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
`{ options, hash }` where `hash(str)` is the package content hash.

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

### 6.1 mermaidPlugin({ mermaid, theme })

The **caller supplies the mermaid instance** (dynamic import, CDN
global — the plugin never imports it, preserving zero dependencies).

- `render` emits a stable placeholder:
  `div.md-mermaid > pre` containing the diagram source, keyed by
  content hash — SSR output is deterministic and content-visible
  without JavaScript.
- `hydrate` calls `mermaid.render(id, source)` and swaps the SVG into
  the element. Rendered SVG is cached by content hash, so re-patches
  and repeated diagrams are O(1).
- Without a `mermaid` instance the plugin still claims the fence and
  renders the placeholder (progressive enhancement stays honest).

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
