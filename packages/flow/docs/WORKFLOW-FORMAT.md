# Composed workflows — jaren-workflow 0.2

`compileWorkflow(document, {tasks, store?})` lowers a neutral JSON workflow
onto `compileStatechart` and `compileDag`. The statechart chooses control;
the DAG executor owns dependency scheduling, fan-out/fan-in and task abort.
The bridge transfers results, persists snapshots and dispatches completion.
Host roles, prompts, model settings, network clients and tools remain in the
versioned task registry.

The composed format uses `$workflow: "0.2"` and schema id
`https://jarenjs.dev/schemas/jaren-workflow/0.2`. This deliberately avoids
reusing Mermaid's historical `jaren-workflow/0.1` schema identity, which denotes
the unversioned flat-FSM projection. The new schema is
[jaren-workflow.schema.json](../schemas/jaren-workflow.schema.json), with
draft-07 and derived authoring twins. Register the DAG, query and JSLT grammars
for full validation; schema acceptance is followed by compilation.

## 1. The document

```json
{
  "$workflow": "0.2",
  "revision": "review/1",
  "initial": "prepare",
  "states": {
    "prepare": {
      "work": { "task": "prepare", "version": "1" },
      "then": "check",
      "limit": 3
    },
    "check": {
      "choose": [{ "guard": "$.context.data.ready", "to": "review" }],
      "otherwise": "prepare"
    },
    "review": {
      "on": [
        { "event": "approve", "guard": "$.payload.accept", "to": "done" },
        { "event": "retry", "to": "prepare" }
      ],
      "after": { "ms": 60000, "to": "expired" }
    },
    "done": { "final": true },
    "expired": { "final": true }
  }
}
```

`revision` is a nonblank host-declared revision. `initial` names a state in
`states`, a nonempty object keyed by nonempty ids. References are local to
that object. Each state declares exactly one form; unknown members refuse.

| Form | Members and meaning |
|---|---|
| Work | `work: {task, version, with?}` or `work: {dag: <jaren-dag document>}`; `then` required, `input` and `catch` optional. |
| Choice | `choose: [{guard,to}, …]` and `otherwise`; first true guard wins. |
| Wait | `on: [{event,to,guard?}, …]`; optional `after: {ms,to}`. At least one event or delay is required. |
| Nested flow | `flow: {initial,states}` and `then`; a compound state whose child final completes it. |
| Final | `final: true`; ends its scope and returns its current data. |

Every state may declare `limit`, a positive safe integer. It bounds total
entries to that fully qualified state **for the whole run**, including
re-entries through an external event or nested flow. A loop is a back-edge in
the control graph. Compilation proves that every automatically traversable
cycle crosses a limited state; otherwise it rejects with JF0022. External
event edges do not advance themselves and are excluded from this proof.
Timer edges ARE automatic. Runtime admission counts all entered states and
rejects an excess with JF2015 before starting work in them. Nested depth is
bounded at 64. An exhausted bound is an error, not successful completion.

Static concurrent branches belong inside `work.dag`, using its existing port,
query, stylesheet and task vocabulary. Parallel statechart regions are available
through `compileStatechart`; a composed workflow's dynamic control intentionally
has one active leaf and one pending work region. Nested control composes by
lowering; it does not start a second workflow scheduler.

## 2. Scope, data and errors

Guards and a work state's `input` query read
`{state,event,payload,context}`. `state` is the active-leaf array. Context is:

- `input`: the original run input, unchanged across the workflow;
- `data`: the current value, initially the input and replaced after each work;
- `event`: the last accepted external `{type,payload?}` event, initially null;
- `results`: the latest completed work result by qualified state id;
- `visits`: entry counts by qualified state id.

The default work input is `$.context.data`. A custom `input` query also sees
`$.context.activation = {runId,state,visit,key}`. `key` is the canonical JSON
encoding of `[runId, qualifiedStateId, visit]`; it remains the same after a
crash/resume and differs between loop iterations. For an effectful task, pass
it explicitly with the work input and have the external system deduplicate it:

```jsonc
{
  "work": { "task": "charge", "version": "billing/3",
    "with": { "idempotencyKey": "$.key", "order": "$.data" } },
  "input": { "key": "$.context.activation.key", "data": "$.context.data" },
  "then": "done"
}
```

