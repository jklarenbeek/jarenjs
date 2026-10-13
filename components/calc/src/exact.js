//@ts-check
/**
 * @file The exact integer algebra of the programmer environment. A value
 * there is a `number`, or a `bigint` once it is a whole number past the
 * safe range (±(2^53 - 1)): a `Number` that far out has already rounded, a
 * `BigInt` has not. So an operation on two safe values is the float
 * operation it always was, and only a result that leaves the safe range, or
 * an operand that already has, takes the exact path. A result too large for
 * a double is `±Infinity`, as the float path answers it, which also bounds
 * how big a `BigInt` here can grow.
 */

import { mathf64_pow } from '@jarenjs/core/math';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;

/** The most bits a power may reach before it is past any double. */
const POWER_BITS = 1024;

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
 * Is `v` a whole number: a `bigint`, or a `Number` with no fraction?
 * @param {number | bigint} v
 * @returns {boolean}
 */
function isWhole(v) {
  return typeof v === 'bigint' || Number.isInteger(v);
}

/**
 * The value as a `Number`, rounded if it is a `bigint`.
 * @param {number | bigint} v
 * @returns {number}
 */
export function toNumber(v) {
  return typeof v === 'bigint' ? Number(v) : v;
}

/**
 * Is `v` a number with a value: any `bigint`, or a finite `Number`?
 * @param {number | bigint} v
 * @returns {boolean}
 */
export function isFiniteValue(v) {
  return typeof v === 'bigint' || Number.isFinite(v);
}

/**
 * Apply an arithmetic operator. Two `Number`s take the float operation, and
 * its result stands unless it left the safe range from whole operands, in
 * which case the exact result replaces it. A `bigint` operand takes the
 * exact path when the other is whole, the float path otherwise.
 * @param {number | bigint} a
 * @param {number | bigint} b
 * @param {(x: number, y: number) => number} float
 * @param {(x: bigint, y: bigint) => bigint} exact
 * @returns {number | bigint}
 */
function arithmetic(a, b, float, exact) {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = float(a, b);
    return Math.abs(r) > Number.MAX_SAFE_INTEGER && Number.isInteger(a) && Number.isInteger(b)
      ? fit(exact(BigInt(a), BigInt(b)))
      : r;
  }
  if (isWhole(a) && isWhole(b)) return fit(exact(BigInt(a), BigInt(b)));
  return float(toNumber(a), toNumber(b));
}

/** @param {number | bigint} a @param {number | bigint} b @returns {number | bigint} */
export function add(a, b) {
  return arithmetic(a, b, (x, y) => x + y, (x, y) => x + y);
}

/** @param {number | bigint} a @param {number | bigint} b @returns {number | bigint} */
export function subtract(a, b) {
  return arithmetic(a, b, (x, y) => x - y, (x, y) => x - y);
}

/** @param {number | bigint} a @param {number | bigint} b @returns {number | bigint} */
export function multiply(a, b) {
  return arithmetic(a, b, (x, y) => x * y, (x, y) => x * y);
}

/**
 * Division. Two `Number`s divide as floats. With a `bigint` operand a whole
 * quotient is exact; a fractional one past the safe range is truncated, which
 * is all a double that large could hold of it; a fractional one inside it is
 * the quotient plus its fraction, rounded once.
 * @param {number | bigint} a
 * @param {number | bigint} b
 * @returns {number | bigint}
 */
export function divide(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a / b;
  if (!isWhole(a) || !isWhole(b)) return toNumber(a) / toNumber(b);
  const x = BigInt(a);
  const y = BigInt(b);
  if (y === 0n) return toNumber(a) / toNumber(b);
  const q = x / y;
  const r = x % y;
  if (r === 0n || q > MAX_SAFE || q < MIN_SAFE) return fit(q);
  const n = Number(q);
  const withFraction = n + Number(r) / Number(y);
  return Math.trunc(withFraction) === n ? withFraction : n;
}

/**
 * Exponentiation. The float power stands unless it left the safe range from
 * a whole base and a whole exponent from 0 to the point the result would pass
 * a double, in which case the exact power replaces it.
 * @param {number | bigint} a
 * @param {number | bigint} b
 * @returns {number | bigint}
 */
export function power(a, b) {
  const r = mathf64_pow(toNumber(a), toNumber(b));
  if (!(Math.abs(r) > Number.MAX_SAFE_INTEGER)) return r;
  if (!isWhole(a) || typeof b !== 'number' || !Number.isInteger(b) || b < 0) return r;
  const base = BigInt(a);
  const magnitude = base < 0n ? -base : base;
  if ((magnitude.toString(2).length - 1) * b > POWER_BITS) return r;
  return fit(base ** BigInt(b));
}

/**
 * Negation.
 * @param {number | bigint} a
 * @returns {number | bigint}
 */
export function negate(a) {
  return typeof a === 'bigint' ? fit(-a) : -a;
}

/**
 * The magnitude of a value, exact for a `bigint`.
 * @param {number | bigint} a
 * @param {(x: number) => number} float
 * @returns {number | bigint}
 */
export function magnitude(a, float) {
  return typeof a === 'bigint' ? fit(a < 0n ? -a : a) : float(a);
}

/**
 * The smaller or larger of the values, exact when one is a `bigint`; a
 * `NaN` among them makes the answer `NaN`.
 * @param {(number | bigint)[]} values
 * @param {boolean} smaller
 * @param {(...x: number[]) => number} float the float function for an all-`Number` call
 * @returns {number | bigint}
 */
export function extreme(values, smaller, float) {
  if (!values.some((v) => typeof v === 'bigint')) return float(.../** @type {number[]} */ (values));
  let best = values[0];
  for (const v of values) {
    if (typeof v === 'number' && Number.isNaN(v)) return NaN;
    if (smaller ? v < best : v > best) best = v;
  }
  return best;
}
