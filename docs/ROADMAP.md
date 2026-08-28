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

- [ ] **Opt-in modes for the remaining pointer divergences** — `hashIndex`
  established the pattern (a compile-time option, spec answer available, fast
  historical answer the default). Two siblings could take the same treatment if
  a consumer ever needs them: own-property-only reads (`/toString` →
  `NOTHING`) and the strict array-index parse that rejects `01`/`1abc`/`1e0`.
  Both are deliberate and documented in the package ARCHITECTURE; neither has a
  requester, so this is a shape to reuse rather than work to schedule.
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
- [ ] **`additionalProperties: false` instancePath divergence from ajv** — Jaren points the error at the offending member (`/nested/extra`) where ajv points at the parent object; deliberate and spec-truer, tracked so consumers diffing against ajv output know it is intentional.
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

- [ ] **Stream reconnection stays the host's hand** — the `stream`
  binding shipped (CONTRACT-FORMAT.md §17–§19: the `subscribe` kind,
  LIVE-FORMAT `{ patch, seq }` emissions as SSE over http and push
  frames over port, `Last-Event-ID`/`lastSeq` resumption, the generated
  subscription in the app binding, the website's live pane re-homed on
  it), but a stream that ends with a `network` outcome is re-entered
  only by the host calling `subscribe` again with the last delivered
  seq. An automatic reconnect policy (backoff, resume, give-up) is the
  open decision — the `lastSeq` option is the hook it would use.
- [ ] **Query-located object members do not survive the HTTP wire** —
  the transport coercion is deliberately scalar-only (query strings,
  form fields), so a `subscribe`/`read` input member typed `object`/
  `array` round-trips over `port`/`local` but arrives as its JSON text
  in a query string over http. Whether the transport should JSON-decode
  a member whose declared type is non-scalar (a D3 extension) is open;
  until then such operations belong on the JSON-framed bindings or key
  their stream by scalars.
- [ ] **The schema-driven serializer stays unbuilt — measured, not
  assumed.** The scheduling criterion was: build it only if serialization
  is ≥ 25% of the per-request cost on the committed dispatch table. The
  measured share (`benchmark/contract.js`, the in-process table's
  heaviest row — the 5×4-body PUT)
  is <!--bm:contract.serialization.share-->11.6%<!--/bm--> of the whole
  jaren request, so a perfect serializer that cost nothing
  would move the pipeline by about a tenth. Not scheduled. Revisit only
  if a consumer's real payloads push the share past the criterion — the
  suite prints the share on every run, so the number stays checkable.
  (The larger measured lever is output validation,
  at <!--bm:contract.validateOutput.share-->29%<!--/bm--> of the same row;
  it is a correctness feature, declared off per server with
  `validateOutput: 'never'`, whose cost the benchmark's fourth column
  keeps visible. For a large cached representation the contract README's
  "validate on rebuild, serve by revision" recipe keeps the guarantee
  per revision instead of per request.)
- [ ] **Matcher promotion to core** — the static-segment path matcher is
  private to `packages/contract/src/path.js` by design; it moves to
  `@jarenjs/core` the moment a second consumer appears (the one-
  implementation rule), not before.
- [ ] **A declared-failure door on stream emissions** — re-homing a
  `@jarenjs/db` `live()` on a subscribe output drops the store's own
  coded error from the wire: an `{ error }` emission crosses as the
  generic stream host-fault event (`JC2093`), coarser than the coded
  error the old page-side push path carried. A way for a subscribe
  operation to declare error shapes its emissions may carry — the
  `errors` map applied to the stream's `error` event — would restore
  the fidelity; undesigned, and it touches the SSE event grammar
  (CONTRACT-FORMAT.md §18), so it is an order-sized decision.
