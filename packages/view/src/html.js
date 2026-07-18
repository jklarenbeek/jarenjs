//@ts-check
/**
 * @file Server-side rendering: vnode JSON → HTML string.
 *
 * No DOM, no state — a pure fold over the vnode tree, usable anywhere
 * (Node, workers, edge runtimes). `on` bindings and `key`s are renderer
 * instructions and produce no markup; hydration is a client-side
 * re-render into the same container (see docs/VIEW-FORMAT.md §6).
 */

import {
  isTextNode,
  isElementNode,
  propsOf,
  childrenOf,
} from './vnode.js';
import { styleToString } from './dom.js';

/** Void elements per the HTML standard: no children, no end tag. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Props that never serialize to markup. */
const SKIP_PROPS = new Set(['key', 'on']);

/**
 * Escape text content: `&`, `<`, `>`.
 * @param {string} text
 * @returns {string}
 */
export function escapeText(text) {
  return text.replace(/[&<>]/g, (ch) => (
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'
  ));
}

/**
 * Escape a double-quoted attribute value: `&`, `"`.
 * @param {string} value
 * @returns {string}
 */
export function escapeAttribute(value) {
  return value.replace(/[&"]/g, (ch) => (ch === '&' ? '&amp;' : '&quot;'));
}

/**
 * Render a vnode JSON document to an HTML string.
 *
 * @example
 * renderToString(['p', { class: 'note' }, 'a < b'])
 * // -> '<p class="note">a &lt; b</p>'
 *
 * @param {any} vnode
 * @returns {string}
 */
export function renderToString(vnode) {
  if (isTextNode(vnode)) {
    return escapeText(String(vnode));
  }
  if (!isElementNode(vnode)) {
    return '';
  }
  const tag = vnode[0];
  const props = propsOf(vnode);
  let out = '<' + tag;
  for (const name in props) {
    if (SKIP_PROPS.has(name)) continue;
    let value = props[name];
    if (value == null || value === false) continue;
    if (name === 'style' && typeof value === 'object') {
      value = styleToString(value);
      if (value === '') continue;
    }
    out += value === true
      ? ' ' + name
      : ' ' + name + '="' + escapeAttribute(String(value)) + '"';
  }
  if (VOID_ELEMENTS.has(tag)) {
    return out + '>';
  }
  out += '>';
  const children = childrenOf(vnode);
  for (let i = 0; i < children.length; i++) {
    out += renderToString(children[i]);
  }
  return out + '</' + tag + '>';
}
