/**
 * Hand-authored declarations for `@jarenjs/linq/forms` — the schema
 * pen's every name, from subclasses that carry the `x-form` vocabulary,
 * plus `assertOnSubmit()`.
 *
 * A rule is an ANNOTATION, so nothing here changes what a builder
 * INFERS: `Infer<>`, `Input<>` and the flags read exactly as they do on
 * the schema pen, and the subclasses exist only so `form()` survives
 * every chained method. What the rules are typed against is the rule
 * CONTEXT: `c.root` is the whole form document, typed by annotation
 * (`(c: RuleContext<Invoice>) => …`) because a member builder is
 * written before the object that will hold it exists — the same limit
 * the flow pen's `context` meets, and TypeScript's own.
 *
 * Every claim here has a runtime twin in `test/linq/forms-pen.test.js`
 * and a compile-level pin in `test/consumer/linq-app.ts`; PENS-FORMAT.md
 * §10 is the normative mapping table.
 */

import type { BoolExpr, DateTime, MemberExpr, StringExpr } from './index.js';
import type {
  Annotations, BuilderLike, Flag, Infer, Input, Json, JsonSchema, NamedLike, Simplify,
  SchemaBuilder, StringBuilder, NumberBuilder, BooleanBuilder, NullBuilder, ArrayBuilder,
  TupleBuilder, ObjectBuilder, NamedBuilder, WhenBuilder,
} from './schema.js';

type AnyBuilder = BuilderLike<any, any, any>;
type Props = Record<string, AnyBuilder>;
type Nullify<T, N extends boolean> = N extends true ? T | null : T;

// ————— the rule context —————

/**
 * The three names a rule query binds (the forms README, "The rule query
 * context"): the whole document at `$`, the field's own value as the
 * `$value` external and its pointer as `$pointer`. `Doc` is the honest
 * top until the callback is annotated.
 */
export interface RuleContext<Doc = unknown, Value = unknown> {
  /** The whole form document (`$`) — cross-field is the point. */
  readonly root: MemberExpr<Doc>;
  /** The field's current value (`$value`); an absent field binds `null`. */
  readonly value: MemberExpr<Value>;
  /** The field's data pointer (`$pointer`), `'/vatId'`. */
  readonly pointer: StringExpr;
}

/** A rule: a callback captured over the context, or a query document. */
export type Rule<Doc = unknown, Value = unknown> =
  | ((context: RuleContext<Doc, Value>) => unknown)
  | { readonly [keyword: string]: unknown };

/** The message an `assert` failure renders: an inline template, or a
 * catalog spec (the forms README, "MessageSpec in `x-form.message`"). */
export type MessageSpec =
  | string
  | { readonly $msgid?: string; readonly message?: string; readonly params?: Record<string, Json> };

/**
 * What `form()` takes — exactly the members `x-form` defines. `preview`
 * is absent on purpose: a field's preview hint is DERIVED from its
 * format by the registry, never authored, and writing it is `JL0102`.
 */
export interface FormRules<Doc = unknown, Value = unknown> {
  /** Should the field be shown? Asserted by effective boolean value; fails OPEN. */
  readonly visible?: Rule<Doc, Value>;
  /** Should the field accept input? EBV; fails OPEN. */
  readonly enabled?: Rule<Doc, Value>;
  /** A cross-field preemptive assertion. EBV; fails CLOSED. */
  readonly assert?: Rule<Doc, Value>;
  /** The field's derived value, mapped to plain JSON. */
  readonly computed?: Rule<Doc, Value>;
  /** Shown when `assert` fails. */
  readonly message?: MessageSpec;
}

// ————— the rule-aware builders —————

/** The base every untyped kind is built from, plus `form()`. */
export class FormBuilder<Out = unknown, In = Out, F extends Flag = never> extends SchemaBuilder<Out, In, F> {
  optional(): FormBuilder<Out, In, F | 'optional'>;
  nullable(): FormBuilder<Out | null, In | null, F>;
  default(value: Out): FormBuilder<Out, In, F | 'defaulted'>;
  /** One `x-form` annotation; a second call merges into the same one. */
  form<Doc = unknown>(rules: FormRules<Doc, Out>): this;
  /** As in the schema pen, but `x-form` is owned here. */
  meta(annotations: Annotations & { readonly 'x-form'?: never }): this;
}

