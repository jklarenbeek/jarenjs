//#region JSONX streaming reader
// Chunk-feedable incremental reader for JSONX and strict JSON, mirroring
// the JOSL reader's API shape (feed/end/root). Chunks may split ANY token
// — escapes mid-`\uXXXX`, numbers, literals (`tru` + `e`), surrogate
// pairs — which is what makes token-by-token LLM output feedable.
//
// Events, in document order (paths are absolute and JSON-Pointer-able:
// strings for object keys, numbers for array indices):
//
//   {type:'object-start', path, line}            - '{' opened
//   {type:'array-start',  path, line}            - '[' opened
//   {type:'pair', path, key, value, line}        - scalar object member,
//                                                  fired on completion
//   {type:'item', path, index, value, line}      - scalar array element,
//                                                  fired on completion
//   {type:'object-end', path, line}              - container completed
//   {type:'array-end',  path, line}
//
// Scalars fire once, on completion (a number is complete only at its
// delimiter; a string at its closing quote). A container value does NOT
// additionally fire `pair`/`item` — its `*-start`/`*-end` events carry
// that. This is deliberately asymmetric with the JOSL reader, where
// inline tables arrive as completed `pair` values and containers have no
// end events: JSON nests, JOSL's line-oriented grammar does not. The
// `pair` event itself is shared verbatim between both readers, so a
// consumer keyed on `pair` paths never branches on syntax.
//
// A document whose root is a single scalar emits no events; the value is
// available from `end()` (and `root()` once complete).
//
// Future hook (not implemented): a `{type:'text-partial'}` event for
// progressive display of long strings as they stream in.

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
  CC_BACKSLASH,
  CC_RBRACKET,
  CC_LBRACE,
  CC_RBRACE,
  isDigitCode,
  isAsciiLetterCode,
} from '@jarenjs/core/scan';

import { JsonxSyntaxError } from './errors.js';
import { setKey } from './util.js';
import {
  isValueEndCode,
  decodeString,
  matchDateTime,
  matchNumber,
  matchWord,
  matchRegExp,
} from './jsonx-scalar.js';

// Machine states: what the next non-whitespace character must be.
const ST_VALUE = 0; // a value (root, after ':', or after ',' in an array)
const ST_ELEM_FIRST = 1; // inside a fresh '[': a value or ']'
const ST_KEY_FIRST = 2; // inside a fresh '{': a key or '}'
const ST_KEY = 3; // after ',' in an object: a key
const ST_COLON = 4; // after a key: ':'
const ST_OBJ_NEXT = 5; // after a member value: ',' or '}'
const ST_ARR_NEXT = 6; // after an element value: ',' or ']'
const ST_DONE = 7; // after the root value: whitespace only

