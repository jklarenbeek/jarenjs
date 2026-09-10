/**
 * Hand-authored declarations for `@jarenjs/linq/db` — the store's front
 * door. `open(model, options)` answers a `Client` typed from the model
 * pen's phantom (`InferMeta<>`); a JSON model is the honest wide map
 * unless the caller names one (`open<EntityMetaMap>(json, options)`).
 * Every entity handle is the store's typed entity set — its unit of
 * work, its provider members — plus the chain start (every `AsyncSequence`
 * member, over the handle), the graph builder (`include` emits a `load`
 * spec, and the result is `Loaded<>` by what it included), membership
 * (`link`/`unlink` over exactly the many-to-many members) and `live`.
 * The types this file imports from `@jarenjs/db` and `@jarenjs/validate`
 * resolve where the optional peers are installed — a consumer of this
 * subpath has them; no other subpath of the package refers to them.
 */

import type { AsyncSequence, AsyncExplanation, Expr, ExprBase, BoolExpr, OrderOptions } from './index.js';
import type { ModelDocument, CollectionSpec, InferMeta } from './model.js';
import type {
  EntityMeta, MetaMap, TypedEntitySet, TypedStore, TypedLoadSpec, Loaded,
} from '@jarenjs/db/typed';
import type {
  Collection, ExecuteOptions, LiveOptions, LiveQuery, LoadExplanation, OpenStoreOptions,
  SavepointController, SaveReport, StoreCapabilities, TransactionStore,
  EntityCursorOptions, QueryCursor, LoadContinuation, Page,
} from '@jarenjs/db';
import type { JarenValidator } from '@jarenjs/validate';
import type { Runtime } from '@jarenjs/core/runtime';

// ————— open —————

export interface OpenOptions extends OpenStoreOptions {
  /** Wired as the store's `compileSchema`; `defaultValidator()` when
   * absent; `null` opens the store unvalidated (`capabilities.validated
   * === false`, the store's declared downgrade). An explicit
   * `compileSchema` wins over all three. */
  validator?: JarenValidator | null;
}

/** `new JarenValidator({ collectErrors: true })` with the string and
 * date-time formats registered — the configuration the Zod-migration
 * recipe reproduces, so `s.string().email()` asserts out of the box. */
export function defaultValidator(): JarenValidator;

/** The entity metadata a model implies: a pen model's `InferMeta<>`; a
 * JSON literal is never inferred (the wide map). */
export type MetaOf<M> = '__entities' extends keyof M ? InferMeta<M> : Record<string, EntityMeta>;

/** The collection document shapes a pen model declares (a JSON model's
 * are `unknown`). */
export type CollectionsOf<M> = M extends ModelDocument<any, infer C>
  ? { [K in keyof C]: C[K] extends CollectionSpec<infer D> ? D : unknown }
  : Record<string, unknown>;

/** The client a model opens to, with its metadata proven to be a map. */
export type ClientOf<M> = MetaOf<M> extends infer E
  ? (E extends MetaMap<E> ? Client<E, CollectionsOf<M>> : never)
  : never;

/** Open a store behind a client. A pen model types the client from its
 * phantom; a JSON model with a named map (`open<EntityMetaMap>(json,
 * options)`) types it from the map; a bare JSON model is the wide map. */
export function open<M extends { readonly $model: '0.1' }>(model: M, options: OpenOptions): Promise<ClientOf<M>>;
export function open<E extends MetaMap<E> = Record<string, EntityMeta>>(model: object, options: OpenOptions): Promise<Client<E>>;

// ————— the client —————

/** A live query whose maintained rows are typed by the chain's item. */
export type TypedLiveQuery<T> = Omit<LiveQuery, 'result'> & {
  readonly result: { readonly rows: readonly T[] };
};

/** The chain start: every `AsyncSequence` member, delegated to
 * `fromAsync(handle)`; `explain()` without a document explains the empty
 * chain (the handle's own `explain(document)` is the store's). */
export type ChainStart<T> = Omit<AsyncSequence<T, {}>, 'explain'> & {
  explain(): AsyncExplanation;
};

/** A collection handle: the collection, the chain start, and a `live`
 * that takes a chain (its document and bound params) or a document. */
export type CollectionHandle<T> = Omit<Collection<T>, 'live' | 'explain'> & ChainStart<T> & {
  explain(document: unknown, options?: ExecuteOptions): Promise<unknown>;
  live<R = T>(source?: AsyncSequence<R, any> | object, options?: LiveOptions): Promise<TypedLiveQuery<R>>;
};

