//@ts-check
/**
 * Single-entry memoization on argument identity. The viewModel wraps
 * its derivations with this so an unchanged input slice returns the
 * PREVIOUS node by reference — which makes the JSLT memo (and through
 * it the renderer's === fast path) fire for the whole subtree.
 * Only successful calls populate the memo; a throwing call keeps the
 * previous successful entry available.
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @returns {F}
 */
export function memo1(fn) {
  /** @type {any[] | null} */
  let lastArgs = null;
  /** @type {any} */
  let lastResult;
  return /** @type {F} */ ((...args) => {
    if (lastArgs !== null && lastArgs.length === args.length
      && lastArgs.every((value, i) => value === args[i])) {
      return lastResult;
    }
    const result = fn(...args);
    lastArgs = args;
    lastResult = result;
    return lastResult;
  });
}
