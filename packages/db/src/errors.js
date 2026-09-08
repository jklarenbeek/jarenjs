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

/** The driver's own settlement envelope; arbitrary caller aggregates stay opaque. */
export class TransactionFailure extends AggregateError {
  /** @param {any} error @param {any} cleanupError */
  constructor(error, cleanupError) {
    super([error, cleanupError], 'the transaction failed, and rolling it back failed too');
  }
}

/**
 * The runtime code table (the `CSV_CODES` shape): one entry per code
 * this package can raise, proven in sync with MODEL-FORMAT.md §7's
 * normative table by a test.
 */
export const DB_CODES = Object.freeze({
  JD0001: 'the SQLite library is below the supported floor',
  JD0002: 'the existing database disagrees with the declared model, or the open failed in the driver',
  JD0003: 'the driver binding is unavailable on this runtime',
  JD0004: 'a declared index cannot be mapped to a column',
  JD0005: 'the model document is invalid',
  JD0006: 'an open option named a pragma this store does not configure',
  JD0007: 'the pragma cannot be applied on this driver or store',
  JD0008: 'a pragma did not take: the read-back disagrees with the request',
  JD0010: 'strict mode refused a residual',
  JD0011: 'the profile refused the document',
  JD0012: 'work waited too long for the open transaction to settle',
  JD0030: 'an unknown x-entity member was declared',
  JD0031: 'relation declarations contradict each other',
  JD0032: 'the include specification is invalid',
  JD0033: 'an entity query names no entity array',
  JD0034: 'a tracked cursor needs a bare entity return',
  JD0035: 'the continuation does not belong to this ordering',
  JD0036: 'a snapshot page needs an immutable ordering',
  JD0037: 'strictStreaming refused a plan that buffers',
  JD0040: 'the save spans a relation cycle',
  JD0050: 'live queries require change capture',
  JD0051: 'the demanded live mode is unavailable',
  JD0052: 'the live-query bound was reached',
  JD0053: 'the live event-time declaration is invalid',
  JD0060: 'the replication document is invalid',
  JD2100: 'replication encountered a sequence or causal gap',
  JD2101: 'an envelope identity has a different payload or origin',
  JD2102: 'the replica identity or model revision disagrees',
  JD2103: 'the conflict resolver returned an invalid decision',
  JD2104: 'a logical row disagrees with its replication history',
  JD2105: 'replication requires an explicit snapshot reset',
  JD2106: 'replication exceeded its operation bound',
  JD0020: "the migration's from-shape does not match the database",
  JD0021: 'the migration is missing a required data transform',
  JD0022: 'an applied migration disagrees with the history record',
  JD0023: 'a migration step failed',
  JD0024: 'a document source or target could not be read or written',
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
  JD2063: 'the store is closed',
  JD2064: 'the call was aborted while it waited for the open transaction',
  JD2065: 'the job is not leased — it is unknown, or already settled',
  JD2066: 'the lease was superseded by a newer claim or renewal',
  JD2067: 'the lease expired before the call',
  JD2068: 'a settling call needs the lease the claim returned',
  JD2069: 'a resumed run does not match the workflow or input it was checkpointed under',
  JD2070: 'the transaction handle does not belong to the live scope',
  JD2071: 'the savepoint label is blank, duplicate or unknown',
  JD2072: 'the call was aborted before its next row',
  JD2073: 'an include exceeded its per-root bound',
  JD2074: 'an item exceeds the page byte bound',
  JD2075: 'the deadline passed before the next unit of work',
  JD2076: 'an item exceeds the profile byte bound',
  JD2077: 'the maintenance operation is unavailable on this store',
  JD2078: 'the maintenance operation failed',
  JD2079: 'the backup was cancelled',
  JD2080: 'the migration was cancelled between steps',
  JD2081: 'the maintenance operation was cancelled',
  JD2082: 'the database or its disk is full',
  JD2083: 'the database is read-only',
  JD2084: 'a disk I/O error',
  JD2085: 'the database file is corrupt or not a database',
  JD2086: 'a seek anchor came back with a type the plan did not declare',
  JD2087: 'the connection to the database was lost',
  JD2088: 'the transaction was aborted by an earlier failure in it',
  JD2089: 'the statement was cancelled by the server',
  JD2090: 'the worker connection generation was lost',
  JD2091: 'the worker admission queue is full',
  JD2092: 'a worker transport bound was exceeded',
  JD2093: 'the worker protocol frame is invalid',
  JD2094: 'the durable snapshot failed and the connection is invalid',
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
 *    the migration story, a later capability. Also a driver failure
 *    anywhere in the open sequence (an unopenable path, a corrupt or
 *    locked file): the error carries `class`/`retryable` from the
 *    classifier and the driver's error as `cause`
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
 *  - `JD0006` — an `openStore` option named a pragma outside the closed
 *    configurable set (`foreign_keys`, `page_size`, a snake-case
 *    spelling of a member); the reason names the option and the set
 *  - `JD0007` — a requested pragma cannot be applied here: the driver's
 *    binding does not declare it, or the store kind refuses it (a
 *    journal-mode write on a read-only store)
 *  - `JD0008` — a requested pragma did not take: the value read back
 *    from the connection after the open sequence disagrees with the
 *    request; the reason carries both, and the store did not open
 *  - `JD0010` — `strict: true` and part of the query would have run
 *    outside the database; the reason names the forcing construct
 *  - `JD0011` — the active profile refused the document before any
 *    execution: an undeclared external, host function, collation or
 *    collection, or a refused full-table scan; the reason names it
 *  - `JD0030` — an unknown member inside an `x-entity` block; a
 *    silently ignored mapping directive is a data-loss bug waiting
 *  - `JD0031` — two relation declarations whose inverses contradict
 *    (different `via`, impossible `many` pairings)
 *  - `JD0033` — a document handed to `store.execute()` over entities
 *    ranges over no declared entity array (`$.<Entity>[*]`); the root
 *    is the map of entity arrays, so there are no rows to answer
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
 *  - `JD0053` — a live query's `eventTime` names a member it does not
 *    admit, or a watermark/retention that is not a finite span
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
 *  - `JD2063` — a call after `close()`: every entry point of a closed
 *    store refuses by name rather than leaking the driver's own error,
 *    and a second `close()` is a no-op on every driver
 *  - `JD2077` — a maintenance operation (`checkpoint`, `integrityCheck`,
 *    `foreignKeyCheck`, `optimize`, `backupTo`) is unavailable here:
 *    the driver's binding does not declare it, or the store is read-only
 *    and the operation writes; `capabilities.maintenance` says which
 *  - `JD2078` — a maintenance operation failed in the driver; the
 *    original error is the `cause`. Corruption an integrity check finds
 *    is its RESULT, never this error
 *  - `JD2079` — a backup was cancelled through its signal between
 *    pages: the temporary file was removed and the target path was not
 *    written; the signal's reason is the `cause`
 *  - `JD2080` — a migration was cancelled through its signal between
 *    migrations, steps or batches: the migration in flight rolled back
 *    whole, the completed ones stand, a rerun resumes from the recorded
 *    position
 *  - `JD2081` — a maintenance operation was cancelled through its signal
 *    before its statement ran
 *  - `JD2086` — a seek anchor came back from the database with a type
 *    the plan did not declare: the plan reads an anchor from a column
 *    of declared type and binds it through a TYPED slot, so a value of
 *    another type is a defect below the store, refused before the
 *    statement it would have bound runs
 *  - `JD2082`/`JD2083`/`JD2084`/`JD2085` — the driver reported a full
 *    disk, a read-only database, an I/O error, a corrupt file: one
 *    classifier (`classifyDriverError`) assigns them, whichever path met
 *    the failure, and every classified error carries `class`,
 *    `retryable` and the driver's error as `cause`; a busy or locked
 *    database stays `JD2005` with `class: 'busy'` and `retryable: true`
 */

/**
 * The ONE classification of a driver failure. Every path that
 * wraps a driver error — the collection and entity writes, the job
 * queue, the query path, the maintenance operations, the backup, the
 * open sequence — consults this table and nothing else, so a locked
 * database, a full disk, a read-only file, an I/O error and a corrupt
 * file each arrive under one code with one stable `class` and one
 * `retryable` verdict, whichever path met them.
 *
 * The engine's primary result code is the low byte of the extended
 * one the bindings expose (`errcode` on node:sqlite, `errno` on
 * bun:sqlite, `resultCode` on the wasm build's `SQLite3Error`); the
 * message is consulted for the two facts a code alone does not carry —
 * an int64 overflow is a generic `SQLITE_ERROR` (1) with the words
 * `integer overflow`, and a duplicate key is a UNIQUE constraint whose
 * message names the table and column.
 *
 * The engine is discriminated by the EVIDENCE the error carries, not by
 * a table threaded down from the caller: a SQLite binding attaches a
 * numeric result code, a PostgreSQL one attaches a five-character
 * SQLSTATE. Both land in the same closed set of classes and the same
 * `retryable` verdict, so a caller that already handles a busy SQLite
 * database handles a deadlocked PostgreSQL transaction with no new
 * branch. Neither table ever reads a connection string, so nothing a
 * URL carried can reach a message.
 */

/** SQLite primary result codes, by name, as the table reads them. */
const RESULT = Object.freeze({
  ERROR: 1, BUSY: 5, LOCKED: 6, READONLY: 8, IOERR: 10, CORRUPT: 11, FULL: 13,
  CANTOPEN: 14, CONSTRAINT: 19, NOTADB: 26,
});

/**
 * The classes, in the order they are tried; `code` is the runtime code
 * a wrapped error carries (`null` for the overflow row, which the query
 * path answers by re-running the document in the engine rather than by
 * raising) and `reason` the sentence the wrapped error leads with.
 */
const CLASSES = Object.freeze([
  Object.freeze({ class: 'busy', primaries: [RESULT.BUSY, RESULT.LOCKED], code: 'JD2005',
    retryable: true, reason: 'the database is busy or locked' }),
  Object.freeze({ class: 'full', primaries: [RESULT.FULL], code: 'JD2082',
    retryable: false, reason: 'the database or its disk is full' }),
  Object.freeze({ class: 'readonly', primaries: [RESULT.READONLY], code: 'JD2083',
    retryable: false, reason: 'the database is read-only' }),
  Object.freeze({ class: 'io', primaries: [RESULT.IOERR], code: 'JD2084',
    retryable: false, reason: 'a disk I/O error' }),
  Object.freeze({ class: 'corrupt', primaries: [RESULT.CORRUPT, RESULT.NOTADB], code: 'JD2085',
    retryable: false, reason: 'the database file is corrupt or not a database' }),
  Object.freeze({ class: 'cantopen', primaries: [RESULT.CANTOPEN], code: 'JD2005',
    retryable: false, reason: 'the database file could not be opened' }),
  Object.freeze({ class: 'constraint', primaries: [RESULT.CONSTRAINT], code: 'JD2005',
    retryable: false, reason: 'the database rejected the operation' }),
]);

const FALLBACK = Object.freeze({ class: 'error', code: 'JD2005', retryable: false,
  reason: 'the database rejected the operation' });

/**
 * PostgreSQL SQLSTATEs, into the SAME classes. Exact codes first, then
 * the two-character class for everything else in a family — which is
 * how a server-side condition nobody enumerated still lands somewhere
 * honest rather than in the fallback.
 *
 * `duplicate` is decided by the calling path, exactly as it is on
 * SQLite: a `unique_violation` is only the KEY's collision when the
 * constraint the server names is the key's own.
 */
const SQLSTATE = Object.freeze({
  // 23 — integrity constraint violation
  '23505': { class: 'constraint', code: 'JD2005', retryable: false,
    reason: 'the database rejected the operation' },
  // 40 — transaction rollback: both are the caller's to retry
  '40001': { class: 'busy', code: 'JD2005', retryable: true,
    reason: 'the transaction could not be serialized' },
  '40P01': { class: 'busy', code: 'JD2005', retryable: true,
    reason: 'the transaction deadlocked' },
  // 55 — object not in prerequisite state
  '55P03': { class: 'busy', code: 'JD2005', retryable: true,
    reason: 'the database is busy or locked' },
  '55006': { class: 'busy', code: 'JD2005', retryable: true,
    reason: 'the database is busy or locked' },
  // 57 — operator intervention
  '57014': { class: 'cancelled', code: 'JD2089', retryable: false,
    reason: 'the statement was cancelled by the server' },
  '57P01': { class: 'connection', code: 'JD2087', retryable: true,
    reason: 'the connection to the database was lost' },
  '57P02': { class: 'connection', code: 'JD2087', retryable: true,
    reason: 'the connection to the database was lost' },
  '57P03': { class: 'connection', code: 'JD2087', retryable: true,
    reason: 'the connection to the database was lost' },
  // 53 — insufficient resources
  '53100': { class: 'full', code: 'JD2082', retryable: false,
    reason: 'the database or its disk is full' },
  '53300': { class: 'busy', code: 'JD2005', retryable: true,
    reason: 'the database is busy or locked' },
  // 58 — system error
  '58030': { class: 'io', code: 'JD2084', retryable: false, reason: 'a disk I/O error' },
  // 25 — invalid transaction state
  '25P02': { class: 'aborted', code: 'JD2088', retryable: false,
    reason: 'the transaction was aborted by an earlier failure in it' },
  '25006': { class: 'readonly', code: 'JD2083', retryable: false,
    reason: 'the database is read-only' },
  // 3D/3F — the catalog or schema the connection named does not exist
  '3D000': { class: 'cantopen', code: 'JD2005', retryable: false,
    reason: 'the database could not be opened' },
  '3F000': { class: 'cantopen', code: 'JD2005', retryable: false,
    reason: 'the database could not be opened' },
  // 42501 — insufficient privilege reads as read-only: the operation is
  // refused for want of write rights, which is what the class means
  '42501': { class: 'readonly', code: 'JD2083', retryable: false,
    reason: 'the database is read-only' },
  // XX — internal error
  'XX001': { class: 'corrupt', code: 'JD2085', retryable: false,
    reason: 'the database file is corrupt or not a database' },
  'XX002': { class: 'corrupt', code: 'JD2085', retryable: false,
    reason: 'the database file is corrupt or not a database' },
});

/** The family fallbacks, by SQLSTATE class (the first two characters). */
const SQLSTATE_FAMILY = Object.freeze({
  '23': { class: 'constraint', code: 'JD2005', retryable: false,
    reason: 'the database rejected the operation' },
  '40': { class: 'busy', code: 'JD2005', retryable: true,
    reason: 'the transaction could not be completed' },
  '08': { class: 'connection', code: 'JD2087', retryable: true,
    reason: 'the connection to the database was lost' },
  '53': { class: 'full', code: 'JD2082', retryable: false,
    reason: 'the database or its disk is full' },
  '55': { class: 'busy', code: 'JD2005', retryable: true,
    reason: 'the database is busy or locked' },
  '57': { class: 'connection', code: 'JD2087', retryable: true,
    reason: 'the connection to the database was lost' },
  '58': { class: 'io', code: 'JD2084', retryable: false, reason: 'a disk I/O error' },
  'XX': { class: 'corrupt', code: 'JD2085', retryable: false,
    reason: 'the database file is corrupt or not a database' },
});

/** A five-character SQLSTATE, or `null` for an error that carries none. */
const SQLSTATE_SHAPE = /^[0-9A-Z]{5}$/;

/**
 * @param {any} error
 * @returns {string | null}
 */
function sqlStateOf(error) {
  if (error === null || typeof error !== 'object') return null;
  const code = error.code;
  return typeof code === 'string' && SQLSTATE_SHAPE.test(code) ? code : null;
}

/**
 * The numeric result code a binding attached, or `null` for an error
 * that is not a driver's.
 * @param {any} error
 * @returns {number | null}
 */
function resultCodeOf(error) {
  if (error === null || typeof error !== 'object') return null;
  for (const member of ['errcode', 'errno', 'resultCode']) {
    const value = error[member];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return null;
}

/**
 * Whether an error is a SQLite driver's own: it carries a numeric
 * result code, or the shape node:sqlite gives its errors.
 * @param {any} error
 * @returns {boolean}
 */
export function isDriverError(error) {
  return resultCodeOf(error) !== null
    || sqlStateOf(error) !== null
    || error?.code === 'ERR_SQLITE_ERROR'
    || error?.name === 'SQLiteError' || error?.name === 'SQLite3Error';
}

/**
 * Classify a driver failure.
 * @param {any} error - the driver's error
 * @param {{ table: string, column: string }} [unique] - the unique key
 *   a write was inserting under, so its collision classifies as
 *   `duplicate` (the `JD2001` every insert path reports)
 * @returns {{ class: string, code: string | null, retryable: boolean, reason: string }}
 */
export function classifyDriverError(error, unique = undefined) {
  const state = sqlStateOf(error);
  if (state !== null) return classifySqlState(state, error, unique);
  const extended = resultCodeOf(error);
  const primary = extended === null ? null : extended & 0xff;
  const message = typeof error?.message === 'string' ? error.message : '';
  // the key's own collision: a PRIMARY KEY conflict (1555), or a UNIQUE
  // conflict whose message names the key column — a unique INDEX over
  // another column is a constraint failure, not a duplicate key
  if (unique !== undefined && (extended === 1555
    || (message.includes('UNIQUE constraint failed') && message.includes(`${unique.table}.${unique.column}`)))) {
    return { class: 'duplicate', code: 'JD2001', retryable: false, reason: 'the key is already present' };
  }
  if (primary === RESULT.ERROR && message.includes('integer overflow')) {
    return { class: 'overflow', code: null, retryable: false,
      reason: 'an integer aggregate overflowed int64' };
  }
  // a locked database reported by a binding that attaches no code
  if (primary === null && /database is locked|database table is locked/.test(message)) {
    return { ...CLASSES[0] };
  }
  for (const row of CLASSES) {
    if (primary !== null && row.primaries.includes(primary))
      return { class: row.class, code: row.code, retryable: row.retryable, reason: row.reason };
  }
  return { ...FALLBACK };
}

/**
 * The PostgreSQL half: a SQLSTATE into the same closed classes. The
 * server names the constraint it rejected against, so the key's own
 * collision is decided by NAME rather than by parsing a message —
 * `<table>_pkey` is the primary key a collection's key column carries,
 * and a unique INDEX over another column stays a constraint failure.
 * @param {string} state
 * @param {any} error
 * @param {{ table: string, column: string }} [unique]
 * @returns {{ class: string, code: string | null, retryable: boolean, reason: string }}
 */
function classifySqlState(state, error, unique) {
  if (state === '23505' && unique !== undefined) {
    const constraint = typeof error?.constraint === 'string' ? error.constraint : '';
    if (constraint === `${unique.table}_pkey` || constraint === `${unique.table}_${unique.column}_key`) {
      return { class: 'duplicate', code: 'JD2001', retryable: false,
        reason: 'the key is already present' };
    }
  }
  // an integer that will not fit the column: SQLite reports it as a
  // generic error naming the overflow, PostgreSQL as numeric_value_out_of_range
  if (state === '22003') {
    return { class: 'overflow', code: null, retryable: false,
      reason: 'an integer aggregate overflowed int64' };
  }
  const exact = SQLSTATE[state];
  if (exact !== undefined) return { ...exact };
  const family = SQLSTATE_FAMILY[state.slice(0, 2)];
  if (family !== undefined) return { ...family };
  return { ...FALLBACK };
}

/**
 * Wrap a driver failure as the coded runtime error its class calls
 * for, with `class` and `retryable` as own members and the original as
 * `cause`. Anything that is not a driver's own error — a coded refusal
 * of this package or of the query engine (a `JQ` error thrown inside a
 * pushed user function), an API-misuse `TypeError` — is the error, and
 * passes through untouched.
 * @param {any} error
 * @param {{ docPath?: string, collection?: string, key?: string | number,
 *   unique?: { table: string, column: string },
 *   duplicateReason?: string, code?: string, reason?: string,
 *   always?: boolean }} details - `duplicateReason` is the `JD2001`
 *   sentence the calling path composes (it names the key); `code` and
 *   `reason` let a lifecycle that owns its failure code (a maintenance
 *   operation's `JD2078`) keep its code and leading sentence while the
 *   class and the verdict still come from the one table; `always`
 *   wraps even a failure that is not a driver's (a closed handle's
 *   state error, a file-system refusal) under that lifecycle code, with
 *   `class: 'error'` — a lifecycle that promises a coded failure keeps
 *   the promise for every uncoded error it meets
 * @returns {Error}
 */
export function wrapDriverError(error, details = {}) {
  if (error instanceof TransactionFailure) {
    let first = error;
    const seen = new Set();
    while (first instanceof TransactionFailure) {
      if (seen.has(first)) return error;
      seen.add(first);
      first = first.errors[0];
    }
    const primary = wrapDriverError(first, details);
    if (typeof primary?.code === 'string' && /^J[A-Z]\d{4}$/.test(primary.code)) {
      // Keep the original and the cleanup failure together, while callers
      // continue to branch on the original classified failure and its cause.
      for (const member of ['code', 'reason', 'class', 'retryable', 'docPath', 'collection', 'key', 'cause']) {
        if (Object.hasOwn(primary, member)) error[member] = primary[member];
      }
    }
    return error;
  }
  if (typeof error?.code === 'string' && /^J[A-Z]\d{4}$/.test(error.code)) return error;
  if (!isDriverError(error)) {
    if (details.always !== true) return error;
    const generic = new DbRuntimeError(details.code ?? 'JD2005',
      `${details.reason ?? FALLBACK.reason}: ${error?.message ?? String(error)}`, { cause: error });
    generic.class = 'error';
    generic.retryable = false;
    return generic;
  }
  const classified = classifyDriverError(error, details.unique);
  const message = error?.message ?? String(error);
  /** @type {any} */
  const own = { cause: error };
  if (details.docPath !== undefined) own.docPath = details.docPath;
  if (details.collection !== undefined) own.collection = details.collection;
  if (details.key !== undefined) own.key = details.key;
  const wrapped = classified.class === 'duplicate'
    ? new DbRuntimeError('JD2001', details.duplicateReason ?? classified.reason, own)
    : new DbRuntimeError(details.code ?? classified.code ?? 'JD2005',
      `${details.reason ?? classified.reason}: ${message}`, own);
  wrapped.class = classified.class;
  wrapped.retryable = classified.retryable;
  return wrapped;
}

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

/** Cloneable driver errors keep the native classification fields.
 * @param {any} error @returns {any}
 */
export function cloneDriverError(error) {
  const out = { message: String(error?.message ?? error), name: String(error?.name ?? 'Error') };
  for (const key of ['code', 'errcode', 'errstr', 'errno', 'resultCode', 'class', 'retryable', 'generation', 'depth']) {
    const value = error?.[key];
    if (['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
  }
  return out;
}

/** Convert a returned SQLite C result into the one native error vocabulary.
 * @param {number} rc @param {string} operation
 */
export function sqliteResultError(rc, operation) {
  return Object.assign(new Error(`${operation} failed (${rc})`), { resultCode: rc });
}
