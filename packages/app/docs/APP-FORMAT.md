# The Jaren App Format

**Version 0.1 — Specification**

Module: `@jarenjs/app`. This document is the contract for the Jaren
**app document** — a complete interactive application as one JSON value
— and for the loop that runs it. It builds directly on three published
contracts: [QUERY-FORMAT](../../json/docs/QUERY-FORMAT.md) (action and
`when` documents), [JSLT-FORMAT](../../json/docs/JSLT-FORMAT.md) (the
view stylesheet) and [VIEW-FORMAT](../../view/docs/VIEW-FORMAT.md) (the
vnode output vocabulary and renderer behavior).

## 1. Introduction

### 1.1 The loop

```
event → binding (§4) → action document (§3) → transition (§3.2)
      → invariant check (§6) → next state → subscriptions refresh (§5.3)
      → batched re-render (view stylesheet → vnodes → keyed DOM patch)
```

Everything the loop executes is compiled once, when the app document is
loaded. JavaScript participates only at **named, registered
boundaries**: effect handlers, subscription handlers, event-field
extractors (§5.4), registered widgets (§5.5), the `compileTypeTest`
hook and the `validateState` hook. Between the boundaries, everything
is data.

### 1.2 Conformance and normative language

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**,
**MAY**, and **OPTIONAL** are to be interpreted as described in
RFC 2119. A **producer** emits app documents and MUST emit documents
valid per §2–§5. A **runtime** (the reference implementation is
`createApp`) MUST reject invalid documents with the compile errors of
§10, MUST raise the runtime errors of §10 under the conditions
specified there, and MUST serialize dispatches per the transaction
model of §8.

One producer ships in this repository: `@jarenjs/linq/app` writes these
documents from typed JavaScript builders — the state's initial value
derived from its schema's defaults, the view the JSLT pen's stylesheet,
actions captured over §3.1's three names, and patch pointers derived
from the state shape — with `defineApp()` refusing at build time what
§4 and §6 would otherwise report per dispatch. Its mapping table is
[APP-PEN.md](../../linq/docs/APP-PEN.md); §2's document below
and the `contract/catalog.load/start` action of
[CONTRACT-FORMAT §11.1](../../contract/docs/CONTRACT-FORMAT.md) are
rebuilt through it byte for byte by that package's test suite. Nothing
in this package depends on it: the format is the contract, and a
document written by hand is the same document.

## 2. The app document

```json
{
  "$app": "0.1",
  "state":   { },
  "view":    [ ],
  "actions": { },
  "subs":    [ ]
}
```

- **`$app`** (OPTIONAL) — the format version. Absent implies `"0.1"`.
- **`state`** (OPTIONAL) — the initial state, any JSON value. Absent
  means the state starts `undefined`; a document SHOULD provide it.
  The state MUST be treated as immutable by every boundary function.
- **`view`** (REQUIRED) — a JSLT stylesheet document (bare rule array
  or envelope form), compiled per JSLT-FORMAT. Each render evaluates it
  against the current state; its output MUST be a single text or
  element vnode.
- **`actions`** (OPTIONAL) — an object mapping action names to action
  documents (§3).
- **`subs`** (OPTIONAL) — an array of subscription entries (§5.2).

Unknown top-level members MUST be ignored (forward compatibility).

## 3. Actions

### 3.1 The action document

An action is a Jaren JSON Query document evaluated with:

- **`$`** — the current state (the whole document; cross-cutting
  transitions are the point, exactly as in `x-form` rules);
- **`$event`** — when the dispatch originated from a DOM event, a
  serializable slice of it (below); otherwise `null`;
- **`$payload`** — the dispatch payload (§4); `null` when absent.

These three names are the whole ambient vocabulary. The runtime takes
the query's **first** result (`query.first` semantics).

For a DOM dispatch, `$event` is the default slice
`{ "type", "value", "checked", "key" }` **plus** one member per field
name the binding requested (§4's `event` member). Each requested name
is resolved in precedence order:

1. a host extractor registered under that name
   (`options.eventFields`, §5.4) — the host wins, so a host can also
   *override* a built-in;
2. the built-in allow-list below;
3. neither — the member is bound `null` and `JA2009` is reported,
   **without dropping the dispatch**: a typo in one field name MUST NOT
   swallow the user's event (contrast §4's `JA2001`, where the whole
   binding is unusable).

The built-in allow-list — every entry is a JSON primitive by
construction, `undefined` coerced to `null`:

- read from the event: `shiftKey`, `ctrlKey`, `altKey`, `metaKey`,
  `button`, `buttons`, `clientX`, `clientY`, `offsetX`, `offsetY`,
  `pageX`, `pageY`, `screenX`, `screenY`, `movementX`, `movementY`,
  `deltaX`, `deltaY`, `deltaMode`, `code`, `repeat`, `location`,
  `isComposing`, `detail`, `pointerId`, `pointerType`, `pressure`,
  `isPrimary`;
- read from `event.target`: `selectionStart`, `selectionEnd`.

`target` itself, `files`, touch lists, and every other
host-object-valued field are deliberately excluded: host objects never
enter `$event` — it MUST survive `JSON.stringify`, the same invariant
as state. When a host needs data only such an object can provide (file
selections, say), it registers an extractor that maps the object to a
JSON value at the boundary (§5.4).

### 3.2 The transition object

An action's result MUST be nothing (empty sequence, `null` — a no-op)
or a **transition object** with any of:

- **`state`** — the next state, whole. Replaces the state.
- **`patch`** — an RFC 6902 JSON Patch, applied copy-on-write to the
  state (after `state`, when both are present). Because the action is a
  query document, op members like `value` and `path` are themselves
  query expressions — computed at dispatch time from `$`, `$event` and
  `$payload`.
- **`effects`** — an array of effect invocations (§5.1), run after the
  state settles, in order, regardless of whether the state changed.

Order of application: `state`, then `patch`, then the invariant check
(§6), then `effects`, then (if the state reference changed)
subscription refresh and render scheduling. A failing `patch` aborts
the whole transition (`JA2004`): the copy-on-write engine guarantees
the state was never touched.

