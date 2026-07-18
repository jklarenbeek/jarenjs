# 📅 Jaren Roadmap

```
My manager tried to open that door before,
but it apparently was scheduled for the next release.
```

This is the single roadmap for the whole monorepo. It combines the release
milestones with everything the development record identified as still to be
done or optimized, grouped per package. Items link to the document that
motivates them where one exists.

## Release milestones

- 0.9 — current
  - [x] Jaren as a drop-in replacement for Ajv
  - [x] add [benchmark](https://github.com/ebdrup/json-schema-benchmark) test suite for `draft7`
  - [x] Fixing JSON error schema output
  - [x] add error reporting tests
  - [x] full `draft7` compliance (100% of the official test suite)
  - [x] full `draft2019` compliance: `unevaluatedProperties`, `unevaluatedItems`, `$recursiveRef`/`$recursiveAnchor`, `$vocabulary`, cross-draft references
  - [x] full `draft2020` compliance: `prefixItems`/`items`, `$dynamicRef`/`$dynamicAnchor`, format-annotation semantics
  - [x] Runtime schema manipulation of constraints (via `data` keyword — json-everything's data-ref proposal)
  - [x] add development documentation
  - [x] add examples
  - [x] `@jarenjs/json`: compiled JSON Pointer, RFC 9535 JSONPath (703/703 compliance), the Jaren JSON Query engine (FLWOR, 58-operator library, XQuery text front-end, QT3 scorecard), and the JSLT stylesheet layer — with published JSON Schema grammar twins for all of it
  - [x] `$query` keyword: Jaren queries inside JSON Schema (cross-field assertions)
  - [x] JSON Schema as the query type system (`$valid`/`$assert`/`$as` via the `compileTypeTest` hook)
  - [x] `@jarenjs/forms` on the json stack: shared compiled pointers, `x-form` query-powered rules, write-once submit assertions
- 🎉 1.0 Stable release
  - [ ] add AI bot workflow and bootstrap prompt
  - [ ] add a website to github pages with typescript and react
  - [x] add i18n — every error carries `msgid` + structured params; catalogs render at report time (`localizeErrors`), locale packs live in `@jarenjs/locales` (Dutch shipped)
- 1.1
  - [ ] [propertyDependencies](https://github.com/json-schema-org/json-schema-spec/blob/main/proposals/propertyDependencies.md) proposal
  - [x] `errorMessage` keyword — text overrides with `$msgid`/catalog indirection, registered at compile time, resolved at report time, zero validation-time cost ([ERROR-MESSAGES.md](packages/validate/docs/ERROR-MESSAGES.md))
  - [ ] JSON Schema standard output formats (`list`/`hierarchical` wrappers, `evaluationPath`/`schemaLocation` renames) — the remaining half of [Fixing JSON Schema output](https://json-schema.org/blog/posts/fixing-json-schema-output); the structured params + keyed messages are exactly what that format wants
- 1.2
  - [ ] compileAsync for asynchronous schema loading
  - [ ] JSON.parse reviver / JSON.stringify replacer integration

## @jarenjs/validate

- [x] **`messages` companion keyword for `$query`** — DELIVERED as `errorMessage`'s `$query` entry (per-code map with an EBV-false `default`); no separate keyword needed.
- [ ] **ajv-style `errorMessage` `properties`/`items` map forms** — only if demand appears; the subtree prefix rule already covers what they express.
- [ ] **Relative-pointer `${...}` interpolation in message templates** — ajv-errors-style data interpolation; params already carry the offending values, so this is convenience, not capability.
- [ ] **Additional locale packs** — the catalog contract and key-parity tests make each pack mechanical; `nl` is the reference implementation.
- [ ] **Unprefixed `query` alias / vocabulary registration** — register `$query` through a custom vocabulary and meta-schema (json-everything style) instead of only as an extension keyword.
- [ ] **Cross-root compile memo for registered schemas** — a *registered* schema whose `$query` literal `$ref`s that same registration compiles a fresh root per hook invocation and can recurse at `compile()` time; a cross-root memo would close this compile-time foot-gun.
- [ ] **Finer `$query`/`$data` feature scan** — the compile-time scan is conservative: any schema in the compilation map containing `$query` (or `$data`) turns on instance-path building for the whole root.
- [ ] **`data` next to `$ref` in 2019-09+** — `$query` was added to the `$ref`-sibling keyword list; `data` has the same latent gap and still relies on pre-existing behavior.
- [x] **Type declarations for `@jarenjs/validate/query`** — declarations are generated from JSDoc for every public subpath.

## @jarenjs/json

### Query engine & language

- [ ] **Filter optimizer / hash joins** — hoist `$`-absolute comparables out of filter loops, fuse adjacent singular segments, and turn `$where` equijoins into hash joins instead of nested loops (the benchmark's join row is O(books × ratings) today; a hash join changes the complexity class, not just the constant).
- [ ] **Lazy sequences / lazy `$range`** — `$range` materializes eagerly, so the `JQ2007` resource guard (fires at 2³² items) can never trigger before the heap does; found by the QT3 harness (6 baselined resource-bomb skips). Needs lazy sequence evaluation or a lower, memory-aware limit.
- [ ] **`$allowing-empty` and window clauses** — the two FLWOR constructs v0.1 leaves out (outer-join-style iteration and `tumbling`/`sliding` windows).
- [ ] **Higher-order operators** — user-supplied functions for map/filter/fold shapes; requires a function-value story the JSON encoding deliberately does not have yet.
- [ ] **Date/time operators** — `@jarenjs/core/dates` exists as the foundation; the operator registry makes the addition mechanical.
- [ ] **Closed-world compilation mode (`JQ0005`)** — a mode requiring all variables bound at compile time; today free variables are externals by default and `JQ0005` fires only for unknown `$as` names.
- [ ] **`compileTypeTest` hook diagnostics** — the hook contract passes `docPath` so future hooks can report schema-compile diagnostics positionally; the reference `createTypeTestCompiler` ignores it today.
- [ ] **`__proto__` member construction in query constructors** — `compileObject`/`compileMap` assign `out[name] = value`, so a *constructed* member named `__proto__` sets the result's prototype instead of a member. The JSLT dispatcher already rebuilds `__proto__` as an own property; the query-engine member appliers should adopt the same `setMember` pattern.
- [ ] **Spec patch batch for QUERY-FORMAT.md §6.5** — the proposed wording for multi-item/empty grouping keys (`JQ2001`/allowed), `NaN` grouping equality and `NaN` order-by placement is implemented and tested but not yet folded into the normative text.

### JSONPath & addressing

- [ ] **Custom JSONPath function extensions** — a registry per RFC 9535 §2.4 with declared parameter/return types, so user functions get the same compile-time well-typedness checks as the built-ins.
- [ ] **Lazy iteration** — `query.iterate(data)` as a generator yielding nodes on demand, plus early-exit `first()`/`exists()` for non-singular JSONPath queries.
- [x] **Normalized path ↔ JSON Pointer bridge** — `jsonPointerFromJSONPath` (any singular query) and `jsonPathFromJSONPointer` (digit tokens become index selectors, documented convention) in path.js; the write operations accept either addressing form directly.
- [x] **Write operations** — shipped as `@jarenjs/json/write`: `compileJSONPointerSetter`/`Inserter`/`Remover` (targets: RFC 6901 pointer, normalized path, or any singular query — including negative indexes and `-` append) and `compileJSONPathSetter`/`Inserter`/`Remover` (every node a query selects, applied in reverse document order so shifts and nested matches compose), plus one-shot forms. Copy-on-write via the shared owned-set core (now package-internal `src/cow.js`, shared with patch.js); `{ mutate: true }` for in-place; setters take updater functions.
- [x] **JSON Patch (RFC 6902) and JSON Merge Patch (RFC 7396)** — apply and structural diff, built on compiled pointers; a diff that emits JSON Patch doubles as a change feed for `@jarenjs/forms`. Shipped as `@jarenjs/json/patch` (compiled copy-on-write appliers, `share`/`fresh`/`mutate` modes, full official json-patch-tests suite); an LCS array-diff mode is future work.
- [x] **Shared pointer-segment encode helper** — `encodeJSONPointerSegment`/`formatJSONPointer` now live in `@jarenjs/json/pointer`; forms' `escapePointerKey` delegates to it (kept as a compatibility alias).
- [ ] **Canonical JSON (RFC 8785 / JCS)** — deterministic serialization for hashing and signing; `stableKeyString` in the query runtime is a starting point.
- [ ] **Relative pointer `0#` fidelity flag** — the hash form returns the member-name *string* (the historical `$data` behavior); draft-luff resolves array positions to a *number*. An opt-in flag would serve a spec-faithful consumer if one appears.
- [ ] **Optional codegen backend** — compile hot queries to source via `new Function` where CSP allows, reusing the same AST and semantics; the closure compiler stays the default.

### JSLT

- [ ] **JSLT matcher optimizer (single-walk)** — replace per-rule path pre-passes with a single multi-pattern walk, specialize location tracking by reachable modes, and use input-schema knowledge to prune impossible shape rules. The benchmark quantifies the gap: dense pure-path transforms pay ~9–12x over the raw path scan, and hand-written native JS stays 3–139x faster on real transformations — this is the main JSLT performance workstream.
- [ ] **Standalone `@jarenjs/jslt` package** — publish the stylesheet layer as its own package only when the query-engine internals it needs have a deliberate public boundary; today the module stays colocated to avoid exposing compiler internals.
- [ ] **Bare `$`/`$root` `$apply` selectors and locations** — a bare root selector currently dispatches location-less; JSLT-FORMAT §6.4 ("path rooted at") arguably includes the zero-segment path. Clarify the spec or carry the location.
- [ ] **`$apply` mode-argument typing in the schema twins** — the draft-neutral subset forbids tuple validation, so a non-string mode in the two-item `$apply` array is compiler-rejected (JT0007) but schema-accepted. Changing this means abandoning the mechanical twin transform or changing the language encoding; documented in JSLT-FORMAT Appendix B.

### XQuery front-end & QT3

- [ ] **`xs:*` constructor casts and more `fn:*` mappings** — the QT3 scorecard attributes the bulk of its 21k `unsupported-syntax` cases to the function library, not the language; a handful of numeric/string casts plus `fn:tokenize` moves thousands of cases into the measurable buckets.
- [ ] **Exact sequence-base lookups** — lookups on non-variable bases emit `$get`, which addresses a single item; a `$let`-wrapper emission would reproduce XQuery's per-item lookup exactly, and is the v2 candidate alongside the `!` simple-map and `=>` arrow operators.
- [ ] **1-based positional *outputs*** — `at`/`count`/`fn:index-of` surface the format's 0-based D6 values, so QT3 asserts them as wrong-value; `fn:index-of` has a cheap local emission fix, `at`/`count` would need reference rewriting. Revisit if the scorecard noise starts to matter.
- [ ] **Front-end diagnostic polish** — a bare NameTest colliding with a keyword (`let`, `order`, ...) raises `unexpected keyword` instead of `unsupported construct 'path expression'`; `=>` after a comparison RHS raises a generic error. Deliberate-diagnostic spots, baselined as known bugs in the QT3 harness.

### Typing & packaging

- [x] **Type declarations for the `query`/`jslt`/`jtlt`/`xquery` subpaths** — declarations are generated from JSDoc for every public subpath.

## @jarenjs/formats

- [ ] **`iregexp` format** — register an I-Regexp (RFC 9485) string format backed by `isValidIRegexp` from `@jarenjs/core/text` (the implementation already exists and powers JSONPath's `match()`/`search()`).
- [ ] **Tests for `country2` and `iban`** — both formats ship without tests (flagged in their format list entries).

## @jarenjs/forms

- [ ] **Rule dependency memoization** — every `evaluateFormRules` call re-evaluates every rule; the compiler already sees each rule's paths, so a dirty-pointer index (changed pointer → affected rules) is the obvious next step once forms get large.
- [ ] **Pruning hidden fields before submit** — `visible: false` fields keep their values in the data; whether submit should drop them (and whether `formRulesToQueryAssertions` should guard asserts on their own `visible`) is an open product decision.
- [x] **Computed views through JSLT** — landed as `buildFormViewModel` (viewmodel.js): the composed render tree that `@jarenjs/app`'s standard form rules dispatch over with `$apply`, keeping forms validator-independent. Still open from the original idea: letting stylesheets *replace* the JS composition step entirely (needs dynamic-pointer reads in rule bodies).

## @jarenjs/view & @jarenjs/app (new — 0.1 formats)

- [x] **The standard forms stylesheet** — shipped: `createFormView()`/`createFormActions()` in `@jarenjs/app` (plain-JSON rules dispatching on `buildFormViewModel` trees by control shape), the `buildFormViewModel` render-tree layer in `@jarenjs/forms`, and the `viewModel` derivation boundary on `createApp`. Follow-ups: typed select values (non-string enums), tuple add/remove affordances, a `json` control editor, i18n for the chrome strings (add/remove button labels).
- [x] **Rebuild the website on view + app** — shipped: `@jarenjs/website` IS the app-document site (the React predecessor is retired). All nine playground engines (generic descriptor framework in `boundaries/engines.js`), the localStorage experiment IDE, all eight benchmark suites incl. searchable validate table + scenario matrices with sources, docs (19 sections as a content document) & examples with open-in-playground, WebMCP agent tools (schema-validated by Jaren itself), PWA (manifest + offline service worker) and the mobile drawer. Nice-to-haves that didn't make the cut: share-link URLs (base64), PNG PWA icons for iOS installs, an a11y audit.
- [ ] **The app-document meta-schema** — publish `jaren-app.schema.json` composing the query, JSLT and vnode schemas; closes the constrained-decoding loop for whole applications.
- [ ] **Dirty-path-pruned re-rendering** — the changed-path feed exists: `json/patch`'s `changes: true` option reports invalidation-sound JSON Pointers per write, and `createApp` hands them to state subscribers (`listener(state, changes)`). Still open: re-dispatch only view rules whose match regions intersect the changed paths; with memoized rule outputs (cache keyed by rule × state-node reference) unchanged branches yield reference-equal vnodes and the renderer's `===` fast path skips them across frames.
- [ ] **Unify the write path** — reimplement forms' `setValueAtPointer`/`appendItem`/`removeItemAt` over the `json/patch` copy-on-write kernel so keystrokes and app transitions share one immutable-update and change-tracking story (forms' `data.js` header already points here).
- [ ] **DOM-adopting hydration & fragment roots** — VIEW-FORMAT §6/§7: adopt server-rendered markup instead of empty-and-rebuild; allow list roots.
- [ ] **Component escape hatch** — a registered-widget vocabulary (mirroring the effect registry) for irreducibly imperative islands: canvas, maps, third-party controls.
- [ ] **Benchmark: view + app vs hyperapp/preact** — a `benchmark/view.js` scenario matrix (large list patch, keyed shuffle, deep tree, SSR throughput) in the honest style of the JSLT benchmarks, including the cost of the generic dispatcher.
- [x] **Join the release train** — `@jarenjs/view` and `@jarenjs/app` are in `pack:check`/`publish`; the 0.1 formats earned it by powering the deployed website.

## LLM & structured-output profile

- [ ] **An "LLM profile" of the query/JSLT schema twins** — a simplified lowest-common-denominator variant for structured-output implementations that do not enforce recursive references, `patternProperties`, `propertyNames` or asserted formats; trades grammar precision for universal provider support. See the [LLM sections](packages/json/README.md#generating-queries-with-llms) for why local validation is required either way.

## @jarenjs/josl (research experiment)

- [ ] **Single-walk scanner** — fold the chunk cutter and the logical-line parser into one pass; the cutter's second scan over every character is the main share of smol-toml's remaining ~1.9x parse-speed edge (`npm run benchmark:toml`).
- [ ] **CST mode** — preserve comments, key order aesthetics and formatting for faithful document rewriting, not just data round-trips.
- [ ] **JOSL/JSONX grammar as JSON Schema** — publish the language surface as a schema twin for LLM constrained decoding, like the query/JSLT grammars.
- [ ] **Graduation decision** — if the experiment earns its keep, drop `private: true`, add typed `dist/types` builds and join the release train; otherwise salvage the strict-TOML engine as a standalone package.

## Benchmarks, tooling & website

- [ ] **Shared benchmark harness library** — `jsonquery.js` and `jslt.js` duplicate ~250 lines of harness (option parsing, adaptive iterations, table rendering); extract it, and backport `jslt.js`'s `--filter` alias and stricter option validation either way.
- [ ] **Compile-mean coverage in `jslt.js`** — the compile row's stylesheet set omits the reshape stylesheet.
- [ ] **`--cell-order` shuffle** — the 4-book singular cell reads higher than the 1000-book one run to run (JIT/IC noise across the cell sequence); a shuffle option would pin it down if it ever matters.
- [ ] **Saxon-JS as an optional competitor** — noted and deliberately excluded so far (heavyweight SEF/XSLT toolchain for a zero-build workspace).
- [ ] **Lint the benchmark workspace** — `benchmark/` sits outside the `npm run lint` glob; the tools follow house style but are not lint-enforced.
- [ ] **Website: publish the new engine numbers** — the JSONPath/query/JSLT benchmark results are not yet integrated into the website's visualizations.
- [ ] **Website: query/JSLT playground** — an editor that loads the published schema twins, validates generated query documents and stylesheets, and displays compiler `docPath` errors inline.
