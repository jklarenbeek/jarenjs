# The Jaren flow formats

This document is the normative contract for the `@jarenjs/flow` document
formats. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119. The structural grammar is
published as JSON Schema in [`schemas/`](../schemas/) (draft 2020-12
plus a mechanically derived draft-07 twin per artifact); this prose is
authoritative for everything a structural schema cannot express, and
the compiler enforces it.

Section map: §1 scope, §2 the jaren-fsm document, §3 the evaluation
scope, §4 the selection rule, §5 errors. §6 (the jaren-dag document)
and §7 (dag execution) are reserved for the dataflow format.

## §1 Scope

A **jaren-fsm** document is an executable finite state machine: named
control states, one current state at a time, and a transition table
answering named events. It is the executable superset of the shape the
`@jarenjs/mermaid` state-diagram projection produces (`jaren-workflow`):
every document valid under that projection contract MUST compile here
unchanged. This projection-shaped document — no `$fsm` key, string
states, null events and guards — is already a complete machine:

```json
{
  "initial": "draft",
  "states": ["draft", "review", "published"],
  "transitions": [
    { "from": "draft", "event": "submit", "guard": null, "to": "review" },
    { "from": "review", "event": "approve", "guard": null, "to": "published" },
    { "from": "review", "event": null, "guard": null, "to": "draft" }
  ]
}
```

The engine is **headless and pure**. Compiling yields a step function
from `(state, event, options)` to a transition result; the machine holds
no mutable state, executes no side effects and touches no host API.
Effects are **descriptors returned as data** — the host's registry runs
them, the same boundary discipline `@jarenjs/app` keeps.

### §1.1 Non-goals of format 0.1

Named so nobody reads absence as oversight:

- **Hierarchy.** No compound or nested states; a mermaid composite state
  arrives flattened.
- **Eventless chains.** A transition only ever fires in answer to a
  `step`/`send` call; there are no spontaneous microsteps and no
  always-transitions that cascade.
- **History, parallel regions, delayed/timed transitions.** Statechart
  vocabulary deferred until a use case demands it.
- **Effect execution.** The engine resolves descriptors and returns
  them; it MUST NOT invoke handlers.
- **Persistence.** A machine's current state is a string; storing it is
  the host's business.

### §1.2 Hosting

