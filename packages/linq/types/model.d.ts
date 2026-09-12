/**
 * Hand-authored declarations for `@jarenjs/linq/model` — the schema
 * pen's every name, from subclasses that carry the `x-entity`
 * vocabulary, plus relation members, collections, indexes and
 * `defineModel()`. `InferMeta<>` reads the model document's phantom the
 * way `entityEmitModel` reads the document itself: closed entity
 * interfaces (nested shapes included), relation members as optional
 * references, date-formatted strings as `DateTime`, an input variant
 * with store-written members optional, to-one/to-many projections
 * dropped and many-to-many members as key-or-document arrays, a key of
 * the key member's primitive (or the composite object), and the
 * relations map. The agreement is pinned: `InferMeta<>` of the fixture
 * model rebuilt through the pen equals the generated `EntityMetaMap`.
 */

import type { DateTime, Expr } from './index.js';
import type {
  Annotations, BuilderLike, CheckRule, Flag, FlagsOf, Infer, Input, Json, JsonSchema,
  NamedLike, Simplify, SchemaBuilder, StringBuilder, NumberBuilder, BooleanBuilder,
  NullBuilder, ArrayBuilder, TupleBuilder, ObjectBuilder, NamedBuilder, WhenBuilder,
  NeverBuilder,
} from './schema.js';

type AnyBuilder = BuilderLike<any, any, any>;
type Props = Record<string, AnyBuilder>;
type Nullify<T, N extends boolean> = N extends true ? T | null : T;

/** A store-written default marks the member `generated`; `key()` marks it `key`. */
type Generated<F extends Flag> = F | 'generated';

/**
 * The closed `x-entity` vocabulary (MODEL-FORMAT §9.2), as `entity()`
 * writes it. A member outside this set is `JL0102`: the store refuses a
 * mapping directive it cannot read rather than ignoring it, so the pen
 * refuses it first. The named methods below are the way to spell each of
 * these — they also carry the FLAGS `InferMeta<>` reads, which the
 * untyped primitive cannot.
 */
export interface EntityBlock {
  /** (Part of) the primary key. */
  readonly key?: true;
  /** A unique index over the member's column. */
  readonly unique?: true;
  /** A non-unique index over the member's column. */
  readonly index?: true;
  /** The optimistic-concurrency token: one plain integer column (§11.5). */
  readonly version?: true;
  /** An epoch column beside a date string, or stay in the document (§9.3). */
  readonly column?: 'integer' | 'json';
  /** Applied on write, in JavaScript (§9.6). */
  readonly default?: 'now' | 'updated' | 'uuid' | 'auto'
    | { readonly value: Json }
    | { readonly query: { readonly [keyword: string]: unknown } };
  /** A relation, as `rel.*` spells one (§9.4). */
  readonly relation?: {
    readonly to: string;
    readonly many?: true;
    readonly via?: string;
    readonly through?: string;
    readonly onDelete?: 'cascade' | 'restrict' | 'setNull';
  };
}

/** Explicit column-only layout for an existing SQLite object. */
export interface PhysicalLayout {
  readonly table: string;
  readonly kind?: 'table' | 'view';
  readonly keys?: readonly string[];
  readonly constraints?: readonly object[];
  readonly indexes?: readonly object[];
  readonly triggers?: readonly object[];
  readonly strict?: boolean;
  readonly withoutRowid?: boolean;
  readonly columns: Readonly<Record<string, {
    readonly name: string;
    readonly codec: 'text' | 'integer' | 'number' | 'boolean' | 'json' | 'date' | 'datetime' | 'epoch-ms' | 'bigint' | 'decimal' | 'blob-hex';
    readonly null: 'null' | 'absent' | 'reject';
    readonly default?: 'database';
    readonly generated?: boolean;
    readonly type?: 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' | 'NUMERIC';
    readonly defaultValue?: unknown;
    readonly collation?: 'BINARY' | 'NOCASE' | 'RTRIM';
    readonly identity?: 'rowid' | 'autoincrement';
    readonly check?: unknown;
    readonly generatedExpression?: unknown;
    readonly stored?: boolean;
  }>>;
}