Change detection is **reference identity**: a transition whose result
is `===` the current state changes nothing, schedules nothing. The
copy-on-write patch engine and JSLT's structural sharing make reference
inequality mean real change, end to end — this is the same contract
VIEW-FORMAT §5.1 builds its fast path on.

One exception keeps controlled inputs correct: a transaction whose
**source is a DOM event** always schedules a **settlement** render, even
when it changes nothing (a no-op, a rejected or failed action, an
effects-only outcome). A user keystroke can move a controlled input off
authoritative state, and without a render the control would keep the
user's value; the settlement render lets VIEW-FORMAT §3 reassert it. It
is cheap — unchanged state re-projects to a reference-equal vnode the
patcher skips whole, leaving only the controlled reconciliation. A
programmatic `dispatch` is not a DOM event and does not force it.

A patch-only transition additionally yields its **changed paths**: the
runtime applies the patch with the engine's `changes` option and hands
the resulting JSON Pointers (invalidation-sound semantics, see the
`@jarenjs/json/patch` documentation) to state subscribers —
`listener(state, changes)` — with `changes = null` for whole-state
transitions, meaning "treat everything as changed". Dirty-path-pruned
re-rendering builds on this feed (roadmap); today the runtime itself
still re-runs the full view stylesheet per frame.

## 4. Event bindings

A vnode `on` binding (opaque to the view layer) is interpreted by this
format as either:

- a **string** — an action name; `$payload` is `null`; or
- an object **`{ "action": name, "with"?: payload, "event"?:
  [fieldName, ...], "preventDefault"?: bool, "stopPropagation"?:
  bool }`** — `$payload` is the `with` value, verbatim, and `event`,
  when present, MUST be an array of strings naming the extra `$event`
  fields to resolve (§3.1). The string binding form carries none of
  the optional members.

The two **native controls** default to `false` and are allowed only on
the object form. When declared `true` **and the named action is
registered**, `event.preventDefault()` / `event.stopPropagation()` run
**synchronously in the native event callback**, before the action is
queued (§8) and before the browser can perform its default or bubble
behavior — a checkbox, link or button nested inside a clickable row is
expressible declaratively. Only a registered action owns the native
behavior: an unknown action name suppresses nothing (the dispatch
still queues and reports `JA2001`). A registered action that later
fails keeps its already-applied controls — whether the action succeeds
or fails cannot retroactively change an already-performed native
control. A widget's `emit(binding,
nativeEvent)` follows the identical path. Headless dispatch with an
event object lacking the methods is a documented no-op.

`$event` extraction runs synchronously at dispatch time too: the
native event is reduced to plain JSON before the transaction enters
the queue, so a recycled event object can never corrupt a queued
dispatch. Requesting a **default member** (`type`/`value`/`checked`/
`key`) never overwrites it — it is already bound; a registered
extractor still wins, the host chose to redefine it. A requested
`__proto__`/`constructor` member binds as an ordinary own data
property and never mutates a prototype. Registered extractors are
trusted host code and MUST return JSON.

Payloads are built at *render* time by the view stylesheet: a rule
body may embed `"$path"`, the matched value, or anything in scope
inside the binding. Combined with §3's `$event`, this replaces both of
hyperapp's payload-creator forms with data. Extraction requests are
render-time data the same way: a JSLT rule builds them, so they are
serializable, schema-checkable and replayable.

```json
["tr", { "on": { "click": {
  "action": "selectRow",
  "with": { "id": "$.id" },
  "event": ["shiftKey", "ctrlKey", "metaKey"]
} } }, "…"]
```

The action then branches on `$event.shiftKey` to extend a selection
range instead of replacing it.

Anything else dispatched as a binding — including an object whose
`event` member is present but not an array of strings — is a producer
error (`JA2001` at runtime): the binding is unusable and the dispatch
is dropped.

## 5. The boundaries

### 5.1 Effects

An effect invocation is `{ "run": name, "with"?: props }`. The runtime
resolves `name` in the registered effect handlers
(`options.effects[name]`) and calls `handler(props ?? null, dispatch)`.
Effects are fire-and-forget from the loop's perspective; asynchronous
completion re-enters through `dispatch`. An unregistered name is
`JA2006`; a throwing handler is `JA2007`; neither aborts the loop or
the remaining effects. For asynchronous work, the shipped task
convention — request identity, stale-response rejection, cancellation,
and the `createTaskEffect` helper — is documented in
[TASKS.md](TASKS.md).

### 5.2 The derivation boundary

`options.viewModel` (OPTIONAL) maps the state to the view stylesheet's
input document before every render; default identity. It MUST be pure
(state in, document out, no dispatching) and is where JS-computed
derivations — `buildFormViewModel` from `@jarenjs/forms`, aggregations
the query language cannot express, memoized joins — enter the render
path without entering the state. This is the app-level generalization
of forms' layer-2 rule evaluation, kept at a boundary for the same
reason: derivations are recomputed, never dispatched.

### 5.3 Subscriptions

A subscription entry is `{ "run": name, "with"?: props, "when"?:
query, "withQuery"?: query, "key"?: query, "for"?: query }`. After
boot and after every state change, the runtime evaluates each entry's
`when` by **effective boolean value** against the current state (no
externals) and reconciles:

- newly live → `cleanup = handler(props, dispatch)`;
- newly dead → `cleanup()` if the handler returned one.

An absent `when` means always live while the app runs; `stop()` kills
all. Error policy, the mirror image of forms' `visible` rule: a
broken `when` fails **closed** — the subscription stops and the error
is reported — because a broken rule must never keep side effects
alive. An unregistered `run` name is `JA2008`, reported each time the
entry would start.

**Static versus dynamic props.** `with` is verbatim data — never
evaluated, and a static entry never restarts (the original contract,
preserved exactly). `withQuery` makes the entry DYNAMIC: a query
compiled like `when` and evaluated against the state per
reconciliation; its result (empty → `null`) is the handler's props. The
two are mutually exclusive (`JA0008`), because a member that is
sometimes data and sometimes executable is how a document becomes
accidentally executable.

**The restart rule.** A live dynamic subscription restarts — stop,
then start with the new props, within one reconciliation — exactly
when its **key** changes. The key derives from the resolved props BY
VALUE (`stableStringify`; structurally equal props share a key
regardless of member order), or from the explicit `key` query when
recomputing a deep key per transaction is worth opting out of
(`key` without `withQuery` or `for` is `JA0008`). A cyclic resolved
value cannot key and fails closed (`JA2016`) rather than hanging. An
unchanged key performs zero handler calls. A throwing cleanup is
isolated (`JA2012`) and never prevents the restart's start half; a
throwing start leaves the slot stopped (`JA2013`) until the next key
change retries it. This is the same "key plus supersede policy" shape
`createTaskEffect` (§9) models for effects — a reader who knows one
knows the other.

**Fan-out.** `for` names a query whose result is the entry's ITEM set
(one array value fans out over its elements; a single item over
itself; empty over none), and the runtime maintains **one instance per
item key** — `stableStringify(item)`, or the `key` query with `$item`
bound. `withQuery` (also with `$item`) shapes per-instance props;
without it the props ARE the item; `with` beside `for` is `JA0008`.
Reconciliation is deterministic: removed instances stop in their
previous order, then added — and changed, by resolved props value —
instances start in the document order of the item sequence; duplicate
keys collapse to the first occurrence. A resolution failure fails the
whole declaration closed (`JA2016`, naming the member). Exceeding
`maxSubInstances` (a `createApp` option, default 256) is `JA2017`, and
the previous instance set is KEPT — the bound is printed, never
silent.

**Scope.** Dynamic members are compiled closed-world: the only
external a document may reference is `$item`, and only under `for` —
any other free variable is `JA0008` at compile time. Reconciliation
runs when the state changed, which is precisely correct for
state-derived keys and props; a key derived from anything outside the
state is NOT supported, and no member sees the DOM, the clock or the
host.

### 5.4 Event-field extractors

`options.eventFields` (OPTIONAL) is a `Record<string, (nativeEvent:
any) => any>` of named JavaScript extractors — the same philosophy as
effects and subscriptions: JavaScript enters only at named, registered
boundaries. When a binding requests a field (§4), an extractor
registered under that name takes precedence over the built-in
allow-list (§3.1). The extractor receives the native event and MUST
return a JSON value; `undefined` is coerced to `null`. An extractor
that throws surfaces as the dispatching action's `JA2002`.

`createFileTokenRegistry` from `@jarenjs/app/file-tokens` supplies a
bounded owner for native `File` objects. Its extractor returns opaque
strings; neither a File nor a signing key enters the app document:

```javascript
import { createApp } from '@jarenjs/app';
import { createFileTokenRegistry } from '@jarenjs/app/file-tokens';

