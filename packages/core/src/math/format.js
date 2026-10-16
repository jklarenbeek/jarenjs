//@ts-check
/**
 * @file Number formatting and parsing. The
 * one place the suite formats a number for display: notation control
 * (auto/fixed/sci/eng), thousands grouping and radix output, plus a
 * radix-aware `parseNumber`. Radix I/O delegates to `math/word.js` so
 * base conversion is never re-implemented. Both read a language's
 * characters from a decimal format record (`decimalFormat`), the record
 * `@jarenjs/locales` compiles from a pack and `$format-number` of
 * `@jarenjs/json` formats pictures with, so core needs no locale data.
 * `numberSyntax` is the one grammar of a number written in a language's
 * characters: `parseNumber` reads a whole text by it and `$quantity` of
 * `@jarenjs/json` finds a number in free text by it.
 */

import { toBase, fromBase } from './word.js';

/**
 * @typedef {object} FormatOptions
 * @property {'auto'|'fixed'|'sci'|'eng'} [notation] default 'auto'
 * @property {number} [precision] significant/decimal digits (notation-dependent)
 * @property {boolean|string} [group] thousands separator: true → ',', or a custom string
 * @property {number} [radix] 2..36; when not 10, `value` is formatted as an integer word
 * @property {string} [decimal] decimal mark, default '.' (the record's under `decimalFormat`)
 * @property {DecimalFormatLike} [decimalFormat] write a base-10 number in a
 *   language's characters: its decimal separator, its grouping separator for
 *   `group: true`, its minus sign, digits, exponent separator and the words
 *   for infinity and NaN
 */

/**
 * The characters a language writes a number with: the members of the
 * decimal format record `compileNumberLocale(pack).decimalFormat` of
 * `@jarenjs/locales` produces (and `$format-number` of `@jarenjs/json`
 * reads). Members it leaves out are English.
 * @typedef {object} DecimalFormatLike
 * @property {string} decimalSeparator
 * @property {string} groupingSeparator
 * @property {string} [minusSign] default '-'
 * @property {string} [zeroDigit] the zero of the digit family, default '0'
 * @property {string} [exponentSeparator] default 'e'
 * @property {string} [infinity] default '∞'
 * @property {string} [NaN] default 'NaN'
 */

/**
 * @typedef {object} NumberCharacters
 * @property {string} decimal
 * @property {string} group
 * @property {string} minus
 * @property {number} zero - the zero's code point
 * @property {string} exponent
 * @property {string} infinity
 * @property {string} nan
 * @property {NumberSyntax} [syntax] - built on the first read
 * @property {RegExp} [grammar] - the syntax, anchored
 */

/** @type {WeakMap<object, NumberCharacters>} */
const readRecords = new WeakMap();

/** Whether a code point is a Unicode decimal digit (Nd). @param {number} cp */
const isNd = (cp) => cp >= 0 && cp <= 0x10FFFF && /^\p{Nd}$/u.test(String.fromCodePoint(cp));

/**
 * Whether a code point is the zero of a decimal digit family. Unicode lays
 * every family out as a run of ten consecutive Nd code points, zero first,
 * and runs can follow one another (the mathematical digits): a zero is an
 * Nd code point at a multiple of ten into its run.
 * @param {number} cp
 * @returns {boolean}
 */
export function isDigitZero(cp) {
  if (!isNd(cp) || !isNd(cp + 9)) return false;
  let before = 0;
  while (before < 50 && isNd(cp - before - 1)) before++;
  return before % 10 === 0;
}

/**
 * Check a decimal format record once (a frozen one is remembered): the two
 * separators non-empty, different and free of digits, so a number text
 * reads one way only, and the zero digit the first of ten digits.
 * @param {DecimalFormatLike} record
 * @returns {NumberCharacters}
 */
