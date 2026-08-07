# PLAY-FORMAT — the engine descriptor and example contract

`@jarenjs/play` models every engine the same way, so the playground UI
(the example picker, the source panes, the dataset switcher, the run stage)
is engine-agnostic and adding an engine is data, not UI code.

## §1 The engine descriptor

```
EngineDescriptor = {
  id:          string,        // 'path' | 'pointer' | 'query' | 'jslt' | …
  label:       string,
  lead?:       string,        // one line describing the engine
  sourcePanes: EnginePane[],  // the engine INPUT (usually one)
  dataPanes:   EnginePane[],  // the JSON it runs against (may be empty)
  run:         (source, data) => PlayResult,
}
EnginePane = { key: string, label: string, control?: 'code' | 'text' }
```

- `sourcePanes` are the engine's input(s): a JSONPath `selector`, a JSLT
  `stylesheet`, a JSON `patch`, a query + its `externals`, a markdown
  `source`. Editable in the playground.
- `dataPanes` are the JSON the engine runs against: usually one `data`; a
  patch's is its `target`; markdown / mermaid / charts have **none** — the
  source is everything.
- `run(source, data)` is PURE and NEVER throws: it wraps the real shipped
  compiler and returns a `PlayResult`. `source` / `data` are maps keyed
  by the pane `key`s, holding the raw text.

## §2 The result

```
PlayResult = {
  ok:     boolean,
  timing: { compileMs, runMs } | null,
  error:  { message: string, code?, path? } | null,
  panels: Panel[],                                 // the result SCREENS ([] on error)
}

Panel = {
  id:     string,                                  // unique in the result (the tab key)
  label?: string,                                  // the tab label (defaults to id)
  kind:   'code' | 'view' | 'table' | 'note' | 'cards',
  depth?: 'simple' | 'deep',                       // 'deep' → hidden behind the depth toggle
  // per kind:
  text?:    string,                                // code / note body
  vnode?:   any,                                   // view: a host-rendered vnode, spliced verbatim
  columns?: string[],  rows?: any[][],             // table
  tone?:    'ok' | 'warn' | 'info',                // note callout tone
  items?:   Array<{ title, value, note? }>,        // cards: a row of stat cards
}
```

Every ok run yields **at least one** panel — most engines a single `code`
panel. The `simple` panels are the calm default: the component shows one
inline, or — for more than one — a tab strip above the active panel body.
The `deep` panels are the engine's rich explainers (match cards, a
geometry-free AST, a compiled program, a canonical round-trip): they stay
hidden until the learner opens the **depth toggle** ("Explain ▸"), which
reveals them as their own tab row beside the answer on desktop and as a
full-pane swap (with a ← back) on a phone. **CSV** is the richest example:
a `note` summary is the calm answer; the parsed `table`, the dialect and
repairs tables and the round-trip `code` ride behind the toggle. The
playground owns this small render vocabulary (code block, spliced vnode,
table, callout, stat cards, coded error line), so it never depends on a
host's node helpers.

## §3 The example, and the dataset problem

```
PlayExample = {
  id:       string,
  label:    string,
  engine:   string,                                // an engine id
  source:   Record<paneKey, string>,               // presets the source pane(s)
  datasets: Array<{ label: string, data: Record<paneKey, string> }>,
}
```

An example presets the source, and carries a **list** of named datasets.
The list length is the answer to "one data or many":

- **0 datasets** — the engine takes no data (markdown / mermaid): no data
  pane, no switcher.
- **1 dataset** — one data pane, no switcher.
- **N datasets** — a **dataset switcher** appears: run the same source over
  dataset A vs. B vs. C without touching the source (e.g. one JSONPath
  selector across three document shapes). Switching keeps the source;
  editing a dataset re-runs.

## §4 Extending

A new engine is one `EngineDescriptor` (registered in `ENGINES`) plus its
`PlayExample`s (added to `EXAMPLES`). No UI changes: the picker groups
examples by engine, the panes render from `sourcePanes`/`dataPanes`, and
the switcher appears whenever an example has ≥ 2 datasets.

## §5 Host-injected seams (the dependency-light contract)

Engines whose real work is heavy or opinionated keep the package free of that
weight by delegating to a host-injected function on `RunOptions`, the same
shape for each:

- `renderers[id]` — the visual engines (markdown / mermaid / charts) hand
  their source to a host renderer that returns a spliced `view` vnode — or
  `{ vnode, deep }`, where `deep` is extra panels only the host can derive
  (the JSON AST, the canonical round-trip), shown behind the depth toggle —
  so the package never imports `@jarenjs/md`, `/mermaid` or `/charts`.
- `validate` — the JSON Schema engine hands `(schemaText, data, locale)` to a
  host validator that returns `{ valid, errors, draft, compileMs, validateMs,
  schemaError }` (errors already localized), so the compiled validator and the
  `@jarenjs/locales` packs stay in the host.
- `operators` — a registry threaded to the `query`/`jslt`/`jtlt` engines.

A missing seam is an honest error Result (`PLAY_NO_RENDERER` /
`PLAY_NO_VALIDATOR`), never a throw. Read-only result panels are
self-contained; interactive panels (a generated form) are host-wired.
