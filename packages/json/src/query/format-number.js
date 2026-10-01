//@ts-check
/**
 * @file `$format-number` — XPath F&O 3.1 `fn:format-number(value, picture,
 * decimal-format)` with the decimal format as DATA: a record of the
 * characters a picture is written in and a number is spelled with, passed
 * as the third operand or registered by name at compile
 * (`options.decimalFormats`). A query stays locale-free and deterministic;
 * `@jarenjs/locales` ships each pack's record.
 *
 * One deviation, for parity with ICU (`Intl.NumberFormat`): the value is
 * rounded on its shortest round-trip decimal (the digits `String(x)`
 * prints), half away from zero — so `1.005` at two places is `1.01` — where
 * F&O rounds the binary value half to even.
 */

import { roundDecimal, shiftDecimal, shortestDecimal } from '@jarenjs/core/math';

/**
 * A decimal format (F&O §4.7.1), every member one character but the two
 * symbols.
 * @typedef {Object} DecimalFormat
 * @property {string} decimalSeparator
 * @property {string} groupingSeparator
 * @property {string} minusSign
 * @property {string} percent
 * @property {string} perMille
 * @property {string} zeroDigit - the zero of the digit family (`0`, `٠`, …)
 * @property {string} digit - the optional digit sign (`#`)
 * @property {string} patternSeparator
 * @property {string} exponentSeparator
 * @property {string} infinity
 * @property {string} NaN
 */

/** F&O's default decimal format. @type {Readonly<DecimalFormat>} */
export const DEFAULT_DECIMAL_FORMAT = Object.freeze({
  decimalSeparator: '.', groupingSeparator: ',', minusSign: '-', percent: '%', perMille: '‰',
  zeroDigit: '0', digit: '#', patternSeparator: ';', exponentSeparator: 'e', infinity: 'Infinity', NaN: 'NaN',
});

const MEMBERS = Object.freeze(Object.keys(DEFAULT_DECIMAL_FORMAT));
/** The members that are picture characters: one character each, all different. */
const CHARACTERS = Object.freeze(['decimalSeparator', 'groupingSeparator', 'percent', 'perMille', 'digit',
  'patternSeparator', 'exponentSeparator']);

/**
 * A refusal of a decimal format or a picture: a catalog message id and its
 * params, for the operator to raise as a compile or a runtime error.
 */
export class FormatRefusal extends Error {
  /** @param {string} messageId @param {Record<string, any>} params */
  constructor(messageId, params) {
    super(messageId);
    this.messageId = messageId;
    this.params = params;
  }
}

/** Whether a code point is a Unicode decimal digit (Nd). @param {number} cp */
const isNd = (cp) => cp >= 0 && cp <= 0x10FFFF && /^\p{Nd}$/u.test(String.fromCodePoint(cp));

/**
 * Whether a code point is the zero of a decimal digit family. Unicode lays
 * every family out as a run of ten consecutive Nd code points, zero first,
 * and runs can follow one another (the mathematical digits): a zero is an
 * Nd code point at a multiple of ten into its run.
 * @param {number} cp
 */
function isDigitZero(cp) {
  if (!isNd(cp) || !isNd(cp + 9)) return false;
  let before = 0;
  while (before < 50 && isNd(cp - before - 1)) before++;
  return before % 10 === 0;
}

/**
 * A decimal format record, checked and completed from F&O's defaults: an
 * object of known members, each picture character one code point and
 * different from the others, a digit-family zero, the two symbols strings.
 * @param {any} record
 * @returns {Readonly<DecimalFormat>}
 * @throws {FormatRefusal}
 */
