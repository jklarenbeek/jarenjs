/**
 * Hand-authored declarations for `@jarenjs/linq/flow` — the flow pen's
 * type contract, kept to the same line as `index.d.ts`: the common path
 * is precisely typed, the exotic path is honestly `unknown`, nothing is
 * ever a WRONG type.
 *
 * State ids, event names and node ids are LITERAL types read from the
 * declarations themselves, so `to('nope')` and `edge('nope', 'out')` do
 * not compile — before they are `JL0102`, and long before the engine's
 * `JF0006`/`JF0013`. A transition that never named its target does not
 * compile either: `on()` answers a builder that has no `__to` phantom
 * until `.to()` gives it one.
 *
 * The honest limits, both of them the same limit TypeScript has (a
 * function's type arguments are all-or-none, so a partially inferred
 * `defineFsm<Ctx>` cannot exist):
 *
 * - a guard's `s.context` is typed by ANNOTATION — `.when((s: Scope<Cart>)
 *   => …)` — because `on()` is evaluated before `defineFsm()` sees the
 *   `context` builder. What `defineFsm({ context })` types is the
 *   MACHINE (`ContextOf<typeof machine>`), which is what a host passing
 *   `step(state, event, { context })` needs. `s.payload` needs no
 *   annotation: `on(from, event, { payload })` declares it on the same
 *   call.
 * - a task name is checked against a registry by annotating the node
 *   map — `{ … } satisfies NodesFor<Tasks>` — and `typedTasks(dag,
 *   registry)` checks the other direction (one handler per declared
 *   task name), so the registry `compileDag` resolves and the document
 *   agree at compile time. The runtime check stays `JF0018`.
 *
 * Every claim here has a runtime twin in `test/linq/flow-pen.test.js`
 * and a compile-level pin in `test/consumer/linq-flow.ts`; PENS-FORMAT.md
 * §8 is the normative mapping table.
 */

import type { ExprBase, MemberExpr, StringExpr, UnknownExpr } from './index.js';
import type { BuilderLike, Infer, Json } from './schema.js';

// ——— the evaluation scopes ———

/**
 * FLOW-FORMAT §3's step scope, as a guard or an effect's `with` reads
 * it. `Ctx` and `Payload` are the honest top until they are annotated
 * (`Scope<Cart>`) or declared (`on(from, event, { payload })`).
 */
export interface Scope<Ctx = unknown, Payload = unknown> {
  /** The current state id — the transition's `from`. */
  readonly state: StringExpr;
  /** The event name being stepped. */
  readonly event: StringExpr;
  /** The caller's payload, or `null` when absent. */
  readonly payload: MemberExpr<Payload>;
  /** The host's extended data, or `null` when absent. */
  readonly context: MemberExpr<Ctx>;
}

/** What a captured member may answer: an expression, or plain JSON. */
export type Captured = unknown;

/** A query-valued member: a callback captured over its scope, or a
 * query document written by hand. The scope type is a TYPE PARAMETER
 * with an honest-top default, so annotating the callback's argument
 * (`(s: Scope<Cart>) => …`) is what types it — exactly as `body()`'s
 * value is typed in the JSLT pen. */
export type QueryMember<S> = ((scope: S) => Captured) | Json;

// ——— the fsm surface ———

/** One `{ run, with? }` effect descriptor (§2). The engine never runs
 * it: a fired transition RETURNS descriptors as data. */
export interface EffectDeclaration<Run extends string = string> {
  readonly run: Run;
  readonly with?: Json;
}

/** One state declaration (§2), carrying its id as a literal. */
export interface StateDeclaration<Id extends string = string> {
  readonly id: Id;
  readonly entry?: readonly EffectDeclaration[];
  readonly exit?: readonly EffectDeclaration[];
  readonly final?: boolean;
}

/** The ids a `states` member declares: a bare string is the format's
 * own shorthand for `{ id }`. */
export type StateIdOf<S> = S extends string ? S
  : S extends StateDeclaration<infer Id> ? Id : never;

/** A transition whose target is still open: `on()` answers one, and it
 * is NOT a transition until `.to()` names a state. */
export interface PendingTransition<From extends string, E extends string, P> {
  /** The guard (§3), captured over the step scope. A plain STRING is
   * `JL0102`: §3 makes a non-`$` literal vacuously true. */
  when<S extends Scope<any, any> = Scope<unknown, P>>(
    guard: (scope: S) => Captured): PendingTransition<From, E, P>;
  when(guard: Json): PendingTransition<From, E, P>;
  /** The state this transition enters. */
  to<To extends string>(state: To): Transition<From, To, E, P>;
}

