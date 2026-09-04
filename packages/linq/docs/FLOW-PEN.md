# The Jaren flow pen

> `./flow` — `jaren-fsm` 0.1 machines and `jaren-dag` 0.1 dataflows,
> every query-valued member captured. **Read it when** you are declaring
> a state machine or a dependency graph of tasks

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119. This document is a **guide** — read
it in order and you can write the format — whose one normative section is
[§2 The mapping table](#2-the-mapping-table); the rules every pen keeps, the shared refusal table, the
index of the other pens and every pen's mapping table collected in one
place are the normative reference,
[LINQ-FORMAT.md](LINQ-FORMAT.md).

## 1. What it writes

You have a process to describe — a document that moves between states as
events arrive, or a pipeline that takes one value and hands it through
named steps — and you want it as data, so a diagram, a runner and a test
can all read the same thing. Writing that data by hand means typing state
ids into a transition table and JSONPath strings into guards, with
nothing checking that either exists. This pen makes both a function call:
the ids are literal types, and every query-valued member is a callback it
records.

**This subpath writes two different documents, compiled by two different
engines.** `defineFsm()` writes a `jaren-fsm` 0.1 machine — control
states and a transition table — and `defineDag()` writes a `jaren-dag`
0.1 dataflow — named nodes wired by edges. They share a package, a
subpath and a capture, and nothing else: a reader who thinks the two
functions write the same document will misread everything after this
paragraph.

```js
import { defineFsm, state, on, effect } from '@jarenjs/linq/flow';
import { defineDag, input, constant, query, jslt, task, output, edge, typedTasks } from '@jarenjs/linq/flow';
```

| | the machine | the dataflow |
|---|---|---|
| document | `{ $fsm: '0.1', initial, states, transitions }` | `{ $dag: '0.1', nodes, edges }` |
| grammar | `jaren-fsm` (`packages/flow/schemas/jaren-fsm.schema.json`) | `jaren-dag` (`packages/flow/schemas/jaren-dag.schema.json`) |
| format | [FLOW-FORMAT](../../flow/docs/FLOW-FORMAT.md) §2 | FLOW-FORMAT §6 |
| engine | `compileFsm` — and `fsmToApp`, which projects a machine into app documents | `compileDag` |
| shape of the work | synchronous, pure: `(state, event, options)` → a result and effect DESCRIPTORS the host runs | asynchronous: one input in, one value out, tasks resolved from a registry |
| the pen's vocabulary | `defineFsm`, `state`, `on` (`.when`, `.to`, `.effects`), `effect` | `defineDag`, `input`, `output`, `constant`, `query`, `jslt`, `task` (`.checkpoint`), `edge`, `typedTasks` |

Every query-valued member of either document is a CALLBACK captured over
the scope the engine evaluates it in, never a path typed as a string: a
guard and an effect's `with` over FLOW-FORMAT §3's step scope, a `query`
node's document, a task's `with` and an edge's `select` over §6.1's input
scope. That is also why the one trap the format names itself is refused
here — a guard given as a plain STRING is `JL0102`, because §3 makes a
non-`$` literal vacuously TRUE so that a diagram's display annotation can
never change execution (§4.2).

State ids, event names and node ids are literal types, so a transition
into an undeclared state and an edge on an undeclared node are compile
errors; at runtime they are `JL0102` naming the id, before the compiler's
`JF0004`/`JF0006`/`JF0013`. A machine written with string states and no
guards is also a valid `jaren-workflow` document — the projection
contract FLOW-FORMAT §1 calls the format's subset — so the pen's machines
and the mermaid projection's meet where the format says they do (§6.4).

The pen imports nothing of `@jarenjs/flow`: the compilers stay the only
judge of what the documents mean, and §7's tree-shaking probe holds it.

**The running example.** §3 is one editorial workflow, told twice because
the subpath writes two documents. The machine half (§3.1–§3.3) is an
article moving from draft to published: the transition table, then the
same table with effects, then the guard that reads a score against a
threshold. The dataflow half (§3.4–§3.7) is the pipeline around it: draft
and critique, filter the submissions that are long enough, render the
accepted ones as a view, and answer a question about them through a task
registry. §5 reads the types back off the same two documents.

## 2. The mapping table

Thirteen exported names and sixteen rows: the four builder methods
(`.when`, `.to`, `.effects`, `.checkpoint`) earn rows of their own, and
`input()` and `output()` share one because they differ in nothing but the
word they write. The completeness gate in `test/linq/pen-docs.test.js`
asserts that every exported callable name appears somewhere in this
section.

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `defineFsm({ initial, states, transitions, context? })` | `{ $fsm: '0.1', initial, states, transitions }` | `Fsm<States, Events, Context>`; `StatesOf<>`, `EventsOf<>`, `ContextOf<>` read it | native; a member the pen does not know, a missing `initial` (pass `null`), a non-array `states`/`transitions`, an entry that is not a declaration, a transition that never named its target, a `context` that is not a builder `JL0101`; an undeclared state id `JL0102` |
| `state(id, { entry?, exit?, final? })` | `{ id, entry?, exit?, final? }`; a bare string in `states` stays §2's shorthand | `StateDeclaration<Id>` — `Id` is a literal | native; an empty id, another member, a non-boolean `final`, a non-array or non-`effect()` entry/exit `JL0101` |
| `on(from, event?, { payload? })` | one entry of `transitions`, `{ from, event?, guard?, to, effects? }` in §2's order; a wildcard writes no `event` | `Transition<From, To, Event, Payload>` — a wildcard names no event, so it adds nothing to `EventsOf<>` | native; an empty `from`, a non-string event, another option, a `payload` that is not a builder `JL0101`; an undeclared `from`/`to` `JL0102` |
| `.when(fn)` / `.when(document)` | the transition's `guard` (§3) | the scope is `Scope<unknown, Payload>`; annotate for `context` | native; a plain STRING `JL0102` (§3's vacuous-guard rule); a non-JSON document `JL0101`; any external `JL0104` |
| `.to(state)` | the transition's `to` | `Transition<From, To, …>` — `To` is a literal | native; an empty id `JL0101`; an undeclared id `JL0102` at `defineFsm()` |
| `.effects([...])`, `state(…, { entry, exit })` | the effects lists §4 fires in exit → transition → entry order | `EffectDeclaration[]` | native; a non-array, or an entry that is not `effect()`, `JL0101` |
| `effect(run, with?)` | `{ run, with? }` | `EffectDeclaration<Run>`; the scope is the honest top until annotated | native; an empty `run`, a non-JSON `with` `JL0101`; any external `JL0104` |
| `defineDag({ nodes, edges })` | `{ $dag: '0.1', nodes, edges }` | `Dag<Ids, Tasks>`; `NodesOf<>`, `TasksOf<>` read it | native; a member the pen does not know, no node, a `nodes` map whose prototype a `__proto__:` literal replaced, a value that is not a node or edge declaration `JL0101`; an edge on an undeclared id `JL0102` |
| `input()` / `output()` | `{ kind: 'input' }` / `{ kind: 'output' }` | `NodeDeclaration<'input'>` / `<'output'>` | native |
| `constant(value)` | `{ kind: 'const', value }` | `NodeDeclaration<'const'>` | native; `undefined`, or a value that is not JSON, `JL0101` |
| `query(fn \| document)` | `{ kind: 'query', query }` | `NodeDeclaration<'query'>` | native; nothing passed, or a document that is not JSON, `JL0101`; any external `JL0104` |
| `jslt(stylesheet)` | `{ kind: 'jslt', stylesheet }` — the JSLT pen's document ([JSLT-PEN.md](JSLT-PEN.md)), or one by hand | `NodeDeclaration<'jslt'>` | native; nothing passed, or a value that is not JSON, `JL0101` |
| `task(run, with?)` | `{ kind: 'task', run, with? }` | `NodeDeclaration<'task', Run>` — `Run` is a literal | native; an empty `run` `JL0101`; any external in `with` `JL0104` |
| `.checkpoint()` | `checkpoint: true`, written last (§7.6) | a new declaration; the one it came from is unchanged | native |
| `edge(from, to, { port?, select? })` | `{ from, to, port?, select? }` | `EdgeDeclaration<From, To>` | native; an empty end, an empty `port`, another member `JL0101`; any external in `select` `JL0104` |
| `typedTasks(graph, tasks)` | — (identity) | the registry `compileDag` resolves must carry one handler per declared task name | native; a missing or misspelled name does not compile |

