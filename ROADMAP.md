# 📅 Jaren Roadmap

```
My manager tried to open that door before,
but it apparently was scheduled for the next release.
```

This is the single roadmap for the whole monorepo. It lists everything the
development record identified as still to be done or optimized, grouped per
package, plus the remaining release milestones. Completed work has been retired
from this file; items link to the document that motivates them where one exists.

## Release milestones

- 🎉 1.0 Stable release
  - [x] **AI bot workflow and bootstrap prompt** — **shipped as `workflow/`**: the
    context-free, work-order development workflow that built this monorepo, committed
    as a sanitized, reusable harness. `BOOTSTRAP.md` is the fresh-session prompt;
    `ROUTER.template.md`, `WORK-ORDER.template.md`, `SESSION-RECORD.template.md` and
    `HANDOFF.template.md` are the four moving parts; `CONVENTIONS.md` binds the rules
    (immutable D-numbers, work lands on `main` uncommitted, every work order ends on
    the full green gate, committed artifacts never reference scratch files, records
    carry numbers not adjectives). Proven, not asserted: `workflow/examples/` holds a
    real work order executed by a fresh session from the bootstrap alone, with the
    session record it produced — a run that also caught four dead-code findings the
    main line had deferred, exactly the honesty the workflow exists for.
- 1.1
  - [ ] [propertyDependencies](https://github.com/json-schema-org/json-schema-spec/blob/main/proposals/propertyDependencies.md) proposal
  - [ ] JSON Schema standard output formats (`list`/`hierarchical` wrappers, `evaluationPath`/`schemaLocation` renames) — the remaining half of [Fixing JSON Schema output](https://json-schema.org/blog/posts/fixing-json-schema-output); the structured params + keyed messages are exactly what that format wants
- 1.2
  - [ ] compileAsync for asynchronous schema loading
  - [ ] JSON.parse reviver / JSON.stringify replacer integration

## @jarenjs/validate

- [ ] **Per-scope static evaluated-set analysis for `unevaluated*`** — the sibling-coverage
  elision shipped in v0.16.1 compiles away the checks that are statically unreachable
  (`additionalProperties` next to `unevaluatedProperties`, uniform `items` next to
  `unevaluatedItems`, annotation-only `true` forms with no consumer), but the genuinely
  dynamic cases — nested `unevaluated*`, cousin schemas, annotations flowing across
  `$ref`/in-place applicators — still pay the runtime evaluation log and its linear scans,
  and sit well behind Ajv's compile-time evaluated-set tracking. Computing a static
  evaluated set per schema scope (with a small dynamic remainder only where refs make it
  unknowable) is the main remaining validator performance workstream.
- [ ] **Optional codegen backend for nano-schemas** — closure-compiled validators bottom
  out around 5× Ajv's generated code on trivial schemas (a two-branch `allOf` runs ~90 ns
  vs ~15 ns), which is the price of the CSP-safe no-`new Function` rule. Mirroring the
  query engine's "optional codegen backend" idea — same compile pipeline, a codegen
  emitter where CSP allows, closures as the default — would close the floor without
  giving up the guarantee.
- [ ] **ajv-style `errorMessage` `properties`/`items` map forms** — only if demand appears; the subtree prefix rule already covers what they express.
- [ ] **Relative-pointer `${...}` interpolation in message templates** — ajv-errors-style data interpolation; params already carry the offending values, so this is convenience, not capability.
- [x] **Additional locale packs** — **shipped**: eleven packs (`nl`, `fr`, `es`, `pt`, `de`, `ja`, `ko`, `zhTW`, `ru`, `tr`, `ar`), each a subpath export with key parity, exact-render and end-to-end tests; the Arabic pack renders limit comparisons as phrases (an ASCII operator between RTL text and a number displays bidi-flipped) with a first-strong-isolate fallback for unknown operators, and the playground's locale switcher is generated from the catalog map so packs and buttons cannot drift.
- [ ] **Unprefixed `query` alias / vocabulary registration** — register `$query` through a custom vocabulary and meta-schema (json-everything style) instead of only as an extension keyword.
- [ ] **Cross-root compile memo for registered schemas** — a *registered* schema whose `$query` literal `$ref`s that same registration compiles a fresh root per hook invocation and can recurse at `compile()` time; a cross-root memo would close this compile-time foot-gun.
- [ ] **Finer `$query`/`$data` feature scan** — the compile-time scan is conservative: any schema in the compilation map containing `$query` (or `$data`) turns on instance-path building for the whole root.
- [ ] **`data` next to `$ref` in 2019-09+** — `$query` was added to the `$ref`-sibling keyword list; `data` has the same latent gap and still relies on pre-existing behavior.
- [ ] **`required` short-circuit reports only the first missing property** — the historical `&&=` collection short-circuit means each object surfaces only its *first* missing `required` property, even in collect-all-errors mode.
- [ ] **Type-only `items` fast path aggregates per-item failures** — the type-only `items` fast path reports a single error at the array path instead of one error per failing item; the multi-keyword path already yields per-item errors.
- [ ] **`additionalProperties: false` instancePath divergence from ajv** — Jaren points the error at the offending member (`/nested/extra`) where ajv points at the parent object; deliberate and spec-truer, tracked so consumers diffing against ajv output know it is intentional.

## @jarenjs/json

### Query engine & language

- [ ] **Filter optimizer / hash joins** — hoist `$`-absolute comparables out of filter loops, fuse adjacent singular segments, and turn `$where` equijoins into hash joins instead of nested loops (the benchmark's join row is O(books × ratings) today; a hash join changes the complexity class, not just the constant).
- [ ] **Lazy sequences / lazy `$range`** — `$range` materializes eagerly; the default `JQ2007` resource guard (2³² items) can never trigger before the heap does (found by the QT3 harness, 6 baselined resource-bomb skips). `options.limits.sequenceItems` now lets a host tighten the guard deterministically; true lazy sequence evaluation remains the structural fix.
- [ ] **`steps`/`depth` execution limits** — `options.limits` deliberately rejects them with a `TypeError` because the closure-compiled engine has no instrumented evaluation core to enforce them; accepting an unenforced limit would be a silent false guarantee. Enforcing them means threading a counters context through the compiled closures (a measured-overhead design question).
- [ ] **`$allowing-empty` and window clauses** — the two FLWOR constructs v0.1 leaves out (outer-join-style iteration and `tumbling`/`sliding` windows).
- [ ] **Higher-order operators** — user-supplied functions for map/filter/fold shapes; requires a function-value story the JSON encoding deliberately does not have yet.
- [ ] **Date/time operators** — `@jarenjs/core/dates` exists as the foundation; the operator registry makes the addition mechanical.
- [ ] **Closed-world compilation mode (`JQ0005`)** — a mode requiring all variables bound at compile time; today free variables are externals by default and `JQ0005` fires only for unknown `$as` names.
- [ ] **`compileTypeTest` hook diagnostics** — the hook contract passes `docPath` so future hooks can report schema-compile diagnostics positionally; the reference `createTypeTestCompiler` ignores it today.
- [ ] **`__proto__` member construction in query constructors** — `compileObject`/`compileMap` assign `out[name] = value`, so a *constructed* member named `__proto__` sets the result's prototype instead of a member. The JSLT dispatcher already rebuilds `__proto__` as an own property; the query-engine member appliers should adopt the same `setMember` pattern.
- [ ] **Non-JSON `queryFn(data)` input** — a compiled query passed `undefined`/non-JSON returns non-JSON without a special-case guard; decide whether to reject or document the pass-through.
- [ ] **Spec patch batch for QUERY-FORMAT.md §6.5** — the proposed wording for multi-item/empty grouping keys (`JQ2001`/allowed), `NaN` grouping equality and `NaN` order-by placement is implemented and tested but not yet folded into the normative text.
- [ ] **Spec patch: member-value cardinality (§3.1/§3.5.2) and the `$string` cast table** — the normative wording for object-construction member values (an empty result omits the member; two-or-more items is `JQ2001`) plus the `$string`/`$concat` cast table (`number → String(n)`, booleans, `null → "null"`) is implemented and tested but not yet folded into QUERY-FORMAT.md.
- [ ] **Spec examples: `$let`-bound sequences vs child filters (§5.1) and `$where` reading its own `$count` (§9)** — two correct-but-surprising behaviors worth a worked example in the spec: a `[?…]` filter on a `$let`-bound item sequence selects the *children* of each item (so an item-level predicate yields empty), and clause scope order lets `$where` observe the phrase's own `$count` name as an external.

### JSONPath & addressing

- [ ] **Custom JSONPath function extensions** — a registry per RFC 9535 §2.4 with declared parameter/return types, so user functions get the same compile-time well-typedness checks as the built-ins.
- [ ] **Lazy iteration** — `query.iterate(data)` as a generator yielding nodes on demand, plus early-exit `first()`/`exists()` for non-singular JSONPath queries.
- [ ] **`json-path-segments` format for variable-rooted paths** — the query schema only regex-checks the *head* of a variable-rooted path string (e.g. `$b.price[…]`); full segment-grammar validation is deferred to the compiler (`JQ0004`). A `json-path-segments` string format would give variable-rooted paths the same schema-time well-formedness check the absolute `json-path` format gives root-anchored ones.
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

## @jarenjs/formats

- [ ] **`iregexp` format** — register an I-Regexp (RFC 9485) string format backed by `isValidIRegexp` from `@jarenjs/core/text` (the implementation already exists and powers JSONPath's `match()`/`search()`).
- [ ] **Tests for `country2` and `iban`** — both formats ship without tests (flagged in their format list entries).
- [ ] **Char-code IRI/IRI-reference validator** — `isValidIRI` falls back to a heavily
  backtracking alternation regex for non-ASCII and bracketed inputs (microseconds per
  call). The RFC 3339 date/time testers moved to allocation-free char-code parsers in
  v0.16.1; the IRI family is the remaining regex monster. Ajv does not implement `iri`
  at all, so this is about absolute cost for real consumers, not a benchmark ratio.
- [ ] **`idn-hostname` punycode cost** — validation of a Unicode hostname costs ~1.6 µs,
  dominated by the genuine IDNA work (per-label punycode decode plus a whole-string
  `toASCII` re-encode for the ACE shape check). The double decode and the identity
  re-encode for ASCII inputs were removed in v0.16.1; anything further means reworking
  the punycode encoder itself. Ajv errors on this format, so the same fairness note as
  `iri` applies.

## @jarenjs/forms

- [x] **Form session dirty authority + injective ids** — **shipped**: `buildFormViewModel`'s `session` option now derives `session.dirty`/`session.dirtyPaths` from a full JSON diff of the initial document against the current data (removed array tails, added/removed members including explicit `null`, and values retained under hidden fields all contribute their pointer), per-node `dirty` is presence-aware, accessible ids are injective (every character outside `[A-Za-z0-9]` escapes as `_<codepoint>_` before segments join on `-`), and the walk RFC 6901-encodes member names so a key containing `/` or `~` can never collide with a nested path.
- [ ] **Rule dependency memoization** — every `evaluateFormRules` call re-evaluates every rule; the compiler already sees each rule's paths, so a dirty-pointer index (changed pointer → affected rules) is the obvious next step once forms get large.
- [ ] **Pruning hidden fields before submit** — `visible: false` fields keep their values in the data; whether submit should drop them (and whether `formRulesToQueryAssertions` should guard asserts on their own `visible`) is an open product decision.
- [ ] **Absent-field semantics: keystroke `null` vs submit empty-sequence** — form rules bind an absent field to `null` during editing, but the submit-side `$query` copy of the same rule binds it as the empty sequence, so `$eq`/`$ne` diverge between the two paths. Documented today with a `$exists`-guard workaround; unifying the two bindings is the real fix.
- [ ] **Stylesheets replacing the JS composition step** — `buildFormViewModel` composes the render tree in JS today; letting stylesheets *replace* that composition entirely needs dynamic-pointer reads in rule bodies.

## @jarenjs/view & @jarenjs/app (new — 0.1 formats)

- [ ] **Standard forms stylesheet follow-ups** — typed select values (non-string enums), tuple add/remove affordances, a `json` control editor, and i18n for the chrome strings (add/remove button labels).
- [~] **Real-browser accessibility and lifecycle matrix** — the first slice shipped: `packages/website/e2e` runs a Playwright suite against the BUILT website (the repository's production `createApp` consumer) in real Chromium, Firefox and WebKit — boot with landmark semantics, client-side navigation mount/unmount lifecycle, keyboard activation of the router, rapid widget/view route churn and history back, each test asserting zero page errors under real engine scheduling. The `browser` CI job runs all three engines on every push; locally `npm run test:browser` (an Ubuntu distrobox serves hosts missing the shared libraries). Still open, claimed nowhere: the full accessibility audit — dialog focus traps, focus restoration, screen-reader/AT semantics, `prefers-reduced-motion` — and the APP-FORMAT §8.4/§8.5 dialog contracts under real AT. (The *platform* matrix preceded it: the `gate` jobs run the full release gate — lint, suite, build, types, tree-shaking, packed consumers with mandatory Bun and an isolated Vite `lib` build of the `@jarenjs/app` closure — on Linux and Windows.)
- [x] **Runtime ownership hardening** — **shipped**: the app/view boundaries hold under adversarial hosts. Boot is one rollback boundary — renderer construction, boot-context initial-state validation (`{ previous: null, action: null, payload: null, changes: null }`), subscription start, the first frame AND the queued boot drain all succeed or every acquired resource (effect handlers included) is disposed and one `JA0007` escapes. The public renderer is serialized (nested renders queue and coalesce to the latest vnode; no `update` before `mount` returns, no stale previous props) with a deterministic widget failure policy (a throwing `mount`/`update` poisons the widget; the next render replaces it with a fresh lifecycle, and recovery is independent of vnode reference identity — while any widget is poisoned the `===` fast path is suspended, so memoized structural sharing cannot leave it inert). A `destroy()` requested inside a widget hook stops the active pass before any later sibling updates. Host-code error boundaries are complete: a throwing `validateState` is `JA2015`, a throwing `eventFields` extractor is `JA2002` with the dispatch kept, deferred render failures reach `onError`, terminal-cleanup failures keep `JA2012` provenance with the first host cause preserved (the renderer's `onCleanupError` channel — a deferred teardown error is never an anonymous render error, and a render-phase error is never mislabeled as cleanup), the focus sink is isolated, and only a registered action may apply `preventDefault`/`stopPropagation`. `maxTurns` is validated; `stop()` is documented as a one-way halt. The adversarial probe suite is `test/app/runtime-hardening.test.js`.
- [~] **O(change) rendering** — two of three layers shipped. (1) The changed-path feed: `json/patch`'s `changes: true` reports invalidation-sound pointers, surfaced to `createApp` subscribers. (2) **Memoized rule outputs**: the JSLT `memo` compile option caches rule bodies by (location, value reference) behind a compile-time eligibility analysis (no `$root`/`$path`/externals, transitively through `$apply`; no root refs in match filters) with a two-generation cache — an unchanged document returns the ENTIRE previous output by reference, and `@jarenjs/app` + the website's `memo1` viewModel derivations turn that into reference-equal vnodes the patcher skips in O(1). Still open: (3) **prepass-level pruning** — skip re-evaluating match paths over unchanged regions using the changed-path feed directly.
- [ ] **DOM-adopting hydration & fragment roots** — VIEW-FORMAT §6/§8: adopt server-rendered markup instead of empty-and-rebuild; allow list roots.
- [x] **Component escape hatch** — **shipped**: the `jaren-widget` registered-widget vocabulary (VIEW-FORMAT §7) for irreducibly imperative islands — canvas, maps, virtualized grids, third-party controls. A widget mounts into a host element the patcher owns, updates on `props` reference change (reference-equal props are never poked, so the JSLT memo makes untouched widgets free), is unmounted deterministically by the destroy walk when it leaves the tree, emits ordinary bindings, and serializes through a declarative `ssr` fallback. The renderer-level `destroy()` shipped with it (VIEW-FORMAT §8): every mounted widget unmounts exactly once, the container is left empty, later renders are exact no-ops.
- [x] **Configurable `$event` extraction** — **shipped**: a binding's `"event": [fieldName, ...]` member requests extra serializable event fields (modifier keys, pointer coordinates, selection offsets) from a closed allow-list, and `options.eventFields` registers named JS extractors for anything the list can't serialize (APP-FORMAT §3.1/§4/§5.4) — shift-range selection and file-token dispatch are now expressible in an app document.
- [x] **Async-task convention + `createTaskEffect`** — **shipped**: the documented staleness-rejection pattern (task-slot ids in state, guard-first completion actions yielding the empty sequence for stale payloads, polling composed on top) plus the `createTaskEffect` helper packaging the host half (per-slot `AbortController`, `done`/`fail` dispatch, abort dispatches nothing). Pattern-first — no format change; the worked example in `packages/app/docs/TASKS.md` is executed verbatim by the test suite. First-class *awaiting* action documents stay open (APP-FORMAT §11).

## @jarenjs/md (new — 0.1 format)

- [ ] **CommonMark conformance push** — 526/655 spec examples pass today (`npm run benchmark:markdown --score-only --verbose` lists the failures); the largest deliberate class is raw-HTML pass-through (the vnode format has no unescaped output), the rest are honest dialect gaps (link-label edge cases, exotic emphasis nestings, HTML block subtleties) worth picking off.
- [ ] **Parse-speed workstream** — ~0.3 ms per 10 kB to AST; the block scan re-slices lines per container level and the inline phase re-buffers leaf text; a column-offset scanner (no intermediate slices) is the next lever toward the sub-200 µs target.
- [ ] **Sanitizer-backed raw HTML** — an opt-in `html` mode that parses raw HTML nodes into vnodes through an injected sanitizer, replacing today's skip/text-only choice.
- [ ] **Streaming reference definitions** — the incremental parser binds `[ref]` links against definitions seen so far; a deferred-resolution pass at `end()` would close the gap with batch mode.

## @jarenjs/mermaid (new — 0.1 format)

A native, headless Mermaid clone: diagrams-as-code → geometry-free JSON
AST → pure-vnode SVG through `@jarenjs/view`, bidirectional
(`parseMermaid` ⇄ `toMermaid`). The Markdown plugin renders `mermaid`
fences inline, SSR-safe, replacing the old injection wrapper.

- [ ] **`foreignObject` / `htmlLabels:true`** — labels are SVG `<text>` in v1 because `@jarenjs/view` 0.1 has no `foreignObject`/`setAttributeNS`; revisit alongside VIEW-FORMAT §6/§8 for HTML labels and pixel-closer parity.
- [ ] **Full layout for the secondary types** — class/ER/state/gantt render as structured panels, not domain-specific layouts; mindmap/gitGraph/journey/timeline parse-accept with a placeholder. Real layouts are the next coverage push (tracked honestly in the benchmark scorecard).
- [ ] **Layout/perf workstream** — dagre-lite handles ranks and straight edges; orthogonal edge routing, subgraph clustering and crossing reduction are the next levers.
- [ ] **More domain projections** — the flagship `stateDiagram ⇄ @jarenjs/app` workflow ships; flowchart⇄DAG executor, sequence⇄orchestration/saga, ER⇄JSON-Schema+`@jarenjs/forms` are follow-ups on the same geometry-free-AST-as-model idea.
- [ ] **Interactive hydration** — pan/zoom/tooltips as an optional client-only plugin (`hydrate` is a no-op today because the render is complete).
- [ ] **Adopt the shared 3D kernel** — `@jarenjs/calc`'s x·y·z plotter introduced a reusable `@jarenjs/core/math` `mat4`/`project.js` kernel (matrices, projection, `surfaceNormal`, painter's-algorithm depth sort). Mermaid 3D could adopt it rather than growing its own projection math.

## @jarenjs/calc (calculator + shared numeric kernel)

- [ ] **Interactive plots** — drag-to-rotate for x·y·z and pan/zoom for x·y are a `hydrate` enhancement (out of scope for v1; the static SVG render is complete).
- [ ] **Retrofit `math/format.js`** — the website hand-rolls `formatMs` in `lib/format.js`; the core number formatter (`formatNumber`/`parseNumber`) can replace ad-hoc formatting suite-wide.
- [ ] **Programmer 64-bit precision** — the expression evaluator surfaces programmer-mode results as `Number` (values beyond 2^53 lose precision on read-back); the four-base display already stays exact via `word.js` BigInt. A BigInt-valued evaluation path would close the gap.
- [ ] **More converter dimensions & rate providers** — fuel economy (non-affine) and additional API-key-free tickers; websocket/streaming rates are deliberately out of v1 (REST polling only).

## @jarenjs/core (shared kernel)

- [ ] **Fix or retire `Float64.map`/`Float64.lerp`** — the core `Float64.map`/`lerp` helpers use a non-standard interpolation formula that returns wrong results for screen/range mapping; consumers work around it locally and the correct `remap` (added during the dedup pass) now lives beside it. A latent core bug worth resolving before the two drift — either fix `Float64.map` in place (auditing existing consumers) or deprecate it in favor of `remap`.

## LLM & structured-output profile

- [x] **An "LLM profile" of the query/JSLT schema twins** — **shipped**: `jaren-query.llm-profile.schema.json` and `jaren-jslt.llm-profile.schema.json`, mechanically derived pure relaxations (`patternProperties`/`propertyNames`/asserted `format`s removed with each constraint restated in the nearest `description`; every `oneOf` becomes `anyOf`, which strict provider subsets require and which the canonical grammar's own name-discriminated branches make necessary). Tests pin byte-stable regeneration, the relaxation property over a corpus plus the site examples, and the documented catch-it-locally pipeline. See the [LLM sections](packages/json/README.md#generating-queries-with-llms).

## @jarenjs/ai (browser-side AI, published)

Browser-side AI that makes sense with bring-your-own-key: one
OpenAI-compatible chat client (OpenRouter / Ollama / LM Studio / any
compatible URL, `fetch` injected), an incremental SSE decoder, a tool
registry whose inputs `@jarenjs/validate` checks before every call —
rejections carry the real validation errors (instancePath/keyword/
message), stringified-JSON arguments are coerced where the schema wants
structure, and unparseable ones get a named hint, because weak models
routinely JSON-encode nested arguments — a bounded agent loop, and
WebMCP (`navigator.modelContext`) registration of the same tools. The
website's assistant and its WebMCP bridge both run on it; the
playground and studio tools are the toolbox, so Jaren validates the
model's own tool calls.

- [x] **Structured-output mode** — **shipped**: `complete({ responseFormat })` emits the `response_format`/`json_schema` wire shape, and `createStructuredOutput` covers every provider tier (schema-constrained decoding → JSON mode → schema-in-prompt, per the `PROVIDERS` capability field), parses the reply, validates it locally with `@jarenjs/validate`, and sends instancePath'd errors back for a bounded repair loop. The end-to-end test generates a query document against the published twin and compiles it with the real engine.
- [x] **Retry/backoff + rate-limit surfacing** — **shipped**: network failures and 408/429/5xx retry with jittered exponential backoff (`retry: { attempts, baseMs, maxMs }`), `Retry-After` (seconds or HTTP-date) wins over the computed delay capped at `maxMs`, a request never retries after the first streamed delta reached the caller, aborts cancel the backoff, and `AI0002` carries `status`/`attempts`/`retryAfterMs`.
- [x] **Token-budget compaction** — **shipped**: `createAgent({ historyBudget })` compacts each request over budget — system prompt, first user message and the largest tail always survive; the dropped middle becomes one deterministic synopsis message (a host `compaction` hook may replace it); cuts land only on tool-round boundaries so `tool_calls`/`tool` pairing stays wire-legal, property-tested against adversarial histories.
- [x] **Provider capability probes** — **shipped**: `probeProvider` GETs the OpenAI-compatible `/models` listing with the chat call's exact auth and never throws; the website settings gained a "Test connection" button, a status line, and a model-name datalist filled by a successful probe.
- [x] **Reasoning-stream surfacing** — **shipped**: `delta.reasoning`/`reasoning_details` stream through `onReasoning` and accumulate onto `message.reasoning` (absent when none), the agent forwards the hook and keeps reasoning off the wire transcript, and the website shows the growing thinking size plus an honest reasoning-only placeholder instead of an empty bubble.

## @jarenjs/josl (published)

The charts/streaming program (shipped 2026-07-21) added the incremental
JSONX/strict-JSON reader (`createJsonxStreamReader`, chunk-splittable at
any token, unified `pair` events with the JOSL reader), flipped the
package to `private: false` with typed `dist/types` builds, dropped the
experimental label and joined it to the release train.

- [ ] **Single-walk scanner** — fold the chunk cutter and the logical-line parser into one pass; the cutter's second scan over every character is the main share of smol-toml's remaining ~1.9x parse-speed edge (`npm run benchmark:toml`).
- [ ] **CST mode** — preserve comments, key order aesthetics and formatting for faithful document rewriting, not just data round-trips.
- [x] **JOSL/JSONX grammar for LLM generation** — **decided and shipped**: JOSL is a text format, so the useful artifact is a JSON-Schema twin over the parsed *data model* — `schemas/jaren-josl-data.schema.json` (root table; strings, finite numbers, booleans, `null`, arrays, nested tables; native date/time scalars deliberately excluded since they parse to platform `Date` values JSON cannot carry). The model emits JSON, `stringifyJosl` renders canonical text, and the round trip is test-pinned. A GBNF-class raw-text grammar for llama.cpp-family constrained sampling is recorded as future work in the README, waiting on a concrete consumer.
- [ ] **Partial-string streaming events** — a `text-partial` event for progressive display of long strings as they stream in (the hook is noted in jsonx-stream.js; not implemented).

## @jarenjs/charts (charts + streaming, shipped 2026-07-21)

Headless charts: definition + data → geometry-free AST → pure-vnode
SVG, twelve types, a stream adapter over the josl readers' unified
events, benchmark-page charts across every suite, a playground engine
with chunked replay, and the Binance live demo (strict-JSON reader end
to end).

- [x] **More chart types** — **shipped**: `radar`, `gauge`, `boxplot`
  (raw samples summarized with linear-interpolated quartiles and Tukey
  1.5·IQR whiskers, or precomputed five-number summaries trusted as
  given), `treemap` (squarified in aspect-scaled space so optimized
  ratios are the rendered ones), `streamgraph` (silhouette baseline),
  `sankey` (nodes collected from links, cycle-closing links dropped,
  longest-path layering, one global value→height scale) and the donut
  variant of pie (`donut: true` or a hole fraction; the solid pie stays
  byte-identical, preserving mermaid parity). Every type follows the
  two-stage geometry-free contract, is schema-covered, golden-pinned,
  and demoed on the /charts page.
- [x] **Heatmap for the scenario matrices** — **shipped** as the
  `heatmap` type: category × category cells on the new `SEQUENTIAL`
  ramp (single-hue blue, light→dark, monotone lightness, legible on
  both surfaces), linear or log normalization, per-cell value hover
  text, and a min→max ramp key riding the frame legend.
- [ ] **Per-mark hover titles for the first five types** — types added
  after the first five carry a `<title>` per value mark (bar rects,
  slices, points); retrofitting the original five is a deliberate
  golden-fixture regeneration (and a mermaid-parity decision for pie),
  so it waits for that call.
- [ ] **JSON-Patch-based O(1) incremental re-render** — blocked on partial re-render support in `@jarenjs/app`; today the projection re-renders wholesale per snapshot (162 µs for a 100×5 line chart, `npm run benchmark:charts`).
- [ ] **Tooltip interactivity beyond SVG `<title>`/CSS hover** — still
  waiting on chart-side binding emission and a consumer; the app half
  thinned since this was filed (`eventFields` now carries pointer
  coordinates), so what remains is emitting bindings from chart marks
  and a floating-tooltip host pattern.
- [ ] **Streaming accumulators for the new types** — the stream adapter
  covers `line`/`bar`/`candlestick`; a `heatmap` accumulator (live
  scenario counts) and a `gauge` accumulator (latest-value) are the
  natural next consumers of the same unified `pair` events.
- [ ] **Radial tick strategy for many-axis radars** — past ~12 axes the
  spoke labels crowd; an every-other-label or leader-line strategy is
  the fix if a consumer hits it.
- [ ] **Sankey crossing reduction** — nodes stack in input order within
  a layer (like mermaid's dagre-lite, crossing minimization deferred);
  barycenter ordering is the known next lever.
- [ ] **Nested treemap** — the tiles are flat `{label, value}`; one
  hierarchy level (group borders, group-first squarify) would cover
  package→module breakdowns.

## Benchmarks, tooling & website

- [ ] **Shared benchmark harness library** — `jsonquery.js` and `jslt.js` duplicate ~250 lines of harness (option parsing, adaptive iterations, table rendering); extract it, and backport `jslt.js`'s `--filter` alias and stricter option validation either way.
- [ ] **Compile-mean coverage in `jslt.js`** — the compile row's stylesheet set omits the reshape stylesheet.
- [ ] **`--cell-order` shuffle** — the 4-book singular cell reads higher than the 1000-book one run to run (JIT/IC noise across the cell sequence); a shuffle option would pin it down if it ever matters.
- [ ] **Saxon-JS as an optional competitor** — noted and deliberately excluded so far (heavyweight SEF/XSLT toolchain for a zero-build workspace).
- [ ] **Drop the fontoxpath baseline-subtraction hack if a compile-only API appears** — the jsonquery adaptor pre-converts XDM and subtracts a baseline because fontoxpath exposes no compile-only entry point; a future compile-only API would let the adaptor measure it fairly.
- [ ] **Lint the benchmark workspace** — `benchmark/` sits outside the `npm run lint` glob; the tools follow house style but are not lint-enforced.
