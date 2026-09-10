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

## @jarenjs/json — JSLT

- [ ] **JSLT matcher optimizer (single-walk)** — replace per-rule path pre-passes with a single multi-pattern walk, specialize location tracking by reachable modes, and use input-schema knowledge to prune impossible shape rules. The benchmark quantifies the gap: dense pure-path transforms pay ~9–12× over the raw path scan, and hand-written native JS stays 3–139× faster on real transformations — this is the main JSLT performance workstream.
- [ ] **Prepass-level pruning in the JSLT matcher** — skip re-evaluating match *paths* over unchanged regions using the changed-path feed directly, rather than discovering the reuse afterwards through the memo cache. The remaining O(change) idea now that the memo layers have shipped.
- [ ] **Standalone `@jarenjs/jslt` package** — publish the stylesheet layer as its own package only when the query-engine internals it needs have a deliberate public boundary; today the module stays colocated to avoid exposing compiler internals.
- [ ] **`$apply` mode-argument typing in the schema twins** — the draft-neutral subset forbids tuple validation, so a non-string mode in the two-item `$apply` array is compiler-rejected (JT0007) but schema-accepted. Changing this means abandoning the mechanical twin transform or changing the language encoding; documented in JSLT-FORMAT Appendix B.

## @jarenjs/json — XQuery front-end & QT3

- [ ] **`xs:*` constructor casts and more `fn:*` mappings** — the QT3 scorecard attributes the bulk of its 21k `unsupported-syntax` cases to the function library, not the language; a handful of numeric/string casts plus `fn:tokenize` moves thousands of cases into the measurable buckets.
- [ ] **Exact sequence-base lookups** — lookups on non-variable bases emit `$get`, which addresses a single item; a `$let`-wrapper emission would reproduce XQuery's per-item lookup exactly, and is the v2 candidate alongside the `!` simple-map and `=>` arrow operators.
- [ ] **1-based positional *outputs*** — `at`/`count`/`fn:index-of` surface the format's 0-based D6 values, so QT3 asserts them as wrong-value; `fn:index-of` has a cheap local emission fix, `at`/`count` would need reference rewriting. Revisit if the scorecard noise starts to matter.
- [ ] **Front-end diagnostic polish** — a bare NameTest colliding with a keyword (`let`, `order`, ...) raises `unexpected keyword` instead of `unsupported construct 'path expression'`; `=>` after a comparison RHS raises a generic error. Deliberate-diagnostic spots, baselined as known bugs in the QT3 harness.

## @jarenjs/validate

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
- [ ] **Finer `$query`/`$data` feature scan** — the compile-time scan is conservative: any schema in the compilation map containing `$query` (or `$data`) turns on instance-path building for the whole root.
- [ ] **Predicate normalization from the CLI** — `--defaults`/`--coerce` are
  booleans, so the per-node predicate route (`x-trim`, `x-coerce`, `x-default`)
  is programmatic-only; a config-file route would make it usable from the CLI.
- [ ] **Normalization across `allOf` branches** — branches run once in declaration
  order. If an earlier branch coerces `count` and a later branch supplies its
  default `'42'`, the first application returns `{ count: '42' }` and a second
  returns `{ count: 42 }`. Decide whether to preserve ordered composition or
  define cross-branch default processing before promising a fixed point; changing
  that order can affect existing normalizers.
- [ ] **ajv-style `errorMessage` `properties`/`items` map forms** — only if demand appears; the subtree prefix rule already covers what they express.
- [ ] **Relative-pointer `${...}` interpolation in message templates** — ajv-errors-style data interpolation; params already carry the offending values, so this is convenience, not capability.

## @jarenjs/forms

- [ ] **Complete stylesheet composition needs a demonstrated benefit** —
  `$fold` already supports typed-segment cursor walks; it does not parse
  RFC 6901 pointer strings or carry an array template's instance cursor
  through `$apply`. The addressing experiment and its losses are published
  in `packages/forms/README.md`; the production composer now carries data
  and initial-session cursors through its JS walk. A replacement must
  demonstrate full parity for nested array/tuple expansion, hidden fields,
  computed values, enum encoding, errors and session state, then measure
  the complete pipeline. Parameterized `$apply` remains one possible path;
  function values are neither needed nor planned for this purpose.

## @jarenjs/view & @jarenjs/app

- [ ] **Native list and grid virtualization.** The registered-widget lifecycle
  already provides the host boundary; it does not provide the windowing engine
  needed to retire `@tanstack/virtual-core`. Add a DOM-free range/measurement
  engine under `packages/core/src/virtual/` and a reusable visible collection
  in `components/collection/`, registered through the existing view widget
  lifecycle. These are planned homes, not existing exports. Expose public
  mount/update/dispose and scroll-to-key/index/offset operations. Specify stable
  item identity, fixed
  and measured sizes, overscan and pinned-item bounds, empty/hidden viewports,
  resize invalidation, scroll anchoring after insert/delete/reorder and size
  changes, and vertical/horizontal axes including RTL offsets. Qualify column
  windowing, variable row heights and browser scroll-size ceilings separately
  from the fixed-row first consumer. Observers, frames,
  elements and measurement caches remain private resources; app state contains
  JSON viewport/selection intent. Acceptance needs bounded mounted rows/cells,
  bounded cache retention and work per scroll/update, stable anchors, no
  per-scroll full-dataset render, deterministic headless range tests, and
  teardown/reinsert tests that leave no observer, listener or scheduled frame.