// ————— the entity-aware builders —————

/** The base every untyped kind is built from, plus the vocabulary. */
export class EntityBuilder<Out = unknown, In = Out, F extends Flag = never> extends SchemaBuilder<Out, In, F> {
  optional(): EntityBuilder<Out, In, F | 'optional'>;
  nullable(): EntityBuilder<Out | null, In | null, F>;
  default(value: Out): EntityBuilder<Out, In, F | 'defaulted'>;
  /** `key: true` — (part of) the primary key. */
  key(): EntityBuilder<Out, In, F | 'key'>;
  /** `unique: true` — a unique index over the column. */
  unique(): this;
  /** `index: true` — a non-unique index over the column. */
  index(): this;
  /** `column: 'json'` keeps a scalar in the document. */
  column(storage: 'json'): this;
  /** `default: { value }` — a literal, filled when absent. */
  fill(value: Out): EntityBuilder<Out, In, Generated<F>>;
  /** `default: { query }` — over the document being written (`$`); no externals. */
  compute(rule: ComputeRule): EntityBuilder<Out, In, Generated<F>>;
  /** Merge into the `x-entity` block — the primitive every method above
   * writes through, held to the closed vocabulary. It carries no flag, so
   * `key()`/`identity()`/`fill()` and the rest stay the way to spell one. */
  entity(patch: EntityBlock): this;
  /** As in the schema pen, but `x-entity` is owned here. */
  meta(annotations: Annotations & { readonly 'x-entity'?: never }): this;
}

export class EntityStringBuilder<Out = string, In = Out, F extends Flag = never> extends StringBuilder<Out, In, F> {
  optional(): EntityStringBuilder<Out, In, F | 'optional'>;
  nullable(): EntityStringBuilder<Out | null, In | null, F>;
  default(value: Out): EntityStringBuilder<Out, In, F | 'defaulted'>;
  coerce(): EntityStringBuilder<Out, In | number | boolean, F>;
  format(name: 'date-time' | 'date'): EntityStringBuilder<DateTime, DateTime, F>;
  format(name: string): this;
  enumOf<const V extends readonly string[]>(values: V): EntityStringBuilder<V[number], V[number], F>;
  key(): EntityStringBuilder<Out, In, F | 'key'>;
  unique(): this;
  index(): this;
  /** `column: 'integer'` — an epoch column, on a `datetime()`/`date()` only. */
  column(storage: 'json'): this;
  column(this: EntityStringBuilder<DateTime, any, any>, storage: 'integer'): this;
  /** A store-allocated key: `key: true` + `default: 'uuid'` (`crypto.randomUUID()`). */
  identity(kind: 'uuid'): EntityStringBuilder<Out, In, Generated<F> | 'key'>;
  /** `default: 'now'` — an RFC 3339 stamp on insert, when absent. */
  now(): EntityStringBuilder<Out, In, Generated<F>>;
  /** `default: 'updated'` — a stamp on insert and on every update. */
  updated(): EntityStringBuilder<Out, In, Generated<F>>;
  fill(value: Out): EntityStringBuilder<Out, In, Generated<F>>;
  compute(rule: ComputeRule): EntityStringBuilder<Out, In, Generated<F>>;
  /** Merge into the `x-entity` block — the primitive every method above
   * writes through, held to the closed vocabulary. It carries no flag, so
   * `key()`/`identity()`/`fill()` and the rest stay the way to spell one. */
  entity(patch: EntityBlock): this;
  meta(annotations: Annotations & { readonly 'x-entity'?: never }): this;
}

