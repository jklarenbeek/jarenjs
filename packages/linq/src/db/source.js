//@ts-check
/**
 * @file Which rows a chain was built over. A chain's document names rows
 * of the source it was built from and nothing else, so a handle that runs
 * a chain's document runs it over ITS rows: a chain over `users` handed to
 * `orders.live()` would be a query over the wrong collection, and a chain
 * over rows in memory would answer from the handle's rows while its own
 * were ignored. A handle's `live()`, `execute()`, `query()` and `explain()`
 * therefore take a chain only over a source of the same name, or over no
 * rows at all.
 *
 * Every collection and entity view of a store carries its own source
 * under `STORE_SOURCE` (the store's view, a transaction's, the synchronous
 * twin, the client's handle spread from one), and the comparison is by
 * name within the model, never by object: a chain over the same-named
 * source of another client of the model, or from a transaction's view, ran
 * the right rows and still does. A chain over an empty array (`from([])`,
 * the document builder) names no rows and is taken; so are rows whose count
 * cannot be read without consuming them (a generator, an async iterable, a
 * cursor) and a provider that carries no source (one written by hand).
 */

import { STORE_SOURCE } from '@jarenjs/db';

import { LinqBuildError } from '../errors.js';

/**
 * How many rows an in-memory source holds, where that is known without
 * reading it: an array, a string, a typed array, a Set or a Map.
 * @param {any} rows
 * @returns {number | undefined} `undefined` for any other iterable
 */
function countOf(rows) {
  if (Array.isArray(rows) || typeof rows === 'string' || ArrayBuffer.isView(rows)) {
    return /** @type {any} */ (rows).length;
  }
  if (rows instanceof Set || rows instanceof Map) return rows.size;
  return undefined;
}

/**
 * A handle's refusal of a chain built over another source than its own:
 * another collection or entity, by name (`JL0005`), or rows in memory.
 * @param {'entity' | 'collection'} kind - the handle's kind
 * @param {string} name - the handle's collection or entity
 * @param {string} method - the member the chain was handed to
 * @returns {(built: { source: any, rows: any }) => void}
 */
export function onlyOwnSource(kind, name, method) {
  const handed = `${method}() on ${kind} '${name}' was handed a chain built over`;
  return ({ source, rows }) => {
    const key = source?.[STORE_SOURCE];
    // names are unique across kinds (two objects of one database cannot
    // share a table name), so the name settles which source it is
    if (key !== undefined && key.name !== name) {
      throw new LinqBuildError('JL0005',
        `${handed} ${key.kind} '${key.name}' — `
        + 'a chain runs against the source it was built over; build it from this handle, '
        + 'or hand it to the handle it was built from');
    }
    const count = rows === null ? undefined : countOf(rows);
    if (count !== undefined && count > 0) {
      throw new LinqBuildError('JL0005',
        `${handed} ${count === 1 ? '1 row' : `${count} rows`} in memory — `
        + "a handle runs a chain's document over its own rows, never the chain's; build it from "
        + 'this handle (or from([]) to write a document), or run it over its rows with toArray()');
    }
  };
}
