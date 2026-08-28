# The Jaren flow pen (normative)

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119. The rules every pen keeps, the
shared refusal table and the index of the other pens are the binder,
[LINQ-FORMAT.md](LINQ-FORMAT.md).

## 1. What it writes

```js
import { defineFsm, state, on, effect } from '@jarenjs/linq/flow';
import { defineDag, input, constant, query, jslt, task, output, edge } from '@jarenjs/linq/flow';
```

writes the two `@jarenjs/flow` documents
([FLOW-FORMAT](../../flow/docs/FLOW-FORMAT.md)): a `jaren-fsm` 0.1
machine (§2) and a `jaren-dag` 0.1 dataflow (§6), each one document
`compileFsm`/`compileDag` — and, for a machine, `fsmToApp` — takes
unchanged.

Every query-valued member is a CALLBACK captured over the scope the
engine evaluates it in, never a path typed as a string: a guard and an
effect's `with` over §3's `{ state, event, payload, context }`, a
`query` node's document, a task's props and an edge's `select` over
§6.1's input scope. That is also why the one trap the format names
itself is refused here — a guard given as a plain STRING is `JL0102`,
because §3 makes a non-`$` literal vacuously TRUE so that a diagram's
display annotation can never change execution.

State ids, event names and node ids are literal types, so a transition
into an undeclared state and an edge on an undeclared node are compile
errors; at runtime they are `JL0102` naming the id, before the
compiler's `JF0004`/`JF0006`/`JF0013`. A machine written with string
states and no guards is also a valid `jaren-workflow` document — the
projection contract FLOW-FORMAT §1 calls the format's subset — so the
pen's machines and the mermaid projection's meet where the format says
they do.

The pen imports nothing of `@jarenjs/flow`: the compilers stay the only
judge of what the documents mean (a tree-shaking probe holds it).

## 2. The mapping table

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `defineFsm({ initial, states, transitions, context? })` | `{ $fsm: '0.1', initial, states, transitions }` | `Fsm<States, Events, Context>`; `StatesOf<>`, `EventsOf<>`, `ContextOf<>` read it | native; a member the pen does not know, a missing `initial` (pass `null`), a `context` that is not a builder `JL0101`; an undeclared state id `JL0102` |
| `state(id, { entry?, exit?, final? })` | `{ id, entry?, exit?, final? }`; a bare string in `states` stays §2's shorthand | `StateDeclaration<Id>` — `Id` is a literal | native; another member, a non-boolean `final`, a non-`effect()` entry `JL0101` |
| `on(from, event?, { payload? })` | one entry of `transitions`, `{ from, event?, guard?, to, effects? }` in §2's order; a wildcard writes no `event` | `Transition<From, To, Event, Payload>` — a wildcard names no event, so it adds nothing to `EventsOf<>` | native; a target never named, a non-string event `JL0101`; an undeclared `from`/`to` `JL0102` |
| `.when(fn)` / `.when(document)` | the transition's `guard` (§3) | the scope is `Scope<unknown, Payload>`; annotate for `context` | native; a plain STRING `JL0102` (§3's vacuous-guard rule) |
| `.effects([...])`, `state(…, { entry, exit })` | the effects lists §4 fires in exit → transition → entry order | `EffectDeclaration[]` | native |
| `effect(run, with?)` | `{ run, with? }` | `EffectDeclaration<Run>`; the scope is the honest top until annotated | native; an empty `run` `JL0101` |
| `defineDag({ nodes, edges })` | `{ $dag: '0.1', nodes, edges }` | `Dag<Ids, Tasks>`; `NodesOf<>`, `TasksOf<>` read it | native; a member the pen does not know, no node `JL0101`; an edge on an undeclared id `JL0102` |
| `input()` / `output()` | `{ kind: 'input' }` / `{ kind: 'output' }` | `NodeDeclaration<'input'>` / `<'output'>` | native |
| `constant(value)` | `{ kind: 'const', value }` | `NodeDeclaration<'const'>` | native; a value that is not JSON `JL0101` |
| `query(fn \| document)` | `{ kind: 'query', query }` | `NodeDeclaration<'query'>` | native; an external the scope does not bind `JL0104` |
| `jslt(stylesheet)` | `{ kind: 'jslt', stylesheet }` — the JSLT pen's document ([JSLT-PEN.md](JSLT-PEN.md)), or one by hand | `NodeDeclaration<'jslt'>` | native; a value that is not JSON `JL0101` |
| `task(run, with?)` | `{ kind: 'task', run, with? }` | `NodeDeclaration<'task', Run>` — `Run` is a literal | native; an empty `run` `JL0101` |
| `.checkpoint()` | `checkpoint: true`, written last (§7.6) | a new declaration; the one it came from is unchanged | native |
| `edge(from, to, { port?, select? })` | `{ from, to, port?, select? }` | `EdgeDeclaration<From, To>` | native; an empty `port`, another member `JL0101` |
| `typedTasks(graph, tasks)` | — (identity) | the registry `compileDag` resolves must carry one handler per declared task name | native; a missing or misspelled name does not compile |

