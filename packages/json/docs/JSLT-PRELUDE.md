# JSLT Prelude — a template layer over Jaren JSON Query

**Status: design prelude, superseded; implemented by the
[`jslt` module](../src/jslt/) under the contract in
[JSLT-FORMAT.md](./JSLT-FORMAT.md).**
This document is kept as design history: it recorded the design direction
for the JSLT layer so that the decisions taken in the query engine and its
type system (QUERY-FORMAT.md §6.8, §8.11) could be judged against what they
must eventually carry. Names, operator spellings, and section numbers here
were provisional; JSLT-FORMAT.md §1.4 lists where the final calls differ.
For the JSLT layer, JSLT-FORMAT.md is authoritative.

## 1. Thesis

XSLT's enduring idea is *declarative dispatch*: a stylesheet is a set of
template rules, each saying "when you meet a node shaped like this, produce
that", and a recursive `apply-templates` engine does the walking. Its
enduring pain is that "shaped like this" (XPath patterns) and "typed like
this" (XML Schema) are two disjoint languages bolted together, with a third
(XSLT's own instruction vocabulary) for the output side.

The Jaren stack can collapse all three into vocabularies it already has:

- **matching** — RFC 9535 JSONPath, already compiled by this package;
- **typing** — JSON Schema, already compiled by `@jarenjs/validate` and
  already embedded in query documents through the `compileTypeTest` hook
  (`$valid`/`$assert`/`$as`);
- **producing** — the Jaren JSON Query language itself, whose documents are
  JSON values the way XSLT stylesheets are XML documents.

A JSLT stylesheet is therefore **one JSON document, compiled by one stack**,
where a template's *match* condition and its *type* condition are the same
kind of object. That is the "better than XSLT/XSD" claim in one sentence:
XSLT 2.0 needed `schema-aware` processors and `typed value` ceremony to let
patterns see types; here a schema *is* a pattern.

## 2. The stylesheet document

A stylesheet is a JSON document holding an **ordered list of template
rules**. Each rule is an object of the shape

- `match` — what the rule fires on. Either a JSONPath string (structural
  position: "any node selected by this path"), a JSON Schema under a
  `$schema-match` wrapper (shape: "any value valid against this schema"), or
  both — position *and* shape must hold. The schema is compiled once through
  the same `compileTypeTest` hook the query engine uses; match testing is a
  hot-path boolean closure, exactly like `$valid`.
- `mode` (optional) — a name partitioning the rule set, as in XSLT: the
  same input walked twice for a table of contents and for body rendering.
- `priority` (optional) — a number for explicit conflict resolution.
- `body` — a Jaren JSON Query expression producing the output for the
  matched value. Inside the body, the matched value is the query input `$`
  (no context-item drift, per the query spec), and an `$apply` operator
  recurses.

Illustrative sketch (spellings provisional):

```json
[ { "match": { "$schema-match": { "type": "object", "required": ["isbn"] } },
    "body": { "title": "$.title", "children": { "$apply": "$.chapters[*]" } } },
  { "match": "$..price", "body": { "$mul": ["$", 1.21] } } ]
```

## 3. `$apply` — the apply-templates operator

`{"$apply": selector}` (optionally with a `mode`) evaluates the selector,
then, for each resulting item, finds the highest-ranking matching rule and
evaluates its body with that item as the new input; results concatenate as
an ordinary sequence. It is the XSLT `apply-templates` instruction, and like
it, `$apply` is what turns a rule list from a big `switch` into a recursive
transformation engine: bodies do not know or care what the children look
like — the dispatcher re-decides per child.

**Conflict resolution** (the intuition, not yet the algorithm): explicit
`priority` wins first; then **schema specificity** — a rule whose schema
states more about the value (a `required` member list over a bare
`"type": "object"`, a `const` over an `enum` over a type) beats a vaguer
one, the analogue of XSLT's pattern-specificity defaults; document order
breaks the remaining ties, later rules winning so that user rules appended
after a library's override it. Quantifying "states more" is an open design
task (§6) — XSLT's numeric default-priority table is the cautionary tale to
beat.

## 4. Identity and default rules; copy depth

XSLT ships built-in rules that make the empty stylesheet a useful program;
JSLT should too. Two dispositions cover the useful defaults:

- **deep-copy** (identity): an unmatched value is copied verbatim,
  subtree and all. The empty stylesheet is the identity transform; each
  added rule is a surgical override — the "modify one field in a deep
  document" use case that motivates most template engines.
- **shallow-copy**: an unmatched container is rebuilt (object member by
  member, array element by element) with `$apply` recursing into each
  child, so deeper rules still fire inside otherwise-untouched regions.
  This is XSLT 3.0's `on-no-match="shallow-copy"`, and is the right default
  *mode* for annotate-in-place transformations.

Which disposition applies should be a per-stylesheet (or per-mode)
declaration, not a per-rule one.

## 5. Compilation model

Nothing new is needed at the bottom of the stack; the layer compiles to the
machinery this package already exposes:

- Every `match` path compiles through the existing segment engine; every
  `$schema-match` compiles once through `compileTypeTest` — the stylesheet
  compiler takes the same `options.compileTypeTest` hook as
  `compileJsonQuery` and stays validator-agnostic, preserving the
  dependency direction (validate → json, never the reverse).
- Every `body` compiles with `compileJsonQuery`; `$apply` is the only new
  operator, and it closes over the compiled dispatch table.
- Dispatch itself is a compiled closure chain: rules partition by mode at
  compile time, and within a mode the match tests run in rank order —
  cheap structural discriminators (type tags, required members) can be
  hoisted into a pre-filter the way the query compiler specializes
  singletons today.

## 6. Non-goals of this prelude, and open questions

Out of scope for the prelude (deliberately unresolved):

- **Streaming.** XSLT 3.0's streamability rules are a research program of
  their own; the query engine materializes sequences, and JSLT inherits
  that. Revisit only with the lazy-iteration roadmap item.
- **Modes vs functions.** Whether modes stay (XSLT experience says they are
  indispensable) or collapse into named, parameterized rule sets — i.e.
  whether JSLT grows function values before the query language does.
- **Vocabulary placement.** Whether `$apply` belongs in the core query
  operator registry (making every query document potentially a template
  body) or in a separate `jslt` module that layers its own phrase shapes —
  current lean: a separate module, keeping the query language's closed
  vocabulary small and the format schema honest.
- **Rule-set schema.** The stylesheet document needs its own published JSON
  Schema twin-set, like the query format's, so LLM structured output can
  emit stylesheets too (QUERY-FORMAT.md appendix B applies verbatim).
- **Schema-aware static optimization** — the delicious one. A compiled
  match schema is knowledge: if the input's own schema proves a rule can
  never fire in a mode, drop it from that dispatch chain; if it proves a
  path selects at most one node, the dispatcher gets the singleton fast
  path. The cardinality analysis in the query compiler is the seed of this.

## 7. Position in the roadmap

The intended consumers, in order:

1. **`@jarenjs/forms`** — computed views: form state is a JSON document,
   view models are transformations of it, and template dispatch on schema
   shape is exactly how a form renderer picks widgets. The stylesheet
   compiled-closure model matches the package's compile-once philosophy.
2. **`@jarenjs/jslt`** — the eventual standalone package: stylesheet
   compiler, `$apply` dispatcher, default-rule library, its own docs and
   schema artifacts, with this package and `@jarenjs/validate` as peers.

The groundwork this prelude assumed — schema literals inside query
documents, the compile-time `compileTypeTest` hook, per-item validation
semantics — has since shipped in the query engine; the next concrete step
is the `$apply` dispatch prototype behind a `jslt` module boundary.