- [ ] **Accessible virtual collection interaction.** A window of rows is not
  yet a usable grid: compose the virtualizer with configurable list/grid
  semantics, logical row/column counts and indices, keyboard navigation,
  offscreen focus realization, single/range selection by stable identity,
  activation and return-focus behavior. Cover Arrow/Home/End/Page navigation,
  Space/Enter, scrolling to an unmounted target, focused-row removal,
  filter/sort/reload, horizontal header synchronization and editable cells
  without stealing their caret or composition events. Every active-descendant
  target must exist when exposed to accessibility APIs; pinning focus must
  obey the DOM budget. Keep selection and field policy injectable and reusable
  across lists and grids. Browser evidence must cover Chromium, Firefox and
  WebKit, zoom, touch and resize; the existing real-browser accessibility and
  native-IME audit entries remain the owners of actual assistive-technology
  and OS input-method qualification.
- [ ] **Virtual views over bounded data providers.** An array-backed widget
  does not make a much larger application bounded. Define an injected range
  provider with stable keys, query/snapshot generation, known or unknown total
  size, loading/error states, finite prefetch/cache credits and cancellation;
  stale replies cannot overwrite a newer filter, sort or scroll request.
  Compose it with existing LINQ keyset pages and live patches through host
  adapters, with an explicit capability/refusal for arbitrary index jumps when
  a provider offers only sequential continuation. Distinguish logical total
  size from loaded rows and selection intent from loaded membership. Specify
  scroll restoration, page eviction and a complete-data print/export path
  independent of mounted DOM. Prove search/sort/live updates preserve identity
  and focus while loaded bytes and mounted cells stay within declared budgets;
  keep database/worker imports out of the view engine. The component owns
  rendering and interaction, app owns the injected provider's private resource
  lifecycle, and `linq/db` owns the adapter to database pages/live results.
  Coordinate through one provider contract rather than direct component-to-db
  imports; database identity and snapshot consistency remain authoritative.

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
- [ ] **First-class awaiting action documents** — the async-task convention and `createTaskEffect` cover the pattern without a format change (`packages/app/docs/TASKS.md`); making *awaiting* expressible in the action document itself is the open half (APP-FORMAT §11).
- [ ] **Native IME verification** — composition-aware controlled writes,
  caret preservation, multiple selects and the safe create/update/remove/reinsert
  corpus are exercised in Chromium, Firefox and WebKit. The automated tests
  include synthetic composition events and Firefox's automation input sequence;
  native OS input methods still need manual coverage before claiming full
  language/input-method fidelity. VIEW-FORMAT §8 records that limit.

## @jarenjs/flow

- [ ] **Streaming dag input** — a run is one value in, one value out
  (FLOW-FORMAT §7.5); feeding a graph chunk-by-chunk from the
  `@jarenjs/josl` incremental readers is the natural 0.2 composition,
  and doing it honestly changes the node contract, so it is a format
  revision rather than an option.
- [ ] **Editor: free-form geometry** — the Flow studio lays out every
  diagram deterministically and connects by click-source-then-target;
  free-form node dragging and *persisted* positions are out of scope for
  0.1 (geometry never enters the document). A `meta.layout` side-table
  would let a user override the auto-layout without polluting the AST —
  the honest place to add it if a consumer asks.

## @jarenjs/md

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

- [ ] **`htmlLabels:true`** — labels still render as SVG `<text>`. The view renderer now supports HTML descendants of `foreignObject` and namespaced attributes; Mermaid still needs HTML-label rendering, sizing and parity tests. Safe mode intentionally excludes `foreignObject`.
- [ ] **Full layout for the secondary types** — class and ER render as structured panels, not domain-specific layouts; mindmap/gitGraph/journey/timeline parse-accept with a placeholder. Real layouts are the next coverage push (tracked honestly in the benchmark scorecard).
- [ ] **Layout/perf workstream** — dagre-lite handles ranks and straight
  edges; orthogonal edge routing, subgraph clustering and crossing reduction
  are the next levers. Edge labels now measure themselves and step aside from
  one another, so the remaining work here is the routing itself: an edge still
  runs straight from border to border and can cross a node it has nothing to
  do with.
- [ ] **More domain projections** — the geometry-free-AST-as-model idea now ships executable arrows for flat FSMs, compound statecharts and DAGs (`stateDiagram ⇄ jaren-fsm` and `flowchart ⇄ jaren-dag`, run by `@jarenjs/flow`; MERMAID-FORMAT §5.1); the remaining follow-ups on the same idea are sequence⇄orchestration/saga and ER⇄JSON-Schema+`@jarenjs/forms`.
- [ ] **Diagram tooltips** — pan/zoom/touch ship as the opt-in
  `mermaidPlugin({ interactive: true })` hydrate; per-node tooltips are the
  remaining half, and they need a hover/focus target the pure render does not
  currently mark.
- [ ] **Adopt the shared 3D kernel** — `@jarenjs/calc`'s x·y·z plotter introduced a reusable `@jarenjs/core/math` `mat4`/`project.js` kernel (matrices, projection, `surfaceNormal`, painter's-algorithm depth sort). Mermaid 3D could adopt it rather than growing its own projection math.

## @jarenjs/charts

- [ ] **Sessions for the remaining ten types** — `line`, `bar` and `candlestick` patch in place; the other ten re-render wholesale, which is correct and, at their sizes, cheap. A `heatmap` session (one cell rect per changed count) is the next one with an obvious incremental path now that the accumulator feeds it.
- [ ] **Deeper treemap nesting** — one hierarchy level ships (groups squarify, children squarify under a naming band). Arbitrary depth needs a recursive layout and a header budget that does not eat the leaves.

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

