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
  // EITHER half may be null: an engine with no compile step (patch merge
  // and diff) and a phase the host did not report are both "no number",
  // and the stage omits that clause rather than printing `0 ms` — which
  // read as "it was free". Only measured phases are ever shown.
  timing: { compileMs: number | null, runMs: number | null } | null,
  error:  PlayError | null,
  panels: Panel[],                                 // the result SCREENS ([] on error)
}

PlayError = {
  message:   string,     // what the compiler said, verbatim
  code?:     string,     // its stable diagnosis code, when it has one
  // WHERE — the location half, in the format's own fields. A field is
  // present exactly when the compiler stated it; nothing is fabricated.
  pane?:     string,     // the pane KEY the error is about: the source pane
                         // for a compile or run failure, the data pane
                         // whose JSON did not parse
  path?:     string,     // JSON Pointer into that pane's DOCUMENT
  dataPath?: string,     // JSON Pointer into the DATA the document ran over
  position?: number,     // 0-based offset into that pane's TEXT
  line?:     number,     // 1-based line …
  column?:   number,     // … and column
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

An error says **where**, because for a learner the location is the lesson:
which token of the selector, which operation of the patch, which rule of
the stylesheet. The compilers already carry it, in three shapes, and the
error copies whichever its compiler stated: the **coded family** (patch,
`$query`, JSLT, JTLT — `@jarenjs/core`'s `CodedError`) states `path`, a
JSON Pointer into the document being compiled or run (`/rules/0/match`,
`/$idiv`, `/0/path`), and a patch *runtime* error adds `dataPath`, the
target location its operation failed at — two facts, both kept; the
**syntax family** (JSONPath, JSON Pointer, XQuery) states `position`, a
0-based offset into the source text; the **line/column family** (JOSL,
CSV) states 1-based `line` and `column`. `pane` names the editor the
location points into, and it is the whole location for a pane whose JSON
does not parse: the host's `JSON.parse` states its offset only inside
engine-specific message text, never as a field, so the pane is claimed and
nothing finer. Two honest gaps: a missing host seam (`PLAY_NO_RENDERER`,
`PLAY_NO_VALIDATOR`) is nobody's pane, and XQuery compiles a *generated*
query document, so a location after its parse phase is a pointer into a
document the learner never typed — stated, with no pane. `message` stays
verbatim (a coded error composes `code: reason at path` itself), so a
host with no structured reader still gets everything.

The component lands it in two places: the editor the error is about is
marked `aria-invalid` (the state the renderer owns; the ring is styled off
it) and its label carries the phrase — `at /rules/0/match`, `at position
7`, `at line 2, column 5` — while the stage's error line shows the code
chip, the message with its own code prefix dropped rather than read twice,
and the pane's label. A data pane a runtime error merely failed *at* is
not marked invalid (the op was wrong, not the target) but shows the
`dataPath` phrase, because that is where the reader looks next.

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

- `renderers[id]` — the visual engines (markdown / mermaid / charts / mdx)
  hand their source to a host renderer that returns a spliced `view` vnode —
  or `{ vnode, deep, compileMs?, runMs? }`, where `deep` is extra panels only
  the host can derive (the JSON AST, the canonical round-trip), shown behind
  the depth toggle — so the package never imports `@jarenjs/md`, `/mermaid`
  or `/charts`. The renderer's second argument is the option-pane config,
  except `mdx`, which receives the PARSED data document (markdown × data is
  a two-input engine). A renderer that reports `compileMs`/`runMs` is
  believed; one that does not leaves the package holding a single
  wall-clock number for the whole call, which it attributes to the RUN and
  leaves the compile `null` — it never invents a figure it did not measure.
- `validate` — the JSON Schema engine hands `(schemaText, data, locale)` to a
  host validator that returns `{ valid, errors, draft, compileMs, validateMs,
  schemaError }` (errors already localized), so the compiled validator and the
  `@jarenjs/locales` packs stay in the host.
- `operators` — a registry threaded to the `query`/`jslt`/`jtlt` engines.

A missing seam is an honest error Result (`PLAY_NO_RENDERER` /
`PLAY_NO_VALIDATOR`), never a throw. Read-only result panels are
self-contained; interactive panels (a generated form) are host-wired.

## §6 The session file

A session is saveable, shareable and — because a share link has a length
ceiling — **downloadable**. The file is a small self-describing envelope:

```
PlaySessionFile = {
  $play:   '0.1',
  name:    string,                                 // the session title
  session: { engine, exampleId, source, data, config },
}
```

Two rules make the round trip safe. Reading is **liberal**: a bare
`session` object loads too, because that is what a share token decodes to
and what a hand-written file is likely to be. Reading is also
**untrusting**: every field goes through the same coercion a share token
does, so a foreign or hostile document lands as safe defaults rather than
reaching an engine, and a document naming no engine is refused outright —
the session in progress survives a bad file instead of being replaced by
it.

The host supplies the two capabilities (a download and a file picker); a
host that has neither still runs the surface, and the affordances say so
rather than failing silently. This is the path that makes the oversized-
share refusal honest: the link is declined, and the same session is
offered as a file the import side can read back.
