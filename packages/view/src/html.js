//@ts-check
/**
 * @file Server-side rendering: vnode JSON → HTML string.
 *
 * No DOM, no state — a pure fold over the vnode tree, usable anywhere
 * (Node, workers, edge runtimes). `on` bindings and `key`s are renderer
 * instructions and produce no markup; hydration is a client-side
 * re-render into the same container (see docs/VIEW-FORMAT.md §6). A
 * `jaren-widget` vnode serializes its host element around the widget's
 * declarative `ssr` fallback (§7) — still pure, no widget is mounted.
 */

import {
  isTextNode,
  isElementNode,
  propsOf,
  childrenOf,
  WIDGET_TAG,
} from './vnode.js';
import { styleToString } from './dom.js';

/** Void elements per the HTML standard: no children, no end tag. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Props that never serialize to markup. */
const SKIP_PROPS = new Set(['key', 'on']);

/** Widget-vnode props that configure the widget, not the host element. */
const WIDGET_SKIP_PROPS = new Set(['key', 'on', 'name', 'props', 'tag']);

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
 * Serialize a props object to an attribute string over a skip set.
 * @param {Record<string, any>} props
 * @param {Set<string>} skip
 * @returns {string}
 */
function serializeProps(props, skip) {
  let out = '';
  for (const name in props) {
    if (skip.has(name)) continue;
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
  return out;
}

/**
 * @typedef {Object} RenderToStringOptions
 * @property {Record<string, { ssr?: (props: any) => any }>} [widgets] -
 *   Registered widget definitions by name: a `jaren-widget` vnode
 *   serializes its host element around the widget's `ssr(props)` vnode
 *   when the widget is registered and has one, else empty
 *   (VIEW-FORMAT §7).
 */

/**
 * Render a vnode JSON document to an HTML string.
 *
 * @example
 * renderToString(['p', { class: 'note' }, 'a < b'])
 * // -> '<p class="note">a &lt; b</p>'
 *
 * @param {any} vnode
 * @param {RenderToStringOptions} [options]
 * @returns {string}
 */
export function renderToString(vnode, options = {}) {
  if (isTextNode(vnode)) {
    return escapeText(String(vnode));
  }
  if (!isElementNode(vnode)) {
    return '';
  }
  const tag = vnode[0];
  const props = propsOf(vnode);
  if (tag === WIDGET_TAG) {
    const hostTag = typeof props.tag === 'string' && props.tag !== '' ? props.tag : 'div';
    const widgets = options.widgets;
    const def = widgets !== undefined && typeof props.name === 'string'
      && Object.hasOwn(widgets, props.name) ? widgets[props.name] : undefined;
    // one read: acquisition and invocation are one boundary here too —
    // renderToString is pure and offers no isolation, so a hostile
    // `ssr` accessor propagates to the caller exactly like a throwing
    // `ssr()` (the documented behavior for both)
    const ssr = def !== undefined ? def.ssr : undefined;
    const inner = ssr !== undefined
      ? renderToString(ssr.call(def, props.props ?? null), options)
      : '';
    return '<' + hostTag + serializeProps(props, WIDGET_SKIP_PROPS) + '>'
      + inner + '</' + hostTag + '>';
  }
  let out = '<' + tag + serializeProps(props, SKIP_PROPS);
  if (VOID_ELEMENTS.has(tag)) {
    return out + '>';
  }
  out += '>';
  const children = childrenOf(vnode);
  for (let i = 0; i < children.length; i++) {
    out += renderToString(children[i], options);
  }
  return out + '</' + tag + '>';
}