## @jarenjs/studio

- [ ] **Entity models and durable project stores** — collection models now
  run in private workers with explicit query routing, SQL plans, live results
  and seed files. The stage's operation contract addresses collections; an
  entity-only model needs entity/query controls. Durable stores and migration
  UI also need project identity, storage ownership and a migration policy:
  the current documented lifetime is in-memory, reset on committed model or
  seed changes. Reusing the data page's shared database would break isolation.

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

- [ ] **Pushdown beyond the proven scalar shapes.** Untyped group keys,
  group returns that read the grouped row binding, ordering by sum/avg
  or other unproven aggregate expressions, entity grouping, and numeric aggregates over groups still run
  in the engine. A window over a group return that can omit an item needs an
  output-cardinality proof; the proven singleton constructors already lower.
  Path comparisons outside one non-null number/string family, predicates
  whose individual leaves span bindings, and unlisted operators remain
  residual. **Semantic boundary:** promotions must preserve missing/null,
  first-occurrence order and engine errors under the indexed, unindexed and
  forced-residual oracle. A disconnected binding graph remains a deliberate
  cartesian-product refusal; removing that guard changes the join contract.
- [ ] **Projection and distinct beyond reconstructible trees.** A return
  containing an operator, a whole entity binding inside a constructor or a non-singular
  path still needs the engine. Windows over such returns are set-residual:
  source-row limits cannot stand in for projected-item limits. `$distinct`
  over an untyped or compound projection, or ordering by paths other than the
  projected scalar, also remains residual.
  **Proof still needed:** preserve output cardinality, structural equality,
  ordering and errors, and never drop a member a residual predicate reads.

- [ ] **A third SQL dialect, and the two capability slots still empty.**
  PostgreSQL and SQLite share the model, query documents and differential
  oracle. `statementTimeout` and `rowEstimates` remain absent on both.
  **Driver boundary:** the injected client contract names neither an in-flight
  cancellation hook nor an estimate-returning operation; a server timeout is
  not the store's `AbortSignal` promise. A third dialect also needs an explicit
  disposition for the SQLite-only job queue and change ledger, currently
  capability-gated refusals. This requires a driver/subsystem design, not
  setting capability flags optimistically.
- [ ] **Introspection outside the model vocabulary.** Partial indexes,
  direct SQL expression indexes and
  CHECK expressions outside the complete scalar enum grammar remain sorted
  loss rows. **Format boundary:** a partial predicate or physical expression
  index has no equivalent model declaration; emitting an unconditional index
  would strengthen its meaning. Boolean-versus-integer origins and numeric
  precision erased by storage also cannot be inferred without metadata.
  Extend the read-only inventory to every trigger and other unsupported schema
  object, including objects attached to an unmapped table; the current
  `CREATE TABLE receipt (id INTEGER PRIMARY KEY, body BLOB)` plus an
  `AFTER INSERT` history trigger reports the table as having no key and omits
  the trigger. Separate key discovery from whether the resulting table can
  be represented by the model. Report defaults, nullability, collation,
  composite-key order, foreign-key actions, generated columns, views and index
  predicates without silently weakening them. Each object must be represented
  or carry a specific sorted loss, with source DDL sufficient for review;
  strict refusal and unchanged schema/data are regression requirements.
- [ ] **Existing relational schemas without a mandatory document column.**
  Extend the hybrid entity model with an explicit physical mapping for ordinary
  column-only tables: logical-to-physical table/column names, integer and
  composite keys, database-generated identities/defaults, nullable/required
  columns, relation/join tables and read-only views. A three-column
  `app_settings(key, value, updated_at)` and an integer-key receipt table must
  be adoptable without adding `doc`, renaming objects or rebuilding the file
  merely to open it. Define SQL NULL versus JSON null/absence, safe-integer and
  decimal precision, textual JSON and date codecs, and a lossless BLOB boundary
  that does not put binary handles into JSON state. Carry supported partial/
  expression indexes, cross-column CHECKs, collations and trigger ownership
  through declaration, mapping explanation, schema comparison and migration;
  unsupported objects require an explicit preserve/refuse disposition. Do not
  infer business invariants from SQL or silently turn an introspection loss
  into permission to drop an object.
- [ ] **Declarative persistence invariants for existing histories.** Physical
  mapping alone still leaves application SQL CHECK/trigger generators in place.
  Define a bounded model vocabulary for reusable cross-field constraints,
  immutable rows/fields, write-once or draft-to-frozen transitions and declared
  revision/audit effects, with application-supplied predicates and field names.
  Reuse existing foreign keys, enums, optimistic versions and query expressions;
  account for old/new row values, insert/update/delete, null behavior, trigger
  ordering, recursion refusal and interaction with generated identities.
  Declare which invariants lower to database enforcement for every writer and
  which require a qualified store writer; runtime validation alone must not
  claim to protect external SQL. Unsupported trigger programs remain explicitly
  preserved or refused. Prove equivalent accepted/rejected mutations, error
  classification, audit rows and transaction/capture behavior through fresh
  builds and upgrades before replacing immutable-history or posted-document
  SQL. Inventory, provenance and recipe/purchase rules remain application
  declarations; Jaren owns their reusable enforcement mechanism.
