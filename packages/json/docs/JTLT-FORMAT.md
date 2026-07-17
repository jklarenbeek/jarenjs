# The Jaren JTLT Format

**Version 0.1 — Specification**

Module: `@jarenjs/json/jtlt`. This document is the language contract for the
Jaren JTLT text-template layer, the way [JSLT-FORMAT](./JSLT-FORMAT.md) is
the contract for the dispatch engine it compiles to, and
[QUERY-FORMAT](./QUERY-FORMAT.md) the contract for the expression language
both share.

> **Naming note (non-normative).** "JTLT" here names the Jaren template
> layer for text — *JSON template language for text*, the
> XSLT-`method="text"` / T4 derivative of this stack. Final naming/branding
> is an open question and is deliberately not settled here, mirroring the
> query and JSLT naming notes.

---

## 1. Introduction

### 1.1 What this language is

A JTLT **template** is a JSON document holding an ordered list of template
rules — the same rule shape as a JSLT stylesheet — whose bodies are
**segment lists** (literal text, interpolated query expressions, `$apply`
splices) and whose transformation result is a **string**. Where JSLT
answers "reshape this JSON into that JSON", JTLT answers "render this JSON
as that text": Markdown, XML, source code, configuration files — anything
with the shape of a character stream.

JTLT is a **front-end, not a second engine** — the same relationship the
XQuery module has to the query engine. A consumer compiles the template
into an ordinary JSLT 0.1 stylesheet and serializes the dispatched result;
the reference implementation exposes that stylesheet as
`render.stylesheet` (§11). Matching, conflict resolution, modes, dispatch,
recursion limits, externals, and the type-test hook are therefore
**inherited from JSLT by construction**, not restated: this document
specifies only what JTLT adds —

- the **template document** (§2): the `$jtlt` envelope and its `output`
  member;
- the **segment vocabulary** (§3): how rule bodies denote text;
- the **built-in template rules** (§4): what unmatched values render as;
- **serialization** (§5): the output methods and their escaping contract;
- the **error surface** (§9): `TL`-prefixed codes with `docPath` pointers
  into the *template* document.

The layer lives at `packages/json/src/jtlt/` — a module boundary inside
`@jarenjs/json`, like `jslt/` and `xquery/`. It adds **zero operators** to
the query vocabulary and **zero members** to the JSLT vocabulary; the JSLT
engine compiles JTLT's output without knowing JTLT exists.

### 1.2 Conformance and normative language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL
NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and
**OPTIONAL** in this document are to be interpreted as described in
RFC 2119.

- A **producer** emits template documents and MUST emit documents valid per
  this specification.
- A **consumer** (template compiler + renderer) MUST accept every valid
  template, MUST reject invalid ones with the compile errors of §9, MUST
  raise the runtime errors of §9 under the conditions specified there, and
  MUST produce the exact output strings this document and its fixtures
  define.

Everything JSLT-FORMAT.md specifies for stylesheets applies to the
compiled form of a template except where this document says otherwise; in
particular, everything QUERY-FORMAT.md specifies applies inside expression
segments verbatim.

### 1.3 Terminology

- **Template** — the top-level JSON document handed to the compiler (§2).
- **Rule** — one template rule object (§2.2).
- **Segment list** — a rule's body: a JSON array of segments (§3).
- **Segment** — one body element: literal text, an expression, a nested
  segment list, or one of the three segment operators (§3.1).
- **Interpolation** — serializing an expression segment's result into the
  output text (§3.2).
- **Output method** — the template's serialization mode, `"text"` or
  `"xml"` (§5).
- **Built-in template rules** — the rendering of values no user rule
  matches (§4).

### 1.4 What JTLT inherits from JSLT

The delegation table, stated once. Each row is normative by reference:

