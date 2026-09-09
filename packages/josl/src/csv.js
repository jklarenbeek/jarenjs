//#region CSV whole-document API
// Reading and writing a complete CSV document. The reader is the same
// machine the streaming reader drives (csv-machine.js), so a document
// parses identically whether it arrives at once or in chunks.

import { CsvMachine, CSV_CODES, coerceCsvValue } from './csv-machine.js';
import { CsvSyntaxError } from './errors.js';

//#region reading

/**
 * Parse a complete CSV document.
 *
 * Default is **strict**: anything RFC 4180 does not allow throws a
 * `CsvSyntaxError` carrying a `CSV1xxx` code, a line and a column.
 * `repair: true` instead takes the reading that loses the least data,
 * records it, and carries on — see `parseCsvDocument` for the log.
 *
 * @param {string} text - CSV source text
 * @param {object} [options] - Reader options
 * @param {string} [options.delimiter=','] - Field separator, one character
 * @param {string|null} [options.quote='"'] - Quote character; `null` disables quoting
 * @param {string|null} [options.comment] - Lines starting with it are skipped
 * @param {boolean|string[]} [options.headers=false] - `true` reads the first
 *  record as column names, an array supplies them; either way records become
 *  objects. `false` yields arrays, which allocate less.
 * @param {boolean} [options.repair=false] - Heal damage instead of throwing
 * @param {boolean} [options.trim=false] - Trim spaces/tabs around unquoted fields
 * @param {boolean} [options.typed=false] - Coerce numbers, bigints, booleans,
 *  `null` and ISO dates; quoted cells always stay strings
 * @param {boolean} [options.emptyAsNull=false] - Empty cells become `null`
 * @param {boolean} [options.skipEmptyLines] - Drop blank lines (default: on
 *  in repair mode, off otherwise)
 * @param {(event: object) => void} [options.onEvent] - Document-order event sink
 * @param {(repair: object) => void} [options.onRepair] - Repair sink
 * @returns {Array<string[]|object>} The records
 * @throws {CsvSyntaxError} On malformed input, unless `repair` is set
 * @example
 * parseCsv('a,b\n1,2');            // [['a','b'], ['1','2']]
 * parseCsv('a,b\n1,2', { headers: true }); // [{ a: '1', b: '2' }]
 */
export function parseCsv(text, options = undefined) {
  return new CsvMachine(options).parseAll(text);
}

/**
 * Parse a complete CSV document and report everything that was learned
 * about it: the resolved dialect, the column names, the records, and the
 * repair log. This is the form to use when the input is untrusted — it is
 * the only way to see *what* had to be healed.
 * @param {string} text - CSV source text
 * @param {object} [options] - Reader options; see `parseCsv`. `delimiter:
 *  'auto'` sniffs the dialect from the text first.
 * @returns {{dialect: object, fields: string[]|null, rows: Array, repairs: object[]}}
 *  The document
 * @example
 * const doc = parseCsvDocument('a;b\n1;2', { delimiter: 'auto', headers: true });
 * doc.dialect.delimiter; // ';'
 * doc.rows;              // [{ a: '1', b: '2' }]
 */
export function parseCsvDocument(text, options = undefined) {
  let opts = options ?? {};
  let dialect;
  if (opts.delimiter === 'auto') {
    dialect = sniffCsvDialect(text, opts);
    opts = { ...opts, delimiter: dialect.delimiter };
    if (opts.headers === 'auto')
      opts.headers = dialect.headers;
  }
  else {
    if (opts.headers === 'auto')
      opts = { ...opts, headers: sniffCsvDialect(text, opts).headers };
    dialect = {
      delimiter: opts.delimiter ?? ',',
      quote: opts.quote === undefined ? '"' : opts.quote,
      headers: opts.headers === true || Array.isArray(opts.headers),
      confidence: 1,
    };
  }
  const machine = new CsvMachine(opts);
  const rows = machine.parseAll(text);
  return { dialect, fields: machine.fields(), rows, repairs: machine.repairs() };
}

//#endregion

//#region dialect sniffing

const CANDIDATES = [',', ';', '\t', '|', ':'];
const SNIFF_BYTES = 65536;
const SNIFF_RECORDS = 50;

// Read up to `SNIFF_RECORDS` records with one candidate delimiter, in
// repair mode so damage never aborts the probe, and report how consistent
// the record widths are. A real delimiter produces the same width on
// nearly every line; a wrong one produces width 1 or noise.
function probeDelimiter(sample, delimiter, options) {
  const widths = [];
  const machine = new CsvMachine({
    ...options,
    delimiter,
    headers: false,
    typed: false,
    repair: true,
    onEvent: null,
    onRepair: null,
  });
  let rows;
  try {
    rows = machine.parseAll(sample);
  }
  catch {
    return { score: 0, width: 0 };
  }
  const limit = rows.length < SNIFF_RECORDS ? rows.length : SNIFF_RECORDS;
  for (let i = 0; i < limit; i++)
    widths.push(rows[i].length);
  if (widths.length === 0)
    return { score: 0, width: 0 };

  const counts = new Map();
  for (const w of widths)
    counts.set(w, (counts.get(w) ?? 0) + 1);
  let modal = 0;
  let best = 0;
  for (const [w, n] of counts) {
    if (n > best || (n === best && w > modal)) {
      best = n;
      modal = w;
    }
  }
  // A single column means the delimiter never appeared: no evidence at all,
  // not perfect evidence.
  if (modal < 2)
    return { score: 0, width: modal };
  return { score: best / widths.length, width: modal, rows };
}

