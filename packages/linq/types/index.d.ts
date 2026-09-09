/**
 * Hand-authored declarations for @jarenjs/linq — the deliberate type
 * surface (hand-authored declarations chosen over emitting them from
 * JSDoc): the implementation stays plain JSDoc'd JavaScript, and this
 * file is the public type contract. The anti-drift
 * rule: every claim here has a runtime twin in `test/linq/types.test.js`
 * and a compile-level pin in `test/consumer/types.ts`.
 *
 * THE LINE (also in the README): the common path is precisely typed;
 * the exotic path is honestly `unknown`; nothing is ever a WRONG type.
 * Constructs beyond inference degrade to `UnknownExpr`/`unknown`, by
 * name, never to a lie.
 */

/**
 * The nominal date-time brand: annotate a model property as `DateTime`
 * and the whole §8.13 date family (`year()`, `startOf()`, `dateAdd()`,
 * `timeBucket()`, …) becomes available on its expression without making
 * EVERY string a date. Purely a type-level marker — the runtime value is a plain
 * RFC 3339 string; there is no constructor and no runtime cost.
 */
export type DateTime = string & { __jarenTag: 'date-time' };

import type { SchemaBuilder } from './schema.js';

/** The phantom carrier every expression type extends: `__value` never
 * exists at runtime; it lets projections infer their unwrapped shape. */
export interface ExprBase<V> {
  readonly __value?: V;
  /** `$exists` — the expression yields at least one item. */
  exists(): BoolExpr;
  /** `$empty` — the expression yields no items. */
  isEmpty(): BoolExpr;
  /** Dynamic member lookup (`$get`, or a bracketed path segment):
   * the escape for non-identifier keys and method-name collisions. */
  get(name: string | number): UnknownExpr;
}

/** Equality over the exact operand family; `null` compares per the
 * documented empty/absent semantics. */
interface EqExpr<V> {
  eq(value: V | ExprBase<V> | null): BoolExpr;
  ne(value: V | ExprBase<V> | null): BoolExpr;
}

export interface BoolExpr extends ExprBase<boolean>, EqExpr<boolean> {
  and(other: boolean | BoolExpr): BoolExpr;
  or(other: boolean | BoolExpr): BoolExpr;
  not(): BoolExpr;
}

export interface NumberExpr extends ExprBase<number>, EqExpr<number> {
  lt(value: number | NumberExpr): BoolExpr;
  le(value: number | NumberExpr): BoolExpr;
  gt(value: number | NumberExpr): BoolExpr;
  ge(value: number | NumberExpr): BoolExpr;
  add(value: number | NumberExpr): NumberExpr;
  sub(value: number | NumberExpr): NumberExpr;
  mul(value: number | NumberExpr): NumberExpr;
  div(value: number | NumberExpr): NumberExpr;
  idiv(value: number | NumberExpr): NumberExpr;
  mod(value: number | NumberExpr): NumberExpr;
  neg(): NumberExpr;
  /** An epoch is a number, so the two instant operators live here too. */
  datetime(): DateTimeExpr;
  timeBucket(every: string | number, origin?: string | number | null,
    context?: CalendarContext): NumberExpr;
}

export interface StringExpr extends ExprBase<string>, EqExpr<string>, SpatialMethods {
  lt(value: string | StringExpr): BoolExpr;
  le(value: string | StringExpr): BoolExpr;
  gt(value: string | StringExpr): BoolExpr;
  ge(value: string | StringExpr): BoolExpr;
  startsWith(value: string | StringExpr): BoolExpr;
  endsWith(value: string | StringExpr): BoolExpr;
  contains(value: string | StringExpr): BoolExpr;
  /** I-Regexp (RFC 9485) full match. */
  matches(pattern: string): BoolExpr;
  upper(): StringExpr;
  lower(): StringExpr;
  length(): NumberExpr;
  concat(value: string | StringExpr): StringExpr;
  substring(start: number, length?: number): StringExpr;
  replace(pattern: string, replacement: string): StringExpr;
}

/** A calendar unit, as QUERY-FORMAT §8.13 fixes it. The unit is DATA
 * rather than vocabulary, so an unknown one is a runtime `JQ2001`; this
 * type is what keeps the common spelling mistake a compile error. */
export type DateUnit =
  | 'year' | 'quarter' | 'month' | 'week' | 'day'
  | 'hour' | 'minute' | 'second' | 'millisecond';

/** The date family (`$is-date` … `$date-format`), available on any
 * expression whose value carries a date. Every method lowers to the §8.13
 * operator of the same name; there is no LINQ-only date semantics. */
