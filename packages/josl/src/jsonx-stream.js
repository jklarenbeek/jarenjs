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
//   {type:'object-end', path, value, line}       - container completed
//   {type:'array-end',  path, value, line}
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
// With `partialText: true` a string value additionally emits
//
//   {type:'text-partial', path, text, line}     - more of a string arrived
//
// each time a chunk leaves it unterminated, plus a closing one when it
// completes. `text` is the *delta* since the previous event, already
// unescaped, so a progressive display appends it directly and a value's
// deltas always add up to exactly its string — there is no tail left over
// in the `pair`/`item` event, which still carries the whole value as the
// completion signal. Deltas never split a surrogate pair or an escape.
// Object keys emit none: a key has no path until it is complete, and half
// a key is not something to display.
//
// With `detach: [...path pattern...]` a value whose absolute path matches
// is **never linked into the tree**. Its completion event still fires and
// still carries the whole value, so a consumer sees every record exactly
// once; what changes is that letting go of the event lets go of the
// record. Without it, feeding a document in chunks bounds the *parse*
// but not the *result* — the reader still ends up holding everything it
// has read, which is the wrong answer for a continent-sized
// FeatureCollection or a log with a million lines.
//
//   createJsonxStreamReader({ detach: ['features', '*'], onEvent })
//
// leaves `root()` holding the document's frame — its header members and
// an empty `features` array — however many features went past. The
// pattern matches an exact path, not a prefix, so a feature's own rings
// are not separately detached: they belong to their feature and are
// freed with it.

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
import { setObjectMember } from '@jarenjs/core/object';
import {
  isValueEndCode,
  decodeString,
  decodeStringSpan,
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

/** The one-segment wildcard in a detach pattern. */
const WILDCARD = '*';

/**
 * Validate a detach path pattern: a non-empty array of segments, each a
 * string key, a non-negative integer index, or `'*'` matching any one
 * segment. `['features', '*']` names every member of the root's
 * `features` array; `['*']` names every element of an array root.
 *
 * A pattern matches a value's own **absolute path**, exactly — it is not
 * a prefix. That is what makes it safe on nested data: `['features',
 * '*']` detaches each feature and says nothing about the rings inside
 * it, which travel with their feature and are freed with it.
 *
 * Note the ambiguity `'*'` carries, the same one JSONPath has: a literal
 * object key spelled `*` cannot be named. Nothing here can fix that
 * without a second syntax, and the trade is worth it.
 *
 * @param {any} spec
 * @returns {(string|number)[]}
 * @throws {TypeError} On a malformed pattern
 */
function detachPattern(spec) {
  if (!Array.isArray(spec) || spec.length === 0)
    throw new TypeError('detach must be a non-empty array of path segments');
  for (const segment of spec) {
    const ok = typeof segment === 'string'
      || (typeof segment === 'number' && Number.isInteger(segment) && segment >= 0);
    if (!ok) {
      throw new TypeError(
        `detach segment ${JSON.stringify(segment)} must be a string key, a non-negative integer index, or '*'`);
    }
  }
  return spec.slice();
}

export class JsonxMachine {
  /**
   * @param {object} [options] - Reader options
   * @param {'jsonx'|'json'} [options.mode] - 'json' rejects every JSONX
   *  extension (bigint, regexp, datetime, non-finite, separators, +)
   * @param {(event: JsonxStreamEvent) => void} [options.onEvent] - Event sink
   * @param {boolean} [options.partialText] - Also emit `text-partial`
   *  deltas while a string value is still arriving
   * @param {(string|number)[]} [options.detach] - Path pattern whose
   *  matching values are NOT retained in the root (see `detachPattern`)
   */
  constructor(options = {}) {
    this.mode = options.mode === 'json' ? 'json' : 'jsonx';
    this.onEvent = options.onEvent ?? null;
    this.partialText = options.partialText === true;
    this.detach = options.detach === undefined ? null : detachPattern(options.detach);
    this.partialFrom = -1; // body offset the next text-partial delta starts at
    this.partialHold = ''; // lone high surrogate held back for the next delta
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
   *
   * Under `detach`, matching values were never linked in — the root is
   * the document's *frame* (its header members, and an empty array where
   * the detached records would have been), which is the whole point.
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
    if (this.partialFrom >= 0)
      this.partialFrom -= pos;
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
      if (end < 0) {
        if (this.partialText)
          this.emitPartialText(buf, pos, buf.length, true);
        return -1;
      }
      const value = decodeString(buf, pos, this.errCb)[0];
      if (this.partialText) {
        // the closing delta completes the run, so the deltas for a string
        // always add up to its value — with no tail left in the pair event
        this.emitPartialText(buf, pos, end - 1, false);
        this.partialFrom = -1;
        this.partialHold = '';
      }
      this.completeScalar(value);
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

  // Emit the string text that arrived since the last delta. `stop` is the
  // end of what may be decoded — the buffer's end while the string is
  // still open, or its closing quote once it has arrived.
  emitPartialText(buf, pos, stop, open) {
    if (this.onEvent === null)
      return;
    if (this.partialFrom < 0)
      this.partialFrom = pos + 1;
    const [decoded, reached] = decodeStringSpan(
      buf, this.partialFrom, stop, this.errCb, open);
    this.partialFrom = reached;
    let text = this.partialHold + decoded;
    this.partialHold = '';
    // never split a surrogate pair across two deltas: a display appending
    // them one at a time would render a replacement character
    const last = text.charCodeAt(text.length - 1);
    if (open && last >= 0xD800 && last <= 0xDBFF) {
      this.partialHold = text.slice(-1);
      text = text.slice(0, -1);
    }
    if (text.length !== 0)
      this.onEvent({ type: 'text-partial', path: this.valuePath(), text, line: this.curLine });
  }

  // Absolute path the value being read will land at.
  valuePath() {
    const stack = this.stack;
    if (stack.length === 0)
      return [];
    const frame = stack[stack.length - 1];
    return this.path.concat(frame.array ? frame.count : frame.key);
  }

  /**
   * Whether `this.path` plus one more segment matches the detach
   * pattern. Spelled out rather than built on `valuePath()` so the
   * common case — a document read with no `detach` at all — costs one
   * null check, and the matching case costs no array allocation.
   */
  detaches(last) {
    const pattern = this.detach;
    if (pattern === null)
      return false;
    const path = this.path;
    if (pattern.length !== path.length + 1)
      return false;
    for (let i = 0; i < path.length; i++) {
      if (pattern[i] !== WILDCARD && pattern[i] !== path[i])
        return false;
    }
    const tail = pattern[path.length];
    return tail === WILDCARD || tail === last;
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
      const index = frame.count++;
      // A detached scalar is not stored: the `item` event below already
      // carries it, so linking it in would retain exactly what the
      // caller asked not to retain.
      if (!this.detaches(index))
        frame.value[index] = value;
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
      if (!this.detaches(frame.key))
        setObjectMember(frame.value, frame.key, value);
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
      const index = parent.count++;
      // The decision is made HERE, at open, not at close: a subtree that
      // is never linked to its parent is never reachable from the root,
      // so the memory is not freed later — it is not held in the first
      // place, and a document with a million records never builds a
      // million-slot array either.
      if (!this.detaches(index))
        parent.value[index] = container;
      this.path.push(index);
    }
    else {
      if (!this.detaches(parent.key))
        setObjectMember(parent.value, parent.key, container);
      this.path.push(parent.key);
    }
    stack.push({
      array: isArray,
      value: container,
      key: undefined,
      count: 0,
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
        value: frame.value,
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
 *   {type: 'object-start'|'array-start', path: JsonxStreamPath, line: number}
 * | {type: 'object-end'|'array-end', path: JsonxStreamPath, value: *, line: number}
 * | {type: 'pair', path: JsonxStreamPath, key: string, value: *, line: number}
 * | {type: 'item', path: JsonxStreamPath, index: number, value: *, line: number}
 * | {type: 'text-partial', path: JsonxStreamPath, text: string, line: number}
 * )} JsonxStreamEvent
 */

/**
 * Create an incremental JSONX / strict-JSON reader.
 * @param {object} [options] - Reader options
 * @param {'jsonx'|'json'} [options.mode] - 'json' rejects every JSONX
 *  extension and matches `JSON.parse` for accepted documents
 * @param {(event: JsonxStreamEvent) => void} [options.onEvent] - Event sink
 * @param {boolean} [options.partialText] - Also emit `text-partial` deltas
 *  while a string value is still arriving, for progressive display
 * @param {(string|number)[]} [options.detach] - Path pattern (segments,
 *  or `'*'` for any one segment) whose matching values are never linked
 *  into the tree. Their completion events still carry them, so the
 *  consumer sees every record and the reader retains none — this is what
 *  makes a document larger than memory readable.
 * @returns {{feed(chunk: string): void, end(): *, root(): *}} The reader:
 *  `feed` accepts chunks that may split any token, `end` flushes,
 *  validates completeness and returns the root, `root` peeks at the
 *  partial result.
 * @throws {TypeError} On a malformed `detach` pattern
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
