//#region CSV incremental reader
// CSV (RFC 4180, and the dialects the world actually writes); this machine
// is both the full parser and the streaming reader — `parseAll()` and
// `feed()`/`end()` run the same record parser, so there is a single
// grammar code path.
//
// The design exploits CSV's record orientation, the way the JOSL machine
// exploits TOML's line orientation. A *logical record* is a physical line
// extended across the newlines that appear inside a quoted field. With
// the whole text in hand `parseRecord` finds each record's end as it
// parses. A chunk stream cannot: a chunk may stop mid-field, so `feed`
// first runs a cutter FSM that tracks just enough state (field start,
// quoted, pending quote) to decide whether a complete record is buffered.
// The cutter never allocates and has no effect on the document, so a scan
// that runs out of input simply resumes when the next chunk arrives.
//
// Two passes for streaming, one for wholesale, is the deliberate trade:
// the wholesale path is what a 100 MB file goes through.
//
// **The parser is authoritative, the cutter only permissive.** The cutter
// resolves an ambiguous quote by staying inside the field, which is the
// latest any reading could close it; the parser may close earlier. So a
// cut span can contain more than one record but never less than one, and
// the cut path reads a span in a loop rather than assuming it holds
// exactly one record. If that invariant were reversed — a cut earlier
// than the parser's — the text after the cut would be silently dropped.
//
// Self-healing (`repair: true`) is the second reason this exists. Real
// CSV is damaged constantly: an unclosed quote, a bare quote inside a
// value, a row with the wrong number of columns. Each has one reading
// that loses the least, and the machine takes it *and says so* — every
// repair lands in a log with a stable code, a line and a column. Strict
// mode throws `CsvSyntaxError` with the same code, so moving between the
// two modes never means re-learning the diagnosis.

import {
  CC_TAB,
  CC_LF,
  CC_CR,
  CC_SPACE,
  CC_DQUOTE,
  CC_COMMA,
  CC_MINUS,
  CC_DOT,
  CC_PLUS,
  CC_0,
  isDigitCode,
} from '@jarenjs/core/scan';

import { CsvSyntaxError } from './errors.js';
import { columnOf, setKey, feedMachine, beginParseAll } from './util.js';
import {
  LocalDate,
  LocalTime,
  LocalDateTime,
  isValidDateParts,
  isValidTimeParts,
} from './values.js';

//#region diagnosis codes

/**
 * The conditions the reader can diagnose. Each is a strict-mode error
 * code and a repair-mode log code; the wording is the same either way.
 */
export const CSV_CODES = {
  CSV1001: 'a quoted field is never closed',
  CSV1002: 'text after a closing quote',
  CSV1003: 'an unescaped quote inside a quoted field',
  CSV1004: 'a record has fewer fields than the header',
  CSV1005: 'a record has more fields than the header',
  CSV1006: 'a bare carriage return ends a record',
  CSV1007: 'a duplicate header name',
  CSV1008: 'an empty header name',
};

const HINTS = {
  CSV1001: 'close the field with a quote, or double any quote meant literally',
  CSV1002: 'double a quote meant literally, or remove the trailing text',
  CSV1003: 'double a quote meant literally ("" inside a quoted field)',
  CSV1004: 'pad the record, or leave the missing columns out deliberately',
  CSV1005: 'remove the extra columns, or widen the header',
  CSV1006: 'use \\n or \\r\\n to end a record',
  CSV1007: 'give each column a distinct name',
  CSV1008: 'give every column a name',
};

//#endregion

//#region cutter states

const S_START = 0; // at a field start: a quote here opens a quoted field
const S_PLAIN = 1; // inside an unquoted field: a quote is ordinary text
const S_QUOTED = 2; // inside a quoted field
const S_QUOTE = 3; // saw a quote inside a quoted field; needs one lookahead

//#endregion

//#region typed values

// Only these first characters can begin a non-string value, so a text
// column costs one comparison per cell instead of a regex.
function canBeTyped(c) {
  return isDigitCode(c)
    || c === CC_MINUS || c === CC_PLUS || c === CC_DOT
    || c === 0x74 || c === 0x54 // t T
    || c === 0x66 || c === 0x46 // f F
    || c === 0x6E || c === 0x4E; // n N
}

