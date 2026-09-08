/**
 * Hand-authored declarations for `@jarenjs/linq/schema` — the schema
 * pen's type contract, kept to the same line as `index.d.ts`: the
 * common path is precisely typed, the exotic path is honestly
 * `unknown`, nothing is ever a WRONG type. Every builder carries two
 * phantoms — `Out`, the shape a document describes AFTER
 * normalization, and `In`, the shape a caller may hand in BEFORE it —
 * and a flag set that decides whether an object member is required on
 * each side. `Infer<>` and `Input<>` read them.
 *
 * Every rule here is emit's reading of the EMITTED document
 * (EMIT-FORMAT §5–§7): a closed object has no index signature, an open
 * one carries `[k: string]: unknown`, a tuple keeps an open rest until
 * `.rest(never())`, a `default()`ed member is present after
 * normalization and optional before it, a `coerce()`d scalar accepts
 * its transport forms on the way in, a constraint (`min`, `pattern`,
 * `format`) never narrows a type, and a date-formatted string is the
 * `DateTime` brand. The three-way agreement — pen type ≡ emit's
 * declaration ≡ the validator's verdicts — is pinned for every corpus
 * entry in `test/consumer/linq-schema.ts` (types) and
 * `test/linq/schema-pen.test.js` (runtime).
 */

import type { BoolExpr, DateTime, Expr, ObjectExpr, StringExpr, UnknownExpr } from './index.js';

/** A JSON value. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A JSON Schema document as the pen writes it: keywords, verbatim. */
export interface JsonSchema {
  readonly [keyword: string]: unknown;
}

/** The flags a member carries: left out of `required`; carrying a JSON
 * Schema `default`; and, for the model pen, a store-written default
 * (`generated`) or a `key()` mark. */
export type Flag = 'optional' | 'defaulted' | 'generated' | 'key';

/** Flatten an intersection into one object type (what emit prints). */
export type Simplify<T> = { [K in keyof T]: T[K] };

/** `T`, or `T | null` when the builder is nullable. */
type Nullify<T, N extends boolean> = N extends true ? T | null : T;

/**
 * What every builder looks like to a type that only needs its phantoms
 * — the constraint every builder-taking position uses. Structural on
 * purpose: a builder class is compared by its four carriers, never by
 * its methods, so a subclass with a narrower `check()` parameter still
 * fits wherever "a builder" is asked for.
 */
export interface BuilderLike<Out = unknown, In = unknown, F extends Flag = Flag> {
  readonly __out: Out;
  readonly __in: In;
  readonly __flags: F;
  readonly schema: JsonSchema | boolean;
}

/** A named builder, by its phantom: what `lazy()` demands. */
export interface NamedLike<Out = unknown, In = unknown> extends BuilderLike<Out, In, Flag> {
  readonly __named: true;
}

type AnyBuilder = BuilderLike<any, any, any>;

/** `Expr<any>` would pick the first conditional arm; the honest top instead. */
type ValueExpr<Out> = 0 extends (1 & Out) ? UnknownExpr : Expr<Out>;

/** The output shape of a builder. */
export type Infer<B> = B extends BuilderLike<infer O, any, any> ? O : never;

/** The accepted (input) shape of a builder — `Infer` with `default()`ed
 * members optional and `coerce()`d scalars widened to their transport
 * forms, exactly as the normalizer's accepted twin reads. */
export type Input<B> = B extends BuilderLike<any, infer I, any> ? I : never;

/** The document type a builder writes. */
export type SchemaOf<B> = B extends BuilderLike<any, any, any> ? B['schema'] : never;

export type FlagsOf<B> = B extends BuilderLike<any, any, infer F> ? F : never;

/** Required after normalization: unless `optional()` and not `default()`ed. */
type OutRequired<B> = 'optional' extends FlagsOf<B> ? ('defaulted' extends FlagsOf<B> ? true : false) : true;
/** Required before normalization: unless `optional()` or `default()`ed. */
type InRequired<B> = 'optional' extends FlagsOf<B> ? false : 'defaulted' extends FlagsOf<B> ? false : true;

type Props = Record<string, AnyBuilder>;

type Members<P extends Props> = Simplify<
  { [K in keyof P as OutRequired<P[K]> extends true ? K : never]: Infer<P[K]> } &
  { [K in keyof P as OutRequired<P[K]> extends true ? never : K]?: Infer<P[K]> }>;