export class EntityNumberBuilder<Out = number, In = Out, F extends Flag = never> extends NumberBuilder<Out, In, F> {
  optional(): EntityNumberBuilder<Out, In, F | 'optional'>;
  nullable(): EntityNumberBuilder<Out | null, In | null, F>;
  default(value: Out): EntityNumberBuilder<Out, In, F | 'defaulted'>;
  coerce(): EntityNumberBuilder<Out, In | string, F>;
  enumOf<const V extends readonly number[]>(values: V): EntityNumberBuilder<V[number], V[number] | Exclude<In, number>, F>;
  key(): EntityNumberBuilder<Out, In, F | 'key'>;
  unique(): this;
  index(): this;
  /** `version: true` — the optimistic-concurrency token (an integer). */
  version(): this;
  column(storage: 'json'): this;
  /** A store-allocated key: `key: true` + `default: 'auto'` (the database allocates an integer). */
  identity(kind: 'auto'): EntityNumberBuilder<Out, In, Generated<F> | 'key'>;
  fill(value: Out): EntityNumberBuilder<Out, In, Generated<F>>;
  compute(rule: ComputeRule): EntityNumberBuilder<Out, In, Generated<F>>;
  /** Merge into the `x-entity` block — the primitive every method above
   * writes through, held to the closed vocabulary. It carries no flag, so
   * `key()`/`identity()`/`fill()` and the rest stay the way to spell one. */
  entity(patch: EntityBlock): this;
  meta(annotations: Annotations & { readonly 'x-entity'?: never }): this;
}

declare class EntityBooleanBuilder<Out = boolean, In = Out, F extends Flag = never> extends BooleanBuilder<Out, In, F> {
  optional(): EntityBooleanBuilder<Out, In, F | 'optional'>;
  nullable(): EntityBooleanBuilder<Out | null, In | null, F>;
  default(value: Out): EntityBooleanBuilder<Out, In, F | 'defaulted'>;
  coerce(): EntityBooleanBuilder<Out, In | string, F>;
  key(): EntityBooleanBuilder<Out, In, F | 'key'>;
  unique(): this;
  index(): this;
  column(storage: 'json'): this;
  fill(value: Out): EntityBooleanBuilder<Out, In, Generated<F>>;
  compute(rule: ComputeRule): EntityBooleanBuilder<Out, In, Generated<F>>;
  /** Merge into the `x-entity` block — the primitive every method above
   * writes through, held to the closed vocabulary. It carries no flag, so
   * `key()`/`identity()`/`fill()` and the rest stay the way to spell one. */
  entity(patch: EntityBlock): this;
  meta(annotations: Annotations & { readonly 'x-entity'?: never }): this;
}

declare class EntityNullBuilder<Out = null, In = Out, F extends Flag = never> extends NullBuilder<Out, In, F> {
  optional(): EntityNullBuilder<Out, In, F | 'optional'>;
  default(value: Out): EntityNullBuilder<Out, In, F | 'defaulted'>;
  coerce(): EntityNullBuilder<Out, In | string, F>;
  column(storage: 'json'): this;
  fill(value: Out): EntityNullBuilder<Out, In, Generated<F>>;
  compute(rule: ComputeRule): EntityNullBuilder<Out, In, Generated<F>>;
  /** Merge into the `x-entity` block — the primitive every method above
   * writes through, held to the closed vocabulary. It carries no flag, so
   * `key()`/`identity()`/`fill()` and the rest stay the way to spell one. */
  entity(patch: EntityBlock): this;
  meta(annotations: Annotations & { readonly 'x-entity'?: never }): this;
}

export class EntityArrayBuilder<Out = unknown[], In = Out, F extends Flag = never> extends ArrayBuilder<Out, In, F> {
  optional(): EntityArrayBuilder<Out, In, F | 'optional'>;
  nullable(): EntityArrayBuilder<Out | null, In | null, F>;
  default(value: Out): EntityArrayBuilder<Out, In, F | 'defaulted'>;
  fill(value: Out): EntityArrayBuilder<Out, In, Generated<F>>;
  compute(rule: ComputeRule): EntityArrayBuilder<Out, In, Generated<F>>;
  /** Merge into the `x-entity` block — the primitive every method above
   * writes through, held to the closed vocabulary. It carries no flag, so
   * `key()`/`identity()`/`fill()` and the rest stay the way to spell one. */
  entity(patch: EntityBlock): this;
  meta(annotations: Annotations & { readonly 'x-entity'?: never }): this;
}

