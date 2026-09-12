# @jarenjs/studio

**The jaren project IDE — a jaren application as a multi-file project.**

CodePen's model, for JSON-all-the-way-down: an application is a small tree
of typed files (a view, the actions, the state, a schema, a data model,
queries, a flow), each edited on its own, each validated against its own
grammar, assembled into runnable artifacts, and — where the driver allows
— run live. The same document the human edits is the document an AI
authors; the studio is a controlled component whose value is that project.

This package ships in two layers, the suite's convention:

- **the engine** (`@jarenjs/studio`) — headless: parse a `jaren-project`
  document, validate each file against its kind, assemble the runnable
  artifacts, and classify a change as structural vs. state-only. Knows the
  grammars, nothing of the DOM.
- **the component** (`@jarenjs/studio/component`) — the IDE itself, a
  `createStudioComponent()` factory (like `@jarenjs/calc`): the shell is a
  **JSLT view** (file rail with add/delete, an editable file name, a
  template gallery, editor, docked coded-error strip, run stage, layout
  switcher) over a pure `projectViewModel`, plus the two hard-problem
  policies (`hostPolicy` reboot-vs-hot-update, `reconcileBuffer`). The
  chrome and its derivation render headlessly and are tested as such; the
  host registers the DOM-touching islands — the live nested-app stage
  (hot-update via `app.setState`) and the drag splitter — which are
  browser-verified. Mounted live at the website's `#/project`, where `app`
  files boot, `jslt`/`query` files run against a data file, `contract`
  files render their `describe()`/OpenAPI projections, `fsm`/`dag` files
  mount the Flow editor, and collection models run in private SQLite workers
  with query plans and live results. All ten file kinds can be created,
  renamed, deleted and opened from templates.

## Complete reusable editors

`mountStudioEditor`, `mountFlowEditor` and `mountDataEditor` provide the same
project, Flow and Data interfaces used by the website. Each exposes document
reads, validation, revision-checked replacement/patching, execution, change
subscriptions and disposal. Hosts supply rendering, templates, task execution
and storage through explicit services.

Use `/component`, `/flow`, `/data` and `/data/host`, with their exported styles
and operation contract. The [host guide](docs/EDITORS.md) describes the complete
API, worker initialization, storage identity and lifecycle. A packed independent
host exercises all three editors without importing website source.

## The project document

A thin envelope over typed files — the full contract is
[PROJECT-FORMAT.md](docs/PROJECT-FORMAT.md).

`KINDS` lists all ten file kinds; `ADDABLE_KINDS` and `fileSkeleton` supply
the creation menu and starter text from one shared table.

```js
import { parseProject, validateFile, assembleArtifacts, classifyChange, describe }
  from '@jarenjs/studio';

const project = parseProject({
  project: '0.1',
  files: [
    { name: 'app.json',   kind: 'app',   text: '{ "view": [ … ], "state": { … } }' },
    { name: 'npv.query',  kind: 'query', text: '{ "$npv": ["$.rate", "$.cf[*]"] }' },
    { name: 'seed.data',  kind: 'data',  text: '{ "cf": [-1000, 300, 400] }' },
  ],
});

describe(project);            // per-file kind / validity / role — the file rail
validateFile(project.files[1]); // { valid, kind, total, errors: [{ code, message, docPath }] }
assembleArtifacts(project);   // the runnable set
```

Files can import named members from other files: an app's `view`, `actions`
and `state` can each live in their own editor. The assembler checks references,
tracks dependencies and writes diagram edits back into their source files.
Explicit `input`, `model` and `collection` metadata route queries and model
seeds; the [format](docs/PROJECT-FORMAT.md) specifies ownership and lifetimes.

Hosts can propose validated candidates through the shared editor controllers. Model-assisted authoring is provided by [Tangle’s Jaren integration](https://github.com/jklarenbeek/tangleai/blob/main/packages/jaren/README.md).

`@jarenjs/studio/export` exposes `exportProject(project, assets)` and
`createProjectZip(files)`. The website's **Offline ZIP** includes a standalone
runner and the installed runtime dependencies, including SQLite and fonts.
It runs from a local HTTP server without an install or external network.
Runtime rows remain transient; explicit seed files travel with the project.

## Why per-file validation

The published `jaren-query` / `jaren-jslt` grammars are *closed*, so a data
query using a host-registered operator (`$npv`, `$sqrt`) can't be checked
against them. The studio validates each file on **its own boundary** —
`jslt`/`query` files are *compiled* with the operator packs mounted, so
registered operators pass and a real mistake surfaces as its own coded
error with a JSON Pointer. There is deliberately no single composed
mega-schema; that is what lets a project mix an app, a store and a data
query at once. See [PROJECT-FORMAT.md](docs/PROJECT-FORMAT.md).

## Exports

Every subpath a consumer can import, derived from the manifest by
`npm run docs:derive` (`npm run docs:check` fails when the two drift):

<!--fact:exports.studio-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/studio` | JavaScript | declared |
| `@jarenjs/studio/component` | JavaScript | declared |
| `@jarenjs/studio/schemas/jaren-project.draft-07.schema.json` | schema | — |
| `@jarenjs/studio/schemas/jaren-project.schema.json` | schema | — |
| `@jarenjs/studio/styles/studio.css` | asset | — |
| `@jarenjs/studio/package.json` | metadata | — |
| `@jarenjs/studio/export` | JavaScript | declared |
| `@jarenjs/studio/flow` | JavaScript | declared |
| `@jarenjs/studio/styles/flow.css` | asset | — |
| `@jarenjs/studio/styles/editor.css` | asset | — |
| `@jarenjs/studio/data` | JavaScript | declared |
| `@jarenjs/studio/data/host` | JavaScript | declared |
| `@jarenjs/studio/contracts/data.contract.json` | asset | — |
| `@jarenjs/studio/styles/data.css` | asset | — |
<!--/fact-->

## Install

```
npm install @jarenjs/studio
```

Zero third-party runtime dependencies — only other `@jarenjs/*` packages.
Node ≥ 24, ESM.

Author portable project files with the [project pen](../../packages/linq/docs/PROJECT-PEN.md).