type MembersIn<P extends Props> = Simplify<
  { [K in keyof P as InRequired<P[K]> extends true ? K : never]: Input<P[K]> } &
  { [K in keyof P as InRequired<P[K]> extends true ? never : K]?: Input<P[K]> }>;

/** Emit widens an index signature to cover every declared member. */
type Indexed<M, V> = Simplify<M & { [key: string]: V | Required<M>[keyof M] }>;

type ObjectShape<P extends Props, Open extends boolean, PV, M> =
  Open extends true ? Simplify<M & { [key: string]: unknown }>
    : [keyof P] extends [never] ? ([PV] extends [never] ? Record<string, never> : { [key: string]: PV })
      : [PV] extends [never] ? M : Indexed<M, PV>;

type ObjectOut<P extends Props, Open extends boolean, PV> = ObjectShape<P, Open, PV, Members<P>>;
type ObjectIn<P extends Props, Open extends boolean, PV> = ObjectShape<P, Open, PV, MembersIn<P>>;

type Outs<T extends readonly AnyBuilder[]> = { [I in keyof T]: Infer<T[I]> };
type Ins<T extends readonly AnyBuilder[]> = { [I in keyof T]: Input<T[I]> };

type TupleOf<T extends readonly unknown[], R> = [R] extends [never] ? [...T] : [...T, ...R[]];

type Intersect<T extends readonly unknown[]> =
  T extends readonly [infer H, ...infer R] ? H & Intersect<R> : unknown;

/** The externals a `check()` rule may name — the two the validator binds. */
export interface CheckExternals {
  /** The instance root (`$root`): an object whose members are the honest top. */
  readonly root: ObjectExpr<Record<string, unknown>>;
  /** The current location as a JSON pointer string (`$path`). */
  readonly path: StringExpr;
}

/** A `check()` rule: a captured callback, or a query document verbatim. */
export type CheckRule<Out> =
  | ((value: ValueExpr<Out>, externals: CheckExternals) => BoolExpr | boolean)
  | { readonly [keyword: string]: unknown };

/** Annotations `meta()` writes verbatim: any key but the ones the pen owns. */
export type Annotations = { readonly [keyword: string]: Json } & {
  readonly [K in OwnedKeyword]?: never;
};

/** The keywords the pen writes itself (`JL0104` through `meta()`). */
export type OwnedKeyword =
  | '$schema' | '$id' | '$ref' | '$defs' | 'definitions' | '$anchor' | '$dynamicRef'
  | '$dynamicAnchor' | '$recursiveRef' | '$recursiveAnchor' | '$vocabulary' | '$query'
  | '$data' | 'data' | 'type' | 'nullable' | 'const' | 'enum' | 'properties' | 'required'
  | 'additionalProperties' | 'patternProperties' | 'propertyNames' | 'minProperties'
  | 'maxProperties' | 'dependentRequired' | 'dependentSchemas' | 'dependencies'
  | 'unevaluatedProperties' | 'items' | 'prefixItems' | 'additionalItems' | 'contains'
  | 'minContains' | 'maxContains' | 'minItems' | 'maxItems' | 'uniqueItems'
  | 'unevaluatedItems' | 'minLength' | 'maxLength' | 'pattern' | 'format'
  | 'contentEncoding' | 'contentMediaType' | 'contentSchema' | 'minimum' | 'maximum'
  | 'exclusiveMinimum' | 'exclusiveMaximum' | 'multipleOf' | 'formatMinimum'
  | 'formatMaximum' | 'formatExclusiveMinimum' | 'formatExclusiveMaximum' | 'anyOf'
  | 'oneOf' | 'allOf' | 'not' | 'if' | 'then' | 'else' | 'default' | 'title'
  | 'description' | 'examples' | 'errorMessage' | 'x-coerce' | 'x-trim';

/**
 * The immutable base every builder shares. `Out` is the shape after
 * normalization, `In` the shape before it, `F` the member flags.
 */