export class EntityTupleBuilder<
  T extends readonly AnyBuilder[], R = unknown, RIn = R,
  N extends boolean = false, F extends Flag = never,
> extends TupleBuilder<T, R, RIn, N, F> {
  optional(): EntityTupleBuilder<T, R, RIn, N, F | 'optional'>;
  nullable(): EntityTupleBuilder<T, R, RIn, true, F>;
  rest<B extends AnyBuilder>(builder: B): EntityTupleBuilder<T, Infer<B>, Input<B>, N, F>;
  /** Merge into the `x-entity` block — the primitive every method above
   * writes through, held to the closed vocabulary. It carries no flag, so
   * `key()`/`identity()`/`fill()` and the rest stay the way to spell one. */
  entity(patch: EntityBlock): this;
  meta(annotations: Annotations & { readonly 'x-entity'?: never }): this;
}

export class EntityObjectBuilder<
  P extends Props, Open extends boolean = false, PV = never, PVIn = PV,
  N extends boolean = false, F extends Flag = never,
> extends ObjectBuilder<P, Open, PV, PVIn, N, F> {
  physical(layout: PhysicalLayout): this;
  invariants(rules: readonly { name: string; on: readonly ('insert' | 'update' | 'delete')[];
    enforcement: 'database' | 'store'; assert: unknown;
    audit?: { entity: string; values: Readonly<Record<string, unknown>> } }[]): this;
  optional(): EntityObjectBuilder<P, Open, PV, PVIn, N, F | 'optional'>;
  nullable(): EntityObjectBuilder<P, Open, PV, PVIn, true, F>;
  open(): EntityObjectBuilder<P, true, PV, PVIn, N, F>;
  patternProperties<M extends Props>(map: M): EntityObjectBuilder<P, Open, Infer<M[keyof M]>, Input<M[keyof M]>, N, F>;
  extend<Q extends Props>(props: Q): EntityObjectBuilder<Simplify<Omit<P, keyof Q> & Q>, Open, PV, PVIn, N, F>;
  pick<K extends keyof P & string>(keys: readonly K[]): EntityObjectBuilder<Pick<P, K>, Open, PV, PVIn, N, F>;
  omit<K extends keyof P & string>(keys: readonly K[]): EntityObjectBuilder<Omit<P, K>, Open, PV, PVIn, N, F>;
  /** `x-rename`: this entity (or collection) was previously named `name`. */
  renamedFrom(name: string): this;
  /** `column: 'json'` keeps the object in the document (where it lives anyway). */
  column(storage: 'json'): this;
  /** Merge into the `x-entity` block — the primitive every method above
   * writes through, held to the closed vocabulary. It carries no flag, so
   * `key()`/`identity()`/`fill()` and the rest stay the way to spell one. */
  entity(patch: EntityBlock): this;
  meta(annotations: Annotations & { readonly 'x-entity'?: never }): this;
}

declare class EntityNamedBuilder<Out, In = Out, F extends Flag = never> extends NamedBuilder<Out, In, F> {
  optional(): EntityNamedBuilder<Out, In, F | 'optional'>;
  nullable(): EntityNamedBuilder<Out | null, In | null, F>;
  /** Merge into the `x-entity` block — the primitive every method above
   * writes through, held to the closed vocabulary. It carries no flag, so
   * `key()`/`identity()`/`fill()` and the rest stay the way to spell one. */
  entity(patch: EntityBlock): this;
  meta(annotations: Annotations & { readonly 'x-entity'?: never }): this;
}

export class EntityWhenBuilder<F extends Flag = never> extends WhenBuilder<F> {
  optional(): EntityWhenBuilder<F | 'optional'>;
  entity(patch: EntityBlock): this;
  then(builder: AnyBuilder): EntityWhenBuilder<F>;
  else(builder: AnyBuilder): EntityWhenBuilder<F>;
}

