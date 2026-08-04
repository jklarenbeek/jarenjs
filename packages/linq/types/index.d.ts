/**
 * Hand-authored declarations for @jarenjs/linq — the deliberate type
 * surface (strategy 1 of the typed-surface order, recorded in
 * TODO_05's execution notes): the implementation stays plain JSDoc'd
 * JavaScript, and this file is the public type contract. The anti-drift
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
 * and the date operators (`year()`, `month()`, `day()`, `epoch()`)
 * become available on its expression without making EVERY string a
 * date. Purely a type-level marker — the runtime value is a plain
 * RFC 3339 string; there is no constructor and no runtime cost.
 */
export type DateTime = string & { readonly __jarenTag: 'date-time' };

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
}

export interface StringExpr extends ExprBase<string>, EqExpr<string> {
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

/** A `DateTime`-branded string: the string surface plus the date
 * component operators. */
export interface DateTimeExpr extends ExprBase<DateTime> {
  eq(value: string | DateTimeExpr | null): BoolExpr;
  ne(value: string | DateTimeExpr | null): BoolExpr;
  lt(value: string | DateTimeExpr): BoolExpr;
  le(value: string | DateTimeExpr): BoolExpr;
  gt(value: string | DateTimeExpr): BoolExpr;
  ge(value: string | DateTimeExpr): BoolExpr;
  year(): NumberExpr;
  month(): NumberExpr;
  day(): NumberExpr;
  /** Epoch milliseconds (`$epoch`). */
  epoch(): NumberExpr;
}

export interface ArrayExpr<E> extends ExprBase<E[]> {
  eq(value: readonly E[] | ArrayExpr<E> | null): BoolExpr;
  ne(value: readonly E[] | ArrayExpr<E> | null): BoolExpr;
  /** Fan the elements out (`[*]`) — a MANY-cardinality expression the
   * aggregates apply to (`u.tags.all().count()`). */
  all(): Expr<E> & AggregatableExpr;
  /** The element at a 0-based index; negative counts from the end. */
  at(index: number): Expr<E>;
  /** `$count` over the fanned elements requires `all()` first; this
   * counts the ARRAY as one item — see the format doc. */
  count(): NumberExpr;
}

/** Aggregates available on any expression (a fanned path, a group). */
export interface AggregatableExpr {
  count(): NumberExpr;
  sum(): NumberExpr;
  avg(): NumberExpr;
  min(): UnknownExpr;
  max(): UnknownExpr;
}

/** An object's expression: exactly its properties, recursively typed —
 * which is what makes a misspelled member a compile error. */
export type ObjectExpr<T> = ExprBase<T> & EqExpr<T> & {
  readonly [K in keyof T & string]-?: Expr<NonNullable<T[K]>>;
};

/** The honest top: everything is available, nothing is precise. Used
 * where inference ends (dynamic `get`, post-operator members, unknown
 * elements) — wide, never wrong. */
export interface UnknownExpr extends ExprBase<unknown>, AggregatableExpr {
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
  year(): NumberExpr;
  month(): NumberExpr;
  day(): NumberExpr;
  epoch(): NumberExpr;
  all(): UnknownExpr;
  at(index: number): UnknownExpr;
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

/** The provider contract (D2): any object exposing
 * `execute(document, options)`. The document arrives whole; the return
 * value uses the engine's result mapping. */
export interface Provider {
  execute(document: unknown, options: { externals: Record<string, unknown> }): unknown;
}

export interface LinqOptions {
  /** Enables `ofType`/`cast` (schema operators); e.g.
   * `createTypeTestCompiler()` from `@jarenjs/validate/query`. */
  compileTypeTest?: (schema: unknown, docPath: string) => (value: unknown) => boolean;
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

  /** Keep items the schema accepts. `S` is caller-asserted (a JSON
   * Schema is not a TypeScript type); the default is honest `unknown`. */
  ofType<S = unknown>(schema: object): Sequence<S, P>;
  cast<S = unknown>(schema: object): Sequence<S, P>;

  /** Recorded unsupported: throws `JL0006`. */
  zip(...args: never[]): never;

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

  /** Cross into the async surface (LINQ-FORMAT.md §11): the sync chain
   * becomes the pushed prefix; the element re-types to the callback's
   * RESOLVED type. */
  mapAsync<R>(fn: (item: T, signal: AbortSignal) => R, options: MapAsyncOptions):
    AsyncSequence<Awaited<R>, P>;
}

export function from<T>(source: Iterable<T>, options?: LinqOptions): Sequence<T, {}>;
export function from<T = unknown>(source: Provider, options?: LinqOptions): Sequence<T, {}>;

export function fromDocument<T = unknown>(
  source: Iterable<unknown> | Provider,
  document: unknown,
  options?: LinqOptions,
): Sequence<T, {}>;

/** The runtime code table, synced to LINQ-FORMAT.md §9 by a test. */
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

// ————— The asynchronous surface (LINQ-FORMAT.md §§10–12) —————

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
  skip(count: number): AsyncSequence<T, P>;
  take(count: number): AsyncSequence<T, P>;
  distinct(): AsyncSequence<T, P>;
  reverse(): AsyncSequence<T, P>;
  /** Only a CONSTANT array can join an async stream (§10). */
  concat(other: readonly T[]): AsyncSequence<T, P>;
  defaultIfEmpty(fallback?: T | null): AsyncSequence<T | null, P>;
  ofType<S = unknown>(schema: object): AsyncSequence<S, P>;
  cast<S = unknown>(schema: object): AsyncSequence<S, P>;
  zip(...args: never[]): never;
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

export function fromAsync<T>(
  source: AsyncIterable<T> | Iterable<T> | AsyncCursor<T>,
  options?: LinqOptions,
): AsyncSequence<T, {}>;

/** The push→pull adapter for feed/end readers (§12). */
export function createPushQueue<T = unknown>(options?: { highWaterMark?: number }): {
  feed(value: T): boolean;
  end(error?: unknown): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
};
