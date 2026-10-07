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
//
// Scalar decoding lives in jsonx-scalar.js, shared with the incremental
// reader (jsonx-stream.js), so both parse every value identically.

import { JsonxSyntaxError } from './errors.js';
import { LocalDate, LocalTime, LocalDateTime } from './values.js';
import {
  CC_TAB,
  CC_LF,
  CC_CR,
  CC_SPACE,
  CC_DQUOTE,
  CC_PLUS,
  CC_COMMA,
  CC_MINUS,
  CC_SLASH,
  CC_COLON,
  CC_LBRACKET,
  CC_RBRACKET,
  CC_LBRACE,
  CC_RBRACE,
  isDigitCode,
  isAsciiLetterCode,
} from '@jarenjs/core/scan';
import { columnOf } from './util.js';
import { admitOptions, JSONX_READ, JSONX_WRITE } from './options.js';
import { setObjectMember } from '@jarenjs/core/object';
import { countCharCode } from '@jarenjs/core/string';
import {
  isValueEndCode,
  decodeString,
  matchDateTime,
  matchNumber,
  matchWord,
  matchRegExp,
} from './jsonx-scalar.js';

class JsonxParser {
  constructor(text, options = {}) {
    this.text = text;
    this.pos = 0;
    this.mode = options.mode === 'json' ? 'json' : 'jsonx';
    this.onEvent = options.onEvent ?? null;
    this.path = [];
    this.errCb = (pos, message, hint) => this.err(message, hint, pos);
    this.endCb = (end) => {
      this.pos = end;
      this.checkValueEnd();
    };
  }

