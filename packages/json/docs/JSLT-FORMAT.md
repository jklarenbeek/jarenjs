# The Jaren JSLT Format

**Version 0.1 — Specification**

Module: `@jarenjs/json/jslt`. This document is the language contract for the
Jaren JSLT template layer, the way [QUERY-FORMAT](./QUERY-FORMAT.md) is the
contract for the query engine it builds on. The design history lives in
[JSLT-PRELUDE](./JSLT-PRELUDE.md), which this specification supersedes.

> **Naming note (non-normative).** "JSLT" here names the Jaren template
> layer — *JSON stylesheet language for transformations*, the XSLT
> derivative of this stack. It is unrelated to Schibsted's JSLT language;
> final naming/branding is an open question and is deliberately not settled
> here, mirroring the query format's naming note.

---

## 1. Introduction

### 1.1 What this language is

A JSLT **stylesheet** is a JSON document holding an ordered list of
**template rules**. Each rule says "when you meet a value shaped like this,
produce that", and a recursive dispatch engine — XSLT's `apply-templates`
idea — does the walking. XSLT's enduring pain is that "shaped like this"
(XPath patterns), "typed like this" (XML Schema), and the output vocabulary
are three disjoint languages bolted together. Here all three are
vocabularies this stack already compiles:

- **matching** — RFC 9535 JSONPath, already compiled by this package (§3);
- **typing** — JSON Schema, embedded through the same validator-agnostic
  `compileTypeTest` hook the query engine uses (§9): a schema *is* a
  pattern, with no schema-aware processor ceremony;
- **producing** — Jaren JSON Query documents (QUERY-FORMAT.md), whose
  documents are JSON values the way XSLT stylesheets are XML documents.

The architecture pillars, stated once (non-normative but binding on the
reference implementation): **one stack, zero new dependencies**. JSLT adds
exactly **one operator** (`$apply`, §6) and a thin compiled dispatch
runtime. The layer lives at `packages/json/src/jslt/` — a module boundary
inside `@jarenjs/json`, like `xquery/` — NOT a new package: it needs the
query engine's internals (`normalizeQuery`, `compileNode`, the sequence
runtime), and a separate package would force those onto the public surface.
The standalone `@jarenjs/jslt` package sketched in the prelude (§7 there)
stays a roadmap note.

### 1.2 Conformance and normative language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL
NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and
**OPTIONAL** in this document are to be interpreted as described in
RFC 2119.

- A **producer** emits stylesheet documents and MUST emit documents valid
  per this specification. (`@jarenjs/linq/jslt` is one: it writes these
  documents by code — rule bodies captured as callbacks — and reproduces
  Appendix A byte for byte; its mapping table is
  `packages/linq/docs/PENS-FORMAT.md` §4.)
- A **consumer** (stylesheet compiler + transformation engine) MUST accept
  every valid stylesheet, MUST reject invalid ones with the compile errors
  of §10, and MUST raise the runtime errors of §10 under the conditions
  specified there.

Everything QUERY-FORMAT.md specifies for query documents applies unchanged
to rule bodies except where this document says otherwise; the only body
extension is `$apply` (§6).

### 1.3 Terminology

- **Stylesheet** — the top-level JSON document handed to the compiler (§2).
- **Rule** — one template rule object (§2.2).
- **Body** — a rule's output expression: a Jaren JSON Query document
  extended with `$apply`.
- **Dispatch** — finding and firing the winning rule for one value (§5).
- **Mode** — a named partition of the rule set (§7).
- **Location** — the normalized path (RFC 9535 §2.7) of a value inside the
  input document, when it has one (§3.2, §6).
- **Disposition** — a mode's built-in behavior for unmatched values (§5).

### 1.4 Changes from the prelude

JSLT-PRELUDE.md declared its spellings provisional; these are the final
calls, listed here so readers of the prelude are not misled:

1. **`$schema-match` is gone.** A schema match is the `"schema"` member of
   the `match` object (§3.1); position and shape conditions are two members
   of one object, not two wrapper vocabularies.
2. **The stylesheet envelope.** Besides the prelude's bare rule array, an
   object form `{"$jslt": "0.1", "rules": [...]}` carries the version and
   the stylesheet-level options `unmatched` and `modes` (§2.1).
3. **Dispositions are `share` / `fresh` / `error`** under the `unmatched`
   member (§5), replacing the prelude's deep-copy/shallow-copy pair. There
   is **no XSLT-style deep-copy default** — see §5.2 for the rationale;
   XSLT's literal deep-copy remains expressible per rule as
   `{"match": m, "body": "$"}`.
4. **Conflict resolution is fixed and small** (§4): explicit `priority`,
   then three default priorities, then document order with later rules
   winning. The prelude's schema-specificity metric (const > enum > type…)
   is explicitly a non-goal of 0.1 and stays on the roadmap.