const RE_INT = /^[+-]?\d+$/;
const RE_FLOAT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const RE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_TIME = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;
const RE_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))?$/;

// A leading zero marks an identifier, not a number: postcodes, phone
// numbers and zero-padded ids lose their meaning the moment they become
// Numbers, and the loss is not recoverable downstream.
function hasLeadingZero(s) {
  const c0 = s.charCodeAt(0);
  const start = c0 === CC_MINUS || c0 === CC_PLUS ? 1 : 0;
  return s.charCodeAt(start) === CC_0 && s.length > start + 1
    && isDigitCode(s.charCodeAt(start + 1));
}

/**
 * Coerce one cell to a JOSL value, or return the string unchanged.
 *
 * The value model is the package's, not JSON's: an integer too large for
 * a Number becomes a BigInt rather than silently losing digits, and an
 * unambiguous ISO-8601 date becomes the same `LocalDate`/`LocalDateTime`
 * a JOSL document would produce. Anything the grammar does not match
 * exactly stays a string — CSV has no types, so a reader must not guess
 * beyond what the text says outright.
 * @param {string} s - The raw cell text
 * @returns {*} The coerced value, or `s` unchanged
 */
export function coerceCsvValue(s) {
  if (s.length === 0)
    return s;
  const c = s.charCodeAt(0);
  if (!canBeTyped(c))
    return s;

  if (c === 0x74 || c === 0x54 || c === 0x66 || c === 0x46 || c === 0x6E || c === 0x4E) {
    const lower = s.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    if (lower === 'null') return null;
    return s;
  }

  if (RE_INT.test(s)) {
    if (hasLeadingZero(s))
      return s;
    const n = Number(s);
    // past 2^53 a Number silently rounds; bigint is a first-class value
    // in this package, so use it rather than lose the digits
    return Number.isSafeInteger(n) ? n : BigInt(s);
  }
  if (RE_FLOAT.test(s)) {
    if (hasLeadingZero(s))
      return s;
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }

  // datetime before date: the date pattern is a prefix of it
  let m = RE_DATETIME.exec(s);
  if (m !== null) {
    const year = +m[1];
    const month = +m[2];
    const day = +m[3];
    const hour = +m[4];
    const min = +m[5];
    const sec = +m[6];
    if (!isValidDateParts(year, month, day) || !isValidTimeParts(hour, min, sec))
      return s;
    const frac = m[7] === undefined ? '' : '.' + m[7];
    if (m[8] !== undefined || m[9] !== undefined) {
      // an offset date-time is an instant, which `Date` holds faithfully
      const offset = m[8] !== undefined ? 0 : (m[9] === '-' ? -1 : 1) * (+m[10] * 60 + +m[11]);
      const ms = frac === '' ? 0 : Math.round(Number('0' + frac) * 1000);
      return new Date(Date.UTC(year, month - 1, day, hour, min, sec, ms) - offset * 60000);
    }
    return new LocalDateTime(
      new LocalDate(year, month, day),
      new LocalTime(hour, min, sec, frac));
  }
  m = RE_DATE.exec(s);
  if (m !== null)
    return isValidDateParts(+m[1], +m[2], +m[3]) ? new LocalDate(+m[1], +m[2], +m[3]) : s;
  m = RE_TIME.exec(s);
  if (m !== null) {
    if (!isValidTimeParts(+m[1], +m[2], +m[3]))
      return s;
    return new LocalTime(+m[1], +m[2], +m[3], m[4] === undefined ? '' : '.' + m[4]);
  }
  return s;
}

//#endregion

//#region the machine

function charCodeOption(value, name, fallback) {
  if (value === undefined || value === null)
    return fallback;
  if (typeof value !== 'string' || value.length !== 1)
    throw new TypeError(`options.${name} must be a single character`);
  return value.charCodeAt(0);
}

