//@ts-check
/**
 * @file The decimals of an IEEE 754 double: rounding them, in the two
 * senses a formatter and a query need, and the multiple test JSON
 * Schema's `multipleOf` needs:
 *
 * - {@link roundExact}: the multiple of `10^-precision` nearest the
 *   **exact** value of the double — XPath F&O `fn:round` (ties toward
 *   positive infinity) and `fn:round-half-to-even` (ties to the even
 *   neighbour). `1.005` is stored as `1.00499999999999989…`, so it rounds
 *   to `1.00` at two places, as F&O says it must.
 * - {@link shortestDecimal} and {@link roundDecimal}: the shortest decimal
 *   that reads back as the double (the digits `String(x)` prints), rounded
 *   half away from zero — what ICU formats from, so `1.005` shows as
 *   `1.01` at two places.
 * - {@link multipleOfTester}: whether a number is a whole multiple of a
 *   step, decided on the decimals the two spell (`0.3` is a multiple of
 *   `0.1`, `20000001` is none of `10000000`) — the one reading of
 *   `multipleOf` the validator and a form field share.
 *
 * Both roundings work on decimal digit strings: no binary scaling
 * (`x * 100`) ever decides a digit.
 */

/**
 * A finite non-negative decimal: `digits × 10^-scale`, `digits` a string
 * of decimal digits without leading zeros (`'0'` for zero).
 * @typedef {{ digits: string, scale: number }} Decimal
 */

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);
/** The index of the high word of a double in this host's byte order. */
const HI = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0;

/**
 * The exact value of a finite, non-zero double's magnitude as a decimal:
 * every digit of `|x|`, with no rounding (a subnormal has up to 1,074
 * fraction digits).
 * @param {number} x
 * @returns {Decimal}
 */
export function exactDecimal(x) {
  F64[0] = Math.abs(x);
  const hi = U32[HI];
  const lo = U32[1 - HI];
  const biased = (hi >>> 20) & 0x7FF;
  let mantissa = (BigInt(hi & 0xFFFFF) << 32n) | BigInt(lo);
  let exponent;
  if (biased === 0) exponent = -1074;
  else {
    mantissa |= 1n << 52n;
    exponent = biased - 1075;
  }
  if (mantissa === 0n) return { digits: '0', scale: 0 };
  if (exponent >= 0) return { digits: (mantissa << BigInt(exponent)).toString(), scale: 0 };
  // m × 2^e = m × 5^-e × 10^e: an exact decimal with -e fraction digits
  return trim({ digits: (mantissa * 5n ** BigInt(-exponent)).toString(), scale: -exponent });
}

/**
 * The digits `String(|x|)` prints, its point and exponent removed, and the
 * scale that places them, `|x| = digits × 10^-scale`: leading and trailing
 * zeros as printed, and a negative scale where the exponent passes the
 * digits (`1e+308` is `'1'` at scale -308).
 * @param {number} x - a finite number
 * @returns {{ digits: string, scale: number }}
 */
function printedDecimal(x) {
  const text = String(Math.abs(x));
  const e = text.indexOf('e');
  const mantissa = e < 0 ? text : text.slice(0, e);
  const exponent = e < 0 ? 0 : Number(text.slice(e + 1));
  const dot = mantissa.indexOf('.');
  const digits = dot < 0 ? mantissa : mantissa.slice(0, dot) + mantissa.slice(dot + 1);
  const fraction = dot < 0 ? 0 : mantissa.length - dot - 1;
  return { digits, scale: fraction - exponent };
}

/**
 * The shortest decimal that reads back as `|x|` — the digits of
 * `String(x)`, which ECMAScript defines as the shortest round trip.
 * @param {number} x - a finite number
 * @returns {Decimal}
 */
export function shortestDecimal(x) {
  const { digits, scale } = printedDecimal(x);
  return normalize(digits, scale);
}

/**
 * A decimal from digits and a scale that may be negative (`'15', -2` is
 * 1500): leading zeros dropped, a negative scale folded into the digits.
 * @param {string} digits @param {number} scale
 * @returns {Decimal}
 */
function normalize(digits, scale) {
  let start = 0;
  while (start < digits.length - 1 && digits.charCodeAt(start) === 0x30) start++;
  let out = digits.slice(start);
  if (scale < 0) {
    out = out === '0' ? '0' : out + '0'.repeat(-scale);
    return { digits: out, scale: 0 };
  }
  return trim({ digits: out, scale });
}

