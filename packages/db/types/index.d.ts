/**
 * Hand-authored declarations for @jarenjs/db — the deliberate public
 * type surface (hand-authored declarations rather than emitted ones —
 * the same decision linq made): the implementation stays plain JSDoc'd
 * JavaScript, and this
 * file is the contract. Anti-drift: the adopter surface is exercised
 * value-position in `test/consumer/types.ts`, and the generated-types
 * pipeline has its own committed oracle (`db-generated.ts`).
 *
 * THE LINE (same as linq's): the common path is precisely typed; the
 * exotic path is honestly `unknown`, never a lie. Query documents,
 * plans and dialect internals are `unknown` on purpose — they are
 * data with their own formats — while the store, entity and
 * unit-of-work surfaces the adopter lives on are exact. Entity-shaped
 * precision (generated `T`s, include-widened loads) layers on top via
 * `@jarenjs/db/typed`.
 */

import type { Runtime } from '@jarenjs/core/runtime';

// ————— errors —————

export declare const DB_CODES: Readonly<Record<string, string>>;

export declare class DbCompileError extends Error {
  constructor(code: string, reason: string, docPath?: string, cause?: Error);
  readonly code: string;
  readonly reason: string;
  readonly docPath?: string;
}

export declare class DbRuntimeError extends Error {
  constructor(code: string, reason: string, options?: {
    docPath?: string;
    collection?: string;
    key?: unknown;
    errors?: unknown[];
    cause?: unknown;
  });
  readonly code: string;
  readonly reason: string;
  readonly docPath?: string;
  readonly collection?: string;
  readonly key?: unknown;
  readonly errors?: unknown[];
}

// ————— shared shapes —————

/** A single-column key, or the `{ prop: value, … }` composite form. */
export type EntityKeyArg = string | number | Readonly<Record<string, string | number>>;

/**
 * What `execute` answers: the ENGINE's result shape (QUERY-FORMAT §1,
 * "singleton ≡ item"). The empty sequence is `undefined`, a sequence of
 * exactly one item IS that item, and anything longer is an array. A
 * single array-valued item is therefore indistinguishable from many
 * items — a consumer whose items may themselves be arrays reads them
 * through `query()`, which answers one item per pull and never
 * unwraps.
 */
export type SequenceResult<T = unknown> = T[] | T | undefined;

/** The D2 provider contract: a synchronous driver answers the value
 * itself and an asynchronous one a promise of it, so a linq chain over
 * a synchronous driver stays synchronous; `await` reads both. */
export type ValueOrPromise<T> = T | Promise<T>;

/**
 * The item cursor `query()` answers: one result item per `next()`,
 * never singleton-unwrapped, so `for await` walks a result whose
 * shape `SequenceResult` cannot say. `return()` releases the
 * underlying statement early. Native and row modes stream row by row;
 * a set residual materializes first (a barrier `explain()` names).
 */
export interface QueryCursor<T = unknown> {
  next(): Promise<IteratorResult<T, undefined>>;
  /** Release the statement, exactly once, at the row boundary the
   * cursor is on; idempotent, and what `for await`'s break, throw and
   * exhaustion all reach. */
  return(): Promise<IteratorResult<T, undefined>>;
  [Symbol.asyncIterator](): QueryCursor<T>;
  /** What this cursor will do for the externals it was given: pull one
   * database row per `next()`, or fill a buffer on the first pull. */
  readonly streaming: 'row' | 'buffered';
  /** What forces the buffer, `null` when the cursor streams. */
  readonly barrier: CursorBarrier | null;
}

/** Why a cursor buffers: `construct` is the stable identifier (a
 * planner construct such as `$orderby` or `$let`, or `external`,
 * `window`, `pushdown`), `reason` the sentence for a person. */
export interface CursorBarrier {
  readonly construct: string;
  readonly reason: string;
}

/**
 * The safe execution profile (MODEL-FORMAT §8): four independent bounds
 * — engine limits, a row bound, reference containment, mandatory
 * predicates — plus the graph bounds. Every member is optional over the
 * `'safe'` defaults. A budget the engine can count is ENFORCED; one it
 * cannot count on SQLite (visited rows, elapsed statement time) is
 * refused at preflight on plan shape (`refuseFullScan`) or reported as
 * unavailable (`explain().budget`), never approximated.
 */
export interface ProfileSpec {
  limits?: { sequenceItems?: number; resultItems?: number; steps?: number; depth?: number };
  /** Rows a fetch may return, materialise or feed a residual, per call
   * (`JD2007` when crossed). */
  maxRows?: number;
  externals?: readonly string[];
  functions?: readonly string[];
  collations?: readonly string[];
  /** The names a document may read — collections AND entity roots;
   * `null` allows all of the store's. */
  collections?: readonly string[] | null;
  /** A predicate conjoined into every plan over the named collection or
   * entity, at its root, after translation. */
  predicates?: Readonly<Record<string, unknown>>;
  /** Refuse a plan whose shape is a full-table scan — including the
   * whole-root fetch an entity residual needs (`JD0011`). */
  refuseFullScan?: boolean;
  /** A cap on any include's per-root rows, on the include depth, and on
   * one item's serialised bytes (`JD2076`); `null` for none. */
  maxIncludedRows?: number | null;
  maxDepth?: number | null;
  maxBytes?: number | null;
}

export interface ExecuteOptions {
  externals?: Readonly<Record<string, unknown>>;
  strict?: boolean;
  /** `false` forces the set residual — the oracle's harness switch. */
  pushdown?: boolean;
  /** The safety profile for THIS call, replacing the store's (normalized
   * over the `'safe'` defaults, MODEL-FORMAT §8); applies to collection,
   * entity, graph, include and store-root execution alike. */
  profile?: 'safe' | ProfileSpec;
  /** Cancellation: a call already aborted runs no statement (`JD2072`);
   * a cursor or page is released at its next row boundary. */
  signal?: AbortSignal;
  /** An epoch-millisecond deadline, checked before a statement runs and
   * at every row boundary of a cursor or page (`JD2075`). NOT a
   * statement timeout: the shipped SQLite drivers expose no interrupt
   * (`capabilities.statementTimeout` is `false`), so a single statement
   * runs to its end — `explain().budget.time` says so. */
  deadline?: number;
  /** On a cursor: a plan that would buffer — a set residual, a
   * k-nearest cut, a native group, a chain's window, an external the
   * database cannot bind — is the refusal `JD0037` naming the barrier,
   * raised before any statement runs; the plan is declined, never run
   * with its memory behaviour quietly changed. On `execute()` it is a
   * `TypeError`: a whole answer has no stream to hold to. */
  strictStreaming?: boolean;
}

/** What a cursor takes: `execute`'s options, `signal` honoured at every
 * row boundary — an aborted cursor releases its statement and every
 * later pull is `JD2072`. */
export interface CursorOptions extends ExecuteOptions {}

/** An entity cursor's options. `tracking: true` registers every yielded
 * entity document with the unit of work — a snapshot per row, so the
 * tracker grows with the result and is bounded by nothing but it; off
 * by default for exactly that reason. The document must then return a
 * bare entity binding (`JD0034` for a projection, a count or a window). */