type TargetMeta<E extends MetaMap<E>, M extends EntityMeta, K extends keyof M['relations']> =
  E[M['relations'][K]['entity'] & keyof E];

/** What `(u) => u.posts` answers at the type level: the member's name. */
export type Picked<K> = { readonly __member: K };
/** The pick callback's argument: exactly the relation members. */
export type RelationPicker<M extends EntityMeta> = {
  readonly [K in keyof M['relations'] & string]: Picked<K>;
};

/** An ordering key over a row: a key callback, or the key with its
 * direction and `$empty`/`$collation` options. */
export type OrderKey<D> =
  | ((it: Expr<D>) => unknown)
  | { readonly key: (it: Expr<D>) => unknown; readonly desc?: boolean;
    readonly empty?: 'least' | 'greatest'; readonly collation?: string };

/** One include's spec (MODEL-FORMAT §10.4): `true` loads the rows,
 * `{ count: true }` the number, and an object the clauses the store's
 * `load` reads — every callback over the TARGET row, nested includes
 * over the target's relations. */
export type IncludeSpec<E extends MetaMap<E>, M extends EntityMeta> =
  | true
  | { readonly count: true }
  | {
    readonly where?: (it: Expr<M['doc']>) => BoolExpr | boolean;
    readonly orderBy?: OrderKey<M['doc']> | readonly OrderKey<M['doc']>[];
    readonly take?: number;
    readonly skip?: number;
    /** The per-root bounds (MODEL-FORMAT §10.4): rows of this relation
     * per parent and serialised bytes per parent; crossing one is the
     * store's `JD2073`, never a truncated graph. `Infinity` spells the
     * unbounded case (emitted as `null`). */
    readonly maxRows?: number;
    readonly maxBytes?: number;
    readonly include?: Includes<E, M>;
  };

/** A nested include record: relation member → its spec. */
export type Includes<E extends MetaMap<E>, M extends EntityMeta> = {
  readonly [K in keyof M['relations'] & string]?: IncludeSpec<E, TargetMeta<E, M, K>>;
};

/** The order-key VALUE types a graph declared, in order: `orderBy` starts
 * the tuple, every `thenBy` appends to it. */
export type OrderOf<S> = S extends { order: infer O extends readonly unknown[] } ? O : [];
type WithOrder<S, O extends readonly unknown[]> = Omit<S, 'order'> & { order: O };

/** The continuation a page over this graph emits, and `after()` takes:
 * the declared order-key values as a tuple whose shape follows
 * `orderBy`/`thenBy` — a two-key ordering needs a two-value `keys` —
 * plus the row's primary key, the tie-breaker the store appends, and
 * the ordering's identity. Unsigned and structural (MODEL-FORMAT §10.5):
 * signing, scoping and expiry are the host's. */
export type Continuation<S, M extends EntityMeta> = LoadContinuation & {
  readonly keys: OrderOf<S>;
  readonly key: M['key'];
};

/** A page's options over this graph (the store's `PageOptions`, the
 * continuation typed by the declared ordering). */
export interface GraphPageOptions<S, M extends EntityMeta> extends EntityCursorOptions {
  lookahead?: boolean;
  limit?: number;
  after?: Continuation<S, M>;
  maxBytes?: number;
  consistency?: 'live' | 'snapshot';
}

/** The graph over one entity set: an immutable builder of the `load`
 * spec, typed by what it included and by what it ordered by. `S`
 * accumulates the include specification `Loaded<>` reads and the
 * `order` tuple `after()`/`page()` are typed by. */