/**
 * Drop trailing zeros while the scale stays above `floor`: `1500 × 10^-3`
 * is `15 × 10^-1`. The default floor drops fraction zeros only; a lower
 * one folds whole zeros into a negative scale too (`1500` is `15 × 10^2`).
 * @param {Decimal} d @param {number} [floor]
 * @returns {Decimal}
 */
function trim(d, floor = 0) {
  let { digits, scale } = d;
  while (scale > floor && digits.length > 1 && digits.charCodeAt(digits.length - 1) === 0x30) {
    digits = digits.slice(0, -1);
    scale--;
  }
  if (digits === '0') scale = 0;
  return { digits, scale };
}

/**
 * Multiply a decimal by `10^shift` exactly (a percent is a shift of 2).
 * @param {Decimal} d @param {number} shift
 * @returns {Decimal}
 */
export function shiftDecimal(d, shift) {
  return normalize(d.digits, d.scale - shift);
}

/**
 * Round a non-negative decimal to `places` fraction digits (negative
 * places round to tens, hundreds, …).
 * @param {Decimal} d
 * @param {number} places - an integer
 * @param {'half-up' | 'half-down' | 'half-even'} tie - how an exact half
 *   breaks for this magnitude: away from zero, toward zero, or to even
 * @returns {Decimal}
 */
export function roundDecimal(d, places, tie) {
  const drop = d.scale - places;
  if (drop <= 0) return d;
  const { digits } = d;
  const keepLength = digits.length - drop;
  // the value is under a tenth of the rounding unit, so under half of it:
  // zero, with no padding built for a precision of -1e9
  if (keepLength < 0) return { digits: '0', scale: 0 };
  const kept = keepLength > 0 ? BigInt(digits.slice(0, keepLength)) : 0n;
  // the dropped part against one half of the last kept unit
  const rest = digits.slice(keepLength);
  const half = '5' + '0'.repeat(rest.length - 1);
  const order = rest === half ? 0 : rest > half ? 1 : -1;
  const up = order > 0 || (order === 0 && (tie === 'half-up' || (tie === 'half-even' && (kept & 1n) === 1n)));
  const value = up ? kept + 1n : kept;
  return normalize(value.toString(), places);
}

/**
 * A decimal back as the double nearest it, signed.
 * @param {Decimal} d @param {boolean} negative
 * @returns {number}
 */
export function decimalToNumber(d, negative) {
  const value = Number(`${d.digits}e${-d.scale}`);
  return negative ? -value : value;
}

/**
 * The multiple of `10^-precision` nearest the exact value of `x`. A tie
 * breaks toward positive infinity (`'half-up'`, F&O `fn:round`: `2.5` → 3,
 * `-2.5` → −2) or to the even neighbour (`'half-even'`, F&O
 * `fn:round-half-to-even`). A negative argument that rounds to zero is
 * `-0`; `NaN`, `±Infinity` and zero are returned as they are. A non-integer
 * precision or an unknown rounding mode throws TypeError before rounding.
 * This is the exact counterpart of `Float64.roundTo`, which rounds the
 * scaled double `x · 10^precision` instead: the two differ where that
 * product rounds onto a tie — `roundExact(2.675, 2)` is 2.67 (the double is
 * 2.67499…), `Float64.roundTo(2.675, 2)` is 2.68.
 * @param {number} x
 * @param {number} [precision] - an integer, default 0
 * @param {'half-up' | 'half-even'} [mode]
 * @returns {number}
 * @example
 * roundExact(2.5);                 // 3
 * roundExact(-2.5);                // -2
 * roundExact(1.005, 2);            // 1   (the double is just below 1.005)
 * roundExact(2.5, 0, 'half-even'); // 2
 * roundExact(1234, -2);            // 1200
 */
export function roundExact(x, precision = 0, mode = 'half-up') {
  if (!Number.isInteger(precision)) throw new TypeError('roundExact precision must be an integer');
  if (mode !== 'half-up' && mode !== 'half-even') throw new TypeError('roundExact mode must be half-up or half-even');
  if (!Number.isFinite(x) || x === 0) return x;
  const negative = x < 0;
  // toward +∞ is away from zero for a positive value, toward it for a negative one
  const tie = mode === 'half-even' ? 'half-even' : negative ? 'half-down' : 'half-up';
  const rounded = roundDecimal(exactDecimal(x), precision, tie);
  if (rounded.digits === '0') return negative ? -0 : 0;
  return decimalToNumber(rounded, negative);
}

/** `10^n` for the scales a double divides by exactly. */
const POWERS_OF_TEN = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11,
  1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22];