- [ ] **The cross-tab e2e in WebKit awaits an OPFS-capable build** —
  the db-owner protocol's cross-tab tests (the second-tab read and the
  port binding's cross-settle proof) pass for real in Chromium and
  Firefox and skip by their own guard in WebKit: Playwright's WebKit
  builds on this harness expose no OPFS at all
  (`navigator.storage.getDirectory` is undefined in page and worker).
  The tests are written; the gate closes by itself the moment a
  Playwright WebKit build ships OPFS — re-check on Playwright upgrades.

- [ ] **`jaren-contract` reads JSON files only — there is no module route
  and no automatic types twin.** `jaren-db` loads a model MODULE (`.js`,
  `.mjs`, `.cjs`, or `.ts` where Node strips types), refuses it when two
  loads differ, keeps a committed snapshot, and writes emit's declaration
  beside it with `snapshot --types`. `jaren-contract` does none of that:
  every command takes `--contract <file>` and calls `JSON.parse` on it, so
  a contract written with `@jarenjs/linq/contract` must first be
  serialized by a script the consumer writes, and the `.d.ts` it projects
  has to be regenerated by a second command nobody is reminded to run. The
  twin of `jaren-db`'s route is: accept a module whose default (or
  `contract`) export is a document or a pen builder, load it twice and
  refuse an impure one, and let `types --check` be the thing CI runs. The
  purity double-load and the module loader are already written in
  `packages/db/src/cli.js` — this is mostly a matter of deciding whether
  they are shared or mirrored, which is a real decision because the two
  packages have no import edge.

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
- [ ] **Editor: it still ships as a website mode** — the `#/flow` studio is
  not a package, and the second consumer this was once gated on has
  arrived: `@jarenjs/studio` has `fsm` and `dag` file kinds that
  validate and assemble but have no editor. So the open question is no
  longer *whether* to extract but *where to*, and the answer the project
  IDE implies is that the canvas becomes a per-kind editor inside
  `@jarenjs/studio` rather than a third two-layer component. That work
  and its constraints are stated once, under `@jarenjs/studio` above;
  the engine remains the product either way.

## @jarenjs/md

- [ ] **`meta.hash` costs ~11% of a parse and cannot simply go lazy** — hashing
  the source is a full pass over it, paid by every caller including the ones
  that never read the hash. A getter would fix that and would also make an
  MdDocument stop being plain JSON, which MD-FORMAT §1.1 promises it is; an
  opt-out flag would leave a document carrying a hash that is a lie. Measured
  and left alone deliberately — the honest fix is the `Math.imul` item above,
  which halves it for everyone.

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

- [ ] **Pushdown promotions.** Two-binding equijoins shipped in phase
  B; the deliberate-residual table still holds `$groupby` (the
  post-group cardinality rebinding deserves its own order —
  MODEL-FORMAT §10.6), three-plus bindings, non-equi joins,
  projections over joins, and `$match` beyond the UDF hatch. Each
  promotion needs its oracle proof first; the forced-residual mode is
  the regression net that makes promotion safe.
- [ ] **Aggregate-UDF pushdown for registered operators.** The
  `pushable:'scalar'` subset already pushes into SQLite as deterministic
  UDFs (MODEL-FORMAT §8.2, node:sqlite; bun stays residual). What remains
  is `pushable:'aggregate'` — `db.aggregate` step/final over `GROUP BY` —
  which no shipped pack yet marks (the finance/stats aggregators fold a
  per-document sequence, a per-row scalar to SQL, not a cross-row column)
  and which additionally waits on `$groupby` pushdown, itself a
  deliberate residual above. The `aggregateFunctions` capability is
  already probed and reported, so the driver gate is in place; whole-
  series functions like `$irr` are never index-eligible — the ceiling is
  stated, not hidden.
