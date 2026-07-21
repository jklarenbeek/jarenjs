//#region JOSL incremental reader
// JOSL is a superset of TOML 1.0; this machine is both the full parser and
// the streaming reader — `parse()` is literally `feed(text)` + `end()`, so
// there is a single grammar code path.
//
// The design exploits TOML's line orientation. A *logical line* is a
// physical line extended across the newlines that TOML permits inside a
// value (multi-line strings and multi-line arrays). The machine cuts the
// incoming chunk stream into logical lines with a tiny cutter FSM that
// tracks just enough state (string context, escape, bracket depth) to know
// which newlines terminate a line — the cutter never allocates and can
// stop mid-token at any chunk boundary, which is what makes token-by-token
// LLM output feedable. Each completed logical line is then parsed by an
// ordinary recursive-descent value parser, and events are emitted in
// document order (unlike `JSON.parse`'s bottom-up reviver).
//
// JOSL extensions over TOML 1.0 (rejected in `mode: 'toml'`):
//   null            key = null
//   bigint          key = 123n / 0xffn (unsafe plain ints auto-promote)
//   regexp          key = /pattern/flags   (JS literal syntax)
//   root array      [[]] starts/appends an element of a root-level array;
//                   later [table] / [[array]] headers are scoped to the
//                   current root element.

import {
  CC_TAB,
  CC_LF,
  CC_CR,
  CC_SPACE,
  CC_DQUOTE,
  CC_HASH,
  CC_SQUOTE,
  CC_COMMA,
  CC_MINUS,
  CC_DOT,
  CC_SLASH,
  CC_COLON,
  CC_EQ,
  CC_LBRACKET,
  CC_BACKSLASH,
  CC_RBRACKET,
  CC_UNDERSCORE,
  CC_PLUS,
  CC_LBRACE,
  CC_RBRACE,
  CC_DEL,
  isDigitCode,
  isAsciiLetterCode,
} from '@jarenjs/core/scan';

import { JoslSyntaxError } from './errors.js';
import {
  LocalDate,
  LocalTime,
  LocalDateTime,
  isValidDateParts,
  isValidTimeParts,
} from './values.js';
import { setKey, getOwn, countNewlines, columnOf } from './util.js';

function isBareKeyCode(c) {
  return (c >= 0x41 && c <= 0x5A) // A-Z
    || (c >= 0x61 && c <= 0x7A) // a-z
    || isDigitCode(c)
    || c === CC_MINUS
    || c === CC_UNDERSCORE;
}

// Cutter states: which context the chunk scanner is inside.
const S_NONE = 0;
const S_BASIC = 1; // "..."  (single line)
const S_LITERAL = 2; // '...'  (single line)
const S_ML_BASIC = 3; // """..."""
const S_ML_LITERAL = 4; // '''...'''
const S_COMMENT = 5;