/**
 * Guess a CSV document's dialect from its text.
 *
 * The delimiter is chosen by consistency: each candidate is parsed and
 * scored by how often it produces the same field count, because a
 * separator that is really a separator divides every record the same way
 * and one that is not divides them arbitrarily. Ties go to the delimiter
 * yielding more columns, since a spurious separator can only ever split
 * fewer.
 *
 * Header detection asks whether the first record looks unlike the rest:
 * if every cell in it is a non-numeric string while some column below is
 * consistently numeric or date-like, that first record is naming columns
 * rather than carrying data.
 *
 * @param {string} text - CSV source text (a prefix is enough)
 * @param {object} [options] - Reader options that affect parsing (`quote`, `comment`)
 * @returns {{delimiter: string, quote: string|null, headers: boolean, width: number, confidence: number}}
 *  The guess, with `confidence` in 0..1
 * @example
 * sniffCsvDialect('a;b;c\n1;2;3'); // { delimiter: ';', headers: true, ... }
 */
export function sniffCsvDialect(text, options = undefined) {
  const sample = text.length > SNIFF_BYTES ? text.slice(0, text.lastIndexOf('\n', SNIFF_BYTES) + 1 || SNIFF_BYTES) : text;
  const opts = options ?? {};
  let bestDelim = opts.delimiter && opts.delimiter !== 'auto' ? opts.delimiter : ',';
  let bestScore = -1;
  let bestWidth = 0;
  let bestRows = null;

  const candidates = opts.delimiter && opts.delimiter !== 'auto' ? [opts.delimiter] : CANDIDATES;
  for (const candidate of candidates) {
    const probe = probeDelimiter(sample, candidate, opts);
    if (probe.score > bestScore || (probe.score === bestScore && probe.width > bestWidth)) {
      bestScore = probe.score;
      bestWidth = probe.width;
      bestDelim = candidate;
      bestRows = probe.rows ?? null;
    }
  }

  return {
    delimiter: bestDelim,
    quote: opts.quote === undefined ? '"' : opts.quote,
    headers: bestRows === null ? false : looksLikeHeader(bestRows),
    width: bestWidth,
    confidence: bestScore < 0 ? 0 : bestScore,
  };
}

// The first record names columns when it is all non-empty text and at
// least one column below it is consistently non-text. A table that is
// strings all the way down gives no evidence either way, so it is not a
// header — inventing one would silently eat a data row.
function looksLikeHeader(rows) {
  if (rows.length < 2)
    return false;
  const head = rows[0];
  for (const cell of head) {
    if (cell === '' || cell === null || typeof coerceCsvValue(String(cell)) !== 'string')
      return false;
  }
  const limit = rows.length < SNIFF_RECORDS ? rows.length : SNIFF_RECORDS;
  for (let col = 0; col < head.length; col++) {
    let typed = 0;
    let seen = 0;
    for (let r = 1; r < limit; r++) {
      const cell = rows[r][col];
      if (cell === undefined || cell === '' || cell === null)
        continue;
      seen++;
      if (typeof coerceCsvValue(String(cell)) !== 'string')
        typed++;
    }
    if (seen > 0 && typed === seen)
      return true;
  }
  return false;
}

//#endregion

//#region writing

const RE_UNSAFE_CACHE = new Map();

function needsQuoteTester(delimiter, quote) {
  const key = delimiter + quote;
  let test = RE_UNSAFE_CACHE.get(key);
  if (test === undefined) {
    const dc = delimiter.charCodeAt(0);
    const qc = quote.length === 0 ? -1 : quote.charCodeAt(0);
    test = (s) => {
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === dc || c === qc || c === 0x0A || c === 0x0D)
          return true;
      }
      // leading or trailing whitespace only survives a round-trip when
      // the field is quoted, because a lenient reader may trim it
      if (s.length !== 0) {
        const a = s.charCodeAt(0);
        const b = s.charCodeAt(s.length - 1);
        if (a === 0x20 || a === 0x09 || b === 0x20 || b === 0x09)
          return true;
      }
      return false;
    };
    RE_UNSAFE_CACHE.set(key, test);
  }
  return test;
}