export function readDecimalFormat(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record))
    throw new FormatRefusal('query/decimal-format-record', {});
  for (const key of Object.keys(record)) {
    if (!MEMBERS.includes(key)) throw new FormatRefusal('query/decimal-format-member', { name: key });
  }
  /** @type {Record<string, string>} */
  const out = { ...DEFAULT_DECIMAL_FORMAT };
  for (const key of MEMBERS) {
    if (record[key] === undefined) continue;
    const value = record[key];
    const symbol = key === 'infinity' || key === 'NaN';
    if (typeof value !== 'string' || value === '' || (!symbol && [...value].length !== 1))
      throw new FormatRefusal('query/decimal-format-character', { name: key });
    out[key] = value;
  }
  if (!isDigitZero(/** @type {number} */ (out.zeroDigit.codePointAt(0))))
    throw new FormatRefusal('query/decimal-format-zero', { char: out.zeroDigit });
  const zero = /** @type {number} */ (out.zeroDigit.codePointAt(0));
  const seen = new Map();
  for (const key of CHARACTERS) {
    const cp = /** @type {number} */ (out[key].codePointAt(0));
    if (seen.has(cp) || (cp >= zero && cp <= zero + 9))
      throw new FormatRefusal('query/decimal-format-clash', { char: out[key] });
    seen.set(cp, key);
  }
  return Object.freeze(/** @type {DecimalFormat} */ (/** @type {unknown} */ (out)));
}

/**
 * One analysed sub-picture (F&O §4.7.4).
 * @typedef {Object} SubPicture
 * @property {string} prefix
 * @property {string} suffix
 * @property {number} minInt
 * @property {number[]} intGroups - grouping positions from the right
 * @property {number} groupSize - the regular grouping size, or 0
 * @property {number} minFrac
 * @property {number} maxFrac
 * @property {number[]} fracGroups - grouping positions from the left
 * @property {number} scale - 2 for a percent, 3 for a per-mille, else 0
 * @property {number} minExp - exponent digits, or -1 without an exponent
 */

/** A picture refusal: the rule broken, as a catalog message the operator
 * nests in its own sentence. @param {string} rule @returns {never} */
function refuse(rule) {
  throw new FormatRefusal(rule, {});
}

/**
 * Analyse one sub-picture.
 * @param {string[]} chars - the sub-picture's code points
 * @param {Readonly<DecimalFormat>} df
 * @returns {SubPicture}
 */