export interface Graph<E extends MetaMap<E>, M extends EntityMeta, S> {
  /** Include one more relation member. (`NoInfer` keeps the spec's
   * callbacks contextually typed while `I` is inferred from the literal —
   * without it TypeScript fixes `I` to its default before typing them.) */
  include<K extends keyof M['relations'] & string, const I extends IncludeSpec<E, TargetMeta<E, M, K>> = true>(
    pick: (u: RelationPicker<M>) => Picked<K>, spec?: I | NoInfer<IncludeSpec<E, TargetMeta<E, M, K>>>,
  ): Graph<E, M, S & { include: { [P in K]: I } }>;
  /** Filter the root rows; consecutive calls conjoin. */
  where(predicate: (it: Expr<M['doc']>) => BoolExpr | boolean): Graph<E, M, S>;
  /** Start the ordering: the key's value type opens the `order` tuple. */
  orderBy<V>(key: (it: Expr<M['doc']>) => ExprBase<V>, options?: OrderOptions): Graph<E, M, WithOrder<S, [V]>>;
  orderByDescending<V>(key: (it: Expr<M['doc']>) => ExprBase<V>, options?: OrderOptions): Graph<E, M, WithOrder<S, [V]>>;
  /** Extend the ordering: the key's value type is appended to the tuple. */
  thenBy<V>(key: (it: Expr<M['doc']>) => ExprBase<V>, options?: OrderOptions): Graph<E, M, WithOrder<S, [...OrderOf<S>, V]>>;
  thenByDescending<V>(key: (it: Expr<M['doc']>) => ExprBase<V>, options?: OrderOptions): Graph<E, M, WithOrder<S, [...OrderOf<S>, V]>>;
  take(count: number): Graph<E, M, S>;
  skip(count: number): Graph<E, M, S>;
  /** Resume after a continuation (§10.5): the value a `page()` over this
   * ordering emitted — its `keys` tuple follows the declared ordering,
   * its `key` is the row's primary key. A bare key is not a continuation. */
  after(cursor: Continuation<S, M>): Graph<E, M, S>;
  /** One bounded page over the composite keyset: `{ items, continuation,
   * hasMore, snapshot }`, never more than `limit` roots or `maxBytes`
   * serialised bytes; `snapshot` is true only over an immutable ordering
   * (the primary key), and `consistency: 'snapshot'` over any other is
   * the store's `JD0036`. Untracked unless `tracking: true`. */
  page(options?: GraphPageOptions<S, M>): Promise<Page<Loaded<E, M, S>, Continuation<S, M>>>;
  /** The include depth bound (§10.4, default 3). */
  maxDepth(depth: number): Graph<E, M, S>;
  /** The same graph, loaded without registering snapshots. */
  asNoTracking(): Graph<E, M, S>;
  /** The emitted `load` spec — plain frozen JSON, a snapshot. */
  toSpec(): TypedLoadSpec<E, M>;
  /** The same document, so `JSON.stringify(graph)` is the spec. */
  toJSON(): TypedLoadSpec<E, M>;
  /** `load(spec)`: the store's one statement, typed by the includes. */
  toArray(): Promise<Array<Loaded<E, M, S>>>;
  /** `loadCursor(spec, options)`: one root graph per pull, its includes
   * attached and bounded, from the same one statement; `return()`
   * releases it. Untracked unless `tracking: true` is spelled per call. */
  cursor(options?: EntityCursorOptions): QueryCursor<Loaded<E, M, S>>;
  /** `explainLoad(spec)`: the SQL, the includes, the pagination strategy. */
  explain(): LoadExplanation;
}

/** An entity handle: the typed entity set, the chain start, and the
 * client's own members. `link`/`unlink` are the typed set's — over
 * exactly the many-to-many members. */
export type EntityHandle<E extends MetaMap<E>, M extends EntityMeta> =
  TypedEntitySet<E, M> & ChainStart<M['doc']> & {
    range(spec: import('@jarenjs/db').LoadSpec, options: DbRangeOptions): Promise<DbRangeProvider<M['doc']>>;
    /** Open a graph: include one relation member with an optional spec. */
    include<K extends keyof M['relations'] & string, const I extends IncludeSpec<E, TargetMeta<E, M, K>> = true>(
      pick: (u: RelationPicker<M>) => Picked<K>, spec?: I | NoInfer<IncludeSpec<E, TargetMeta<E, M, K>>>,
    ): Graph<E, M, { include: { [P in K]: I } }>;
    /** Open a graph with nothing included: the root clauses, the keyset
     * continuation and the page over the rows alone. */
    graph(): Graph<E, M, {}>;
    /** A live query over a chain of this set (the whole set when none
     * is given), through the store's entity-root registration. */
    live<T = M['doc']>(source?: AsyncSequence<T, any> | object, options?: LiveOptions): Promise<TypedLiveQuery<T>>;
  };