export interface DateMethods {
  /** Lexical date components; a value with no date half is `JQ2001`. */
  year(): NumberExpr;
  month(): NumberExpr;
  day(): NumberExpr;
  /** Lexical time components; `seconds` carries its fraction. */
  hours(): NumberExpr;
  minutes(): NumberExpr;
  seconds(): NumberExpr;
  /** Minutes east of UTC; a bare `full-date` yields the empty sequence. */
  offset(): NumberExpr;
  /** ISO 8601 week number, and its week-numbering year. */
  week(): NumberExpr;
  weekYear(): NumberExpr;
  /** Calendar quarter 1-4; ISO weekday 1 (Monday) to 7 (Sunday). */
  quarter(): NumberExpr;
  weekday(): NumberExpr;
  /** Epoch milliseconds (`$epoch`) — the one shift to UTC. */
  epoch(): NumberExpr;
  /** The inverse: epoch milliseconds → a canonical UTC `date-time`. */
  datetime(): DateTimeExpr;
  /** The RFC 3339 lexical-form predicates; these never raise. */
  isDate(): BoolExpr;
  isTime(): BoolExpr;
  isDatetime(): BoolExpr;
  isDuration(): BoolExpr;
  /** Truncate to a unit, keeping the lexical form (`$start-of`/`$end-of`). */
  startOf(unit: DateUnit): DateTimeExpr;
  endOf(unit: DateUnit): DateTimeExpr;
  /** Shift by an ISO 8601 duration, or by an amount and a unit. */
  dateAdd(duration: string): DateTimeExpr;
  dateAdd(amount: number | NumberExpr, unit: DateUnit): DateTimeExpr;
  dateSub(duration: string): DateTimeExpr;
  dateSub(amount: number | NumberExpr, unit: DateUnit): DateTimeExpr;
  /** Whole units from this value to another; negative when it precedes. */
  dateDiff(to: string | DateTimeExpr, unit: DateUnit): NumberExpr;
  /** Render through a Unicode LDML pattern (`yyyy-MM-dd`). */
  dateFormat(pattern: string): StringExpr;
  /** The instant labelling the bucket this one falls in (`$time-bucket`). */
  timeBucket(every: string | number, origin?: string | number | null,
    context?: CalendarContext): NumberExpr;
}

/** A `DateTime`-branded string: the string surface plus the whole §8.13
 * date family. */
export interface DateTimeExpr extends ExprBase<DateTime>, DateMethods {
  eq(value: string | DateTimeExpr | null): BoolExpr;
  ne(value: string | DateTimeExpr | null): BoolExpr;
  lt(value: string | DateTimeExpr): BoolExpr;
  le(value: string | DateTimeExpr): BoolExpr;
  gt(value: string | DateTimeExpr): BoolExpr;
  ge(value: string | DateTimeExpr): BoolExpr;
}

/** The wall clock a calendar boundary falls on (QUERY-FORMAT §8.16).
 * UTC is the default; a named `zone` needs an injected `zoneProvider`. */
export interface CalendarContext {
  zone?: string;
  offset?: number;
  disambiguation?: 'reject' | 'earlier' | 'later';
}

/** The aggregates `$resample` and `$rolling` share. */
export type SeriesAggregate =
  'sum' | 'mean' | 'min' | 'max' | 'first' | 'last' | 'count';

/** What an EMPTY bucket says, and nothing else. */
export type SeriesFill = 'omit' | 'null' | 'zero' | 'locf' | 'linear';

/** A width: an ISO 8601 duration, or a count of milliseconds. */
export type SeriesSpan = string | number;

/** An instant: epoch milliseconds, or an RFC 3339 string. */
export type SeriesInstant = string | number;

/** A row selector: a singular path whose `$` is the ROW rather than the
 * document (`'$.on'`, `"$['recorded at']"`). */
export type RowSelector = string;

/** The `$resample` spec — a literal, read once when the query compiles. */
export interface ResampleSpec extends CalendarContext {
  every: SeriesSpan;
  origin?: SeriesInstant;
  start?: SeriesInstant;
  end?: SeriesInstant;
  aggregate?: SeriesAggregate;
  fill?: SeriesFill;
  at?: RowSelector;
  value?: RowSelector;
}

/** The `$rolling` spec — a window measured in time, not in rows. */
export interface RollingSpec extends CalendarContext {
  width: SeriesSpan;
  aggregate?: SeriesAggregate;
  minPeriods?: number;
  at?: RowSelector;
  value?: RowSelector;
}

/** The `$asof` spec — every member optional: backward, unkeyed, unbounded. */
export interface AsOfSpec {
  direction?: 'backward' | 'forward' | 'nearest';
  tolerance?: SeriesSpan;
  by?: RowSelector;
  leftAt?: RowSelector;
  rightAt?: RowSelector;
}

/** One canonical sample the series operators answer with. */
export interface SeriesBucket {
  at: number;
  value: number | null;
  count: number;
}

/** One row of an as-of join; `right` is `null` when nothing matched, and
 * the row stays in the answer. */
export interface AsOfMatch {
  left: unknown;
  right: unknown;
  distance: number | null;
}

/** A half-open interval: `[start, end)`, in epoch milliseconds. */
export interface Interval {
  start: SeriesInstant;
  end: SeriesInstant;
}

/** The §8.16 operators that take a whole series and answer another one.
 * Available wherever a MANY-cardinality expression is (an array member,
 * or a fanned path). */
export interface SeriesMethods {
  /** Sorted `{at, value, count}` buckets, one per `every` (`$resample`). */
  resample(spec: ResampleSpec): Expr<SeriesBucket[]> & AggregatableExpr;
  /** One row per input instant, over a window measured in time. */
  rolling(spec: RollingSpec): Expr<SeriesBucket[]> & AggregatableExpr;
  /** The right row that was current when each left row happened. */
  asof(right: ExprBase<unknown> | readonly unknown[], spec?: AsOfSpec):
    Expr<AsOfMatch[]> & AggregatableExpr;
}