- [ ] **One public transaction owner for staged SQL/model adoption.** Public
  Node/Bun drivers already own statements and savepoints, and stores already
  provide scoped sync/async transaction views. The missing bridge is a
  supported way for prepared legacy SQL, mapped entities, validation, receipts
  and `tx.jobs` to share that exact connection and transaction while a domain
  migrates incrementally. Specify statement binding/result/close contracts,
  immediate writer admission, nested savepoints, rollback and commit-failure
  propagation, and lifetime checks on retained statements and callbacks;
  synchronous callbacks must reject thenables and escaped continuations.
  Async hosts must declare the absent synchronous capability. Any trusted-host
  SQL seam needs explicit read/write authority and tracker/cache/change-capture
  invalidation, including trigger/cascade side effects; unknown effects must
  invalidate conservatively or refuse live/replication claims. Prove unrelated
  requests cannot join the transaction, rollback withdraws all model/job state,
  and neither a second connection nor an application-written driver wrapper is
  needed. This is a coexistence milestone; query migration has its own exit.
- [ ] **Native authoring for legacy query and mutation families.** Extend the
  LINQ/model/query surfaces only from an executable census of real SQL consumers:
  multi-table catalog projections, environment-qualified joins, correlated
  lookups, aggregates, compound keys, conditional updates, insert-select,
  upsert/conflict targets and affected-row/returned-value contracts. Reuse the
  shipped planner and unit of work; the existing pushdown, projection/distinct
  and live-shape entries own their unproven cases. Close additional gaps with
  declarative plans or explicitly qualified native operations, preserving
  missing/null, ordering/ties, rounding/overflow, collation, identity allocation,
  optimistic revisions and exact no-op behavior. SQL-reference and
  indexed/unindexed/forced-residual oracles must agree for reads and writes,
  including errors, emitted statements and audit effects; explain residual
  scans, resource costs and unsupported shapes. A raw SQL escape alone does
  not satisfy removal of domain SQL, and fluent syntax alone does not prove
  bounded execution or an equivalent query plan.
- [ ] **Physical preservation and recovery for relational adoption.** Extend
  the existing migration planner, assertions and table-rebuild machinery to
  the column-only mappings and preserved objects above. Separate read-only
  inspection, adopt-without-DDL and an explicitly executed migration; capture
  a consistent snapshot including committed WAL, retain unknown objects or
  refuse, and check schema, logical rows, BLOB bytes, keys, foreign keys,
  constraints and trigger behavior against both the source and a fresh target.
  Exercise populated histories, concurrent revision races, failed output/
  receipt/commit, process death during copy/drop/publication, repeated startup
  and forward repair under Node and Bun. Define compatibility with the newest
  file and post-upgrade writes before offering downgrade or restore; an older
  snapshot is not recovery for newer facts. Only qualified writer paths may
  claim capture/replication coverage, under the existing replication boundary.
- [ ] **Federation merge strategy and spilling.** Connected N-way joins and
  nested fluent joins now have an explicit fetch order and combined admission
  credits (QUERY-PEN §12.1). A merge strategy still needs a provider ordering
  guarantee. Buffered providers and intermediate byte checks cannot prevent
  allocation inside the producer; spilling or a streaming intermediate engine
  needs a separate execution contract. Ordinary unrelated-source `join()`
  remains `JL0005`.
- [ ] **Replication beyond bounded SQLite histories.** Portable envelopes,
  causal frontiers, durable receipts, transactional apply, explicit conflicts
  and bounded snapshot resets are implemented in
  [REPLICATION-FORMAT](../packages/db/docs/REPLICATION-FORMAT.md).
  **Capture/persistence boundary:** PostgreSQL declares no change capture;
  paged snapshots need snapshot identity and continuation consistency;
  receipt/tombstone compaction needs causal stability evidence beyond current
  reset credits. Journal replication explicitly refuses child cascade/set-null
  relations at open because its write journal cannot observe those database
  side effects. Removing that refusal requires transactional child before/after
  capture across all delete paths, including replay and unit-of-work writes.
  Independent field merges require a declared resolver policy.
- [ ] **Remaining incremental live shapes.**
  [The matrix](../packages/db/docs/LIVE-FORMAT.md) retains self joins,
  non-equality and unindexed joins, reverse many-to-many edges without an
  index, ordered/windowed entity joins, load-spec graphs, global-root graph
  projections, ordered/windowed distinct projections, non-canonical aggregates
  over groups and LINQ group-of-groups emission. **Maintenance boundary:**
  entity caches currently evaluate subsets keyed by distinct entity roots;
  self aliases need independent root addressing, ordered tuples need maintained
  global ordering, and group-of-groups needs another dependency level. A native
  SQL plan alone proves none of those. Offset windows remain rerun. Preserve
  row/byte credits, transactional invalidation and equal-correctness measurements
  when extending these strategies.
- [ ] **Typed SQL migration aggregates need an intermediate schema.**
  Collection counts execute through the SQL planner; other independent
  aggregates use ordered accumulators and bounded distinct retains admitted
  unique items. **Schema boundary:** a migration's baseline and target do not
  describe documents between transform steps. Typed SQL promotion needs an
  intermediate-schema contract and equivalent numeric/order/error semantics;
  inferring that schema from either endpoint can return a wrong answer.
- [ ] **An interval declaration is needed before `$overlaps` can seek.**
  The current prefilter retains malformed stored spans so the engine can raise
  the required error; that extra disjunct prevents an index seek.
  **Model-format boundary:** declaring a start/end pair as well-formed requires
  a cross-member constraint carried into DDL CHECKs, migration parity and
  introspection, plus the corresponding `createIntervalIndex` resident shape.
  Silently dropping inverted spans would violate QUERY-FORMAT §8.16.

