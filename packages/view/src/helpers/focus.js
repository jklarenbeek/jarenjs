//@ts-check
/** Resolve an exact data-ref without interpolating a CSS selector. */
/** @param {any} node @param {string} token @returns {any | null} */
export function findByRef(node, token) {
  if (typeof node?.getAttribute === 'function' && node.getAttribute('data-ref') === token) return node;
  const children = node?.childNodes;
  if (children === undefined) return null;
  for (let i = 0; i < children.length; i++) {
    const found = findByRef(children[i], token);
    if (found !== null) return found;
  }
  return null;
}
