/**
 * Hand-authored declarations for `@jarenjs/linq/app` — the app pen's
 * type contract, kept to the same line as `index.d.ts`: the common path
 * is precisely typed, the exotic path is honestly `unknown`, nothing is
 * ever a WRONG type.
 *
 * `AppDocument<State, Actions>` carries the state shape and the ACTION
 * NAMES as phantoms, both read off the declarations themselves — the
 * keys of `actions` are literal, so `ActionsOf<typeof app>` is the union
 * a `bind<Names>()` is checked against and `bind<Names>('nope')` does
 * not compile, before it is `JL0102` and long before the loop's
 * `JA2001`.
 *
 * The honest limits, both of them TypeScript's own (a function's type
 * arguments are all-or-none, and a sibling member's inferred type cannot
 * contextually type a callback beside it):
 *
 * - an action's `s` is typed by ANNOTATION — `action((s: Expr<State>, x)
 *   => …)` — because `action()` is evaluated before `defineApp()` sees
 *   the `state` builder. What `defineApp({ state })` types is the
 *   DOCUMENT (`StateOf<typeof app>`), which is what a host reading
 *   `app.getState()` needs. `x.payload` needs no annotation:
 *   `action(fn, { payload })` declares it on the same call.
 * - `bind()`'s action name is checked by annotating the call —
 *   `bind<Action>('todo/add')` — where `Action` is the union the author
 *   declared or `ActionsOf<>` read back. `defineApp()` checks the other
 *   direction at run time over the whole view, which is the half a type
 *   cannot reach: a view is a compiled stylesheet by then.
 *
 * Every claim here has a runtime twin in `test/linq/app-pen.test.js` and
 * a compile-level pin in `test/consumer/linq-app.ts`; APP-PEN.md is the
 * normative mapping table.
 */

import type { Expr, MemberExpr, UnknownExpr } from './index.js';
import type { BuilderLike, Infer, Json, JsonSchema } from './schema.js';

type AnyBuilder = BuilderLike<any, any, any>;

/** `Expr<any>`/`Expr<unknown>` would pick a wrong arm; the honest top instead. */
type ValueExpr<T> = MemberExpr<T>;

// ————— the action scope —————

/**
 * APP-FORMAT §3.1's default `$event` slice, plus one member per field
 * the binding requested. Every value is a JSON primitive by
 * construction: `$event` MUST survive `JSON.stringify`, the same
 * invariant as state.
 */
export type EventSlice<Fields extends string = never> =
  & { readonly type: unknown; readonly value: unknown; readonly checked: unknown; readonly key: unknown }
  & { readonly [K in Fields]: unknown };

/**
 * The two externals §3.1 binds beside the state — and the whole ambient
 * vocabulary an action has.
 */
export interface ActionScope<Payload = unknown, Fields extends string = never> {
  /** The dispatch payload (a binding's `with`), `null` when absent. */
  readonly payload: ValueExpr<Payload>;
  /** The serializable event slice, `null` for a programmatic dispatch. */
  readonly event: Expr<EventSlice<Fields>>;
}

/** A patch path: a lambda over the state, or an RFC 6901 pointer. The
 * lambda sees the SAME scope the action does, so a computed index may
 * read `$payload` — annotate it (`(c: Expr<State>, y: ActionScope<P>)`)
 * exactly as an action's own callback is annotated. */
export type PatchPath<State = unknown, Payload = unknown> =
  | ((state: ValueExpr<State>, externals: ActionScope<Payload>) => unknown)
  | string;

/** One RFC 6902 operation of a transition's `patch` (§3.2). */
export interface PatchOp {
  readonly op: 'add' | 'replace' | 'remove' | 'move' | 'copy' | 'test';
  readonly from?: unknown;
  readonly path: unknown;
  readonly value?: unknown;
}

/** One effect invocation (§5.1). */
export interface EffectDeclaration<Run extends string = string> {
  readonly run: Run;
  readonly with?: unknown;
}