/**
 * Render one value as CSV cell text. `null`/`undefined` become empty,
 * bigints lose the `n` suffix JOSL uses (CSV has no type marks), the
 * JOSL date classes and `Date` render as ISO-8601, and a plain object or
 * an array — a nested document in a flat format — is its JSON text, so
 * a reader gets the value back instead of `[object Object]`.
 * @param {*} value - The value
 * @returns {string} Cell text, unquoted
 */
export function formatCsvValue(value) {
  if (value === null || value === undefined)
    return '';
  switch (typeof value) {
    case 'string': return value;
    case 'number': return Number.isFinite(value) ? String(value) : '';
    case 'bigint': return String(value);
    case 'boolean': return value ? 'true' : 'false';
    default: break;
  }
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    return JSON.stringify(value);
  // LocalDate / LocalTime / LocalDateTime, and anything else that knows
  // how to render itself
  return String(value);
}

/**
 * Serialize records to a CSV document.
 *
 * A field is quoted only when it has to be — when it contains the
 * delimiter, a quote, a newline, or edge whitespace a lenient reader
 * might trim. Everything else is written bare, which keeps the output
 * both smaller and diff-friendly.
 *
 * @param {Array<Array|object>} rows - Records: arrays, or objects keyed by column
 * @param {object} [options] - Writer options
 * @param {string} [options.delimiter=','] - Field separator
 * @param {string} [options.quote='"'] - Quote character
 * @param {string} [options.newline='\r\n'] - Record terminator; RFC 4180 §2.1
 *  specifies CRLF, which is also what spreadsheet software expects
 * @param {string[]} [options.fields] - Column order; inferred from the first
 *  object record when omitted
 * @param {boolean} [options.header=true] - Emit a header row for object records
 * @returns {string} The CSV document
 * @example
 * stringifyCsv([{ a: 1, b: 'x,y' }]); // 'a,b\r\n1,"x,y"\r\n'
 */
export function stringifyCsv(rows, options = {}) {
  let out = '';
  for (const chunk of stringifyCsvChunks(rows, options))
    out += chunk;
  return out;
}

/**
 * The one row formatter behind every CSV writer: the same delimiter,
 * quote and terminator rules and the same header-once rule, whether
 * rows arrive as an array, an iterable, an async iterable or one at a
 * time through the stream writer — so all of them produce byte-identical
 * text for the same records by construction.
 * @param {object} [options] - Writer options; see `stringifyCsv`
 * @returns {{ lines: (row: Array|object) => string[], tail: () => string, fields: () => string[] | null }}
 *   `lines` formats one record as its line — preceded by the header
 *   line exactly once, before the first object row — `tail` answers the
 *   header an explicit field list is still owed when no record was
 *   ever written, `fields` the columns as decided
 */
export function createCsvRowFormatter(options = {}) {
  const delimiter = options.delimiter ?? ',';
  const quote = options.quote ?? '"';
  const newline = options.newline ?? '\r\n';
  const wantHeader = options.header !== false;
  const unsafe = needsQuoteTester(delimiter, quote);
  const escaped = quote + quote;

  const cell = (value) => {
    const s = formatCsvValue(value);
    if (quote.length === 0 || !unsafe(s))
      return s;
    return quote + (s.includes(quote) ? s.replaceAll(quote, escaped) : s) + quote;
  };
  const line = (values) => {
    let out = '';
    for (let i = 0; i < values.length; i++)
      out += (i === 0 ? '' : delimiter) + cell(values[i]);
    return out + newline;
  };

  let fields = options.fields ?? null;
  let emittedHeader = false;
  return {
    lines(row) {
      if (Array.isArray(row))
        return [line(row)];
      if (fields === null)
        fields = Object.keys(row);
      const values = new Array(fields.length);
      for (let i = 0; i < fields.length; i++)
        values[i] = row[fields[i]];
      if (wantHeader && !emittedHeader) {
        emittedHeader = true;
        return [line(fields), line(values)];
      }
      return [line(values)];
    },
    tail() {
      // an explicit field list still deserves its header when there
      // were no records to infer one from
      if (wantHeader && !emittedHeader && fields !== null && options.fields !== undefined) {
        emittedHeader = true;
        return line(fields);
      }
      return '';
    },
    fields: () => fields,
  };
}

/**
 * Serialize records as an iterable of chunks, one record at a time, so a
 * large table never exists as a single string. The header precedes the
 * first object row; a chunk is one line.
 * @param {Iterable<Array|object>} rows - Records
 * @param {object} [options] - Writer options; see `stringifyCsv`
 * @yields {string} One record (or the header) at a time
 */
export function* stringifyCsvChunks(rows, options = {}) {
  const formatter = createCsvRowFormatter(options);
  for (const row of rows)
    yield* formatter.lines(row);
  const tail = formatter.tail();
  if (tail.length !== 0)
    yield tail;
}

//#endregion

export { CsvSyntaxError, CSV_CODES, coerceCsvValue };

//#endregion
