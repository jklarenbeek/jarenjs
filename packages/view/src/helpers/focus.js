//@ts-check
import { attributeOf, childNodesOf, domReaderOf, nodeTypeOf } from '../members.js';

/** Resolve an exact data-ref without interpolating a CSS selector. The tree
 * is read through the DOM's own accessors of `node`'s realm: a `form`
 * answers `childNodes` and `getAttribute` through controls of those names,
 * which would hide every ref inside it. */
/** @param {any} node @param {string} token @returns {any | null} */
export function findByRef(node, token) {
  return findIn(domReaderOf(null, node), node, token);
}

/** @param {import('../members.js').DomReader} dom @param {any} node @param {string} token @returns {any | null} */
function findIn(dom, node, token) {
  const element = dom.getAttribute !== null ? node != null && nodeTypeOf(dom, node) === 1 : typeof node?.getAttribute === 'function';
  if (element && attributeOf(dom, node, 'data-ref') === token) return node;
  const children = node == null ? undefined : childNodesOf(dom, node);
  if (children === undefined) return null;
  for (let i = 0; i < children.length; i++) {
    const found = findIn(dom, children[i], token);
    if (found !== null) return found;
  }
  return null;
}