/** A transition object (§3.2), as the action's capture spells it. */
export interface Transition {
  readonly state?: unknown;
  readonly patch?: readonly PatchOp[];
  readonly effects?: readonly EffectDeclaration[];
}

/** One captured action document, carrying its payload type as a phantom. */
export interface ActionDeclaration<Payload = unknown> {
  readonly __payload: Payload;
  readonly document: Json;
}

// ————— bindings and subscriptions —————

/** §4's object binding form. */
export interface Binding<Names extends string = string> {
  readonly action: Names;
  readonly with?: unknown;
  readonly event?: readonly string[];
  readonly preventDefault?: boolean;
  readonly stopPropagation?: boolean;
}

/** One subscription entry (§5.3). */
export interface SubDeclaration<Run extends string = string> {
  readonly run: Run;
  readonly with?: Json;
  readonly when?: Json;
  readonly withQuery?: Json;
  readonly key?: Json;
  readonly for?: Json;
}

/** What a subscription's `withQuery`/`key` binds under a `for` fan-out. */
export interface FanScope<Item = unknown> {
  /** The item this instance was fanned out over (`$item`). */
  readonly item: ValueExpr<Item>;
}

/** A subscription member: a callback over the state, or a query document. */
export type SubRule<State, Externals> =
  | ((state: ValueExpr<State>, externals: Externals) => unknown)
  | { readonly [keyword: string]: unknown }
  | string;

// ————— the document —————

/**
 * A `jaren-app` 0.1 document as the pen writes it, carrying the state
 * shape and the declared action names as phantoms.
 */
export interface AppDocument<State = unknown, Actions extends string = string> {
  readonly __state: State;
  readonly __actions: Actions;
  readonly $app: '0.1';
  readonly state?: Json;
  readonly view: unknown;
  readonly actions?: { readonly [name: string]: Json };
  readonly subs?: readonly SubDeclaration[];
}

/** What `defineApp()` answers: the document, and the state's schema
 * beside it — never merged, because the format has no slot for one. */
export interface AppResult<State = unknown, Actions extends string = string> {
  readonly document: AppDocument<State, Actions>;
  readonly stateSchema: JsonSchema | boolean | null;
}

/** The state an app document describes — what `app.getState()` answers. */
export type StateOf<A> = A extends AppResult<infer S, any> ? S
  : A extends AppDocument<infer S, any> ? S : never;
/** The action names an app declares — what a `bind<>()` is checked against. */
export type ActionsOf<A> = A extends AppResult<any, infer N> ? N
  : A extends AppDocument<any, infer N> ? N : never;

// ————— the surface —————

/**
 * One action document (§3): a callback captured over the state, `$event`
 * and `$payload`, whose result is a transition. Annotate `s` to type it
 * (`(s: Expr<State>, x) => …`); `payload` and `event` are TYPES only —
 * the format carries no schema for either.
 */
export function action<State = unknown>(
  fn: (state: ValueExpr<State>, externals: ActionScope<unknown, never>) => unknown,
): ActionDeclaration<unknown>;
export function action<
  B extends AnyBuilder, const Fields extends readonly string[] = [], State = unknown,
>(
  fn: (state: ValueExpr<State>, externals: ActionScope<Infer<B>, Fields[number]>) => unknown,
  options: { readonly payload: B; readonly event?: Fields },
): ActionDeclaration<Infer<B>>;
export function action<const Fields extends readonly string[], State = unknown>(
  fn: (state: ValueExpr<State>, externals: ActionScope<unknown, Fields[number]>) => unknown,
  options: { readonly event: Fields },
): ActionDeclaration<unknown>;

/** A transition object (§3.2), in the order the runtime applies it. */
export function transition(spec: {
  readonly state?: unknown;
  readonly patch?: readonly PatchOp[];
  readonly effects?: readonly EffectDeclaration[];
}): Transition;

