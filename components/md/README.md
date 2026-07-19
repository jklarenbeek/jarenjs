# @jarenjs/md

Markdown + frontmatter as JSON documents — one package, **two clearly
separated layers**:

1. **The engine** (`@jarenjs/md`, part one). Where JTLT (in
   [`@jarenjs/json`](../../packages/json)) turns JSON into text, the
   engine is the inverse arrow: it parses Markdown — CommonMark core,
   GFM tables/strikethrough/task lists, YAML/JSON/TOML frontmatter —
   into a stable, serializable AST that the rest of the suite consumes
   natively. JSLT stylesheets transform it, query documents address it,
   [`@jarenjs/view`](../../packages/view) renders it (DOM and SSR), and
   [`@jarenjs/app`](../../packages/app) loads it as a resource. The
   engine is headless: it produces and prints *values* and never
   touches a host.
2. **The visual component** (`@jarenjs/md/component` +
   `@jarenjs/md/styles/md.css`, part two). The presentation layer that
   drops the engine into a rendering host — above all an
   `@jarenjs/app` document: a memoized, reference-stable `view()`
   projection for viewModels, `md-load`/`md-parse` entries for the
   effect registry, a `hydrate()` pass for browser-only plugin
   upgrades, a default plugin set with syntax highlighting on, and the
   component stylesheet. The [jarenjs website](../../packages/website)'s
   playground *Markdown* tab is this component, live.

The layer boundary is a hard rule, not a convention: the engine never
imports from `src/component/` or ships CSS, and the component adds no
parsing semantics — it only packages engine output for hosts (the
rationale is spelled out in [ARCHITECTURE.md](ARCHITECTURE.md)). Zero
runtime dependencies outside the suite; no `eval`; the same
parse-once/compile-to-closures design as every other Jaren engine.

## The format in one glance

```js
import { parseMarkdown } from '@jarenjs/md';

parseMarkdown('---\ntitle: Hello\n---\n# Hi *there*');
// {
//   "$md": "0.1",
//   "frontmatter": { "title": "Hello" },
//   "ast": [
//     { "type": "heading", "depth": 1, "children": [
//       { "type": "text", "value": "Hi " },
//       { "type": "emphasis", "children": [{ "type": "text", "value": "there" }] }
//     ] }
//   ],
//   "meta": { "sourceUrl": null, "hash": "8k41x2", "frontmatterLang": "yaml" }
// }
```

- Every node is a plain object with a `type` discriminator; containers
  hold `children`, literals hold `value`.
- Frontmatter (`---` YAML subset, `---json`/leading-`{` JSON, `+++`
  TOML) normalizes to plain JSON on the document.
- The whole document is JSON: stringify it, diff it with JSON Patch,
  validate it against
  [`schemas/jaren-md-ast.schema.json`](schemas/jaren-md-ast.schema.json),
  transform it with JSLT, generate it under constrained decoding.

The normative contracts live in [docs/MD-FORMAT.md](docs/MD-FORMAT.md)
(AST + frontmatter), [docs/PLUGINS.md](docs/PLUGINS.md) (the
compile-time plugin system) and [docs/LOADER.md](docs/LOADER.md) (the
lazy URL loader).

## Usage

### Parse, print, project

```js
import { parseMarkdown, toMarkdown, mdToVnode, compileMarkdown } from '@jarenjs/md';
import { renderToString } from '@jarenjs/view';

const doc = parseMarkdown(source);        // → MdDocument (plain JSON)
const canonical = toMarkdown(doc);        // → canonical Markdown (round-trips)
const vnode = mdToVnode(doc);             // → view vnode, content-hash keys
const html = renderToString(vnode);       // → SSR string

// Or compile once and reuse the cached projections:
const md = compileMarkdown(source, { retainSource: false });
md.toVnode() === md.toVnode();            // true — built at most once
```

### End to end: URL → frontmatter → JSLT → plugins → DOM + SSR

The full pipeline, runnable as-is in a browser module (swap the URL);
on the server, keep everything up to `renderToString`:

```js
import { loadMarkdown, createMdRenderer } from '@jarenjs/md';
import { highlightPlugin, mermaidPlugin } from '@jarenjs/md/plugins';
import { renderToString } from '@jarenjs/view';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';

const mermaid = (await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')).default;
const plugins = [highlightPlugin(), mermaidPlugin({ mermaid })];

// 1. Load + compile (cached by URL, AbortSignal-aware, streaming).
const md = await loadMarkdown('/docs/article.md', { plugins });

// 2. Frontmatter is plain JSON — and binds as JSLT externals.
const { title } = md.frontmatter;

// 3. A small JSLT transform of the AST: drop every h1.
const dropH1 = compileJsltStylesheet([
  { match: { path: '$.ast[*]', schema: { properties: { type: { const: 'heading' }, depth: { const: 1 } }, required: ['type', 'depth'] } },
    body: null },
], { compileTypeTest });   // hook from '@jarenjs/validate/query'
const trimmed = dropH1(md.doc);   // unmatched blocks stay ===

// 4. SSR: pure, deterministic (mermaid renders its placeholder).
const ssr = renderToString(mdToVnode(trimmed, { plugins }));

// 5. Browser: mount, patch, and hydrate (mermaid swaps in the SVG).
const render = createMdRenderer({ container: document.getElementById('app'), plugins });
render(md);
```

