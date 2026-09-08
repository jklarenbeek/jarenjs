# @jarenjs/md

Markdown + frontmatter as JSON documents — one package, **two clearly
separated layers**:

1. **The engine** (`@jarenjs/md`, part one). Where JTLT (in
   [`@jarenjs/json`](../../packages/json)) turns JSON into text, the
   engine is the inverse arrow: it parses Markdown — CommonMark core,
   GFM tables, strikethrough, task lists, footnotes and autolink
   literals, YAML/JSON/TOML frontmatter —
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

### An HTML string, in one call

```js
import { parseMarkdown, toHtml } from '@jarenjs/md';

toHtml(parseMarkdown(source));                        // '<h1>Hi</h1><p>…</p>'
toHtml(doc, { wrap: 'article class="md"' });          // wrapped, like the vnode path
toHtml(doc, { html: 'raw' });                         // TRUSTED INPUT ONLY
```

`toHtml` writes bytes; `mdToVnode` builds a patchable tree. Neither is
implemented in terms of the other, because their targets differ: a vnode
is keyed, memoized and reconciled in O(1) by `@jarenjs/view`, and its
safety is structural — there is no slot in it for unescaped author
markup. A string has one, which is why the raw-HTML corner of CommonMark
is reachable through `toHtml` and only through it.

The `html` option is the whole difference:

| mode | what a raw-HTML node becomes |
|---|---|
| `'escape'` (default) | escaped text — the markup is **visible**, not live |
| `'skip'` | dropped, as the vnode path drops it by default |
| `'raw'` | passed through verbatim — **trusted input only** |

The URL policy is orthogonal and runs in **every** mode: `'raw'` says
"this document's HTML blocks are trusted", not "trust everything", so a
markdown `[x](javascript:…)` still loses its `href`. No surface in this
repository passes `'raw'`.

For markup a vnode *can* express, the two emitters produce byte-identical
output — asserted over the CommonMark corpus in
[`test/md/to-html.test.js`](../../test/md/to-html.test.js), not on one
fixture.

### Heading anchors

`[see below](#the-section)` needs something to land on, so the emitter can
give every heading a GitHub-compatible `id` — the same slug GitHub mints,
so one committed README anchors identically on GitHub, in an editor
preview and wherever you render it:

```js
mdToVnode(doc, { headingIds: true });
// ['h2', { id: 'quick-start' }, 'Quick start']

mdToVnode(doc, { headingIds: true, headingAnchors: true });
// … plus a trailing ['a', { class: 'md-anchor', href: '#quick-start', … }, '#']
// so a reader can copy a link to the section

mdToVnode(doc, { headingIds: true, slugPrefix: 'user-content-' });
// every id and anchor href prefixed — set this for markdown you did not
// author, so its ids cannot collide with your own page's
```

Repeated headings are numbered the way GitHub numbers them (`setup`,
`setup-1`, `setup-2`), and a heading with no slug-worthy text (`## ***`)
lands on `section`. Ids are **off by default on purpose**: CommonMark
renders a heading as `<h1>Foo</h1>`, so emitting one by default would put
the conformance score below at odds with what the package produces. The
rules are normative in [MD-FORMAT.md](docs/MD-FORMAT.md) §4.5; the slug
transform is `slugify` from `@jarenjs/core/string`.

The affordance styles itself from `styles/md.css` and stays quiet until
its heading is hovered or it takes focus. A page with a sticky header
sets `--md-scroll-margin` so a scrolled-to heading does not land beneath
it.

### Footnotes and bare links (GFM)

Both are on with `gfm` (the default) and both are **additive**: with
`gfm: false` the output is byte-for-byte what it was before they existed.

```md
A claim.[^1] Visit www.example.com or mail a@b.test.

[^1]: The source, which may hold [several](/blocks) blocks.
```

A footnote definition stays **where the author wrote it** in the AST —
the document is what was written, not what one renderer makes of it — and
the emitters collect it: references become `<sup>` links, uncited
definitions render nothing at all, and one `<section class="footnotes">`
is appended after the last block.

- **Numbering follows the first reference**, not definition order or
  label order. Cite `[^b]` before `[^a]` and `b` is footnote 1.
- **An undefined `[^nope]` stays literal text**, exactly as on GitHub —
  a citation of nothing is not a link to nothing.
