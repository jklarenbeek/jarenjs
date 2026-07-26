//@ts-check

/**
 * Punycode - the Bootstring encoding of Unicode for IDNA (RFC 3492) -
 * and the domain-level conversions built on it.
 *
 * Two layers, because they are used at different granularities:
 * `punycodeEncode`/`punycodeDecode` are the codec for ONE label and know
 * nothing about domains, while `domainToASCII`/`domainToUnicode` walk a
 * domain name (or the domain half of an email address) label by label
 * and apply the `xn--` prefix convention. `isValidIdnHostname` in
 * `host.js` splits labels itself and so calls the codec directly; the
 * domain pair is for callers holding a whole name.
 *
 * The `flag` parameter of RFC 3492's digit encoder is omitted: it
 * selects uppercase output, and IDNA A-labels are lowercase.
 */

import {
  toCodePoints,
  fromCodePoints,
} from '../string.js';

/** Bootstring parameters (RFC 3492 section 5). */
const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128; // the first non-basic code point
const DELIMITER = '-';
const MAX_INT = 0x7FFFFFFF; // the largest positive signed 32-bit value

const BASE_MINUS_T_MIN = BASE - T_MIN;

/** The ACE prefix that marks an encoded label. */
const ACE_PREFIX = 'xn--';

/**
 * Whether the code point separates labels. IDNA (RFC 3490 section 3.1)
 * accepts three full-stop variants besides the ASCII one.
 * @param {number} code - A UTF-16 code unit
 * @returns {boolean} True for a label separator
 */
function isLabelSeparator(code) {
  return code === 0x2E // '.'
    || code === 0x3002 // ideographic full stop
    || code === 0xFF0E // fullwidth full stop
    || code === 0xFF61; // halfwidth ideographic full stop
}

/**
 * The numeric value of a basic code point used as a Bootstring digit, or
 * `BASE` when the code point is not a digit at all.
 * @param {number} code - A basic (ASCII) code point
 * @returns {number} The digit value 0..35, or BASE
 */
function basicToDigit(code) {
  if (code - 0x30 < 0x0A) return code - 0x16; // '0'-'9' -> 26..35
  if (code - 0x41 < 0x1A) return code - 0x41; // 'A'-'Z' -> 0..25
  if (code - 0x61 < 0x1A) return code - 0x61; // 'a'-'z' -> 0..25
  return BASE;
}

/**
 * The basic code point representing a Bootstring digit: 0..25 map to
 * 'a'-'z', 26..35 to '0'-'9'.
 * @param {number} digit - A digit value 0..35
 * @returns {number} The code point
 */
function digitToBasic(digit) {
  return digit + 22 + 75 * (digit < 26 ? 1 : 0);
}

/**
 * Bias adaptation (RFC 3492 section 6.1).
 * @param {number} delta - The delta just encoded or decoded
 * @param {number} numPoints - Code points handled so far, plus one
 * @param {boolean} firstTime - Whether this is the first adaptation
 * @returns {number} The new bias
 */
function adapt(delta, numPoints, firstTime) {
  delta = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  let k = 0;
  for (; delta > ((BASE_MINUS_T_MIN * T_MAX) >> 1); k += BASE)
    delta = Math.floor(delta / BASE_MINUS_T_MIN);
  return Math.floor(k + (BASE_MINUS_T_MIN + 1) * delta / (delta + SKEW));
}

/**
 * Decode a Punycode string to Unicode. The input is a bare encoded
 * label - the `xn--` prefix, if any, belongs to the caller.
 *
 * @param {string} input - The Punycode-encoded text
 * @returns {string} The decoded Unicode text
 * @throws {RangeError} On a non-basic input character, a truncated digit
 *   sequence, or an integer overflow
 * @example
 * punycodeDecode('bcher-kva'); // 'bücher'
 */
export function punycodeDecode(input) {
  const inputLength = input.length;
  const output = [];
  let i = 0;
  let n = INITIAL_N;
  let bias = INITIAL_BIAS;

  // Everything before the last delimiter is literal basic code points.
  let basic = input.lastIndexOf(DELIMITER);
  if (basic < 0) basic = 0;

  for (let j = 0; j < basic; ++j) {
    const code = input.charCodeAt(j);
    if (code >= 0x80)
      throw new RangeError('Illegal input >= 0x80 (not a basic code point)');
    output.push(code);
  }

  for (let index = basic > 0 ? basic + 1 : 0; index < inputLength;) {
    // Decode a generalized variable-length integer into `i`. Overflow is
    // easier to check by growing `i` as we go and taking the difference
    // at the end than by tracking the delta separately.
    const oldi = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (index >= inputLength) throw new RangeError('Invalid input');

      const digit = basicToDigit(input.charCodeAt(index++));
      if (digit >= BASE || digit > Math.floor((MAX_INT - i) / w))
        throw new RangeError('Overflow: input needs wider integers to process');

      i += digit * w;
      const t = k <= bias ? T_MIN : (k >= bias + T_MAX ? T_MAX : k - bias);
      if (digit < t) break;

      const baseMinusT = BASE - t;
      if (w > Math.floor(MAX_INT / baseMinusT))
        throw new RangeError('Overflow: input needs wider integers to process');
      w *= baseMinusT;
    }

    const out = output.length + 1;
    bias = adapt(i - oldi, out, oldi === 0);

    // `i` was meant to wrap from `out` to 0, carrying into `n` each time.
    if (Math.floor(i / out) > MAX_INT - n)
      throw new RangeError('Overflow: input needs wider integers to process');

    n += Math.floor(i / out);
    i %= out;

    output.splice(i++, 0, n);
  }

  return fromCodePoints(output);
}