- [ ] **No projection pushdown, and `$count` pushes only over a bare
  binding.** A FLWOR whose `$return` is a single path over the binding
  plans as `mode: 'row'` and its statement still selects the whole
  document, so reading or `$distinct`-ing one member costs a full
  document read of every row the predicate admits. The visible edge of
  the same gap is `$count`: over `$return: "$r"` it emits `SELECT
  COUNT(*) … WHERE …`, while the identical document with
  `$return: "$r.key"` plans as a set and reads every document — correct,
  and not distinguishable from `explain().mode` alone. It is why the
  durable ledger adapter (the recipe `packages/ai`'s README publishes)
  answers its identity check from pushed counts and pays the scan only
  when the counts prove a mixture. Closing it means projecting a
  declared scalar path into the statement when the `$return` is a single
  path over the binding, with the residual rules thought through in the
  same change: a projection that drops a member a residual conjunct
  still needs is a wrong answer, not a slow one.
- [ ] **A k-nearest probe cannot pick its column at bind time.** Two
  `derive: 'vector'` widths over one member path are two columns, and a
  plan carries one of them; an external probe of the other width
  diverts to the engine with the reason named rather than selecting the
  column that would fit it. Choosing from the probe's width at bind time
  is possible and unbuilt — the plan would have to carry both columns
  and the diversion reason would have to name which widths were on
  offer. A single-width collection, which is what an embedding model
  gives you, never meets it.
- [ ] **Two processes opening one fresh file race on `openStore`.**
  Reproduction: two child processes released simultaneously on a path
  that does not exist yet. `PRAGMA journal_mode = wal` runs right after
  open, then the shape is created as `tableExists` + `CREATE` inside a
  DEFERRED savepoint, so the read→write upgrade gets `SQLITE_BUSY`
  without the busy handler: 3 of 12 rounds failed with a raw
  `database is locked` (at the pragma or at the CREATE) despite the 5 s
  busy timeout, the other process succeeding. The fix is known and
  unbuilt: shape creation under `BEGIN IMMEDIATE` (the dialect already
  spells it), `CREATE … IF NOT EXISTS`, and open-time driver errors
  wrapped as `JD0002`.
- [ ] **`explain().series.counts` after a row, aggregate or cursor
  run.** `countSeries` runs on the set path only: a `$return:
  '$s.value'` range reports `mode: 'row'`, `series.mode: 'native'` and
  `counts: null` after `execute`; a `$count` over the range and a
  `for await` over it leave `counts` null and `stats().series.queries`
  unchanged; a plain `execute` of the same range then fills
  `{ statements: 1, candidates: 3, results: 3 }`. Count in all three
  paths, and derive `series.mode` from the plan mode rather than from
  the index alone.
- [ ] **A UDF-hatch error names the wrapper's path.** The hatch compiles
  a fragment as `{ $let: { it: '$' }, $return: body }`, so `$match` over
  a number raises `JQ2001 … at /$return/$match/0` natively and
  `/$where/$match/0` in the residual — the same error with two
  `path`s. Rebase the path onto the document's.
- [ ] **`$sum` over an INTEGER column past int64.** Two documents with
  `n: 2**62` make the pushed `SUM` a raw `integer overflow` from SQLite
  where the engine answers `9223372036854776000` (a double). Either the
  planner refuses `$sum` over integer paths it cannot bound, or the
  overflow becomes a coded residual — today it is the one raw driver
  error left on the query path.
- [ ] **The plain bind-time diversion is invisible.** `explain(doc,
  { externals: { flag: true } })` reports `mode: 'row'` with the native
  SQL, while `execute` with the same externals runs the whole-collection
  set residual (a boolean cannot bind); the k-nearest divert has its own
  counter, the plain one has none. `explain` should read the externals
  it is given, or the divert should count.
- [ ] **A many-to-many hop on the chain.** Relation navigation is
  desugared by the chain now: `p.author.email` and `u.posts.all()
  .count()` over an entity set lower to the correlated phrases the
  engine runs, read from the set's relation table (MODEL-FORMAT §10.1,
  QUERY-PEN §4 "relation navigation"), and the document carries no
  relation name. The one hop still refused is many-to-many (`u.labels`,
  `JL0105`): its join table is not a queryable root, so there is no
  phrase to lower to. The change that closes it: expose the join tables
  as roots in the entity engine (`$.Label_User[*]` with its two key
  columns, planned and fetched like an entity), then lower the hop
  through two equalities — `join.<Own>_key = $it.<key>` and
  `$r.<targetKey> = join.<To>_key` — under the oracle. The lowered
  shapes that do exist are residuals (a phrase where the planner wants
  a member path); their promotion belongs to the pushdown entry above.