export interface EntityCursorOptions extends CursorOptions {
  tracking?: boolean;
}

/** An include's clauses: the root's without `after` — a keyset cursor
 * paginates the root alone; an include windows with `skip`/`take`. */
export interface LoadInclude extends Omit<LoadSpec, 'after'> {
  /** Project the related-row COUNT instead of the rows. */
  count?: boolean;
  /** The per-root bounds (MODEL-FORMAT §10.4): rows of this relation
   * per parent (default `INCLUDE_ROWS_DEFAULT`, or the include's own
   * `take`), and serialised bytes per parent (default
   * `INCLUDE_BYTES_DEFAULT`). Crossing one is the refusal `JD2073`,
   * never a truncated graph. `Infinity` (`null` in JSON) is the
   * unbounded case, spelled. */
  maxRows?: number | null;
  maxBytes?: number | null;
}

export interface LoadSpec {
  /** A query expression over `$it` (translatable clauses only). */
  where?: unknown;
  orderBy?: unknown;
  take?: number;
  skip?: number;
  /** The keyset cursor (MODEL-FORMAT §10.5): the structural continuation
   * a page emitted, over the declared ordering with the primary key
   * appended; or, the single-column form, one value of a unique
   * ordering column. */
  after?: string | number | LoadContinuation;
  maxDepth?: number;
  include?: Readonly<Record<string, boolean | LoadInclude>>;
}

/** One term of a keyset ordering's identity: the mapped column, its
 * direction, and where its nulls sort. */
export interface OrderIdentity {
  readonly column: string;
  readonly desc: boolean;
  readonly nullsFirst: boolean;
}

/**
 * The continuation a page emits (MODEL-FORMAT §10.5): unsigned,
 * structural, opaque — the ordering's identity, so it cannot be
 * replayed against another ordering (`JD0035`); the last row's declared
 * order-key values as the document carries them; and the row's primary
 * key, the tie-breaker the plan appends. Signing, tenant scoping, expiry
 * and wire encoding are the HOST's: the store has no principal and no
 * key, and a continuation handed to an untrusted client unsigned is the
 * host's mistake, not a store guarantee.
 */
export interface LoadContinuation {
  readonly order: readonly OrderIdentity[];
  readonly keys: readonly unknown[];
  readonly key: EntityKeyArg;
}

/** A page's options: `limit` roots at most (default `PAGE_LIMIT_DEFAULT`),
 * `maxBytes` serialised bytes at most (`Infinity`/absent for no byte
 * bound), the continuation to resume from, and `consistency` —
 * `'snapshot'` is refused (`JD0036`) over an ordering whose keys a
 * write may change; `'live'` (the default) reports the truth in
 * `snapshot`. */
export interface PageOptions<C = LoadContinuation> extends EntityCursorOptions {
  limit?: number;
  after?: C;
  maxBytes?: number | null;
  consistency?: 'live' | 'snapshot';
}

/** One page: never more than `limit` items or `maxBytes` bytes; the
 * continuation of the last delivered item (or the one resumed from, when
 * nothing fit); `hasMore` by one peek past the page; `snapshot` true
 * only over an immutable ordering — otherwise LIVE pagination, where a
 * row whose order key changes can move across the cursor. */
export interface Page<T, C = LoadContinuation> {
  readonly items: T[];
  readonly continuation: C | null;
  readonly hasMore: boolean;
  readonly snapshot: boolean;
}

export interface LoadExplanation {
  sql: string;
  pagination: 'keyset' | 'offset' | 'none';
  includes: ReadonlyArray<{ path: string; kind: string; count: boolean }>;
  /** The per-root bounds every row-projecting include runs under;
   * `null` is the unbounded case a caller spelled. */
  bounds: ReadonlyArray<{ path: string; maxRows: number | null; maxBytes: number | null }>;
  /** The keyset ordering's identity, with the appended tie-breaker, and
   * whether a page over it is a snapshot; `null` for a load outside
   * keyset mode, whose tie-breaker is the row identity. */
  order: readonly OrderIdentity[] | null;
  snapshot: boolean | null;
  /** A graph load pulls one root row per statement row, always. */
  streaming: 'row';
  barrier: null;
}

/** What `saveChanges()` returns: data, not a boolean (§11.6). */
export interface SaveReport {
  inserted: number;
  updated: number;
  deleted: number;
  joinInserted: number;
  joinDeleted: number;
  /** Whole-row writes for untranslatable diffs — counted, never silent. */
  fallbacks: number;
  statements: ReadonlyArray<{ sql: string; rows: number }>;
  concurrency: { checked: number; unversioned: readonly string[] };
  elapsedMs: number;
}

export interface StoreStats {
  statementCache: { hits: number; misses: number; evictions: number };
  udfRegistrations: number;
  tracker: {
    tracked: number;
    pendingInserts: number;
    pendingDeletes: number;
    /** Pending `link`/`unlink` records: one per entity, own key and member (§11.7). */
    pendingMemberships: number;
  } | null;
  liveQueries: number;
}

export interface StoreCapabilities {
  readonly version: string;
  readonly readOnly: boolean;
  readonly validated: boolean;
  readonly profiled: boolean;
  readonly busyTimeoutMs: number | null;
  readonly journalMode: string | null;
  readonly capture: 'session' | 'journal' | 'none';
  readonly captureLog: boolean;
  readonly live: boolean;
  readonly jobs: boolean;
  /** Whether a temporal spec naming a ZONE compiles here (D7's
   * injected clock was supplied at open). Without it such a document
   * is refused rather than answered in UTC. */
  readonly zoneProvider: boolean;
  readonly [capability: string]: unknown;
}

// ————— collections (the phase-A storage subset) —————

export interface Collection<T = unknown> {
  stats(): unknown;
  insert(doc: T): Promise<string | number>;
  get(key: string | number): Promise<T | undefined>;
  put(doc: T, key?: string | number): Promise<string | number>;
  patch(key: string | number, ops: readonly unknown[]): Promise<T>;
  delete(key: string | number): Promise<boolean>;
  /** Run a query document and answer in the engine's result shape.
   * `R` is what the document's `$return` produces — a document, a
   * projected value, an aggregate's number — and only the caller knows
   * it, so it is stated per call and defaults to `unknown` rather than
   * to a guess. The D2 provider: value-or-promise so a linq chain over
   * a synchronous driver stays synchronous. */
  execute<R = unknown>(document: unknown, options?: ExecuteOptions): ValueOrPromise<SequenceResult<R>>;
  /** The same document as an item cursor — one item per pull. */
  query<R = unknown>(document: unknown, options?: CursorOptions): QueryCursor<R>;
  explain(document: unknown, options?: ExecuteOptions): Promise<unknown>;
  /** Register a live query (LIVE-FORMAT §7); requires capture. */
  live(document: unknown, options?: LiveOptions): Promise<LiveQuery>;
}

