//@ts-check
/**
 * @file Raw HTML in Markdown, parsed to vnodes through an allow-list.
 *
 * The vnode format has no unescaped output — deliberately: a tree of
 * arrays cannot carry a half-open tag or an injected `<script>`, which
 * is why `mdToVnode` has always either dropped raw HTML or shown it as
 * text. This module is the third answer: PARSE the HTML and keep what an
 * allow-list recognises, so `<details>` and `<img>` in a document render
 * as themselves.
 *
 * The safety argument is structural rather than a promise about
 * filtering strings. The output is a vnode tree, so:
 *
 * - an element not on the list contributes nothing but its children's
 *   text — there is no path by which its markup reaches the DOM;
 * - an attribute not on the list is dropped, so `on*` handlers,
 *   `style` and `srcdoc` never exist to begin with;
 * - `href`/`src` go through the same {@link sanitizeUrl} policy as
 *   Markdown's own links, so `javascript:` cannot ride in on raw HTML
 *   when it cannot ride in on `[x](…)`.
 *
 * What this is NOT: an HTML5 parser. It does not implement implicit
 * end tags, foster parenting, or the tokenizer's error recovery, and it
 * does not attempt to reproduce what a browser would build from
 * malformed input. Unbalanced input closes at the end of the fragment.
 * For hostile input the goal is that nothing survives that should not,
 * not that the shape matches what a browser would have made of it.
 *
 * A host that wants different rules injects its own parser instead
 * (`mdToVnode`'s `parseHtml` option) — this is the default, not the
 * only, implementation.
 */

import { sanitizeUrl } from '@jarenjs/view/helpers';
import { decodeReferences } from './entities.js';
import { MAX_NESTING } from './utils.js';

/** Elements that carry no content and never take an end tag. */
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * The elements a Markdown document may render. Structure, text and
 * media; nothing that scripts, loads a document, or takes over the page
 * (`script`, `style`, `iframe`, `object`, `form`, `input`).
 */
const ELEMENTS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'cite',
  'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl',
  'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'picture',
  'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'small',
  'source', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr',
]);

/**
 * Elements whose CONTENT is not prose: dropping the tag and keeping the
 * children would print a script's source as text. Their subtree goes.
 */
const DROP_CONTENT = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template']);

/** Attributes allowed on any element. */
const GLOBAL_ATTRS = new Set(['class', 'id', 'title', 'lang', 'dir', 'role']);