A task handler has the existing DAG signature `({with,input}, signal)`.
`work.with` reads the **DAG input**, not the outer control scope. Missing
query results become null. Work inputs, outputs and snapshots must survive
canonical JSON serialization. Snapshot ownership is separate from task-owned
values; restoring a checkpoint does not hand a task mutable durable state.

On success, the bridge records the result, replaces `data`, clears pending
work and sends the lowered completion event. A `catch` target handles JF2006
node failures by replacing data with `{error:{code,message,nodeId}}` and
transitioning there. Store, provenance, cancellation and visit-bound errors
are never swallowed by `catch`. Uncaught task failures reject; persisted
checkpoints remain available for a later retry.

Unlike a standalone statechart, a workflow rejects a guard evaluation error
as JF2016 before advancing control: choosing a fallback after a broken work
predicate is not a successful workflow decision. The lower-level diagnostic
path remains on the error. Task effects are at-least-once across crash windows;
checkpointing does not make an external service exactly-once. Implementation
versions remain host declarations: the compiler cannot detect code changes
hidden behind an unchanged version token.

## 3. Deterministic lowering

`lowerWorkflow(document)` returns frozen JSON containing the original
`document`, lowering `version`, declared `revision`, `fsm`, `dags`, `specs` and
`sources`. It resolves no host handler and performs no work. Each state gets
a stable JSON Pointer id, for example `/states/prepare` or
`/states/round/flow/states/prepare`; each id segment escapes `~` and `/`.

Work shorthand lowers to input → versioned checkpointed task → checkpointed
output. Inline DAGs retain their wiring and checkpoint declarations, with
the output checkpoint enabled because a completed region is serializable.
Consequently **every task in a composed workflow must declare a version**, and
its registry entry must supply the same version. Intermediate undeclared
checkpoints recompute, per FLOW-FORMAT §7.6.

Choices and work completions become explicit internal event names. Wait
names receive a separate `event:` prefix, so an external caller cannot forge
a work-completion event. Delays lower to statechart `after`; nested flows to
compound states and `done` transitions. No third node scheduler is generated.

Compilation exposes `lowered`, `revisions` (control and DAG content
fingerprints), and a sorted `taskVersions` map qualified by control and node
path. Trace and checkpoint records refer to these lowered identities. Exact
canonical documents and maps, rather than a short content hash alone, decide
resume compatibility. Runtime traces can vary in completion timing; values,
control decisions and lowering are deterministic for equal inputs/events,
explicit time and equal task results.

## 4. Run, wait and resume

```js
const workflow = compileWorkflow(doc, {
  tasks: { prepare: { version: '1', run: async ({input}, signal) => prepare(input, signal) } },
  store,
});
const first = await workflow.run(input, { runId: 'review-7', now: 1000 });
// first.status: 'waiting' or 'done'; first.snapshot is frozen JSON.
const next = await workflow.run(input, {
  runId: 'review-7', now: 2000,
  expectedGeneration: first.snapshot.generation,
  event: { type: 'approve', payload: { accept: true } },
});
```

A run proceeds until a final state or an unhandled wait. The return value is
`{status: 'waiting'|'done', result, snapshot}`; `result` is current data on
completion and null while waiting. With no store, pass the previous snapshot
as `snapshot` on the next call. Store and explicit snapshot are mutually
exclusive. Resume requires the original input and matching exact identities;
JF2013 is raised before loading any node result when they differ.

One supplied event is delivered to the first wait reached by that call, then
consumed even if no guard accepts it. Unknown events leave a wait unchanged.
`expectedGeneration` rejects a stale event/resume with JF2014 before work.
An accepted event is persisted in `context.event` before subsequent work, so
an input query can consume `$.context.event.payload` after a durable wait.
Callers needing durable event receipts maintain those in their host; duplicate
external-event delivery is not an exactly-once input protocol.

`now` is explicit statechart time. A resumed computation uses the supplied
wake-up time for its next control transition. At a wait the bridge processes a due timer
before the supplied external event, persisting each admission; this ordering
is fixed. Fresh runs default to time zero. Work is not automatically timed
out; cancellation belongs to the supplied `signal`. A host can wake a saved
workflow using its snapshot's earliest deadline. No sleeping timer lives in
the bridge.