export interface SyncCollection<T = unknown> {
  stats(): unknown;
  insert(doc: T): string | number;
  get(key: string | number): T | undefined;
  put(doc: T, key?: string | number): string | number;
  patch(key: string | number, ops: readonly unknown[]): T;
  delete(key: string | number): boolean;
  execute<R = unknown>(document: unknown, options?: ExecuteOptions): SequenceResult<R>;
  explain(document: unknown, options?: ExecuteOptions): unknown;
}

// ————— entities (phase B) —————

/** One row of an entity's relation table (MODEL-FORMAT §10.1): the
 * declared relation as plain data a query producer can lower a hop
 * from — never a document dialect. For a foreign-key relation `via`
 * names the key property, `fkEntity` the entity holding it, `fkTargets`
 * the entity it references and `targetKey` the key property it
 * references there (the column a hop's equality compares `via` with);
 * `kind` says which side holds the key (`oneToOne`: the declaring
 * entity; `oneToMany`: the target). A many-to-many carries its
 * `joinTable` and the target's `targetKey`. */
export interface RelationEntry {
  readonly to: string;
  readonly kind: 'oneToOne' | 'oneToMany' | 'manyToMany';
  readonly via?: string;
  readonly fkEntity?: string;
  readonly fkTargets?: string;
  readonly joinTable?: string;
  readonly targetKey: string;
}

/** An entity's relation table: one entry per declared relation member. */
export type RelationTable = Readonly<Record<string, RelationEntry>>;

/** The identity every entity set of one store shares — two sets with one
 * `scope` may be joined in one document — carrying the relation tables
 * of every root, keyed by entity name, so a hop can chain into another
 * root of the same scope. */
export interface EntityScope {
  readonly relations: Readonly<Record<string, RelationTable>>;
}

export interface UntrackedReads<T = unknown> {
  get(key: EntityKeyArg): Promise<T | undefined>;
  load(spec?: LoadSpec): Promise<T[]>;
}

export interface EntitySet<T = unknown, I = unknown> {
  /** The provider phantom: a chain over this set infers its item type. */
  readonly __item?: T;
  create(doc: I): Promise<Readonly<T>>;
  get(key: EntityKeyArg): Promise<Readonly<T> | undefined>;
  update(key: EntityKeyArg, changes: Partial<T>): Promise<Readonly<T>>;
  delete(key: EntityKeyArg): Promise<boolean>;
  load(spec?: LoadSpec): Promise<ReadonlyArray<Readonly<T>>>;
  /** The graph cursor: one root graph per pull, its includes attached
   * and bounded (§10.4), from the same one statement `load` runs;
   * `return()` releases it. Untracked unless `tracking: true`. */
  loadCursor(spec?: LoadSpec, options?: EntityCursorOptions): QueryCursor<Readonly<T>>;
  /** One bounded page over the composite keyset (§10.5). A `take` or
   * `skip` in the spec is refused: the page windows by its limit. */
  page(spec?: LoadSpec, options?: PageOptions): Promise<Page<Readonly<T>>>;
  explainLoad(spec?: LoadSpec): LoadExplanation;
  /** Track a pending insert (local, synchronous — no round trip). */
  add(doc: I): Readonly<T>;
  /** Register the next version of a tracked entity. */
  put(next: T): Readonly<T>;
  /** Schedule a delete (local, synchronous). */
  remove(key: EntityKeyArg | T): void;
  /** Drop tracking without scheduling anything — conflict recovery. */
  discard(key: EntityKeyArg | T): void;
  /** Attach / detach one many-to-many membership through the unit of
   * work (§11.7): local bookkeeping, written by `saveChanges()` as join
   * rows against the join table as it stands then — idempotent. `own`
   * and `target` are each a key or a document carrying the key. */
  link(own: EntityKeyArg | T, member: string, target: EntityKeyArg | object): void;
  unlink(own: EntityKeyArg | T, member: string, target: EntityKeyArg | object): void;
  asNoTracking(): UntrackedReads<T>;
  /** The provider contract over this entity's root (MODEL-FORMAT §10.1):
   * the document is over the multi-entity root and arrives whole; the
   * answer is the engine's result shape, value-or-promise (D2). */
  execute<R = unknown>(document: unknown, options?: ExecuteOptions): ValueOrPromise<SequenceResult<R>>;
  /** The same document as an item cursor: one row per pull from an open
   * statement, released on `return()`; a set residual materialises the
   * fetched root first and says so (`streaming: 'buffered'`). A chain's
   * `for await` over this set is this cursor. Untracked unless
   * `tracking: true`. */
  cursor<R = T>(document: unknown, options?: EntityCursorOptions): QueryCursor<R>;
  explain(document: unknown, options?: ExecuteOptions): Promise<unknown>;
  /** The root expression this set's rows are bound through (`$.<Name>[*]`). */
  readonly root: string;
  /** The identity every entity set of one store shares: two sets with one
   * `scope` may be joined in one document; it carries every root's
   * relation table. */
  readonly scope: EntityScope;
  /** This entity's relation table (MODEL-FORMAT §10.1) — what a query
   * producer lowers a relation hop from. */
  readonly relations: RelationTable;
}

export interface SyncUntrackedReads<T = unknown> {
  get(key: EntityKeyArg): T | undefined;
  load(spec?: LoadSpec): T[];
}

export interface SyncEntitySet<T = unknown, I = unknown> {
  /** The provider phantom: a chain over this set infers its item type. */
  readonly __item?: T;
  create(doc: I): Readonly<T>;
  get(key: EntityKeyArg): Readonly<T> | undefined;
  update(key: EntityKeyArg, changes: Partial<T>): Readonly<T>;
  delete(key: EntityKeyArg): boolean;
  load(spec?: LoadSpec): ReadonlyArray<Readonly<T>>;
  explainLoad(spec?: LoadSpec): LoadExplanation;
  add(doc: I): Readonly<T>;
  put(next: T): Readonly<T>;
  remove(key: EntityKeyArg | T): void;
  discard(key: EntityKeyArg | T): void;
  link(own: EntityKeyArg | T, member: string, target: EntityKeyArg | object): void;
  unlink(own: EntityKeyArg | T, member: string, target: EntityKeyArg | object): void;
  asNoTracking(): SyncUntrackedReads<T>;
  /** The provider contract over this entity's root, answering values. */
  execute<R = unknown>(document: unknown, options?: ExecuteOptions): SequenceResult<R>;
  explain(document: unknown, options?: ExecuteOptions): unknown;
  readonly root: string;
  readonly scope: EntityScope;
  readonly relations: RelationTable;
}

// ————— the store —————

export interface SyncStore {
  /** `T` is the collection's document shape — the model's schema in
   * the consumer's words; the handle's writes take it and reads answer it. */
  collection<T = unknown>(name: string): SyncCollection<T>;
  entity(name: string): SyncEntitySet;
  transaction<R>(fn: (store: TransactionStore) => R): R;
  execute?<R = unknown>(document: unknown, options?: ExecuteOptions): SequenceResult<R>;
  explain?(document: unknown, options?: ExecuteOptions): unknown;
  /** The entity roots this store-level provider serves (present with
   * entities): it has no single root of its own, so a chain over it is
   * refused by name — chain over `entity(name)` instead. */
  readonly roots?: readonly string[];
  /** The relation tables of every entity, keyed by entity name (present
   * with entities; MODEL-FORMAT §10.1). */
  readonly relations?: Readonly<Record<string, RelationTable>>;
  saveChanges?(): SaveReport;
}

