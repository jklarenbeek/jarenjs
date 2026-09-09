# Jaren statecharts — jaren-fsm 0.2

`compileStatechart` compiles a JSON document into pure `start`, `step` and
`advance` functions. It provides compound states, parallel regions, shallow
and deep history, completion/eventless transitions and delayed transitions.
It executes no effect and reads no clock. `compileFsm`, `createFsmSession`,
`fsmToApp` and the 0.1 schemas retain their existing contracts.

The canonical grammar is [jaren-statechart.schema.json](../schemas/jaren-statechart.schema.json)
(`https://jarenjs.dev/schemas/jaren-fsm/0.2`), with draft-07 and authoring twins.
Register the query grammar when validating. Compilation checks references,
hierarchy and transition domains that JSON Schema cannot prove. Unknown
statechart, state and transition members are compile errors.

## 1. Document and state tree

```json
{
  "$fsm": "0.2",
  "initial": "working",
  "states": [
    { "id": "working", "initial": "editing" },
    { "id": "editing", "parent": "working" },
    { "id": "review", "parent": "working" },
    { "id": "memory", "parent": "working", "history": "deep" },
    "paused",
    { "id": "expired", "final": true }
  ],
  "transitions": [
    { "from": "editing", "event": "submit", "to": "review" },
    { "from": "working", "event": "pause", "to": "paused" },
    { "from": "paused", "event": "resume", "to": "memory" },
    { "from": "review", "after": 60000, "to": "expired" }
  ]
}
```

States have globally unique, nonempty string ids. A bare string declares an
atomic state. An object supports `id`, `parent`, `initial`, `type`, `history`,
`final`, `entry` and `exit`. The parent relation MUST be acyclic.

| Type | Contract |
|---|---|
| `atomic` | No children. The default when no ordinary children exist. |
| `compound` | Exactly one ordinary child active; `initial` MUST name an immediate ordinary child. Inferred when ordinary children exist. |
| `parallel` | All ordinary children active. Each region recursively enters its initial configuration. No `initial` on the parallel state itself. |
| `final` | No children or outgoing transitions. `final: true` is shorthand. |
| `history` | A pseudo-state with a parent and `history: "shallow"` or `"deep"`; no children, outgoing transitions or effects. `history` infers this type. |

The document's `initial` MUST name an ordinary root state. State effects use
FLOW-FORMAT's `{run,with?}` descriptors. Final and history declarations cannot
conflict with an explicit `type`. Parents precede children in runtime tree
order even if the flattened declarations list a child first; siblings retain
declaration order.

Entering a compound target recursively enters its initial child. Entering a
parallel target recursively enters every region. An explicit descendant target
enters its ancestors and fills any unmentioned parallel regions with defaults.

## 2. Selection, effects and completion

A transition supports `from`, `to`, `guard`, `effects`, `type` and at most one
trigger: `event`, `after`, `always: true` or `done: true`. An absent or null
event is a wildcard over **external string events**, as in 0.1. It does not
match timers or completion. A transition MUST name declared endpoints.

For each active leaf, search its own transitions first, then its ancestors
nearest first. Within a source, document order decides; a wildcard before a
named transition wins. Evaluate a shared ancestor guard once per microstep.
Independent parallel regions can transition in the same step. Conflicting
exit sets are resolved in favor of the descendant source; unrelated conflicts
use tree order of the selecting leaves. The selected transition effects run
in transition document order.

`type: "external"` is the default in **0.2**, including self-transitions.
Its domain is the least common **proper compound ancestor** of source and
target (or the virtual root); a parallel ancestor is not such a domain.
Exiting that domain's active descendants makes a cross-region transition
leave and re-enter the parallel state, restoring untargeted regions to their
defaults. `type: "internal"` can target the source or its descendants: the
source stays entered, while its active descendants exit. An atomic internal
self-transition therefore runs only its transition effects. This is an
explicit version difference from 0.1's implicit internal self-transition.

Each microstep resolves effects against its pre-transition scope in order:
exit effects in reverse tree order, transition effects in document order,
entry effects in tree order. `$.state` is the ordered **array of active leaf
ids**; `$.event` is the external name, or null for initial entry/timers;
`$.payload` and `$.context` are caller values, defaulting to null. Guards
use query effective boolean value. Evaluation failures retain FLOW-FORMAT's
JF2003/JF2004 records and fail-closed behavior.

