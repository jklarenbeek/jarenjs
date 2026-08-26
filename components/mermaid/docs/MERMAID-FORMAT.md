# The Jaren Mermaid Format

**Version 0.1 — Specification**

Module: `@jarenjs/mermaid`. This document is the normative contract for
the `DiagramDocument` — the JSON vocabulary a Mermaid diagram parses into
— and the bidirectional round-trip between Mermaid text and that AST. It
plays the role for diagrams that [MD-FORMAT](../../md/docs/MD-FORMAT.md)
plays for Markdown.

## 1. Introduction

### 1.1 What this format is

`@jarenjs/mermaid` parses Mermaid diagram source into a plain-JSON,
**geometry-free** AST wrapped in a `DiagramDocument` envelope. The AST
carries the diagram's *meaning* — a directed graph, an ordered
interaction, a finite state machine — and no coordinates: layout is a
separate, later pass. This makes the AST a faithful, lossless,
schema-validated semantic model that other engines project via JSLT, and
a fixed point of the canonical printer `toMermaid`.

### 1.2 Non-goals (v0.1)

Pixel-identity with browser-Mermaid is an explicit **non-goal**. Labels
are SVG `<text>` (Mermaid `htmlLabels: false` semantics), because
`@jarenjs/view` 0.1 has no `foreignObject`. Layout is a deterministic
approximation over a headless text-metrics table (no `getBBox`). See
§6.

## 2. The DiagramDocument envelope

Every parse returns a fresh, never-mutated object:

```jsonc
{ "$mermaid": "0.1",
  "diagram": "flowchart",
  "config":  { "theme": "default", "flowchart": { "curve": "basis" } },
  "ast":     { "...type-specific, monomorphic, geometry-free..." },
  "meta":    { "hash": "8k41x2", "direction": "TD", "title": null } }
```

| Field | Meaning |
|-------|---------|
| `$mermaid` | format version (`"0.1"`) |
| `diagram` | canonical type: `flowchart`, `sequence`, `class`, `er`, `state`, `gantt`, `pie`, or a secondary type name |
| `config` | plain-JSON config from front-matter + `%%{init}%%` (§3) |
| `ast` | the type-specific AST (§4) |
| `meta.hash` | `hashContent(source)` — FNV-1a 32-bit, base-36; the identity key across the suite |
| `meta.direction` | flowchart direction, else `null` |
| `meta.title` | front-matter `title`, else `null` |

## 3. Config

Two sources merge into `config` (plain JSON), in source order:

1. A leading `---` front-matter block (a YAML subset): `title` lifts to
   `meta.title`, `config:` merges into `config`.
2. `%%{init: { … }}%%` directives (relaxed JSON: single quotes and bare
   keys tolerated).

Whole-line `%%` comments are stripped. The **raw source is never
consumed** — it stays in the Markdown fence `value`, so `toMarkdown`
round-trips byte-for-byte while a node is untransformed (§5).

The engine may not statically import `@jarenjs/md`; a host with the md
frontmatter parser can inject it via `parseMermaidConfig(source, {
parseFrontmatter })`, otherwise the built-in YAML subset is used.

## 4. The AST vocabulary

Every node is born from a constructor in `src/ast.js` with a fixed
member order (monomorphic; the structural hash is deterministic).

### 4.1 flowchart

```
{ direction, nodes[], edges[], subgraphs[], classDefs[], classes[], styles[] }
```

| Shape | Members |
|-------|---------|
| node | `{ id, label, shape }` — shape ∈ rect, round, stadium, subroutine, cylinder, circle, doublecircle, diamond, hexagon, parallelogram, parallelogram_alt, trapezoid, trapezoid_alt, asymmetric |
| edge | `{ from, to, stroke, head, tail, length, label }` — stroke ∈ solid/thick/dotted; head/tail ∈ none/arrow/circle/cross; `length` preserved so the printer is a fixed point |
| subgraph | `{ id, label, direction, nodes[] }` |
| classDef / class / style | `{ name, styles }` / `{ node, name }` / `{ node, styles }` |