- [ ] **Membership on an auto-keyed pending insert.** `link`/`unlink`
  shipped (MODEL-FORMAT §11.7; surfaced typed on `@jarenjs/linq/db`),
  and a pending insert with a caller-supplied key links in the same
  save; an `auto`-keyed one still cannot — the join row needs the key
  the save allocates, so the attach would have to ride the insert's
  `RETURNING` inside the same transaction, keyed back to the record.
  Until then: save, then link (the refusal says so).
- [ ] **Other SQL dialects.** The dialect seam is real (proven by a
  test double) and the capability slots for statement timeouts and
  row estimates are deliberately empty on SQLite; a second dialect is
  the day they fill. The constraint: a dialect must reproduce the
  truth table's guarded semantics, not merely parse.
- [ ] **Introspection of an existing database.** `jaren-db` plans from
  model FILES (a database stores shape hashes, not models); deriving a
  first model from a live schema is unwritten.
- [ ] **Down migrations.** Named a non-goal with its reason restated in
  MIGRATION-FORMAT §12 (a transform is not generally invertible); if
  it ever lands it is an explicit author-written document, never an
  inferred inverse.
- [ ] **Model-declared UDF-expression indexes.** The migration engine
  re-registers declared functions (`registerFunctions`) and data steps
  over UDF-indexed tables are tested; what remains is the model-level
  vocabulary to DECLARE such an index rather than hand-creating it as
  drift.
- [ ] **Cross-source linq joins beyond one store.** Two entity sets of
  one store join in one document now (a shared provider `scope`,
  QUERY-PEN §8; one statement for a bare-binding equijoin). What stays
  open is a join across two different sources — two stores, a store and
  an array — which one query document cannot spell (one input), and
  three or more bindings, which the entity translator names a residual
  (MODEL-FORMAT §10.6).
- [ ] **Replication.** Change capture (LIVE-FORMAT) is an ordered log
  of RFC 6902 patches with a monotonic sequence, and SQLite's
  changeset/conflict primitives are available — the raw material a
  replication protocol is built from. None is shipped: there is no
  conflict resolution, no site identity, no causal ordering across
  writers. This is the design constraint written down as an open
  item, not a hint that it is nearly there.
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
- [ ] **The browser store's boot has no failure surface.** Under
  contention the wasm store can fail to open and never say so: the
  studio's status line stays at `—` indefinitely while the page keeps
  claiming to be booting. Measured in WebKit under the full
  three-engine browser matrix, roughly one run in four; raising the
  wait to 90 s does not help, so it is stuck rather than slow, and
  the same load stops the page's own `load` event firing in a spec
  that touches no store at all. Alone it settles in about a second
  (8/8). What makes it awkward is that the boot spans page → worker →
  wasm → VFS acquisition, and only the last stage knows it lost a
  race, so an honest report needs each stage to time out and name
  itself rather than one outer deadline; and the reproduction needs a
  load no single user generates, which is exactly the condition under
  which "stuck" and "starved" are hardest to tell apart. The e2e
  suite absorbs it with CI retries and by running `data.spec.js`
  serially — neither of which is a fix.