export interface DbRangeOptions {
  keys: readonly string[];
  resident?: boolean; seekIndex?: boolean; exactTotal?: boolean;
  source?: string; query?: string; schemaVersion?: string;
  profile?: 'safe' | import('@jarenjs/db').ProfileSpec;
  maxRows?: number; maxBytes?: number; maxPages?: number; maxInFlight?: number; maxSubscriptions?: number;
  runtime?: Partial<Runtime>;
}
export interface DbRangeRequest {
  generation: number; requestId: string; query: string; snapshot: string;
  range?: { start: number; end: number }; continuation?: string;
  credits: { pages: number; rows: number; bytes: number; work: number };
}
export interface DbRangeResponse<T = unknown> {
  generation: number; requestId: string; query: string; snapshot: string;
  state: 'ready' | 'loading' | 'error' | 'invalidated' | 'budget-exhausted'; reason?: string;
  rows?: readonly T[]; keys?: readonly string[]; continuation?: string | null;
  total?: { kind: 'known'; value: number } | { kind: 'unknown' };
  used: { pages: number; rows: number; bytes: number; work: number };
}
export interface DbRangeProvider<T = unknown> {
  readonly query: string; readonly snapshot: string;
  readonly capabilities: Readonly<{ seekIndex: boolean; seekKey: false; continuation: true;
    live: true; exactTotal: boolean; completeExport: false }>;
  request(request: DbRangeRequest, signal?: AbortSignal): Promise<DbRangeResponse<T>>;
  subscribe(observer: (event: { type: 'reset'; reason: string; query: string; snapshot: string; revision: number; capture: string }) => void): () => boolean;
  stats(): { sourceReads: number; sourceRows: number; sourceBytes: number; pending: number;
    pages: number; rows: number; bytes: number; subscriptions: number; disposed: boolean };
  dispose(): Promise<void>;
}
/** Source capture is required; keyset mode is sequential unless resident is explicit. */
export declare function createDbRangeProvider<T = unknown>(store: import('@jarenjs/db').Store | TypedStore<any>,
  entity: string, spec: import('@jarenjs/db').LoadSpec, options: DbRangeOptions): Promise<DbRangeProvider<T>>;

/** Present exactly when the model declares entities, as on the store. */
export interface EntityClientMembers {
  /** The store's unit of work, flushed. */
  saveChanges(): Promise<SaveReport>;
  /** Register an entity-root chain (or document) as a live query: the
   * store's re-run maintenance, declared; `JD0050` without capture. */
  live<T>(source: AsyncSequence<T, any> | object, options?: LiveOptions): Promise<TypedLiveQuery<T>>;
}

// ————— the ledger —————

/** The record `createDbLedger` keeps per `(op, scope, key)`: exactly
 * `idempotencyLedgerModel`'s (`@jarenjs/contract/ledger`), the
 * `generation` the fence verifies included. */