export class SchemaBuilder<Out = unknown, In = Out, F extends Flag = never> {
  protected constructor();
  /** Phantoms: declared, never present at runtime (a builder is never
   * constructed by hand, so nothing ever has to supply them). */
  readonly __out: Out;
  readonly __in: In;
  readonly __flags: F;
  /** The document: assembled once, deep-frozen, `$defs` hoisted. */
  readonly schema: JsonSchema | boolean;
  /** `JSON.stringify(builder)` is the document. */
  toJSON(): JsonSchema | boolean;
  /** `$id`: resource identity; the phantom is unchanged. */
  id(uri: string): this;
  /** Raw constraint escape hatch, without inferred narrowing. */
  keyword(key: string, value: Json): this;
  /** Validation or annotation only; retains the current phantom. */
  anchor(value: string): this;
  /** Validation or annotation only; retains the current phantom. */
  dynamicRef(value: string): this;
  /** Validation or annotation only; retains the current phantom. */
  dynamicAnchor(value: string): this;
  /** Validation or annotation only; retains the current phantom. */
  recursiveRef(value: string): this;
  /** Validation or annotation only; retains the current phantom. */
  recursiveAnchor(value: boolean): this;
  /** Validation or annotation only; retains the current phantom. */
  dollarData(value: string): this;
  /** Validation or annotation only; retains the current phantom. */
  vocabulary(value: Readonly<Record<string, boolean>>): this;
  /** Validation or annotation only; retains the current phantom. */
  data(value: Readonly<Record<string, string>>): this;
  /** Validation or annotation only; retains the current phantom. */
  not(value: AnyBuilder): this;
  /** Validation or annotation only; retains the current phantom. */
  unevaluatedProperties(value: AnyBuilder): this;
  /** Validation or annotation only; retains the current phantom. */
  unevaluatedItems(value: AnyBuilder): this;
  /** Validation or annotation only; retains the current phantom. */
  dependentSchemas(value: Props): this;
  /** Validation or annotation only; retains the current phantom. */
  definitions(value: Props): this;
  /** Validation or annotation only; retains the current phantom. */
  additionalItems(value: AnyBuilder): this;
  /** Validation or annotation only; retains the current phantom. */
  dependencies(value: Readonly<Record<string, AnyBuilder | readonly string[]>>): this;
  /** Legacy nullable may widen acceptance; no inferred shape is claimed. */
  legacyNullable(value: boolean): SchemaBuilder<unknown, unknown, F>;
  /** As an object member: left out of `required`. */
  optional(): SchemaBuilder<Out, In, F | 'optional'>;
  /** Admit `null`. */
  nullable(): SchemaBuilder<Out | null, In | null, F>;
  /** `default`: present after normalization, optional before it. */
  default(value: Out): SchemaBuilder<Out, In, F | 'defaulted'>;
  /** `description`. */
  describe(text: string): this;
  /** `title`. */
  title(text: string): this;
  /** One more entry of `examples`. */
  example(value: Out): this;
  /** Annotations written verbatim; a pen-owned keyword is refused (`JL0104`). */
  meta(annotations: Annotations): this;
  /** `errorMessage`: the validator's author-supplied message spec. */
  message(spec: Json): this;
  /** A cross-field rule as `$query` (a captured callback, or a document). */
  check(rule: CheckRule<Out>): this;
}

/** `{ type: 'string' }` and the string constraints. */
export class StringBuilder<Out = string, In = Out, F extends Flag = never> extends SchemaBuilder<Out, In, F> {
  /** `contentEncoding`; retains the current phantom. */
  contentEncoding(value: string): this;
  /** `contentMediaType`; retains the current phantom. */
  contentMediaType(value: string): this;
  /** `contentSchema`; retains the current phantom. */
  contentSchema(value: AnyBuilder): this;
  /** `formatMinimum`; retains the current phantom. */
  formatMinimum(value: string): this;
  /** `formatMaximum`; retains the current phantom. */
  formatMaximum(value: string): this;
  /** `formatExclusiveMinimum`; retains the current phantom. */
  formatExclusiveMinimum(value: string): this;
  /** `formatExclusiveMaximum`; retains the current phantom. */
  formatExclusiveMaximum(value: string): this;
  optional(): StringBuilder<Out, In, F | 'optional'>;
  nullable(): StringBuilder<Out | null, In | null, F>;
  default(value: Out): StringBuilder<Out, In, F | 'defaulted'>;
  /** `x-coerce`: numbers and booleans are accepted and become their text. */
  coerce(): StringBuilder<Out, In | number | boolean, F>;
  /** `x-trim`: leading and trailing whitespace is removed before validation. */
  trim(): this;
  /** `minLength`. */
  min(n: number): this;
  /** `maxLength`. */
  max(n: number): this;
  /** `minLength` and `maxLength` together. */
  length(n: number): this;
  /** `pattern`: a regular expression source (a flagless `RegExp` is taken by its source). */
  pattern(source: string | RegExp): this;
  /** `format`: `date-time` and `date` carry the `DateTime` brand. */
  format(name: 'date-time' | 'date'): StringBuilder<DateTime, DateTime, F>;
  format(name: string): this;
  /** `format: 'email'`. */
  email(): this;
  /** `format: 'uuid'`. */
  uuid(): this;
  /** `format: 'uri'`. */
  uri(): this;
  /** `enum` beside `type: 'string'` — a typed enum, the literal union. */
  enumOf<const V extends readonly string[]>(values: V): StringBuilder<V[number], V[number], F>;
}

