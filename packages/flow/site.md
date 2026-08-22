---
package: "@jarenjs/flow"
card:
  title: Flow — executable workflows
  blurb: >-
    Executable workflows as JSON: jaren-fsm state machines compiled to a
    pure step function, and jaren-dag dataflow over the suite’s own engines.
    Guards are query documents, effects come back as data, and
    @jarenjs/mermaid projects a diagram both ways — the Flow studio edits,
    runs and animates them live.
  perf: >-
    a machine survives a JSON round trip with its guards; XState’s functions
    do not
engines:
  - key: flow
    suite: flow
    title: Flow
---

`@jarenjs/flow` makes the suite’s machines executable, in two document formats.
A `jaren-fsm` is a finite state machine as one JSON value — declared states, an
initial state and a document-ordered transition table whose guards are Jaren
JSON Query documents — compiled once into a pure step function; a `jaren-dag`
is an acyclic dataflow whose nodes are the suite’s own engines (a query
filters, a JSLT stylesheet projects, a registered task awaits) wired by edges
that carry data. Both are schema-published for constrained decoding, both
compile fail-closed with coded, docPath-carrying errors, and neither uses eval.

Effects are data, not callbacks: a fired transition returns resolved { run,
with } descriptors — the host’s registry runs them — so the whole machine stays
a serializable value. That is the wedge, and the Benchmarks page measures it
against XState v5: a `jaren-fsm` document survives a JSON round trip with its
guards intact and still fires them, where XState’s guards are functions JSON
drops and the restored machine throws. Published beside that win are the honest
losses — a compiled machine holds more memory than an XState actor, and a dag
run costs several times a hand-written pipeline: the measured price of dataflow
as one serializable, constrained-decodable value.

**A machine and a dataflow, both as JSON**

```js
// jaren-fsm: a guard is a query document, effects come back as data
{ "$fsm": "0.1", "initial": "idle",
  "states": ["idle", { "id": "done", "final": true }],
  "transitions": [
    { "from": "idle", "event": "ok", "guard": "$.payload.fresh", "to": "done" }] }

// jaren-dag: the suite’s engines, wired
{ "$dag": "0.1",
  "nodes": { "rows": { "kind": "input" },
    "adults": { "kind": "query",
      "query": { "$for": { "r": "$[*]" }, "$where": { "$ge": ["$r.age", 18] }, "$return": "$r" } },
    "out": { "kind": "output" } },
  "edges": [{ "from": "rows", "to": "adults" }, { "from": "adults", "to": "out" }] }
```

One document, three views that cannot disagree: `@jarenjs/mermaid` projects a
stateDiagram to a `jaren-fsm` and a flowchart to a `jaren-dag` (and back) as
plain JSLT stylesheets, a machine hosts inside an `@jarenjs/app` through
generated standard action documents, and a dag hosts as one app effect. The
Flow studio puts all three on one page — click the diagram, edit a generated
inspector, or edit the mermaid text; every gesture is an RFC 6902 patch against
the same document, which then runs live as a nested app or an aborting dag.

The studio ships classic FSM examples as seeds, including three ported from
iMatix’s Libero code generator (imatix-legacy.github.io/libero) — the Coke
machine, the telephone dialogue and the lrcalc arithmetic-expression evaluator.
Libero described logic as state / event / action / next-state tables and
generated code from them; a `jaren-fsm` IS that table, as one runnable JSON
value: load the Coke machine, watch it as a state graph, and click Ok · Clink ·
Coke to drive it — the current state glows and the transition just taken flows
— with every Libero action landing in the run log. The expression evaluator is
the same idea doing real work: a shunting-yard parser whose events are token
types.

> **Try it** — Open the Flow studio: start from the review-machine or
> enrich-dataflow seed, edit it three ways, then run it live and watch the
> diagram highlight the current state or the nodes settle. [Open Flow](#/flow)
