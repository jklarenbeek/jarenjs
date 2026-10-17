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
  JD0004: 'a declared index cannot be mapped to a column, or a planned name is longer than the engine holds (PostgreSQL: 63 bytes, refused when the model is planned), or an index would take a name PostgreSQL gives one of the table\'s own objects',
  JD0005: 'the model document is invalid',
  JD0006: 'an open option named a pragma this store does not configure',
  JD0007: 'the pragma cannot be applied on this driver or store',
  JD0008: 'a pragma did not take: the read-back disagrees with the request',
  JD0009: 'an open option is outside the closed set openStore reads, or its value is malformed',
  JD0010: 'strict mode refused a residual',
  JD0011: 'the profile refused the document',
  JD0012: 'work waited too long for the connection a transaction or another call held',
  JD0013: 'an option passed to a store operation is not one it reads, or is malformed',
  JD0014: 'a transaction guarantee was requested where it cannot act',
  JD0015: 'owner was asked of an adopted store whose database has no owner table',
  JD0030: 'an unknown x-entity member was declared',
  JD0031: 'relation declarations contradict each other, or two many-to-many declarations that are not inverses name one join table',
  JD0032: 'the include specification is invalid',
  JD0033: 'an entity query names no entity array',
  JD0034: 'a tracked cursor needs a bare entity return',
  JD0035: 'the continuation does not belong to this ordering',
  JD0036: 'a snapshot page needs an immutable ordering',
  JD0037: 'strictStreaming refused a plan that buffers',
  JD0038: 'the native mutation document is unsupported or invalid',
  JD0039: 'a member that takes a query document was handed a chain',
  JD0040: 'the save spans a relation cycle',
  JD0041: 'a query document, or an external a comparison reads, is not JSON: a non-plain object with no own member to read, at its root or inside it',
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
  JD0020: 'migration endpoint mismatch',
  JD0021: 'migration precondition failed',
  JD0022: 'an applied migration disagrees with the history record',
  JD0023: 'a migration step failed',
  JD0024: 'a document source or target could not be read or written',
  JD0025: 'a migration host step is unknown, its version differs, or it appears where it cannot run',
  JD0026: 'an atomic migration run on SQLite contains a rebuild link',
  JD0027: 'a physical scope is malformed or names a table the plan does not own',
  JD0028: 'legacy migration authority needs attestation',
  JD2001: 'insert found the key already present, or the key is stored under two spellings',
  JD2002: 'a usable key could not be resolved for the write, or an explicit key disagrees with the document',
  JD2003: 'a value or staged operation violates its data contract',
  JD2004: 'an undeclared collection was requested',
  JD2005: 'a database operation failed',
  JD2006: 'patch found no document at the key',
  JD2007: 'the result exceeded the profile row bound',
  JD2040: 'an optimistic precondition did not hold: the row changed under an update, or an expect did not match',
  JD2041: 'tracked changes are pending; save or discard them first',
  JD2050: 'a changeset could not be decoded',
  JD2051: 'the change log is not enabled',
  JD2060: 'the maintained live state exceeded its bound',
  JD2061: 'another context owns the database, or another owner holds its lease',
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
  JD2090: 'the connection generation was lost, its cleanup expired, or a statement reached a parallel read that had ended',
  JD2091: 'host admission capacity was exhausted or acquisition expired',
  JD2092: 'a host transport or buffered result bound was exceeded',
  JD2093: 'the worker protocol frame is invalid',
  JD2094: 'the durable snapshot failed and the connection is invalid',
  JD2095: 'the trusted SQL or synchronous transaction authority was refused',
  JD2096: 'a persistence invariant rejected the mutation',
  JD2097: 'the supervised operation was cancelled or exceeded its response deadline',
  JD2098: 'the transaction held its connection past its hold limit and was rolled back',
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
 *    classifier and the driver's error as `cause`. Also a SQLite
 *    database whose text encoding is not UTF-8 (its BINARY order is
 *    code point order only over UTF-8; the encoding is named)
 *  - `JD0003` — the runtime builtin behind a driver could not be
 *    loaded here (Node cannot resolve `bun:`; a runtime without
 *    `node:sqlite` cannot load the Node binding), an injected handle is
 *    missing, a host runs only on another runtime (the supervised
 *    process host is Node's; the reason names both runtimes), or a
 *    worker endpoint stopped before it was ready — a bundle that left
 *    the endpoint behind; the reason names its URL and `retryable` is
 *    `false`, because a reopen meets the same missing module
 *  - `JD0004` — a declared index cannot be mapped to a column: its
 *    path does not select exactly one member (wildcards, slices,
 *    filters and descendants are not indexable), or its `derive`
 *    declaration is not one the storage vocabulary carries; the reason
 *    names the expression or the member and `docPath` points at it. It is
 *    also a name the plan gives a table, a column or an index that the
 *    engine cannot hold whole (`dialect.maxIdentifierBytes`: PostgreSQL
 *    keeps 63 bytes of an identifier and truncates a longer one silently),
 *    refused when the model is planned — before any statement — at the
 *    model member the name comes from; SQLite holds a name of any length.
 *    So is a collection, entity or join table named like one of the
 *    engine's own tables (`_jaren_migrations`, `_jaren_jobs`, …), and an
 *    index the plan would name as the engine names one of the
 *    table's own objects (`dialect.ownRelationNames`: PostgreSQL's
 *    `<table>_pkey` and `<table>_<column>_seq`), which the open would skip
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
 *  - `JD0009` — an `openStore` option outside the closed set the store
 *    reads (the reason names it and the nearest member), or one whose
 *    value is malformed (`queueTimeout: Infinity`, `capture: 'false'`,
 *    `jobs: null`, a misspelt `transactions`); refused before the driver
 *    opens, so no file is created and no handle is held
 *  - `JD0013` — an option passed to a store operation — a transaction's
 *    `mode`, `signal`, `unitOfWork`, `isolation` — is not one it reads
 *    (named, with the nearest member), or its value is malformed; refused
 *    before the operation begins
 *  - `JD0014` — a transaction guarantee requested where it cannot act:
 *    `unitOfWork` or `isolation` on a nested transaction (a savepoint
 *    writes through the unit of work around it and runs at its root's
 *    level), `mode: 'immediate'` inside a transaction that did not take
 *    the writer lock, and `retry` or `holdTimeoutMs` on the synchronous
 *    twin or a nested transaction
 *  - `JD0015` — `owner` on an adopted SQLite store whose database has no
 *    owner table: adoption creates nothing, so the operator creates it
 *    once with the statement the reason names
 *  - `JD0010` — `strict: true` and part of the query would have run
 *    outside the database; the reason names the forcing construct
 *  - `JD0011` — the active profile refused the document before any
 *    execution: an undeclared external, host function, collation or
 *    collection, or a refused full-table scan; the reason names it
 *  - `JD0030` — an unknown member inside an `x-entity` block; a
 *    silently ignored mapping directive is a data-loss bug waiting
 *  - `JD0031` — two relation declarations whose inverses contradict
 *    (different `via`, impossible `many` pairings), or two many-to-many
 *    declarations that are not each other's inverse and name one join table
 *  - `JD0033` — a document handed to `store.execute()` or `store.live()`
 *    over entities ranges over no declared entity array (`$.<Entity>[*]`);
 *    the root is the map of entity arrays, so there are no rows to answer
 *  - `JD0039` — a member that takes a query document (`execute`,
 *    `query`, `explain`, `live`, an entity set's and the store's alike)
 *    was handed a `@jarenjs/linq` chain (anything with `toDocument()`):
 *    the reason names the member and the chain's own document
 *  - `JD0032` — a graph-load include specification is invalid: an
 *    unknown relation, a cycle, an untranslatable filter, or the
 *    depth bound exceeded (the bound is printed, never silent); or a
 *    keyset continuation is not qualified: over a view, a codec whose
 *    decoded value does not compare as the stored one, a text key that
 *    does not survive its SQLite text encoding, or a text term of a
 *    database whose encoding is not UTF8 (named)
 *  - `JD0040` — `saveChanges()` cannot order its statements: the
 *    entities being inserted or deleted form a foreign-key cycle
 *    (self-references included); break the save in two
 *  - `JD0041` — a member that takes a query document was handed an
 *    object whose prototype is neither `Object.prototype` nor `null` and
 *    which has no own enumerable member (a `Date`, a `Map`), the reason
 *    naming the member; or a document holds, at any depth, such an object
 *    (a `Date` in a `$where`), which the compiler read as `{}` — the
 *    `docPath` names where; or an external a comparison reads (a direct
 *    operand of `$eq $ne $lt $le $gt $ge`, in the document or the store
 *    profile's predicate) holds one, which it reads otherwise than the
 *    JSON value it stands for (a `Date` by its instant, never equal to a
 *    stored date-time's text; a `Map` as `{}`) — the reason names the
 *    external and how it is read, the `docPath` the comparison
 *  - `JD0050` — a live query was registered on a store opened without
 *    `capture`; the patch stream is the invalidation source
 *  - `JD0051` — `mode: 'incremental'` was demanded but the document
 *    classifies as re-run, or a maintained view can no longer answer what a
 *    fresh run does (an integer accumulator past its exactness bound); the
 *    reason names the forcing construct
 *  - `JD0052` — registering would exceed the store's `live.maxQueries`
 *    bound; the bound is printed, never silent
 *  - `JD0053` — a live query's `eventTime` names a member it does not
 *    admit, or a watermark/retention that is not a finite span
 *  - `JD0020` — a migration endpoint does not match its exact
 *    baseline, adjacent endpoint or attested model boundary
 *  - `JD0021` — a draft transform was not filled in, or a document no
 *    longer validates after the migration (a narrowing without an
 *    adequate transform), or a PostgreSQL writer lacks READ COMMITTED
 *  - `JD0022` — the migration list disagrees with the applied history
 *    (an edited file, a missing file, a reordered sequence)
 *  - `JD0023` — a step failed: an assertion returned rows, DDL was
 *    rejected, or a transform produced an unstorable value — classified
 *    (`class`, `retryable`) like every driver failure
 *  - `JD0025` — a migration host step has no registered host, a host
 *    whose version differs, or runs where there is no transaction (a
 *    documents-only migration)
 *  - `JD0026` — an `atomic` run on SQLite holds a link that rebuilds a table
 *    (the rebuild changes connection settings outside any transaction)
 *  - `JD0027` — a physical plan's `scope` is malformed, or names a table
 *    the plan does not own
 *  - `JD0028` — legacy history needs explicit attestation, or pending
 *    work must be authored as an exact 0.2 migration
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
 *  - `JD2003` — a value or staged operation violates its data contract;
 *    `errors` carries the injected validation hook's findings when it
 *    produced any, and `cause` retains a driver's unsafe-number refusal
 *  - `JD2004` — `collection()` named a collection the model does not
 *    declare
 *  - `JD2005` — the database rejected an operation for a reason that
 *    is not a duplicate key; the original error is the `cause`
 *  - `JD2006` — `patch` addressed a key with no stored document
 *  - `JD2007` — a fetch crossed the profile's `maxRows` bound; the
 *    result is refused whole, never silently truncated
 *  - `JD2040` — an optimistic precondition did not hold. A tracked
 *    update or delete matched no row: the declared version changed
 *    under the save (or the row is gone); the error names the entity
 *    and key, and the whole save rolled back. Or a collection write's
 *    `expect` did not match the stored document (MODEL-FORMAT §5):
 *    nothing was written
 *  - `JD2041` — SQL the store did not plan (trusted SQL, a relational
 *    write) was refused while tracked changes are pending: a later save
 *    would write over what the statement wrote — save or discard them
 *    first
 *  - `JD2050` — a session changeset carried bytes this decoder does
 *    not recognise (a future SQLite format change would land here)
 *  - `JD2051` — `changesSince` was called on a store whose capture
 *    has no persisted log
 *  - `JD2060` — maintenance crossed the live query's `maxMaintained`
 *    bound; the query delivered this error and closed rather than
 *    degrade
 *  - `JD2061` — a second context tried to open a database whose
 *    storage grants one context exclusive access (the owner topology
 *    of LIVE-FORMAT §11); connect to the owner instead. Also the owner
 *    lease (MODEL-FORMAT §5.1): an open with `owner` while another
 *    Store holds the lease (`owner` names it, `expiresAt` says until
 *    when; busy, retryable), and every call of a Store whose lease
 *    another holder took (not retryable — close it) or that lapsed and
 *    could not be renewed yet (retryable)
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

/** One classification shape for either driver's condition table.
 * @param {string} kind @param {string|null} code @param {boolean} retryable
 * @param {string} reason */
function classification(kind, code, retryable, reason) {
  return { class: kind, code, retryable, reason };
}

/** SQLite matches primary result codes before reporting the same classification.
 * @param {ReturnType<typeof classification>} result @param {number[]} primaries */
function sqliteClass(result, primaries) {
  return Object.freeze({ class: result.class, primaries, code: result.code,
    retryable: result.retryable, reason: result.reason });
}

const CORRUPT = Object.freeze(classification('corrupt', 'JD2085', false, DB_CODES.JD2085));
const IO = Object.freeze(classification('io', 'JD2084', false, DB_CODES.JD2084));
const CONNECTION = Object.freeze(classification('connection', 'JD2087', true, DB_CODES.JD2087));
const BUSY = Object.freeze(classification('busy', 'JD2005', true, 'the database is busy or locked'));
const FULL = Object.freeze(classification('full', 'JD2082', false, DB_CODES.JD2082));
const CONSTRAINT = Object.freeze(classification('constraint', 'JD2005', false, 'the database rejected the operation'));
const READONLY = Object.freeze(classification('readonly', 'JD2083', false, DB_CODES.JD2083));
const CANTOPEN = Object.freeze(classification('cantopen', 'JD2005', false, 'the database could not be opened'));

const DUPLICATE = Object.freeze(classification('duplicate', 'JD2001', false, 'the key is already present'));

const OVERFLOW = Object.freeze(classification('overflow', null, false, 'a numeric result left the range of its type'));

/**
 * The classes, in the order they are tried; `code` is the runtime code
 * a wrapped error carries (`null` for the overflow row, which has no code
 * of its own: a wrapped overflow is `JD2005`, and over the values the store
 * writes no pushed integer sum or average raises one, since each folds only
 * the terms its exactness guard admits)
 * and `reason` the sentence the wrapped error leads with.
 */
const CLASSES = Object.freeze([
  sqliteClass(BUSY, [RESULT.BUSY, RESULT.LOCKED]),
  sqliteClass(FULL, [RESULT.FULL]),
  sqliteClass(READONLY, [RESULT.READONLY]),
  sqliteClass(IO, [RESULT.IOERR]),
  sqliteClass(CORRUPT, [RESULT.CORRUPT, RESULT.NOTADB]),
  sqliteClass(classification('cantopen', 'JD2005', false, 'the database file could not be opened'), [RESULT.CANTOPEN]),
  sqliteClass(CONSTRAINT, [RESULT.CONSTRAINT]),
]);

const FALLBACK = Object.freeze(classification('error', 'JD2005', false, 'the database rejected the operation'));

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
  '23505': CONSTRAINT,
  // 40 — transaction rollback: both are the caller's to retry
  '40001': classification('busy', 'JD2005', true, 'the transaction could not be serialized'),
  '40P01': classification('busy', 'JD2005', true, 'the transaction deadlocked'),
  // 55 — object not in prerequisite state
  '55P03': BUSY,
  '55006': BUSY,
  // 57 — operator intervention
  '57014': classification('cancelled', 'JD2089', false, DB_CODES.JD2089),
  '57P01': CONNECTION,
  '57P02': CONNECTION,
  '57P03': CONNECTION,
  // 53 — insufficient resources
  '53100': FULL,
  '53300': BUSY,
  // 58 — system error
  '58030': IO,
  // 25 — invalid transaction state
  '25P02': classification('aborted', 'JD2088', false, DB_CODES.JD2088),
  '25006': READONLY,
  // 3D/3F — the catalog or schema the connection named does not exist
  '3D000': CANTOPEN,
  '3F000': CANTOPEN,
  // 42501 — insufficient privilege reads as read-only: the operation is
  // refused for want of write rights, which is what the class means
  '42501': READONLY,
  // XX — internal error
  'XX001': CORRUPT,
  'XX002': CORRUPT,
});