/**
 * `never()` on this pen. `false` carries no keywords, so the entity
 * vocabulary cannot be written on it: `entity()`, `key()`, `unique()`,
 * `index()`, `version()`, `column()`, `now()`, `updated()`, `fill()`,
 * `compute()` and `meta()` all raise `JL0102` and `identity()` raises
 * `JL0101`. None of the entity vocabulary is declared here, and `meta()`
 * is inherited from `NeverBuilder` with a `never` parameter, so none of
 * those calls compiles either — and `never()` ANSWERS this class, so a
 * caller meets the refusal without narrowing to it. `renamedFrom()` is
 * the one that writes outside the schema and so survives.
 */
export class EntityNeverBuilder<Out = never, In = Out, F extends Flag = never> extends NeverBuilder<Out, In, F> {
  optional(): EntityNeverBuilder<Out, In, F | 'optional'>;
  /** As on the schema pen: widening to admit `null` is what makes the
   * vocabulary writable, so it answers this pen's base builder. */
  nullable(): EntityBuilder<Out | null, In | null, F>;
  /** The migration hint: a rename is recorded beside the schema, not in it. */
  renamedFrom(name: string): this;
}

/** A `compute()` rule: the document being written at `$`, no externals. */
export type ComputeRule =
  | ((doc: Expr<Record<string, unknown>>, externals: Record<string, never>) => unknown)
  | { readonly [keyword: string]: unknown };

// ————— relations —————

export type RelationKind = 'oneToMany' | 'oneToOne' | 'manyToMany';

/** A relation member: no type of its own, optional by construction; the
 * phantom `__relation` is what `InferMeta` and `defineModel` read. */
declare class RelationBuilder<To extends string, Many extends boolean, Kind extends RelationKind>
  extends SchemaBuilder<unknown, unknown, 'optional'> {
  readonly __relation: { readonly to: To; readonly many: Many; readonly kind: Kind };
}

/**
 * A TYPE, not a value: a relation member is a plain builder over an
 * `any` schema at run time, so there is no class to export. It is met
 * through `rel.hasMany()`, `rel.hasOne()` and `rel.belongsToMany()`,
 * which are how one is ever made.
 */
export type { RelationBuilder };

export interface ForeignKeyOptions {
  /** The foreign-key property name. */
  via: string;
  /** Required wherever a foreign key is created — never defaulted silently. */
  onDelete: 'cascade' | 'restrict' | 'setNull';
}

export const rel: {
  /** One-to-many: `{ to, many: true, via, onDelete }`, the FK on the TARGET. */
  hasMany<To extends string>(to: To, options: ForeignKeyOptions): RelationBuilder<To, true, 'oneToMany'>;
  /** One-to-one (and the many-to-one side): `{ to, via, onDelete }`, the FK on the DECLARING entity. */
  hasOne<To extends string>(to: To, options: ForeignKeyOptions): RelationBuilder<To, false, 'oneToOne'>;
  /** Many-to-many: `{ to, many: true, through? }` — a join table. */
  belongsToMany<To extends string>(to: To, options?: { through?: string }): RelationBuilder<To, true, 'manyToMany'>;
};

// ————— collections —————

export interface IndexOptions {
  name?: string;
  unique?: boolean;
  derive?: 'geohash' | 'bbox' | 'vector';
  precision?: number;
  dims?: number;
  physical?: 'columns' | 'rtree';
}

/** One index declaration; `D` is the document shape its paths are checked against. */
export interface IndexSpec<D = unknown> {
  readonly __doc?: D;
  readonly name: string;
  readonly path: string | readonly string[];
  readonly unique?: boolean;
  readonly derive?: 'geohash' | 'bbox' | 'vector';
  readonly precision?: number;
  readonly dims?: number;
  readonly physical?: 'columns' | 'rtree';
}

/** A member path: a captured lambda, a JSONPath string, or a composite of either. */
export type IndexPath<D> = ((doc: Expr<D>) => unknown) | string | readonly (((doc: Expr<D>) => unknown) | string)[];

