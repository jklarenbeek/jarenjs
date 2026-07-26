# The Jaren Markdown Format

**Version 0.1 — Specification**

This document defines the JSON document format produced by `@jarenjs/md`:
a Markdown + frontmatter engine whose output is a stable, serializable
AST that the rest of the Jaren suite consumes natively. Where JTLT
([JSLT-FORMAT.md](../../../packages/json/docs/JSLT-FORMAT.md) §segments) turns JSON
into text, this format is the inverse arrow: Markdown text into JSON that
JSLT stylesheets match, query documents address, and
[view](../../../packages/view/docs/VIEW-FORMAT.md) renderers display.

## 1. Introduction

### 1.1 What this format is

An **MdDocument** is a plain JSON value — no classes, no methods, no
prototypes. It can be stringified, diffed with JSON Patch, validated with
JSON Schema (`schemas/jaren-md-ast.schema.json`), transformed with JSLT,
and generated under constrained decoding, like every other document
format in the suite.

### 1.2 Conformance and normative language

The key words **MUST**, **MUST NOT**, **SHOULD** and **MAY** are to be
interpreted as described in RFC 2119. Two conformance roles exist:

- a **producer** creates MdDocuments (the parser in this package, a JSLT
  transform, an LLM under the published schema);
- a **consumer** reads them (the vnode emitter, the canonical printer,
  a stylesheet, application code).

### 1.3 Dialect

The parser recognizes the CommonMark core constructs (ATX headings,
setext headings, paragraphs, thematic breaks, fenced and indented code,
blockquotes, ordered/unordered lists, inline emphasis/links/images/code,
hard and soft breaks, backslash escapes, autolinks, raw HTML blocks and
spans) plus the three GFM extensions in universal use: **tables**,
**strikethrough** and **task lists**. It is a fast, pragmatic dialect —
this specification, not the CommonMark spec, is normative for this
package; the benchmark workspace scores the parser against the official
CommonMark example corpus and reports the honest number.

## 2. The document envelope

```json
{
  "$md": "0.1",
  "frontmatter": { "title": "Hello" },
  "ast": [ { "type": "heading", "depth": 1, "children": [ { "type": "text", "value": "Hello" } ] } ],
  "meta": { "sourceUrl": null, "hash": "1f9a2k3", "frontmatterLang": "yaml" }
}
```

- `$md` — the format version. Producers MUST write `"0.1"`.
- `frontmatter` — the parsed frontmatter value, or `null` when the
  document has none. Whatever the source syntax (§3), it normalizes to
  plain JSON here.
- `ast` — the ordered array of block nodes (§4).
- `meta.sourceUrl` — the URL the document was loaded from, or `null`.
- `meta.hash` — a content hash of the source (FNV-1a 32-bit, base 36):
  the identity primitive for caches and vnode keys.
- `meta.frontmatterLang` — `"yaml"`, `"json"`, `"toml"` or `null`.

Consumers MUST ignore `meta` members they do not know; producers MAY add
members there (the envelope is minimal, extensible).

## 3. Frontmatter

Frontmatter is detected **at the very top of the source only** (byte 0):

| Opener (first line) | Syntax | Closer |
|---|---|---|
| `---` | YAML subset (§3.1) | a line `---` or `...` |
| `---json` | JSON | a line `---` |
| `{` (first character) | JSON object | a line that is exactly `}` |
| `+++` | TOML (§3.3) | a line `+++` |

When the closing line is missing, the document has no frontmatter and
the opener is ordinary Markdown (a `---` first line followed by text is
a setext heading candidate, exactly as CommonMark treats it). Malformed
content *inside* a properly closed fence raises `MdFrontmatterError`.

### 3.1 The YAML subset (normative limits)

The built-in parser handles, from scratch and dependency-free:

- **Scalars** — `null`/`Null`/`NULL`/`~`, `true`/`false` (with `True`
  etc. capitalizations), decimal integers and floats (optional sign and
  exponent), and plain strings. Anything else — including YAML 1.1
  `yes`/`no`, sexagesimals, hex ints and timestamps — is a **string**.
