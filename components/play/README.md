# @jarenjs/play

**A JSON-engine playground — understand an engine before you compose it.**

Pick an engine (JSONPath, JSON Pointer, JSON Patch, `$query`, JSLT,
markdown, mermaid, a `$contract` document, a JSON Schema emitted as
TypeScript, a fluent `@jarenjs/linq` chain, …), feed it a source input and
one or more datasets from a curated example library, and watch it run. Where `@jarenjs/studio` is for
building an application out of many files, `@jarenjs/play` is for
learning one engine standalone — a reference bench you experiment on first.

Two layers, the suite's convention:

- **the engine** (`@jarenjs/play`) — headless: an engine registry, a
  curated example library, and a pure `runExample(engineId, source, data)
  → { ok, panels, timing, error }`. Wraps the real shipped compilers; knows
  nothing of the DOM.
- **the component** (`@jarenjs/play/component`) — the playground UI, a
  `createPlayComponent()` factory (like `@jarenjs/calc`): a JSLT view
  (example rail, source editors, a dataset switcher, the run stage) the
  host composes.

Play is a **student tool**: it opens calm — one clean result per run — and
drills deeper on demand. An engine's rich explainers (match cards, the
compiled program, a geometry-free AST, a canonical round-trip) are `deep`
result panels behind a quiet **"Explain ▸"** depth toggle: revealed beside
the answer on desktop, as a full-pane swap with a ← back on a phone. And
when a run fails, the error says **where**: the editor it is about is
marked invalid and its label carries the compiler's own location — the
rule of the stylesheet (`at /rules/0/match`), the token of the selector
(`at position 7`), the line of the document (`at line 2, column 5`) — so
the learner is pointed at the text to fix, not just told it is wrong
([PLAY-FORMAT §2](./docs/PLAY-FORMAT.md#2-the-result)).

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
See [docs/PLAY-FORMAT.md](docs/PLAY-FORMAT.md) for descriptors and results,
and [ARCHITECTURE.md](ARCHITECTURE.md) for the state, action and run-loop
contract an embedding host supplies. Query, JSLT, JTLT and XQuery expose
an editable JSON externals pane; the JSON Schema engine an editable
referenced-schemas pane, so a schema can `$ref` another by `$id`. The Emit
engine takes a schema and no data: it compiles the schema to the type model
`@jarenjs/emit` publishes and renders it as TypeScript declarations or a
Markdown reference (the model rides behind the depth toggle), with option
selects for the target, open or closed objects, and the normalizer that makes
the accepted and normalized types differ.

Three engines show what the other packages are made of. The LINQ engine
reads a fluent `@jarenjs/linq` chain — `from(data).where((u) =>
u.age.gt(21)).orderBy((u) => u.name)` — as text, without `eval`, replays
it against the real chain and shows the query document it compiles to
beside that document's answer: the document is the thing a model learns to
author, and a JavaScript operator the chain cannot capture (`u.age > 21`)
is refused at its position, naming `.gt()`. The JSONX engine reads JSONX
(bigint, regexp, datetimes, `inf`/`nan`) as the JSON another engine's data
pane takes, and names each value JSON writes differently. The kernels
engine calls the `@jarenjs/core` geo, date, math and text functions the
`$query` operators run, over a JSON array of arguments, and drills down
into the operator document that runs the same kernel and whether the two
answers agree.

Answers that changed (upgrade notes): a host `validate` runner now receives a
fourth argument, the parsed referenced schemas (`[]` when the pane is empty),
and must register them before compiling; a runner that ignores it still
answers as before. `runExample` answers `unknown engine` for
an id every object inherits (`constructor`, `__proto__`, `toString`), where it
failed with `engine.run is not a function`; a timing that is `NaN` or infinite
prints a dash, where it printed `NaN ms`. The JOSL engine's streaming-events
table writes each path as a JSON Pointer, `~` and `/` in a key escaped
(`/a~1b` for the key `a/b`), where it printed `/a/b`, the pointer of a
nested member.

## Exports

Every subpath a consumer can import, derived from the manifest by
`npm run docs:derive` (`npm run docs:check` fails when the two drift):

<!--fact:exports.play-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/play` | JavaScript | declared |
| `@jarenjs/play/component` | JavaScript | declared |
| `@jarenjs/play/styles/play.css` | asset | — |
| `@jarenjs/play/package.json` | metadata | — |
<!--/fact-->

## Install

```
npm install @jarenjs/play
```

Zero third-party runtime dependencies — only other `@jarenjs/*` packages.
Node ≥ 24, ESM.
