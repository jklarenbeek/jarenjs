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

import type { AsyncSequence, AsyncExplanation, Expr, BoolExpr, OrderOptions } from './index.js';
import type { ModelDocument, CollectionSpec, InferMeta } from './model.js';
import type {
  EntityMeta, MetaMap, TypedEntitySet, TypedStore, TypedLoadSpec, Loaded,
} from '@jarenjs/db/typed';
import type {
  Collection, ExecuteOptions, LiveOptions, LiveQuery, LoadExplanation, OpenStoreOptions,
  SaveReport, StoreCapabilities, TransactionStore,
} from '@jarenjs/db';
import type { JarenValidator } from '@jarenjs/validate';

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
    readonly include?: Includes<E, M>;
  };

/** A nested include record: relation member → its spec. */
export type Includes<E extends MetaMap<E>, M extends EntityMeta> = {
  readonly [K in keyof M['relations'] & string]?: IncludeSpec<E, TargetMeta<E, M, K>>;
};

/** The graph over one entity set: an immutable builder of the `load`
 * spec, typed by what it included. `S` accumulates the include
 * specification `Loaded<>` reads. */
export interface Graph<E extends MetaMap<E>, M extends EntityMeta, S> {
  /** Include one more relation member. (`NoInfer` keeps the spec's
   * callbacks contextually typed while `I` is inferred from the literal —
   * without it TypeScript fixes `I` to its default before typing them.) */
  include<K extends keyof M['relations'] & string, const I extends IncludeSpec<E, TargetMeta<E, M, K>> = true>(
    pick: (u: RelationPicker<M>) => Picked<K>, spec?: I | NoInfer<IncludeSpec<E, TargetMeta<E, M, K>>>,
  ): Graph<E, M, S & { include: { [P in K]: I } }>;
  /** Filter the root rows; consecutive calls conjoin. */
  where(predicate: (it: Expr<M['doc']>) => BoolExpr | boolean): Graph<E, M, S>;
  orderBy(key: (it: Expr<M['doc']>) => unknown, options?: OrderOptions): Graph<E, M, S>;
  orderByDescending(key: (it: Expr<M['doc']>) => unknown, options?: OrderOptions): Graph<E, M, S>;
  thenBy(key: (it: Expr<M['doc']>) => unknown, options?: OrderOptions): Graph<E, M, S>;
  thenByDescending(key: (it: Expr<M['doc']>) => unknown, options?: OrderOptions): Graph<E, M, S>;
  take(count: number): Graph<E, M, S>;
  skip(count: number): Graph<E, M, S>;
  /** The keyset cursor (§10.5): the key of the last row of the previous page. */
  after(cursor: M['key']): Graph<E, M, S>;
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
  /** `explainLoad(spec)`: the SQL, the includes, the pagination strategy. */
  explain(): LoadExplanation;
}

/** An entity handle: the typed entity set, the chain start, and the
 * client's own members. `link`/`unlink` are the typed set's — over
 * exactly the many-to-many members. */
export type EntityHandle<E extends MetaMap<E>, M extends EntityMeta> =
  TypedEntitySet<E, M> & ChainStart<M['doc']> & {
    /** Open a graph: include one relation member with an optional spec. */
    include<K extends keyof M['relations'] & string, const I extends IncludeSpec<E, TargetMeta<E, M, K>> = true>(
      pick: (u: RelationPicker<M>) => Picked<K>, spec?: I | NoInfer<IncludeSpec<E, TargetMeta<E, M, K>>>,
    ): Graph<E, M, { include: { [P in K]: I } }>;
    /** A live query over a chain of this set (the whole set when none
     * is given), through the store's entity-root registration. */
    live<T = M['doc']>(source?: AsyncSequence<T, any> | object, options?: LiveOptions): Promise<TypedLiveQuery<T>>;
  };

/** Present exactly when the model declares entities, as on the store. */
export interface EntityClientMembers {
  /** The store's unit of work, flushed. */
  saveChanges(): Promise<SaveReport>;
  /** Register an entity-root chain (or document) as a live query: the
   * store's re-run maintenance, declared; `JD0050` without capture. */
  live<T>(source: AsyncSequence<T, any> | object, options?: LiveOptions): Promise<TypedLiveQuery<T>>;
}

/** How a transaction relates to the client's unit of work: `'own'` (the
 * default) gives the callback a tracker of its own, so two handlers on
 * one client hold two records for the same entity key; `'shared'` opts
 * back into the client's, for a caller who staged changes outside the
 * transaction and means to save them inside it. */
export interface TransactionOptions {
  readonly unitOfWork?: 'own' | 'shared';
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
  /** The scope-bound store — the escape hatch, still inside. */
  readonly store: TransactionStore;
  readonly capabilities: StoreCapabilities;
  readonly entities: { readonly [K in keyof E & string]: EntityHandle<E, E[K]> };
  readonly collections: { readonly [K in keyof C & string]: CollectionHandle<C[K]> };
  /** Nest through this transaction's savepoint. */
  transaction<R>(fn: (tx: TransactionClientOf<E, C>) => R | Promise<R>): Promise<Awaited<R>>;
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