/** A geometry operand: a GeoJSON geometry or position, a WKT string,
 * or an expression yielding one. */
export type GeoOperand = ExprBase<unknown> | object | readonly number[] | string;

/** The §8.14 family, one method per operator, on every expression kind
 * a geometry can be — a position or bbox array, a GeoJSON object, a WKT
 * or geohash string — and on the honest top. Measurements are numbers,
 * cells and text are strings, a bbox and a centroid are positions; a
 * result that is a geometry stays `UnknownExpr`, because a GeoJSON
 * shape is not a TypeScript type this surface can promise. */
export interface SpatialMethods {
  /** `[west, south, east, north]` of the value's positions. */
  bbox(): ArrayExpr<number>;
  /** Square metres of the value's polygons (`$area`). */
  geoArea(): NumberExpr;
  /** Metres of the value's lines and ring perimeters (`$length`). */
  geoLength(): NumberExpr;
  /** The mean of the value's positions, as a position. */
  centroid(): ArrayExpr<number>;
  /** Metres between the two representative positions. */
  distance(other: GeoOperand): NumberExpr;
  /** Is this value's representative position inside `region`'s surface? */
  within(region: GeoOperand): BoolExpr;
  /** Do the two bounding boxes overlap? Touching edges count. */
  bboxIntersects(other: GeoOperand): BoolExpr;
  /** The base-32 geohash cell (precision 1–12, default 9). */
  geohash(precision?: number | NumberExpr): StringExpr;
  /** A Well-Known Text string → the geometry it denotes. */
  geoParse(): UnknownExpr;
  /** Any value → its Well-Known Text. */
  geoText(): StringExpr;
  /** A cell string → the `Polygon` covering that cell. */
  geohashBounds(): UnknownExpr;
  /** A cell string → the cell and its neighbours, a SEQUENCE of up to
   * nine cell strings (aggregate it, or `at()` is not available). */
  geohashNeighbours(): StringExpr & AggregatableExpr;
  /** The same value with vertices dropped; the tolerance is in degrees. */
  geoSimplify(tolerance: number | NumberExpr): UnknownExpr;
}

export interface ArrayExpr<E> extends ExprBase<E[]>, SeriesMethods, SpatialMethods {
  eq(value: readonly E[] | ArrayExpr<E> | null): BoolExpr;
  ne(value: readonly E[] | ArrayExpr<E> | null): BoolExpr;
  /** Do two half-open `{start, end}` intervals share an instant?
   * Touching spans do not. */
  overlaps(other: Interval | ExprBase<unknown>): BoolExpr;
  /** Fan the elements out (`[*]`) — a MANY-cardinality expression the
   * aggregates and the §8.16 sequence operators apply to
   * (`u.tags.all().count()`, `rows.all().resample(spec)`); an object
   * element's members are fanned with it (`lines.all().amount.sum()`). */
  all(): FannedExpr<E>;
  /** The element at a 0-based index; negative counts from the end. A
   * computed index is an expression — the engine's `$get` — which is
   * what an app-pen patch path lowers to a `$concat` pointer. */
  at(index: number | NumberExpr): Expr<E>;
  /** `$count`. Over a GROUP — a `groupBy`'s `items`, a group-join's
   * group — this is the number of rows, because the chain knows those
   * are rows and fans them (QUERY-PEN.md §13.3). Over an array a caller
   * stored, it counts the array as one item, because at capture time an
   * array member and a scalar member are the same path: fan it first
   * (`u.tags.all().count()`), or ask `exists()` what this would
   * otherwise be answering. */
  count(): NumberExpr;
  /** Cosine similarity to another vector (§8.15): a captured array
   * embeds as a literal, a `params()` binding stays an external. Only a
   * numeric array is a vector. */
  similarity(this: ArrayExpr<number>, other: readonly number[] | ArrayExpr<number>): NumberExpr;
}

/** A fanned path (`$.lines[*]`): the element's expression, aggregatable,
 * and — for an object element — every member is a fanned path too
 * (`$.lines[*].amount`), so it aggregates without a second `all()`. */
export type FannedExpr<E> = Expr<E> & AggregatableExpr & SeriesMethods &
  ([E] extends [readonly unknown[]] ? {} :
    [E] extends [object] ? { readonly [K in keyof E & string]-?: MemberExpr<E[K]> & AggregatableExpr } : {});

/** Aggregates available on any expression (a fanned path, a group). */
export interface AggregatableExpr {
  count(): NumberExpr;
  sum(): NumberExpr;
  avg(): NumberExpr;
  min(): UnknownExpr;
  max(): UnknownExpr;
}

/** An object's expression: exactly its properties, recursively typed —
 * which is what makes a misspelled member a compile error. A GeoJSON
 * object carries the spatial family; a `{ start, end }` object the
 * interval test. */
export type ObjectExpr<T> = ExprBase<T> & EqExpr<T> & SpatialMethods & {
  /** Do two half-open `{start, end}` intervals share an instant? */
  overlaps(other: Interval | ExprBase<unknown>): BoolExpr;
} & {
  readonly [K in keyof T & string]-?: MemberExpr<T[K]>;
};