const RE_BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class JsonxMachine {
  /**
   * @param {object} [options] - Reader options
   * @param {'jsonx'|'json'} [options.mode] - 'json' rejects every JSONX
   *  extension (bigint, regexp, datetime, non-finite, separators, +)
   * @param {(event: JsonxStreamEvent) => void} [options.onEvent] - Event sink
   */
  constructor(options = {}) {
    this.mode = options.mode === 'json' ? 'json' : 'jsonx';
    this.onEvent = options.onEvent ?? null;
    this.buf = '';
    this.pos = 0; // consumed up to here; stalls at the pending token start
    this.state = ST_VALUE;
    this.stack = []; // open container frames
    this.path = []; // absolute path of the innermost open container
    this.rootValue = undefined;
    this.ended = false;
    // line/column bookkeeping; newlines only ever occur as whitespace in
    // this grammar (strings and regexps must escape them), so tracking
    // them in the whitespace skipper alone is exact
    this.curLine = 1;
    this.lineStart = 0; // buf offset of the current line start (may go negative after compaction)
    // resumable token-scan state
    this.scanPos = -1; // where the pending token's scan left off
    this.scanInFlags = false; // regexp scan: past the closing '/'
    this.scanInClass = false; // regexp scan: inside [...]
    this.scanDtSpace = false; // scalar scan: crossed a date-time space separator
    this.errCb = (pos, message, hint) => this.errAt(pos, message, hint);
    this.endCb = (pos) => this.checkValueEnd(this.buf, pos);
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
    if (chunk.length !== 0) {
      this.buf += chunk;
      this.pump();
    }
    return this;
  }

  /**
   * Finish the document, flushing any pending token.
   * @returns {*} The completed root value
   * @throws {JsonxSyntaxError} When the document is incomplete or invalid
   */
  end() {
    if (this.ended)
      return this.rootValue;
    this.ended = true;
    this.pump();
    if (this.state !== ST_DONE)
      this.endError();
    return this.rootValue;
  }

  /**
   * The (possibly still growing) root value. Undefined until the root
   * value has started; container members appear as they complete.
   * @returns {*} Current root value
   */
  root() {
    return this.rootValue;
  }

  //#endregion

  //#region errors & events

  errAt(pos, message, hint) {
    throw new JsonxSyntaxError(message, this.curLine, pos - this.lineStart + 1, hint);
  }

  endError() {
    const pos = this.buf.length;
    switch (this.state) {
      case ST_VALUE:
      case ST_ELEM_FIRST:
        this.errAt(pos, 'unexpected end of input');
        break;
      case ST_KEY_FIRST:
      case ST_KEY:
        this.errAt(pos, 'expected a string key');
        break;
      case ST_COLON:
        this.errAt(pos, "expected ':' after key");
        break;
      case ST_OBJ_NEXT:
        this.errAt(pos, 'unterminated object', "close the object with '}'");
        break;
      case ST_ARR_NEXT:
        this.errAt(pos, 'unterminated array', "close the array with ']'");
        break;
    }
  }

  //#endregion

  //#region pump

  // Consume as much of the buffer as possible. Exits when the buffer is
  // exhausted or the pending token needs input that has not arrived yet
  // (this.pos then rests on the token start; the scan* fields remember
  // how far scanning got so nothing is rescanned on the next feed).
  pump() {
    const buf = this.buf;
    let pos = this.pos;
    pumping:
    for (;;) {
      // skip whitespace, tracking physical lines
      while (pos < buf.length) {
        const c = buf.charCodeAt(pos);
        if (c === CC_LF) {
          this.curLine++;
          this.lineStart = pos + 1;
          pos++;
          continue;
        }
        if (c === CC_SPACE || c === CC_TAB || c === CC_CR) {
          pos++;
          continue;
        }
        break;
      }
      this.pos = pos;
      if (pos >= buf.length)
        break;
      const c = buf.charCodeAt(pos);
      switch (this.state) {
        case ST_DONE:
          this.errAt(pos, 'unexpected trailing characters');
          break;
        case ST_KEY_FIRST:
        case ST_KEY: {
          if (this.state === ST_KEY_FIRST && c === CC_RBRACE) {
            this.closeContainer();
            pos++;
            continue;
          }
          if (c !== CC_DQUOTE)
            this.errAt(pos, 'expected a string key');
          const end = this.scanString(buf, pos);
          if (end < 0)
            break pumping;
          this.stack[this.stack.length - 1].key = decodeString(buf, pos, this.errCb)[0];
          this.state = ST_COLON;
          pos = end;
          continue;
        }
        case ST_COLON:
          if (c !== CC_COLON)
            this.errAt(pos, "expected ':' after key");
          this.state = ST_VALUE;
          pos++;
          continue;
        case ST_OBJ_NEXT:
          if (c === CC_RBRACE) {
            this.closeContainer();
            pos++;
            continue;
          }
          if (c === CC_COMMA) {
            this.state = ST_KEY;
            pos++;
            continue;
          }
          this.errAt(pos, "expected ',' or '}' in object");
          break;
        case ST_ARR_NEXT:
          if (c === CC_RBRACKET) {
            this.closeContainer();
            pos++;
            continue;
          }
          if (c === CC_COMMA) {
            this.state = ST_VALUE;
            pos++;
            continue;
          }
          this.errAt(pos, "expected ',' or ']' in array");
          break;
        case ST_ELEM_FIRST:
        case ST_VALUE: {
          if (this.state === ST_ELEM_FIRST && c === CC_RBRACKET) {
            this.closeContainer();
            pos++;
            continue;
          }
          const end = this.parseValueAt(buf, pos, c);
          if (end < 0)
            break pumping;
          pos = end;
          continue;
        }
      }
    }
    this.pos = pos;
    this.compact();
  }

  // Drop the consumed prefix once per pump so the buffer holds only the
  // pending token and unscanned tail.
  compact() {
    const pos = this.pos;
    if (pos === 0)
      return;
    this.buf = pos === this.buf.length ? '' : this.buf.slice(pos);
    this.pos = 0;
    this.lineStart -= pos;
    if (this.scanPos >= 0)
      this.scanPos -= pos;
  }

  //#endregion

  //#region values

  // Parse the value starting at pos; returns the position after it, or
  // -1 when the token is incomplete and more input is needed.
  parseValueAt(buf, pos, c) {
    if (c === CC_LBRACE) {
      this.openContainer(false);
      return pos + 1;
    }
    if (c === CC_LBRACKET) {
      this.openContainer(true);
      return pos + 1;
    }
    if (c === CC_DQUOTE) {
      const end = this.scanString(buf, pos);
      if (end < 0)
        return -1;
      this.completeScalar(decodeString(buf, pos, this.errCb)[0]);
      return end;
    }
    if (c === CC_SLASH) {
      if (this.mode === 'json')
        this.errAt(pos, 'a regexp literal is a JSONX extension', 'quote the pattern as a string');
      if (this.scanRegExp(buf, pos) < 0)
        return -1;
      const [re, end] = matchRegExp(buf, pos, this.errCb);
      this.checkValueEnd(buf, end);
      this.completeScalar(re);
      return end;
    }
    if (this.mode === 'json' && c === CC_PLUS)
      this.errAt(pos, "a leading '+' sign is a JSONX extension", 'remove the + sign');
    const end = this.scanScalar(buf, pos);
    if (end < 0)
      return -1;
    return this.decodeScalarToken(buf, pos, c);
  }

  // Decode a delimiter-terminated scalar token (number, word, datetime),
  // dispatching exactly like the full-text parser's parseValue.
  decodeScalarToken(buf, pos, c) {
    let m;
    if (c === CC_MINUS || c === CC_PLUS) {
      const d = pos + 1 < buf.length ? buf.charCodeAt(pos + 1) : -1;
      if (isAsciiLetterCode(d)) {
        m = matchWord(buf, pos, this.mode, this.errCb);
        this.checkValueEnd(buf, m[1]);
      }
      else
        m = matchNumber(buf, pos, this.mode, this.errCb, this.endCb);
    }
    else if (isDigitCode(c)) {
      if (this.mode === 'jsonx')
        m = matchDateTime(buf, pos, this.errCb, this.endCb);
      if (m == null)
        m = matchNumber(buf, pos, this.mode, this.errCb, this.endCb);
    }
    else if (isAsciiLetterCode(c)) {
      m = matchWord(buf, pos, this.mode, this.errCb);
      this.checkValueEnd(buf, m[1]);
    }
    else
      this.errAt(pos, 'invalid value');
    this.completeScalar(m[0]);
    return m[1];
  }

  checkValueEnd(buf, pos) {
    if (pos >= buf.length)
      return;
    if (!isValueEndCode(buf.charCodeAt(pos)))
      this.errAt(pos, 'unexpected character after value');
  }

  completeScalar(value) {
    const stack = this.stack;
    if (stack.length === 0) {
      this.rootValue = value;
      this.state = ST_DONE;
      return;
    }
    const frame = stack[stack.length - 1];
    if (frame.array) {
      const index = frame.value.length;
      frame.value.push(value);
      if (this.onEvent !== null)
        this.onEvent({
          type: 'item',
          path: this.path.concat(index),
          index,
          value,
          line: this.curLine,
        });
      this.state = ST_ARR_NEXT;
    }
    else {
      setKey(frame.value, frame.key, value);
      if (this.onEvent !== null)
        this.onEvent({
          type: 'pair',
          path: this.path.concat(frame.key),
          key: frame.key,
          value,
          line: this.curLine,
        });
      frame.key = undefined;
      this.state = ST_OBJ_NEXT;
    }
  }

  //#endregion

  //#region containers

  openContainer(isArray) {
    const container = isArray ? [] : {};
    const stack = this.stack;
    const parent = stack.length !== 0 ? stack[stack.length - 1] : null;
    if (parent === null)
      this.rootValue = container;
    else if (parent.array) {
      this.path.push(parent.value.length);
      parent.value.push(container);
    }
    else {
      this.path.push(parent.key);
      setKey(parent.value, parent.key, container);
    }
    stack.push({
      array: isArray,
      value: container,
      key: undefined,
      pathed: parent !== null,
    });
    if (this.onEvent !== null)
      this.onEvent({
        type: isArray ? 'array-start' : 'object-start',
        path: this.path.slice(),
        line: this.curLine,
      });
    this.state = isArray ? ST_ELEM_FIRST : ST_KEY_FIRST;
  }

  closeContainer() {
    const frame = this.stack.pop();
    if (this.onEvent !== null)
      this.onEvent({
        type: frame.array ? 'array-end' : 'object-end',
        path: this.path.slice(),
        line: this.curLine,
      });
    if (frame.pathed)
      this.path.pop();
    const stack = this.stack;
    if (stack.length === 0)
      this.state = ST_DONE;
    else if (stack[stack.length - 1].array)
      this.state = ST_ARR_NEXT;
    else {
      stack[stack.length - 1].key = undefined;
      this.state = ST_OBJ_NEXT;
    }
  }

  //#endregion

  //#region resumable token scanners

  // Find the position after a string's closing quote, or -1 when the
  // close has not arrived yet. Content is validated by decodeString once
  // the extent is known; at end-of-input the decoder surfaces the
  // unterminated-string/escape error with its exact position.
  scanString(buf, pos) {
    let p = this.scanPos >= 0 ? this.scanPos : pos + 1;
    while (p < buf.length) {
      const c = buf.charCodeAt(p);
      if (c === CC_DQUOTE) {
        this.scanPos = -1;
        return p + 1;
      }
      if (c === CC_BACKSLASH) {
        if (p + 1 >= buf.length)
          break; // the escaped character is in the next chunk
        p += 2;
        continue;
      }
      p++;
    }
    if (this.ended) {
      this.scanPos = -1;
      decodeString(buf, pos, this.errCb); // always throws here
    }
    this.scanPos = p;
    return -1;
  }

  // Find the end of a regexp literal (body, then flags), or -1 when more
  // input is needed. matchRegExp re-validates and reports errors.
  scanRegExp(buf, pos) {
    let p = this.scanPos >= 0 ? this.scanPos : pos + 1;
    if (!this.scanInFlags) {
      body:
      while (p < buf.length) {
        const c = buf.charCodeAt(p);
        if (c === CC_LF)
          break; // matchRegExp reports the unterminated literal
        if (c === CC_BACKSLASH) {
          if (p + 1 >= buf.length)
            break body;
          p += 2;
          continue;
        }
        if (c === CC_LBRACKET)
          this.scanInClass = true;
        else if (c === CC_RBRACKET)
          this.scanInClass = false;
        else if (c === CC_SLASH && !this.scanInClass) {
          this.scanInFlags = true;
          p++;
          break body;
        }
        p++;
      }
      if (!this.scanInFlags) {
        if (p < buf.length && buf.charCodeAt(p) === CC_LF) {
          this.scanPos = -1;
          this.scanInClass = false;
          return p + 1;
        }
        if (this.ended) {
          this.scanPos = -1;
          this.scanInClass = false;
          matchRegExp(buf, pos, this.errCb); // always throws here
        }
        this.scanPos = p;
        return -1;
      }
    }
    while (p < buf.length && isAsciiLetterCode(buf.charCodeAt(p)))
      p++;
    if (p >= buf.length && !this.ended) {
      this.scanPos = p; // a flag letter may still follow
      return -1;
    }
    this.scanPos = -1;
    this.scanInFlags = false;
    this.scanInClass = false;
    return p;
  }

  // Find the delimiter that terminates a number/word/datetime token, or
  // -1 when the token may still grow. A bare date followed by a single
  // space may yet become a space-separated RFC 3339 date-time, so the
  // scan crosses that one space and the run after it before deciding —
  // the datetime matcher then consumes exactly as much as is valid.
  scanScalar(buf, pos) {
    let p = this.scanPos >= 0 ? this.scanPos : pos;
    for (;;) {
      while (p < buf.length && !isValueEndCode(buf.charCodeAt(p)))
        p++;
      if (p >= buf.length && !this.ended) {
        this.scanPos = p;
        return -1;
      }
      if (this.mode === 'jsonx'
        && !this.scanDtSpace
        && p < buf.length
        && buf.charCodeAt(p) === CC_SPACE
        && p - pos === 10
        && RE_BARE_DATE.test(buf.slice(pos, p))) {
        this.scanDtSpace = true;
        p++;
        continue;
      }
      this.scanPos = -1;
      this.scanDtSpace = false;
      return p;
    }
  }

  //#endregion
}

