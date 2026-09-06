# 📅 Jaren Roadmap

```
My manager tried to open that door before,
but it apparently was scheduled for the next release.
```

This is the single roadmap for the whole monorepo: the remaining release
milestones and the open work per package.

**It lists only what is still open.** When an item ships, its knowledge moves
into the document a reader would actually reach for — the package `README`, its
`ARCHITECTURE.md`, the format spec under `docs/` — and the entry leaves this
file. Nothing is summarized here twice. The record of *when* something shipped
is the git history and the release tags; what a shipped thing *does* is its
documentation's job. Keeping that rule is what stops this file turning back into
a changelog nobody reads to the end of.

Each entry states a problem and the constraint that makes it hard, in one
paragraph. An entry that no longer matches the code is a bug in this file —
delete it or fix it.

## Release milestones

- **1.0 stable** — no milestone-level blockers remain; 1.0 is gated on the
  per-package items below rather than on any one feature.
- **1.1**
  - [ ] [propertyDependencies](https://github.com/json-schema-org/json-schema-spec/blob/main/proposals/propertyDependencies.md) proposal
  - [ ] JSON Schema standard output formats (`list`/`hierarchical` wrappers, `evaluationPath`/`schemaLocation` renames) — the remaining half of [Fixing JSON Schema output](https://json-schema.org/blog/posts/fixing-json-schema-output); the structured params + keyed messages are exactly what that format wants
- **1.2**
  - [ ] compileAsync for asynchronous schema loading
  - [ ] JSON.parse reviver / JSON.stringify replacer integration

## @jarenjs/json — JSONPath & addressing

*The current focus.* JSON Pointer (RFC 6901), the JSONPath engine
(RFC 9535, passing the complete official compliance suite), JSON Patch
(RFC 6902) and Merge Patch (RFC 7396). See
[`packages/json/ARCHITECTURE.md`](../packages/json/ARCHITECTURE.md).

- [ ] **Relative pointer index manipulation (`0+1`, `1-1`)** — added by
  draft-bhutton-relative-json-pointer-00 and not accepted by the parser. Jaren
  is conformant to draft-handrews-01, the revision JSON Schema 2020-12
  normatively references, and the official format suite still asserts
  `+1/foo/bar` **invalid** — so this cannot be implemented alone: it needs a
  dialect gate so the `relative-json-pointer` format tester keeps rejecting it
  until the suite moves. `test/json/pointer-format.test.js` pins the current
  answer and is what should fail first when that happens.
- [ ] **Give the relative resolver the ancestor the caller already has** — the
  one remaining structural inefficiency in addressing, and the only lead that
  survived measurement. `compileRelativeJSONPointer` receives `(dataRoot,
  dataPath)` and re-walks the location *string* from the root on every call,
  re-scanning and re-slicing segments the validator had in hand when it
  descended there. Four cheaper fixes were measured and rejected: a
  prototype-guarded read instead of `Object.hasOwn` (faster in isolation,
  **slower** in the real polymorphic walk), per-segment closure chains (slower),
  caching the parsed location path (2.3× on repeat but **2× worse** when the
  path varies, which is the array-iteration case that matters), and flattening
  cons-string paths (no effect). What is left is an API that lets a caller pass
  the ancestor value directly, which means threading it through the validator's
  descent — real blast radius, so it wants deciding before doing. Note this
  would not help JSLT or JTLT: they use `segments.js` for runtime addressing and
  touch `pointer.js` only for compile-time error paths.
- [ ] **Optional codegen backend** — compile hot queries to source via
  `new Function` where CSP allows, reusing the same frozen AST and semantics, with
  the closure compiler staying the default. The no-`eval` rule is absolute in this
  package today, which is the guarantee this must not quietly cost.

## @jarenjs/json — query engine & language

- [ ] **Materializing `$range` still meets the heap before the guard** —
  iterating a range no longer materializes it (`$for` and quantifiers over a
  static `$range` compile to counting loops), so the shape the QT3
  resource-bomb skips exercised is fixed. A range that is genuinely
  materialized — bound by `$let`, handed to an aggregate — still has only the
  2³² `JQ2007` ceiling, which no heap survives; `options.limits.sequenceItems`
  tightens it deterministically, and a lower default would be a spec change
  to §10.3 rather than an implementation choice.
- [ ] **Function *values*** — `$fold` (§6.9) gave the language its fold, and
  it turned out not to need function values at all: the accumulator is a
  binding, so map/filter/fold shapes are all FLWOR. What is still missing is
  passing a *rule* to an operator — a comparator to `$sort`, a projection to
  a hypothetical `$map-seq`. `$call` covers host functions over scalars; a
  first-class function value would need an encoding the JSON surface
  deliberately does not have.

## @jarenjs/json — JSLT

- [ ] **JSLT matcher optimizer (single-walk)** — replace per-rule path pre-passes with a single multi-pattern walk, specialize location tracking by reachable modes, and use input-schema knowledge to prune impossible shape rules. The benchmark quantifies the gap: dense pure-path transforms pay ~9–12× over the raw path scan, and hand-written native JS stays 3–139× faster on real transformations — this is the main JSLT performance workstream.
- [ ] **Prepass-level pruning in the JSLT matcher** — skip re-evaluating match *paths* over unchanged regions using the changed-path feed directly, rather than discovering the reuse afterwards through the memo cache. The remaining O(change) idea now that the memo layers have shipped.
- [ ] **Standalone `@jarenjs/jslt` package** — publish the stylesheet layer as its own package only when the query-engine internals it needs have a deliberate public boundary; today the module stays colocated to avoid exposing compiler internals.
- [ ] **Bare `$`/`$root` `$apply` selectors and locations** — a bare root selector currently dispatches location-less; JSLT-FORMAT §6.4 ("path rooted at") arguably includes the zero-segment path. Clarify the spec or carry the location.
- [ ] **`$apply` mode-argument typing in the schema twins** — the draft-neutral subset forbids tuple validation, so a non-string mode in the two-item `$apply` array is compiler-rejected (JT0007) but schema-accepted. Changing this means abandoning the mechanical twin transform or changing the language encoding; documented in JSLT-FORMAT Appendix B.

## @jarenjs/json — XQuery front-end & QT3

- [ ] **`xs:*` constructor casts and more `fn:*` mappings** — the QT3 scorecard attributes the bulk of its 21k `unsupported-syntax` cases to the function library, not the language; a handful of numeric/string casts plus `fn:tokenize` moves thousands of cases into the measurable buckets.
- [ ] **Exact sequence-base lookups** — lookups on non-variable bases emit `$get`, which addresses a single item; a `$let`-wrapper emission would reproduce XQuery's per-item lookup exactly, and is the v2 candidate alongside the `!` simple-map and `=>` arrow operators.
- [ ] **1-based positional *outputs*** — `at`/`count`/`fn:index-of` surface the format's 0-based D6 values, so QT3 asserts them as wrong-value; `fn:index-of` has a cheap local emission fix, `at`/`count` would need reference rewriting. Revisit if the scorecard noise starts to matter.
- [ ] **Front-end diagnostic polish** — a bare NameTest colliding with a keyword (`let`, `order`, ...) raises `unexpected keyword` instead of `unsupported construct 'path expression'`; `=>` after a comparison RHS raises a generic error. Deliberate-diagnostic spots, baselined as known bugs in the QT3 harness.

## @jarenjs/validate

- [ ] **Two `$dynamicRef` cases fail in 2020-12** — the official suite's
  `dynamicRef.json` has two groups Jaren does not satisfy: *"A `$dynamicRef`
  that initially resolves to a schema with a matching `$dynamicAnchor`
  resolves to the first `$dynamicAnchor` in the dynamic scope"* (1 of 2
  assertions) and *"after leaving a dynamic scope, it is not used by a
  `$dynamicRef`"* (2 of 3). Both sit where the dynamic scope must be
  *unwound*: the resolver keeps an anchor visible after the scope that
  introduced it has been left. They went unseen because Ajv errors on the
  same two groups (`"$dynamicRef" only supports hash fragment reference`)
  and the conformance count dropped every test the rival could not compile
  — each engine is now scored over the tests it ran, so the suite reports
  them.

- [ ] **Per-scope static evaluated-set analysis for `unevaluated*`** — the shipped
  sibling-coverage elision compiles away the checks that are statically
  unreachable, but the genuinely dynamic cases — nested `unevaluated*`, cousin
  schemas, annotations flowing across `$ref`/in-place applicators — still pay the
  runtime evaluation log and its linear scans, and sit well behind Ajv's
  compile-time evaluated-set tracking. Computing a static evaluated set per schema
  scope (with a small dynamic remainder only where refs make it unknowable) is the
  main remaining validator performance workstream.
- [ ] **Optional codegen backend for nano-schemas** — closure-compiled validators bottom out around 5× Ajv's generated code on trivial schemas (a two-branch `allOf` runs ~90 ns vs ~15 ns), which is the price of the CSP-safe no-`new Function` rule. Mirroring the query engine's codegen-backend idea — same compile pipeline, a codegen emitter where CSP allows, closures as the default — would close the floor without giving up the guarantee.
- [ ] **Collected errors inside `allOf` branches** — `allOf` is not
  speculative (every branch must hold), so its branch errors are kept, which
  is right. What is still coarse is that a branch failing deep inside reports
  both its own fault and the `allOf` wrapper error; a consumer wanting one
  issue per fault has to filter the wrapper. The applicator-level rollback
  shape added for `anyOf`/`oneOf`/`not`/`if`/`contains` is the tool if this
  ever needs finer treatment.
- [ ] **Unprefixed `query` alias / vocabulary registration** — register `$query` through a custom vocabulary and meta-schema (json-everything style) instead of only as an extension keyword.
- [ ] **Cross-root compile memo for registered schemas** — a *registered* schema whose `$query` literal `$ref`s that same registration compiles a fresh root per hook invocation and can recurse at `compile()` time; a cross-root memo would close this compile-time foot-gun.
- [ ] **Finer `$query`/`$data` feature scan** — the compile-time scan is conservative: any schema in the compilation map containing `$query` (or `$data`) turns on instance-path building for the whole root.
- [ ] **Normalizer edges** — a selected rest coercion can reach unselected
  `prefixItems` positions; a root `default` is cloned but not passed through the
  root's own normalization step; an own property explicitly set to `undefined`
  suppresses its default and stays `undefined`; and a `default` reachable only
  behind a local `$ref` does not materialize an absent property.
- [ ] **Predicate normalization from the CLI** — `--defaults`/`--coerce` are
  booleans, so the per-node predicate route (`x-trim`, `x-coerce`, `x-default`)
  is programmatic-only; a config-file route would make it usable from the CLI.
- [ ] **`data` next to `$ref` in 2019-09+** — `$query` was added to the `$ref`-sibling keyword list; `data` has the same latent gap and still relies on pre-existing behavior.
- [ ] **ajv-style `errorMessage` `properties`/`items` map forms** — only if demand appears; the subtree prefix rule already covers what they express.
- [ ] **Relative-pointer `${...}` interpolation in message templates** — ajv-errors-style data interpolation; params already carry the offending values, so this is convenience, not capability.

- [ ] **A scoped QUIRKS pass over the validate/emit triangle is owed, and
  its findings are already reproduced.** A reading of validate, emit and
  the normalizer beside each other returned eighteen findings that no
  campaign since has been allowed to widen into. They are listed here so
  the pass starts from reproductions rather than from a re-reading, and
  they are NOT ordered by severity: `patternProperties` beside a
  schema-valued `additionalProperties` types NARROWER than the document
  admits; the accepted-twin memo is order-dependent under cycles;
  constraints on anonymous nodes are dropped silently; `nullable: true` is
  ignored by emit; `required` away from `properties` is dropped; absolute
  same-document `$ref`s and percent-encoded pointers go unresolved by the
  shared resolver; `$ref` siblings under the default draft; a
  self-`$ref`ing `$query` literal hangs `compile()`; `/re/flags` pattern
  keys diverge between the validator and the normalizer, which is silent
  data loss; `addSchema(s); compile(s)` throws; the emit-model schema
  rejects `extensions`; four MIGRATING-FROM-ZOD rows mislead (`.strict()`,
  `tuple`, the `items` count, `schemaPath`); a hidden `errors` getter sits
  on compiled validators; `validateSchema` defaults to draft-06 while
  `compile` defaults to draft-07; a `$query` literal cannot see the
  enclosing document, beside two message typos; the emit README's outputs
  differ from the tool's; integer coercion rounds above 2^53; and a set of
  dead switches (the `validation` option, a boolean `required`,
  `--suffix`, `--name`, raw stack traces, `enum` with a mismatched
  `type`). One more, found while building the schema pen and worth naming
  separately because it has a working route beside it:
  `JarenValidator.addMetaSchema(<the 2020-12 bundle>)` — the array form
  `@jarenjs/refs` hands out — answers `false` for every schema, and so
  does the 2019-09 bundle; compiling the main document with the
  vocabulary documents registered beside it (`addSchema(vocabularies)
  .compile(main)`) works, and is what this repository's own tests do.
  Each of these is a fix, a documented deviation or a drop; none is a
  widening of a shipped behavior without that decision being made.

## @jarenjs/contract

- [ ] **The app binding's subscription slot passes no `reconnect`** — the
  HTTP client's opt-in reconnect (`subscribe(op, input, { reconnect: {
  max } })`, CONTRACT-FORMAT.md §19) re-establishes a stream after a
  network loss from the last delivered seq, but `contractAppBinding`'s
  `contract-stream` handler calls `client.subscribe` with the callbacks
  only, so a slot that lost its stream is re-entered by the view with a
  fresh `start`. A per-operation `reconnect` on the binding's `subs`
  entry, threaded into that call, is the one-line door; deciding whether
  a slot should reconnect silently or surface the loss first is the
  design question it waits on.
- [ ] **Query-located object members do not survive the HTTP wire** —
  the transport coercion is deliberately scalar-only (query strings,
  form fields), so a `subscribe`/`read` input member typed `object`/
  `array` round-trips over `port`/`local` but arrives as its JSON text
  in a query string over http. Whether the transport should JSON-decode
  a member whose declared type is non-scalar (a D3 extension) is open;
  until then such operations belong on the JSON-framed bindings or key
  their stream by scalars.

## @jarenjs/forms

- [ ] **Stylesheets replacing the JS composition step** — `buildFormViewModel`
  composes the render tree in JS. A stylesheet cannot replace it because
  rendering a form is a **two-cursor walk**: the schema-derived model says what
  a field is, the data says what it holds, and a JSLT rule descends only the
  one input document it matched. Two primitives would each unblock it, and
  **one now exists**: the query engine's `$fold` clause (QUERY-FORMAT §6.9)
  makes walking a runtime pointer a reduce over its segments with `$get`, so
  a rule can reach the data cursor for the node it matched. The alternative,
  **a parameterized `$apply`** carrying a second cursor down with the matched
  node, is still unbuilt. The open work is therefore no longer a language
  question but a stylesheet one: rewrite `buildFormViewModel`'s composition as
  rules that fold to their data cursor, and find out where the fold's
  per-field re-walk costs more than the JS pass it replaces.
- [ ] **Form chrome beyond the two array buttons** — `form/addItem` and
  `form/removeItem` are catalog messages resolved by `formChromeLabels`; the
  `+`/`×` glyphs, the `*` required marker and the `json` editor's affordances
  are still literal. They want a decision about how much of a stylesheet's
  static text belongs in the message keyspace before more keys land in eleven
  packs.

## @jarenjs/view & @jarenjs/app

- [ ] **Real-browser accessibility audit** — the *lifecycle* half of the matrix
  ships (the website's Playwright suite drives the built site through Chromium,
  Firefox and WebKit on every push — see
  [its browser tests](../packages/website/README.md#browser-tests)), and so does
  the `prefers-reduced-motion` half: the site's motion layer is asserted under
  both emulated preferences in all three engines, including that `reduce`
  yields final states on first paint with no animation at all (DESIGN §6/§10).
  What stays untested and unclaimed is the assistive-technology half: dialog
  focus traps and focus restoration under an actual screen reader, and AT
  semantics. APP-FORMAT §8.4/§8.7 state the contracts that audit would have to
  prove.
- [ ] **DOM-adopting hydration & fragment roots** — VIEW-FORMAT §6/§8: adopt server-rendered markup instead of empty-and-rebuild; allow list roots.
- [ ] **First-class awaiting action documents** — the async-task convention and `createTaskEffect` cover the pattern without a format change (`packages/app/docs/TASKS.md`); making *awaiting* expressible in the action document itself is the open half (APP-FORMAT §11).
- [ ] **Safe-mode composition/IME and a real-browser adversarial suite** — the
  safe render profile (VIEW-FORMAT §8) and the controlled-input registry are
  verified against the Node DOM stub, which cannot model an IME composition, a
  live caret, or a browser's URL/style reflection. The open half is a
  Playwright suite that drives create→update→remove→reinsert of the safe
  attack corpus and the controlled/`multiple`-select/composition cases through
  Chromium, Firefox and WebKit, plus composition-aware authoritative writes
  (defer during a composition, settle without losing the caret). Until then
  those behaviors are documented as browser-unproven.
- [ ] **`safe`/`onUnsafe` forwarding through `@jarenjs/app`** — the renderer
  takes a safe profile, but `createApp` does not thread it, and an app document
  additionally names host actions, effects and subscriptions. Forwarding the
  view profile is necessary but not sufficient to run an *untrusted* app
  document; a real answer needs a capability model for what an app document may
  name, so today the safe profile is scoped to the *view* renderer and app
  documents are self-authored only.

## @jarenjs/flow

- [ ] **Statechart vocabulary** — jaren-fsm 0.1 deliberately has no
  hierarchy/compound states, history states, parallel regions or
  delayed/timed transitions (FLOW-FORMAT §1.1 names them as non-goals).
  Revisit when a consumer needs one; hierarchy is the likely first,
  since the mermaid state parser already records a flattened `parent`.
- [ ] **Streaming dag input** — a run is one value in, one value out
  (FLOW-FORMAT §7.5); feeding a graph chunk-by-chunk from the
  `@jarenjs/josl` incremental readers is the natural 0.2 composition,
  and doing it honestly changes the node contract, so it is a format
  revision rather than an option.
- [ ] **A dag node's result carries the query engine's singleton rule,
  and §6 never says so** — QUERY-FORMAT rule 5 identifies a one-item
  sequence with the item, and `compileDag` calls a compiled query with
  its default entry point, so a `query` node whose filter passes exactly
  one row yields THAT ROW where two rows yield an array. FLOW-FORMAT §6
  states only the empty case ("a `query`/`jslt` node whose own result is
  empty yields `null`"), and its own worked example changes shape at one
  row. Reproduction: run §6's document over
  `[{name:'ada',age:36},{name:'kit',age:9},{name:'lin',age:20}]` — the
  `ul` carries two `li`s with names; drop `lin` and the `ul` carries two
  EMPTY `li`s, because the downstream `$[*]` iterated the surviving
  object's values. The fix is a §6 sentence and a worked example that
  cannot be read two ways, or a node-level "always a sequence" option;
  either is a format decision, not a bug fix.
- [ ] **Editor: free-form geometry** — the Flow studio lays out every
  diagram deterministically and connects by click-source-then-target;
  free-form node dragging and *persisted* positions are out of scope for
  0.1 (geometry never enters the document). A `meta.layout` side-table
  would let a user override the auto-layout without polluting the AST —
  the honest place to add it if a consumer asks.
- [ ] **Nothing composes a DAG and an FSM into one workflow.** Task,
  fan-out/fan-in, switch, bounded loop, nested flow and durable wait/resume
  are each expressible today — static regions as `jaren-dag`, dynamic control
  as `jaren-fsm`, effects host-executed with the idempotency key honored by
  the effectful system (FLOW-FORMAT says so) — but a host that needs all six
  in one document has to write the composition and the lowering itself, and
  a third scheduler is the usual result. A small composition layer that
  lowers one neutral document deterministically onto the two engines, with
  trace and checkpoint records referring to the lowered revisions, is the
  generic part; roles, prompts, model profiles, tools and domain state are
  host registries and stay out. The constraint is that this repository has
  no composed workflow of its own to lower — the website assistant and the
  benchmark harness are the candidates — and a lowering layer without a
  deterministic lowering/concurrency/resume test over a real one would be
  the third scheduler with better manners. Built when that consumer exists.

## @jarenjs/md

- [ ] **`meta.hash` costs ~11% of a parse and cannot simply go lazy** — hashing
  the source is a full pass over it, paid by every caller including the ones
  that never read the hash. A getter would fix that and would also make an
  MdDocument stop being plain JSON, which MD-FORMAT §1.1 promises it is; an
  opt-out flag would leave a document carrying a hash that is a lie. Measured
  and left alone deliberately — the honest fix is the `Math.imul` item above,
  which halves it for everyone.

- [ ] **Chunking is text-only; a block sequence has no packer.** `@jarenjs/core/chunk`
  cuts one string by size, line or separator with offsets back into it,
  which is what a tool result or a transcript needs. A document that already
  has structure — the block tree this package parses, or a host's typed
  elements with headings, roles and page boxes — wants deterministic packing
  over an ordered block sequence (a stable id, text, an optional role, a
  hierarchy path, opaque metadata) that preserves order and attribution,
  honors a hard size bound, exposes the overlap it actually produced and
  takes boundary and size policy as injected functions. Nothing in the suite
  consumes such a packer yet; the block tree here is rendered, not retrieved.
  It is built when a suite surface needs it — this package's own tree is the
  first candidate — and not before, so that the shape is fitted to a real
  consumer rather than to a description of one.

## @jarenjs/mermaid

- [ ] **`foreignObject` / `htmlLabels:true`** — labels are SVG `<text>` in v1 because `@jarenjs/view` has no `foreignObject`/`setAttributeNS`; revisit alongside VIEW-FORMAT §6/§8 for HTML labels and pixel-closer parity.
- [ ] **Full layout for the secondary types** — class and ER render as structured panels, not domain-specific layouts; mindmap/gitGraph/journey/timeline parse-accept with a placeholder. Real layouts are the next coverage push (tracked honestly in the benchmark scorecard).
- [ ] **Layout/perf workstream** — dagre-lite handles ranks and straight
  edges; orthogonal edge routing, subgraph clustering and crossing reduction
  are the next levers. Edge labels now measure themselves and step aside from
  one another, so the remaining work here is the routing itself: an edge still
  runs straight from border to border and can cross a node it has nothing to
  do with.
- [ ] **More domain projections** — the geometry-free-AST-as-model idea now ships two executable arrows (`stateDiagram ⇄ jaren-fsm` and `flowchart ⇄ jaren-dag`, both run by `@jarenjs/flow`; MERMAID-FORMAT §5.1); the remaining follow-ups on the same idea are sequence⇄orchestration/saga and ER⇄JSON-Schema+`@jarenjs/forms`.
- [ ] **Diagram tooltips** — pan/zoom/touch ship as the opt-in
  `mermaidPlugin({ interactive: true })` hydrate; per-node tooltips are the
  remaining half, and they need a hover/focus target the pure render does not
  currently mark.
- [ ] **Adopt the shared 3D kernel** — `@jarenjs/calc`'s x·y·z plotter introduced a reusable `@jarenjs/core/math` `mat4`/`project.js` kernel (matrices, projection, `surfaceNormal`, painter's-algorithm depth sort). Mermaid 3D could adopt it rather than growing its own projection math.

## @jarenjs/charts

- [ ] **Sessions for the remaining ten types** — `line`, `bar` and `candlestick` patch in place; the other ten re-render wholesale, which is correct and, at their sizes, cheap. A `heatmap` session (one cell rect per changed count) is the next one with an obvious incremental path now that the accumulator feeds it.
- [ ] **Deeper treemap nesting** — one hierarchy level ships (groups squarify, children squarify under a naming band). Arbitrary depth needs a recursive layout and a header budget that does not eat the leaves.
- [ ] **A sampled line session scans its input twice.** Above the 2,000-point
  default the session rebuilds every frame, and `rebuild()` runs
  `scanLineExtremes` and then lets `buildLineAST` scan the same input again —
  so a 10,000-point time line patches at 3.25 ms against a 2.53 ms wholesale
  render, the one shape where the incremental path is the slower one
  (`sampling: false` restores the 4.44 µs patch exactly, and both rows are
  published in the charts suite). Letting `buildLineAST` accept pre-scanned
  extremes, or having the session read them back off the AST, removes the
  second scan; the session's contract is byte equality with `compileChart` of
  the same data, so whatever is passed forward has to be what the wholesale
  path would have computed.

## @jarenjs/calc

- [ ] **Interactive plots** — drag-to-rotate for x·y·z and pan/zoom for x·y are a `hydrate` enhancement (out of scope for v1; the static SVG render is complete).
- [ ] **Programmer 64-bit precision** — the expression evaluator surfaces programmer-mode results as `Number` (values beyond 2^53 lose precision on read-back); the four-base display already stays exact via `word.js` BigInt. A BigInt-valued evaluation path would close the gap.
- [ ] **More converter dimensions & rate providers** — fuel economy (non-affine) and additional API-key-free tickers; websocket/streaming rates are deliberately out of v1 (REST polling only).

## @jarenjs/play

The engine playground behind `#/play`: pick an engine and an example, edit the
source or the data, it runs live. Membership is a rule rather than a list — an
engine belongs here iff it is a **pure function of `(source, data)`**:
stateless, no worker, no live subscription, no side channel. That is why flow
and the document store are studio file kinds instead, and why adding an engine
costs a descriptor plus examples and no UI code at all.

