//@ts-check
/**
 * @file The exact number algebra of the programmer environment. A value
 * there is a `number`, a `bigint` once it is a whole number past the safe
 * range (±(2^53 - 1)), or a `Ratio`, the exact fraction a division on the
 * exact path answers when its quotient is not whole: a `Number` that far
 * out has already rounded, a `BigInt` or a `Ratio` has not. So an operation
 * on two safe values is the float operation it always was, and only a
 * result that leaves the safe range, or an operand that already has, takes
 * the exact path; a fraction among the operands of `+ - * /` that is a
 * `Number` (`0.5`) takes the float path again. A result too large for a
 * double is `±Infinity`, as the float path answers it, which also bounds
 * how big a `BigInt` or a `Ratio` here can grow.
 */

import { mathf64_pow } from '@jarenjs/core/math';

/** A whole number written as decimal text: the exact form of a word a `Number` cannot hold. */
export const DECIMAL_INTEGER = /^-?\d+$/;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;

/** The most bits a power may reach before it is past any double. */
const POWER_BITS = 1024;

/** The bits of a double's significand. */
const SIGNIFICAND_BITS = 53;

/** The exponent of a double's smallest step, 2^-1074. */
const SMALLEST_STEP = 1074;

/**
 * An exact fraction `n / d` in lowest terms with `d > 1`: what a division
 * on the exact path answers when the quotient is not whole, so that
 * `(2^53 + 1) / 2 * 2` is `2^53 + 1` as `7/2*2` is `7`. It has no
 * `valueOf`, so it never becomes a `Number` unnoticed: the operations here
 * read it exactly, `toNumber` rounds it once, and a word reads its whole
 * part (truncated toward zero, as a word reads a `Number`).
 */
export class Ratio {
  /** @param {bigint} n @param {bigint} d */
  constructor(n, d) {
    /** The numerator, carrying the sign. */
    this.n = n;
    /** The denominator, greater than 1. */
    this.d = d;
  }
}

/** @typedef {number | bigint | Ratio} ExactValue a value of the exact algebra */

/**
 * Canonical form of an exact integer: a `Number` inside the safe range,
 * `±Infinity` past what a double holds, the `BigInt` otherwise.
 * @param {bigint} b
 * @returns {number | bigint}
 */
export function fit(b) {
  if (b >= MIN_SAFE && b <= MAX_SAFE) return Number(b);
  const n = Number(b);
  return n === Infinity || n === -Infinity ? n : b;
}

/**
 * @param {bigint} a @param {bigint} b non-negative
 * @returns {bigint}
 */
