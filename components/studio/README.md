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
  files render their `describe()`/OpenAPI projections, and files are
  added, renamed, deleted and opened from templates.

## The project document

A thin envelope over typed files — the full contract is
[PROJECT-FORMAT.md](docs/PROJECT-FORMAT.md).

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

## Why per-file validation

The published `jaren-query` / `jaren-jslt` grammars are *closed*, so a data
query using a host-registered operator (`$npv`, `$sqrt`) can't be checked
against them. The studio validates each file on **its own boundary** —
`jslt`/`query` files are *compiled* with the operator packs mounted, so
registered operators pass and a real mistake surfaces as its own coded
error with a JSON Pointer. There is deliberately no single composed
mega-schema; that is what lets a project mix an app, a store and a data
query at once. See [PROJECT-FORMAT.md](docs/PROJECT-FORMAT.md).

## Install

```
npm install @jarenjs/studio
```

Zero third-party runtime dependencies — only other `@jarenjs/*` packages.
Node ≥ 24, ESM.