function readNumberCharacters(record) {
  const known = readRecords.get(record);
  if (known !== undefined) return known;
  if (record === null || typeof record !== 'object')
    throw new TypeError('decimalFormat must be a decimal format record, such as compileNumberLocale(pack).decimalFormat');
  const text = (/** @type {string} */ name, /** @type {string} */ fallback) => {
    const value = /** @type {any} */ (record)[name] ?? fallback;
    if (typeof value !== 'string' || value === '')
      throw new TypeError(`decimalFormat.${name} must be a non-empty string`);
    return value;
  };
  const decimal = text('decimalSeparator', '');
  const group = text('groupingSeparator', '');
  if (decimal === group || /\p{Nd}/u.test(decimal + group))
    throw new TypeError(`decimalFormat's decimal separator '${decimal}' and grouping separator '${group}' must differ and hold no digit, or a number text reads two ways`);
  const zeroText = text('zeroDigit', '0');
  const zero = /** @type {number} */ (zeroText.codePointAt(0));
  if ([...zeroText].length !== 1 || !isDigitZero(zero))
    throw new TypeError(`decimalFormat.zeroDigit '${zeroText}' must be the zero of a family of ten digits`);
  /** @type {NumberCharacters} */
  const read = {
    decimal, group, minus: text('minusSign', '-'), zero,
    exponent: text('exponentSeparator', 'e'), infinity: text('infinity', '∞'), nan: text('NaN', 'NaN'),
  };
  if (Object.isFrozen(record)) readRecords.set(record, read);
  return read;
}

/** ASCII digits in a digit family. @param {string} ascii @param {number} zero */
function toFamily(ascii, zero) {
  if (zero === 0x30) return ascii;
  let out = '';
  for (const c of ascii) {
    const d = c.charCodeAt(0) - 0x30;
    out += d >= 0 && d <= 9 ? String.fromCodePoint(zero + d) : c;
  }
  return out;
}

/** Digits of a family, and ASCII digits, as ASCII. @param {string} text @param {number} zero */
function fromFamily(text, zero) {
  if (zero === 0x30) return text;
  let out = '';
  for (const c of text) {
    const cp = /** @type {number} */ (c.codePointAt(0));
    out += cp >= zero && cp <= zero + 9 ? String.fromCharCode(0x30 + cp - zero) : c;
  }
  return out;
}

// written so it holds inside a character class and outside one under `u`
const escapeRegExp = (/** @type {string} */ text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/-/g, '\\x2d');

/**
 * The characters a number is written in, as `numberSyntax` takes them.
 * @typedef {object} NumberSyntaxCharacters
 * @property {string} decimal - the decimal separator
 * @property {string} group - the grouping separator
 * @property {string} minus - the minus sign; `-` and `−` read as one too
 * @property {number} zero - the code point of the digit family's zero
 * @property {string} [exponent] - the exponent separator, default 'e';
 *   `e` and `E` read as one too
 */

/**
 * A number's digits as written, in ASCII.
 * @typedef {object} WrittenNumber
 * @property {boolean} negative - a minus sign was written
 * @property {string} whole - the integer part, without its grouping separators
 * @property {string} fraction - the digits after the decimal separator, or ''
 * @property {string} exponent - the exponent with its sign ('-3', '12'), or ''
 */

/**
 * The grammar of a written number, as regular expression source.
 * @typedef {object} NumberSyntax
 * @property {string} source - unanchored source under the `u` flag; its
 *   capturing groups, in order: the plus sign (unless `plus: false`), the
 *   minus sign, the integer part, the fraction, then (unless
 *   `exponent: false`) the exponent's sign and digits
 * @property {number} groups - how many capturing groups `source` holds
 * @property {string} digits - the digits read (ASCII and the family) as the
 *   body of a character class
 * @property {string} group - the grouping separator, escaped
 * @property {string} decimal - the decimal separator, escaped
 * @property {string} minus - the minus sign, escaped
 * @property {(match: RegExpExecArray) => WrittenNumber} read - the digits
 *   of a match whose first capturing groups are the source's
 */