`onTrace` receives frozen records with `runId`, source `revision`, and lowered
`revisions`. Node records add `type:'node'`, qualified `state`, activation
visit, and the DAG's `id/status/ms`; transition records add ordered transition
indices, entered/exited ids, active leaves and snapshot generation. A final
`waiting`/`done` record names the settled control. Observer exceptions are
isolated. Aborted DAG stragglers can still produce observation records; they
cannot commit new work checkpoints after cancellation.

## 5. Store, atomicity and crash windows

A store implements async-or-sync methods:

```js
load(runId);                              // snapshot or null
save(runId, snapshot, expectedGeneration); // true on atomic success, false if stale
```

`save` MUST atomically compare the existing generation, replace the complete
snapshot and return true. Expected generation zero means the run is absent.
The bridge claims a fresh generation before work, serializes concurrent DAG
checkpoint writes, and awaits every durable write before the corresponding
control change is visible. A failed write is JF2009; a failed comparison is
JF2014. Same-instance concurrent calls for one run id refuse immediately;
independent compiles/processes are fenced by the store's CAS. This is optimistic
fencing, not an execution lease: overlapping workers can start external work
before one loses its next CAS, so side effects still need the idempotency key.

A snapshot carries format, run id, exact identities, generation, statechart
control, data context, status and nullable pending DAG activation. Pending
work carries state id, visit, captured input, per-node values, DAG provenance
and, after completion, its result. On resume, declared node checkpoints seed
the existing DAG memo; a recorded completed region skips the DAG altogether.
Malformed control, visits, pending provenance and node declarations refuse.

A crash after an effect succeeds but before its node checkpoint repeats that
effect on resume. A crash after region completion but before control changes
reuses the region result. Store implementations choose transaction durability
and retention; the library promises no fsync, queue leasing or automatic
compaction. All run data is currently stored in one bounded-by-the-host JSON
snapshot; large histories should use a store with appropriate limits.

Standalone DAGs can opt into the same exact provenance comparison with
`compileDag(doc, {tasks,checkpoint,revision})`; see FLOW-FORMAT §7.9.

## 6. Repository consumer and verification

[The flow benchmark document](../../../benchmark/fixtures/flow-workflow.json)
is the workflow executed by `npm run benchmark:flow`. Two correctness suites
fan out in one DAG. A nested flow then runs the existing FSM and DAG benchmarks
**sequentially**, retaining their measurement isolation and original assertions.
A report task assembles their values. A choice optionally enters a persisted
review wait; `retry` loops through at most three measurement rounds.

```sh
npm run benchmark:flow -- --quick
npm run benchmark:flow -- --quick --review --checkpoint /tmp/flow-runs.json
npm run benchmark:flow -- --checkpoint /tmp/flow-runs.json --accept
```

Omit `--quick` for normal benchmark iterations. Quick timings are smoke data,
not replacement release measurements. Use a new `--run-id` for a fresh run;
resuming a completed run intentionally returns its saved result. The file
store uses an exclusive short lock plus atomic compare/rename; a lock left by
a killed process must be inspected and removed by the host, never stolen based
on elapsed time. Node/browser hosts may inject another CAS store.

Tests cover this exact document's concurrency, ordered measurements and saved
review/retry, plus general task/choice/loop/nesting/wait, failure/resume,
checkpoint reuse, generation races, changed identities, cancellation and
schema/compiler agreement. Streaming input, graphical editing, action-document
awaiting and domain orchestration projections are separate contracts.

## Complete provider ingestion

`createIngestion({provider,store,source,maxPartitions?,maxPages?,maxRows?,maxBytes?})`
compiles one workflow over injected capabilities. It imports no provider or
persistence package. `provider.pages(input,context)` supplies bounded pages;
`store.begin/stage/invalidate/publish` supplies atomic persistence. The public
implementations are `compileProvider` from `@jarenjs/contract/provider` and
`createDbIngestionStore` from `@jarenjs/linq/db`.

