# @jarenjs/app

Collection, search, formula and run resources are injected and disposed by their host. Follow the [combined public composition](../../docs/ADOPTION-EVIDENCE.md) for bounded observations, page ownership and explicit platform/manual qualifications.

Applications as JSON documents. This package rebuilds [hyperapp](https://github.com/jorgebucaran/hyperapp)'s dispatch loop on the Jaren suite and pushes its philosophy — *everything is data* — the rest of the way: hyperapp made effects and subscriptions data but kept actions and views as JavaScript functions; here **the whole application is one JSON value**:

| Slot | Written as | Compiled by |
|---|---|---|
| `state` | a JSON document | — |
| `view` | a [JSLT stylesheet](../json/docs/JSLT-FORMAT.md) producing [vnodes](../view/docs/VIEW-FORMAT.md) | `@jarenjs/json/jslt` |
| `actions` | named [query documents](../json/docs/QUERY-FORMAT.md) producing transitions | `@jarenjs/json/query` |
| transitions | next state, or an RFC 6902 **JSON Patch** | `@jarenjs/json/patch` |
| `subs` | entries with an EBV `when` query deciding liveness | `@jarenjs/json/query` |

Everything compiles **once** at `createApp` time; the running loop only calls specialized closures — the same design contract as every other Jaren engine. JavaScript enters at named, registered boundaries only: effect and subscription handlers, the `compileTypeTest` hook, the `validateState` invariant hook. No `eval`, CSP-safe, and the entire app is serializable: snapshot it, diff it, ship it over the wire, or have a constrained decoder generate it — an LLM cannot emit a syntactically invalid program in this framework.

The document contract is [docs/APP-FORMAT.md](docs/APP-FORMAT.md).

## A complete app

```javascript
import { createApp } from '@jarenjs/app';

const app = createApp({
  "$app": "0.1",
  "state": { "count": 0 },

  "view": [
    { "match": "$", "body":
      ["main", {},
        ["h1", {}, "Count: ", "$.count"],
        ["button", { "on": { "click": "inc" } }, "+"],
        ["button", { "on": { "click": { "action": "add", "with": 10 } } }, "+10"]] }
  ],

  "actions": {
    "inc": { "patch": [{ "op": "replace", "path": "/count",
                         "value": { "$add": ["$.count", 1] } }] },
    "add": { "patch": [{ "op": "replace", "path": "/count",
                         "value": { "$add": ["$.count", "$payload"] } }] }
  }
}, { node: document.getElementById('app') });
```

### The same app, by code

`@jarenjs/linq/app` writes that document from typed builders — the
initial state derived from the state schema's defaults, the view the
JSLT pen's stylesheet, the actions captured over `$`/`$event`/`$payload`
and their patch pointers derived from the state shape — and answers the
state's JSON Schema beside it for `validateState`:

```javascript
import { action, bind, defineApp, replace, transition } from '@jarenjs/linq/app';
import { rule } from '@jarenjs/linq/jslt';
import * as s from '@jarenjs/linq/schema';

const counter = defineApp({
  state: s.object({ count: s.integer().default(0) }),
  view: [rule('$', (v) => ['main', {},
    ['h1', {}, 'Count: ', v.get('count')],
    ['button', { on: { click: 'inc' } }, '+'],
    ['button', { on: { click: bind('add', { payload: 10 }) } }, '+10'],
  ])],
  actions: {
    inc: action((st) => transition({
      patch: [replace((c) => c.get('count'), st.get('count').add(1))],
    })),
    add: action((st, x) => transition({
      patch: [replace((c) => c.get('count'), st.get('count').add(x.payload))],
    }), { payload: s.integer() }),
  },
});

createApp(counter.document, { node: document.getElementById('app') });
```

It is the same application — the test suite boots both and compares
them frame for frame. The mapping table, every refusal and the
member-name escape this example's `get('count')` spells are
[APP-PEN.md](../linq/docs/APP-PEN.md); this package depends on none of
it.

## The view

The view is a JSLT stylesheet: rules match state by location (JSONPath) and shape (JSON Schema, via `compileTypeTest`), bodies are query documents producing vnodes, and `$path`/`$root` are in scope — a rule rendering `/todos/3` can embed its own pointer in an event binding, which is why there are no payload-creator functions anywhere.

## Actions and transitions

An action document is evaluated with `$` bound to the current state, `$event` bound to serializable event data (`{ type, value, checked, key }`) and `$payload` bound to the binding's `with` value. A binding can request more of the event declaratively — `{ "action": "selectRow", "with": { "id": "$.id" }, "event": ["shiftKey", "ctrlKey"] }` adds those members to `$event` from a closed allow-list of serializable fields (modifier keys, pointer coordinates, selection offsets, ...), and the `eventFields` option registers named JS extractors for anything the allow-list can't serialize (APP-FORMAT §3.1/§5.4). It returns a **transition**:

```json
{ "state":   "the next state, whole — optional",
  "patch":   "an RFC 6902 patch applied copy-on-write — optional",
  "effects": [{ "run": "http", "with": { "url": "/api" } }] }
```

Returning nothing is a no-op. State updates are immutable and structure-sharing (the patch engine's copy-on-write), which feeds the renderer's `oldVnode === newVnode` fast path.

## Effects and subscriptions

Side effects stay at the edges, as registered handlers:

```javascript
createApp(doc, {
  node,
  effects: {
    http: (props, dispatch) =>
      fetch(props.url).then((r) => r.json()).then((data) => dispatch(props.done, data)),
  },
  subs: {
    interval: (props, dispatch) => {
      const id = setInterval(() => dispatch(props.tick), props.ms);
      return () => clearInterval(id);       // cleanup
    },
  },
});
```

Subscription entries in the document carry a `when` query; after every state change the loop starts and stops handlers to match (`{ "run": "interval", "with": { "ms": 1000, "tick": "tick" }, "when": "$.running" }`). A broken `when` fails **closed** — a broken rule must never keep side effects alive — and is reported through `onError`.

## Async tasks

Async work follows a documented convention — **correctness lives in state, cancellation lives in the host** — with one shipped helper packaging the host half:

```javascript
import { createTaskEffect } from '@jarenjs/app';

// state:  "tasks": { "list": { "id": 0, "status": "idle", "error": null } }
// start:  patch increments /tasks/list/id AND the effect's with.id
//         carries the same increment expression (evaluated pre-transition!)
// finish: the completion action guards { "$eq": ["$payload.id", "$.tasks.list.id"] }
//         and yields the empty sequence for anything stale
effects: {
  http: createTaskEffect((props, signal) =>
    fetch(props.url, { signal }).then((r) => r.json())),
}
```

The helper aborts a slot's in-flight predecessor (`mode: "switch"`, the default — `"exhaust"`, `"concat"` and `"parallel"` pick the other per-slot concurrency semantics), dispatches `done` with `{ id, result }` on resolve and `fail ?? done` with `{ id, error }` on failure — `error` a string by default, or the JSON an optional `projectError(err, props)` returns (the door for a structured HTTP failure: status, code, safe details; anything non-JSON falls back to the string) — and dispatches nothing for an abort. The abort is only an optimization — an aborted request may already have resolved — so the state-side id guard is the guarantee: out-of-order and polling responses are rejected by construction. The handler exposes `cancel(slot)`/`cancelAll()`/`dispose()`; `app.destroy()` disposes it automatically. The full convention, with a runnable worked example the test suite executes verbatim, is [docs/TASKS.md](docs/TASKS.md).

## One FIFO queue, observable transactions

Every dispatch — from the DOM, an effect, a listener, a subscription or a widget — is one **transaction** on one FIFO queue; nested dispatches queue, never interleave, so every listener observes every transaction in the same order with the state that transaction produced ([APP-FORMAT §8](docs/APP-FORMAT.md)). Boot is a transaction too: a failure in renderer construction, the initial-state check, a starting subscription, the first frame or the queued boot work rolls back everything acquired (effect handlers disposed, container emptied) and throws `JA0007`. `app.stop()` halts the loop one-way (no resume); `app.destroy()` is the terminal teardown — subscriptions cleaned, effect handlers disposed, widgets unmounted exactly once, the container emptied.

`app.observe(fn)` streams one bounded JSON record per transaction (`seq`, `action`, `source`, `status`, `changedPaths`, `scheduledEffects`, `durationMs`, `errorCode` — payloads only with the `capturePayloads` opt-in), and `createTransactionLog({ limit, redact })` packages the ring buffer with a redaction hook for support exports. `createFocusEffect({ container })` bridges focus, text selection and measurement through post-render `data-ref` intents, so accessible dialogs restore focus without a DOM node ever entering state (§8.4).

## Widgets — imperative islands, declarative everything else

An irreducibly imperative island — a virtualized grid, a canvas, a map — lives behind a **registered widget** ([VIEW-FORMAT §7](../view/docs/VIEW-FORMAT.md)); the app document stays JSON and the app option only names the boundary, like `effects` and `subs`:

```javascript
createApp({
  state: { grid: { rows: hugeArray, scrollTop: 0 }, selected: null },
  view: [
    { "match": "$", "body": ["main", {}, { "$apply": "$.grid" }] },
    { "match": "$.grid", "body":
      ["jaren-widget", { "name": "virtual-list", "key": "list", "props": {
        "rows": "$.rows", "scrollTop": "$.scrollTop",
        "binding": { "action": "select", "with": {} } } }] },
  ],
  actions: { select: { patch: [{ op: 'add', path: '/selected', value: '$payload.id' }] } },
}, { node, widgets: { 'virtual-list': virtualListWidget } });
```

Jaren owns state and orchestration; the widget owns its DOM. Its `props` come from the view stylesheet and are compared **by reference** — the JSLT memo means a transition that doesn't touch the widget's state slice never calls into the widget at all. The widget dispatches by composing runtime data into the binding its props carry and handing it to `emit`, which flows through the ordinary binding path — `with` payloads and `event` extraction included — and it is unmounted deterministically when it leaves the tree.

### A ready-made splitter, and a document store

Two IDE-shaped primitives ship ready to bind, so a two-pane surface (the studio, the play playground) doesn't re-implement them:

- **`createSplitterWidget({ action, grid, rail, cssVar, min, max, step })`** — a drag handle over a pane boundary. It drives a CSS ratio variable *live* during a drag (no per-move dispatch — that would flood the transaction log and undo) and commits the ratio through `action` on pointer-up only, plus keyboard resize as an ARIA separator. Register it like any widget; parameterize the grid/rail selectors, the CSS variable and the commit action so each surface binds its own.

  Widget props accept `axis: 'x' | 'y'` (default `'x'`) for side-by-side or
  stacked panes. The widget also writes `${cssVar}-first` and
  `${cssVar}-rest` as fractional grid tracks. Pointer cancellation restores
  the starting ratio without committing; vertical resizing uses Up/Down.
- **`createDocStore({ storage, key })`** — a keyed `save`/`load`/`remove`/`names`/`all` CRUD over an injected `storage` (`localStorage` in the browser, an in-memory object in tests), so the package never touches `localStorage` itself. Paired with **`encodeShare(snapshot)`** / **`decodeShare(token)`**, a Unicode-safe base64url share-link codec (a corrupt token decodes to `null`, never a throw), it is the new/save/load/delete/share pattern behind the studio and play surfaces.

Collection keys and document names such as `__proto__` are ordinary own
members of the document store and survive persistence. Loading a name
that has not been saved returns `undefined`, including prototype-member names.

Stores created with the same storage adapter share one in-memory root, read
once. Saves and removals preserve other collections, including when the
adapter cannot persist writes. A new adapter starts a new read of storage.

## Invariants the model can't cheat

```javascript
import { JarenValidator } from '@jarenjs/validate';
import { createTypeTestCompiler } from '@jarenjs/validate/query';

const validate = new JarenValidator().compile(stateSchema);   // may carry $query assertions

createApp(doc, {
  node,
  compileTypeTest: createTypeTestCompiler(),   // enables schema matches & $valid/$assert/$as
  validateState: (state) => validate(state),   // every transition checked; rejected = not applied
});
```

`validateState` runs against every candidate next state; a rejection blocks the transition (fail closed) and surfaces as a `JA2005` error with the validator's structured errors in `detail`. The app package itself never imports the validator — the same boundary discipline as `@jarenjs/forms`.

## The standard forms stylesheet

The marquee integration: render any [`@jarenjs/forms`](../forms) model with **zero hand-written render code**. `createFormView()` returns a plain-JSON JSLT rule set that dispatches over a `buildFormViewModel` tree by *shape* (JSONPath filter selectors on each node's `control`), and `createFormActions()` returns the matching action documents that write keystrokes back into the state — choosing the correct RFC 6902 op per node (`replace` for array elements, where `add` would insert; `add` for object members, where it means set-or-replace).

```javascript
import { createApp, createFormView, createFormActions, formEventFields } from '@jarenjs/app';
import { buildFormModel, compileFormRules, createInitialData, buildFormViewModel } from '@jarenjs/forms';

const model = buildFormModel(schema);
const rules = compileFormRules(model);

const app = createApp({
  state: { data: createInitialData(model) },
  view: [
    ...createFormView(),                                  // the shipped rule set
    { match: '$', body: ['main', {}, { $apply: '$.form' }] },
  ],
  actions: createFormActions({ dataPointer: '/data' }),
}, {
  node: document.getElementById('app'),
  eventFields: { ...formEventFields() },                  // decode the JSON-carrying controls
  viewModel: (state) => ({                                // the derivation boundary
    form: buildFormViewModel(model, state.data, { rules, validateFields: true }),
  }),
});
```

Schema in, live form out: text/email/number/date/color inputs, textareas, checkboxes, selects with precomputed options, nested object fieldsets, arrays with add/remove buttons, inline errors, and `x-form` visibility/enablement/computed reacting per keystroke. The `viewModel` option is the general **derivation boundary**: it maps state to the view stylesheet's input before every render, so JS-computed derivations enter the render path without ever entering the state. A DOM control's value is a string, and two controls carry something else: a select over a non-string enum, and the `json` editor over a structured value. Both round-trip through JSON text and decode it in `formEventFields()`, the format's one sanctioned place for host JavaScript at the DOM boundary (APP-FORMAT §5.4) — **register it or those two controls write nothing**. Remaining limits (documented in `src/forms.js`): a cleared number input writes `null`, and intermediate object/array containers need to exist in the data. `createInitialData(model)` supplies them for a new form; loaded documents must supply them too.

Nested object and array fields honor `x-form.enabled` through their native
`fieldset` disablement, including child controls and array buttons. A `readOnly`
field uses native `readonly` for text inputs and textareas, and `disabled` for
checkboxes, selects, collection fieldsets, and add/remove buttons.

## Headless and server-side

Without a `node`, the app runs headless: `getVnode()` returns the current view output for any renderer, and SSR is one composition:

```javascript
import { renderToString } from '@jarenjs/view';
renderToString(createApp(doc).getVnode());
```

## API

`createApp(appDoc, options)` → `{ dispatch(name, payload?), getState(), setState(next), getVnode(), render(), subscribe(listener), observe(observer), stop(), destroy() }`

Also exported: `compileActions`, `compileSubs`, `createFormView`, `createFormActions`, `formEventFields`, `createTaskEffect`, `createFocusEffect`, `createTransactionLog`, `createSplitterWidget`, `createDocStore`, `encodeShare`, `decodeShare`, and the error classes (`AppCompileError`, `AppRuntimeError`, `HostValueError`, `toError`, `APP_CODES`).

Options: `node`, `document`, `effects`, `subs`, `eventFields` (named `$event` field extractors), `widgets` (registered widget definitions, forwarded to the renderer), `compileTypeTest`, `validateState`, `viewModel`, `onError` (default rethrows), `schedule` (render batching; default microtask — pass `(f) => f()` for synchronous tests). Compile failures throw `AppCompileError` (`JA0xxx`, with a `docPath` into the app document); runtime failures route `AppRuntimeError` (`JA2xxx`) through `onError`. The full code table is in [APP-FORMAT.md](docs/APP-FORMAT.md) §10.

## Exports

Every subpath a consumer can import, derived from the manifest by
`npm run docs:derive` (`npm run docs:check` fails when the two drift):

<!--fact:exports.app-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/app/search` | JavaScript | declared |
| `@jarenjs/app` | JavaScript | declared |
| `@jarenjs/app/schemas/jaren-app.authoring.schema.json` | schema | — |
| `@jarenjs/app/schemas/jaren-app.draft-07.schema.json` | schema | — |
| `@jarenjs/app/schemas/jaren-app.schema.json` | schema | — |
| `@jarenjs/app/package.json` | metadata | — |
| `@jarenjs/app/formula` | JavaScript | declared |
<!--/fact-->

## Development

Unit tests live in `test/app/` at the repository root (`npm run test:app`). See [ROADMAP](../../docs/ROADMAP.md) for what's next: dirty-path-pruned re-rendering and time-travel tooling over the action log.

`createApp` forwards the renderer's `safe`, `onUnsafe` and `hydrate` options.
Optional `capabilities: { effects, subs, widgets, eventFields }` arrays grant
specific host registry names; with safe mode or explicit grants, omitted lists
are empty. See [APP-FORMAT §8.2.1](docs/APP-FORMAT.md#821-dom-profiles-and-host-capability-grants)
for the disposal and trust contract. Safe mode is a display policy and removes
DOM event bindings and widgets.

`createArrayRangeProvider` and `createCollectionCoordinator` provide injected collection coordination and complete snapshot output; see [the provider contract](docs/COLLECTION-PROVIDER.md).

`@jarenjs/app/search` owns an injected worker and a private resident index; see [search ownership](docs/SEARCH.md) for cancellation, progress and drained disposal.

## Terminating formula workers

`@jarenjs/app/formula` exports `createFormulaResource`, an injected worker lifecycle with bounded admission, generation fencing, hard termination and draining disposal. Hosts supply actual terminating isolates; same-thread helpers have no hard deadline. See the [formula resource contract](../json/docs/FORMULA-FORMAT.md#batches-and-isolation).