5. **The `[]` idiom.** The prelude's §2 sketch wrote
   `"children": {"$apply": "$.chapters[*]"}` — that bare member form is a
   runtime error (JQ2001) as soon as a node has two or more chapters. The
   correct idiom is `"children": [{"$apply": "$.chapters[*]"}]`, with the
   array-constructor brackets (§6.3).
6. **`$apply`'s mode argument** is spelled as the argument-list form
   `{"$apply": [selector, mode]}` (§6.1), and an omitted mode defaults to
   the **rule's own mode**, not XSLT 1.0's unnamed mode (§6.5).
7. **Vocabulary placement is decided**: `$apply` lives in the `jslt`
   module, injected per rule body by the stylesheet compiler. The core
   query vocabulary and the published query-format schema are unchanged
   (§6.1).
8. **Reserved parameters.** `root` and `path` are engine-bound externals
   available in every body (§8.2); the prelude had no parameter story.

---

## 2. The stylesheet document

### 2.1 Top level

A stylesheet is either:

1. a JSON **array of rules** (the shorthand form) — implies version `"0.1"`
   and all defaults; or
2. the **envelope object**:

   ```json
   { "$jslt": "0.1",
     "rules": [],
     "unmatched": "share",
     "modes": { "toc": { "unmatched": "error" } } }
   ```

   `$jslt` and `rules` are REQUIRED (`rules` MUST be an array of rules);
   `unmatched` and `modes` are OPTIONAL. Unknown envelope members are
   compile error JT0001. A `$jslt` value other than the string `"0.1"` —
   including non-string values — is compile error JT0004.

A stylesheet that is neither an array nor an object of the envelope shape
is JT0001.

- `"unmatched"`: one of `"share"` (the default), `"fresh"`, or `"error"` —
  the built-in-rule disposition of §5; any other value is JT0001. The
  envelope's `unmatched` sets the default for every mode.
- `"modes"`: an object `{ modeName: { "unmatched": disposition } }` of
  per-mode overrides. Unknown members inside a mode object are JT0001.
  Modes need NOT be declared to be used (§7); declaring one only overrides
  its disposition.

### 2.2 Rules

A **rule** is an object with the members

```json
{ "match": "$..price", "mode": "render", "priority": 2, "body": "$" }
```

- `body` (REQUIRED) — a Jaren JSON Query document per QUERY-FORMAT.md,
  extended with the `$apply` operator (§6). Everything the query format
  specifies — encoding rules, FLWOR, operators, schema operators, errors —
  applies inside a body verbatim.
- `match` (OPTIONAL) — what the rule fires on (§3). A rule with no `match`
  member matches every value (an **unconditional rule**).
- `mode` (OPTIONAL) — a string naming the rule's mode (§7); default is the
  unnamed mode `""`. A non-string `mode` is JT0002.
- `priority` (OPTIONAL) — any JSON number, for explicit conflict resolution
  (§4). A non-number `priority` is JT0002.

A rule that is not an object, or that lacks `body`, is JT0002. Unknown rule
members are JT0002 — the vocabulary is **closed**, the same culture as the
query format: no silent annotations.

---

## 3. Matching

### 3.1 The `match` member

`match` is either an RFC 9535 JSONPath query string, or an object with **at
least one** of the members `"path"` and `"schema"` and **no other members**
(violations are JT0003):

```json
{ "match": { "path": "$.store.book[*]",
             "schema": { "type": "object", "required": ["isbn"] } } }
```

- A bare string is shorthand for `{"path": string}`.
- `"path"` MUST be a valid RFC 9535 query string; a syntactically invalid
  path is JT0003 (with the `JSONPathSyntaxError` as `cause`).
- `"schema"` is a **JSON Schema literal**, taken verbatim per the
  schema-literal rules of QUERY-FORMAT §8.11: never evaluated as a query
  expression, deep-copied and frozen, compiled exactly once at stylesheet
  compile time by the `compileTypeTest` hook (§9).
- An empty object `{}` is JT0003 (it would match nothing meaningfully and
  is always a mistake; write no `match` member for an unconditional rule).

When both `path` and `schema` are present, **both** conditions MUST hold
for the rule to match.

### 3.2 Path matching is positional

A value matches a `"path"` condition **iff it sits at a location the path
selects from the input document root**. The path is a plain RFC 9535 query
over the input document: filters inside it see `$` as the **input root**
(not the candidate value), exactly as in any absolute path.

Normative consequence: values that have **no location** — values computed
by a rule body, or selected by a non-path `$apply` selector (§6.4) — can
NEVER match a path condition. Only `schema` conditions and unconditional
rules apply to them.

```json
{ "match": "$..price", "body": { "$mul": ["$", 1.21] } }
```

