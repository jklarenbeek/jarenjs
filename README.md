![Jaren](jaren.png)

# Jaren

Jaren is a high-performance JSON toolchain written in vanilla JavaScript, built around a JSON Schema validating compiler with full support for `draft-06`, `draft-07`, `draft 2019-09` and `draft 2020-12`. Around that validator sits a coherent stack of compilers for the JSON standards that surround it: JSON Pointer, JSONPath, a JSON-native query language with XQuery 3.1 semantics, a JSON stylesheet/transformation layer, format validators, and framework-agnostic form generation — all zero-dependency, `eval`-free and CSP-safe, published under the MIT license.

Every engine in the repository follows one philosophy: **parse and decide everything once at compile time, then run a specialized closure**. That is where the speed comes from.

## ✅ Conformance & Speed

Jaren scores **<!--bm:validate.conformance-->1164 of 1166<!--/bm-->** on the official [JSON-Schema-Test-Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite) — including the optional format suites — across all benchmarked drafts, counted independently of what the rival could compile; the cases that fail are named in [the roadmap](docs/ROADMAP.md). Against Ajv it is faster on <!--bm:validate.perTestWins-->742 of 1090<!--/bm--> of the tests both engines pass, and <!--bm:validate.vsAjv-->1.4<!--/bm-->x as fast on the success-only totals. All numbers below were measured on <!--bm:benchmarks.measured-->2026-08-02–2026-08-21 with Node v24.19.0/v22.22.2<!--/bm-->; they are reproducible from the [benchmark workspace](benchmark/README.md), which documents each tool, suite and fairness decision. Micro-timing totals vary roughly ±10% run to run; the pass/fail counts are the invariant.

### @jarenjs/validate — vs Ajv over the official suite

`node benchmark/profiler.js --profile-all --draft draft7,draft2019-09,draft2020-12` (1000 iterations per test; the time totals cover the *success-only* tests, i.e. those Ajv can also compile and pass — Jaren additionally passes every test Ajv fails):

<!--bm:validate.table-->
| Draft | Jaren | Ajv | Success-only totals | Jaren faster on |
|---|---|---|---|---|
| draft-07 | **308 passed, 0 failed, 0 errors** | 294 passed, 13 failed, 1 error | **94 ms** vs 165 ms | 216 of 294 tests |
| 2019-09 | **425 passed, 0 failed, 0 errors** | 406 passed, 15 failed, 4 errors | **170 ms** vs 208 ms | 275 of 406 tests |
| 2020-12 | **431 passed, 2 failed, 0 errors** | 390 passed, 33 failed, 10 errors | **144 ms** vs 189 ms | 251 of 390 tests |
<!--/bm-->

These runs exercise `@jarenjs/formats` and `@jarenjs/refs` too: the optional format suites are included, and every draft's bundled meta-schemas are in play. `unevaluatedProperties`/`unevaluatedItems` checks that sibling keywords make unreachable are compiled away entirely, so the `unevaluated*` outliers that once dragged the 2020-12 totals to a near-tie are gone; per-test medians favor Jaren in all three drafts.

### @jarenjs/json — <!--bm:json.engines-->6<!--/bm--> compiled engines, <!--bm:json.suites-->5<!--/bm--> benchmarks

