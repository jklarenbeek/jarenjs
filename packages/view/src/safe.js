//@ts-check
/**
 * @file The safe render policy: one decision surface for untrusted vnodes,
 * shared by the DOM renderer and the SSR serializer so the two can never
 * disagree about what is safe.
 *
 * **Why this exists.** A vnode is plain JSON, and the published grammar
 * ([`jaren-vnode.schema.json`](../schemas/jaren-vnode.schema.json)) proves a
 * document is a well-formed *interface* — it does not prove the document is
 * *safe to render*. The default (trusted) renderer writes any DOM property a
 * node has, including `innerHTML` and inline `on*` handlers, and the SSR
 * serializer trusts the tag and attribute *names* it is given. For a
 * source-authored view that is exactly right — it is the equivalent of
 * writing the DOM by hand. For a view that arrives from somewhere you do not
 * control — a tenant, a remote service, a language model — it is not: a
 * schema-valid document can still carry `['div', { innerHTML: '<img
 * onerror=…>' }]` or a tag spelled `div><script>`.
 *
 * Schema validation is a structural gate, not a sanitizer. This module is the
 * sanitizer. Pass `{ safe: true }` to {@link createDomRenderer} or
 * {@link renderToString} and every element flows through the decisions here:
 *
 *  - **Tags** must be on an allow-list of known-inert HTML and SVG elements.
 *    `script`, `iframe`, `object`, `style`, `link`, `foreignObject` and the
 *    rest are dropped, and so is any tag whose *name* is not a bare
 *    identifier — which is what closes structural injection through the tag
 *    (`'div><img src=x onerror=alert(1)'`).
 *  - **Property names** must be bare identifiers too (closing attribute-name
 *    injection like `'x onfocus'`), must not begin with `on` (no inline
 *    handlers), and must not be a known scripting sink (`innerHTML`,
 *    `outerHTML`, `srcdoc`, …).
 *  - **URL attributes** (`href`, `src`, `action`, …) are filtered through the
 *    deny-list {@link sanitizeUrl}, so `javascript:` and a document-carrying
 *    `data:` are dropped while ordinary links survive.
 *  - **Inline `style`** is dropped when it carries the classic CSS vectors
 *    (`expression(`, or a `url()` with a script scheme).
 *  - **Event bindings** (`on`) are dropped: an untrusted document must not be
 *    able to bind the host's application actions. Safe-mode views are
 *    display-oriented by construction.
 *
 * The policy is a set of pure decisions. The DOM renderer and the SSR
 * serializer call the *same* functions, which is what guarantees the client
 * and the server neutralize an attack identically.
 */

import { sanitizeUrl } from './helpers/url.js';

/** A tag or property name that is a bare identifier: a letter, then letters,
 * digits or hyphens. No spaces, `>`, `=`, `/`, colons or quotes — the
 * characters every structural-injection payload needs. */
const RE_SAFE_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * The HTML elements a user interface legitimately renders. An allow-list, not
 * a deny-list, because a deny-list silently admits the next dangerous element
 * a browser adds. Document structure (`html`, `head`, `body`, `title`),
 * script and style carriers (`script`, `style`, `link`, `meta`, `base`,
 * `noscript`, `template`), and document-embedding elements (`iframe`,
 * `object`, `embed`, `frame`, `frameset`, `portal`) are all absent by design.
 */
const SAFE_HTML_TAGS = new Set([
  // sectioning & grouping
  'main', 'section', 'article', 'aside', 'nav', 'header', 'footer', 'hgroup',
  'address', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'div', 'p', 'hr', 'pre', 'blockquote', 'ol', 'ul', 'li', 'dl', 'dt', 'dd',
  'figure', 'figcaption', 'menu',
  // text-level
  'a', 'span', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'mark', 'abbr',
  'cite', 'q', 'code', 'kbd', 'samp', 'var', 'sub', 'sup', 'time', 'data',
  'wbr', 'br', 'bdi', 'bdo', 'ruby', 'rt', 'rp', 'dfn', 'ins', 'del',
  // tables
  'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot',
  'tr', 'td', 'th',
  // forms
  'form', 'label', 'input', 'button', 'select', 'option', 'optgroup',
  'textarea', 'fieldset', 'legend', 'datalist', 'output', 'progress', 'meter',
  // media & embedded (URL-bearing attributes are sanitized separately)
  'img', 'picture', 'source', 'audio', 'video', 'track', 'canvas',
  // interactive
  'details', 'summary', 'dialog',
]);