- **Ids carry `user-content-` by default** (GitHub's own answer), so a
  document dropped into a page you own cannot collide with its `#fn-1`.
  `slugPrefix` replaces the prefix; `slugPrefix: ''` opts out.
- **A footnote cited twice gets two landing places** and two
  back-references, so `↩` returns the reader where they left.
- **A footnote may cite another**, cycles included; the collection
  terminates because each definition is rendered once.
- With `wrap: null` (a bare fragment) the section is appended **inside**
  the fragment, after the last block — a consumer concatenating fragments
  gets one footnotes section per fragment.

Literal autolinks follow GFM's extended grammar, trailing-punctuation
rules and all — `www.example.com/a.b.` links `www.example.com/a.b` and
leaves the sentence's full stop alone. The AST holds a plain `link` with
the scheme already inserted (`http://www.example.com/a.b`) plus an
`auto: true` flag, which exists for exactly one consumer: `toMarkdown`,
which prints it back bare instead of as `[text](url)`. Both features are
normative in [MD-FORMAT.md](docs/MD-FORMAT.md) §4.6 and §4.7.

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
- `md.view(sourceOrDoc, policy)` renders that one call under a
  **rendering policy**, for a host whose documents do not all come from
  the same place. Heading ids are the live case: ids are a page's
  namespace, so markdown the host authored may mint them bare while
  markdown from anywhere else renders with a `slugPrefix` —

  ```js
  const TRUSTED = { slugPrefix: '' };                    // your own documents
  const UNTRUSTED = { slugPrefix: 'user-content-' };     // everyone else's

  md.view(readme, TRUSTED);          // id="setup"
  md.view(reply, UNTRUSTED);         // id="user-content-setup"
  ```

  A policy may name `headingIds`, `slugPrefix`, `headingAnchors`,
  `footnotesLabel`, `html` and `keyed` — the options that shape the
  emitted vnode; anything else (`plugins`, `sanitizeUrl` — construction-
  time decisions, and `plugins` changes the *parse*) is **refused**, not
  ignored. The projection is memoized per source **and** policy, so
  alternating provenances cannot thrash the cache and each stays
  reference-stable; the parse and the hydratable index are shared, which
  is why this is one component and not two. A call that names no policy
  renders under the construction-time options, unchanged.
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
  package stays dependency-free. When frontmatter omits `data`, the built
  form model supplies schema defaults and `const` values; explicit data,
  including `null`, is preserved.
- In an [`@jarenjs/app`](../../packages/app) document, a view can be a JSLT
  stylesheet over a loaded MdDocument: register `loadMarkdown` as an
  async effect that dispatches the plain `MdDocument` into the state,
  and let the app's view stylesheet (`{"$apply": "$.doc.ast[*]"}`
  rules, or simply `mdToVnode` inside a `viewModel` derivation) produce
  the vnodes. Frontmatter members bind as externals via
  `compiled.externals()`.

### mdx — markdown × data

`@jarenjs/md/mdx` renders a markdown TEMPLATE against a data document —
still a pure `(doc, data) → doc` pass over the parsed AST, so
`mdToVnode`, `toMarkdown` and the plugins all work unchanged on the
result. The template vocabulary reuses the suite's own query
expressions — no new mini-language:

```js
import { createMdx } from '@jarenjs/md/mdx';
import { compileJsonQuery } from '@jarenjs/json';

const mdx = createMdx({ compileQuery: compileJsonQuery });
const doc = mdx.transform(parseMarkdown(source), data);
```

- `{$.path}` inline in text interpolates a query expression over the
  data (`$` is the data document; `$name` externals come from the
  frontmatter — the same binding JSLT gets — and from `each` loops).
  Code spans, code blocks and raw HTML never interpolate.
- A paragraph of exactly `{#if <expr>}` … `{/if}` keeps its section only
  when the expression is truthy; `{#each <expr> as <name>}` … `{/each}`
  repeats its section per item, binding `$<name>`. Sections nest, and a
  directive must form its own paragraph (blank lines around it).
- The expression compiler is **injected** (`compileJsonQuery` from
  [`@jarenjs/json`](../../packages/json)), so this package's engine layer
  keeps its core+view-only dependency contract. A bad expression renders
  its diagnosis in place — the pass never throws.

- `<!--mdx:$.path-->fallback<!--/mdx-->` is the **same expression through
  the same evaluator**, carried in a comment. Use it in a document that
  is also read raw; use `{$.path}` in one that is always rendered
  dynamically, where it is the terser read. See Directives below.