export interface Store {
  readonly capabilities: StoreCapabilities;
  readonly dialect: Dialect;
  stats(): StoreStats;
  /** `T` is the collection's document shape — the model's schema in
   * the consumer's words; the handle's writes take it and reads answer it. */
  collection<T = unknown>(name: string): Collection<T>;
  entity(name: string): EntitySet;
  /** Entity documents over the multi-entity root (§10.1); present
   * only when the model declares entities. Value-or-promise (D2),
   * in the engine's result shape. */
  execute?<R = unknown>(document: unknown, options?: ExecuteOptions): ValueOrPromise<SequenceResult<R>>;
  explain?(document: unknown, options?: ExecuteOptions): Promise<unknown>;
  /** The entity roots this store-level provider serves (present with
   * entities): it has no single root of its own, so a chain over it is
   * refused by name — chain over `entity(name)` instead. */
  readonly roots?: readonly string[];
  /** The relation tables of every entity, keyed by entity name (present
   * with entities; MODEL-FORMAT §10.1). */
  readonly relations?: Readonly<Record<string, RelationTable>>;
  /** The unit of work (§11); present only with entities. */
  saveChanges?(): Promise<SaveReport>;
  /**
   * A top-level transaction. The callback receives a
   * {@link TransactionStore} whose handles are INSIDE it; this store's
   * own handles are an unrelated caller and wait for the commit.
   *
   * `signal` abandons the call while it is still QUEUED — the callback
   * then never runs and no statement is issued (`JD2064`). A transaction
   * that has already taken the connection runs to its own end.
   *
   * `unitOfWork: 'own'` gives the callback a tracker of its own, so two
   * concurrent handlers hold two records for one entity key and neither
   * sees the other's pending state; `'shared'` (the default) writes
   * through the store's, which is what lets a caller `add()` a document
   * outside the transaction and save it inside. Both behave identically
   * with and without capture.
   */
  transaction<R>(fn: (store: TransactionStore) => R | Promise<R>,
    options?: TransactionScopeOptions): Promise<Awaited<R>>;
  /** Register a change observer; requires capture. Returns unsubscribe. */
  observe(fn: (record: ChangeRecord) => void): () => void;
  /** Read the persisted log forward from `after` (`JD2051` without
   * `capture.log`) — EVERY surviving record in one array, UNBOUNDED, with
   * no watermark: a reconnecting consumer whose cursor fell below the
   * retention floor receives the surviving suffix and cannot tell it
   * from the whole. Unsafe for a reconnecting consumer; `changes.page()`
   * is the supported path (LIVE-FORMAT §5). */
  changesSince?(after: number): Promise<ChangeRecord[]>;
  /** The bounded change reader: the log's watermarks and pages that
   * never exceed their bounds and report a retention gap explicitly;
   * present exactly when the log is enabled. */
  readonly changes?: ChangesReader;
  /** PRAGMA data_version — the coarse cross-connection signal. */
  dataVersion(): Promise<number>;
  /** Register a live query over an entity-root document (re-run
   * strategy in this version); present only with entities. */
  live?(document: unknown, options?: LiveOptions): Promise<LiveQuery>;
  /** Close the store. Job workers are asked to stop and given
   * `graceMs` to wind up; the connection closes whether or not they
   * did, and a handler still in flight is reported as JD2062. */
  close(options?: { graceMs?: number }): Promise<void>;
  /** The queue surface; present when opened with `jobs` (JOBS-FORMAT).
   * Root calls here take the store gate — an unrelated enqueue, claim,
   * checkpoint or settlement never joins an open application
   * transaction's fate. The transactional-outbox spelling is the
   * `tx.jobs` a transaction callback receives, which runs as the exact
   * scope and co-commits with the domain transaction. */
  readonly jobs?: JobsApi;
  /** Present exactly when the driver is synchronous — never stubs. */
  readonly sync?: SyncStore;
}

/** The options a top-level transaction takes. An unknown `unitOfWork`
 * value is a compile error here and runtime API misuse there. */
export interface TransactionScopeOptions {
  /** Abandons the call while it is still QUEUED (`JD2064`); a
   * transaction that has taken the connection runs to its own end. */
  signal?: AbortSignal;
  /** `'own'` gives the callback an independent tracker; `'shared'`
   * (the default) writes through the store's. */
  unitOfWork?: 'own' | 'shared';
}

/**
 * The named-savepoint group a live transaction view carries
 * (MODEL-FORMAT §5.2): checkpoint-and-continue without a sentinel
 * exception. The label is a map key and diagnostic for that exact
 * transaction — never SQL; the driver generates the identifier. A
 * blank, duplicate or unknown label is `JD2071`; a stale or
 * cross-scope view is `JD2070` first. `rollbackTo` keeps the target
 * active (repeated rollback is defined) and invalidates every later
 * checkpoint; `release` removes the target and every later checkpoint,
 * keeping their rows — the engine's own semantics, exactly.
 */
export interface SavepointController {
  create(label: string): Promise<void>;
  rollbackTo(label: string): Promise<void>;
  release(label: string): Promise<void>;
}

/** The synchronous twin of {@link SavepointController}, answering
 * values (present under `tx.sync` on a synchronous driver). */
export interface SyncSavepointController {
  create(label: string): void;
  rollbackTo(label: string): void;
  release(label: string): void;
}

/** The synchronous surface a transaction view carries: the store's,
 * plus the transaction-only savepoint group. */
export interface TransactionSyncStore extends SyncStore {
  readonly savepoints: SyncSavepointController;
}

/**
 * The store a transaction callback receives: the same surface, with
 * every handle bound to THIS transaction's exact scope.
 *
 * `tx.collection(...)`, `tx.entity(...)`, `tx.sync`, `tx.jobs` and
 * `tx.saveChanges()` run as the transaction's owner, and
 * `tx.transaction(...)` nests through its savepoint. The outer store's
 * handles are, by construction, an unrelated caller: they wait for the
 * commit, and one awaited from inside the callback is a self-wait that
 * `JD0012` names rather than a hang.
 *
 * The view lives exactly as long as its own scope: any stateful member
 * used after the transaction settled, or while an async inner savepoint
 * is current, refuses `JD2070` before touching tracker state or the
 * database. There is deliberately no `close` — a transaction view does
 * not own the store lifetime; the root store remains the only owner of
 * the connection.
 */
export interface TransactionStore extends Omit<Store, 'close' | 'transaction' | 'sync'> {
  transaction<R>(fn: (store: TransactionStore) => R | Promise<R>): Promise<Awaited<R>>;
  /** Named partial rollback over the transaction's one savepoint stack
   * (MODEL-FORMAT §5.2). Root stores, clients, workers and checkpoint
   * stores expose none of it. */
  readonly savepoints: SavepointController;
  /** Present exactly when the driver is synchronous, as on the store. */
  readonly sync?: TransactionSyncStore;
}

