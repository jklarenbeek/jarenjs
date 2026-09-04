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

/**
 * A summary over the whole sequence. `pushable: 'aggregate'` is a
 * promise about the FOLD, not just about purity: a SQL aggregate visits
 * the rows in an order nothing specifies, so only a summary whose value
 * depends on the multiset alone may carry the token — every one here
 * does. It also promises a finite number or `undefined` (the empty
 * answer) as its result, since a database column carries neither NaN
 * nor Infinity.
 */
const aggNum = (signature, fn) =>
  ({ kind: 'agg', signature, result: 'number', fn, pushable: 'aggregate' });

export const statsPack = {
  name: 'stats',
  entries: {
    $mean: aggNum(['seq<number>'], mean),
    $median: aggNum(['seq<number>'], median),
    $variance: aggNum(['seq<number>'], variance),
    $stddev: aggNum(['seq<number>'], stddev),
    // two operands: the sequence and the percentile. A SQL aggregate
    // cannot carry the second one into a fold over ZERO rows, so this
    // entry stays engine work and says so through its own token
    $percentile: { kind: 'agg', signature: ['seq<number>', 'number'], result: 'number',
      fn: percentile, pushable: false },
  },
};