matches every value sitting at a `price` member anywhere in the input — and
does not match the number `10` produced by another rule's body, however
price-like it looks.

### 3.3 Schema matching is shape-based

A value matches a `"schema"` condition **iff it satisfies the schema**,
tested by the compiled predicate the `compileTypeTest` hook returned — the
same hook, contract, and per-item semantics as QUERY-FORMAT §8.11. Shape
matching needs no location: it applies to every dispatched value, wherever
it came from.

```json
{ "match": { "schema": { "type": "object", "required": ["isbn"] } },
  "body": { "title": "$.title" } }
```

### 3.4 Implementation note (non-normative)

The intended mechanism constrains the semantics, so it is recorded here:
the consumer evaluates all match paths against the input **once per
transformation** (lazily per mode), yielding the set of matched locations;
dispatching a located value tests set membership plus the schema
predicates. This is sound because documents are **immutable during a
transform**: rule bodies construct fresh values per the query engine's
constructor rules and never mutate the input, so no body ever observes
partial pre-pass state.

---

## 4. Conflict resolution

The whole algorithm:

1. **Rank** = (`priority`, document order).
2. `priority` is any JSON number. When absent, the **default priority** is:

   | rule | default priority |
   |---|---|
   | both `path` and `schema` present | `1` |
   | exactly one of `path` / `schema` | `0` |
   | unconditional (no `match`) | `-1` |

3. Higher priority wins. Ties break by document order with **later rules
   winning** — user rules appended after a library's override it.
4. The first match in rank order **fires**; there are no ambiguity errors
   and no warnings.

Deep schema-specificity metrics (a `const` beating an `enum` beating a
`type`, …) are explicitly a **non-goal of 0.1**; they stay on the roadmap.
XSLT's default-priority table is the cautionary tale this section is
designed to beat by being small.

```json
[ { "match": "$..price", "body": "$" },
  { "match": "$..price", "body": { "$mul": ["$", 1.21] } } ]
```

Both rules tie at priority `0`; the later one wins and every price is
multiplied.

---

## 5. Dispatch and the built-in rule

### 5.1 Processing model

A **transformation** is the dispatch of the input document root in the
unnamed mode. **Dispatching** a value in a mode:

1. Find the highest-ranking rule of the mode that matches the value (§3,
   §4). If one fires, the dispatch result is its **body's result**, with
   the matched value as the body's query input `$` (no context-item drift,
   per the query format).
2. If no rule fires, the **built-in rule** applies, per the mode's
   `unmatched` disposition:

- **`"share"` (the default).** A scalar (string, number, boolean, `null`)
  is returned **as-is**. A container is rebuilt member-by-member (object)
  or element-by-element (array), **dispatching every child**; the rebuilt
  container follows the query format's constructor rules: an object member
  whose child dispatch is empty is **omitted**; a child dispatch of two or
  more items for an object member is runtime error JT2002; array children
  splice their result sequences flat. **When every child comes back
  identical (`===`) and complete, the original container itself is
  returned** — the output shares unmatched subtrees with the input. The
  empty stylesheet is the identity transform, `===` included.
- **`"fresh"`.** The same semantics, but the built-in rule **always
  returns the freshly rebuilt container**, never the original — callers
  get a tree they may mutate without touching the input (the
  forms/view-model case). Stated plainly: `fresh` governs **only built-in
  rebuilds**; rule-body outputs are whatever the bodies return, and path
  results inside bodies still share input subtrees (QUERY-FORMAT
  behavior).
- **`"error"`.** An unmatched value is runtime error JT2003, naming the
  value's location when it has one — the exhaustive-dispatch style.

### 5.2 No deep-copy default (divergence from the prelude)

JSLT has **no XSLT deep-copy default**, deliberately. Under XSLT 3.0
`on-no-match="deep-copy"` semantics, an unmatched root freezes the whole
document: a stylesheet whose only rule matches `$..price` would never fire
it, because the root is unmatched and the deep copy stops all further
matching. That contradicts the surgical-override promise that motivates
template engines — rules must apply at every depth.

In JSLT, rules conceptually apply to **every value**; the `unmatched`
disposition only chooses what happens **between** matches. XSLT's literal
deep-copy — copy this subtree, stop matching inside it — remains
expressible per rule:

```json
{ "match": "$.assets", "body": "$" }
```

### 5.3 Sharing is normative

In `share` mode — and in rule bodies generally, since path results share
input subtrees per QUERY-FORMAT — **the output may alias input objects and
arrays; mutating the output mutates the input.** Consumers MUST implement
the `===` sharing of §5.1, and callers who intend to mutate the result MUST
use `fresh` (or copy). This is documented loudly on purpose: it is the
number-one operational surprise of value-sharing template engines.

### 5.4 Recursion and the depth guard

