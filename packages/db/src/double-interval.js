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
 * its decimal digits (PostgreSQL's `numeric`) binds its decimal edges — of
 * every double there, since a writer may spell a fraction or a safe integer
 * past a double's precision too (`5.00000000000000000001` is 5 to the
 * engine).
 */

/** The least decimal that rounds to Infinity: the midpoint between the
 * largest double and 2^1024, whose tie rounds to the even 2^1024. */
const INFINITE_EDGE = 2n ** 1024n - 2n ** 970n;

/** The 64-bit integers a database column holds. */
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * The interval of reals that round to the finite double `value` under
 * round-half-to-even: its two edges, each the midpoint to the neighbouring
 * double, as exact rationals `low / 2^shift` and `high / 2^shift` (a
 * double and its midpoints are dyadic, so each has a finite decimal
 * spelling), and whether it holds them (a tie rounds to `value` where its
 * last significand bit is even). Below a power of two the neighbour is half
 * as far (not below the least normal double, whose neighbours are the
 * evenly spaced subnormals), and zero's neighbours are the least double
 * either side, so `-0` and `0` stand for one interval. `null` for an
 * infinity or NaN.
 * @param {number} value
 * @returns {{ low: bigint, high: bigint, shift: bigint, closed: boolean } | null}
 */
function midpointsOf(value) {
  if (!Number.isFinite(value)) return null;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const exponent = bits >> 52n;
  const fraction = bits & ((1n << 52n) - 1n);
  // `value` is significand * 2^power; its midpoints lie a half spacing out,
  // so in quarters of the spacing above it each edge is an integer
  const significand = exponent === 0n ? fraction : fraction | (1n << 52n);
  const power = (exponent === 0n ? 1n : exponent) - 1075n;
  const below = fraction === 0n && exponent > 1n ? 1n : 2n;
  const quarter = power - 2n;
  const scale = (/** @type {bigint} */ edge) => (quarter >= 0n ? edge << quarter : edge);
  const shift = quarter >= 0n ? 0n : -quarter;
  const low = scale(4n * significand - below);
  const high = scale(4n * significand + 2n);
  const closed = significand % 2n === 0n;
  return value < 0 ? { low: -high, high: -low, shift, closed } : { low, high, shift, closed };
}

/**
 * The closed interval of integers that round to the double `value` under
 * round-half-to-even, or `null` for a number that is not an integer past
 * ±(2^53 - 1) (a safe integer, a fraction: no other integer rounds to it).
 * An edge that is an integer is kept where its tie rounds to `value` and
 * stepped inside otherwise; one between integers is rounded inside.
 * @param {number} value
 * @returns {{ low: bigint, high: bigint } | null}
 */
export function integersRoundingTo(value) {
  if (!Number.isInteger(value) || Number.isSafeInteger(value)) return null;
  const { low, high, shift, closed } = /** @type {NonNullable<ReturnType<typeof midpointsOf>>} */ (midpointsOf(value));
  const inward = closed ? 0n : 1n;
  // `>>` floors, so an edge between integers rounds inside as its floor
  // plus one below and its floor above
  const whole = (/** @type {bigint} */ edge) => (edge & ((1n << shift) - 1n)) === 0n;
  return {
    low: whole(low) ? (low >> shift) + inward : (low >> shift) + 1n,
    high: whole(high) ? (high >> shift) - inward : high >> shift,
  };
}

/**
 * The exact decimal text of `numerator / 2^shift`: `numerator * 5^shift`
 * over `10^shift`, trailing zeros dropped.
 * @param {bigint} numerator @param {bigint} shift @returns {string}
 */
const decimalText = (numerator, shift) => {
  const magnitude = numerator < 0n ? -numerator : numerator;
  const sign = numerator < 0n ? '-' : '';
  if (shift === 0n) return `${sign}${magnitude}`;
  const digits = String(magnitude * 5n ** shift).padStart(Number(shift) + 1, '0');
  const point = digits.length - Number(shift);
  const fraction = digits.slice(point).replace(/0+$/, '');
  return `${sign}${digits.slice(0, point)}${fraction === '' ? '' : `.${fraction}`}`;
};

/**
 * The JSON text one bound of a comparison with the double `value` binds,
 * for a member read by its decimal digits. `low` and `high` are the edges
 * of the interval of decimals that round to it ({@link midpointsOf});
 * `lowExclusive` and `highExclusive` the bounds a member must lie strictly
 * beyond besides: the edge itself where its tie rounds away, a number
 * outside it where the tie rounds to `value`. So `m >= low AND m >
 * lowExclusive` is "at or above the interval's low edge" whichever way its
 * tie rounds, and `m <= high AND m < highExclusive` likewise. Every
 * finite double is such an interval: a writer spells 5 as
 * `5.00000000000000000001` too, and 0 as `1e-400`. An
 * infinity is the interval of decimals at and past the midpoint between the
 * largest double and 2^1024 ({@link INFINITE_EDGE}, whose tie rounds to the
 * infinity), open on its other side: there it binds the JSON value that
 * `jsonb` orders past every number (`true`) or before every one (`null`), so
 * `m <= true` holds of every number and `m > true` of none. Anything else
 * (a NaN, a string) binds as its JSON text.
 * @param {unknown} value
 * @param {'low' | 'high' | 'lowExclusive' | 'highExclusive'} edge
 * @returns {string}
 */
export function decimalEdge(value, edge) {
  if (value === Infinity || value === -Infinity) {
    const inner = edge === (value > 0 ? 'low' : 'high') ? INFINITE_EDGE
      : edge === (value > 0 ? 'lowExclusive' : 'highExclusive') ? INFINITE_EDGE - 1n : null;
    return inner === null ? (value > 0 ? 'true' : 'null') : `${value > 0 ? '' : '-'}${inner}`;
  }
  const midpoints = typeof value === 'number' ? midpointsOf(value) : null;
  if (midpoints === null) return JSON.stringify(value);
  const { low, high, shift, closed } = midpoints;
  // one past an edge the tie keeps: a bound every member at or past the
  // edge lies strictly beyond
  const one = 1n << shift;
  if (edge === 'low') return decimalText(low, shift);
  if (edge === 'high') return decimalText(high, shift);
  if (edge === 'lowExclusive') return decimalText(closed ? low - one : low, shift);
  return decimalText(closed ? high + one : high, shift);
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

/** The bounds a list's tuple holds, in order ({@link decimalIntervals}). */
export const INTERVAL_EDGES = /** @type {const} */ (['low', 'lowExclusive', 'high', 'highExclusive']);

/**
 * The intervals of decimals that round to a list's numbers, as the JSON
 * text of one `[low, lowExclusive, high, highExclusive]` tuple per finite
 * number ({@link decimalEdge}), for a member read by its decimal digits to
 * be found in. An item that is not a finite number stands for no interval:
 * a string is another kind's, and an infinity, which the list's JSON spells
 * `null`, was never a number of it.
 * @param {unknown[]} items
 * @returns {string}
 */
export function decimalIntervals(items) {
  return JSON.stringify(items.filter((item) => typeof item === 'number' && Number.isFinite(item))
    .map((item) => INTERVAL_EDGES.map((edge) => decimalEdge(item, edge))));
}
