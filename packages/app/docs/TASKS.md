# Async tasks — the staleness-rejection convention

Module: `@jarenjs/app`. This document is the async-task **convention**:
how an app document performs asynchronous work — request identity,
stale-response rejection, cancellation — plus the one shipped helper,
[`createTaskEffect`](../src/tasks.js), that removes the host-side
boilerplate.

It is deliberately **pattern-first**: there is no format change and no
new document member. The correctness mechanism is expressible in
today's vocabulary, and that is a *feature* of actions-as-queries — a
task's identity is ordinary state, its guard is an ordinary query, so
snapshots, replay and the meta-schema all keep working with nothing
added. First-class async action documents (a disposition that awaits an
effect before transitioning) remain the roadmap item they already are
([APP-FORMAT §11](APP-FORMAT.md)).

> **The worked example below is executable.** The single `json` code
> block in this document is a complete app document; the test suite
> (`test/app/tasks.test.js`) extracts it *from this file*, compiles it,
> and drives every scenario — happy path, out-of-order staleness, abort,
> failure routing, polling — against it. These docs cannot drift from
> the engine.

## The two halves, stated precisely

**Correctness lives in state; cancellation lives in the host.**

- The **state half** is the guarantee: every task slot carries a
  monotonically increasing `id`; the start action increments it; the
  completion action rejects any payload whose `id` is not the current
  one. Out-of-order responses are harmless *by construction*.
- The **host half** — an `AbortController` per slot, packaged by
  `createTaskEffect` — is an optimization: it stops wasting the wire on
  a superseded request. It is **not** the guarantee: an aborted fetch
  may already have resolved and its completion dispatch may already be
  queued. **A host that only aborts is still wrong.** Keep the id
  guard.

## Half 1 — the state convention

A task slot in state:

```js
"tasks": { "list": { "id": 0, "status": "idle", "error": null } }
```

**The start action** does two things in one transition: it patches the
slot (increment `id`, set `status` to `"loading"`, clear `error`) and
invokes the effect with the **new** id in its props.

> ⚠ **The pre-transition-`$` gotcha.** An action's entire result —
> including every effect's `with` — is computed by the query against
> the ***pre*-transition** state `$`. The patch is applied before the
> effects *run*, but their props were already evaluated. So the
> effect's `with.id` MUST be written as the same increment expression
> the patch uses — `{ "$add": ["$.tasks.list.id", 1] }` — and never as
> a read of the patched slot. This is the one place the pattern can
> silently rot: a `with.id` that reads the slot ships the *old* id, and
> every completion is then rejected as stale.

**The completion action** is dispatched by the host with
`$payload = { "id", "result" }` on success or `{ "id", "error" }` on
failure. Guard first: when `$payload.id` differs from the slot's
current `id`, produce the **empty sequence** — a conditional with no
else-branch, `{ "$if": [guard, then] }`, which is APP-FORMAT §3.2's
no-op transition: nothing changes, nothing renders, no subscriber
fires. Otherwise store the result (or the error) and flip `status`.
The two payload shapes are told apart with
`{ "$exists": "$payload.error" }` — an absent member is the empty
sequence, so `$exists` is the exact "did the host send an error" test.

**Polling** composes on top: a subscription whose `when` watches state
dispatches the start action on an interval. Every poll increments the
id, so overlapping responses fall out of the same guard — an old poll
response can never overwrite newer state, with no new machinery.

## Half 2 — the shipped helper

```javascript
import { createApp, createTaskEffect } from '@jarenjs/app';

createApp(doc, {
  effects: {
    http: createTaskEffect((props, signal) =>
      fetch(props.url, { signal }).then((r) => r.json())),
  },
  subs: {
    every: (props, dispatch) => {
      const id = setInterval(() => dispatch(props.action), props.ms);
      return () => clearInterval(id);
    },
  },
});
```