/** A member's expression: an `unknown` (or `any`) member is the honest
 * top, never the first conditional arm `Expr<>` would pick for it. */
export type MemberExpr<V> = unknown extends V ? UnknownExpr : Expr<NonNullable<V>>;

/** The honest top: everything is available, nothing is precise. Used
 * where inference ends (dynamic `get`, post-operator members, unknown
 * elements) — wide, never wrong. */
export interface UnknownExpr
  extends ExprBase<unknown>, AggregatableExpr, DateMethods, SeriesMethods, SpatialMethods {
  eq(value: unknown): BoolExpr;
  ne(value: unknown): BoolExpr;
  lt(value: unknown): BoolExpr;
  le(value: unknown): BoolExpr;
  gt(value: unknown): BoolExpr;
  ge(value: unknown): BoolExpr;
  and(other: unknown): BoolExpr;
  or(other: unknown): BoolExpr;
  not(): BoolExpr;
  add(value: unknown): UnknownExpr;
  sub(value: unknown): UnknownExpr;
  mul(value: unknown): UnknownExpr;
  div(value: unknown): UnknownExpr;
  idiv(value: unknown): UnknownExpr;
  mod(value: unknown): UnknownExpr;
  neg(): UnknownExpr;
  startsWith(value: unknown): BoolExpr;
  endsWith(value: unknown): BoolExpr;
  contains(value: unknown): BoolExpr;
  matches(pattern: string): BoolExpr;
  upper(): UnknownExpr;
  lower(): UnknownExpr;
  length(): NumberExpr;
  concat(value: unknown): UnknownExpr;
  substring(start: number, length?: number): UnknownExpr;
  replace(pattern: string, replacement: string): UnknownExpr;
  all(): UnknownExpr;
  at(index: number | NumberExpr): UnknownExpr;
  /** Do two half-open `{start, end}` intervals share an instant? */
  overlaps(other: Interval | ExprBase<unknown>): BoolExpr;
  /** Cosine similarity (§8.15) — wide, on the honest top. */
  similarity(other: unknown): NumberExpr;
}

/** Value type → expression type. Order matters: the DateTime brand is
 * a string subtype and must match first. */
export type Expr<T> =
  [T] extends [DateTime] ? DateTimeExpr :
  [T] extends [string] ? StringExpr :
  [T] extends [number] ? NumberExpr :
  [T] extends [boolean] ? BoolExpr :
  [T] extends [readonly (infer E)[]] ? ArrayExpr<E> :
  [T] extends [object] ? ObjectExpr<T> :
  UnknownExpr;

/** The parameters proxy: exactly the declared names, each typed. */
export type ParamsExpr<P> = {
  readonly [K in keyof P & string]-?: Expr<NonNullable<P[K]>>;
};

/** Unwrap a captured projection back to its VALUE shape: expressions
 * by their phantom, object/array literals recursively, literals as
 * themselves. */
export type Unwrap<R> =
  R extends ExprBase<infer V> ? V :
  R extends readonly (infer E)[] ? Unwrap<E>[] :
  R extends object ? { [K in keyof R]: Unwrap<R[K]> } :
  R;

/** A multi-item projection flattens (`selectMany`). */
type Element<V> = V extends readonly (infer E)[] ? E : V;

/** Any expression-ish callback result the runtime accepts. */
type ExprResult = ExprBase<unknown> | object | string | number | boolean | null;

export interface OrderOptions {
  /** `$empty` — where empty keys sort: `'least'` (default) or `'greatest'`. */
  empty?: 'least' | 'greatest';
  /** `$collation` — a registered collation name. */
  collation?: string;
}

/** One row of a provider's relation table (MODEL-FORMAT §10.1, as a
 * store spells it): the declared relation as plain data a hop lowers
 * from. A foreign-key relation names its key column (`via`), the entity
 * holding it (`fkEntity`), the entity it references (`fkTargets`) and the
 * key it references there (`targetKey`); `kind` says which side holds the
 * key. A many-to-many names its `joinTable` and is refused (`JL0105`). */
export interface RelationEntry {
  readonly to: string;
  readonly kind: 'oneToOne' | 'oneToMany' | 'manyToMany';
  readonly via?: string;
  readonly fkEntity?: string;
  readonly fkTargets?: string;
  readonly joinTable?: string;
  readonly targetKey: string;
}

/** A provider's relation table: one entry per relation member of the
 * rows it serves. */
export type RelationTable = Readonly<Record<string, RelationEntry>>;

/** One relation hop a callback navigated (QUERY-PEN §4, relation
 * navigation): the member read, the relation's kind, and the binding
 * the lowered correlated phrase ranges over (`r1`, `r2`, …). */
export interface Hop {
  member: string;
  kind: 'oneToOne' | 'oneToMany';
  binding: string;
}

/** The provider contract (D2, QUERY-PEN §8): any object exposing
 * `execute(document, options)`. The document arrives whole; the return
 * value uses the engine's result mapping. `T` is the item type — read
 * from the `__item` phantom a typed provider carries (a typed entity
 * set), stated by the caller (`from<T>(provider)`), or `unknown`. */