- **Quoted strings** — double quotes with JSON-style escapes
  (`\n \t \r \b \f \0 \\ \" \uXXXX`), single quotes with `''` → `'`.
- **Block maps and sequences** by indentation (spaces only). A sequence
  MAY sit at the same indent as its parent key. `- key: value` opens an
  inline map item.
- **Flow collections** — `[a, b]` and `{a: 1}`, nesting freely, spanning
  multiple lines while brackets remain open.
- **Block scalars** — literal `|` and folded `>`, each with the `-`
  chomp (drop the final newline). The `+` chomp and explicit indent
  indicators are not supported.
- **Comments** — `#` to end of line, outside quotes.

Deliberately outside the subset: anchors/aliases (`&`/`*`), tags (`!!`),
multi-document streams (`---` separators inside the block), complex
(non-scalar) keys, and the `?` key indicator. Duplicate keys: last one
wins. A key named `__proto__` becomes an ordinary own property.

### 3.2 JSON frontmatter

The `---json` fence body and the leading-`{` form are parsed with
`JSON.parse`. The leading-`{` form closes at the **first line that is
exactly `}`**; if that slice fails to parse the opener is ordinary
Markdown text, not an error.

### 3.3 TOML frontmatter

The caller MAY inject a full TOML parser — `parseToml` from
[`@jarenjs/josl`](../../../packages/josl/README.md) is the intended companion —
through `options.toml`; the package itself stays dependency-free. The
built-in fallback subset handles `[table]`/`[[array-of-tables]]` headers
with dotted paths, bare/quoted/dotted keys, basic and literal strings,
integers (decimal/hex/octal/binary with `_`), floats, booleans, flow
arrays (multi-line), inline tables and comments. Datetimes and any other
unrecognized value are kept as verbatim **strings**; multi-line strings
are not supported.

### 3.4 Frontmatter as ambient variables

When the AST flows through a JSLT/JTLT stylesheet or a query document,
frontmatter members bind as **externals**: the compiled document exposes
`externals()`, a flat object of the frontmatter's top-level members
(minus the engine-reserved names `root` and `path`), passed as the
second argument of a compiled transform — bodies reference them as
`"$title"`, `"$date"`, and so on.

## 4. The node vocabulary

Every node is a plain object with a `"type"` string discriminator.
Container nodes hold their ordered content in `children`; literal nodes
hold text in `value`. Producers MUST NOT emit other container member
names; consumers MUST ignore unknown members on known types (so plugins
and future versions can annotate) and MUST pass unknown *types* through
unchanged where possible.

### 4.1 Block nodes

| type | members | notes |
|---|---|---|
| `paragraph` | `children` | inline content |
| `heading` | `depth` (1–6), `children` | ATX and setext |
| `thematicBreak` | — | `***`, `---`, `___` |
| `blockquote` | `children` | block content |
| `list` | `ordered` (boolean), `start` (number or `null`), `tight` (boolean), `children` | children are `listItem`s |
| `listItem` | `checked` (`true`/`false`/`null`), `children` | `checked` non-null only for task-list items |
| `code` | `lang` (string or `null`), `meta` (string or `null`), `value` | fenced and indented; `lang` is the info string's first word, `meta` the rest |
| `html` | `value` | a raw HTML block, verbatim |
| `table` | `align` (array of `"left"`/`"right"`/`"center"`/`null`), `children` | children are `tableRow`s; the first row is the header |
| `tableRow` | `children` | children are `tableCell`s |
| `tableCell` | `children` | inline content |

### 4.2 Inline nodes