| concern | contract |
|---|---|
| rule `match` (path, schema, both) | JSLT-FORMAT §3 |
| conflict resolution (`priority`, document order) | JSLT-FORMAT §4, plus the reserved band of §2.2 |
| dispatch, recursion, `maxDepth` guard | JSLT-FORMAT §5.1, §5.4 |
| `$apply` value forms, semantics, location propagation, mode defaults | JSLT-FORMAT §6 |
| modes | JSLT-FORMAT §7 |
| parameters, reserved `root`/`path` externals | JSLT-FORMAT §8 |
| the `compileTypeTest` hook | JSLT-FORMAT §9 |
| expression evaluation inside segments | QUERY-FORMAT, all of it |

Two JSLT concepts do **not** carry over:

1. **`unmatched` dispositions.** JTLT's built-in template rules (§4) match
   every value, so no value is ever "unmatched" in the JSLT sense; the
   `share`/`fresh`/`error` vocabulary and the `modes` envelope member have
   no meaning here and are not part of the template envelope (§2.1).
2. **Sharing semantics.** The result of a rendering is a fresh string;
   JSLT's normative `===` sharing (JSLT-FORMAT §5.3) is about JSON
   outputs and does not apply.

---

## 2. The template document

### 2.1 Top level

A template is either:

1. a JSON **array of rules** (the shorthand form) — implies version
   `"0.1"` and the `"text"` output method; or
2. the **envelope object**:

   ```json
   { "$jtlt": "0.1",
     "output": "xml",
     "rules": [] }
   ```

   `$jtlt` and `rules` are REQUIRED (`rules` MUST be an array of rules);
   `output` is OPTIONAL. Unknown envelope members are compile error
   TL0001. A `$jtlt` value other than the string `"0.1"` — including
   non-string values — is compile error TL0006.

A template that is neither an array nor an object of the envelope shape is
TL0001.

- `"output"`: one of `"text"` (the default) or `"xml"` — the serialization
  method of §5. Any other value is TL0001, and the error message SHOULD
  name the supported methods. `"json"` and `"toml"` are deliberately not
  methods — see §5.1.

There is no `unmatched` member and no `modes` member (§1.4); a producer
MUST NOT emit them and a consumer MUST reject them as unknown members.

### 2.2 Rules

A **rule** is an object with the members

```json
{ "match": "$.store.book[*]", "mode": "toc", "priority": 2, "body": ["- ", "$.title", "\n"] }
```

- `body` (REQUIRED) — a **segment list**: a JSON array of segments (§3).
  A `body` that is not an array is TL0002 — this is the one place JTLT is
  *narrower* than JSLT, where a body is any query expression.
- `match` (OPTIONAL) — what the rule fires on, per JSLT-FORMAT §3
  verbatim: a JSONPath string, or an object with `path` and/or `schema`
  members. A rule with no `match` matches every value. The template
  compiler checks only that `match` is a string or an object (TL0002);
  everything deeper is validated by the JSLT layer and surfaces as TL0005
  (§9).
- `mode` (OPTIONAL) — a string naming the rule's mode (JSLT-FORMAT §7);
  default is the unnamed mode `""`. A non-string `mode` is TL0002.
- `priority` (OPTIONAL) — a finite JSON number for explicit conflict
  resolution (JSLT-FORMAT §4). A non-number or non-finite `priority` is
  TL0002. Priorities **at or below `-1e307` are RESERVED** for the
  built-in template rules (§4) and are compile error TL0003.

A rule that is not an object, or that lacks `body`, is TL0002. Unknown
rule members are TL0002 — the vocabulary is **closed**, the same culture
as the query and JSLT formats.

---

## 3. Segments

### 3.1 The segment forms

A segment list is a JSON array; each element is exactly one of the
following. The list is **closed**: anything else is compile error TL0004,
pointing at the offending element.

