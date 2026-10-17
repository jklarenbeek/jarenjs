//@ts-check
/**
 * @file The integers a double stands for. A document spells a number past
 * ±(2^53 - 1) by any digits that name an integer rounding to it (2^60 is
 * `1152921504606847000` from a JavaScript writer and `1152921504606846976`
 * from another), the engine compares the double those digits round to, and
 * a database that reads a JSON integer by its digits holds the exact
 * integer. Comparing that integer with the interval of integers that round
 * to the double answers as the engine does whatever digits the writer chose:
 * equal is inside it, less is below its low edge, greater above its high one.
 */

/** The 64-bit integers a database column holds. */
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * The closed interval of integers that round to the double `value` under
 * round-half-to-even, or `null` for a number that is not an integer past
 * ±(2^53 - 1) (a safe integer, a fraction: each stands for itself alone).
 * Each edge is the midpoint to the neighbouring double, kept where the tie
 * rounds to `value` (its last significand bit is even) and stepped inside
 * otherwise; below a power of two the neighbour is half as far.
 * @param {number} value
 * @returns {{ low: bigint, high: bigint } | null}
 */
export function integersRoundingTo(value) {
  if (!Number.isInteger(value) || Number.isSafeInteger(value)) return null;
  const magnitude = BigInt(Math.abs(value));
  const bits = magnitude.toString(2).length;
  // the spacing of the doubles at and above `magnitude`, and below it
  const above = 1n << BigInt(bits - 53);
  const below = magnitude === 1n << BigInt(bits - 1) ? above / 2n : above;
  const inward = (magnitude / above) % 2n === 0n ? 0n : 1n;
  // below 2^53 the doubles are one apart, a midpoint no integer lies on:
  // the half floors away and no integer below the double rounds to it
  const low = magnitude - below / 2n + inward;
  const high = magnitude + above / 2n - inward;
  return value > 0 ? { low, high } : { low: -high, high: -low };
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