- [ ] **Engines the rule admits and the registry lacks** — fifteen ship.
  `@jarenjs/linq` (a fluent chain compiles to a query document), `@jarenjs/emit`
  (a schema compiles to TypeScript), JSONX as an *input* dialect rather than
  only an output, and the `@jarenjs/core` kernels the query operators already
  expose (geo, dates, math, text) all satisfy the rule and have no descriptor.
  The streaming readers are the interesting refusal: the JOSL and CSV stream
  parsers are pure, but they consume a stream rather than a string, so a
  descriptor for them first needs a source pane that means "feed this in
  chunks" — a question the `(source, data)` shape does not answer.
- [ ] **JSLT, JTLT and XQuery cannot be given externals** — all three compiled
  functions accept an externals object and play passes none, so `$query` is the
  only engine with an externals pane. XQuery is the sharp case: it binds
  exactly `$doc` and silently drops every other declared external, so a query
  with a second variable cannot run here at all.
- [ ] **The `validate` engine is single-schema** — one schema pane and no
  `addSchema`, so a schema that `$ref`s another by `$id` cannot be demonstrated
  even though the docs teach exactly that. The other surfaces that compile
  schemas register theirs; this one does not.
- [ ] **The example library under-covers the engines it already has** — charts
  ship four of thirteen types, mermaid four of seven laid-out diagrams, and the
  validate engine offers twelve locales while every example pins `en`. Examples
  are data, so each is cheap; what makes the gap worth listing is that it is
  invisible from the page — a reader who sees four chart examples concludes
  there are four charts.