const files = createFileTokenRegistry({ runtime, ttlMs: 300_000,
  maxFiles: 8, maxBytes: 32 * 1024 * 1024 });
const releaseFiles = Object.assign(({ tokens }) => files.release(tokens), {
  dispose: files.dispose, // app.destroy() invokes the existing effect disposer
});
const app = createApp(doc, {
  node, eventFields: { fileTokens: files.extract },
  effects: { releaseFiles },
});
```

A binding `{ "action": "pickFiles", "event": ["fileTokens"] }` then
binds `$event.fileTokens` to an array of strings. Guard the action with
`{ "$ne": ["$event.fileTokens", null] }`: an extractor refusal reports
`JA2002` with the registry code as its cause and binds the field to
`null`. Keep the previous selection on that refusal. Disable further
selection until upload or explicit cancel, or retain all outstanding
tokens in a bounded application list; replacing the state array alone
does not release its Files.

| Member | Contract |
|---|---|
| `register(files)` | Native `FileList` or `ArrayLike<File>`; returns a frozen token array in selection order. The whole selection fits or is refused before registration. Active tokens are never silently evicted. |
| `extract(event)` | Calls `register(event.target?.files ?? [])`; compatible with `eventFields`. |
| `take(token)` | Atomically removes and returns the exact native `File` once. Unknown, foreign, expired, released or disposed tokens return `null`. The caller owns a taken File. |
| `release(tokens)` | Releases remaining references and returns their count. Duplicate/unknown tokens do nothing; at most 4096 token arguments per call. It works without consulting the clock. |
| `stats()` | Frozen `{ files, bytes, maxFiles, maxBytes, disposed }` after expiry cleanup. Bytes are the sum of native File sizes, not process memory. |
| `dispose()` | Idempotently closes admission and drops all registry references. `take` returns `null`, `release` returns zero, `stats` remains available, and registration throws `JA2020`. |

Defaults: `ttlMs=300000`, `maxFiles=32`, `maxBytes=67108864`. All
limits are positive safe integers; `maxFiles` is capped at 4096.
Expiry is inclusive (`now >= expiresAt`); registration, take and stats
sweep expired references. There is no background timer: dispose the
owner when its route/session ends. `runtime` uses the shared core
runtime; explicit `now` and `mintToken` callbacks override its clock
and per-token UUID provider. Time is epoch milliseconds. Each registry
also needs a fresh namespace from `runtime.uuid()`; injected providers
must honor that fresh-identifier contract. A monotonic serial prevents
stale tokens rebinding even when a custom suffix minter repeats.
Identifiers use 1–128 ASCII letters, digits, hyphens or underscores.

A host can consume a token for a bounded upload/commit operation:

```javascript
const file = files.take(token);
if (file === null) return { ok: false, kind: 'missing-file' };
// The host now owns this File, its AbortController and retry budget.
const uploaded = await client.bytes('upload', { id: uploadId }, {
  body: file.stream(), signal, attempt: 1,
});
if (!uploaded.ok) return uploaded;
await uploaded.value.body?.cancel(); // release an unused response stream
return client.invoke('commit', { id: uploadId, name: file.name }, { signal });
```

The contract client's byte operation never retries automatically. An
explicit retry needs a new `file.stream()` from the same taken File,
a finite attempt budget and the host's upload/receipt policy. Drop the
taken reference on success, cancellation or abandoned retry; it no
longer belongs to registry statistics or expiry. An upload followed by
a JSON commit is not one transaction: uncertain commits need a durable
receipt and reconciliation at the host. Cancel a queued selection with
`files.release(tokens)` before clearing state. Abort active uploads on
owner teardown, and revoke any object URLs the host created. The
registry creates no object URLs and grants no upload authorization.

Direct helper calls throw `AppRuntimeError`: `JA2018` for malformed
options, clock or native File selection; `JA2019` for a count, byte or
lifetime bound; `JA2020` for closed admission; `JA2021` for malformed
identifiers or reentrant operations. Unexpected host callback failures
are normalized without retaining the callback's cause or File objects.

### 5.5 Widgets

`options.widgets` (OPTIONAL) is a `Record<string, WidgetDef>` of
registered widget definitions for `jaren-widget` vnodes — JavaScript
enters only at named, registered boundaries, the same sentence shape
as effects and subs. The mechanism lives entirely in `@jarenjs/view`
(the vocabulary, lifecycle and reconciliation semantics are
VIEW-FORMAT §7); `createApp` only forwards the registry to the
renderer it creates — the dependency arrow stays one-way. A widget's
`emit` delivers ordinary §4 bindings, so widget events dispatch
through the same `handleBinding` path as any DOM event — including
§4's `event` extraction member.

## 6. Invariants

When `options.validateState` is present, every candidate next state
that differs (by reference) from the current state is passed to it. A
rejection — `false`, or an object with `valid: false` — blocks the
transition entirely (**fail closed**, matching `x-form.assert`): the
state does not change, no effects run, and `JA2005` is reported with
the hook's `errors` in `detail`.

The intended hook is a compiled `@jarenjs/validate` schema — including
`$query` cross-field assertions, so generated or replayed transitions
are checked for internal consistency, not just shape. The app package
never imports the validator; like forms, the application holds the key
(`compileTypeTest` for schema operators inside documents,
`validateState` for the authoritative check).

## 7. Serialization, replay, SSR (non-normative)

Because state, view, actions and subs are one JSON value and every
dispatch is `(name, payload)` — also JSON — the following are
compositions, not features: state snapshots, action logs, time-travel
(replay the log through a fresh `createApp` — with the LIVE effect and
subscription handlers stubbed or replaced, since replaying a log
re-runs its transitions but must not re-fire real side effects;
replaying recorded effect *outcomes* is an open follow-up, not a
shipped capability), server rendering
(`renderToString(app.getVnode())`), and remote mutation (ship a
transition's `patch` over the wire). Runtimes SHOULD keep it that way:
any extension that puts a function in the document breaks the format's
core property.

## 8. The transaction model

### 8.1 One FIFO queue

Every dispatch is one **transaction** on one FIFO queue; only the
queue drain evaluates and applies transitions. A dispatch made from an
effect handler, a state listener, a transaction observer, a
subscription handler or callback, a widget `emit`, or any lifecycle
hook **queues behind the current transaction** — dispatches never
nest. `setState` (§8.5) is a transaction on the same queue, so nothing
that changes state runs outside it. Within a transaction the order is
fixed:

1. action evaluation and state commit;
2. effect invocation;
3. listener notification (registration order — every listener observes
   every transaction in the same order, with the state produced by
   exactly that transaction and its changed paths);
4. subscription reconciliation;
5. render scheduling;
6. observer notification (§8.3).

All six complete before the next transaction begins. Errors from
isolated sites — listeners (`JA2011`), observers (`JA2011`), cleanups
(`JA2012`) — are reported through `onError` and never corrupt the
queue: whatever the sink throws surfaces to the outermost dispatch
caller only after the drain fully completed. A runaway
action→effect→action loop is diagnosed as `JA2010` after
`options.maxTurns` transactions (default 1000) instead of hanging;
`maxTurns` MUST be a positive finite integer — `createApp` rejects
anything else (a guard that silently coerces is no guard).

`validateState` is host code and may itself fail: a throwing validator
is isolated as `JA2015` — the transaction fails (its observer record
carries the code), the original cause is preserved, and the queue
keeps draining; parked errors from the default rethrowing sink surface
only after the drain.

`validateState` receives a second argument, the transaction context
`{ previous, action, payload, changes }` — `changes` is the patch
engine's changed-pointer list, or `null` meaning *unknown: validate
fully*. Selective validation keyed on `changes` is sound only when the
hook falls back to a full check for `null`.

### 8.2 Boot, stop, destroy

**Boot is a transaction.** Compiling the documents, creating the
renderer, validating the initial state, starting the initial
subscriptions, painting the first frame and draining the dispatches
those handlers queued either all succeed, or every already-acquired
resource — subscriptions, effect handlers, the renderer (the container
ends empty, scheduled work becomes a no-op) — is disposed and
`createApp` throws `JA0007` with the original failure as `cause`.
`onError` observes individual boot failures first: a sink that
swallows a subscription-start failure (`JA2013`), the initial-state
check (`JA2005`/`JA2015` with the boot context `{ previous: null,
action: null, payload: null, changes: null }`) or an error inside
queued boot work recovers it and boots the rest; renderer-construction
and first-frame failures are always fatal; the default rethrowing sink
aborts boot on any of them. No failure path leaves a live
subscription, a populated container or an unreturned app handle
behind. Boot is SCHEDULER-INDEPENDENT: every frame the boot
transaction produces commits inside the boot window (never on a later
microtask), so the deferred first `afterRender` always acts on the
final boot DOM — a boot subscription that changes state and queues a
focus intent settles identically under the synchronous and the
default scheduler. Effect-handler identities are snapshotted inside
the boot rollback BEFORE any resource is acquired: disposal never
re-enumerates a host registry at destroy time, and an unenumerable
registry rejects the boot (`JA0007`) while nothing is owned yet.

**Subscription startup is resource acquisition.** A slot commits live
only after its handler returned; a throwing handler leaves the slot
stopped (`JA2013`). Cleanups run exactly once, a throwing cleanup is
isolated (`JA2012`) and never skips its siblings. Because dispatches
queue, a condition flipped by a starting handler is observed by the
next transaction's reconciliation, which disposes the just-started
resource through the ordinary stop path — rapid `false`/`true`
condition changes coalesce per transaction.

**`stop()` halts; `destroy()` ends.** `stop()` is one-way and
nonterminal — there is no resume: it clears the queue, disposes live
subscriptions and listeners, and permanently ignores further
dispatches; the renderer and effect handlers stay untouched.
`destroy()` is terminal and idempotent: `stop()` plus observer
removal, effect-handler `dispose()` (each handler identity exactly
once), and renderer destruction — widgets unmount exactly once, the
container is left empty, and scheduled render flushes become exact
no-ops.

### 8.2.1 DOM profiles and host capability grants

`createApp` forwards `safe`, `onUnsafe` and `hydrate` to its DOM renderer
(VIEW-FORMAT §6/§8). `capabilities` optionally grants names from the host's
`effects`, `subs`, `widgets` and `eventFields` registries:

```js
const app = createApp(doc, {
  node, safe: true, onUnsafe: report,
  effects: { load },
  capabilities: { effects: ['load'] },
});
```

When `safe: true` or `capabilities` is supplied, omitted grant lists are empty.
Unknown or inherited registry names are refused at construction. Only granted
effects belong to this app's disposal lifecycle. Without either option, the
existing registered capabilities remain available. Safe mode still removes
DOM event bindings and widgets; a widget grant does not override that display
policy. A trusted interactive app can use explicit grants without `safe`.

The action vocabulary is local to the app document. Effect/subscription/widget
registries and custom event fields are host boundaries. These controls bound
named host access, not CPU, memory, native navigation or network loads; they
are not a browser security sandbox. Hosted documents still require a deliberate
trust policy.

### 8.3 Transaction observers and diagnostics

`app.observe(fn)` delivers one bounded JSON record per settled
transaction: `{ seq, action, source, status, changedPaths,
scheduledEffects, durationMs, errorCode }` — `source` is
`'dispatch'`/`'binding'`/`'effect'`/`'subscription'`, `status` is
`'applied'`/`'noop'`/`'rejected'`/`'failed'`. Payload/event values are
included **only** when the app was created with `capturePayloads:
true` — diagnostics must not leak data by default. A throwing observer
is isolated (`JA2011`). `createTransactionLog({ limit, redact })`
packages the bounded ring buffer with a redaction hook and a versioned
`export()` envelope; the log lives in host memory, never in state.

### 8.4 The post-render focus/measurement queue

DOM nodes never enter state; focus, selection and measurement bridge
through JSON intents naming a `data-ref` attribute token.
`createFocusEffect({ container })` returns an effect handler whose
intents `{ ref, op?: "focus"|"select"|"measure", done?, id? }` queue
during the transaction and flush after the **next committed frame** —
wire its `flush` as `options.afterRender`. `afterRender` is a
**committed-live-frame boundary**: it runs exactly once per settled,
nonterminal committed frame — after the DOM patch *and* after widget
mounts, so a target born in the same transition is already connected;
when a widget hook error was parked during the frame, `afterRender`
runs BEFORE that error is delivered (the frame committed; error
delivery cannot starve its callback); and it never runs for a pass
that ended in terminal teardown (there is no live frame to act on).
Boot is ATOMIC for the callback: frames committed during the boot
transaction defer, and one `afterRender` fires only after the entire
boot — queued boot drain included — succeeded. A failed boot never
fires it, so no post-render side effect can escape a boot that rolled
back; a deferred callback's own failure follows boot policy (a
swallowing sink recovers it; an escaping failure rolls back as
`JA0007`). A missing target is a diagnosable
`JA2014`, never a silent no-op; sibling intents still resolve.
`measure` dispatches `done` with `{ id, ref, rect }`, the JSON-reduced
bounding rect. `app.destroy()` cancels pending intents through the
handler's `dispose()`. A headless app never flushes — the queue is a
documented no-op there.

### 8.5 `setState` is a transaction

`app.setState(next)` replaces the whole state from OUTSIDE the action
loop — SSR hydration, or a studio hot-swapping an edited `state` block
into a running app without a reboot. It runs no reducer and no effects,
notifies listeners with `null` changed-paths, refreshes `when`-gated
subscriptions and schedules one render.

It is public, so it is a contract, and it holds every guarantee §8.1
gives a dispatch:

- it **takes its turn** in the FIFO queue, so a replacement requested
  from inside a listener, effect or subscription handler queues behind
  the transaction that is running rather than interleaving with it;
- `validateState` **decides before the commit**, with the context
  `{ previous, action: null, payload: null, changes: null }` — `action`
  is `null` because no reducer ran, and `changes` is `null` because a
  replacement changes everything. A rejected replacement is `JA2005` and
  the state stands;
- every listener observes the SAME state, in registration order;
- the turn guard counts it, so a `setState` loop is `JA2010` rather than
  a hang;
- observers see one record, `source: 'setState'`, `changedPaths: null`;
- a parked sink failure settles **at the `setState` caller**, not out of
  the next unrelated dispatch.

A reference-identical replacement is a `noop`; a call after `stop()` or
`destroy()` does nothing.

### 8.6 Subscription ownership

A subscription slot is OWNED from before its handler runs, not from
after it returns. A handler is host code and can reach the app surface,
so it can re-enter reconciliation; a slot that only became live on the
way out looked startable to that re-entry, started again, and each
return overwrote the single cleanup slot — leaking every acquisition but
the last, past `destroy()`. The claim-first rule means one live slot is
one start and one release, whatever the handler does.

The `for` fan-out bound (`maxSubInstances`) stops the WORK, not just the
retention: enumeration halts the moment the bound is crossed and reports
`JA2017` with how many items were left. Bounding only what is kept still
ran every key and props expression of a runaway query first, so the
limit cost memory and CPU proportional to the mistake it existed to
contain.

### 8.7 Dialog widget and accessible component contracts

`createDialogWidget({ widgets? }?)` from `@jarenjs/app/dialog` registers
a modal using the view layer's [native dialog owner](../../view/docs/VIEW-FORMAT.md#75-native-modal-dialog-owner).
The renderer's existing mount/update/unmount lifecycle owns every
listener and nested content widget. DOM values remain outside state:

```javascript
import { createDialogWidget } from '@jarenjs/app/dialog';
const widgets = {};
widgets.dialog = createDialogWidget({ widgets });
const app = createApp(doc, { node, widgets });
```

An ordinary `jaren-widget` uses these JSON props:

```json
["jaren-widget", {"name":"dialog", "key":"settings", "props": {
  "id":"settings", "title":"Settings", "open":true,
  "initialFocusRef":"name", "fallbackFocusRef":"settings-opener",
  "close":"closeSettings", "closeLabel":"Close",
  "content":["input", {"data-ref":"name", "aria-label":"Name"}]
}}]
```

`close` is an action name or an ordinary `{ action, with?, event? }`
binding. Escape and the visible close button emit that binding; its
action must change `open` to false or remove the widget. This keeps a
confirmation policy in app state. A missing close action is `JA2022`.
For a state-driven stylesheet, set `open` to `"$.dialog.open"` in the
template. Other props follow VIEW-FORMAT §7.5. Child widgets receive
the supplied `widgets` registry, so nested dialogs reuse the same
definition. Closing a parent destroys its content owners first.

The native browser owns background inertness and modal stacking. The
helper handles visible naming, both Tab boundaries, chosen initial
focus, disconnected opener fallback, dynamic content and cleanup.
Existing §8.4 focus intents use the same `data-ref` resolver and can
still target a control after a frame commits. Chromium, Firefox and
WebKit exercise these behaviors; this is not physical screen-reader
or assistive-technology qualification.

The format's accessibility position: **the widget escape hatch is not
an accessibility escape hatch**, and the primitives above exist so the
accessible patterns are expressible as data.

- **Dialogs**: use the owned widget above, or compose an explicit
  dialog with the view helper. The original §8.4 focus-queue skeleton
  remains a test of post-render intent ordering.
- **Tabs**: a tablist/tab/tabpanel triple is ordinary vnode data —
  `role`/`aria-selected`/`aria-controls` are props like any other, and
  arrow-key movement is a `keydown` binding requesting `key` (§3.1).
- **Rows with nested controls**: `stopPropagation` on the nested
  binding (§4) keeps a checkbox or link inside a clickable row from
  triggering the row action; `preventDefault` expresses suppressed
  native behavior declaratively.
- **Widgets** own the complete keyboard, focus and announcement
  behavior of their subtree — the renderer guarantees only mount/
  update/unmount-exactly-once (VIEW-FORMAT §7); everything inside
  is the widget contract's responsibility.
- These contracts are tested headlessly in this repository, and the
  **lifecycle** half is additionally exercised against a real
  Chromium/Firefox/WebKit matrix on every push (see
  [the website's browser suite](../../website/README.md#browser-tests)):
  boot with landmark semantics, client-side navigation mount/unmount,
  keyboard activation of the router, and rapid route churn, each
  asserting zero page errors under real engine scheduling. What that
  matrix does **not** yet cover — and this document does not claim — is
  physical screen-reader/AT semantics and
  `prefers-reduced-motion`. Those remain open and are tracked in the
  roadmap.

### 8.8 Hash and history route subscriptions

`createHashRouteSubscription(options?)` and
`createHistoryRouteSubscription(options?)` from `@jarenjs/app/routes`
return a subscription handler with `navigate`, `replace`, `refresh`
and `dispose` controls. One factory owns one active subscription and
its native listeners. Stop it before reusing it for another app:

```javascript
import { createHistoryRouteSubscription } from '@jarenjs/app/routes';
const routes = createHistoryRouteSubscription({ window, basePath: '/app' });
const app = createApp({
  state: { route: null }, view: [{ match: '$', body: ['main'] }],
  actions: { arrived: { patch: [
    { op: 'replace', path: '/route', value: '$payload' },
  ] } },
  subs: [{ run: 'routes', with: { action: 'arrived' } }],
}, { subs: { routes } });
routes.navigate('/app/items?tag=one&tag=two#details');
routes.replace('/app/items?tag=three');
// app.stop()/destroy() run the returned subscription cleanup.
app.destroy();
routes.dispose(); // optional terminal disposal of the reusable factory
```

Each initial subscription synchronously dispatches one frozen JSON
record. Distinct observed addresses then dispatch once; identical
refreshes or paired native events are deduplicated:

| Field | Meaning |
|---|---|
| `mode` | `hash` or `history`. |
| `path` | URL pathname relative to `basePath`, with a leading slash. Percent escapes remain encoded, so `%2F` is not mistaken for a path separator. |
| `query` | Frozen object of frozen string arrays. Repeated keys retain their encounter order; even a single value is an array. Prototype names are ordinary own keys. |
| `fragment` | Inner fragment without `#`, still percent-encoded. In hash mode this is the second hash, inside the route. |
| `raw` | Original location hash in hash mode; pathname+search+hash in history mode. Adapters can preserve their own existing route grammar. |