/** `{ type: 'number' | 'integer' }` and the numeric constraints. */
export class NumberBuilder<Out = number, In = Out, F extends Flag = never> extends SchemaBuilder<Out, In, F> {
  optional(): NumberBuilder<Out, In, F | 'optional'>;
  nullable(): NumberBuilder<Out | null, In | null, F>;
  default(value: Out): NumberBuilder<Out, In, F | 'defaulted'>;
  /** `x-coerce`: a numeric string is accepted and becomes the number. */
  coerce(): NumberBuilder<Out, In | string, F>;
  /** `minimum`. */
  min(n: number): this;
  /** `maximum`. */
  max(n: number): this;
  /** `exclusiveMinimum`. */
  gt(n: number): this;
  /** `exclusiveMaximum`. */
  lt(n: number): this;
  /** `multipleOf`. */
  multipleOf(n: number): this;
  /** `type: 'integer'` — integer-ness is a documented widening, the type stays `number`. */
  int(): this;
  /** `enum` beside the numeric type — a typed enum, the literal union;
   * `coerce()` then widens `Input` by `string` (emit's accepted reading). */
  enumOf<const V extends readonly number[]>(values: V): NumberBuilder<V[number], V[number] | Exclude<In, number>, F>;
}

/** `{ type: 'boolean' }`. */
declare class BooleanBuilder<Out = boolean, In = Out, F extends Flag = never> extends SchemaBuilder<Out, In, F> {
  optional(): BooleanBuilder<Out, In, F | 'optional'>;
  nullable(): BooleanBuilder<Out | null, In | null, F>;
  default(value: Out): BooleanBuilder<Out, In, F | 'defaulted'>;
  /** `x-coerce`: `'true'`/`'false'` are accepted and become the boolean. */
  coerce(): BooleanBuilder<Out, In | string, F>;
}

/** `{ type: 'null' }`. */
declare class NullBuilder<Out = null, In = Out, F extends Flag = never> extends SchemaBuilder<Out, In, F> {
  optional(): NullBuilder<Out, In, F | 'optional'>;
  default(value: Out): NullBuilder<Out, In, F | 'defaulted'>;
  /** `x-coerce`: the empty string is accepted and becomes `null`. */
  coerce(): NullBuilder<Out, In | string, F>;
}

/** `{ type: 'array', items }` and the array constraints. */
export class ArrayBuilder<Out = unknown[], In = Out, F extends Flag = never> extends SchemaBuilder<Out, In, F> {
  /** `minContains`; retains the current phantom. */
  minContains(value: number): this;
  /** `maxContains`; retains the current phantom. */
  maxContains(value: number): this;
  optional(): ArrayBuilder<Out, In, F | 'optional'>;
  nullable(): ArrayBuilder<Out | null, In | null, F>;
  default(value: Out): ArrayBuilder<Out, In, F | 'defaulted'>;
  /** `minItems`. */
  min(n: number): this;
  /** `maxItems`. */
  max(n: number): this;
  /** `minItems` and `maxItems` together. */
  length(n: number): this;
  /** `uniqueItems: true`. */
  unique(): this;
  /** `contains`. */
  contains(builder: AnyBuilder): this;
}

/** `{ type: 'array', prefixItems, minItems }` — every position required,
 * the rest open until `.rest(never())`. */
export class TupleBuilder<
  T extends readonly AnyBuilder[],
  R = unknown, RIn = R,
  N extends boolean = false, F extends Flag = never,