/** The family fallbacks, by SQLSTATE class (the first two characters). */
const SQLSTATE_FAMILY = Object.freeze({
  '23': CONSTRAINT,
  '40': classification('busy', 'JD2005', true, 'the transaction could not be completed'),
  '08': CONNECTION,
  '53': FULL,
  '55': BUSY,
  '57': CONNECTION,
  '58': IO,
  'XX': CORRUPT,
});

/** A five-character SQLSTATE, or `null` for an error that carries none. */
const SQLSTATE_SHAPE = /^[0-9A-Z]{5}$/;

/** A lost connection that carries no SQLSTATE: the socket's errno. */
const LOSS_ERRNO = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT',
  'ENOTCONN', 'EHOSTUNREACH', 'ENETUNREACH']);

/** …or node-postgres's own sentence for a connection it lost (it sets no code). */
const LOSS_MESSAGE = /^(Connection terminated( unexpectedly| due to connection timeout)?|Client has encountered a connection error and is not queryable|Client was closed and is not queryable)\b/;

/**
 * Whether a failure that carries no SQLSTATE is a lost connection — an
 * errno the socket raised, or node-postgres's uncoded sentence.
 * @param {any} error
 * @returns {boolean}
 */
function isUncodedLoss(error) {
  if (error === null || typeof error !== 'object' || sqlStateOf(error) !== null) return false;
  if (typeof error.code === 'string' && LOSS_ERRNO.has(error.code)) return true;
  return typeof error.message === 'string' && LOSS_MESSAGE.test(error.message);
}

