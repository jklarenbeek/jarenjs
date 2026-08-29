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
spans) plus the GFM extensions in universal use: **tables**,
**strikethrough**, **task lists**, **footnotes** (§4.6) and **literal
autolinks** (§4.7). The parser passes **every example in the CommonMark
specification** through the string emitter (§4.4a), and the benchmark
workspace scores both emitters against the official corpus — and against
the GFM specification's extension sections — on every run.

This specification remains normative for the package: it covers the
frontmatter, the AST, and the extensions neither spec describes
(footnotes are GitHub's, documented nowhere but here). Where it and
CommonMark speak about the same construct they agree. Two places where
this package deliberately differs from the GFM reference implementation
are stated with their reasons in the package README's scorecard section;
neither is a dialect gap a document can fall into.

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
| `footnoteDefinition` | `identifier`, `label`, `children` | GFM; block content, collected rather than rendered in place (§4.6) |

### 4.2 Inline nodes

| type | members | notes |
|---|---|---|
| `text` | `value` | literal text, escapes resolved |
| `emphasis` | `children` | `*x*` / `_x_` |
| `strong` | `children` | `**x**` / `__x__` |
| `strikethrough` | `children` | `~~x~~` (GFM) |
| `link` | `url`, `title` (string or `null`), `children` | inline links and autolinks; `url` is verbatim, filtered at render (§4.3). A GFM literal autolink additionally carries `auto: true` and a RESOLVED `url` (§4.7) |
| `image` | `url`, `title` (string or `null`), `alt` (string) | `alt` is plain text; `url` as for `link` |
| `inlineCode` | `value` | backtick spans |
| `break` | — | hard break (two spaces or `\` before newline) |
| `softBreak` | — | an in-paragraph newline |
| `html` | `value` | a raw inline HTML span |
| `footnoteReference` | `identifier`, `label` | GFM; the citation mark (§4.6) |

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

### 4.4a Raw HTML and the two emitters (normative)

An `html` node holds markup verbatim (§4.1, §4.2). What a consumer may do
with it depends on what the consumer emits, and this format recognizes
exactly two emission targets:

- a **vnode tree** (`mdToVnode`) has no representation for unbalanced or
  unknown markup — a lone `</div>`, a never-closed `<span>` — because a
  tree node is an element or it is nothing. An emitter to vnodes MUST
  therefore drop (`html: 'skip'`, the default), show as literal text
  (`'text'`), or PARSE through an allow-list (`'vnode'`). It MUST NOT
  have a mode that emits author markup unescaped, and that impossibility
  — not a filtering promise — is what makes the vnode path safe for
  Markdown a host did not write;
- a **string** (`toHtml`) can hold any byte sequence. A string emitter
  MUST offer `'escape'` (the default: the markup is shown, escaped),
  `'skip'` (parity with the vnode default) and `'raw'` (verbatim). `'raw'`
  is the mode CommonMark specifies and the mode a conformance scorecard
  measures; it MUST be per-call, MUST NOT be the default, and MUST be
  documented as trusted-input-only.

The URL rule of §4.3 is **orthogonal to all of this** and applies in
every mode of both emitters: `'raw'` states that a document's HTML blocks
are trusted, not that its markdown links are.

Neither emitter may be implemented in terms of the other: a string
emitter built on vnodes inherits the tree's structural limit, and a vnode
emitter built on strings would have to re-parse its own output. For every
document whose markup a vnode CAN express, the two MUST agree
byte-for-byte, which is the property that keeps them one dialect with two
targets rather than two dialects.

### 4.5 Heading identifiers (normative)

A `heading` node carries no identifier: an `id` is a *rendering*
decision, so the AST stays the text the author wrote and two emitters can
disagree about anchors without disagreeing about the document.

An emitter that offers heading ids MUST compute one from the heading's
plain text (`textOf`, §4.2 — image `alt` counts, formatting does not) by
this algorithm, which is GitHub's, so a document anchors identically on
GitHub, in an editor preview and in this renderer:

1. lower-case the text;
2. drop every character that is not a letter, a digit, a combining mark,
   `-` or `_` — so punctuation, symbols (`§`, `—`) and emoji go, while
   non-ASCII letters and digits stay;
3. replace each remaining whitespace character with `-`, one for one (a
   run of two spaces yields `--`).

The result MAY be empty (`## ***`); an emitter MUST then substitute
`section`, because a heading with no landing place cannot be linked.
Within one document, the **second** heading yielding a given identifier
MUST get `-1` appended, the third `-2`, and so on, counted over the
substituted value so `***` twice yields `section` and `section-1`. The
counter is per emission and MUST NOT be shared with any other numbering
in the emitter.

An emitter MUST offer a prefix (`slugPrefix`) prepended to every emitted
identifier and to every anchor href it writes, and its default MUST be
empty. A host rendering a document it did not author into a page it owns
sets the prefix (GitHub's own answer is `user-content-`) so an author
cannot mint an identifier that collides with the host's own DOM.

Emitting ids MUST be opt-in and off by default: CommonMark renders a
heading as `<h1>Foo</h1>`, and a default that adds an attribute would put
this package's conformance score at odds with the documents it produces.

`mdToVnode` implements this as `headingIds`, `slugPrefix` and
`headingAnchors`; the slug transform itself is `slugify` from
`@jarenjs/core/string`, the suite's only one. A host whose documents do
not all share one provenance names the prefix per render rather than per
emitter — the visual component takes the rendering policy as `view()`'s
second argument (README §"The visual component").

### 4.6 Footnotes (normative)

Footnotes are a GFM extension the GFM *specification* never described —
GitHub ships them, the spec has no section for them — so their behaviour
is pinned here, matching GitHub's rendering.

**Two node types.** A producer MUST emit a `footnoteDefinition` for
`[^label]: …` and a `footnoteReference` for `[^label]`, both carrying an
`identifier` (the label under the normalization of §Link reference
definitions — trim, collapse whitespace, case fold) and a `label` (the
text as written). Both are recognized only when `gfm` is on.

**One label grammar, both sides.** A label is `[^` followed by one or
more characters that are not `]`, `[` or whitespace, then `]`. The same
grammar decides a definition and a reference, so `[^my note]` is neither
rather than one without the other.

**A definition is a container block**, not a leading definition like
`[foo]:`. It therefore MAY interrupt a paragraph, its continuation lines
are indented four columns, it takes lazy continuation, and — like a list
item — a blank line ends it while it is still empty. A producer MUST
record only the FIRST definition of an identifier.

**A definition stays where it was written.** A producer MUST NOT hoist
definitions: the AST is the document, and moving them would make
`toMarkdown` print a document the author did not write. Collecting them
is the *emitter's* job (§4.4a: what a consumer may do depends on what it
emits).

An emitter that renders footnotes MUST:

1. **number by first reference** — not by definition order, not by label.
   References inside a rendered footnote count, and are numbered after
   the references in the document body;
2. **render nothing for an uncited definition**, in place or at the end;
3. **render a reference with no definition as the literal text it was
   written as** (`[^nope]`), never as a link to a missing anchor. (A
   parser cannot produce such a node — the inline rule requires a
   definition — but a transform can.);
4. **terminate on a cycle.** A footnote MAY cite another, itself
   included; an emitter MUST render each definition at most once, which
   makes termination a property of the algorithm rather than a depth
   limit;
5. **give each citation its own identifier**, so a footnote cited *n*
   times has *n* landing places and *n* back-references. The
   identifiers are `<prefix>fn-<number>` for the definition and
   `<prefix>fnref-<number>` for the first citation, `-2`, `-3` … for the
   rest;
6. **default the prefix to `user-content-`**, and use `slugPrefix` when
   it is given. This differs from §4.5 on purpose: a heading id is
   opt-in and asserted bare by CommonMark, while a footnote id is
   emitted by the default rendering of a feature that is *nothing but* a
   link between two places on one page. No corpus example asserts a bare
   `fn-1`, so the safe default costs nothing;
7. **append one section after the last block**, inside whatever fragment
   or wrapper it is producing. A consumer concatenating fragments
   receives one footnotes section per fragment, which is the only
   placement a fragment emitter can offer.

### 4.7 Literal autolinks (normative)

With `gfm` on, a producer MUST recognize GFM's extended autolinks — bare
`www.…`, `http://…`, `https://…`, `ftp://…` and email addresses — under
the grammar of GFM §Autolinks (extension), including:

- a match MAY begin only at the start of the text, after whitespace, or
  after one of `*`, `_`, `~`, `(`. The start of a `text` node counts:
  what precedes it is a sibling node, not a character;
- matching is **case-sensitive**. `WWW.EXAMPLE.COM` is not a link, here
  or on GitHub;
- trailing `?`, `!`, `.`, `,`, `:`, `*`, `_`, `~` are excluded from the
  link, though they MAY appear in its interior;
- a trailing `)` is excluded only while the link holds more `)` than
  `(`, so `(www.a.test/x)` links `www.a.test/x` and
  `www.a.test/x(y)` links all of it;
- a trailing `;` is excluded only as part of an entity-shaped tail
  (`&` + alphanumerics + `;`), and then the whole tail goes, not the
  semicolon;
- a `<` ends the link at that character.

**The node type is `link`.** A literal autolink IS a link, and inventing
a second type would make every consumer, plugin and schema learn two
spellings of one thing. The `url` holds the RESOLVED destination — a
`www.` link gets `http://`, an address gets `mailto:` — so no consumer
re-derives it. A producer MUST set `auto: true` on such a node; exactly
one consumer reads it, the canonical printer, which prints the link back
bare (§5). A consumer that does not know the flag renders a correct
link, which is why it is a flag and not a type.

Recognition happens **after** inline parsing, over `text` nodes, and MUST
NOT descend into a `link` — links do not nest. Consequently a literal
autolink is never found inside a code span, raw HTML or link text, and
the entity rule above is meaningful: by then `&copy;` has become `©`, and
the only `&…;` left to exclude is one that was never an entity.

### 4.8 Directives (normative)

A **directive** is a value in a document that a machine derives and a
human reads:

```markdown
Jaren is <!--fact:jsonpath.ctsRatio-->23.1<!--/fact-->x faster on the CTS mean.
```

The carrier is an HTML comment, and the choice is the whole design:
every markdown renderer drops comments, so a directive is invisible on
GitHub, in an editor preview and on npm, while the baked text between the
markers stays readable, correct and static.

- A directive is `<!--<ns>:<payload>-->` … `<!--/<ns>-->`. `ns` matches
  `[a-z][a-z0-9-]*`.
- **The payload is opaque.** This format assigns it no meaning: `bm` puts
  a derivation key there, `mdx` puts a query expression. A consumer owns
  its own vocabulary, and a producer MUST NOT interpret another
  namespace's payload.
- **Block scope** is an opener and closer that are their own `html` block
  nodes, with block nodes between them. **Inline scope** is all three
  inside one inline container. Markers pair **within one children array**:
  an opener inside `**bold**` and a closer outside it are two unpaired
  markers, not one directive.
- **Unpaired markers MUST be reported, not dropped.** An opener with no
  closer, a stray closer, and same-`ns` nesting are each diagnostics. A
  marker nobody matched is how a stale figure hides.
- A consumer MUST NOT require directive support to read the document:
  with the markers ignored, the text between them is the document's
  content, and that is what every renderer shows.

**An inline marker MUST NOT begin a line.** A comment at the start of a
line opens a CommonMark HTML block (§HTML blocks, type 2), which consumes
the rest of that line — so the marker, its value *and the prose after it*
leave the document. This is a property of CommonMark, not of this
format, and it applies to every renderer including GitHub's. Put text
before the marker, or give the directive a block of its own.

Writing a directive's current value into the source is **baking**. It is
a build-time operation on trusted input, and it differs from mdx
interpolation on exactly one axis that matters: a baked body is spliced
into the source and WILL be re-parsed as markdown (a whole table is a
legitimate body), whereas an interpolated value lands in a `text` node
and is never re-read. A baker MUST rewrite only the spans between
markers — a document with no directives MUST come back byte-identical —
because canonical re-printing (§5) would reformat every hand-written
document it touched.

## 5. Canonical Markdown and round-trips

`toMarkdown(doc)` prints **canonical Markdown**: ATX headings, `-`
bullets, `1.` ordered markers (renumbered from `start`), fenced code
with backticks, `*emphasis*`/`**strong**`, reference-free inline links,
`|`-piped tables with an alignment row, and blank lines between blocks.
A footnote definition prints where it stands, its later blocks indented
four columns; a literal autolink prints bare, escaped so that a `_` or
`&` in a destination survives the trip back.

The normative round-trip guarantees:

1. `parseMarkdown(toMarkdown(doc))` produces an AST deep-equal to
   `doc.ast` for any document this package produced, and printing that
   AST again reproduces the same text (canonical form is a fixed
   point). Both halves are checked over the whole CommonMark example
   corpus, not a sample: a printer that cannot represent a construct it
   just parsed — an autolink, a heading carrying a soft break, two
   adjacent lists, a text run holding a literal newline — shows up
   there and nowhere else. The same check runs over the GFM
   specification's 672 examples with the extensions ON, which is the
   only place tables, task lists, strikethrough, footnotes and literal
   autolinks are printed at corpus scale;
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
