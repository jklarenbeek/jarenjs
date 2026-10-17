//@ts-check
/**
 * @file The numbers a double stands for. A document spells a number past
 * ±(2^53 - 1) by any digits that name a number rounding to it (2^60 is
 * `1152921504606847000` from a JavaScript writer and `1152921504606846976`
 * or `1152921504606846976.5` from another), the engine compares the double
 * those digits round to, and a database that reads a JSON number by its
 * digits holds the exact number. Comparing that number with the interval of
 * numbers that round to the double answers as the engine does whatever
 * digits the writer chose: equal is inside it, less is below its low edge,
 * greater above its high one. One derivation serves both readings: a
 * database that holds an integer by its digits and a fraction as a double
 * (SQLite) binds the interval's integers, one that holds every number by
 * its decimal digits (PostgreSQL's `numeric`) binds its decimal edges.
 */

/** The 64-bit integers a database column holds. */
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * The interval of reals that round to the double `value` under
 * round-half-to-even, as twice its edges (each edge is the midpoint to the
 * neighbouring double, an integer or one half past one), whether it holds
 * them (a tie rounds to `value` where its last significand bit is even),
 * or `null` for a number that is not an integer past ±(2^53 - 1) (a safe
 * integer, a fraction: each stands for itself alone). Below a power of two
 * the neighbour is half as far, and below 2^53 it is one away, so 2^53's
 * low edge is the one that is not an integer.
 * @param {number} value
 * @returns {{ twiceLow: bigint, twiceHigh: bigint, closed: boolean } | null}
 */
function midpointsOf(value) {
  if (!Number.isInteger(value) || Number.isSafeInteger(value)) return null;
  const magnitude = BigInt(Math.abs(value));
  const bits = magnitude.toString(2).length;
  // the spacing of the doubles at and above `magnitude`, and below it
  const above = 1n << BigInt(bits - 53);
  const below = magnitude === 1n << BigInt(bits - 1) ? above / 2n : above;
  const closed = (magnitude / above) % 2n === 0n;
  const twiceLow = 2n * magnitude - below;
  const twiceHigh = 2n * magnitude + above;
  return value > 0 ? { twiceLow, twiceHigh, closed } : { twiceLow: -twiceHigh, twiceHigh: -twiceLow, closed };
}

/**
 * The closed interval of integers that round to the double `value` under
 * round-half-to-even, or `null` for a number that is not an integer past
 * ±(2^53 - 1) ({@link midpointsOf}). An edge that is an integer is kept
 * where its tie rounds to `value` and stepped inside otherwise; one half
 * past an integer is rounded inside.
 * @param {number} value
 * @returns {{ low: bigint, high: bigint } | null}
 */
export function integersRoundingTo(value) {
  const midpoints = midpointsOf(value);
  if (midpoints === null) return null;
  const { twiceLow, twiceHigh, closed } = midpoints;
  const inward = closed ? 0n : 1n;
  return {
    low: twiceLow % 2n === 0n ? twiceLow / 2n + inward : (twiceLow + 1n) / 2n,
    high: twiceHigh % 2n === 0n ? twiceHigh / 2n - inward : (twiceHigh - 1n) / 2n,
  };
}

/** The JSON text of half of `twice`, exactly. @param {bigint} twice @returns {string} */
const halfText = (twice) => {
  const magnitude = twice < 0n ? -twice : twice;
  return `${twice < 0n ? '-' : ''}${magnitude / 2n}${magnitude % 2n === 0n ? '' : '.5'}`;
};

/**
 * The JSON text one bound of a comparison with the double `value` binds,
 * for a member read by its decimal digits. `low` and `high` are the edges
 * of the interval of decimals that round to it ({@link midpointsOf});
 * `lowExclusive` and `highExclusive` the bounds a member must lie strictly
 * beyond besides: the edge itself where its tie rounds away, a number
 * outside it where the tie rounds to `value`. So `m >= low AND m >
 * lowExclusive` is "at or above the interval's low edge" whichever way its
 * tie rounds, and `m <= high AND m < highExclusive` likewise. A safe
 * integer or a fraction stands for itself alone, with ties held; anything
 * else binds as its JSON text.
 * @param {unknown} value
 * @param {'low' | 'high' | 'lowExclusive' | 'highExclusive'} edge
 * @returns {string}
 */
export function decimalEdge(value, edge) {
  const midpoints = typeof value === 'number' ? midpointsOf(value) : null;
  if (midpoints === null) {
    if (typeof value !== 'number' || edge === 'low' || edge === 'high') return JSON.stringify(value);
    return JSON.stringify(edge === 'lowExclusive' ? value - 1 : value + 1);
  }
  const { twiceLow, twiceHigh, closed } = midpoints;
  if (edge === 'low') return halfText(twiceLow);
  if (edge === 'high') return halfText(twiceHigh);
  if (edge === 'lowExclusive') return halfText(closed ? twiceLow - 2n : twiceLow);
  return halfText(closed ? twiceHigh + 2n : twiceHigh);
}

/**
 * The value one edge of a comparison with the double `value` binds: the
 * interval's edge ({@link integersRoundingTo}) as a 64-bit integer, or the
 * double itself where the edge lies past the 64-bit integers, which orders
 * as that edge does against every value the column can hold (the integers
 * all lie on one side of it, and no other double lies between). A value that
 * is not an integer past ±(2^53 - 1) binds as itself.
 * @param {unknown} value
 * @param {'low' | 'high'} edge
 * @returns {unknown}
 */
export function intervalEdge(value, edge) {
  const interval = typeof value === 'number' ? integersRoundingTo(value) : null;
  if (interval === null) return value;
  const bound = interval[edge];
  return bound < INT64_MIN || bound > INT64_MAX ? value : bound;
}