  err(message, hint, pos = this.pos) {
    throw new JsonxSyntaxError(
      message,
      countCharCode(this.text, 0x0A, 0, pos) + 1,
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

  /**
   * Parse one value. Containers are walked with an explicit stack of the
   * open ones rather than by recursion, so nesting depth is bounded by
   * memory - as it is for `JSON.parse` - and not by the call stack. While
   * a member's value is parsed, `this.path` ends with that member's key or
   * index: the path holds one entry per open container.
   * @returns {*} The value
   */
  parseValue() {
    const text = this.text;
    const path = this.path;
    const outer = []; // the open containers around `container`, outermost first
    let container = null; // the innermost open container
    let isArray = false;
    for (;;) {
      if (this.pos >= text.length)
        this.err('unexpected end of input');
      const c = text.charCodeAt(this.pos);
      let value;
      if (c === CC_LBRACE || c === CC_LBRACKET) {
        this.pos++; // consume '{' or '['
        const array = c === CC_LBRACKET;
        this.emit('open', array ? 'array' : 'object');
        value = array ? [] : {};
        this.skipWs();
        if (this.pos >= text.length || text.charCodeAt(this.pos) !== (array ? CC_RBRACKET : CC_RBRACE)) {
          if (container !== null)
            outer.push(container);
          container = value;
          isArray = array;
          this.enterMember(container, isArray);
          continue; // parse the value of its first member
        }
        this.pos++; // an empty container is complete at once
        this.emit('close', value);
      }
      else
        value = this.parseScalar(c);
      // `value` is complete: add it to its container, then close every
      // container that ends with it
      for (;;) {
        if (container === null)
          return value;
        const key = path.pop();
        if (isArray)
          container.push(value);
        else
          setObjectMember(container, key, value);
        this.skipWs();
        if (this.pos >= text.length) {
          if (isArray)
            this.err('unterminated array', "close the array with ']'");
          this.err('unterminated object', "close the object with '}'");
        }
        const d = text.charCodeAt(this.pos);
        if (d === CC_COMMA) {
          this.pos++;
          this.enterMember(container, isArray);
          break; // parse the value of the next member
        }
        if (d !== (isArray ? CC_RBRACKET : CC_RBRACE))
          this.err(isArray ? "expected ',' or ']' in array" : "expected ',' or '}' in object");
        this.pos++;
        this.emit('close', container);
        value = container;
        container = outer.length === 0 ? null : outer.pop();
        isArray = Array.isArray(container);
      }
    }
  }

  /**
   * Read up to the value of an open container's next member - for an
   * object its key and the ':' - and put the member's key, or the array
   * element's index, on the path.
   * @param {object|Array} container - The open container
   * @param {boolean} isArray - Whether it is an array
   */
  enterMember(container, isArray) {
    this.skipWs();
    if (isArray) {
      this.path.push(container.length);
      return;
    }
    if (this.pos >= this.text.length || this.text.charCodeAt(this.pos) !== CC_DQUOTE)
      this.err('expected a string key');
    const key = this.parseString();
    this.skipWs();
    if (this.pos >= this.text.length || this.text.charCodeAt(this.pos) !== CC_COLON)
      this.err("expected ':' after key");
    this.pos++;
    this.skipWs();
    this.path.push(key);
  }

  /**
   * Parse the scalar at `this.pos`.
   * @param {number} c - Its first char code
   * @returns {*} The value
   */
  parseScalar(c) {
    if (c === CC_DQUOTE)
      return this.scalar(this.parseString());
    if (c === CC_SLASH) {
      this.extension('a regexp literal', 'quote the pattern as a string');
      const [re, end] = matchRegExp(this.text, this.pos, this.errCb);
      this.pos = end;
      this.checkValueEnd();
      return this.scalar(re);
    }
    if (c === CC_MINUS || c === CC_PLUS) {
      if (c === CC_PLUS)
        this.extension("a leading '+' sign", 'remove the + sign');
      const d = this.pos + 1 < this.text.length ? this.text.charCodeAt(this.pos + 1) : -1;
      if (isAsciiLetterCode(d))
        return this.scalar(this.parseWord());
      return this.scalar(this.parseNumber());
    }
    if (isDigitCode(c)) {
      if (this.mode === 'jsonx') {
        const dt = matchDateTime(this.text, this.pos, this.errCb, this.endCb);
        if (dt !== null)
          return this.scalar(dt[0]);
      }
      return this.scalar(this.parseNumber());
    }
    if (isAsciiLetterCode(c))
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
    if (!isValueEndCode(this.text.charCodeAt(this.pos)))
      this.err('unexpected character after value');
  }

  parseString() {
    const [value, end] = decodeString(this.text, this.pos, this.errCb);
    this.pos = end;
    return value;
  }

  parseWord() {
    const [value, end] = matchWord(this.text, this.pos, this.mode, this.errCb);
    this.pos = end;
    this.checkValueEnd();
    return value;
  }

  parseNumber() {
    return matchNumber(this.text, this.pos, this.mode, this.errCb, this.endCb)[0];
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
 * @throws {TypeError} On an option other than `mode` and `onEvent` - a
 *  `JSONX2xxx` limit is refused by naming the stream reader that enforces
 *  it - or a value of the wrong type
 */
export function parseJsonx(text, options = undefined) {
  return new JsonxParser(String(text), admitOptions(options, JSONX_READ, 'parseJsonx', refuseJsonxOption)).parse();
}

/** The JSONX limits are the stream reader's: `parseJsonx` holds the whole text already. */
const STREAM_LIMITS = Object.freeze(['maxTotalBytes', 'maxTokenBytes', 'maxDepth', 'maxRetainedValues']);

/**
 * The refusal of a member `parseJsonx` does not take: a stream limit names
 * the API that enforces it rather than the nearest member.
 * @param {string} key @param {string} hint @returns {TypeError}
 */
function refuseJsonxOption(key, hint) {
  return STREAM_LIMITS.includes(key)
    ? new TypeError(`parseJsonx: '${key}' is a limit of the JSONX stream reader`
      + ' — read with createJsonxStreamReader or parseJsonxStream to enforce it')
    : new TypeError(`parseJsonx: unknown option '${key}'${hint}`);
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
 * @throws {TypeError} On an option other than `mode` and `indent`, or a
 *  value of the wrong type
 */
export function stringifyJsonx(value, options = {}) {
  options = admitOptions(options, JSONX_WRITE, 'stringifyJsonx');
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
