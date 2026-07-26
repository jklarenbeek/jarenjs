//#region CSV streaming reader and writer
// Chunk-feedable reader for incremental input — a network response, a
// file read in pieces, an LLM emitting a table token by token. Rows are
// complete the moment their record terminates, so a consumer can work on
// row 1 while row 100000 is still on the wire.
//
// The reader drives the same machine as `parseCsv`, so a document read in
// chunks and the same document read whole produce identical rows; the
// test suite asserts exactly that at every chunk size.

import { CsvMachine } from './csv-machine.js';
import { stringifyCsvChunks, formatCsvValue } from './csv.js';

//#region reading

/**
 * Create an incremental CSV reader.
 *
 * Events, in document order:
 *   {type:'header', fields, line}                  - column names resolved
 *   {type:'row',    index, values, record, line}   - a record completed
 *   {type:'repair', code, message, line, column}   - damage healed
 *
 * @param {object} [options] - Reader options; see `parseCsv`
 * @returns {{feed(chunk: string): void, end(): Array, rows(): Array,
 *  fields(): string[]|null, repairs(): object[]}} The reader: `feed`
 *  accepts chunks that may split any field, `end` flushes the pending
 *  record and returns every row, and the rest peek at partial results.
 * @example
 * const reader = createCsvStreamReader({ headers: true, onEvent: console.log });
 * reader.feed('a,b\n1,');
 * reader.feed('2\n');
 * reader.end(); // [{ a: '1', b: '2' }]
 */
export function createCsvStreamReader(options = undefined) {
  const machine = new CsvMachine(options);
  return {
    feed(chunk) {
      machine.feed(chunk);
    },
    end() {
      return machine.end();
    },
    rows() {
      return machine.rows();
    },
    fields() {
      return machine.fields();
    },
    repairs() {
      return machine.repairs();
    },
  };
}

/**
 * Read an async iterable of string chunks (a fetch body, a file stream,
 * an LLM response) into records.
 * @param {AsyncIterable<string>|Iterable<string>} chunks - Source chunks
 * @param {object} [options] - Reader options; see `parseCsv`
 * @returns {Promise<Array>} Every record
 */
export async function parseCsvStream(chunks, options = undefined) {
  const machine = new CsvMachine(options);
  for await (const chunk of chunks)
    machine.feed(chunk);
  return machine.end();
}

/**
 * Yield records as they complete, without ever holding the whole table.
 *
 * This is the reason to stream: `parseCsvStream` still accumulates every
 * row, so a file larger than memory needs a reader that hands each record
 * over and forgets it. Rows are dropped from the machine as they are
 * yielded, so memory stays flat in the number of records.
 * @param {AsyncIterable<string>|Iterable<string>} chunks - Source chunks
 * @param {object} [options] - Reader options; see `parseCsv`
 * @yields {Array|object} One record at a time
 * @example
 * for await (const row of iterateCsvStream(response.body, { headers: true }))
 *   await save(row);
 */
export async function* iterateCsvStream(chunks, options = undefined) {
  const machine = new CsvMachine(options);
  const pending = machine.rows();
  for await (const chunk of chunks) {
    machine.feed(chunk);
    if (pending.length !== 0) {
      // hand over the completed rows and drop them, so the machine never
      // accumulates the document it is streaming
      const batch = pending.splice(0, pending.length);
      for (const row of batch)
        yield row;
    }
  }
  machine.end();
  for (const row of pending.splice(0, pending.length))
    yield row;
}

//#endregion

//#region writing

/**
 * An incremental CSV writer: rows in, chunks out.
 */
export class CsvStreamWriter {
  /**
   * @param {object} [options] - Writer options; see `stringifyCsv`
   */
  constructor(options = {}) {
    this.options = options;
    this.chunks = [];
    this.onChunk = options.onChunk ?? null;
    this.fields = options.fields ?? null;
    this.wroteHeader = options.header === false;
  }

  #emit(text) {
    if (this.onChunk !== null)
      this.onChunk(text);
    else
      this.chunks.push(text);
    return this;
  }

  /**
   * Write one record.
   * @param {Array|object} row - An array, or an object keyed by column
   * @returns {this} The writer, for chaining
   */
  write(row) {
    if (!Array.isArray(row) && this.fields === null)
      this.fields = Object.keys(row);
    for (const chunk of stringifyCsvChunks([row], {
      ...this.options,
      fields: this.fields,
      header: !this.wroteHeader && this.options.header !== false,
    })) {
      this.#emit(chunk);
    }
    if (!Array.isArray(row))
      this.wroteHeader = true;
    return this;
  }

  /**
   * Write many records.
   * @param {Iterable<Array|object>} rows - Records
   * @returns {this} The writer, for chaining
   */
  writeAll(rows) {
    for (const row of rows)
      this.write(row);
    return this;
  }

  /**
   * Concatenate the buffered chunks; empty when an `onChunk` sink is set.
   * @returns {string} The document so far
   */
  toString() {
    return this.chunks.join('');
  }

  /**
   * Finish writing.
   * @returns {string} The complete document, or `''` with an `onChunk` sink
   */
  end() {
    return this.toString();
  }
}

/**
 * Create an incremental CSV writer.
 * @param {object} [options] - Writer options; see `stringifyCsv`
 * @param {(chunk: string) => void} [options.onChunk] - Chunk sink; without
 *  one, chunks buffer until `end()`
 * @returns {CsvStreamWriter} The writer
 * @example
 * const w = createCsvStreamWriter();
 * w.write({ a: 1, b: 2 }).write({ a: 3, b: 4 });
 * w.end(); // 'a,b\r\n1,2\r\n3,4\r\n'
 */
export function createCsvStreamWriter(options = undefined) {
  return new CsvStreamWriter(options ?? {});
}

//#endregion

export { stringifyCsvChunks, formatCsvValue };

//#endregion