/** The log's two watermarks (LIVE-FORMAT §5): the earliest surviving
 * sequence (`null` when nothing survives) and the highest sequence the
 * FILE ever allocated — durable across an emptied log, a reopen and a
 * second store over the same file, never a process counter. */
export interface ChangeBounds {
  readonly earliestAvailable: number | null;
  readonly highWatermark: number;
}

/** A change page's options: `after` is the last sequence seen and is
 * required — there is no legitimate "give me everything" for a change
 * log; `limit` records at most (default `PAGE_LIMIT_DEFAULT`),
 * `maxBytes` serialised patch bytes at most (none unless given),
 * `signal` honoured at a record boundary (`JD2072`). */
export interface ChangePageOptions {
  after: number;
  limit?: number;
  maxBytes?: number | null;
  signal?: AbortSignal;
  /** An epoch-millisecond deadline, read against the store's clock at every record boundary (`JD2075`). */
  deadline?: number;
}

/**
 * One page of the log. `resetRequired: true` means the record after
 * `after` no longer survives: `items` is EMPTY and `next` absent — a
 * total refusal, never a partial suffix — and the consumer re-seeds
 * from a snapshot and resumes at `highWatermark`. Otherwise `next` is
 * the sequence to continue from (`after` itself when nothing was
 * delivered), `hasMore` says whether records remain above it, and the
 * watermarks are the log's as read after the page.
 */
export interface ChangePage {
  readonly items: ChangeRecord[];
  readonly next?: number;
  readonly earliestAvailable: number | null;
  readonly highWatermark: number;
  readonly hasMore: boolean;
  readonly resetRequired: boolean;
}

/** The bounded change reader (LIVE-FORMAT §5). A record larger than
 * `maxBytes` is `JD2074` without advancing `next` — the same rule, the
 * same implementation, as an entity page. */
export interface ChangesReader {
  bounds(): Promise<ChangeBounds>;
  page(options: ChangePageOptions): Promise<ChangePage>;
}

/** One committed transaction's change record (LIVE-FORMAT §§1–5). */
export interface ChangeRecord {
  /** Monotonic; continues across reopens when the log is enabled. */
  seq: number;
  at: number;
  source: 'session' | 'journal';
  collections: readonly string[];
  /** RFC 6902 ops with `/<table>/<key>/<path…>` pointers. */
  patch: ReadonlyArray<{ op: string; path: string; value?: unknown; from?: string }>;
}

export interface CaptureOptions {
  /** 'auto' (default) picks sessions where the driver has them. */
  mode?: 'auto' | 'session' | 'journal';
  log?: boolean | { retention?: number };
}

// ————— live queries (LIVE-FORMAT §§7–12) —————

export interface LiveOptions {
  /** Fixed at registration; a query whose inputs change is a new
   * registration. */
  externals?: Record<string, unknown>;
  /** 'incremental' DEMANDS incrementality (JD0051 when the shape
   * re-runs); 'rerun' forces the re-run strategy. */
  mode?: 'auto' | 'incremental' | 'rerun';
  /** Event time for a `$resample` / `$rolling` view (LIVE-FORMAT §13).
   * Its members are closed: anything else is JD0053. */
  eventTime?: LiveEventTime;
}

export interface LiveEventTime {
  /** A singular row selector naming the instant member, e.g. '$.at'.
   * It must be the member the spec aggregates by. */
  path: string;
  /** A finite epoch in milliseconds. Never a clock reading — the host
   * supplies it, and `advance()` is the only way it moves. */
  watermark: number;
  /** How far behind the watermark a reading may still be applied
   * (default 0). Older readings emit `lateData` and re-run. */
  allowedLateness?: number;
  /** The horizon this view claims, in milliseconds. It must cover the
   * window (or bucket) width plus `allowedLateness`, or the view is
   * classified as a re-run. */
  retention: number;
}

export interface LiveMode {
  readonly strategy: 'rows' | 'window' | 'accumulator' | 'group'
    | 'bucket' | 'rolling' | 'rerun';
  readonly mode: 'incremental' | 'rerun';
  /** Present exactly when the strategy is 'rerun': the named reason. */
  readonly reason?: string;
}

export interface LiveEvent {
  /** RFC 6902 ops against the `{ rows }` result document. */
  patch?: ReadonlyArray<{ op: string; path: string; value?: unknown }>;
  seq?: number;
  /** A maintenance failure (JD2060 …): the query closed after this. */
  error?: unknown;
  /** Present when a reading behind the lateness boundary forced this
   * emission: the view re-read, and the row was never folded in as
   * though it had arrived on time (LIVE-FORMAT §13). */
  lateData?: {
    reason: 'late-data';
    at: number;
    key: string;
    watermark: number;
    allowedLateness: number;
    boundary: number;
  };
}

export interface LiveStats {
  records: number;
  matched: number;
  emissions: number;
  /** min/max extremum-removal recomputes (accumulator strategy). */
  fallbacks?: number;
  /** whole-query re-executions (re-run strategy, and the re-read a
   * late reading forces). */
  reruns?: number;
  /** readings that arrived behind the lateness boundary (event time). */
  lateData?: number;
  /** buckets or window stretches folded again (event time). */
  recomputes?: number;
  /** the current watermark (event time). */
  watermark?: number;
}

export interface LiveQuery {
  /** The maintained result document; a fresh object per emission with
   * unaffected rows REFERENCE-IDENTICAL (§9). */
  readonly result: { readonly rows: readonly unknown[] };
  readonly state: 'live' | 'closed' | 'errored';
  readonly error: unknown;
  readonly mode: LiveMode;
  stats(): LiveStats;
  subscribe(observer: (event: LiveEvent) => void): () => void;
  /** Move the event-time watermark forward. Present only on a view
   * registered with `eventTime`; a non-finite or backward value is a
   * TypeError. */
  advance?(watermark: number): void;
  close(): void;
}

export interface LiveBounds {
  /** Registrations beyond it are JD0052 (default 64). */
  maxQueries?: number;
  /** Per-query ceiling on maintained entries — rows, window entries
   * and contributions all count (default 10 000; JD2060 beyond). */
  maxMaintained?: number;
}