function analyse(chars, df) {
  const zero = /** @type {number} */ (df.zeroDigit.codePointAt(0));
  const isDigit = (/** @type {string} */ c) => {
    const cp = /** @type {number} */ (c.codePointAt(0));
    return cp >= zero && cp <= zero + 9;
  };
  const isActiveBase = (/** @type {string} */ c) => isDigit(c) || c === df.digit || c === df.decimalSeparator
    || c === df.groupingSeparator;
  // an exponent separator counts only between two active characters (rule 9)
  const active = chars.map((c, i) => isActiveBase(c) || (c === df.exponentSeparator
    && i > 0 && i < chars.length - 1 && isActiveBase(chars[i - 1]) && isActiveBase(chars[i + 1])));
  const first = active.indexOf(true);
  const last = active.lastIndexOf(true);
  if (first < 0) refuse('query/picture/no-digit');
  // rule 5: no passive character between active ones
  for (let i = first; i <= last; i++) if (!active[i]) refuse('query/picture/passive-inside');
  const prefix = chars.slice(0, first).join('');
  const suffix = chars.slice(last + 1).join('');
  const body = chars.slice(first, last + 1);
  const passive = chars.slice(0, first).concat(chars.slice(last + 1));
  const percents = passive.filter((c) => c === df.percent).length;
  const perMilles = passive.filter((c) => c === df.perMille).length;
  if (percents + perMilles > 1) refuse('query/picture/percent');
  const exponents = body.map((c, i) => (c === df.exponentSeparator && active[first + i] ? i : -1)).filter((i) => i >= 0);
  if (exponents.length > 1) refuse('query/picture/exponent-twice');
  const exponentAt = exponents.length === 1 ? exponents[0] : body.length;
  if (exponents.length === 1 && percents + perMilles > 0) refuse('query/picture/exponent-percent');
  const mantissa = body.slice(0, exponentAt);
  const exponent = body.slice(exponentAt + 1);
  if (exponents.length === 1 && (exponent.length === 0 || exponent.some((c) => !isDigit(c))))
    refuse('query/picture/exponent-digits');
  const decimals = mantissa.filter((c) => c === df.decimalSeparator).length;
  if (decimals > 1) refuse('query/picture/decimal-twice');
  const point = decimals === 1 ? mantissa.indexOf(df.decimalSeparator) : mantissa.length;
  const integer = mantissa.slice(0, point);
  const fraction = mantissa.slice(point + 1);
  if (!mantissa.some((c) => isDigit(c) || c === df.digit)) refuse('query/picture/no-digit');
  // rules 6 and 7: a grouping separator never next to another, nor to the point, nor ending the integer part
  for (let i = 0; i < mantissa.length; i++) {
    if (mantissa[i] !== df.groupingSeparator) continue;
    if (mantissa[i + 1] === df.groupingSeparator) refuse('query/picture/grouping-twice');
    if (mantissa[i + 1] === df.decimalSeparator || mantissa[i - 1] === df.decimalSeparator
      || (decimals === 0 && i === mantissa.length - 1)) refuse('query/picture/grouping-edge');
  }
  // rule 8: optional digits lead the integer part and trail the fraction
  let mandatory = false;
  for (const c of integer) {
    if (isDigit(c)) mandatory = true;
    else if (c === df.digit && mandatory) refuse('query/picture/digit-order');
  }
  let optional = false;
  for (const c of fraction) {
    if (c === df.digit) optional = true;
    else if (isDigit(c) && optional) refuse('query/picture/digit-order');
  }
  /** grouping positions from the right of the integer part */
  const intGroups = [];
  let digitsRight = 0;
  for (let i = integer.length - 1; i >= 0; i--) {
    if (integer[i] === df.groupingSeparator) intGroups.push(digitsRight);
    else digitsRight++;
  }
  // regular: every position a multiple of the smallest, every multiple occupied (F&O §4.7.4)
  let groupSize = 0;
  if (intGroups.length > 0) {
    const g = Math.min(...intGroups);
    const sorted = [...intGroups].sort((a, b) => a - b);
    const regular = g > 0 && sorted.every((p, i) => p === g * (i + 1));
    if (regular) groupSize = g;
  }
  const fracGroups = [];
  let digitsLeft = 0;
  for (const c of fraction) {
    if (c === df.groupingSeparator) fracGroups.push(digitsLeft);
    else digitsLeft++;
  }
  let minInt = integer.filter(isDigit).length;
  const minFrac = fraction.filter(isDigit).length;
  const maxFrac = fraction.filter((c) => isDigit(c) || c === df.digit).length;
  if (minInt === 0 && maxFrac === 0 && exponents.length === 0) minInt = 1;
  return { prefix, suffix, minInt, intGroups, groupSize, minFrac, maxFrac, fracGroups,
    scale: percents > 0 ? 2 : perMilles > 0 ? 3 : 0,
    minExp: exponents.length === 1 ? exponent.length : -1 };
}

/**
 * A compiled picture: the positive sub-picture, and the negative one (the
 * minus sign before the positive prefix, when the picture has none).
 * @typedef {{ positive: SubPicture, negative: SubPicture, format: Readonly<DecimalFormat> }} Picture
 */

/**
 * Compile a picture string under a decimal format.
 * @param {string} picture
 * @param {Readonly<DecimalFormat>} df
 * @returns {Picture}
 * @throws {FormatRefusal}
 */
export function compilePicture(picture, df) {
  const chars = [...picture];
  const separators = chars.filter((c) => c === df.patternSeparator).length;
  if (separators > 1) refuse('query/picture/separator-twice');
  const at = chars.indexOf(df.patternSeparator);
  const positive = analyse(at < 0 ? chars : chars.slice(0, at), df);
  const negative = at < 0 ? { ...positive, prefix: df.minusSign + positive.prefix }
    : analyse(chars.slice(at + 1), df);
  return { positive, negative, format: df };
}

