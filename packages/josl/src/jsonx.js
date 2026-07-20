//#region JSONX
// JSONX is JSON extended with the JOSL first-class citizens:
//
//   null            (JSON already has it)
//   bigint          123n / -9007199254740993n (unsafe ints auto-promote)
//   regexp          /pattern/flags
//   datetimes       bare RFC 3339 tokens: 1979-05-27T07:32:00Z (Date),
//                   1979-05-27T07:32:00 (LocalDateTime), 1979-05-27
//                   (LocalDate), 07:32:00 (LocalTime)
//   non-finite      inf, -inf, nan (also Infinity/NaN, the JS spellings)
//   separators      1_000_000, and a leading + sign
//
// `mode: 'json'` is bit-compatible strict JSON: parsing matches
// `JSON.parse` (minus the reviver) and stringifying delegates to
// `JSON.stringify`. In place of the reviver — which visits leaves
// bottom-up, after the fact, without telling you where you are — the
// parser reports document-order events with absolute paths.

import { JsonxSyntaxError } from './errors.js';
import {
  LocalDate,
  LocalTime,
  LocalDateTime,
  isValidDateParts,
  isValidTimeParts,
} from './values.js';
import { isDigitCode, isAsciiUpperCode, isAsciiLowerCode } from '@jarenjs/core/scan';
import { setKey, countNewlines, columnOf } from './util.js';

const RE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?/;
const RE_TIMEONLY = /^(\d{2}):(\d{2}):(\d{2})(\.\d+)?/;
const RE_NUM_JSON = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const RE_NUM_JSONX = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?(n?)/;

const CC_TAB = 0x09;
const CC_LF = 0x0A;
const CC_CR = 0x0D;
const CC_SPACE = 0x20;
const CC_DQUOTE = 0x22;
const CC_PLUS = 0x2B;
const CC_COMMA = 0x2C;
const CC_MINUS = 0x2D;
const CC_SLASH = 0x2F;
const CC_COLON = 0x3A;
const CC_LBRACKET = 0x5B;
const CC_BACKSLASH = 0x5C;
const CC_RBRACKET = 0x5D;
const CC_LBRACE = 0x7B;
const CC_RBRACE = 0x7D;

const isLetter = (c) => isAsciiUpperCode(c) || isAsciiLowerCode(c);

class JsonxParser {
  constructor(text, options = {}) {
    this.text = text;
    this.pos = 0;
    this.mode = options.mode === 'json' ? 'json' : 'jsonx';
    this.onEvent = options.onEvent ?? null;
    this.path = [];
  }

  err(message, hint, pos = this.pos) {
    throw new JsonxSyntaxError(
      message,
      countNewlines(this.text, pos) + 1,
      columnOf(this.text, pos),
      hint);
  }

  extension(what, hint) {
    if (this.mode === 'json')
      this.err(`${what} is a JSONX extension`, hint);
  }

  emit(type, value) {
    if (this.onEvent !== null)
      this.onEvent(type === 'open'
        ? { type, path: this.path.slice(), kind: value }
        : { type, path: this.path.slice(), value });
  }

  skipWs() {
    const text = this.text;
    while (this.pos < text.length) {
      const c = text.charCodeAt(this.pos);
      if (c !== CC_SPACE && c !== CC_TAB && c !== CC_LF && c !== CC_CR)
        break;
      this.pos++;
    }
  }

  parse() {
    this.skipWs();
    const value = this.parseValue();
    this.skipWs();
    if (this.pos < this.text.length)
      this.err('unexpected trailing characters');
    return value;
  }

  parseValue() {
    if (this.pos >= this.text.length)
      this.err('unexpected end of input');
    const c = this.text.charCodeAt(this.pos);
    if (c === CC_LBRACE)
      return this.parseObject();
    if (c === CC_LBRACKET)
      return this.parseArray();
    if (c === CC_DQUOTE)
      return this.scalar(this.parseString());
    if (c === CC_SLASH) {
      this.extension('a regexp literal', 'quote the pattern as a string');
      return this.scalar(this.parseRegExp());
    }
    if (c === CC_MINUS || c === CC_PLUS) {
      if (c === CC_PLUS)
        this.extension("a leading '+' sign", 'remove the + sign');
      const d = this.pos + 1 < this.text.length ? this.text.charCodeAt(this.pos + 1) : -1;
      if (isLetter(d))
        return this.scalar(this.parseWord());
      return this.scalar(this.parseNumber());
    }
    if (isDigitCode(c)) {
      if (this.mode === 'jsonx') {
        const dt = this.tryDateTime();
        if (dt !== undefined)
          return this.scalar(dt);
      }
      return this.scalar(this.parseNumber());
    }
    if (isLetter(c))
      return this.scalar(this.parseWord());
    this.err('invalid value');
  }