Parsing follows URL pathname normalization and URLSearchParams query
decoding: plus becomes a space, malformed percent escapes remain
literal where possible and invalid UTF-8 becomes U+FFFD. No implicit
path decoding changes an encoded separator. A base path matches a
whole segment prefix (`/app` also matches `/app/`, but not `/apple`).
The default base is `/`. A history deployment still needs its server
to serve the application at deep links; the helper does not configure
server fallback routing.

Hash mode observes `hashchange`; history mode observes `popstate` and
fragment `hashchange`, deduplicating their current address. Native
events publish the address visible when observed; they are not a
durable log of every transient external write. `navigate(target)` and
`replace(target)` use owned pushState/replaceState calls and publish
immediately in both modes. They do not synthesize global native events
or monkey-patch history. Hash targets can be `#/path`, `/path` or a
same-origin full URL that retains the outer pathname/search. History
targets resolve against the current URL and must remain inside the
base. Navigation permits HTTP(S) on the current origin without URL
credentials. A no-change target publishes no duplicate record.

External pushState/replaceState calls do not emit popstate: call
`refresh()` after them, or adapt a host-owned router to dispatch the
same application action. New history entries carry null state;
replacement preserves the current history state. Use the host's own
router when it needs another history-state policy.

Bounds are explicit: `maxLength=8192` URL code units (hard maximum
65536), `maxQueryEntries=128` including repeats (maximum 1024), and
`maxTurns=64` queued deliveries per synchronous drain (maximum 1024).
Navigation validates these limits before changing history. Reentrant
redirects queue in order and cannot grow the call stack without a
bound. Earlier accepted navigations remain in history if a later
redirect exceeds its budget. Only one active subscriber is admitted;
each stop is idempotent and stale cleanup cannot stop a later owner.
Disposed or inactive controls refuse; unsubscribe permits another
subscription, while `dispose()` is terminal.