/** One index over a singular path (`(p) => p.embedding` → `$.embedding`),
 * a composite, or a JSONPath string; default name `by_<segments>`. */
export function index<D = unknown>(path: IndexPath<D>, options?: IndexOptions): IndexSpec<D>;

/** One node of an index expression: a member (a lambda or a JSONPath
 * string), a JSON scalar, or a call to a function the HOST declares. */
export type ExpressionNode<D = unknown> =
  | ((doc: Expr<D>) => unknown)
  | string
  | number
  | boolean
  | { member: ((doc: Expr<D>) => unknown) | string }
  | { value: string | number | boolean }
  | { call: string; args?: readonly ExpressionNode<D>[] };

/** One index over a COMPUTED value. */
export interface ExpressionIndexSpec<D = unknown> {
  readonly __doc?: D;
  readonly name: string;
  readonly expression: unknown;
  readonly unique?: boolean;
}

/**
 * An index over a computed value: a closed expression over declared
 * members, JSON scalars and functions the host declares deterministic.
 *
 * The function is resolved where the declarations are —
 * `openStore({ expressions })` — so a name this pen has never heard of
 * is not an error here; a wrong arity and a missing declaration are
 * `JD0004` at open, before any DDL. Default name `by_<call>_<members>`.
 */
export function expressionIndex<D = unknown>(
  expression: ExpressionNode<D>,
  options?: { name?: string; unique?: boolean },
): ExpressionIndexSpec<D>;

export interface CollectionOptions<D> {
  /** An RFC 6901 pointer, a captured member path (`(d) => d.id` → `/id`), or `null` (the store allocates). */
  key?: string | ((doc: Expr<D>) => unknown) | null;
  identity?: 'caller' | 'uuid' | 'integer';
  indexes?: readonly (IndexSpec<D> | ExpressionIndexSpec<D>)[];
  renamedFrom?: string;
}

/** One collection declaration for `defineModel`. */
export interface CollectionSpec<D = unknown> {
  readonly __doc?: D;
  readonly schema: JsonSchema | boolean;
  readonly key?: string | null;
  readonly identity?: 'caller' | 'uuid' | 'integer';
  readonly indexes?: readonly IndexSpec<D>[];
  readonly 'x-rename'?: string;
}

export function collection<B extends AnyBuilder>(schema: B, options?: CollectionOptions<Infer<B>>): CollectionSpec<Infer<B>>;

// ————— the model —————

/** An entity declaration whose relation targets are all declared names.
 * (Each member carries `__out`, so the check is never a weak-type one.) */
type EntityFor<Names> = BuilderLike & {
  readonly __props: { readonly [member: string]: { readonly __out: unknown; readonly __relation?: { readonly to: Names } } };
};

/** The `$model` 0.1 document, carrying the entity builders — and the
 * collection specs — as phantoms: what `InferMeta<>` and the migration
 * pen's name and shape checks read. */
export interface ModelDocument<E = unknown, C = unknown> {
  readonly __entities?: E;
  readonly __collections?: C;
  readonly $model: '0.1';
  readonly entities?: { readonly [name: string]: { readonly schema: JsonSchema | boolean; readonly 'x-rename'?: string } };
  readonly collections?: { readonly [name: string]: CollectionSpec };
}

/** One `$model` 0.1 document that `openStore` accepts unchanged. */
export function defineModel<
  E extends { [K in keyof E]: EntityFor<keyof E & string> } = {},
  C extends Record<string, CollectionSpec<any>> = {},
>(spec: { entities?: E; collections?: C }): ModelDocument<E, C>;

// ————— InferMeta —————

type PropsOf<B> = B extends { readonly __props: infer P } ? P : never;
type RelationOf<B> = B extends { readonly __relation: infer R } ? R : never;
type IsRelation<B> = B extends { readonly __relation: any } ? true : false;