/**
 * The SVG drawing subset. `foreignObject` is excluded — it re-enters HTML and
 * would reopen every vector above — and so are `script` and the event-bearing
 * SMIL elements.
 */
const SAFE_SVG_TAGS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'marker', 'mask', 'clipPath', 'pattern',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath', 'image',
  'linearGradient', 'radialGradient', 'stop',
  'title', 'desc',
]);

/** Property names denied outright: the sinks that PARSE their value as HTML.
 * `textContent`/`innerText` are deliberately absent — they set text, which a
 * browser escapes, so they are not injection vectors. Compared
 * case-insensitively. */
const DANGEROUS_PROPS = new Set([
  'innerhtml', 'outerhtml', 'insertadjacenthtml',
  'dangerouslysetinnerhtml', 'srcdoc',
]);

/** Attributes whose value is a single URL, filtered through the deny-list
 * sanitizer. Compared case-insensitively. */
const URL_ATTRS = new Set([
  'href', 'src', 'action', 'formaction', 'poster', 'background',
  'cite', 'longdesc', 'data',
]);

/** Attributes whose value is a URL *list*: `srcset` is comma-separated
 * `url descriptor` candidates, `ping` is a whitespace-separated URL list.
 * Running the whole string through a single-URL check would miss an unsafe
 * candidate after the first, so each is parsed and every URL is sanitized. */
const URL_LIST_ATTRS = new Set(['srcset', 'ping']);