Options accept an injected `window` (default current browser window)
and optional `onError(error)` for native event errors. Direct calls
throw; without a sink, native event errors also surface. Codes:
`JA2023` malformed host/input/action, `JA2024` URL/origin/protocol/base
refusal, `JA2025` bounds, `JA2026` unavailable subscription ownership.
Initial delivery failure removes every listener it acquired. A host
must configure its action/error policy; these helpers add no auth or
application page vocabulary.

The website uses the shared hash owner with a 65536-character/1024-query
ceiling to accommodate its existing share-token budget. Its page adapter
still consumes `raw`, preserving its established last-value query and
unknown-page rules.

## 9. Tasks and host concurrency

### 9.1 The convention

The async-task convention (state-side ids + guard-first completion
actions) is specified in [TASKS.md](./TASKS.md); its host half is
`createTaskEffect(run, options)`.

### 9.2 Concurrency modes and controls

`createTaskEffect` takes a per-slot concurrency `mode`:

| Mode | A new start while the slot is busy… |
|---|---|
| `"switch"` (default) | aborts the in-flight predecessor; newest wins |
| `"exhaust"` | is ignored entirely — the double-click-safe commit mode |
| `"concat"` | queues and runs strictly after — deliberately ordered commands |
| `"parallel"` | runs concurrently; the consumer owns the merge rule |