/**
 * Insert grouping separators between the digits of an integer part (an
 * array of code points, already in the format's digit family).
 * @param {string[]} digits @param {SubPicture} sub @param {string} separator
 */
function groupInteger(digits, sub, separator) {
  if (sub.intGroups.length === 0) return digits.join('');
  let out = '';
  const n = digits.length;
  for (let i = 0; i < n; i++) {
    const fromRight = n - i;
    if (i > 0 && (sub.groupSize > 0 ? fromRight % sub.groupSize === 0 : sub.intGroups.includes(fromRight))) out += separator;
    out += digits[i];
  }
  return out;
}

/** Insert grouping separators between the digits of a fraction. @param {string[]} digits @param {SubPicture} sub @param {string} separator */
function groupFraction(digits, sub, separator) {
  if (sub.fracGroups.length === 0) return digits.join('');
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && sub.fracGroups.includes(i)) out += separator;
    out += digits[i];
  }
  return out;
}

/** ASCII digits in the format's digit family, one code point per digit.
 * @param {string} digits @param {Readonly<DecimalFormat>} df @returns {string[]} */
function mapDigits(digits, df) {
  const zero = /** @type {number} */ (df.zeroDigit.codePointAt(0));
  return [...digits].map((c) => String.fromCodePoint(zero + c.charCodeAt(0) - 0x30));
}

/**
 * Format a number through a compiled picture. `NaN` is the format's NaN
 * symbol alone (F&O); a negative value, negative zero included, takes the
 * negative sub-picture; an infinity is the prefix, the infinity symbol and
 * the suffix.
 * @param {number} value
 * @param {Picture} picture
 * @returns {string}
 */
export function formatNumberPicture(value, picture) {
  const df = picture.format;
  if (Number.isNaN(value)) return df.NaN;
  const negative = value < 0 || Object.is(value, -0);
  const sub = negative ? picture.negative : picture.positive;
  if (!Number.isFinite(value)) return sub.prefix + df.infinity + sub.suffix;
  let decimal = shiftDecimal(shortestDecimal(value), sub.scale);
  let exponentText = '';
  if (sub.minExp >= 0) {
    // the mantissa keeps minInt integer digits (one, when the picture has none)
    const integerDigits = Math.max(sub.minInt, 1);
    let exponent = 0;
    if (decimal.digits !== '0') {
      const magnitude = decimal.digits.length - decimal.scale; // digits before the point
      exponent = magnitude - integerDigits;
      decimal = { digits: decimal.digits, scale: decimal.scale + exponent };
      decimal = roundDecimal(decimal, sub.maxFrac, 'half-up');
      // rounding up can carry into another integer digit: renormalize once
      if (decimal.digits.length - decimal.scale > integerDigits) {
        exponent += 1;
        decimal = roundDecimal({ digits: decimal.digits, scale: decimal.scale + 1 }, sub.maxFrac, 'half-up');
      }
    }
    const sign = exponent < 0 ? df.minusSign : '';
    exponentText = df.exponentSeparator + sign + mapDigits(String(Math.abs(exponent)).padStart(sub.minExp, '0'), df).join('');
  }
  else decimal = roundDecimal(decimal, sub.maxFrac, 'half-up');
  const { digits, scale } = decimal;
  let integer = scale >= digits.length ? '' : digits.slice(0, digits.length - scale);
  let fraction = scale > 0 ? digits.slice(-scale).padStart(scale, '0') : '';
  if (integer === '0') integer = '';
  integer = integer.padStart(sub.minInt, '0');
  while (fraction.length > sub.minFrac && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  fraction = fraction.padEnd(sub.minFrac, '0');
  if (integer === '' && fraction === '') integer = '0';
  let out = sub.prefix + groupInteger(mapDigits(integer, df), sub, df.groupingSeparator);
  if (fraction !== '') out += df.decimalSeparator + groupFraction(mapDigits(fraction, df), sub, df.groupingSeparator);
  return out + exponentText + sub.suffix;
}
