//#region JSONX scalar decoders
// Pure, position-based scalar decoders shared by the full-text parser
// (jsonx.js) and the incremental reader (jsonx-stream.js). Every function
// takes the source text plus an offset and reports errors through an
// `err(pos, message, hint)` callback that must throw; none of them keep
// state, so both parsers decode every scalar through a single code path.
//
// The `checkEnd(pos)` callback lets the caller assert that the character
// after a match is a legal value terminator *at the same point in the
// grammar* where the full-text parser checks it — error ordering between
// 'unexpected character after value' and the value-specific validations
// is part of the observable behavior and must match in both parsers.

import {
  CC_LF,
  CC_MINUS,
  CC_PLUS,
  CC_SLASH,
  CC_COMMA,
  CC_SPACE,
  CC_TAB,
  CC_CR,
  CC_DQUOTE,
  CC_BACKSLASH,
  CC_LBRACKET,
  CC_RBRACKET,
  CC_RBRACE,
  isAsciiLetterCode,
} from '@jarenjs/core/scan';

import {
  LocalDate,
  LocalTime,
  LocalDateTime,
  isValidDateParts,
  isValidTimeParts,
} from './values.js';

// Sticky (y) so they match in place at the current position without
// slicing the source text.
const RE_DATETIME = /(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?/y;
const RE_TIMEONLY = /(\d{2}):(\d{2}):(\d{2})(\.\d+)?/y;
const RE_NUM_JSON = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const RE_NUM_JSONX = /[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?(n?)/y;

function stickyExec(re, text, pos) {
  re.lastIndex = pos;
  return re.exec(text);
}

/**
 * @callback JsonxErrCallback
 * @param {number} pos - Offset of the error in the source text
 * @param {string} message - What is wrong
 * @param {string} [hint] - Repair suggestion
 * @returns {never} Must throw
 */

/**
 * @callback JsonxCheckEndCallback
 * @param {number} pos - Offset of the first character after the value
 * @returns {void} Must throw when the character cannot follow a value
 */

/**
 * Whether a char code may legally follow a completed JSON/JSONX value
 * (whitespace, `,`, `]` or `}`).
 * @param {number} c - The char code
 * @returns {boolean}
 */
export function isValueEndCode(c) {
  return c === CC_SPACE || c === CC_TAB || c === CC_LF || c === CC_CR
    || c === CC_COMMA || c === CC_RBRACKET || c === CC_RBRACE;
}

/**
 * Decode one escape sequence.
 * @param {string} text - Source text
 * @param {number} pos - Offset of the backslash
 * @param {JsonxErrCallback} err - Error reporter
 * @returns {[string, number]} The decoded text and the offset after it
 */
export function decodeEscape(text, pos, err) {
  if (pos + 1 >= text.length)
    err(pos, 'unterminated escape sequence');
  const c = text.charCodeAt(pos + 1);
  switch (c) {
    case CC_DQUOTE: return ['"', pos + 2];
    case CC_BACKSLASH: return ['\\', pos + 2];
    case CC_SLASH: return ['/', pos + 2];
    case 0x62: return ['\b', pos + 2];
    case 0x66: return ['\f', pos + 2];
    case 0x6E: return ['\n', pos + 2];
    case 0x72: return ['\r', pos + 2];
    case 0x74: return ['\t', pos + 2];
    case 0x75: {
      const hex = text.slice(pos + 2, pos + 6);
      if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex))
        err(pos, "expected 4 hex digits after '\\u'");
      return [String.fromCharCode(parseInt(hex, 16)), pos + 6];
    }
    default:
      err(pos, `invalid escape '\\${text[pos + 1]}'`);
  }
}

/**
 * Decode a double-quoted string.
 * @param {string} text - Source text
 * @param {number} pos - Offset of the opening quote
 * @param {JsonxErrCallback} err - Error reporter
 * @returns {[string, number]} The value and the offset after the close quote
 */