function gcd(a, b) {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/**
 * `a / b` rounded toward -∞, for `b > 0`.
 * @param {bigint} a @param {bigint} b
 * @returns {bigint}
 */
function floorDiv(a, b) {
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

/**
 * Canonical form of the exact quotient `n / d` (`d` not 0): the whole
 * number's canonical form when it is whole, `±Infinity` past what a double
 * holds, the `Ratio` in lowest terms otherwise.
 * @param {bigint} n @param {bigint} d
 * @returns {ExactValue}
 */
function quotient(n, d) {
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = d === 1n ? 1n : gcd(n < 0n ? -n : n, d);
  if (g === d) return fit(n / d);
  const whole = fit(n / d);
  return whole === Infinity || whole === -Infinity ? whole : new Ratio(n / g, d / g);
}

/**
 * Is `v` a whole number: a `bigint`, or a `Number` with no fraction?
 * @param {ExactValue} v
 * @returns {boolean}
 */
function isWhole(v) {
  return typeof v === 'bigint' || Number.isInteger(v);
}

/**
 * Does `v` take the exact path: a whole number or a `Ratio`?
 * @param {ExactValue} v
 * @returns {boolean}
 */
function isExact(v) {
  return v instanceof Ratio || isWhole(v);
}

/**
 * The exact value of `v` as a numerator and a positive denominator. A
 * finite `Number` with a fraction is the binary fraction it holds.
 * @param {ExactValue} v
 * @returns {[bigint, bigint]}
 */
function parts(v) {
  if (v instanceof Ratio) return [v.n, v.d];
  if (typeof v === 'bigint') return [v, 1n];
  let x = v;
  let d = 1n;
  // doubling a double moves only its exponent, so every step is exact
  while (!Number.isInteger(x)) {
    x *= 2;
    d *= 2n;
  }
  return [BigInt(x), d];
}

/**
 * `m · 2^s / d` truncated, and its remainder over its divisor.
 * @param {bigint} m @param {bigint} d @param {number} s
 * @returns {[bigint, bigint, bigint]} quotient, remainder, divisor
 */
function scaledQuotient(m, d, s) {
  const num = s >= 0 ? m << BigInt(s) : m;
  const den = s >= 0 ? d : d << BigInt(-s);
  return [num / den, num % den, den];
}

/**
 * The nearest double to `n / d` (`d > 0`), rounded once, ties to even: the
 * quotient is scaled by `2^s` to the 53 whole bits a double keeps (no finer
 * than its smallest step, 2^-1074, for a value below the normal range),
 * rounded there by its remainder, and scaled back exactly.
 * @param {bigint} n @param {bigint} d
 * @returns {number}
 */
function roundQuotient(n, d) {
  const negative = n < 0n;
  const m = negative ? -n : n;
  let s = SIGNIFICAND_BITS - (m.toString(2).length - d.toString(2).length);
  // the quotient has 53 or 54 whole bits at that scale: keep 53
  if (scaledQuotient(m, d, s)[0] >> BigInt(SIGNIFICAND_BITS) !== 0n) s -= 1;
  s = Math.min(s, SMALLEST_STEP);
  const [whole, rest, den] = scaledQuotient(m, d, s);
  const twice = rest * 2n;
  const q = twice > den || (twice === den && (whole & 1n) === 1n) ? whole + 1n : whole;
  // 2^-s is a double down to 2^-1074, and so is q · 2^-s: the product is exact
  const x = Number(q) * 2 ** -s;
  return negative ? -x : x;
}

/**
 * The value as a `Number`: a `bigint` or a `Ratio` rounded once to the
 * nearest double.
 * @param {ExactValue} v
 * @returns {number}
 */
export function toNumber(v) {
  if (typeof v === 'bigint') return Number(v);
  return v instanceof Ratio ? roundQuotient(v.n, v.d) : v;
}

/**
 * Is `v` a number with a value: any `bigint` or `Ratio`, or a finite `Number`?
 * @param {ExactValue} v
 * @returns {boolean}
 */
export function isFiniteValue(v) {
  return typeof v === 'bigint' || v instanceof Ratio || Number.isFinite(v);
}

/**
 * The whole part of a finite value, truncated toward zero, as a `BigInt`:
 * the integer a word operand or the displayed word reads.
 * @param {ExactValue} v
 * @returns {bigint}
 */
export function truncated(v) {
  if (typeof v === 'bigint') return v;
  return v instanceof Ratio ? v.n / v.d : BigInt(Math.trunc(v));
}

/**
 * The whole number an exact value rounds to by `how`: `trunc` toward zero,
 * `floor`, `ceil`, or `round` (half toward +∞, as `Math.round`). A
 * `bigint` is already whole.
 * @param {bigint | Ratio} v
 * @param {'trunc' | 'floor' | 'ceil' | 'round'} how
 * @returns {number | bigint}
 */
export function roundExact(v, how) {
  if (typeof v === 'bigint') return v;
  const { n, d } = v;
  if (how === 'floor') return fit(floorDiv(n, d));
  if (how === 'ceil') return fit(-floorDiv(-n, d));
  if (how === 'round') return fit(floorDiv(2n * n + d, 2n * d));
  return fit(n / d);
}

/**
 * Apply an arithmetic operator. Two `Number`s take the float operation, and
 * its result stands unless it left the safe range from whole operands, in
 * which case the exact result replaces it. An operand on the exact path (a
 * `bigint` or a `Ratio`) takes the exact operation when the other is whole
 * or a `Ratio`, the float operation otherwise.
 * @param {ExactValue} a
 * @param {ExactValue} b
 * @param {(x: number, y: number) => number} float
 * @param {(x: [bigint, bigint], y: [bigint, bigint]) => [bigint, bigint]} exact
 *   the operation on the operands' numerators and denominators
 * @returns {ExactValue}
 */
function arithmetic(a, b, float, exact) {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = float(a, b);
    return Math.abs(r) > Number.MAX_SAFE_INTEGER && Number.isInteger(a) && Number.isInteger(b)
      ? quotient(...exact(parts(a), parts(b)))
      : r;
  }
  if (isExact(a) && isExact(b)) return quotient(...exact(parts(a), parts(b)));
  return float(toNumber(a), toNumber(b));
}

/** @param {ExactValue} a @param {ExactValue} b @returns {ExactValue} */
export function add(a, b) {
  return arithmetic(a, b, (x, y) => x + y, ([an, ad], [bn, bd]) => [an * bd + bn * ad, ad * bd]);
}

/** @param {ExactValue} a @param {ExactValue} b @returns {ExactValue} */
export function subtract(a, b) {
  return arithmetic(a, b, (x, y) => x - y, ([an, ad], [bn, bd]) => [an * bd - bn * ad, ad * bd]);
}

/** @param {ExactValue} a @param {ExactValue} b @returns {ExactValue} */
export function multiply(a, b) {
  return arithmetic(a, b, (x, y) => x * y, ([an, ad], [bn, bd]) => [an * bn, ad * bd]);
}

/**
 * Is `v` a whole `Number` a double holds only approximately?
 * @param {ExactValue} v
 * @returns {boolean}
 */
function isUnsafeWhole(v) {
  return Number.isInteger(v) && !Number.isSafeInteger(v);
}

/**
 * Division. Two safe `Number`s divide as floats (`7/2` is `3.5`). When an
 * operand is beyond the safe range (a `bigint`, or a whole `Number` past
 * it) or a `Ratio`, and neither is a fractional `Number`, the quotient is
 * exact: a whole one is the integer, any other the `Ratio`, so the
 * remainder is kept however large the quotient is. A division by zero is
 * the float one (`±Infinity`, or `NaN` for `0/0`).
 * @param {ExactValue} a
 * @param {ExactValue} b
 * @returns {ExactValue}
 */
export function divide(a, b) {
  if (typeof a === 'number' && typeof b === 'number'
    && !(Number.isInteger(a) && Number.isInteger(b) && (isUnsafeWhole(a) || isUnsafeWhole(b)))) return a / b;
  if (!isExact(a) || !isExact(b) || b === 0 || b === 0n) return toNumber(a) / toNumber(b);
  const [an, ad] = parts(a);
  const [bn, bd] = parts(b);
  return quotient(an * bd, ad * bn);
}

/**
 * Exponentiation. The float power stands unless it left the safe range from
 * a whole base, or a `Ratio` one, and a whole exponent from 0 to the point
 * the power of the base's numerator would pass a double, in which case the
 * exact power replaces it.
 * @param {ExactValue} a
 * @param {ExactValue} b
 * @returns {ExactValue}
 */
export function power(a, b) {
  const r = mathf64_pow(toNumber(a), toNumber(b));
  if (!(Math.abs(r) > Number.MAX_SAFE_INTEGER)) return r;
  if (!isExact(a) || typeof b !== 'number' || !Number.isInteger(b) || b < 0) return r;
  const [n, d] = parts(a);
  const magnitude = n < 0n ? -n : n;
  if ((magnitude.toString(2).length - 1) * b > POWER_BITS) return r;
  const e = BigInt(b);
  return quotient(n ** e, d ** e);
}

/**
 * Negation.
 * @param {ExactValue} a
 * @returns {ExactValue}
 */
export function negate(a) {
  if (a instanceof Ratio) return new Ratio(-a.n, a.d);
  return typeof a === 'bigint' ? fit(-a) : -a;
}

/**
 * The magnitude of a value, exact for a `bigint` or a `Ratio`.
 * @param {ExactValue} a
 * @param {(x: number) => number} float
 * @returns {ExactValue}
 */
export function magnitude(a, float) {
  if (a instanceof Ratio) return a.n < 0n ? negate(a) : a;
  return typeof a === 'bigint' ? fit(a < 0n ? -a : a) : float(a);
}

/**
 * Is `a` less than `b`, exactly? A `Ratio` is compared by its fraction,
 * against a `Number` too; a non-finite `Number` is past every value.
 * @param {ExactValue} a
 * @param {ExactValue} b
 * @returns {boolean}
 */
function less(a, b) {
  if (!(a instanceof Ratio) && !(b instanceof Ratio)) return a < b;
  if (!isFiniteValue(a) || !isFiniteValue(b)) return toNumber(a) < toNumber(b);
  const [an, ad] = parts(a);
  const [bn, bd] = parts(b);
  return an * bd < bn * ad;
}

/**
 * The smaller or larger of the values, exact when one is a `bigint` or a
 * `Ratio`; a `NaN` among them makes the answer `NaN`.
 * @param {ExactValue[]} values
 * @param {boolean} smaller
 * @param {(...x: number[]) => number} float the float function for an all-`Number` call
 * @returns {ExactValue}
 */
export function extreme(values, smaller, float) {
  if (values.every((v) => typeof v === 'number')) return float(.../** @type {number[]} */ (values));
  let best = values[0];
  for (const v of values) {
    if (typeof v === 'number' && Number.isNaN(v)) return NaN;
    if (smaller ? less(v, best) : less(best, v)) best = v;
  }
  return best;
}