/** A closed reading of a value type: every index signature stripped,
 * recursively — what `entityEmitModel` asks emit for (`openObjects: 'closed'`). */
export type Unopen<T> =
  T extends string | number | boolean | null | undefined ? T :
  T extends readonly unknown[] ? { [I in keyof T]: Unopen<T[I]> } :
  T extends object ? { [K in keyof T as string extends K ? never : K]: Unopen<T[K]> } :
  T;

/** Present in the document unless `optional()` — the schema's own `required`. */
type DocRequired<B> = 'optional' extends FlagsOf<B> ? false : true;
/** Accepted by `create()`/`add()` unless `optional()` or store-written. */
type InputRequired<B> = 'optional' extends FlagsOf<B> ? false : 'generated' extends FlagsOf<B> ? false : true;
type IsKey<B> = 'key' extends FlagsOf<B> ? true : false;

type PlainKeys<P> = { [K in keyof P]: IsRelation<P[K]> extends true ? never : K }[keyof P];
type RelationKeys<P> = { [K in keyof P]: IsRelation<P[K]> extends true ? K : never }[keyof P];
type KeyKeys<P> = { [K in keyof P]: IsKey<P[K]> extends true ? K : never }[keyof P];
/** (Guarded by `IsRelation`: a conditional over `never` is not distributive, and `never` extends anything.) */
type ManyToManyKeys<P> = { [K in keyof P]: IsRelation<P[K]> extends true ? (RelationOf<P[K]> extends { kind: 'manyToMany' } ? K : never) : never }[keyof P];

/** A DateTime read is a plain string write (the brand discriminates
 * expressions, never blocks a caller's literal); anything else is itself. */
type InputMember<T> = [T] extends [DateTime] ? ([DateTime] extends [T] ? string : Unopen<T>) : Unopen<T>;

type RelationDoc<E, R> = R extends { to: infer To extends keyof E & string; many: infer M }
  ? (M extends true ? EntityDoc<E, To>[] : EntityDoc<E, To>)
  : never;

/** The document shape: closed, relation members optional references. */
export type EntityDoc<E, K extends keyof E> = Simplify<
  { [P in PlainKeys<PropsOf<E[K]>> as DocRequired<PropsOf<E[K]>[P]> extends true ? P : never]: Unopen<Infer<PropsOf<E[K]>[P]>> } &
  { [P in PlainKeys<PropsOf<E[K]>> as DocRequired<PropsOf<E[K]>[P]> extends true ? never : P]?: Unopen<Infer<PropsOf<E[K]>[P]>> } &
  { [P in RelationKeys<PropsOf<E[K]>>]?: RelationDoc<E, RelationOf<PropsOf<E[K]>[P]>> }>;

/** The primitive of a key member, as the store hands it back. */
type KeyPrimitive<B> = Infer<B> extends string ? string : number;

/** The key: one member's primitive, or the composite object. */
export type EntityKey<E, K extends keyof E> =
  [KeyKeys<PropsOf<E[K]>>] extends [never] ? never
    : IsUnion<KeyKeys<PropsOf<E[K]>>> extends true
      ? { [P in KeyKeys<PropsOf<E[K]>>]: KeyPrimitive<PropsOf<E[K]>[P]> }
      : KeyPrimitive<PropsOf<E[K]>[KeyKeys<PropsOf<E[K]>>]>;

type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/** What `create()`/`add()` accept: store-written members optional,
 * to-one/to-many projections dropped, many-to-many as key-or-document arrays. */
export type EntityInput<E, K extends keyof E> = Simplify<
  { [P in PlainKeys<PropsOf<E[K]>> as InputRequired<PropsOf<E[K]>[P]> extends true ? P : never]: InputMember<Infer<PropsOf<E[K]>[P]>> } &
  { [P in PlainKeys<PropsOf<E[K]>> as InputRequired<PropsOf<E[K]>[P]> extends true ? never : P]?: InputMember<Infer<PropsOf<E[K]>[P]>> } &
  { [P in ManyToManyKeys<PropsOf<E[K]>>]?: RelationOf<PropsOf<E[K]>[P]> extends { to: infer To extends keyof E & string }
    ? Array<EntityKey<E, To> | EntityDoc<E, To>> : never }>;

