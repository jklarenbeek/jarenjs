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
  - [ ] JSON Schema standard output formats (`list`/`hierarchical` wrappers, `evaluationPath`/`schemaLocation` renames) — the remaining half of [Fixing JSON Schema output](https://json-schema.org/blog/posts/fixing-json-schema-output); the structured params + keyed messages are exactly what that format wants
- **1.2**
  - [ ] compileAsync for asynchronous schema loading
  - [ ] JSON.parse reviver / JSON.stringify replacer integration

## @jarenjs/json — JSONPath & addressing

*The current focus.* JSON Pointer (RFC 6901), the JSONPath engine
(RFC 9535, passing the complete official compliance suite), JSON Patch
(RFC 6902) and Merge Patch (RFC 7396). See
[`packages/json/ARCHITECTURE.md`](../packages/json/ARCHITECTURE.md).

- [ ] **The `data` meta-schema rejects a `bhutton-00` relative pointer.** The
  validator reads `0+1`, `1-1/name` and `0-1#` in `data`/`$data` under
  `relativePointerDialect: 'bhutton-00'`, but the data-2022 meta-schema
  (`packages/refs/src/data.json`) still refuses such a pointer, so a schema
  validated against it fails before it compiles. Wanted: a dialect-aware
  meta-schema or a note that the option skips that check.
## @jarenjs/json — JSLT

- [ ] **JSLT matcher optimizer (single-walk)** — replace per-rule path pre-passes with a single multi-pattern walk, specialize location tracking by reachable modes, and use input-schema knowledge to prune impossible shape rules. The benchmark quantifies the gap: dense pure-path transforms pay ~9–12× over the raw path scan, and hand-written native JS stays 3–139× faster on real transformations — this is the main JSLT performance workstream.
- [ ] **Prepass-level pruning in the JSLT matcher** — skip re-evaluating match *paths* over unchanged regions using the changed-path feed directly, rather than discovering the reuse afterwards through the memo cache. The remaining O(change) idea now that the memo layers have shipped.
- [ ] **`$apply` mode-argument typing in the schema twins** — the draft-neutral subset forbids tuple validation, so a non-string mode in the two-item `$apply` array is compiler-rejected (JT0007) but schema-accepted. Changing this means abandoning the mechanical twin transform or changing the language encoding; documented in JSLT-FORMAT Appendix B.

## @jarenjs/json — XQuery front-end & QT3

- [ ] **More `xs:*` constructors and `fn:*` mappings** — the numeric, boolean and string constructors and
  `fn:tokenize` with a plain-text separator are mapped. What still hides most of the scorecard's
  `unsupported-syntax` cases falls in three groups. Mappable onto an operator the engine has: `fn:round`, `abs`,
  `floor`, `ceiling`, `round-half-to-even`, `format-number`; the derived integer types (`xs:long`, `xs:int`, ...)
  as range-checked integers; `cast as` / `castable as` for the types already mapped. Composable from existing
  operators, to be checked: `fn:remove`, `fn:insert-before` (from `$subsequence`), `fn:compare`. Needing an engine
  operator first: `fn:tokenize` with a regular-expression pattern or flags (an I-Regexp split; the plain-text
  mapping probes every position, so it is quadratic in the text length and bounded by the sequence guards),
  `substring-before`/`-after` and `translate` (nothing finds a position in a string).
- [ ] **1-based positional *outputs*** — `at`/`count`/`fn:index-of` surface the format's 0-based D6 values, so QT3 asserts them as wrong-value; `fn:index-of` has a cheap local emission fix, `at`/`count` would need reference rewriting. Revisit if the scorecard noise starts to matter.
## @jarenjs/validate

- [ ] **Per-scope static evaluated-set analysis for `unevaluated*`** — the shipped
  sibling-coverage elision compiles away the checks that are statically
  unreachable, but the genuinely dynamic cases — nested `unevaluated*`, cousin
  schemas, annotations flowing across `$ref`/in-place applicators — still pay the
  runtime evaluation log and its linear scans, and sit well behind Ajv's
  compile-time evaluated-set tracking. Computing a static evaluated set per schema
  scope (with a small dynamic remainder only where refs make it unknowable) is the
  main remaining validator performance workstream.
- [ ] **Unprefixed `query` alias / vocabulary registration** — register `$query` through a custom vocabulary and meta-schema (json-everything style) instead of only as an extension keyword.
- [ ] **A reference keeps instance locations on** — once a `$data`, `data` or `$query` reader exists anywhere in the compilation, a subtree holding a `$ref`, `$dynamicRef` or `$recursiveRef` still extends member and item locations even when what it references reads none; resolving references during the compile-time scan would let those subtrees skip too.

- [ ] **Recursion depth is the JavaScript stack.** `canonicalizeJson`, JSONPath
  `$..*`, validation of a deeply nested instance and a reference loop through
  an applicator (`allOf: [{ "$ref": "#" }]`, `anyOf: [{ "type": "string" },
  { "$ref": "#" }]` on a non-string) throw `RangeError` instead of a coded
  refusal; a depth option would turn them into one.

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
- [ ] **Editor: free-form geometry** — the Flow studio lays out every
  diagram deterministically and connects by click-source-then-target;
  free-form node dragging and *persisted* positions are out of scope for
  0.1 (geometry never enters the document). A `meta.layout` side-table
  would let a user override the auto-layout without polluting the AST —
  the honest place to add it if a consumer asks.

## @jarenjs/md

- [ ] **Canonical printing: delimiter soups.** `toMarkdown` searches a run of
  emphasis and strong a stretch at a time, paid from a per-call pool in
  proportion to what it prints, so length no longer limits it, but a stretch of
  dozens of touching delimiter nodes with no text between can exceed the pool,
  and a nesting that needs only some of one text node's `*`/`_` left bare is
  outside the spelling model; such a run prints canonically and reads back as
  other nodes, and one unspellable stretch returns the whole block to the
  canonical spelling, discarding the stretches that were solved. Content the
  search cannot spell costs far more than the single read-back it used to.
  Wanted: a guided search, a per-character bare spelling, or printing the solved
  stretches and the canonical spelling only where needed.
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
- [ ] **Diagram tooltips beyond flowchart and state nodes** — `mermaidPlugin({ tooltips: true })` ships node tooltips (focus and hover, Escape, aria wiring) for the diagram types whose render marks nodes (`flowchart`, `stateDiagram`, `jaren-dag`). The remaining types draw no marked target: sequence actors and messages, class and ER panels, gantt rows (which carry `data-id` but a different class), edges, and the secondary placeholders. Their render needs per-element markers first. The text is English-only and derived from the DOM; a Mermaid `click` line's own tooltip text is parse-accepted and not modeled in the AST.

## @jarenjs/charts

- [ ] **Sessions for the remaining nine types** — `line`, `bar`, `heatmap` and `candlestick` patch in place; the other nine (`boxplot`, `gauge`, `map`, `pie`, `radar`, `sankey`, `scatter`, `streamgraph`, `treemap`) re-render wholesale, which is correct and, at their sizes, cheap.

## @jarenjs/calc

- [ ] **Interactive plots** — drag-to-rotate for x·y·z and pan/zoom for x·y are a `hydrate` enhancement (out of scope for v1; the static SVG render is complete).
- [ ] **Programmer 64-bit state** — programmer-mode evaluation, the `=` display and the committed entry are exact to 64 bits, but the state slice holds `ans` and the memory register as JSON numbers (exact to 2^53), so a word beyond that is held rounded: `=` shows the exact word while clearing the entry afterwards, reusing `ans` and `M+` use the rounded one (an unsigned `0xFFFFFFFFFFFFFFFF` rounds up to 2^64 and shows `0x0`). Also open: a division with a remainder whose quotient is beyond 2^53 truncates (a double holds no fraction there), a scope value must still be a `Number` (a `bigint` is refused), and `toExpression` prints a literal beyond 2^53 as its nearest double. An exact `ans` needs the state schema to carry a string or bigint form (a minor).
- [ ] **More rate providers** — additional API-key-free tickers beyond CoinGecko and Binance; websocket/streaming rates are deliberately out of v1 (REST polling only).

## @jarenjs/play

The engine playground behind `#/play`: pick an engine and an example, edit the
source or the data, it runs live. Membership is a rule rather than a list — an
engine belongs here iff it is a **pure function of `(source, data)`**:
stateless, no worker, no live subscription, no side channel. That is why flow
and the document store are studio file kinds instead, and why adding an engine
costs a descriptor plus examples and no UI code at all.

- [ ] **Engines the rule admits and the registry lacks** — sixteen ship.
  `@jarenjs/linq` (a fluent chain compiles to a query document), JSONX as an
  *input* dialect rather than only an output, and the `@jarenjs/core` kernels
  the query operators already expose (geo, dates, math, text) all satisfy the
  rule and have no descriptor.
  The streaming readers are the interesting refusal: the JOSL and CSV stream
  parsers are pure, but they consume a stream rather than a string, so a
  descriptor for them first needs a source pane that means "feed this in
  chunks" — a question the `(source, data)` shape does not answer.

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
- [ ] **Pushdown beyond the proven scalar shapes.** Group keys the schema does
  not declare as scalars alone (untyped, a union that lists an object or an
  array, reached by a negative index),
  group returns that read the grouped row binding, ordering by a floating
  sum/avg or other unproven aggregate expressions and floating numeric
  aggregates without a rounding proof still run in the engine. One-root scalar
  grouping, guarded integer sums/counts, groups ordered by an integer sum/avg
  and, on SQLite, the unordered grouping of a connected join of roots now have
  native plans; over a join of roots an ordered grouping, a window over its
  groups, the nullable form of a sum and a return that reads a whole binding
  still run in the engine (tied groups would order by the first row's number,
  with a proof per ordering shape). A window over a group return that can omit
  an item needs an output-cardinality proof, and a window over groups ordered
  by an integer sum/avg needs the exactness guard read on every group, not only
  on the returned ones (`plan.windowedAccumulation`); the proven singleton
  constructors already lower. A grouping over a compound physical key whose
  order leaves two groups tied runs in the engine (`entity.groupOrder`): a
  group's first appearance is its smallest key tuple, which per-column minima
  do not give. On PostgreSQL an entity grouping lowers only over one adopted
  table with no document column; a store-owned table and any join plan the set
  residual (`bind.entityGrouping`) until the runtime guards are qualified
  there. A comparison of two paths when either is not typed as a scalar (an
  object, an array, a member with no type), an entity query's comparison of two
  paths outside one non-null number/string family, predicates whose individual
  leaves span bindings, and unlisted operators remain residual. **Semantic
  boundary:** promotions must preserve missing/null, first-occurrence order and
  engine errors under the indexed, unindexed and forced-residual oracle. A
  disconnected binding graph remains a deliberate cartesian-product refusal;
  removing that guard changes the join contract. A join equality is an edge
  only between mapped columns of one comparison family (the family the column
  stores and the engine decodes, never a union's first type) that are neither a
  boolean nor both able to read a NULL as a present `null`, so the database
  pairs the rows the engine does; an undeclared foreign key compares as the key
  it references, a nullable member whose NULL reads back as no member (every
  store-owned nullable column) still joins natively, and any other equality
  runs in the engine.
- [ ] **Projection and distinct beyond reconstructible trees.** A return
  containing an operator beyond `$default`, `$upper`, `$lower`,
  `$string-length`, `$count` and `$exists` (each over the members
  [MODEL-FORMAT §10.6](../packages/db/docs/MODEL-FORMAT.md) names), a whole
  entity binding inside a constructor or a non-singular path still needs the
  engine. So does a navigation hop that is chained, ordered inside, correlated
  across comparison families or over a column that can hold a `null`, or read
  as a value without the related entity's key. A hop over a foreign key no
  property declares stays in the engine although a join reads that key
  (`entity.hopShape`). Windows over such returns are set-residual: source-row
  limits cannot stand in for projected-item limits, and the engine evaluates
  the return of every row, so a window or a count may leave a row unevaluated
  only where the evaluation cannot raise. Over an object or array constructor
  of those operators a collection's window rides in the statement (`row`) and
  a count is a `COUNT(*)`, on a collection and on an entity; an entity window
  over an operator projection (the entity planner has no row residual; a
  per-row evaluation of the constructor over the fetched window would lower
  it), a collection's window or count beside a conjunct that runs as a
  registered function, and a bare operator as the whole return (always one
  item per row, but no constructor) are still the engine's. `$distinct` still
  runs in the engine over a leaf that may hold an object or an array (an
  untyped member, a union that lists either, a path reached by a negative
  index: the database groups an object by its text, which keeps member order,
  where the engine compares members), an array constructor, an operator, the
  document, a constructor or an ordering by other paths beside a registered
  function, and, on an entity, a distinct with an ordering of its own (numbering
  the entity rows by the order terms would lower it) or over a document member,
  an epoch or a date column (`plan.distinctProjection`, `entity.distinct`).
  **Proof still needed:** preserve output cardinality, structural equality,
  ordering and errors, and never drop a member a residual predicate reads.

- [ ] **A third SQL dialect and SQLite row estimates.**
  PostgreSQL and SQLite share the model, query documents and differential
  oracle. `rowEstimates` is filled on PostgreSQL by the planner's own labelled
  estimate (`explain().budget.estimatedRows`) and remains absent on SQLite,
  which also lacks a statement timeout. PostgreSQL now provides bounded native
  cursors, a server timeout and an optional cursor cancellation hook.
  **Driver boundary:** SQLite estimates need a per-statement estimate API that
  neither `node:sqlite` nor `bun:sqlite` exposes; a server timeout is not the
  Store's `AbortSignal` promise. A third dialect also needs an explicit
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
  Physical tables page by integer, bigint, text and uuid identities on both
  engines (a SQLite uuid by the text its table stores), an identity of NOT NULL
  terms in one direction as one row value that the key's index serves
  ([MODEL-FORMAT §10.5](../packages/db/docs/MODEL-FORMAT.md#105-pagination)).
  Relation navigation across physical layouts, a PostgreSQL page's `ORDER BY` read in
  index order (it spells `NULLS FIRST`, so the rows past the row value are sorted:
  about 14 ms for the second page of 200,000 rows against 0.016 ms read in index
  order), pushdown beyond the qualified native census and additional PostgreSQL
  types remain open. An integral literal outside a PostgreSQL `smallint` or
  `integer` physical column's own range (`qty < 3000000000` on an `integer`
  column) is refused `JD2005` through `execute`, `load` and `mutate`, because
  the server types the parameter from the column; wanted: record the native
  width at qualification (`verifyPhysical`) and fold the comparison as the
  integers the column admits, as a fraction already is, or spell the parameter
  `($n)::bigint`, which the btree integer family compares with `int4` and so
  still seeks. A partition attached to an adopted partitioned table while a
  store is open reports a duplicate key as `JD2005` naming its own constraint
  until the next open; the catalog read cannot follow it without a read on the
  failure path, which an aborted PostgreSQL transaction forbids. Capture and replication of adopted physical tables — whose application triggers and
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
  takes effect only after the copy, and only if the event loop runs it before
  the copy's closing file I/O settles; nothing else on that thread runs
  meanwhile. A Bun copy that leaves the thread free needs a worker-hosted backup
  qualified inside compiled executables
  ([HOSTS](../packages/db/docs/HOSTS.md#existing-file-adoption-and-backup)).
- [ ] **PostgreSQL entity changes beyond an unreferenced table.** A change
  the planner expresses as a rebuild (a key declaration, an `enum`, a type, a
  relation) rebuilds the table on PostgreSQL under a table lock, which holds for
  an entity no foreign key references, its own included: a referenced or
  self-referencing entity is refused at the drop (`JD0023`, naming what depends
  on it) and the link rolls back whole
  ([MIGRATION-FORMAT §10](../packages/db/docs/MIGRATION-FORMAT.md)). A rename
  of a referenced entity plans such a rebuild for every table that references
  it, so a rename alone is refused when one of those is itself referenced. Wanted:
  foreign keys re-pointed through the rebuild, or in-place `ALTER`s where
  PostgreSQL has them.
- [ ] **A rebuild that casts a number to text spells it as the engine does.**
  `5` is `5.0` on SQLite and `5` on PostgreSQL, a boolean is `1` or `0`. Wanted:
  one spelling.
- [ ] **An integer past 2^53 is stored and cast exactly but read back as
  `JD2003` on SQLite and rounded without a word on PostgreSQL.**
- [ ] **A retype check does not see a text number below the double range.**
  `1e-400`, which SQLite casts to `0.0`, passes; PostgreSQL's `0x10` and `1_000`
  spellings are refused although its cast reads them.
- [ ] **A native `$resample` window never reads the rows outside it.** `start`
  and `end` are applied by the statement, so a row outside them that the
  temporal kernel refuses (no instant, no reading) is never met, where the
  engine validates every row first and raises `JQ2001` (the operand's own
  `$where` is no case: the engine filters before the kernel too). Inside the
  window the statement counts the rows that carry no reading and hands such a
  question to the engine. Wanted: either state that the window prunes before
  validation, or a probe over the rows outside it that costs less than the
  window saves.
- [ ] **An event-time `sum` or `mean` of readings that do not add exactly hands
  a view holding two rows at one instant to a fresh run.** A bucket or rolling
  view adds rows sharing an instant in the order they reached it, a fresh run in
  the table's, so once the readings are not integers or binary fractions of a
  modest scale the view re-reads from the store for the rest of its life
  (`live.mode` `rerun`; `JD0051` under `mode: 'incremental'`). Wanted: add
  same-instant rows in table order (the position a live window already reads),
  which keeps the view maintained (LIVE-FORMAT 13.3). A rolling view over such
  readings folds the whole series on every write, which costs a few times a
  slice repair.
- [ ] **Join tables are not queryable roots.** A many-to-many join table has no
  root to bind: `u.labels` as a chain hop is `JL0105`, and a membership is read
  through `include` (`client.entities.User.include((u) => u.labels)` loads the
  rows, `{ count: true }` counts them). A question about the membership itself
  ("which pairs were attached since Friday") is reachable only by loading and
  asking in JavaScript. Wanted: a root for a join table, so a membership can be
  filtered, counted and joined in one document
  ([DB-CLIENT §6](../packages/linq/docs/DB-CLIENT.md)).
- [ ] **A handle cannot tell some chains from its own collection's.** A chain
  over rows in memory carries no collection, so
  `orders.live(from(rows).where(..))` registers its document over `orders` and
  ignores `rows` (the empty `from([])` builder is the same shape), and
  `orders.execute(from(rows).where(..))`, `query(..)` and `explain(..)` run
  that document over the handle's stored rows the same way; a chain over a
  view the client does not record (a view opened on the raw store, another
  transaction's handle, a hand-written provider) is accepted by all four for
  the same reason. Wanted: the store's collection and entity views carry their
  own name, and a chain over non-empty rows is refused by `live()`, `execute`,
  `query` and `explain` alike. The store's own members
  (`client.store.collection('orders').execute(chain)`) still read a chain as
  a document with no clauses and answer `{}`.
- [ ] **Lone surrogates and NUL in native projections.** A lone surrogate written
  as a JavaScript escape comes back from a native projection, group key or
  distinct as three U+FFFD, and `$ends-with` and `$contains` over NUL or lone
  surrogates answer differently from the engine, while the live strategies keep
  the true value, so a live result and `execute` differ. Wanted: those operands
  stay residual, or the dialect encodes them exactly.
  An exact read of a stored lone surrogate would guard every SQLite text leaf
  of a projection, group key or distinct with a byte-pattern test, which makes
  those reads measurably slower for text that never holds one, and an
  `$ends-with` that compares bytes to survive a U+0000 answers false under
  `$not` for the empty string; both mechanisms were tried and withdrawn.
- [ ] **A store profile does not yet bound every read.** A point read (`get`)
  applies the root's mandatory predicate when it names no external
  ([MODEL-FORMAT §8](../packages/db/docs/MODEL-FORMAT.md)); a root whose
  predicate names an external still answers the row of any key, because `get`
  takes no per-call externals (or `profile`). `store.observe`, capture and
  replication feeds deliver every tenant's records, a tracked `put`/`update` of
  a key `get` hides still writes the stored row, and a per-call `profile` on
  `execute`, `query` and `cursor` replaces the store's mandatory predicate
  instead of narrowing it. Wanted: per-call options on `get` that supply
  externals, the store's profile kept as a floor under a per-call one (or a
  store option that pins it), and the feeds named as host surfaces with their
  own bound.
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
  replication every create refuses `JD2104`. Wanted: every key binding — the
  entity core, the unit of work, foreign-key and membership columns, session
  capture's key decoding and the replication writer — encodes the instant
  through the column's codec, as its column stores it. A refusal of an epoch key
  (`JD0005`) was rejected: an append-only log keyed by the instant and queried
  by range answers right today (create, load, ordered load, range predicates),
  and the refusal would stop it opening.
- [ ] **Store rules judge only the store's own statements.** A row the
  database's foreign-key actions remove or null runs none of its entity's rules
  (a child's delete rule refuses its own `delete()` yet a cascading parent
  delete removes it). Journal capture now reads exactly those rows before the
  delete; judging them needs the same read under session capture and a decided
  `$.old`/`$.new` for a nulled row.
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
- [ ] **A PostgreSQL statement at the term bound can still compile for seconds.** One statement carries at most
  128 predicate terms ([POSTGRESQL](../packages/db/docs/POSTGRESQL.md)); a leaf is one term, an inequality or a
  negated comparison against an external operand on a document member counts four, and a member's membership in an
  external list counts sixteen (four in its own column, eight there under a `$not`), so the external chains that
  compiled for many seconds are the engine's. A statement the server's cost model sends through JIT is still
  compiled by LLVM, which no signal interrupts, so what remains is the weights of the other leaf kinds (none is
  known to compile slower leaf for leaf than a literal `$ne`), and a top-level `$and` of `$ne` literals over one
  member, which is presence plus one negated list and could regroup as an `$or` of equalities does, making it one leaf.
- [ ] **A mandatory predicate past the term bound still reaches PostgreSQL
  whole.** A profile's mandatory predicate with more leaves than the dialect's
  term bound demotes the document, and the residual's root fetch carries the
  whole predicate (a 200-leaf statement is sent; it answers right and `maxRows`,
  `strict` and `refuseFullScan` still bound it), and the bound's mechanism, an
  uninterruptible JIT compile, holds for that statement too: measured under a
  forced JIT, 128 terms (admitted) take 1.9 s and 800 take 22 s, a continuous
  cost. A refusal (`JD0011`) was tried and rejected: profiles of 33 external
  `$ne` terms or 65 tenant/level pairs answered right and would stop opening.
  Wanted: a cheaper spelling of the fetch's predicate (regrouping its own
  memberships), or a weight for it in the style of the external-operand weights.
- [ ] **A migration over a UTF-16 file compares a query step's text terms by
  BINARY.** `migrate` still runs on a UTF-16 file (physical-transform key pages
  read it through its own decoder), and a `query` step's native text comparison
  is code point only over UTF-8; refuse the file when a step reads text, or give
  the comparison the dialect's code-point collation.
- [ ] **A pushed string operator answers false where the engine raises.** A
  pushed `$starts-with`, `$ends-with` or `$contains` over a member typed
  `string` alone, or `string` and `null` alone (`['string', 'null']`: a plain
  column, an epoch column, a document member), answers false for a stored null
  (for the `string`-alone member also a number), where the engine raises
  `JQ2001`. The first is a document the schema forbids, reachable only on a
  store that validates nothing; the second is conforming data, kept native on
  purpose because running it in the engine costs the prefix search its index
  seek, makes `strict` refuse it on PostgreSQL and counts every fetched row
  against a profile's `maxRows`. A member of several kinds besides `null`
  (`['string', 'integer']`) and an adopted column with `null: 'null'` are the
  engine's and raise. A literal `$get` that feeds a string operator lowers only
  over a member typed `string` alone. Wanted: a guarded native form that raises
  on the null row (a native count of the rows holding a null beside the seek),
  or a decision that the native answer is the contract for a nullable string.
  A guarded form that counts the refused rows beside the seek was built and set
  aside: SQLite evaluates a registered-function term for rows an earlier
  `IN (SELECT …)` term already excludes, so it raised a false `JQ2001`, and the
  count reads every row lacking the member, turning a seek on a sparse member
  into a table scan.
- [ ] **A capture answers most array methods with a coded refusal, but not all,
  and not on a to-many relation.** `u.tags.includes('a')` and 18 more (includes,
  indexOf, lastIndexOf, some, every, filter, find, findIndex, findLast,
  findLastIndex, map, flatMap, reduce, reduceRight, forEach, slice, join, sort,
  reverse) answer `JL0108` naming the query spelling. Still a raw `TypeError`:
  `flat`, `entries`, `keys`, `values`, `fill`, `copyWithin`, `push`, `pop`,
  `shift`, `unshift`, `splice`, `toSorted`, `toReversed`, `toSpliced`, `with`
  and the string methods (`toUpperCase`, `trim`, `split`, ...). An array method
  on a to-many relation (`u.posts.some(...)`, `.filter`, `.map`) is `JL0005`
  ("fan them first (.all().some)"), advice that points at a member spelling, not
  at the predicate the reader wrote.
- [ ] **A hop member cannot be the list of `in`.** `x.in(p.author.tags.all())`
  is refused `JL0005` ('cannot follow an operator result or a relation'), where
  `.all().eq(v)` on the same hop member now fans; and `.all().all()` on a hop
  member appends a second `[*]`, as a path member does.
- [ ] **A PostgreSQL table keeps the unguarded definitions of an open-container
  index path until its index is dropped and declared again; a comparison,
  ordering or grouping over such a path reads the guarded document and does not
  seek the index.** The generated column, index expression and interval CHECK of
  a new table read an index step off an array alone (and a digit name off an
  object alone) where the schema leaves the container open; a table an earlier
  release created, or one whose model only changed how it declares the
  container, keeps whatever it holds and opens as it is, so no plan upgrades it
  (a model that moves the path between an index step and a name rebuilds the
  column). Still open: (a) a plan, or an option, that rebuilds such a column
  from the live catalog; (b) a migration document a previous release planned
  keeps creating unguarded columns (re-plan the link); (c) an earlier table
  answers `JD2005` from its CHECK where the store answered `JD2003` for an
  object keyed `0` holding a bad span, and a table that keeps its plain column
  after a declared container is loosened (`type: 'array'` or `'object'` to none)
  refuses conforming documents of the other kind (`JD2005`); (d) a digit name
  over a DECLARED object container (`type: 'object'`, `$.s['0']`) is unguarded
  text that `introspect()` reads back as an index, an interval over it does not
  reopen (`JD0002`, before and after), and the plan from a model that reads such
  a name under a guard to the model derived from the unguarded table rebuilds
  the column; (e) the seek: read the column for an open-container path when the
  plan knows the column carries the guard (the planned column's `unpinned`; a
  table holding the other spelling must keep the guarded document), or an
  expression index; (f) `memberAt` reads a negative index as absent where the
  engine counts from the end.
- [ ] **A SQLite table the previous release created keeps one of its member's types under an indexed union until a link changes the union or the column is retyped by hand.**
  Such a table opens, answers as it did and is accepted by `plan --store` and `migrate()`, but a comparison of a kind its column cannot hold reads the document and names no
  index, and it still refuses the documents the column's type cannot hold. A plan that changes the union's types rebuilds the column; a plan between identical models
  plans nothing. Wanted: a plan, or an open option, that retypes the column from the live catalog without changing the model.
- [ ] **On PostgreSQL the generated column of an indexed union member is the first type's, so a comparison of another kind reads the document and does not seek.** Wanted: a typed column per kind or an expression index.
- [ ] **An integer past 2^53 compares exactly in SQLite where the engine compares doubles.** Observed identically before this change: on every indexed union member whose column is not
  number-first (string-first, integer-first, boolean-first, `['integer','number']`), on an indexed `integer` column, and on every unindexed path, `$eq`, `$ne`, `$le` and `$gt` of
  2**60 or -(2**62) differ from the engine; and a `$seq` membership list holding such an integer misses on every number column, number-first unions included (the list element is
  an INTEGER and the column holds the double). Wanted: read both sides of a comparison as the doubles the engine compares, and bind a membership list's numbers as doubles.
- [ ] **A grouping ordered by a key that reads a NULL as a present `null` runs
  in the engine.** A column whose policy reads a NULL as a present `null`
  (`null: 'null'`) used as a group key under an `$orderby` makes the engine
  raise `JQ2005` where SQL would order the NULL, so the planner keeps the
  grouping in the engine. Wanted: a native guard that raises `JQ2005` when the
  ordered key holds a NULL, so it stays in SQL. On PostgreSQL no column of that
  policy is read natively (`nativeQuery` is false for it), so the grouped sum,
  mean and extreme there also stay in the engine; qualifying such a column would
  close both.
- [ ] **A conjunct that runs as a registered function can go unevaluated where
  the engine evaluates it and raises.** An ordered index stops at the window,
  and an index on a cheaper conjunct never visits the row, so a native window,
  count or fetch beside such a conjunct answers on SQLite where the engine
  raises (`plan.registeredFunction` keeps a window or a count over a
  constructor in the engine, but the plain-member and bare-binding plans stay
  exposed). A string operator over a member of several kinds besides `null`,
  or over a `null: 'null'` column, runs the same way, so it raises only where
  the row reaches it.
  Wanted: prove the conjunct cannot raise, or keep the engine's order of
  evaluation.
- [ ] **A native statement never reads a column its codec cannot decode.** A
  row an adopted table holds that its codec cannot decode (invalid text in a
  `date` or `datetime` column, a PostgreSQL `double precision` NaN or Infinity,
  an integer above 2^53) raises `JD2003` in the engine, which decodes the whole
  row; a native count, selection, grouping or distinct reads only the columns
  it names and answers. Wanted: count
  natively only where the table cannot hold an invalid row (a declared check),
  or read the column.
- [ ] **A row deleted and stored again with the same document leaves a window's
  tie order stale.** A transaction that deletes a row and stores it again
  unchanged writes no capture record, yet the table holds the row last, so a
  maintained ordered window (and a nested group's order) keeps it where it was
  and a fresh run orders it after its ties. Wanted: capture reports a row that
  moved, or a view re-reads positions it cannot confirm (LIVE-FORMAT section 9).
- [ ] **A native grouping cannot know its group count.** A native `$distinct`
  or `$groupby` groups every row it reads: with nearly as many groups as rows
  the statement does the engine's work and a sort besides and is slower than
  the engine, on PostgreSQL more than on SQLite. Wanted: a cost signal (a
  distinct-count estimate or a bounded-group run-time fallback).
- [ ] **Member paths outside ASCII identifiers in entity indexes, index
  conditions and database rules.** Entity index paths, index conditions and
  rule operands name members as `$.<member>` over ASCII identifiers. A member
  named otherwise (`é`, `日本`, `123`, `a b`) takes per-property
  `index`/`unique` flags but no entity index, condition or rule operand
  (`JD0004`/`JD0005` at the member). Wanted: a bracket spelling
  (`$['日本']`) through the one path resolver of the row-predicate module and
  the entity index walk, with the same oracle rows.
- [ ] **PostgreSQL verifies a physical index's condition by shape.** A
  recreated physical index with another condition reopens on PostgreSQL, where
  SQLite compares the condition's text (MODEL-FORMAT §12). Wanted: read
  `pg_get_expr(indpred)` through the relational grammar and compare it as
  SQLite does.
  A comparison through the grammar must treat as equal a commuted `AND` or
  `OR` operand order, `IN (a, b)` beside `x = a OR x = b` (and `= ANY (ARRAY[...])`),
  a flipped comparison (`5 < n` and `n > 5`), redundant parentheses and the
  server's casts and literal spellings, and it is a stated stricter refusal at
  open (a minor).
- [ ] **The ledger shape carries no sweep bound.** `createDbLedger().sweep(now?, { limit })` bounds
  one call (an ordered, index-read take of at most `limit` expired records; an answer equal to
  `limit` says more may remain). `@jarenjs/contract`'s `Ledger.sweep(now?) -> count`, its
  conformance kit and the in-memory ledger carry no limit (the memory ledger ignores a second
  argument), so a host holding only the structural shape cannot bound a sweep, and "more remain"
  is implicit (count === limit; an exact multiple costs one extra call). Wanted: a `limit` in the
  structural shape and the kit, or a result that says whether more remain (a shape change).

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
  `dateFormat`, `axisFormat`, `tickInterval`, `excludes`, `includes`,
  `inclusiveEndDates`, `weekday`, `weekend`, `topAxis` and `displayMode:
  compact` are interpreted (the last two as Mermaid reads them, from the
  diagram's config, and `topAxis` also as a header line), the tasks resolve
  to half-open intervals with dependencies and working-day arithmetic, and
  gantt renders a real timeline — the grammar, the vendored conformance table
  and the divergences are in `components/mermaid/docs/MERMAID-FORMAT.md`
  §4.4, and the kernel's half is `compileDateParser` in
  `packages/core/docs/DATES.md`. What is left is the `click` interaction
  statements — plus the eight d3 axis specifiers the conformance table now
  names as refusals rather than passing off as unknown (`%f`, `%g`, `%G`,
  `%q`, `%Q`, `%s`, `%u`, `%V`): a week-based year and a week number are a
  second year field and a derived one, so admitting them is a parts-record
  decision rather than a table entry. Note `todayMarker` is **not** on this
  list and never will be — it needs a clock, and there is none (see the
  constraint above); a host that wants "now" on a diagram supplies the instant
  as data.
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

## Benchmarks & tooling

- [ ] **The import map passes over two things Node refuses or lacks.** An export
  target that is a number or a boolean is passed over, where Node raises
  `ERR_INVALID_PACKAGE_TARGET`; refusing it would make `jaren-emit importmap`
  exit 1 on a manifest that builds a working map today, so it needs a deliberate
  decision. And following `optionalDependencies` can reach a platform-binary
  package with no JavaScript entry, whose `./index.js` is then reported
  unresolved. Neither occurs in the suite's own closure.
- [ ] **`vector.js`'s largest leg needs about 1.5 GB.** 50,000 × 768 holds one
  in-memory SQLite database of roughly a gigabyte beside a 153 MB resident
  matrix, and finishes in about ninety seconds; a memory-constrained runner
  wants `--sizes 10000`. Backing the largest leg with a file would buy the
  headroom at the price of measuring a page cache instead of a database, which
  is only worth trading once a runner actually fails.
