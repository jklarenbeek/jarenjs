# Hosting a machine in @jarenjs/app

How a jaren-fsm document drives a live `@jarenjs/app` application. The
shape of the convention is one sentence: **control state is a state
slice, and the machine's transition table becomes generated standard
action documents** — plain JSON the app compiles like any hand-written
action, with no `@jarenjs/flow` code anywhere at runtime and neither
package importing the other. The test suite executes this document's
worked example verbatim.

The philosophy is the same split FLOW-FORMAT §3 states for the headless
engine — control state lives in the machine, data state lives in the
host — mapped onto the app: the control state is one slice member
(`<pointer>/current`), and the host's app state *is* the machine's
`context`.

## The API

```js
import { fsmToApp, fsmStateSchema } from '@jarenjs/flow';

const { slice, actions, events } = fsmToApp(fsmDoc, {
  pointer: '/fsm',        // where the slice lives in app state (default)
  namespace: 'fsm/',      // action-name prefix (default)
});
// slice   → { current: <initial> }         mount it at `pointer`
// actions → { 'fsm/submit': <query doc> }  spread into the app's actions
// events  → ['submit', 'approve', ...]     the machine's event vocabulary
```

`fsmToApp` validates the document exactly like `compileFsm` (same
JF0xxx errors) and then emits **pure JSON**: one action document per
distinct named event, each a conditional chain over the machine's
transitions in document order. `pointer` must be a chain of
identifier-safe segments (`/ui/wizard` is fine); anything else throws a
`TypeError` — that is an option mistake, not a document defect.

`fsmStateSchema(fsmDoc)` returns the slice's JSON Schema — `current`
as an enum of the declared state ids — for composing into a
`validateState` schema (below).

## The scope mapping

A guard or effect `with` query is authored against FLOW-FORMAT §3's
scope. Hosted, each member maps to app vocabulary — the generator
performs this mapping mechanically, so machine documents run unchanged:

| FLOW-FORMAT §3 | hosted meaning |
|---|---|
| `$.state` | the slice's `current`, read pre-transition |
| `$.event` | the event name, baked as a literal per action |
| `$.payload` | the app's `$payload` (the binding's `with`; `null` when absent) |
| `$.context` | the **whole app state** `$`, pre-transition |

Inside a generated action the scope is bound once to the reserved
variable `__fsm`; machine guards and effect props MUST NOT bind a
variable of that name (`fsmToApp` throws a `TypeError` when one does).

**Everything evaluates pre-transition**, guards and effect props alike —
the app computes the entire transition object, effects included, in one
action evaluation against the current state, and this is exactly the
headless engine's rule (one step scope, built before the transition
applies). An effect that wants "the state we just entered" needs no
state read at all: the generator bakes the target state, the patch
value and the event name as literals. Effect props that read *data*
state see pre-transition values; when an async effect's completion must
be checked against later state, use the id-guard convention of
[`@jarenjs/app`'s TASKS.md](../../app/docs/TASKS.md).

## The rules that make it exact

- **Selection is document order, identically.** Each action's
  conditional chain lists that event's transitions (named matches and
  wildcard fallbacks together) in the transition table's order; `$and`
  stops at the first false and `$if` evaluates only the taken branch,
  so a guard runs exactly when the headless engine would run it.
- **The vocabulary is closed.** An app can only dispatch registered
  action names, so the hosted machine answers exactly its *named*
  events; wildcard transitions participate as fallbacks inside each
  named event's action. Two consequences, stated honestly: a machine
  with only unlabeled transitions has an empty vocabulary and cannot be
  driven in an app, and dispatching an out-of-vocabulary name is the
  app's ordinary unknown-action error (`JA2001`) — where the headless
  engine would have answered any string event.
- **An unmatched event is a no-op, not an error.** The chain's missing
  final `$else` yields the empty sequence; the app records a `noop`
  transaction, matching FLOW-FORMAT §4's ignored-event rule.

## Honest divergences

The headless engine records evaluation failures and fails closed
(FLOW-FORMAT §5.2). An app has one failure channel for a whole action,
so two behaviors differ, deliberately:

- **A guard or `with` that throws** (an unbound external, a hostile
  value) fails the entire hosted transaction as `JA2002` — no fallback
  transition fires and no JF2003/JF2004 record exists. Headless, the
  same guard reads false and selection continues. Write total guards;
  the divergence only appears in documents that are already broken.
- **`errors` records don't exist hosted.** The app's `onError` and
  transaction log are the error channel.

One behavior that does NOT diverge: an effect `with` whose query yields
the empty sequence omits the member in both worlds (the query engine
drops empty members from object constructors), and the app hands the
handler `null` for an absent `with` — normalize with `?? null` when
comparing.

## Fail closed with `validateState`

