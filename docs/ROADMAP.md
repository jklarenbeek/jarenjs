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

- [ ] **Hoist `$`-absolute comparables out of filter loops** — inside a path
  filter, a `$`-rooted comparable (`[?@.price < $.max]`) re-walks from the
  root once per candidate node, though its value is invariant for the whole
  filter run. The obvious fix — remember the last root and its value, the
  monomorphic per-callsite cache `compileIRegexp` callers already use — is
  **wrong**: a caller may mutate the document and re-query the same object
  identity, and a root-keyed memo cannot see that. A safe version needs the
  cache reset per filter *application*, which means the predicate tree
  handing its reset hooks up to the selector that runs it. (The entry's
  former sibling, fusing adjacent singular segments, is done and was already
  done: `compileSingularGetter` flattens a whole singular chain into one
  steps array.)
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
  [its browser tests](../packages/website/README.md#browser-tests)). The
  accessibility half is untested and unclaimed: dialog focus traps and focus
  restoration under an actual screen reader, AT semantics, and
  `prefers-reduced-motion`. APP-FORMAT §8.4/§8.5 state the contracts that audit
  would have to prove.
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
- [ ] **Editor: extract to a component package** — the studio ships as a
  website mode, not a package. Extraction into a reusable
  `@jarenjs/flow` component (the `@jarenjs/md`/`@jarenjs/mermaid`
  two-layer shape) is gated on a second consumer; the engine is the
  product, the editor is the proof.

## @jarenjs/md

- [ ] **CommonMark conformance push** — 571/655 spec examples pass
  (`npm run benchmark:markdown --score-only --verbose` lists the failures).
  **47 of the remaining 84 cannot be reached at all**: CommonMark renders raw
  HTML verbatim, including a lone `</div>`, an unknown `<bab>` and a
  never-closed tag, and a vnode tree has no way to hold half an element. The
  `html: 'vnode'` mode already takes the balanced cases. What is left that is
  *fixable* is ~37 examples of real dialect gaps, in four groups worth doing
  one at a time: loose-list `<p>` wrapping (List items, Lists), emphasis
  flanking rules, link-label edge cases, and empty/`<>` destinations.
- [ ] **Parse-speed workstream** — ~0.32 ms per 10 kB to AST. A CPU profile
  says the block scan is **not** where the time is (~14%): the inline phase is
  ~36% (`parseInlines`, `resolveEmphasis`, `mergeText`, `closeBracket`) and
  hashing the source for `meta.hash` is ~10% on its own. The leads in order of
  measured weight are avoiding the adjacent-text-node merge, then deciding
  whether `meta.hash` can be computed lazily without breaking the document
  contract. A column-offset block scanner was the previous guess and the
  profile does not support it.

## @jarenjs/mermaid

- [ ] **`foreignObject` / `htmlLabels:true`** — labels are SVG `<text>` in v1 because `@jarenjs/view` has no `foreignObject`/`setAttributeNS`; revisit alongside VIEW-FORMAT §6/§8 for HTML labels and pixel-closer parity.
- [ ] **Full layout for the secondary types** — class/ER/state/gantt render as structured panels, not domain-specific layouts; mindmap/gitGraph/journey/timeline parse-accept with a placeholder. Real layouts are the next coverage push (tracked honestly in the benchmark scorecard).
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

## @jarenjs/josl

- [ ] **CSV parse speed against a codegen parser** — `udsv` reads the 10k
  record stream in ~1.5 ms against the CSV reader's ~3.0 ms, because it
  compiles a parser per schema with `new Function`. The no-codegen rule is
  absolute in this package, so closing that gap means finding it in the
  closure-compiled shape: the remaining per-cell cost is the `slice` per
  field and the object build per record. This is the same trade the
  validator and query engine record under their own codegen-backend items.
- [ ] **Stringify speed** — `stringifyJosl` runs ~2.5× behind `smol-toml`
  on the 1k-record document (6.9 ms vs 2.7 ms, `npm run benchmark:toml
  --profile`), roughly level with `@iarna/toml`. Parsing has had two
  optimization passes and now leads on small documents; the writer has had
  none, and is the larger relative gap of the two.
- [ ] **Streaming CST** — `parseJoslCst` records source spans, which only
  the whole-document driver produces; the cutter has the same slices in
  hand but reports them per cut line, without the terminator. Rewriting a
  document implies having all of it, so this waits for a consumer that
  genuinely edits a stream.

## Dates & times (cross-package)

One program. The motivating observation is that the suite does not lack a
date *library* — it lacks date *capability in its engines*: charts silently
drops date strings, gantt stores its date directives without interpreting
them, forms renders two of its three date formats as plain text boxes, and
the locale packs contain no month names at all.

The kernel (`@jarenjs/core/dates/*`), the query operators, the charts time
axis, the forms date controls and the JOSL dedup are done; what they do is
documented in `packages/core/ARCHITECTURE.md`, QUERY-FORMAT.md §8.13 and the
respective package READMEs. Three entries are left.

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
Safari and not this repo's Node ≥ 22 baseline. The string/number
representation is what `Temporal.Instant.from()` consumes, so the kernel can
delegate to Temporal internally once the baseline moves, without changing a
public surface. Building a general-purpose date *library* is therefore the one
thing to avoid.

- [ ] **Locale month/weekday names and relative time** — the 11 packs carry no
  date content, and `form/format` interpolates the format name untranslated
  (a Dutch user reads *"Moet een geldige date-time zijn"*). Month, weekday and
  meridiem names plus relative-time phrasing ("3 dagen geleden") belong on the
  existing msgid machinery, which already handles the hard plural cases
  (Russian's genitive second form, Turkish's fixed-noun suffixes, the
  no-plural languages). The constraint is why this is *not* delegated to
  `Intl.RelativeTimeFormat` despite it being free: ICU output drifts between
  Node versions, and the site is server-rendered with byte-comparison tests,
  so rendered text must come from data the repo owns. An `Intl`-backed
  provider stays available as an opt-in for hosts that want 100+ locales and
  do not need byte-stable SSR.
- [ ] **Mermaid gantt: interpret the date directives** — `dateFormat`,
  `axisFormat`, `tickInterval`, `excludes` and `weekday` are parsed into
  `meta` as strings and never interpreted, so gantt renders as a structured
  panel rather than a timeline. This is the one place in the suite that needs
  *parsing by pattern* (`dateFormat: DD-MM-YYYY`) rather than RFC 3339, which
  is why the kernel owes a `compileDateParser` as well as a formatter.
  `excludes: weekends` additionally needs working-day arithmetic.
- [ ] **`formatMinimum`/`formatMaximum` without allocating** — the bound
  comparators parse *both* the bound and the value into `Date` objects on every
  validation, where the lexical parser plus an epoch comparison would allocate
  nothing. The catch is that the current path accepts a raw `Date` instance as
  a value and compares it directly, so the fast path has to keep that door
  open or the change is not behavior-preserving.

## Geospatial (cross-package)

A PostGIS-shaped capability, ordered so each phase is independently useful.
The kernel (`@jarenjs/core/geo/*`), the GeoJSON meta-schema, the spatial query
operators, the spatial-join index, the `geoFormats` group (`geohash`/`wkt`/
`geojson`), the streaming map accumulator and the published benchmark suite
are done; what they do is documented in `packages/core/ARCHITECTURE.md`,
`packages/json/ARCHITECTURE.md`, QUERY-FORMAT.md §8.14 and the
`@jarenjs/json`, `@jarenjs/formats` and `@jarenjs/charts` READMEs. One entry
is left.

**The representation is GeoJSON, and there is no geometry type.**
[RFC 7946](https://datatracker.ietf.org/doc/html/rfc7946) is a closed JSON
vocabulary that explicitly forbids extension — the same shape as the query
format — so its objects already *are* JSON items: patchable, schema-checkable,
addressable by pointer and path. A wrapper class would break all four, exactly
as it does for dates. The RFC also **removed CRS support** and mandates WGS 84
in lon/lat decimal degrees, which deletes PostGIS's heaviest component by
conformance rather than by omission: no SRID table, no `proj4`, and no
geometry/geography duality to model. Web Mercator is needed only for
rendering, and is a projection *out*, not a CRS system.

- [ ] **Overlay operations (union, intersection, difference, buffer)** —
  deliberately last, and possibly never. This is what [JSTS](https://github.com/bjornharrtell/jsts)
  exists for, it is where floating-point robustness problems concentrate, and
  a half-correct clipper is worse than none. Everything before it has shipped,
  so if this is ever built it starts by benchmarking honestly against
  [Turf](https://github.com/Turfjs/turf) (~796k weekly downloads) and JSTS
  (~577k), and records the loss here rather than pretending the gap is small.

## Benchmarks & tooling

- [ ] **Compile-mean coverage in `jslt.js`** — `COMPILE_KEYS` is `['identity', 'surgical', 'annotate']`, so the compile row's stylesheet set omits the reshape stylesheet.
- [ ] **`--cell-order` shuffle** — the 4-book singular cell reads higher than the 1000-book one run to run (JIT/IC noise across the cell sequence); a shuffle option would pin it down if it ever matters.
- [ ] **Saxon-JS as an optional competitor** — noted and deliberately excluded so far (heavyweight SEF/XSLT toolchain for a zero-build workspace).
- [ ] **Drop the fontoxpath baseline-subtraction hack if a compile-only API appears** — the jsonquery adaptor pre-converts XDM and subtracts a baseline because fontoxpath exposes no compile-only entry point; a future compile-only API would let the adaptor measure it fairly.