- [ ] **Strong same-store transaction ownership.** MODEL-FORMAT §5.1
  states the residual plainly: a bare write issued through the STORE
  while an async top-level transaction is open joins that transaction
  and shares its rollback, because the transaction callback's `tx` is
  a view over the store that shares the store's collection/entity/
  sync handles — every operation reaches the connection through the
  one active scope, so the store cannot tell a tx-originated call from
  an unrelated caller. Today the safe shapes are "own the store" or
  "one store per concurrent writer". Closing it means scope-BOUND
  handles: `tx.collection(...)`/`tx.entity(...)`/`tx.sync` return
  handles pinned to the owning scope, and store-level handles, seeing
  a foreign scope open, wait on the connection's gate (the same queue
  an overlapping `store.transaction` already waits on, with the same
  `queueTimeout`/`JD0012` bound) or reject under an opt-in strict
  mode. The documented `store.collection().put()`-inside-the-callback
  join then becomes a self-wait that `JD0012` names — the fix is
  `tx.collection()`. Cost: one handle set per open scope, cores that
  take their scope as an argument rather than reading a shared
  variable, and the capture scope, jobs and live registry re-audited
  for which handle they hold. The pinning test
  (`test/db/transaction-ownership.test.js`, "a bare statement issued
  while a transaction is open JOINS it") flips from "pinned, not
  endorsed" to the regression for the new behavior. Raised by a
  consumer wanting one shared Fastify store; not started.
- [ ] **An as-of join with no tolerance is bounded above and not below.**
  The batched fetch is one statement whatever the probes number, which is the
  bound it was built for — but a backward join with no `tolerance` can only
  cap the far side, and at the benchmark's shape that is 99,129 of 100,000
  rows, costing 1,424× fifty-one separate index reads (published beside the
  win in the `@jarenjs/db` README). The tight lower limit is a BIND-time
  scalar, and the plan algebra's external operand emits the guarded
  two-branch text-OR-number comparison, which is not a seek: paying an OR to
  save a range is the wrong trade. Closing it means a fourth `ParamSlot` kind
  that binds a scalar of known type without the guard — a real change to a
  documented closed set, and its own decision.
- [ ] **`$overlaps` is not planned.** Two half-open spans over four declared
  columns is a conjunction of four comparisons the emitter already spells,
  and `createIntervalIndex` is the resident shape it would serve. It sits
  outside the three temporal shapes the planner closes over (range, as-of,
  fixed bucket), so adding it is a fourth recognizer rather than a widening
  of one.

- [ ] **Join tables are not queryable roots.** A many-to-many membership
  lives in a join table the store creates, plans and syncs, but the entity
  engine exposes only entity roots (`$.User[*]`), so nothing can bind
  `$.Label_User[*]` and its two key columns. Three things wait on the same
  change: the chain's many-to-many hop (`u.labels`, refused `JL0105`
  above), a query that asks about the membership itself ("which pairs were
  attached since Friday" — reachable today only through `load({ include })`
  and then in JavaScript), and a migration step that transforms a join
  table's rows. The change is to plan and fetch a join table exactly as an
  entity — a declared root with two key columns and no document column —
  under the oracle corpus that already governs entity roots. What it must
  not become is a document dialect: the lowered shape stays two
  equalities over ordinary roots.
- [ ] **A store-less document migration runner.** `migrate()` needs a
  store, because every step it runs is SQL or a data pass over tables. A
  `$migration` document's `jslt` and `query` steps, though, describe a
  transformation of DOCUMENTS, and nothing but the runner's shape stops
  them from being applied to an array in memory, to a JSON file, or to a
  collection of another engine — which is what a consumer wants when
  migrating fixtures, seed data or an export alongside a database. The
  work is a second runner over the same document, sharing the step
  vocabulary and refusing (rather than silently skipping) the step kinds
  that are physical: `ddl`, `sql` and `rebuild`. Its value is that a
  fixture and a database stop drifting apart; its risk is a second
  implementation of the same semantics, so it wants the migration
  oracle's cases run through both.
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
- [ ] **Three pens declare a class the runtime does not export, and export
  a class the declaration does not name.** `packages/linq/types/schema.d.ts`
  declares `BooleanBuilder`, `NullBuilder` and `NamedBuilder` with
  `export class`, which declares a VALUE as well as a type, while
  `packages/linq/src/schema/index.js` exports neither them nor a binding
  under those names — so `import { NamedBuilder } from '@jarenjs/linq/schema'`
  type-checks and is `undefined` at run time, and an `instanceof` against
  it throws. The other direction holds too: `NeverBuilder` and
  `createFactories` are runtime exports no declaration names, so a
  consumer who wants either cannot import it under `strict`. `model`
  repeats both halves (`EntityNeverBuilder` runtime-only, `RelationBuilder`
  declared-only) and `forms` the first (`FormNeverBuilder`). The
  constraint is that the three declared-only classes are load-bearing as
  TYPES — `types/model.d.ts` and `types/forms.d.ts` extend all three, the
  schema corpus annotates its recursive definition with `NamedBuilder`,
  and `test/consumer/linq-schema.ts` pins it — so the repair is not a
  deletion but a decision per name: export the class from the subpath, or
  declare it as an `interface`/`type` that carries no value. Either way it
  is an export-surface change, and the packed-consumer and type gates are
  what must prove it.
