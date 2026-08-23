//@ts-check
/**
 * @file Error types for @jarenjs/db, built on `@jarenjs/core`'s coded
 * contract: every failure carries a stable `code` (JD0xxx compile-time,
 * JD2xxx runtime), a bare `reason`, a composed `message`, and — where a
 * position in the model document exists — a `docPath`. Runtime errors
 * additionally carry the `collection` and, where one exists, the `key`
 * as own properties. Database errors are wrapped, never leaked raw: the
 * reason keeps the original text, `cause` keeps the original error. The
 * normative table lives in docs/MODEL-FORMAT.md §7, proven in sync with
 * `DB_CODES` below by a test.
 */

import { CodedError } from '@jarenjs/core/errors';

/**
 * The runtime code table (the `CSV_CODES` shape): one entry per code
 * this package can raise, proven in sync with MODEL-FORMAT.md §7's
 * normative table by a test.
 */
export const DB_CODES = Object.freeze({
  JD0001: 'the SQLite library is below the supported floor',
  JD0002: 'the declared model disagrees with the existing database',
  JD0003: 'the driver binding is unavailable on this runtime',
  JD0004: 'a declared index cannot be mapped to a column',
  JD0005: 'the model document is invalid',
  JD0010: 'strict mode refused a residual',
  JD0011: 'the profile refused the document',
  JD0012: 'work waited too long for the open transaction to settle',
  JD0030: 'an unknown x-entity member was declared',
  JD0031: 'relation declarations contradict each other',
  JD0032: 'the include specification is invalid',
  JD0040: 'the save spans a relation cycle',
  JD0050: 'live queries require change capture',
  JD0051: 'the demanded live mode is unavailable',
  JD0052: 'the live-query bound was reached',
  JD0020: "the migration's from-shape does not match the database",
  JD0021: 'the migration is missing a required data transform',
  JD0022: 'an applied migration disagrees with the history record',
  JD0023: 'a migration step failed',
  JD2001: 'insert found the key already present',
  JD2002: 'a usable key could not be resolved for the write',
  JD2003: 'the write failed schema validation',
  JD2004: 'an undeclared collection was requested',
  JD2005: 'a database operation failed',
  JD2006: 'patch found no document at the key',
  JD2007: 'the result exceeded the profile row bound',
  JD2040: 'the row changed under an optimistic update',
  JD2050: 'a changeset could not be decoded',
  JD2051: 'the change log is not enabled',
  JD2060: 'the maintained live state exceeded its bound',
  JD2061: 'another context owns the database',
  JD2062: 'the store closed with job handlers still in flight',
});

/**
 * A defect found while opening a store — in the model document, the
 * declared indexes, the driver binding, or the database's agreement
 * with the declaration. Codes:
 *
 *  - `JD0001` — the SQLite library reported a version below the
 *    supported floor; the reason names the version found
 *  - `JD0002` — a declared collection already exists in the database
 *    with a different shape; nothing was altered — changing shape is
 *    the migration story, a later capability
 *  - `JD0003` — the runtime builtin behind a driver could not be
 *    loaded here (Node cannot resolve `bun:`; Bun ships no
 *    `node:sqlite`), or an injected handle is missing
 *  - `JD0004` — a declared index cannot be mapped to a column: its
 *    path does not select exactly one member (wildcards, slices,
 *    filters and descendants are not indexable), or its `derive`
 *    declaration is not one the storage vocabulary carries; the reason
 *    names the expression or the member and `docPath` points at it
 *  - `JD0005` — the model document is invalid; `docPath` points at
 *    the offending member
 *  - `JD0010` — `strict: true` and part of the query would have run
 *    outside the database; the reason names the forcing construct
 *  - `JD0011` — the active profile refused the document before any
 *    execution: an undeclared external, host function, collation or
 *    collection, or a refused full-table scan; the reason names it
 *  - `JD0030` — an unknown member inside an `x-entity` block; a
 *    silently ignored mapping directive is a data-loss bug waiting
 *  - `JD0031` — two relation declarations whose inverses contradict
 *    (different `via`, impossible `many` pairings)
 *  - `JD0032` — a graph-load include specification is invalid: an
 *    unknown relation, a cycle, an untranslatable filter, or the
 *    depth bound exceeded (the bound is printed, never silent)
 *  - `JD0040` — `saveChanges()` cannot order its statements: the
 *    entities being inserted or deleted form a foreign-key cycle
 *    (self-references included); break the save in two
 *  - `JD0050` — a live query was registered on a store opened without
 *    `capture`; the patch stream is the invalidation source
 *  - `JD0051` — `mode: 'incremental'` was demanded but the document
 *    classifies as re-run; the reason names the forcing construct
 *  - `JD0052` — registering would exceed the store's `live.maxQueries`
 *    bound; the bound is printed, never silent
 *  - `JD0020` — a migration's `from` hash does not match the
 *    database's recorded shape; running it would corrupt
 *  - `JD0021` — a draft transform was not filled in, or a document no
 *    longer validates after the migration (a narrowing without an
 *    adequate transform)
 *  - `JD0022` — the migration list disagrees with the applied history
 *    (an edited file, a missing file, a reordered sequence)
 *  - `JD0023` — a step failed: an assertion returned rows, DDL was
 *    rejected, or a transform produced an unstorable value
 */