## Lexical search (cross-package)

Catalog applications can retain MiniSearch after adopting the suite because
query `$search` is regex substring matching; the vector kernel, indexes and AI
recall solve a different retrieval
problem. The open work here is an opt-in lexical engine, with dependency-free
kernels in core where shared, query authoring in json/linq, persistence adapters
in db and host lifecycle integration in app. Package/subpath names are design
decisions, not existing exports; none requires a database or AI dependency in a
browser search consumer.

- [ ] **A compiled lexical search contract and resident index.** Define a
  versioned JSON declaration for document identity, indexed/stored fields,
  normalization/tokenization, field boosts, term combination, prefix/fuzzy
  policy, ranking and deterministic ties. Compile once; expose bounded build,
  add/update/delete/clear, search and disposal with ranked IDs, scores and
  optional match positions. Decide Unicode/case/accent behavior, punctuation,
  numbers and leading-zero identifiers, repeated tokens, empty input, exact
  identifier matching, typo-distance thresholds and expansion limits explicitly.
  Reuse core text primitives, but do not substitute regex matching or vector
  similarity for lexical relevance. Acceptance includes a catalog profile with
  title, SKU, barcode, type, category/category-search, source name and tag fields,
  application-supplied HTML-entity decoding, `prefix: true`, `fuzzy: 0.15` and
  AND term combination. Pin result membership and ordering against the installed
  MiniSearch baseline, including ties; explicit application sort must still
  override relevance without changing membership. Any ranking change requires
  a documented compatibility profile or a separately accepted migration.
- [ ] **Bounded incremental search and durable index lifecycle.** Updates must
  replace old postings and ranking statistics atomically by document identity,
  reject duplicate/stale generations according to a declared policy, and remove
  deleted content without retaining unbounded tombstones. Budget source bytes,
  token/posting counts, vocabulary, candidate expansion, returned matches and
  build/update work; distinguish an exhausted budget from a complete empty
  result. Provide cooperative batches and an injected worker protocol with
  cancellation, stale-result fencing, progress and drained teardown. Specify a
  versioned index snapshot bound to tokenizer/ranker configuration and source
  revision, validation of corrupt/incompatible snapshots, atomic publication
  and full rebuild recovery. The index is derived data, never a second catalog
  authority. Keep it outside serializable app state and prove repeated
  rebuild/navigation does not leak workers, indexes or obsolete source rows.
- [ ] **One search meaning across resident and database execution.** Give
  LINQ/query documents a deliberate lexical-search provider boundary and db an
  optional persisted-index/execution capability, without changing the existing
  `$search` operator's meaning. Specify score identity, filtering/faceting
  scope, exact counts versus top-k windows, tie-aware continuation and snapshot
  consistency so filtering a truncated candidate set cannot lose valid hits.
  Native SQLite/PostgreSQL full-text facilities are candidates only after
  tokenizer/ranking/error equivalence is demonstrated; expose residual work
  and unsupported capabilities instead of claiming dialect parity. Connect
  committed changes through the existing capture/live machinery, explicitly
  handling external SQL writers and stale index generations. Qualification
  needs labelled multilingual and identifier-heavy queries, incremental-versus-
  rebuild equality, cold/warm build/query latency, peak memory and bundle size
  against MiniSearch at the application fixture and a larger bounded corpus;
  publish relevance and performance losses alongside wins.

## Saved formulas and reviewed rules (cross-package)

