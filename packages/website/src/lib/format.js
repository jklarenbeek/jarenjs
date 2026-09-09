//@ts-check
/** Number formatting and projection memoization for the website. */

import { Float64 } from '@jarenjs/core/math';

/**
 * The clock the boundaries time with: `performance` where it exists,
 * `Date` in a plain Node process. Returns milliseconds.
 */
export const now = () => (typeof performance !== 'undefined' ? performance : Date).now();

/** A value as pretty-printed JSON — the site's one code-block format. */
export const formatJson = (value) => JSON.stringify(value, null, 2);

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

/**
 * Milliseconds always rendered in the ms unit — no µs/ns scaling.
 * The playground's timing cards sit side by side (compile next to run,
 * parse next to render), so they keep one unit: a reader compares the
 * numbers directly instead of the units.
 */
export function formatMsUnscaled(ms) {
  return `${round3(ms)} ms`;
}

/** A speed ratio: `>1` always means "Jaren is N× faster". */
export function formatRatio(ratio) {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—';
  if (ratio >= 1) return `${round3(ratio)}× faster`;
  return `${round3(1 / ratio)}× slower`;
}

/** Benchmark numbers display at 3 significant figures. */
function round3(value) {
  return Float64.roundToPrecision(value, 3);
}