The engine is deliberately host-agnostic. For `@jarenjs/app` the
package ships a generator, `fsmToApp`, that projects a machine into
standard app documents — a state slice and one action document per
named event, with this section's scope mapped onto app vocabulary
(the host's state is the `context`). That convention, including its
honestly-stated divergences, is specified in
[APP-INTEGRATION.md](APP-INTEGRATION.md); nothing there changes the
format defined here.

## §2 The jaren-fsm document

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
    { "from": "loading", "event": "fail", "to": "idle",
      "effects": [{ "run": "toast", "with": { "text": "retrying" } }] }
  ]
}
```

- **`$fsm`** MAY be present; when present it MUST be `"0.1"`. Absent
  implies 0.1 — the projection contract predates the key.
- **`initial`** MUST be the id of a declared state, or `null` when the
  document does not choose one (a session then requires an explicit
  start state).
- **`states`** MUST be an array of declarations, each a string id or an
  object `{ id, entry?, exit?, final? }`; a string is shorthand for
  `{ id }`. Ids MUST be unique. `final: true` marks a terminal state —
  advisory to hosts (a session reports `done`); the engine itself
  happily steps out of a final state if a transition says so.
- **`transitions`** MUST be an array of
  `{ from, event?, guard?, to, effects? }` entries. `from` and `to`
  MUST name declared states. `event` is a string, or null/absent — a
  **wildcard** matching any event name. `guard` is a Jaren JSON Query
  document (§3), or null/absent for none.
- **Effect descriptors** (`entry`, `exit`, transition `effects`) MUST be
  `{ "run": name, "with"?: query }` with a non-empty string `run`.
- Unknown members anywhere are ignored for forward compatibility, as in
  the app format.

## §3 The evaluation scope

Guards and effect `with` members are Jaren JSON Query documents
(QUERY-FORMAT.md), compiled once at `compileFsm` time. At step time each
evaluates with `$` bound to one scope object:

| member | value |
|---|---|
| `$.state` | the current state id (the transition's `from`) |
| `$.event` | the event name being stepped |
| `$.payload` | the caller's payload, or `null` when absent |
| `$.context` | caller-supplied extended data, or `null` when absent |

**Control state lives in the machine; data state lives in the host.**
The engine carries no context of its own — the caller passes `context`
per call, which is what keeps the machine a pure function and the host
(an `@jarenjs/app` state slice, a server session, a test) the single
owner of its data.

A guard is asserted by **effective boolean value** (QUERY-FORMAT's EBV
rules). Two consequences worth stating plainly:

- A guard that is a plain string **not** starting with `$` is a literal
  string, and a non-empty literal is EBV-true: the guard is **vacuously
  true**. This is deliberate — the mermaid projection carries opaque
  display guards (`[count > 3]` from a diagram label), and a picture's
  annotation MUST NOT change execution. Write `$`-paths or operator
  documents for real conditions.
- A guard whose result has no effective boolean value (a multi-item
  sequence) does not fail the step: it reads **false** and the failure
  is recorded (§5.2).

An effect's `with` evaluates against the same scope; an empty query
result omits the `with` member from the resolved descriptor.

## §4 The selection rule

**Document order is the whole priority scheme.** For a step from state
S on event E, the first entry of `transitions` — in document order —
whose `from` equals S, whose `event` equals E or is a wildcard, and
whose guard is absent or EBV-true, fires. There is no specificity
ranking (a wildcard listed first beats a named match listed later), no
backtracking, and order among guards is the author's to arrange —
fallbacks go last.

When a transition fires, the step result reports `changed: true`,
`state` = the transition's `to`, and the resolved effect descriptors in
this order:

1. the `exit` effects of the from-state — only when the state actually
   changed (`from ≠ to`);
2. the transition's own `effects` — always;
3. the `entry` effects of the to-state — only when the state actually
   changed.

A **self-transition** (`from = to`) therefore runs its transition
effects but neither exit nor entry: format 0.1 has no internal/external
transition distinction, and re-running entry work on a self-loop is the
surprising default. `changed` means **a transition fired** — a
self-transition reports `changed: true` with an unchanged `state`.

A step whose event no transition answers is **ignored**: the result is
`changed: false`, the same state, no effects — the conventional FSM
reading of an unhandled event, and the shape hosts can treat as a
no-op. It MUST NOT be an error.

## §5 Errors

Every failure carries a stable `code` and the `docPath` of the
offending document member. The classes live in `src/errors.js`; the
tables there and here MUST stay in sync.

### §5.1 Compile errors (`FlowCompileError`, thrown)

| code | condition |
|---|---|
| JF0001 | the document is not an object, or `$fsm` is present and not `"0.1"` |
| JF0002 | `states` is not an array, or a state entry is malformed |
| JF0003 | two state entries share one id |
| JF0004 | `initial` is neither null nor a declared state id |
| JF0005 | `transitions` is not an array, or an entry is malformed |
| JF0006 | a transition's `from` or `to` names no declared state |
| JF0007 | a guard failed to compile (`cause` carries the query error) |
| JF0008 | an effects list or effect descriptor is malformed |
| JF0009 | an effect's `with` failed to compile (`cause`) |
| JF0010 | the dag document is not an object, or `$dag` is not `"0.1"` |
| JF0011 | `nodes` is not an object, or a node declaration is malformed |
| JF0012 | `edges` is not an array, or an edge entry is malformed |
| JF0013 | an edge's `from` or `to` names no declared node |
| JF0014 | an embedded query/stylesheet/`with`/`select` failed to compile (`cause`) |
| JF0015 | wiring rules violated: inbound into `input`/`const`, outbound from `output`, incomplete/duplicate ports, or a consumer with no inbound edge |
| JF0016 | the graph has a cycle (member ids in the message, `docPath` at the first edge inside it) |
| JF0017 | not exactly one `output` node |
| JF0018 | a `task` node names no registered handler |

### §5.2 Runtime: thrown vs recorded

Only **caller mistakes** throw (`FlowRuntimeError`):

| code | condition |
|---|---|
| JF2001 | an undeclared state id passed to `step`/`events`/`final`, or as a session start |
| JF2002 | a non-string event passed to `step` |
| JF2005 | a session created with no start state anywhere |

**Document-level evaluation failures never throw.** They fail closed
and are recorded as plain data in the step result's `errors` array,
each record `{ code, docPath, message }`:

| code | condition | fail-closed reading |
|---|---|---|
| JF2003 | a guard threw while evaluating | the guard is false; selection continues |
| JF2004 | an effect's `with` threw while evaluating | the effect is omitted; the step completes |

A step with a non-empty `errors` array still returns a valid result —
hosts SHOULD surface the records through their own error channel, and a
repair loop gets a `docPath` pointing at exactly the query that failed.

**Dag runs are different, deliberately** (§7.3): a dag has no
recorded-error channel. A failure rejects the whole run promise —
because a dataflow result assembled from partially failed nodes is
exactly the kind of partial result D7 forbids:

| code | condition |
|---|---|
| JF2006 | a node failed while evaluating (own `nodeId` property beside `docPath` and `cause`) |
| JF2007 | the caller's signal aborted the run |
| JF2008 | a node declared `checkpoint: true` but produced a value that is not JSON-serializable; the run rejects at save time |
| JF2009 | the checkpoint store threw while loading, saving or completing; the run rejects |

## §6 The jaren-dag document

A **jaren-dag** document is an executable, acyclic dataflow: named
nodes wired by edges that carry data, run to completion for one input.
The nodes are the suite's own engines — a closed vocabulary, which is
what keeps the schema a real contract for constrained decoding;
extending it is a format revision, not an option.

```json
{
  "$dag": "0.1",
  "nodes": {
    "rows": { "kind": "input" },
    "adults": { "kind": "query",
      "query": { "$for": { "r": "$[*]" }, "$where": { "$ge": ["$r.age", 18] }, "$return": "$r" } },
    "names": { "kind": "jslt",
      "stylesheet": [{ "match": "$", "body": ["ul", {},
        [{ "$for": { "p": "$[*]" }, "$return": ["li", {}, "$p.name"] }]] }] },
    "out": { "kind": "output" }
  },
  "edges": [
    { "from": "rows", "to": "adults" },
    { "from": "adults", "to": "names" },
    { "from": "names", "to": "out" }
  ]
}
```

- **`$dag`** MUST be `"0.1"` and MUST be present — unlike `$fsm` there
  is no earlier contract to stay compatible with, so the document says
  what it is.
- **`nodes`** MUST be an object of id → declaration. The kinds:

  | kind | members | meaning |
  |---|---|---|
  | `input` | — | yields the `run(input)` value (`null` when absent) |
  | `const` | `value` (required, any JSON) | yields its literal value |
  | `query` | `query` | a Jaren JSON Query over the node's input scope |
  | `jslt` | `stylesheet` | a JSLT stylesheet over the node's input scope |
  | `task` | `run`, `with?` | a registered async handler (§7.2) |
  | `output` | — | its input scope value is the run's result |

- **`edges`** MUST be an array of `{ from, to, port?, select? }`.
  `select` is a query applied to the source value before delivery.
  Wiring rules (all compile-time): `input` and `const` nodes accept no
  inbound edge; the `output` node has no outbound edge; `query`,
  `jslt`, `task` and `output` nodes MUST have at least one inbound
  edge; the graph MUST be acyclic; exactly one `output` node MUST be
  declared. Unknown members are ignored for forward compatibility.

### §6.1 The input scope

A node's `$` is decided by its inbound edges:

- **One unported edge** — `$` is the delivered value, verbatim.
- **Ported edges** — when any inbound edge names a `port`, every
  inbound edge MUST name one, ports MUST be unique, and `$` is the
  object of port-named values, members in **edge document order**. A
  single ported edge therefore yields `{ port: value }` — the way to
  force the object shape.
- Two or more unported inbound edges are a compile error (JF0015).

A delivery whose `select` yields the empty sequence delivers `null`; a
`query`/`jslt` node whose own result is empty likewise yields `null` —
`undefined` is not a JSON value and never flows through a graph.
Values pass **by reference**: nodes and hosts MUST NOT mutate what
they receive.

## §7 Dag execution

### §7.1 Compile once, run many

`compileDag(doc, { tasks })` validates the document (§5.1 codes),
compiles every embedded query, stylesheet, `with` and `select` exactly
once, resolves every `task` node against the registry (a missing
handler is compile-time JF0018 — fail early, not mid-run), and proves
acyclicity. `run(input, { signal?, onNode? })` may then be called any
number of times, concurrently; runs share nothing but the compiled
closures.

### §7.2 The run

Nodes evaluate when their inputs are ready — topological order with
insertion-order tie-break; independent branches run **concurrently**.
Determinism is *same input → same output values*, never same timing:
results are keyed and port objects are assembled in edge document
order, so completion order cannot change a value. Each node evaluates
at most once per run; every declared node evaluates, reachable from
the output or not.

A `task` node's handler is called as
`handler({ with, input }, signal)` — `with` is its query resolved
against the node's input scope (`null` when absent or empty), `input`
is the scope value, and `signal` is the run's shared `AbortSignal`.
The handler MAY return a plain value or a promise; a resolved
`undefined` reads as `null`. **Handlers MUST honor the signal**: an
ignoring handler can never block a run's rejection, but it blocks a
run's successful resolution (the run resolves only when every node
settled).

### §7.3 Failure and abort

The first failing node wins: the run rejects with `JF2006` (own
`nodeId`, `docPath` to the failing member, `cause`), the shared signal
aborts, and in-flight tasks are expected to reject promptly. The
caller's `signal` aborting rejects the run with `JF2007`. There are no
retries and no partial results — rerunning is the caller's decision,
and the id-guard convention of `@jarenjs/app`'s TASKS.md is the
staleness answer when a dag runs as an app effect
(APP-INTEGRATION.md).

### §7.4 Observability

`onNode` receives one bounded JSON record per node **that started
evaluating**, at settlement: `{ id, status, ms }` with `status` one of
`ok` | `error` | `aborted` | `restored` and `ms` the node's own
evaluation time (waiting for inputs excluded). `restored` is the one
exception to "started evaluating": a RESUMED run (§7.6) fires it
first, `ms: 0`, for every node whose checkpointed value was seeded
instead of evaluated. The first failure records `error`;
concurrent losers and abort victims record `aborted`; nodes whose
inputs never arrived produce no record. Records for stragglers MAY
arrive after the run promise already rejected. A throwing observer is
isolated and ignored — observation MUST NOT change a run.

### §7.5 Non-goals of format 0.1

- **Streaming.** A run is one value in, one value out; feeding a dag
  from the `@jarenjs/josl` incremental readers chunk by chunk is the
  natural 0.2 composition, and doing it well changes the node contract
  — so it is not bolted on here.
- **Retries.** A failed run is rerun by its caller; retry policy
  belongs to the host (or the app's task convention), not the graph.
- **Persistence / resume — amended.** A run STILL holds no durable
  state by default, because checkpoints would make every node contract
  a serialization contract. §7.6 makes that contract EXPLICIT and
  opt-in instead of universal: nothing changes for any document or
  caller that does not ask.
- **Cross-run caching.** Same-input memoization is a host concern;
  the engine promising it would outlaw impure task handlers the
  format explicitly allows.

### §7.6 Checkpointing — the explicit serialization contract

Durable runs are OPT-IN twice: the caller provides a store, and each
node that wants its value persisted declares it.

```js
const dag = compileDag(doc, { tasks, checkpoint: {
  load(runId) {},               // → { values: { [nodeId]: value } } | null
  save(runId, nodeId, value) {}, // record one declared node's value
  complete(runId, result) {},    // record the run's result
} });
await dag.run(input, { runId: 'run-42' });
```

- A node declares `"checkpoint": true` to assert its output is JSON.
  A declared node whose value fails RFC 8785 canonicalization is
  **`JF2008` at save time, never a silent skip** — the node's author
  claimed a serialization contract and broke it. Undeclared nodes are
  simply RECOMPUTED on resume, which preserves the exact 0.1 contract
  for every document written before this section existed.
- A resumed run (`run(input, { runId })` with recorded values) SEEDS
  the per-run memo from `load` and restarts the rest — the execution
  model is untouched; only where the memo comes from changed. Seeded
  nodes fire `restored` records (§7.4).
- `save` runs after the node's value exists and before its `ok`
  record: a crash between the two re-runs the node on resume —
  at-least-once, stated plainly. A store member MAY return a promise;
  a THROWING store fails the run with `JF2009`.
- `complete(runId, result)` runs after the output settles; a queue
  backing the store can mark its job done in the same transaction —
  which is the entire point of the shape.
- **Idempotency is the caller's.** A task node with side effects that
  runs twice after a crash is the caller's bug, bluntly. The
  mitigation is an idempotency key threaded through the node's
  `with` props and honoured by the effectful system itself.
- Resuming under a DIFFERENT document than the one that saved is
  undefined behaviour — keep the document stable with the run (the
  `@jarenjs/db` queue stores it on the job row for exactly this
  reason). Values recorded for node ids the current document does not
  declare (or no longer declares `checkpoint`) are ignored.

### §7.7 FSM persistence

Needs nothing new: `step` is pure and a session's whole durable state
IS its current state string. `@jarenjs/flow` ships three thin helpers
— `snapshotFsm(session)` → `{ state }`, `resumeFsmSession(fsm,
snapshot)` (an undeclared state refuses with the session's own
JF2001), and `createDurableFsmSession(fsm, { load, save })`, which
persists through a SYNCHRONOUS store on every state CHANGE, before
the step result returns; a throwing `save` fails the send rather than
lose a transition. A worked example over a `@jarenjs/db` collection:

```js
const machine = compileFsm(doc);
const orders = store.sync.collection('fsm');
const session = createDurableFsmSession(machine, {
  load: () => orders.get('order-7')?.state ?? null,
  save: (state) => orders.put({ id: 'order-7', state }, 'order-7'),
});
```