export function decodeString(text, pos, err) {
  const [out, p] = decodeStringSpan(text, pos + 1, text.length, err, false);
  if (p < text.length) // stopped on the closing quote
    return [out, p + 1];
  err(p, 'unterminated string', "close the string with '\"'");
}

/**
 * Decode the body of a string between two offsets, stopping at the closing
 * quote (which it does not consume) or at `stop`. In `partial` mode it also
 * stops before an escape that is not complete within the span, so a
 * still-arriving string can be decoded as far as it is safe to.
 * @param {string} text - Source text
 * @param {number} from - Offset of the first body character
 * @param {number} stop - Exclusive end offset
 * @param {JsonxErrCallback} err - Error reporter
 * @param {boolean} partial - Whether the span may end mid-escape
 * @returns {[string, number]} The decoded text and the offset reached
 */
export function decodeStringSpan(text, from, stop, err, partial) {
  let p = from;
  let out = '';
  let chunk = p;
  while (p < stop) {
    const c = text.charCodeAt(p);
    if (c === CC_DQUOTE)
      break;
    if (c === CC_BACKSLASH) {
      // the longest escape is \uXXXX; anything shorter than that near the
      // span's end may simply not have arrived yet
      if (partial && p + (text.charCodeAt(p + 1) === 0x75 ? 6 : 2) > stop)
        break;
      out += text.slice(chunk, p);
      const [dec, np] = decodeEscape(text, p, err);
      out += dec;
      p = np;
      chunk = p;
      continue;
    }
    if (c < 0x20)
      err(p, 'control characters must be escaped in strings');
    p++;
  }
  return [out + text.slice(chunk, p), p];
}

/**
 * Try to match an RFC 3339 datetime token (date, time, local or offset
 * date-time; `T`, `t` or a single space may separate date and time).
 * @param {string} text - Source text
 * @param {number} pos - Offset of the first digit
 * @param {JsonxErrCallback} err - Error reporter
 * @param {JsonxCheckEndCallback} checkEnd - Value-terminator check
 * @returns {[*, number]|null} The value and end offset, or null if the
 *  text at `pos` is not a datetime
 */
export function matchDateTime(text, pos, err, checkEnd) {
  let m = stickyExec(RE_DATETIME, text, pos);
  if (m !== null) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (!isValidDateParts(year, month, day))
      err(pos, `invalid date '${m[0]}'`);
    const date = new LocalDate(year, month, day);
    const end = pos + m[0].length;
    checkEnd(end);
    if (m[4] === undefined)
      return [date, end];
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const second = Number(m[6]);
    if (!isValidTimeParts(hour, minute, second))
      err(end, `invalid time '${m[0]}'`);
    const time = new LocalTime(hour, minute, second, m[7] ?? '');
    if (m[8] === undefined)
      return [new LocalDateTime(date, time), end];
    const offset = m[8] === 'z' || m[8] === 'Z' ? 'Z' : m[8];
    const instant = new Date(`${date.toString()}T${time.toString()}${offset}`);
    if (Number.isNaN(instant.getTime()))
      err(end, `invalid date-time '${m[0]}'`);
    return [instant, end];
  }
  m = stickyExec(RE_TIMEONLY, text, pos);
  if (m !== null) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    const second = Number(m[3]);
    if (!isValidTimeParts(hour, minute, second))
      err(pos, `invalid time '${m[0]}'`);
    const end = pos + m[0].length;
    checkEnd(end);
    return [new LocalTime(hour, minute, second, m[4] ?? ''), end];
  }
  return null;
}

/**
 * Match a number token. Strict JSON follows RFC 8259; JSONX adds a
 * leading `+`, `_` separators, an `n` bigint suffix, and auto-promotes
 * unsafe integers to BigInt.
 * @param {string} text - Source text
 * @param {number} pos - Offset of the first sign or digit
 * @param {'jsonx'|'json'} mode - Dialect
 * @param {JsonxErrCallback} err - Error reporter
 * @param {JsonxCheckEndCallback} checkEnd - Value-terminator check
 * @returns {[number|bigint, number]} The value and end offset
 */
