# @jarenjs/play

**A JSON-engine playground — understand an engine before you compose it.**

Pick an engine (JSONPath, JSON Pointer, JSON Patch, `$query`, JSLT,
markdown, mermaid, …), feed it a source input and one or more datasets from
a curated example library, and watch it run. Where `@jarenjs/studio` is for
building an application out of many files, `@jarenjs/play` is for
learning one engine standalone — a reference bench you experiment on first.

Two layers, the suite's convention:

- **the engine** (`@jarenjs/play`) — headless: an engine registry, a
  curated example library, and a pure `runExample(engineId, source, data)
  → { ok, output, timing, error }`. Wraps the real shipped compilers; knows
  nothing of the DOM.
- **the component** (`@jarenjs/play/component`) — the playground UI, a
  `createPlayComponent()` factory (like `@jarenjs/calc`): a JSLT view
  (example rail, source editors, a dataset switcher, the run stage) the
  host composes.

## The model

An engine's inputs are heterogeneous — a selector needs one JSON document,
a patch needs a target, markdown needs no data at all. Each engine is a
**descriptor** (the panes it consumes + a pure `run`); each **example**
presets those panes plus a **list of datasets**:

```js
{ engine: 'path',
  source:   { selector: '$.store.book[*].title' },
  datasets: [ { label: 'store',   data: { data: '{ … }' } },
              { label: 'catalog', data: { data: '{ … }' } } ] }
```

The datasets list length is the whole story: **0** → the engine takes no
data (markdown/mermaid); **1** → one dataset; **N** → a switcher that runs
the *same* source over each shape. Adding an engine is a descriptor plus
examples — the picker, panes and switcher all derive from the descriptor.
See [docs/PLAY-FORMAT.md](docs/PLAY-FORMAT.md).

## Install

```
npm install @jarenjs/play
```

Zero third-party runtime dependencies — only other `@jarenjs/*` packages.
Node ≥ 22, ESM.
