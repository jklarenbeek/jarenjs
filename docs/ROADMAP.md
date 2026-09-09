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
- [ ] **A runnable offline project export.** Download now preserves every file
  and the layout in a `jaren-project` JSON envelope. A `.zip` eject with a
  host page, runtime dependencies and a README remains a separate capability;
  it needs an explicit bundled-versus-pinned-CDN dependency policy.
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
- [ ] **A third SQL dialect, and the two capability slots still empty.**
  PostgreSQL 16+ ships (`@jarenjs/db/postgres`): the same model, the
  same query documents and the same differential oracle run on both
  engines, and what differs is declared in the portability matrix rather
  than discovered. What is still open is narrower than it was.
  `statementTimeout` and `rowEstimates` are empty on BOTH engines —
  PostgreSQL has a server-side `statement_timeout`, but the store's
  cancellation is an `AbortSignal` and a server timeout is not the same
  promise, so filling that slot honestly needs a cancellation hook the
  injected client contract does not yet name. A third dialect would also
  want the two SQLite-only subsystems (the durable job queue, the change
  ledger) to have a portable form; today they are declared absent
  (`capabilities.jobs`, `capabilities.changeCapture`) and refuse at open.
- [ ] **Introspection that recovers what a CHECK or a partial index
  meant.** `store.introspect()` derives a `jaren-model` from a live
  database on both engines, read-only, with a sorted loss report; the
  same logical model comes back from equivalent SQLite and PostgreSQL
  databases. What it cannot derive it REPORTS, and two of those rows are
  worth closing: an entity's `enum` becomes a CHECK on the way out and
  is not read back into one, and a partial or expression index the model
  has no vocabulary for is `unmapped-index` rather than a narrowed
  declaration.
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
- [ ] **Replication beyond bounded SQLite histories.** Portable JSON envelopes,
  replica identities, causal frontiers, durable replay receipts, transactional
  apply, explicit conflicts and bounded snapshot resets are implemented in
  [REPLICATION-FORMAT](../packages/db/docs/REPLICATION-FORMAT.md). Session and
  journal capture agree on Node and wasm; transport and resolver policy are
  host-injected. Remaining work: PostgreSQL capture/persistence, paged snapshots
  and causally safe receipt/tombstone compaction for histories beyond the
  configured reset credits, and journal capture of child cascade/set-null effects. Whole-row conflicts remain conservative; independent
  field merges require a declared resolver policy.
- [ ] **Remaining incremental live shapes.** Indexed inner/left entity joins,
  multi-entity tuple projections, bounded nested graph projections and explicit
  two-level collection groups are maintained through changed-key dependencies.
  [The matrix](../packages/db/docs/LIVE-FORMAT.md) names the residuals:
  self joins, non-equality and unindexed joins, reverse many-to-many edges with
  no declared index, ordered/windowed entity joins, load-spec graphs, global-root
  graph projections and LINQ group-of-groups emission. Offset windows remain
  rerun. [Equal-correctness measurements](../packages/db/docs/REPLICATION-FORMAT.md#measurements)
  publish initialization and high-fan-out losses beside selective maintenance.
- [ ] **Typed SQL migration aggregates need an intermediate schema.**
  Proven collection counts now execute through the existing SQL query planner.
  Other independent `$count`, `$sum`, `$avg`, `$min`, `$max` operands use
  the query engine's ordered accumulator; bounded `$distinct` retains only
  admitted unique items. Global and positional shapes materialize under
  declared row and byte limits (MIGRATION-FORMAT §6). Promoting typed
  aggregates between migration steps still needs a trustworthy schema for
  those intermediate documents and proof of equivalent numeric/order
  semantics. The baseline and target alone cannot provide that guarantee.
- [ ] **A declared task version is only as honest as the host that bumps
  it.** A checkpointed task node now declares the identity of the
  implementation it depends on, the registry must supply the same token,
  and a DAG job fingerprints the canonical version map beside the
  workflow revision and the input — so a handler reimplemented under an
  unchanged document is `JD2069` before a checkpoint is loaded
  (FLOW-FORMAT §7.8, JOBS-FORMAT §7). What no format can check is whether
  the host actually moved the token when it changed the code; that is the
  same limit the workflow revision has always had, now inherited by
  tasks. An explicit `jobs.reset(id, { expectedGeneration })` now atomically
  clears an inactive run and advances its fence for recomputation; it
  refuses stale observations and live leases. Standalone flow checkpoint
  stores must enforce their own run provenance before returning values.
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

## Benchmarks & tooling

- [ ] **Portable streaming backpressure measurement** — the fixed-heap host-seam
  test's encoded-minus-consumed count includes platform TCP buffers. Its existing
  bound can fail during a parallel suite run while the unchanged isolated test
  and full rerun pass. Define a portable measurement of queued application data
  while retaining the fixed-heap, complete-byte, hash and cancellation assertions
  in `test/contract/host-seam-e2e.test.js`.

- [ ] **`vector.js`'s largest leg needs about 1.5 GB.** 50,000 × 768 holds one
  in-memory SQLite database of roughly a gigabyte beside a 153 MB resident
  matrix, and finishes in about ninety seconds; a memory-constrained runner
  wants `--sizes 10000`. Backing the largest leg with a file would buy the
  headroom at the price of measuring a page cache instead of a database, which
  is only worth trading once a runner actually fails.
