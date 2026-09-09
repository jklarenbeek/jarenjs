# @jarenjs/flow

Executable JSON workflows: flat FSMs, statecharts, DAGs, and a composition
compiler that combines long-lived control with concurrent work regions.
The **jaren-fsm 0.1 format**
is a finite state machine as one JSON value — declared states, an
initial state, and a document-ordered transition table whose guards and
effect props are [Jaren JSON Query](../json/docs/QUERY-FORMAT.md)
documents — compiled, once, into a **pure step function**. The
**jaren-dag format** is an acyclic dataflow whose nodes are the suite's
own engines — query documents, JSLT stylesheets, registered async
tasks — wired by edges that carry data and compiled into a
run-to-completion executor.

`compileStatechart` adds compound states, parallel regions, shallow/deep
history and explicit-time delayed transitions in jaren-fsm 0.2.
`compileWorkflow` lowers one composed document onto statechart control and
DAG work, with choices, bounded loops, nested flows, saved waits and
generation-fenced checkpoints. Existing 0.1 APIs keep their behavior.

It is the executable half of a round trip the suite already ships: a
`stateDiagram-v2` parsed by [`@jarenjs/mermaid`](../../components/mermaid)
projects (via a JSLT stylesheet) into exactly this shape, and this
engine runs it. The format is a strict superset of that projection
contract — every projected document compiles unchanged.

The grammar is published as JSON Schema in
[`schemas/jaren-fsm.schema.json`](schemas/jaren-fsm.schema.json) (with a
mechanically derived draft-07 twin for providers pinned to older
drafts) — hand it to a constrained decoder and a language model cannot
emit a machine with a structurally malformed guard. The
normative contract is [docs/FLOW-FORMAT.md](docs/FLOW-FORMAT.md). Zero
dependencies outside the suite; no `eval`, CSP-safe; the only runtime
dependencies are `@jarenjs/core` and `@jarenjs/json`.

## Composed workflows and statecharts

```js
import { compileWorkflow } from '@jarenjs/flow';

const workflow = compileWorkflow({
  $workflow: '0.2', revision: 'review/1', initial: 'prepare',
  states: {
    prepare: { work: { task: 'prepare', version: '1' }, then: 'review' },
    review: { on: [{ event: 'approve', to: 'done' }] },
    done: { final: true },
  },
}, { tasks: { prepare: { version: '1', run: ({ input }) => ({ ...input, ready: true }) } } });

const first = await workflow.run({ title: 'Draft' }, { runId: 'review-7' });
const done = await workflow.run({ title: 'Draft' }, {
  runId: 'review-7', snapshot: first.snapshot, event: { type: 'approve' },
});
// done.result = { title: 'Draft', ready: true }
```

Use `work: {dag: document}` for concurrent branches, `choose` for guarded
switches, `flow` for nested control, and `limit` to bound a loop. An optional
CAS store persists node values and control before advancing. The compiler
rejects a resume whose document, input or task identities changed.
[WORKFLOW-FORMAT.md](docs/WORKFLOW-FORMAT.md) defines lowering, scope,
idempotency keys, crash windows and the benchmark command that consumes it.

For statecharts directly, `compileStatechart(doc).start({now})` returns the
initial control snapshot and entry-effect descriptors. `step(state,event)`
handles an event; `advance(state,now)` processes deadlines supplied by the
host. Snapshots include active leaves, history and pending timers.
`createStatechartSession` provides synchronous save-before-advance sessions.
[STATECHART-FORMAT.md](docs/STATECHART-FORMAT.md) specifies the semantics.
Neither API silently upgrades a 0.1 FSM or its string snapshots.

Both formats publish canonical, draft-07 and derived authoring schemas.
`createGrammarAuthor` accepts `statechart` and `workflow` with their full
schema/compiler gates. The existing LINQ flow pen continues to author the
0.1 FSM and DAG documents; its DAG documents can be embedded as work regions.

## The format in one glance

