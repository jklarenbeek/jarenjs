//#region JOSL streaming reader
// Chunk-feedable reader for incremental (e.g. LLM token) output. Events
// fire in document order the moment each construct completes — the
// opposite of `JSON.parse(text, reviver)`, which visits leaves bottom-up
// after the whole text has arrived and never tells you where you are.
// Every event carries an absolute `path` (strings for keys, numbers for
// array-of-tables indices), so events are directly JSON-Pointer-able.

import { JoslMachine } from './machine.js';
import { JoslSyntaxError } from './errors.js';
import { closeIterator, abortedError } from './pull.js';

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

/**
 * Yield the `[[]]` root items of a JOSL document as they complete,
 * without ever holding the whole document: each item is DETACHED from
 * the root the moment the next `[[]]` header (or the end) completes it,
 * so `root()`-style retention never grows past one record — the JOSL
 * twin of the JSONX reader's `detach`. A document with a table root is
 * refused by name (`JoslSyntaxError`): a table root is one retained
 * value, not a stream of records. `options.signal` aborts between
 * chunks; an abort, a consumer that stops early or a throw closes the
 * chunk source exactly once.
 * @param {AsyncIterable<string>|Iterable<string>} chunks - Source chunks
 * @param {object} [options] - Reader options; see `createStreamReader`,
 *  plus `signal` and the `JOSL2xxx` limits
 * @yields {object} One completed root item at a time
 * @example
 * for await (const record of iterateJoslStream(response.body))
 *   await save(record);
 */
export async function* iterateJoslStream(chunks, options = undefined) {
  /** @type {object[]} */
  const completed = [];
  const machine = new JoslMachine({
    ...(options ?? {}),
    detachRoot: (item) => { completed.push(item); },
  });
  const signal = options?.signal ?? null;
  const iterator = chunks[Symbol.asyncIterator]?.() ?? chunks[Symbol.iterator]();
  let finished = false;
  try {
    for (;;) {
      if (signal !== null && signal.aborted)
        throw abortedError(signal);
      const step = await iterator.next();
      if (step.done) {
        finished = true;
        break;
      }
      machine.feed(step.value);
      if (machine.rootValue !== undefined && !machine.rootIsArray) {
        throw new JoslSyntaxError('iterateJoslStream reads a [[]] root array; this document has a table root',
          machine.lineOrigin, 1, 'stream a document of [[]] records, or read a table root with parseJoslStream');
      }
      while (completed.length !== 0)
        yield /** @type {object} */ (completed.shift());
    }
  }
  finally {
    if (!finished)
      await closeIterator(iterator);
  }
  machine.end();
  while (completed.length !== 0)
    yield /** @type {object} */ (completed.shift());
}

export { JoslSyntaxError } from './errors.js';
export { JoslLimitError, JOSL_LIMIT_CODES } from './limits.js';

//#endregion
