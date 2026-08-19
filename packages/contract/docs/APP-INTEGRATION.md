# Calling a contract from @jarenjs/app

How an application built with `@jarenjs/app` calls the operations of a
contract with no route strings, no hand-written `fetch` wrappers and
no per-operation effect handlers. The shape of the convention is one
sentence: **every operation becomes a task slot in state plus three
generated action documents, and one registered effect carries them all**
— plain JSON the app compiles like any hand-written action, with the
per-operation concurrency mode taken from the contract's `policy.task`
and neither package importing the other. The test suite executes this
document's two worked examples verbatim, against a real `serveHttp`
dispatcher.

The convention is `@jarenjs/app`'s own async-task convention
([TASKS.md](../../app/docs/TASKS.md)): correctness lives in state (a
monotonic slot `id`, a completion action that guards on it), cancellation
lives in the host. The generator writes those documents so a consumer
never writes the id guard by hand, and the effect settles every
operation with the contract's **outcome** (CONTRACT-FORMAT §10) instead
of a string.

## The API

```js
import { createApp, createTaskEffect } from '@jarenjs/app';
import { openHttpClient } from '@jarenjs/contract/client';
import { contractAppBinding, createContractEffect } from '@jarenjs/contract/app';

const client = openHttpClient(contract, { baseUrl: 'https://api.example' });

const { slice, actions, schema } = contractAppBinding(contract, {
  statePath: '/contract',      // where the slice lives in app state (default)
  namespace: 'contract/',      // action-name prefix (default)
  ops: contract.ids,           // the operations this app uses (default: all)
});
// slice   → { 'catalog.load': { id: 0, status: 'idle', kind: null, value: null, error: null, meta: null }, … }   mount it at statePath
// actions → { 'contract/catalog.load/start', '…/done', '…/reset': <query docs>, … }                            spread into the app's actions
// schema  → the slice's JSON Schema                                                                           compose into validateState

createApp(doc, {
  effects: { contract: createContractEffect(client, { createTaskEffect }) },   // ONE effect for every operation
});
```

`createContractEffect` takes the `createTaskEffect` factory **from the
host** — `@jarenjs/contract` imports nothing from `@jarenjs/app`, and
there is exactly one task-effect implementation in the suite. It builds
one inner task effect per distinct `policy.task` mode the contract
uses (`switch` for a read, `exhaust` for a command by default) and
routes each descriptor by its `op`, so a `switch` read and an `exhaust`
command live behind the one `run: "contract"` the documents name. The
mode is never *named* in a generated document; the generator derives the
document's state-side guards from it instead (an `exhaust` start is a
no-op in state while its slot is loading), so state and effect tell the
same story in every mode.

## The worked example

A two-operation contract — a read with a query member and a command
with a path variable, a required idempotency key and a declared
`conflict` error:

```json
{
  "$contract": "0.1",
  "id": "shop",
  "version": "1",
  "$defs": {
    "Product": {
      "type": "object",
      "required": ["id", "name", "price"],
      "properties": {
        "id": { "type": "integer" },
        "name": { "type": "string", "minLength": 1 },
        "price": { "type": "number", "minimum": 0 }
      }
    }
  },
  "operations": {
    "catalog.load": {
      "kind": "read",
      "input": { "type": "object", "properties": { "since": { "type": "string", "format": "date-time" } } },
      "output": { "type": "array", "items": { "$ref": "#/$defs/Product" } },
      "http": { "method": "GET", "path": "/api/catalog" }
    },
    "product.save": {
      "kind": "command",
      "input": {
        "type": "object",
        "required": ["id", "product"],
        "properties": { "id": { "type": "integer" }, "product": { "$ref": "#/$defs/Product" } }
      },
      "output": { "$ref": "#/$defs/Product" },
      "errors": { "conflict": { "status": 409, "schema": { "$ref": "#/$defs/Product" } } },
      "policy": { "idempotency": "required" },
      "http": { "method": "PUT", "path": "/api/products/{id}" }
    }
  }
}
```

The application document. `state.contract` is where the generated slice
is mounted (the host replaces the placeholder with `slice`), the
generated actions are spread beside the app's own, and the view reads
the slots like any other state:

```json
{
  "$app": "0.1",
  "state": {
    "contract": {},
    "draft": { "id": 1, "name": "Kettle", "price": 12 }
  },
  "view": [
    { "match": "$", "body": ["main", {},
      ["p", { "class": "status" }, "$.contract['catalog.load'].status"],
      ["ul", {}, { "$apply": "$.contract['catalog.load'].value[*]" }],
      ["p", { "class": "save" }, "$.contract['product.save'].status"]
    ] },
    { "match": "$.contract['catalog.load'].value[*]", "body": ["li", {}, "$.name"] }
  ],
  "actions": {
    "draft/name": { "patch": [{ "op": "replace", "path": "/draft/name", "value": "$payload" }] }
  }
}
```

Composed and mounted:

