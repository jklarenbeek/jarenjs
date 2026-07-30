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

/** Attributes whose value is a URL, filtered through the deny-list sanitizer.
 * Compared case-insensitively. */
const URL_ATTRS = new Set([
  'href', 'src', 'action', 'formaction', 'poster', 'background',
  'cite', 'longdesc', 'data', 'ping', 'srcset',
]);

/** Inline-style values that carry a CSS execution vector. */
const RE_DANGEROUS_STYLE = /expression\s*\(|url\s*\(\s*['"]?\s*(?:javascript|vbscript|data):/i;

/**
 * @typedef {Object} SafePolicy
 * @property {(tag: string) => string | null} tag - The tag to render, or
 *   `null` to drop the element and its subtree.
 * @property {(name: string, value: any) => { name: string, value: any } | null}
 *   prop - The name/value to write, `{ name, value: null }` to clear an
 *   existing attribute, or `null` to drop the property entirely.
 * @property {boolean} dropsEvents - Whether `on` bindings are stripped (always
 *   true for the default policy; the renderers read this to skip the `on`
 *   path in safe mode).
 */

/**
 * @typedef {Object} SafePolicyOptions
 * @property {(info: { kind: 'tag' | 'prop' | 'event', name: string }) => void}
 *   [onUnsafe] - Called for every element, property or event binding the
 *   policy strips, so a host can observe what an untrusted document tried to
 *   do rather than have it silently vanish.
 */

/**
 * Build the default safe policy. Stateless and cheap; a renderer builds one
 * per `safe: true` and hands the *same* object to every element it renders.
 * @param {SafePolicyOptions} [options]
 * @returns {SafePolicy}
 */
export function createSafePolicy(options = {}) {
  const report = typeof options.onUnsafe === 'function' ? options.onUnsafe : null;

  return {
    dropsEvents: true,

    tag(tag) {
      if (typeof tag === 'string' && RE_SAFE_NAME.test(tag)
        && (SAFE_HTML_TAGS.has(tag) || SAFE_SVG_TAGS.has(tag))) {
        return tag;
      }
      if (report !== null) report({ kind: 'tag', name: String(tag) });
      return null;
    },

    prop(name, value) {
      const lower = name.toLowerCase();
      // A name that is not a bare identifier is structural injection, whatever
      // it spells: reject before it can reach a serializer or a DOM property.
      if (!RE_SAFE_NAME.test(name) || lower.startsWith('on')
        || DANGEROUS_PROPS.has(lower)) {
        if (report !== null) report({ kind: 'prop', name });
        return null;
      }
      if (URL_ATTRS.has(lower)) {
        const safe = sanitizeUrl(value);
        if (safe === null) {
          if (report !== null) report({ kind: 'prop', name });
          // Keep the name (it is safe) but clear any prior value: a patch
          // from a good URL to a bad one must remove the old attribute.
          return { name, value: null };
        }
        return { name, value: safe };
      }
      if (lower === 'style' && dangerousStyle(value)) {
        if (report !== null) report({ kind: 'prop', name });
        return { name, value: null };
      }
      return { name, value };
    },
  };
}

/** Whether an inline-style value (string, or a pre-stringified object) carries
 * a CSS execution vector. Objects that have not been stringified yet are
 * checked value by value. */
function dangerousStyle(value) {
  if (typeof value === 'string') return RE_DANGEROUS_STYLE.test(value);
  if (value !== null && typeof value === 'object') {
    for (const key in value) {
      const v = value[key];
      if (typeof v === 'string' && RE_DANGEROUS_STYLE.test(v)) return true;
    }
  }
  return false;
}

export { SAFE_HTML_TAGS, SAFE_SVG_TAGS, DANGEROUS_PROPS, URL_ATTRS, RE_SAFE_NAME };
