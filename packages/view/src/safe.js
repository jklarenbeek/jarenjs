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
 * node has, including `innerHTML`, and the SSR serializer trusts the tag and
 * attribute *names* it is given. (Neither writes a value that is not a function under
 * a handler's name, such as `onclick`: the property table drops it.) For a
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
 *    (`'div><img src=x onerror=alert(1)'`). Inside an `svg` an element whose
 *    start tag ends the `svg` for an HTML parser (`br`, `hr`, `img`) is
 *    dropped too: the DOM renderer would build it inside, the parser outside.
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
 * **The interactive profile** (`{ safe: 'interactive' }`) is this policy with
 * the SAME tag, name, sink, URL and style decisions, and exactly three more —
 * the three places it differs from `safe: true`:
 *
 *  - **`on` bindings are kept when they are data** ({@link createSafePolicy}'s
 *    `events`): a binding is JSON (a string, a finite number, a boolean,
 *    `null`, or a plain list or object of those — no function, accessor,
 *    symbol key or prototype of its own, within a fixed depth and size), on
 *    an event type from {@link INTERACTIVE_EVENTS}: events a user fires by a
 *    deliberate gesture. The handler receives {@link projectEvent}'s frozen
 *    data slice, never the native event or a node.
 *  - **Widgets render only when the host granted their name** (`widget`), and
 *    only with data props; the renderers also hold a granted widget's host
 *    tag to the tag allow-list.
 *  - **Form controls are controlled** (`control`): an `input`'s `value` and
 *    `checked` attribute is written as under `safe: true`, and the DOM
 *    renderer reasserts the live value to what that attribute says; a
 *    `textarea`'s and a `select`'s `value` is written in the trusted form (a
 *    textarea's text, `selected` on the matching option) and reasserted, so
 *    app state resets a field the user edited. The document writes only the
 *    value it owns; it reads what was typed only through the event
 *    projection. A file input's value is never assigned.
 *
 * The policy is a set of pure decisions. The DOM renderer and the SSR
 * serializer call the *same* functions, which is what guarantees the client
 * and the server neutralize an attack identically.
 */

import { sanitizeUrl } from './helpers/url.js';
import { breaksOutOfSvg, isElementName } from './vnode.js';
import { attributePresent, attributeText } from './properties.js';

/** A property name that is a bare identifier: a letter, then letters,
 * digits or hyphens. No spaces, `>`, `=`, `/`, colons or quotes — the
 * characters every structural-injection payload needs. A tag is held to the
 * same grammar through {@link isElementName}, the predicate the trusted
 * renderers share. */
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

/** A submitter's override of where and how its form is sent: dropped on
 * every element, so no button or input can send the document's form, or the
 * host's, anywhere. Compared case-insensitively. */
const SUBMITTER_ATTRS = new Set(['formaction', 'formmethod', 'formtarget', 'formenctype', 'formnovalidate']);

/** Where and how a `form` is sent: dropped on a `form`, which the profiles
 * give `method="dialog"` instead ({@link FORM_FIXED}). */
const FORM_DESTINATION_ATTRS = new Set(['action', 'method', 'target', 'enctype']);

/** The attributes every `form` a safe profile renders carries, whatever the
 * document says: `method="dialog"` sends nothing anywhere — outside a
 * `dialog` a submission is a no-op, inside one it closes that dialog — while
 * the `submit` event still fires, so an interactive binding still sees it. */
const FORM_FIXED = Object.freeze([Object.freeze(/** @type {const} */ (['method', 'dialog']))]);

/** Attributes whose value is ONE element id the browser resolves in the
 * whole page: rewritten into the render's id namespace. */
const ID_REF_ATTRS = new Set([
  'for', 'htmlfor', 'form', 'list', 'popovertarget', 'commandfor', 'interestfor', 'anchor',
  'contextmenu', 'aria-activedescendant',
]);

/** Attributes whose value is a whitespace-separated LIST of element ids. */
const ID_LIST_ATTRS = new Set([
  'headers', 'itemref', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns',
  'aria-details', 'aria-errormessage', 'aria-flowto',
]);

/** The elements whose `name` becomes a named property of `document` (and of
 * `window`): their `name` is namespaced like an id, so a document cannot
 * shadow `document.cookie`, `document.forms` or a host global. */
export const NAMED_TAGS = new Set(['form', 'img', 'embed', 'object', 'iframe']);

/** SVG presentation attributes that reference a paint server, clip path,
 * mask, marker or filter by `url(#id)`. */
const URL_REF_ATTRS = new Set([
  'fill', 'stroke', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end', 'filter',
]);

/** A `url(#id)` reference, as CSS and SVG spell one. */
const RE_URL_FRAGMENT = /(url\(\s*['"]?\s*)#/gi;
const RE_HAS_URL_FRAGMENT = /url\(\s*['"]?\s*#/i;

/** The id namespace a render uses when its host names none: what the
 * serializer always writes, and what the first live safe root of a page
 * takes, so a page's single document serializes and renders alike. */
const DEFAULT_ID_PREFIX = 'jaren-u-';

/** An id prefix a host may supply: a letter, then letters, digits, `_` or
 * `-`, so a prefixed id stays a plain token in a `#fragment` and a `url()`. */
const RE_ID_PREFIX = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * @typedef {Object} SafePolicy
 * @property {(tag: string, foreign?: boolean) => string | null} tag - The tag
 *   to render, or `null` to drop the element and its subtree. `foreign`: the
 *   element sits where an HTML parser reads foreign content (inside an `svg`,
 *   not under its `desc` or `title`), where an element that would end the
 *   `svg` (`br`, `div`, `p`, `span`, `table`, ...) is dropped: no markup
 *   builds it there.
 * @property {(tag: string) => ReadonlyArray<readonly [string, string]> | null} fixed -
 *   Attributes an element of this tag carries whatever the document says,
 *   written before its props (a `form`'s `method="dialog"`), or `null`.
 * @property {(name: string, value: any, tag?: string) => { name: string, value: any } | null}
 *   prop - The name/value to write on an element of `tag`, `{ name, value: null }` to clear an
 *   existing attribute (a sanitized-away URL, a dangerous style), or `null` to
 *   drop the property entirely (a rejected name).
 * @property {boolean} dropsEvents - Whether `on` bindings are stripped (true
 *   for the default policy, false for the interactive one; the renderers read
 *   this to skip the `on` path in safe mode).
 * @property {(on: any) => { kept: Record<string, any> | null, dropped: string[] }}
 *   events - The interactive decision on an `on` member: the bindings to wire
 *   (a fresh object of own, allowed, data-only entries, or `null` for none)
 *   and the names of what was dropped (an event type, or `'on'` when the
 *   member is not a plain object). The default policy keeps nothing.
 * @property {(binding: any) => boolean} binding - Whether a binding a widget
 *   emits may reach the host: the same data rule as `events` (always false
 *   for the default policy).
 * @property {(name: any, props: any) => boolean} widget - Whether a widget of
 *   this name, configured by these props, may render: granted by the host and
 *   fed data (always false for the default policy).
 * @property {(tag: string, props: Record<string, any>) => SafeControl | null} control -
 *   The authoritative state of a form control under the interactive
 *   profile, which the DOM renderer reasserts over a user edit: for an
 *   `input` with an own `value` or `checked`, what its attributes say; for a
 *   `textarea` or `select` with a `value`, the text or the selection the
 *   serializer writes in its place. `null` for every other element and
 *   always for the default policy (attribute-only).
 */

/**
 * @typedef {Object} SafeControl
 * @property {boolean} hasValue - Whether the control's `value` is authoritative.
 * @property {boolean} hasChecked - Whether its `checked` is authoritative.
 * @property {string | ReadonlyArray<string | number | boolean | null> | undefined} value -
 *   An `input`'s: the value its `value` attribute writes (`''` when the
 *   attribute is absent or empty). A `textarea`'s: its text (`''` for
 *   `null` or a stripped value). A `select`'s: the option value it selects,
 *   or a `multiple` select's list of them.
 * @property {boolean | undefined} checked - Whether its `checked` attribute
 *   is present.
 */

/**
 * @typedef {Object} SafePolicyOptions
 * @property {boolean} [interactive=false] - Build the interactive profile's
 *   policy: data-only `on` bindings on {@link INTERACTIVE_EVENTS}, the
 *   granted widgets, and controlled form controls.
 * @property {Iterable<string>} [widgets] - The widget names the host granted
 *   (interactive only; none when absent).
 * @property {string} [idPrefix='jaren-u-'] - The render's id namespace: every
 *   id the document declares, and every id reference (`for`, `form`, `list`,
 *   `popovertarget`, `headers`, the `aria-*` relations, `#fragment` hrefs,
 *   `url(#…)`), is prefixed with it, as is `name` on `form`, `img`, `embed`,
 *   `object` and `iframe`. A letter, then letters, digits, `_` or `-`.
 */

/**
 * The event types an interactive binding may name: each fires from a
 * deliberate user gesture on the document's own elements. Absent by design:
 * events that fire with no gesture (`load`, `error`, `toggle` on an open
 * `details`, CSS `animation*`/`transition*`, the `focus`/`focusin` an
 * `autofocus` attribute fires), hover and movement (`mouseover`,
 * `pointermove`, …), `wheel`/`scroll`, and events whose interesting payload
 * is a host object (`paste`, `drop`). Matched exactly: an event type is
 * case-sensitive, so `Click` names no event.
 */
const INTERACTIVE_EVENTS = new Set([
  'click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
  'keydown', 'keyup', 'input', 'change', 'submit', 'reset', 'blur', 'focusout',
]);

/** How deep a binding or widget props may nest, and how many values they may
 * hold, before the profile stops reading and drops them: fixed bounds, so a
 * cyclic or exponentially shared JS structure is refused deterministically,
 * whatever the host's stack. */
const MAX_DATA_DEPTH = 64;
const MAX_DATA_VALUES = 65536;


/**
 * Build the default safe policy. Stateless and cheap; a renderer builds one
 * per `safe: true` and hands the *same* object to every element it renders.
 *
 * The policy is a set of **pure decisions** — it neither writes nor reports.
 * The renderer owns `onUnsafe` and reports at the point it acts on a
 * rejection, which is what lets it report the strips a policy never sees (an
 * `on` binding, a widget) with one contract.
 *
 * With `{ interactive: true }` it builds the interactive profile's policy:
 * `tag` and `prop` are the very same decisions, and `events`, `binding`,
 * `widget` and `control` keep what the profile keeps.
 * @param {SafePolicyOptions} [options]
 * @returns {SafePolicy}
 */
export function createSafePolicy(options = {}) {
  const interactive = options.interactive === true;
  const granted = new Set(interactive ? options.widgets ?? [] : []);
  const prefix = idPrefixOf(options.idPrefix);
  return {
    dropsEvents: !interactive,

    events(on) {
      if (on == null) return { kept: null, dropped: [] };
      if (!interactive || !isPlainRecord(on)) return { kept: null, dropped: ['on'] };
      /** @type {string[]} */
      const dropped = [];
      /** @type {Record<string, any>} */
      const kept = {};
      let any = false;
      for (const type of /** @type {string[]} */ (Reflect.ownKeys(on))) {
        const own = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(on, type));
        // a member left undefined binds nothing, as in trusted mode, and was
        // not stripped by anything
        if ('value' in own && own.value === undefined) continue;
        if (!own.enumerable || !('value' in own) || !INTERACTIVE_EVENTS.has(type) || !isData(own.value)) {
          dropped.push(type);
          continue;
        }
        kept[type] = own.value;
        any = true;
      }
      // what is wired is a fresh object of the kept entries, never the
      // document's own `on`
      return { kept: any ? kept : null, dropped };
    },

    binding(value) {
      return interactive && isData(value);
    },

    widget(name, props) {
      return interactive && typeof name === 'string' && granted.has(name) && isData(props ?? null);
    },

    control(tag, props) {
      if (!interactive) return null;
      if (tag === 'textarea' || tag === 'select') {
        // read as trusted mode reads it (an inherited `value` too: their
        // attribute is one a parser ignores, so nothing falls back to it).
        // The trusted form, of the value the policy keeps: a textarea's
        // text, a select's value (a `multiple` one's list), which the
        // serializer writes as text and `selected` options
        if (!('value' in props)) return null;
        const value = this.prop('value', props.value, tag)?.value;
        return {
          hasValue: true,
          hasChecked: false,
          value: tag === 'select' && Array.isArray(value) ? value : value == null ? '' : String(value),
          checked: undefined,
        };
      }
      if (tag !== 'input') return null;
      const hasValue = Object.hasOwn(props, 'value');
      const hasChecked = Object.hasOwn(props, 'checked');
      if (!hasValue && !hasChecked) return null;
      // the state the attribute the renderers write stands for, so a
      // reasserted control shows what the serializer's markup starts from
      const value = hasValue ? this.prop('value', props.value, tag)?.value : undefined;
      const checked = hasChecked ? this.prop('checked', props.checked, tag)?.value : undefined;
      return {
        hasValue,
        hasChecked,
        value: hasValue ? attributeText(value) : undefined,
        checked: hasChecked ? attributePresent(checked) : undefined,
      };
    },

    tag(tag, foreign = false) {
      if (isElementName(tag) && (SAFE_HTML_TAGS.has(tag) || SAFE_SVG_TAGS.has(tag)) && !(foreign && breaksOutOfSvg(tag))) {
        return tag;
      }
      return null;
    },

    fixed(tag) {
      return tag === 'form' ? FORM_FIXED : null;
    },

    prop(name, value, tag) {
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
      // No submission leaves the document's control: a submitter's override
      // and a form's own destination are denied (the form is `method="dialog"`).
      if (SUBMITTER_ATTRS.has(lower) || (tag === 'form' && FORM_DESTINATION_ATTRS.has(lower))) return null;
      // a value is a string, a number, a boolean or null, as the safe schema
      // says: anything else is turned into text by the renderers, and the
      // text of a list or an object is not what the checks below read (a
      // list holding a script URL) or cannot be made at all (a `toString`
      // member that is no function). A `multiple` select's `value` is the
      // one list.
      if (lower === 'style') return { name, value: scopeStyle(safeStyle(value), prefix) };
      if (!isScalar(value) && !(lower === 'value' && Array.isArray(value) && value.every(isScalar))) {
        return { name, value: null };
      }
      // Every id the document declares, and every reference to one, lives in
      // the render's namespace: references inside the document resolve, and
      // none can reach — or shadow — an element of the host's.
      if (lower === 'id' || ID_REF_ATTRS.has(lower) || (lower === 'name' && NAMED_TAGS.has(/** @type {string} */ (tag)))) {
        return { name, value: scopeId(value, prefix) };
      }
      if (ID_LIST_ATTRS.has(lower)) return { name, value: scopeIdList(value, prefix) };
      if (lower === 'usemap') return { name, value: scopeFragment(value, prefix) };
      if (URL_REF_ATTRS.has(lower)) return { name, value: scopeUrlRefs(value, prefix) };
      if (URL_ATTRS.has(lower)) {
        const safe = sanitizeUrl(value);
        // Keep the (safe) name but clear the value when the URL is unsafe: a
        // patch from a good URL to a bad one must remove the old attribute.
        // A same-document `#fragment` points into the render's namespace.
        return { name, value: lower === 'href' ? scopeFragment(safe, prefix) : safe };
      }
      if (URL_LIST_ATTRS.has(lower)) {
        return { name, value: sanitizeUrlList(value, lower === 'srcset') };
      }
      return { name, value };
    },
  };
}

/**
 * The id prefix a render uses: the host's, checked, or the default.
 * @param {any} value
 * @returns {string}
 */
export function idPrefixOf(value) {
  if (value === undefined) return DEFAULT_ID_PREFIX;
  if (typeof value !== 'string' || !RE_ID_PREFIX.test(value)) {
    throw new TypeError(`view: idPrefix must be a letter followed by letters, digits, _ or -, got ${JSON.stringify(value) ?? String(value)}`);
  }
  return value;
}

/**
 * One id in the render's namespace. A value that is not a non-empty string
 * or a number declares no id and is returned as it is.
 * @param {any} value
 * @param {string} prefix
 * @returns {any}
 */
function scopeId(value, prefix) {
  if (typeof value === 'number') return prefix + String(value);
  return typeof value === 'string' && value !== '' ? prefix + value : value;
}

/**
 * A whitespace-separated id list in the render's namespace.
 * @param {any} value
 * @param {string} prefix
 * @returns {any}
 */
function scopeIdList(value, prefix) {
  if (typeof value === 'number') return prefix + String(value);
  if (typeof value !== 'string') return value;
  const ids = value.split(/[\t\n\f\r ]+/).filter((id) => id !== '');
  return ids.length === 0 ? value : ids.map((id) => prefix + id).join(' ');
}

/**
 * A same-document `#fragment` URL in the render's namespace; any other URL
 * (and `#` alone, the top of the page) unchanged.
 * @param {any} value
 * @param {string} prefix
 * @returns {any}
 */
function scopeFragment(value, prefix) {
  return typeof value === 'string' && value.length > 1 && value[0] === '#' ? '#' + prefix + value.slice(1) : value;
}

/**
 * Every `url(#id)` in a value, in the render's namespace.
 * @param {any} value
 * @param {string} prefix
 * @returns {any}
 */
function scopeUrlRefs(value, prefix) {
  return typeof value === 'string' ? value.replace(RE_URL_FRAGMENT, (_match, open) => `${open}#${prefix}`) : value;
}

/**
 * A safe inline style with its `url(#id)` references in the render's
 * namespace: the same string or object when it holds none.
 * @param {any} value
 * @param {string} prefix
 * @returns {any}
 */
function scopeStyle(value, prefix) {
  if (typeof value === 'string') return scopeUrlRefs(value, prefix);
  if (value === null || typeof value !== 'object') return value;
  let out = null;
  for (const key in value) {
    const v = value[key];
    if (typeof v === 'string' && RE_HAS_URL_FRAGMENT.test(v)) {
      if (out === null) out = { ...value };
      out[key] = scopeUrlRefs(v, prefix);
    }
  }
  return out ?? value;
}

/**
 * Whether `value` is a plain record: an object whose prototype is
 * `Object.prototype` or `null`, so nothing it answers is inherited, and
 * whose own keys are all strings.
 * @param {any} value
 * @returns {boolean}
 */
function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) && Object.getOwnPropertySymbols(value).length === 0;
}

/**
 * Whether `value` is JSON data, as the interactive profile reads a binding or
 * a widget's props: a string, a finite number, a boolean, `null`, or a plain
 * list or record of those. Never a function, a getter (it is not run: the
 * descriptor is read), a symbol-keyed or non-enumerable member (a hidden
 * `toJSON` is still called by `JSON.stringify`), an object with a prototype
 * of its own (a class instance, a `Date`, a `Map`), a hole or an extra
 * member on a list, `undefined`, a non-finite number or a bigint — nothing
 * that could run code when the host reads, copies or serializes it. Bounded
 * by {@link MAX_DATA_DEPTH} and {@link MAX_DATA_VALUES}.
 * @param {any} value
 * @returns {boolean}
 */
export function isData(value) {
  const budget = { left: MAX_DATA_VALUES };
  return dataWalk(value, 0, budget);
}

/**
 * The recursion of {@link isData}.
 * @param {any} value
 * @param {number} depth
 * @param {{ left: number }} budget
 * @returns {boolean}
 */
function dataWalk(value, depth, budget) {
  if (--budget.left < 0) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth >= MAX_DATA_DEPTH) return false;
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value)) {
    // its own keys are exactly its indexes and `length`: no hole, no extra
    if (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length + 1) return false;
    for (let i = 0; i < value.length; i++) {
      const own = Object.getOwnPropertyDescriptor(value, i);
      if (own === undefined || !('value' in own) || !dataWalk(own.value, depth + 1, budget)) return false;
    }
    return true;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of keys) {
    if (typeof key !== 'string') return false;
    const own = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(value, key));
    if (!own.enumerable || !('value' in own) || !dataWalk(own.value, depth + 1, budget)) return false;
  }
  return true;
}

/** The primitive fields of a native event an interactive handler receives:
 * keyboard, modifier, button and pointer members. `screenX`/`screenY` (where
 * the window sits on the screen) and the wheel deltas (no wheel binding) are
 * left out. */
const PROJECTED_FIELDS = [
  'key', 'code', 'repeat', 'location', 'isComposing',
  'shiftKey', 'ctrlKey', 'altKey', 'metaKey',
  'button', 'buttons', 'detail',
  'clientX', 'clientY', 'offsetX', 'offsetY', 'pageX', 'pageY', 'movementX', 'movementY',
  'pointerId', 'pointerType', 'pressure', 'isPrimary',
];

/** The fields that carry what a user typed: withheld from an event at a
 * password field or one that rose from inside a widget. */
const TYPED_FIELDS = new Set(['key', 'code']);

/** The projections this module made, so one handed on again (a widget's
 * nested renderer emitting through its owner) is not projected twice. */
const PROJECTED = new WeakSet();

/**
 * The data an interactive handler receives in place of a native event: a
 * frozen, null-prototype object of the event's primitive fields
 * ({@link PROJECTED_FIELDS}, a member that is not a string, number or
 * boolean read as `null`), a frozen `target` slice of `value`, `checked`,
 * `selectionStart` and `selectionEnd`, and the two native controls a binding
 * may ask for, `preventDefault()` and `stopPropagation()`. No node, no
 * window, no event object is reachable from it.
 *
 * What a user typed is withheld (`key`, `code` and the whole target slice read
 * `null`) when the event's target is a password field — a document must not
 * read a credential, typed or filled in by the browser — and when `withheld`
 * is set: the renderer sets it for an event that rose from inside a widget's
 * subtree, which is the host's, not the document's.
 * @param {any} event - The native event, or what a widget emitted.
 * @param {boolean} withheld
 * @returns {any} the projection (`event` itself when it is not an object)
 */
export function projectEvent(event, withheld) {
  if (event === null || typeof event !== 'object' || PROJECTED.has(event)) return event;
  const target = event.target;
  const sealed = withheld || isPasswordField(target);
  const out = Object.create(null);
  out.type = primitive(event.type);
  for (const name of PROJECTED_FIELDS) {
    out[name] = sealed && TYPED_FIELDS.has(name) ? null : primitive(event[name]);
  }
  const slice = Object.create(null);
  slice.value = sealed ? null : primitive(target?.value);
  slice.checked = sealed ? null : primitive(target?.checked);
  slice.selectionStart = sealed ? null : primitive(target?.selectionStart);
  slice.selectionEnd = sealed ? null : primitive(target?.selectionEnd);
  out.target = Object.freeze(slice);
  out.preventDefault = () => {
    if (typeof event.preventDefault === 'function') event.preventDefault();
  };
  out.stopPropagation = () => {
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
  };
  Object.freeze(out);
  PROJECTED.add(out);
  return out;
}

/**
 * A value an event projection may carry: a string, a finite number or a
 * boolean; anything else reads `null`.
 * @param {any} value
 * @returns {string | number | boolean | null}
 */
function primitive(value) {
  return typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value)) ? value : null;
}