What the pen does **not** judge, by design: duplicate state ids
(`JF0003`), a guard's or stylesheet's own operators (`JF0007`,
`JF0014`), the dag wiring rules (`JF0015`), acyclicity (`JF0016`), the
exactly-one-output rule (`JF0017`) and task-registry resolution
(`JF0018`). The pen EMITS those documents and the compilers refuse
them; a test builds each one through the pen and asserts the compiler's
code.

## 3. Worked examples

Every `js` fence exports exactly one document, and the `json` fence
that follows is what the pen emits — executed by
`test/linq/pen-docs.test.js`. FLOW-FORMAT §2's machine and §6's
dataflow are rebuilt the same way and held BYTE-equal to the doc's own
fences by `test/linq/flow-pen.test.js`.

A review machine: a declared payload, a captured guard, an entry effect
and a wildcard fallback listed last (document order is the whole
priority scheme, §4):

```js
import * as s from '@jarenjs/linq/schema';
import { defineFsm, effect, on, state } from '@jarenjs/linq/flow';

export const review = defineFsm({
  initial: 'draft',
  states: [
    'draft',
    'review',
    state('published', { entry: [effect('announce', (sc) => ({ by: sc.payload.by }))], final: true }),
  ],
  transitions: [
    on('draft', 'submit').to('review'),
    on('review', 'approve', { payload: s.object({ by: s.string(), fresh: s.boolean() }) })
      .when((sc) => sc.payload.fresh)
      .to('published'),
    on('review').to('draft'),
  ],
  context: s.object({ author: s.string() }),
});
```
```json
{
  "$fsm": "0.1",
  "initial": "draft",
  "states": [
    "draft",
    "review",
    { "id": "published", "entry": [{ "run": "announce", "with": { "by": "$.payload.by" } }], "final": true }
  ],
  "transitions": [
    { "from": "draft", "event": "submit", "to": "review" },
    { "from": "review", "event": "approve", "guard": "$.payload.fresh", "to": "published" },
    { "from": "review", "to": "draft" }
  ]
}
```

The `payload` and `context` builders are TYPES: the format carries no
schema for either, so the pen emits nothing for them and the document
above is the whole document.

A dataflow over four of the six node kinds, with a checkpointed task
and a selecting edge:

```js
import { defineDag, edge, input, jslt, output, query, task } from '@jarenjs/linq/flow';
import { rule, stylesheet } from '@jarenjs/linq/jslt';

export const digest = defineDag({
  nodes: {
    rows: input(),
    recent: query((v) => v.all()),
    lines: jslt(stylesheet([rule('$', (v) => ({ count: v.all().count() }))])),
    summary: task('llm', (v) => ({ prompt: v.get('count') })).checkpoint(),
    out: output(),
  },
  edges: [
    edge('rows', 'recent'),
    edge('recent', 'lines'),
    edge('lines', 'summary'),
    edge('summary', 'out', { select: (v) => v.get('text') }),
  ],
});
```
```json
{
  "$dag": "0.1",
  "nodes": {
    "rows": { "kind": "input" },
    "recent": { "kind": "query", "query": "$[*]" },
    "lines": {
      "kind": "jslt",
      "stylesheet": { "$jslt": "0.1", "rules": [{ "match": "$", "body": { "count": { "$count": "$[*]" } } }] }
    },
    "summary": { "kind": "task", "run": "llm", "with": { "prompt": "$['count']" }, "checkpoint": true },
    "out": { "kind": "output" }
  },
  "edges": [
    { "from": "rows", "to": "recent" },
    { "from": "recent", "to": "lines" },
    { "from": "lines", "to": "summary" },
    { "from": "summary", "to": "out", "select": "$['text']" }
  ]
}
```

