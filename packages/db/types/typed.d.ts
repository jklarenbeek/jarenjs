/**
 * The typed-store surface: bind a generated `EntityMetaMap` (from
 * `entityEmitModel` + `@jarenjs/emit`) to an opened store and the
 * entity sets speak the generated shapes — inputs on `create`/`add`,
 * documents on reads, and `load` results WIDENED by their include
 * specification, relation by relation, `count: true` as a number,
 * to-one includes as `Doc | null`.
 *
 * THE LINE, again: where clauses and orderings are query expressions
 * with their own format — they stay `unknown` here, checked by the
 * runtime's refusal codes, not by TypeScript. The include SHAPE is
 * what only a model knows, and that is what this file types.
 */

import type {
  EntityKeyArg, LoadExplanation, SaveReport, Store, StoreCapabilities,
  StoreStats, Collection, ExecuteOptions, SequenceResult, ValueOrPromise,
  Dialect, ChangeRecord, LiveOptions, LiveQuery, JobsApi, SyncStore,
  EntityScope, RelationEntry, RelationTable,
} from '@jarenjs/db';

/** The self-referential constraint an interface can satisfy: generated
 * `EntityMetaMap` interfaces carry no index signature, so the generics
 * constrain against their own keys instead of `Record<string, …>`. */
export type MetaMap<E> = { [K in keyof E]: EntityMeta };

/** One entity's generated metadata: the `EntityMetaMap` entry shape. */
export interface EntityMeta {
  doc: object;
  input: object;
  key: unknown;
  relations: Record<string, { entity: string; doc: object; many: boolean }>;
}

/** The include clause for one relation of `M`, recursing through the
 * metadata map so nested includes stay precise. */
export type TypedInclude<E extends MetaMap<E>, M extends EntityMeta> = {
  readonly [K in keyof M['relations']]?:
    true
    | { count: true }
    | TypedLoadSpec<E, E[M['relations'][K]['entity'] & keyof E]>;
};

export interface TypedLoadSpecBase {
  /** A query expression over `$it` — its format is the runtime's. */
  where?: unknown;
  orderBy?: unknown;
  take?: number;
  skip?: number;
  maxDepth?: number;
}

export type TypedLoadSpec<E extends MetaMap<E>, M extends EntityMeta> =
  TypedLoadSpecBase & {
    after?: M['key'] extends string | number ? M['key'] : never;
    include?: TypedInclude<E, M>;
  };

/** The result of one load: the document, widened by what the include
 * specification asked for. A wrong include key never types. */
export type Loaded<
  E extends MetaMap<E>,
  M extends EntityMeta,
  S,
> = M['doc'] & (S extends { include: infer I } ? {
  -readonly [K in keyof I & keyof M['relations']]-?:
    I[K] extends { count: true } ? number
      : M['relations'][K]['many'] extends true
        ? Array<Loaded<E, E[M['relations'][K]['entity'] & keyof E], I[K]>>
        : Loaded<E, E[M['relations'][K]['entity'] & keyof E], I[K]> | null;
} : NonNullable<unknown>);

export interface TypedUntrackedReads<E extends MetaMap<E>, M extends EntityMeta> {
  get(key: EntityKeyArg): Promise<M['doc'] | undefined>;
  load<const S extends TypedLoadSpec<E, M>>(spec?: S): Promise<Array<Loaded<E, M, S>>>;
}

export interface TypedEntitySet<E extends MetaMap<E>, M extends EntityMeta> {
  /** The provider phantom: `from(typed.entity('User'))` infers `User`
   * without a cast. */
  readonly __item?: M['doc'];
  create(doc: M['input']): Promise<Readonly<M['doc']>>;
  get(key: EntityKeyArg): Promise<Readonly<M['doc']> | undefined>;
  /** A relation member is a projection, never stored state: `update()`
   * refuses it (`JD2003`), and the type does not offer it. */
  update(key: EntityKeyArg, changes: Partial<Omit<M['doc'], keyof M['relations']>>): Promise<Readonly<M['doc']>>;
  delete(key: EntityKeyArg): Promise<boolean>;
  load<const S extends TypedLoadSpec<E, M>>(spec?: S):
    Promise<Array<Readonly<Loaded<E, M, S>>>>;
  explainLoad(spec?: TypedLoadSpec<E, M>): LoadExplanation;
  add(doc: M['input']): Readonly<M['doc']>;
  put(next: M['doc']): Readonly<M['doc']>;
  remove(key: EntityKeyArg | M['doc']): void;
  discard(key: EntityKeyArg | M['doc']): void;
  asNoTracking(): TypedUntrackedReads<E, M>;
  /** The provider contract over this entity's root (MODEL-FORMAT §10.1);
   * the answer is the engine's result shape, value-or-promise (D2). */
  execute<R = unknown>(document: unknown, options?: ExecuteOptions): ValueOrPromise<SequenceResult<R>>;
  explain(document: unknown, options?: ExecuteOptions): Promise<unknown>;
  /** The root expression this set's rows are bound through (`$.<Name>[*]`). */
  readonly root: string;
  /** The identity every entity set of one store shares; it carries every
   * root's relation table. */
  readonly scope: EntityScope;
  /** This entity's relation table (MODEL-FORMAT §10.1): exactly the
   * generated metadata's relation members, as the plain rows a query
   * producer lowers a hop from. */
  readonly relations: Readonly<Record<keyof M['relations'] & string, RelationEntry>>;
}

/** The typed store: every member of `Store` (a typed store is the same
 * object, identity at runtime), with the entity sets typed. */
export interface TypedStore<E extends MetaMap<E>> {
  readonly capabilities: StoreCapabilities;
  readonly dialect: Dialect;
  stats(): StoreStats;
  collection<T = unknown>(name: string): Collection<T>;
  entity<K extends keyof E & string>(name: K): TypedEntitySet<E, E[K]>;
  execute?<R = unknown>(document: unknown, options?: ExecuteOptions): ValueOrPromise<SequenceResult<R>>;
  explain?(document: unknown, options?: ExecuteOptions): Promise<unknown>;
  /** The entity roots this store-level provider serves (present with entities). */
  readonly roots?: readonly (keyof E & string)[];
  /** The relation tables of every entity, keyed by entity name. */
  readonly relations?: Readonly<Record<keyof E & string, RelationTable>>;
  saveChanges?(): Promise<SaveReport>;
  transaction<R>(fn: (store: Store) => R | Promise<R>): Promise<Awaited<R>>;
  observe(fn: (record: ChangeRecord) => void): () => void;
  changesSince?(after: number): Promise<ChangeRecord[]>;
  dataVersion(): Promise<number>;
  live?(document: unknown, options?: LiveOptions): Promise<LiveQuery>;
  close(options?: { graceMs?: number }): Promise<void>;
  readonly jobs?: JobsApi;
  readonly sync?: SyncStore;
}

/**
 * Bind a store to its generated entity metadata. Identity at runtime;
 * every guarantee is in the types.
 */
export declare function typedStore<E extends MetaMap<E>>(
  store: Store,
): TypedStore<E>;