```json
{
  "$fsm": "0.1",
  "initial": "idle",
  "states": [
    "idle",
    { "id": "loading", "entry": [{ "run": "fetch", "with": { "url": "$.context.url" } }] },
    { "id": "done", "final": true }
  ],
  "transitions": [
    { "from": "idle", "event": "start", "to": "loading" },
    { "from": "loading", "event": "ok", "guard": "$.payload.fresh", "to": "done" },
    { "from": "loading", "event": "fail", "to": "idle" }
  ]
}
```

Guards are asserted by effective boolean value against one scope —
`{ state, event, payload, context }` — and **effects are data**: a fired
transition returns resolved `{ run, with? }` descriptors (exit →
transition → entry); the engine never executes them. Which registry runs
them is the host's business, the same boundary discipline as
`@jarenjs/app` effects.

## Usage

```javascript
import { compileFsm, createFsmSession } from '@jarenjs/flow';

const fsm = compileFsm(doc);        // throws FlowCompileError (JF0xxx) on a bad document
fsm.initial;                        // 'idle'
fsm.states;                         // ['idle', 'loading', 'done'] (frozen)
fsm.events('loading');              // ['ok', 'fail'] (frozen)

// The pure core: state in, result out. Nothing is held, nothing runs.
const r = fsm.step('loading', 'ok', { payload: { fresh: true }, context: { url: '/api' } });
r; // { changed: true, state: 'done', effects: [], final: true, errors: [] }

// The thin mutable convenience over it:
const s = createFsmSession(fsm);    // starts at doc initial
s.can('start');                     // true — a dry run (step is pure, so can() IS step())
s.send('start');                    // advances; returns the same result shape
s.state;                            // 'loading'
s.done;                             // final-state flag
```

`step` is **total over machine input**: an event no transition answers
is ignored (`changed: false`, no effects) — the conventional FSM
reading. Only caller mistakes throw: an undeclared state id or a
non-string event (`FlowRuntimeError`, JF2001/JF2002).

## Fail closed, report precisely

A guard that throws at evaluation reads **false**; an effect whose
`with` throws is **omitted**. Neither aborts the step — each appends a
plain-data record `{ code, docPath, message }` to the result's `errors`
array, where `docPath` is a JSON Pointer to exactly the query that
failed (`/transitions/2/guard`). That is the suite's standard
machine-repairable error shape: a host surfaces the records through its
own error channel, and a repair loop knows precisely what to fix.

Compile-time failures throw `FlowCompileError` with the same `code` +
`docPath` discipline (JF0001–JF0009, table in
[FLOW-FORMAT.md §5](docs/FLOW-FORMAT.md)); a guard that cannot compile
is a compile error, never a runtime surprise.

## Hosting a machine in @jarenjs/app

`fsmToApp` turns the same document into **generated standard app
documents** — a state slice plus one plain-JSON action per named event,
compiled by the app like any hand-written action, with no flow code at
runtime:

```javascript
import { fsmToApp, fsmStateSchema } from '@jarenjs/flow';
import { createApp } from '@jarenjs/app';

const { slice, actions, events } = fsmToApp(doc);   // { pointer: '/fsm', namespace: 'fsm/' }
const app = createApp({
  state: { fsm: slice },
  view,
  actions: { ...actions, ...hostActions },
}, { node, effects, validateState });               // fsmStateSchema(doc) guards the slice
```

Control state lives at `<pointer>/current`; the host's app state **is**
the machine's `context`; guards and effect props evaluate
pre-transition in both worlds, and target states are baked as literals.
Selection semantics are provably the headless engine's — the test
suite drives both through the same scripts and asserts state and
effects agree. The convention, the scope mapping table, multi-machine
layout and the honestly-stated divergences (a throwing guard fails the
hosted transaction instead of reading false) live in
[docs/APP-INTEGRATION.md](docs/APP-INTEGRATION.md).

## The dataflow half — jaren-dag

"Connect different parts together" as one schema-validated JSON value:
nodes from a closed vocabulary (`input`, `output`, `const`, `query`,
`jslt`, `task`) wired by edges, run to completion for one input. The
suite's engines compose as **data** — a query filters, a stylesheet
projects, and the result can be a vnode tree without this package ever
importing a rendering line:

