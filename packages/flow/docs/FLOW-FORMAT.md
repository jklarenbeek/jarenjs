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

### §5.2 Runtime: thrown vs recorded

Only **caller mistakes** throw (`FlowRuntimeError`): JF2001 (an
undeclared state id passed to `step`/`events`/`final`, or as a session
start), JF2002 (a non-string event), JF2005 (a session with no start
state anywhere).

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

## §6 The jaren-dag document

*Reserved for the dataflow format.*

## §7 Dag execution

*Reserved for the dataflow format.*