/**
 * The one grammar of a number written in a language's characters, which
 * `parseNumber` reads a whole text by under `decimalFormat` and `$quantity`
 * of `@jarenjs/json` finds a number in free text by: an optional sign (`+`,
 * or a minus: the given one, `-` or `−`), an integer part either ungrouped
 * or grouped in threes after a leading group of one to three digits that
 * does not start with zero (`0.125` is no grouped number), an
 * optional fraction after the decimal separator, and an optional exponent
 * (the given separator, `e` or `E`, an optional sign, digits); digits are
 * ASCII or the family of `zero`. `plus: false` reads no `+` and
 * `exponent: false` no exponent. The source is unanchored, for the caller
 * to anchor or to embed in its own context after no capturing group of its
 * own, so that `read` finds its groups first; the escaped separators and the
 * digit class hold inside a character class and outside one. The
 * characters are taken as given: the caller checks that they read one way.
 * @param {NumberSyntaxCharacters} chars
 * @param {{ plus?: boolean, exponent?: boolean }} [options] both default true
 * @returns {NumberSyntax}
 */
export function numberSyntax(chars, options = {}) {
  const { zero, group: groupText } = chars;
  const digits = zero === 0x30 ? '0-9'
    : `0-9${escapeRegExp(String.fromCodePoint(zero))}-${escapeRegExp(String.fromCodePoint(zero + 9))}`;
  const digit = `[${digits}]`;
  // a grouped integer part leads with a digit that is not zero: no writer
  // groups `0.125`, and reading it as 125 would be a guess a thousand
  // times too large at the decimal separator the writer meant
  const lead = zero === 0x30 ? '[1-9]'
    : `[1-9${escapeRegExp(String.fromCodePoint(zero + 1))}-${escapeRegExp(String.fromCodePoint(zero + 9))}]`;
  const minus = escapeRegExp(chars.minus);
  const group = escapeRegExp(groupText);
  const decimal = escapeRegExp(chars.decimal);
  const anyMinus = `${minus}|\\x2d|\\u2212`;
  const plus = options.plus !== false;
  const exponent = options.exponent !== false;
  // groups by position (a named group would cost every match an object)
  let source = `(?:${plus ? '(\\+)|' : ''}(${anyMinus}))?(${lead}${digit}{0,2}(?:${group}${digit}{3})+|${digit}+)(?:${decimal}(${digit}+))?`;
  if (exponent)
    source += `(?:(?:${escapeRegExp(chars.exponent ?? 'e')}|[eE])(\\+|${anyMinus})?(${digit}+))?`;
  const at = plus ? 2 : 1; // the minus sign's group
  return {
    source, groups: at + (exponent ? 4 : 2), digits, group, decimal, minus,
    read: (m) => ({
      negative: m[at] !== undefined,
      whole: fromFamily(m[at + 1].split(groupText).join(''), zero),
      fraction: m[at + 2] === undefined ? '' : fromFamily(m[at + 2], zero),
      exponent: !exponent || m[at + 4] === undefined ? ''
        : `${m[at + 3] === undefined || m[at + 3] === '+' ? '' : '-'}${fromFamily(m[at + 4], zero)}`,
    }),
  };
}

/**
 * Read a base-10 number written in a record's characters, or NaN.
 * @param {string} s - trimmed
 * @param {NumberCharacters} chars
 * @returns {number}
 */
function parseWritten(s, chars) {
  for (const sign of ['', '+', '-', '\u2212', chars.minus]) {
    if (!s.startsWith(sign)) continue;
    const rest = s.slice(sign.length);
    if (rest === chars.infinity || rest === '∞' || rest.toLowerCase() === 'infinity')
      return sign === '' || sign === '+' ? Infinity : -Infinity;
  }
  if (chars.syntax === undefined) {
    chars.syntax = numberSyntax(chars);
    chars.grammar = new RegExp(`^${chars.syntax.source}$`, 'u');
  }
  const m = /** @type {RegExp} */ (chars.grammar).exec(s);
  if (m === null) return NaN;
  const { negative, whole, fraction, exponent } = chars.syntax.read(m);
  return Number(`${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}${exponent === '' ? '' : `e${exponent}`}`);
}

/**
 * Insert a grouping separator every three digits of an integer string
 * (sign-aware).
 * @param {string} intPart
 * @param {string} sep
 * @returns {string}
 */
