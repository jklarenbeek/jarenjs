//@ts-check
import { mulberry32 } from './random.js';
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

/**
 * @typedef {{ resamples: number, seed: number, maxWork?: number,
 *   statistic?: 'mean-difference' | ((a: number[], b: number[]) => number) }} PairedOptions
 */

/** Validate the work before allocating any resample. */
function pairedSample(pairs, options) {
  if (!Array.isArray(pairs) || pairs.length === 0 || pairs.some(pair =>
    !Array.isArray(pair) || pair.length !== 2 || !pair.every(Number.isFinite)))
    throw new TypeError('paired samples require nonempty finite number pairs');
  const { resamples, seed, statistic = 'mean-difference', maxWork = 10000000 } = options ?? {};
  if (!Number.isSafeInteger(resamples) || resamples < 1 || resamples > 1000000
    || !Number.isSafeInteger(maxWork) || maxWork < 1 || maxWork > 100000000
    || pairs.length * resamples > maxWork)
    throw new RangeError('paired resampling exceeds its finite work budget');
  if (!Number.isSafeInteger(seed)) throw new TypeError('paired resampling requires an integer seed');
  if (statistic !== 'mean-difference' && typeof statistic !== 'function') throw new TypeError('invalid paired statistic');
  const a = pairs.map(pair => pair[0]), b = pairs.map(pair => pair[1]);
  const deltas = b.map((value, i) => value - a[i]);
  const finite = value => {
    if (!Number.isFinite(value)) throw new RangeError('paired statistic must be finite');
    return value;
  };
  const estimate = finite(statistic === 'mean-difference' ? mean(deltas) : statistic(a.slice(), b.slice()));
  return { a, b, deltas, estimate, finite, statistic, resamples, seed: seed >>> 0, random: mulberry32(seed) };
}

/**
 * Seeded paired percentile bootstrap. The default is the mean of (b - a),
 * summing sampled deltas in draw order. Callbacks own their determinism.
 * @param {readonly (readonly [number, number])[]} pairs
 * @param {PairedOptions & { level?: number, quantile?: QuantileMethod }} options
 * @returns {{ estimate: number, lower: number, upper: number, resamples: number,
 *   seed: number, level: number, method: 'paired-bootstrap', quantile: QuantileMethod }}
 */
export function pairedBootstrap(pairs, options) {
  const sample = pairedSample(pairs, options);
  const { level = 0.95, quantile: method = 'nearest-rank' } = options;
  if (!(level > 0 && level < 1) || !Number.isFinite(level)) throw new RangeError('bootstrap level must be between zero and one');
  if (!METHODS.includes(method)) throw new TypeError('invalid bootstrap quantile method');
  const values = [];
  for (let r = 0; r < sample.resamples; r++) {
    let sum = 0;
    const a = [], b = [];
    for (let i = 0; i < pairs.length; i++) {
      const index = Math.floor(sample.random() * pairs.length);
      if (sample.statistic === 'mean-difference') sum += sample.deltas[index];
      else { a.push(sample.a[index]); b.push(sample.b[index]); }
    }
    values.push(sample.finite(sample.statistic === 'mean-difference' ? sum / pairs.length : sample.statistic(a, b)));
  }
  const tail = (1 - level) / 2;
  return { estimate: sample.estimate, lower: quantile(values, tail, { method }), upper: quantile(values, 1 - tail, { method }),
    resamples: sample.resamples, seed: sample.seed, level, method: 'paired-bootstrap', quantile: method };
}

/**
 * Monte Carlo paired label-swap test, including ties; p = (extreme + 1)/(R + 1).
 * The exchangeable unit is one pair, not independently sampled observations.
 * @param {readonly (readonly [number, number])[]} pairs
 * @param {PairedOptions & { alternative?: 'two-sided' | 'greater' | 'less' }} options
 * @returns {{ estimate: number, pValue: number, resamples: number, seed: number,
 *   alternative: string, method: 'paired-permutation', exact: false }}
 */
export function permutationTest(pairs, options) {
  const sample = pairedSample(pairs, options);
  const { alternative = 'two-sided' } = options;
  if (!['two-sided', 'greater', 'less'].includes(alternative)) throw new TypeError('invalid permutation alternative');
  let extreme = 0;
  for (let r = 0; r < sample.resamples; r++) {
    let sum = 0;
    const a = [], b = [];
    for (let i = 0; i < pairs.length; i++) {
      const swap = sample.random() < 0.5;
      if (sample.statistic === 'mean-difference') sum += sample.deltas[i] * (swap ? -1 : 1);
      else { a.push(swap ? sample.b[i] : sample.a[i]); b.push(swap ? sample.a[i] : sample.b[i]); }
    }
    const value = sample.finite(sample.statistic === 'mean-difference' ? sum / pairs.length : sample.statistic(a, b));
    if (alternative === 'two-sided' ? Math.abs(value) >= Math.abs(sample.estimate)
      : alternative === 'greater' ? value >= sample.estimate : value <= sample.estimate) extreme++;
  }
  return { estimate: sample.estimate, pValue: (extreme + 1) / (sample.resamples + 1),
    resamples: sample.resamples, seed: sample.seed, alternative, method: 'paired-permutation', exact: false };
}