Three rules the table implies, spelled out:

- **The node kinds are a closed vocabulary and the pen mirrors it
  exactly.** FLOW-FORMAT §6 fixes six kinds, and this pen has one
  function per kind — so a kind the format does not have cannot be
  spelled, and a kind it adds later needs a pen function before it can
  be. `defineDag` refuses anything in `nodes` that is not one of the six
  (`JL0101` naming all six), which is why a hand-written
  `{ kind: 'input' }` is refused where the equivalent `input()` is taken.
- **`payload` and `context` are TYPES; nothing is emitted for them.** The
  format carries no schema for either — a machine's data lives in the
  host (§3) — so `on(from, event, { payload })` and
  `defineFsm({ context })` type the guards and the host's `step()` call
  and write no member. The refusal for a non-builder says so in as many
  words.
- **What the pen does NOT judge is the compiler's.** Duplicate state ids
  (`JF0003`), a guard's or stylesheet's own operators (`JF0007`,
  `JF0014`), the dag wiring rules (`JF0015`), acyclicity (`JF0016`), the
  exactly-one-output rule (`JF0017`) and task-registry resolution
  (`JF0018`). The pen EMITS those documents and the compilers refuse
  them; `test/linq/flow-pen.test.js` builds each one through the pen and
  asserts the compiler's code, so the non-judgement is itself gated.

## 3. Worked examples

Every `js` fence below exports exactly one document, and the `json` fence
that follows it is what the pen emits — executed by
`test/linq/pen-docs.test.js`. FLOW-FORMAT §2's machine and §6's dataflow
are additionally rebuilt through the pen and held BYTE-equal to the
format doc's own fences by `test/linq/flow-pen.test.js`, and every
document below validates under its published grammar.

### 3.1 A machine with a guard

Three states, three transitions, one guard, and a wildcard listed last —
document order is the whole priority scheme (§4), so a fallback goes at
the bottom and nothing else is needed to express precedence.

```js
import * as s from '@jarenjs/linq/schema';
import { defineFsm, on, state } from '@jarenjs/linq/flow';

export const review = defineFsm({
  initial: 'draft',
  states: ['draft', 'review', state('published', { final: true })],
  transitions: [
    on('draft', 'submit').to('review'),
    on('review', 'approve', { payload: s.object({ fresh: s.boolean(), by: s.string() }) })
      .when((sc) => sc.payload.fresh)
      .to('published'),
    on('review').to('draft'),
  ],
});
```

```json
{
  "$fsm": "0.1",
  "initial": "draft",
  "states": ["draft", "review", { "id": "published", "final": true }],
  "transitions": [
    { "from": "draft", "event": "submit", "to": "review" },
    { "from": "review", "event": "approve", "guard": "$.payload.fresh", "to": "published" },
    { "from": "review", "to": "draft" }
  ]
}
```

Three things to read off it. A bare string in `states` stays a bare
string — the format's own shorthand for `{ id }`, and the shape the
`jaren-workflow` projection carries — while `state(id, options)` writes
the object form. The wildcard writes NO `event` member, which is what
makes it match anything. And the `payload` builder emitted nothing: it
typed `sc.payload` inside the guard and left the document alone.

The guard `"$.payload.fresh"` is a path, and a path is what a captured
member read records. Send `approve` with `{ fresh: false }` and this
machine does not stay put — the guard fails, the wildcard below it
matches, and the step lands on `draft`. That is §4's selection rule
working exactly as written, and it is the reason a fallback's POSITION is
part of the design.

### 3.2 The same machine with effects, and an effect's `with`

An effect is a `{ run, with? }` descriptor. The engine never invokes it:
a fired transition RETURNS descriptors as data and the host's registry
runs them, which is the boundary that keeps the machine pure.

```js
import * as s from '@jarenjs/linq/schema';
import { defineFsm, effect, on, state } from '@jarenjs/linq/flow';

export const reviewed = defineFsm({
  initial: 'draft',
  states: [
    'draft',
    'review',
    state('published', { entry: [effect('announce', (sc) => ({ by: sc.payload.by, from: sc.state }))], final: true }),
  ],
  transitions: [
    on('draft', 'submit').to('review'),
    on('review', 'approve', { payload: s.object({ fresh: s.boolean(), by: s.string() }) })
      .when((sc) => sc.payload.fresh)
      .to('published'),
    on('review').to('draft').effects([effect('toast', () => ({ text: 'sent back' }))]),
  ],
});
```

```json
{
  "$fsm": "0.1",
  "initial": "draft",
  "states": [
    "draft",
    "review",
    { "id": "published",
      "entry": [{ "run": "announce", "with": { "by": "$.payload.by", "from": "$.state" } }],
      "final": true }
  ],
  "transitions": [
    { "from": "draft", "event": "submit", "to": "review" },
    { "from": "review", "event": "approve", "guard": "$.payload.fresh", "to": "published" },
    { "from": "review", "to": "draft",
      "effects": [{ "run": "toast", "with": { "text": "sent back" } }] }
  ]
}
```