```js
const { slice, actions, schema } = contractAppBinding(contract, { ops: ['catalog.load', 'product.save'] });
const validate = new JarenValidator().compile({
  type: 'object',
  required: ['contract', 'draft'],
  properties: { contract: schema, draft: { type: 'object' } },
});
const app = createApp(
  { ...doc, state: { ...doc.state, contract: slice }, actions: { ...actions, ...doc.actions } },
  {
    effects: { contract: createContractEffect(client, { createTaskEffect }) },
    validateState: (state) => validate(state),
  });

app.dispatch('contract/catalog.load/start', { since: '2026-01-01T00:00:00Z' });
// → state.contract['catalog.load'] = { id: 1, status: 'loading', kind: null, value: null, error: null, meta: null }
// … the server answers …
// → { id: 1, status: 'done', kind: null, value: [ {…}, {…} ], error: null, meta: { op, attempt: 1, trace, … } }

app.dispatch('contract/product.save/start', { id: 1, product: app.getState().draft });
// a 409 conflict → { id: 1, status: 'error', kind: 'failure', value: null, error: { code: 'conflict', status: 409, details: {…}, … }, meta }
// state.draft is untouched; a later success → status 'done', kind null, value the saved product, error null
app.dispatch('contract/product.save/reset');
// → status 'idle', kind null, error null — id, value and meta untouched (dismiss the error, or release a slot the host cancelled)
```

## What the generated documents guarantee

- **Staleness is rejected by construction.** Two quick `start`s take the
  slot id to 2; the effect's `switch` mode aborts request 1, but even
  when request 1's response arrives (it may already have resolved), its
  `done` carries `id: 1`, the guard compares it with the slot's `2`,
  `$if` takes no branch, and the action yields the empty sequence — no
  state change, no render, no subscriber.
- **A double-click does not double-run a command — and its result
  lands.** `product.save` is a command, `policy.task` defaults to
  `exhaust`: its generated `start` is wrapped in a state-side guard
  (`$if: [{ $ne: [<slot>.status, "loading"] }, …]`), so while the slot
  has an in-flight task a second `start` is a no-op in state *and* in
  the effect — no patch, no effect invocation, no render; the id stays
  at 1, the handler runs once, the single completion carries id 1
  against a slot at 1 and lands as `done` with the saved product. (For
  a command whose every dispatch must run, `policy.task: "concat"`
  queues; the contract is the one place the choice is made.)
- **`reset` releases a slot.** `contract/<op>/reset` writes `status:
  "idle"`, `kind: null`, `error: null` and leaves `id`, `value` and
  `meta` alone — the ordinary "dismiss the error" action, and the one
  way out of a slot a host `effect.cancel(slot)` left `loading` on an
  `exhaust` operation (the guarded `start` is a no-op while loading).
  The id stays monotonic, so a late completion of the cancelled attempt
  is still rejected.
- **A failed reload keeps the last good value.** The error branch writes
  `status`, `error` and `meta`; `value` is untouched, so a list stays on
  screen while the error shows beside it.
- **Cancellation is silent.** A `cancelled` outcome dispatches nothing
  (the task effect's `AbortError` rule); the slot stays `loading` until
  its successor settles or the host dispatches `reset`.
- **`validateState` fails closed.** The slice schema pins `status` to
  `idle | loading | done | error`, `kind` to `null | failure | network |
  contract`, `value` to the operation's output schema or `null`, and
  `error`/`meta` to the outcome shapes; a rogue hand-written action that
  writes a nonsense status is `JA2005` and the state stands.
- **Every failure lands as an outcome, and the slot says which kind.** A
  declared error, a network failure, a contract violation — and a thrown
  host value, projected to `JC2058` — arrive in `error` as the same
  `{ code, message, status, details, retryable }`, and the slot's `kind`
  carries the outcome's kind (`failure` | `network` | `contract`) while
  `status` is `error`, so a view tells "you are offline" from "the
  server refused this" without parsing `error.code`.

## Honest divergences from TASKS.md

- The completion payload is read through `$coalesce: ["$payload.result",
  "$payload.error"]` rather than TASKS.md's `$exists: "$payload.error"`
  branch: both members carry an outcome here (a resolved one, or a
  projected host throw), and the outcome's own `ok` decides the branch.
- The effect's `fail` prop is not emitted: one completion action per
  operation is the query-friendliest shape, and the outcome already
  distinguishes success from failure.
- The state slot carries `kind`, `value` and `meta` beside TASKS.md's
  `{ id, status, error }`: the operation's output has a schema, so it
  has a typed home in the slice rather than a hand-chosen path, and the
  failure class is a member rather than a code to parse.
- One slot per operation makes `concat` and `parallel` **"latest
  wins"**: every `start` increments the id, the effect runs them all
  (queued, or concurrently), only the completion carrying the current
  id lands, `status` stays `loading` until the newest does, and earlier
  results and errors are dropped from state. TASKS.md's per-slot
  convention says nothing about several results for one slot; a
  consumer that needs every result of a fan-out needs a slot per key.
- An `exhaust` operation's `start` carries a state-side guard TASKS.md
  does not write by hand: TASKS.md's exhaust mode ignores duplicate
  starts in the *effect*, but a hand-written start still moves the
  slot id, so the one completion would be rejected; the generator
  decides in state first, and the mode is still never named.
