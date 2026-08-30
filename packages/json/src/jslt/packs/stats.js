//@ts-check
/**
 * @file The statistics pack — aggregators core does not ship as query
 * operators. `sum`/`min`/`max`/`avg`/`count` are ALREADY core query
 * operators and are NOT re-registered here; this pack adds the summaries
 * they don't cover, each a thin registration over `@jarenjs/core/stats`,
 * which is the suite's one home for the arithmetic. What is this pack's
 * own is the user-facing scale of `$percentile`: `p` on 0..100, clamped,
 * under the linear-interpolation rule an analyst expects.
 */

import { mean, median, variance, stddev, quantile } from '@jarenjs/core/stats';

/**
 * Linear-interpolation percentile; `p` in [0, 100], clamped.
 * @param {number[]} xs
 * @param {number} p
 */
function percentile(xs, p) {
  return quantile(xs, Math.max(0, Math.min(100, p)) / 100, { method: 'linear' });
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
