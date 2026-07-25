# The Jaren Markdown Plugin Contract

**Version 0.1 — Specification**

Plugins are the extensibility story of `@jarenjs/md`, and they follow
the package's one rule: **everything is declared up front and baked into
compiled closures**. There is no runtime registration, no mutation of a
live parser, no dynamic lookup on the hot path. A plugin is data; the
compiler turns it into table entries.

## 1. The plugin object

A plugin is a plain frozen object created by `definePlugin(spec)`:

```js
definePlugin({
  name: 'mermaid',                    // unique, kebab-case (required)
  fences: ['mermaid'],                // fenced-code claims by info-string first word
  blocks: [ /* block rule descriptors, §3 */ ],
  inlines: [ /* inline rule descriptors, §4 */ ],
  node: 'mermaid',                    // the AST type this plugin emits
  render: (node, h, ctx) => vnode,    // pure, synchronous vnode renderer
  hydrate: async (el, node, ctx) => {}, // optional browser-only upgrade
});
```

`definePlugin` validates the shape (name present and kebab-case, rule
descriptors well-formed, `render` a function when `node` is declared)
and returns `Object.freeze`d data. Every member except `name` is
optional.

Plugins are passed as `options.plugins: MdPlugin[]` to `parseMarkdown`,
`compileMarkdown` and `loadMarkdown`. At compile time they merge into
four prebuilt tables:

| table | indexed by | consulted |
|---|---|---|
| fence claims | info-string first word | when a fenced code block closes |
| block starts | first non-space character | once per unclaimed line |
| inline scans | trigger character | from the inline scanner's dispatch |
| renders | AST `type` | by the vnode emitter |

All four are built once per compile; the hot loops do only indexed
lookups. Two plugins claiming the same fence word, block character
*and* matching the same line, inline character, or node type: the
**first plugin in the array wins** (deterministic, documented, no
merging magic).

## 2. Fence claims

`fences: ['mermaid']` claims fenced code blocks whose info-string first
word matches. The block is scanned exactly like a code fence (the
scanner owns fence semantics — nesting, indentation, closing rules);
only the resulting node changes:

```
```mermaid          →  { type: 'mermaid', value: 'graph TD; …', meta: null }
graph TD; A-->B
```
```

A claimed fence MUST produce `{ type: plugin.node, value, meta }` where
`meta` is the info string after the first word (or `null`). Without the
plugin, the same source is a plain `code` node with `lang: 'mermaid'` —
**degradation is always graceful**.

## 3. Block rule descriptors

For syntax that is not a fence (callout blocks, directives, footnote
definitions):

```js
{
  chars: ':',                       // trigger characters (first non-space char)
  start: (line, ctx) => node|null,  // claim the line: return a fresh node or null
  continue: (node, line, ctx) => boolean, // does this line still belong?
  close: (node, ctx) => void,       // finalize (parse buffered text, etc.)
}
```

- `start` runs only when the line's first non-space character is in
  `chars` and no core construct with higher precedence claimed it. It
  MUST return a new AST node (which the parser appends to the current
  container) or `null` to decline.
- `continue` runs per subsequent line while the block is open. Return
  `true` to consume the line and stay open, `'end'` to consume the line
  *and* close (a closing fence), or `false` to close without consuming
  — the line then re-processes as a fresh block start.
- `close` runs once when the block closes (end of input included).
- `ctx` is `{ frontmatter, options }` — read-only compile context.

## 4. Inline rule descriptors

```js
{
  char: '$',                              // single trigger character
  scan: (src, pos, ctx) => ({ node, end }) | null,
}
```

`scan` is called when the inline scanner meets `char` at `pos` in the
raw inline text `src`. Return the inline AST node and the exclusive end
offset, or `null` to decline (the character then flows into plain text).
`scan` MUST NOT look behind `pos` except to inspect delimiter context
and MUST NOT allocate on the decline path.

## 5. Rendering and hydration

`render(node, h, ctx) => vnode` maps the plugin's node type to a
[view vnode](../../../packages/view/docs/VIEW-FORMAT.md). It MUST be pure and
synchronous — SSR through `renderToString` and the DOM patcher both
call it, and its output for equal input SHOULD be reference-equal
(cache by `node` reference or content hash) so re-patches hit the O(1)
fast path. `h` is `@jarenjs/view`'s element constructor; `ctx` carries
`{ options, hash, sanitizeUrl }` where `hash(str)` is the package content
hash.

A plugin `render` **shadows the core emitter for its node type**, so the
core's URL filtering does not run for it. A plugin that writes an
`href`/`src` from document content MUST put it through
`ctx.sanitizeUrl(url)` — the active policy, host override included — and
drop the attribute when it returns `null` (MD-FORMAT §4.3). A URL the
plugin composes itself from a trusted constant needs no filtering.

Anything asynchronous or DOM-dependent goes in
`hydrate(el, node, ctx)`, which `createMdRenderer` invokes **after**
the patcher mounts the element (§6 of [LOADER.md](LOADER.md) covers
scheduling). A hydratable render marks its root element with
`'data-md-hydrate': plugin.name` and `'data-md-hash': contentHash`; the
renderer finds marked elements, skips those whose hash it already
hydrated, and calls the plugin. `hydrate` MAY be async; failures are
contained per element (reported through `options.onHydrateError`,
default `console.error`).