- **JSONPath** (`npm run benchmark:jsonpath`, `:profile`): **<!--bm:jsonpath.ctsPass-->all 703<!--/bm--> tests** of the official [JSONPath Compliance Test Suite](https://github.com/jsonpath-standard/jsonpath-compliance-test-suite) pass (normalized paths included; json-p3 scores <!--bm:jsonpath.ctsRival-->all 703<!--/bm-->). Performance vs [json-p3](https://www.npmjs.com/package/json-p3): **<!--bm:jsonpath.ctsRatio-->8.8<!--/bm-->x faster across the CTS queries**, as the geometric mean of the per-query ratios (<!--bm:jsonpath.ctsTimes-->109 ns vs 0.966 µs<!--/bm--> per query, the same summary over the same rows), and 4.9x (singular) to 81.8x (descendant `$..value`) on the synthetic 1000-item scenarios.
- **JSON Pointer** (`npm run benchmark:jsonpointer`): compiled getters resolve absolute pointers **12–16x faster** than the interpretive resolver they replaced and relative pointers (the `$data` hot path) **4–16x faster**, beating the `jsonpointer` npm package on every scenario (escaped keys by an order of magnitude).
- **Jaren JSON Query** (`npm run benchmark:jsonquery:profile`): **14–215x faster** than [fontoxpath](https://www.npmjs.com/package/fontoxpath) (XQuery 3.1 in JavaScript) and **10–63x faster** than [jsonata](https://www.npmjs.com/package/jsonata) across the scenario matrix (filter, join, group, reshape at 4 → 10,000 books); compiles a query in <!--bm:jsonquery.compile-->39 µs — 13.8x faster than fontoxpath, 2.8x faster than jsonata<!--/bm-->.
- **JSLT** (`npm run benchmark:jslt:profile`): the identity transform returns the input reference in **24–81 ns** regardless of document size (proof-of-no-change sharing; native JS and JSONata deep-copy in milliseconds), and every expressible transformation beats JSONata's transform operator by **6.6–45x**. Hand-written per-scenario JavaScript remains 3.4–143x faster than the generic dispatcher — the honestly measured cost of the abstraction.
- **QT3 scorecard** (`npm run benchmark:qt3`): the W3C XQuery/XPath 3.1 suite (31,821 cases) runs through the XQuery text front-end with **zero unattributed failures** — 1,858 passes, 21,191 honestly classified as outside the text subset, 540 attributed to the format's documented deviations, 0 regressions against the committed baseline.

This library started as a personal merge of some useful javascript algorithms, functions, modules and classes, I programmed or snippits that I used over the years; stuff that I used and didn't want to forget about and wrapped them in an organized way into a monorepo as a JSON Schema validating compiler library that anyone can use.

Please read [Understanding JSON Schema](https://json-schema.org/UnderstandingJSONSchema.pdf) for a more comprehensive guide on what JSON Schema is (not Jaren!).

## 🚀 Quick Start

### Installation

```bash
npm install @jarenjs/validate @jarenjs/formats @jarenjs/refs
```

Node ≥ 24, ESM only, no third-party runtime dependencies. To pin a source
checkout instead of a registry version — or to work on Jaren itself — see
[CONSUMING.md](docs/CONSUMING.md).

### Basic Usage

```javascript
import { JarenValidator } from '@jarenjs/validate';

const jaren = new JarenValidator();

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer', minimum: 0 }
  },
  required: ['name']
};

const validate = jaren.compile(schema);

console.log(validate({ name: 'John', age: 30 })); // true
console.log(validate({ age: 30 }));               // false (missing required field)
console.log(validate({ name: 'John', age: -5 })); // false (age below minimum)
```

### Using External Schemas with `$ref`

```javascript
import { JarenValidator } from '@jarenjs/validate';

const jaren = new JarenValidator();

// Add external schemas that can be referenced
jaren.addSchema({
  $id: 'https://example.com/address.json',
  type: 'object',
  properties: {
    street: { type: 'string' },
    city: { type: 'string' }
  }
});

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    address: { $ref: 'https://example.com/address.json' }
  }
};

const validate = jaren.compile(schema);
```

There is an extensive [HOWTO](docs/HOWTO.md) document covering options, lightweight setups, custom formats, performance tips and common pitfalls.

## 📦 The packages

```
Programming is like sex.

One mistake and you have to support it for the rest of your life.
```

The monorepo is organized as a dependency chain of <!--bm:packages.count-->22<!--/bm--> published packages — each builds on the ones before it, and each has its own README and, where the internals warrant it, an ARCHITECTURE document:

| Package | What it is | Docs |
|---|---|---|
| [`@jarenjs/core`](packages/core) | Zero-dependency foundation: type guards, Unicode strings, text validators, math | [README](packages/core/README.md) · [ARCHITECTURE](packages/core/ARCHITECTURE.md) |
| [`@jarenjs/json`](packages/json) | JSON Pointer, JSONPath, the Jaren JSON Query language, JSLT stylesheets | [README](packages/json/README.md) · [ARCHITECTURE](packages/json/ARCHITECTURE.md) |
| [`@jarenjs/validate`](packages/validate) | The JSON Schema validating compiler | [README](packages/validate/README.md) · [ARCHITECTURE](packages/validate/ARCHITECTURE.md) |
| [`@jarenjs/formats`](packages/formats) | Format validators for the `format` keyword | [README](packages/formats/README.md) |
| [`@jarenjs/refs`](packages/refs) | The official JSON Schema meta-schemas, bundled for offline use | [README](packages/refs/README.md) |
| [`@jarenjs/emit`](packages/emit) | Build-time artifacts from JSON documents: JSON Schema → TypeScript declarations (and Markdown docs) through JTLT stylesheets, verified against the validator | [README](packages/emit/README.md) · [ARCHITECTURE](packages/emit/ARCHITECTURE.md) · [FORMAT](packages/emit/docs/EMIT-FORMAT.md) |
| [`@jarenjs/contract`](packages/contract) | Operation contracts: a `$contract` document declares JSON-in/JSON-out operations with kind, policy and an HTTP binding, compiled once into per-operation validators, transport normalizers and a static-beats-variable path matcher — served over HTTP, called with JSON outcomes, bound into app documents, projected to OpenAPI/TypeScript/Markdown/AI tools, revisioned and diffed | [README](packages/contract/README.md) · [FORMAT](packages/contract/docs/CONTRACT-FORMAT.md) |
| [`@jarenjs/forms`](packages/forms) | Framework-agnostic form generation from JSON Schema | [README](packages/forms/README.md) |
| [`@jarenjs/locales`](packages/locales) | Locale packs (message catalogs) for validate & forms error messages, and the calendar language the date kernel refuses to invent | [README](packages/locales/README.md) |
| [`@jarenjs/view`](packages/view) | The vnode format: UIs as JSON, with a keyed DOM patcher and SSR | [README](packages/view/README.md) · [FORMAT](packages/view/docs/VIEW-FORMAT.md) |
| [`@jarenjs/app`](packages/app) | Applications as JSON documents: the compiled dispatch loop | [README](packages/app/README.md) · [FORMAT](packages/app/docs/APP-FORMAT.md) |
| [`@jarenjs/flow`](packages/flow) | Executable workflow documents: jaren-fsm machines compiled to a pure step function, and jaren-dag dataflow graphs over the suite's engines | [README](packages/flow/README.md) · [FORMAT](packages/flow/docs/FLOW-FORMAT.md) |
| [`@jarenjs/md`](components/md) | Markdown + frontmatter as JSON documents: the parsing engine and the drop-in visual component | [README](components/md/README.md) · [FORMAT](components/md/docs/MD-FORMAT.md) |
| [`@jarenjs/mermaid`](components/mermaid) | A native, headless Mermaid clone: diagrams-as-code → geometry-free JSON AST → pure-vnode SVG, bidirectional | [README](components/mermaid/README.md) · [FORMAT](components/mermaid/docs/MERMAID-FORMAT.md) |
| [`@jarenjs/calc`](components/calc) | A multi-mode calculator (standard/scientific/programmer/financial/converter) as an @jarenjs/app document, with x·y/x·y·z plots as pure-vnode SVG; its numeric kernel lives in @jarenjs/core (math/finance/convert) | [README](components/calc/README.md) · [FORMAT](components/calc/docs/CALC-FORMAT.md) |
| [`@jarenjs/charts`](components/charts) | Headless charts: definition + data → geometry-free AST → pure-vnode SVG, thirteen types (pie/bar/line/scatter/candlestick/radar/gauge/boxplot/heatmap/treemap/streamgraph/sankey/map), with a stream adapter over the josl readers' events | [README](components/charts/README.md) · [ARCHITECTURE](components/charts/ARCHITECTURE.md) |
| [`@jarenjs/studio`](components/studio) | The jaren project IDE: a multi-file project (schema, view, actions, model, queries, flow) as one document — each file validated against its own grammar, assembled into runnable artifacts, edited and hosted by an embeddable studio widget | [README](components/studio/README.md) · [FORMAT](components/studio/docs/PROJECT-FORMAT.md) |
| [`@jarenjs/play`](components/play) | A JSON-engine playground: pick an engine (JSONPath/Pointer/Patch/$query/JSLT/markdown/mermaid), feed it a source input and one or more datasets from a curated example library, and watch it run — understand an engine standalone before composing it in the studio | [README](components/play/README.md) · [FORMAT](components/play/docs/PLAY-FORMAT.md) |
| [`@jarenjs/josl`](packages/josl) | JOSL, a streaming TOML superset, JSONX, and a self-healing CSV reader/writer — with incremental streaming readers for every dialect (JOSL/TOML/JSONX/strict JSON/CSV) | [README](packages/josl/README.md) · [FORMAT](packages/josl/FORMAT.md) |
| [`@jarenjs/linq`](packages/linq) | **The suite, by code.** C#-familiar fluent chains captured into plain query documents — deferred immutable sequences, a typed surface, one bounded async boundary, and a provider seam that pushes the same document anywhere — plus eight **pens** under their own subpaths, each writing exactly the published document another engine already takes (a JSON Schema, a database model, a JSLT stylesheet, a migration, a contract, a machine and a dataflow, an application, a form) with `Infer<>` types proven equal to emit's generated declarations; and `./db`, the store's typed front door over the package's one declared, optional-peer edge | [README](packages/linq/README.md) · [ARCHITECTURE](packages/linq/ARCHITECTURE.md) · [FORMAT](packages/linq/docs/LINQ-FORMAT.md) · [PENS](packages/linq/docs/PENS-FORMAT.md) |
| [`@jarenjs/db`](packages/db) | Documents in SQLite behind driver and dialect seams: model-declared collections, a pushdown planner with honest residuals and explain(), a safe profile for untrusted queries, and migrations as shadow-validated documents | [README](packages/db/README.md) · [ARCHITECTURE](packages/db/ARCHITECTURE.md) · [MODEL-FORMAT](packages/db/docs/MODEL-FORMAT.md) · [MIGRATION-FORMAT](packages/db/docs/MIGRATION-FORMAT.md) |
| [`@jarenjs/ai`](packages/ai) | Browser-side AI: one OpenAI-compatible client (OpenRouter/Ollama/LM Studio, bring-your-own-key), an embeddings client over the same providers behind one embedder seam, an SSE decoder, a tool registry whose inputs Jaren validates before every call, a bounded agent loop, WebMCP registration — a durable ledger (a persistent objective, evidenced memories and archived conversation rounds, so a compacted session can fetch back what it dropped and a run outlives the tab), and an environment the model works on by address rather than reads: it authors a compile-gated program over named slots, fans one bounded model call out per piece — each of which may be a depth-capped child agent over its own slice, sharing one budget with the whole tree — and answers a question over a whole corpus while the request stays flat | [README](packages/ai/README.md) |

### 🤓 @jarenjs/core — the foundation

Everything the other packages are built on, none of it depending on JSON Schema: type guards and coercion helpers, grapheme-aware Unicode string handling, a large text-validation toolbox (emails, hostnames, IPs, URIs/IRIs, UUIDs, punycode, I-Regexp/RFC 9485), RFC 3339/ISO 8601 date-time parsing, fixed-width integer/float range validators, a char-code scanner toolkit for recursive-descent parsers, and asm.js-style int32/float64 math with 2D/3D vector classes. The math kernel now covers transcendental completeness, BigInt word math, domain-free root finders, a `mat4`/projection 3D kernel and number formatting ([`math`](packages/core/docs/MATH.md)), plus two pure, reusable subpackages: [`@jarenjs/core/finance`](packages/core/docs/FINANCE.md) (TVM, cash-flow, amortization, interest, depreciation, bonds, technical indicators) and [`@jarenjs/core/convert`](packages/core/docs/CONVERT.md) (fixed-factor unit conversion + the pure `convertCurrency` rate-table primitive). Every module can be used standalone in any JavaScript project — checking country codes, zip codes or IBAN numbers needs no schema. See [packages/core](packages/core/README.md).

### 🔍 @jarenjs/json — addressing, queries & stylesheets

The JSON addressing and transformation stack as compilers: JSON Pointer ([RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901)) with zero-allocation compiled getters, the fully compliant JSONPath engine ([RFC 9535](https://www.rfc-editor.org/rfc/rfc9535.html)), the **Jaren JSON Query format** — XQuery 3.1 semantics (FLWOR, joins, grouping, quantifiers, a 104-operator library) in JSON documents with JSONPath leaves — and **JSLT**, the recursive stylesheet layer where JSONPath matches position, JSON Schema matches shape, and query documents produce output. Query and stylesheet grammars are both published as JSON Schema twins (draft 2020-12 + draft-07) for validators and LLM structured output; an XQuery *text* front-end (`parseXQuery`) doubles as the bridge to the W3C QT3 test suite. The language contracts live in [QUERY-FORMAT.md](packages/json/docs/QUERY-FORMAT.md) and [JSLT-FORMAT.md](packages/json/docs/JSLT-FORMAT.md). See [packages/json](packages/json/README.md).

### ⚙️ @jarenjs/validate — the validating compiler

The heart of the repository: compiles JSON Schemas into optimized validation functions, with annotation-based `unevaluatedProperties`/`unevaluatedItems`, spec-compliant dynamic references, per-document draft handling, `$vocabulary` support, instance-data references (`data`/`$data`), the `$query` extension keyword that embeds a Jaren JSON Query as a cross-field assertion — the class of constraint (arithmetic, ordering, aggregates, quantification) JSON Schema is notoriously bad at — and structured error messages (stable `msgid` + raw params on every error, the `errorMessage` keyword, report-time i18n through `@jarenjs/locales`). The complete keyword list and capability walkthroughs are in the package README. See [packages/validate](packages/validate/README.md).

### ✍ @jarenjs/formats — format validators

All standard JSON Schema string formats (`date-time`, `email`, `idn-hostname`, `uri-template`, `uuid`, ...) plus many extras (`isbn10`, `mac`, `iban`, `color`, ...), numeric formats (`int8` ... `uint64`, `float16` ... `float64`), and the JSON addressing formats — including a `json-path` format checked against the complete RFC 9535 grammar by the real JSONPath parser. One canonical name → predicate registry backs both the validator's format compilers and forms' per-keystroke testers, so the two can never drift. See [packages/formats](packages/formats/README.md).

### 🏗 @jarenjs/emit — your schemas, as TypeScript

The gap a schema-first codebase has where a Zod codebase has `z.infer`. The observation it is built on is small: **a JSON Schema is JSON, TypeScript is text, and JTLT is JSON-to-text** — so generating a declaration file is a stylesheet, not a new engine. Point `jaren-emit` at a directory of schemas and get `.d.ts` files with doc comments, unions, tuples, index signatures and recursive references; `--check` fails CI when a schema moved and the types did not.

What makes the output trustworthy is that Jaren owns both sides. The same schema becomes a **type** and a **validator**, and the [cyclic verification](packages/emit/README.md#the-cyclic-verification) requires the two to correspond over a corpus of instances: every schema-valid instance must type-check (the type is never narrower than the schema), every structurally invalid one must not (never wider), and the cases TypeScript genuinely cannot express — `minLength`, `pattern`, `format` — are asserted as widened *and written into the generated file as a comment*, because widening silently is the most common way a generated type misleads its reader. A standalone schema-to-TypeScript tool has no validator to disagree with; this one does, and the suite is itself checked by breaking the generator on purpose. See [packages/emit](packages/emit/README.md).

### 🔌 @jarenjs/contract — operations over the wire

The layer between two Jaren ends: a **`$contract` document** — the sibling of `$model`, `$fsm` and `jaren-app` — declares JSON-in/JSON-out operations (kind, one input schema, an output schema, declared errors, a behavior policy, a REST-faithful HTTP binding) and `compileContract` turns it once into per-operation validators, transport normalizers and a path matcher whose static segments beat variables regardless of registration order. The same compiled contract then **serves** over HTTP (`serveHttp` — a total dispatch pipeline over plain request/response objects, with `fetch` and `node` adapters and idempotency through a ledger interface), in-process (`local` — the test seam, SSR, a CLI calling its own operations) and over `MessagePort`/`Worker`/`BroadcastChannel` (`port` — JSON frames with collision-free client-scoped request ids; the website's cross-tab data studio runs on it), is **called** from the other end (`openHttpClient` — the same validator both sides, a JSON outcome for everything a server or a network can do, the attempt/trace/idempotency-key identities kept apart by construction), **streams** a `subscribe` operation as a `@jarenjs/db` live query over the wire (a snapshot, then LIVE-FORMAT `{ patch, seq }` emissions — SSE over http, push frames over port, resumable by seq), **binds** into a `@jarenjs/app` document (generated task slots and subscriptions plus one effect — no route strings, no hand-written wrappers), and **projects** to OpenAPI 3.1, TypeScript declarations, Markdown docs, AI tool definitions and a browser-safe public subset. The contract knows its own identity: `contract.revision()` is the SHA-256 of the canonical public projection, and `diffContracts` classifies any two versions' changes as breaking/additive/neutral/unknown by a published rule table — `jaren-contract diff --fail-on breaking` is the CI gate.

Measured on the committed 123-route table (`npm run benchmark:contract`): the matcher resolves the probe mix at <!--bm:contract.match.vs-fmw-->172 ns per lookup vs find-my-way's 180 ns<!--/bm--> — hono's TrieRouter is <!--bm:contract.match.vs-hono-->1.8x<!--/bm--> behind and its RegExpRouter refuses this table outright. The whole dispatch pipeline is <!--bm:contract.dispatch.vs-fastify-->2.8–15.1x<!--/bm--> faster than Fastify driven through its own `inject` (a number that includes Fastify's mock-stream harness, and the suite says so). The honest loss is published beside the wins: the bare pieces Fastify composes — find-my-way + Ajv + fast-json-stringify, no harness, no response validation — are <!--bm:contract.dispatch.losses-->2.4–7.5x<!--/bm--> faster than the pipeline that routes, decodes, validates both directions and settles every hostile input into a coded response (the wide end of the band is the bare `{ok:true}` route, where there is no work to amortize the pipeline against); over a real loopback socket the two stacks are level. See [packages/contract](packages/contract/README.md).

### 🔗 @jarenjs/refs — bundled meta-schemas

The official JSON Schema meta-schemas for all supported drafts, bundled so draft detection, `$vocabulary` processing and meta-validation work offline. See [packages/refs](packages/refs/README.md).

### 🌍 @jarenjs/locales — error messages in your language

Locale packs for the structured error messages of `@jarenjs/validate` and `@jarenjs/forms`: every failure carries a stable message key plus raw params, and human text renders at report time through a catalog of plain closures — `localizeErrors(result.errors, catalog)` is the whole post-hoc i18n story, with the `errorMessage` keyword and `$msgid` indirection keeping schema-authored messages translatable too. Packs never depend on a consumer package — only on the platform's `Intl` (plural rules, number and list formatting) and `@jarenjs/core` for the shared value renderer — so either the validator or the form layer can serve any pack. Every pack also carries the calendar language `@jarenjs/core/dates` refuses to invent — month, weekday and meridiem names for its `MMMM`/`EEE`/`a` tokens, signed relative-time phrases that are handed their amount instead of reading a clock, and the display names that turn *"Moet een geldige date-time zijn"* into *"Moet een geldige datum en tijd zijn"* — as repository data rather than `Intl`, so server-rendered output is the same bytes on every host and every Node version; `createIntlDateLocale` is the opt-in provider for a host that would rather have a hundred locales. Eleven ship (`nl`, `fr`, `es`, `pt`, `de`, `ja`, `ko`, `zhTW`, `ru`, `tr`, `ar`); the [pack-authoring guide](packages/locales/README.md) and the normative [ERROR-MESSAGES](packages/validate/docs/ERROR-MESSAGES.md) spec show how to add more. See [packages/locales](packages/locales/README.md).

### 📝 @jarenjs/forms — form generation

Turns a JSON Schema into a framework-agnostic form model: a tree of field descriptors with labels, input-control hints, constraints and enum options. Validation happens in three layers on one stack — per-field on every keystroke (core primitives + the shared format registry), cross-field on every keystroke (`x-form` rules written as query documents: visibility, enablement, computed values, assertions), and authoritatively on submit (the compiled schema, optionally with the same rules copied into a `$query` keyword). Use it with React, Vue or vanilla DOM — [Play](https://jklarenbeek.github.io/jarenjs/#/play) renders the JSON Schema engine's "Form" data view with it. See [packages/forms](packages/forms/README.md).

### 🖼 @jarenjs/view — user interfaces as JSON

The Jaren vnode format — text, `[tag, props?, ...children]` elements, spliced lists, data-only event bindings — published as a JSON Schema like the query and JSLT grammars, plus the two renderers that consume it: a keyed DOM patcher whose `oldVnode === newVnode` fast path is designed around the JSLT engine's structural sharing, and a pure `renderToString` for SSR. The only DOM-touching package in the suite; zero dependencies. The contract lives in [VIEW-FORMAT.md](packages/view/docs/VIEW-FORMAT.md). See [packages/view](packages/view/README.md).

### 🌀 @jarenjs/app — applications as JSON documents

[Hyperapp](https://github.com/jorgebucaran/hyperapp)'s dispatch loop rebuilt on the suite, with every slot a compiled Jaren document: the view is a JSLT stylesheet producing vnodes, actions are query documents producing transitions (next state or an RFC 6902 patch, computed from `$`, `$event`, `$payload`), subscriptions carry EBV `when` queries, and JavaScript enters only at named registries (effects, subscriptions, `compileTypeTest`, `validateState`). The whole app — state, view, actions — is one serializable JSON value: snapshot it, replay it, validate it, or generate it under constrained decoding. The contract lives in [APP-FORMAT.md](packages/app/docs/APP-FORMAT.md). See [packages/app](packages/app/README.md).

### 🔀 @jarenjs/flow — workflows as JSON documents

The suite's machines, executable: the **jaren-fsm format** (states, an initial state, a document-ordered transition table with query-document guards) compiled once into a pure step function whose effects come back as data, and the **jaren-dag format** (an acyclic dataflow whose nodes are the suite's own engines — queries, JSLT stylesheets, registered async tasks) compiled into a fail-closed, concurrently-evaluating executor. A machine hosts in `@jarenjs/app` through generated standard action documents — twin-oracle tested against the pure engine — and a dag hosts as one app effect; both grammars publish schema twins for constrained decoding, and `@jarenjs/mermaid` projects `stateDiagram ⇄ jaren-fsm` and `flowchart ⇄ jaren-dag` both ways as plain JSLT stylesheets, so the diagram, the document and the running machine stay three views of one JSON value.

The wedge, measured against XState v5 (`npm run benchmark:flow`): the pure `step` is several times faster than an actor's `send` and `compileFsm` beats `createMachine`+`createActor`, but the real point is a **conformance** fact — a jaren-fsm document is JSON *including its guards*, so it survives a `JSON.stringify` → `JSON.parse` round trip and still compiles and still fires its guard, where XState's guards are functions JSON drops and the restored machine throws "Guard not implemented". Serialize, store, diff, ship, replay a running machine. Published beside the wins are the losses: a compiled Jaren machine holds more memory than the actor (every guard is a compiled query), and a `compileDag` run costs ~8–20× a hand-written JavaScript pipeline — the honest price of dataflow as one serializable, constrained-decodable value. See [packages/flow](packages/flow/README.md).

### 📄 @jarenjs/md — Markdown as JSON documents

Where JTLT turns JSON into Markdown, `@jarenjs/md` is the inverse arrow: a from-scratch, zero-dependency parser (CommonMark core + GFM tables, strikethrough, task lists, footnotes and autolink literals + YAML/JSON/TOML frontmatter) whose output is a plain JSON AST published as a schema (`jaren-md-ast.schema.json`) — transformable with JSLT, addressable with queries, rendered by `@jarenjs/view` with content-hash keys and structural sharing so unchanged blocks patch in O(1). Extensibility is compile-time plugins (mermaid and a built-in syntax highlighter ship as the reference pair), loading is a lazy URL loader with caching, AbortSignal and block-by-block streaming, and `toMarkdown` prints canonical round-trip text. The scorecard against the official CommonMark examples runs in the benchmark workspace (`npm run benchmark:markdown`). See [components/md](components/md/README.md).

### 🌊 @jarenjs/josl — JOSL, JSONX & CSV, the streaming data languages

**JOSL** (*JavaScript Obvious Streaming Language*) is a strict superset of TOML 1.0 that makes JavaScript's obvious value types first-class citizens — `null`, bigint (`123n`), regexp (`/^ok$/i`), all four TOML datetime flavours — and adds a streamable `[[]]` root array for the most common LLM output shape: a list of records. The parser passes the complete official [toml-test](https://github.com/toml-lang/toml-test) 1.0.0 suite in strict TOML mode (the only engine in our benchmark that does), consumes chunk streams that may split *any* token, and reports document-order events with JSON-Pointer-able paths — the deliberate opposite of `JSON.parse`'s bottom-up reviver. **JSONX** is the same set of extensions over JSON, with a bit-compatible strict-JSON mode — and `createJsonxStreamReader` is its incremental reader: chunk-feedable at any split point, emitting the same `pair` events as the JOSL reader (one consumer, two syntaxes), with a strict-JSON mode that makes it a streaming `JSON.parse`. A streaming writer mirrors the reader for record-by-record output.

**CSV** is the third dialect, and the one where the machine's shape pays off differently: there is no specification worth conforming to, so the contract is stated instead. Reading is strict RFC 4180 by default — anything it forbids throws a `CsvSyntaxError` with a stable `CSV1xxx` code, a line and a column — while `repair: true` reads the same damage the way that loses the least and **logs every fix under the same code**. An unclosed quote, a stray quote inside a value, a ragged row: each has one obvious reading, and the reader takes it and says so, where other parsers heal silently or reject the file. `delimiter: 'auto'` sniffs the dialect by scoring how consistently each candidate divides records; `typed: true` promotes an integer past 2^53 to a bigint rather than rounding it and reads ISO dates as the same value classes JOSL yields. Run `npm run benchmark:toml`, `npm run benchmark:jsonx-stream` and `npm run benchmark:csv` for the compliance and speed numbers. See [packages/josl](packages/josl/README.md) and the [FORMAT.md](packages/josl/FORMAT.md) language definition.

## 🤖 Why Jaren matters for AI

Since 2023 I worked extensively with LLMs, and this repository is shaped by one conviction: **to work with language models naturally, we need to speak JSON all the way down.** JSON Schema is already the lingua franca of the LLM ecosystem — tool and function definitions are JSON Schema documents, and every major provider's structured-output mode constrains generation against one. Jaren is built to be the infrastructure on the receiving end of that:

- **Validate what the model produced, locally and strictly.** Provider structured-output implementations enforce varying subsets of JSON Schema regardless of the draft they declare. A validator scored against the whole official test suite, with whatever it fails published rather than dropped — and faster than the alternatives — is what you want between a model's output and your program. Compile the schema once; validating each generation is then sub-microsecond work that can sit inside an agent's inner loop.
- **Give the model a whole language, not just a shape.** The Jaren JSON Query and JSLT grammars are *closed vocabularies published as JSON Schema* ([query](packages/json/schemas/jaren-query.schema.json), [JSLT](packages/json/schemas/jaren-jslt.schema.json), each with a mechanically derived draft-07 twin for providers pinned to older drafts). Hand the schema to a constrained decoder and the model cannot emit an unknown operator, a wrong arity, or a malformed phrase — it generates *programs* that are data: queries that join and aggregate, stylesheets that transform. See [Generating queries with LLMs](packages/json/README.md#generating-queries-with-llms) for the worked pipeline.
- **Every failure is machine-repairable.** Compile and runtime errors from the query and JSLT engines carry a stable error `code` and a `docPath` — a JSON Pointer into the offending document — plus "did you mean" suggestions for unknown operators. That is exactly the feedback shape an LLM repair loop (or a training pipeline generating verified data) needs: not "something failed", but *where* and *what*.
- **Constraints models can't cheat.** The `$query` keyword puts cross-field assertions (sums, date ordering, quantification) inside the schema itself, so generated data is checked for internal consistency, not just structure. The `$valid`/`$assert`/`$as` operators point the other direction: queries and transforms that type-check their own data with JSON Schema.
- **Runs anywhere an agent runs.** No `eval`, no `new Function`, no runtime dependencies: the compilers are CSP-safe and sandbox-friendly by construction.
- **A model can author a whole application.** The website's [Studio](https://jklarenbeek.github.io/jarenjs/#/project) hosts an AI-authored `@jarenjs/app` document — state, view and actions as one JSON value — validated against the [jaren-app meta-schema](packages/app/schemas/jaren-app.schema.json) before every boot and iterated by RFC 6902 patches: the honest "one prompt → website", with no eval and no server.

The author's further belief — stated as motivation, not as a measured result — is that this combination could propel LLM *training*: a JSON-native program language with a machine-checkable grammar, an executable engine, and precisely located error feedback is a natural source of verifiable synthetic tasks (generate → validate → compile → run → compare). The pieces for that loop all exist in this repository today; the training experiments do not.

## 📚 Documentation

```
Procrastination

I will look up what that means, later...
```

- [HOWTO.md](docs/HOWTO.md) — practical usage guide: installation profiles, options, formats, `$ref` patterns, performance tips, pitfalls, API reference.
- [CONSUMING.md](docs/CONSUMING.md) — depending on Jaren from another project: npm packages or a pinned source/submodule checkout, package selection, declaration generation, Docker and bundling, upgrading a pin.
- [MIGRATING-FROM-ZOD.md](docs/MIGRATING-FROM-ZOD.md) — the idiom and error-shape map from Zod, the parity configuration, the measured head-to-head, and a staged migration order. Honest about what does not map.
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the monorepo fits together and the shared compile-to-closures design; each package links its own deeper ARCHITECTURE document from there.
- [ROADMAP.md](docs/ROADMAP.md) — release milestones and the open work per package. It lists what is *not* done: shipped capability is documented in the package docs, not there.
- [workflow/](docs/workflow/) — how this repository is changed and shipped, as process documentation: [`CONVENTIONS.md`](docs/workflow/CONVENTIONS.md) holds the rules once (repo model, gates, documentation rules, the close-out protocol); [`BOOTSTRAP.md`](docs/workflow/BOOTSTRAP.md) is the fresh-session prompt; the four playbooks are [`CAMPAIGN.md`](docs/workflow/CAMPAIGN.md) (build a capability across many orders), [`REFACTOR.md`](docs/workflow/REFACTOR.md) (the idempotent codebase-health pass), [`QUIRKS.md`](docs/workflow/QUIRKS.md) (the evidence-first hunt for what is wrong but not loud) and [`PUBLISHING.md`](docs/workflow/PUBLISHING.md) (authentication, synchronized versioning, the compatibility policy, release checks, provenance); plus the work-order and session-record templates, each followed by a real one executed from the bootstrap alone.
- [DESIGN.md](docs/DESIGN.md) — the visual design system and UI/UX constraints for the website and the visual components: brand palette, token vocabulary, spacing scale, breakpoints, accessibility rules and the host-linked theming architecture.
- [SECURITY.md](docs/SECURITY.md) — how to report a vulnerability privately, what is in scope, and the supply-chain posture.
- [benchmark/README.md](benchmark/README.md) — the complete measuring and debugging toolbox: conformance suites, profilers, the test-failure debugger, code coverage, call graphs, and the QT3 scorecard.
- Language specifications: [QUERY-FORMAT.md](packages/json/docs/QUERY-FORMAT.md) (the Jaren JSON Query format), [JSLT-FORMAT.md](packages/json/docs/JSLT-FORMAT.md) (the JSLT stylesheet format), [XQUERY-FRONTEND.md](packages/json/docs/XQUERY-FRONTEND.md) (the XQuery text subset), [VIEW-FORMAT.md](packages/view/docs/VIEW-FORMAT.md) (the vnode format), [APP-FORMAT.md](packages/app/docs/APP-FORMAT.md) (the app document format).

For detailed API documentation beyond that, visit our official documentation. Which is the code itself — every public function carries JSDoc.

## 📅 Roadmap

The roadmap lives in its own document: [ROADMAP.md](docs/ROADMAP.md). It tracks the remaining release milestones (1.0 stable → beyond) together with the open work per package — from the JSLT single-walk matcher optimizer and query hash joins to lazy `$range`, the `propertyDependencies` proposal and JSON Schema standard output formats.

It deliberately lists **only what is still open**. When something ships, its knowledge moves into the document a reader would actually reach for — the package `README`, its `ARCHITECTURE.md`, the format spec — and the entry leaves the roadmap. That is what keeps it a plan you can act on rather than a changelog you have to read past; the record of *when* something shipped is in the git history and the release tags.

## 🤝 Contributing to Jaren

```
Is it true that when computer software is designed,
a back door is left for the designer to enter at will?
```

![Visual Studio Code](https://img.shields.io/badge/Visual%20Studio%20Code-0078d7.svg?style=for-the-badge&logo=visual-studio-code&logoColor=white)
![JavaScript](https://img.shields.io/badge/javascript-%23323330.svg?style=for-the-badge&logo=javascript&logoColor=%23F7DF1E)

We welcome contributions from the community! Here's how you can help:

1. Report Issues: Found a bug or have a feature request? Open an issue. For a **security** problem, please use the private channel in [SECURITY.md](docs/SECURITY.md) instead of a public issue.
2. Improve Documentation: Help us make Jaren easier to use by improving our docs.
3. Add Tests: Increase our test coverage.
4. Implement New Features: Pick an item from our [roadmap](docs/ROADMAP.md) and submit a pull request.

Run the test suite with `npm test` (per package: `npm run test:core`, `npm run test:json`, `npm run test:validate`) and lint with `npm run lint` — the lint gate covers `packages`, `components`, `test`, `benchmark`, `scripts` and the root config files, and is expected to pass at **zero errors and zero warnings**, so a new warning is a finding to fix rather than noise to live with. `npm run test:browser` additionally drives the built website through real Chromium, Firefox and WebKit ([how to run it](packages/website/README.md#browser-tests)). The [benchmark workspace](benchmark/README.md) documents how to reproduce every performance and conformance claim.

## ❓ Frequently Asked Questions

```
  So frequently asked
  but never out spoken
  what shadow arises
  what hath thou awoken
```

<details><summary>

#### Why!?, Why would you create another json schema validator?
</summary>

I am aware of the excellent `Ajv` and `zod` validators, but I really wanted to understand json schema and I wanted to do something else (see if I could beat its first place in speed). We as programmers work with validation all over the place, especially at the front-end, but also at the back-end and in the middle-ware. Since 2023 I started working a lot with LLM's and I believe that in order to work with them in a more natural way, we need to speak JSON, all the way down. So I decided to create a JSON Schema validator that is fully compliant with the JSON Schema specification and should be fast for the fun of it, but that is also easy to understand and easy to extend. Not by plugins perse, but by simply opening up the code and see what is going on.

</details>

<details><summary>

#### Why would you program it in vanilla javascript and not use typescript?
</summary>

Good question! I believe that vanilla javascript for a library like this is a little bit more straight forward to understand. And to be honest, I just like javascript. TypeScript is an excellent language but there is also a lot of boilerplate code that might be a bit too much for what we are trying to accomplish here. And I don't want to use a transpiler that might destroy my intentions of how it should be working, since I understand how the JIT compiler is working very well. Also I do use JSDoc to generate the documentation for the code and that should be enough for most of the users and TypeScript libraries when they want to make use of Jaren. Therefor I don't see the need for TypeScript here.

</details>

## 🙏 Be excellent to yourself, and each other!

If you find bugs, or want to know what a function is doing, please don't hesitate to ask me by filing an issue. Off topic questions I'd rather not see, but any jaren related question is very welcome.

Please file an issue at [the github jaren repository](https://github.com/jklarenbeek/jarenjs/issues).
