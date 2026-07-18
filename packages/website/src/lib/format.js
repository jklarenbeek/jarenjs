//@ts-check
/** Number formatting for benchmark displays (ported from the website's utils). */

/**
 * Single-entry memoization on argument identity. The viewModel wraps
 * its derivations with this so an unchanged input slice returns the
 * PREVIOUS node by reference — which makes the JSLT memo (and through
 * it the renderer's === fast path) fire for the whole subtree.
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
    lastArgs = args;
    lastResult = fn(...args);
    return lastResult;
  });
}

/** Nanoseconds to a friendly unit string. */
export function formatNs(ns) {
  if (ns === null || ns === undefined || Number.isNaN(ns)) return '—';
  if (ns < 1000) return `${round3(ns)} ns`;
  if (ns < 1e6) return `${round3(ns / 1000)} µs`;
  return `${round3(ns / 1e6)} ms`;
}

/** Milliseconds to a friendly string. */
export function formatMs(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 0.001) return `${round3(ms * 1e6)} ns`;
  if (ms < 1) return `${round3(ms * 1000)} µs`;
  return `${round3(ms)} ms`;
}

/** A speed ratio: `>1` always means "Jaren is N× faster". */
export function formatRatio(ratio) {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—';
  if (ratio >= 1) return `${round3(ratio)}× faster`;
  return `${round3(1 / ratio)}× slower`;
}

function round3(value) {
  return Number(value.toPrecision(3));
}
