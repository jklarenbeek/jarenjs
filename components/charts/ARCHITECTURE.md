# @jarenjs/charts Architecture

How the headless chart engine is put together. The user-facing story is
the [README](README.md); the design mirrors
[`@jarenjs/mermaid`](../mermaid/ARCHITECTURE.md) deliberately.

## Engine and component (the two layers)

| | Engine (part one) | Visual component (part two) |
|---|---|---|
| Entry points | `@jarenjs/charts`, `@jarenjs/charts/transforms/*` | `@jarenjs/charts/component`, `@jarenjs/charts/styles/charts.css` |
| Source | `src/core/`, `src/types/`, `src/transforms/` | `src/component/`, `styles/` |
| Job | definition + data ⇄ AST ⇄ vnode **values** | package those values for a rendering **host** |
| Knows about | `@jarenjs/core` + `@jarenjs/view` (SVG builders, `textWidth`, `resolveTheme` from `@jarenjs/view/helpers`) | the engine, plus `@jarenjs/app`'s viewModel shape |
| Ships CSS | no | yes (`styles/charts.css`) |
| State | none — pure functions over data | memoization caches |

The dependency arrow points **one way**: the engine never imports the
component, `@jarenjs/app`, or the DOM — it runs in a worker, an edge
runtime or a build step. `@jarenjs/mermaid` depends on charts (its pie
delegates here); charts never imports mermaid.

## The geometry-free AST contract

Every chart type is one file in `src/types/` exporting two stages:

- `build{Type}AST(data, config)` — data → an AST in **abstract space**:
  fractions, angles, `[0,1]` unit coordinates, category names. No
  pixels, no colors, no font metrics. The AST is plain JSON — walkable,
  diffable, serializable.
- `render{Type}AST(ast, theme, hash, options?)` — AST → pure-vnode SVG.
  Pixel mapping, palette lookup and text measurement
  (`@jarenjs/view/helpers` `textWidth`) happen only here.

`compileChart(config, data, options)` dispatches on `config.type` and
returns cached projections (`ast`, `toVnode()`, `toSvgString()`), the
`compileMermaid` bundle shape.

Twelve types follow the contract: the original five (`pie` — donut
variant included — `bar`, `line`, `scatter`, `candlestick`) plus
`radar`, `gauge`, `boxplot`, `heatmap`, `treemap`, `streamgraph` and
`sankey`. Cartesian types share `cartesianFrame`; `radar`/`gauge` are
polar around their own centers; `treemap`/`sankey` lay out in the unit
square with `y` growing downward (no axes — reading order wins). Types
added after the first five give every value-carrying mark a `<title>`
child (native SSR-safe hover text); the first five keep their
byte-stable output, so per-mark titles there would be a deliberate
golden-fixture regeneration.

## Scales and axes (`src/core/`)

Scales are pure `domain -> (value) => [0,1]` closures — construction
may allocate lookup maps, calls never allocate. Out-of-domain values
map outside `[0,1]` (linear/log/time) or to `NaN` (ordinal/band);
`num`/`polylinePath` in the render layer are the guards that keep a
`NaN` out of emitted strings. `scaleLog` rejects a non-positive
*domain* once, at construction. Axis tick generators return domain
values: nice-number steps (`1/2/5 × 10^k`) for linear axes, decade
powers for log axes, band centers for ordinal axes.

## Colors and theming

Two distinct mechanisms, per DESIGN.md:

- The **categorical palette** (`CATEGORICAL`) is a concrete constant in
  the suite anchor order — not theme tokens (DESIGN.md §8). It is the
  palette the mermaid pie always used, so pies render byte-identically
  through either package. Its magnitude counterpart is **`SEQUENTIAL`**,
  a single-hue blue ramp (light→dark, monotone perceptual lightness,
  both ends legible on the light and the dark surface) sampled
  continuously by `sequentialColor(t)` — the heatmap's cell fill. Text
  set *inside* a concrete fill (treemap tile labels) picks its ink with
  `inkFor(fill)` by fill luminance, not by theme — the fill is a
  constant, so the legible ink is too.
- The **semantic tokens** (text, muted, grid, axis, win/loss,
  sliceStroke) resolve through the shared `resolveTheme` kernel with
  the `chart` prefix. `createTheme('host')` links them to the site
  token vocabulary (`--fg`, `--border`, `--ok`, `--fail`, …) via
  `HOST_VARS`, stamping `var(--host-token, concrete)` inline on the
  root `<svg>` — the two-layer theming architecture of DESIGN.md §7.
  Sync invariant: the token tables in `src/core/palette.js` must match
  the `--chart-*` fallbacks in `styles/charts.css`.

Engine render code contains no hex literals; every color comes from the
palette constant or a theme token.

## Memoization (the honest story)

- `hashContent` takes a **string**. It is used only on the
  stable-stringified config (`stableStringify` from
  `@jarenjs/core/object`) to derive the root vnode key — never on an
  object (an object would coerce to `"[object Object]"` and collide
  universally).
- Chart output caching is **identity-based**: the component's `view()`
  holds a WeakMap keyed on the data object, with an inner map keyed on
  the config hash. Static data objects are stable → O(1) re-patches;
  streaming snapshots are fresh objects → every tick re-renders, and
  the WeakMap lets old snapshots be collected.

## The streaming contract (with @jarenjs/josl)

`src/core/stream-adapter.js` consumes the unified event vocabulary the
josl readers emit — the shared core is the `pair` event
(`{type:'pair', path, key, value, line}`), identical from
`createStreamReader` (JOSL/TOML) and `createJsonxStreamReader`
(JSONX/strict JSON), so the adapter never branches on syntax and this
package never depends on a parser. Record assembly is path-prefix
matching (`recordPath`); the two `recordBoundary` modes map onto the
two streaming shapes (incremental document vs. message feed). Snapshot
objects from `getData()` are fresh per call on purpose: the component's
identity-keyed memo then re-renders exactly once per snapshot.

The benchmark transforms (`src/transforms/benchmark-adapter.js`) are
the static counterpart: pure functions from the website's published
benchmark shapes to `{config, data}` pairs.

## Mermaid delegation

`mermaidPieToChartAST` (`src/transforms/mermaid-adapter.js`) maps a
mermaid pie AST to `{config, data}`. Mermaid's `renderPie` calls
`buildPieAST` + `renderPieAST` with options carrying its class names
(`mm-pie-slice`, …), key prefix (`mmpie-`), palette and theme — making
the emitted SVG byte-identical to the pre-delegation renderer while the
geometry lives in exactly one place.
