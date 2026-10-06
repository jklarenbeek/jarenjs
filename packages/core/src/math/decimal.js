//@ts-check
/**
 * @file Decimal rounding of an IEEE 754 double, in the two senses a
 * formatter and a query need:
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
 *
 * Both work on decimal digit strings: no binary scaling (`x * 100`) ever
 * decides a digit.
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
 * The shortest decimal that reads back as `|x|` — the digits of
 * `String(x)`, which ECMAScript defines as the shortest round trip.
 * @param {number} x - a finite number
 * @returns {Decimal}
 */
export function shortestDecimal(x) {
  const text = String(Math.abs(x));
  const e = text.indexOf('e');
  const mantissa = e < 0 ? text : text.slice(0, e);
  const exponent = e < 0 ? 0 : Number(text.slice(e + 1));
  const dot = mantissa.indexOf('.');
  const digits = dot < 0 ? mantissa : mantissa.slice(0, dot) + mantissa.slice(dot + 1);
  const fraction = dot < 0 ? 0 : mantissa.length - dot - 1;
  return normalize(digits, fraction - exponent);
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

/** Drop trailing fraction zeros: `1500 × 10^-3` is `15 × 10^-1`. @param {Decimal} d @returns {Decimal} */
function trim(d) {
  let { digits, scale } = d;
  while (scale > 0 && digits.length > 1 && digits.charCodeAt(digits.length - 1) === 0x30) {
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
