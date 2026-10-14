//@ts-check
/**
 * Shape helpers for the parser's hostile-input tests; the growth-ratio
 * timing they use lives in `test/lib/growth.js`.
 */

/**
 * The depth of a vnode or AST value — arrays and objects each count one
 * level — measured with an explicit stack, so a tree too deep to recurse
 * over still has a depth.
 * @param {unknown} root
 * @returns {number}
 */
export function depthOf(root) {
  let max = 0;
  /** @type {[unknown, number][]} */
  const stack = [[root, 1]];
  while (stack.length > 0) {
    const [value, depth] = /** @type {[unknown, number]} */ (stack.pop());
    if (value === null || typeof value !== 'object') continue;
    if (depth > max) max = depth;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return max;
}
