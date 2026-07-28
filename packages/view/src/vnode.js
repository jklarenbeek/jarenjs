//@ts-check
/**
 * @file The Jaren vnode contract — the JSON vocabulary for user interfaces.
 *
 * A vnode is a plain JSON value, designed to be the *output* of a JSLT
 * stylesheet (`@jarenjs/json/jslt`) the way HTML is the output of XSLT:
 *
 *  - text:    a `string` or a `number` (rendered as `String(value)`)
 *  - element: an array whose first item is a string tag:
 *             `[tag, props?, ...children]`
 *  - list:    an array whose first item is NOT a string — spliced into the
 *             parent's children in place (the natural shape of a JSLT
 *             `[{ "$apply": ... }]` body)
 *  - skipped: `null`, `undefined`, `true` and `false` render nothing
 *             (so `{"$if": ...}` bodies compose without wrappers)
 *
 * The second item of an element is its props object when it is a plain
 * object; otherwise it is the first child. Recognized special props:
 *
 *  - `key`   — reconciliation identity for keyed children (never rendered)
 *  - `on`    — `{ [eventType]: binding }`; the binding is opaque JSON handed
 *              to the renderer's `onEvent` hook (in `@jarenjs/app`: an
 *              action name or `{ "action": name, "with": payload }`)
 *  - `style` — a CSS string or an object of declarations
 *
 * Everything in this module is allocation-light and does no validation
 * beyond shape dispatch: the vnode grammar is published as JSON Schema in
 * `schemas/jaren-vnode.schema.json` for validating untrusted documents.
 */

import { isJsonObject } from '@jarenjs/core/object';

/** Frozen empty props object shared by all prop-less elements. */
export const EMPTY_PROPS = Object.freeze({});

/**
 * The reserved widget tag (VIEW-FORMAT §7). A valid custom-element name,
 * so a renderer that predates the widget vocabulary degrades to an inert,
 * harmless element — and the dash makes collision with real HTML tags
 * impossible. (`$widget` is impossible: in query/JSLT rule bodies a
 * string leaf starting with `$` is a path expression.)
 */
export const WIDGET_TAG = 'jaren-widget';

/**
 * A vnode JSON value.
 * @typedef {string | number | boolean | null | undefined | VNodeElement | VNodeJson[]} VNodeJson
 */
/**
 * An element vnode: `[tag, props?, ...children]`.
 * @typedef {Array<any>} VNodeElement
 */

/**
 * Is this vnode a text node (string or finite number)?
 * @param {any} vnode
 * @returns {vnode is string | number}
 */
export function isTextNode(vnode) {
  const t = typeof vnode;
  return t === 'string' || t === 'number';
}

/**
 * Is this vnode an element (`[tag, ...]` with a string tag)?
 * @param {any} vnode
 * @returns {vnode is VNodeElement}
 */
export function isElementNode(vnode) {
  return Array.isArray(vnode) && typeof vnode[0] === 'string';
}

/**
 * Is this value skipped by the renderer (`null`/`undefined`/booleans)?
 * @param {any} vnode
 * @returns {boolean}
 */
export function isSkippedNode(vnode) {
  return vnode == null || vnode === true || vnode === false;
}

/**
 * Is this vnode a widget node (`["jaren-widget", props]`, VIEW-FORMAT §7)?
 * @param {any} vnode
 * @returns {vnode is VNodeElement}
 */
export function isWidgetNode(vnode) {
  return Array.isArray(vnode) && vnode[0] === WIDGET_TAG;
}

/**
 * The props of an element vnode; `EMPTY_PROPS` when it has none.
 * @param {VNodeElement} vnode
 * @returns {Record<string, any>}
 */
export function propsOf(vnode) {
  const second = vnode.length > 1 ? vnode[1] : undefined;
  return isJsonObject(second) ? second : EMPTY_PROPS;
}

/**
 * The reconciliation key of an element vnode, or `undefined`.
 * @param {any} vnode
 * @returns {string | number | undefined}
 */
export function keyOf(vnode) {
  return isElementNode(vnode) ? propsOf(vnode).key : undefined;
}

/**
 * The renderable children of an element vnode as a flat array: nested
 * lists are spliced in place, skipped values are dropped.
 * @param {VNodeElement} vnode
 * @returns {VNodeJson[]}
 */
export function childrenOf(vnode) {
  const start = vnode.length > 1 && isJsonObject(vnode[1]) ? 2 : 1;
  /** @type {VNodeJson[]} */
  const out = [];
  for (let i = start; i < vnode.length; i++) {
    appendChild(out, vnode[i]);
  }
  return out;
}

/**
 * Append one child value to `out`, splicing lists and dropping skipped
 * values.
 * @param {VNodeJson[]} out
 * @param {any} child
 */
function appendChild(out, child) {
  if (isSkippedNode(child)) return;
  if (Array.isArray(child) && typeof child[0] !== 'string') {
    for (let i = 0; i < child.length; i++) appendChild(out, child[i]);
    return;
  }
  out.push(child);
}

/**
 * Convenience element constructor for JavaScript-side views and tests —
 * produces the same JSON an authored stylesheet would.
 *
 * @example
 * h('li', { key: 7, class: 'todo' }, 'Buy milk')
 * // -> ['li', { key: 7, class: 'todo' }, 'Buy milk']
 *
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {...any} children
 * @returns {VNodeElement}
 */
export function h(tag, props, ...children) {
  return [tag, props ?? EMPTY_PROPS, ...children];
}

/**
 * Two vnodes are "the same node" for reconciliation when a patch in place
 * is possible: both text, or elements with equal tag and equal key.
 * @param {VNodeJson} a
 * @param {VNodeJson} b
 * @returns {boolean}
 */
export function isSameNode(a, b) {
  if (isTextNode(a)) return isTextNode(b);
  if (isTextNode(b)) return false;
  return /** @type {VNodeElement} */ (a)[0] === /** @type {VNodeElement} */ (b)[0]
    && keyOf(a) === keyOf(b);
}
