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
  CC_0,
  CC_LOWER_B,
  CC_LOWER_O,
  CC_LOWER_X,
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
import {
  setKey, getOwn, countNewlines, columnOf, RE_DATETIME, RE_TIMEONLY,
} from './util.js';

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

// Runs of characters that cannot end a logical line or change the cutter's
// state. The cutter skips them with the regex engine rather than stepping
// per character, which is what keeps its pass cheap next to the parser's.
// `\n` stays in every stop set so the cutter can count the physical lines a
// logical line spans without a separate walk over it.
// The basic/literal classes serve both the single- and multi-line states:
// a `'` is inert inside a basic string and a `"` inside a literal one.
const RUN_NONE = /[^\n"'#[\]]*/y;
const RUN_BASIC = /[^\n"\\]*/y;
const RUN_LITERAL = /[^\n']*/y;

// Advance past a run of inert characters. `test` on a `*` pattern always
// matches (possibly empty) and, unlike `exec`, allocates no match object.
function skipRun(re, buf, pos) {
  re.lastIndex = pos;
  re.test(buf);
  return re.lastIndex;
}

// Number token patterns; the date-time pair is shared with the JSONX
// scalar reader (util.js). Sticky (y) so they match in place.
const RE_HEX = /0x[0-9a-fA-F](?:_?[0-9a-fA-F])*(n?)/y;
const RE_OCT = /0o[0-7](?:_?[0-7])*(n?)/y;
const RE_BIN = /0b[01](?:_?[01])*(n?)/y;
const RE_NUM = /[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?(n?)/y;

function stickyExec(re, line, pos) {
  re.lastIndex = pos;
  return re.exec(line);
}

// Whether `pos` is a position a value may legally end at. Separate from
// the machine's throwing `checkValueEnd` so the number scanner can test a
// candidate token without committing to it.
function atValueEnd(line, pos) {
  if (pos >= line.length)
    return true;
  const c = line.charCodeAt(pos);
  return c === CC_SPACE || c === CC_TAB || c === CC_LF || c === CC_CR
    || c === CC_COMMA || c === CC_RBRACKET || c === CC_RBRACE || c === CC_HASH;
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
    // Logical-line sink used by the CST layer: reports each line's source
    // span, and the span of a pair's value inside it, so a rewriter can
    // replace a value without disturbing the bytes around it.
    this.onLine = options.onLine ?? null;
    this.lineValueStart = -1;
    this.lineValueEnd = -1;
    // chunk cutter state
    this.buf = '';
    this.scanPos = 0;
    this.scanState = S_NONE;
    this.scanDepth = 0;
    this.scanNl = 0; // newlines seen inside the logical line being cut
    this.startLine = 1; // physical line where the current logical line begins
    // Absolute physical line of `this.line`'s index 0, so error positions
    // read the same whether `this.line` is one cut line or the whole source.
    this.lineOrigin = 1;
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
      this.lineOrigin = this.startLine;
      this.parseLine(line);
    }
    return this.root();
  }

  /**
   * Parse a complete document in one pass. Every value parser already stops
   * at the newlines TOML forbids a construct from crossing, so with the
   * whole text in hand the parser finds each logical line's end itself and
   * the cutter's separate pass over the source is not needed. `feed`/`end`
   * keep the cutter because a chunk can stop mid-token, where only a
   * side-effect-free pre-pass can decide whether a line is complete.
   * @param {string} text - The entire document
   * @returns {*} The completed root value
   */
  parseAll(text) {
    if (this.started || this.ended)
      throw new Error('parseAll cannot be mixed with feed()/end()');
    this.started = true;
    this.ended = true;
    if (text.charCodeAt(0) === 0xFEFF)
      text = text.slice(1);
    // positions are offsets into the whole source, which starts at line 1
    this.lineOrigin = 1;
    const tracking = this.onEvent !== null;
    const len = text.length;
    let pos = 0;
    while (pos < len) {
      this.lineValueStart = -1;
      this.lineValueEnd = -1;
      const end = this.parseLine(text, pos);
      const next = end < len && text.charCodeAt(end) === CC_LF ? end + 1 : end;
      if (this.onLine !== null)
        this.onLine(pos, next, this.lineValueStart, this.lineValueEnd);
      if (tracking) {
        // only events need the logical line's own number; errors derive
        // theirs from lineOrigin and the offset
        let n = this.startLine;
        for (let i = pos; i < next; ++i)
          if (text.charCodeAt(i) === CC_LF)
            n++;
        this.startLine = n;
      }
      pos = next;
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
    let nl = this.scanNl;
    const ended = this.ended;
    outer:
    while (pos < buf.length) {
      switch (state) {
        case S_NONE: {
          pos = skipRun(RUN_NONE, buf, pos);
          if (pos >= buf.length)
            break outer;
          const c = buf.charCodeAt(pos);
          if (c === CC_LF) {
            if (depth === 0) {
              this.cutLine(buf, lineStart, pos, nl);
              lineStart = pos + 1;
              nl = 0;
            }
            else
              nl++;
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
        }
        case S_COMMENT: {
          // nothing but the newline can end a comment, so jump straight to it
          const at = buf.indexOf('\n', pos);
          if (at < 0) {
            pos = buf.length;
            break outer;
          }
          if (depth === 0) {
            this.cutLine(buf, lineStart, at, nl);
            lineStart = at + 1;
            nl = 0;
          }
          else
            nl++;
          state = S_NONE;
          pos = at + 1;
          break;
        }
        case S_BASIC:
        case S_LITERAL: {
          const basic = state === S_BASIC;
          pos = skipRun(basic ? RUN_BASIC : RUN_LITERAL, buf, pos);
          if (pos >= buf.length)
            break outer;
          const c = buf.charCodeAt(pos);
          if (c === CC_LF) {
            // unterminated single-line string: the line parser reports it
            state = S_NONE;
            if (depth === 0) {
              this.cutLine(buf, lineStart, pos, nl);
              lineStart = pos + 1;
              nl = 0;
            }
            else
              nl++;
            pos++;
            break;
          }
          if (basic && c === CC_BACKSLASH) {
            if (pos + 1 >= buf.length && !ended)
              break outer;
            pos += 2;
            break;
          }
          state = S_NONE; // the run only stops on the closing quote
          pos++;
          break;
        }
        case S_ML_BASIC:
        case S_ML_LITERAL: {
          const basic = state === S_ML_BASIC;
          pos = skipRun(basic ? RUN_BASIC : RUN_LITERAL, buf, pos);
          if (pos >= buf.length)
            break outer;
          const c = buf.charCodeAt(pos);
          if (c === CC_LF) {
            nl++; // multi-line strings carry newlines inside the logical line
            pos++;
            break;
          }
          if (basic && c === CC_BACKSLASH) {
            if (pos + 1 >= buf.length && !ended)
              break outer;
            pos += 2;
            break;
          }
          const q = basic ? CC_DQUOTE : CC_SQUOTE;
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
    this.scanNl = nl;
  }

  // `innerNl` is how many newlines the cutter already counted inside this
  // logical line, so the physical-line bookkeeping costs no extra walk.
  cutLine(buf, start, nlPos, innerNl) {
    const end = nlPos > start && buf.charCodeAt(nlPos - 1) === CC_CR
      ? nlPos - 1
      : nlPos;
    if (end > start) {
      this.lineOrigin = this.startLine;
      this.parseLine(buf.slice(start, end));
    }
    this.startLine += innerNl + 1;
  }

  //#endregion

  //#region errors & events

  err(pos, message, hint) {
    const line = this.line;
    throw new JoslSyntaxError(
      message,
      this.lineOrigin + countNewlines(line, Math.min(pos, line.length)),
      columnOf(line, Math.min(pos, line.length)),
      hint);
  }

  emit(event) {
    if (this.onEvent !== null)
      this.onEvent(event);
  }

  //#endregion

  //#region logical line parser

  // Parses one logical line and returns the offset it ended at: the index
  // of the terminating newline, or the end of the text. A cut line carries
  // no terminator, so the newline branches only fire for the whole-document
  // driver, which parses straight out of the source.
  parseLine(line, pos = 0) {
    this.line = line;
    pos = this.skipWs(line, pos);
    if (pos >= line.length)
      return pos;
    const c = line.charCodeAt(pos);
    if (c === CC_LF)
      return pos;
    if (c === CC_CR && line.charCodeAt(pos + 1) === CC_LF)
      return pos + 1;
    if (c === CC_HASH)
      return this.checkComment(line, pos);
    if (c === CC_LBRACKET)
      return this.parseHeader(line, pos);
    return this.parsePair(line, pos);
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

  // Consumes the rest of the logical line and returns the offset it ended
  // at, so the whole-document driver knows where the next one begins.
  expectLineEnd(line, pos) {
    pos = this.skipWs(line, pos);
    if (pos >= line.length)
      return pos;
    const c = line.charCodeAt(pos);
    if (c === CC_LF)
      return pos;
    if (c === CC_CR && line.charCodeAt(pos + 1) === CC_LF)
      return pos + 1;
    if (c !== CC_HASH)
      this.err(pos, 'unexpected content after expression');
    return this.checkComment(line, pos);
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
        return this.expectLineEnd(line, p + 2);
      }
      const [keys, after] = this.parseKeys(line, pos);
      p = after;
      if (p + 1 >= line.length
        || line.charCodeAt(p) !== CC_RBRACKET
        || line.charCodeAt(p + 1) !== CC_RBRACKET)
        this.err(p, "expected ']]' to close array-of-tables header");
      this.openArrayTable(keys, p);
      return this.expectLineEnd(line, p + 2);
    }
    const [keys, after] = this.parseKeys(line, pos);
    if (after >= line.length || line.charCodeAt(after) !== CC_RBRACKET)
      this.err(after, "expected ']' to close table header");
    this.openTable(keys, after);
    return this.expectLineEnd(line, after + 1);
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
    if (this.onLine !== null) {
      this.lineValueStart = p;
      this.lineValueEnd = afterValue;
    }
    this.assignPair(keys, value, pos);
    if (this.onEvent !== null)
      this.emit({
        type: 'pair',
        path: this.currentPath.concat(keys),
        key: keys[keys.length - 1],
        value,
        line: this.startLine,
      });
    return this.expectLineEnd(line, afterValue);
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
    if (atValueEnd(line, pos))
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
    const c0 = line.charCodeAt(pos);
    // Plain decimal integers dominate real documents. A digit run that ends
    // the value cannot hold a radix prefix, an underscore, a fraction or the
    // bigint suffix, so it needs none of the token regexes below. Anything
    // else — including a leading zero, which TOML forbids — falls through so
    // the regexes keep producing the established value and error positions.
    if (isDigitCode(c0)) {
      let p = pos + 1;
      while (p < line.length && isDigitCode(line.charCodeAt(p)))
        p++;
      if ((p - pos === 1 || c0 !== CC_0) && atValueEnd(line, p)) {
        const source = line.slice(pos, p);
        return [this.intValue(pos, source, false, source), p];
      }
    }
    // Radix prefixes are the only tokens those three patterns can match.
    let m = null;
    if (c0 === CC_0) {
      const c1 = line.charCodeAt(pos + 1);
      if (c1 === CC_LOWER_X)
        m = stickyExec(RE_HEX, line, pos);
      else if (c1 === CC_LOWER_O)
        m = stickyExec(RE_OCT, line, pos);
      else if (c1 === CC_LOWER_B)
        m = stickyExec(RE_BIN, line, pos);
    }
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