/**
 * THE connection-loss rule (one home): SQLSTATE class 08 and
 * 57P01–57P03 (by the table), a socket errno (`ECONNRESET`, `EPIPE`, …)
 * and node-postgres's uncoded "Connection terminated …" all classify as
 * `JD2087`, class `connection`.
 * @param {any} error
 * @returns {boolean}
 */
export function isConnectionLoss(error) {
  return classifyDriverError(error).class === 'connection';
}

/**
 * Whether an error is a Jaren coded error, one that already names its
 * failure and passes the store's wrappers with its code. A canonicalization
 * refusal (`JsonCanonicalizeError`, a `TypeError` with a `JO` code) is not
 * one here: it names data a host handed over that is not JSON, and the
 * lifecycle that meets it keeps its own promised code (`JD0023`, `JD2078`),
 * the refusal with its code and `dataPath` as the `cause`. It is matched by
 * name, so a second copy of `@jarenjs/json` in a host's tree is matched too.
 * @param {any} error
 * @returns {boolean}
 */
export function isJarenCoded(error) {
  return typeof error?.code === 'string' && /^J[A-Z]\d{4}$/.test(error.code) && error.name !== 'JsonCanonicalizeError';
}

/**
 * A lost connection as the coded failure the store reports, with
 * `retryable` decided the way the process and worker hosts decide it:
 * `true` only when no transaction outcome is at stake (the loss came
 * before `BEGIN`, or during an autocommit read), `false` when a
 * transaction was open or its `COMMIT` was in flight — a retry could
 * then run work that already committed.
 * @param {any} cause
 * @param {{ outcomeAtStake: boolean }} context
 * @returns {DbRuntimeError}
 */