/** Attributes allowed on specific elements. */
const ELEMENT_ATTRS = {
  a: new Set(['href', 'name', 'target', 'rel', 'download']),
  img: new Set(['src', 'alt', 'width', 'height', 'loading', 'decoding', 'srcset', 'sizes']),
  source: new Set(['src', 'srcset', 'sizes', 'type', 'media']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  td: new Set(['colspan', 'rowspan', 'headers', 'align']),
  th: new Set(['colspan', 'rowspan', 'headers', 'scope', 'abbr', 'align']),
  ol: new Set(['start', 'reversed', 'type']),
  li: new Set(['value']),
  details: new Set(['open']),
  time: new Set(['datetime']),
  del: new Set(['cite', 'datetime']),
  ins: new Set(['cite', 'datetime']),
  blockquote: new Set(['cite']),
  q: new Set(['cite']),
};

/** Attributes holding a URL, filtered by the Markdown link policy. */
const URL_ATTRS = new Set(['href', 'src']);

/**
 * @typedef {object} HtmlParseOptions
 * @property {(url: string) => (string|null)} [sanitizeUrl] URL policy for
 *  `href`/`src` (default: the shared deny-list, as Markdown links use)
 */

/**
 * Parse an HTML fragment into vnodes, keeping only what the allow-list
 * recognises.
 *
 * Elements nest at most `MAX_NESTING` deep in the result: one opened
 * deeper keeps its content and loses its markup, as an unknown element
 * does, so no fragment builds a tree too deep to render.
 *
 * @param {string} source the raw HTML of one Markdown html node
 * @param {HtmlParseOptions} [options]
 * @returns {any[]} vnodes and strings; empty when nothing survived
 * @example
 * parseHtmlFragment('<details><summary>More</summary>text</details>');
 * // [['details', {}, ['summary', {}, 'More'], 'text']]
 */
export function parseHtmlFragment(source, options = {}) {
  const urlPolicy = options.sanitizeUrl ?? sanitizeUrl;
  /** Open elements; the root frame collects the result. */
  const frames = createFrames();
  const stack = frames.stack;
  /** @type {Set<number>} attribute-loop offsets a tag scan never ends from */
  const unended = new Set();
  /** @type {TagStops} */
  let stops = SCANNED_STOPS;
  let i = 0;
  let text = '';

  const flushText = () => {
    if (text === '') return;
    stack[stack.length - 1].children.push(decodeReferences(text));
    text = '';
  };

  while (i < source.length) {
    if (source.charCodeAt(i) !== 0x3C /* < */) {
      text += source[i];
      i++;
      continue;
    }
    // A comment, doctype or processing instruction carries no content
    // worth keeping — and its text must not leak out as prose either.
    if (source.startsWith('<!--', i)) {
      const close = source.indexOf('-->', i + 4);
      i = close === -1 ? source.length : close + 3;
      continue;
    }
    if (source.startsWith('<!', i) || source.startsWith('<?', i)) {
      const close = source.indexOf('>', i);
      i = close === -1 ? source.length : close + 1;
      continue;
    }
    const tag = scanTag(source, i, stops, unended);
    if (tag === null) {
      // A scan that ran on and ended nowhere may be the first of many
      // (a `<` that never closes), so later scans read runs from tables.
      if (stops === SCANNED_STOPS && unended.size > 0) stops = tabledStops(source);
      // not a tag at all: a literal `<` in prose
      text += source[i];
      i++;
      continue;
    }
    i = tag.end;
    flushText();
    if (tag.closing) {
      // close the nearest matching open element; an end tag that matches
      // nothing is noise and is dropped
      closeElement(frames, tag.name);
      continue;
    }
    const known = ELEMENTS.has(tag.name);
    if (known && (tag.selfClosing || VOID.has(tag.name))) {
      stack[stack.length - 1].children.push([tag.name, attrsFor(tag, urlPolicy)]);
      continue;
    }
    // An unknown element still opens a frame: its CHILDREN are content
    // the reader wrote and should keep, its own markup is what goes.
    openFrame(frames, {
      tag: tag.name,
      children: [],
      props: known ? attrsFor(tag, urlPolicy) : null,
      keep: known && !tag.selfClosing,
      drop: DROP_CONTENT.has(tag.name),
    });
  }
  flushText();
  while (stack.length > 1) closeFrame(frames);
  return stack[0].children;
}

/**
 * The open-element frames of one parse: the stack (its root frame
 * collects the result), how many open frames will become elements, and
 * how many are open per tag name — so an end tag that matches nothing is
 * dropped without walking the stack.
 * @typedef {{ stack: any[], kept: number, open: Map<string, number> }} Frames
 */

/** @returns {Frames} */
function createFrames() {
  return { stack: [{ tag: '', children: [] }], kept: 0, open: new Map() };
}

/**
 * Open a frame. Past `MAX_NESTING` kept elements it keeps its content
 * and loses its markup, as an unknown element does.
 * @param {Frames} frames @param {any} frame
 */
function openFrame(frames, frame) {
  if (frame.keep) {
    if (frames.kept < MAX_NESTING) frames.kept++;
    else frame.keep = false;
  }
  frames.open.set(frame.tag, (frames.open.get(frame.tag) ?? 0) + 1);
  frames.stack.push(frame);
}

/**
 * Close the innermost open element named `name` and every frame inside
 * it; nothing when no such element is open.
 * @param {Frames} frames @param {string} name
 */
function closeElement(frames, name) {
  if ((frames.open.get(name) ?? 0) === 0) return;
  const stack = frames.stack;
  let depth = stack.length - 1;
  while (stack[depth].tag !== name) depth--;
  while (stack.length > depth) closeFrame(frames);
}

/**
 * Classify ONE tag — what CommonMark's inline phase hands out, since at
 * that level a tag is not an element (`<b>bold</b>` is three siblings).
 * Returns null when the source is not exactly one tag.
 * @param {string} source
 * @param {HtmlParseOptions} [options]
 * @returns {{name: string, closing: boolean, complete: boolean,
 *   drop: boolean, props: Record<string, any>|null} | null}
 */
export function parseHtmlTag(source, options = {}) {
  const tag = scanTag(source, 0, SCANNED_STOPS);
  if (tag === null || tag.end !== source.length) return null;
  const known = ELEMENTS.has(tag.name);
  return {
    name: tag.name,
    closing: tag.closing,
    // a void element or an explicit `<x/>` never takes an end tag
    complete: tag.selfClosing || VOID.has(tag.name),
    drop: DROP_CONTENT.has(tag.name),
    props: known ? attrsFor(tag, options.sanitizeUrl ?? sanitizeUrl) : null,
  };
}

/**
 * Pop the innermost frame into its parent, dropping unknown elements.
 * Children are moved one at a time: a frame may hold more of them than a
 * call can take as arguments.
 * @param {Frames} frames
 */
function closeFrame(frames) {
  const stack = frames.stack;
  const frame = stack.pop();
  frames.open.set(frame.tag, (frames.open.get(frame.tag) ?? 1) - 1);
  if (frame.keep) frames.kept--;
  const parent = stack[stack.length - 1].children;
  if (frame.drop) return;
  const children = frame.children;
  if (frame.keep) {
    const element = [frame.tag, frame.props];
    for (let i = 0; i < children.length; i++) element.push(children[i]);
    parent.push(element);
  }
  else {
    for (let i = 0; i < children.length; i++) parent.push(children[i]);
  }
}

/** The allow-listed attributes of one tag, as vnode props. */
function attrsFor(tag, urlPolicy) {
  const allowed = ELEMENT_ATTRS[tag.name];
  /** @type {Record<string, any>} */
  const props = {};
  for (const [name, value] of tag.attrs) {
    const lower = name.toLowerCase();
    if (!GLOBAL_ATTRS.has(lower) && (allowed === undefined || !allowed.has(lower))) continue;
    if (URL_ATTRS.has(lower)) {
      const safe = urlPolicy(decodeReferences(value));
      if (safe !== null) props[lower] = safe;
      continue;
    }
    if (lower === 'srcset') {
      const safe = filterSrcset(decodeReferences(value), urlPolicy);
      if (safe !== '') props.srcset = safe;
      continue;
    }
    props[lower] = decodeReferences(value);
  }
  return props;
}

/** HTML's ASCII whitespace: space, tab, line feed, form feed, carriage return. */
function isAsciiSpace(code) {
  return code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0C || code === 0x0D;
}

/**
 * Pass every candidate URL of a `srcset` through the URL policy and write
 * back the candidates that survive. The list is read the way the HTML
 * specification reads it: a candidate is a URL (a run of non-whitespace; a
 * trailing comma ends a candidate that has no descriptor) followed by
 * descriptors up to the next comma outside parentheses.
 * @param {string} value
 * @param {(url: string) => (string|null)} urlPolicy
 * @returns {string}
 */
function filterSrcset(value, urlPolicy) {
  const kept = [];
  const n = value.length;
  let i = 0;
  while (i < n) {
    while (i < n && (value.charCodeAt(i) === 0x2C || isAsciiSpace(value.charCodeAt(i)))) i++;
    if (i >= n) break;
    let start = i;
    while (i < n && !isAsciiSpace(value.charCodeAt(i))) i++;
    let url = value.slice(start, i);
    let descriptors = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    }
    else {
      start = i;
      let depth = 0;
      while (i < n) {
        const c = value.charCodeAt(i);
        if (c === 0x28) depth++;
        else if (c === 0x29 && depth > 0) depth--;
        else if (c === 0x2C && depth === 0) break;
        i++;
      }
      descriptors = value.slice(start, i).trim().replace(/\s+/g, ' ');
    }
    if (url === '') continue;
    const safe = urlPolicy(url);
    if (safe === null || /\s/.test(safe)) continue;
    kept.push(descriptors === '' ? safe : safe + ' ' + descriptors);
  }
  return kept.join(', ');
}