export class FormStringBuilder<Out = string, In = Out, F extends Flag = never> extends StringBuilder<Out, In, F> {
  optional(): FormStringBuilder<Out, In, F | 'optional'>;
  nullable(): FormStringBuilder<Out | null, In | null, F>;
  default(value: Out): FormStringBuilder<Out, In, F | 'defaulted'>;
  coerce(): FormStringBuilder<Out, In | number | boolean, F>;
  format(name: 'date-time' | 'date'): FormStringBuilder<DateTime, DateTime, F>;
  format(name: string): this;
  enumOf<const V extends readonly string[]>(values: V): FormStringBuilder<V[number], V[number], F>;
  form<Doc = unknown>(rules: FormRules<Doc, Out>): this;
  meta(annotations: Annotations & { readonly 'x-form'?: never }): this;
}

export class FormNumberBuilder<Out = number, In = Out, F extends Flag = never> extends NumberBuilder<Out, In, F> {
  optional(): FormNumberBuilder<Out, In, F | 'optional'>;
  nullable(): FormNumberBuilder<Out | null, In | null, F>;
  default(value: Out): FormNumberBuilder<Out, In, F | 'defaulted'>;
  coerce(): FormNumberBuilder<Out, In | string, F>;
  enumOf<const V extends readonly number[]>(values: V): FormNumberBuilder<V[number], V[number] | Exclude<In, number>, F>;
  form<Doc = unknown>(rules: FormRules<Doc, Out>): this;
  meta(annotations: Annotations & { readonly 'x-form'?: never }): this;
}

declare class FormBooleanBuilder<Out = boolean, In = Out, F extends Flag = never> extends BooleanBuilder<Out, In, F> {
  optional(): FormBooleanBuilder<Out, In, F | 'optional'>;
  nullable(): FormBooleanBuilder<Out | null, In | null, F>;
  default(value: Out): FormBooleanBuilder<Out, In, F | 'defaulted'>;
  coerce(): FormBooleanBuilder<Out, In | string, F>;
  form<Doc = unknown>(rules: FormRules<Doc, Out>): this;
  meta(annotations: Annotations & { readonly 'x-form'?: never }): this;
}

declare class FormNullBuilder<Out = null, In = Out, F extends Flag = never> extends NullBuilder<Out, In, F> {
  optional(): FormNullBuilder<Out, In, F | 'optional'>;
  default(value: Out): FormNullBuilder<Out, In, F | 'defaulted'>;
  coerce(): FormNullBuilder<Out, In | string, F>;
  form<Doc = unknown>(rules: FormRules<Doc, Out>): this;
  meta(annotations: Annotations & { readonly 'x-form'?: never }): this;
}

export class FormArrayBuilder<Out = unknown[], In = Out, F extends Flag = never> extends ArrayBuilder<Out, In, F> {
  optional(): FormArrayBuilder<Out, In, F | 'optional'>;
  nullable(): FormArrayBuilder<Out | null, In | null, F>;
  default(value: Out): FormArrayBuilder<Out, In, F | 'defaulted'>;
  form<Doc = unknown>(rules: FormRules<Doc, Out>): this;
  meta(annotations: Annotations & { readonly 'x-form'?: never }): this;
}

export class FormTupleBuilder<
  T extends readonly AnyBuilder[], R = unknown, RIn = R,
  N extends boolean = false, F extends Flag = never,
> extends TupleBuilder<T, R, RIn, N, F> {
  optional(): FormTupleBuilder<T, R, RIn, N, F | 'optional'>;
  nullable(): FormTupleBuilder<T, R, RIn, true, F>;
  rest<B extends AnyBuilder>(builder: B): FormTupleBuilder<T, Infer<B>, Input<B>, N, F>;
  form<Doc = unknown>(rules: FormRules<Doc, unknown>): this;
  meta(annotations: Annotations & { readonly 'x-form'?: never }): this;
}

export class FormObjectBuilder<
  P extends Props, Open extends boolean = false, PV = never, PVIn = PV,
  N extends boolean = false, F extends Flag = never,
> extends ObjectBuilder<P, Open, PV, PVIn, N, F> {
  optional(): FormObjectBuilder<P, Open, PV, PVIn, N, F | 'optional'>;
  nullable(): FormObjectBuilder<P, Open, PV, PVIn, true, F>;
  open(): FormObjectBuilder<P, true, PV, PVIn, N, F>;
  patternProperties<M extends Props>(map: M): FormObjectBuilder<P, Open, Infer<M[keyof M]>, Input<M[keyof M]>, N, F>;
  extend<Q extends Props>(props: Q): FormObjectBuilder<Simplify<Omit<P, keyof Q> & Q>, Open, PV, PVIn, N, F>;
  pick<K extends keyof P & string>(keys: readonly K[]): FormObjectBuilder<Pick<P, K>, Open, PV, PVIn, N, F>;
  omit<K extends keyof P & string>(keys: readonly K[]): FormObjectBuilder<Omit<P, K>, Open, PV, PVIn, N, F>;
  /** A rule on the ROOT's `visible` is refused by `compileFormRules`:
   * hiding the whole form would null the render tree and its summary. */
  form<Doc = unknown>(rules: FormRules<Doc, unknown>): this;
  meta(annotations: Annotations & { readonly 'x-form'?: never }): this;
}

