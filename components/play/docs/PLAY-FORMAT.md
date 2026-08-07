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
  kind:   'code' | 'view' | 'table' | 'note',
  depth?: 'simple' | 'deep',                       // 'deep' → revealed on drill-in (PLAY_06)
  // per kind:
  text?:    string,                                // code / note body
  vnode?:   any,                                   // view: a host-rendered vnode, spliced verbatim
  columns?: string[],  rows?: any[][],             // table
  tone?:    'ok' | 'warn' | 'info',                // note callout tone
}
```

Every ok run yields **at least one** panel — most engines a single `code`
panel (today's behaviour, unchanged). Richer engines yield several: **CSV**
returns a `note` (dialect + record count + repairs), a `table` (the parsed
records) and a `code` (the CSV round-trip). The component shows one panel
inline, or — for more than one — a tab strip above the active panel body.
The playground owns this small render vocabulary (code block, spliced
vnode, table, callout, stat line, coded error line), so it never depends on
a host's node helpers.

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