/**
 * Encode Unicode text as Punycode. The result is a bare encoded label -
 * prefixing it with `xn--` is the caller's job.
 *
 * @param {string} str - The Unicode text
 * @returns {string} The Punycode-encoded text
 * @throws {RangeError} On an integer overflow
 * @example
 * punycodeEncode('bücher'); // 'bcher-kva'
 */
export function punycodeEncode(str) {
  const input = toCodePoints(str);
  const inputLength = input.length;

  // Appended to directly rather than collected in an array and joined:
  // every character is written once and never revisited.
  let output = '';
  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;

  // The basic code points are copied out in order, then separated from
  // the encoded remainder by the delimiter.
  let basicLength = 0;
  for (let j = 0; j < inputLength; j++) {
    if (input[j] < 0x80) {
      output += String.fromCharCode(input[j]);
      basicLength++;
    }
  }
  if (basicLength) output += DELIMITER;

  let handledCPCount = basicLength;
  while (handledCPCount < inputLength) {
    // Every non-basic code point below `n` is already encoded; find the
    // next one up.
    let m = MAX_INT;
    for (let j = 0; j < inputLength; j++) {
      const value = input[j];
      if (value >= n && value < m) m = value;
    }

    const handledPlusOne = handledCPCount + 1;
    if (m - n > Math.floor((MAX_INT - delta) / handledPlusOne))
      throw new RangeError('Overflow: input needs wider integers to process');

    delta += (m - n) * handledPlusOne;
    n = m;

    for (let j = 0; j < inputLength; j++) {
      const value = input[j];
      if (value < n && ++delta > MAX_INT)
        throw new RangeError('Overflow: input needs wider integers to process');
      if (value !== n) continue;

      // Write `delta` as a generalized variable-length integer.
      let q = delta;
      for (let k = BASE; ; k += BASE) {
        const t = k <= bias ? T_MIN : (k >= bias + T_MAX ? T_MAX : k - bias);
        if (q < t) break;
        const qMinusT = q - t;
        const baseMinusT = BASE - t;
        output += String.fromCharCode(digitToBasic(t + qMinusT % baseMinusT));
        q = Math.floor(qMinusT / baseMinusT);
      }

      output += String.fromCharCode(digitToBasic(q));
      bias = adapt(delta, handledPlusOne, handledCPCount === basicLength);
      delta = 0;
      ++handledCPCount;
    }

    ++delta;
    ++n;
  }
  return output;
}

/**
 * Walk a domain name label by label, converting each with `convert` and
 * rejoining on ASCII full stops.
 *
 * In an email address only the domain is converted; the local part is
 * left exactly as written. Splitting on the FIRST "@" and converting
 * only what follows the second segment matches RFC 3490's assumption of
 * a single "@" - a malformed address with more is not a case this
 * conversion is defined for.
 *
 * @param {string} domain - A domain name or email address
 * @param {(label: string) => string} convert - The per-label conversion
 * @returns {string} The converted domain
 */
function mapLabels(domain, convert) {
  let prefix = '';
  const parts = domain.split('@');
  if (parts.length > 1) {
    prefix = parts[0] + '@';
    domain = parts[1];
  }

  let out = prefix;
  let start = 0;
  const end = domain.length;
  for (let i = 0; i <= end; i++) {
    if (i < end && !isLabelSeparator(domain.charCodeAt(i))) continue;
    out += convert(domain.slice(start, i));
    if (i < end) out += '.';
    start = i + 1;
  }
  return out;
}

/**
 * Whether the label carries the ACE prefix, in any case.
 * @param {string} label - A domain label
 * @returns {boolean} True when the label starts with `xn--`
 */
function hasAcePrefix(label) {
  return label.length >= 4
    && (label.charCodeAt(0) | 0x20) === 0x78 // 'x'
    && (label.charCodeAt(1) | 0x20) === 0x6E // 'n'
    && label.charCodeAt(2) === 0x2D // '-'
    && label.charCodeAt(3) === 0x2D;
}

/**
 * Convert a domain name or email address to its Unicode form, decoding
 * every `xn--` label. Labels that are not encoded are left alone, so
 * calling this on an already-Unicode name is harmless.
 *
 * @param {string} input - The domain name or email address
 * @returns {string} The Unicode form
 * @example
 * domainToUnicode('xn--bcher-kva.example'); // 'bücher.example'
 */
export function domainToUnicode(input) {
  return mapLabels(input, (label) => hasAcePrefix(label)
    ? punycodeDecode(label.slice(4).toLowerCase())
    : label);
}

/**
 * Convert a domain name or email address to its ASCII (ACE) form,
 * encoding every label that carries non-ASCII characters. Labels that
 * are already ASCII are left alone, so calling this on an ASCII name is
 * harmless.
 *
 * @param {string} input - The domain name or email address
 * @returns {string} The ACE form
 * @example
 * domainToASCII('bücher.example'); // 'xn--bcher-kva.example'
 */
export function domainToASCII(input) {
  return mapLabels(input, (label) => {
    for (let i = 0; i < label.length; i++) {
      if (label.charCodeAt(i) > 0x7E)
        return ACE_PREFIX + punycodeEncode(label);
    }
    return label;
  });
}