- [ ] **The package documents its view but not its host contract** — play is the
  only component without an `ARCHITECTURE.md`, and the reducer actions, the
  debounced run loop, the session document store and the share codec all live at
  the host, described nowhere. The `play-splitter` widget and the `$.dataForm`
  mount point are host seams the format doc's seam list omits, so a second
  consumer finds them by reading the website's source.

## @jarenjs/studio

The multi-file project IDE behind `#/project`. A `jaren-project` is a thin
envelope over typed files (`app`, `jslt`, `query`, `schema`, `state`, `data`,
`contract`, `fsm`, `dag`, `model`), each validated against its own grammar
rather than one composed mega-schema. Two of those kinds still have no editor
beyond a textarea, which is what the first two entries are about.

- [ ] **`fsm`/`dag`/`model` are validate-only kinds** — `KINDS` lists all ten
  and `validateFile` checks all ten, but these three have no editor, no runner
  and no way in. `deriveStage` returns an inert "edit it as text meanwhile"
  note; `runProjectFile` whitelists `query`/`jslt`/`schema`/`contract` only;
  and four
  independent gates refuse to create one — the add-file `<select>`,
  `ADDABLE_KINDS`, the `SKELETONS` table (a missing skeleton makes
  `project-add` bail silently) and the assistant tool's `kind` enum. Today such
  a file can only enter a project through a hand-written envelope or a share
  token. This is the substance of the next two entries.
