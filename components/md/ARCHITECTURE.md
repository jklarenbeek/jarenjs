# @jarenjs/md Architecture

How the Markdown engine is put together, and where its speed comes
from. The user-facing story is the [README](README.md); the normative
contracts are [MD-FORMAT.md](docs/MD-FORMAT.md),
[PLUGINS.md](docs/PLUGINS.md) and [LOADER.md](docs/LOADER.md).

## Engine and component (the two layers)

The package is deliberately split in two, and the split is a hard
architectural boundary, not a filing convention:

| | Engine (part one) | Visual component (part two) |
|---|---|---|
| Entry points | `@jarenjs/md`, `@jarenjs/md/plugins` | `@jarenjs/md/component`, `@jarenjs/md/styles/md.css` |
| Source | `src/*.js`, `src/plugins/` | `src/component/`, `styles/` |
| Job | text ↔ AST ↔ vnode **values**; parse, print, load | package those values for a rendering **host** |
| Knows about | nothing outside `@jarenjs/view` (for the vnode shape) | the engine, plus `@jarenjs/app`'s viewModel/effect shapes |
| Ships CSS | no | yes (`styles/md.css`) |
| State | none — pure functions over data | memoization caches, a default plugin set |

The dependency arrow points **one way**: `src/component/` imports from
the engine; nothing in the engine imports from `src/component/` or from
`styles/`. So the engine remains a headless data toolchain usable in a
worker, an edge runtime or a build step with no notion of a host, and
the component is a thin, replaceable adapter — a second component (a
React binding, a different app framework's glue) could sit beside it
without touching the engine.

**What the component adds, and why it is not in the engine:**

- `createMdComponent()` — a `view()` projection memoized by source
  string and by parsed-document reference, so an `@jarenjs/app`
  viewModel gets reference-stable vnodes (the O(change) contract).
  Memoization *policy* (LRU size, what to key on) is a host concern,
  not a parsing concern.
- `effects` (`md-load`, `md-parse`) shaped for `createApp({ effects })`
  — the engine exposes `loadMarkdown`/`parseMarkdown` as plain
  functions; wrapping them in the app registry's
  `(props, dispatch) => …` contract is app-specific glue.
- `hydrate(container)` — walks host DOM running plugin hydrate hooks.
  The engine's `createMdRenderer` owns its own DOM; the component's
  `hydrate` upgrades DOM the *host* rendered, which only a host layer
  can coordinate.
- A default plugin set (highlighting on) and `styles/md.css` — opinions
  about presentation that a headless engine must not impose.

The jarenjs website consumes the component exactly this way: one shared
`createMdComponent()` instance feeds both the playground *Markdown* tab
and the docs-page README dialog — `view()` in the viewModel, `md-load`
in the effect registry, `md.css` imported once.

## Overview

The package follows the repository's one philosophy — **parse and
decide everything once at compile time, then run a specialized
closure** — applied to a text format instead of a JSON one:

```
source text ──parse──▶ MdDocument (plain JSON AST)
                         │
        ┌────────────────┼──────────────────┐
        ▼                ▼                  ▼
   toMarkdown()      mdToVnode()        JSLT / query
   (canonical         (view vnodes,     (the AST is an
    round-trip)        hash keys)        ordinary document)
```

Everything right of the parse is a compiled projection: dispatch tables
keyed on node `type`, built once per plugin set, cached per document.

## Module map

| File | Role |
|------|------|
| `src/scanner.js` | Stateless per-line classifiers (fence? heading? list marker? table row?) at char-code level; every regex compiled at module load |
| `src/parser.js` | The block parser (container stack + one open leaf), the inline parser (delimiter stack), plugin tables, `parseMarkdown`, `createIncrementalParser` |
| `src/frontmatter.js` | YAML-subset / JSON / TOML-subset parsers, written from scratch; `options.toml` injects `@jarenjs/josl` |
| `src/ast.js` | Node constructors (one hidden class per type), `walkAst`, compiled-visitor `visitAst` |
| `src/compiler.js` | `compileMarkdown` — the closure bundle with cached projections; `frontmatterExternals`, `mdToForm` |
| `src/to-md.js` | Canonical printer (round-trip fixed point) |
| `src/to-vnode.js` | Vnode emitter (per-node memo, content-hash keys), `createMdRenderer` with hydrate scheduling |
| `src/loader.js` | LRU cache + validators, in-flight sharing, AbortSignal, `streamMarkdown` |
| `src/plugins/` | `definePlugin` + the two reference plugins (highlight, mermaid) |
| `src/component/` | **the visual component** — `createMdComponent` (memoized `view()`, app `effects`, `hydrate`); imports the engine, never the reverse |
| `styles/md.css` | the component stylesheet (`.md` rhythm, `tok-*` token colors, mermaid placeholder), light/dark |

## The parser

### Block phase: a container stack and one open leaf

Each (detabbed) line runs through three steps:

1. **Match open containers.** The stack holds `blockquote`, `list` and
   `listItem` entries; each consumes its marker prefix (`>`, item
   indentation). A partial match either feeds a lazy paragraph
   continuation or closes the unmatched tail.
2. **Feed the open leaf.** Fences, HTML blocks, tables and plugin
   blocks consume raw lines before any block-start scanning — that is
   what makes fence content inert.
3. **Open new blocks.** One ordered scan (setext → table delimiter →
   fence → ATX → thematic break → blockquote → list marker → HTML →
   plugin rules → paragraph) that loops when a fresh container (`>`,
   list item) re-enters with the rest of the line.

Leaves buffer **raw text only**. A closed paragraph first sheds link
reference definitions into the document map, then waits.

### Inline phase: once per leaf, at close

Inline parsing runs once over each leaf's buffered text: a char-code
dispatch (backslash, backtick, `*_~` delimiter runs, brackets,
autolinks/raw HTML at `<`, entities at `&`, breaks at `\n`) with a
fast-skip loop over plain text, a delimiter stack for
emphasis/strong/strikethrough (flanking + rule of three), and a bracket
stack for links/images. Batch parsing resolves inlines after the whole
block phase (so later reference definitions bind); the incremental
parser resolves each block when it is yielded (the documented streaming
trade-off).

### Plugin tables

`buildPluginTables(plugins)` merges a plugin array into five maps —
fence claims by info word, block rules by first character, inline rules
by trigger character, renderers and hydrators by node type — memoized
by array identity, so a module-level plugin array is compiled exactly
once per process. With no plugins the parser shares one frozen
empty-table object; the hot loop's only cost is a `Map.get` on lines
and trigger characters that already look special.

## Structural sharing, end to end

Three layers cooperate to make the *re-render* path O(changes), the
same design the view/app stack is built on:

1. **The AST is share-friendly.** Plain JSON, fresh per parse, never
   mutated after return — so JSLT's copy-on-write engine keeps every
   unmatched subtree reference-equal, and an identity transform returns
   the input itself.
2. **The vnode emitter is memoized per node reference.** Same AST node
   → same vnode reference (a `WeakMap` on the plugin-table object), so
   a transformed document only re-emits the blocks that actually
   changed.
3. **Block vnodes carry content-hash keys** (structural FNV-1a, no
   intermediate JSON string), so the keyed patcher reorders moved
   blocks instead of rebuilding them, and equal content keeps its key
   across documents.

`compileMarkdown` adds the last cache: `toVnode()`/`toMarkdown()`
compute once per compiled document.

## The loader

`loadMarkdown` = normalize URL → cache lookup (keyed on URL + plugin
names) → fetch. The cache stores the compiled document plus its
`ETag`/`Last-Modified`; hits resolve immediately and revalidate in the
background; in-flight promises are cached so concurrent loads share one
request; failures and aborts evict. Streaming bodies feed
`createIncrementalParser` chunk by chunk, and `streamMarkdown` exposes
the same core as an async generator of completed top-level blocks whose
return value is the finished document.

## Performance notes

- **No per-call patterns.** Every regex in the package is a module
  constant; the highlighter compiles grammar tables to closures with a
  `Uint8Array` char-class map; the inline scanner and the tokenizer are
  single-pass with fast-skip loops.
- **Monomorphic nodes.** Constructors in `ast.js` build every node of a
  type with the same member order, which also makes the structural
  hash deterministic.
- **Honest numbers.** `npm run benchmark:markdown` measures against
  marked/markdown-it/micromark and scores the official CommonMark
  examples; the README quotes the results with date and Node version.
  The one-shot parse+render row is within ~1.1–1.5x of the fastest
  mainstream parsers; the compiled/shared re-render path — this
  package's actual job in the suite — has no equivalent there.

## Known limits (v0.1)

- The dialect is pragmatic, not fully CommonMark-conformant (80.3% of
  spec examples; the scorecard attributes the rest, raw-HTML
  pass-through being the largest deliberate class).
- Inline HTML and HTML blocks are preserved in the AST but not rendered
  to vnodes by default (`html: 'text'` shows them literally).
- Streaming resolves inlines per yielded block, so a reference
  definition only binds links in blocks completed after it.
- The YAML/TOML frontmatter parsers are documented subsets
  (MD-FORMAT.md §3), with `@jarenjs/josl` as the full-TOML companion.