export class CsvMachine {
  /**
   * @param {object} [options] - Reader options; see `parseCsv`
   */
  constructor(options = {}) {
    this.delimiter = charCodeOption(options.delimiter, 'delimiter', CC_COMMA);
    this.quote = options.quote === null || options.quote === ''
      ? -1
      : charCodeOption(options.quote, 'quote', CC_DQUOTE);
    this.quoteChar = this.quote < 0 ? '' : String.fromCharCode(this.quote);
    this.comment = options.comment === undefined || options.comment === null
      ? -1
      : charCodeOption(options.comment, 'comment', -1);
    this.repair = options.repair === true;
    this.trim = options.trim === true;
    this.typed = options.typed === true;
    this.emptyAsNull = options.emptyAsNull === true;
    // A blank line is a one-empty-field record by the letter of RFC 4180.
    // Repair mode drops it, because in a table of N columns a blank line
    // is damage rather than a row; either way the caller can override.
    this.skipEmptyLines = options.skipEmptyLines === undefined
      ? this.repair
      : options.skipEmptyLines === true;
    this.onEvent = options.onEvent ?? null;
    this.onRepair = options.onRepair ?? null;

    const headers = options.headers;
    this.wantHeader = headers === true;
    this.headerFields = Array.isArray(headers)
      ? this.#nameHeader(headers.map(String), 1)
      : null;
    this.objectRows = this.wantHeader || this.headerFields !== null;
    // With no trimming, coercion or empty-as-null, a cell is its own
    // slice: worth knowing once, because `finish` would otherwise be a
    // call per cell that decides nothing.
    this.plainCells = !this.trim && !this.typed && !this.emptyAsNull;
    this.protoSafe = this.headerFields !== null && this.headerFields.includes('__proto__');

    // cutter state
    this.buf = '';
    this.scanPos = 0;
    this.scanState = S_START;
    this.started = false;
    this.ended = false;

    // document state
    this.outRows = [];
    this.repairLog = [];
    this.cells = [];
    this.recordIndex = 0;
    this.dropRecord = false; // set for a line that carries no record (a comment)
    this.line = 1; // physical line currently being read (1-based)
    this.recordOrigin = 1; // physical line the current record starts on
  }

  //#region public surface

  /**
   * Feed the next chunk of source text; chunks may split any field.
   * @param {string} chunk - Next piece of the document
   * @returns {this} The machine, for chaining
   */
  feed(chunk) {
    return feedMachine(this, chunk);
  }

  /**
   * Finish the document, flushing any pending record.
   * @returns {Array} The completed rows
   */
  end() {
    if (this.ended)
      return this.outRows;
    this.ended = true;
    this.scan();
    if (this.buf.length !== 0) {
      const rest = this.buf;
      this.buf = '';
      this.scanPos = 0;
      this.readSpan(rest, 0, rest.length);
    }
    return this.outRows;
  }

  /**
   * Parse a complete document in one pass. `parseRecord` finds each
   * record's end as it goes, so with the whole text in hand the cutter's
   * separate pass is not needed; `feed`/`end` keep it because a chunk can
   * stop mid-field, where only a side-effect-free pre-pass can decide
   * whether a record is complete.
   * @param {string} text - The entire document
   * @returns {Array} The completed rows
   */
  parseAll(text) {
    text = beginParseAll(this, text);
    this.readSpan(text, 0, text.length);
    return this.outRows;
  }

  /** @returns {Array} The rows read so far. */
  rows() {
    return this.outRows;
  }

  /** @returns {string[]|null} The header names, once known. */
  fields() {
    return this.headerFields;
  }

  /** @returns {object[]} The repair log, in document order. */
  repairs() {
    return this.repairLog;
  }

  //#endregion

  //#region diagnosis

  // Strict mode throws, repair mode logs and carries on; both carry the
  // same code so a caller can switch modes without re-reading the docs.
  heal(code, line, column, detail = undefined) {
    const message = detail === undefined ? CSV_CODES[code] : `${CSV_CODES[code]} (${detail})`;
    if (!this.repair)
      throw new CsvSyntaxError(code, message, line, column, HINTS[code]);
    const entry = { code, message, line, column };
    this.repairLog.push(entry);
    if (this.onRepair !== null)
      this.onRepair(entry);
    if (this.onEvent !== null)
      this.onEvent({ type: 'repair', ...entry });
  }

  //#endregion

  //#region chunk cutter