Whatever the mode, correctness stays visible in JSON state — the task
slot's monotonic `id` and the completion action's guard remain the
authority on which response may land. The handler exposes
`cancel(slot)` (abort in-flight, discard queued), `cancelAll()`, and
`dispose()` (terminal: nothing dispatches afterwards; called
automatically by `app.destroy()`). `run` is invoked through a uniform
promise boundary: a synchronous throw and a non-promise return settle
through the same path as a rejection/resolution.

### 9.3 Structured failure — `projectError`

By default a non-abort rejection settles as `{ id, error }` with `error`
a **string**. That flattens what an HTTP host knows about a failure —
status, a stable error code, safe details — so `createTaskEffect` takes
an optional `projectError(err, props) => JSON` that produces the `error`
member instead. The rules that keep the door narrow:

- an `AbortError` never reaches the projector — cancellation dispatches
  nothing, as before;
- the projector receives the rejection value and the effect props
  verbatim (so it can name the operation the failure belongs to);
- its result must be JSON. A projector that throws, returns `undefined`
  (declines) or returns a value JSON cannot carry — an `Error`, a
  `Response`, a function, a class instance, a cycle, a non-finite number
  — falls back to the string projection. Settlement therefore stays
  total, and no host object enters state through this path;
- a non-function `projectError` is a `TypeError` at construction (a host
  programming error).

