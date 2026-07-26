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
  const stack = [{ tag: '', children: /** @type {any[]} */ ([]) }];
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
    const tag = scanTag(source, i);
    if (tag === null) {
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
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth].tag !== tag.name) continue;
        for (let k = stack.length - 1; k >= depth; k--) closeFrame(stack);
        break;
      }
      continue;
    }
    const known = ELEMENTS.has(tag.name);
    if (known && (tag.selfClosing || VOID.has(tag.name))) {
      stack[stack.length - 1].children.push([tag.name, attrsFor(tag, urlPolicy)]);
      continue;
    }
    // An unknown element still opens a frame: its CHILDREN are content
    // the reader wrote and should keep, its own markup is what goes.
    stack.push({
      tag: tag.name,
      children: [],
      props: known ? attrsFor(tag, urlPolicy) : null,
      keep: known && !tag.selfClosing,
      drop: DROP_CONTENT.has(tag.name),
    });
  }
  flushText();
  while (stack.length > 1) closeFrame(stack);
  return stack[0].children;
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
  const tag = scanTag(source, 0);
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

/** Pop the innermost frame into its parent, dropping unknown elements. */
function closeFrame(stack) {
  const frame = stack.pop();
  const parent = stack[stack.length - 1].children;
  if (frame.drop) return;
  if (frame.keep) parent.push([frame.tag, frame.props, ...frame.children]);
  else parent.push(...frame.children);
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
    props[lower] = decodeReferences(value);
  }
  return props;
}

/** Tag-name characters: a letter, then letters, digits or `-`. */
const RE_TAG = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/;

/**
 * Scan one tag at `pos`. Attribute values may be double-quoted,
 * single-quoted or bare; an unterminated tag is not a tag.
 * @returns {{name: string, closing: boolean, selfClosing: boolean,
 *   attrs: [string, string][], end: number} | null}
 */
function scanTag(source, pos) {
  const m = RE_TAG.exec(source.slice(pos, pos + 64));
  if (m === null) return null;
  const closing = m[1] === '/';
  const name = m[2].toLowerCase();
  let i = pos + m[0].length;
  /** @type {[string, string][]} */
  const attrs = [];
  while (i < source.length) {
    while (i < source.length && isSpace(source.charCodeAt(i))) i++;
    const c = source.charCodeAt(i);
    if (c === 0x3E /* > */) return { name, closing, selfClosing: false, attrs, end: i + 1 };
    if (c === 0x2F /* / */ && source.charCodeAt(i + 1) === 0x3E)
      return { name, closing, selfClosing: true, attrs, end: i + 2 };
    const start = i;
    while (i < source.length && !isSpace(source.charCodeAt(i))
      && source.charCodeAt(i) !== 0x3D && source.charCodeAt(i) !== 0x3E
      && source.charCodeAt(i) !== 0x2F) i++;
    if (i === start) return null; // a character no attribute name may start with
    const attrName = source.slice(start, i);
    while (i < source.length && isSpace(source.charCodeAt(i))) i++;
    if (source.charCodeAt(i) !== 0x3D /* = */) {
      attrs.push([attrName, '']);
      continue;
    }
    i++;
    while (i < source.length && isSpace(source.charCodeAt(i))) i++;
    const quote = source.charCodeAt(i);
    if (quote === 0x22 || quote === 0x27) {
      const close = source.indexOf(String.fromCharCode(quote), i + 1);
      if (close === -1) return null;
      attrs.push([attrName, source.slice(i + 1, close)]);
      i = close + 1;
      continue;
    }
    const valueStart = i;
    while (i < source.length && !isSpace(source.charCodeAt(i))
      && source.charCodeAt(i) !== 0x3E) i++;
    attrs.push([attrName, source.slice(valueStart, i)]);
  }
  return null; // never terminated
}

function isSpace(code) {
  return code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D || code === 0x0C;
}