/**
 * Whether an event target is a password field: its `type` property, or its
 * `type` attribute where the node reflects none.
 * @param {any} target
 * @returns {boolean}
 */
function isPasswordField(target) {
  if (target === null || typeof target !== 'object') return false;
  const type = typeof target.type === 'string' ? target.type
    : typeof target.getAttribute === 'function' ? target.getAttribute('type') : null;
  return typeof type === 'string' && type.trim().toLowerCase() === 'password';
}

/**
 * Validate the interactive profile's widget grant, `capabilities.widgets`,
 * against the registry the renderer was handed, and return the granted
 * names. Shared by both renderers, so a grant the DOM renderer refuses the
 * serializer refuses too. Absent (`capabilities` or its `widgets` member
 * `undefined` or `null`) grants nothing.
 * @param {any} capabilities
 * @param {Record<string, any> | undefined} widgets
 * @returns {string[]}
 */
export function grantedWidgets(capabilities, widgets) {
  if (capabilities == null) return [];
  if (typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new TypeError('view: capabilities must be an object, as { widgets: [name, ...] }');
  }
  const names = capabilities.widgets;
  if (names == null) return [];
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
    throw new TypeError('view: capabilities.widgets must be a list of widget names');
  }
  for (const name of names) {
    if (widgets == null || !Object.hasOwn(widgets, name)) {
      throw new TypeError(`view: capabilities.widgets grants '${name}', which is not a registered widget`);
    }
  }
  return [...names];
}

/**
 * Whether `value` is a kind an attribute can carry: a string, a number, a
 * boolean, or nothing (`null`/`undefined`).
 * @param {any} value
 * @returns {boolean}
 */
function isScalar(value) {
  return value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
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
      if (!isScalar(v) || (typeof v === 'string' && RE_DANGEROUS_STYLE.test(v))) return null;
    }
    return value;
  }
  return value;
}