/** A complete transition, carrying its ends and event as literals. */
export interface Transition<From extends string, To extends string, E extends string, P>
  extends PendingTransition<From, E, P> {
  readonly __from: From;
  readonly __to: To;
  /** The event this transition answers; `never` for a wildcard. */
  readonly __event: E;
  when<S extends Scope<any, any> = Scope<unknown, P>>(
    guard: (scope: S) => Captured): Transition<From, To, E, P>;
  when(guard: Json): Transition<From, To, E, P>;
  /** The transition's own effects, fired between exit and entry (§4). */
  effects(effects: readonly EffectDeclaration[]): Transition<From, To, E, P>;
}

/** Any complete transition. */
export type AnyTransition = Transition<string, string, string, any>;

/** The declared states of a transition list, and the events it names. */
export type TransitionFrom<T> = T extends Transition<infer F, any, any, any> ? F : never;
export type TransitionTo<T> = T extends Transition<any, infer To, any, any> ? To : never;
export type TransitionEvent<T> = T extends Transition<any, any, infer E, any> ? E : never;

/** A `jaren-fsm` 0.1 document as the pen writes it, carrying the
 * machine's states, events and context type as phantoms. */
export interface Fsm<
  States extends string = string, Events extends string = string, Ctx = unknown,
> {
  /** Phantoms: declared, never present at runtime. */
  readonly __states: States;
  readonly __events: Events;
  readonly __context: Ctx;
  readonly $fsm: '0.1';
  readonly initial: States | null;
  readonly states: readonly (States | StateDeclaration<States>)[];
  readonly transitions: readonly {
    readonly from: States; readonly event?: Events; readonly guard?: Json;
    readonly to: States; readonly effects?: readonly EffectDeclaration[];
  }[];
}

/** The state ids a machine declares. */
export type StatesOf<F> = F extends Fsm<infer S, any, any> ? S : never;
/** The named events a machine answers (wildcards excluded). */
export type EventsOf<F> = F extends Fsm<any, infer E, any> ? E : never;
/** The host data a machine's guards read — what `step(…, { context })` takes. */
export type ContextOf<F> = F extends Fsm<any, any, infer C> ? C : never;

/** One effect descriptor: the handler name, and the props it resolves.
 * The scope is the honest top until it is annotated (`(s: Scope<Cart,
 * Approval>) => …`): an `effect()` is written before the transition
 * that carries it exists. */
export function effect<
  const Run extends string, S extends Scope<any, any> = Scope<unknown, unknown>,
>(run: Run, props?: ((scope: S) => Captured) | Json): EffectDeclaration<Run>;

/** One state declaration; a bare string in `states` is the shorthand. */
export function state<const Id extends string>(
  id: Id,
  options?: {
    readonly entry?: readonly EffectDeclaration[];
    readonly exit?: readonly EffectDeclaration[];
    readonly final?: boolean;
  },
): StateDeclaration<Id>;

/** One transition, left open until `.to()` names its target. Document
 * order is the whole priority scheme (§4). */
export function on<const From extends string, const E extends string>(
  from: From, event: E): PendingTransition<From, E, unknown>;
/** A transition whose event declares its payload SCHEMA — a type only:
 * the format carries no payload schema and the pen emits nothing for it. */
export function on<const From extends string, const E extends string, B extends BuilderLike<any, any, any>>(
  from: From, event: E, options: { readonly payload: B }):
PendingTransition<From, E, Infer<B>>;
/** The wildcard: a transition answering any event (§2). */
export function on<const From extends string>(
  from: From, event?: null): PendingTransition<From, never, unknown>;

/** Write a `jaren-fsm` 0.1 document (§2). */
export function defineFsm<
  const St extends readonly (string | StateDeclaration<string>)[],
  const T extends readonly Transition<StateIdOf<St[number]>, StateIdOf<St[number]>, string, any>[],
  const B extends BuilderLike<any, any, any> | undefined = undefined,
>(spec: {
  /** A declared state id, or null when the document chooses none. */
  readonly initial: StateIdOf<St[number]> | null;
  readonly states: St;
  readonly transitions: T;
  /** The host data a guard reads (§3) — a TYPE only, never emitted. */
  readonly context?: B;
}): Fsm<
StateIdOf<St[number]>,
Extract<TransitionEvent<T[number]>, string>,
B extends BuilderLike<any, any, any> ? Infer<B> : unknown>;