```javascript
import { compileDag } from '@jarenjs/flow';

const dag = compileDag({
  $dag: '0.1',
  nodes: {
    rows:   { kind: 'input' },
    adults: { kind: 'query',
      query: [{ $for: { r: '$[*]' }, $where: { $ge: ['$r.age', 18] }, $return: '$r' }] },
    view:   { kind: 'jslt',
      stylesheet: [{ match: '$', body: ['ul', {},
        [{ $for: { p: '$[*]' }, $return: ['li', {}, '$p.name'] }]] }] },
    out:    { kind: 'output' },
  },
  edges: [
    { from: 'rows', to: 'adults' },
    { from: 'adults', to: 'view' },
    { from: 'view', to: 'out' },
  ],
}, { tasks: {} });

await dag.run(people);   // ['ul', {}, [['li', {}, 'ada'], …]] — a vnode, as JSON
```

The query's outer array keeps `adults` an array for zero, one or many
rows. Without it, the engine's one-result sequence becomes that row;
the next node's `$[*]` would iterate its members instead of rows.

Cycles, port rules and the exactly-one-output rule are **compile-time**
rejections (JF0xxx with `docPath`); a `task` node's handler is resolved
at compile too, and called as `handler({ with, input }, signal)` with
the run's shared `AbortSignal`. Independent branches run concurrently,
but determinism is *same input → same output values* — results are
keyed and port objects assemble in edge document order, so completion
timing can never change a value. Failure is fail-closed: the first
failing node aborts the shared signal and rejects the whole run
(`JF2006` with `nodeId`, `docPath`, `cause`; a caller abort is
`JF2007`) — no retries, no partial results. Per-node observability is
the `onNode` record stream (`{ id, status, ms }`), and a compiled dag
hosts in an app as **one effect** through `createTaskEffect` — the
recipe is in [docs/APP-INTEGRATION.md](docs/APP-INTEGRATION.md), the
contract in [docs/FLOW-FORMAT.md](docs/FLOW-FORMAT.md) §6–§7.

## One scope, one honest quirk

`$.state`, `$.event`, `$.payload`, `$.context` — control state lives in
the machine, data state lives in the host, passed per call. A guard
written as a plain string that does not start with `$` is a *literal*
(query semantics), and a non-empty literal is EBV-**true**: a display
guard carried over from a diagram label (`count > 3`) is vacuously true
by design, because a picture's annotation must not change execution.
Real conditions are `$`-paths (`"$.payload.fresh"`) or operator
documents (`{ "$gt": ["$.context.count", 3] }`).

## Performance (measured)

`npm run benchmark:flow` (run it yourself — the FSM head-to-head needs
the `xstate` benchmark devDependency, and the memory row needs
`node --expose-gc`, which the script passes). The same logical machine is
built with `@jarenjs/flow` and XState v5 and asserted to agree before
timing:

- **Transitions** — the pure `step` runs several times faster than an
  XState actor's `send` (≈<!--fact:flow.fsmBand-->5.6–8.1<!--/fact-->× across 5/50/500-state machines); the
  `createFsmSession` wrapper is on the page too.
- **Compile** — `compileFsm` beats `createMachine` + `createActor`
  ≈1.5–2.6×. Not like-for-like: XState builds a scheduling actor, so the
  row is each engine's description→drivable cost.
- **The wedge** — a conformance fact, not a timing: a jaren-fsm document
  is JSON *including its guards*, so it survives `JSON.stringify` →
  `JSON.parse` and still compiles and still fires its guard. XState's
  guards are functions JSON drops, so the round-tripped machine throws
  "Guard not implemented" at the guarded transition. Serialize, store,
  diff, ship, replay — that is the whole reason to speak JSON all the way
  down.
- **Where we lose** — a compiled Jaren machine holds **more** memory than
  the XState actor (every guard compiles to its own query closure); the
  benchmark publishes the KiB-per-machine loss beside the wins.