  scalar(value) {
    this.emit('value', value);
    return value;
  }

  checkValueEnd() {
    if (this.pos >= this.text.length)
      return;
    const c = this.text.charCodeAt(this.pos);
    if (c === CC_SPACE || c === CC_TAB || c === CC_LF || c === CC_CR
      || c === CC_COMMA || c === CC_RBRACKET || c === CC_RBRACE)
      return;
    this.err('unexpected character after value');
  }

  parseObject() {
    this.pos++; // consume '{'
    this.emit('open', 'object');
    const obj = {};
    this.skipWs();
    if (this.pos < this.text.length && this.text.charCodeAt(this.pos) === CC_RBRACE) {
      this.pos++;
      this.emit('close', obj);
      return obj;
    }
    for (;;) {
      this.skipWs();
      if (this.pos >= this.text.length || this.text.charCodeAt(this.pos) !== CC_DQUOTE)
        this.err('expected a string key');
      const key = this.parseString();
      this.skipWs();
      if (this.pos >= this.text.length || this.text.charCodeAt(this.pos) !== CC_COLON)
        this.err("expected ':' after key");
      this.pos++;
      this.skipWs();
      this.path.push(key);
      const value = this.parseValue();
      this.path.pop();
      setKey(obj, key, value);
      this.skipWs();
      if (this.pos >= this.text.length)
        this.err('unterminated object', "close the object with '}'");
      const c = this.text.charCodeAt(this.pos);
      if (c === CC_RBRACE) {
        this.pos++;
        this.emit('close', obj);
        return obj;
      }
      if (c === CC_COMMA) {
        this.pos++;
        continue;
      }
      this.err("expected ',' or '}' in object");
    }
  }

  parseArray() {
    this.pos++; // consume '['
    this.emit('open', 'array');
    const arr = [];
    this.skipWs();
    if (this.pos < this.text.length && this.text.charCodeAt(this.pos) === CC_RBRACKET) {
      this.pos++;
      this.emit('close', arr);
      return arr;
    }
    for (;;) {
      this.skipWs();
      this.path.push(arr.length);
      const value = this.parseValue();
      this.path.pop();
      arr.push(value);
      this.skipWs();
      if (this.pos >= this.text.length)
        this.err('unterminated array', "close the array with ']'");
      const c = this.text.charCodeAt(this.pos);
      if (c === CC_RBRACKET) {
        this.pos++;
        this.emit('close', arr);
        return arr;
      }
      if (c === CC_COMMA) {
        this.pos++;
        continue;
      }
      this.err("expected ',' or ']' in array");
    }
  }