The two `with` members are the same capture in two spellings. `announce`
reads the step scope, so its members record paths (`$.payload.by`,
`$.state`); `toast` returns a literal, so its `with` is an object
CONSTRUCTOR — `{ "text": "sent back" }`, not `{ "$const": … }` — for the
reason [JSLT-PEN.md](JSLT-PEN.md) §1.1 point 4 gives, and because it is
the spelling FLOW-FORMAT §2's own example carries.

Stepping `approve` with `{ fresh: true, by: 'ada' }` from `review`
answers
`{ changed: true, state: 'published', effects: [{ run: 'announce', with: { by: 'ada', from: 'review' } }], final: true, errors: [] }`.
The `with` resolved against the scope; the handler named `announce` is
the host's to provide. The engine has NO code for an unregistered effect
handler and could not have one — FLOW-FORMAT §1.1 makes effect execution
a non-goal, so `compileFsm` never looks a name up and never calls
anything. A `run` nobody registered is a descriptor the host quietly
drops, which is worth knowing because it is one of the few mistakes in
this pen's surface that nothing on either side reports.

### 3.3 A guard over the whole step scope

The case that motivates the capture. A guard comparing two members of the
scope, and reading the event name besides, is an operator document — not
a path — and there is no string a writer could type that means it.

```js
import * as s from '@jarenjs/linq/schema';
import { defineFsm, on } from '@jarenjs/linq/flow';

export const scored = defineFsm({
  initial: 'review',
  states: ['review', 'published'],
  transitions: [
    on('review', 'approve', { payload: s.object({ score: s.number() }) })
      .when((sc) => sc.context.threshold.le(sc.payload.score).and(sc.event.eq('approve')))
      .to('published'),
  ],
  context: s.object({ threshold: s.number() }),
});
```

```json
{
  "$fsm": "0.1",
  "initial": "review",
  "states": ["review", "published"],
  "transitions": [
    { "from": "review", "event": "approve",
      "guard": { "$and": [ { "$le": ["$.context.threshold", "$.payload.score"] },
                           { "$eq": ["$.event", "approve"] } ] },
      "to": "published" }
  ]
}
```

`compileFsm(scored).step('review', 'approve', { payload: { score: 8 }, context: { threshold: 5 } })`
fires; the same call with `{ score: 3 }` reports
`{ changed: false, state: 'review', … }` — an unhandled step, not an
error (§4).

This is what §4.2's refusal is protecting. A writer who wants this
condition and reaches for a string gets a guard that is EBV-true for
every step, forever, silently. The pen refuses the string; the callback
is the route.

**A TypeScript caller writes one more thing here.** `sc.payload` is typed
by the event's own declaration on the same call, but `sc.context` is not:
`on()` is evaluated before `defineFsm()` ever sees the `context` builder,
so the scope's context is the honest top and `sc.context.threshold` does
not compile. The annotation is where the type comes from —

```ts
on('review', 'approve', { payload: Score })
  .when((sc: Scope<{ threshold: number }, { score: number }>) =>
    sc.context.threshold.le(sc.payload.score))
  .to('published')
```

— and §5.1 says why it cannot be inferred. The emitted document is
identical either way; the annotation buys the compiler, not the
document.

### 3.4 A dataflow: input, two tasks, output

Two `task` nodes chained, the second checkpointed, and a `select` on the
delivering edge. `run` is a NAME the pen writes and never resolves — the
registry a host hands `compileDag` owns the handler.

```js
import { defineDag, edge, input, output, task } from '@jarenjs/linq/flow';

export const writing = defineDag({
  nodes: {
    brief: input(),
    draft: task('llm', (v) => ({ prompt: v.topic })),
    review: task('critic', (v) => ({ text: v })).checkpoint(),
    out: output(),
  },
  edges: [
    edge('brief', 'draft'),
    edge('draft', 'review'),
    edge('review', 'out', { select: (v) => v.get('verdict') }),
  ],
});
```

```json
{
  "$dag": "0.1",
  "nodes": {
    "brief": { "kind": "input" },
    "draft": { "kind": "task", "run": "llm", "with": { "prompt": "$.topic" } },
    "review": { "kind": "task", "run": "critic", "with": { "text": "$" }, "checkpoint": true },
    "out": { "kind": "output" }
  },
  "edges": [
    { "from": "brief", "to": "draft" },
    { "from": "draft", "to": "review" },
    { "from": "review", "to": "out", "select": "$['verdict']" }
  ]
}
```

`review`'s `with` is `{ "text": "$" }`: the callback returned the scope
value itself, and the scope value of a node with one unported inbound
edge IS the delivered value, verbatim (§6.1). `checkpoint: true` is
written last whatever order `.checkpoint()` was called in, and it is
opt-in per node — with a checkpoint store configured, only `review`'s
value is recorded, and a resumed run seeds it instead of calling the
handler again (§7.6).

`v.get('verdict')` in the `select` records `"$['verdict']"` rather than
`"$.verdict"`. Both are the same path; `get()` always writes the bracket
form because it takes an arbitrary string. Reach for it when a member
name is not an identifier, or when it collides with a chain method — a
member called `count` read as `v.count` answers the method, not the
member.

### 3.5 A `query` node, and the rule that changes its shape

A `query` node runs a Jaren JSON Query over its input scope. This example
takes a query DOCUMENT rather than a callback, because FLOW-FORMAT §6's
own example does and because a FLWOR phrase naming its binding `r` is not
something the chain emits (it packs and names its binding `it`).

```js
import { defineDag, edge, input, output, query } from '@jarenjs/linq/flow';

export const longEnough = defineDag({
  nodes: {
    subs: input(),
    long: query({ $for: { r: '$[*]' }, $where: { $ge: ['$r.words', 500] }, $return: '$r' }),
    out: output(),
  },
  edges: [edge('subs', 'long'), edge('long', 'out')],
});
```

```json
{
  "$dag": "0.1",
  "nodes": {
    "subs": { "kind": "input" },
    "long": { "kind": "query",
      "query": { "$for": { "r": "$[*]" }, "$where": { "$ge": ["$r.words", 500] }, "$return": "$r" } },
    "out": { "kind": "output" }
  },
  "edges": [
    { "from": "subs", "to": "long" },
    { "from": "long", "to": "out" }
  ]
}
```

**A node's result carries the query engine's singleton rule, and the
result shape changes with the data.** `compileDag` calls a compiled query
through its default entry point, and QUERY-FORMAT rule 5 identifies a
one-item sequence with the item. So this graph, run three times:

```json
[
  { "input": [{"name":"ada","age":36},{"name":"kit","age":9},{"name":"lin","age":20}],
    "result": [{"name":"ada","age":36},{"name":"lin","age":20}] },
  { "input": [{"name":"ada","age":36},{"name":"kit","age":9}],
    "result": {"name":"ada","age":36} },
  { "input": [{"name":"kit","age":9}],
    "result": null }
]
```

