# @jarenjs/play architecture

The package supplies the engine registry, example library, a JSLT
component and a host kit. The embedding app owns state, actions, scheduling
and browser capabilities. The executable host is
[`packages/website/src/boundaries/play.js`](../../packages/website/src/boundaries/play.js),
with its run loop in the website's `src/app/` directory; it takes its
validator, language catalogs, slice rules, the slice's reducers and session
file from `@jarenjs/play/host`, the same kit another host composes.

## Package boundaries

| Module | Responsibility |
|---|---|
| `src/engines.js` | Descriptors, editable panes, compiler invocation and located result/error records |
| `src/chain.js` | The LINQ engine's chain reader: the chain text read without `eval` and replayed against `@jarenjs/linq` over closed operator and method lists |
| `src/kernels.js` | The kernels engine's table: each `@jarenjs/core` kernel with the `$query` operator document that runs it |
| `src/examples.js` | Source presets and named datasets |
| `src/index.js` | Registry and `runExample`; synchronous results and rejected promises share the result contract |
| `src/component/index.js` | `createPlayComponent`, including default operator, renderer and validator seams |
| `src/component/viewmodel.js` | Pure derivation from `state.play` into rail, editor and result nodes |
| `src/component/view.js` | JSLT rules in mode `play`, rooted at `$.ui.play` |
| `src/host/catalogs.js` | `PLAY_LOCALES`, compiled catalogs, the pack requester over a host-supplied loader, `localizePlayErrors` |
| `src/host/validator.js` | `createPlayValidator`: the `validate` seam with referenced schemas, the generated form and its chrome; `playDataForm`, `referencedSchemas`, `detectDraftName` |
| `src/host/session.js` | `PLAY_START`, the reader-language rules (`withPlayLocale`, `switchPlayOption`, `loadExample`), `runPlay`, the session file |
| `src/host/forms.js` | `playFormActions`: the generated form's actions over `/play/dataValue`; `PLAY_FORM_VIEW`, the `createFormView` options that read `ui.play` |
| `src/host/actions.js` | `playSliceActions({ langPointer })`: the reducers of `play/loaded`, `play/option-set` and `play/loaded-session` as action documents, writing the reader's language at the host's pointer |
| `styles/play.css` | Desktop grid, mobile pane switcher and result/editor styling |

`createPlayComponent({ operators, renderers, validate, messages })` returns
`rules`, `modes`, `mode`, `viewModel`, `engines`, `examples`, `engineIds` and
`runExample`. Per-run options override the factory's configured seams;
`messages` (a compiled catalog over `playMessagesEn`'s ids, from
`src/messages.js`) is also the view model's default language, and
`viewModel(state, { messages })` takes another per call.
Visual engines delegate rendering; schema validation delegates to the host.
The package imports neither a DOM renderer nor browser storage. No subpath imports
a locale pack, a format set or forms code: `/host` adds the JSON Schema
runner over `@jarenjs/validate`, which the root already depends on, and
takes the format sets, the form functions and every pack from the host (the
packs through the host's own loader).

## State and actions supplied by the host

Mount `component.viewModel(state, { messages })` at `state`'s derived `ui.play` location,
merge the component's rules/modes into the app stylesheet, and apply that
node in mode `play`. Keep editable source text in `state.play.source` and
data text in `state.play.data`, keyed by each descriptor's pane keys.
`engine`, `exampleId`, `datasetIndex` and `config` identify the current
experiment. `result` holds the latest `PlayResult` or `null` before a run.

The view emits these action bindings; the host supplies their reducers or
effects. Input bindings carry the native event's serialized `value`.

| Actions | Payload and responsibility |
|---|---|
| `play/example`, `play/dataset` | Example id or dataset index; replace the corresponding source/data presets |
| `play/source`, `play/data` | `{ key }` plus event value; update one pane |
| `play/option` | `{ key }` plus event value; apply the session `component.switchOption(engine, key, value, session)` answers — the config, and the source and data that fit it (another example's when it names one) |
| `play/panel`, `play/deep-pick`, `play/deep` | Panel id or boolean; choose result screens without re-running |
| `play/mobile-pane`, `play/data-view` | Pane name or `json`/`form`; switch the visible editor/result surface |
| `play/name`, `play/open` | Event value; rename or open a saved session |
| `play/new`, `play/save`, `play/save-as`, `play/delete-session` | Session lifecycle; delete carries the session name |
| `play/download`, `play/import`, `play/share` | Host file/clipboard capabilities, with status in `shared` |
| `play/loaded`, `play/option-set`, `play/loaded-session` | Dispatched by the host with what `loadExample`, `switchPlayOption` and `sessionToLoaded` answer; `@jarenjs/play/host`'s `playSliceActions({ langPointer })` supplies their reducers, writing the reader's language at the host's pointer (the website's `/lang`) |

The host also keeps presentation state (`panel`, `deep`, `deepPick`,
`mobilePane`, `ratio`, `dataView`) and session state (`name`, `savedName`,
`names`, `shared`); `@jarenjs/play/host`'s `PLAY_START` is that slice at
rest. The reader's language is the host's (`lang`), set only by the reader:
`play/option` on the `locale` pane writes the `lang` that `switchPlayOption`
answers; `play/example` keeps the example's `exampleLocale` for its own run;
opening a session clears it. The generated validation form is a host
integration (`playDataForm` mounts it at `ui.play.dataForm` and
`ui.play.formLabels`, `PLAY_FORM_VIEW` renders it, `playFormActions` are the
`play/f-*` actions); the component only exposes the place to render it. Register the shared app
splitter widget for the component's separator and commit its ratio into
the play slice.

## Running and persistence

Subscribe to changes of engine, source, data and config, debounce editor
changes, and call `component.runExample(engine, source, data, options)`.
Resolve its possible promise and publish the result only if that run is
still current. A monotonic run sequence prevents an older async result
from overwriting a newer edit. Changes to panel selection, saved names or
result itself must not schedule another engine run.

Persist source/data/config, not derived panels, DOM nodes or timing.
The website's session reader validates and normalizes imported values
before replacing state. Download and share use the session envelope in
[PLAY-FORMAT §6](docs/PLAY-FORMAT.md#6-the-session-file); oversized share
links are refused with a working file-download alternative. Storage,
downloads, imports, clipboard and routing remain host capabilities.
