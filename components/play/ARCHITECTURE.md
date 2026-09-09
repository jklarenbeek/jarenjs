# @jarenjs/play architecture

The package supplies the engine registry, example library and a JSLT
component. The embedding app owns state, actions, scheduling and browser
capabilities. The executable host is
[`packages/website/src/boundaries/play.js`](../../packages/website/src/boundaries/play.js),
with its reducer and run loop in the website's `src/app/` directory.

## Package boundaries

| Module | Responsibility |
|---|---|
| `src/engines.js` | Descriptors, editable panes, compiler invocation and located result/error records |
| `src/examples.js` | Source presets and named datasets |
| `src/index.js` | Registry and `runExample`; synchronous results and rejected promises share the result contract |
| `src/component/index.js` | `createPlayComponent`, including default operator, renderer and validator seams |
| `src/component/viewmodel.js` | Pure derivation from `state.play` into rail, editor and result nodes |
| `src/component/view.js` | JSLT rules in mode `play`, rooted at `$.ui.play` |
| `styles/play.css` | Desktop grid, mobile pane switcher and result/editor styling |

`createPlayComponent({ operators, renderers, validate })` returns `rules`,
`modes`, `mode`, `viewModel`, `engines`, `examples`, `engineIds` and
`runExample`. Per-run options override the factory's configured seams.
Visual engines delegate rendering; schema validation delegates to the host.
The package imports neither a DOM renderer nor browser storage.

## State and actions supplied by the host

Mount `component.viewModel(state)` at `state`'s derived `ui.play` location,
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
| `play/source`, `play/data`, `play/option` | `{ key }` plus event value; update one pane or option |
| `play/panel`, `play/deep-pick`, `play/deep` | Panel id or boolean; choose result screens without re-running |
| `play/mobile-pane`, `play/data-view` | Pane name or `json`/`form`; switch the visible editor/result surface |
| `play/name`, `play/open` | Event value; rename or open a saved session |
| `play/new`, `play/save`, `play/save-as`, `play/delete-session` | Session lifecycle; delete carries the session name |
| `play/download`, `play/import`, `play/share` | Host file/clipboard capabilities, with status in `shared` |

The host also keeps presentation state (`panel`, `deep`, `deepPick`,
`mobilePane`, `ratio`, `dataView`) and session state (`name`, `savedName`,
`names`, `shared`). The generated validation form is a host integration;
the package only exposes the place to render it. Register the shared app
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
