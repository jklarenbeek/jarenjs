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
[`packages/json/ARCHITECTURE.md`](packages/json/ARCHITECTURE.md).

- [ ] **Custom JSONPath function extensions** — a registry per RFC 9535 §2.4 with
  declared parameter/return types, so user functions get the same compile-time
  well-typedness checks as the five built-ins. Today `FUNCTIONS` in `src/path.js`
  is a module-private table with a single lookup site and no mutation path, and
  `compileJSONPath(source)` takes no options argument — so the work is as much
  about threading a registry through every entry point (`compileJSONPath`,
  `queryJSONPath`, `isValidJSONPathStrict`, the query normalizer's
  `parsePathString`, `write.js`, the JSLT dispatcher) as about the registry
  itself. It also forces a decision the single table currently avoids: the
  `json-path` **string format** resolves to `isValidJSONPathStrict`, so a
  registry means deciding whose extensions a format assertion validates against.
- [ ] **Early-exit iteration for non-singular queries** — `query.first()` and
  `query.exists()` already ship, and for *singular* queries they are already
  allocation-free. For non-singular ones both call `runSegmentsV` and materialize
  the entire nodelist before looking at one element. Making them stop at the first
  hit, and adding `query.iterate(data)` as a generator yielding nodes on demand,
  is the open half. (`compileExists` in `src/segments.js` has the same fallback,
  so it is not a ready-made implementation.)
- [ ] **`json-path-segments` format for variable-rooted paths** — the query schema
  pattern-checks only the *head* of a variable-rooted path string (`$b.price[…]`);
  the full segment grammar is enforced later by the compiler (`JQ0004`). An
  absolute path gets `"format": "json-path"` and therefore schema-time
  well-formedness; a variable-rooted one gets nothing equivalent. A
  `json-path-segments` format would close that asymmetry — and would have to be
  applied across all six schema twins that replicate the definition.
- [ ] **Canonical JSON (RFC 8785 / JCS)** — deterministic serialization for hashing
  and signing. Two near-duplicate starting points exist and a JCS item has to
  reconcile them as well as add the strictness: `stableKeyString` in the query
  runtime deliberately emits `NaN`/`Infinity` bare (so `NaN` groups with `NaN`,
  per XQuery) where JCS requires rejecting those inputs, and serializes numbers
  with a raw `String(n)` rather than the number-to-string discipline JCS mandates;
  `stableStringify` in `@jarenjs/core/object` instead follows `JSON.stringify`
  conventions (`NaN` → `null`, `undefined` members dropped). Neither validates
  ill-formed strings.
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
- [ ] **Minimal array diffs in `createJSONPatch`** — the array diff is a
  prefix/suffix trim plus index-wise recursion, so a mid-array insertion degrades
  to a run of per-index `replace` ops. Correct, but not minimal; an LCS mode would
  emit the insertion. Relevant to anyone shipping patches over the wire.
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