| segment | meaning |
|---|---|
| string not starting with `$` | **literal text**, emitted raw (§5) |
| string starting with `$$` | **literal text** with one leading `$` removed: `"$$price"` emits `$price` — the query format's own escape, applied to text |
| any other string starting with `$` | an **expression segment**: a query expression per QUERY-FORMAT §4 (absolute path, variable-rooted path, or invalid — invalid forms are compile errors surfacing as TL0005), interpolated per §3.2 |
| array | a **nested segment list**, rendered in place; nesting is purely organizational and has no semantic effect |
| `{ "$apply": … }` (single-key) | an **apply splice** (§3.4) |
| `{ "$raw": expr }` (single-key) | **unescaped interpolation** (§3.3) |
| `{ "$json": expr }` (single-key) | **JSON embedding** (§3.3) |
| any other object with at least one `$`-prefixed key | an **expression segment**: an operator phrase per QUERY-FORMAT (FLWOR, `$if`, `$concat`, …), interpolated per §3.2 |
| object with no `$`-prefixed key | TL0004 — a map constructor cannot be serialized; this is always a mistake |
| number, boolean, `null` | TL0004 — write literal text as a string, so `42` and `"42"` cannot be silently conflated |

`$raw`, `$json`, and the segment-position treatment of `$apply` are
**segment-level forms**: they are recognized only as complete body-list
elements (at any nesting depth of segment lists). Inside an expression
segment, `$raw` and `$json` are unknown operators (a compile error via
TL0005), and `$apply` is the ordinary JSLT operator whose sequence result
becomes payload values — almost never what a template author wants; see
§3.4.

### 3.2 Interpolation

An expression segment is evaluated per QUERY-FORMAT with the dispatched
value as `$`, then serialized:

1. Each item of the result sequence is converted to its **text value**:

   | item | text value |
   |---|---|
   | string | the string itself |
   | number | the shortest round-trip decimal form (ECMAScript `Number::toString`) |
   | `true` / `false` | `"true"` / `"false"` |
   | `null` | the empty string |
   | object or array | runtime error TL2001 |

2. The text values are joined with a **single space** (U+0020) — the XSLT
   `xsl:value-of` separator default.
3. The empty sequence renders as the empty string.
4. Under the `"xml"` output method the joined text is escaped (§5.3);
   under `"text"` it is emitted raw.

The `null` row is a deliberate deviation from the `$string` cast
(QUERY-FORMAT §8.10), which spells `null` as `"null"`: interpolation is
*text serialization* — an absent-ish value renders as nothing — while
`$string` is a *data cast*. An author who wants the spelling writes
`{ "$string": expr }` as the segment.

The TL2001 row is deliberate too: there is no default text value of a
container. Dispatch into it with `$apply`, or embed it with `$json`. The
error names the segment's `docPath`.

### 3.3 `$raw` and `$json`

- `{ "$raw": expr }` interpolates exactly per §3.2 steps 1–3 but is
  **never escaped** — the XSLT `disable-output-escaping` analogue for
  data-carried markup. Under the `"text"` method, `$raw` and a plain
  expression segment are indistinguishable.
- `{ "$json": expr }` serializes each result item as **JSON text**
  (ECMAScript `JSON.stringify`; containers are permitted and expected),
  space-joins multiple items, and escapes the result per the output
  method like any interpolation. The empty sequence renders as the empty
  string.

### 3.4 `$apply` splices

As a segment, `{ "$apply": … }` takes every value form and semantics of
JSLT-FORMAT §6 — selector-only, `[selector, mode]`, location propagation,
the rule's own mode as the default target — and **splices the rendered
output** of the dispatched values into the surrounding text, in order.
Nothing separates consecutive dispatch outputs; rules own their own
whitespace.

