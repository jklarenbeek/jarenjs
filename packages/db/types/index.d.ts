/**
 * Hand-authored declarations for @jarenjs/db — the deliberate public
 * type surface (strategy 1, the same decision TODO_05 recorded for
 * linq): the implementation stays plain JSDoc'd JavaScript, and this
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
}

export interface StoreCapabilities {
  readonly version: string;
  readonly readOnly: boolean;
  readonly validated: boolean;
  readonly profiled: boolean;
  readonly busyTimeoutMs: number | null;
  readonly journalMode: string | null;
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
  /** The D2 provider: value-or-promise so a linq chain over a
   * synchronous driver stays synchronous. */
  execute(document: unknown, options?: ExecuteOptions): unknown;
  query(document: unknown, options?: ExecuteOptions): unknown;
  explain(document: unknown, options?: ExecuteOptions): Promise<unknown>;
}

export interface SyncCollection<T = unknown> {
  stats(): unknown;
  insert(doc: T): string | number;
  get(key: string | number): T | undefined;
  put(doc: T, key?: string | number): string | number;
  patch(key: string | number, ops: readonly unknown[]): T;
  delete(key: string | number): boolean;
  execute(document: unknown, options?: ExecuteOptions): unknown;
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
  collection(name: string): SyncCollection;
  entity(name: string): SyncEntitySet;
  transaction<R>(fn: (store: Store) => R): R;
  execute?(document: unknown, options?: ExecuteOptions): unknown;
  saveChanges?(): SaveReport;
}

export interface Store {
  readonly capabilities: StoreCapabilities;
  readonly dialect: Dialect;
  stats(): StoreStats;
  collection(name: string): Collection;
  entity(name: string): EntitySet;
  /** Entity documents over the multi-entity root (§10.1); present
   * only when the model declares entities. Value-or-promise (D2). */
  execute?(document: unknown, options?: ExecuteOptions): unknown;
  explain?(document: unknown, options?: ExecuteOptions): Promise<unknown>;
  /** The unit of work (§11); present only with entities. */
  saveChanges?(): Promise<SaveReport>;
  transaction<R>(fn: (store: Store) => R | Promise<R>): Promise<Awaited<R>>;
  close(): Promise<void>;
  /** Present exactly when the driver is synchronous — never stubs. */
  readonly sync?: SyncStore;
}

export interface OpenStoreOptions {
  driver: Driver;
  path?: string;
  /** The injected validation hook (D10); absent means unvalidated,
   * declared through `capabilities.validated`. */
  compileSchema?: (schema: unknown) => (doc: unknown) => unknown;
  busyTimeout?: number;
  journalMode?: string;
  statementCacheBound?: number;
  profile?: unknown;
  readOnly?: boolean;
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
  open(options?: unknown): unknown;
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
export declare function compileIndexPath(path: string, schema: unknown): unknown;
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