- [ ] **The flow editor is not in the studio** — `#/flow` has the palette,
  click-source-then-target connect, the generated inspector form and the live
  run; an `fsm`/`dag` file in a project has a textarea. Moving that editor in
  as a per-kind enhancement is what makes `#/flow` "the studio with a flow file
  active". The constraint is the isolation boundary a hosted file boots
  under — widgets and `compileTypeTest` but **no effects and no
  subscriptions** — so the run pane has to work inside that sandbox rather than
  the website's own runtime.
- [ ] **The `model` kind has no store behind it** — a model file should open a
  live in-browser SQLite store on the worker, with the project's `query` files
  running against it, `explain()` showing the pushdown and a live query
  maintaining as rows commit, exactly as `#/data` does. This is the kind that
  earns per-file validation its keep: a data file is compiled by the WORKER so
  registered operators (`$sqrt`, `$npv`) keep resolving, which means it can
  never be gated by the project's closed grammar. A single whole-project gate
  is therefore not merely unbuilt but undesirable — and the worker is the one
  sanctioned side-effecting host inside an otherwise effect-free sandbox.
- [ ] **Fragment assembly — a file is always a whole document** — `app`, `fsm`,
  `dag` and `model` files each hold one complete document, which is what made
  the migration a move rather than a rewrite. Splitting an app into separate
  view / actions / state files — the real HTML/CSS/JS split, and the reason the
  envelope is deliberately thin — is the assembly model's headline capability
  and has not been built.
- [ ] **The assistant authors files unconstrained** — it can already list, read,
  write and run project files, but a written file arrives as free-form tool
  arguments; `createStructuredOutput` ships and is not wired to this path.
  Doing it honestly means handing the provider exactly ONE file's grammar and
  never the whole project schema, and only `query` and `jslt` have the
  `.llm-profile` relaxations that make a schema decodable
  (`packages/json/schemas/jaren-{query,jslt}.llm-profile.schema.json`).
  `app`/`fsm`/`dag`/`model` would each need a profile derived, or would have to
  accept the canonical schema with its unresolved-`$ref` limitation stated.
- [ ] **There is no whole-project takeaway** — `project/download` emits the
  designated `app` file's document as one JSON file, so every query, jslt,
  schema and data sibling is dropped, and a project with no `app` file at all
  (three of the shipped templates) downloads nothing and says nothing. That
  gap has a second edge: a project whose share token exceeds the 8000-character
  limit is honestly refused a link and told to "use Download instead" — advice
  Download cannot currently fulfil. The intended answer is a `.zip` eject: the
  project as a folder that runs offline, every file under a sane name plus a
  small host page and a README. The one real decision it needs is how the
  ejected host reaches `@jarenjs/*` — bundled, or a pinned CDN — which has to
  be chosen and written down rather than defaulted into.
- [ ] **The stage swallows a nested app's own failures** — `project/stage-error`
  is dispatched from three places in the stage widget, reduced into
  `project.stageError`, and never read by any view, so an app that throws at
  boot or at runtime shows the user nothing. A real console is out of the
  question by construction: nested documents get widgets but no effects and no
  subscriptions, and capturing `console.*` would breach exactly that isolation.
  The substitute the design calls for is a boot-log / last-error panel fed by
  the state that is already being collected.
- [ ] **Two `layout` knobs the IDE does not honour** — `autorun` is in the
  schema, in PROJECT-FORMAT and in `LAYOUT_DEFAULT`, and no code reads it:
  there is no toggle and the debounced commit loop always runs, so the format
  promises a switch the document cannot actually throw. Either honour it or
  drop it. Separately, the drag splitter is horizontal, so `data-mode="top"`
  hides it and the stacked layout cannot be resized at all.
- [ ] **No syntax highlighting** — the editor is a plain `<textarea>` here and
  in `@jarenjs/play`. The two ways to add it — a `contenteditable` surface, or
  a mirrored `<pre>` behind a transparent textarea — both fight the
  controlled-input contract the typing buffer exists to protect (a render
  landing mid-edit must not move the caret or eat a keystroke), and neither may
  reintroduce `innerHTML`. That trade is the reason this is not simply a
  styling job.

## @jarenjs/josl

- [ ] **CSV header-keyed objects against a codegen parser** — `udsv` reads
  the 10k record stream to objects in ~1.6 ms against the CSV reader's
  ~3.2 ms, because it compiles a parser per schema with `new Function` and
  builds each record object with literal keys the engine can inline-cache.
  String-array rows are now within ~1.3× (cell ends come from cached
  `indexOf` cursors instead of a per-character scan), so the remaining gap
  is concentrated in the object build per record — a computed-key store per
  cell. The no-codegen rule is absolute in this package, so closing it
  means finding a closure-compiled shape for record construction. This is
  the same trade the validator and query engine record under their own
  codegen-backend items.
- [ ] **Streaming CST** — `parseJoslCst` records source spans, which only
  the whole-document driver produces; the cutter has the same slices in
  hand but reports them per cut line, without the terminator. Rewriting a
  document implies having all of it, so this waits for a consumer that
  genuinely edits a stream.

## @jarenjs/linq & @jarenjs/db — the data pair

The fluent front door and the SQLite document store shipped as a pair;
what each does is its own documentation's job
([linq](../packages/linq/README.md) ·
[db](../packages/db/README.md)). What remains open:

- [ ] **Pushdown promotions.** A general `$groupby` over a collection,
  a projection TREE (`$return` objects and arrays of member paths) and
  an N-way equi-join graph all lower now, each proved against the
  differential oracle first. What the deliberate-residual table still
  holds, and why, is unchanged in kind: a `$groupby` whose key is
  untyped or nullable, whose `$return` reads the binding (after a
  grouping it holds the group's ROWS), or whose `$orderby` names
  anything but a key; a window over the GROUPS or an aggregate of them;
  a comparison whose two sides are both paths (join territory) and a
  disjunction spanning bindings; a `$for` binding nothing joins to — the
  cartesian product an equi-join graph exists to prevent; a projection
  ACROSS a join on the entity engine; and `$match`, `$call` and the
  other unlisted operators, which reach the deterministic-function
  hatch or nothing. Each remaining promotion needs its oracle proof
  first; the forced-residual mode is the regression net that makes one
  safe.
- [ ] **No shipped pack marks an aggregate operator.** Both halves of
  the registered-operator ring now exist: `pushable:'scalar'` pushes as
  a deterministic UDF, and `pushable:'aggregate'` registers a
  `db.aggregate` step/final pair and lowers into a `GROUP BY` (a plan
  whose `aggregate.fn` is `'registered'` carries the registered NAME,
  never a fragment of SQL), on the drivers whose `aggregateFunctions`
  capability is probed and reported. What is missing is a pack that
  declares one: the finance and stats aggregators fold a per-document
  sequence — a per-row scalar to SQL — rather than a cross-row column,
  and whole-series functions like `$irr` are never index-eligible. The
  ceiling is stated, not hidden.
- [ ] **Projection pushdown on the entity engine.** A collection FLWOR
  projects one member path, and now a whole TREE of them — `$return`
  objects and arrays rebuilt from the distinct leaves the statement
  fetched, each leaf's value beside its JSON type, with
  `explain().projection.paths` naming them and `$count` over one a
  `COUNT(*)`. What stays residual, deliberately: a projection the tree
  cannot rebuild (an operator over a member, a reference to the binding
  itself, a non-singular path, no member path at all), every projection
  on the ENTITY engine — one binding or across a join (MODEL-FORMAT
  §10.6) — and a `$distinct` over a projected path, which the engine
  still folds over the projected items. The rule that governs each
  promotion stays: project only when no residual conjunct still needs a
  member the projection would drop, because a projection that dropped
  one is a wrong answer rather than a slow one.
- [ ] **The synchronous entity set has no cursor.** A cursor is
  asynchronous by contract (`next()` answers a promise); `from(
  store.sync.entity('X'))` pushes one whole window as it always did.
  A synchronous row iterator on the `sync` twin is unbuilt.
- [ ] **A nested include's byte bound re-serialises the embedded JSON to
  measure it.** The root-level include text already contains every
  nested relation, so the outer bound covers nested content; per-child
  measurement below the root stringifies the parsed child. Projecting
  nested includes as text would make it a length, at the price of a
  projection change.
- [ ] **Other SQL dialects.** The dialect seam is real (proven by a
  test double) and the capability slots for statement timeouts and
  row estimates are deliberately empty on SQLite; a second dialect is
  the day they fill. The constraint: a dialect must reproduce the
  truth table's guarded semantics, not merely parse.
- [ ] **Introspection of an existing database.** `jaren-db` plans from
  model FILES (a database stores shape hashes, not models); deriving a
  first model from a live schema is unwritten.
- [ ] **Model-declared UDF-expression indexes.** The migration engine
  re-registers declared functions (`registerFunctions`) and data steps
  over UDF-indexed tables are tested; what remains is the model-level
  vocabulary to DECLARE such an index rather than hand-creating it as
  drift.
- [ ] **A federation joins two sides, not three.** Two entity sets of
  one store join in one document (a shared provider `scope`, QUERY-PEN
  §8; one statement for a bare-binding equijoin), and a join across two
  DIFFERENT sources now has its explicit door: `federate({ sources,
  maxRows, maxBytes })` (QUERY-PEN §12.1) hands back one provider source
  per name, pushes each side's own filters and projection to its own
  source, reduces the probe side by the build side's keys and lets the
  engine decide over the two bounded sets. An ordinary `join()` across
  unrelated sources stays `JL0005` — that is the design, not a gap. What
  is unbuilt: a federation of THREE or more sides, which needs a join
  order this boundary deliberately does not invent; a merge strategy,
  which needs sources that declare an ordering; and the same door on the
  entity translator's own three-plus-binding residual (MODEL-FORMAT
  §10.6).
- [ ] **A re-run live view is read before it has re-run.**
  `benchmark/live.js`'s event-time leg compares `live.result.rows`
  against the kernel's own answer immediately after a write. The
  MAINTAINED view passes it — the patch is applied with the write — and
  the `rerun` view does not, because its re-execution is scheduled and
  `LiveQuery` exposes no settle point to await, only `subscribe`. The
  suite has failed this way for at least four releases, so
  `benchmark:generate` omits the live rows rather than publishing wrong
  ones. Two ways to close it, and the choice is the live contract's: the
  harness awaits an emission before it compares, or a re-run view
  settles before `result` is readable. Found by QUERYREACH's close-out;
  it belongs to whoever owns live maintenance.
- [ ] **Replication.** Change capture (LIVE-FORMAT) is an ordered log
  of RFC 6902 patches with a monotonic sequence, and SQLite's
  changeset/conflict primitives are available — the raw material a
  replication protocol is built from. The log now has a bounded reader
  (`store.changes.bounds()` / `changes.page()`, LIVE-FORMAT §5) with
  two watermarks and an explicit retention gap — `resetRequired`, with
  no partial suffix beside it — which is the precondition a replication
  protocol would build on: a consumer can know when its cursor is
  usable and when it must re-seed. That is the precondition, not the
  protocol. None of the protocol is shipped: there is no conflict
  resolution, no site identity, no causal ordering across writers. This
  is the design constraint written down as an open item, not a hint
  that it is nearly there.
- [ ] **Richer incremental live maintenance.** The maintenance table
  (LIVE-FORMAT §7) covers `where`/`select`, the ordered window,
  whole-query aggregates and single-level `groupBy`; joins,
  multi-entity roots, offset windows and the linq chain's nested
  two-level `groupBy` emission all RE-RUN on invalidation (declared,
  reported through `live.mode`). Incremental joins in particular are
  the open research half this program deliberately did not open-end.
- [ ] **The session extension in the wasm build.** The official SQLite
  wasm build compiles `ENABLE_SESSION`, but the oo1 adapter does not
  yet map the session C API, so browser capture runs in the journal
  mode (stated in the capability matrix). Adapting it makes wasm
  capture session-complete.
- [ ] **The SharedArrayBuffer OPFS VFS and a header-capable host.**
  The deployed demo uses the header-free SAH-pool VFS because GitHub
  Pages cannot set COOP/COEP; a host that can set them may use the
  faster SharedArrayBuffer VFS family. Wiring that path (and an
  IndexedDB-backed fallback for hosts with neither) is unwritten.
- [ ] **A worker-hosted Node driver and its pool.** Every shipped
  driver runs SQLite on the caller's thread: one synchronous
  `DatabaseSync` per open, so a slow statement holds the event loop of
  the process that issued it. The website already hosts the wasm build
  in a dedicated worker with a five-stage named-failure boot; Node has
  no equivalent. What is wanted is a `nodeWorkerDriver()` that is a
  DRIVER — `{ name, dialect, open }` returning the same Connection
  contract, never a second store API — over a worker thread: a
  transport that keeps transaction affinity (one worker connection per
  open transaction), prepared-statement identity across the boundary,
  row cursors with credits rather than whole results, and driver-
  generation errors (a restarted worker refuses the statements of the
  generation before it, classed and retryable). Before it, a faulting
  and pausing test Driver, so generation-specific failure across the
  boundary is tested rather than hoped for. Then the pool: read-only
  WAL workers beside one writer, bounded queues, a graceful close, and
  queue-depth/latency metrics. Definition of done: a store over
  `nodeWorkerDriver()` passes the SAME store test suite as the
  in-process driver; a slow statement on a worker-backed store does
  not raise event-loop latency on the calling thread beyond a stated,
  measured, published bound; and `npm run test:deps` proves no
  `db → contract` edge (the transport lives in `@jarenjs/db`). It
  builds on the cancellation surface (`capabilities.cancellation`) and
  the driver-failure classes the store now has.
- [ ] **A migration assertion cannot be pushed into SQL.** Every
  assertion is now classified before it runs and none reads a collection
  whole: an associative aggregate over the root (`$count`, `$sum`,
  `$min`, `$max`) folds one batch at a time, and anything else gathers
  through the same paged walk under declared row and byte bounds
  (MIGRATION-FORMAT §6). What remains unavailable is D3's FIRST choice —
  letting the provider execute the aggregate. A migration assertion runs
  BETWEEN models: the documents are in whatever shape the preceding steps
  left, which is neither the baseline's nor the target's, so the planner
  has no settled shape to bind a profile to. Closing it means giving a
  migration a per-step declared shape, at which point the promotion is
  one branch in the classifier and a provider probe. `$distinct` and
  `$avg` also still materialize: neither combines from the engine's own
  per-batch answer alone, which is the property that makes the current
  folds provably equal to it.
- [ ] **A declared task version is only as honest as the host that bumps
  it.** A checkpointed task node now declares the identity of the
  implementation it depends on, the registry must supply the same token,
  and a DAG job fingerprints the canonical version map beside the
  workflow revision and the input — so a handler reimplemented under an
  unchanged document is `JD2069` before a checkpoint is loaded
  (FLOW-FORMAT §7.8, JOBS-FORMAT §7). What no format can check is whether
  the host actually moved the token when it changed the code; that is the
  same limit the workflow revision has always had, now inherited by
  tasks. A run whose version legitimately moved also has no path but a new
  id or a dropped run — deliberate, but an operator-driven reset is the
  obvious follow-up if the need appears.