/**
 * A test of whether a number is a whole multiple of `step`, decided on the
 * decimals the two numbers spell — the shortest decimal that reads back as
 * each ({@link shortestDecimal}: the digits `String(x)` prints) — exactly at
 * every magnitude: `0.3` is a multiple of `0.1`, `20000001` is none of
 * `10000000`, `1e308` is one of `0.5`. A step's multiples are those of its
 * magnitude. A value that is not finite is no multiple; under a step that
 * is not finite, or zero, a value is one where the quotient is whole (any
 * finite value of an infinite step, nothing of zero).
 * @param {number} step
 * @returns {(value: number) => boolean}
 */
export function multipleOfTester(step) {
  const size = Math.abs(step);
  if (!Number.isFinite(size) || size === 0) return (value) => Number.isInteger(value / step);
  const { digits, scale } = shortestDecimal(size);
  // the step is `unit × 10^-scale`
  const unit = Number(digits);
  const divisor = scale < POWERS_OF_TEN.length ? POWERS_OF_TEN[scale] : 0;
  // every whole number is a multiple where `unit` divides `10^scale` (1, 0.5, 1e-8)
  const wholeNumbers = 10n ** BigInt(scale) % BigInt(digits) === 0n;
  const wholeStep = scale === 0 && unit <= Number.MAX_SAFE_INTEGER;
  /** @type {ExactStep | undefined} built for the first value the fast paths leave */
  let exact;
  return function isMultipleOf(value) {
    if (!Number.isFinite(value)) return false;
    const x = Math.abs(value);
    if (divisor !== 0) {
      // A whole quotient can only be the one nearest the float quotient.
      // Below 1e15 that many steps is an exact integer of at most 15
      // digits over an exact power of ten: the division rounds to the
      // double that decimal spells, and a decimal of at most 15 digits is
      // the shortest one of the double it rounds to, so it is the value's
      // own decimal exactly when the two doubles are equal.
      const steps = Math.round(x / size) * unit;
      if (steps < 1e15) return x === steps / divisor;
    }
    // A whole double spells a whole decimal at every magnitude, below 2^53
    // the double itself.
    if (Number.isInteger(x)) {
      if (wholeNumbers) return true;
      if (wholeStep && x <= Number.MAX_SAFE_INTEGER) return x % unit === 0;
    }
    return isDecimalMultiple(x, exact ??= exactStep(digits, scale));
  };
}

/**
 * A step `unit × 10^-scale` as the exact route reads it: `unit` without
 * trailing zeros, `twosAndFives` the larger of the powers of 2 and 5 that
 * divide it, and `power` ten raised to that.
 * @typedef {{ unit: bigint, scale: number, twosAndFives: number, power: bigint }} ExactStep
 */

/**
 * The step `digits × 10^-scale` read once for the exact route: its trailing
 * zeros folded into the scale, and its factors of 2 and 5 counted.
 * @param {string} digits @param {number} scale
 * @returns {ExactStep}
 */
function exactStep(digits, scale) {
  const stripped = trim({ digits, scale }, -Infinity);
  const unit = BigInt(stripped.digits);
  let twos = 0;
  let fives = 0;
  for (let rest = unit; rest % 2n === 0n; rest /= 2n) twos++;
  for (let rest = unit; rest % 5n === 0n; rest /= 5n) fives++;
  const twosAndFives = Math.max(twos, fives);
  return { unit, scale: stripped.scale, twosAndFives, power: 10n ** BigInt(twosAndFives) };
}

/**
 * Whether the decimal a finite non-negative number spells is a whole
 * multiple of a step, decided exactly on the digits the number prints: the
 * quotient is `digits × 10^shift / unit`. The unit's factors 2 and 5 all
 * divide `10^twosAndFives`, so a larger shift is read at that power and
 * only the unit's factors prime to ten decide; a negative shift past every
 * printed digit leaves a fraction of anything but zero. No power of ten
 * follows the number's own exponent: `1e308` against `0.123456789` is the
 * remainder of 1 by 123456789.
 * @param {number} x
 * @param {ExactStep} step
 * @returns {boolean}
 */
function isDecimalMultiple(x, step) {
  const { digits, scale } = printedDecimal(x);
  const value = BigInt(digits);
  const shift = step.scale - scale;
  if (shift >= step.twosAndFives) return value * step.power % step.unit === 0n;
  if (shift >= 0) return value * 10n ** BigInt(shift) % step.unit === 0n;
  return -shift < digits.length ? value % (step.unit * 10n ** BigInt(-shift)) === 0n : value === 0n;
}