export class DbCompileError extends CodedError {
  /**
   * @param {string} code
   * @param {string} reason - The bare reason; `message` is composed per
   *   the coded contract.
   * @param {string} [docPath] - JSON Pointer into the model document,
   *   where one exists.
   * @param {Error} [cause]
   */
  constructor(code, reason, docPath, cause) {
    super('DbCompileError', code, reason, docPath,
      cause !== undefined ? { cause } : undefined);
  }
}

/**
 * A failure while reading or writing an open store. Codes:
 *
 *  - `JD2001` — `insert` hit a document already stored under the key
 *  - `JD2002` — the declared key pointer resolved to nothing or to a
 *    non-scalar, or an explicit key argument is not a string or number
 *  - `JD2003` — the injected validation hook rejected the document
 *    that a write would have stored; `errors` carries the hook's
 *    findings when it produced any
 *  - `JD2004` — `collection()` named a collection the model does not
 *    declare
 *  - `JD2005` — the database rejected an operation for a reason that
 *    is not a duplicate key; the original error is the `cause`
 *  - `JD2006` — `patch` addressed a key with no stored document
 *  - `JD2007` — a fetch crossed the profile's `maxRows` bound; the
 *    result is refused whole, never silently truncated
 *  - `JD2040` — an optimistic update or delete matched no row: the
 *    declared version changed under the save (or the row is gone);
 *    the error names the entity and key, and the whole save rolled
 *    back
 *  - `JD2050` — a session changeset carried bytes this decoder does
 *    not recognise (a future SQLite format change would land here)
 *  - `JD2051` — `changesSince` was called on a store whose capture
 *    has no persisted log
 *  - `JD2060` — maintenance crossed the live query's `maxMaintained`
 *    bound; the query delivered this error and closed rather than
 *    degrade
 *  - `JD2061` — a second context tried to open a database whose
 *    storage grants one context exclusive access (the owner topology
 *    of LIVE-FORMAT §11); connect to the owner instead
 */
export class DbRuntimeError extends CodedError {
  /**
   * @param {string} code
   * @param {string} reason - The bare reason; `message` is composed per
   *   the coded contract.
   * @param {{ docPath?: string, collection?: string,
   *   key?: string | number, errors?: unknown[], cause?: unknown }} [details]
   *   - `docPath` points into the model document (the collection the
   *   failure belongs to); `collection`/`key` are installed as own
   *   properties; `errors` carries validation findings; `cause` follows
   *   the coded contract's `hasOwn` form.
   */
  constructor(code, reason, details = undefined) {
    super('DbRuntimeError', code, reason,
      details?.docPath !== undefined ? { docPath: details.docPath } : undefined,
      details !== undefined && Object.hasOwn(details, 'cause')
        ? { cause: details.cause }
        : undefined);
    if (details?.collection !== undefined) this.collection = details.collection;
    if (details?.key !== undefined) this.key = details.key;
    if (details?.errors !== undefined) this.errors = details.errors;
  }
}