`createTaskEffect(run, options)` takes the host's async function
`run(props, signal) => Promise<JSON>` and returns an ordinary effect
handler. `run` is invoked through a **uniform promise boundary**: a
synchronous throw and a non-promise return settle through exactly the
same path as a rejection/resolution. `options.mode` picks the per-slot
concurrency semantics — `"switch"` (default: a new start aborts the
slot's in-flight predecessor), `"exhaust"` (duplicate starts are
ignored — the double-click-safe commit mode), `"concat"` (starts queue
and run strictly in order) or `"parallel"` (APP-FORMAT §9.2). The
handler carries the host-side controls `cancel(slot)`, `cancelAll()`
and `dispose()` — after `dispose()` (which `app.destroy()` calls
automatically) no late settlement can dispatch. `options.projectError`
opens the structured-failure door: an HTTP host can settle `{ id,
error: { status, code, ... } }` instead of a flattened string
(APP-FORMAT §9.3). The effect-props convention (all JSON):

| Prop | | Meaning |
|---|---|---|
| `id` | REQUIRED | The task identity, echoed back verbatim in the completion payload. |
| `done` | REQUIRED | The action dispatched on settle. |
| `fail` | OPTIONAL | The action for rejections. Absent: rejections dispatch `done` with `{ id, error }` instead of `{ id, result }` — one completion action guarding on `$payload.error` is the query-friendliest shape, so it is the default. |
| `slot` | OPTIONAL | The concurrency key (a string), default `""`. What a new start does to the slot's in-flight task is the effect's `mode` (default `"switch"`: it aborts the predecessor). |
| ... | | Anything else `run` needs (a URL, a query, ...). |

Settlement semantics, exactly:

| Outcome | Effect |
|---|---|
| start | The slot's in-flight controller (if any) is aborted; a fresh one is stored; `run(props, signal)` is called. |
| resolve | `dispatch(done, { id, result })`. |
| reject, `err.name === "AbortError"` | **Nothing.** A superseded task is dead by design; its successor's dispatch carries the story. |
| reject, anything else | `dispatch(fail ?? done, { id, error })` — `error` is a **string** by default, or the JSON value `options.projectError(err, props)` returned (APP-FORMAT §9.3); never an Error object — JSON only crosses the boundary. A projector that throws, declines (`undefined`) or returns non-JSON falls back to the string. |
| settle | The task's controller is released; a `concat` slot starts its next queued task. |
| after `dispose()` | **Nothing** — a late settlement can no longer dispatch. |
| malformed `id`/`done`/`fail`/`slot` | A `TypeError` from the handler — a host programming error, reported by the loop as `JA2007`. |

Tasks in different slots never touch each other. The helper holds no
state beyond the per-slot records, uses no timers, and has zero
dependencies (`AbortController` is platform).

## The worked example

A list task and a detail task in independent slots, with polling. Both
completion actions guard on the slot id; the detail task routes
failures to a dedicated `fail` action, the list task uses the default
single-completion shape:

```json
{
  "$app": "0.1",
  "state": {
    "tasks": {
      "list":   { "id": 0, "status": "idle", "error": null },
      "detail": { "id": 0, "status": "idle", "error": null }
    },
    "items": [],
    "detail": null,
    "polling": false
  },
  "view": [
    { "match": "$", "body": ["main", {}, "$.tasks.list.status"] }
  ],
  "actions": {
    "loadList": {
      "patch": [
        { "op": "replace", "path": "/tasks/list/id",
          "value": { "$add": ["$.tasks.list.id", 1] } },
        { "op": "replace", "path": "/tasks/list/status", "value": "loading" },
        { "op": "replace", "path": "/tasks/list/error", "value": null }
      ],
      "effects": [
        { "run": "http", "with": {
          "id": { "$add": ["$.tasks.list.id", 1] },
          "done": "listLoaded",
          "slot": "list",
          "url": "/api/items"
        } }
      ]
    },
    "listLoaded": {
      "$if": [
        { "$eq": ["$payload.id", "$.tasks.list.id"] },
        { "$if": [
          { "$exists": "$payload.error" },
          { "patch": [
            { "op": "replace", "path": "/tasks/list/status", "value": "error" },
            { "op": "replace", "path": "/tasks/list/error", "value": "$payload.error" }
          ] },
          { "patch": [
            { "op": "replace", "path": "/tasks/list/status", "value": "done" },
            { "op": "replace", "path": "/items", "value": "$payload.result" }
          ] }
        ] }
      ]
    },
    "openDetail": {
      "patch": [
        { "op": "replace", "path": "/tasks/detail/id",
          "value": { "$add": ["$.tasks.detail.id", 1] } },
        { "op": "replace", "path": "/tasks/detail/status", "value": "loading" },
        { "op": "replace", "path": "/tasks/detail/error", "value": null }
      ],
      "effects": [
        { "run": "http", "with": {
          "id": { "$add": ["$.tasks.detail.id", 1] },
          "done": "detailLoaded",
          "fail": "detailFailed",
          "slot": "detail",
          "url": { "$concat": ["/api/items/", { "$string": "$payload" }] }
        } }
      ]
    },
    "detailLoaded": {
      "$if": [
        { "$eq": ["$payload.id", "$.tasks.detail.id"] },
        { "patch": [
          { "op": "replace", "path": "/tasks/detail/status", "value": "done" },
          { "op": "replace", "path": "/detail", "value": "$payload.result" }
        ] }
      ]
    },
    "detailFailed": {
      "$if": [
        { "$eq": ["$payload.id", "$.tasks.detail.id"] },
        { "patch": [
          { "op": "replace", "path": "/tasks/detail/status", "value": "error" },
          { "op": "replace", "path": "/tasks/detail/error", "value": "$payload.error" }
        ] }
      ]
    },
    "startPolling": { "patch": [{ "op": "replace", "path": "/polling", "value": true }] },
    "stopPolling":  { "patch": [{ "op": "replace", "path": "/polling", "value": false }] }
  },
  "subs": [
    { "run": "every", "when": "$.polling",
      "with": { "ms": 5000, "action": "loadList" } }
  ]
}
```

Walk the staleness scenario through it: `loadList` twice in quick
succession takes the slot id to `2` and the helper aborts request 1.
Suppose request 1's response arrives anyway (it had already resolved
when the abort landed). Its dispatch is `listLoaded` with
`{ "id": 1, ... }`; the guard compares `1` against the slot's `2`,
`$if` takes no branch, the action yields the empty sequence — no state
change, no render, no subscriber. Only request 2's completion, carrying
the current id, lands. The same holds when polling: every tick is a
fresh id, so the guard serializes an arbitrary storm of overlapping
responses down to "latest wins".

## What the meta-schema needs

Nothing — and that is the point. The convention is ordinary `state`,
ordinary `actions`, ordinary `effects` invocations; the worked example
above validates against the shipped
[`jaren-app.schema.json`](../schemas/jaren-app.schema.json) unchanged.
A pattern that needed a schema extension would be a format change; this
one is proof the existing vocabulary already carries request identity
and staleness rejection.

## Observe an existing durable run

`createRunObservation({ readPage, wake, pageSize?, maxBytes? })` is an app
subscription factory, used as `subs: { run: observation }`. The subscription
props name `runId`, attempt `id`, saved `cursor` and `update`/`error` actions.
`readPage({ id, after, limit }, { signal })` reads one bounded public event page;
`wake(signal)` waits for the next notification or the host's bounded poll.
Only one page is outstanding and only current status, summary, revision and
cursor enter app state. The update action must guard the attempt ID and reject
older revisions, as for task completion. No accumulated event log enters state.

The cleanup returned by a subscription and `observation.dispose()` detach
observers. They do not cancel the durable run. Lost notifications recover through
the saved revision cursor; missing history emits `reset: true` and a fresh
summary. Malformed/oversized pages and read failures emit only
`{ code: "run-observation-failed" }`, never exception text or provider credentials.
The host projection decides which domain summary fields are public.

`createRunPageHandler({ page, authorize, maxPage? })` from `@jarenjs/contract/app`
is an ordinary read handler that checks current authority before touching durable
history. Inject `createDbRunStore(...).page` into it, expose it through a compiled
read operation, and have `readPage` invoke that operation through any public
contract client. Explicit cancellation is a separate authorized command; navigation
only removes the subscription.