Recursion happens ONLY through `$apply` (§6) and the built-in rule's child
dispatches. A consumer MUST enforce a dispatch depth guard: the compile
option `maxDepth` (default `1024`) bounds the dispatch nesting depth, and
exceeding it is runtime error JT2001 — the self-application loop

```json
{ "rules": [ { "body": { "$apply": ["$"] } } ], "$jslt": "0.1" }
```

MUST die with JT2001, not a stack overflow.

---

## 6. `$apply` — the apply-templates operator

### 6.1 Availability

`$apply` is available ONLY inside rule bodies: the stylesheet compiler
injects it into each body compile. The query format's vocabulary is
**unchanged** and its published schema untouched — plain `compileJsonQuery`
documents still reject `$apply` as JQ0002.

### 6.2 Value forms

Following the `$orderby` disambiguation precedent of the query format
(QUERY-FORMAT §6.6, "an array value is always a list"):

- A **non-array** value is the selector expression; dispatch happens in the
  **rule's own mode**:

  ```json
  { "$apply": "$.chapters[*]" }
  ```

- An **array** value is ALWAYS the argument-list form `[selector]` or
  `[selector, mode]`, where `mode` is a **literal JSON string** naming the
  target mode (`""` names the unnamed mode). The mode is not an
  expression — dynamic mode selection is a non-goal of 0.1:

  ```json
  { "$apply": ["$.sections[*]", "toc"] }
  ```

- To apply templates to a **constructed array**, write the selector
  explicitly: `{"$apply": [{"$const": [1, 2]}]}` or
  `{"$apply": [{"$seq": [1, 2]}]}` — a bare array value never means "apply
  to this array".

Wrong shapes — an empty or overlong argument list, a non-string mode — are
JQ0003 inside the body, surfacing as JT0007 at the stylesheet level (§10).

### 6.3 Semantics

Evaluate the selector against the current input `$`; for each item of the
result, **in order**, dispatch it (§5) in the target mode; concatenate the
dispatch results into one sequence. An empty selector result is the empty
sequence.

`$apply` is an **ordinary operator** with respect to the query format: its
result composes under the constructor rules like any other expression.

> **The `[]` idiom — the one trap every author hits.** An object member
> holds exactly one value, so the array-of-children idiom is
>
> ```json
> { "title": "$.title", "children": [ { "$apply": "$.chapters[*]" } ] }
> ```
>
> — **with** the array-constructor brackets, which splice the sequence into
> one array. The bare member form
> `"children": { "$apply": "$.chapters[*]" }` assigns the sequence itself
> to the member and is runtime error **JQ2001** the moment a node has two
> or more chapters (an object member takes exactly one value,
> QUERY-FORMAT §3.1). The prelude's sketch got this wrong; see §1.4.

### 6.4 Location propagation

Items selected by a selector that is a **path rooted at `$`** (the current
value) **or at `$root`** (§8.2) carry locations: the current value's (or
the root's) location extended with the path's normalized-path suffix. Such
items can match path rules (§3.2). Items produced any other way — FLWOR
phrases, operators, variable-rooted paths on other variables, literals —
are **location-less**: only schema and unconditional rules can match them.
The dispatch of the input root carries location `$`.

### 6.5 Mode dispatch defaults

An omitted mode means the **rule's own mode** — a static fact, since each
rule belongs to exactly one mode (§7). This deviates from XSLT 1.0, whose
modeless `apply-templates` always targets the unnamed mode; recursive walks
*within* a mode are the dominant pattern, and XSLT 3.0 grew
`mode="#current"` for exactly this reason. JSLT makes the common thing the
default.

Applying into a mode that has no rules is legal — the mode's disposition
does all the work (§5). A rule's `mode` is a single string in 0.1; mode
lists are roadmap.

---

## 7. Modes

A rule's `mode` member (default: the unnamed mode `""`) partitions the rule
set. Each mode has its own ranked rule chain (§4), its own `unmatched`
disposition (§2.1, §5), and its own match pre-pass (§3.4). Modes are the
mechanism for walking the same input more than once with different
outputs — the same document rendered once as a table of contents and once
as body content is the canonical example (Appendix A.4).

Modes need not be declared: naming one in a rule's `mode` or an `$apply`
target creates it. The envelope's `modes` member (§2.1) exists only to
override a mode's disposition.

---

## 8. Externals and parameters

### 8.1 Stylesheet parameters

Free variables in rule bodies are the stylesheet's **parameters**, exactly
like query externals (QUERY-FORMAT §9): use is the declaration, and the
caller binds them at transformation time —
`transform(data, { rate: 1.21 })`. Evaluating a reference to an unbound
parameter is JQ2006 inside the body, surfacing wrapped as JT2004 (§10).

### 8.2 Reserved names: `root` and `path`

Two names are RESERVED and engine-bound per dispatch, shadowing any
caller-supplied binding of the same name:

- `root` — the input document root. `"$root"` and variable-rooted paths
  like `"$root.currency"` read the whole input from any rule body.
- `path` — the current value's **normalized path** (RFC 9535 §2.7 string,
  e.g. `"$['items'][0]['price']"`), or `null` for location-less values
  (§6.4).

> **Contrast note.** The validator's `$query` keyword (the other direction
> of this stack: queries inside schemas) binds its `path` parameter as an
> **RFC 6901 JSON Pointer** — the schema-side convention. JSLT's matching
> language is JSONPath, so its `path` is an RFC 9535 **normalized path**.
> See the `@jarenjs/validate` README's "`$query` — cross-field assertions"
> section for the other half.

### 8.3 `transform.externals`

The compiled transformation exposes `transform.externals`: the **user
parameters only** (reserved names excluded), as the union across all rule
bodies, in order of first appearance.

---

## 9. The type-test hook

```
compileJsltStylesheet(doc, { compileTypeTest: (schemaJson, docPath) => (value => boolean) })
```

One hook, three consumers: `schema` match conditions (§3.3), and the
`$valid`/`$assert` operators and `$as` clause inside rule bodies (the hook
is threaded through to every body compile). The contract, signature, and
once-per-literal-at-compile-time rule are exactly QUERY-FORMAT §8.11's;
`@jarenjs/validate/query`'s `createTypeTestCompiler` satisfies it, and the
`json` package never imports the validator — the dependency direction stays
validate → json.

A stylesheet using `schema` match conditions compiled **without** a hook is
compile error JT0006 (the mirror of JQ0008); a hook that rejects a match
schema (throws) is compile error JT0005 (the mirror of JQ0009). Inside
bodies, the query engine's own JQ0008/JQ0009 apply and surface as JT0007
(§10).

---

## 10. Errors

### 10.1 Error objects

Consumers MUST raise compile-time errors as `JsltCompileError` and runtime
errors as `JsltRuntimeError`. Every error carries the same shape as the
query errors:

- `code` — a stable identifier from the registry below;
- `message` — human-readable, non-normative;
- `docPath` — an RFC 6901 JSON Pointer into the **stylesheet document**
  (e.g. `/rules/2/match/path`);
- `cause` — the wrapped underlying error, where the registry says so.

In the bare-array shorthand (§2.1) the document has no `rules` member;
`docPath` pointers then start at the rule index (`/2/match/path`).

### 10.2 Registry

| code | condition |
|---|---|
| JT0001 | stylesheet shape: not array/object, missing `rules`, unknown envelope/mode member, bad `unmatched` value |
| JT0002 | rule shape: not an object, missing `body`, unknown member, `mode`/`priority` of the wrong type |
| JT0003 | match: invalid shape/empty object, path not a valid RFC 9535 query (cause = `JSONPathSyntaxError`) |
| JT0004 | unknown `$jslt` version |
| JT0005 | `schema` match rejected by the hook (cause preserved) |
| JT0006 | `schema` match without a `compileTypeTest` hook |
| JT0007 | body failed to compile — wraps `JsonQueryCompileError`; `docPath` = `/rules/<i>/body` + the inner docPath, `code`/cause preserved on `cause` |
| JT2001 | dispatch depth exceeded `maxDepth` |
| JT2002 | built-in rebuild: an object member's child dispatch produced 2+ items (message carries the location + member name) |
| JT2003 | unmatched value under `"error"` disposition |
| JT2004 | rule body raised a runtime error — wraps `JsonQueryRuntimeError` (cause), message names the rule (`/rules/<i>`) and the node location when known; never double-wraps |

JT0xxx are compile errors (`JsltCompileError`), JT2xxx runtime errors
(`JsltRuntimeError`) — the same numbering convention as JQ0xxx/JQ2xxx.

---

## 11. Correspondence with XSLT (non-normative)

| XSLT | JSLT 0.1 |
|---|---|
| template rule (`xsl:template`) | rule object (§2.2) |
| `match` pattern (XPath) | `match.path` (RFC 9535 JSONPath, positional — §3.2) |
| schema-aware `type`/`element(*, T)` tests | `match.schema` (JSON Schema literal — §3.3) |
| `mode` | `mode` (§7) |
| `priority` + default-priority table | `priority` + the three-row default table (§4) |
| `xsl:apply-templates select="…" mode="…"` | `{"$apply": [selector, mode]}` (§6) |
| sequence constructor | rule body = Jaren JSON Query document |
| built-in rules / `on-no-match` | `unmatched` disposition per mode (§5) |
| `xsl:param` / `xsl:with-param` | stylesheet parameters = query externals (§8) |

Deliberate deviations, gathered:

1. **Per-value semantics, not on-no-match copy modes** (§5.2): rules apply
   at every depth; `unmatched` only picks the between-matches behavior.
   There is no deep-copy default.