declare class FormNamedBuilder<Out, In = Out, F extends Flag = never> extends NamedBuilder<Out, In, F> {
  optional(): FormNamedBuilder<Out, In, F | 'optional'>;
  nullable(): FormNamedBuilder<Out | null, In | null, F>;
  form<Doc = unknown>(rules: FormRules<Doc, Out>): this;
  meta(annotations: Annotations & { readonly 'x-form'?: never }): this;
}

export class FormWhenBuilder<F extends Flag = never> extends WhenBuilder<F> {
  optional(): FormWhenBuilder<F | 'optional'>;
  then(builder: AnyBuilder): FormWhenBuilder<F>;
  else(builder: AnyBuilder): FormWhenBuilder<F>;
}

// ————— the named factories —————

export function string(): FormStringBuilder;
export function number(): FormNumberBuilder;
export function integer(): FormNumberBuilder;
export function boolean(): FormBooleanBuilder;
export function nil(): FormNullBuilder;
export function literal<const V extends Json>(value: V): FormBuilder<V, V>;
export function enumOf<const V extends readonly Json[]>(values: V): FormBuilder<V[number], V[number]>;
export function object<P extends Props>(props: P): FormObjectBuilder<P>;
export function array<B extends AnyBuilder>(items: B): FormArrayBuilder<Infer<B>[], Input<B>[]>;
export function tuple<T extends readonly AnyBuilder[]>(items: readonly [...T]): FormTupleBuilder<T>;
export function record<B extends AnyBuilder>(values: B):
  FormBuilder<{ [key: string]: Infer<B> }, { [key: string]: Input<B> }>;
export function union<T extends readonly AnyBuilder[]>(options: readonly [...T]):
  FormBuilder<Infer<T[number]>, Input<T[number]>>;
export function discriminated<K extends string, T extends readonly BuilderLike<Record<K, unknown>, any, any>[]>(
  key: K, options: readonly [...T]): FormBuilder<Infer<T[number]>, Input<T[number]>>;
export function intersection<T extends readonly AnyBuilder[]>(parts: readonly [...T]):
  FormBuilder<Intersect<{ [I in keyof T]: Infer<T[I]> }>, Intersect<{ [I in keyof T]: Input<T[I]> }>>;
type Intersect<T extends readonly unknown[]> = T extends readonly [infer H, ...infer R] ? H & Intersect<R> : unknown;
export function named<B extends AnyBuilder>(name: string, builder: B): FormNamedBuilder<Infer<B>, Input<B>>;
export function ref<T = unknown>(name: string): FormBuilder<T, T>;
export function lazy<T, I = T>(thunk: () => NamedLike<T, I>): FormBuilder<T, I>;
export function any(): FormBuilder<unknown, unknown>;
export function never(): FormBuilder<never, never>;
export function when(cond: AnyBuilder): FormWhenBuilder;
export function from<T = unknown>(json: JsonSchema | boolean): FormBuilder<T, T>;
export function document(root: AnyBuilder, options?: { draft?: '2020-12' }): JsonSchema | boolean;
export function datetime(): FormStringBuilder<DateTime, DateTime>;
export function date(): FormStringBuilder<DateTime, DateTime>;
export function time(): FormStringBuilder;
export function duration(): FormStringBuilder;

/** The mixin the classes above are built with: a NEW class carrying `form()`. */
export function withForm<B extends new (...args: any[]) => any>(Base: B): B;

/**
 * The submit twin of a document's `x-form.assert` rules (the forms
 * README's layer 3): every assert copied onto the ROOT as its own
 * `allOf` branch `{ $query, errorMessage }`, so the rule an author wrote
 * once for per-keystroke feedback is what the compiled validator
 * enforces. A document with no assert answers itself.
 */
export function assertOnSubmit(root: AnyBuilder | JsonSchema): JsonSchema;

export const SCHEMA_BUILDER: unique symbol;
export function isSchemaBuilder(value: unknown): value is BuilderLike;
export function schemaOf(value: unknown): unknown;
export type { BoolExpr };
