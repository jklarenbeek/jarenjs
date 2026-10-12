//@ts-check
/** Number formatting and projection memoization for the website. */

import { Float64 } from '@jarenjs/core/math';

/**
 * The clock the boundaries time with: `performance` where it exists,
 * `Date` in a plain Node process. Returns milliseconds.
 */
export const now = () => (typeof performance !== 'undefined' ? performance : Date).now();

/**
 * Run `fn` once and report its value with the milliseconds it took.
 * @template T
 * @param {() => T} fn
 * @returns {{ value: T, ms: number }}
 */
export function timed(fn) {
  const start = now();
  const value = fn();
  return { value, ms: now() - start };
}

/** A value as pretty-printed JSON — the site's one code-block format. */
export const formatJson = (value) => JSON.stringify(value, null, 2);

export { memo1 } from '@jarenjs/studio/component';

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

/**
 * A speed ratio: `>1` always means "Jaren is N× faster". A ratio that is
 * not a positive finite number (a timing of zero on either side) compares
 * nothing, so it prints as unknown instead of `Infinity× slower`.
 */
export function formatRatio(ratio) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) return '—';
  if (ratio >= 1) return `${round3(ratio)}× faster`;
  return `${round3(1 / ratio)}× slower`;
}

/** Benchmark numbers display at 3 significant figures. */
function round3(value) {
  return Float64.roundToPrecision(value, 3);
}