  // Advance the cutter over the buffer, handing each complete span to the
  // record reader. Permissive by construction: an ambiguous quote keeps
  // it inside the field, so a span never ends before the parser would end
  // a record — see the invariant at the top of this file.
  scan() {
    const buf = this.buf;
    const len = buf.length;
    const delim = this.delimiter;
    const quote = this.quote;
    let pos = this.scanPos;
    let state = this.scanState;
    let start = 0;

    while (pos < len) {
      const c = buf.charCodeAt(pos);
      switch (state) {
        case S_START:
          if (c === quote) {
            state = S_QUOTED;
            pos++;
            continue;
          }
          state = S_PLAIN;
          continue;
        case S_PLAIN: {
          if (c === delim) {
            state = S_START;
            pos++;
            continue;
          }
          if (c === CC_LF) {
            // The terminator belongs to the span, so the parser consumes
            // it and counts the line exactly as it does whole-document.
            pos++;
            this.readSpan(buf, start, pos);
            start = pos;
            state = S_START;
            continue;
          }
          if (c === CC_CR) {
            // A CR is only this record's end if no LF follows it, and
            // that needs one character of lookahead. Cutting here keeps
            // a CR-only document from buffering to the last byte, and the
            // parser still makes the call: it re-reads the same next
            // character out of the same buffer and heals CSV1006 itself.
            if (pos + 1 >= len) {
              if (this.ended)
                break;
              this.scanPos = pos;
              this.scanState = state;
              this.compact(start);
              return;
            }
            pos++;
            if (buf.charCodeAt(pos) === CC_LF)
              pos++;
            this.readSpan(buf, start, pos);
            start = pos;
            state = S_START;
            continue;
          }
          pos++;
          continue;
        }
        case S_QUOTED: {
          // quoted fields can be long, so let the engine find the quote
          const q = buf.indexOf(this.quoteChar, pos);
          if (q < 0) {
            pos = len;
            continue;
          }
          pos = q + 1;
          state = S_QUOTE;
          continue;
        }
        default: { // S_QUOTE - one lookahead decides doubled vs closing
          if (c === quote) { // "" is a literal quote; stay inside
            state = S_QUOTED;
            pos++;
            continue;
          }
          // Anything but a delimiter or terminator keeps the field open:
          // the latest close any reading could pick, which is what makes
          // the cutter permissive.
          state = c === delim || c === CC_LF || c === CC_CR ? S_PLAIN : S_QUOTED;
          continue;
        }
      }
      break;
    }

    // Out of input. A trailing S_QUOTE is undecided until the next
    // character arrives, so stop one short and re-read it next time.
    if (state === S_QUOTE && !this.ended) {
      this.scanPos = pos - 1;
      this.scanState = S_QUOTED;
    }
    else {
      this.scanPos = pos;
      this.scanState = state === S_QUOTE ? S_PLAIN : state;
    }
    this.compact(start);
  }

  // Drop the spans already handed off, keeping the partial tail.
  compact(start) {
    if (start === 0)
      return;
    this.buf = this.buf.slice(start);
    this.scanPos -= start;
  }

  //#endregion

  //#region record parsing

  // Read every record in `text[pos, end)`. A cut span always carries its
  // own terminator, so this is the same loop the whole-document form runs
  // and a blank line is a record of one empty field in both.
  readSpan(text, pos, end) {
    const reuse = this.objectRows;
    while (pos < end) {
      // An array row is handed straight to the caller, so it is built in
      // its own array and never copied. An object row is built FROM the
      // cells, so those can go in one scratch buffer that never grows.
      let cells;
      if (reuse) {
        cells = this.cells;
        cells.length = 0;
      }
      else {
        cells = [];
      }
      this.recordOrigin = this.line;
      this.dropRecord = false;
      pos = this.parseRecord(text, pos, end, cells);
      if (!this.dropRecord)
        this.emitRecord(cells);
    }
    return pos;
  }