Because JTLT rule bodies are segment lists — not object constructors —
the `[]` idiom that JSLT-FORMAT §6.3 warns about does not arise: a bare
`{ "$apply": … }` element and a nested `[{ "$apply": … }]` element render
identically (§3.1's nesting rule).

`$apply` remains an ordinary operator *inside* expression segments (it is
injected by the JSLT layer into every body compile), but there its result
items are interpolated as payload values — containers raise TL2001 —
rather than spliced as rendered text. Consumers MUST NOT alter that
inherited behavior; authors SHOULD keep `$apply` at segment level.

---

## 4. The built-in template rules

Dispatching a value **no user rule matches** renders it with the built-in
template rules — the XSLT built-ins, restated for JSON:

- a **container** (object or array) applies templates to **every child in
  document order**, in the current mode, and splices the results —
  as if by `[{ "$apply": "$[*]" }]`;
- an **atom** (string, number, boolean, `null`) is **interpolated** per
  §3.2, including method escaping — as if by `["$"]`.

Consequences, all normative:

1. The empty template renders any input as the concatenated text values
   of its atoms, in document order (Appendix A.1).
2. `{ "$apply": "$.title" }` against an unmatched string is a *value-of
   with rule-override capability*: it renders the string today, and a
   later rule matching `$.title` takes over that rendering without the
   call site changing (Appendix A.5).
3. Every value matches *some* rule, so JSLT's `unmatched` dispositions
   never trigger (§1.4).

The built-in rules sit **below every user rule**: they lose to any user
rule of any priority. A consumer implementing them as ordinary appended
rules MUST place them at a priority at or below the reserved band of
§2.2, one per mode in use. A **matchless user rule** (JSLT default
priority `-1`) therefore replaces the built-in behavior for its mode —
the override mechanism, exactly as in XSLT.

Recursion through the built-in container rule and through `$apply` is
bounded by the inherited `maxDepth` guard (JSLT-FORMAT §5.4); exceeding
it surfaces as TL2003 wrapping JT2001.

> **Location note.** The built-in container rule's children are selected
> by a `$`-rooted path, so they carry locations and can match path rules
> below (JSLT-FORMAT §6.4). A value dispatched **location-less** — e.g.
> by `{ "$apply": "$" }`, whose bare-`$` selector is not a located path —
> can match only schema and matchless rules; the built-ins still render
> it.

---

## 5. Output methods and serialization

### 5.1 The `output` member

`"output"` selects how the rendered stream becomes the final string. 0.1
defines two methods; the member is designed for growth (a future method
is a new envelope value, not a new document shape).

**Non-normative rationale — why not `"json"` and `"toml"`.** JTLT's model
is a *text stream*: rules contribute character runs in document order.
JSON and TOML are *whole-document* serializations — they need the
complete value tree before the first byte is right, and their natural
producer is a JSLT transform followed by a serializer, not a template.
Keeping the method list stream-shaped keeps this contract honest.

### 5.2 The `"text"` method

Every emitted text run — literal, interpolation, `$raw`, `$json`, the
built-in atom rule — is written **verbatim**. There is no escaping, no
trimming, no newline normalization: whitespace in literal segments is the
author's, preserved exactly.

### 5.3 The `"xml"` method

Literal text segments and `$raw` interpolations are written verbatim —
literal template text *is* the markup, the XSLT literal-result-element /
T4 text-block contract. Every other emission — expression segments,
`$json` segments, and the built-in atom rule — is **escaped**: each
occurrence of the five characters below is replaced by its reference.

| character | replacement |
|---|---|
| `&` | `&amp;` |
| `<` | `&lt;` |
| `>` | `&gt;` |
| `"` | `&quot;` |
| `'` | `&#39;` |

All five are always escaped, so one rule serves element content and
single- or double-quoted attribute values alike.

**Non-normative.** The method escapes *data*; it does not police
*documents*. Well-formedness — balanced tags, one root element, legal
name characters, no literal `&` in literal text — is the author's
responsibility, exactly as in T4. `"xml"` is equally suitable for HTML
output; the escape set is safe HTML.

---

## 6. The compiled stylesheet (non-normative)

Only the rendered string is normative. The reference implementation
reaches it by **desugaring**: literal segments become `$const` pairs,
expression segments become tagged constructors carrying their template
`docPath`, `$apply` passes through verbatim, and the built-in rules of §4
are appended as matchless rules at priority `-1e308` — one per mode
named anywhere in the template. The result is a valid JSLT 0.1 stylesheet
with **user rule indexes preserved**, exposed as `render.stylesheet`
(§11) so authors can inspect exactly what dispatches on their behalf.

Consumers MAY compile templates any other way — a fused single-walk
renderer is an explicitly anticipated future — provided every observable
of this document (output strings, error codes, template `docPath`s,
`render.stylesheet` validity) is preserved.

---

## 7. Externals and parameters

JSLT-FORMAT §8 verbatim: free variables in expression segments are the
template's parameters, bound at render time
(`render(data, { rate: 1.21 })`); `root` and `path` are reserved,
engine-bound names; the compiled renderer exposes `render.externals` with
the user parameters in first-appearance order. Appendix A.6 exercises all
three.

---

## 8. The type-test hook

JSLT-FORMAT §9 verbatim: `options.compileTypeTest` serves `schema` match
conditions and the `$valid`/`$assert`/`$as` operators inside expression
segments. A template using schema matches compiled without a hook fails
exactly as in JSLT (JT0006), surfacing as TL0005.

---

## 9. Errors

### 9.1 Error objects

Consumers MUST raise compile-time errors as `JtltCompileError` and
runtime errors as `JtltRuntimeError`, with the same shape as the query
and JSLT errors:

- `code` — a stable identifier from the registry below;
- `message` — human-readable, non-normative;
- `docPath` — an RFC 6901 JSON Pointer into the **template document**
  (e.g. `/rules/1/body/2`);
- `cause` — the wrapped underlying error, where the registry says so.

In the bare-array shorthand (§2.1) the document has no `rules` member;
`docPath` pointers then start at the rule index (`/1/body/2`).

**The remap requirement.** Errors raised by the underlying JSLT/query
layers point into the *compiled stylesheet*; a consumer MUST translate
`docPath` back into the template document wherever the pointer targets a
construct the template author wrote (a rule member, a segment, a position
inside an expression segment). Pointers into consumer-generated
constructs (the built-in rules of §4) carry `docPath` `""` — the whole
document. Message text MAY still quote compiled-stylesheet paths; the
`docPath` member is the contract.

### 9.2 Registry

| code | condition |
|---|---|
| TL0001 | template shape: not array/object, missing/invalid `rules`, unknown envelope member, unknown `output` method |
| TL0002 | rule shape: not an object, missing or non-array `body`, unknown member, `match`/`mode`/`priority` of the wrong type |
| TL0003 | `priority` in the reserved band (at or below `-1e307`) |
| TL0004 | not a segment: `null`/number/boolean element, or an object with no `$`-prefixed key |
| TL0005 | the compiled stylesheet was rejected — wraps `JsltCompileError` (which may itself wrap query or hook errors); `docPath` remapped per §9.1 |
| TL0006 | unknown `$jtlt` version |
| TL2001 | interpolating an object or array (§3.2); `docPath` names the segment |
| TL2002 | malformed segment stream — an engine-contract violation, never author error; a consumer bug if ever observed |
| TL2003 | rendering raised a `JsltRuntimeError` — depth guard, body runtime errors, unbound parameters; wraps it, `docPath` remapped per §9.1 |

TL0xxx are compile errors (`JtltCompileError`), TL2xxx runtime errors
(`JtltRuntimeError`) — the same numbering convention as JQ/JT.

---

## 10. Correspondence with XSLT and T4 (non-normative)

| XSLT / T4 | JTLT 0.1 |
|---|---|
| `<xsl:output method="text"/>` / T4 template | `"output": "text"` (the default) |
| `<xsl:output method="xml"/>` | `"output": "xml"` (§5.3) |
| literal result text / T4 text block | literal string segment |
| `<xsl:value-of select="…"/>` / T4 `<#= … #>` | expression segment (§3.2) |
| `value-of`'s default `separator=" "` | the single-space sequence join (§3.2) |
| `<xsl:apply-templates select="…" mode="…"/>` | `{ "$apply": [selector, mode] }` splice (§3.4) |
| built-in template rules (text output) | §4 — containers recurse, atoms emit text |
| `disable-output-escaping="yes"` | `{ "$raw": expr }` |
| — (no analogue) | `{ "$json": expr }` |
| template rule / `match` / `mode` / `priority` | inherited from JSLT verbatim (§1.4) |

Deliberate deviations:

1. **Unmatched atoms render under the built-ins** exactly as XSLT's text
   built-ins emit text nodes — including the classic surprise that an
   over-broad `$apply` leaks stray text into the output. JTLT keeps the
   behavior because it is what makes `$apply` a value-of (§4); the
   remedy, as in XSLT, is a more precise selector or an overriding rule.
2. **`null` renders as nothing** (§3.2) — JSON's `null` is closer to an
   absent text node than to the four-letter word.
3. **No indentation engine in 0.1.** T4's structured-whitespace helpers
   and `xsl:output/@indent` have no analogue yet; literal whitespace is
   preserved verbatim and is the whole story. An indentation story is
   roadmap.
4. **One document, no imports, no named templates** — inherited from
   JSLT 0.1's composition stance.

---

## 11. API note (non-normative)

```
compileJtltStylesheet(doc, options) -> render
  render(data, externals?)      // string out
  render.externals              // user parameter names (§7)
  render.output                 // the resolved output method
  render.doc                    // deeply frozen copy of the template
  render.stylesheet             // the frozen compiled JSLT stylesheet (§6)
renderText(template, data, externals?, options?) // one-shot, WeakMap-cached
```

Module: `@jarenjs/json/jtlt`. `options` carries `compileTypeTest` (§8) and
`maxDepth` (JSLT-FORMAT §5.4), both for `compileJtltStylesheet` and as the
optional fourth argument of `renderText`. The one-shot function is the
counterpart of `queryJson`/`transformJson`, caching compiled templates by
document identity and compile-option values in a WeakMap.

---

## Appendix A. Worked examples (normative fixtures)

Every example is complete and destined to run verbatim as engine tests.
Unless noted, the output method is the default `"text"` and the mode is
the unnamed mode. Output strings are shown with escaped newlines.

### A.1 The empty template renders the input's text

```json
[]
```

Input:

```json
{ "greeting": "hello", "count": 2, "flag": true, "gap": null }
```

Output: `"hello2true"` — the built-in rules walk the tree in document
order, atoms emit their text values, `null` emits nothing (§3.2, §4).
Contrast JSLT, whose empty stylesheet is the identity *JSON* transform.

### A.2 A Markdown list

```json
[ { "match": "$", "body": ["# Books\n", { "$apply": "$.store.book[*]" }] },
  { "match": "$.store.book[*]", "body": ["- ", "$.title", " (", "$.price", ")\n"] } ]
```

Input:

```json
{ "store": { "book": [ { "title": "A", "price": 8.95 },
                       { "title": "B", "price": 12.99 } ] } }
```

Output: `"# Books\n- A (8.95)\n- B (12.99)\n"`. The root rule owns the
frame, the `$apply` splices one rendered line per book, each rule owns its
own newline (§3.4).

### A.3 XML — escaped interpolation, raw literals, `$raw`

```json
{ "$jtlt": "0.1",
  "output": "xml",
  "rules": [
    { "match": "$",
      "body": ["<note title=\"", "$.title", "\">", { "$raw": "$.markup" }, "</note>"] }
  ] }
```

Input:

```json
{ "title": "Q&A", "markup": "<b>hi</b>" }
```

Output: `"<note title=\"Q&amp;A\"><b>hi</b></note>"`. The interpolated
title is escaped — the same escape set serves the attribute value — while
the literal markup and the `$raw` splice pass through verbatim (§5.3).

### A.4 Two modes: table of contents + body text

```json
{ "$jtlt": "0.1",
  "rules": [
    { "match": "$",
      "body": ["TOC\n", { "$apply": ["$.sections[*]", "toc"] }, "\n",
               { "$apply": "$.sections[*]" }] },
    { "mode": "toc", "match": "$.sections[*]", "body": ["- ", "$.heading", "\n"] },
    { "match": "$.sections[*]",
      "body": ["== ", "$.heading", " ==\n", "$.text", "\n"] }
  ] }
```

Input:

```json
{ "sections": [
    { "heading": "Introduction", "text": "Start here." },
    { "heading": "Usage", "text": "Then this." } ] }
```

Output:

```
"TOC\n- Introduction\n- Usage\n\n== Introduction ==\nStart here.\n== Usage ==\nThen this.\n"
```

The same sections render twice — once per mode, each mode with its own
rule chain, exactly JSLT-FORMAT §7 (and its Appendix A.4, in text).

### A.5 `$apply` is a value-of with rule override

```json
[ { "match": "$", "body": ["Title: ", { "$apply": "$.title" }, "\n"] } ]
```

Input `{ "title": "Moby Dick" }` renders `"Title: Moby Dick\n"` — no rule
matches the string, so the built-in atom rule interpolates it (§4).
Appending a rule:

```json
[ { "match": "$", "body": ["Title: ", { "$apply": "$.title" }, "\n"] },
  { "match": "$.title", "body": ["«", "$", "»"] } ]
```

renders `"Title: «Moby Dick»\n"` — the override takes the rendering
without the call site changing.

### A.6 Parameters and the reserved externals

```json
[ { "match": "$..price",
    "body": ["$path", " = ", { "$mul": ["$", "$rate"] }, " ", "$root.currency", "\n"] } ]
```

Called as `render(input, { rate: 1.21 })`; `render.externals` is
`["rate"]` — `root` and `path` are engine-bound and excluded (§7).

Input:

```json
{ "currency": "EUR", "items": [ { "sku": "a1", "price": 10 } ] }
```

Output: `"$['items'][0]['price'] = 12.1 EUR\n"`. The other atoms
(`"EUR"`, `"a1"`) sit outside the matched location's rendering only
because the matched rule's output replaces the price *within the
built-in walk* — the walk still visits `currency` and `sku`, so the full
output begins with `EUR` and contains `a1`: precisely,
`"EURa1$['items'][0]['price'] = 12.1 EUR\n"`. This is deviation 1 of §10
in action; match the root to own the frame (A.2) when stray text is
unwelcome.

### A.7 Embedding JSON with `$json`

```json
[ { "match": "$", "body": ["const data = ", { "$json": "$" }, ";"] } ]
```

Input `{ "a": [1, 2] }` renders `"const data = {\"a\":[1,2]};"` — the one
sanctioned way to put a container into the stream (§3.3).

---

## Appendix B. LLM structured output (non-normative)

No schema artifact is published for templates in version 0.1 — this is
the honest gap between JTLT and its siblings, and closing it is roadmap.
The intended derivation follows the JSLT artifact's discipline
(JSLT-FORMAT Appendix B): reuse the committed query artifact's definition
map for expression segments, define the segment alternation of §3.1 over
it (strings, nested lists, `$raw`/`$json`/`$apply` phrases), reuse the
JSLT artifact's rule scaffolding with `body` narrowed to the segment-list
array, and derive a draft-07 twin mechanically. Until that artifact
exists, generated templates should be validated by compiling them:
`compileJtltStylesheet` is the authority, and every rejection carries a
`docPath` into the template for a repair loop.

Templates remain ordinary JSON throughout a toolchain — function-call
arguments, retrieved rule sets, reviewed diffs, audit-log entries, and
replayable renderers without a text parser.
