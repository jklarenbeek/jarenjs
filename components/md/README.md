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
import { createTypeTestCompiler } from '@jarenjs/validate/query';

const plugins = [highlightPlugin(), mermaidPlugin()];   // native engine, no injected instance

// 1. Load + compile (cached by URL, AbortSignal-aware, streaming).
const md = await loadMarkdown('/docs/article.md', { plugins });

// 2. Frontmatter is plain JSON — and binds as JSLT externals.
const { title } = md.frontmatter;

// 3. A small JSLT transform of the AST: drop every h1.
const dropH1 = compileJsltStylesheet([
  { match: { path: '$.ast[*]', schema: { properties: { type: { const: 'heading' }, depth: { const: 1 } }, required: ['type', 'depth'] } },
    body: null },
], { compileTypeTest: createTypeTestCompiler() });   // schema-match hook
const trimmed = dropH1(md.doc);   // unmatched blocks stay ===

// 4. SSR: pure, deterministic (mermaid renders real inline SVG, no browser).
const ssr = renderToString(mdToVnode(trimmed, { plugins }));

// 5. Browser: mount and patch (mermaid's SVG is already complete — no hydrate).
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
- `md.hydrate(container)` runs plugin `hydrate` hooks (browser-only
  upgrades) over app-managed DOM, once per content hash. The bundled
  plugins need none — mermaid renders complete SVG synchronously — so
  this is a no-op until a hydrating third-party plugin is added.
- Pass `plugins` to extend the compiled-in set — e.g.
  `createMdComponent({ plugins: [highlightPlugin(), mermaidPlugin()] })`.

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

### Untrusted Markdown

Two filters run when an AST becomes vnodes, on the same principle: the
vnode format has no unescaped output, so nothing authored reaches the page
as markup or as a live URL.

- **Raw HTML** is dropped. `options.html: 'text'` shows it as literal
  text instead; `'vnode'` PARSES it through an allow-list
  (`@jarenjs/md/html`), keeping the elements a document legitimately
  uses — `<details>`, `<span class>`, `<img>`, tables — and dropping
  everything else. What makes that offerable is structural rather than a
  promise about filtering: the output is a vnode tree, so an
  unrecognised element contributes only its children's text, `on*`
  handlers and `style` never exist to begin with, `href`/`src` go
  through the same URL policy as Markdown's own links, and a
  `<script>`'s content is discarded rather than shown. It is not an
  HTML5 parser — unbalanced input closes at the end of its run — and a
  host with its own rules injects them through `options.parseHtml`.
- **Link and image URLs** whose scheme can execute (`javascript:`,
  `vbscript:`) or stand in for a document (`file:`, `data:` other than a
  raster image) lose their `href`/`src`; the element and its text stay, so
  nothing the author wrote disappears. Relative references — `image.png`,
  `docs/guide.md` — are not schemes and pass untouched. The AST keeps the
  URL verbatim, so `toMarkdown` still round-trips it.

`options.sanitizeUrl` — `(url) => string | null` — replaces the URL policy
wholesale when a host needs a custom scheme in trusted content. It is the
whole guard, so widen it deliberately. Plugin `render` functions shadow the
core emitter and own the rule for URLs they emit; `ctx.sanitizeUrl` is the
active policy ([PLUGINS.md](docs/PLUGINS.md) §5, [MD-FORMAT.md](docs/MD-FORMAT.md) §4.3).

## Performance contract

Measured, not claimed — `npm run benchmark:markdown`, 2026-07-19, Node
v22.22.2 (run it yourself; micro-timings vary ±15%):

- **Parse to AST**: ~75 µs for a typical ~2 kB document, ~0.30 ms for
  ~10 kB, ~3.0 ms for ~100 kB — linear in input. A CPU profile puts the
  inline phase at ~36% of that and the source hash for `meta.hash` at
  ~10%; the block scan, the obvious suspect, is ~14%. (Replacing one
  `/\s+$/` regex at paragraph close with a scan was worth 4–17%
  depending on how paragraph-dense the document is — measured as an A/B
  on this corpus, because the same change looked like noise on a
  differently shaped one.)
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
- **CommonMark scorecard**: 571 of 655 spec examples (87.2%) under the
  spec's normalization, reported honestly as coverage of the pragmatic
  dialect. 47 of the 84 remaining **cannot pass by construction**: the
  spec renders raw HTML verbatim, including a lone `</div>` or a
  never-closed tag, and a vnode tree cannot hold half an element. The
  rest are real dialect gaps (loose-list paragraph wrapping, emphasis
  flanking, link-label edge cases) tracked in the
  [ROADMAP](../../ROADMAP.md). The scorecard runs against the official
  spec as a git submodule, QT3-style, and compares rendered meaning:
  whitespace that only lays markup out is normalized away on every
  engine's output, not just this one's.

## Development

Tests live in the repository root: [`test/md/`](../../test/md)
(`npm run test:md`) — CommonMark-subset and GFM conformance, frontmatter,
plugins, structural sharing, streaming, loader caching, and AST-schema
validation through `@jarenjs/validate`. The benchmark methodology is
documented in [benchmark/README.md](../../benchmark/README.md). See the
repo [README](../../README.md) and [ROADMAP](../../ROADMAP.md) for the
bigger picture, and [ARCHITECTURE.md](ARCHITECTURE.md) for the
internals.
