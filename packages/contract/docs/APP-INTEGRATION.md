# Calling a contract from @jarenjs/app

How an application built with `@jarenjs/app` calls the operations of a
contract with no route strings, no hand-written `fetch` wrappers and
no per-operation effect handlers. The shape of the convention is one
sentence: **every operation becomes a task slot in state plus two
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
// slice   → { 'catalog.load': { id: 0, status: 'idle', value: null, error: null, meta: null }, … }   mount it at statePath
// actions → { 'contract/catalog.load/start': <query doc>, 'contract/catalog.load/done': <query doc>, … }  spread into the app's actions
// schema  → the slice's JSON Schema                                                               compose into validateState

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
command live behind the one `run: "contract"` the documents name.

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
// → state.contract['catalog.load'] = { id: 1, status: 'loading', value: null, error: null, meta: null }
// … the server answers …
// → { id: 1, status: 'done', value: [ {…}, {…} ], error: null, meta: { op, attempt: 1, trace, … } }

app.dispatch('contract/product.save/start', { id: 1, product: app.getState().draft });
// a 409 conflict → { id: 1, status: 'error', value: null, error: { code: 'conflict', status: 409, details: {…}, … }, meta }
// state.draft is untouched; a later success → status 'done', value the saved product, error null
```

## What the generated documents guarantee

- **Staleness is rejected by construction.** Two quick `start`s take the
  slot id to 2; the effect's `switch` mode aborts request 1, but even
  when request 1's response arrives (it may already have resolved), its
  `done` carries `id: 1`, the guard compares it with the slot's `2`,
  `$if` takes no branch, and the action yields the empty sequence — no
  state change, no render, no subscriber.
- **A double-click does not double-run a command.** `product.save` is a
  command, `policy.task` defaults to `exhaust`: while the slot has an
  in-flight task, a second `start` still increments the id and marks
  `loading` (state is honest about the intent), but the effect ignores
  the duplicate start entirely — the handler runs once. The completion
  carries id 1 against a slot at 2 and is rejected; the slot is released
  by the next start. (For a command that must land, `policy.task:
  "concat"` queues; the document is the one place the choice is made.)
- **A failed reload keeps the last good value.** The error branch writes
  `status`, `error` and `meta`; `value` is untouched, so a list stays on
  screen while the error shows beside it.
- **Cancellation is silent.** A `cancelled` outcome dispatches nothing
  (the task effect's `AbortError` rule); the slot stays `loading` until
  its successor settles or the host dispatches its own reset.
- **`validateState` fails closed.** The slice schema pins `status` to
  `idle | loading | done | error`, `value` to the operation's output
  schema or `null`, and `error`/`meta` to the outcome shapes; a rogue
  hand-written action that writes a nonsense status is `JA2005` and the
  state stands.
- **Every failure lands as an outcome.** A declared error, a network
  failure, a contract violation — and a thrown host value, projected to
  `JC2058` — arrive in `error` as the same `{ code, message, status,
  details, retryable }`; `kind` is recoverable from the code (`JC2051`
  network, other `JC205x` contract, anything else a failure).

## Honest divergences from TASKS.md

- The completion payload is read through `$coalesce: ["$payload.result",
  "$payload.error"]` rather than TASKS.md's `$exists: "$payload.error"`
  branch: both members carry an outcome here (a resolved one, or a
  projected host throw), and the outcome's own `ok` decides the branch.
- The effect's `fail` prop is not emitted: one completion action per
  operation is the query-friendliest shape, and the outcome already
  distinguishes success from failure.
- The state slot carries `value` and `meta` beside TASKS.md's `{ id,
  status, error }`: the operation's output has a schema, so it has a
  typed home in the slice rather than a hand-chosen path.