`streamMarkdown(url)` yields completed top-level blocks while the body
is still downloading, and `createIncrementalParser()` is the same core
for non-URL sources — see [docs/LOADER.md](docs/LOADER.md).

### Plugins are compile-time

```js
import { definePlugin } from '@jarenjs/md';

const callout = definePlugin({
  name: 'callout',
  node: 'callout',
  blocks: [{ chars: ':', start, continue: cont, close }],
  render: (node, h) => h('aside', { class: 'md-callout' }, node.value),
});
parseMarkdown(source, { plugins: [callout] });
```

All extensibility — fence claims, block rules, inline rules, renderers,
hydrators — is declared up front and baked into dispatch tables; the
hot loops only do indexed lookups. Without a plugin, its syntax
degrades gracefully (a ` ```mermaid ` fence is just a `code` node). The
contract and both reference plugins are specified in
[docs/PLUGINS.md](docs/PLUGINS.md).

### The visual component (part two)

Everything an `@jarenjs/app` document needs, as one bundle:

```js
import { createApp } from '@jarenjs/app';
import { createMdComponent } from '@jarenjs/md/component';
import '@jarenjs/md/styles/md.css';   // .md rhythm + tok-* colors, light/dark

const md = createMdComponent();        // default plugins: syntax highlighting

createApp(appDoc, {
  node,
  effects: { ...md.effects },          // 'md-load' and 'md-parse'
  viewModel: (state) => ({ ...state, article: md.view(state.doc) }),
});

// An action loads a document through the effect registry:
// { "effects": [{ "run": "md-load",
//                 "with": { "url": "$.url", "done": "article/loaded" } }] }
```

- `md.view(sourceOrDoc)` is **memoized and reference-stable**: the same
  source string (or the same parsed document) returns the same vnode
  reference, so the view patcher skips an unchanged article in O(1) —
  the derivation contract `@jarenjs/app` viewModels rely on.
- `md.effects['md-load']` resolves any URL through the loader (cache,
  abort, streaming) and dispatches the plain `MdDocument` as the
  action payload; `md-parse` does the same for an in-state source
  string. Failures route to an optional `error` action.
- `md.hydrate(container)` runs plugin `hydrate` hooks (mermaid's SVG
  swap) over app-managed DOM, once per content hash.
- Pass `plugins` to extend the compiled-in set — e.g.
  `createMdComponent({ plugins: [highlightPlugin(), mermaidPlugin({ mermaid })] })`.

### Forms and apps

- A document whose frontmatter declares a schema (`form:` or `$schema`)
  feeds [`@jarenjs/forms`](../../packages/forms) through `mdToForm(doc, forms)` —
  `{ schema, fields, data }`, with the forms module injected so this
  package stays dependency-free.
- In an [`@jarenjs/app`](../../packages/app) document, a view can be a JSLT
  stylesheet over a loaded MdDocument: register `loadMarkdown` as an
  async effect that dispatches the plain `MdDocument` into the state,
  and let the app's view stylesheet (`{"$apply": "$.doc.ast[*]"}`
  rules, or simply `mdToVnode` inside a `viewModel` derivation) produce
  the vnodes. Frontmatter members bind as externals via
  `compiled.externals()`.

## Performance contract

Measured, not claimed — `npm run benchmark:markdown`, 2026-07-19, Node
v22.22.2 (run it yourself; micro-timings vary ±15%):

- **Parse to AST**: ~72 µs for a typical ~2 kB document, ~0.3 ms for
  ~10 kB, ~3.1 ms for ~100 kB — linear in input.
- **Parse + render to HTML** (the cross-engine row): within 1.1–1.5x of
  `marked` and `markdown-it`, 6–15x faster than `micromark`, on the
  same GFM documents.
- **The compiled fast path**: `compileMarkdown(...).toVnode()` returns
  the cached projection in ~30 ns — and because block vnodes carry
  content-hash keys and unchanged AST nodes emit reference-equal
  vnodes, the view patcher skips unchanged blocks in O(1). A JSLT
  identity transform returns the document by reference; a partial
  transform keeps every unmatched subtree `===`. That pipeline — not
  the one-shot HTML render — is what this package is optimized for.
- **CommonMark scorecard**: 526 of 655 spec examples (80.3%) under the
  spec's normalization, reported honestly as coverage of the pragmatic
  dialect (raw-HTML pass-through examples cannot pass by design: the
  vnode format has no unescaped output). The scorecard runs against
  the official spec as a git submodule, QT3-style.

## Development

Tests live in the repository root: [`test/md/`](../../test/md)
(`npm run test:md`) — CommonMark-subset and GFM conformance, frontmatter,
plugins, structural sharing, streaming, loader caching, and AST-schema
validation through `@jarenjs/validate`. The benchmark methodology is
documented in [benchmark/README.md](../../benchmark/README.md). See the
repo [README](../../README.md) and [ROADMAP](../../ROADMAP.md) for the
bigger picture, and [ARCHITECTURE.md](ARCHITECTURE.md) for the
internals.
