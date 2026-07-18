//#region JOSL streaming reader
// Chunk-feedable reader for incremental (e.g. LLM token) output. Events
// fire in document order the moment each construct completes — the
// opposite of `JSON.parse(text, reviver)`, which visits leaves bottom-up
// after the whole text has arrived and never tells you where you are.
// Every event carries an absolute `path` (strings for keys, numbers for
// array-of-tables indices), so events are directly JSON-Pointer-able.

import { JoslMachine } from './machine.js';

/**
 * Create an incremental JOSL/TOML reader.
 *
 * Events, in document order:
 *   {type:'table',       path, line}          - a [header] opened
 *   {type:'table-array', path, line}          - a [[header]] appended
 *   {type:'root-item',   path, index, line}   - a [[]] element started
 *   {type:'pair',        path, key, value, line} - a key-value completed
 *
 * @param {object} [options] - Reader options
 * @param {'josl'|'toml'} [options.mode] - 'toml' rejects JOSL extensions
 * @param {(event: object) => void} [options.onEvent] - Event sink
 * @returns {{feed(chunk: string): void, end(): *, root(): *}} The reader:
 *  `feed` accepts chunks that may split any token, `end` flushes and
 *  returns the completed root, `root` peeks at the partial result.
 */
export function createStreamReader(options = undefined) {
  const machine = new JoslMachine(options);
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
 * @param {object} [options] - Reader options; see `createStreamReader`
 * @returns {Promise<*>} The completed root value
 */
export async function parseJoslStream(chunks, options = undefined) {
  const machine = new JoslMachine(options);
  for await (const chunk of chunks)
    machine.feed(chunk);
  return machine.end();
}

export { JoslSyntaxError } from './errors.js';

//#endregion