export interface Provider<T = unknown> {
  /** The item phantom: never present at runtime; what `from` infers `T` from. */
  readonly __item?: T;
  execute(document: unknown, options: { externals: Record<string, unknown> }): unknown;
  /** The root expression the items are bound through (`'$.Post[*]'`);
   * absent means the whole input, `'$[*]'`. */
  readonly root?: string;
  /** The entity roots a store-level provider serves when it has no root
   * of its own — `from()` refuses it (`JL0007`) naming them. */
  readonly roots?: readonly string[];
  /** An identity two providers share when their documents may be joined
   * (one store's entity sets). When it carries `relations` — the tables
   * of every root of the scope, keyed by root name — a hop continues
   * into another root (`p.author.posts`). */
  readonly scope?: unknown;
  /** The relation table of the rows this provider serves: a relation
   * member on the chain then hops (§3), lowered to a correlated phrase. */
  readonly relations?: RelationTable;
}

/** The asynchronous provider (D8, §12): the same members, and `execute`
 * may answer a promise — `fromAsync(provider)` awaits it, and the whole
 * chain up to a `mapAsync` arrives as ONE document. */
export interface AsyncProvider<T = unknown> {
  readonly __item?: T;
  execute(document: unknown, options: { externals: Record<string, unknown> }): unknown | Promise<unknown>;
  /** The cursor protocol, optional: the same document as an item
   * cursor, one item per pull, `return()` releasing whatever it holds.
   * A `for await` over the chain hands its pushed document here when
   * the provider offers it, so iteration never materialises what the
   * provider can stream; a provider without it is run whole. */
  cursor?(document: unknown, options: { externals: Record<string, unknown> }):
    AsyncIterator<unknown> & { return(): Promise<unknown> };
  readonly root?: string;
  readonly roots?: readonly string[];
  readonly scope?: unknown;
  readonly relations?: RelationTable;
}

/** The engine's compile registries, under the engine's own option names
 * (QUERY-PEN §8.1): what makes an expressible document executable in
 * memory. Their shapes are the query engine's — wide here, never wrong. */
export interface LinqOptions {
  /** Enables `ofType`/`cast` (schema operators); e.g.
   * `createTypeTestCompiler()` from `@jarenjs/validate/query`. */
  compileTypeTest?: (schema: unknown, docPath: string) => (value: unknown) => boolean;
  /** Registered `$call` functions, for a hand-written or saved document. */
  functions?: Readonly<Record<string, (...args: any[]) => unknown>>;
  /** Named collations: `orderBy(…, { collation })` is `JQ0010` without one. */
  collations?: Readonly<Record<string, (a: string, b: string) => number>>;
  /** Custom RFC 9535 path function extensions. */
  pathFunctions?: Readonly<Record<string, unknown>>;
  /** Step, depth and sequence bounds — a SAVED document's guard. */
  limits?: Readonly<Record<string, number>>;
  /** An explicit cache-partition key, when the hooks above are rebuilt
   * per call: compiled documents are shared per registry combination. */
  registry?: object;
}

export interface Explanation {
  document: unknown;
  externals: string[];
  dependencies: {
    readonly externals: readonly string[];
    readonly operators: readonly string[];
    readonly functions: readonly string[];
    readonly collations: readonly string[];
  };
  /** The relation hops the chain's callbacks navigated, in capture
   * order; a join's inner sequence's hops precede the join's own. */
  hops: Hop[];
  /** The values `params()` bound, by name — what a provider receives as
   * `externals` when the document runs, so a host handed the chain (a
   * live registration) can carry them without a second spelling. */
  bindings: Record<string, unknown>;
}

/** The deferred, immutable sequence of `T` with declared params `P`. */
export class Sequence<T = unknown, P = {}> {
  private constructor();

  where(predicate: (it: Expr<T>, p: ParamsExpr<P>) => BoolExpr | boolean): Sequence<T, P>;
  select<R extends ExprResult>(projection: (it: Expr<T>, p: ParamsExpr<P>) => R): Sequence<Unwrap<R>, P>;
  selectMany<R extends ExprResult>(selector: (it: Expr<T>, p: ParamsExpr<P>) => R): Sequence<Element<Unwrap<R>>, P>;

  orderBy(key: (it: Expr<T>, p: ParamsExpr<P>) => ExprResult, options?: OrderOptions): Sequence<T, P>;
  orderByDescending(key: (it: Expr<T>, p: ParamsExpr<P>) => ExprResult, options?: OrderOptions): Sequence<T, P>;
  thenBy(key: (it: Expr<T>, p: ParamsExpr<P>) => ExprResult, options?: OrderOptions): Sequence<T, P>;
  thenByDescending(key: (it: Expr<T>, p: ParamsExpr<P>) => ExprResult, options?: OrderOptions): Sequence<T, P>;

  groupBy<R extends ExprResult>(key: (it: Expr<T>, p: ParamsExpr<P>) => R):
    Sequence<{ key: Unwrap<R> | null, items: T[] }, P>;