The machine's own guarantee — `current` is always a declared state —
should be enforced by the host too, so a rogue hand-written action
cannot corrupt the slice:

```js
import { JarenValidator } from '@jarenjs/validate';

const stateSchema = {
  type: 'object',
  required: ['fsm'],
  properties: { fsm: fsmStateSchema(fsmDoc), reviewer: { type: 'string' } },
};
const validate = new JarenValidator().compile(stateSchema);
createApp(appDoc, { validateState: (s) => validate(s) });
```

A transition into an out-of-vocabulary `current` is rejected with the
app's own `JA2005` and the state stays untouched.

## Multiple machines

`pointer` and `namespace` make machines composable: a wizard at
`/wizard` with `wizard/` actions and an upload machine at `/upload`
with `upload/` actions share one app without touching each other —
each machine's actions read and write only its own slice, and the
action-name spaces are disjoint by construction.

## The worked example

A document-review machine — one guard reading data state, one entry
effect, two terminal states. This is the document the test suite hosts
and drives:

```json
{
  "$fsm": "0.1",
  "initial": "draft",
  "states": [
    "draft",
    { "id": "in-review",
      "entry": [{ "run": "notify", "with": { "reviewer": "$.context.reviewer", "from": "$.state" } }] },
    { "id": "approved", "final": true },
    { "id": "rejected", "final": true }
  ],
  "transitions": [
    { "from": "draft", "event": "submit", "to": "in-review" },
    { "from": "in-review", "event": "approve", "guard": "$.context.reviewer", "to": "approved" },
    { "from": "in-review", "event": "reject", "to": "rejected",
      "effects": [{ "run": "notify", "with": { "reason": "$.payload.reason" } }] }
  ]
}
```

Hosted:

```js
const { slice, actions } = fsmToApp(reviewDoc);
const app = createApp({
  state: { fsm: slice },                      // no reviewer member yet
  view: [{ match: '$', body: ['main', {}] }],
  actions: {
    ...actions,                               // fsm/submit, fsm/approve, fsm/reject
    assign: { patch: [{ op: 'add', path: '/reviewer', value: '$payload' }] },
  },
}, {
  effects: { notify: (props) => log.push(props) },
  validateState: (s) => validate(s),
});
```

And driven, each step observable through `app.observe`:

1. `dispatch('fsm/submit')` — `applied`, `current` = `in-review`,
   `changedPaths` = `['/fsm/current']`; `notify` receives
   `{ from: 'draft' }` — `reviewer` is **omitted** because the member
   does not exist yet (empty sequence), and `from` is the
   pre-transition state.
2. `dispatch('fsm/approve')` — `noop`: the guard reads no reviewer.
   Nothing moved, nothing ran, no error.
3. `dispatch('assign', 'sam')` — the host's own action; data state and
   control state live side by side.
4. `dispatch('fsm/approve')` — `applied`, `current` = `approved`, a
   final state.

Control state moved only through the machine's generated actions, data
state only through the host's, and the one guard read across the
boundary the only way the convention allows: through `context`.

## A dag as one effect

A compiled dataflow graph (FLOW-FORMAT §6–§7) needs **no adapter at
all**: `run(input, { signal })` is already the exact shape
`createTaskEffect` wants, so a whole graph becomes one ordinary app
effect — with the task convention's per-slot cancellation and the
id-guard staleness rule for free (the app's TASKS.md is the normative
home for that pattern). The test suite runs this recipe:

```js
import { compileDag } from '@jarenjs/flow';
import { createApp, createTaskEffect } from '@jarenjs/app';

const dag = compileDag(enrichDoc, { tasks: { lookup } });

const app = createApp({
  state: { rows: [...], tasks: { enrich: { id: 0, status: 'idle' } }, result: null },
  view,
  actions: {
    start: {
      patch: [
        { op: 'replace', path: '/tasks/enrich/id', value: { $add: ['$.tasks.enrich.id', 1] } },
        { op: 'replace', path: '/tasks/enrich/status', value: 'busy' },
      ],
      effects: [{ run: 'enrich',
        with: { input: '$.rows', id: { $add: ['$.tasks.enrich.id', 1] }, done: 'done' } }],
    },
    done: {
      $if: [{ $eq: ['$payload.id', '$.tasks.enrich.id'] },
        { patch: [
          { op: 'replace', path: '/result', value: '$payload.result' },
          { op: 'replace', path: '/tasks/enrich/status', value: 'idle' } ] }],
    },
  },
}, {
  effects: { enrich: createTaskEffect((props, signal) => dag.run(props.input, { signal })) },
});
```

The division of labor is exact: the dag owns the computation and its
internal abort fan-out (§7.3), `createTaskEffect` owns slot concurrency
and cancellation, and the state-side id guard owns staleness —
out-of-order completions are rejected by construction, never by luck.