The completion action stores whatever it is handed; the state schema is
where the projected shape is pinned.

## 10. Errors

### 10.1 The host-failure normalization policy

JavaScript's `throw` accepts any value — `null`, `undefined`, strings,
numbers, arbitrary objects — and every host extension point (effects,
subscriptions, validators, event extractors, listeners, observers,
widget hooks, error sinks) may produce any of them. One shared policy
covers them all:

- every caught value is treated as `unknown`; no boundary ever reads
  `.message` off a raw caught value;
- an `Error` instance passes through BY IDENTITY wherever a contract
  promises the original as `cause`;
- a non-Error value is wrapped in a `HostValueError` whose message
  describes the value **without invoking user coercion** (a hostile
  `toString` is never called) and which retains the original value as
  an OWN `cause` property — set even for `undefined`, so
  `Object.hasOwn(err, 'cause')` distinguishes "threw undefined" from
  "no cause";
- parked failures use presence records, never the thrown value itself
  as the absence sentinel — a thrown `null` still counts, still
  surfaces, and still surfaces BY IDENTITY to the outermost caller;
- event extraction reports tagged outcomes: a thrown `undefined` is a
  failure (`JA2002`), structurally distinct from an unknown field
  (`JA2009`);
- direct and deferred teardown behave identically, all sibling
  listeners, cleanups, queued transactions and renderer teardown
  complete before the first sink failure surfaces, and terminal
  idempotence survives any cleanup failure;
- the policy is TOTAL: no operation performed while handling a caught
  value may itself escape. Classification (`instanceof Error`) and
  every diagnostic property read (`message`, `name`) run inside
  nonthrowing accessors, and value description uses only untrappable
  conversions — a revoked `Proxy`, a throwing trap, a hostile
  `message` accessor or a booby-trapped `toString`/`Symbol.toPrimitive`
  degrades the *description*, never the guarantee. An `Error` whose
  diagnostics are hostile still passes as `cause` by identity, with a
  safe projected message beside it; a value whose classification
  throws wraps like any non-Error;
- dual failures stay observable in their own frame: when both
  `afterRender` and a widget hook fail in one frame, a collecting sink
  receives the `afterRender` failure first and the parked hook failure
  second — in that frame, never a later one. Under the default
  rethrowing sink, ALL values the sink threw during one drain cross
  the caller boundary together: one value by identity, several as one
  `AggregateError` over the originals in report order. The collection
  is FRAMEWORK-OWNED — appending performs no reflection or coercion on
  a sink-thrown value, and a host-created `AggregateError` (the
  framework's own envelope message included) stays ONE element by
  identity, never flattened;
- capability ACQUISITION is part of the boundary: reading an optional
  host method — an effect handler's `dispose`, a widget definition's
  `update`/`unmount`, a registry member — executes host code when the
  host used an accessor or proxy, so the read shares the isolation
  boundary and the failure policy of the invocation. A hostile
  `dispose` lookup is a cleanup failure (`JA2012`) after which later
  disposers and renderer teardown still run; a hostile `unmount`
  lookup is collected like a throwing unmount, every sibling still
  unmounts and the container empties; a hostile `update` lookup
  poisons the widget exactly like a throwing update, the frame
  settles, and the next render replaces it; hostile effect/
  subscription registry reads report `JA2007`/`JA2013` and the loop
  drains on;
- one `app.destroy()` delivers ONE `JA2012`: a single cleanup failure
  is its cause by identity; several aggregate in occurrence order
  (subscription cleanups, then effect disposal, then the renderer
  walk — whose own frame envelope arrives as one element). This holds
  for an IN-HOOK destroy too: when a widget hook calls
  `app.destroy()` and the renderer teardown defers to the end of the
  active pass, the collector stays open and delivers once, after that
  teardown completes. Outside `destroy()` — `stop()`, per-transaction
  reconciliation — each cleanup failure reports its own `JA2012`, as
  before;
- task settlement is total: abort classification reads the rejection
  value's `name` through a safe accessor (the signal never suppresses
  — a superseded task's non-abort failure still dispatches, the
  state-side id guard is the authority), every non-abort rejection
  produces exactly one `{ id, error }` settlement dispatch, and a
  settlement dispatch that itself throws is re-raised on its own
  microtask so the host's global error handling observes it — never a
  framework-originated unhandled promise rejection.