/**
 * Absolute document path: strings for object keys, numbers for array
 * indices (JSON-Pointer-able).
 * @typedef {(string|number)[]} JsonxStreamPath
 */

/**
 * Document-order reader event; see the module doc comment for semantics.
 * @typedef {(
 *   {type: 'object-start'|'array-start'|'object-end'|'array-end',
 *    path: JsonxStreamPath, line: number}
 * | {type: 'pair', path: JsonxStreamPath, key: string, value: *, line: number}
 * | {type: 'item', path: JsonxStreamPath, index: number, value: *, line: number}
 * )} JsonxStreamEvent
 */

/**
 * Create an incremental JSONX / strict-JSON reader.
 * @param {object} [options] - Reader options
 * @param {'jsonx'|'json'} [options.mode] - 'json' rejects every JSONX
 *  extension and matches `JSON.parse` for accepted documents
 * @param {(event: JsonxStreamEvent) => void} [options.onEvent] - Event sink
 * @returns {{feed(chunk: string): void, end(): *, root(): *}} The reader:
 *  `feed` accepts chunks that may split any token, `end` flushes,
 *  validates completeness and returns the root, `root` peeks at the
 *  partial result.
 */
export function createJsonxStreamReader(options = undefined) {
  const machine = new JsonxMachine(options ?? {});
  return {
    feed(chunk) {
      machine.feed(chunk);
    },
    end() {
      return machine.end();
    },
    root() {
      return machine.root();
    },
  };
}

/**
 * Parse an async iterable of string chunks (e.g. an LLM output stream).
 * @param {AsyncIterable<string>|Iterable<string>} chunks - Source chunks
 * @param {object} [options] - Reader options; see `createJsonxStreamReader`
 * @returns {Promise<*>} The completed root value
 */
export async function parseJsonxStream(chunks, options = undefined) {
  const machine = new JsonxMachine(options ?? {});
  for await (const chunk of chunks)
    machine.feed(chunk);
  return machine.end();
}

export { JsonxSyntaxError } from './errors.js';

//#endregion