- **The dag tax** — no npm library executes schema-validated JSON
  dataflow, so the honest rival is the same pipeline hand-written in
  JavaScript. A `compileDag` run costs ~8–20× the hand-written baseline —
  the published price of dataflow as one serializable,
  constrained-decodable JSON value, sitting beside what it buys.

The full tables, the wedge as a conformance row, and the fairness notes
are on the [benchmarks page](https://jklarenbeek.github.io/jarenjs/#/benchmarks?suite=flow).

## Authoring with a model

A jaren-fsm or jaren-dag document is JSON published as a schema, so a
constrained decoder can author one — and because every compile error
carries a `code` and a `docPath`, a schema-valid but semantically broken
machine (a transition to an undeclared state, say) repairs in a bounded
loop rather than flailing. `@jarenjs/ai`'s
[*Authoring engine documents*](../ai/README.md#authoring-engine-documents-validate-and-compile)
section shows the `composeChecks(schema, compileGate)` recipe, and
[*A model as a dataflow node*](../ai/README.md#a-model-as-a-dataflow-node)
runs a model as an ordinary dag `task`. Neither package imports the
other — the composition is data.

## Authoring by code

The same documents have a by-code twin. `@jarenjs/linq/flow` is the
suite's pen for both formats: state ids, event names and node ids are
literal types, so a transition into an undeclared state or an edge from
an undeclared node is a compile error, and guards, effect props, node
queries and edge selectors are callbacks captured over the scope the
engine evaluates them in — never a path typed as a string.

```javascript
import { defineFsm, on, state, effect } from '@jarenjs/linq/flow';

const doc = defineFsm({
  initial: 'idle',
  states: [
    'idle',
    state('loading', { entry: [effect('fetch', (s) => ({ url: s.context.url }))] }),
    state('done', { final: true }),
  ],
  transitions: [
    on('idle', 'start').to('loading'),
    on('loading', 'ok').when((s) => s.payload.fresh).to('done'),
    on('loading', 'fail').to('idle'),
  ],
});                                // the document at the top of this README, byte for byte

compileFsm(doc).step('idle', 'start', { context: { url: '/rows' } });
```

A model-authored document and a pen-written one go through the SAME
gate — `compileFsm`/`compileDag`. The mapping table, and where the pen's
refusals end and the compiler's begin, are
[FLOW-PEN.md](../linq/docs/FLOW-PEN.md).

## Exports

Every subpath a consumer can import, derived from the manifest by
`npm run docs:derive` (`npm run docs:check` fails when the two drift):

<!--fact:exports.flow-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/flow` | JavaScript | declared |
| `@jarenjs/flow/schemas/jaren-dag.authoring.schema.json` | schema | — |
| `@jarenjs/flow/schemas/jaren-dag.draft-07.schema.json` | schema | — |
| `@jarenjs/flow/schemas/jaren-dag.schema.json` | schema | — |
| `@jarenjs/flow/schemas/jaren-fsm.authoring.schema.json` | schema | — |
| `@jarenjs/flow/schemas/jaren-fsm.draft-07.schema.json` | schema | — |
| `@jarenjs/flow/schemas/jaren-fsm.schema.json` | schema | — |
| `@jarenjs/flow/schemas/jaren-statechart-state.draft-07.schema.json` | schema | — |
| `@jarenjs/flow/schemas/jaren-statechart-state.schema.json` | schema | — |
| `@jarenjs/flow/schemas/jaren-statechart.authoring.schema.json` | schema | — |
| `@jarenjs/flow/schemas/jaren-statechart.draft-07.schema.json` | schema | — |
| `@jarenjs/flow/schemas/jaren-statechart.schema.json` | schema | — |
| `@jarenjs/flow/schemas/jaren-workflow.authoring.schema.json` | schema | — |
| `@jarenjs/flow/schemas/jaren-workflow.draft-07.schema.json` | schema | — |
| `@jarenjs/flow/schemas/jaren-workflow.schema.json` | schema | — |
| `@jarenjs/flow/package.json` | metadata | — |
<!--/fact-->

## Development

Unit tests live in `test/flow/` at the repository root
(`npm run test:flow`). See the repository [README](../../README.md) for
the full suite documentation.