Compile (`AppCompileError`, thrown by `createApp`; `docPath` is a JSON
Pointer into the app document):

| Code | Condition |
|---|---|
| `JA0001` | the app document is not an object |
| `JA0002` | `view` missing or failed to compile |
| `JA0003` | `actions` is not an object |
| `JA0004` | an action document failed to compile |
| `JA0005` | `subs` is not an array |
| `JA0006` | a subscription entry is malformed / its `when` failed to compile |
| `JA0007` | boot failed after compilation (renderer construction, initial-state check, initial subscriptions, first frame or queued boot work); everything acquired was rolled back (§8.2) |
| `JA0008` | a subscription dynamic member (`withQuery`/`key`/`for`) failed to compile, or the members combine invalidly (§5.3) |

Runtime (`AppRuntimeError`, routed through `options.onError`, which
defaults to rethrowing):

| Code | Condition |
|---|---|
| `JA2001` | unknown action name, or unusable binding |
| `JA2002` | an action or `when` document threw while evaluating, or a registered event-field extractor threw (the member is bound `null`; the dispatch is NOT dropped) |
| `JA2003` | a transition is not an object / `effects` not an array |
| `JA2004` | a `patch` failed to apply (transition aborted) |
| `JA2005` | `validateState` rejected the next state (transition blocked) |
| `JA2006` | unregistered effect name |
| `JA2007` | an effect handler threw |
| `JA2008` | unregistered subscription name |
| `JA2009` | a binding requested an unknown event field (the member is bound `null`; the dispatch is NOT dropped) |
| `JA2010` | the dispatch loop exceeded `maxTurns` in one drain; the queue was abandoned (§8.1) |
| `JA2011` | a state listener or transaction observer threw (isolated) |
| `JA2012` | a cleanup threw while stopping/reconciling/destroying (isolated; a widget `unmount` failing during renderer teardown — deferred teardown after an in-hook `destroy()` included — reports here with the first host cause preserved, after every sibling cleaned up) |
| `JA2013` | a subscription handler threw while starting; the slot stays stopped |
| `JA2014` | a post-render intent named a `data-ref` with no rendered target (§8.4) |
| `JA2015` | the `validateState` hook itself threw (the transaction failed; the queue keeps draining) |
| `JA2016` | a subscription dynamic query (`withQuery`/`key`/`for`) threw while evaluating — cyclic resolved values included; the subscription failed closed (§5.3) |
| `JA2017` | a subscription fan-out resolved more instances than `maxSubInstances`; the previous instance set was kept (§5.3) |
| `JA2018` | file registry options, clock or native File selection are malformed (§5.4; direct helper calls throw) |
| `JA2019` | a file registry count, byte or lifetime bound would be exceeded; the selection is refused atomically (§5.4) |
| `JA2020` | registration attempted after file registry disposal (§5.4) |
| `JA2021` | a file registry identifier is malformed or a host callback reentered an operation (§5.4) |
| `JA2022` | a dialog widget has no usable close action binding (§8.7) |
| `JA2023` | route host options, subscription action or navigation input are malformed (§8.8) |
| `JA2024` | route URL, origin, protocol or base-path boundary refuses navigation (§8.8) |
| `JA2025` | a route URL, query-entry or delivery bound would be exceeded (§8.8) |
| `JA2026` | route owner is disposed, inactive or already has an active subscription (§8.8) |

Wrapped causes are preserved on `error.cause`; compile errors from
embedded documents keep their own codes (`JQ...`, `JT...`) there —
with their `docPath`s pointing inside the embedded document, the
feedback shape a repair loop needs.

## 11. Open items (roadmap, non-normative)

- ~~The app-document meta-schema~~ — **shipped**:
  [`schemas/jaren-app.schema.json`](../schemas/jaren-app.schema.json)
  (draft 2020-12, with a mechanically derived draft-07 twin) composes
  the published query and JSLT grammars by `$ref`; register those
  artifacts alongside it. A constrained decoder held to it cannot emit
  a structurally invalid application — and the test suite validates
  the production website's own app document against it.
- ~~The standard forms stylesheet~~ — **shipped**: `createFormView` /
  `createFormActions` render any `@jarenjs/forms` model through one
  rule set. What remains of the idea is the other half — generalizing
  `x-form`'s derivation vocabulary (`computed`/`visible`) to app-level
  derived state, and letting a stylesheet replace the view-model
  composition itself, which needs a language primitive this format does
  not have (see ROADMAP, `@jarenjs/forms`).
- ~~Dirty-path-pruned re-rendering~~ — largely **shipped** through the
  other side: the JSLT `memo` option makes unchanged subtrees return
  reference-equal vnodes the renderer skips in O(1); prepass-level
  pruning of match evaluation remains open (see ROADMAP).
- ~~Unifying the write path~~ — **shipped**: `@jarenjs/json/write`
  `parents: 'create'` + undefined-deletes is now exactly forms'
  `setValueAtPointer`, on the shared copy-on-write kernel.
- **Async action documents** — the effect→dispatch convention for
  asynchronous work is now documented and helper-backed
  ([TASKS.md](TASKS.md): task-slot identity, stale-response rejection,
  `createTaskEffect`); what remains open is a first-class *awaiting
  disposition* — an action that suspends on an effect's settlement and
  transitions with its result, instead of completing through a second
  dispatched action.