> extends SchemaBuilder<Nullify<TupleOf<Outs<T>, R>, N>, Nullify<TupleOf<Ins<T>, RIn>, N>, F> {
  optional(): TupleBuilder<T, R, RIn, N, F | 'optional'>;
  nullable(): TupleBuilder<T, R, RIn, true, F>;
  default(value: Nullify<TupleOf<Outs<T>, R>, N>): TupleBuilder<T, R, RIn, N, F | 'defaulted'>;
  /** `items`: what may follow the positions; `never()` closes the tuple. */
  rest<B extends AnyBuilder>(builder: B): TupleBuilder<T, Infer<B>, Input<B>, N, F>;
}

/** `{ type: 'object', properties, required, additionalProperties: false }`. */
export class ObjectBuilder<
  P extends Props,
  Open extends boolean = false,
  PV = never, PVIn = PV,
  N extends boolean = false, F extends Flag = never,
> extends SchemaBuilder<Nullify<ObjectOut<P, Open, PV>, N>, Nullify<ObjectIn<P, Open, PVIn>, N>, F> {
  /** The members, as builders — what a pen over this one reads. */
  readonly __props: P;
  optional(): ObjectBuilder<P, Open, PV, PVIn, N, F | 'optional'>;
  nullable(): ObjectBuilder<P, Open, PV, PVIn, true, F>;
  default(value: Nullify<ObjectOut<P, Open, PV>, N>): ObjectBuilder<P, Open, PV, PVIn, N, F | 'defaulted'>;
  /** Drop `additionalProperties: false`: other members are admitted (`[k: string]: unknown`). */
  open(): ObjectBuilder<P, true, PV, PVIn, N, F>;
  /** `minProperties`. */
  minProperties(n: number): this;
  /** `maxProperties`. */
  maxProperties(n: number): this;
  /** `patternProperties`: on a closed object the index signature carries
   * the pattern values (widened over the members, as emit reads it). */
  patternProperties<M extends Props>(map: M):
    ObjectBuilder<P, Open, Infer<M[keyof M]>, Input<M[keyof M]>, N, F>;
  /** `propertyNames`. */
  propertyNames(builder: AnyBuilder): this;
  /** `dependentRequired`. */
  dependentRequired(map: { readonly [member: string]: readonly string[] }): this;
  /** More members; a later spelling of a name replaces the earlier one. */
  extend<Q extends Props>(props: Q): ObjectBuilder<Simplify<Omit<P, keyof Q> & Q>, Open, PV, PVIn, N, F>;
  /** Only these members. */
  pick<K extends keyof P & string>(keys: readonly K[]): ObjectBuilder<Pick<P, K>, Open, PV, PVIn, N, F>;
  /** All but these members. */
  omit<K extends keyof P & string>(keys: readonly K[]): ObjectBuilder<Omit<P, K>, Open, PV, PVIn, N, F>;
  /** Every member optional. */
  partial(): ObjectBuilder<{ [K in keyof P]: AsOptional<P[K]> }, Open, PV, PVIn, N, F>;
  /** These members (every member, when none are named) required again. */
  required<K extends keyof P & string>(keys?: readonly K[]):
    ObjectBuilder<{ [J in keyof P]: J extends K ? AsRequired<P[J]> : P[J] }, Open, PV, PVIn, N, F>;
  required(): ObjectBuilder<{ [K in keyof P]: AsRequired<P[K]> }, Open, PV, PVIn, N, F>;
}

type AsOptional<B> = B extends BuilderLike<infer O, infer I, infer G> ? BuilderLike<O, I, G | 'optional'> : never;
type AsRequired<B> = B extends BuilderLike<infer O, infer I, infer G> ? BuilderLike<O, I, Exclude<G, 'optional'>> : never;

/** A definition: hoisted to `$defs`, referenced where used. The
 * phantom `__named` is what `lazy()` demands. */
declare class NamedBuilder<Out, In = Out, F extends Flag = never> extends SchemaBuilder<Out, In, F> {
  readonly __named: true;
  optional(): NamedBuilder<Out, In, F | 'optional'>;
  nullable(): NamedBuilder<Out | null, In | null, F>;
  default(value: Out): NamedBuilder<Out, In, F | 'defaulted'>;
}

