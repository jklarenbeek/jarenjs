# @jarenjs/studio — architecture

## Two layers, one-way

`@jarenjs/studio` follows the suite's component convention: an **engine**
(`src/*`, headless) and a **component** (`src/component/*`, the IDE
widget). The boundary is one-way — the component imports the engine, never
the reverse.

Unlike a render-only component (`calc`/`md`/`mermaid`, whose engine sees
only `@jarenjs/core` + `@jarenjs/view`), the studio's engine is a
**validator / assembler**: it must know the suite's grammars, so it
imports `@jarenjs/{validate, json, app, flow, db}` (their schemas and
compilers) — but nothing of the DOM or `@jarenjs/app`'s runtime. It sits
near the top of the dependency arrow, just below the website; nothing it
imports imports it, so there is no cycle.

## The project is a thin envelope

The document (`jaren-project`, PROJECT-FORMAT.md) is `{ files, active,
layout }`. The envelope alone is schema-gated. Each file's `text` is
validated against **its own kind grammar at its own boundary** — there is
no composed meta-schema. That is the load-bearing decision: the published
`jaren-query`/`jaren-jslt` grammars are closed (their operators
enumerated), so a data query with a host-registered operator (`$npv`)
could never validate against one composed gate. Compiling each `jslt` /
`query` file *with the operator registry* accepts registered operators
and yields the engine's own coded errors with JSON Pointers — the honest
per-file boundary, not a shortcut.

## `classifyChange` — the reboot decision as data

The IDE's hardest UX problem is that re-booting a nested `@jarenjs/app` on
every edit destroys the running app's state. The engine keeps the *data*
for that decision headless and tested: `classifyChange(prev, next)`
compares a **structural key** — an `app` document minus its `state`, via
the suite's `contentKey` — and reports `structural` / `state-only` /
`none` per artifact. The component's policy (hot-dispatch a state-only
edit, reboot a structural one) reads this; the split keeps the policy
thin and the datum proven.

## Assembly: whole-document first

`assembleArtifacts` ships the whole-document contract (a runnable file is
its own artifact; `state`/`data` are inputs). **Fragment assembly** —
composing separate `state` + `view` + `actions` files into one
`jaren-app` document — is the enhancement that makes the true HTML/CSS/JS
split real; it extends `sourceFiles` without changing the contract.

## Files

- `src/project.js` — the model: `KINDS`, `LAYOUT_DEFAULT`, `parseProject`
  (envelope-gate + normalize), `fileOf`.
- `src/validate.js` — `validateFile`: per-kind dispatch; the composed app
  meta-schema + a headless render audit; jslt/query compiled with the
  operator packs.
- `src/assemble.js` — `assembleArtifacts`, `classifyChange`, `describe`.
- `src/errors.js` — `StudioError` on `@jarenjs/core`'s coded base;
  `STUDIO_CODES` (JS0001/JS0002).
- `src/component/index.js` — `createStudioComponent` (the IDE widget lands
  in the next order; today it exposes the engine surface a host binds at
  mount).
- `schemas/` — the `jaren-project` grammar + draft-07 twin.
