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

```json
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

### 4.3 class / er / state / gantt / pie

Class: `{ classes:[{ name, label, members[] }], relations[] }`. ER:
`{ entities:[{ name, attributes[] }], relationships[] }`. State:
`{ states:[{ id, label }], transitions:[{ from, to, event, parent }] }`.
Gantt: `{ meta, sections:[{ name, tasks[] }] }`. Pie:
`{ title, showData, slices:[{ label, value }] }`.

### 4.4 Secondary types

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

## 6. Layout & metrics (informative)

Layout is a separate pure pass (`layoutDiagram`) producing a
`PositionedDiagram` scene graph. Node/label sizes come from
`measureText`, a per-codepoint advance-width table for a default
sans-serif — an approximation, no `getBBox`, no DOM. Flowchart layout is
a compact dagre-lite (longest-path ranks, banded coordinates, straight
border-clipped edges); sequence layout resolves lifelines, message
y-advance, activation bars, notes and block frames. Geometry is
deterministic, so golden-JSON tests catch drift.

## 7. Rendering

`diagramToVnode` turns a `PositionedDiagram` into a tagged-array SVG
vnode rooted at `['svg', …]`, which the `@jarenjs/view` patcher creates
in the SVG namespace. It is synchronous, complete and **error-safe**: a
parse/layout failure returns an error vnode, never throws. `toSvgString`
is `renderToString` of that vnode — a valid standalone SVG with no
browser.