A node `id` is alphanumeric/underscore (plus Unicode letters); `-` and
`.` are **excluded** so an id can never swallow a following link
operator — `A-->B` parses as an edge, not as a node with id `A-`. This
is a deliberate parser-correctness deviation from upstream Mermaid,
whose grammar permits those characters in ids.

### 4.2 sequence

```
{ participants[], statements[], autonumber }
```

`participants`: `{ id, label, kind }` (kind ∈ participant/actor).
`statements` is ordered; each is a `message`
(`{ kind, from, to, text, line, head, activation }`), a `note`
(`{ kind, placement, actors[], text }`), an `activate`/`deactivate`
(`{ kind, actor }`), or a `block`
(`{ kind:'block', blockType, branches:[{ label, statements[] }] }`) for
loop/opt/alt/par/critical/break.

### 4.3 class / er / state / pie

Class: `{ classes:[{ name, label, members[] }], relations[] }`. ER:
`{ entities:[{ name, attributes[] }], relationships[] }`. State:
`{ states:[{ id, label }], transitions:[{ from, to, label, event,
guard, effect, parent }] }` — a transition's `label` is the verbatim
text after `:` (what renderers draw and `toMermaid` prints), and
`event`/`guard`/`effect` are its UML reading, parsed as
`event [guard] / effect` with every part optional: the first `[` opens
the guard (nesting counted), the effect starts at the first `/` after
it (or the first `/` at all when there is no guard), and a label that
fits no pattern — an unmatched `[`, or text between `]` and `/` — reads
whole as the event, which keeps plain labels meaning what they always
meant. Pie: `{ title, showData, slices:[{ label, value }] }`.

Gantt is `{ meta, rules, sections:[{ name, tasks[] }], domain }` and is
described in §4.4, because it is the one AST that carries a *resolved*
answer rather than only what the source said.

### 4.4 gantt — a resolved schedule

```
{ meta, rules, sections:[{ name, tasks[] }], domain:{ start, end } }
```

`meta` holds the header lines **verbatim** (`title`, `dateFormat`,
`axisFormat`, `excludes`, `tickInterval`, `weekday`, `weekend`,
`todayMarker`), which is what keeps `printGantt` a fixed point. `rules`
holds the same directives *interpreted*:
`{ dateFormat, axisFormat, tick, weekStart, weekendStart, excludes,
todayMarker }`, where `tick` is `{ amount, unit }` or `null`,
`weekStart`/`weekendStart` are ISO weekdays (1 is Monday), and
`excludes` is `{ weekends, weekdays[], days[] }` with `days` as day
indexes from 1970-01-01.

A task is
`{ name, info, id, flags, start, end, duration, after, line }`. `info`
is the raw metadata string the printer emits; the rest is the schedule.
`start`/`end` are epoch milliseconds and the interval is **half-open**,
so `end` is the first instant the task no longer occupies — except a
milestone, which is the instant `start === end`. `flags` is the subset
of `done`, `active`, `crit`, `milestone` in that order. `domain` is the
half-open span every task falls inside, and it is what layout scales
against.

The AST stays geometry-free and plain JSON: no compiled closure and no
coordinate crosses this boundary. `layout/gantt.js` re-compiles the axis
pattern from `rules`, once per diagram.

#### The three grammars

A Gantt header speaks three pattern languages and **none of them is
Unicode LDML**, so each gets its own tokenizer and each token is mapped
individually onto the core vocabulary (`src/parser/gantt-grammar.js`):

