/**
 * Hand-authored declarations for `@jarenjs/linq/jslt` — the JSLT pen's
 * type contract, kept to the same line as `index.d.ts`: the common path
 * is precisely typed, the exotic path is honestly `unknown`, nothing is
 * ever a WRONG type.
 *
 * A body's VALUE is typed by annotating the callback's first argument
 * (`(v: Expr<Book>) => …`) or by the rule's `schema` match when it is a
 * schema-pen builder; without either it is the honest top. A body's
 * externals are `root` and `path` — always present, no declaration —
 * plus the parameters the body declares by name (`{ externals: ['rate']
 * }`): a declared name types as `UnknownExpr` until the second argument
 * is annotated (`x: Externals<{ rate: number }>`), an undeclared name is
 * a compile error, as with the chain's `params()`.
 *
 * The honest limits: a rule's OUTPUT is the unwrapped shape of what its
 * body returns, with every `apply()` — a dispatch to OTHER rules —
 * `unknown`; a stylesheet's `In`/`Out` are its FIRST rule's (write the
 * root rule first, as Appendix A does), or what the author annotates
 * (`stylesheet<In, Out>(…)`). The built-in rule's rebuilds (`share`/
 * `fresh` around an unmatched container) are not typed at all: a
 * stylesheet whose root is unmatched is `Stylesheet<unknown, unknown>`
 * unless annotated. Every claim here has a runtime twin in
 * `test/linq/jslt-pen.test.js` and a compile-level pin in
 * `test/consumer/linq-jslt.ts`.
 */

import type { ExprBase, MemberExpr, StringExpr, UnknownExpr, Unwrap } from './index.js';
import type { BuilderLike, Json, JsonSchema } from './schema.js';

/** A mode's built-in-rule disposition (JSLT-FORMAT §5). */
export type Disposition = 'share' | 'fresh' | 'error';

/**
 * The externals a body may name: the two the engine binds on every
 * dispatch (§8.2) and the parameters the body declared (§8.1).
 */
export type Externals<X = {}, Root = unknown> = {
  /** The input document root (`$root`). */
  readonly root: MemberExpr<Root>;
  /** The matched value's normalized path (`$path`) — `null` for a location-less value. */
  readonly path: StringExpr;
} & {
  readonly [K in keyof X & string]-?: MemberExpr<X[K]>;
};

/** Any expression-ish callback result the capture accepts. */
export type BodyResult = ExprBase<unknown> | object | string | number | boolean | null;

/** The value phantom of an expression type; the honest top otherwise. */
export type ValueOf<V> = V extends ExprBase<infer T> ? (unknown extends T ? unknown : T) : unknown;

/**
 * A rule body's document — plain JSON (the `$expr` of a rule), carrying
 * the value it was captured over and the shape it produces as
 * phantoms. `body()` writes one; `rule()` reads both phantoms.
 */
export type BodyDocument<In = unknown, Out = unknown> = Json & {
  /** Phantoms: declared, never present at runtime. */
  readonly __in: In;
  readonly __out: Out;
};

export interface BodyOptions<N extends string> {
  /** The stylesheet parameters this body names (§8.1); `root` and `path` need none. */
  readonly externals?: readonly N[];
}

/**
 * Capture one rule body over the matched value at `$`. Type the value
 * by annotating `v` (`(v: Expr<Book>) => …`); declare parameters by
 * name and type them by annotating `x` (`x: Externals<{ rate: number
 * }>`) — an undeclared name on `x` does not compile.
 */
export function body<
  V extends ExprBase<unknown> = UnknownExpr,
  N extends string = never,
  R extends BodyResult = BodyResult,
  Root = unknown,
  X extends Record<N, unknown> = Record<N, unknown>,
>(
  fn: (value: V, x: Externals<X, Root>) => R,
  options?: BodyOptions<N>,
): BodyDocument<ValueOf<V>, Unwrap<R>>;

/**
 * `{ $apply: selector }` / `{ $apply: [selector, mode] }` — the
 * apply-templates operator (§6), inside a `body()` callback. Its result
 * is a dispatch to other rules, so it is the honest top: as an array
 * element (`[apply(…)]`, the `[]` idiom) it unwraps to `unknown[]`; as a
 * bare object member it is refused at build time (`JL0102`).
 */
