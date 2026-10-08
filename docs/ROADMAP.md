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

Reusable host helpers now cover [bounded file tokens and route subscriptions](../packages/app/docs/APP-FORMAT.md),
the [owned native dialog](../packages/view/docs/VIEW-FORMAT.md), and
[ordinary-panel drag sources](../components/collection/docs/COLLECTION.md).
Public consumers exercise disposal, interrupted interaction and three browser
engines; the manual device and assistive-technology qualification below remains
open. [Signed Node continuations](../packages/contract/docs/CONTRACT-FORMAT.md)
bind injected host context, while [CSV formula neutralization](../packages/josl/FORMAT.md)
is an opt-in formatter policy with unchanged default bytes. SQLite
[async jobs, committed feeds and separate-file receipt replay](../packages/db/docs/HOSTS.md)
have source and isolated-package fixtures. These source capabilities do not
establish registry publication or downstream acceptance.

- [ ] **Collection platform and large-source qualification.** The [reusable collection](../components/collection/docs/COLLECTION.md) and [injected provider coordinator](../packages/app/docs/COLLECTION-PROVIDER.md) cover fixed/measured axes, keyed interaction and bounded page caches. Remaining work is segmented logical scrolling beyond the conservative CSS extent ceiling, physical touch-device qualification, actual assistive technology and native OS IME sessions, and complete sequential database snapshots/index seeks backed by an independently qualified source contract. Keep the retained virtualizer oracle until real downstream/manual acceptance permits retirement; installed synthetic consumers alone do not authorize an external cutover.