export function matchNumber(text, pos, mode, err, checkEnd) {
  const m = stickyExec(mode === 'json' ? RE_NUM_JSON : RE_NUM_JSONX, text, pos);
  if (m === null || m[0].length === 0)
    err(pos, 'invalid number');
  const end = pos + m[0].length;
  checkEnd(end);
  if (mode === 'json')
    return [Number(m[0]), end];
  const big = m[1] === 'n';
  const token = big ? m[0].slice(0, -1) : m[0];
  const isFloat = /[.eE]/.test(token);
  if (isFloat) {
    if (big)
      err(pos, 'bigint literals cannot have a fraction or exponent');
    return [Number(token.replace(/_/g, '')), end];
  }
  const stripped = token.replace(/[_+]/g, '');
  if (big)
    return [BigInt(stripped), end];
  const value = Number(stripped);
  return [Number.isSafeInteger(value) ? value : BigInt(stripped), end];
}

/**
 * Match a word token (`true`, `false`, `null`, and in JSONX the
 * optionally signed non-finite spellings `inf`/`Infinity`/`nan`/`NaN`).
 * The caller performs the value-terminator check.
 * @param {string} text - Source text
 * @param {number} pos - Offset of the first sign or letter
 * @param {'jsonx'|'json'} mode - Dialect
 * @param {JsonxErrCallback} err - Error reporter
 * @returns {[boolean|null|number, number]} The value and end offset
 */
export function matchWord(text, pos, mode, err) {
  let p = pos;
  const c0 = text.charCodeAt(p);
  if (c0 === CC_MINUS || c0 === CC_PLUS)
    p++;
  const neg = c0 === CC_MINUS;
  const wordStart = p;
  while (p < text.length && isAsciiLetterCode(text.charCodeAt(p)))
    p++;
  const word = text.slice(wordStart, p);
  const signed = wordStart !== pos;
  switch (word) {
    case 'true':
      if (signed)
        break;
      return [true, p];
    case 'false':
      if (signed)
        break;
      return [false, p];
    case 'null':
      if (signed)
        break;
      return [null, p];
    case 'inf':
    case 'Infinity':
      if (mode === 'json')
        err(pos, `'${word}' is a JSONX extension`, 'JSON cannot represent non-finite numbers');
      return [neg ? -Infinity : Infinity, p];
    case 'nan':
    case 'NaN':
      if (mode === 'json')
        err(pos, `'${word}' is a JSONX extension`, 'JSON cannot represent non-finite numbers');
      return [NaN, p];
  }
  err(pos, `invalid value '${text.slice(pos, p)}'`);
}

/**
 * Match a regexp literal. The caller performs the value-terminator check.
 * @param {string} text - Source text
 * @param {number} pos - Offset of the opening slash
 * @param {JsonxErrCallback} err - Error reporter
 * @returns {[RegExp, number]} The value and end offset
 */
export function matchRegExp(text, pos, err) {
  let p = pos + 1;
  let inClass = false;
  for (;;) {
    if (p >= text.length || text.charCodeAt(p) === CC_LF)
      err(pos, 'unterminated regexp literal', "close the regexp with '/'");
    const c = text.charCodeAt(p);
    if (c === CC_BACKSLASH) {
      p += 2;
      continue;
    }
    if (c === CC_LBRACKET)
      inClass = true;
    else if (c === CC_RBRACKET)
      inClass = false;
    else if (c === CC_SLASH && !inClass)
      break;
    p++;
  }
  const body = text.slice(pos + 1, p);
  p++;
  const flagStart = p;
  while (p < text.length && isAsciiLetterCode(text.charCodeAt(p)))
    p++;
  const flags = text.slice(flagStart, p);
  try {
    return [new RegExp(body, flags), p];
  }
  catch (e) {
    err(pos, `invalid regexp literal: ${e.message}`);
  }
}

//#endregion