// Datetime / number token patterns. Sticky (y) so they match in place at
// the current position without slicing the logical line.
const RE_DATETIME = /(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?/y;
const RE_TIMEONLY = /(\d{2}):(\d{2}):(\d{2})(\.\d+)?/y;
const RE_HEX = /0x[0-9a-fA-F](?:_?[0-9a-fA-F])*(n?)/y;
const RE_OCT = /0o[0-7](?:_?[0-7])*(n?)/y;
const RE_BIN = /0b[01](?:_?[01])*(n?)/y;
const RE_NUM = /[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?(n?)/y;

function stickyExec(re, line, pos) {
  re.lastIndex = pos;
  return re.exec(line);
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const SAFE_MIN = BigInt(Number.MIN_SAFE_INTEGER);
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

export class JoslMachine {
  /**
   * @param {object} [options] - Reader options
   * @param {'josl'|'toml'} [options.mode] - 'toml' rejects JOSL extensions
   * @param {(event: object) => void} [options.onEvent] - Document-order
   *  event sink: {type:'table'|'table-array'|'root-item'|'pair', path, ...}
   */
  constructor(options = {}) {
    this.mode = options.mode === 'toml' ? 'toml' : 'josl';
    this.onEvent = options.onEvent ?? null;
    // chunk cutter state
    this.buf = '';
    this.scanPos = 0;
    this.scanState = S_NONE;
    this.scanDepth = 0;
    this.startLine = 1; // physical line where the current logical line begins
    this.started = false;
    this.ended = false;
    // document state
    this.rootValue = undefined;
    this.rootIsArray = false;
    this.current = null; // current [table] target
    this.currentPath = []; // absolute path of `current` (indices for [[..]])
    this.meta = new WeakMap(); // container flags, see assign/open methods
    // per-logical-line parse context (for error positions)
    this.line = '';
  }

  //#region public surface

  /**
   * Feed the next chunk of source text; chunks may split any token.
   * @param {string} chunk - Next piece of the document
   * @returns {this} The machine, for chaining
   */
  feed(chunk) {
    if (this.ended)
      throw new Error('cannot feed after end()');
    if (!this.started && chunk.length !== 0) {
      this.started = true;
      if (chunk.charCodeAt(0) === 0xFEFF)
        chunk = chunk.slice(1); // strip a leading BOM
    }
    if (chunk.length !== 0) {
      this.buf += chunk;
      this.scan();
    }
    return this;
  }

  /**
   * Finish the document, flushing any pending logical line.
   * @returns {*} The completed root value
   */
  end() {
    if (this.ended)
      return this.root();
    this.ended = true;
    this.scan();
    if (this.buf.length !== 0) {
      // no trailing-\r strip here: a \r not followed by \n is a bare
      // carriage return, which the grammar forbids (consumeLine handles
      // the \r\n case)
      const line = this.buf;
      this.buf = '';
      this.scanPos = 0;
      this.parseLine(line);
    }
    return this.root();
  }

  /**
   * The (possibly still growing) root value: `{}`-rooted for documents,
   * `[]`-rooted after a `[[]]` header. Undefined content yields `{}`.
   * @returns {*} Current root value
   */
  root() {
    if (this.rootValue === undefined)
      this.rootValue = {};
    return this.rootValue;
  }

  //#endregion

  //#region chunk cutter

  // Scan the buffered text for the newlines that terminate logical
  // lines; each completed line goes to parseLine(). Stalls (saves
  // position and exits) when a decision needs lookahead that has not
  // arrived yet — e.g. a quote that may open a triple delimiter. The
  // consumed prefix is compacted once per call, not per line, so whole-
  // document parses stay linear in document size.
  scan() {
    const buf = this.buf;
    let pos = this.scanPos;
    let lineStart = 0;
    let state = this.scanState;
    let depth = this.scanDepth;
    const ended = this.ended;
    outer:
    while (pos < buf.length) {
      const c = buf.charCodeAt(pos);
      switch (state) {
        case S_NONE:
          if (c === CC_LF) {
            if (depth === 0) {
              this.cutLine(buf, lineStart, pos);
              lineStart = pos + 1;
            }
            pos++;
            break;
          }
          if (c === CC_DQUOTE || c === CC_SQUOTE) {
            if (pos + 2 >= buf.length && !ended)
              break outer; // may be a triple delimiter split across chunks
            if (buf.charCodeAt(pos + 1) === c && buf.charCodeAt(pos + 2) === c) {
              state = c === CC_DQUOTE ? S_ML_BASIC : S_ML_LITERAL;
              pos += 3;
            }
            else {
              state = c === CC_DQUOTE ? S_BASIC : S_LITERAL;
              pos++;
            }
            break;
          }
          if (c === CC_HASH) {
            state = S_COMMENT;
            pos++;
            break;
          }
          if (c === CC_LBRACKET)
            depth++;
          else if (c === CC_RBRACKET && depth > 0)
            depth--;
          pos++;
          break;
        case S_COMMENT:
          if (c === CC_LF) {
            if (depth === 0) {
              this.cutLine(buf, lineStart, pos);
              lineStart = pos + 1;
            }
            state = S_NONE;
          }
          pos++;
          break;
        case S_BASIC:
        case S_LITERAL:
          if (c === CC_LF) {
            // unterminated single-line string: the line parser reports it
            state = S_NONE;
            if (depth === 0) {
              this.cutLine(buf, lineStart, pos);
              lineStart = pos + 1;
            }
            pos++;
            break;
          }
          if (state === S_BASIC && c === CC_BACKSLASH) {
            if (pos + 1 >= buf.length && !ended)
              break outer;
            pos += 2;
            break;
          }
          if (c === (state === S_BASIC ? CC_DQUOTE : CC_SQUOTE))
            state = S_NONE;
          pos++;
          break;
        case S_ML_BASIC:
        case S_ML_LITERAL: {
          if (state === S_ML_BASIC && c === CC_BACKSLASH) {
            if (pos + 1 >= buf.length && !ended)
              break outer;
            pos += 2;
            break;
          }
          const q = state === S_ML_BASIC ? CC_DQUOTE : CC_SQUOTE;
          if (c === q) {
            let run = pos;
            while (run < buf.length && buf.charCodeAt(run) === q)
              run++;
            if (run === buf.length && run - pos < 3 && !ended)
              break outer; // quote run may continue in the next chunk
            if (run - pos >= 3)
              state = S_NONE;
            pos = run;
            break;
          }
          pos++;
          break;
        }
      }
    }
    if (lineStart !== 0) {
      this.buf = buf.slice(lineStart);
      this.scanPos = pos - lineStart;
    }
    else
      this.scanPos = pos;
    this.scanState = state;
    this.scanDepth = depth;
  }

  cutLine(buf, start, nlPos) {
    let line = buf.slice(start, nlPos);
    if (line.endsWith('\r'))
      line = line.slice(0, -1);
    const lines = countNewlines(line) + 1;
    if (line.length !== 0)
      this.parseLine(line);
    this.startLine += lines;
  }

  //#endregion

  //#region errors & events

  err(pos, message, hint) {
    const line = this.line;
    throw new JoslSyntaxError(
      message,
      this.startLine + countNewlines(line, Math.min(pos, line.length)),
      columnOf(line, Math.min(pos, line.length)),
      hint);
  }

  emit(event) {
    if (this.onEvent !== null)
      this.onEvent(event);
  }

  //#endregion

  //#region logical line parser

  parseLine(line) {
    this.line = line;
    let pos = this.skipWs(line, 0);
    if (pos >= line.length)
      return;
    const c = line.charCodeAt(pos);
    if (c === CC_HASH) {
      this.checkComment(line, pos);
      return;
    }
    if (c === CC_LBRACKET)
      this.parseHeader(line, pos);
    else
      this.parsePair(line, pos);
  }

  skipWs(line, pos) {
    while (pos < line.length) {
      const c = line.charCodeAt(pos);
      if (c !== CC_SPACE && c !== CC_TAB)
        break;
      pos++;
    }
    return pos;
  }

  // whitespace, newlines and comments — legal between array elements
  skipWsNlComment(line, pos) {
    while (pos < line.length) {
      const c = line.charCodeAt(pos);
      if (c === CC_SPACE || c === CC_TAB || c === CC_LF || c === CC_CR) {
        pos++;
        continue;
      }
      if (c === CC_HASH) {
        pos = this.checkComment(line, pos);
        continue;
      }
      break;
    }
    return pos;
  }

  expectLineEnd(line, pos) {
    pos = this.skipWs(line, pos);
    if (pos < line.length) {
      if (line.charCodeAt(pos) !== CC_HASH)
        this.err(pos, 'unexpected content after expression');
      this.checkComment(line, pos);
    }
  }

  // pos sits on '#'; validates comment content and returns the position
  // of the terminating newline (or end of line)
  checkComment(line, pos) {
    pos++;
    while (pos < line.length) {
      const c = line.charCodeAt(pos);
      if (c === CC_LF)
        return pos;
      if (c === CC_CR && line.charCodeAt(pos + 1) === CC_LF)
        return pos + 1;
      if ((c < 0x20 && c !== CC_TAB) || c === CC_DEL)
        this.err(pos, 'control characters are not allowed in comments');
      pos++;
    }
    return pos;
  }

  //#endregion

  //#region headers

  parseHeader(line, pos) {
    pos++; // consume '['
    if (pos < line.length && line.charCodeAt(pos) === CC_LBRACKET) {
      pos++; // consume second '['
      let p = this.skipWs(line, pos);
      if (p < line.length && line.charCodeAt(p) === CC_RBRACKET
        && p + 1 < line.length && line.charCodeAt(p + 1) === CC_RBRACKET) {
        // [[]] — JOSL root array element
        this.openRootItem(p);
        this.expectLineEnd(line, p + 2);
        return;
      }
      const [keys, after] = this.parseKeys(line, pos);
      p = after;
      if (p + 1 >= line.length
        || line.charCodeAt(p) !== CC_RBRACKET
        || line.charCodeAt(p + 1) !== CC_RBRACKET)
        this.err(p, "expected ']]' to close array-of-tables header");
      this.openArrayTable(keys, p);
      this.expectLineEnd(line, p + 2);
      return;
    }
    const [keys, after] = this.parseKeys(line, pos);
    if (after >= line.length || line.charCodeAt(after) !== CC_RBRACKET)
      this.err(after, "expected ']' to close table header");
    this.openTable(keys, after);
    this.expectLineEnd(line, after + 1);
  }

  headerBase() {
    if (this.rootIsArray)
      return [this.rootValue[this.rootValue.length - 1], [this.rootValue.length - 1]];
    if (this.rootValue === undefined)
      this.rootValue = {};
    return [this.rootValue, []];
  }

  // walk the intermediate keys of a header, creating implicit tables and
  // descending into the last element of arrays-of-tables
  navigate(keys, pos) {
    let [t, path] = this.headerBase();
    for (let i = 0; i < keys.length - 1; ++i) {
      const k = keys[i];
      const ex = getOwn(t, k);
      if (ex === undefined) {
        const nt = {};
        this.meta.set(nt, { implicit: true });
        setKey(t, k, nt);
        t = nt;
        path = path.concat(k);
        continue;
      }
      if (Array.isArray(ex)) {
        const m = this.meta.get(ex);
        if (m === undefined || m.aot !== true)
          this.err(pos, `cannot use static array '${k}' as a table`);
        t = ex[ex.length - 1];
        path = path.concat(k, ex.length - 1);
        continue;
      }
      if (ex !== null && typeof ex === 'object') {
        const m = this.meta.get(ex);
        if (m !== undefined && m.inline === true)
          this.err(pos, `cannot extend inline table '${k}'`);
        // dotted-defined tables may be traversed as intermediates; only
        // opening one as a header's final key is forbidden (spec 1.0)
        t = ex;
        path = path.concat(k);
        continue;
      }
      this.err(pos, `key '${k}' conflicts with an existing value`);
    }
    return [t, path];
  }

  openTable(keys, pos) {
    const [t, path] = this.navigate(keys, pos);
    const k = keys[keys.length - 1];
    const ex = getOwn(t, k);
    if (ex === undefined) {
      const nt = {};
      this.meta.set(nt, { explicit: true });
      setKey(t, k, nt);
      this.current = nt;
    }
    else if (ex !== null && typeof ex === 'object' && !Array.isArray(ex)) {
      const m = this.meta.get(ex);
      if (m === undefined || m.explicit === true || m.inline === true || m.dotted === true)
        this.err(pos, `table '${keys.join('.')}' is already defined`);
      m.explicit = true;
      this.current = ex;
    }
    else
      this.err(pos, `key '${keys.join('.')}' conflicts with an existing value`);
    this.currentPath = path.concat(k);
    this.emit({ type: 'table', path: this.currentPath, line: this.startLine });
  }

  openArrayTable(keys, pos) {
    const [t, path] = this.navigate(keys, pos);
    const k = keys[keys.length - 1];
    let arr = getOwn(t, k);
    if (arr === undefined) {
      arr = [];
      this.meta.set(arr, { aot: true });
      setKey(t, k, arr);
    }
    else if (!Array.isArray(arr) || this.meta.get(arr)?.aot !== true)
      this.err(pos, `key '${keys.join('.')}' is not an array of tables`);
    const el = {};
    arr.push(el);
    this.current = el;
    this.currentPath = path.concat(k, arr.length - 1);
    this.emit({ type: 'table-array', path: this.currentPath, line: this.startLine });
  }

  openRootItem(pos) {
    if (this.mode === 'toml')
      this.err(pos, 'root arrays ([[]]) are a JOSL extension',
        'name the array, e.g. [[items]], for TOML compatibility');
    if (this.rootValue === undefined) {
      this.rootValue = [];
      this.rootIsArray = true;
      this.meta.set(this.rootValue, { aot: true });
    }
    else if (!this.rootIsArray)
      this.err(pos, 'cannot mix a root table and a root array',
        'a document that starts with key-value pairs has an object root');
    const el = {};
    this.rootValue.push(el);
    this.current = el;
    this.currentPath = [this.rootValue.length - 1];
    this.emit({
      type: 'root-item',
      path: this.currentPath,
      index: this.rootValue.length - 1,
      line: this.startLine,
    });
  }

  //#endregion

  //#region key-value pairs

  parsePair(line, pos) {
    if (this.current === null) {
      if (this.rootIsArray)
        this.err(pos, 'expected [[]] before key-value pairs in a root array');
      if (this.rootValue === undefined)
        this.rootValue = {};
      this.current = this.rootValue;
      this.currentPath = [];
    }
    const [keys, afterKeys] = this.parseKeys(line, pos);
    let p = afterKeys;
    if (p >= line.length || line.charCodeAt(p) !== CC_EQ)
      this.err(p, "expected '=' after key", 'a key-value pair looks like: key = value');
    p = this.skipWs(line, p + 1);
    const [value, afterValue] = this.parseValue(line, p);
    this.assignPair(keys, value, pos);
    if (this.onEvent !== null)
      this.emit({
        type: 'pair',
        path: this.currentPath.concat(keys),
        key: keys[keys.length - 1],
        value,
        line: this.startLine,
      });
    this.expectLineEnd(line, afterValue);
  }

  assignPair(keys, value, pos) {
    let t = this.current;
    for (let i = 0; i < keys.length - 1; ++i) {
      const k = keys[i];
      const ex = getOwn(t, k);
      if (ex === undefined) {
        const nt = {};
        this.meta.set(nt, { dotted: true });
        setKey(t, k, nt);
        t = nt;
        continue;
      }
      if (ex !== null && typeof ex === 'object' && !Array.isArray(ex)
        && this.meta.get(ex)?.dotted === true) {
        t = ex;
        continue;
      }
      this.err(pos, `dotted key '${k}' cannot extend a table defined elsewhere`);
    }
    const k = keys[keys.length - 1];
    if (Object.hasOwn(t, k))
      this.err(pos, `duplicate key '${k}'`);
    setKey(t, k, value);
  }

  parseKeys(line, pos) {
    const keys = [];
    for (;;) {
      pos = this.skipWs(line, pos);
      if (pos >= line.length)
        this.err(pos, 'expected a key');
      const c = line.charCodeAt(pos);
      if (c === CC_DQUOTE) {
        const [s, p] = this.parseBasicString(line, pos);
        keys.push(s);
        pos = p;
      }
      else if (c === CC_SQUOTE) {
        const [s, p] = this.parseLiteralString(line, pos);
        keys.push(s);
        pos = p;
      }
      else {
        const start = pos;
        while (pos < line.length && isBareKeyCode(line.charCodeAt(pos)))
          pos++;
        if (pos === start)
          this.err(pos, 'expected a key');
        keys.push(line.slice(start, pos));
      }
      pos = this.skipWs(line, pos);
      if (pos < line.length && line.charCodeAt(pos) === CC_DOT) {
        pos++;
        continue;
      }
      return [keys, pos];
    }
  }

  //#endregion

  //#region values

  parseValue(line, pos) {
    if (pos >= line.length)
      this.err(pos, 'expected a value');
    const c = line.charCodeAt(pos);
    if (c === CC_DQUOTE) {
      if (line.startsWith('"""', pos))
        return this.parseMlBasicString(line, pos);
      return this.parseBasicString(line, pos);
    }
    if (c === CC_SQUOTE) {
      if (line.startsWith("'''", pos))
        return this.parseMlLiteralString(line, pos);
      return this.parseLiteralString(line, pos);
    }
    if (c === CC_LBRACKET)
      return this.parseArray(line, pos);
    if (c === CC_LBRACE)
      return this.parseInlineTable(line, pos);
    if (c === CC_SLASH)
      return this.parseRegExp(line, pos);
    if (c === CC_PLUS || c === CC_MINUS) {
      const d = pos + 1 < line.length ? line.charCodeAt(pos + 1) : -1;
      if (isDigitCode(d))
        return this.parseNumber(line, pos);
      if (isAsciiLetterCode(d))
        return this.parseSignedWord(line, pos);
      this.err(pos, 'expected a number after sign');
    }
    if (isDigitCode(c))
      return this.parseDateTimeOrNumber(line, pos);
    if (isAsciiLetterCode(c))
      return this.parseWord(line, pos);
    this.err(pos, 'invalid value');
  }

  checkValueEnd(line, pos) {
    if (pos >= line.length)
      return pos;
    const c = line.charCodeAt(pos);
    if (c === CC_SPACE || c === CC_TAB || c === CC_LF || c === CC_CR
      || c === CC_COMMA || c === CC_RBRACKET || c === CC_RBRACE || c === CC_HASH)
      return pos;
    this.err(pos, 'unexpected character after value');
  }

  parseWord(line, pos) {
    const start = pos;
    while (pos < line.length && isAsciiLetterCode(line.charCodeAt(pos)))
      pos++;
    const word = line.slice(start, pos);
    switch (word) {
      case 'true': return [true, this.checkValueEnd(line, pos)];
      case 'false': return [false, this.checkValueEnd(line, pos)];
      case 'inf': return [Infinity, this.checkValueEnd(line, pos)];
      case 'nan': return [NaN, this.checkValueEnd(line, pos)];
      case 'null':
        if (this.mode === 'toml')
          this.err(start, 'null is a JOSL extension',
            'TOML has no null; omit the key instead');
        return [null, this.checkValueEnd(line, pos)];
      default:
        this.err(start, `invalid value '${word}'`,
          "strings must be quoted, e.g. key = \"value\"");
    }
  }

  parseSignedWord(line, pos) {
    const neg = line.charCodeAt(pos) === CC_MINUS;
    let p = pos + 1;
    const start = p;
    while (p < line.length && isAsciiLetterCode(line.charCodeAt(p)))
      p++;
    const word = line.slice(start, p);
    if (word === 'inf')
      return [neg ? -Infinity : Infinity, this.checkValueEnd(line, p)];
    if (word === 'nan')
      return [NaN, this.checkValueEnd(line, p)];
    this.err(pos, `invalid value '${line.slice(pos, p)}'`);
  }

  //#endregion

  //#region strings

  decodeEscape(line, pos) {
    // pos sits on the backslash; returns [decoded, nextPos]
    if (pos + 1 >= line.length)
      this.err(pos, 'unterminated escape sequence');
    const c = line.charCodeAt(pos + 1);
    switch (c) {
      case 0x62: return ['\b', pos + 2];
      case 0x74: return ['\t', pos + 2];
      case 0x6E: return ['\n', pos + 2];
      case 0x66: return ['\f', pos + 2];
      case 0x72: return ['\r', pos + 2];
      case CC_DQUOTE: return ['"', pos + 2];
      case CC_BACKSLASH: return ['\\', pos + 2];
      case 0x75: return this.decodeUnicodeEscape(line, pos, 4);
      case 0x55: return this.decodeUnicodeEscape(line, pos, 8);
      default:
        this.err(pos, `invalid escape '\\${line[pos + 1]}'`,
          'valid escapes are \\b \\t \\n \\f \\r \\" \\\\ \\uXXXX \\UXXXXXXXX');
    }
  }

  decodeUnicodeEscape(line, pos, width) {
    const hex = line.slice(pos + 2, pos + 2 + width);
    if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex))
      this.err(pos, `expected ${width} hex digits after '\\${line[pos + 1]}'`);
    const cp = parseInt(hex, 16);
    if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF))
      this.err(pos, `invalid unicode code point '\\${line[pos + 1]}${hex}'`);
    return [String.fromCodePoint(cp), pos + 2 + width];
  }

  checkStringChar(line, pos, multiline) {
    const c = line.charCodeAt(pos);
    if (c === CC_TAB)
      return;
    if (multiline && c === CC_LF)
      return;
    if (multiline && c === CC_CR && line.charCodeAt(pos + 1) === CC_LF)
      return;
    if (c < 0x20 || c === CC_DEL)
      this.err(pos, 'control characters must be escaped in strings');
  }

  parseBasicString(line, pos) {
    pos++; // consume '"'
    let out = '';
    let chunk = pos;
    while (pos < line.length) {
      const c = line.charCodeAt(pos);
      if (c === CC_DQUOTE)
        return [out + line.slice(chunk, pos), pos + 1];
      if (c === CC_BACKSLASH) {
        out += line.slice(chunk, pos);
        const [dec, p] = this.decodeEscape(line, pos);
        out += dec;
        pos = p;
        chunk = pos;
        continue;
      }
      if (c === CC_LF)
        break;
      this.checkStringChar(line, pos, false);
      pos++;
    }
    this.err(pos, 'unterminated string', "close the string with '\"'");
  }

  parseLiteralString(line, pos) {
    pos++; // consume "'"
    const start = pos;
    while (pos < line.length) {
      const c = line.charCodeAt(pos);
      if (c === CC_SQUOTE)
        return [line.slice(start, pos), pos + 1];
      if (c === CC_LF)
        break;
      this.checkStringChar(line, pos, false);
      pos++;
    }
    this.err(pos, 'unterminated string', "close the string with \"'\"");
  }

  parseMlBasicString(line, pos) {
    pos += 3; // consume '"""'
    if (line.charCodeAt(pos) === CC_CR && line.charCodeAt(pos + 1) === CC_LF)
      pos += 2;
    else if (line.charCodeAt(pos) === CC_LF)
      pos++;
    let out = '';
    let chunk = pos;
    while (pos < line.length) {
      const c = line.charCodeAt(pos);
      if (c === CC_DQUOTE) {
        let run = pos;
        while (run < line.length && line.charCodeAt(run) === CC_DQUOTE)
          run++;
        const n = run - pos;
        if (n >= 3) {
          if (n > 5)
            this.err(pos, 'too many quotes closing a multi-line string');
          return [out + line.slice(chunk, pos) + '"'.repeat(n - 3), run];
        }
        pos = run;
        continue;
      }
      if (c === CC_BACKSLASH) {
        // line-ending backslash: trim whitespace up to and beyond the newline
        let p = pos + 1;
        while (p < line.length) {
          const w = line.charCodeAt(p);
          if (w === CC_SPACE || w === CC_TAB || w === CC_CR) {
            p++;
            continue;
          }
          break;
        }
        if (p < line.length && line.charCodeAt(p) === CC_LF) {
          out += line.slice(chunk, pos);
          while (p < line.length) {
            const w = line.charCodeAt(p);
            if (w === CC_SPACE || w === CC_TAB || w === CC_CR || w === CC_LF) {
              p++;
              continue;
            }
            break;
          }
          pos = p;
          chunk = pos;
          continue;
        }
        out += line.slice(chunk, pos);
        const [dec, np] = this.decodeEscape(line, pos);
        out += dec;
        pos = np;
        chunk = pos;
        continue;
      }
      this.checkStringChar(line, pos, true);
      pos++;
    }
    this.err(pos, 'unterminated multi-line string', "close the string with '\"\"\"'");
  }

  parseMlLiteralString(line, pos) {
    pos += 3; // consume "'''"
    if (line.charCodeAt(pos) === CC_CR && line.charCodeAt(pos + 1) === CC_LF)
      pos += 2;
    else if (line.charCodeAt(pos) === CC_LF)
      pos++;
    const start = pos;
    while (pos < line.length) {
      const c = line.charCodeAt(pos);
      if (c === CC_SQUOTE) {
        let run = pos;
        while (run < line.length && line.charCodeAt(run) === CC_SQUOTE)
          run++;
        const n = run - pos;
        if (n >= 3) {
          if (n > 5)
            this.err(pos, 'too many quotes closing a multi-line string');
          return [line.slice(start, pos) + "'".repeat(n - 3), run];
        }
        pos = run;
        continue;
      }
      this.checkStringChar(line, pos, true);
      pos++;
    }
    this.err(pos, 'unterminated multi-line string', "close the string with \"'''\"");
  }

  //#endregion

  //#region containers

  parseArray(line, pos) {
    pos++; // consume '['
    const arr = [];
    this.meta.set(arr, { aot: false });
    for (;;) {
      pos = this.skipWsNlComment(line, pos);
      if (pos >= line.length)
        this.err(pos, 'unterminated array', "close the array with ']'");
      if (line.charCodeAt(pos) === CC_RBRACKET)
        return [arr, pos + 1];
      const [v, p] = this.parseValue(line, pos);
      arr.push(v);
      pos = this.skipWsNlComment(line, p);
      if (pos >= line.length)
        this.err(pos, 'unterminated array', "close the array with ']'");
      const c = line.charCodeAt(pos);
      if (c === CC_COMMA) {
        pos++;
        continue;
      }
      if (c === CC_RBRACKET)
        return [arr, pos + 1];
      this.err(pos, "expected ',' or ']' in array");
    }
  }

  parseInlineTable(line, pos) {
    pos++; // consume '{'
    const obj = {};
    this.meta.set(obj, { inline: true });
    pos = this.skipWs(line, pos);
    if (pos < line.length && line.charCodeAt(pos) === CC_RBRACE)
      return [obj, pos + 1];
    for (;;) {
      if (pos < line.length && line.charCodeAt(pos) === CC_LF)
        this.err(pos, 'newlines are not allowed inside inline tables',
          'use a [table] section for multi-line tables');
      const [keys, afterKeys] = this.parseKeys(line, pos);
      let p = afterKeys;
      if (p >= line.length || line.charCodeAt(p) !== CC_EQ)
        this.err(p, "expected '=' after key in inline table");
      p = this.skipWs(line, p + 1);
      const [v, afterValue] = this.parseValue(line, p);
      this.assignInline(obj, keys, v, pos);
      pos = this.skipWs(line, afterValue);
      if (pos >= line.length)
        this.err(pos, 'unterminated inline table', "close the table with '}'");
      const c = line.charCodeAt(pos);
      if (c === CC_RBRACE)
        return [obj, pos + 1];
      if (c === CC_COMMA) {
        pos = this.skipWs(line, pos + 1);
        continue;
      }
      this.err(pos, "expected ',' or '}' in inline table");
    }
  }

  assignInline(obj, keys, value, pos) {
    let t = obj;
    for (let i = 0; i < keys.length - 1; ++i) {
      const k = keys[i];
      const ex = getOwn(t, k);
      if (ex === undefined) {
        const nt = {};
        this.meta.set(nt, { inline: true, dotted: true });
        setKey(t, k, nt);
        t = nt;
        continue;
      }
      if (ex !== null && typeof ex === 'object' && !Array.isArray(ex)
        && this.meta.get(ex)?.dotted === true) {
        t = ex;
        continue;
      }
      this.err(pos, `dotted key '${k}' conflicts with an existing value`);
    }
    const k = keys[keys.length - 1];
    if (Object.hasOwn(t, k))
      this.err(pos, `duplicate key '${k}'`);
    setKey(t, k, value);
  }

  //#endregion

  //#region regexp, datetimes & numbers

  parseRegExp(line, pos) {
    if (this.mode === 'toml')
      this.err(pos, 'regexp literals are a JOSL extension',
      'quote the pattern as a string for TOML compatibility');
    const start = pos;
    pos++; // consume '/'
    let inClass = false;
    for (;;) {
      if (pos >= line.length || line.charCodeAt(pos) === CC_LF)
        this.err(start, 'unterminated regexp literal', "close the regexp with '/'");
      const c = line.charCodeAt(pos);
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
    const body = line.slice(start + 1, pos);
    pos++; // consume '/'
    const flagStart = pos;
    while (pos < line.length && isAsciiLetterCode(line.charCodeAt(pos)))
      pos++;
    const flags = line.slice(flagStart, pos);
    try {
      return [new RegExp(body, flags), this.checkValueEnd(line, pos)];
    }
    catch (e) {
      this.err(start, `invalid regexp literal: ${e.message}`);
    }
  }

  parseDateTimeOrNumber(line, pos) {
    // a datetime needs ':' at pos+2 (time) or '-' at pos+4 (date);
    // everything else goes straight to the number path
    if (line.charCodeAt(pos + 2) !== CC_COLON && line.charCodeAt(pos + 4) !== CC_MINUS)
      return this.parseNumber(line, pos);
    let m = stickyExec(RE_DATETIME, line, pos);
    if (m !== null) {
      const year = Number(m[1]);
      const month = Number(m[2]);
      const day = Number(m[3]);
      if (!isValidDateParts(year, month, day))
        this.err(pos, `invalid date '${m[0]}'`);
      const date = new LocalDate(year, month, day);
      if (m[4] === undefined)
        return [date, this.checkValueEnd(line, pos + m[0].length)];
      const hour = Number(m[4]);
      const minute = Number(m[5]);
      const second = Number(m[6]);
      if (!isValidTimeParts(hour, minute, second))
        this.err(pos, `invalid time '${m[0]}'`);
      const time = new LocalTime(hour, minute, second, m[7] ?? '');
      const end = this.checkValueEnd(line, pos + m[0].length);
      if (m[8] === undefined)
        return [new LocalDateTime(date, time), end];
      const offset = m[8] === 'z' || m[8] === 'Z' ? 'Z' : m[8];
      const instant = new Date(`${date.toString()}T${time.toString()}${offset}`);
      if (Number.isNaN(instant.getTime()))
        this.err(pos, `invalid date-time '${m[0]}'`);
      return [instant, end];
    }
    m = stickyExec(RE_TIMEONLY, line, pos);
    if (m !== null) {
      const hour = Number(m[1]);
      const minute = Number(m[2]);
      const second = Number(m[3]);
      if (!isValidTimeParts(hour, minute, second))
        this.err(pos, `invalid time '${m[0]}'`);
      return [
        new LocalTime(hour, minute, second, m[4] ?? ''),
        this.checkValueEnd(line, pos + m[0].length),
      ];
    }
    return this.parseNumber(line, pos);
  }

  bigIntCheck(pos, suffix) {
    if (suffix === 'n' && this.mode === 'toml')
      this.err(pos, 'bigint literals are a JOSL extension',
        'drop the n suffix for TOML compatibility');
    return suffix === 'n';
  }

  // Integers parse exactly via BigInt, then downgrade to Number when safe.
  // Strict TOML mode enforces the spec's signed 64-bit range ("should be
  // accepted and handled losslessly"); JOSL mode has no range limit.
  // Tokens of 15 digits or fewer are always safe, so the common case
  // never touches BigInt.
  intValue(pos, source, big, m0) {
    if (!big && source.length <= (source.charCodeAt(0) === CC_MINUS ? 16 : 15))
      return Number(source);
    const value = BigInt(source);
    if (this.mode === 'toml' && (value < INT64_MIN || value > INT64_MAX))
      this.err(pos, `integer '${m0}' exceeds the TOML 64-bit integer range`);
    if (big)
      return value;
    return value >= SAFE_MIN && value <= SAFE_MAX ? Number(value) : value;
  }

  parseNumber(line, pos) {
    let m = stickyExec(RE_HEX, line, pos)
      ?? stickyExec(RE_OCT, line, pos)
      ?? stickyExec(RE_BIN, line, pos);
    if (m !== null) {
      const big = this.bigIntCheck(pos, m[1]);
      const stripped = (big ? m[0].slice(0, -1) : m[0]).replace(/_/g, '');
      const end = this.checkValueEnd(line, pos + m[0].length);
      return [this.intValue(pos, stripped, big, m[0]), end];
    }
    m = stickyExec(RE_NUM, line, pos);
    if (m === null)
      this.err(pos, 'invalid number');
    const big = this.bigIntCheck(pos, m[1]);
    const token = big ? m[0].slice(0, -1) : m[0];
    const isFloat = /[.eE]/.test(token);
    const end = this.checkValueEnd(line, pos + m[0].length);
    if (isFloat) {
      if (big)
        this.err(pos, 'bigint literals cannot have a fraction or exponent');
      return [Number(token.replace(/_/g, '')), end];
    }
    return [this.intValue(pos, token.replace(/[_+]/g, ''), big, m[0]), end];
  }

  //#endregion
}

//#endregion
