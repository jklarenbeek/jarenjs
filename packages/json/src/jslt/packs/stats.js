//@ts-check
/**
 * @file The statistics pack — aggregators core does not ship as
 * operators. `sum`/`min`/`max`/`avg`/`count` are ALREADY core query
 * operators and are NOT re-registered here; this pack adds the summaries
 * they don't cover. The helpers are small pure functions defined in this
 * file (their natural home — core carries no statistics module), each a
 * deterministic function of its array argument.
 */

/** @param {number[]} xs */
function mean(xs) {
  if (xs.length === 0) return undefined;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample variance (n−1). @param {number[]} xs */
function variance(xs) {
  if (xs.length < 2) return undefined;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / (xs.length - 1);
}

/** @param {number[]} xs */
function stddev(xs) {
  const v = variance(xs);
  return v === undefined ? undefined : Math.sqrt(v);
}

/** @param {number[]} xs */
function median(xs) {
  if (xs.length === 0) return undefined;
  const sorted = xs.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Linear-interpolation percentile; `p` in [0, 100]. @param {number[]} xs */
function percentile(xs, p) {
  if (xs.length === 0) return undefined;
  const sorted = xs.slice().sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (Math.max(0, Math.min(100, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

const aggNum = (signature, fn) => ({ kind: 'agg', signature, result: 'number', fn, pushable: false });

export const statsPack = {
  name: 'stats',
  entries: {
    $mean: aggNum(['seq<number>'], mean),
    $median: aggNum(['seq<number>'], median),
    $variance: aggNum(['seq<number>'], variance),
    $stddev: aggNum(['seq<number>'], stddev),
    $percentile: aggNum(['seq<number>', 'number'], percentile),
  },
};