/** The relations map: name → `{ entity, doc, many }`. */
export type EntityRelations<E, K extends keyof E> = {
  [P in RelationKeys<PropsOf<E[K]>>]: RelationOf<PropsOf<E[K]>[P]> extends { to: infer To extends keyof E & string; kind: infer Kind }
    ? { entity: To; doc: EntityDoc<E, To>; many: Kind extends 'oneToOne' ? false : true }
    : never;
};

/** The `EntityMetaMap` a model's phantom implies — `typedStore<InferMeta<typeof model>>(store)`. */
export type InferMeta<M> = M extends ModelDocument<infer E> ? {
  [K in keyof E]: {
    doc: EntityDoc<E, K>;
    input: EntityInput<E, K>;
    key: EntityKey<E, K>;
    relations: EntityRelations<E, K>;
  };
} : never;

// ————— the factories, entity-aware —————

export function string(): EntityStringBuilder;
export function number(): EntityNumberBuilder;
export function integer(): EntityNumberBuilder;
export function boolean(): EntityBooleanBuilder;
export function nil(): EntityNullBuilder;
export function literal<const V extends Json>(value: V): EntityBuilder<V, V>;
export function enumOf<const V extends readonly Json[]>(values: V): EntityBuilder<V[number], V[number]>;
export function object<P extends Props>(props: P): EntityObjectBuilder<P>;
export function array<B extends AnyBuilder>(items: B): EntityArrayBuilder<Infer<B>[], Input<B>[]>;
export function tuple<T extends readonly AnyBuilder[]>(items: readonly [...T]): EntityTupleBuilder<T>;
export function record<B extends AnyBuilder>(values: B):
  EntityBuilder<{ [key: string]: Infer<B> }, { [key: string]: Input<B> }>;
export function union<T extends readonly AnyBuilder[]>(options: readonly [...T]):
  EntityBuilder<Infer<T[number]>, Input<T[number]>>;
export function discriminated<K extends string, T extends readonly BuilderLike<Record<K, unknown>, any, any>[]>(
  key: K, options: readonly [...T]): EntityBuilder<Infer<T[number]>, Input<T[number]>>;
export function intersection<T extends readonly AnyBuilder[]>(parts: readonly [...T]):
  EntityBuilder<Intersect<{ [I in keyof T]: Infer<T[I]> }>, Intersect<{ [I in keyof T]: Input<T[I]> }>>;
type Intersect<T extends readonly unknown[]> = T extends readonly [infer H, ...infer R] ? H & Intersect<R> : unknown;
export function named<B extends AnyBuilder>(name: string, builder: B): EntityNamedBuilder<Infer<B>, Input<B>>;
export function ref<T = unknown>(name: string): EntityBuilder<T, T>;
export function lazy<T, I = T>(thunk: () => NamedLike<T, I>): EntityBuilder<T, I>;
export function any(): EntityBuilder<unknown, unknown>;
export function never(): EntityNeverBuilder;
export function when(cond: AnyBuilder): EntityWhenBuilder;
export function from<T = unknown>(json: JsonSchema | boolean): EntityBuilder<T, T>;
export function document(root: AnyBuilder, options?: { draft?: '2020-12' }): JsonSchema | boolean;
export function datetime(): EntityStringBuilder<DateTime, DateTime>;
export function date(): EntityStringBuilder<DateTime, DateTime>;
export function time(): EntityStringBuilder;
export function duration(): EntityStringBuilder;

/** The mixin the classes above are built with: a NEW class carrying the vocabulary. */
export function withEntity<B extends new (...args: any[]) => any>(Base: B): B;

export const SCHEMA_BUILDER: unique symbol;
export function isSchemaBuilder(value: unknown): value is BuilderLike;
export function schemaOf(value: unknown): unknown;
export type { CheckRule };