## 4. Refusals

The flow pen raises these `LinqBuildError` codes and no others —
`test/linq/pen-docs.test.js` holds this list equal, in both directions,
to the codes `packages/linq/src/flow/` throws. The full condition each
code states across every pen is the binder's,
[LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3.

| Code | What this pen raises it for |
|---|---|
| `JL0101` | a value this pen cannot spell, or a name → value map it cannot read |
| `JL0102` | a construct the format cannot carry |
| `JL0104` | a pen-owned keyword written through `meta()`, or an external a captured rule did not declare |

The message names the fix, and `docPath` is the JSON pointer of the node
being assembled where the refusal has one.

## 5. The types

```ts
import { compileDag, compileFsm, fsmToApp } from '@jarenjs/flow';
import { defineDag, defineFsm, edge, input, on, output, task, typedTasks } from '@jarenjs/linq/flow';
import type { ContextOf, EventsOf, NodesFor, StatesOf, TasksOf } from '@jarenjs/linq/flow';

type State = StatesOf<typeof review>;      // 'draft' | 'review' | 'published'
type Event = EventsOf<typeof review>;      // 'submit' | 'approve'   (a wildcard names none)
type Ctx = ContextOf<typeof review>;       // { author: string }

const machine = compileFsm(review);
machine.step('review', 'approve', { payload: { by: 'ada', fresh: true }, context: { author: 'ada' } });
fsmToApp(review);                          // a machine of string states projects to app documents

type Names = TasksOf<typeof digest>;       // 'llm'
compileDag(digest, { tasks: typedTasks(digest, { llm: askTheModel }) });
```

The honest limits, both of them TypeScript's own (a function's type
arguments are all-or-none, so a partially inferred `defineFsm<Ctx>`
cannot exist):

- a guard's `s.payload` is typed by the event's own declaration —
  `on(from, event, { payload })` is the same call — but its `s.context`
  is typed by ANNOTATION, `.when((s: Scope<Cart>) => …)`, because
  `on()` is evaluated before `defineFsm()` sees the `context` builder.
  What `context` types is the MACHINE (`ContextOf<>`), which is what a
  host calling `step(state, event, { context })` needs. An `effect()`
  is the same: it is written before the transition that carries it
  exists, so its scope is the honest top until annotated.
- a task name is checked against the registry a host will pass by
  annotating the node map — `{ … } satisfies NodesFor<Tasks>` — and
  `typedTasks(graph, registry)` checks the other direction, one handler
  per declared task name. The runtime check stays `JF0018`.

A `query`/`select`/`with` callback's value is the honest top until it
is annotated (`query((v: Expr<Row[]>) => …)`), exactly as the JSLT
pen's body is.

## 6. What it cannot spell

Every construct the flow pen refuses as unspellable is `JL0102`. §2's
Status column names the ones that belong to a method of this pen, each
beside the spelling that works; the binder's shared table
([LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3) carries the condition in full.

## 7. Cost

`@jarenjs/linq/flow` builds to **19,032 bytes** as a minified,
tree-shaken ESM bundle — the figure `scripts/check-tree-shaking.js`
measures and `npm run test:tree-shaking` reports, published rounded
beside the other nine subpath prices in
[docs/CONSUMING.md](../../../docs/CONSUMING.md). It carries the capture and, of the schema pen, only `brand.js` — no chain module, no `@jarenjs/flow` byte and no other pen.