  parseString() {
    const text = this.text;
    let pos = this.pos + 1; // consume '"'
    let out = '';
    let chunk = pos;
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      if (c === CC_DQUOTE) {
        this.pos = pos + 1;
        return out + text.slice(chunk, pos);
      }
      if (c === CC_BACKSLASH) {
        out += text.slice(chunk, pos);
        out += this.decodeEscape(pos);
        pos = this.pos;
        chunk = pos;
        continue;
      }
      if (c < 0x20)
        this.err('control characters must be escaped in strings', undefined, pos);
      pos++;
    }
    this.err('unterminated string', "close the string with '\"'", pos);
  }

  decodeEscape(pos) {
    // pos sits on the backslash; sets this.pos past the escape
    const text = this.text;
    if (pos + 1 >= text.length)
      this.err('unterminated escape sequence', undefined, pos);
    const c = text.charCodeAt(pos + 1);
    this.pos = pos + 2;
    switch (c) {
      case CC_DQUOTE: return '"';
      case CC_BACKSLASH: return '\\';
      case CC_SLASH: return '/';
      case 0x62: return '\b';
      case 0x66: return '\f';
      case 0x6E: return '\n';
      case 0x72: return '\r';
      case 0x74: return '\t';
      case 0x75: {
        const hex = text.slice(pos + 2, pos + 6);
        if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex))
          this.err("expected 4 hex digits after '\\u'", undefined, pos);
        this.pos = pos + 6;
        return String.fromCharCode(parseInt(hex, 16));
      }
      default:
        this.err(`invalid escape '\\${text[pos + 1]}'`, undefined, pos);
    }
  }

  parseWord() {
    const text = this.text;
    const start = this.pos;
    let pos = start;
    if (text.charCodeAt(pos) === CC_MINUS || text.charCodeAt(pos) === CC_PLUS)
      pos++;
    const neg = text.charCodeAt(start) === CC_MINUS;
    const wordStart = pos;
    while (pos < text.length && isLetter(text.charCodeAt(pos)))
      pos++;
    const word = text.slice(wordStart, pos);
    const signed = start !== wordStart;
    switch (word) {
      case 'true':
        if (signed)
          break;
        this.pos = pos;
        this.checkValueEnd();
        return true;
      case 'false':
        if (signed)
          break;
        this.pos = pos;
        this.checkValueEnd();
        return false;
      case 'null':
        if (signed)
          break;
        this.pos = pos;
        this.checkValueEnd();
        return null;
      case 'inf':
      case 'Infinity':
        this.extension(`'${word}'`, 'JSON cannot represent non-finite numbers');
        this.pos = pos;
        this.checkValueEnd();
        return neg ? -Infinity : Infinity;
      case 'nan':
      case 'NaN':
        this.extension(`'${word}'`, 'JSON cannot represent non-finite numbers');
        this.pos = pos;
        this.checkValueEnd();
        return NaN;
    }
    this.err(`invalid value '${text.slice(start, pos)}'`, undefined, start);
  }

  tryDateTime() {
    const s = this.text.slice(this.pos);
    let m = RE_DATETIME.exec(s);
    if (m !== null) {
      const year = Number(m[1]);
      const month = Number(m[2]);
      const day = Number(m[3]);
      if (!isValidDateParts(year, month, day))
        this.err(`invalid date '${m[0]}'`);
      const date = new LocalDate(year, month, day);
      this.pos += m[0].length;
      this.checkValueEnd();
      if (m[4] === undefined)
        return date;
      const hour = Number(m[4]);
      const minute = Number(m[5]);
      const second = Number(m[6]);
      if (!isValidTimeParts(hour, minute, second))
        this.err(`invalid time '${m[0]}'`);
      const time = new LocalTime(hour, minute, second, m[7] ?? '');
      if (m[8] === undefined)
        return new LocalDateTime(date, time);
      const offset = m[8] === 'z' || m[8] === 'Z' ? 'Z' : m[8];
      const instant = new Date(`${date.toString()}T${time.toString()}${offset}`);
      if (Number.isNaN(instant.getTime()))
        this.err(`invalid date-time '${m[0]}'`);
      return instant;
    }
    m = RE_TIMEONLY.exec(s);
    if (m !== null) {
      const hour = Number(m[1]);
      const minute = Number(m[2]);
      const second = Number(m[3]);
      if (!isValidTimeParts(hour, minute, second))
        this.err(`invalid time '${m[0]}'`);
      this.pos += m[0].length;
      this.checkValueEnd();
      return new LocalTime(hour, minute, second, m[4] ?? '');
    }
    return undefined;
  }

  parseNumber() {
    const start = this.pos;
    const s = this.text.slice(start);
    const m = (this.mode === 'json' ? RE_NUM_JSON : RE_NUM_JSONX).exec(s);
    if (m === null || m[0].length === 0)
      this.err('invalid number');
    this.pos = start + m[0].length;
    this.checkValueEnd();
    if (this.mode === 'json')
      return Number(m[0]);
    const big = m[1] === 'n';
    const token = big ? m[0].slice(0, -1) : m[0];
    const isFloat = /[.eE]/.test(token);
    if (isFloat) {
      if (big)
        this.err('bigint literals cannot have a fraction or exponent', undefined, start);
      return Number(token.replace(/_/g, ''));
    }
    const stripped = token.replace(/[_+]/g, '');
    if (big)
      return BigInt(stripped);
    const value = Number(stripped);
    return Number.isSafeInteger(value) ? value : BigInt(stripped);
  }

  parseRegExp() {
    const text = this.text;
    const start = this.pos;
    let pos = start + 1; // consume '/'
    let inClass = false;
    for (;;) {
      if (pos >= text.length || text.charCodeAt(pos) === CC_LF)
        this.err('unterminated regexp literal', "close the regexp with '/'", start);
      const c = text.charCodeAt(pos);
      if (c === CC_BACKSLASH) {
        pos += 2;
        continue;
      }
      if (c === CC_LBRACKET)
        inClass = true;
      else if (c === CC_RBRACKET)
        inClass = false;
      else if (c === CC_SLASH && !inClass)
        break;
      pos++;
    }
    const body = text.slice(start + 1, pos);
    pos++; // consume '/'
    const flagStart = pos;
    while (pos < text.length && isLetter(text.charCodeAt(pos)))
      pos++;
    const flags = text.slice(flagStart, pos);
    this.pos = pos;
    this.checkValueEnd();
    try {
      return new RegExp(body, flags);
    }
    catch (e) {
      this.err(`invalid regexp literal: ${e.message}`, undefined, start);
    }
  }
}