- [ ] **Real-browser accessibility audit** — the *lifecycle* half of the matrix
  ships (the website's Playwright suite drives the built site through Chromium,
  Firefox and WebKit on every push — see
  [its browser tests](../packages/website/README.md#browser-tests)), and so does
  the `prefers-reduced-motion` half: the site's motion layer is asserted under
  both emulated preferences in all three engines, including that `reduce`
  yields final states on first paint with no animation at all (DESIGN §6/§10).
  The collection matrix also exercises pending active descendants, keyed focus/selection, anchored scroll, RTL and editable controls. What stays untested and unclaimed is the assistive-technology half: dialog
  focus traps and focus restoration under an actual screen reader, and AT
  semantics. APP-FORMAT §8.4/§8.7 state the contracts that audit would have to
  prove.
- [ ] **First-class awaiting action documents** — the async-task convention and `createTaskEffect` cover the pattern without a format change (`packages/app/docs/TASKS.md`); making *awaiting* expressible in the action document itself is the open half (APP-FORMAT §11).
- [ ] **Trusted inline-handler strings differ between renderers.** A trusted
  handler string (`onclick: '…'`) is dropped on the DOM property path while
  SSR writes it as a live attribute. This needs an explicit trusted-mode
  policy and a rule in the shared property table before either renderer changes.
- [ ] **Native IME verification** — composition-aware controlled writes,
  caret preservation, multiple selects and the safe create/update/remove/reinsert
  corpus are exercised in Chromium, Firefox and WebKit. The automated tests
  include synthetic composition events and Firefox's automation input sequence;
  the collection also covers synthetic composition during scroll and focused-row removal. Native OS input methods still need manual coverage before claiming full
  language/input-method fidelity. VIEW-FORMAT §8 records that limit.

## @jarenjs/flow

- [ ] **Streaming dag input** — a run is one value in, one value out
  (FLOW-FORMAT §7.5); feeding a graph chunk-by-chunk from the
  `@jarenjs/josl` incremental readers is the natural 0.2 composition,
  and doing it honestly changes the node contract, so it is a format
  revision rather than an option.
- [ ] **A whole-graph checkpoint rule in the pen's types** — the flow pen's
  types refuse a checkpoint on an unversioned task node, but a graph with a
  checkpoint on its input node and an unversioned task elsewhere type-checks
  and only `compileDag` refuses it (`JF0011`). "Any checkpoint means every task
  is versioned" is a property of the whole graph, which the builder's types
  would have to carry from node to node.
- [ ] **Editor: free-form geometry** — the Flow studio lays out every
  diagram deterministically and connects by click-source-then-target;
  free-form node dragging and *persisted* positions are out of scope for
  0.1 (geometry never enters the document). A `meta.layout` side-table
  would let a user override the auto-layout without polluting the AST —
  the honest place to add it if a consumer asks.

## @jarenjs/contract

- [ ] **A retry policy on a subscribe operation is never read.** `policy.retry`
  on a subscribe operation compiles and has no effect, since a stream is not
  retried as a call is. The `retry-on-undeclared` lint flags an entry that names
  a stream code, but an entry naming a declared code passes. Refusing a retry
  policy where it cannot apply is a lint rule of its own.

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
- [ ] **Programmer 64-bit precision** — the expression evaluator surfaces programmer-mode results as `Number`, so a result beyond 2^53 is rounded before the four-base display wraps it to the word (`0xFFFFFFFFFFFFFFFF` displays `0x0`; [CALC-FORMAT](../components/calc/docs/CALC-FORMAT.md) says so). A BigInt-valued evaluation path would close the gap.
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

- [ ] **Expression indexes on entities.** An entity declares composite,
  unique and partial indexes over its members (MODEL-FORMAT §9.2), but an
  entry with an `expression` is refused (`JD0004`, §7A): an entity table has
  no generated column to carry the expression, and SQLite maintains an index
  over a function only on a connection that registered it, so every other
  writer of the table — the raw SQL client a database rule exists for
  included — could no longer insert or delete a row. Wanted: a carrier for
  the expression on entities as a collection has one, or an expression the
  engine evaluates on every connection, with the row-predicate module's call
  nodes (§7A), open verification, the migration planner's index diff and
  introspection.
- [ ] **Database invariants over a store-owned layout, beyond its scalar
  columns.** A store-owned entity takes `enforcement: "database"` rules over
  the scalar and foreign-key columns its table maps, installed with the table
  and verified at every open (MODEL-FORMAT §13.4). Still refused (`JD0005`): a
  rule that reads an epoch member, a member the document holds or a relation;
  an `audit` or `effects`, whose trigger writes journal capture cannot see;
  and `$exists-row`, whose probe needs the target table's key columns and
  their declared types. Wanted: those, and a decision whether a store rule
  should see the rows a foreign-key action writes, which a database rule
  judges and a store rule never does. Introspection reports such a table's
  triggers as unmapped objects, so a model derived from the database neither
  reopens nor migrates to the authored one. Every PostgreSQL open reads each
  store-owned table's triggers and rewrite rules with a query per table (about
  1.2–1.5 ms each); one read per namespace would bound it.
- [ ] **Pushdown beyond the proven scalar shapes.** Untyped group keys,
  group returns that read the grouped row binding, ordering by sum/avg
  or other unproven aggregate expressions, multi-root entity grouping and floating
  numeric aggregates without a rounding proof still run in the engine. One-root
  scalar grouping and guarded integer sums/counts now have native plans. A window over a group return that can omit an item needs an
  output-cardinality proof; the proven singleton constructors already lower.
  Path comparisons outside one non-null number/string family, predicates
  whose individual leaves span bindings, and unlisted operators remain
  residual. **Semantic boundary:** promotions must preserve missing/null,
  first-occurrence order and engine errors under the indexed, unindexed and
  forced-residual oracle. A disconnected binding graph remains a deliberate
  cartesian-product refusal; removing that guard changes the join contract.
  Two native entity equality joins already pair differently from the engine: over
  a nullable member the database pairs no nulls where the engine pairs `null`
  with `null` (a live registration follows `execute`), and between differently
  typed columns (text `'7'` against integer `7`, `1` against `true`) SQLite's
  affinity pairs rows the engine and the live strategies leave apart. Wanted: the
  planner guards the pairs it cannot prove, or the join documents the database's
  pairing as its contract.
- [ ] **Projection and distinct beyond reconstructible trees.** A return
  containing an unproven operator (restricted correlated counts are now native),
  a whole entity binding inside a constructor or a non-singular
  path still needs the engine. Windows over such returns are set-residual:
  source-row limits cannot stand in for projected-item limits. `$distinct`
  over an untyped or compound projection, or ordering by paths other than the
  projected scalar, also remains residual.
  **Proof still needed:** preserve output cardinality, structural equality,
  ordering and errors, and never drop a member a residual predicate reads.

- [ ] **A third SQL dialect and native row estimates.**
  PostgreSQL and SQLite share the model, query documents and differential
  oracle. `rowEstimates` remains absent on both; SQLite also lacks a statement
  timeout. PostgreSQL now provides bounded native cursors, a server timeout and
  an optional cursor cancellation hook. **Driver boundary:** estimates need a
  qualified estimate-returning operation; a server timeout is not the Store's
  `AbortSignal` promise. A third dialect also needs an explicit
  disposition for the job queue and journal concurrency/coverage. PostgreSQL
  now qualifies managed journal capture and the shared leased job queue with
  concurrent claims and fenced checkpoints. Remaining subsystem work needs backend strategies, not
  setting capability flags optimistically.
- [ ] **Introspection outside the model vocabulary.** A collection's
  partial index, an entity's partial index whose condition does not read back
  into the query grammar, direct SQL expression indexes and
  CHECK expressions outside the complete scalar enum grammar remain sorted
  loss rows. **Format boundary:** such a partial predicate or physical expression
  index has no equivalent model declaration; emitting an unconditional index
  would strengthen its meaning. Boolean-versus-integer origins and numeric
  precision erased by storage also cannot be inferred without metadata.
  Physical inventory now reports rowid/composite keys, source programs, defaults,
  nullability, FK actions, generated columns, views and predicates independently
  of derivation. The explicit SQLite structural vocabulary now authors these declarations
  ([native SQLite programs](../packages/db/docs/SQLITE-RELATIONAL.md)); automatic
  lossless derivation remains open. PostgreSQL now inventories schema-qualified
  keys, exact types, constraints, opclasses, functions, RLS and identity sequences;
  adoption does not infer
  application intent from their DDL.
- [ ] **Broader relational mapping and query qualification.** Explicit SQLite and PostgreSQL
  column layouts, codecs, read-only views and composite-key join-table entities
  are supported ([MODEL-FORMAT §12](../packages/db/docs/MODEL-FORMAT.md#12-existing-column-layouts)).
  Physical tables page by integer, bigint and text identities on SQLite
  ([MODEL-FORMAT §10.5](../packages/db/docs/MODEL-FORMAT.md#105-pagination)).
  Relation navigation across physical layouts, keyset continuation over a `uuid`
  key (it reads back lowercase whatever the table stores, so its decoded value does
  not compare as the stored one) and over any physical table on PostgreSQL,
  pushdown beyond the qualified native census and additional PostgreSQL types remain
  open. Capture and replication of adopted physical tables — whose application triggers and
  cascades the store does not write — remain refused until their complete writer population has
  an executable oracle.
- [ ] **Broader database invariant lowering.** Rules lower to verified triggers
  on SQLite and PostgreSQL alike ([MODEL-FORMAT §13](../packages/db/docs/MODEL-FORMAT.md#13-persistence-invariants)),
  over comparisons, membership, existence probes keyed by a verified unique
  index and integer `$add`/`$sub`/`$neg` inside the safe-integer domain.
  Still outside: `$mul`, `$div`, `$idiv`, `$mod` and arithmetic over a
  `number` operand (the engine's double rounding and division are not SQL's);
  `$starts-with` (a code-point prefix spelling and an oracle of its own on each
  engine); an arbitrary trigger program (a `TableTrigger` stays SQLite SQL); a
  probe of the rule's own table (PostgreSQL runs row triggers at statement end
  and SQLite per row); an aggregate over other rows; and the stored-row walk of
  a migration that adds a rule (it judges no stored row today). Store-only rules
  retain their explicit writer qualification. SQLite's change test compares
  each column under its declared collation and stored spelling (§13.4), where
  PostgreSQL and the store compare by codec; comparing by code point would
  change the text of every installed update program, so it waits for a
  reviewed migration of installed programs.
- [ ] **Broader native authoring for legacy SQL.** The executable census now
  proves five adopted-column read families and three SQLite mutation families
  ([native contracts](../packages/db/docs/NATIVE-PLANS.md)). Receipt history
  retains SQL because its table has no declared primary key. The explicit SQLite surface now supports correlated/computed selections,
  cross-table insert-select and partial/expression conflicts. Entity `mutate`
  also admits adopted PostgreSQL column layouts, but the frozen census, its
  parity, no-op and rollback proofs and the benchmark are SQLite-only: the same
  three families on PostgreSQL, with PostgreSQL reference SQL, remain open, as
  do promotions into the JSON query semantic contract and store-invariant bulk
  preimages. Additional promotions need retained SQL/decoded-row parity, no-op
  and rollback proofs, and explicit work costs; fluent syntax alone is not
  evidence.
- [ ] **Relational recovery beyond the qualified SQLite hosts.** Explicit
  preservation plans, consistent committed-WAL backups, interrupted rebuild and
  publication recovery, and forward repair from the newest file are exercised
  under Node and Bun ([MIGRATION-FORMAT](../packages/db/docs/MIGRATION-FORMAT.md#existing-physical-files-and-forward-recovery)).
  PostgreSQL now uses the shared receipt and preservation executor for reviewed
  native catalog targets, recorded dependencies and sequence allocation guards;
  independent-database shadow replay retains exact qualified programs.
  PostgreSQL coherent dump/restore and archived-WAL recovery now have
  [separate managed-data oracles](../packages/db/docs/POSTGRESQL.md).
  Physical-schema cutover, power-loss durability, deployment beyond the qualified
  Linux executables and actual downstream cutover still require named evidence.
  On Bun a backup's copy runs on the calling thread, because Bun's `node:sqlite`
  backup performs every step before it returns: a deadline or an abort raised
  from `onProgress` stops it between pages, but an abort from a timer or I/O
  takes effect only after the copy, and nothing else on that thread runs
  meanwhile. A Bun copy that leaves the thread free needs a worker-hosted backup
  qualified inside compiled executables
  ([HOSTS](../packages/db/docs/HOSTS.md#existing-file-adoption-and-backup)).
- [ ] **PostgreSQL entity changes beyond an unreferenced table.** A change
  the planner expresses as a rebuild (a key declaration, an `enum`, a type, a
  relation) rebuilds the table on PostgreSQL under a table lock, which holds for
  an entity no foreign key references, its own included: a referenced or
  self-referencing entity is refused at the drop (`JD0023`, naming what depends
  on it) and the link rolls back whole
  ([MIGRATION-FORMAT §10](../packages/db/docs/MIGRATION-FORMAT.md)). Also open
  on PostgreSQL: a key that gains `default: 'auto'` after creation opens but
  cannot allocate (no sequence), a key that drops it and is then referenced by a
  new entity cannot create the foreign key, and folding a numeric or text column
  into the document fails. Wanted: foreign keys re-pointed through the rebuild,
  or in-place `ALTER`s where PostgreSQL has them, key allocation converted by a
  planned step, and the same chain qualified on both engines.
- [ ] **Duplicate keys classified by the key's own constraint.** PostgreSQL
  reports a duplicate key by the constraint's generated name; the classifier
  recognizes `<table>_pkey` with the server's clipping and numeric suffix, so a
  table renamed by a migration keeps its old name and reports `JD2005` where a
  fresh store reports `JD2001`, and a unique member literally named `pkey<N>`
  reads as the key. Wanted: the key constraint read from the catalog at open.
- [ ] **Native temporal buckets sum floating readings in SQL.** Collection and
  entity sums over `number` members run in the engine, left to right in doubles;
  a `$time-bucket` or `$resample` sum over a `number` member is still summed by
  the database (`1e16, 1, -1e16` answers `1` where the engine answers `0`), and
  over integer-valued `number` readings Node's SQLite binding can raise `JD2005`
  or `JD2003` ([MODEL-FORMAT §10.6](../packages/db/docs/MODEL-FORMAT.md)).
  Wanted: the series planner keeps these sums residual with a named reason, as
  the collection planner does.
- [ ] **Join tables are not queryable roots.** A many-to-many join table has no
  root to bind: `u.labels` as a chain hop is `JL0105`, and a membership is read
  through `include` (`client.entities.User.include((u) => u.labels)` loads the
  rows, `{ count: true }` counts them). A question about the membership itself
  ("which pairs were attached since Friday") is reachable only by loading and
  asking in JavaScript. Wanted: a root for a join table, so a membership can be
  filtered, counted and joined in one document
  ([DB-CLIENT §6](../packages/linq/docs/DB-CLIENT.md)).
- [ ] **An aggregate method on a captured value ignores its argument.**
  `g.items.sum((r) => r.score)` emits `$sum` over the rows and fails `JQ2001` at
  run time, in memory and on a store alike; the documented spelling fans first
  (`g.items.all().score.sum()`, QUERY-PEN). Refusing an argument the capture does
  not read changes the capture's surface, so it needs a decision.
- [ ] **Live evaluation compares group keys and documents by a sorting
  serialization.** A group key computed to a non-finite number (`$div` by zero)
  shares or misorders live groups, because a live group is keyed by
  `stableStringify` where the engine keys by `stableKeyString`, which
  `@jarenjs/json/query` does not export; and live results and replication compare
  documents by `stableStringify` equality (`live.js`, `live-nested.js`,
  `replication.js`), which ignores member order, so a write that only reorders a
  stored document's members counts as no change and a registration keeps serving
  the previous order. Wanted: export the engine's group-key identity and key live
  groups by it; and either compare with member order
  (`semanticKey(value, { ordered: true })`), accepting a re-emission on a
  reorder-only write, or state that a stored document's member order is not part
  of its value.
- [ ] **Live registrations take unchecked options and share capture records.**
  Unknown live option keys (`mod`, `eventtime`) are ignored, and a valid
  `eventTime` on a document that is not temporal is ignored too; the window and
  rows strategies hold the capture record's inserted object, so a
  `store.observe` observer that mutates its record rewrites `live.result`.
  Wanted: `store.live` validates its option keys (`externals`, `mode`,
  `eventTime`), a decision on `eventTime` over a non-temporal document, and
  records frozen at capture or copied per registration.
- [ ] **A chain handed to another source's `live()` runs against the wrong
  collection.** `client.collections.orders.live(<a chain over users>)` registers
  the users chain's document against `orders`: a chain's run bindings carry no
  source. Wanted: the chain carries its source and `live()` refuses a chain over
  another source.
- [ ] **Lone surrogates and NUL in native projections.** A lone surrogate written
  as a JavaScript escape comes back from a native projection, group key or
  distinct as three U+FFFD, and `$ends-with` and `$contains` over NUL or lone
  surrogates answer differently from the engine, while the live strategies keep
  the true value, so a live result and `execute` differ. Wanted: those operands
  stay residual, or the dialect encodes them exactly.
- [ ] **A store profile bounds query documents, not every read.** On a store
  opened with a profile, a point read (`get`, collection or entity) answers the
  row of any tenant, `store.observe`, capture and replication feeds deliver every
  tenant's records, and a per-call `profile` option on `execute`, `query` and
  `cursor` replaces the store's mandatory predicate instead of narrowing it
  ([MODEL-FORMAT §8](../packages/db/docs/MODEL-FORMAT.md)). Wanted: the predicate
  applied to point reads, the store's profile kept as a floor under a per-call
  one (or a store option that pins it), and the feeds named as host surfaces
  with their own bound.
- [ ] **Federation merge strategy and spilling.** Connected N-way joins and
  nested fluent joins now have an explicit fetch order and combined admission
  credits (QUERY-PEN §12.1). A merge strategy still needs a provider ordering
  guarantee. Buffered providers and intermediate byte checks cannot prevent
  allocation inside the producer; spilling or a streaming intermediate engine
  needs a separate execution contract. Ordinary unrelated-source `join()`
  remains `JL0005`.
- [ ] **Replication beyond bounded managed histories.** Portable envelopes,
  causal frontiers, durable receipts, transactional apply, explicit conflicts
  and bounded snapshot resets are implemented in
  [REPLICATION-FORMAT](../packages/db/docs/REPLICATION-FORMAT.md) on SQLite and
  PostgreSQL, under session and journal capture alike, including the rows
  foreign keys remove or null. Paged snapshots need snapshot identity and
  continuation consistency; receipt/tombstone compaction needs causal stability
  evidence beyond current reset credits. Independent field merges require a
  declared resolver policy. Concurrent structural changes — a child added on one
  replica under a parent another replica deletes — refuse on both sides
  (`JD2104` where the deletion arrives, `JD2005` where the child arrives) and
  need a reset; no structural conflict policy exists. An envelope no write order
  can replay — values rotated between rows, or a row that must be written both
  before a removal and after it — refuses `JD2005` or `JD2104`. A store on
  several PostgreSQL sessions (`sessions` above 1) refuses `replication`
  (`JD0009`): its pages, snapshots and applies are qualified on one session.
- [ ] **Instant keys kept as epoch columns.** A `date-time` or `date` key
  declared `column: "integer"` is stored — the column holds the epoch, the
  document the string — but no later statement names its row: `get`, `update`
  and `delete` bind the string against the integer key column, so SQLite finds
  no row (`get` answers `undefined`, `update` refuses `JD2006`, `delete` answers
  `false`) and PostgreSQL refuses `JD2005`; a foreign key or membership naming
  such a row refuses `JD2005` on both engines; session capture records the row
  under its epoch where journal capture records the string; and under
  replication every create refuses `JD2104`. Either every key binding — the
  entity core, the unit of work, foreign-key and membership columns, session
  capture's key decoding and the replication writer — encodes the instant as its
  column stores it, or the model refuses an epoch key (`JD0005`).
- [ ] **A write that collides on its key and on another unique member reads
  two codes.** Single collisions agree on both engines (key `JD2001`, unique
  member `JD2005`); a write colliding on both at once reads `JD2001` on
  PostgreSQL and, under a non-integer key, `JD2005` on SQLite, because each
  engine reports the first constraint it checks. Agreeing on `JD2001` needs a
  key read after a SQLite unique failure that does not name the key, on every
  insert path (entity create, unit-of-work batches, collections, the
  replication writer).
- [ ] **Store rules judge only the store's own statements.** A row the
  database's foreign-key actions remove or null runs none of its entity's rules
  (a child's delete rule refuses its own `delete()` yet a cascading parent
  delete removes it). Journal capture now reads exactly those rows before the
  delete; judging them needs the same read under session capture and a decided
  `$.old`/`$.new` for a nulled row.
- [ ] **A `setNull` relation over a required member.** The model accepts a
  `setNull` relation whose via member is required or non-nullable; the
  database's set-null then stores a row that member's schema rejects (`get`
  answers the document without the member). Wanted: the model refuses the
  relation (`JD0005`), or reads its via member as nullable.
- [ ] **Remaining incremental live shapes.**
  [The matrix](../packages/db/docs/LIVE-FORMAT.md) still re-runs ordered groups,
  ordered or windowed distinct projections, windowed groups and windowed
  aggregates over groups, LINQ group-of-groups emission and LINQ chains that
  order, window or deduplicate after `groupBy`; ordered or windowed entity
  queries; global-root graph projections and graph projections whose child
  sequence is ordered; entity aggregates and object-root entity documents;
  whole-query floating `sum` and `avg` over a `number` member, whose
  left-to-right addition the engine decides; a projection that reads the
  collection root; self joins inside a graph projection or an allowing-empty
  join; non-equality joins; unindexed joins, reverse many-to-many edges
  included; and every registration on a store opened with a profile.
  **Maintenance boundary:** a group is maintained by recomputing only the groups
  a change touches, which needs every output to depend on one group's rows —
  ordering, windows or distinct across groups and a second grouping level break
  that; ordered entity tuples need maintained global ordering; a nested self-join
  binding still reads the outer root; and a profile's predicates, member lists
  and limits must apply to every row maintenance admits, inserted documents
  included. A native SQL plan alone proves none of those. **Position boundary:**
  a row deleted and inserted again with an equal value in one transaction
  reaches capture as no change, so a registration keeps its old place for the
  row while a fresh run lists it last, until a later change to that row reaches
  capture. **Policy, not mechanism:** a join dependency needs a primary-key
  prefix, a declared index or a mapped foreign-key index, although maintenance
  answers reverse lookups from its own in-memory indices; relaxing that rule
  would maintain unindexed equi-joins and reverse many-to-many edges, and is an
  operator decision. The bounded database range adapter publishes source resets
  through committed capture; it does not close these incremental cases. The
  optional durable `resnapshot` mode covers bounded async queries on PostgreSQL
  and Node SQLite hosts, including cross-Store commits, revision races and
  retention resets; it does not claim incremental maintenance for these shapes.
  Preserve row/byte credits, transactional invalidation and equal-correctness
  measurements when extending these strategies.
- [ ] **Typed SQL migration aggregates need an intermediate schema.**
  Collection counts execute through the SQL planner; other independent
  aggregates use ordered accumulators and bounded distinct retains admitted
  unique items. **Schema boundary:** a migration's baseline and target do not
  describe documents between transform steps. Typed SQL promotion needs an
  intermediate-schema contract and equivalent numeric/order/error semantics;
  inferring that schema from either endpoint can return a wrong answer.
- [ ] **Long membership chains over a PostgreSQL collection member.** A
  same-member `$or` folds into one bound list, and an entity column answers a
  chain of equalities quickly, but a chain that cannot fold over a collection's
  document member compiles to a `CASE` over `jsonb_typeof` per term: 2,000 terms
  over 2,000 documents take about 16 s, and a 5,000-term chain kept a backend
  running after its client went away, past both `pg_cancel_backend` and
  `pg_terminate_backend`. Wanted: the typed fold a column gets, or a bound on the
  terms such a chain may compile to.
- [ ] **A join over a `$range` inner source runs as a nested loop.** The
  engine builds its hash, spatial and interval probes over an uncorrelated
  inner binding on the first outer tuple, but it declines a `$range` source and
  answers that join by the nested loop (the json package's ARCHITECTURE, "Interval
  joins"): the same pairs, order and first error, quadratically — about 178 ms for two 2,000-item ranges where a
  probe over a materialized source takes 1 ms. Wanted: build the probe by
  counting when the range fits the guard that bounds a materialized source
  (`JQ2007`), keeping the nested loop's pairs, order and errors.
- [ ] **A capture argument answers `JSON.stringify` and array methods with raw
  host errors.** Every unknown name on a captured value is a member proxy, so
  `JSON.stringify(x)` of a capture argument recurses until a `RangeError` and
  `x.tags.includes('a')` is a raw `TypeError` instead of a coded refusal.
  Wanted: a `toJSON` special case in the value proxy's `get` (that would shadow
  a member of that name, which `get('toJSON')` still reaches) and an `apply`
  trap for array methods, each answering a coded refusal that names the
  query-language spelling.

## Lexical search (cross-package)

The [resident lexical contract](../packages/core/docs/SEARCH.md), explicit JSON/LINQ
provider boundary, source-validated db snapshots and injected worker lifecycle are
implemented. The [measurements](../benchmark/README.md#lexical-search-qualification)
qualify the retained cold ranking profile on frozen synthetic corpora.

- [ ] **Downstream relevance and migration acceptance.** Run the actual
  application corpus through the declared tokenizer/ranker and host decoding
  policy. Review ranking, tie and resource differences before removing the
  retained engine from a real consumer. Synthetic portable qualification does
  not establish production relevance or host-wide memory limits.
- [ ] **Native full-text execution.** Qualify SQLite/PostgreSQL tokenization,
  ranking, ties and errors before promoting a dialect index. The current db
  adapter reports bounded resident residual work; PostgreSQL external-writer
  capture needs its own platform proof. Optional match positions remain open.

## Saved formulas and reviewed rules (cross-package)

Versioned native profiles, bounded per-record outcomes/dependencies, explicit
subset migration, terminating workers and reusable reviewed-rule authoring are
implemented in [FORMULA-FORMAT](../packages/json/docs/FORMULA-FORMAT.md) and
[@jarenjs/rules](../components/rules/README.md). Reviewed writes use the existing
validated command/receipt transaction with current-authority and snapshot checks.

- [ ] Resolve real saved-source corpora with application owners. The
  translator covers a measured corpus with every remaining difference named and
  positioned; what stays open is what such a corpus needs beyond the translated
  subset — regular-expression captures (`.match(…)[n]`) and a first-occurrence
  `.replace`, a string-or-array `.length`/`.includes` on a field no host schema
  types, and each application's helper and result policies, which decide the
  differences a translation names. Retain the application-selected trusted
  runner until every original is resolved.
- [ ] A per-dimension unit registry: `$quantity` carries every dimension's unit
  table, though its words name only mass, volume and length, because the
  registry is one module.
- [ ] Qualify real downstream adoption, physical-device behavior and manual
  accessibility. Automated synthetic Node/Bun and browser results do not prove
  those host/operator outcomes.
- [ ] Consider a textual formula front door only after a measured corpus
  justifies its grammar and a round trip into the existing Query representation.

## Provider execution and durable domain workflows (cross-package)

The suite already supplies ordered/drained `mapConcurrent`, AI clients with
bounded requests and retry policy, contract HTTP clients and host lifecycle
hooks, `createDbLedger(tx)` settlement, flow checkpoints, fenced jobs with
renewal/recovery, and the transactional `tx.jobs` outbox
([contract lifecycle](../packages/contract/docs/CONTRACT-FORMAT.md#77-the-host-lifecycle-identify-acquire-release-settle),
[jobs](../packages/db/docs/JOBS-FORMAT.md),
[flow](../packages/flow/README.md)). The remaining work extends their composition with
external provider protocols and existing durable business facts. Reuse those
owners: core for shared scheduling, contract for execution boundaries, flow for
orchestration, db/linq for persistence, app for public run observation and ai for
its provider dialects. Provider schemas, credentials, destination policy,
inventory arithmetic and immutable business history remain application-owned;
native integration means expressing and enforcing them through public Jaren
capabilities, not replacing their meanings with a generic ledger.

The bounded provider read and ingestion composition now has public owners:
[core retry and scheduling](../packages/core/docs/SCHEDULING.md),
[contract descriptors and private run authority](../packages/contract/docs/PROVIDER-FORMAT.md),
[flow ingestion](../packages/flow/docs/WORKFLOW-FORMAT.md#complete-provider-ingestion)
and [transactional staging/publication](../packages/linq/docs/DB-CLIENT.md#complete-ingestion-store).
Three recorded dialects and two installed Node/Bun consumers qualify bounded
reads, authority revalidation, lossless accepted pages, crash recovery, complete
partition publication and identical-input no-op behavior. The original reference
fixtures remain executable; these results do not retire external SDKs or qualify
production cutover. Streaming DAG input is not required by this composition.

- [ ] **Provider extensions and live adoption.** Qualify real provider authority,
  credential refresh/account restoration and read-back on their actual hosts
  before downstream cutover. Media/binary, bulk-operation and upload protocols
  require separately qualified descriptors; they currently refuse before
  dispatch. SDK transports must prove one request per admitted attempt and bind
  provider idempotency explicitly. External writes use the durable
  receipts and reconciliation composition; single-send classification alone cannot
  resolve an uncertain remote outcome. Application membership, destination and
  reconciliation rules remain injected, including preservation of manual facts.
- [ ] **Existing business-history adoption qualification.** The public
  [durable command composition](../packages/contract/docs/DURABLE.md) now
  co-settles validated HTTP/local/job commands over mapped application tables,
  with permanent replay, separate leases and bounded migration/compaction.
  Qualify each downstream application's historical outcome mapping, hash-version
  policy, retention rules and existing transaction owner before cutover. Other
  operating systems and PostgreSQL remain unqualified beyond the combined Linux executable and
  installed Node/Bun SQLite evidence; arbitrary historical schemas and destructive
  retention policies are not inferred or supported automatically.
- [ ] **Provider-specific external reconciliation acceptance.** The
  [fenced effect composition](../packages/flow/docs/WORKFLOW-FORMAT.md#domain-run-and-external-effect-adoption)
  records reviewed legs, sending intent, uncertainty and explicit reconciliation
  on the existing job engine. Real-provider qualification must establish key
  scope/retention, correlation/read-back guarantees, absence semantics and
  authoritative outcome classification. Exercise real disconnect, timeout and
  lost-settlement boundaries, then obtain application/operator acceptance for
  manual reconciliation and separately authorized compensation. Synthetic
  exactly-once local settlement does not establish exactly-once remote delivery.
- [ ] **Application run lifecycle adoption.** The public
  [mapped run and observation adapters](../packages/linq/docs/DB-CLIENT.md#durable-mapped-records)
  preserve run identities, workflow/schema provenance and bounded progress while
  reusing workflow checkpoints and job fences. Qualify each application's
  historical status vocabulary, public-summary projection, upgrade/reset policy,
  remote cancellation boundaries and host resource lifecycle before cutover.
  Source provenance, review decisions and posted history retain their domain
  schemas and rules. Other operating systems, PostgreSQL and downstream/manual
  acceptance remain open beyond the combined Linux executable proof; synthetic
  restart, takeover and observer evidence do not substitute for those runs.
  A conformance kit for host-owned run tables — tests a host runs against its
  own table to prove it keeps the run store's contract — is an open decision:
  the store's adapters are typed for every durable client, and no host has
  needed the kit to adopt them.

## Native application adoption — external qualification

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

The [public disposition ledger](ADOPTION-EVIDENCE.md#request-disposition-ledger)
reconciles the library requests and selected older clauses against their owned
contracts and executable evidence. Library completion and synthetic portable
qualification are established within those scopes. Each external retirement
entry remains pending until its actual host and operator evidence exists.

- [ ] **External adoption acceptance.** Qualify real labelled/saved-source
  corpora, actual provider-platform guarantees, downstream cutover, manual
  accessibility and native OS IME, other operating systems and PostgreSQL.
  Existing combined journeys qualify Node/Bun installations, Linux standalone
  executables and automated browser composition only. Keep original sources
  and retained oracles until their qualified retirement; synthetic passes never
  authorize a downstream deletion or increase a budget.
- [ ] **WebKit offline page navigation.** Offline database reopen, ingestion
  and reconciliation pass on the qualified WebKit host, but offline page reload
  reports an internal navigation error. Qualify navigation itself before claiming
  complete offline browser recovery. Chromium and Firefox already exercise it.
- [ ] **Combined resource qualification.** Exact peak heap and host-wide remaining
  handles need a matching measurement for each combined host/workload. Sampled
  heap, process high-water RSS and focused component teardown do not fill those
  cells in the [complete budget comparison](ADOPTION-EVIDENCE.md#complete-frozen-budget-comparison).

## Windows qualification (cross-package)

Nothing below has run on Windows; [HOSTS.md](../packages/db/docs/HOSTS.md)
says as much of the owner lease. Hosted CI runs on Linux only, and the
[Windows workflow](workflow/WINDOWS.md) is opt-in. These behaviours depend on
Windows file locking, sockets, process termination, timers, links or line
endings in ways a Linux run cannot show, so each needs a run on a Windows
machine — the opt-in workflow or a local one — and its result recorded here.

- [ ] **Files and SQLite locking.**
  - A refused `openStore` (a malformed option value) creates no file and
    holds no handle: its temp directory is removable at once.
  - The owner lease (`test/db/owner-lease.test.js`): a second process refused
    while the first holds it, a killed holder's lease expiring, `close()`
    releasing at once, a read-only open never refused. `BEGIN IMMEDIATE` under
    the lease bracket and the renewal's busy wait meet Windows file locking;
    `child.kill('SIGKILL')` is `TerminateProcess`, so a killed child's handle
    may outlive it for longer; the renewal test runs on the wall clock (3 s,
    margins of 150 ms).
  - Two worker-thread stores racing on one file
    (`test/db/collection-expect.test.js`, 300 rounds of `BEGIN IMMEDIATE`,
    bounded by the 5 s busy timeout), and a second `DatabaseSync` holding a
    writer while a store refuses options.
  - Keyset pages over adopted files, including a malformed-UTF-8 key
    (`test/db/physical-page.test.js`); list membership on a file-backed store
    read by a second connection (`test/db/list-membership.test.js`,
    `test/linq/list-membership.test.js`).
  - Migrations: host steps on a worker store (`migrate-host-step`), foreign
    keys with a raw second connection writing an orphan (`migrate-foreign-keys`),
    atomic runs, adopted history and the planner goldens, whose JSON fixtures
    rely on LF checkouts (`.gitattributes` sets `eol=lf`).
  - Every test and README example that removes a temp directory after
    `close()`: watch for `EBUSY`/`EPERM` when a worker's handle outlives it.
- [ ] **Worker and pool hosts.** `test/db/relational-store.test.js` and
  `quirks-relational.test.js` (`node-worker` and a WAL `node-pool` over a temp
  file: the reader-lane assertion and the WAL sidecars); the hold limit, retry
  and connection loss (`transaction-hold`, `transaction-retry` with its README
  runner, `connection-loss`, `quirks-transactions` with 100 ms holds near the
  limit); `pool-parallel-reads` (a held read given back on close within
  2,500 ms). A worker `endpoint` is a URL: on Windows it is
  `pathToFileURL(path)`, never a `C:\` path. Compiled executables are
  qualified on Linux only.
- [ ] **Sockets.** `test/contract/node-framework.test.js` drives Fastify over
  loopback: its slow reader depends on loopback buffering (Winsock's smaller
  buffers should give up sooner; the bound reads `writableHighWaterMark`), and
  its chunked-upload 413s rely on the linger that keeps an RST from eating the
  answer. `server-surface-quirks.test.js` and `binding-quirks.test.js` open real
  servers on `127.0.0.1`; `test/contract/cli.test.js` spawns `node` in a temp
  directory and removes it.
- [ ] **Processes and runtimes.** The cross-process ledger test
  (`test/linq/db-ledger.test.js`) spawns `node --input-type=module -e` or
  `bun -e`; `test/db/numeric-keys.test.js` and `migrate-foreign-keys` spawn
  `bun` when present, which must resolve to `bun.exe`.
- [ ] **Links, paths and line endings.** `buildImportMap` compares real paths
  and reports URLs and duplicates with `/`; `test/emit/importmap.test.js` builds
  its fixture behind a junction (no privilege needed), and a short `8.3` temp
  path is the case to watch. The task documents (`test/linq/app-tasks.test.js`,
  `test/app/tasks.test.js`) and the formula corpus split their text on LF, which
  `.gitattributes` keeps; the translator counts CRLF as one line break.
- [ ] **PostgreSQL from Windows.** `test/db/postgres-sessions.test.js` and the
  other server tests against a Windows-hosted or remote server: their timing
  bounds (an unrelated call under 250 ms, tracked work under 500 ms) assume a
  local one. Its server-less part opens two SQLite connections to one file and
  closes a store with transactions in flight.
- [ ] **Timers, focus and input.** `test/app/settled.test.js` and
  `test/view/controlled.test.js` schedule with `setTimeout(…, 0)` and wait on
  promises; the focus end-to-end test uses real keyboard input, where OS-level
  IME and focus behaviour is what a Windows run would surface. The ICU
  cross-check of number formatting skips unless the runtime's ICU is the one it
  was measured against.

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
and LIVE-FORMAT; AI spatial authoring obligations belong to the application that hosts the model; the `geojson` preview hint in the `@jarenjs/forms` README;
and the one-document-three-executors claim in `docs/ARCHITECTURE.md`. What is
still open is listed here, each with its reason.

- [ ] **A live ordering by `$distance` re-runs.** The geofence maintains a
  `$where` per row; an `$orderby` over `$distance` (or over a member beside a
  refined predicate) and a spatial aggregate re-run on invalidation with the
  reason in `live.mode`. Maintaining a distance-ordered window incrementally is
  an incremental spatial index, which is separate work; the honest
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

- [ ] **The import map reads `exports` and `main` as Node does, short of three
  edges.** A `main` that names a missing file is taken literally, where Node also
  tries `main.js` and `main/index.js` before `./index.js`; an export target that is
  a number or a boolean is passed over, where Node raises
  `ERR_INVALID_PACKAGE_TARGET`; and following `optionalDependencies` can reach a
  platform-binary package with no JavaScript entry, whose `./index.js` is then
  reported unresolved. None occurs in the suite's own closure; each needs a
  deliberate rule for which of Node's fallbacks a browser map should copy, since a
  map cannot probe the file system at load time as Node does.

- [ ] **`vector.js`'s largest leg needs about 1.5 GB.** 50,000 × 768 holds one
  in-memory SQLite database of roughly a gigabyte beside a 153 MB resident
  matrix, and finishes in about ninety seconds; a memory-constrained runner
  wants `--sizes 10000`. Backing the largest leg with a file would buy the
  headroom at the price of measuring a page cache instead of a database, which
  is only worth trading once a runner actually fails.