export interface OpenStoreOptions {
  driver: Driver;
  path?: string;
  /**
   * What a store-level call does while another caller's transaction owns
   * the connection. `'wait'` (the default) queues behind it under
   * `queueTimeout` and then refuses `JD0012`; `'strict'` refuses at once,
   * for a host that would rather see the contention than pay for it.
   * Either way the call never joins the transaction.
   */
  transactions?: 'wait' | 'strict';
  /** Change capture (LIVE-FORMAT): off unless requested. */
  capture?: boolean | CaptureOptions;
  /** Live-query bounds (LIVE-FORMAT §12). */
  live?: LiveBounds;
  /** The durable job queue (JOBS-FORMAT); off unless requested. */
  jobs?: boolean | JobsOptions;
  /** The injected validation hook (D10); absent means unvalidated,
   * declared through `capabilities.validated`. */
  compileSchema?: (schema: unknown) => (doc: unknown) => unknown;
  /** D7's injected clock — `{ toParts(epoch, zone), toEpoch(parts, zone,
   * disambiguation) }`. A temporal spec naming a zone
   * (`{ "every": "P1M", "zone": "Europe/Amsterdam" }`) compiles only
   * where one was injected; without it the document is refused rather
   * than answered in UTC. No time-zone database is bundled. */
  zoneProvider?: unknown;
  /** The host's runtime record (`@jarenjs/core/runtime`): the clock the
   * capture log and the job queue stamp, the identifier a `uuid`
   * identity and a `default: 'uuid'` allocate, the job queue's backoff
   * jitter and the zone provider — each read only where the explicit
   * option (`zoneProvider`, `jobs.now`, `jobs.random`) is absent, and
   * handed on to the job engine. */
  runtime?: Partial<Runtime>;
  busyTimeout?: number;
  /** How long work waits for an open transaction to settle before
   * `JD0012` (MODEL-FORMAT §5.1); reaches every driver. */
  queueTimeout?: number;
  journalMode?: string;
  statementCacheBound?: number;
  /** The store-level safety profile (MODEL-FORMAT §8). */
  profile?: 'safe' | ProfileSpec;
  readOnly?: boolean;
  /** A `createJsltRegistry()` registry (Ring 2/3): the operators a
   * query may use, and the pushable subset. */
  operators?: unknown;
  /** Raw registry-free operators; never pushed. */
  functions?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export declare function openStore(model: unknown, options: OpenStoreOptions): Promise<Store>;
export declare function normalizeModel(model: unknown): Map<string, unknown>;
export declare const MODEL_VERSION: string;

// ————— the dialect and driver seams —————

/** A dialect is data plus spelling primitives; consumers treat it as
 * opaque beyond the members shown. */
export interface Dialect {
  readonly name: string;
  quoteIdentifier(name: string): string;
  stringLiteral(value: string): string;
  readonly [primitive: string]: unknown;
}

export interface Driver {
  readonly name: string;
  readonly dialect: Dialect;
  /** Open a connection (value-or-promise) at `path` (`':memory:'` for
   * none) with the driver's own options. */
  open(path: string, options?: unknown): unknown;
}

export declare const sqliteDialect: Dialect;
export declare function createDialect(spec: unknown): Dialect;
export declare const SQLITE_FLOOR: string;

// ————— entities: models, mapping, generated types —————

export declare function normalizeEntities(model: unknown): Map<string, unknown>;
export declare function explainMapping(model: unknown): unknown;
/** The relation tables of normalized entities, keyed by entity name
 * then by relation member (MODEL-FORMAT §10.1) — what every entity set
 * exposes as `relations` and every scope carries for all its roots. */
export declare function relationTables(
  entities: Map<string, unknown>,
): Readonly<Record<string, RelationTable>>;

/**
 * Build the EMIT-FORMAT model document for a model's entities.
 * `compile` is `compileEmitModel` from `@jarenjs/emit`, injected so db
 * never depends on emit; render the result with `renderTypeScript`.
 */
export declare function entityEmitModel(model: unknown, options: {
  compile: (schema: unknown, options?: unknown) => unknown;
  source?: string;
  reserved?: string[];
}): unknown;

// ————— the unit of work —————

export declare function createTracker(context: unknown): unknown;
export declare function parseChangeset(bytes: Uint8Array): unknown[];
export declare function translateOperations(
  connection: unknown, shapes: Map<string, unknown>, operations: unknown[],
): unknown;
export declare function keyToken(parts: readonly unknown[]): string;
export declare function createCaptureEngine(options: unknown): unknown;
export declare const CHANGES_TABLE: string;
/** The change log's durable state table: the highest sequence the file ever allocated (LIVE-FORMAT §5). */
export declare const CHANGES_STATE_TABLE: string;
export declare const DEFAULT_RETENTION: number;
/** Deep-freeze a JSON value in place and return it (idempotent). */
export declare function deepFreeze<T>(value: T): T;
export declare const BATCH_PARAM_BUDGET: number;
export declare const BATCH_ROW_BOUND: number;

// ————— migrations —————

export interface MigrateOptions {
  baseline: unknown;
  model?: unknown;
  compileSchema?: (schema: unknown) => (doc: unknown) => unknown;
  dryRun?: boolean;
  batchSize?: number;
  shadow?: boolean;
  /** Re-register declared deterministic functions on every connection
   * the migration opens (real, shadow, reference) — §10. */
  registerFunctions?: (connection: unknown) => unknown;
  /** The host's runtime record: the clock every applied migration is
   * stamped with; the platform's own when absent. */
  runtime?: Partial<Runtime>;
}

export declare function migrate(
  target: unknown, migrations: readonly unknown[], options: MigrateOptions,
): Promise<unknown>;
export declare function planMigration(from: unknown, to: unknown, options?: unknown): unknown;
/** The whole-model diff — collections AND entities (MIGRATION-FORMAT §9). */
export declare function planModelMigration(from: unknown, to: unknown, options?: unknown): unknown;
export interface MigrationStatusReport {
  applied: string[];
  pending: string[];
  /** A one-line difference when the database drifted; null in sync. */
  drift: string | null;
  upToDate: boolean;
}
export declare function migrationStatus(
  target: { driver: Driver; path?: string },
  migrations: readonly unknown[],
  options: { baseline: unknown; model?: unknown;
    registerFunctions?: (connection: unknown) => unknown },
): Promise<MigrationStatusReport>;
/** Create a model's whole physical shape on a connection. */
export declare function createModelShape(connection: unknown, model: unknown): unknown;
/** The declared schema, normalized for shape-equality comparison. */
export declare function schemaShapeOf(connection: unknown):
  Promise<Array<{ type: string; name: string; owner: string; sql: string }>>
  | Array<{ type: string; name: string; owner: string; sql: string }>;
/** Null when the database's shape equals a fresh build of the model. */
export declare function compareShapeToModel(
  driver: Driver, connection: unknown, model: unknown,
  registerFunctions?: (connection: unknown) => unknown,
): Promise<string | null> | string | null;
export declare function shapeHash(model: unknown): string;
export declare function migrationChecksum(migration: unknown): string;
export declare const MIGRATION_VERSION: string;
export declare const HISTORY_TABLE: string;

// ————— the machinery exports —————
// The planner/emitter/residual/profile internals are public for tools
// and tests; their documents have their own formats, so their types
// are deliberately WIDE (unknown), never wrong.

export declare function planCollection(name: string, collection: unknown, dialect: Dialect): unknown;
export declare function compileIndexPath(expression: string, docPath: string): unknown;
export declare function normalizeDeclaredSql(sql: string): string;
export declare function comparableDeclaredSql(sql: string): string;
export declare function schemaTypeAt(schema: unknown, segments: unknown): unknown;
export declare const KEY_COLUMN: string;
export declare const DOC_COLUMN: string;
export declare function planQuery(document: unknown, shape: unknown, options?: unknown): unknown;
export declare function assertDecidedKind(node: unknown): void;
export declare function entityShape(entity: unknown, entityMapping: unknown): unknown;
export declare function entityPathRef(node: unknown, slot: number, shape: unknown): unknown;
export declare function planEntityPredicate(node: unknown, slot: number, shape: unknown): unknown;
export declare function planEntityQuery(document: unknown, entities: unknown, mapping: unknown): unknown;
export declare function emitPlan(plan: unknown, dialect: Dialect, physical: unknown): unknown;
export declare function createEntityPredicateEmitters(dialect: Dialect, param: unknown): unknown;
export declare function emitEntityPlan(plan: unknown, dialect: Dialect, physicalOf: unknown): unknown;
export declare function mergeEntityRow(entityMapping: unknown, row: unknown, docField?: string): unknown;
export declare function parseGraphRow(node: unknown, row: unknown, docField?: string): unknown;
export declare function selectPlan(collection: string): unknown;
export declare function conjoin(plan: unknown, predicate: unknown): unknown;
export declare function assertNoSqlText(plan: unknown): void;
export declare const PLAN_VERSION: number;
export declare function typeOfPath(shape: unknown, segments: unknown): unknown;
export declare function isNumericType(type: unknown): boolean;
export declare function compileSetResidual(document: unknown, limits?: unknown): unknown;
export declare function compileRowResidual(rowReturn: unknown, limits?: unknown): unknown;
export declare function compilePackedResidual(document: unknown, limits?: unknown): unknown;
/** The one cursor mechanism every engine builds on: a row source pulled
 * one row per `next()` and released exactly once, or a materialised
 * source that says so. */
export declare function createCursor<T = unknown>(spec: {
  streaming: 'row' | 'buffered';
  barrier?: CursorBarrier | null;
  signal?: AbortSignal;
  materialize?: () => unknown;
  open?: () => unknown;
  items?: (row: unknown) => T[];
}): QueryCursor<T>;
export declare function sequenceResult(items: unknown[]): unknown;
export declare function deterministicFragment(fragment: unknown): unknown;
export declare function registerFragment(connection: unknown, registered: Set<string>, fragment: unknown): void;
export declare function createQueryEngine(context: unknown): unknown;
export declare function createQueryState(bound?: number): unknown;
export declare function createEntityQueryEngine(context: unknown): unknown;
export declare function createLoadEngine(context: unknown, entityName: string): unknown;
export declare const INCLUDE_DEPTH_DEFAULT: number;
export declare const INCLUDE_ROWS_DEFAULT: number;
export declare const INCLUDE_BYTES_DEFAULT: number;
export declare const PAGE_LIMIT_DEFAULT: number;
export declare function normalizeProfile(profile: unknown): unknown;
export declare const SAFE_PROFILE: unknown;
export declare function translateProfilePredicate(predicate: unknown, shape: unknown): unknown;
export declare function applyMandatoryPredicate(plan: unknown, predicate: unknown): unknown;
export declare function applyRowBound(plan: unknown, maxRows: number): unknown;
export declare function translatePatch(ops: readonly unknown[], doc: unknown, dialect: Dialect): unknown;
export declare function planEntity(name: string, entityMapping: unknown, mapping: unknown, dialect: Dialect): unknown;
export declare function planJoinTable(name: string, joinTable: unknown, mapping: unknown, dialect: Dialect): unknown;
export declare function entityCore(connection: unknown, entity: unknown, entityMapping: unknown, validate: unknown): unknown;
export declare function chain<T, R>(value: T | Promise<T>, next: (value: T) => R): R | Promise<R>;
export declare function toPromise<T>(value: T | Promise<T>): Promise<T>;
export declare function isThenable(value: unknown): boolean;
export declare function compareVersions(a: string, b: string): number;
export declare function openConnection(raw: unknown, options: unknown): unknown;
export declare function wrapStatement(statement: unknown): unknown;
export declare function lazyOpen(spec: unknown, reason: string, use: unknown, args?: unknown): unknown;
export declare function classifyLiveQuery(
  document: unknown, queryShape: unknown, keyed: boolean, eventTime?: unknown): unknown;
export declare function createLiveRegistry(
  bounds: { maxQueries: number; maxMaintained: number }): unknown;
export declare function diffRows(oldRows: readonly unknown[], newRows: readonly unknown[]):
  Array<{ op: string; path: string; value?: unknown }>;
export declare const LIVE_DEFAULTS: { maxQueries: number; maxMaintained: number };
export declare function createSortedWindow(
  terms: unknown[], limit: number | null): unknown;
export declare function compareCodepoint(a: string, b: string): number;
export declare function collectEntityRoots(
  document: unknown, entities: ReadonlyMap<string, unknown>): Set<string>;
/** The root expression an entity's rows are bound through (`$.<Name>[*]`) —
 * what an entity set exposes as `root` and what `collectEntityRoots` reads. */
export declare function entityRoot(name: string): string;

// ————— the derived-index and k-nearest machinery —————
// Constants carry their real shapes; the functions take and answer the
// planner's own records, which have no published type — WIDE, never
// wrong (the line at the top of this file).

export declare const DERIVE_KINDS: ReadonlySet<string>;
export declare const DERIVE_MAPPING: Readonly<Record<string, string | null>>;
export declare const PHYSICAL_KINDS: ReadonlySet<string>;
export declare const BBOX_COMPONENTS: readonly ['w', 's', 'e', 'n'];
export declare const BBOX_INDEX_ORDER: readonly ['w', 'e', 's', 'n'];
export declare const PRECISION_MIN: number;
export declare const PRECISION_MAX: number;
export declare const DIMS_MIN: number;
export declare const DIMS_MAX: number;
export declare function derivedMappingFor(kind: string, driverMapping: unknown): unknown;
export declare function deriveGeohash(value: unknown, precision: number): unknown;
export declare function deriveBboxEdge(value: unknown, component: 'w' | 's' | 'e' | 'n'): unknown;
export declare function deriveVector(member: unknown, dims: number): unknown;
export declare function storedMemberForm(member: unknown): unknown;
export declare function derivedValue(column: unknown, member: unknown): unknown;
export declare function memberAt(doc: unknown, segments: unknown): unknown;
export declare function registerDeriveFunctions(connection: unknown): unknown;
export declare function probeVector(value: unknown, dims: number): unknown;
export declare function columnScore(bytes: unknown, dims: number, probe: unknown): unknown;
export declare const KNN_MARGIN: number;
export declare const IDENTITY_CHUNK: number;
export declare function cutCandidates(rows: unknown[], m: number, margin: number): unknown;
export declare function identityBatches(identities: unknown[]): unknown;

// ————— the job queue (JOBS-FORMAT) —————

export interface JobRecord {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly state: 'pending' | 'leased' | 'done' | 'failed' | 'dead';
  readonly runAt: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseUntil: number | null;
  readonly leaseOwner: string | null;
  /** How many times this job has been claimed. It identifies the
   * ATTEMPT, which the owner cannot: one worker reuses one owner. */
  readonly leaseGeneration: number;
  readonly lastError: string | null;
  readonly result: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * The capability one claim mints: the right to settle THIS attempt of
 * this job, for as long as the lease is valid.
 *
 * It is a token rather than an owner, because an owner is reused by
 * every attempt one worker makes and so cannot say which attempt is
 * speaking. It is immutable: `renew` answers a NEW lease and retires
 * this one, so a reference kept across a renewal can never quietly
 * become valid again.
 *
 * Only `claim` and `renew` hand one out. `get` does not — a record
 * anyone can read must not carry the capability to settle it.
 */
export interface JobLease {
  readonly jobId: string;
  readonly token: string;
  readonly generation: number;
  readonly attempt: number;
  /** Diagnostics only: never a guard. */
  readonly owner: string | null;
  readonly expiresAt: number;
}

/** What `claim` answers: the record, and the lease to settle it with. */
export interface ClaimedJob extends JobRecord {
  readonly lease: JobLease;
}

export interface JobCounts {
  pending: number;
  leased: number;
  done: number;
  failed: number;
  dead: number;
  /** Pending/failed totals per kind — how a handler-less kind REPORTS. */
  pendingKinds: Record<string, number>;
}

/** What became of one attempt. A LOST settlement is its own outcome:
 * counting it as a completion is what let a corpse report success over
 * work another attempt was still doing, and counting it as a failure
 * would burn a retry the job never spent. */
export interface JobOutcome {
  readonly outcome: 'completed' | 'failed' | 'lost';
  /** Where the loss was noticed: settling the result, or settling the
   * failure that came before it. Absent on the other two outcomes. */
  readonly phase?: 'completion' | 'failure';
  readonly jobId: string;
  readonly kind: string;
  readonly attempt: number;
  readonly generation: number;
  /** The refusal code a lost settlement carries (`JD2065`/`JD2066`/
   * `JD2067`); `null` when the lease was lost some other way. */
  readonly code?: string | null;
  readonly reason?: string;
}

export interface JobWorker {
  start(): JobWorker;
  /** Stop claiming, signal in-flight handlers, and wait up to `graceMs`
   * (JOBS-FORMAT §6): the record says whether every loop drained. */
  stop(options?: { graceMs?: number }): Promise<{ drained: boolean; inFlight: number }>;
  stats(): { claims: number; completions: number; failures: number;
    polls: number; wakes: number; claimErrors: number; inFlight: number;
    /** Leases replaced while a handler was still running. */
    renewals: number;
    /** Attempts whose lease was lost mid-flight — never a completion,
     * never a failure. */
    lostSettlements: number };
  /** The leases this worker holds right now: one per in-flight attempt,
   * each the newest that attempt has been given. */
  leases(): readonly JobLease[];
}

export interface JobWorkerOptions {
  /**
   * `checkpoints` is bound to THIS attempt and follows its current
   * lease, so a renewal does not strand it. `signal` aborts for either
   * reason a handler must wind up for: the worker is stopping, or the
   * job is no longer this attempt's to finish — in which case the
   * signal's `reason` is the coded refusal that says which.
   */
  handlers: Record<string, (payload: unknown, context: {
    job: ClaimedJob;
    checkpoints: { load(runId: string): unknown;
      save(runId: string, nodeId: string, value: unknown): unknown;
      complete(runId: string, result: unknown): unknown };
    signal: AbortSignal }) => unknown>;
  /** A positive integer; the loops claiming concurrently. */
  concurrency?: number;
  pollInterval?: number;
  leaseMs?: number;
  owner?: string;
  /** Renew each attempt's lease while its handler runs (the default).
   * `false` for a handler that must not outlive its lease. */
  renew?: boolean;
  /** Called once per settled attempt, including the lost ones. An
   * observer that throws never affects the loop. */
  onOutcome?: (event: JobOutcome) => void;
  backoffBase?: number;
  backoffCap?: number;
  /** How long `stop()` waits for in-flight handlers by default. */
  stopGraceMs?: number;
}

export interface JobsApi {
  enqueue(kind: string, payload?: unknown,
    options?: { id?: string; runAt?: number; maxAttempts?: number }): Promise<string>;
  get(id: string): Promise<JobRecord | undefined>;
  counts(): Promise<JobCounts>;
  /** The low-level guarded claim the worker itself uses (§3). It mints
   * the fence: a fresh token and the next generation. */
  claim(options: { kinds: string[]; owner: string; leaseMs?: number }):
    Promise<ClaimedJob | undefined>;
  /**
   * Replace a lease with a later one (§3). A handler that runs longer
   * than its lease renews rather than hoping; the lease it is given
   * back supersedes the one it passed in, which then settles nothing.
   *
   * Refuses `JD2065` (the job is not leased — unknown, or already
   * settled), `JD2066` (the lease was superseded) or `JD2067` (it
   * expired), never a silent `false`.
   */
  renew(lease: JobLease, options?: { leaseMs?: number }): Promise<JobLease>;
  /** Settle the attempt this lease holds. `true`, or one of the three
   * coded refusals above — a caller that cannot tell "already done"
   * from "you are stale" guesses, and guesses wrong. */
  complete(lease: JobLease, result?: unknown): Promise<boolean>;
  fail(lease: JobLease, error: unknown): Promise<boolean>;
  /** The per-attempt flow checkpoint store binding (§7). Rows are
   * stamped with the attempt's generation: `load` reads what was
   * written up to it, and a settlement prunes no further, so a stale
   * attempt cannot erase a live one's work. */
  checkpointsFor(job: ClaimedJob): {
    load(runId: string): unknown;
    save(runId: string, nodeId: string, value: unknown): unknown;
    complete(runId: string, result: unknown): unknown;
  };
  createWorker(options: JobWorkerOptions): JobWorker;
}

export interface JobsOptions {
  maxAttempts?: number;
  leaseMs?: number;
  pollInterval?: number;
  backoffBase?: number;
  backoffCap?: number;
  stopGraceMs?: number;
  /** Injectable clock and randomness — every test injects both. */
  now?: () => number;
  random?: () => number;
}

export declare function createDagJobRunner(store: Store, options: {
  compileDag: Function;
  documents: Record<string, unknown>;
  tasks?: Record<string, Function>;
  concurrency?: number;
  pollInterval?: number;
  leaseMs?: number;
  owner?: string;
  renew?: boolean;
  onOutcome?: (event: JobOutcome) => void;
  backoffBase?: number;
  backoffCap?: number;
  stopGraceMs?: number;
}): JobWorker;

/** The checkpoint row a run's identity lives in — the workflow revision
 * and a hash of the input a resume must agree with (`JD2069` when it
 * does not). Pruned with the run it belongs to. */
export declare const RUN_IDENTITY_NODE: string;

export declare function createJobEngine(options: {
  connection: unknown; now?: () => number; random?: () => number;
  defaults?: JobsOptions; runtime?: Partial<Runtime> }): unknown;
export declare const JOBS_TABLE: string;
export declare const JOB_CHECKPOINTS_TABLE: string;
export declare const JOB_DEFAULTS: Readonly<{
  maxAttempts: number; leaseMs: number; pollInterval: number;
  backoffBase: number; backoffCap: number; stopGraceMs: number }>;
/** A total diagnostic string for any value, including ones that fight back. */
export declare function describeValue(value: unknown): string;
/** A job result as the queue stores it: JSON text, or the reason it could not be. */
export declare function serializeResult(value: unknown): unknown;