function groupInteger(intPart, sep) {
  let neg = '';
  let s = intPart;
  if (s.startsWith('-')) { neg = '-'; s = s.slice(1); }
  const parts = [];
  for (let i = s.length; i > 0; i -= 3) {
    parts.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return neg + parts.join(sep);
}

/**
 * Engineering notation: mantissa in [1, 1000) times 10^(3k).
 * @param {number} value
 * @param {number} precision
 * @returns {string}
 */
function toEngineering(value, precision) {
  if (value === 0) return '0e+0';
  // the exponent comes from the number's own digits, so it is exact at every
  // magnitude, and the mantissa is shifted as text, so no power of ten has to
  // be representable (the smallest subnormals have none)
  const [digits, exponent] = value.toExponential().split('e');
  const decimalExp = Number(exponent);
  const render = (engExp) => {
    const mantissa = Number(`${digits}e${decimalExp - engExp}`);
    return precision >= 0 ? mantissa.toFixed(precision) : String(mantissa);
  };
  let engExp = Math.floor(decimalExp / 3) * 3;
  let m = render(engExp);
  // rounding can carry the mantissa up to 1000: 999.9996 is 1.000e+3
  if (precision >= 0 && Math.abs(Number(m)) >= 1000) {
    engExp += 3;
    m = render(engExp);
  }
  return `${m}e${engExp >= 0 ? '+' : ''}${engExp}`;
}

/**
 * Format a number for display.
 *
 * `notation: 'auto'` (the default) is NOT a drop-in for a fixed-unit
 * readout: the auto branch escapes to exponential once
 * `abs(value) >= 1e21` or `abs(value) < 1e-6`, so
 * `formatNumber(v, { precision: 3 })` is not interchangeable with a
 * plain `Number(v.toPrecision(3))`. A caller that appends its own unit
 * - `"0.0509 ms"` - wants the value never to become `5.09e-5`, and must
 * either pass `notation: 'fixed'` or keep its own rounder. See
 * packages/core/docs/MATH.md.
 *
 * Under `decimalFormat` the text is the one `parseNumber` reads back
 * under the same record: `formatNumber(1234.5, { decimalFormat: nlFormat,
 * group: true })` is `'1.234,5'`. Grouping falls every three digits
 * (a language's minimum grouping digits are not applied: Spanish 1234
 * groups as `'1.234'`, which still reads back as 1234). A price with a
 * currency sign in a fixed place is a picture, `'€ #.##0,00'`, for
 * `$format-number` of `@jarenjs/json`, under the same record.
 * @param {number} value
 * @param {FormatOptions} [opts]
 * @returns {string}
 * @throws {TypeError} when `decimalFormat` is not a record that reads one way
 */
export function formatNumber(value, opts = {}) {
  const chars = opts.decimalFormat === undefined ? undefined : readNumberCharacters(opts.decimalFormat);
  value = +value;
  if (Number.isNaN(value)) return chars ? chars.nan : 'NaN';
  if (value === Infinity) return chars ? chars.infinity : '∞';
  if (value === -Infinity) return chars ? chars.minus + chars.infinity : '-∞';

  const notation = opts.notation ?? 'auto';
  const sep = opts.group === true ? (chars ? chars.group : ',') : (typeof opts.group === 'string' ? opts.group : '');
  const decimal = opts.decimal ?? (chars ? chars.decimal : '.');

  // Radix output: integer word in the requested base.
  if (opts.radix !== undefined && opts.radix !== 10) {
    let str = toBase(Math.trunc(value), opts.radix, { upper: true });
    if (sep) str = groupInteger(str, sep);
    return str;
  }

  let out;
  if (notation === 'fixed') {
    out = value.toFixed(opts.precision ?? 2);
  }
  else if (notation === 'sci') {
    out = value.toExponential(opts.precision ?? undefined);
  }
  else if (notation === 'eng') {
    out = toEngineering(value, opts.precision ?? 3);
  }
  else {
    // auto: plain decimal for human-scale magnitudes, else scientific.
    const abs = Math.abs(value);
    if (value !== 0 && (abs >= 1e21 || abs < 1e-6)) {
      out = opts.precision !== undefined ? value.toExponential(opts.precision) : value.toExponential();
    }
    else if (opts.precision !== undefined) {
      out = String(Number(value.toPrecision(opts.precision)));
    }
    else {
      out = String(value);
    }
  }

  if (sep || decimal !== '.' || chars) {
    const eIdx = out.search(/[eE]/);
    let exp = eIdx >= 0 ? out.slice(eIdx) : '';
    const mant = eIdx >= 0 ? out.slice(0, eIdx) : out;
    const dot = mant.indexOf('.');
    let intPart = dot >= 0 ? mant.slice(0, dot) : mant;
    let frac = dot >= 0 ? mant.slice(dot + 1) : '';
    if (sep) intPart = groupInteger(intPart, sep);
    if (chars) {
      intPart = toFamily(intPart.startsWith('-') ? chars.minus + intPart.slice(1) : intPart, chars.zero);
      frac = toFamily(frac, chars.zero);
      if (exp) exp = chars.exponent + (exp[1] === '-' ? chars.minus : exp[1] === '+' ? '+' : '')
        + toFamily(exp.replace(/^[eE][+-]?/, ''), chars.zero);
    }
    out = intPart + (frac ? decimal + frac : '') + exp;
  }
  return out;
}

/**
 * Parse a numeric string, radix-aware. Recognizes `0x`/`0o`/`0b`
 * prefixes, an explicit `radix` option, grouping separators (`,`/`_`/
 * space) and base-10 scientific notation. Returns `NaN` on failure
 * rather than throwing.
 *
 * Without `decimalFormat` the text is read as English: `.` is the decimal
 * point and every `,`, `_` and space is dropped as grouping wherever it
 * stands, so decimal-comma text misreads — `'3,45'` is 345, `'1.234,5'`
 * is 1.2345, `'1,23'` is 123. Pass the language's decimal format to read
 * its text instead.
 *
 * With `decimalFormat` (a record such as
 * `compileNumberLocale(pack).decimalFormat`) a base-10 text has one
 * reading: an optional `+` or minus sign (the record's, `-` or `−`), an
 * integer part written either without grouping or with the record's
 * grouping separator before every three digits after a leading group of
 * one to three that does not start with zero, an optional fraction after
 * the record's decimal separator,
 * and an optional exponent (the record's separator, `e` or `E`); digits
 * are ASCII or the record's family. Anything else is `NaN`, never a guess:
 * under Dutch `'1.234,5'` is 1234.5 and `'3,45'` is 3.45, while `'1,2,3'`,
 * `'1.23'`, `'3.45'` and `'0.125'` are `NaN`. The infinity words (the record's, `∞`,
 * `Infinity`) read as infinities; prefixed and `radix` input is read as
 * without the record.
 *
 * @param {string} str
 * @param {{ radix?: number, decimalFormat?: DecimalFormatLike }} [opts]
 * @returns {number}
 * @throws {TypeError} when `decimalFormat` is not a record that reads one
 *   way: separators empty, equal or holding a digit, a zero digit that is
 *   no digit family's zero
 */
export function parseNumber(str, opts = {}) {
  const chars = opts.decimalFormat === undefined ? undefined : readNumberCharacters(opts.decimalFormat);
  if (typeof str !== 'number') str = String(str);
  else return +str;
  let s = str.trim();
  if (s === '') return NaN;
  const lower = s.toLowerCase();
  if (lower === 'nan') return NaN;
  if (lower === '∞' || lower === 'infinity' || lower === '+infinity') return Infinity;
  if (lower === '-∞' || lower === '-infinity') return -Infinity;

  const prefixed = /^[+-]?0[xob]/i.test(s);
  if (prefixed || (opts.radix !== undefined && opts.radix !== 10)) {
    try {
      return Number(fromBase(s, opts.radix ?? 10));
    }
    catch {
      return NaN;
    }
  }
  if (chars) return parseWritten(s, chars);
  // Base 10: strip grouping, keep the numeric grammar.
  const cleaned = s.replace(/[,_ ]/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(cleaned)) return NaN;
  return Number(cleaned);
}