## 6. The reference plugins

Both ship from `@jarenjs/md/plugins` and are the canonical templates
for third-party plugins (math, callouts/admonitions, footnotes, embeds).

### 6.1 mermaidPlugin({ theme })

The **native** plugin, re-exported from `@jarenjs/mermaid/plugin`. It
parses the fence source with the in-house headless Mermaid engine and
emits **pure-vnode SVG** synchronously — no injected `mermaid` instance,
no CDN global, no `innerHTML`.

- `render` claims `mermaid`/`mmd` fences and returns
  `div.md-mermaid.mermaid-block > svg`, keyed by content hash. Because it
  is pure and synchronous, a Markdown document containing a `mermaid`
  fence renders to a full SVG string through **SSR with no browser** —
  something the old injection wrapper could not do. Text and attribute
  values are escaped by the view serializer, and only `http(s)`/relative
  link `href`s survive, so the SVG-injection surface the old `innerHTML`
  path carried is gone.
- There is **no `hydrate`** — the render is already complete.
  Optional client-only enhancements (pan/zoom) are reserved for a future
  interactivity plugin.
- The dependency arrow is **md → mermaid**:
  `@jarenjs/mermaid/plugin` returns a self-frozen `MdPlugin`-shaped
  object *without* importing `definePlugin`, so there is no cycle;
  `@jarenjs/md` re-exports it and adds `@jarenjs/mermaid` to its
  dependencies. Consumers who never use it tree-shake it away
  (`sideEffects:false`). Mermaid stays **opt-in** — it is not in
  `DEFAULT_PLUGINS`.

**Transformed-diagram round-trip.** There is no per-plugin `toMarkdown`
hook; a `mermaid` fence round-trips through `toMarkdown` generically as
long as its source lives in `node.value` (which it does). So a JSLT
transform that *rewrites* a diagram must refresh the fence source with
the canonical printer. `@jarenjs/mermaid/plugin` exports the primitive
for exactly this:

```js
import { parseMermaid, toMermaid } from '@jarenjs/mermaid';
import { refreshMermaidFence } from '@jarenjs/mermaid/plugin';

const doc = parseMermaid(fenceNode.value);
const edited = transform(doc);                 // JSLT / hand edit of the AST
const fresh = refreshMermaidFence(fenceNode, edited);  // { type:'mermaid', value: toMermaid(edited) }
```

The refreshed `value` re-emits through the core fence printer
(`to-md.js`), so `toMarkdown` prints the new diagram.

### 6.2 highlightPlugin({ grammars, adapter })

Claims nothing — it **renders** `code` nodes, replacing the default
code renderer through the render table.

**Built-in mode**: a zero-dependency single-pass tokenizer driven by
compact grammar tables (keyword set, string/comment/number delimiters,
punctuation classes), compiled to closures once per compile. Shipped
grammars: `js`/`ts` (+`jsx`/`mjs`), `json`, `josl`/`toml`, `html`/`xml`,
`css`, `md`/`markdown`, `bash`/`sh`/`shell`.

**Adapter mode**: `adapter: (code, lang) => Token[] | null` plugs
shiki/prism/highlight.js behind the same token contract; `null` falls
back to the built-in grammar for that `lang`, then to plain text. The
adapter is captured at compile time, never re-registered.

**The token contract** (normative): a flat array of
`{ kind, value }` covering the source exactly, in order. Kinds and
their CSS classes:

| kind | class | meaning |
|---|---|---|
| `kw` | `tok-kw` | keyword |
| `str` | `tok-str` | string literal |
| `num` | `tok-num` | number literal |
| `com` | `tok-com` | comment |
| `pun` | `tok-pun` | punctuation/brackets |
| `id` | `tok-id` | identifier |
| `op` | `tok-op` | operator |
| `lit` | `tok-lit` | language literal (`true`, `null`, …) |

Tokens render as `<span class="tok-{kind}">` children of the `<code>`
element (plain `id` runs render as bare text nodes to keep the vnode
small); the fence language renders as `class="language-{lang}"` on the
`code` element, claimed fences aside.

## 7. Writing your own (non-normative)

A callout plugin in full:

```js
import { definePlugin } from '@jarenjs/md';

export const calloutPlugin = () => definePlugin({
  name: 'callout',
  node: 'callout',
  blocks: [{
    chars: ':',
    start: (line) => {
      const m = /^:::\s*(\w+)\s*$/.exec(line);
      return m ? { type: 'callout', kind: m[1], lines: [] } : null;
    },
    continue: (node, line) => {
      if (/^\s*:::\s*$/.test(line)) return 'end';
      node.lines.push(line);
      return true;
    },
    close: (node) => {
      node.value = node.lines.join('\n');
      delete node.lines;
    },
  }],
  render: (node, h) =>
    h('aside', { class: `md-callout md-callout-${node.kind}` }, node.value),
});
```

Everything the core constructs get, a plugin gets: table dispatch, SSR
purity, graceful degradation, and content-hash keys.