| type | members | notes |
|---|---|---|
| `text` | `value` | literal text, escapes resolved |
| `emphasis` | `children` | `*x*` / `_x_` |
| `strong` | `children` | `**x**` / `__x__` |
| `strikethrough` | `children` | `~~x~~` (GFM) |
| `link` | `url`, `title` (string or `null`), `children` | inline links and autolinks; `url` is verbatim, filtered at render (§4.3) |
| `image` | `url`, `title` (string or `null`), `alt` (string) | `alt` is plain text; `url` as for `link` |
| `inlineCode` | `value` | backtick spans |
| `break` | — | hard break (two spaces or `\` before newline) |
| `softBreak` | — | an in-paragraph newline |
| `html` | `value` | a raw inline HTML span |

### 4.3 URL safety (normative)

A `link`/`image` `url` in the AST is **verbatim**: whatever the author
wrote, so that `toMarkdown` round-trips it (§5) and a transformation can
inspect or rewrite it. Filtering happens one step later, when the AST is
projected to vnodes.

An emitter MUST NOT write a `url` into an `href`/`src` when its scheme can
execute script (`javascript:`, `vbscript:`) or stand in for a document of
its own (`file:`, and `data:` other than a raster image type). On
rejection it MUST drop **only that attribute**, keeping the element and
its children, so no authored text is lost. A scheme-less relative
reference (`image.png`, `docs/guide.md`) is not a scheme and MUST pass.

The scheme MUST be read the way a browser reads it, not as a literal
prefix: ASCII whitespace and control characters inside it are ignored, so
a tab spliced into `javascript:` does not get a URL through.

A `url` that survives the filter MUST be **percent-encoded** for the
attribute: an authored destination may hold spaces, backslashes,
backticks or any non-ASCII character, and a browser resolves those
differently than the author wrote them. Characters carrying URL
structure (`/?:@&=+$,#`) stay literal, and an existing `%XX` is not
re-encoded. The AST still holds the destination verbatim — only the
attribute is encoded.

`mdToVnode` implements this with `sanitizeUrl` from
`@jarenjs/view/helpers`. `options.sanitizeUrl` replaces the policy
wholesale — `(url) => string | null` — which is how a host widens it for a
custom scheme in trusted content. **A plugin `render` bypasses the core
emitter entirely, so a plugin that writes its own `href`/`src` owns this
rule for the URLs it emits.**

### 4.4 Plugin and custom nodes

A compiled-in plugin (see [PLUGINS.md](PLUGINS.md)) MAY emit nodes of
any `type` it declares — e.g. `{ "type": "mermaid", "value": "...",
"meta": null }`. For document interchange without a plugin vocabulary,
the generic escape hatch is:

```json
{ "type": "custom", "name": "callout", "data": { "kind": "warning" }, "children": [] }
```

Consumers that do not know a type SHOULD fall back gracefully: the vnode
emitter renders unknown literal nodes as plain `pre` text and unknown
containers by their children; without the mermaid plugin, a
` ```mermaid ` fence is just a `code` node with `lang: "mermaid"`.

## 5. Canonical Markdown and round-trips

`toMarkdown(doc)` prints **canonical Markdown**: ATX headings, `-`
bullets, `1.` ordered markers (renumbered from `start`), fenced code
with backticks, `*emphasis*`/`**strong**`, reference-free inline links,
`|`-piped tables with an alignment row, and blank lines between blocks.

The normative round-trip guarantees:

1. `parseMarkdown(toMarkdown(doc))` produces an AST deep-equal to
   `doc.ast` for any document this package produced (canonical form is
   a fixed point);
2. a document produced by a JTLT stylesheet parses into an AST that an
   identity JSLT stylesheet (`[]`) maps back — by reference — to the
   same AST, which prints to the canonical equivalent of the JTLT
   output.

## 6. Structural sharing (normative)

The AST is designed for the suite's reference-equality fast paths:

- a parser MUST return a fresh document per call but MUST NOT mutate a
  document after returning it — consumers MAY freeze, cache and share;
- an identity JSLT transform of a document returns the input by
  reference (the engine's proof-of-no-change sharing), and any partial
  transform keeps unmatched subtrees `===` — the vnode emitter's
  per-block cache and the view patcher's `oldVnode === newVnode` check
  then skip unchanged blocks in O(1);
- the vnode emitter MUST key block vnodes by content hash so the keyed
  patcher reorders instead of rebuilding when blocks move.

## 7. The JSON Schema

`schemas/jaren-md-ast.schema.json` (draft 2020-12,
`$id: https://jarenjs.dev/schemas/jaren-md-ast/0.1`) publishes this
vocabulary for validators and LLM structured output, in the same spirit
as the [query and JSLT grammar twins](../../../packages/json/README.md). The test
suite validates parser output against it with `@jarenjs/validate`.