The query compiler already has named pure functions/operator packs, dependency
reports and execution limits
([QUERY-FORMAT §8.12](../packages/json/docs/QUERY-FORMAT.md#812-registered-functions-operators-collations-and-execution-limits));
calc already parses and closure-compiles numeric expressions. Reuse those
engines and core math/finance/date/unit kernels. The missing application contract
below belongs across json/linq and opt-in forms/app authoring; database writes
remain behind validated domain commands. No lower-layer package imports calc
or an application component to obtain a shared parser or primitive.

- [ ] **Versioned saved formulas over structured records.** Define a reusable
  formula document/profile with language version, input/result schemas, named
  immutable bindings, declared helper names/versions and compile diagnostics
  that identify a formula and source/document location. It must cover nested
  optional fields, strings, booleans, arrays, branching and collection
  derivations as well as numeric arithmetic; calc's numeric scope alone cannot
  express a catalog formula. Prefer the existing query document as execution
  representation and, if a text front door is justified, lower it to that same
  representation with a specified round trip. Define missing/null/coercion,
  non-finite/overflow, rounding and formatting semantics; locale, clock and
  exchange/unit data are explicit inputs or named pure host capabilities.
  Compile/cache by document plus capability/schema identity, refuse missing
  helpers or incompatible versions, and keep all executors CSP-safe. Product
  helpers such as a shop's price step or field vocabulary stay in its profile.
- [ ] **Per-record results, dependencies and bounded evaluation.** Build a
  shared batch evaluator around compiled formulas with distinct JSON outcomes
  for value, skip, explanation and error; null, empty sequence and a skipped
  write must not collapse into one state, and a host's Symbol-valued `SKIP`
  sentinel must not leak into persisted documents. A failing cell/target must
  produce a bounded diagnostic and accurate aggregate counts while independent
  rows continue; disabled targets do not compile or run. Inputs stay immutable,
  evaluation receives no implicit global/IO access, and caches account for
  schema/helper/input revisions. Extend existing dependency metadata only where
  needed for field-sensitive invalidation and explicitly declared computed-
  field dependencies, including cycle refusal and deterministic evaluation
  order. Reuse query step/depth limits while exposing their actual scope:
  intermediate allocations and arbitrary host functions are not bounded by an
  output cap. Hard deadlines need an injected worker/isolate with termination,
  stale-result fencing and cleanup, never a same-thread timeout promise.
- [ ] **Explicit migration from trusted local JavaScript.** Saved column and
  rule bodies can contain statements, optional chaining, `Intl`, local
  variables and arbitrary trusted JavaScript, not just calculator expressions.
  Inventory each saved source and helper dependency; preserve original text,
  IDs, labels, enabled state and storage version in an exportable migration
  record. A converter may accept only a documented subset with differential
  fixtures for values, display text, errors, skip/explanation and rounding;
  every other body needs a precise refusal and explicit rewrite/review. Keep
  the application's existing trusted runner only as an explicitly selected
  compatibility host while migration is incomplete, without adding `eval` or
  `new Function` to Jaren or presenting that host as a sandbox. Prove repeated
  migration and rollback preserve originals and later edits. The native exit
  requires every supported saved formula to be converted or explicitly
  resolved, with no silent deletion, automatic source reinterpretation or new
  server execution of legacy JavaScript.
- [ ] **Reusable reviewed-rule planning and authoring.** Compose formulas,
  query scopes and forms into a schema-driven editor/preview and a DOM-free
  plan contract: immutable dataset/rule revisions, enabled targets, stable
  entity/field identity, before/proposed values, explanations, per-stage counts,
  report-only mode and visible diagnostics. Group/entity deduplication,
  writable fields, units, provenance protection and conflicting-target policy
  are declared by the application; siblings and group context are explicit
  data, not hidden database reads. Store the plan and selected changes, then
  revalidate authority, expected revisions and admissible values inside the
  authoritative transaction; preview evaluation never grants write authority.
  Reuse existing contract settlement and the domain receipt work below for
  replay and audit. Acceptance includes row/target failures, stale previews,
  no-op writes, conflicting changes, selection across virtual pages and a
  saved-formula editor that preserves draft text/caret; this is an application
  composition over existing engines, not another formula or rule evaluator.

## Provider execution and durable domain workflows (cross-package)

The suite already supplies ordered/drained `mapConcurrent`, AI clients with
bounded requests and retry policy, contract HTTP clients and host lifecycle
hooks, `createDbLedger(tx)` settlement, flow checkpoints, fenced jobs with
renewal/recovery, and the transactional `tx.jobs` outbox
([contract lifecycle](../packages/contract/docs/CONTRACT-FORMAT.md#77-the-host-lifecycle-identify-acquire-release-settle),
[jobs](../packages/db/docs/JOBS-FORMAT.md),
[flow](../packages/flow/README.md)). The remaining work is their composition with
external provider protocols and existing durable business facts. Reuse those
owners: core for shared scheduling, contract for execution boundaries, flow for
orchestration, db/linq for persistence, app for public run observation and ai for
its provider dialects. Provider schemas, credentials, destination policy,
inventory arithmetic and immutable business history remain application-owned;
native integration means expressing and enforcing them through public Jaren
capabilities, not replacing their meanings with a generic ledger.

- [ ] **One reusable provider execution policy.** Extract the missing shared
  transport/scheduling composition from real adapters, keeping existing AI and
  contract clients as consumers: injected transport, clock/random/sleep,
  explicit total attempts, per-attempt and overall deadlines, response/stream
  byte limits, cancellation and bounded queues/concurrency. Support per-origin/
  account start spacing and provider cost/rate observations, retry classification
  and bounded backoff with seconds/date/millisecond Retry-After dialects; define
  whether an over-budget server delay refuses rather than retrying too soon.
  Distinguish safe reads, provider-idempotent commands and single-send writes;
  never infer replay safety from an HTTP verb or a timeout. One layer owns
  retries, so SDK, client, scheduler and job retries cannot multiply attempts.
  Prove dispatch counts, fairness between scopes, no start after cancellation,
  stopped admission and drained in-flight cleanup before releasing credentials,
  leases or storage. Refactor shipped behavior through the seam only with
  differential tests preserving each client's declared defaults and wire shape.
- [ ] **Provider protocol descriptors and complete-snapshot ingestion.** Add
  an opt-in contract/adapter composition for the REST/GraphQL dialect details
  a Jaren-to-Jaren HTTP client does not describe: endpoint/API version, query/
  variable encoding, headers, response envelopes, partial GraphQL errors,
  provider IDs, pagination/continuation and error/cost extraction. Compile
  declarative transformations through existing schema/query/JSLT facilities;
  keep exceptional callbacks explicit host capabilities. Pagination needs page/
  row/byte ceilings, repeated-cursor/no-progress detection, empty-page rules,
  backpressure, cancellation and durable source/version/partition checkpoints.
  Preserve lossless staging and partial observations; publication of a complete
  snapshot requires evidence for every requested partition, with explicit
  behavior for a source changing mid-pull. Provider-specific media/binary,
  bulk-operation or upload capabilities require their own qualified descriptor,
  not a claim of universal GraphQL support. Recorded inventory and commerce
  protocol fixtures plus an unrelated provider must demonstrate reuse before retiring
  SDK/adaptor code; CSV/locale decoding stays with its existing qualified owner.
- [ ] **Destination authority and private host resources across runs.** Extend
  existing identify/acquire/release and injected effects with a documented
  composition for a persisted run whose tenant/environment/company and actor
  identity must survive navigation while credentials remain private. Resolve
  current authority before each external write, reject configuration changes
  between validation and dispatch, and define lease/resource ownership across
  OAuth refresh, account switching, worker failure, cancellation and shutdown.
  Persist opaque credential references and authority evidence only where
  appropriate, never tokens, browser handles, controllers or secrets in JSON
  state, checkpoints, replay responses or logs. Restoring a switched provider
  context must happen after all workers drain. Prove revoked access, changed
  destination, concurrent runs and late responses cannot reuse a previously
  privileged client or publish after cancellation. Generic lifecycle hooks
  must remain independent of any one provider's membership or config policy.
- [ ] **Durable domain receipts beyond an expiring HTTP claim.** The shipped
  ledger co-settles HTTP commands on a declared collection, but requires a
  finite positive TTL; local/port bindings leave settlement policy inert.
  Provide a qualified persistence/command composition for existing mapped
  receipt and immutable event tables, with shared HTTP/local/job invocation
  semantics. Define command identity and payload-hash versions, tenant/env/
  aggregate scope, collision refusal, expected revisions, replay outcome and
  current-state observation separately, current authorization for replay reads,
  and retention independent of a
  short-lived execution lease. Expiry, sweep or retryable failure must never
  authorize repeating an already recorded business mutation. Reuse the current
  required-settlement hook for same-transaction output/error validation,
  revision checks, domain writes and receipts, including deliberate validated
  failure observations that commit. Make claim/lease recovery and historical
  replay retention separate policies, with explicit migration and compaction
  rules preserving audit references. Cross-process races, invalid output,
  settlement/commit failure and restart must prove one committed domain effect
  and no second database or parallel authoritative ledger.
- [ ] **External effect reconciliation on the existing job/outbox engine.**
  Model durable preparation, frozen reviewed payload/hash, selected fields or
  legs, sending intent, attempts, confirmed success/rejection and unresolved
  outcome separately from a job lease. Commit preparation and local facts
  together, release the transaction before I/O, then settle evidence under the
  expected operation revision/fence. A crash after send and before local
  settlement, timeout, disconnect, abort or malformed response can leave an
  externally completed effect; lease expiry must not automatically resend it.
  Inject provider idempotency guarantees, correlation/read-back probes and
  explicit operator reconciliation with actor/reason evidence; absence of a
  match is proof of non-application only when the provider guarantees it.
  Partial multi-leg success remains individually recorded, and compensation
  is a separately authorized operation, not rollback of a remote system.
  Extend flow/job retry admission and recovery where needed so unknown effects
  block or reconcile while safe work resumes. Test every crash boundary and
  stale worker; exactly-once store settlement is never advertised as exactly-
  once delivery to a provider.
- [ ] **Domain run adoption, observation and audit without a second engine.**
  Compose the existing flow FSM/DAG, job fences/checkpoints and app task effect
  with mapped domain run IDs, revisions and transitions so an existing durable
  import, sync, enrichment or review run can attach, resume and cancel through
  the same public contract. Decide persisted workflow/schema identity and
  upgrade/reset compatibility before consuming old checkpoints; reset cannot
  erase immutable business facts or authorize replay of unresolved external
  effects. Expose bounded, paged public progress/events and resumable observation
  by cursor or revision, with stale-update rejection and secret-free errors;
  navigation detaches observation without implicitly cancelling durable work.
  Explicit cancellation stops admission, drains work and records its final
  observation before host resources close. Prove restart, lease takeover,
  concurrent observers, lost progress delivery and shutdown against the
  application's existing run/status semantics. This adopts orchestration;
  source provenance, review decisions, stock movements and posted history keep
  their authoritative schema and domain rules.

## Native application adoption — qualification and order

These workstreams cover five mechanisms that can remain application-owned
after adopting the suite: domain SQL/private driver bridge,
MiniSearch, virtual-core, trusted local formulas, and provider adapters/domain
ledgers.

| Retained mechanism | Roadmap owner |
|---|---|
| Domain SQL and private driver bridge | [The data pair](#jarenjslinq--jarenjsdb--the-data-pair): physical mappings, invariants, shared transactions, native queries and recovery |
| MiniSearch | [Lexical search](#lexical-search-cross-package): ranking, incremental indexes and resident/database equivalence |
| virtual-core | [View and app](#jarenjsview--jarenjsapp): windowing, accessible interaction and bounded data providers |
| Trusted local formulas | [Saved formulas and reviewed rules](#saved-formulas-and-reviewed-rules-cross-package): native profiles, evaluation, migration and reviewed plans |
| Provider adapters and domain ledgers | [Provider execution and durable workflows](#provider-execution-and-durable-domain-workflows-cross-package): scheduling, protocols, authority, receipts, reconciliation and run adoption |

Existing roadmap entries for SQL pushdown/introspection/live queries,
accessibility, IME and Studio editing remain their single owners; the additions
above define the missing adoption contracts rather than reopening shipped
engines. Search, virtualization and formula discovery can start independently.
Relational mapping and transaction coexistence precede durable domain-ledger
adoption; provider scheduling/protocol work can proceed separately, but
external-write cutover requires the receipt/reconciliation proof. Native
formula authoring can ship before legacy migration; retiring the trusted
runner waits for explicit resolution of the saved corpus.

- [ ] **Reproducible replacement evidence across applications.** Start each
  workstream with a source/API census and preserve the retained implementation
  as a differential test oracle. Provide portable, secret-free fixtures for
  an integer receipt/history trigger, column-only settings, nullable
  inventory/provenance, ranked catalog, virtual grid, saved JavaScript bodies
  and interrupted provider legs, plus a representative larger consumer with
  independently declared scale and semantics. Publish capability/refusal and
  behavior matrices, correctness/recovery results, source removed versus host
  policy retained, query/statement counts, startup and interaction latency,
  peak resident/heap memory and compressed browser bytes. Freeze workload and
  budgets before comparing; do not extrapolate a small fixture or increase a
  limit to conceal a regression. Qualify applicable public exports through
  installed npm consumers, Node, Bun, compiled standalone binaries and real
  browsers, including offline/restart and teardown. Each replacement exits
  only when the application can delete the old mechanism through public APIs,
  preserve its existing data and user-visible behavior (or an explicitly
  accepted migration), and keep its product policy; implementation, consumer
  acceptance and platform/manual evidence are separate completion claims.

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
valuable half both times. Repeated-refinement measurements now support opt-in
suppression of exact text/evidence/tag repeats. Seeded retention measurements
support reported archive budgets and lossless goal checkpoints; broader semantic
merging still needs its own outcome evidence.

- [ ] **Program reuse calibration beyond the scripted question stream.** Verified opt-in
  reuse now ships with current-environment compilation, suitability approval, an outcome
  checker and one fresh fallback. The committed question-stream frontier calibrates only
  its hash embedder and fixture labels. Real-language/provider calibration remains open.

- [ ] **Depth benefit on live models.** The original hierarchical corpus and depth-neutral
  evidence checker now run through depths zero through three. Scripted traversal remains
  correct while cost rises; current live rows fail before producing correct final answers.
  A deeper default needs the predeclared correctness/cost improvement on live models.

- [ ] **Reliable authoring under provider-enforced budgets.** Program/JSLT authoring and
  recursive live artifacts retain all failures with route identity, deadlines and usage.
  The unrecorded dense-model success claim is withdrawn. The injected router supports
  separate author/subcall routes, but current measurements do not support dense-first
  website policy; some providers exceed the requested reasoning ceiling.

- [ ] **Retrieval beyond the reference corpus remains externally unmeasured.**
  The [labelled instrument](../benchmark/README.md#labelled-recall-and-repeated-refinement)
  ships a checksum-pinned BEIR SciFact importer, live embedding cache and exact/
  approximate scorecards. The measured sparse-projection contender loses labelled
  relevance and end-to-end latency, so exact remains the choice. What remains
  open is a larger externally supplied labelled corpus and vectors sufficient to
  demonstrate a quality-preserving crossover beyond the measured exact ceiling;
  the small reference corpus cannot establish that claim. New contenders use
  the optional rank capability and the same predeclared recall/cost bars.

- [ ] **WebKit multi-writer localStorage coherence.** Exclusive Web Locks and
  reload-inside-lock still lost updates in the tested WebKit process model. The
  website therefore elects one writer tab in WebKit and explicitly refuses a
  second; closing the owner permits takeover. Chromium and Firefox use serialized
  multi-writer mutation. Re-enabling concurrent WebKit writers requires a storage
  host with demonstrated coherent reads; timing delays are not evidence of safety.

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

- [ ] **The spatial authoring profile has not met a live model.** Its three
  refusals (a geohash prefix offered as proximity, planar arithmetic over a
  coordinate member, a geographic ask with no spatial operator) are proven on
  recorded fixtures and the repair round is shown to carry the code and the
  fix; no key or local runtime was available when it was built. The first live
  run belongs as a row beside the stylesheet author's measurements in the
  `@jarenjs/ai` README. Its intent reader is an English word list — a question
  that says "in the neighbourhood of" without a listed word is not read as
  proximity, so a prefix document passes; a host can pass its own `gates`.
- [ ] **A live ordering by `$distance` re-runs.** The geofence maintains a
  `$where` per row; an `$orderby` over `$distance` (or over a member beside a
  refined predicate) and a spatial aggregate re-run on invalidation with the
  reason in `live.mode`. Maintaining a distance-ordered window incrementally is
  an incremental spatial index, which is a different campaign; the honest
  re-run is the shipped answer until it is built. **Maintenance boundary:** a new ordered spatial
  strategy must account for changed distances, window membership, ties and
  declared state credits; native bounding-box filtering alone supplies none of
  that state.
- [ ] **Overlay operations (union, intersection, difference, buffer)** —
  deliberately last, and possibly never. This is what [JSTS](https://github.com/bjornharrtell/jsts)
  exists for, it is where floating-point robustness problems concentrate, and
  a half-correct clipper is worse than none. Everything before it has shipped,
  so if this is ever built it starts by benchmarking honestly against
  [Turf](https://github.com/Turfjs/turf) (~796k weekly downloads) and JSTS
  (~577k), and records the loss here rather than pretending the gap is small.

## Benchmarks & tooling

- [ ] **`vector.js`'s largest leg needs about 1.5 GB.** 50,000 × 768 holds one
  in-memory SQLite database of roughly a gigabyte beside a 153 MB resident
  matrix, and finishes in about ninety seconds; a memory-constrained runner
  wants `--sizes 10000`. Backing the largest leg with a file would buy the
  headroom at the price of measuring a page cache instead of a database, which
  is only worth trading once a runner actually fails.