export interface DbLedgerRecord {
  id: string;
  generation: string;
  op: string;
  scope: string;
  key: string;
  hash: string;
  status: 'started' | 'committed' | 'failed';
  response: unknown;
  retryable: boolean | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

/** The ref a `new` claim hands back: the record's id and the generation
 * the claim minted — portable across processes, stale once the key
 * expires or is reclaimed. */
export interface DbLedgerRef {
  readonly id: string;
  readonly generation: string;
}

export type DbClaimResult =
  | { state: 'new'; ref: DbLedgerRef }
  | { state: 'replay'; response: unknown }
  | { state: 'in-progress' }
  | { state: 'mismatch' };

export interface DbLedgerOptions {
  /** The declared collection; `'ledger'` (the model's) by default. */
  collection?: string;
  /** The retention of a key; 86,400,000 ms by default. */
  ttlMs?: number;
  /** The host's runtime record: its `now` is the clock, its `uuid`
   * mints every generation. */
  runtime?: Partial<Runtime>;
  /** The clock; wins over the runtime's. Given neither, the ledger
   * follows the instants the binding passes. */
  now?: () => number;
}

/** The ledger the http binding calls, over the store: structurally the
 * contract package's `Ledger`, every method asynchronous. A `commit` or
 * `fail` whose ref settles no started record rejects `JL2007`. */
export interface DbLedger {
  claim(claim: { op: string; scope: string; key: string; hash: string; now?: number }): Promise<DbClaimResult>;
  commit(ref: unknown, response: unknown, now?: number): Promise<void>;
  fail(ref: unknown, retryable: boolean, response?: unknown, now?: number): Promise<void>;
  lookup(key: { op: string; scope: string; key: string; now?: number }): Promise<DbLedgerRecord | null>;
  /** Drop every expired record; answers how many. */
  sweep(now?: number): Promise<number>;
}

/** What `createDbLedger` needs of a client: the declared collections
 * and a transaction — the root client (claims take the write lock up
 * front, `mode: 'immediate'`) or the one a transaction callback
 * received (claims and settlements nest in that transaction). */
export type LedgerClient =
  | Pick<Client<any, any>, 'collections' | 'transaction' | 'close'>
  | Pick<TransactionClientOf<any, any>, 'collections' | 'transaction'>;

/** The contract ledger over a declared collection of the client's
 * store — no import of `@jarenjs/contract`, no driver, the client's
 * own surface only (DB-CLIENT.md §2.6). A `TypeError` names a client
 * that is not one, a collection the model does not declare, a bad
 * `ttlMs` or `now`. */
export function createDbLedger(client: LedgerClient, options?: DbLedgerOptions): DbLedger;

/** How a transaction relates to the client's unit of work: `'own'` (the
 * default) gives the callback a tracker of its own, so two handlers on
 * one client hold two records for the same entity key; `'shared'` opts
 * back into the client's, for a caller who staged changes outside the
 * transaction and means to save them inside it. */
export interface TransactionOptions {
  readonly unitOfWork?: 'own' | 'shared';
  /** `'immediate'` takes the write lock up front (`BEGIN IMMEDIATE`),
   * so a body that reads before it writes never meets the read→write
   * upgrade busy the handler cannot retry; `'deferred'` (the default)
   * is the savepoint as always. A nested `tx.transaction()` is a
   * savepoint whichever mode the root chose. */
  readonly mode?: 'deferred' | 'immediate';
  /** Abandons the call while it is still QUEUED: the callback never
   * runs and no statement is issued (`JD2064`). */
  readonly signal?: AbortSignal;
}

/**
 * The client a transaction callback receives: the same handles, the
 * same inference, over the store that is INSIDE the transaction.
 *
 * `tx.entities.X` and `tx.collections.Y` run as the transaction's owner
 * and `tx.transaction(...)` nests, while the outer client's handles are
 * an unrelated caller — one awaited from in here waits for the commit it
 * is part of, which `JD0012` names rather than hangs on.
 */
export type TransactionClientOf<E extends MetaMap<E>, C = Record<string, unknown>> = {
  /** The scope-bound store — the escape hatch, still inside. It carries
   * no `close`: a transaction never owns the connection's lifetime. */
  readonly store: TransactionStore;
  readonly sql: TransactionStore['sql'];
  readonly jobs: TransactionStore['jobs'];
  readonly sync: TransactionStore['sync'];
  readonly capabilities: StoreCapabilities;
  readonly entities: { readonly [K in keyof E & string]: EntityHandle<E, E[K]> };
  readonly collections: { readonly [K in keyof C & string]: CollectionHandle<C[K]> };
  /** Nest through this transaction's savepoint. */
  transaction<R>(fn: (tx: TransactionClientOf<E, C>) => R | Promise<R>): Promise<Awaited<R>>;
  /** Named partial rollback (MODEL-FORMAT §5.2) — the store's
   * `tx.savepoints`, forwarded unchanged: create, roll back to and
   * release a checkpoint by label without a sentinel exception. Only a
   * live transaction has it; the root client deliberately has no twin,
   * and a handle kept past its callback is `JD2070`. */
  readonly savepoints: SavepointController;
} & ([keyof E] extends [never] ? {} : EntityClientMembers);

/** The client: one frozen record of handles per declared name, the
 * store beneath it, and the pass-throughs. */
export type Client<E extends MetaMap<E>, C = Record<string, unknown>> = {
  /** The store itself — the escape hatch, typed. */
  readonly store: TypedStore<E>;
  readonly capabilities: StoreCapabilities;
  readonly entities: { readonly [K in keyof E & string]: EntityHandle<E, E[K]> };
  readonly collections: { readonly [K in keyof C & string]: CollectionHandle<C[K]> };
  /** A transaction, with a typed client of its own. */
  transaction<R>(fn: (tx: TransactionClientOf<E, C>) => R | Promise<R>,
    options?: TransactionOptions): Promise<Awaited<R>>;
  close(options?: { graceMs?: number }): Promise<void>;
} & ([keyof E] extends [never] ? {} : EntityClientMembers);

/** Author a logical envelope using the DB's canonical format validator. */
export function defineReplication(header: Omit<import('@jarenjs/db').ReplicationEnvelope, '$replication' | 'operations'>): {
  change(table: string, key: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): ReturnType<typeof defineReplication>;
  toDocument(): import('@jarenjs/db').ReplicationEnvelope;
  toJSON(): import('@jarenjs/db').ReplicationEnvelope;
};