- [ ] **Filter optimizer / hash joins** — hoist `$`-absolute comparables out of filter loops, fuse adjacent singular segments, and turn `$where` equijoins into hash joins instead of nested loops (the benchmark's join row is O(books × ratings) today; a hash join changes the complexity class, not just the constant).
- [ ] **Lazy sequences / lazy `$range`** — `$range` materializes eagerly; the default `JQ2007` resource guard (2³² items) can never trigger before the heap does (found by the QT3 harness, 6 baselined resource-bomb skips). `options.limits.sequenceItems` lets a host tighten the guard deterministically; true lazy sequence evaluation remains the structural fix.
- [ ] **`steps`/`depth` execution limits** — `options.limits` deliberately rejects them with a `TypeError` because the closure-compiled engine has no instrumented evaluation core to enforce them; accepting an unenforced limit would be a silent false guarantee. Enforcing them means threading a counters context through the compiled closures (a measured-overhead design question).
- [ ] **`$allowing-empty` and window clauses** — the two FLWOR constructs v0.1 leaves out (outer-join-style iteration and `tumbling`/`sliding` windows).
- [ ] **Higher-order operators** — user-supplied functions for map/filter/fold shapes; requires a function-value story the JSON encoding deliberately does not have yet.
- [ ] **Date/time operators** — `@jarenjs/core/dates` exists as the foundation; the operator registry makes the addition mechanical.
- [ ] **Closed-world compilation mode (`JQ0005`)** — a mode requiring all variables bound at compile time; today free variables are externals by default and `JQ0005` fires only for unknown `$as` names.
- [ ] **`compileTypeTest` hook diagnostics** — the hook contract passes `docPath` so future hooks can report schema-compile diagnostics positionally; the reference `createTypeTestCompiler` ignores it today.
- [ ] **`__proto__` member construction in query constructors** — `compileObject`/`compileMap` assign `out[name] = value`, so a *constructed* member named `__proto__` sets the result's prototype instead of a member. The JSLT dispatcher and `@jarenjs/core/object`'s `setObjectMember` already rebuild `__proto__` as an own property; the query-engine member appliers should adopt the same pattern.
- [ ] **Non-JSON `queryFn(data)` input** — a compiled query passed `undefined`/non-JSON returns non-JSON without a special-case guard; decide whether to reject or document the pass-through.
- [ ] **Spec patch batch for QUERY-FORMAT.md §6.5** — the proposed wording for multi-item/empty grouping keys (`JQ2001`/allowed), `NaN` grouping equality and `NaN` order-by placement is implemented and tested but not yet folded into the normative text.
- [ ] **Spec patch: member-value cardinality (§3.1/§3.5.2) and the `$string` cast table** — the normative wording for object-construction member values (an empty result omits the member; two-or-more items is `JQ2001`) plus the `$string`/`$concat` cast table (`number → String(n)`, booleans, `null → "null"`) is implemented and tested but not yet folded into QUERY-FORMAT.md.
- [ ] **Spec examples: `$let`-bound sequences vs child filters (§5.1) and `$where` reading its own `$count` (§9)** — two correct-but-surprising behaviors worth a worked example in the spec: a `[?…]` filter on a `$let`-bound item sequence selects the *children* of each item (so an item-level predicate yields empty), and clause scope order lets `$where` observe the phrase's own `$count` name as an external.

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
- [ ] **`required` short-circuit reports only the first missing property** — the historical `&&=` collection short-circuit means each object surfaces only its *first* missing `required` property, even in collect-all-errors mode.
- [ ] **Type-only `items` fast path aggregates per-item failures** — the type-only `items` fast path reports a single error at the array path instead of one error per failing item; the multi-keyword path already yields per-item errors.
- [ ] **`additionalProperties: false` instancePath divergence from ajv** — Jaren points the error at the offending member (`/nested/extra`) where ajv points at the parent object; deliberate and spec-truer, tracked so consumers diffing against ajv output know it is intentional.
- [ ] **Unprefixed `query` alias / vocabulary registration** — register `$query` through a custom vocabulary and meta-schema (json-everything style) instead of only as an extension keyword.
- [ ] **Cross-root compile memo for registered schemas** — a *registered* schema whose `$query` literal `$ref`s that same registration compiles a fresh root per hook invocation and can recurse at `compile()` time; a cross-root memo would close this compile-time foot-gun.
- [ ] **Finer `$query`/`$data` feature scan** — the compile-time scan is conservative: any schema in the compilation map containing `$query` (or `$data`) turns on instance-path building for the whole root.
- [ ] **`data` next to `$ref` in 2019-09+** — `$query` was added to the `$ref`-sibling keyword list; `data` has the same latent gap and still relies on pre-existing behavior.
- [ ] **ajv-style `errorMessage` `properties`/`items` map forms** — only if demand appears; the subtree prefix rule already covers what they express.
- [ ] **Relative-pointer `${...}` interpolation in message templates** — ajv-errors-style data interpolation; params already carry the offending values, so this is convenience, not capability.

## @jarenjs/forms

- [ ] **Stylesheets replacing the JS composition step** — `buildFormViewModel`
  composes the render tree in JS. A stylesheet cannot replace it because
  rendering a form is a **two-cursor walk**: the schema-derived model says what
  a field is, the data says what it holds, and a JSLT rule descends only the
  one input document it matched. Either primitive would unblock it, and neither
  exists: **a fold** (`$get` is a real dynamic lookup, so walking a runtime
  pointer needs only a reduce over its segments — see *Higher-order operators*),
  or **a parameterized `$apply`** that carries a second cursor down with the
  matched node. Deciding which is the language question to answer first.
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
  [its browser tests](packages/website/README.md#browser-tests)). The
  accessibility half is untested and unclaimed: dialog focus traps and focus
  restoration under an actual screen reader, AT semantics, and
  `prefers-reduced-motion`. APP-FORMAT §8.4/§8.5 state the contracts that audit
  would have to prove.
- [ ] **DOM-adopting hydration & fragment roots** — VIEW-FORMAT §6/§8: adopt server-rendered markup instead of empty-and-rebuild; allow list roots.
- [ ] **First-class awaiting action documents** — the async-task convention and `createTaskEffect` cover the pattern without a format change (`packages/app/docs/TASKS.md`); making *awaiting* expressible in the action document itself is the open half (APP-FORMAT §11).

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

- [ ] **`foreignObject` / `htmlLabels:true`** — labels are SVG `<text>` in v1 because `@jarenjs/view` 0.1 has no `foreignObject`/`setAttributeNS`; revisit alongside VIEW-FORMAT §6/§8 for HTML labels and pixel-closer parity.
- [ ] **Full layout for the secondary types** — class/ER/state/gantt render as structured panels, not domain-specific layouts; mindmap/gitGraph/journey/timeline parse-accept with a placeholder. Real layouts are the next coverage push (tracked honestly in the benchmark scorecard).
- [ ] **Layout/perf workstream** — dagre-lite handles ranks and straight edges; orthogonal edge routing, subgraph clustering and crossing reduction are the next levers.
- [ ] **More domain projections** — the flagship `stateDiagram ⇄ @jarenjs/app` workflow ships; flowchart⇄DAG executor, sequence⇄orchestration/saga, ER⇄JSON-Schema+`@jarenjs/forms` are follow-ups on the same geometry-free-AST-as-model idea.
- [ ] **Interactive hydration** — pan/zoom/tooltips as an optional client-only plugin (`hydrate` is a no-op today because the render is complete).
- [ ] **Adopt the shared 3D kernel** — `@jarenjs/calc`'s x·y·z plotter introduced a reusable `@jarenjs/core/math` `mat4`/`project.js` kernel (matrices, projection, `surfaceNormal`, painter's-algorithm depth sort). Mermaid 3D could adopt it rather than growing its own projection math.

## @jarenjs/charts

- [ ] **Sessions for the remaining nine types** — `line`, `bar` and `candlestick` patch in place; the other nine re-render wholesale, which is correct and, at their sizes, cheap. A `heatmap` session (one cell rect per changed count) is the next one with an obvious incremental path now that the accumulator feeds it.
- [ ] **Deeper treemap nesting** — one hierarchy level ships (groups squarify, children squarify under a naming band). Arbitrary depth needs a recursive layout and a header budget that does not eat the leaves.

## @jarenjs/calc

- [ ] **Interactive plots** — drag-to-rotate for x·y·z and pan/zoom for x·y are a `hydrate` enhancement (out of scope for v1; the static SVG render is complete).
- [ ] **Programmer 64-bit precision** — the expression evaluator surfaces programmer-mode results as `Number` (values beyond 2^53 lose precision on read-back); the four-base display already stays exact via `word.js` BigInt. A BigInt-valued evaluation path would close the gap.
- [ ] **More converter dimensions & rate providers** — fuel economy (non-affine) and additional API-key-free tickers; websocket/streaming rates are deliberately out of v1 (REST polling only).

## @jarenjs/josl

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

## Benchmarks & tooling

- [ ] **Shared benchmark harness library** — `jsonquery.js` and `jslt.js` duplicate ~250 lines of harness (option parsing, adaptive iterations, table rendering); extract it, and backport `jslt.js`'s `--filter` alias and stricter option validation either way. Note this rewrites the code that produces the published numbers, so it wants output-diffing against the current tables rather than a blind refactor.
- [ ] **Compile-mean coverage in `jslt.js`** — `COMPILE_KEYS` is `['identity', 'surgical', 'annotate']`, so the compile row's stylesheet set omits the reshape stylesheet.
- [ ] **`--cell-order` shuffle** — the 4-book singular cell reads higher than the 1000-book one run to run (JIT/IC noise across the cell sequence); a shuffle option would pin it down if it ever matters.
- [ ] **Saxon-JS as an optional competitor** — noted and deliberately excluded so far (heavyweight SEF/XSLT toolchain for a zero-build workspace).
- [ ] **Drop the fontoxpath baseline-subtraction hack if a compile-only API appears** — the jsonquery adaptor pre-converts XDM and subtracts a baseline because fontoxpath exposes no compile-only entry point; a future compile-only API would let the adaptor measure it fairly.