/**
 * The three builders above are TYPES, not values: `boolean()`, `nil()`
 * and `named()` all answer a plain `SchemaBuilder` at run time, so
 * there is no class to export and importing one as a value would
 * resolve to `undefined`. They are reached through the factory that
 * answers them and extended by the model and forms pens; the census in
 * `test/linq/types.test.js` holds the value half of this file equal to
 * what the module actually exports.
 */
export type { BooleanBuilder, NullBuilder, NamedBuilder };

/** `{ if, then, else }` — typed `unknown`, as emit reads a conditional. */
export class WhenBuilder<F extends Flag = never> extends SchemaBuilder<unknown, unknown, F> {
  optional(): WhenBuilder<F | 'optional'>;
  /** The `then` branch. Never `await` a `when()` builder: this method
   * makes it thenable-shaped, and a promise resolution is refused (`JL0101`). */
  then(builder: AnyBuilder): WhenBuilder<F>;
  /** The `else` branch. */
  else(builder: AnyBuilder): WhenBuilder<F>;
}

/**
 * `false` — the schema nothing satisfies. While that IS the document it
 * carries no keywords at all, so every method that would write one is
 * refused with `JL0102` rather than dropped. The signatures below say so
 * on BOTH sides: the return type is `never`, and the parameter is `never`
 * too, so the call does not compile either — a method declared only
 * `: never` still type-checks at its call site, which would leave the
 * refusal a run-time surprise for a caller who narrowed to this class.
 * `nullable()` is the way out and the refusals name it: the node
 * becomes `{ anyOf: [false, { type: 'null' }] }`, which carries keywords
 * like any other, so it answers the base builder rather than this class.
 * `never()` answers one, and this class is how a caller recognises it
 * (`instanceof`).
 */
export class NeverBuilder<Out = never, In = Out, F extends Flag = never> extends SchemaBuilder<Out, In, F> {
  /** `false` carries no members, so the boolean schema is the document. */
  readonly schema: false;
  optional(): NeverBuilder<Out, In, F | 'optional'>;
  /** The one method that widens what `false` admits — and so the one
   * that hands back a builder the annotations below are legal on. */
  nullable(): SchemaBuilder<Out | null, In | null, F>;
  /** Refused (`JL0102`) — `false` carries no `default`. */
  default(value: never): never;
  /** Refused (`JL0102`) — `false` carries no `description`. */
  describe(text: never): never;
  /** Refused (`JL0102`) — `false` carries no `title`. */
  title(text: never): never;
  /** Refused (`JL0102`) — `false` carries no `examples`. */
  example(value: never): never;
  /** Refused (`JL0102`) — `false` carries no annotation of any name. */
  meta(annotations: never): never;
  /** Refused (`JL0102`) — `false` carries no `errorMessage`. */
  message(spec: never): never;
  /** Refused (`JL0102`) — nothing reaches a check on `false`. */
  check(rule: never): never;
}

/** `{ type: 'string' }`. */
export function string(): StringBuilder;
/** `{ type: 'number' }`. */
export function number(): NumberBuilder;
/** `{ type: 'integer' }` — the type is `number`; integer-ness is a documented widening. */
export function integer(): NumberBuilder;
/** `{ type: 'boolean' }`. */
export function boolean(): BooleanBuilder;
/** `{ type: 'null' }`. */
export function nil(): NullBuilder;
/** `{ const: value }`. */
export function literal<const V extends Json>(value: V): SchemaBuilder<V, V>;
/** `{ enum: values }`. */
export function enumOf<const V extends readonly Json[]>(values: V): SchemaBuilder<V[number], V[number]>;
/** A closed object (`additionalProperties: false`) of named members. */
export function object<P extends Props>(props: P): ObjectBuilder<P>;
/** `{ type: 'array', items }`. */
export function array<B extends AnyBuilder>(items: B): ArrayBuilder<Infer<B>[], Input<B>[]>;
/** `{ type: 'array', prefixItems, minItems }`. */
export function tuple<T extends readonly AnyBuilder[]>(items: readonly [...T]): TupleBuilder<T>;
/** `{ type: 'object', additionalProperties: values }`. */
export function record<B extends AnyBuilder>(values: B):
  SchemaBuilder<{ [key: string]: Infer<B> }, { [key: string]: Input<B> }>;