  // The single grammar path: fill `cells` with one record's fields and
  // return the offset just past the record, including its terminator.
  parseRecord(text, pos, end, cells) {
    const delim = this.delimiter;
    const quote = this.quote;
    const comment = this.comment;

    // a comment line is consumed whole and contributes no record
    if (comment >= 0 && pos < end && text.charCodeAt(pos) === comment) {
      this.dropRecord = true;
      while (pos < end) {
        const c = text.charCodeAt(pos);
        if (c === CC_LF) {
          this.line++;
          return pos + 1;
        }
        if (c === CC_CR) {
          this.line++;
          return pos + (text.charCodeAt(pos + 1) === CC_LF ? 2 : 1);
        }
        pos++;
      }
      return pos;
    }

    for (;;) {
      pos = pos < end && text.charCodeAt(pos) === quote
        ? this.parseQuoted(text, pos, end, cells)
        : this.parsePlain(text, pos, end, cells);
      if (pos >= end)
        return pos;
      const t = text.charCodeAt(pos);
      if (t === delim) {
        pos++;
        continue;
      }
      if (t === CC_LF) {
        this.line++;
        return pos + 1;
      }
      // CC_CR
      if (text.charCodeAt(pos + 1) === CC_LF) {
        this.line++;
        return pos + 2;
      }
      // A bare CR is an old-Mac terminator. Reading it as data instead
      // would silently glue two records together, so repair mode ends the
      // record here and strict mode says why.
      this.heal('CSV1006', this.line, columnOf(text, pos));
      this.line++;
      return pos + 1;
    }
  }

  // An unquoted field: everything up to the next delimiter or terminator.
  parsePlain(text, pos, end, cells) {
    const delim = this.delimiter;
    const start = pos;
    while (pos < end) {
      const c = text.charCodeAt(pos);
      if (c === delim || c === CC_LF || c === CC_CR)
        break;
      pos++;
    }
    const raw = text.slice(start, pos);
    cells.push(this.plainCells ? raw : this.finish(raw));
    return pos;
  }

  // A quoted field: `"` … `"`, with `""` for a literal quote.
  parseQuoted(text, pos, end, cells) {
    const quote = this.quote;
    const delim = this.delimiter;
    pos++; // opening quote
    let start = pos;
    let out = null;
    for (;;) {
      if (pos >= end) {
        // Out of input with the field still open. Closing it here is the
        // only reading that keeps the text.
        this.heal('CSV1001', this.recordOrigin, columnOf(text, pos));
        cells.push(this.finishQuoted(joinCell(out, text, start, pos)));
        return pos;
      }
      const c = text.charCodeAt(pos);
      if (c !== quote) {
        if (c === CC_LF)
          this.line++;
        pos++;
        continue;
      }
      const n = pos + 1 < end ? text.charCodeAt(pos + 1) : -1;
      if (n === quote) { // "" — one literal quote
        out = (out === null ? '' : out) + text.slice(start, pos + 1);
        pos += 2;
        start = pos;
        continue;
      }
      if (n === delim || n === CC_LF || n === CC_CR || n === -1) {
        cells.push(this.finishQuoted(joinCell(out, text, start, pos)));
        return pos + 1; // past the closing quote
      }

      // A quote followed by ordinary text is neither a close nor an
      // escape, and the two possible readings damage different things.
      // Deciding between them by looking for another quote before the
      // next structural character keeps whichever is intact:
      //
      //   "he said "hi" ok"   another quote first  -> literal quote,
      //                       so the field text survives
      //   "abc"junk,d         a delimiter first    -> the field closed,
      //                       so the RECORD's column count survives
      //
      // Column count wins ties, because a consumer indexes by column.
      if (quoteBeforeBreak(text, pos + 1, end, quote, delim)) {
        this.heal('CSV1003', this.line, columnOf(text, pos));
        pos++;
        continue;
      }
      this.heal('CSV1002', this.line, columnOf(text, pos));
      const closed = joinCell(out, text, start, pos);
      pos++; // past the closing quote
      const stray = pos;
      while (pos < end) {
        const s = text.charCodeAt(pos);
        if (s === delim || s === CC_LF || s === CC_CR)
          break;
        pos++;
      }
      cells.push(this.finishQuoted(closed + text.slice(stray, pos)));
      return pos;
    }
  }

  //#endregion

  //#region cell and record shaping

  finish(cell) {
    if (this.trim)
      cell = trimAscii(cell);
    if (cell.length === 0)
      return this.emptyAsNull ? null : cell;
    return this.typed ? coerceCsvValue(cell) : cell;
  }

  // A quoted cell is never trimmed — the quotes are the author saying the
  // whitespace belongs to the data — and never coerced, for the same
  // reason: `"0123"` is an identifier the writer chose to protect.
  finishQuoted(cell) {
    if (cell.length === 0)
      return this.emptyAsNull ? null : cell;
    return cell;
  }