2. **Static mode default** (§6.5): an omitted `$apply` mode targets the
   rule's own mode (XSLT 3.0's `#current`), not the unnamed mode.
3. **The `[]` idiom** (§6.3): sequences compose under JSON constructor
   rules; there is no implicit "children become content" as in XML tree
   construction.
4. **No imports, no named templates, no stylesheet functions in 0.1** — all
   roadmap. A stylesheet is one document; rule order and priority are the
   only composition tools.
5. **A schema is a pattern** (the prelude's thesis): where XSLT 2.0 needed
   schema-aware processors and typed-value ceremony to let patterns see
   types, here the match condition and the type condition are the same
   kind of object, compiled by the same hook.

---

## 12. API note (non-normative)

```
compileJsltStylesheet(doc, options) -> transform
  transform(data, externals?)   // plain JSON out
  transform.externals           // user parameter names (§8.3)
  transform.doc                 // deeply frozen copy of the stylesheet
transformJson(stylesheet, data, externals?, options?) // one-shot, WeakMap-cached
```

Module: `@jarenjs/json/jslt`. `transform` returns plain JSON with the query
API's sequence mapping: `undefined` for the empty sequence, the item itself
for a singleton, an array of items for a longer sequence. `options` carries
`compileTypeTest` (§9) and `maxDepth` (§5.4), both for
`compileJsltStylesheet` and as the optional fourth argument of
`transformJson`. The one-shot function is the counterpart of `queryJson`,
caching compiled stylesheets by document identity and compile-option
values in a WeakMap.

## 13. Registered operators (host opt-in, non-normative)

The operator vocabulary (QUERY-FORMAT §8) is **closed** — a document
using `$npv` fails `JQ0002` exactly as one using `$frobnicate` does. A
host can EXTEND it, the way `@jarenjs/validate` gains formats from
`@jarenjs/formats`: compose packs of pure functions into a registry and
compile against it. The published format is unchanged; the extension
lives entirely in the caller's compile options.

```js
import { createJsltRegistry, mathPack, financePack, statsPack }
  from '@jarenjs/json/jslt';

const jslt = createJsltRegistry().use(mathPack).use(financePack).use(statsPack);
const transform = jslt.compile(stylesheet);   // bound compileJsltStylesheet
const q = jslt.compileQuery(queryDocument);    // bound compileJsonQuery
jslt.names();                                  // every registered name
jslt.toOptions();                              // { extensions, functions }
```

`createJsltRegistry()` is **immutable-by-copy**: `.use(pack)` returns a
new registry (a value, not a mutable singleton), and a name that collides
with the core vocabulary or a name already registered throws a
`TypeError` at `.use()` — a host programming error, never a `JQ`
document error.

A **pack** is plain data — `{ name, entries }` — wrapping pure functions,
free of the operator internals. Each entry declares a **kind**:

- **`op`** — a scalar `$`-operator over scalar operands (`$sqrt`,
  `$pow`). An empty operand propagates to an empty result.
- **`agg`** — an operator whose declared `seq` operands are FOLDED to
  arrays before the call, then the pure function runs and its result is
  wrapped: a number as one item, an array under a `seq<number>` result as
  a SEQUENCE (which packs into a JSON array with `[...]`, the same rule
  `$range` follows). This is core `$sum`'s fold generalized, so
  `{ "$npv": ["$.rate", "$.cashflows[*]"] }` computes the present value
  of a filtered cashflow series. `sum`/`min`/`max`/`avg`/`count` are
  already core operators and are NOT re-registered.
- **`fn`** — a bare `$call` function, the low-level escape.

**Purity is required.** A pack function must be a pure deterministic
function of its arguments (no clock, randomness, or changing closure) —
the same discipline `$call` and `$orderby`'s collations demand. A
throwing function surfaces as the coded runtime error `JQ2010`, never a
crash; a function returning `NaN`/`null` is the caller's data problem.

The built-in packs wrap `@jarenjs/core`: `mathPack` (`$sqrt`, `$pow`,
`$hypot`, trigonometry, logs — scalar ops), `financePack` (`$npv`,
`$irr`, `$mirr`, `$fv`/`$pv`/`$pmt`, `$sma`/`$ema`/`$wma`/`$rsi`,
`$volatility`/`$sharpe`/`$maxDrawdown` — aggregators over a series), and
`statsPack` (`$mean`, `$median`, `$variance`, `$stddev`, `$percentile`).
Because a registry compiles both stylesheets and bare query documents,
registered operators also work through `@jarenjs/linq` over an in-memory
source. Against `@jarenjs/db` a store opens with `openStore(model, {
operators })`: every registered operator runs **correctly** in the query
residual (JS over the fetched rows, named by `explain()`), and the
`pushable:'scalar'` subset (the math ops) is additionally pushed into
SQLite as deterministic UDFs where the driver allows (`node:sqlite` yes;
`bun:sqlite` stays the residual). See MODEL-FORMAT §8.1–8.2.

---

## Appendix A. Worked examples (normative fixtures)

Every example is complete and destined to run verbatim as engine tests and
schema fixtures. Unless noted, the disposition is the default `share` and
the mode is the unnamed mode.

### A.1 The empty stylesheet is the identity transform

```json
[]
```

Input:

```json
{ "store": { "book": [ { "title": "Sayings of the Century", "price": 8.95 } ] } }
```

Output: the input document — not a copy: `output === input` (§5.1).

### A.2 Surgical override — VAT on every price

```json
[ { "match": "$..price", "body": { "$mul": ["$", 1.21] } } ]
```

Input:

```json
{ "catalog": { "book": [ { "title": "A", "price": 10 }, { "title": "B", "price": 20 } ] },
  "meta": { "publisher": { "name": "N" } } }
```

Output:

```json
{ "catalog": { "book": [ { "title": "A", "price": 12.1 }, { "title": "B", "price": 24.2 } ] },
  "meta": { "publisher": { "name": "N" } } }
```

One rule, applied at every depth the path selects; every container on the
way is rebuilt by the built-in rule. Sharing is asserted: `output.meta ===
input.meta` — the untouched subtree is the input's own object (§5.1, §5.3).

### A.3 The book example, done right

```json
{ "$jslt": "0.1",
  "rules": [
    { "match": { "schema": { "type": "object", "required": ["isbn"] } },
      "body": { "title": "$.title",
                "children": [ { "$apply": "$.chapters[*]" } ] } },
    { "match": { "schema": { "type": "object", "required": ["heading"] } },
      "body": { "name": "$.heading" } }
  ] }
```

Input:

```json
{ "isbn": "0-553-21311-3", "title": "Moby Dick",
  "chapters": [ { "heading": "Loomings" }, { "heading": "The Carpet-Bag" } ] }
```

Output:

```json
{ "title": "Moby Dick",
  "children": [ { "name": "Loomings" }, { "name": "The Carpet-Bag" } ] }
```

The schema match fires on the root (shape, not position); `$apply`
dispatches each chapter, and the chapter rule fires on shape again. Note
the `[]` around the `$apply` — without it, this stylesheet is JQ2001 at
runtime, because two chapter results cannot occupy one member (§6.3).

### A.4 Two modes: table of contents + body rendering

```json
{ "$jslt": "0.1",
  "rules": [
    { "match": "$",
      "body": { "toc":  [ { "$apply": ["$.sections[*]", "toc"] } ],
                "body": [ { "$apply": ["$.sections[*]", "render"] } ] } },
    { "mode": "toc", "match": "$.sections[*]",
      "body": { "ref": "$.id", "label": "$.heading" } },
    { "mode": "render", "match": "$.sections[*]",
      "body": { "anchor": "$.id", "heading": "$.heading", "text": "$.text" } }
  ] }
```

Input:

```json
{ "title": "Guide",
  "sections": [
    { "id": "intro", "heading": "Introduction", "text": "Start here." },
    { "id": "usage", "heading": "Usage", "text": "Then this." }
  ] }
```

Output:

```json
{ "toc":  [ { "ref": "intro", "label": "Introduction" },
            { "ref": "usage", "label": "Usage" } ],
  "body": [ { "anchor": "intro", "heading": "Introduction", "text": "Start here." },
            { "anchor": "usage", "heading": "Usage", "text": "Then this." } ] }
```

The same sections are walked twice — once per mode, each with its own rule
chain (§7). The selectors are `$`-rooted paths, so the section values carry
locations and match the path rules (§6.4).

### A.5 `fresh` — an annotated copy the caller may mutate

```json
{ "$jslt": "0.1",
  "unmatched": "fresh",
  "rules": [
    { "match": { "schema": { "type": "object", "required": ["price"] } },
      "body": { "title": "$.title", "price": "$.price",
                "taxed": { "$mul": ["$.price", 1.21] } } }
  ] }
```

Input:

```json
{ "products": [ { "title": "A", "price": 10 } ] }
```

Output:

```json
{ "products": [ { "title": "A", "price": 10, "taxed": 12.1 } ] }
```

The schema rule rebuilds each priced object with an extra member; the
`fresh` disposition makes the built-in rule rebuild the surrounding
containers too (`output !== input`, `output.products !== input.products`),
so the caller owns the result tree — the forms/view-model case (§5.1).

### A.6 `error` — exhaustive dispatch with an explicit fallback

```json
{ "$jslt": "0.1",
  "unmatched": "error",
  "rules": [
    { "match": "$", "body": [ { "$apply": "$.events[*]" } ] },
    { "match": { "schema": { "type": "object", "required": ["error"] } },
      "body": { "level": "fatal", "message": "$.error" } },
    { "match": { "schema": { "type": "object", "required": ["info"] } },
      "body": { "level": "note", "message": "$.info" } },
    { "body": { "level": "unknown" } }
  ] }
```

Input:

```json
{ "events": [ { "info": "started" }, { "error": "disk full" }, { "beep": true } ] }
```

Output:

```json
[ { "level": "note", "message": "started" },
  { "level": "fatal", "message": "disk full" },
  { "level": "unknown" } ]
```

Under `"error"`, nothing passes silently: remove the unconditional fallback
rule (default priority `-1`, §4) and the same input raises JT2003 at
`$['events'][2]`. With it, unexpected shapes flow to an explicit default.

### A.7 Parameters and the reserved externals

```json
[ { "match": "$..price",
    "body": { "amount": { "$mul": ["$", "$rate"] },
              "currency": "$root.currency",
              "at": "$path" } } ]
```

Called as `transform(input, { rate: 1.21 })`; `transform.externals` is
`["rate"]` — `root` and `path` are engine-bound and excluded (§8).

Input:

```json
{ "currency": "EUR", "items": [ { "sku": "a1", "price": 10 } ] }
```

Output:

```json
{ "currency": "EUR",
  "items": [ { "sku": "a1",
               "price": { "amount": 12.1, "currency": "EUR",
                          "at": "$['items'][0]['price']" } } ] }
```

`$rate` is a stylesheet parameter (§8.1); `$root.currency` reads the input
root from a deep rule; `$path` is the matched value's normalized path
(§8.2). Calling `transform(input)` without `rate` raises JT2004 wrapping
the body's JQ2006.

---

## Appendix B. LLM structured output (non-normative)

The complete stylesheet language is published as JSON Schema twins:

- [`../schemas/jaren-jslt.schema.json`](../schemas/jaren-jslt.schema.json) —
  canonical draft 2020-12, `$id`
  `https://jarenjs.dev/schemas/jaren-jslt/0.1`;
- [`../schemas/jaren-jslt.draft-07.schema.json`](../schemas/jaren-jslt.draft-07.schema.json) —
  the mechanically derived draft-07 twin.

This extends the query format's
[structured-output story](./QUERY-FORMAT.md#appendix-b-llm-structured-output-non-normative)
to complete stylesheets. Constrained decoding against either artifact can
prevent unknown envelope/rule members, missing bodies, malformed match
objects, bad dispositions and versions, unknown body operators, and wrong
structurally expressible `$apply` arities before any compiler runs.

The rule-body grammar is not a hand-maintained copy. The canonical
stylesheet artifact deep-copies the committed query artifact's definition
map, adds the single body-local `applyPhrase`, and appends that phrase to
`objectExpression.oneOf`. Tests pin that derivation and separately pin the
canonical-to-draft-07 transform. A query-schema refactor therefore fails
the artifact test loudly instead of letting the stylesheet grammar drift;
the published query artifacts themselves remain unchanged.

As with generated queries, schema-valid does not mean semantically complete.
The compiler remains authoritative for rule ranking, reserved externals,
type-test hook availability and schema compilation, plus the positional
fact that the second item of `{"$apply": [selector, mode]}` is a literal
string. That last fact cannot be represented without tuple validation,
which the draft-neutral artifact policy deliberately excludes. The
remaining failures are the JT0xxx/JT2xxx errors of §10, carrying a
`docPath` into the stylesheet for a repair loop.

Provider "structured output" implementations also support different JSON
Schema subsets regardless of the draft they advertise. In particular,
recursive references, `patternProperties`, `propertyNames`, `format`, and
some composition keywords may be restricted or treated as annotations.
Always validate a generated stylesheet locally against the full artifact
before calling `compileJsltStylesheet`.

For those strict subsets a third artifact ships,
[`../schemas/jaren-jslt.llm-profile.schema.json`](../schemas/jaren-jslt.llm-profile.schema.json)
(`$id` `https://jarenjs.dev/schemas/jaren-jslt/0.1/llm-profile`): a
mechanically derived, pure *relaxation* of the canonical artifact.
`patternProperties`, `propertyNames` and asserted `format`s are removed —
each restated in the nearest `description`, which the model still reads —
and every `oneOf` becomes `anyOf`. The guarantee runs one way only: every
canonical-valid stylesheet validates under the profile, the reverse is
deliberately *not* guaranteed. The profile is what you hand the provider's
constrained decoder; the canonical artifact remains the authority, so the
local validate-then-compile step above stays mandatory.

Stylesheets remain ordinary JSON throughout the toolchain: they can be
function-call arguments, retrieved rule sets, reviewed diffs, audit-log
entries, and replayable transformation programs without a text parser.