Try it live: the `MDX` engine on
[Play](https://jklarenbeek.github.io/jarenjs/#/play) runs this pass over
an editable data pane.

### Directives — a number a machine derives and a human reads

```markdown
Jaren is <!--fact:jsonpath.ctsRatio-->8.8<!--/fact-->x faster across the CTS queries.
```

Every markdown renderer on earth drops HTML comments, so GitHub, an editor
preview and npm all show that line as one plain sentence with the figure in
it and no markers — static text, no runtime, correct today. A
directive-aware consumer reads the marker instead and can re-derive the
value:

```js
import { scanDirectives, replaceDirectives } from '@jarenjs/md/directives';
import { bake } from '@jarenjs/md';

scanDirectives(doc, { ns: 'bm' });        // → { directives, diagnostics }
replaceDirectives(doc, { ns: 'bm' }, …);  // → a new doc, untouched subtrees ===
bake(source, { ns: 'bm', resolve });      // → { text, changed, diagnostics }
```

`bake` writes the fresh value **into the source**, which is what makes a
re-derivation a reviewable diff instead of a number that quietly stopped
being true. It splices only the spans between markers — a document with
no directives comes back byte-identical — because `toMarkdown` is a
canonicalizing printer and re-printing a hand-written README would reflow
every list for no reason. This repository's own figures work exactly this
way (`npm run docs:derive`, `npm run docs:check`).

The layer never interprets the payload: `bm` puts a derivation key there,
`mdx` puts a query expression, and the vocabulary belongs to the
consumer. Unpaired markers, stray closers and same-namespace nesting come
back as **diagnostics** rather than being dropped — a marker nobody
matched is how a stale figure hides.

**One rule for authors: an inline marker must not begin a line.** A
comment at the start of a line opens a CommonMark HTML block, which eats
the rest of that line — the marker, its value and the prose after it.
That is CommonMark, not this package, and it bites on GitHub too. `bake`
reports it by name. (Six markers in this repository were written that way
and three sentences were disappearing from the rendered README; the gate
found them.)

`bake` is a build-time tool for input you control, and that is the one
place its trust level differs from mdx's: a baked body is spliced into
the source and **will** be re-parsed as markdown — a fact that is a whole
table is the point — whereas an mdx interpolation lands in a text node
and is never re-read. Normative in
[MD-FORMAT.md](docs/MD-FORMAT.md) §4.8.

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
whole guard, so widen it deliberately.

Heading ids are the other half of the same question, and it is settled per
*document* rather than per emitter: a host that renders its own documents
beside documents it did not author passes the rendering policy to
`md.view(source, policy)` (above), so untrusted text gets a `slugPrefix`
and the host's own documents do not. Plugin `render` functions shadow the
core emitter and own the rule for URLs they emit; `ctx.sanitizeUrl` is the
active policy ([PLUGINS.md](docs/PLUGINS.md) §5, [MD-FORMAT.md](docs/MD-FORMAT.md) §4.3).

## Performance contract

Measured, not claimed — `npm run benchmark:markdown`, <!--fact:md.measured-->2026-08-11, Node v24.19.0<!--/fact-->
(run it yourself; micro-timings vary ±15%):

- **Parse to AST**: <!--fact:md.parseTimes-->~0.099 ms for a typical ~2 kB document, ~0.51 ms for ~10 kB, ~4.8 ms for ~100 kB<!--/fact--> — linear in input. A CPU profile puts the
  inline phase at ~36% of that and the source hash for `meta.hash` at
  ~10%; the block scan, the obvious suspect, is ~14%. (Replacing one
  `/\s+$/` regex at paragraph close with a scan was worth 4–17%
  depending on how paragraph-dense the document is — measured as an A/B
  on this corpus, because the same change looked like noise on a
  differently shaped one.)
- **Parse + render to HTML** (the cross-engine row, `toHtml`): takes <!--fact:md.vsPeers-->0.6–1.1<!--/fact-->x the time `marked` and `markdown-it` take — <!--fact:md.vsPeersDetail-->faster than both at every size measured except one — `markdown-it` is ahead at ~10 kB (1.1x)<!--/fact--> — and is <!--fact:md.vsMicromark-->12.9–21.4<!--/fact-->x faster than `micromark`, on the same GFM documents.
  Through the **vnode** path the same documents cost roughly twice that
  — keys, memoization and a tree the patcher can reconcile are not free,
  and the benchmark publishes that row beside this one rather than
  quoting only the flattering half.
- **Where the time goes** (~100 kB, the phase split the benchmark now
  prints and publishes): <!--fact:md.phaseSplit-->parse 35%, AST→vnode 50%, vnode→HTML 16%<!--/fact-->. The projection, not
  the parse, is the expensive half — and <!--fact:md.keyCost-->53%<!--/fact--> of the projection is
  computing the content-hash **keys** (<!--fact:md.unkeyedMs-->3.3 ms against 6.9 ms<!--/fact--> without them).
  Keys are what let the patcher reorder blocks instead of rebuilding
  them, so they are worth it for a tree that will be patched — and worth
  nothing to a caller that renders once and throws the tree away. That
  caller passes `keyed: false`:

  ```js
  mdToVnode(doc, { keyed: false });        // SSR, a snapshot, a one-shot string
  ```

  It is deliberately not inferred. A renderer cannot know whether its
  output will be patched, and guessing wrong turns O(1) reconciliation
  into a rebuild with no error to show for it.
- **The compiled fast path**: `compileMarkdown(...).toVnode()` returns
  the cached projection in <!--fact:md.cachedNs-->39–82<!--/fact--> ns — and because block vnodes carry
  content-hash keys and unchanged AST nodes emit reference-equal
  vnodes, the view patcher skips unchanged blocks in O(1). A JSLT
  identity transform returns the document by reference; a partial
  transform keeps every unmatched subtree `===`. That pipeline — not
  the one-shot HTML render — is what this package is optimized for.
- **CommonMark scorecard**, both paths, because the difference between
  them *is* the safety boundary:
  - `toHtml` (`html: 'raw'`, the like-for-like row): <!--fact:md.scorecard-->655 of 655 (100.0%)<!--/fact-->; for scale, <!--fact:md.scorecardPeers-->marked 620, markdown-it 655, micromark 650<!--/fact-->.
    **No dialect gap remains on this path**: every example the spec
    contains passes, and the round-trip suite additionally asserts that
    all 655 survive `parseMarkdown → toMarkdown → parseMarkdown` with an
    identical AST and an unchanged canonical form.
  - `mdToVnode` + SSR: <!--fact:md.scorecardVnode-->593 of 655 (90.5%)<!--/fact-->. **Every** example the two
    paths disagree on contains raw HTML — asserted, not asserted-at:
    [`test/md/to-html.test.js`](../../test/md/to-html.test.js) checks that no
    vnode-path failure is free of an `html` node. The spec renders raw
    HTML verbatim, including a lone `</div>` or a never-closed tag, and a
    vnode tree cannot hold half an element. That is a property of the
    format, not a gap to close — it is the same property that makes the
    vnode path safe for Markdown you did not write.

- **GFM extension scorecard**, the five extension sections of the GFM
  specification with every engine's extensions switched on — because the
  CommonMark corpus says nothing about any of them, and the part of the
  dialect every engine advertises was the only part nobody measured: <!--fact:md.gfmScorecard-->22 of 24 (91.7%)<!--/fact--> through `toHtml`, and <!--fact:md.gfmScorecardVnode-->22 of 24 (91.7%)<!--/fact--> through the vnode
  path; for scale, <!--fact:md.gfmPeers-->marked 22, markdown-it 14, micromark 23<!--/fact-->.
  Autolink literals are <!--fact:md.gfmAutolinks-->11 of 11<!--/fact-->, ahead of every rival here. The two
  this package does not pass are **stated boundaries, not to-do items**:
  - **table alignment is written as `style="text-align:center"`, not the
    deprecated `align` attribute** (1 example). Both render identically;
    `align` was removed from HTML in 2014, and switching would change the
    bytes every existing consumer already receives.
  - **the "disallowed raw HTML" extension is not implemented** (1
    example). It escapes the `<` of `<title>`, `<script>`, `<iframe>` and
    six others when raw HTML passes through. Our raw mode is documented
    trusted-input-only, and the two modes a host actually points at
    untrusted Markdown — `escape` and the vnode path — already neutralize
    those tags **and every other one**, which is a stronger guarantee
    than a nine-tag deny-list. Implementing it would add a fourth
    HTML policy that is safer than `raw` and weaker than the default.

  Footnotes are not in this table because the GFM specification does not
  cover them: GitHub ships them, the spec never grew a section for them,
  so there is no reference corpus to score. They are covered by
  hand-written tests written from GitHub's rendering
  ([`test/md/gfm.test.js`](../../test/md/gfm.test.js)).

  Both scorecards run against their official spec as a git submodule,
  QT3-style, and compare rendered meaning: whitespace that only lays
  markup out — and the order in which a serializer happened to print a
  tag's attributes — is normalized away on every engine's output, not
  just this one's.

## Exports

Every subpath a consumer can import, derived from the manifest by
`npm run docs:derive` (`npm run docs:check` fails when the two drift):

<!--fact:exports.md-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/md` | JavaScript | declared |
| `@jarenjs/md/plugins` | JavaScript | declared |
| `@jarenjs/md/html` | JavaScript | declared |
| `@jarenjs/md/mdx` | JavaScript | declared |
| `@jarenjs/md/directives` | JavaScript | declared |
| `@jarenjs/md/component` | JavaScript | declared |
| `@jarenjs/md/styles/md.css` | asset | — |
| `@jarenjs/md/schemas/jaren-md-ast.schema.json` | schema | — |
| `@jarenjs/md/package.json` | metadata | — |
<!--/fact-->

## Development

Tests live in the repository root: [`test/md/`](../../test/md)
(`npm run test:md`) — CommonMark-subset and GFM conformance, frontmatter,
plugins, structural sharing, streaming, loader caching, and AST-schema
validation through `@jarenjs/validate`. The benchmark methodology is
documented in [benchmark/README.md](../../benchmark/README.md). See the
repo [README](../../README.md) and [ROADMAP](../../docs/ROADMAP.md) for the
bigger picture, and [ARCHITECTURE.md](ARCHITECTURE.md) for the
internals.
