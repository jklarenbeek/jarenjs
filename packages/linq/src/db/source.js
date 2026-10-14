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
 * twin, the client's handle spread from one): its kind, its name and the
 * database its store reads (a file's canonical name, a PostgreSQL server,
 * database and schema, or a token of the store's own for a database no
 * second store can name). The comparison is by name and by that value,
 * never by view object: a chain from a transaction's view, from the
 * synchronous twin, or from another client over the same database, runs
 * the right rows and is taken, while a chain over the same-named source
 * of a store over another database is refused. A chain over an
 * empty array (`from([])`, the document builder) names no rows and is
 * taken, and so is a provider that carries no source (one written by
 * hand). Rows whose count cannot be read without consuming them (a
 * generator, an async iterable, a cursor, a push queue, another chain)
 * are refused by their kind, never by reading them: they may hold rows
 * the handle would ignore.
 */

import { STORE_SOURCE } from '@jarenjs/db';

import { LinqBuildError } from '../errors.js';

/**
 * How many rows an in-memory source holds, where that is known without
 * reading it: an array, a string, a typed array, a Set or a Map.
 * @param {any} rows
 * @returns {number | undefined} `undefined` for any other source, which
 *   is not read to find out
 */
function countOf(rows) {
  if (Array.isArray(rows) || typeof rows === 'string' || ArrayBuffer.isView(rows)) {
    return /** @type {any} */ (rows).length;
  }
  if (rows instanceof Set || rows instanceof Map) return rows.size;
  return undefined;
}

/**
 * A handle's refusal of a chain built over another source than its own
 * (`JL0005`): another collection or entity, by name, the same-named one
 * of a store over another database, by the database its store reads, or
 * rows in memory — any but a countable empty set of them.
 * @param {any} provider - the store view the handle fronts, carrying its
 *   own source under `STORE_SOURCE`
 * @param {string} method - the member the chain was handed to
 * @returns {(built: { source: any, rows: any }) => void}
 */
export function onlyOwnSource(provider, method) {
  const own = provider[STORE_SOURCE];
  const handed = `${method}() on ${own.kind} '${own.name}' was handed a chain built over`;
  const elsewhere = 'a chain runs against the source it was built over; build it from this handle, '
    + 'or hand it to the handle it was built from';
  return ({ source, rows }) => {
    const key = source?.[STORE_SOURCE];
    // names are unique across kinds (two objects of one database cannot
    // share a table name), so the name and the store settle which it is
    if (key !== undefined && key.name !== own.name) {
      throw new LinqBuildError('JL0005', `${handed} ${key.kind} '${key.name}' — ${elsewhere}`);
    }
    if (key !== undefined && key.store !== own.store) {
      throw new LinqBuildError('JL0005', `${handed} ${key.kind} '${key.name}' of another store — ${elsewhere}`);
    }
    if (rows === null) return;
    const count = countOf(rows);
    if (count === 0) return;
    const held = count === undefined ? 'rows in memory it cannot count without reading them'
      : `${count === 1 ? '1 row' : `${count} rows`} in memory`;
    throw new LinqBuildError('JL0005',
      `${handed} ${held} — `
      + "a handle runs a chain's document over its own rows, never the chain's; build it from "
      + 'this handle (or from([]) to write a document), or run it over its rows with toArray()');
  };
}

/**
 * The client's own `live()` refusal of a chain built over another store
 * (`JL0005`): it takes a chain over any entity of its store, so only the
 * database its store reads is compared. The client has `live()` only when the
 * model declares entities, so the store's first entity names it.
 * @param {any} view - the store view the client fronts (the root store,
 *   or the one a transaction callback received)
 * @returns {(built: { source: any, rows: any }) => void}
 */
export function onlyThisStore(view) {
  const own = view.entity(view.roots[0])[STORE_SOURCE].store;
  return ({ source }) => {
    const key = source?.[STORE_SOURCE];
    if (key !== undefined && key.store !== own) {
      throw new LinqBuildError('JL0005',
        `live() on the client was handed a chain built over ${key.kind} '${key.name}' of another store — `
        + "a chain runs against the store it was built over; build it from this client's handles, "
        + 'or hand it to the client it was built from');
    }
  };
}