- [ ] **A refused `-0` is reported as `0`.** `describeValue` in
  `packages/linq/src/json-boundary.js` renders a number with `String(value)`,
  and `String(-0)` is `'0'` — so `s.number().default(-0)` refuses with
  "default() received 0, which is not JSON", naming a value the caller did
  not write. The tail of the same message says "finite numbers (never -0)",
  so the information is there, but a reader who greps their source for the
  literal the message names finds the wrong one. The constraint is that
  `describeValue` is the shared boundary every pen's `JL0101` message is
  built from and its output appears in assertions across the pen tests, so
  special-casing `-0` there is a message change with a wide blast radius
  and wants its own pass over those assertions.

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
  (<!--bm:horizon.pairwise-->0% at every budget that compacts anything except ledger/front at 20000<!--/bm-->)
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
  published whichever way it falls (<!--bm:retrieval.ranked-->5.0% of questions at 10,000 memories through the hash-trigram-64 reference embedder (33.8% at 1,000), ahead of tag match and recency's 1.3%<!--/bm-->).
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
  constant is fitted rather than guessed: <!--bm:vector.ceiling-->5.546 ns per vector component — one query reaches 100 ms at about 22,000 vectors of 768 dimensions and one second at about 234,000<!--/bm-->.
  Past that ceiling the answer is an approximate index, and it is deliberately
  not built: approximation trades the exactness that lets one query document
  answer identically in the JavaScript engine, in SQLite through the Node
  driver and in a real wasm build for a recall number nobody here has
  measured. If it is ever built, the terms are the ones
  already on the table — it starts by benchmarking against the extension this
  design already publishes itself against (<!--bm:vector.rival-->38 ms against 206 ms at 50,000 × 768 — 5.4× in sqlite-vec's favour, out of a database 6.6× smaller that holds no documents<!--/bm-->),
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
  contract.** A storage adapter is four async methods, not a transaction, and
  the ledger's header says so — but the website's assistant keeps its ledger in
  one browser storage slot that it caches in memory and rewrites whole on every
  write, so two tabs are two writers over one adapter and the last one to write
  wins wholesale. It predates the contract sentence rather than regressing
  against it, and a durable adapter does not close it either: an immediate
  transaction narrows the cross-process race but cannot end it, because minting
  an id is a read and then a write across two adapter calls. Closing it means
  either electing one writer (a lock, an owner tab) or moving the mint into the
  adapter as an atomic operation — which is a fifth method, and the fact that
  there are only four is what makes an adapter cheap enough to write.

- [ ] **Nothing evicts an archived round.** Compaction writes every dropped
  round to a slot and never deletes one, which is exactly the property that makes
  a synopsis address trustworthy — and it means a ledger grows for as long as a
  conversation does. In memory that is a session's worth of strings; over a
  browser slot it eventually meets the storage quota, where the site degrades by
  keeping the session correct (the in-memory map still answers every address) and
  losing the next visit. An eviction rule needs to answer what may be dropped
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
`packages/locales/README.md`. Two entries are left.

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

- [ ] **A chart time axis cannot be asked for a language.** All eleven packs
  carry month, weekday and meridiem names, signed relative-time phrases and
  translated date-format display names, and `compileDateLocale` reads them
  into the provider `compileDateFormat` takes (`packages/locales/README.md`).
  The Mermaid Gantt half of this is done — a diagram's `dateFormat` and
  `axisFormat` both take an injected `dateNames` record, which is exactly
  `compileDateLocale(pack).names`, and a name token with no provider is a
  refusal rather than a silent English fallback
  (`components/mermaid/README.md`). What still has no way to receive one is
  the **chart** time axis: it compiles its own numeric patterns
  (`yyyy-MM-dd`, `HH:mm`) at module load, so nothing on it is mistranslated
  and nothing on it can be localized either. The seam a chart spec should
  reuse is the Gantt's — a plain `DateNames` record threaded to the
  formatter, compiled once per render rather than per label; the open
  decision is only where in a chart spec it enters.
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

- [ ] **A benchmark suite cannot be registered with a green `npm test`.** The
  drift guard asserts the tracked `packages/website/public/benchmarks/*.json`
  match HEAD and it runs inside `npm test`, while the manifest gate asserts the
  suite order equals those tracked files exactly — so a change that ADDS a suite
  must generate the file (for the manifest) and have already committed it (for
  the guard) to make one `npm test` green, and every re-measure is red until its
  commit. Two fixes exist and choosing between them is a judgement about where
  the guard belongs: move the clean-checkout assertion out of `npm test` into
  `predeploy`, where it already runs, or teach it that an untracked new file
  whose key is in the suite order is registration rather than drift.
- [ ] **`vector.js`'s largest leg needs about 1.5 GB.** 50,000 × 768 holds one
  in-memory SQLite database of roughly a gigabyte beside a 153 MB resident
  matrix, and finishes in about ninety seconds; a memory-constrained runner
  wants `--sizes 10000`. Backing the largest leg with a file would buy the
  headroom at the price of measuring a page cache instead of a database, which
  is only worth trading once a runner actually fails.
- [ ] **Compile-mean coverage in `jslt.js`** — `COMPILE_KEYS` is `['identity', 'surgical', 'annotate']`, so the compile row's stylesheet set omits the reshape stylesheet.
- [ ] **`--cell-order` shuffle** — the 4-book singular cell reads higher than the 1000-book one run to run (JIT/IC noise across the cell sequence); a shuffle option would pin it down if it ever matters.
- [ ] **Saxon-JS as an optional competitor** — noted and deliberately excluded so far (heavyweight SEF/XSLT toolchain for a zero-build workspace).
- [ ] **Drop the fontoxpath baseline-subtraction hack if a compile-only API appears** — the jsonquery adaptor pre-converts XDM and subtracts a baseline because fontoxpath exposes no compile-only entry point; a future compile-only API would let the adaptor measure it fairly.
- [ ] **A scoped pass over the packaging documentation is owed.** The same
  reading that produced the validate/emit list above checked the packaging
  story and found ten claims worth revisiting; five were repaired at the
  campaign close-out that wrote this entry (the dependency graph's four
  missing edges, CONSUMING's `dist/types` claim and its "independent of
  that set" sentence, CONVENTIONS' count of the gates outside `site:gate`,
  the json README's `./canonical` subpath, and linq's `files` omitting
  `ARCHITECTURE.md`). What remains, each with its reproduction in the
  file it names: `scripts/release-bump.js` launches `npm` by bare name,
  which is a PATH assumption on a release path that otherwise pins its
  npm; `@jarenjs/emit`'s subpaths and its wasm helpers are undocumented
  in its README; and there is no gate holding a package README's subpath
  list equal to its manifest's `exports`, which is why these drift
  silently rather than loudly. The last is the one worth building: it
  turns the other two into test failures instead of findings.
