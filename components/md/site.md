---
package: "@jarenjs/md"
card:
  title: Markdown
  blurb: >-
    The inverse of JTLT: CommonMark + GFM + frontmatter parsed into a JSON
    AST — transformed by JSLT, rendered by @jarenjs/view with content-hash
    keys and structural sharing. Ships an app-ready visual component.
  perf: >-
    measured against marked, markdown-it and micromark; constant-time
    re-render
engines:
  - key: markdown
    suite: markdown
---

The inverse of JTLT: `@jarenjs/md` parses Markdown (CommonMark core + GFM
tables, strikethrough, task lists, footnotes and autolink literals +
YAML/JSON/TOML frontmatter) into a plain JSON AST the whole suite consumes —
JSLT transforms it, queries address it, `toMarkdown` prints canonical
round-trip text, and the view patcher renders it with content-hash keys and
structural sharing.

```js
import { parseMarkdown, toMarkdown } from '@jarenjs/md';
const doc = parseMarkdown('# Hi *there*');
doc.ast[0].type;          // 'heading'
toMarkdown(doc);          // '# Hi *there*\n' — a fixed point
```

Part two is the visual component (`@jarenjs/md/component`): a memoized `view()`
projection for app viewModels, md-load / md-parse entries for the effect
registry, a hydrate pass for plugins like mermaid, and the styles/md.css
stylesheet. Play’s Markdown engine on this site is that component, live.

```js
import { createMdComponent } from '@jarenjs/md/component';
const md = createMdComponent();
createApp(appDoc, {
  effects: { ...md.effects },
  viewModel: (state) => ({ ...state, article: md.view(state.source) }),
});
```

Two emitters, one AST, and neither built on the other: `toHtml` writes bytes,
`mdToVnode` builds a patchable tree. A vnode has no slot for unescaped author
markup, which is what makes it safe for Markdown you did not write; a string
does, which is why the raw-HTML corner of CommonMark is reachable through
`toHtml` and only there. Escaping is the default in both; `html: 'raw'` is
per-call and trusted-input-only.

```js
import { toHtml, mdToVnode } from '@jarenjs/md';
toHtml(doc);                       // '<h1>Hi <em>there</em></h1>' — escaped by default
toHtml(doc, { html: 'raw' });      // trusted input only
mdToVnode(doc, { keyed: false });  // SSR: skip the content-hash keys
```

Directives carry a value a machine derives and a human reads. The carrier is an
HTML comment, which every markdown renderer drops — so the baked text between
the markers is what GitHub, an editor preview and npm show, with no runtime.
`bake()` writes the fresh value back into the source, splicing only the spans
between markers, so a re-derivation is a reviewable diff instead of a number
that quietly stopped being true. Every measured figure in this repository’s own
documents works that way.

Measured like every other engine, on two corpora: the Markdown benchmark scores
`@jarenjs/md` against marked, markdown-it and micromark over the official
CommonMark spec examples, and over the GFM specification’s five extension
sections with every engine’s extensions on (`npm run benchmark:markdown`). Both
jaren rows are published — the string emitter and the vnode emitter — because
the difference between them is the safety boundary, not a rounding error. The
results are on the Benchmarks page.

> **Try it** — Play’s Markdown engine parses as you type — the preview, AST,
> canonical print and frontmatter all come from one compiled document. The
> Benchmarks page has its scorecard and timings against the mainstream parsers.
> [Open Play](#/play?engine=markdown)