Two survivors give an array, ONE survivor gives the row itself, none
gives `null`. FLOW-FORMAT §6 states only the empty case, and the
difference is invisible until a downstream `$[*]` iterates an object's
values instead of an array's items. The pen cannot fix it — this is the
engine's reading of a document the pen wrote faithfully — so it is
recorded in [docs/ROADMAP.md](../../../docs/ROADMAP.md) under
`@jarenjs/flow`, where the resolution is a format decision (a §6 sentence
and a worked example, or a node-level "always a sequence" option). Until
then: a `query` node feeding anything that expects a list wants a `$for`
whose `$return` is explicitly an array constructor, or a downstream node
that tolerates both.

### 3.6 A `jslt` node

A `jslt` node's stylesheet is the JSLT pen's document
([JSLT-PEN.md](JSLT-PEN.md)), embedded whole. This is the composition the
two pens exist for: a dataflow that ends in a rendered view, written
entirely by code.

```js
import { defineDag, edge, input, jslt, output } from '@jarenjs/linq/flow';
import { apply, rule, stylesheet } from '@jarenjs/linq/jslt';

export const listing = defineDag({
  nodes: {
    articles: input(),
    list: jslt(stylesheet([
      rule('$', (v) => ['ul', {}, [apply(v.all())]]),
      rule('$[*]', (v) => ['li', {}, v.title]),
    ])),
    out: output(),
  },
  edges: [edge('articles', 'list'), edge('list', 'out')],
});
```

```json
{
  "$dag": "0.1",
  "nodes": {
    "articles": { "kind": "input" },
    "list": { "kind": "jslt",
      "stylesheet": { "$jslt": "0.1", "rules": [
        { "match": "$", "body": ["ul", {}, [{ "$apply": "$[*]" }]] },
        { "match": "$[*]", "body": ["li", {}, "$.title"] } ] } },
    "out": { "kind": "output" }
  },
  "edges": [
    { "from": "articles", "to": "list" },
    { "from": "list", "to": "out" }
  ]
}
```

Over `[{ title: 'ada' }, { title: 'lin' }]` this runs to
`['ul', {}, [['li', {}, 'ada'], ['li', {}, 'lin']]]` — a `jaren-vnode`
tree, which is what [JSLT-PEN.md](JSLT-PEN.md) §3.7 is about. The
envelope form and the bare rules array are both accepted here; the
envelope is what `stylesheet()` writes, and a rules array is what a hand
written node usually carries. Nothing about the stylesheet is judged by
this pen — `jslt()` checks only that the value is JSON, and `JF0014` is
the compiler's if the stylesheet itself is wrong.

### 3.7 Ports, a constant, and `typedTasks` over the registry

A node with more than one inbound edge needs ports: when any inbound edge
names one, every inbound edge MUST, and the node's `$` becomes the object
of port-named values in EDGE document order (§6.1). `typedTasks(graph,
registry)` binds the handler table to the graph — identity at runtime,
a compile-time check that the table has one handler per declared task
name.

```js
import { constant, defineDag, edge, input, output, task, typedTasks } from '@jarenjs/linq/flow';

const answering = defineDag({
  nodes: {
    question: input(),
    facts: constant({ product: 'jarenjs', version: '0.52.7' }),
    answer: task('llm', (v) => ({ prompt: v.get('q'), facts: v.get('f') })),
    out: output(),
  },
  edges: [
    edge('question', 'answer', { port: 'q' }),
    edge('facts', 'answer', { port: 'f' }),
    edge('answer', 'out', { select: (v) => v.get('text') }),
  ],
});

// the registry the host will hand compileDag, checked against the graph's task names
void typedTasks(answering, {
  llm: async ({ with: w }) => ({ text: `${w.prompt} — ${w.facts.product} ${w.facts.version}` }),
});

export const graph = answering;
```

```json
{
  "$dag": "0.1",
  "nodes": {
    "question": { "kind": "input" },
    "facts": { "kind": "const", "value": { "product": "jarenjs", "version": "0.52.7" } },
    "answer": { "kind": "task", "run": "llm",
      "with": { "prompt": "$['q']", "facts": "$['f']" } },
    "out": { "kind": "output" }
  },
  "edges": [
    { "from": "question", "to": "answer", "port": "q" },
    { "from": "facts", "to": "answer", "port": "f" },
    { "from": "answer", "to": "out", "select": "$['text']" }
  ]
}
```

`typedTasks` emits nothing — it is the identity function, and the fence
exports the graph. Rename `llm` to `model` in the registry and the fence
stops COMPILING, which is the whole point: the check is
`{ [K in TasksOf<D>]: TaskHandler }`, and the runtime check stays
`JF0018` for a host that assembled its registry dynamically. §5.3 states
the other direction — annotating the node map with `NodesFor<Registry>`,
which catches a misspelled `task('nope')` at the node rather than at the
binding.

## 4. Refusals