// ——— the dag surface ———

/** The closed kind vocabulary §6 fixes. */
export type NodeKind = 'input' | 'output' | 'const' | 'query' | 'jslt' | 'task';

/** One node declaration, carrying its kind and — for a task — the
 * handler name it will need, as literals. */
export interface NodeDeclaration<K extends NodeKind = NodeKind, Run extends string = never> {
  readonly __kind: K;
  readonly __run: Run;
  /** Declare this node's value durable (§7.6). */
  checkpoint(): NodeDeclaration<K, Run>;
}

/** A node of any kind. */
export type AnyNode = NodeDeclaration<NodeKind, any>;

/** A node map whose task nodes name handlers a registry provides:
 * `{ … } satisfies NodesFor<Tasks>` makes `task('nope')` a compile error. */
export type NodesFor<Tasks> = Readonly<Record<string,
| NodeDeclaration<Exclude<NodeKind, 'task'>, never>
| NodeDeclaration<'task', Extract<keyof Tasks, string>>>>;

/** One edge (§6), carrying its two ends as literals. */
export interface EdgeDeclaration<From extends string = string, To extends string = string> {
  readonly __from: From;
  readonly __to: To;
}

/** A `jaren-dag` 0.1 document as the pen writes it, carrying its node
 * ids and the task names it declares as phantoms. */
export interface Dag<Ids extends string = string, Tasks extends string = never> {
  /** Phantoms: declared, never present at runtime. */
  readonly __nodes: Ids;
  readonly __tasks: Tasks;
  readonly $dag: '0.1';
  readonly nodes: { readonly [id: string]: { readonly kind: NodeKind } & Json };
  readonly edges: readonly {
    readonly from: Ids; readonly to: Ids; readonly port?: string; readonly select?: Json;
  }[];
}

/** The node ids a graph declares. */
export type NodesOf<D> = D extends Dag<infer Ids, any> ? Ids : never;
/** The handler names a graph's task nodes require. */
export type TasksOf<D> = D extends Dag<any, infer T> ? T : never;

/** A dag task handler (§7.2): `handler({ with, input }, signal)`. */
export type TaskHandler = (
  props: { with: unknown; input: unknown }, signal: AbortSignal) => unknown;

/** The `input` node: the run's input value; no inbound edge. */
export function input(): NodeDeclaration<'input'>;
/** The `output` node: its input scope IS the run's result. */
export function output(): NodeDeclaration<'output'>;
/** A `const` node: its literal value, delivered by reference. */
export function constant(value: Json): NodeDeclaration<'const'>;
/** A `query` node: a Jaren JSON Query over the node's input scope (§6.1). */
export function query<V extends ExprBase<unknown> = UnknownExpr>(
  document: ((value: V) => Captured) | Json): NodeDeclaration<'query'>;
/** A `jslt` node: a stylesheet over the node's input scope. */
export function jslt(document: Json | { readonly rules: readonly unknown[] }):
NodeDeclaration<'jslt'>;
/** A `task` node: a registered async handler, named here and resolved
 * by the registry `compileDag` is given (`JF0018` when it cannot). */
export function task<const Run extends string, V extends ExprBase<unknown> = UnknownExpr>(
  run: Run, props?: ((value: V) => Captured) | Json): NodeDeclaration<'task', Run>;

/** One edge (§6). `select` is applied to the source value before delivery. */
export function edge<
  const From extends string, const To extends string,
  V extends ExprBase<unknown> = UnknownExpr,
>(
  from: From, to: To,
  options?: { readonly port?: string; readonly select?: ((value: V) => Captured) | Json },
): EdgeDeclaration<From, To>;

/** Write a `jaren-dag` 0.1 document (§6). */
export function defineDag<
  const N extends Readonly<Record<string, AnyNode>>,
  const E extends readonly EdgeDeclaration<Extract<keyof N, string>, Extract<keyof N, string>>[],
>(spec: { readonly nodes: N; readonly edges: E }): Dag<
Extract<keyof N, string>,
N[keyof N] extends never ? never : Extract<
{ [K in keyof N]: N[K] extends NodeDeclaration<'task', infer R> ? R : never }[keyof N], string>>;

/** Bind a task registry to the graph it serves. Identity at runtime; a
 * missing or misspelled handler name is a type error. */
export function typedTasks<D extends Dag<any, any>, T extends { [K in TasksOf<D>]: TaskHandler }>(
  dag: D, tasks: T): T;