/** `{ anyOf: options }`. A hand-written option is `from<T>(json)`. */
export function union<T extends readonly AnyBuilder[]>(options: readonly [...T]):
  SchemaBuilder<Outs<T>[number], Ins<T>[number]>;
/** `{ oneOf: options }`: objects each declaring `key` as a `literal()` or `enumOf()` member. */
export function discriminated<K extends string, T extends readonly BuilderLike<Record<K, unknown>, any, any>[]>(
  key: K, options: readonly [...T]): SchemaBuilder<Outs<T>[number], Ins<T>[number]>;
/** `{ allOf: parts }` — object parts must be `open()` (`JL0102` otherwise). */
export function intersection<T extends readonly AnyBuilder[]>(parts: readonly [...T]):
  SchemaBuilder<Intersect<Outs<T>>, Intersect<Ins<T>>>;
/** A definition: hoisted to `$defs` and referenced wherever it is used. */
export function named<B extends AnyBuilder>(name: string, builder: B): NamedBuilder<Infer<B>, Input<B>>;
/** A reference to a definition by name; `T` is caller-asserted (a
 * name carries no type) — `lazy()` is the inferred spelling. */
export function ref<T = unknown>(name: string): SchemaBuilder<T, T>;
/** A deferred reference to a NAMED builder — the recursion spelling.
 * Annotate the recursive constant (`const Node: SchemaBuilder<Node> = …`),
 * as any recursive inference needs. */
export function lazy<T, I = T>(thunk: () => NamedLike<T, I>): SchemaBuilder<T, I>;
/** `{}` — anything. */
export function any(): SchemaBuilder<unknown, unknown>;
/** `false` — nothing; it carries no annotations (`JL0102`). */
export function never(): NeverBuilder;
/** `{ if: cond }`, extended by `.then()`/`.else()`. */
export function when(cond: AnyBuilder): WhenBuilder;
/** A hand-written JSON Schema embedded verbatim; `T` is caller-asserted
 * (a JSON literal is never inferred). */
export function from<T = unknown>(json: JsonSchema | boolean): SchemaBuilder<T, T>;
/** A standalone document: `$schema` first when a draft is named. */
export function document(root: AnyBuilder, options?: { draft?: '2020-12' }): JsonSchema | boolean;
/** `{ type: 'string', format: 'date-time' }` — the `DateTime` brand. */
export function datetime(): StringBuilder<DateTime, DateTime>;
/** `{ type: 'string', format: 'date' }` — the `DateTime` brand. */
export function date(): StringBuilder<DateTime, DateTime>;
/** `{ type: 'string', format: 'time' }`. */
export function time(): StringBuilder;
/** `{ type: 'string', format: 'duration' }`. */
export function duration(): StringBuilder;

/** The brand key every builder answers `true` under. */
export const SCHEMA_BUILDER: unique symbol;
/** Whether `value` is a schema builder. */
export function isSchemaBuilder(value: unknown): value is BuilderLike;
/** A builder's document, or the value as given. */
export function schemaOf(value: unknown): unknown;
/** The JSON boundary every value entering a document crosses (`JL0101`). */
export function requireJson<T>(value: T, what: string): T;

/** A builder class as the factory wiring receives it — the pen supplies
 * eight, and every factory answers an instance of the one it was handed.
 * A pen's classes guard their constructors (`protected`: a builder is
 * never constructed by hand), and no construct signature accepts one, so
 * what this asks for is the class object itself. */
type BuilderClass = { readonly prototype: unknown };

/**
 * Build the named factories above for ONE set of builder classes. The
 * schema pen calls it with the classes in this file; `./model` and
 * `./forms` call it with their subclasses, so the wiring exists exactly
 * once and no subpath patches another's prototype.
 *
 * The answer is typed as the record it is, not as the twenty-six
 * signatures above: what each factory returns depends on the classes
 * handed in, which no signature here can name. A caller building a pen
 * of their own destructures it and annotates what they re-export — the
 * way `./model` and `./forms` do.
 */
export function createFactories(classes: {
  readonly Base: BuilderClass;
  readonly String: BuilderClass;
  readonly Number: BuilderClass;
  readonly Array: BuilderClass;
  readonly Tuple: BuilderClass;
  readonly Object: BuilderClass;
  readonly When: BuilderClass;
  readonly Never: BuilderClass;
}): Readonly<Record<string, (...args: any[]) => unknown>>;