  join<U, R extends ExprResult>(
    inner: Sequence<U, any>,
    outerKey: (it: Expr<T>, p: ParamsExpr<P>) => ExprResult,
    innerKey: (it: Expr<U>, p: ParamsExpr<P>) => ExprResult,
    result: (outer: Expr<T>, inner: Expr<U>, p: ParamsExpr<P>) => R,
  ): Sequence<Unwrap<R>, P>;

  /** The matching inner group is bound as an ARRAY value: index it
   * (`g.at(0)`), fan it (`g.all()`), place it in a member (`{ all: g }`),
   * and aggregate over its MEMBERS (`g.count()` is the number of
   * matches, `g.exists()` whether there are any). */
  groupJoin<U, R extends ExprResult>(
    inner: Sequence<U, any>,
    outerKey: (it: Expr<T>, p: ParamsExpr<P>) => ExprResult,
    innerKey: (it: Expr<U>, p: ParamsExpr<P>) => ExprResult,
    result: (outer: Expr<T>, group: ArrayExpr<U> & AggregatableExpr, p: ParamsExpr<P>) => R,
  ): Sequence<Unwrap<R>, P>;

  /** The seeded fold; the sequence of exactly one accumulated value. */
  aggregate<A>(seed: A, step: (acc: Expr<A>, it: Expr<T>, p: ParamsExpr<P>) => ExprResult): Sequence<A, P>;

  skip(count: number): Sequence<T, P>;
  take(count: number): Sequence<T, P>;
  distinct(): Sequence<T, P>;
  reverse(): Sequence<T, P>;
  concat(other: Sequence<T, any> | readonly T[]): Sequence<T, P>;
  defaultIfEmpty(fallback?: T | null): Sequence<T | null, P>;

  /** Keep items the schema accepts. A schema-pen builder carries its
   * own shape (`Infer<>`); for a hand-written document `S` is
   * caller-asserted (a JSON Schema is not a TypeScript type) and the
   * default is honest `unknown`. */
  ofType<S>(schema: SchemaBuilder<S, any, any>): Sequence<S, P>;
  ofType<S = unknown>(schema: object): Sequence<S, P>;
  cast<S>(schema: SchemaBuilder<S, any, any>): Sequence<S, P>;
  cast<S = unknown>(schema: object): Sequence<S, P>;

  /** Recorded unsupported (§4, §16): the grammar has no positional
   * co-iteration. The parameter is `never`, not just the return type:
   * a rest parameter accepts zero arguments, so `q.zip()` — the one
   * spelling a caller would actually write — type-checked and failed at
   * run time instead. JavaScript callers still get `JL0006`. */
  zip(unsupported: never): never;

  params<Q extends Record<string, unknown>>(bindings: Q): Sequence<T, P & Q>;

  toDocument(): unknown;
  explain(): Explanation;

  toArray(): T[];
  [Symbol.iterator](): Iterator<T>;

  first(): T;
  firstOrDefault(): T | undefined;
  firstOrDefault<D>(defaultValue: D): T | D;
  single(): T;
  singleOrDefault(): T | undefined;
  singleOrDefault<D>(defaultValue: D): T | D;
  last(): T;
  lastOrDefault(): T | undefined;
  lastOrDefault<D>(defaultValue: D): T | D;
  elementAt(index: number): T;
  elementAtOrDefault(index: number): T | undefined;
  elementAtOrDefault<D>(index: number, defaultValue: D): T | D;

  count(): number;
  sum(): number;
  average(): number;
  /** Numbers yield a number; strings a string (the operand family). */
  min(): T extends string ? string : number;
  max(): T extends string ? string : number;

  any(predicate?: (it: Expr<T>, p: ParamsExpr<P>) => BoolExpr | boolean): boolean;
  all(predicate: (it: Expr<T>, p: ParamsExpr<P>) => BoolExpr | boolean): boolean;

  /** Cross into the async surface (QUERY-PEN.md §11): the sync chain
   * becomes the pushed prefix; the element re-types to the callback's
   * RESOLVED type. */
  mapAsync<R>(fn: (item: T, signal: AbortSignal) => R, options: MapAsyncOptions):
    AsyncSequence<Awaited<R>, P>;
}

export function from<T>(source: Iterable<T>, options?: LinqOptions): Sequence<T, {}>;
/** A provider: `T` from its `__item` phantom (a typed entity set infers
 * without a cast), or as the caller states it, or `unknown`. */
export function from<T = unknown>(source: Provider<T>, options?: LinqOptions): Sequence<T, {}>;

export function fromDocument<T = unknown>(
  source: Iterable<unknown> | Provider,
  document: unknown,
  options?: LinqOptions,
): Sequence<T, {}>;

/** The runtime code table, synced to QUERY-PEN.md §9 by a test. */
export const LINQ_CODES: Readonly<Record<string, string>>;

export class LinqBuildError extends Error {
  readonly code: string;
  readonly reason: string;
  readonly docPath: string | undefined;
}

export class LinqRuntimeError extends Error {
  readonly code: string;
  readonly reason: string;
  readonly docPath: string | undefined;
}

// ————— The asynchronous surface (QUERY-PEN.md §§10–12) —————