- [ ] **A stored interval cannot be declared well-formed, so `$overlaps`
  narrows but never seeks.** The promotion pushes the half-open conjunction
  over the two declared bound columns and the engine's own operator decides,
  which is the fetch it was built for — but §8.16 RAISES on a span whose end
  is at or before its start, and no JSON Schema keyword compares two members,
  so such a row is storable. The statement therefore keeps every one of them
  (`start >= end`, a comparison of two columns), and no index bounds that
  disjunct: the fetch scans. Closing it means declaring the pair AS an
  interval — a `CHECK` the DDL carries, so an inverted span is unwritable and
  the conjunction alone is exact — which is a model-format change with its own
  migration parity, plus `createIntervalIndex` as the resident shape it would
  then serve.

- [ ] **A document migration file holds ONE collection.** `migrateDocuments`,
  `streamDocuments` and `jaren-db documents` run a migration's document
  steps over arrays, JSON, JSONL and stdio, sharing one implementation of
  what a step MEANS with the store runner — so the array answer equals the
  store answer, on the same step, in the same words (MIGRATION-FORMAT
  §6.1, §11). What is not covered is a chain whose document steps touch
  more than one collection: a file is one collection, so such a chain is
  refused rather than partly applied. Closing it means a multi-source
  invocation (`--in users=…  --in events=…`) and deciding what atomicity
  means across several files, since the whole-or-nothing rename that makes
  one file safe does not compose across two.
- [ ] **The remaining authored documents have no pen.** Nine formats are
  written by code today, under one contract stated in
  [LINQ-FORMAT §1](../packages/linq/docs/LINQ-FORMAT.md) — the emitted
  document is exactly the published one, types are phantoms, and grammar,
  compile, docs and type gates hold each. Five authored formats are still
  written as JSON literals, each for its own reason rather than a shared
  blocker: `chart-definition` (`@jarenjs/charts`) is the most immediately
  useful; `jaren-project` (`@jarenjs/studio`) is low value alone, since
  the studio authors projects — its worth is round-tripping pen output
  into the studio; the JTLT template document is blocked first on a
  published `jaren-jtlt` grammar, which is a format decision and not a
  pen one; message catalogs (`@jarenjs/contract`, `@jarenjs/locales`)
  would be typed by the msgids the English catalog declares; and the AI
  action language is authored by models rather than people, so a pen
  there buys fixtures and tests rather than authoring. Each is one work
  order of the shape every shipped pen already has — a subpath, a
  `types/<pen>.d.ts`, a corpus test asserting emission byte for byte
  against hand-written documents and the format's own examples, grammar
  validation, an engine compile and run, a pen document whose fences
  run, a tree-shaking probe carrying neither chain module nor engine, a
  packed-consumer subpath and a type pin. A JTLT order additionally
  carries the grammar artifact and its tests. None is scheduled.
- [ ] **Twenty-five keywords the validator compiles have no schema-pen
  method.** `@jarenjs/linq/schema` owns 69 keyword names
  (`packages/linq/src/schema/builders.js`) and has a builder method for 44
  of them; the rest are reachable only through `.keyword(key, value)` or
  `from(json)`, which write verbatim and change no phantom type. They are
  `not`; `unevaluatedProperties` and `unevaluatedItems`;
  `dependentSchemas` and `dependencies`; `minContains` and `maxContains`;
  `contentEncoding`, `contentMediaType` and `contentSchema`;
  `formatMinimum`, `formatMaximum`, `formatExclusiveMinimum` and
  `formatExclusiveMaximum`; `$id`, `$anchor` and `$vocabulary`;
  `$dynamicRef`, `$dynamicAnchor`, `$recursiveRef` and
  `$recursiveAnchor`; `definitions` (the draft-07 spelling of `$defs`);
  `additionalItems`; and `$data` with its bare `data` spelling. `@jarenjs/validate` compiles every one. The constraint is that
  a method is not the whole cost: each wants a type reading that stays
  honest — `not` has no sound `Infer<>` narrowing, the unevaluated pair is
  an annotation-dependent keyword whose result depends on sibling
  applicators, and the dynamic references would make `named()`'s
  one-name-one-definition identity rule ambiguous — so the ones worth
  adding first are the ones whose type reading is simply `this`
  (`minContains`/`maxContains`, the content family, the format bounds).
  The forms and model pens inherit whatever lands here.

## @jarenjs/ai

The package now has three paths — a bounded tool loop, a ledger-backed agent that
survives a closed tab, and a recursive entry point that works a corpus larger than
the context by addressing it instead of reading it — and, across all three, an
embedder seam: an OpenAI-compatible `/embeddings` client and a deterministic
reference embedder, memories and skills that carry a vector with its identity, and
`recall({ near })` ranking by meaning through an embedder the host injects. All of
it is documented in `packages/ai/README.md`, which is where shipped capability
lives; what follows is only what is genuinely still open.

Most of these entries share a shape worth naming: the missing thing is a
**measurement**, not an implementation. This package refuses to add a ranker, an
evictor or a de-duplicator before the number that would say whether it helps, and
the ranker is the case that has now run its course: the instrument was committed
first, scored the policies that already existed, and only then was the ranked path
added and published whichever way it fell. It turned out to be the harder and more
valuable half both times. The evictor and the de-duplicator are still waiting on
theirs.

- [ ] **A program is authored per question, and nothing reuses one.** A question
  over everything at once — which two of forty records are closest — is
  unanswerable from a compacted transcript at any budget
  (<!--fact:horizon.pairwise-->0% at every budget that compacts anything except ledger/front at 20000<!--/fact-->)
  and is answered by a compiled program over the environment, which is what
  `packages/ai/README.md` now documents. What is open is everything around the
  single run: an authored program is thrown away after it answers, so a session
  that asks forty similar questions authors forty similar plans and pays the
  authoring call every time. The ledger already stores *skills*, and a program
  that compiled and answered is exactly the evidence a skill wants — and
  "the same question again" is a similarity judgement, which is the half that
  has since been built. `recallSkills({ near })` ranks stored skills by meaning
  through the injected embedder and refuses across model identities, and
  `benchmark/retrieval.js` is the instrument that scores a ranking rather than
  asserting it (the retrieval entry below carries its numbers). What is still
  missing is the measurement for THIS question, which is a different one: a
  benchmark over a question STREAM rather than a single question — how often is
  a stored plan the right plan, and what does re-running a wrong one cost?
  Without it a reuse threshold is a guess, and a wrongly reused plan is more
  expensive than the authoring call it saved.

- [ ] **A program's reduce shape is a convention the compiler cannot check.** A map
  element is `{ slot, value }` whether that value came from a leaf model call or a
  whole child agent, so a reduce has to emit the same shape its elements carry or
  the identical program answers correctly at depth 0 and returns nothing at depth 1.
  The compile gate catches undeclared names, uncompilable queries and a missing
  final step; it cannot catch this, because query documents are not typed and the
  element shape is whatever the sub-calls happened to answer. Both behaviours are
  pinned in `test/ai/recursive.test.js` so the rule cannot rot, and the README
  states it — but a rule a reader must remember is weaker than one a compiler
  enforces. Closing it means type inference over query documents (`annotateTypes`
  exists in `@jarenjs/json` and is the obvious starting point), which is a
  query-engine feature with its own justification, not an AI-package patch.

- [ ] **Depth has not been shown to pay on any task this repo measures.** The
  benchmark runs depths 0–2 and publishes median and p95 cost: deeper answers the
  same fraction correctly and costs proportionally more. That is consistent with the
  research — which finds most of its gain at depth 1 and depth 3 helping only on
  *information-dense* tasks — but it means this package ships a capability whose
  benefit it cannot demonstrate, only its price. The missing piece is a task with
  the density the research describes (a corpus where one piece cannot be summarised
  without reading its own sub-pieces). Until that exists the honest reading is: the
  depth cap and the shared budget are the useful parts, and depth 1 is the default
  because deeper has not earned its cost here.

- [ ] **The authoring call is what times out, on the `a3b` tier specifically.** The
  campaign's live runs lost roughly one authoring attempt in three on the
  single-level program path and **all four** recursive tasks at depths 1 and 2, every
  one on a 300-second deadline during its first authoring call — while ordinary
  sub-calls on the same tier, in the same run, answered 40 out of 40. Recursion needs
  one authoring call per level, so the failure probability compounds with depth, which
  is what the numbers show.

  The stylesheet-authoring pass closed the two *mechanical* causes — the oversized
  `response_format` (a narrowed authoring profile, and `stream` is now an option on
  `createStructuredOutput`) — and the residue is a property of the model, not the
  request. On the identical, now-working authoring path, `qwen3.6-35b-a3b` spends
  3,000–5,600 tokens *reasoning* per attempt at 60–90 s a call, where
  `qwen3.6-27b` emits **zero** reasoning tokens and answers the same question
  correctly in one call, five times out of five, in 3–6 seconds. A sparse-MoE tier
  that cannot stop thinking is not fixed by a smaller schema; it is avoided by
  routing authoring to a dense model. What is open is whether that routing rule
  generalises past this one document kind — the program language and the recursive
  tiers have not been re-measured since, and the depth numbers below still stand on
  the old runs.

