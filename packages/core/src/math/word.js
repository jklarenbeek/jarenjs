//@ts-check
/**
 * @file BigInt fixed-width word math. The programmer-calculator
 * kernel: two's-complement integers of a fixed bit width (8/16/32/64),
 * signed or unsigned, with the bitwise/shift/rotate operators and
 * radix-string I/O a HEX/DEC/OCT/BIN calculator needs.
 *
 * Everything is native `BigInt` — zero dependencies, exact at any width.
 * Values crossing the module boundary are plain `BigInt`s already reduced
 * to the requested word (mask + sign-extend), so operators compose
 * without re-normalizing.
 */

/** Supported word sizes, in bits. */
export const WORD_BITS = Object.freeze([8, 16, 32, 64]);

/**
 * The unsigned mask for a word of `bits` bits: `2**bits - 1`.
 * @param {number} bits
 * @returns {bigint}
 */
export function wordMask(bits) {
  return (1n << BigInt(bits | 0)) - 1n;
}

/**
 * Reduce any integer to a fixed-width word. Unsigned words wrap into
 * `[0, 2**bits)`; signed words are the two's-complement interpretation,
 * so the high bit becomes the sign and the result lands in
 * `[-2**(bits-1), 2**(bits-1))`.
 *
 * @param {bigint|number|string} value
 * @param {number} [bits]
 * @param {boolean} [signed]
 * @returns {bigint}
 */
export function toWord(value, bits = 32, signed = false) {
  const b = BigInt(bits | 0);
  const mask = (1n << b) - 1n;
  let v = (typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value)))) & mask;
  if (signed) {
    const signBit = 1n << (b - 1n);
    if ((v & signBit) !== 0n) v -= (1n << b);
  }
  return v;
}

/** @param {bigint} a @param {bigint} b @param {number} [bits] @param {boolean} [signed] */
export function wAnd(a, b, bits = 32, signed = false) {
  return toWord(toWord(a, bits, false) & toWord(b, bits, false), bits, signed);
}
/** @param {bigint} a @param {bigint} b @param {number} [bits] @param {boolean} [signed] */
export function wOr(a, b, bits = 32, signed = false) {
  return toWord(toWord(a, bits, false) | toWord(b, bits, false), bits, signed);
}
/** @param {bigint} a @param {bigint} b @param {number} [bits] @param {boolean} [signed] */
export function wXor(a, b, bits = 32, signed = false) {
  return toWord(toWord(a, bits, false) ^ toWord(b, bits, false), bits, signed);
}
/** @param {bigint} a @param {number} [bits] @param {boolean} [signed] */
export function wNot(a, bits = 32, signed = false) {
  return toWord(~toWord(a, bits, false), bits, signed);
}
/** @param {bigint} a @param {bigint} n @param {number} [bits] @param {boolean} [signed] */
export function wShl(a, n, bits = 32, signed = false) {
  return toWord(toWord(a, bits, false) << (BigInt(n) % BigInt(bits)), bits, signed);
}
/**
 * Logical right shift (zero fill) over the unsigned representation, then
 * reinterpreted per `signed`.
 * @param {bigint} a @param {bigint} n @param {number} [bits] @param {boolean} [signed]
 */
export function wShr(a, n, bits = 32, signed = false) {
  return toWord(toWord(a, bits, false) >> (BigInt(n) % BigInt(bits)), bits, signed);
}
/** Rotate left. @param {bigint} a @param {bigint} n @param {number} [bits] @param {boolean} [signed] */
export function wRol(a, n, bits = 32, signed = false) {
  const b = BigInt(bits | 0);
  const u = toWord(a, bits, false);
  const s = ((BigInt(n) % b) + b) % b;
  const mask = (1n << b) - 1n;
  return toWord(((u << s) | (u >> (b - s))) & mask, bits, signed);
}
/** Rotate right. @param {bigint} a @param {bigint} n @param {number} [bits] @param {boolean} [signed] */
export function wRor(a, n, bits = 32, signed = false) {
  const b = BigInt(bits | 0);
  const u = toWord(a, bits, false);
  const s = ((BigInt(n) % b) + b) % b;
  const mask = (1n << b) - 1n;
  return toWord(((u >> s) | (u << (b - s))) & mask, bits, signed);
}
/**
 * Euclidean-flavoured modulo that follows the sign of the divisor,
 * reduced back into the word.
 * @param {bigint} a @param {bigint} b @param {number} [bits] @param {boolean} [signed]
 */
export function wMod(a, b, bits = 32, signed = false) {
  const x = toWord(a, bits, signed);
  const y = toWord(b, bits, signed);
  if (y === 0n) throw new RangeError('wMod: division by zero');
  return toWord(x % y, bits, signed);
}

/** @param {number} radix @returns {string} */
function radixDigits(radix) {
  return '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, radix);
}

/**
 * Format an integer as a radix string (no prefix). Groups digits with an
 * optional separator and left-pads to `pad` digits.
 *
 * @param {bigint|number} int
 * @param {number} [radix] 2..36
 * @param {{ group?: number, sep?: string, pad?: number, upper?: boolean }} [opts]
 * @returns {string}
 */
export function toBase(int, radix = 10, opts = {}) {
  const r = radix | 0;
  if (r < 2 || r > 36) throw new RangeError(`toBase: radix ${radix} out of range 2..36`);
  let v = typeof int === 'bigint' ? int : BigInt(Math.trunc(Number(int)));
  const neg = v < 0n;
  if (neg) v = -v;
  const R = BigInt(r);
  const digits = radixDigits(r);
  let out = v === 0n ? '0' : '';
  while (v > 0n) {
    out = digits[Number(v % R)] + out;
    v /= R;
  }
  if (opts.pad && out.length < opts.pad) out = out.padStart(opts.pad, '0');
  if (opts.group && opts.group > 0) {
    const sep = opts.sep ?? ' ';
    const parts = [];
    for (let i = out.length; i > 0; i -= opts.group) {
      parts.unshift(out.slice(Math.max(0, i - opts.group), i));
    }
    out = parts.join(sep);
  }
  if (opts.upper) out = out.toUpperCase();
  return neg ? '-' + out : out;
}

/**
 * Parse a radix string back to a BigInt. Tolerates group separators
 * (space/underscore), a leading sign, and an optional `0x`/`0o`/`0b`
 * prefix (which must agree with `radix` when both are given).
 *
 * @param {string} str
 * @param {number} [radix] 2..36
 * @returns {bigint}
 */
export function fromBase(str, radix = 10) {
  let s = String(str).trim().replace(/[ _]/g, '');
  let neg = false;
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  else if (s.startsWith('+')) s = s.slice(1);
  const m = /^0([xob])/i.exec(s);
  if (m) {
    const pfx = m[1].toLowerCase();
    const pfxRadix = pfx === 'x' ? 16 : pfx === 'o' ? 8 : 2;
    radix = pfxRadix;
    s = s.slice(2);
  }
  const r = radix | 0;
  if (r < 2 || r > 36) throw new RangeError(`fromBase: radix ${radix} out of range 2..36`);
  if (s.length === 0) throw new SyntaxError('fromBase: empty digit string');
  const R = BigInt(r);
  const digits = radixDigits(r);
  let acc = 0n;
  for (const ch of s.toLowerCase()) {
    const d = digits.indexOf(ch);
    if (d < 0) throw new SyntaxError(`fromBase: '${ch}' is not a base-${r} digit`);
    acc = acc * R + BigInt(d);
  }
  return neg ? -acc : acc;
}