/** Inline-style values that carry a CSS execution vector. */
const RE_DANGEROUS_STYLE = /expression\s*\(|url\s*\(\s*['"]?\s*(?:javascript|vbscript|data):/i;

/** A CSS property name a safe style object may carry: a plain identifier or a
 * `--custom-property`. A key with `:`, `;`, `(` or whitespace is not a
 * property name — it is a declaration smuggled through the key, which is how
 * `styleToString` concatenation turns `{ 'x:url(javascript:…)': 'y' }` into a
 * live rule. */
const RE_SAFE_STYLE_KEY = /^(?:--[A-Za-z0-9-]+|[A-Za-z][A-Za-z0-9-]*)$/;

/**
 * @typedef {Object} SafePolicy
 * @property {(tag: string) => string | null} tag - The tag to render, or
 *   `null` to drop the element and its subtree.
 * @property {(name: string, value: any) => { name: string, value: any } | null}
 *   prop - The name/value to write, `{ name, value: null }` to clear an
 *   existing attribute (a sanitized-away URL, a dangerous style), or `null` to
 *   drop the property entirely (a rejected name).
 * @property {boolean} dropsEvents - Whether `on` bindings are stripped (always
 *   true for the default policy; the renderers read this to skip the `on`
 *   path in safe mode).
 */

/**
 * Build the default safe policy. Stateless and cheap; a renderer builds one
 * per `safe: true` and hands the *same* object to every element it renders.
 *
 * The policy is a set of **pure decisions** — it neither writes nor reports.
 * The renderer owns `onUnsafe` and reports at the point it acts on a
 * rejection, which is what lets it report the strips a policy never sees (an
 * `on` binding, a widget) with one contract.
 * @returns {SafePolicy}
 */
export function createSafePolicy() {
  return {
    dropsEvents: true,

    tag(tag) {
      if (typeof tag === 'string' && RE_SAFE_NAME.test(tag)
        && (SAFE_HTML_TAGS.has(tag) || SAFE_SVG_TAGS.has(tag))) {
        return tag;
      }
      return null;
    },

    prop(name, value) {
      const lower = name.toLowerCase();
      // A name that is not a bare identifier is structural injection, whatever
      // it spells: reject before it can reach a serializer or a DOM property.
      // `is` is a bare identifier but a capability escape: it upgrades an
      // element to a registered customized built-in when the markup is
      // PARSED (an untrusted document's safe SSR would run a host-registered
      // constructor), so it is denied outright.
      if (!RE_SAFE_NAME.test(name) || lower.startsWith('on')
        || lower === 'is' || DANGEROUS_PROPS.has(lower)) {
        return null;
      }
      if (URL_ATTRS.has(lower)) {
        const safe = sanitizeUrl(value);
        // Keep the (safe) name but clear the value when the URL is unsafe: a
        // patch from a good URL to a bad one must remove the old attribute.
        return { name, value: safe };
      }
      if (URL_LIST_ATTRS.has(lower)) {
        return { name, value: sanitizeUrlList(value, lower === 'srcset') };
      }
      if (lower === 'style') {
        return { name, value: safeStyle(value) };
      }
      return { name, value };
    },
  };
}

/**
 * Sanitize a URL-list attribute. Every candidate's URL is checked; a single
 * unsafe candidate drops the whole attribute, because a browser would still
 * act on the safe ones around it and the intent is already hostile.
 * @param {any} value
 * @param {boolean} isSrcset - `srcset` (a candidate list) vs `ping`
 *   (whitespace-separated URLs)
 * @returns {string | null}
 */
function sanitizeUrlList(value, isSrcset) {
  if (typeof value !== 'string') return null;
  if (!isSrcset) {
    const urls = value.split(/\s+/).filter((u) => u !== '');
    for (const url of urls) if (sanitizeUrl(url) === null) return null;
    return urls.length > 0 ? urls.join(' ') : null;
  }
  const candidates = parseSrcset(value);
  if (candidates === null) return null;
  const out = [];
  for (const { url, descriptor } of candidates) {
    if (sanitizeUrl(url) === null) return null;
    out.push(descriptor === '' ? url : `${url} ${descriptor}`);
  }
  return out.length > 0 ? out.join(', ') : null;
}

/**
 * Parse an `srcset` into `{ url, descriptor }` candidates. A candidate's URL
 * runs up to the next ASCII whitespace, so a comma INSIDE a URL — a `data:`
 * image is full of them — stays part of the URL rather than splitting it,
 * which the naive comma-split got wrong. Follows the shape of the HTML srcset
 * algorithm closely enough to validate every URL; the descriptor is opaque to
 * a safety check.
 * @param {string} s
 * @returns {Array<{ url: string, descriptor: string }> | null}
 */
function parseSrcset(s) {
  const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && (isWs(s[i]) || s[i] === ',')) i++;
    if (i >= s.length) break;
    let url = '';
    while (i < s.length && !isWs(s[i])) { url += s[i]; i++; }
    // trailing commas on the URL are candidate separators, not part of it.
    let hadTrailingComma = false;
    while (url.endsWith(',')) { url = url.slice(0, -1); hadTrailingComma = true; }
    let descriptor = '';
    if (!hadTrailingComma) {
      while (i < s.length && isWs(s[i])) i++;
      while (i < s.length && s[i] !== ',') { descriptor += s[i]; i++; }
      if (i < s.length) i++; // consume the separating comma
    }
    if (url !== '') out.push({ url, descriptor: descriptor.trim() });
  }
  return out.length > 0 ? out : null;
}

/**
 * The safe form of an inline-style value: `null` when it carries a CSS
 * execution vector or an injection-shaped property name, otherwise the value
 * unchanged (a string, or an object the renderer will serialize). Both the
 * KEYS and the values are checked — a payload smuggled through an object key
 * survives `styleToString`'s concatenation otherwise.
 * @param {any} value
 * @returns {any}
 */
function safeStyle(value) {
  if (typeof value === 'string') {
    return RE_DANGEROUS_STYLE.test(value) ? null : value;
  }
  if (value !== null && typeof value === 'object') {
    for (const key in value) {
      if (!RE_SAFE_STYLE_KEY.test(key) || RE_DANGEROUS_STYLE.test(key)) return null;
      const v = value[key];
      if (typeof v === 'string' && RE_DANGEROUS_STYLE.test(v)) return null;
    }
    return value;
  }
  return value;
}

export {
  SAFE_HTML_TAGS, SAFE_SVG_TAGS, DANGEROUS_PROPS,
  URL_ATTRS, URL_LIST_ATTRS, RE_SAFE_NAME,
};