- [ ] **An oversized `response_format` has one measured cure and it is per-grammar.**
  `jaren-jslt.authoring.schema.json` exists because a JSLT stylesheet is what was
  measured; the query, app, fsm and dag grammars have no authoring profile and the
  same failure is available to all of them. The derivation
  (`deriveAuthoringProfile`, a narrowing at a named `$defs` seam) is general and the
  artifact is three lines of script — what is missing is the measurement that says
  where each grammar's seam is, which is not guessable from the schema alone.

- [ ] **Retrieval quality has an instrument and no real-language dataset.**
  `recall({ tags, limit })` is the default; `recall({ near })` ranks by meaning
  through an injected embedder and refuses without one, and
  `benchmark/retrieval.js` scores both — recall@k and MRR over a seeded corpus,
  the ranked row through the deterministic hashed-trigram reference embedder,
  published whichever way it falls (<!--fact:retrieval.ranked-->5.0% of questions at 10,000 memories through the hash-trigram-64 reference embedder (33.8% at 1,000), ahead of tag match and recency's 1.3%<!--/fact-->).
  What is open is what that instrument cannot say. The corpus is synthetic and the
  reference embedder is lexical, so the numbers are mechanism scores: they prove
  the sweep, the identity check and the ranking work over the shipped code path
  and say nothing about whether the right memory is found by *meaning*. Measuring
  QUALITY needs a real-language dataset with human-labelled relevance, embedded
  through the `--live` tier by a model a host injects — and this suite publishes
  no model's number as its own, so the dataset and the run are a host's to bring.
  The other open edge is scale, and it now has numbers instead of an intuition.
  Ranked recall is EXACT on both of its paths — an in-process sweep of one
  cosine per embedded record, or, when the storage adapter offers the optional
  `rank` capability (the `@jarenjs/db` one does, over a packed vector column),
  a cut the store performs and the ledger re-scores; `benchmark/retrieval.js
  --store=db` runs both and asserts their quality columns equal, so only
  latency moves. Both are linear in candidates times dimensions, and the
  constant is fitted rather than guessed: <!--fact:vector.ceiling-->5.142 ns per vector component — one query reaches 100 ms at about 24,000 vectors of 768 dimensions and one second at about 252,000<!--/fact-->.
  Past that ceiling the answer is an approximate index, and it is deliberately
  not built: approximation trades the exactness that lets one query document
  answer identically in the JavaScript engine, in SQLite through the Node
  driver and in a real wasm build for a recall number nobody here has
  measured. If it is ever built, the terms are the ones
  already on the table — it starts by benchmarking against the extension this
  design already publishes itself against (<!--fact:vector.rival-->35 ms against 191 ms at 50,000 × 768 — 5.5× in sqlite-vec's favour, out of a database 6.6× smaller that holds no documents<!--/fact-->),
  it publishes the RECALL it loses against exact top-k and not only the
  latency it wins, and the committed instrument above is what scores it.

- [ ] **The goal section has no ceiling.** Progress is appended and never
  rewritten, and every entry composes into the system prompt of every request —
  which is exactly what stops a resumed session redoing finished work. It also
  means a long run's pinned system message grows without bound, and the
  compaction planner pins it whole: past some length a tight `historyBudget`
  spends its whole allowance on the goal. Superseding or pruning the goal is the
  only lever today. Bounding it automatically means deciding what may be dropped
  from a record whose entire purpose is that nothing is forgotten, so the missing
  input is a measurement — what does dropping the oldest progress cost a resumed
  run? — rather than a summarizer.

- [ ] **Refinement's grounding is checked, not judged.** The live probe verifies
  that a proposed record quotes something the run actually contained and invents
  no identifier-shaped token (`REC0007`, `v4.19.2`, a region). Nothing measures
  whether a stored memory was *worth* storing, or what happens to a ledger
  refined after fifty runs: near-duplicates accumulate, and the prompt asks the
  model not to add one but nothing enforces it. What that measurement needed now
  exists: a memory can carry an `embedding` with its `embeddedBy` identity, the
  kernels score a pair without throwing, and `benchmark/retrieval.js` is a
  committed harness that loads a corpus through the real ledger and scores what
  came back. What does not exist is the measurement itself — duplicate pressure
  over repeated refinements against ONE ledger: how many near-duplicates a run
  adds, at what similarity, and what recall they cost the questions that follow.
  A de-duplication rule written before those numbers would still be a guess
  about which of two similar memories is the better one, and the similarity
  score alone cannot tell them apart: two records at 0.95 may be one redundant
  restatement or two facts that differ in the one detail that matters.

- [ ] **The site's own ledger adapter sits outside the single-writer
  contract.** A storage adapter's mutation contract is four async methods, not
  a transaction; an adapter may also expose the optional `rank` capability —
  but the website's assistant keeps its ledger in
  one browser storage slot that it caches in memory and rewrites whole on every
  write, so two tabs are two writers over one adapter and the last one to write
  wins wholesale. It predates the contract sentence rather than regressing
  against it, and a durable adapter does not close it either: an immediate
  transaction narrows the cross-process race but cannot end it, because minting
  an id is a read and then a write across two adapter calls. Closing it means
  either electing one writer (a lock, an owner tab) or moving the mint into the
  adapter as an atomic operation — another optional capability whose extra
  weight has to be justified against the deliberately small mutation contract.

- [ ] **Archived rounds have no automatic budget eviction.** Compaction writes
  every dropped round to a slot and never deletes one during a live conversation,
  which is exactly the property that makes
  a synopsis address trustworthy — and it means a ledger grows for as long as a
  conversation does. In memory that is a session's worth of strings; over a
  browser slot it eventually meets the storage quota, where the site degrades by
  keeping the session correct (the in-memory map still answers every address) and
  losing the next visit. The site deletes those slots when the user explicitly
  clears the conversation; it does not enforce a storage budget before that.
  An eviction rule needs to answer what may be dropped
  from a store whose promise is that nothing was, so the honest shape is probably
  a host-set budget with the ledger REPORTING what it evicted, not a silent LRU.

- [ ] **The per-path record shape lives in the prompt, not the schema.** One
  `value` union serves `/memories/-`, `/skills/-` and `/goal/progress/-`, so a
  progress entry written in a memory's shape is legal against the patch schema
  and is caught only when the record is validated against the ledger's own. On
  the qwen tier that cost every first attempt until a shape table and a worked
  example went into the prompt. `if`/`then` per path would move the constraint
  into decoding itself, at the price of a keyword provider implementations
  support unevenly — worth revisiting once that support is measurable rather
  than assumed.

- [ ] **The guarded-document refiner is ledger-shaped.** `createRefiner` runs
  four stages — the patch's shape against a constrained schema, the patch
  applied to a COPY through the injected engine, every record the candidate
  would store validated, then commit through the ledger's own API with a
  snapshot to roll back to — and every one of them is hard-wired to the
  ledger's supplemental state: the reader is `getGoal`/`listMemories`/
  `listSkills`, the legal paths are `/memories`, `/skills` and
  `/goal/progress`, the commit is `addMemory`/`addSkill`/`recordProgress`.
  The mechanism is reusable and the shape is not: a host with a different
  durable document (a learned skill file, a forecast checkpoint, a research
  plan) wants the same read → validate shape → apply to a copy → validate
  candidate → derive a commit plan → commit-or-rollback, behind an injected
  contract — the patch schema, the patch engine, the candidate validator and
  the commit transaction as seams, pointered problems out, and the rule that
  a model's generation never gets a weaker gate than a hand-written patch.
  The constraint that keeps this open is that the generic layer must not
  invent one universal artifact schema, and the only honest proof that it
  has not is `createRefiner` itself rewritten as its first consumer without
  losing a ledger rule or a test — an extraction, not a second refiner.

- [ ] **A claim/evidence envelope has no record to validate.** Grounded
  answers, clinical assistants, graph retrieval, trading notes and research
  logs all repeat the same structural checks — a claim has a stable id, an
  evidence reference resolves to an admitted artifact, a visible citation
  names evidence that was used, an unresolved critical claim is explicit —
  and each host writes them again, subtly differently. A generic schema plus
  a pure referential validator would end that, and it must stop exactly
  there: it may check structure and reference integrity, never that prose is
  supported, never source authority, never fetch a URL, never a domain's
  policy. What is missing is the internal consumer: the ledger's memory
  carries free-text `evidence`, not a reference, so there is nothing in the
  suite for such a validator to validate. The entry lifts when the
  memory/evidence pair grows a referential form and a bad-reference fixture
  comes with it.

## Dates & times (cross-package)

One program. The motivating observation is that the suite does not lack a
date *library* — it lacked date *capability in its engines*: charts silently
dropped date strings, gantt stored its date directives without interpreting
them, forms rendered two of its three date formats as plain text boxes, and
the locale packs contained no month names at all.

The kernel (`@jarenjs/core/dates/*`), the query operators, the charts time
axis, the forms date controls, the JOSL dedup, the allocation-free
`formatMinimum`/`formatMaximum` comparators, the locale packs' calendar
language and the Mermaid Gantt timeline are done; what they do is documented in
`packages/core/ARCHITECTURE.md`, QUERY-FORMAT.md §8.13 and the respective
package READMEs — the date msgids and their compilation in
`packages/locales/README.md`; the chart time axis takes the same
`DateNames` record the Gantt does (`components/charts/README.md`), and a
zone provider over the host's ICU ships opt-in as
`@jarenjs/locales/intl-zones` beside the runtime record
(`@jarenjs/core/runtime`) that hands it, with the clock, to every host
subsystem at once. One entry is left.

Two constraints shape every entry. **There is no date type**: dates are RFC
3339 strings (lexical, interchange) and epoch milliseconds (arithmetic), both
of which are already JSON items — a wrapper object, even an immutable one,
could not be a query-engine item, a JSON Patch target, a schema-validated
value or part of app state, which is exactly why `canonicalizeJson` turns a
`Date` into `{}` and why JOSL's value classes are opaque outside JOSL. And
**there is no `now`**: a compiled query is cached by document identity and
saved as a rule, so the current instant enters as data (an external, an app
effect) rather than as an operator (QUERY-FORMAT §8.13).

Note the deadline this program does *not* have: TC39 Temporal reached Stage 4
in March 2026 and ships in Chrome 144+, Firefox 139+ and Node 26+, but not
Safari and not this repo's Node ≥ 24 baseline. The string/number
representation is what `Temporal.Instant.from()` consumes, so the kernel can
delegate to Temporal internally once the baseline moves, without changing a
public surface. Building a general-purpose date *library* is therefore the one
thing to avoid.

- [ ] **Mermaid gantt: the directives that are still only text.**
  `dateFormat`, `axisFormat`, `tickInterval`, `excludes`, `weekday` and
  `weekend` are interpreted, the tasks resolve to half-open intervals with
  dependencies and working-day arithmetic, and gantt renders a real
  timeline — the grammar, the vendored conformance table and the
  divergences are in `components/mermaid/docs/MERMAID-FORMAT.md` §4.4, and
  the kernel's half is `compileDateParser` in `packages/core/docs/DATES.md`.
  What is left is the remaining header vocabulary: `includes` (the
  exception list that overrides `excludes`), `inclusiveEndDates`, `topAxis`,
  `displayMode: compact` and the `click` interaction statements — plus the
  eight d3 axis specifiers the conformance table now names as refusals
  rather than passing off as unknown (`%f`, `%g`, `%G`, `%q`, `%Q`, `%s`,
  `%u`, `%V`): a week-based year and a week number are a second year field
  and a derived one, so admitting them is a parts-record decision rather
  than a table entry. Note `todayMarker` is **not** on this list and never
  will be — it needs a clock, and there is none (see the constraint above);
  a host that wants "now" on a diagram supplies the instant as data.

## Geospatial (cross-package)

Geography is a capability every surface of the suite can spell, and the shipped
half is documented where a stranger looks rather than here: the kernel and its
published losses in `packages/core/docs/GEO.md` and `packages/core/ARCHITECTURE.md`;
the thirteen spatial operators, the conversion family, the proximity rule and
the CSV recipe in QUERY-FORMAT §8.14, the `@jarenjs/json` README and
`docs/HOWTO.md`; the fluent surface in QUERY-PEN §4; derived spatial index
kinds, the two-stage plan with its truth table, the geofence and the storage
numbers with their loss in the `@jarenjs/db` README, ARCHITECTURE, MODEL-FORMAT
and LIVE-FORMAT; the spatial authoring profile and the geo toolbox in the
`@jarenjs/ai` README; the `geojson` preview hint in the `@jarenjs/forms` README;
and the one-document-three-executors claim in `docs/ARCHITECTURE.md`. What is
still open is listed here, each with its reason.

- [ ] **`$geo-parse` and the published proximity recipe raise where the rest
  of §8.14 answers.** §8.14's nine-cell membership test is `$exists` over
  `$index-of`, and `$index-of` refuses an empty search item (`JQ2001`), so a
  row whose geometry has no bounded position — a missing coordinate, an empty
  `FeatureCollection` — raises in the engine and under a pushdown-off run,
  while the same query under the promotion never fetches that row and answers.
  Whether the *language* should answer `false` there (a membership test over
  nothing is not a match) is a query-format decision with a spec diff, not a
  patch; until it is made, guard the probe with `$exists` on the position, as
  the format's prose says.
- [ ] **The spatial authoring profile has not met a live model.** Its three
  refusals (a geohash prefix offered as proximity, planar arithmetic over a
  coordinate member, a geographic ask with no spatial operator) are proven on
  recorded fixtures and the repair round is shown to carry the code and the
  fix; no key or local runtime was available when it was built. The first live
  run belongs as a row beside the stylesheet author's measurements in the
  `@jarenjs/ai` README. Its intent reader is an English word list — a question
  that says "in the neighbourhood of" without a listed word is not read as
  proximity, so a prefix document passes; a host can pass its own `gates`.
- [ ] **A string at a derived index path cannot be stored.** A collection
  declaring `derive` on a member writes that member into the generated column
  through `json(jsonb_extract(doc, …))`, and `jsonb_extract` hands back the raw
  SQL value for a string rather than its JSON representation — so `json()`
  rejects it and the insert fails with `JD2005: malformed JSON`. Numbers,
  booleans, `null` and arrays are unaffected. The member is not geography in
  that case, so the document was wrong; the failure is opaque about it, and a
  collection whose spatial member is sometimes a WKT string cannot be written
  at all. The fix is a dialect-level change to how the member reaches the
  function, which moves a generated column's declared expression and therefore
  needs the shape-verification and migration story thought through with it.
- [ ] **A parameterized `$distance` bound is not promoted.** A bounded
  `$distance` pushes its circle's box only when BOTH the probe position and the
  radius are literals: an external on either side would need a parameter slot
  that composes the bound value with the radius, and the derived slot kind is
  closed at one axis of one bound value. Such a query is correct and reads
  every row. `$within` and `$bbox-intersects` do bind an external region.
- [ ] **A live ordering by `$distance` re-runs.** The geofence maintains a
  `$where` per row; an `$orderby` over `$distance` (or over a member beside a
  refined predicate) and a spatial aggregate re-run on invalidation with the
  reason in `live.mode`. Maintaining a distance-ordered window incrementally is
  an incremental spatial index, which is a different campaign; the honest
  re-run is the shipped answer until it is built.
- [ ] **Overlay operations (union, intersection, difference, buffer)** —
  deliberately last, and possibly never. This is what [JSTS](https://github.com/bjornharrtell/jsts)
  exists for, it is where floating-point robustness problems concentrate, and
  a half-correct clipper is worse than none. Everything before it has shipped,
  so if this is ever built it starts by benchmarking honestly against
  [Turf](https://github.com/Turfjs/turf) (~796k weekly downloads) and JSTS
  (~577k), and records the loss here rather than pretending the gap is small.

## The website

- [ ] **A cross-document deep link leaves the site.** The README dialog's
  link walk (`rewriteAnchor`, `packages/website/src/boundaries/markdown.js`)
  resolves a repo-relative href and then tests the resolved path for
  `.md` — but the path still carries its `#fragment`, so
  `SCHEMA-PEN.md#4-refusals` fails that test, fails `isDirectoryPath`
  next because its last segment contains a dot, and falls through to a
  GitHub blob URL in a new tab. A bare `SCHEMA-PEN.md` navigates in the
  dialog and a same-document `#4-refusals` scrolls; only the two
  together throw the reader out, which is exactly the form a directory
  of interlinked documents wants to write. The fix has to split the
  fragment off before the extension test and then carry it: the dialog's
  navigation state is `{ title, url }` in three places — `readme/navigate`
  patches it, the `readme-hist` effect stores it as the trail entry, and
  `readme/show` replays that entry on back and forward — and the scroll
  cannot run at dispatch time the way `readme/anchor` does, because the
  document is not in the DOM until `readme/loaded`. The trail then has
  to decide whether a fragment is a history entry of its own or a
  detail of the entry it arrived with.

## Benchmarks & tooling

- [ ] **`vector.js`'s largest leg needs about 1.5 GB.** 50,000 × 768 holds one
  in-memory SQLite database of roughly a gigabyte beside a 153 MB resident
  matrix, and finishes in about ninety seconds; a memory-constrained runner
  wants `--sizes 10000`. Backing the largest leg with a file would buy the
  headroom at the price of measuring a page cache instead of a database, which
  is only worth trading once a runner actually fails.
- [ ] **Compile-mean coverage in `jslt.js`** — `COMPILE_KEYS` is `['identity', 'surgical', 'annotate']`, so the compile row's stylesheet set omits the reshape stylesheet.