/** One effect invocation (§5.1). Its props are a value in the ACTION's
 * own scope: one document, one capture. */
export function effect<const Run extends string>(
  run: Run, props?: unknown): EffectDeclaration<Run>;

/** `{ "op": "add", "path", "value" }` — sets a member, or REPLACES an
 * array when the path names one; `append()` is the array insert. */
export function add<State = unknown, Payload = unknown>(
  path: PatchPath<State, Payload>, value: unknown): PatchOp;
/** `{ "op": "add", "path": "<path>/-", "value" }` — RFC 6902's array append. */
export function append<State = unknown, Payload = unknown>(
  path: PatchPath<State, Payload>, value: unknown): PatchOp;
/** `{ "op": "replace", "path", "value" }` — and the op an array ELEMENT needs. */
export function replace<State = unknown, Payload = unknown>(
  path: PatchPath<State, Payload>, value: unknown): PatchOp;
/** `{ "op": "remove", "path" }`. */
export function remove<State = unknown, Payload = unknown>(
  path: PatchPath<State, Payload>): PatchOp;
/** `{ "op": "move", "from", "path" }`. */
export function move<State = unknown, Payload = unknown>(
  from: PatchPath<State, Payload>, path: PatchPath<State, Payload>): PatchOp;
/** `{ "op": "copy", "from", "path" }`. */
export function copy<State = unknown, Payload = unknown>(
  from: PatchPath<State, Payload>, path: PatchPath<State, Payload>): PatchOp;
/** `{ "op": "test", "path", "value" }` — a failing test aborts the transition. */
export function test<State = unknown, Payload = unknown>(
  path: PatchPath<State, Payload>, value: unknown): PatchOp;

/**
 * One event binding (§4). Annotate the call with the declared action
 * names — `bind<Action>('todo/add')` — and a name the app does not
 * declare stops compiling.
 */
export function bind<Names extends string = string>(
  name: Names,
  options?: {
    readonly payload?: unknown;
    readonly event?: readonly string[];
    readonly preventDefault?: boolean;
    readonly stopPropagation?: boolean;
  },
): Binding<Names>;

/** One subscription entry (§5.3). `with` is verbatim data and never
 * restarts; `withQuery`/`key`/`for` are queries and make it dynamic. */
export function sub<const Run extends string, State = unknown, Item = unknown>(
  run: Run,
  options?: {
    readonly with?: Json;
    readonly when?: SubRule<State, Record<string, never>>;
    readonly withQuery?: SubRule<State, FanScope<Item>>;
    readonly key?: SubRule<State, FanScope<Item>>;
    readonly for?: SubRule<State, Record<string, never>>;
  },
): SubDeclaration<Run>;

/**
 * Write a `jaren-app` 0.1 document (§2) and the JSON Schema of its
 * state. The initial state comes from the state builder's `default()`s
 * unless `initial` names one; a required member that declares neither is
 * `JL0102`.
 */
export function defineApp<
  B extends AnyBuilder, const A extends Record<string, ActionDeclaration<any>> = {},
>(spec: {
  readonly state: B;
  readonly initial?: Infer<B>;
  readonly view: unknown;
  readonly actions?: A;
  readonly subs?: readonly SubDeclaration[];
}): AppResult<Infer<B>, keyof A & string>;
export function defineApp<
  B extends AnyBuilder, const A extends Record<string, ActionDeclaration<any>> = {},
>(spec: {
  readonly state?: Json;
  readonly schema: B;
  readonly view: unknown;
  readonly actions?: A;
  readonly subs?: readonly SubDeclaration[];
}): AppResult<Infer<B>, keyof A & string>;
export function defineApp<const A extends Record<string, ActionDeclaration<any>> = {}>(spec: {
  readonly state?: Json;
  readonly view: unknown;
  readonly actions?: A;
  readonly subs?: readonly SubDeclaration[];
}): AppResult<unknown, keyof A & string>;
