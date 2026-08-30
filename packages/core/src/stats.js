//@ts-check
/**
 * @file Descriptive statistics over a sample of numbers: the mean, the
 * sample variance and its root, the median, and a quantile that will
 * not answer until told which quantile it is being asked for.
 *
 * Before this file the suite computed these in two places with two
 * quantile rules — linear interpolation in the query layer's statistics
 * pack, nearest rank in the benchmark harness — and each was the right
 * rule for its consumer: an interpolated percentile is what an analyst
 * expects of `$percentile`, while a benchmark row of eleven readings
 * should not publish a latency nobody measured. Both rules stay; the
 * definitions move here so that there is one of each, and `quantile`
 * makes the caller name its method, because "the 95th percentile" of a
 * small sample is a different number under every one of the seven
 * common definitions and a default would decide silently.
 *
 * Every function answers `undefined` for a sample it cannot summarize —
 * an empty one, or fewer than two values for a variance — rather than
 * `NaN` or `0`: a number that was not measured must not format as one.
 * The caller's array is never reordered; a quantile sorts a copy.
 * Values are numbers by contract and are not checked one by one.
 */

/**
 * The arithmetic mean.
 * @param {readonly number[]} values
 * @returns {number | undefined} `undefined` for an empty sample
 */
export function mean(values) {
  if (values.length === 0) return undefined;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/**
 * The SAMPLE variance, with Bessel's correction (`n − 1`): the sample is
 * taken as drawn from a population it did not enumerate, which is what a
 * benchmark's rounds and a query's rows both are.
 * @param {readonly number[]} values
 * @returns {number | undefined} `undefined` for fewer than two values
 */
export function variance(values) {
  if (values.length < 2) return undefined;
  const m = /** @type {number} */ (mean(values));
  let sum = 0;
  for (const value of values) sum += (value - m) * (value - m);
  return sum / (values.length - 1);
}

/**
 * The sample standard deviation — the root of {@link variance}.
 * @param {readonly number[]} values
 * @returns {number | undefined} `undefined` where the variance is
 */
export function stddev(values) {
  const v = variance(values);
  return v === undefined ? undefined : Math.sqrt(v);
}

/**
 * @param {readonly number[]} values
 * @returns {number[]} an ascending copy
 */
function ascending(values) {
  return [...values].sort((a, b) => a - b);
}

/**
 * The median: the middle value, or the mean of the two middle values
 * when the sample has an even count.
 *
 * This is NOT `quantile(values, 0.5, …)` under either method, and on an
 * even count the three disagree: for `[1, 2, 3, 4]` the median is `2.5`,
 * the nearest-rank p50 is `2`, and the linear p50 is `2.5` only because
 * that sample happens to be evenly spaced. A consumer publishing a "p50"
 * beside a "p95" wants `quantile` with its method named; a consumer
 * asking for the median wants this.
 * @param {readonly number[]} values
 * @returns {number | undefined} `undefined` for an empty sample
 */
export function median(values) {
  if (values.length === 0) return undefined;
  const sorted = ascending(values);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * The quantile methods this module knows.
 *
 * - `'nearest-rank'`: the value at rank `max(1, ceil(p · n))` of the
 *   ascending sample — always a value that was measured, never one
 *   invented between two. The benchmark rule.
 * - `'linear'`: rank `(n − 1) · p`, interpolated linearly between the
 *   values at `floor` and `ceil` of it (Hyndman–Fan type 7, the default
 *   of R, NumPy and spreadsheets). The analyst's rule.
 * @typedef {'nearest-rank' | 'linear'} QuantileMethod
 */

/** @type {readonly QuantileMethod[]} */
const METHODS = ['nearest-rank', 'linear'];

/**
 * The `p`-quantile of a sample, `p` on `[0, 1]`, under a NAMED method.
 *
 * The method is required, not defaulted: on a small sample the common
 * definitions disagree by whole values, and a caller who did not say
 * which one it wanted has published a number it cannot explain.
 * @param {readonly number[]} values
 * @param {number} p - the probability, `0` (the minimum) to `1` (the maximum)
 * @param {{ method: QuantileMethod }} options
 * @returns {number | undefined} `undefined` for an empty sample
 * @throws {TypeError} when `method` is absent or not one of {@link QuantileMethod}
 * @throws {RangeError} when `p` is not a number in `[0, 1]`
 */
export function quantile(values, p, options) {
  const method = options?.method;
  if (!METHODS.includes(/** @type {any} */ (method)))
    throw new TypeError(`quantile needs { method: 'nearest-rank' | 'linear' }, got ${JSON.stringify(method)}`);
  if (typeof p !== 'number' || !(p >= 0 && p <= 1))
    throw new RangeError(`quantile needs p in [0, 1], got ${String(p)}`);
  const n = values.length;
  if (n === 0) return undefined;
  const sorted = ascending(values);
  if (method === 'nearest-rank') return sorted[Math.max(1, Math.ceil(p * n)) - 1];
  const rank = (n - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}