The flow pen raises these three `LinqBuildError` codes and no others —
`test/linq/pen-docs.test.js` holds this list equal, in both directions,
to the codes `packages/linq/src/flow/` throws. The full condition each
code states across every pen is the binder's,
[LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3.

| Code | What this pen raises it for |
|---|---|
| `JL0101` | a value this pen cannot spell, a member it does not know, or a name → value map it cannot read |
| `JL0102` | a guard given as a plain STRING, or a state or node id no declaration carries |
| `JL0104` | any external at all: both engines evaluate with one `$` and nothing else |

`packages/linq/src/flow/` carries **33 throw sites** — 30 `JL0101` and 3
`JL0102`. Two families of condition reach a caller through this pen
without being thrown in its directory: the effect descriptor and its list
(`packages/linq/src/effect.js`, shared with the app pen) and the shared
capture's external check (`packages/linq/src/capture-root.js`), which is
where every one of this pen's `JL0104`s comes from — the code appears in
`src/flow/` only in the comments that explain it, and the refusal gate
counts those, correctly, as the pen owing the reader a row.

Every message below is the one the pen raised when the spelling beside it
was run, with the code prefix (`JL0101: `) removed. `docPath`, where the
refusal carries one, is the JSON pointer of the node being assembled and
is appended to the message text as well (`… at /transitions/0/to`).

### 4.1 `JL0101` — the value, the member and the map

**The machine.**

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `defineFsm('$')` | `defineFsm() takes { initial, states, transitions, context? }, got a string` | the four members |
| `defineFsm({ states, transitions })` | `defineFsm() needs an initial state — the format requires the member; pass null for a machine that chooses none (a session then starts with an explicit state)` — `docPath` `/initial` | `initial: 'draft'`, or `null` |
| `defineFsm({ …, nope: 1 })` | `defineFsm() does not take 'nope' — it takes initial, states, transitions, context` — `docPath` `/nope` | the four members |
| `defineFsm({ …, context: {} })` | `defineFsm() context is a schema-pen builder that types the host data a guard reads (FLOW-FORMAT §3) — the format carries no context schema, so nothing is emitted for it; got a Object instance` — `docPath` `/context` | `s.object({ … })` |
| `defineFsm({ …, states: '$' })` | `defineFsm() states is an array of ids and state() declarations, got a string` — `docPath` `/states` | an array |
| `defineFsm({ …, states: [{ id: 'a' }] })` | `defineFsm() states[0] is an id or state(id, options?), got a Object instance` — `docPath` `/states/0` | `'a'` or `state('a')` |
| `defineFsm({ initial: 42, … })` | `defineFsm() initial takes a state id — a non-empty string, got 42` | a declared id |
| `defineFsm({ …, transitions: '$' })` | `defineFsm() transitions is an array of on(…) declarations, got a string` — `docPath` `/transitions` | an array |
| `defineFsm({ …, transitions: [{ from: 'a', to: 'a' }] })` | `defineFsm() transitions[0] is on(from, event?).to(state), got a Object instance` — `docPath` `/transitions/0` | `on('a', 'go').to('a')` |
| `defineFsm({ …, transitions: [on('a', 'go')] })` | `defineFsm() transitions[0] never named its target — on('a', 'go') needs .to(state)` — `docPath` `/transitions/0` | finish it with `.to(state)` |

**A state, a transition, an effect.**

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `state('')` | `state() takes a state id — a non-empty string, got a string` | a non-empty id |
| `state('a', 'x')` | `state() options are { entry?, exit?, final? }, got a string` | the options object |
| `state('a', { onEntry: [] })` | `state() does not take 'onEntry' — it takes entry, exit, final` — `docPath` `/onEntry` | `entry` |
| `state('a', { final: 'yes' })` | `state() final is a boolean, got a string` — `docPath` `/final` | `true` |
| `state('a', { entry: 'x' })` | `state() entry is an array of effect() descriptors, got a string` | an array |
| `state('a', { entry: [{ run: 'x' }] })` | `state() entry[0] is effect(run, with?), got a Object instance` | `effect('x')` |
| `on(1)` | `on() takes a state id — a non-empty string, got 1` | a declared id |
| `on('a', 7)` | `on() takes an event name as a non-empty string, or null for the wildcard that matches any event (FLOW-FORMAT §2), got 7` — `docPath` `/event` | `'go'`, or `null` |
| `on('a', 'go', 'x')` | `on() options are { payload? }, got a string` | `{ payload: … }` |
| `on('a', 'go', { data: s.string() })` | `on() does not take 'data' — it takes payload` — `docPath` `/data` | `payload` |
| `on('a', 'go', { payload: { type: 'object' } })` | `on() payload is a schema-pen builder that types the event's payload — the format carries no payload schema, so nothing is emitted for it; got a Object instance` — `docPath` `/payload` | `s.object({ … })` |
| `on('a', 'go').to(42)` | `to() takes a state id — a non-empty string, got 42` | a declared id |
| `on('a', 'go').effects('x')` | `effects() is an array of effect() descriptors, got a string` | an array |
| `on('a', 'go').when(new Date(0))` | `when() received a Date instance, which is not JSON — a document carries null, booleans, finite numbers (never -0), strings, arrays and plain objects, and nothing else` | a callback, or a query document |
| `effect('')` | `effect() takes the handler name as a non-empty string, got a string` — `docPath` `/run` | a registered name |
| `effect('x', { with: Symbol('s') })` | `effect() with received a Object instance, which is not JSON — a document carries null, booleans, finite numbers (never -0), strings, arrays and plain objects, and nothing else` | a callback, or a query document |

**The dataflow.**

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `defineDag([])` | `defineDag() takes { nodes, edges }, got a Array instance` | the two members |
| `defineDag({ …, tasks: {} })` | `defineDag() does not take 'tasks' — it takes nodes, edges` — `docPath` `/tasks` | the registry goes to `compileDag` |
| `defineDag({ nodes: '$', edges: [] })` | `defineDag() nodes is a plain object of id → node declaration, got a string` — `docPath` `/nodes` | an object |
| `defineDag({ nodes: { __proto__: input() }, edges: [] })` | `defineDag() nodes received a map whose prototype was replaced: a '__proto__:' key in an object literal sets the prototype instead of adding a member, so that member is not there to emit — spell it { ['__proto__']: … }, which is an own key` — `docPath` `/nodes` | `{ ['__proto__']: input() }` |
| `defineDag({ nodes: {}, edges: [] })` | `defineDag() needs at least one node` — `docPath` `/nodes` | at least one |
| `defineDag({ nodes: { a: { kind: 'input' } }, … })` | `defineDag() node 'a' is input(), constant(), query(), jslt(), task() or output(), got a Object instance` — `docPath` `/nodes/a` | `input()` |
| `defineDag({ …, edges: {} })` | `defineDag() edges is an array of edge(from, to) declarations, got a Object instance` — `docPath` `/edges` | an array |
| `defineDag({ …, edges: [{ from: 'a', to: 'a' }] })` | `defineDag() edges[0] is edge(from, to, options?), got a Object instance` — `docPath` `/edges/0` | `edge('a', 'a')` |
| `constant(undefined)` | `constant() takes the value the node yields — every JSON value, null included; undefined is not one` — `docPath` `/value` | any JSON value |
| `constant(new Date(0))` | `constant() received a Date instance, which is not JSON — …` | its ISO string, or its epoch number |
| `query(undefined)` | `query() takes a callback (v) => … captured over the node input, or a query document` — `docPath` `/query` | one of the two |
| `jslt(undefined)` | `jslt() takes a stylesheet document — the JSLT pen's stylesheet(…) or rule array, or one written by hand` — `docPath` `/stylesheet` | `stylesheet([…])` |
| `task('')` | `task() takes the handler name as a non-empty string, got a string` — `docPath` `/run` | a registry name |
| `edge('', 'b')`, `edge('a', '')` | `edge() takes the producing node id as a non-empty string, got a string` — `docPath` `/from` | a declared id |
| `edge('a', 'b', 'x')` | `edge() options are { port?, select? }, got a string` | the options object |
| `edge('a', 'b', { port: '' })` | `edge() port is a non-empty string, got a string` — `docPath` `/port` | a port name |
| `edge('a', 'b', { ports: 'x' })` | `edge() does not take 'ports' — it takes port, select` — `docPath` `/ports` | `port` |

A refusal a captured member can raise that is the CHAIN's rather than
this pen's: `effect('x', () => new Date(0))` is `JL0005` ("a captured
expression cannot embed a Date instance — it carries no own enumerable
members, so it would embed as `{}`"). It is documented in
[QUERY-PEN.md](QUERY-PEN.md) §9.

### 4.2 `JL0102` — a guard given as a plain string

This deserves its own prose because a reader will hit it, and because the
message alone does not explain why a perfectly reasonable-looking string
is refused.

FLOW-FORMAT §3 asserts a guard by **effective boolean value**. A string
that does not start with `$` is a literal string, and a non-empty literal
is EBV-true. So a guard spelled `'count > 3'` is not a condition the
engine fails to parse — it is a condition that passes, on every step,
forever, silently. That is deliberate in the FORMAT: the mermaid state
diagram projection carries opaque display guards lifted from diagram
labels (`[count > 3]`), and a picture's annotation MUST NOT change
execution.

The pen refuses to emit one, because a pen writing that document is not
projecting a diagram — it is writing code that meant something.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `on('a', 'go').when('count > 3')` | `a guard given as a plain string is asserted by effective boolean value, and a non-empty literal is therefore VACUOUSLY TRUE (FLOW-FORMAT §3: a projected display guard must not change execution) — got "count > 3"; pass a body instead: .when((s) => s.payload.fresh)` — `docPath` `/guard` | `.when((sc) => sc.context.count.gt(3))` |
| `on('a', 'go').when('$.payload.fresh')` | the same message, with `"$.payload.fresh"` | `.when((sc) => sc.payload.fresh)` |

The second row is the one that catches people. `'$.payload.fresh'` IS a
valid guard document — the engine would read it as a path and evaluate it
correctly. The pen refuses it anyway, and the reason is that it cannot
tell that string apart from the first row's at build time without
becoming a JSONPath parser, which LINQ-FORMAT §1.1 rule 1 forbids: a pen
mirrors the engine's rules, it does not re-implement its compiler.
Refusing every plain string is the rule that has no wrong answers, and
the callback is both shorter and typed:

```js
// refused, though the document it would write is correct
on('review', 'approve').when('$.payload.fresh').to('published')

// what the writer meant, captured — and sc.payload is typed by the event's declaration
on('review', 'approve', { payload: Approval }).when((sc) => sc.payload.fresh).to('published')
```

A guard written as a query DOCUMENT rides verbatim and is not refused —
`.when({ $gt: ['$.payload.n', 3] })` emits exactly that. The refusal is
on the string form alone, because the string form is the ambiguous one.

### 4.3 `JL0102` — an id no declaration carries

The other `JL0102` condition, and the pen's clearest case of catching the
engine's own rule one step earlier. Both machines and dataflows have it.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `defineFsm({ initial: 'nope', states: ['draft'], transitions: [] })` | `defineFsm() initial names the state 'nope', which "states" does not declare — the declared states are 'draft'` — `docPath` `/initial` | a declared id — the message lists them |
| `on('draft', 'go').to('nope')` in a machine declaring `draft`, `review` | `transition 0 names the state 'nope', which "states" does not declare — the declared states are 'draft', 'review'` — `docPath` `/transitions/0/to` | as above |
| `on('nope', 'go').to('draft')` | the same message, `docPath` `/transitions/0/from` | as above |
| `edge('nope', 'out')` in a graph declaring `rows`, `out` | `edge 0 names the node 'nope', which "nodes" does not declare — the declared nodes are 'rows', 'out'` — `docPath` `/edges/0/from` | a declared id — the message lists them |
| `edge('rows', 'nope')` | the same message, `docPath` `/edges/0/to` | as above |

Every message names the id that was not found AND the ids that were,
which is what makes it useful for a typo: the reader does not have to
scroll back to the declaration to see what they meant to write.

Three checks in a row are worth naming, because they fire in a fixed
order and only the last one is the engine's:

1. **The type checker.** State ids and node ids are literal types read
   off the declarations, so `to('nope')` and `edge('nope', 'out')` do not
   compile in a typed consumer. That is the cheapest place to be told
   (§5.2).
2. **The pen**, for a JavaScript consumer or a dynamically built id:
   `JL0102` at `defineFsm()`/`defineDag()`, naming the id.
3. **The compiler**, for a hand-written document that never went through
   the pen: `JF0004` (`initial` is neither `null` nor a declared state),
   `JF0006` (a transition's `from` or `to` names no declared state) and
   `JF0013` (an edge's `from` or `to` names no declared node).

### 4.4 `JL0104` — the closed world is EMPTY

A machine's guard, an effect's `with`, a `query` node, a task's `with`
and an edge's `select` bind NOTHING but `$`. Not `root`, not `path`, not
a parameter — both flow engines evaluate these with a single `$` and no
externals at all.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `on('a', 'go').when((sc, x) => x.root)` | `a when() callback cannot bind 'root' — its query evaluates with no externals at all; anything else has nothing to bind to — when() evaluates over the step scope { state, event, payload, context } (FLOW-FORMAT §3), which its argument IS` | read the scope: `(sc) => sc.context.url` |
| `effect('x', (sc, y) => ({ n: y.rate }))` | the same, `an effect() with callback cannot bind 'rate'`, with the same step-scope advice | read the scope, or put the value in `context` |
| `query((v, x) => x.root)` | the same, `a query() callback cannot bind 'root'`, advised `query() evaluates over the node's input scope (FLOW-FORMAT §6.1), which its argument IS` | read the input: `(v) => v.all()` |
| `task('llm', (v, x) => x.root)` | the same, `a task() with callback cannot bind 'root'` | as above |
| `edge('a', 'b', { select: (v, x) => x.root })` | the same, `an edge() select callback cannot bind 'root'`, advised `edge() select evaluates over the source value (FLOW-FORMAT §6)` | as above |

Refusing at build time is the whole value of this check, and the reason
is FLOW-FORMAT §5.2: a guard whose evaluation fails does NOT fail the
step. It reads **false** and the failure is recorded. So a guard naming
an unbound external would compile, run, and quietly never fire — the
worst failure mode a state machine has. `JQ2006` at step time is a
recorded error nobody reads; `JL0104` at build time is a stack trace on
the line that wrote it.

**Why the message names no scope of its own.** The first half comes from
the shared capture (`packages/linq/src/capture-root.js`), which knows how
many externals the evaluator binds and nothing else — WHERE a query is
evaluated is the pen's fact, not the capture's, and this pen's five
members have three different answers. Each one supplies its own, which is
what the clause after the dash is. The word "callback" is this pen's too:
it has no rules.

## 5. The types

The declarations are `packages/linq/types/flow.d.ts` (285 lines), and
every claim below is pinned at compile level in
`test/consumer/linq-flow.ts` with a runtime twin in
`test/linq/flow-pen.test.js`. This subpath exports **no builder class, no
constant and no type guard** — the three kinds the mapping table excludes
are empty here, so §2 names the whole runtime surface.

```ts
import { compileDag, compileFsm, fsmToApp } from '@jarenjs/flow';
import { defineDag, defineFsm, edge, input, on, output, state, task, typedTasks } from '@jarenjs/linq/flow';
import type { ContextOf, Dag, EventsOf, Fsm, NodesFor, NodesOf, Scope, StatesOf, TasksOf } from '@jarenjs/linq/flow';

// over §3.1's machine — no `context` was declared, so ContextOf<> is the honest top
type State = StatesOf<typeof review>;      // 'draft' | 'review' | 'published'
type Event = EventsOf<typeof review>;      // 'submit' | 'approve'   (a wildcard names none)
type NoCtx = ContextOf<typeof review>;     // unknown

// over §3.3's machine, which declared one
type Ctx = ContextOf<typeof scored>;       // { threshold: number }

const machine = compileFsm(review);
machine.step('review', 'approve', { payload: { fresh: true, by: 'ada' } });
fsmToApp(review);                          // a machine of string states projects to app documents

// over §3.7's graph
type Ids = NodesOf<typeof graph>;          // 'question' | 'facts' | 'answer' | 'out'
type Names = TasksOf<typeof graph>;        // 'llm'
compileDag(graph, { tasks: typedTasks(graph, { llm: askTheModel }) });
```

`Fsm<States, Events, Ctx>` and `Dag<Ids, Tasks>` carry their phantoms —
`__states`, `__events`, `__context`; `__nodes`, `__tasks` — declared and
never present at runtime, and the `…Of<>` helpers read them back. A
transition builder carries `__from`, `__to` and `__event`, and `on()`
answers a `PendingTransition` that has NO `__to` until `.to()` gives it
one: a transition that never named its target does not compile, before it
is the `JL0101` §4.1 shows.

### 5.1 How a captured member is typed, and where the annotation goes

The capture itself is the JSLT pen's, and it is explained once, in
[JSLT-PEN.md](JSLT-PEN.md) §1.1 — a callback run once at build time
against a recording proxy. What differs here is the closed world: this
pen calls the shared capture with an EMPTY external list, so a flow
callback has one argument and a second one binds nothing (§4.4). The
`fold: false` setting is the same, which is why an effect's literal
`with` is a constructor and not a `$const`.

A captured value's TYPE is the honest top until it is annotated or
declared, and the pen has three different answers for the three places
that matters:

| Where | How it is typed | Why not by inference |
|---|---|---|
| a guard's `sc.payload` | the event's own declaration: `on(from, event, { payload })` | it is the same call — nothing to defer |
| a guard's `sc.context` | ANNOTATION: `.when((sc: Scope<Thresholds>) => …)` | `on()` is evaluated before `defineFsm()` sees the `context` builder |
| an `effect()`'s scope | ANNOTATION: `effect('x', (sc: Scope<Thresholds, Approval>) => …)` | an `effect()` is written before the transition that carries it exists |
| a `query`/`task`/`select` value | ANNOTATION: `query((v: Expr<Row[]>) => …)` | a node's input scope is decided by its inbound EDGES, which are declared after it |

What `defineFsm({ context })` types is the MACHINE — `ContextOf<>` — and
that is the reading a host needs, because the host is what calls
`step(state, event, { context })`. The annotation inside a guard and the
builder on the machine are two statements of the same fact, and nothing
in TypeScript can derive the first from the second here.

### 5.2 Literal ids, and what does not compile

```ts
// @ts-expect-error — 'nope' is not a declared state (before JL0102, long before JF0006)
void defineFsm({ initial: 'draft', states: ['draft'], transitions: [on('draft', 'go').to('nope')] });
// @ts-expect-error — a transition that never named its target is not a transition
void defineFsm({ initial: 'draft', states: ['draft'], transitions: [on('draft', 'go')] });
// @ts-expect-error — the initial state must be declared too
void defineFsm({ initial: 'nope', states: ['draft'], transitions: [] });
// @ts-expect-error — 'nope' is not a declared node (before JL0102, long before JF0013)
void defineDag({ nodes: { i: input(), o: output() }, edges: [edge('nope', 'o')] });
```

The mechanism is `const` type parameters on every id-taking function plus
`StateIdOf<St[number]>` over the `states` array, so the ids come from the
declarations themselves rather than from a union the caller maintains. A
wildcard contributes `never` to the event union, which is why
`EventsOf<>` of a machine whose only transition is `on('a').to('b')` is
`never` and not `string`.

### 5.3 `defineDag<Tasks>` cannot exist — and what a caller writes instead

State it plainly, because a reader who reaches for the type parameter
will get a compiler error that does not explain itself: **there is no
`defineDag<Tasks>(…)` and there cannot be one.**

The reason is TypeScript's, not this pen's. A function's type arguments
are all-or-none: supply one explicitly and every other type parameter
stops being inferred and falls back to its constraint or its default. The
node map's literal ids (`'rows' | 'out'`) and its task names are INFERRED
from the argument, so a signature that also took `Tasks` explicitly would
have to give up the inference that makes `NodesOf<>` and every
`edge(from, to)` check work. One or the other, never both.

So the pen ships both directions as separate spellings, and a caller who
wants a registry checked uses the first:

```ts
interface Registry { llm: (props: { with: unknown; input: unknown }, signal: AbortSignal) => unknown }

// direction 1 — annotate the node map: a task naming a handler the registry lacks
// fails AT THE NODE, which is where the typo is
const nodes = {
  rows: input(),
  ask: task('llm'),
  out: output(),
} satisfies NodesFor<Registry>;

const graph = defineDag({ nodes, edges: [edge('rows', 'ask'), edge('ask', 'out')] });
//    ^ still Dag<'rows' | 'ask' | 'out', 'llm'> — satisfies preserves the literal types

// direction 2 — an identity wrapper at the binding: one handler per declared task name
compileDag(graph, { tasks: typedTasks(graph, { llm: askTheModel }) });
// @ts-expect-error — the graph declares 'llm', not 'other'
void typedTasks(graph, { other: async () => null });
```

`satisfies` rather than a type annotation is what makes direction 1 work:
an annotation (`const nodes: NodesFor<Registry> = { … }`) would WIDEN the
node map to the annotated type and destroy the literal ids, so
`edge('rows', 'ask')` would stop being checked. `satisfies` checks the
value against the type and keeps the value's own inferred type, which is
exactly the trade this needs.

The same wall stands in front of `defineFsm<Ctx>` for the same reason,
and §5.1's annotation table is the answer there. The runtime check for a
missing handler remains the engine's `JF0018`, at `compileDag` — early,
not mid-run.

### 5.4 What the pins hold

`test/consumer/linq-flow.ts` (119 lines) is the compile-level record. It
pins, with `Equals<A, B>` — identity in both directions, never
assignability — `StatesOf<>`, `EventsOf<>` and `ContextOf<>` of a machine
with a mixed `states` array, a `payload`-declared guard, an annotated
effect and a wildcard; the `never` event union of a machine whose only
transition is a wildcard; and `NodesOf<>` and `TasksOf<>` of a six-node
graph. It pins the two type-level directions of the registry check and
nine `@ts-expect-error` negatives, each of which FAILS the build if it
ever starts compiling: an undeclared `to`, an unfinished transition, an
undeclared `initial`, an unknown `defineFsm` member, an undeclared edge
end in each direction, an unknown `defineDag` member, a registry naming a
handler the graph does not declare, and a `task()` naming a handler the
registry does not provide.

## 6. What it cannot spell

### 6.1 A display guard that decides execution

§4.2's refusal restated as a limit, because it is one. The format has
exactly one guard vocabulary and it is executable: a `$`-rooted path or
an operator document. There is no way to carry a human-readable condition
alongside — `[count > 3]` from a diagram label — and have it BE the
condition, and the format's decision (a non-`$` literal is vacuously
true) means the closest thing to it is a guard that always passes.

The alternative is to carry both: the executable guard in `guard`, and
the display text wherever the projection wants it. That is what the
mermaid projection does in the other direction, and it is why the two
documents can round-trip at all.

### 6.2 There is no workflow pen, and there will not be one

`jaren-workflow` is what `@jarenjs/mermaid`'s state-diagram parser
produces from a diagram: no `$fsm` key, string states, null events and
null guards. It is a PROJECTION of a machine, and the binder's "no pen,
by decision" table ([LINQ-FORMAT.md](LINQ-FORMAT.md) §1.0) says why it
gets no pen of its own — the fsm pen's documents are its executable
superset.

The practical consequence, and it is a good one: a machine written with
string states and no guards through `defineFsm()` validates under
`jaren-workflow` as well as under `jaren-fsm`, so a pen-written machine
is projectable to a diagram without a conversion step, and a
diagram-parsed workflow compiles with `compileFsm` unchanged.
`test/linq/flow-pen.test.js` validates a pen document under both
grammars.

### 6.3 The dataflow's non-goals, which are the format's

Named here so a reader does not read absence as an oversight, each with
the section that owns it. A run is one value in and one value out —
streaming a graph chunk by chunk changes the node contract and is a
format revision (§7.5). A machine has no hierarchy, no history states, no
parallel regions and no delayed or timed transitions (§1.1). A machine's
current state is a string and storing it is the host's business (§1.1);
`createFsmSession` is a convenience over that, not persistence. And an
effect is never invoked by the engine: the descriptors come back as data
and the host's registry runs them. Both engines' remaining non-goals are
on [docs/ROADMAP.md](../../../docs/ROADMAP.md) under `@jarenjs/flow`, and
none of them is a pen limitation.

### 6.4 The shape a `query` node's result takes

§3.5's singleton rule is a limit a writer has to plan around today, and
it belongs in this list even though it is neither a refusal nor a pen
decision: a `query` node's result is a value, an array or `null`
depending on how many items the query yielded, and the document cannot
say which it wants. Until the format answers, the spelling that has one
meaning is a `$return` that constructs an array explicitly.

### 6.5 When not to reach for this pen

- **The machine or the graph is data.** A `jaren-fsm` or `jaren-dag`
  document read from a file, drawn in the studio, or projected from
  mermaid is a value; `compileFsm`/`compileDag` take it directly.
- **The control flow is a function.** A pipeline that runs in one
  process, never crosses a boundary and is never drawn is three
  `await`s. A dataflow document buys checkpointing, a diagram, a task
  registry a host substitutes and a document a test can assert — pay for
  it when you want one of those.
- **The states are not a closed set.** `defineFsm` types state ids as
  literals, which is most of what it buys you; a machine whose states are
  computed, loaded, or numerous enough that nobody would type them is
  better as data.
- **The work is long-running and needs to survive a restart.** §6.2 says
  it plainly: there is no workflow pen and there will not be one.
  Durability, retries, timers and compensation belong to a workflow
  engine, and a dataflow document that grew them would be one wearing the
  wrong name.
- **A guard needs to ask something the query language cannot.** Guards
  evaluate over the step scope with one `$` and no externals (§4.4), so a
  clock, a lookup, or a call into a service has no spelling. Decide it in
  the host and send a different EVENT — which is what an event is for.

## 7. Cost

`@jarenjs/linq/flow` builds to **<!--fact:bundle.flow-->19,852<!--/fact--> bytes** as a minified,
tree-shaken ESM bundle — the figure `scripts/check-tree-shaking.js`
measures and `npm run test:tree-shaking` reports, published rounded
(<!--fact:bundle.flow.kb-->20<!--/fact--> kB) beside the other nine subpath prices in
[docs/CONSUMING.md](../../../docs/CONSUMING.md).

The probe is a gate, not a report. Building a machine with a guard and
two effects as a consumer would — `defineFsm`, `state`, `on` and
`effect` — it asserts that the bundle carries:

- **no `@jarenjs/flow` byte** — neither compiler, no `fsmToApp`, no
  session. A consumer who only WRITES documents — a build script, a CLI
  that emits a graph, a test fixture — ships none of the engine;
- **no other engine** — nothing of `@jarenjs/json`, `@jarenjs/validate`,
  `@jarenjs/emit`, `@jarenjs/db`, `@jarenjs/formats`, `@jarenjs/refs` or
  `@jarenjs/contract`;
- **no chain module** — none of `sequence.js`, `document.js`, `async.js`,
  `concurrency.js`, `provider.js`, `sources.js` or `schema-of.js`;
- **of the schema pen, only `brand.js`** — the builder brand, which
  `on()` and `defineFsm()` need to tell a `payload`/`context` builder
  from a hand-written object;
- **no other pen** — not one byte of `model`, `jslt`, `migration`,
  `contract`, `app`, `forms` or `db`, which is what §2's `jslt()` row
  means when it says the stylesheet arrives as a document: the node takes
  JSON and never imports the pen that wrote it;
- **a ceiling** of 20,000 bytes; and the other direction, that neither the
  chain's bundle nor the schema pen's carries a byte of
  `packages/linq/src/flow/`.

Two documents, two grammars, thirteen exported names — and 57 bytes more
than `./jslt`'s <!--fact:bundle.jslt-->19,798<!--/fact-->, which writes one. The reason is that most of
both prices is the same shared machinery: the recording proxy
(`expression.js`), the root capture (`capture-root.js`) and the JSON
boundary (`json-boundary.js`). What this pen adds on top of them is 685
lines of member checks and the messages §4 quotes — and, as the model
pen's own §7 notes, the message text is most of what a mirrored rule
costs.

What a consumer actually pays for §3.6's graph is both subpaths, since
the stylesheet has to be written by something — but not the sum: the
recording proxy, the root capture and the JSON boundary are shared, so
the second subpath adds only its own files. Every figure on this page is
measured rather than typed: the probe compares `docs/CONSUMING.md`'s ten
rounded prices AND every pen document's exact §7 byte count to the bundle
it just built, so a stale number is a red gate rather than a wrong
sentence.