```js
import { createIngestion } from '@jarenjs/flow';

const ingestion = createIngestion({ provider, store,
  source: async (plan, phase) => readSourceEvidence(plan, phase),
  maxPartitions: 8, maxPages: 32, maxRows: 4096, maxBytes: 1048576,
});
const result = await ingestion.run({
  source: 'inventory/test', version: 'source-snapshot-1', generation: 'pull-1',
  partitions: ['north', 'south'], input: {}, policyRevision: 'policy-1',
  consistency: 'snapshot',
}, { executor: providerRun, authority: providerRun, signal: providerRun.signal });
```

A plan has a source identity, source version, local generation, unique requested
partitions, JSON input and reconciliation policy revision. `consistency` is
`snapshot` (an upstream stable snapshot) or `revision` (an upstream monotonic
revision which changes with every relevant source mutation). The injected source
check returns `{version,consistency}` at start, after each page and before
publication. It must report actual upstream evidence, not echo local generation
numbers. Each page's version must match. A changed source invalidates staging;
a host may start a fresh generation after obtaining fresh source evidence.

The iterator resumes each unfinished partition from its committed continuation.
It waits for a page to commit before requesting another. No network request
holds a database transaction. Default aggregate limits are 64 partitions, 64
pages, 65536 rows and 16777216 bytes; counts include prior committed pages on
resume. The descriptor's page limits additionally bound an individual iterator.
An interrupted pull retains staging; failed/partial partitions never publish a
complete pointer. Pages reporting partial errors retain their exact raw wire
text and cannot complete a partition. Source-invalid pages within limits remain
inspectable but cannot certify completion.

Publication checks source and optional current authority again. For private
runs pass the same `withProviderRun` capability as executor and authority;
its publication gate suppresses callbacks after cancellation or revocation.
Returning `unchanged` requires matching source version, input, requested
partitions, consistency and policy revision, and produces zero fact writes or
revisions without requesting another page. A new source or policy revision
stages a new generation. The store owns transactional recovery; application
policy owns reconciliation, retention and downstream cutover.

DAG and workflow run options accept `resources` separately from JSON input.
Task handlers receive `(props, signal, resources)`; resources never participate
in checkpoint serialization, replay identity or trace output. A resource-bearing
run drains tasks on abort before settling so the caller can release its lease.
Tasks must return JSON results and keep resource handles out of their output.

## Domain run and external-effect adoption

`createExternalEffects({ store, executor, authorize, classify })` composes the
existing workflow engine with a mapped effect store and the public provider
executor. `run(operationId, { lease, signal? })` reads the reviewed plan,
reauthorizes resume and dispatch, and persists sending intent from the executor's
`beforeDispatch` hook. This runs after scheduler admission, immediately before
transport. A private one-attempt budget prevents executor retries from escaping
the durable per-leg budget. Only validated successful provider responses passed
through the host's `classify(response, plannedLeg)` become confirmed/rejected
public evidence. Timeout, abort, disconnect, invalid response or lost settlement
remain unresolved. Restart recovers stale sending intent without resending it.
Read-back and operator decisions use the store's explicit `reconcile` method.
Register `effects.handler` with the existing queue worker to pause unresolved or
refused operations in the queue's cancelled state. Explicit requeue/claim then
provides a fresh reconciliation fence; confirmed operations complete normally.

`createDomainRun(document, { store, schemaVersion, tasks })` compiles the existing
workflow once and binds its checkpoint CAS to application run records.
`run(id, input, { lease, signal?, event?, release?, ...resources })` preserves the
application run ID. `lease` may be a capability or a function returning the
worker's current renewed lease. Checkpoint provenance includes the canonical
workflow/schema identity and the engine's input/task-version identity.

`cancel(id, observedRevision, { actor, reason })` records explicit cancellation
intent, stops local task admission, signals and drains local workers, and waits
for their final observation and resource release. Remote workers see the durable
cancellation at the next checkpoint/admission boundary; a remote cancel request
may therefore return pending intent rather than completed cancellation. The
requesting contract must authorize the actor. A signal alone also requires
workers to drain; failed/cancelled observations use fixed public statuses without
raw exception messages. Attaching an observer is independent of starting/cancelling
a run. Reset is a separate, explicitly guarded store operation and cannot erase
business receipts or unresolved effects.