export interface MapAsyncOptions {
  /** REQUIRED: the in-flight bound (a positive integer, `JL0005`
   * otherwise) — there is no unbounded default. */
  concurrency: number;
  /** The `createTaskEffect` vocabulary; default `'parallel'`. */
  mode?: 'parallel' | 'concat' | 'switch' | 'exhaust';
  /** Source order (default) versus completion order. */
  ordered?: boolean;
}

export interface AsyncExplanation {
  barriers: { operator: string, reason: string }[];
  /** What THIS surface does with the item stream: one item at a time, or
   * a buffer at its first local barrier. Over a provider the pushed
   * document's own class — a set residual, an external the database
   * cannot bind — is the provider's `explain(document, { externals:
   * bindings })` to report, and its cursor carries the same answer. */
  streaming: 'row' | 'buffered';
  barrier: { construct: string, reason: string } | null;
  /** The relation hops the chain's callbacks navigated (as `Explanation`). */
  hops: Hop[];
  /** The values `params()` bound, by name (as `Explanation`). */
  bindings: Record<string, unknown>;
  /** Present when the chain is document-representable (no mapAsync). */
  document?: unknown;
  /** Present when a mapAsync splits the chain. */
  split?: { pushed: unknown, residual: string[] };
}

/** The cursor shape (§12): an async iterator by another name. */
export interface AsyncCursor<T = unknown> {
  next(): Promise<IteratorResult<T>>;
  return?(): Promise<IteratorResult<T>>;
}

/** The deferred async sequence: the same operator surface, promise
 * terminals, streaming semantics per §10. */
export class AsyncSequence<T = unknown, P = {}> {
  private constructor();

  where(predicate: (it: Expr<T>, p: ParamsExpr<P>) => BoolExpr | boolean): AsyncSequence<T, P>;
  select<R extends ExprResult>(projection: (it: Expr<T>, p: ParamsExpr<P>) => R): AsyncSequence<Unwrap<R>, P>;
  selectMany<R extends ExprResult>(selector: (it: Expr<T>, p: ParamsExpr<P>) => R): AsyncSequence<Element<Unwrap<R>>, P>;
  orderBy(key: (it: Expr<T>, p: ParamsExpr<P>) => ExprResult, options?: OrderOptions): AsyncSequence<T, P>;
  orderByDescending(key: (it: Expr<T>, p: ParamsExpr<P>) => ExprResult, options?: OrderOptions): AsyncSequence<T, P>;
  thenBy(key: (it: Expr<T>, p: ParamsExpr<P>) => ExprResult, options?: OrderOptions): AsyncSequence<T, P>;
  thenByDescending(key: (it: Expr<T>, p: ParamsExpr<P>) => ExprResult, options?: OrderOptions): AsyncSequence<T, P>;
  groupBy<R extends ExprResult>(key: (it: Expr<T>, p: ParamsExpr<P>) => R):
    AsyncSequence<{ key: Unwrap<R> | null, items: T[] }, P>;
  aggregate<A>(seed: A, step: (acc: Expr<A>, it: Expr<T>, p: ParamsExpr<P>) => ExprResult): AsyncSequence<A, P>;

  /** Equi-join, pushed WHOLE: only over a provider origin, before any
   * `mapAsync`, with an inner async sequence over the same provider or
   * one sharing its scope (`JL0005` otherwise — a single-pass source
   * cannot be joined; QUERY-PEN §10). */
  join<U, R extends ExprResult>(
    inner: AsyncSequence<U, any>,
    outerKey: (it: Expr<T>, p: ParamsExpr<P>) => ExprResult,
    innerKey: (it: Expr<U>, p: ParamsExpr<P>) => ExprResult,
    result: (outer: Expr<T>, inner: Expr<U>, p: ParamsExpr<P>) => R,
  ): AsyncSequence<Unwrap<R>, P>;
  /** Group-join, pushed WHOLE under the same rule as `join`. */
  groupJoin<U, R extends ExprResult>(
    inner: AsyncSequence<U, any>,
    outerKey: (it: Expr<T>, p: ParamsExpr<P>) => ExprResult,
    innerKey: (it: Expr<U>, p: ParamsExpr<P>) => ExprResult,
    result: (outer: Expr<T>, group: ArrayExpr<U> & AggregatableExpr, p: ParamsExpr<P>) => R,
  ): AsyncSequence<Unwrap<R>, P>;
  skip(count: number): AsyncSequence<T, P>;
  take(count: number): AsyncSequence<T, P>;
  distinct(): AsyncSequence<T, P>;
  reverse(): AsyncSequence<T, P>;
  /** Only a CONSTANT array can join an async stream (§10). */
  concat(other: readonly T[]): AsyncSequence<T, P>;
  defaultIfEmpty(fallback?: T | null): AsyncSequence<T | null, P>;
  ofType<S>(schema: SchemaBuilder<S, any, any>): AsyncSequence<S, P>;
  ofType<S = unknown>(schema: object): AsyncSequence<S, P>;
  cast<S>(schema: SchemaBuilder<S, any, any>): AsyncSequence<S, P>;
  cast<S = unknown>(schema: object): AsyncSequence<S, P>;
  /** Recorded unsupported, as on the synchronous surface. */
  zip(unsupported: never): never;
  params<Q extends Record<string, unknown>>(bindings: Q): AsyncSequence<T, P & Q>;

