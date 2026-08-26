---
package: "@jarenjs/mermaid"
card:
  title: Mermaid
  blurb: >-
    A native, headless Mermaid clone: diagrams-as-code parsed to a
    geometry-free JSON AST and rendered as pure-vnode SVG through
    @jarenjs/view — SSR-able with no browser, structurally shared,
    bidirectional (parseMermaid ⇄ toMermaid).
  perf: >-
    headless SVG, constant-time re-render
engines:
  - key: mermaid
    suite: mermaid
---

A native, headless Mermaid clone: `@jarenjs/mermaid` parses diagrams-as-code
(flowchart, sequence, state and gantt fully; class, ER and pie too) into a
geometry-free JSON AST, then lays it out and renders pure-vnode SVG through
`@jarenjs/view` — no innerHTML, no browser. `render()` is synchronous, complete
and error-safe, memoized by content hash.

```js
import { parseMermaid, toMermaid, renderMermaid } from '@jarenjs/mermaid';
const doc = parseMermaid('flowchart TD\n  A --> B');
toMermaid(doc);           // canonical text — a round-trip fixed point
renderMermaid('flowchart TD\n  A --> B'); // an ['svg', …] vnode
```

Because the AST is geometry-free it is a reusable semantic model: a
stateDiagram-v2 projects via a JSLT stylesheet into an executable
`@jarenjs/flow` machine (`jaren-fsm`) and a flowchart into a `jaren-dag`
dataflow — both run, both project back to editable diagram text through
`toMermaid`. Rendering is one consumer of the model, not the only one; see the
Flow section.

The Markdown engine embeds it: a ```mermaid fence renders to inline SVG through
the native plugin — SSR-safe, no injected instance. This site dogfoods it; the
package READMEs render their own Mermaid diagrams live in the docs dialog. Pie
rendering delegates to `@jarenjs/charts` — same SVG, one pie engine for the
whole suite.

> **Try it** — Play’s Mermaid engine parses as you type — the rendered SVG, the
> geometry-free AST and the canonical `toMermaid` round-trip all come from one
> compiled document. The Benchmarks page has its coverage scorecard and
> parse-speed numbers. [Open Play](#/play?engine=mermaid)