/**
 * Parse JSONX (or, with `mode: 'json'`, strict JSON) text.
 * @param {string} text - Source text
 * @param {object} [options] - Parser options
 * @param {'jsonx'|'json'} [options.mode] - 'json' matches JSON.parse
 * @param {(event: object) => void} [options.onEvent] - Document-order
 *  event sink: {type:'open', path, kind}, {type:'value', path, value},
 *  {type:'close', path, value} — paths are absolute (JSON-Pointer-able)
 * @returns {*} The parsed value
 * @throws {JsonxSyntaxError} On invalid input
 */
export function parseJsonx(text, options = undefined) {
  return new JsonxParser(String(text), options ?? {}).parse();
}

function stringifyValue(value, seen, gap, depth) {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (Number.isNaN(value))
        return 'nan';
      if (value === Infinity)
        return 'inf';
      if (value === -Infinity)
        return '-inf';
      return String(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return `${value}n`;
    case 'object':
      break;
    default:
      return undefined; // functions, symbols, undefined
  }
  if (value === null)
    return 'null';
  if (value instanceof Date)
    return value.toISOString();
  if (value instanceof LocalDate || value instanceof LocalTime || value instanceof LocalDateTime)
    return value.toString();
  if (value instanceof RegExp)
    return `/${value.source}/${value.flags}`;
  if (seen.has(value))
    throw new TypeError('Converting circular structure to JSONX');
  seen.add(value);
  const inner = gap === '' ? '' : '\n' + gap.repeat(depth + 1);
  const outer = gap === '' ? '' : '\n' + gap.repeat(depth);
  const sep = gap === '' ? ',' : ',' + inner;
  let out;
  if (Array.isArray(value)) {
    const parts = [];
    for (let i = 0; i < value.length; ++i)
      parts.push(stringifyValue(value[i], seen, gap, depth + 1) ?? 'null');
    out = parts.length === 0 ? '[]' : `[${inner}${parts.join(sep)}${outer}]`;
  }
  else {
    const parts = [];
    for (const [k, v] of Object.entries(value)) {
      const sv = stringifyValue(v, seen, gap, depth + 1);
      if (sv !== undefined)
        parts.push(`${JSON.stringify(k)}:${gap === '' ? '' : ' '}${sv}`);
    }
    out = parts.length === 0 ? '{}' : `{${inner}${parts.join(sep)}${outer}}`;
  }
  seen.delete(value);
  return out;
}

/**
 * Serialize a value to JSONX text. With `mode: 'json'` this delegates to
 * `JSON.stringify` for exact backward compatibility (bigints throw, dates
 * become quoted strings, non-finite numbers become null, ...).
 * @param {*} value - The value to serialize
 * @param {object} [options] - Writer options
 * @param {'jsonx'|'json'} [options.mode] - Output dialect
 * @param {number|string} [options.indent] - Pretty-print indentation
 * @returns {string|undefined} The text, or undefined for undefined input
 */
export function stringifyJsonx(value, options = {}) {
  if (options.mode === 'json')
    return JSON.stringify(value, null, options.indent);
  const indent = options.indent ?? 0;
  const gap = typeof indent === 'string'
    ? indent.slice(0, 10)
    : ' '.repeat(Math.min(10, Math.max(0, Math.trunc(indent))));
  return stringifyValue(value, new Set(), gap, 0);
}

export { JsonxSyntaxError } from './errors.js';
export { LocalDate, LocalTime, LocalDateTime } from './values.js';

//#endregion