`always` transitions participate in automatic stabilization after initial
entry, an external event or a timer. `done` is enabled when its compound
source has an active immediate final child, or all regions of its parallel
source have completed. Completion sources MUST be compound/parallel. A
completed root reports `final: true`; it is still possible to send events to
that root's ancestors/sources until the host chooses to stop. There is no
implicit context assignment, raised-event queue or invocation machinery.

`maxMicrosteps` (default 1000, positive safe integer) bounds one call's
automatic transitions and timer processing. Exhaustion throws JF2012; pure
inputs and session state remain unchanged. There is no partial-result commit.
These rules borrow hierarchy/history and transition-domain definitions from
[SCXML's control semantics](https://www.w3.org/TR/scxml/), but this JSON format
is not an SCXML implementation or an SCXML conformance claim.

## 3. History

Immediately before exiting a compound/parallel state, remember its active
configuration for each declared history child. Shallow history stores the
active immediate ordinary children; re-entry initializes their descendants.
Deep history stores active atomic/final leaves, including all parallel
regions, and restores those leaves. Targeting history before any record exists
uses the parent's default initial configuration. Entering the parent normally
uses its defaults even if history was recorded; history is an explicit target.

History restores **control**, not elapsed timers or host context. Restored
states run their entry effects and schedule fresh delays. A timer that belonged
to an exited state remains cancelled.

## 4. Time is input

```js
const chart = compileStatechart(doc);
const initial = chart.start({ now: 1000, context });
const next = chart.step(initial.state, 'submit', { now: 1200, context });
const later = chart.advance(next.state, 61200, { context });
```

`now` is a finite number in the host's millisecond time domain; fresh starts
default to zero. Omitted step time preserves the snapshot's time. Time MUST
NOT move backwards (JF2011). The engine never calls `Date.now`, starts a host
timer, or waits. A host may arm a timer from the earliest returned deadline
and call `advance` when notified, including after process restart.

`after` is a finite nonnegative duration. Entry creates one timer per delayed
transition, storing its absolute deadline, transition index and monotonically
increasing token. Exit cancels the source's timers. A timer is consumed once,
even if its guard is false. Equal deadlines use transition order. Newly entered
delays use logical firing time, not the time the host eventually delivered the
wake-up. Overflowing deadlines/tokens are JF2011.

`step` does not implicitly fire overdue timers. The host chooses whether an
external event or a due timer happens first. `advance` consumes due timers up
to its supplied time and stabilizes after each. `{one: true}` consumes at most
one timer plus its stabilization, leaving time at that logical firing instant;
when none is due it advances to the requested time. The composition bridge
uses this mode to persist visit counts between timer deliveries. Timer indices
cannot be forged as string events: external dispatch and time advancement are
separate APIs.

## 5. Snapshot and session

`StatechartState` is the whole control snapshot:

```jsonc
{
  "active": ["review"],
  "history": { "memory": ["review"] },
  "timers": [{ "transition": 3, "at": 61200, "token": 1 }],
  "serial": 1,
  "time": 1200
}
```

Snapshots are frozen JSON. `restore(snapshot)` validates legal active and
history configurations, timer sources/deadlines/tokens and numeric counters;
it normalizes leaf/history/timer ordering and returns an independent frozen
copy. Invalid snapshots are JF2010. A snapshot's schema is
[jaren-statechart-state.schema.json](../schemas/jaren-statechart-state.schema.json).
Standalone callers bind snapshots to their machine revision; composed workflows
perform that comparison themselves.

Results carry `changed`, `state`, `final`, `effects`, `errors`, `entered`,
`exited` and `transitions` (indices into the compiled document). `changed`
means a transition fired. An ignored event or a consumed false timer can still
advance snapshot time, so persist the returned state even when `changed` is false.

`createStatechartSession(chart, {state?, now?, context?, store?})` exposes
`state`, `done`, `initial`, `send`, `advance` and `can`. `initial` contains entry
effects for a fresh start and is null when restoring; the host executes these
and later result effects. Optional synchronous `store.load()`/`store.save(state)`
persist a fresh initial state and every successful send/advance **before** the
session advances. A failed save leaves the session unchanged. Async stores
belong at the workflow boundary. `can` is a pure dry run with no store write.
