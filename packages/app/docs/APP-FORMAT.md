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
      → invariant check (§6) → next state → subscriptions refresh (§5.2)
      → batched re-render (view stylesheet → vnodes → keyed DOM patch)
```

Everything the loop executes is compiled once, when the app document is
loaded. JavaScript participates only at **named, registered
boundaries**: effect handlers, subscription handlers, the
`compileTypeTest` hook and the `validateState` hook. Between the
boundaries, everything is data.

### 1.2 Conformance and normative language

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**,
**MAY**, and **OPTIONAL** are to be interpreted as described in
RFC 2119. A **producer** emits app documents and MUST emit documents
valid per §2–§5. A **runtime** (the reference implementation is
`createApp`) MUST reject invalid documents with the compile errors of
§8 and MUST raise the runtime errors of §8 under the conditions
specified there.

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
- **`$event`** — when the dispatch originated from a DOM event, the
  serializable slice `{ "type", "value", "checked", "key" }` of it;
  otherwise `null`;
- **`$payload`** — the dispatch payload (§4); `null` when absent.

These three names are the whole ambient vocabulary. The runtime takes
the query's **first** result (`query.first` semantics).

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
- an object **`{ "action": name, "with": payload }`** — `$payload` is
  the `with` value, verbatim.

Payloads are built at *render* time by the view stylesheet: a rule
body may embed `"$path"`, the matched value, or anything in scope
inside the binding. Combined with §3's `$event`, this replaces both of
hyperapp's payload-creator forms with data.

Anything else dispatched as a binding is a producer error (`JA2001` at
runtime).

## 5. The boundaries

### 5.1 Effects

An effect invocation is `{ "run": name, "with"?: props }`. The runtime
resolves `name` in the registered effect handlers
(`options.effects[name]`) and calls `handler(props ?? null, dispatch)`.
Effects are fire-and-forget from the loop's perspective; asynchronous
completion re-enters through `dispatch`. An unregistered name is
`JA2006`; a throwing handler is `JA2007`; neither aborts the loop or
the remaining effects.

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
query }`. After boot and after every state change, the runtime
evaluates each entry's `when` by **effective boolean value** against
the current state (no externals) and reconciles:

- newly live → `cleanup = handler(props ?? null, dispatch)`;
- newly dead → `cleanup()` if the handler returned one.

An absent `when` means always live while the app runs; `stop()` kills
all. Error policy, the mirror image of forms' `visible` rule: a
broken `when` fails **closed** — the subscription stops and the error
is reported — because a broken rule must never keep side effects
alive. An unregistered `run` name is `JA2008`, reported each time the
entry would start.

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
(replay the log through a fresh `createApp`), server rendering
(`renderToString(app.getVnode())`), and remote mutation (ship a
transition's `patch` over the wire). Runtimes SHOULD keep it that way:
any extension that puts a function in the document breaks the format's
core property.

## 8. Errors

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

Runtime (`AppRuntimeError`, routed through `options.onError`, which
defaults to rethrowing):

| Code | Condition |
|---|---|
| `JA2001` | unknown action name, or unusable binding |
| `JA2002` | an action or `when` document threw while evaluating |
| `JA2003` | a transition is not an object / `effects` not an array |
| `JA2004` | a `patch` failed to apply (transition aborted) |
| `JA2005` | `validateState` rejected the next state (transition blocked) |
| `JA2006` | unregistered effect name |
| `JA2007` | an effect handler threw |
| `JA2008` | unregistered subscription name |

Wrapped causes are preserved on `error.cause`; compile errors from
embedded documents keep their own codes (`JQ...`, `JT...`) there —
with their `docPath`s pointing inside the embedded document, the
feedback shape a repair loop needs.

## 9. Open items (roadmap, non-normative)

- ~~The app-document meta-schema~~ — **shipped**:
  [`schemas/jaren-app.schema.json`](../schemas/jaren-app.schema.json)
  (draft 2020-12, with a mechanically derived draft-07 twin) composes
  the published query and JSLT grammars by `$ref`; register those
  artifacts alongside it. A constrained decoder held to it cannot emit
  a structurally invalid application — and the test suite validates
  the production website's own app document against it.
- **The standard forms stylesheet** — render any `@jarenjs/forms`
  model through one shipped rule set; generalize `x-form`'s derivation
  vocabulary (`computed`/`visible`) to app-level derived state.
- ~~Dirty-path-pruned re-rendering~~ — largely **shipped** through the
  other side: the JSLT `memo` option makes unchanged subtrees return
  reference-equal vnodes the renderer skips in O(1); prepass-level
  pruning of match evaluation remains open (see ROADMAP).
- ~~Unifying the write path~~ — **shipped**: `@jarenjs/json/write`
  `parents: 'create'` + undefined-deletes is now exactly forms'
  `setValueAtPointer`, on the shared copy-on-write kernel.
- **Async action documents** — a disposition for actions that await an
  effect before transitioning (today: effect → dispatch).