| Directive | Grammar | Example |
|---|---|---|
| `dateFormat` | dayjs `customParseFormat` (moment's spelling) | `DD-MM-YYYY` |
| `axisFormat` | d3-time-format (strftime) | `%Y-%m-%d` |
| `tickInterval` | `^([1-9]\d*)(millisecond\|second\|minute\|hour\|day\|week\|month)$` | `1week` |
| a task duration | `^(\d+(?:\.\d+)?)([Mdhmswy]\|ms)$` | `3d`, `1.5w`, `2M` |

Handing `YYYY` straight to the core compiler would be a silent lie —
LDML's `YYYY` is the *week-numbering* year, so `YYYY-MM-DD` read as LDML
answers 2019 for `2018-12-31`. Note also that moment's `m` is a minute
while strftime's `%m` is a month: one shared table would mis-read half
of every diagram.

An **unsupported** token is a `JM` error naming the token and the
reason, not a literal passed through. The vendored conformance table —
every documented token of the Mermaid version this engine tracks, marked
supported or refused with its reason, plus the provenance of where it
was read — is `test/mermaid/fixtures/gantt-grammar.json`, and
`test/mermaid/gantt.test.js` pins the code against it in both
directions.

#### Task forms and working days

The field-count rule is Mermaid's own: one field is an end, two are a
start and an end, three add an explicit id in front, and the four flags
lead. `after <id …>` starts a task at the latest end of those ids;
`until <id …>` ends it at the earliest start of those. Ids may be
forward references — resolution is a topological pass — and a cycle, a
missing id, a duplicate id, a reversed span and an empty non-milestone
span are all refused with the offending line.

`excludes` removes whole days: `weekends` (the `weekend` day and the one
after it, saturday by default), weekday names, and dates written in the
document's own `dateFormat`. An end derived from a *duration* is pushed
out one day per excluded day it crosses; an end written as an explicit
*date* is the author's answer and is never pushed. The probes are the
instants `start + k days`, so a task starting Friday noon and lasting a
day ends Monday noon. Days are UTC days. This is not a holiday service:
a schedule skips exactly what its own `excludes` line lists.

#### Three deliberate divergences from Mermaid

1. **No clock.** Mermaid starts an undated first task *today*. This
   engine has no clock anywhere (`docs/ROADMAP.md`, "there is no now"),
   so a schedule with no dated anchor is a `JM` error rather than a
   diagram that means something different tomorrow. In practice only the
   first task needs a date. For the same reason `todayMarker` is kept
   in `meta` and never drawn.
2. **No silent literals** — an unsupported pattern token is refused by
   name, where Mermaid passes it through as text.
3. **No guessed dependencies** — Mermaid falls back to today for an
   `after` naming an unknown id; this engine refuses.

### 4.5 Secondary types

mindmap, gitGraph, journey, timeline, quadrantChart, requirement
parse-accept into `{ diagram, lines[] }` and render an honest "not yet
laid out" placeholder — counted in the coverage scorecard.

## 5. The bidirectional round trip

`toMermaid(doc)` is a **canonical** printer (one closure per diagram
type) and the reverse of `parseMermaid`. The normative contract:

> **`parseMermaid(toMermaid(doc))` deep-equals `doc.ast`** for the
> fully-modeled types (flowchart, sequence).

The flowchart printer emits in a fixed order — node declarations (AST
order) → subgraph membership → edges → classDef/class/style — and it is
that ordering which makes node order and edge order a fixed point on the
round trip. Subgraphs, however, round-trip **structurally, not as a
deep-equal fixed point**: they emit their members by bare id and a
re-parse reconstructs membership, so the shape survives but the strict
`nodes[]` ordering of a subgraph is not guaranteed to be `===`-identical
to the original.

The printer is canonical, not verbatim: it does not preserve source
whitespace or comments. Two round-trip modes coexist:

- **verbatim**, via the raw source stored in the Markdown fence `value`
  while a node is *untransformed*;
- **canonical**, via `toMermaid` once the AST changes or the engine is
  used standalone.

Because there is no per-plugin `toMarkdown` hook, a JSLT-transformed
diagram round-trips through `toMarkdown` only when its fence `value` is
refreshed with `toMermaid(newDoc)` — `refreshMermaidFence` is that
primitive.

### 5.1 Semantic projections

The geometry-free AST doubles as a domain model, and four JSLT
stylesheets in [`stylesheets/`](../stylesheets/) project it both ways —
plain data documents, no code:

| stylesheet | from → to |
|---|---|
| `state-to-workflow.jslt.json` | state DiagramDocument → executable machine (`@jarenjs/flow`'s jaren-fsm superset shape) |
| `workflow-to-state.jslt.json` | machine document → state AST (print with `toMermaid`) |
| `flowchart-to-dag.jslt.json` | flowchart DiagramDocument → jaren-dag **skeleton** (every node a `task` stub named by its id; edge labels become `port`s verbatim) |
| `dag-to-flowchart.jslt.json` | jaren-dag document → flowchart AST |

The forward state projection maps the parsed UML parts: `event` and
`guard` carry over when present, and an `effect` becomes
`effects: [{ "run": <effect text> }]` — the effect label **is** the
registry name by convention. The reverse composes the label from the
machine's parts and stays consistent with the parser by construction.

The dag projection renders each node kind as a fixed flowchart shape:

| kind | shape |
|---|---|
| `input` | stadium |
| `output` | doublecircle |
| `const` | circle |
| `query` | rect |
| `jslt` | round |
| `task` | subroutine |

Edge decorations print into the edge label as `port` / `port · select`
(joined with ` · `).

**Lossiness is documented, not hidden.** Diagrams are pictures of
machines; the document is the truth. A structured (non-string) guard
prints as the `[…]` placeholder; an effect prints its `run` name only
(multiple effects join with `, `), dropping any `with`; a structured
edge `select` prints as `…`. Round-tripping is exact for string guards
and bare run names, and deliberately lossy beyond that. Division of
labor: a cyclic flowchart **projects** to a dag skeleton without
complaint — acyclicity is `compileDag`'s job (`JF0016`), not the
projection's.

## 6. Layout & metrics (informative)

Layout is a separate pure pass (`layoutDiagram`) producing a
`PositionedDiagram` scene graph. Node/label sizes come from
`measureText`, a per-codepoint advance-width table for a default
sans-serif — an approximation, no `getBBox`, no DOM. Flowchart layout is
a compact dagre-lite (longest-path ranks, banded coordinates, straight
border-clipped edges); sequence layout resolves lifelines, message
y-advance, activation bars, notes and block frames. Geometry is
deterministic, so golden-JSON tests catch drift.

**State diagrams lay out through the flowchart engine** via an adapter
(`layoutState`), not a second algorithm: states become rounded nodes,
transition `label`s become edge labels verbatim, and the `[*]`
pseudo-states become synthetic `__start`/`__end` nodes (a fixed-size
filled `statedot` and an empty-labeled `doublecircle` ring — shapes
only the adapter produces; flowchart source cannot spell them).
Composite states stay flattened in v1, their recorded `parent` not yet
drawn as a cluster. `compileMermaid(source).toLayout()` exposes the
scene as a cached projection — reference-equal on repeated calls, null
for types without a geometric layout — so an editor hit-tests against
pure geometry without re-running layout.

## 7. Rendering

`diagramToVnode` turns a `PositionedDiagram` into a tagged-array SVG
vnode rooted at `['svg', …]`, which the `@jarenjs/view` patcher creates
in the SVG namespace. It is synchronous, complete and **error-safe**: a
parse/layout failure returns an error vnode, never throws. `toSvgString`
is `renderToString` of that vnode — a valid standalone SVG with no
browser.

**Stable identity for editors.** In flowchart and state output, every
node group carries `data-id="<AST node id>"` and every edge group
carries `data-edge="<index>" data-from="<id>" data-to="<id>"`, where
the index is the edge's AST position — which is also its docPath tail,
so a click maps to a document member without translation. These are
plain data props on the vnodes: SSR emits them, event delegation reads
them, and the state renderer's root additionally carries the
`mm-state` class for theming.