  /** The bounded-concurrency boundary (§11): re-types the element to
   * the callback's RESOLVED type. */
  mapAsync<R>(fn: (item: T, signal: AbortSignal) => R, options: MapAsyncOptions):
    AsyncSequence<Awaited<R>, P>;

  toDocument(): unknown;
  explain(): AsyncExplanation;

  [Symbol.asyncIterator](): AsyncIterator<T>;
  toArray(): Promise<T[]>;
  first(): Promise<T>;
  firstOrDefault(): Promise<T | undefined>;
  firstOrDefault<D>(defaultValue: D): Promise<T | D>;
  single(): Promise<T>;
  singleOrDefault(): Promise<T | undefined>;
  singleOrDefault<D>(defaultValue: D): Promise<T | D>;
  last(): Promise<T>;
  lastOrDefault(): Promise<T | undefined>;
  lastOrDefault<D>(defaultValue: D): Promise<T | D>;
  elementAt(index: number): Promise<T>;
  elementAtOrDefault(index: number): Promise<T | undefined>;
  elementAtOrDefault<D>(index: number, defaultValue: D): Promise<T | D>;
  count(): Promise<number>;
  sum(): Promise<number>;
  average(): Promise<number>;
  min(): Promise<T extends string ? string : number>;
  max(): Promise<T extends string ? string : number>;
  any(predicate?: (it: Expr<T>, p: ParamsExpr<P>) => BoolExpr | boolean): Promise<boolean>;
  all(predicate: (it: Expr<T>, p: ParamsExpr<P>) => BoolExpr | boolean): Promise<boolean>;
}

/** Build an async sequence over a provider (an `execute` duck, asked for
 * before the iterable shapes): the document arrives whole and `execute`
 * may answer a promise; `T` from the `__item` phantom, the caller, or
 * `unknown`. */
export function fromAsync<T = unknown>(
  source: AsyncProvider<T>,
  options?: LinqOptions,
): AsyncSequence<T, {}>;
/** Build an async sequence over an async iterable, a sync iterable, a
 * cursor or a push queue. A STRING is refused (`JL0001`): on this
 * surface a string is a chunk source — feed it through a push queue —
 * never a character stream, which is where the twins deliberately
 * differ from `from('abc')`. */
export function fromAsync<T>(
  source: AsyncIterable<T> | Iterable<T> | AsyncCursor<T>,
  options?: LinqOptions,
): AsyncSequence<T, {}>;

/** One side of a federation, as `explain()` reports it (§12.1). */
export interface FederatedSide {
  readonly source: string;
  readonly root: string;
  readonly estimatedRows: number | null;
  /** The join key on this side, as the document spells it. */
  readonly key: string;
  /** The document this side's own source is asked. */
  readonly document: unknown;
  /** Whether this side is pulled row by row, or answered whole. */
  readonly streaming: 'row' | 'buffered';
  readonly children?: readonly FederatedSide[];
}

/** What a federated document will do, without doing any of it (§12.1). */
export interface FederationPlan {
  readonly strategy: 'hash';
  readonly budget: { readonly maxRows: number; readonly maxBytes: number };
  readonly combinedBudget: { readonly maxTotalRows: number; readonly maxTotalBytes: number };
  readonly order: readonly FederatedSide[];
  readonly build: FederatedSide;
  readonly probe: FederatedSide;
  /** The engine evaluates the original binding order over the reduced sets. */
  readonly resident: { readonly document: unknown };
}

/** One named source of a federation: an ordinary provider source whose
 * root is `$.<name>[*]`, sharing one scope with its siblings — which is
 * what admits the join the federation then executes. */
export interface FederatedSource<T = unknown> extends AsyncProvider<T> {
  explain(document: unknown): FederationPlan;
  readonly root: string;
}

/** The explicit cross-source boundary (§12.1).
 *
 * A query document reads one input, and an ordinary join across two
 * unrelated sources stays `JL0005`. `federate()` is the one way to opt
 * out of that, by naming the sources and the bounds together: each
 * side's own filters and projection run at its source, the smaller side
 * fills a bounded hash table, the other is probed against it, and the
 * caller's own document decides over the reduced sets. Connected N-way
 * graphs and nested fluent joins share cumulative admission credits. A side that
 * reaches `maxRows` or `maxBytes` raises `JL2008` at the row that would
 * have broken the bound. */
export function federate(spec: {
  sources: Record<string, AsyncProvider | { provider: AsyncProvider; estimatedRows?: number }>;
  maxRows: number;
  maxBytes: number;
  /** Shared admission credits across source reads and intermediate sets; defaults to 2 * maxRows. */
  maxTotalRows?: number;
  /** Defaults to 2 * maxBytes. Buffered providers/intermediates are checked after production. */
  maxTotalBytes?: number;
  strategy?: 'hash';
}): {
  source<T = unknown>(name: string): FederatedSource<T>;
  readonly names: readonly string[];
};

/** The push→pull adapter for feed/end readers (§12). */
export function createPushQueue<T = unknown>(options?: { highWaterMark?: number }): {
  feed(value: T): boolean;
  end(error?: unknown): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
};
