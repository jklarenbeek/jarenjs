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
  return(): Promise<IteratorResult<T, undefined>>;
  [Symbol.asyncIterator](): QueryCursor<T>;
}

export interface ExecuteOptions {
  externals?: Readonly<Record<string, unknown>>;
  strict?: boolean;
  /** `false` forces the set residual — the oracle's harness switch. */
  pushdown?: boolean;
}

export interface LoadInclude extends LoadSpec {
  /** Project the related-row COUNT instead of the rows. */
  count?: boolean;
}

export interface LoadSpec {
  /** A query expression over `$it` (translatable clauses only). */
  where?: unknown;
  orderBy?: unknown;
  take?: number;
  skip?: number;
  /** The keyset cursor: needs a single unique-column ordering. */
  after?: string | number;
  maxDepth?: number;
  include?: Readonly<Record<string, boolean | LoadInclude>>;
}

export interface LoadExplanation {
  sql: string;
  pagination: 'keyset' | 'offset' | 'none';
  includes: ReadonlyArray<{ path: string; kind: string; count: boolean }>;
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
  query<R = unknown>(document: unknown, options?: ExecuteOptions): QueryCursor<R>;
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

export interface UntrackedReads<T = unknown> {
  get(key: EntityKeyArg): Promise<T | undefined>;
  load(spec?: LoadSpec): Promise<T[]>;
}

export interface EntitySet<T = unknown, I = unknown> {
  create(doc: I): Promise<Readonly<T>>;
  get(key: EntityKeyArg): Promise<Readonly<T> | undefined>;
  update(key: EntityKeyArg, changes: Partial<T>): Promise<Readonly<T>>;
  delete(key: EntityKeyArg): Promise<boolean>;
  load(spec?: LoadSpec): Promise<ReadonlyArray<Readonly<T>>>;
  explainLoad(spec?: LoadSpec): LoadExplanation;
  /** Track a pending insert (local, synchronous — no round trip). */
  add(doc: I): Readonly<T>;
  /** Register the next version of a tracked entity. */
  put(next: T): Readonly<T>;
  /** Schedule a delete (local, synchronous). */
  remove(key: EntityKeyArg | T): void;
  /** Drop tracking without scheduling anything — conflict recovery. */
  discard(key: EntityKeyArg | T): void;
  asNoTracking(): UntrackedReads<T>;
}

export interface SyncUntrackedReads<T = unknown> {
  get(key: EntityKeyArg): T | undefined;
  load(spec?: LoadSpec): T[];
}

export interface SyncEntitySet<T = unknown, I = unknown> {
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
  asNoTracking(): SyncUntrackedReads<T>;
}

// ————— the store —————

export interface SyncStore {
  /** `T` is the collection's document shape — the model's schema in
   * the consumer's words; the handle's writes take it and reads answer it. */
  collection<T = unknown>(name: string): SyncCollection<T>;
  entity(name: string): SyncEntitySet;
  transaction<R>(fn: (store: Store) => R): R;
  execute?<R = unknown>(document: unknown, options?: ExecuteOptions): SequenceResult<R>;
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
  /** The unit of work (§11); present only with entities. */
  saveChanges?(): Promise<SaveReport>;
  transaction<R>(fn: (store: Store) => R | Promise<R>): Promise<Awaited<R>>;
  /** Register a change observer; requires capture. Returns unsubscribe. */
  observe(fn: (record: ChangeRecord) => void): () => void;
  /** Read the persisted log forward (JD2051 without capture.log). */
  changesSince?(after: number): Promise<ChangeRecord[]>;
  /** PRAGMA data_version — the coarse cross-connection signal. */
  dataVersion(): Promise<number>;
  /** Register a live query over an entity-root document (re-run
   * strategy in this version); present only with entities. */
  live?(document: unknown, options?: LiveOptions): Promise<LiveQuery>;
  /** Close the store. Job workers are asked to stop and given
   * `graceMs` to wind up; the connection closes whether or not they
   * did, and a handler still in flight is reported as JD2062. */
  close(options?: { graceMs?: number }): Promise<void>;
  /** The queue surface; present when opened with `jobs` (JOBS-FORMAT). */
  readonly jobs?: JobsApi;
  /** Present exactly when the driver is synchronous — never stubs. */
  readonly sync?: SyncStore;
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
  busyTimeout?: number;
  /** How long work waits for an open transaction to settle before
   * `JD0012` (MODEL-FORMAT §5.1); reaches every driver. */
  queueTimeout?: number;
  journalMode?: string;
  statementCacheBound?: number;
  profile?: unknown;
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
export declare function sequenceResult(items: unknown[]): unknown;
export declare function deterministicFragment(fragment: unknown): unknown;
export declare function registerFragment(connection: unknown, registered: Set<string>, fragment: unknown): void;
export declare function createQueryEngine(context: unknown): unknown;
export declare function createQueryState(bound?: number): unknown;
export declare function createEntityQueryEngine(context: unknown): unknown;
export declare function createLoadEngine(context: unknown, entityName: string): unknown;
export declare const INCLUDE_DEPTH_DEFAULT: number;
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
  readonly lastError: string | null;
  readonly result: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
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

export interface JobWorker {
  start(): JobWorker;
  /** Stop claiming, signal in-flight handlers, and wait up to `graceMs`
   * (JOBS-FORMAT §6): the record says whether every loop drained. */
  stop(options?: { graceMs?: number }): Promise<{ drained: boolean; inFlight: number }>;
  stats(): { claims: number; completions: number; failures: number;
    polls: number; wakes: number; claimErrors: number; inFlight: number };
}

export interface JobWorkerOptions {
  handlers: Record<string, (payload: unknown, context: {
    job: JobRecord; checkpointsFor: Function; signal: AbortSignal }) => unknown>;
  /** A positive integer; the loops claiming concurrently. */
  concurrency?: number;
  pollInterval?: number;
  leaseMs?: number;
  owner?: string;
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
  /** The low-level guarded claim the worker itself uses (§3). */
  claim(options: { kinds: string[]; owner: string; leaseMs?: number }):
    Promise<JobRecord | undefined>;
  complete(id: string, owner: string, result?: unknown): Promise<boolean>;
  fail(id: string, owner: string, error: unknown): Promise<boolean>;
  /** The per-job flow checkpoint store binding (§7). */
  checkpointsFor(job: JobRecord): {
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
  backoffBase?: number;
  backoffCap?: number;
  stopGraceMs?: number;
}): JobWorker;

export declare function createJobEngine(options: {
  connection: unknown; now?: () => number; random?: () => number;
  defaults?: JobsOptions }): unknown;
export declare const JOBS_TABLE: string;
export declare const JOB_CHECKPOINTS_TABLE: string;
export declare const JOB_DEFAULTS: Readonly<{
  maxAttempts: number; leaseMs: number; pollInterval: number;
  backoffBase: number; backoffCap: number; stopGraceMs: number }>;
/** A total diagnostic string for any value, including ones that fight back. */
export declare function describeValue(value: unknown): string;
/** A job result as the queue stores it: JSON text, or the reason it could not be. */
export declare function serializeResult(value: unknown): unknown;
