// @jarenjs/linq/flow — the type half: state ids, event names and node ids
// are literal types read from the declarations, so a transition into an
// undeclared state and an edge on an undeclared node do not compile; a
// transition that never named its target does not compile either. A
// guard's payload is typed by the event's own declaration, its context by
// annotation (on() is evaluated before defineFsm() sees the context
// builder), and a task name against a registry by annotating the node map.
// The runtime twins live in test/linq/flow-pen.test.js.
import {
  constant, defineDag, defineFsm, edge, effect, input, jslt, on, output, query, state, task,
  typedTasks,
} from '@jarenjs/linq/flow';
import type {
  ContextOf, Dag, EventsOf, Fsm, NodesFor, NodesOf, Scope, StatesOf, TasksOf,
} from '@jarenjs/linq/flow';
import * as s from '@jarenjs/linq/schema';
import type { Infer } from '@jarenjs/linq/schema';

/** Identical types, in both directions — the strict check, not assignability. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

const Cart = s.object({ total: s.number(), currency: s.string() });
const Approval = s.object({ fresh: s.boolean(), by: s.string() });

// ——— the machine: states and events are literal unions ———
const review = defineFsm({
  initial: 'draft',
  states: ['draft', 'review', state('published', { final: true })],
  transitions: [
    on('draft', 'submit').to('review'),
    on('review', 'approve', { payload: Approval })
      .when((s2) => s2.payload.fresh)
      .to('published')
      .effects([effect('notify', (s2: Scope<unknown, Infer<typeof Approval>>) => ({ by: s2.payload.by }))]),
    on('review').to('draft'),
  ],
  context: Cart,
});

const states: Equals<StatesOf<typeof review>, 'draft' | 'review' | 'published'> = true;
const events: Equals<EventsOf<typeof review>, 'submit' | 'approve'> = true;
const context: Equals<ContextOf<typeof review>, { total: number; currency: string }> = true;
const asFsm: Fsm<'draft' | 'review' | 'published', 'submit' | 'approve', { total: number; currency: string }> = review;
void [states, events, context, asFsm];

// a wildcard names no event, so it adds nothing to the union
const wild = defineFsm({
  initial: null,
  states: ['a', 'b'],
  transitions: [on('a').to('b')],
});
const noEvents: Equals<EventsOf<typeof wild>, never> = true;
void noEvents;

// the payload is typed by the event's own declaration; the context by annotation
void on('review', 'approve', { payload: Approval }).when((sc) => sc.payload.by.upper()).to('review');
void on('review', 'approve').when((sc: Scope<{ total: number }>) => sc.context.total.gt(10)).to('review');

// @ts-expect-error — 'nope' is not a declared state (before JL0102, long before JF0006)
void defineFsm({ initial: 'draft', states: ['draft'], transitions: [on('draft', 'go').to('nope')] });
// @ts-expect-error — a transition that never named its target is not a transition
void defineFsm({ initial: 'draft', states: ['draft'], transitions: [on('draft', 'go')] });
// @ts-expect-error — the initial state must be declared too
void defineFsm({ initial: 'nope', states: ['draft'], transitions: [] });
// @ts-expect-error — a member the pen's surface does not know
void defineFsm({ initial: null, states: [], transitions: [], nope: 1 });

// ——— the graph: node ids are literal unions ———
const graph = defineDag({
  nodes: {
    rows: input(),
    threshold: constant(18),
    adults: query((v) => v.all()),
    named: jslt([{ match: '$', body: '$' }]),
    summary: task('llm', (v) => ({ prompt: v.get('instruction') })).checkpoint(),
    out: output(),
  },
  edges: [
    edge('rows', 'adults'),
    edge('adults', 'named'),
    edge('named', 'summary', { port: 'rows', select: (v) => v.all() }),
    edge('threshold', 'summary', { port: 'min' }),
    edge('summary', 'out'),
  ],
});

const nodes: Equals<NodesOf<typeof graph>, 'rows' | 'threshold' | 'adults' | 'named' | 'summary' | 'out'> = true;
const tasks: Equals<TasksOf<typeof graph>, 'llm'> = true;
const asDag: Dag<'rows' | 'threshold' | 'adults' | 'named' | 'summary' | 'out', 'llm'> = graph;
void [nodes, tasks, asDag];

// the registry and the document agree: one handler per declared task name
const registry = typedTasks(graph, { llm: async () => ({ text: 'ok' }) });
void registry.llm;
// @ts-expect-error — the graph declares 'llm', not 'other'
void typedTasks(graph, { other: async () => null });

// @ts-expect-error — 'nope' is not a declared node (before JL0102, long before JF0013)
void defineDag({ nodes: { i: input(), o: output() }, edges: [edge('nope', 'o')] });
// @ts-expect-error — an edge INTO a node nothing declares
void defineDag({ nodes: { i: input(), o: output() }, edges: [edge('i', 'nope')] });
// @ts-expect-error — a member the pen's surface does not know
void defineDag({ nodes: { i: input(), o: output() }, edges: [], nope: 1 });

// a task name outside the registry a host will pass: the node map is annotated
interface Registry { llm: (props: { with: unknown; input: unknown }, signal: AbortSignal) => unknown }
const knownNodes = {
  rows: input(),
  ask: task('llm'),
  out: output(),
} satisfies NodesFor<Registry>;
void defineDag({ nodes: knownNodes, edges: [edge('rows', 'ask'), edge('ask', 'out')] });
const strayNodes = {
  rows: input(),
  // @ts-expect-error — 'nope' is not a handler the registry provides
  ask: task('nope'),
  out: output(),
} satisfies NodesFor<Registry>;
void strayNodes;