  emitRecord(cells) {
    const n = cells.length;
    if (this.skipEmptyLines && n === 1 && (cells[0] === '' || cells[0] === null))
      return;

    if (this.headerFields === null && this.wantHeader) {
      const names = new Array(n);
      for (let i = 0; i < n; i++)
        names[i] = cells[i] === null ? '' : String(cells[i]);
      this.headerFields = this.#nameHeader(names, this.recordOrigin);
      this.protoSafe = this.headerFields.includes('__proto__');
      if (this.onEvent !== null)
        this.onEvent({ type: 'header', fields: this.headerFields, line: this.recordOrigin });
      return;
    }

    const index = this.recordIndex++;
    const row = this.objectRows ? this.buildObject(cells) : cells;
    this.outRows.push(row);
    if (this.onEvent !== null) {
      // the scratch buffer is reused, so an event that outlives this call
      // needs its own copy of the cells
      this.onEvent({
        type: 'row',
        index,
        line: this.recordOrigin,
        values: this.objectRows ? cells.slice(0, n) : row,
        record: this.objectRows ? row : null,
      });
    }
  }

  buildObject(values) {
    const fields = this.headerFields;
    const width = fields.length;
    const n = values.length;
    if (n < width)
      this.heal('CSV1004', this.recordOrigin, 1, `${n} of ${width}`);
    else if (n > width)
      this.heal('CSV1005', this.recordOrigin, 1, `${n} of ${width}`);

    const row = {};
    const limit = n < width ? n : width;
    if (this.protoSafe) {
      for (let i = 0; i < limit; i++)
        setKey(row, fields[i], values[i]);
    }
    else {
      for (let i = 0; i < limit; i++)
        row[fields[i]] = values[i];
    }
    // A short record leaves the remaining columns absent rather than
    // inventing a value: reading `undefined` says "this record did not
    // carry the column", where `''` would claim it carried an empty one.
    if (n > width) {
      // Widen the header once, so the extra columns have somewhere to go
      // and every later record agrees on the shape.
      for (let i = width; i < n; i++) {
        const name = uniqueName(fields, `column_${i + 1}`);
        fields.push(name);
        setKey(row, name, values[i]);
      }
      this.protoSafe = this.protoSafe || fields.includes('__proto__');
    }
    return row;
  }

  #nameHeader(names, line) {
    for (let i = 0; i < names.length; i++) {
      let name = names[i];
      if (name.length === 0) {
        this.heal('CSV1008', line, i + 1);
        name = uniqueName(names, `column_${i + 1}`);
      }
      // `lastIndexOf(name, -1)` would search from the END, so the first
      // column would always look like a duplicate of itself
      if (i > 0 && names.lastIndexOf(name, i - 1) >= 0) {
        this.heal('CSV1007', line, i + 1, name);
        name = uniqueName(names, name);
      }
      names[i] = name;
    }
    return names;
  }

  //#endregion
}

//#endregion

//#region helpers

// Concatenate a cell whose escaped prefix was already collected. `out`
// is null for the overwhelmingly common cell with no doubled quote,
// where the whole cell is one slice and nothing is concatenated.
function joinCell(out, text, start, pos) {
  const tail = text.slice(start, pos);
  return out === null ? tail : out + tail;
}

// Is there another quote before the next delimiter or terminator?
function quoteBeforeBreak(text, pos, end, quote, delim) {
  while (pos < end) {
    const c = text.charCodeAt(pos);
    if (c === quote)
      return true;
    if (c === delim || c === CC_LF || c === CC_CR)
      return false;
    pos++;
  }
  return false;
}

function trimAscii(s) {
  let a = 0;
  let b = s.length;
  while (a < b) {
    const c = s.charCodeAt(a);
    if (c !== CC_SPACE && c !== CC_TAB) break;
    a++;
  }
  while (b > a) {
    const c = s.charCodeAt(b - 1);
    if (c !== CC_SPACE && c !== CC_TAB) break;
    b--;
  }
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

// The first free name in the `base`, `base_2`, `base_3`, ... series. A
// synthesized column keeps its plain name when nothing else claims it;
// only a genuine collision gets a suffix.
function uniqueName(taken, base) {
  if (!taken.includes(base))
    return base;
  let n = 2;
  let name = `${base}_${n}`;
  while (taken.includes(name)) {
    n++;
    name = `${base}_${n}`;
  }
  return name;
}

//#endregion

//#endregion