export function apply(selector: ExprBase<unknown> | string | Json, mode?: string): UnknownExpr;

/**
 * `{ [name]: operands }` — a registered operator (§13), spelled without
 * judging it; the engine's compiler decides. Works in any capture.
 */
export function op(name: `$${string}`, operands?: ExprBase<unknown> | Json | readonly (ExprBase<unknown> | Json)[]): UnknownExpr;

/** The `match` member (§3): a JSONPath string, `{ path?, schema? }`, or `null` for the unconditional rule. */
export type Match =
  | string
  | null
  | undefined
  | { readonly path?: string; readonly schema?: BuilderLike | JsonSchema | boolean };

/** The value a match types: a schema-pen builder's `Infer<>`; the honest top otherwise. */
export type MatchIn<M> = M extends { readonly schema: BuilderLike<infer O, any, any> } ? O : unknown;

export interface RuleOptions {
  /** The rule's mode (§7); the unnamed mode `""` by default. */
  readonly mode?: string;
  /** Explicit conflict resolution (§4); the three defaults otherwise. */
  readonly priority?: number;
}

/** The `match` member as emitted. */
export type MatchDocument =
  | string
  | { readonly path?: string; readonly schema?: JsonSchema | boolean };

/** A rule as a plain document — what `stylesheet()` takes, by pen or by hand. */
export interface RuleDocument {
  readonly mode?: string;
  readonly match?: MatchDocument;
  readonly priority?: number;
  readonly body: Json;
}

/** One template rule (§2.2), carrying its body's phantoms. */
export interface Rule<In = unknown, Out = unknown> extends RuleDocument {
  readonly __in: In;
  readonly __out: Out;
}

/** A callback rule: the value is typed by annotating it (`(v: Expr<Book>) => …`)
 * or by the match's schema builder; the honest top otherwise. */
export function rule<
  M extends Match,
  R extends BodyResult,
  V extends ExprBase<unknown> = MemberExpr<MatchIn<M>>,
>(
  match: M,
  fn: (value: V, x: Externals<{}, unknown>) => R,
  options?: RuleOptions,
): Rule<ValueOf<V>, Unwrap<R>>;
/** A `body()` document: its phantoms are the rule's (the match's schema types `In` when the body is untyped). */
export function rule<M extends Match, In, Out>(
  match: M,
  body: BodyDocument<In, Out>,
  options?: RuleOptions,
): Rule<unknown extends In ? MatchIn<M> : In, Out>;
/** A query document verbatim: nothing is inferred. */
export function rule(match: Match, body: Json, options?: RuleOptions): Rule<unknown, unknown>;

export interface StylesheetOptions {
  /** The default disposition of every mode (§2.1, §5). */
  readonly unmatched?: Disposition;
  /** Per-mode overrides. */
  readonly modes?: { readonly [mode: string]: { readonly unmatched: Disposition } };
}

/** The envelope (§2.1), carrying the root rule's phantoms. */
export interface Stylesheet<In = unknown, Out = unknown> {
  readonly __in: In;
  readonly __out: Out;
  readonly $jslt: '0.1';
  readonly unmatched?: Disposition;
  readonly modes?: { readonly [mode: string]: { readonly unmatched: Disposition } };
  readonly rules: readonly RuleDocument[];
}

/** A rule's `In` phantom; a hand-written rule is `unknown`. */
export type RuleIn<R> = R extends Rule<infer I, any> ? I : unknown;
/** A rule's `Out` phantom; a hand-written rule is `unknown`. */
export type RuleOut<R> = R extends Rule<any, infer O> ? O : unknown;

/** The envelope over rule documents; `In`/`Out` are the FIRST rule's. */
export function stylesheet<const R extends readonly RuleDocument[]>(
  rules: R,
  options?: StylesheetOptions,
): Stylesheet<RuleIn<R[0]>, RuleOut<R[0]>>;
/** The envelope with the phantoms as the author states them. */
export function stylesheet<In, Out>(
  rules: readonly RuleDocument[],
  options?: StylesheetOptions,
): Stylesheet<In, Out>;

/** The input a stylesheet (or rule) was written over. */
export type Input<S> = S extends { readonly __in: infer I } ? I : unknown;
/** The shape a stylesheet (or rule) produces. */
export type Output<S> = S extends { readonly __out: infer O } ? O : unknown;