/** Tag-name characters: a letter, then letters, digits or `-`. */
const RE_TAG = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/;

/**
 * Where the runs a tag scan reads end, from any offset of `source`: past
 * spaces, an attribute name, a bare value, and the next quote of a kind
 * (`-1` for none).
 * @typedef {object} TagStops
 * @property {(source: string, i: number) => number} space
 * @property {(source: string, i: number) => number} name
 * @property {(source: string, i: number) => number} value
 * @property {(source: string, quote: number, i: number) => number} quote
 */

/** @param {number} code */
function isSpace(code) {
  return code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D || code === 0x0C;
}

/** @param {number} code a character that ends an attribute name */
function endsName(code) {
  return isSpace(code) || code === 0x3D /* = */ || code === 0x3E /* > */ || code === 0x2F /* / */;
}

/** @param {number} code a character that ends a bare attribute value */
function endsValue(code) {
  return isSpace(code) || code === 0x3E /* > */;
}

/**
 * Stops found by scanning forward: the cheap answer for a tag that ends,
 * since the scan then reads only the tag.
 * @type {TagStops}
 */
const SCANNED_STOPS = {
  space: (source, i) => {
    while (i < source.length && isSpace(source.charCodeAt(i))) i++;
    return i;
  },
  name: (source, i) => {
    while (i < source.length && !endsName(source.charCodeAt(i))) i++;
    return i;
  },
  value: (source, i) => {
    while (i < source.length && !endsValue(source.charCodeAt(i))) i++;
    return i;
  },
  quote: (source, quote, i) => source.indexOf(String.fromCharCode(quote), i),
};