export function connectionLost(cause, context) {
  if (isJarenCoded(cause) && cause.code !== 'JD2087') return cause;
  const reason = typeof cause?.message === 'string' ? cause.message : String(cause);
  const error = cause?.code === 'JD2087' ? cause
    : new DbRuntimeError('JD2087', `${CONNECTION.reason}: ${reason}`, { cause });
  error.class = CONNECTION.class;
  error.retryable = context.outcomeAtStake !== true && (cause?.code !== 'JD2087' || cause.retryable !== false);
  return error;
}

/**
 * @param {any} error
 * @returns {string | null}
 */
function sqlStateOf(error) {
  if (error === null || typeof error !== 'object') return null;
  const code = error.code;
  // `EPIPE` has the shape of a SQLSTATE; no SQLSTATE class begins with
  // `E`, so an all-letter `E…` code is a socket errno, never a state
  return typeof code === 'string' && SQLSTATE_SHAPE.test(code) && !/^E[A-Z]{4}$/.test(code) ? code : null;
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

/** node:sqlite refuses to materialize an int64 that a Number would round,
 * and a driver that decodes a stored integer itself refuses one in the same
 * shape ({@link integerReadFailure}). Other host RangeErrors remain host
 * errors. @param {any} error */
const isIntegerReadFailure = (error) => error?.code === 'ERR_OUT_OF_RANGE'
  && typeof error.message === 'string'
  && /^Value is too large to be represented as a JavaScript number: -?\d+$/.test(error.message);

/**
 * The refusal of a stored integer that a JavaScript number would round,
 * spelled as node:sqlite raises it, so that every engine's read of one is
 * classified alike: `JD2003`, class `data`, not retryable.
 * @param {string} text - the stored integer's decimal digits, signed
 * @returns {Error}
 */
export function integerReadFailure(text) {
  const error = /** @type {any} */ (new RangeError(`Value is too large to be represented as a JavaScript number: ${text}`));
  error.code = 'ERR_OUT_OF_RANGE';
  return error;
}

/** Where a driver that decodes a stored number itself notes, on the row, each
 * column whose stored integer the number it hands back rounds — by the
 * stored digits. A column the store maps as an `integer` refuses such a value
 * ({@link refuseRoundedInteger}); a `number` reads the nearest double. */
export const ROUNDED_INTEGERS = Symbol('jaren.roundedIntegers');

/**
 * Refuse an `integer` column's value that its driver rounded
 * ({@link ROUNDED_INTEGERS}), as SQLite's driver refuses one.
 * @param {any} row @param {string} name - the column
 */
export function refuseRoundedInteger(row, name) {
  const text = row[ROUNDED_INTEGERS]?.[name];
  if (text !== undefined) throw integerReadFailure(text);
}

/**
 * The full decimal a double spells: its shortest spelling, with an
 * exponent (`1e+21`) written out as the digits it stands for.
 * @param {number} number
 * @returns {string}
 */
function spelledInFull(number) {
  const text = String(number);
  const exponent = /^(-?)(\d)(?:\.(\d+))?e\+(\d+)$/.exec(text);
  if (exponent === null) return text;
  const digits = exponent[2] + (exponent[3] ?? '');
  return exponent[1] + digits + '0'.repeat(Number(exponent[4]) - digits.length + 1);
}

/**
 * The digits of the integer a stored value holds when its JavaScript
 * number rounds it — the number is neither the stored integer nor spelled by
 * its digits (an integer past the double range is neither) — else `null`. An
 * integral value kept with a scale (`9007199254740993.0`, which a retype from
 * text leaves in a PostgreSQL `numeric`) is the integer its digits before the
 * point spell. Every integer within ±(2^53 - 1), every fraction, every
 * integer a double holds exactly (2^53 + 2, 2^60), and every integer a
 * JavaScript number wrote (its digits ARE that number's spelling: 2^60 is
 * written `1152921504606847000`, which is how the store writes it to a
 * PostgreSQL `numeric`) does not. The PostgreSQL driver reads a stored
 * `numeric` by this rule, and an included child's integer columns there are
 * held to it; a SQLite column holds the exact integer the store bound
 * ({@link storedIntegerNumber}).
 * @param {any} value - the stored value's text
 * @returns {string | null}
 */
export function roundedIntegerDigits(value) {
  const integral = typeof value === 'string' ? /^(-?\d+)(?:\.0+)?$/.exec(value) : null;
  if (integral === null) return null;
  const digits = integral[1];
  const number = Number(digits);
  return !Number.isSafeInteger(number)
    && !(Number.isFinite(number) && (BigInt(digits) === BigInt(number) || spelledInFull(number) === digits))
    ? digits : null;
}

/**
 * The number a stored 64-bit integer reads as: an integer a double holds
 * exactly (every one within ±(2^53 - 1), 2^53 + 2, 2^60 — every integer the
 * store writes, which binds a JavaScript number) reads as that number, and
 * any other is refused as node:sqlite refuses one past ±(2^53 - 1)
 * ({@link integerReadFailure}): the number would round it.
 * @param {bigint} value
 * @returns {number}
 */
export function storedIntegerNumber(value) {
  const number = Number(value);
  if (Number.isSafeInteger(number) || BigInt(number) === value) return number;
  throw integerReadFailure(String(value));
}

/** The text a database invariant's refusal starts with (MODEL-FORMAT §13). */
export const INVARIANT_MARKER = 'jaren invariant:';
/** The SQLSTATE a database invariant raises on PostgreSQL: class 23,
 * integrity constraint violation, with an implementation-defined subclass. */
export const INVARIANT_SQLSTATE = '23J01';
/** SQLite's extended result code for a trigger's `RAISE(ABORT, …)`. */
const SQLITE_CONSTRAINT_TRIGGER = 1811;

/**
 * Whether a driver error is a database invariant's own refusal. On
 * PostgreSQL that is its dedicated SQLSTATE; on SQLite, a trigger's
 * `RAISE` (the extended code `SQLITE_CONSTRAINT_TRIGGER`) whose own text
 * starts with the marker — a binding may put its result code in front of
 * that text, as the wasm build does. A value that merely quotes the
 * marker somewhere in a message (PostgreSQL quotes the input it could
 * not read) is never one.
 * @param {any} error
 * @returns {boolean}
 */
function isInvariantRefusal(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const state = sqlStateOf(error);
  if (state !== null) return state === INVARIANT_SQLSTATE && message.startsWith(INVARIANT_MARKER);
  if (resultCodeOf(error) !== SQLITE_CONSTRAINT_TRIGGER) return false;
  return message.replace(/^SQLITE_[A-Z_]+: sqlite3 result code \d+: /, '').startsWith(INVARIANT_MARKER);
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
    || error?.name === 'SQLiteError' || error?.name === 'SQLite3Error'
    || isUncodedLoss(error) || isIntegerReadFailure(error);
}

/** SQLite's extended result codes for a PRIMARY KEY and for a UNIQUE index conflict. */
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/**
 * Whether a SQLite UNIQUE message lists every one of `qualified`
 * (`table.column`) among the columns it names, in any order — each whole,
 * never as the prefix of a longer column name (`m.pid_seq` does not name
 * `m.pid`).
 * @param {string} message @param {string[]} qualified
 * @returns {boolean}
 */
function listsEvery(message, qualified) {
  const named = namedColumns(message) ?? [];
  return qualified.every((column) => named.includes(column));
}

/**
 * The `table.column` entries a SQLite UNIQUE message lists, or `null` for a
 * message that carries no listing.
 * @param {string} message
 * @returns {string[] | null}
 */
function namedColumns(message) {
  const at = message.indexOf('UNIQUE constraint failed:');
  if (at < 0) return null;
  return message.slice(at + 'UNIQUE constraint failed:'.length).split(',').map((part) => part.trim());
}

/**
 * The unique key a write was inserting under.
 * @typedef {{ table: string, column: string | string[], constraint?: string | string[] }} UniqueKey
 * `column` is the key's column, or its columns in key order; `constraint`
 * is the name the catalog gives the key's primary-key constraint, which
 * PostgreSQL's report is matched against — the names of every one, for a
 * table whose rows live in partitions that each carry their own.
 */

/**
 * Whether a SQLite UNIQUE failure is the key's own collision: a PRIMARY KEY
 * conflict on the table the write inserts into, or a UNIQUE conflict whose
 * message names every key column — a unique INDEX over another column is a
 * constraint failure, not a duplicate key, and neither is the primary key of
 * another table that a trigger of this one inserted into, which the message
 * names by its table. A message that lists no columns leaves the code as the
 * answer.
 * @param {number | null} extended @param {string} message @param {UniqueKey} unique
 * @returns {boolean}
 */
function ownsKey(extended, message, unique) {
  if (extended === SQLITE_CONSTRAINT_PRIMARYKEY) {
    const named = namedColumns(message);
    return named === null || named[0].startsWith(`${unique.table}.`);
  }
  return message.includes('UNIQUE constraint failed')
    && listsEvery(message, [unique.column].flat().map((column) => `${unique.table}.${column}`));
}

/**
 * Whether a failed write left the key's own collision undecided. SQLite
 * reports only the first unique constraint a row fails, so a UNIQUE failure
 * that is not the key's own may hide a key that is stored too; the caller
 * reads the key it carried and, if a row holds it, answers
 * {@link wrapHeldKey}. PostgreSQL names the constraint it rejected against,
 * so for it nothing is undecided.
 * @param {any} error @param {UniqueKey | undefined} unique
 * @returns {boolean}
 */
export function keyUndecided(error, unique) {
  if (unique === undefined || sqlStateOf(error) !== null || isInvariantRefusal(error)) return false;
  const extended = resultCodeOf(error);
  const message = typeof error?.message === 'string' ? error.message : '';
  return (extended === SQLITE_CONSTRAINT_UNIQUE || message.includes('UNIQUE constraint failed'))
    && !ownsKey(extended, message, unique);
}

/**
 * Classify a driver failure.
 * @param {any} error - the driver's error
 * @param {UniqueKey} [unique] - the unique key a write was inserting under,
 *   so its collision classifies as `duplicate` (the `JD2001` every insert
 *   path reports): on SQLite a PRIMARY KEY conflict or a UNIQUE conflict
 *   naming every key column; on PostgreSQL a unique violation of the
 *   constraint named by `unique.constraint` — and of no other, whatever it
 *   is called. Without `constraint` a PostgreSQL unique violation is a
 *   constraint failure
 * @returns {{ class: string, code: string | null, retryable: boolean, reason: string }}
 */
export function classifyDriverError(error, unique = undefined) {
  const state = sqlStateOf(error);
  if (state !== null) return classifySqlState(state, error, unique);
  if (isUncodedLoss(error)) return { ...CONNECTION };
  if (isIntegerReadFailure(error)) return classification('data', 'JD2003', false, 'a stored integer cannot be represented exactly as a JavaScript number');
  const extended = resultCodeOf(error);
  const primary = extended === null ? null : extended & 0xff;
  const message = typeof error?.message === 'string' ? error.message : '';
  if (unique !== undefined && ownsKey(extended, message, unique)) return { ...DUPLICATE };
  if (primary === RESULT.ERROR && message.includes('integer overflow')) {
    return { ...OVERFLOW };
  }
  // a locked database reported by a binding that attaches no code
  if (primary === null && /database is locked|database table is locked/.test(message)) {
    return { ...CLASSES[0], primaries: [...CLASSES[0].primaries] };
  }
  for (const row of CLASSES) {
    if (primary !== null && row.primaries.includes(primary))
      return classification(row.class, row.code, row.retryable, row.reason);
  }
  return { ...FALLBACK };
}

/**
 * The PostgreSQL half: a SQLSTATE into the same closed classes. The server
 * names the constraint it rejected against, and the key's own collision is
 * the one named like the primary-key constraint the catalog gave the key
 * (`unique.constraint`, read when the store opened): a renamed table keeps
 * the name its key was created under, an adopted table brings its own, and
 * a unique member may be named like a key's index, so no name is read as
 * the key unless the catalog says it is. Any other unique violation stays a
 * constraint failure.
 * @param {string} state
 * @param {any} error
 * @param {UniqueKey} [unique]
 * @returns {{ class: string, code: string | null, retryable: boolean, reason: string }}
 */
function classifySqlState(state, error, unique) {
  if (state === '23505' && typeof error?.constraint === 'string'
    && (Array.isArray(unique?.constraint) ? unique.constraint.includes(error.constraint) : error.constraint === unique?.constraint)) {
    return { ...DUPLICATE };
  }
  // an integer that will not fit the column: SQLite reports it as a
  // generic error naming the overflow, PostgreSQL as numeric_value_out_of_range
  if (state === '22003') {
    return { ...OVERFLOW };
  }
  const exact = SQLSTATE[state];
  if (exact !== undefined) return { ...exact };
  const family = SQLSTATE_FAMILY[state.slice(0, 2)];
  if (family !== undefined) return { ...family };
  return { ...FALLBACK };
}

/**
 * What a path hands `wrapDriverError` about itself.
 * @typedef {{ docPath?: string, collection?: string, key?: string | number,
 *   unique?: UniqueKey, duplicateReason?: string, code?: string, reason?: string,
 *   always?: boolean }} WrapDetails
 */

/**
 * Wrap a driver failure as the coded runtime error its class calls
 * for, with `class` and `retryable` as own members and the original as
 * `cause`. Anything that is not a driver's own error — a coded refusal
 * of this package or of the query engine (a `JQ` error thrown inside a
 * pushed user function), an API-misuse `TypeError` (a canonicalization
 * refusal is one, its `JO` code notwithstanding) — is the error, and
 * passes through untouched.
 * @param {any} error
 * @param {WrapDetails} details - `duplicateReason` is the `JD2001`
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
    if (isJarenCoded(primary)) {
      // Keep the original and the cleanup failure together, while callers
      // continue to branch on the original classified failure and its cause.
      for (const member of ['code', 'reason', 'class', 'retryable', 'docPath', 'collection', 'key', 'cause']) {
        if (Object.hasOwn(primary, member)) error[member] = primary[member];
      }
    }
    return error;
  }
  if (isJarenCoded(error)) return error;
  if (!isDriverError(error)) {
    if (details.always !== true) return error;
    const generic = new DbRuntimeError(details.code ?? 'JD2005',
      `${details.reason ?? FALLBACK.reason}: ${error?.message ?? String(error)}`, { cause: error });
    generic.class = 'error';
    generic.retryable = false;
    return generic;
  }
  if (isInvariantRefusal(error)) {
    const wrapped = new DbRuntimeError('JD2096', error.message, { ...details, cause: error });
    wrapped.class = 'constraint'; wrapped.retryable = false;
    return wrapped;
  }
  return wrapClassified(error, details, classifyDriverError(error, details.unique));
}

/**
 * A failed insert whose key a read found stored: the `JD2001` the key's own
 * collision would have been, with the path's own sentence. The caller
 * reached it through {@link keyUndecided} and the read, never on its own.
 * @param {any} error - the driver's error
 * @param {WrapDetails} details - as `wrapDriverError`'s
 * @returns {Error}
 */
export function wrapHeldKey(error, details) {
  return wrapClassified(error, details, { ...DUPLICATE });
}

/**
 * The coded error a classification calls for, with its class and verdict
 * and the driver's error as `cause`.
 * @param {any} error @param {WrapDetails} details
 * @param {{ class: string, code: string | null, retryable: boolean, reason: string }} classified
 * @returns {Error}
 */
function wrapClassified(error, details, classified) {
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