/**
 * Stops read from tables built in one backward pass: the answer once a
 * fragment's tags stop ending, when every `<` after would otherwise read
 * the same runs again.
 * @param {string} source
 * @returns {TagStops}
 */
function tabledStops(source) {
  const n = source.length;
  const space = new Int32Array(n + 1);
  const name = new Int32Array(n + 1);
  const value = new Int32Array(n + 1);
  const double = new Int32Array(n + 1);
  const single = new Int32Array(n + 1);
  space[n] = name[n] = value[n] = n;
  double[n] = single[n] = -1;
  for (let i = n - 1; i >= 0; i--) {
    const code = source.charCodeAt(i);
    space[i] = isSpace(code) ? space[i + 1] : i;
    name[i] = endsName(code) ? i : name[i + 1];
    value[i] = endsValue(code) ? i : value[i + 1];
    double[i] = code === 0x22 ? i : double[i + 1];
    single[i] = code === 0x27 ? i : single[i + 1];
  }
  const at = (/** @type {Int32Array} */ table, /** @type {number} */ i) => table[Math.min(i, n)];
  return {
    space: (_, i) => at(space, i),
    name: (_, i) => at(name, i),
    value: (_, i) => at(value, i),
    quote: (_, quote, i) => at(quote === 0x22 ? double : single, i),
  };
}

/**
 * Scan one tag at `pos`. Attribute values may be double-quoted,
 * single-quoted or bare; an unterminated tag is not a tag.
 *
 * From the top of the attribute loop a scan is a function of where it
 * stands and nothing else, so `unended` — the loop offsets earlier scans
 * found leading nowhere — ends a scan the moment it reaches one, and a
 * failing scan adds the offsets it visited. With tabled stops that makes
 * every scan of one fragment, from every `<`, add up to a single pass.
 * @param {string} source @param {number} pos
 * @param {TagStops} stops
 * @param {Set<number>} [unended]
 * @returns {{name: string, closing: boolean, selfClosing: boolean,
 *   attrs: [string, string][], end: number} | null}
 */
function scanTag(source, pos, stops, unended) {
  const m = RE_TAG.exec(source.slice(pos, pos + 64));
  if (m === null) return null;
  const closing = m[1] === '/';
  const name = m[2].toLowerCase();
  let i = pos + m[0].length;
  /** @type {[string, string][]} */
  const attrs = [];
  /** @type {number[]} */
  const visited = [];
  const fail = () => {
    if (unended !== undefined) for (const top of visited) unended.add(top);
    return null;
  };
  while (i < source.length) {
    if (unended !== undefined) {
      if (unended.has(i)) return fail();
      visited.push(i);
    }
    i = stops.space(source, i);
    const c = source.charCodeAt(i);
    if (c === 0x3E /* > */) return { name, closing, selfClosing: false, attrs, end: i + 1 };
    if (c === 0x2F /* / */ && source.charCodeAt(i + 1) === 0x3E)
      return { name, closing, selfClosing: true, attrs, end: i + 2 };
    const start = i;
    i = stops.name(source, i);
    if (i === start) return fail(); // a character no attribute name may start with
    const attrName = source.slice(start, i);
    i = stops.space(source, i);
    if (source.charCodeAt(i) !== 0x3D /* = */) {
      attrs.push([attrName, '']);
      continue;
    }
    i = stops.space(source, i + 1);
    const quote = source.charCodeAt(i);
    if (quote === 0x22 || quote === 0x27) {
      const close = stops.quote(source, quote, i + 1);
      if (close === -1) return fail();
      attrs.push([attrName, source.slice(i + 1, close)]);
      i = close + 1;
      continue;
    }
    const valueStart = i;
    i = stops.value(source, i);
    attrs.push([attrName, source.slice(valueStart, i)]);
  }
  return fail(); // never terminated
}
