![Jaren](jaren.png)

# Jaren

Jaren is a high-performance JSON toolchain written in vanilla JavaScript, built around a JSON Schema validating compiler with full support for `draft-06`, `draft-07`, `draft 2019-09` and `draft 2020-12`. Around that validator sits a coherent stack of compilers for the JSON standards that surround it: JSON Pointer, JSONPath, a JSON-native query language with XQuery 3.1 semantics, a JSON stylesheet/transformation layer, format validators, and framework-agnostic form generation — all zero-dependency, `eval`-free and CSP-safe, published under the MIT license.

Every engine in the repository follows one philosophy: **parse and decide everything once at compile time, then run a specialized closure**. That is where the speed comes from.

## ✅ Conformance & Speed

Jaren passes **100% of the official [JSON-Schema-Test-Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite)** — including the optional format suites — for all benchmarked drafts, while being faster than Ajv on the majority of individual test cases in every draft. All numbers below were measured on 2026-07-17 with Node v24.14.0; they are reproducible from the [benchmark workspace](benchmark/README.md), which documents each tool, suite and fairness decision. Micro-timing totals vary roughly ±10% run to run; the pass/fail counts are the invariant.

### @jarenjs/validate — vs Ajv over the official suite

`node benchmark/profiler.js --profile-all --draft draft7,draft2019-09,draft2020-12` (1000 iterations per test; the time totals cover the *success-only* tests, i.e. those Ajv can also compile and pass — Jaren additionally passes every test Ajv fails):

| Draft | Jaren | Ajv | Success-only totals | Jaren faster on |
|---|---|---|---|---|
| draft-07 | **308 passed, 0 failed, 0 errors** | 294 passed, 13 failed, 1 error | **117 ms** vs 151 ms | 205 of 294 tests |
| 2019-09 | **425 passed, 0 failed, 0 errors** | 406 passed, 15 failed, 4 errors | **200 ms** vs 212 ms | 240 of 406 tests |
| 2020-12 | **433 passed, 0 failed, 0 errors** | 390 passed, 33 failed, 10 errors | 198 ms vs **189 ms** | 217 of 390 tests |

These runs exercise `@jarenjs/formats` and `@jarenjs/refs` too: the optional format suites are included, and every draft's bundled meta-schemas are in play. The 2020-12 totals are a near-tie dominated by a handful of `unevaluated*` outliers; per-test medians favor Jaren in all three drafts.

### @jarenjs/json — four compiled engines, five benchmarks

- **JSONPath** (`npm run benchmark:jsonpath`, `:profile`): **all 703 tests** of the official [JSONPath Compliance Test Suite](https://github.com/jsonpath-standard/jsonpath-compliance-test-suite) pass (normalized paths included; json-p3 also passes 703). Performance vs [json-p3](https://www.npmjs.com/package/json-p3): **18.7x faster on the CTS mean** (151 ns vs 2.81 µs per query), and 4.9x (singular) to 81.8x (descendant `$..value`) on the synthetic 1000-item scenarios.
- **JSON Pointer** (`npm run benchmark:jsonpointer`): compiled getters resolve absolute pointers **12–16x faster** than the interpretive resolver they replaced and relative pointers (the `$data` hot path) **4–16x faster**, beating the `jsonpointer` npm package on every scenario (e.g. escaped keys: 37 ns vs 548 ns).
- **Jaren JSON Query** (`npm run benchmark:jsonquery:profile`): **14–215x faster** than [fontoxpath](https://www.npmjs.com/package/fontoxpath) (XQuery 3.1 in JavaScript) and **10–63x faster** than [jsonata](https://www.npmjs.com/package/jsonata) across the scenario matrix (filter, join, group, reshape at 4 → 10,000 books); compiles a query in 24 µs — 18.9x faster than fontoxpath, 2.7x faster than jsonata.
- **JSLT** (`npm run benchmark:jslt:profile`): the identity transform returns the input reference in **24–81 ns** regardless of document size (proof-of-no-change sharing; native JS and JSONata deep-copy in milliseconds), and every expressible transformation beats JSONata's transform operator by **6.6–45x**. Hand-written per-scenario JavaScript remains 3.4–143x faster than the generic dispatcher — the honestly measured cost of the abstraction.
- **QT3 scorecard** (`npm run benchmark:qt3`): the W3C XQuery/XPath 3.1 suite (31,821 cases) runs through the XQuery text front-end with **zero unattributed failures** — 1,858 passes, 21,191 honestly classified as outside the text subset, 540 attributed to the format's documented deviations, 0 regressions against the committed baseline.

This library started as a personal merge of some useful javascript algorithms, functions, modules and classes, I programmed or snippits that I used over the years; stuff that I used and didn't want to forget about and wrapped them in an organized way into a monorepo as a JSON Schema validating compiler library that anyone can use.

Please read [Understanding JSON Schema](https://json-schema.org/UnderstandingJSONSchema.pdf) for a more comprehensive guide on what JSON Schema is (not Jaren!).

## 🚀 Quick Start

### Installation

```bash
npm install
npm run build
```

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

There is an extensive [HOWTO](HOWTO.md) document in the root of this repository covering options, lightweight setups, custom formats, performance tips and common pitfalls.

## 📦 The packages

```
Programming is like sex.

One mistake and you have to support it for the rest of your life.
```

The monorepo is organized as a dependency chain — each package builds on the ones before it, and each has its own README and, where the internals warrant it, an ARCHITECTURE document:

| Package | What it is | Docs |
|---|---|---|
| [`@jarenjs/core`](packages/core) | Zero-dependency foundation: type guards, Unicode strings, text validators, math | [README](packages/core/README.md) · [ARCHITECTURE](packages/core/ARCHITECTURE.md) |
| [`@jarenjs/json`](packages/json) | JSON Pointer, JSONPath, the Jaren JSON Query language, JSLT stylesheets | [README](packages/json/README.md) · [ARCHITECTURE](packages/json/ARCHITECTURE.md) |
| [`@jarenjs/validate`](packages/validate) | The JSON Schema validating compiler | [README](packages/validate/README.md) · [ARCHITECTURE](packages/validate/ARCHITECTURE.md) |
| [`@jarenjs/formats`](packages/formats) | Format validators for the `format` keyword | [README](packages/formats/README.md) |
| [`@jarenjs/refs`](packages/refs) | The official JSON Schema meta-schemas, bundled for offline use | [README](packages/refs/README.md) |
| [`@jarenjs/forms`](packages/forms) | Framework-agnostic form generation from JSON Schema | [README](packages/forms/README.md) |

### 🤓 @jarenjs/core — the foundation

Everything the other packages are built on, none of it depending on JSON Schema: type guards and coercion helpers, grapheme-aware Unicode string handling, a large text-validation toolbox (emails, hostnames, IPs, URIs/IRIs, UUIDs, punycode, I-Regexp/RFC 9485), RFC 3339/ISO 8601 date-time parsing, fixed-width integer/float range validators, a char-code scanner toolkit for recursive-descent parsers, and asm.js-style int32/float64 math with 2D/3D vector classes. Every module can be used standalone in any JavaScript project — checking country codes, zip codes or IBAN numbers needs no schema. See [packages/core](packages/core/README.md).

### 🔍 @jarenjs/json — addressing, queries & stylesheets

The JSON addressing and transformation stack as compilers: JSON Pointer ([RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901)) with zero-allocation compiled getters, the fully compliant JSONPath engine ([RFC 9535](https://www.rfc-editor.org/rfc/rfc9535.html)), the **Jaren JSON Query format** — XQuery 3.1 semantics (FLWOR, joins, grouping, quantifiers, a 58-operator library) in JSON documents with JSONPath leaves — and **JSLT**, the recursive stylesheet layer where JSONPath matches position, JSON Schema matches shape, and query documents produce output. Query and stylesheet grammars are both published as JSON Schema twins (draft 2020-12 + draft-07) for validators and LLM structured output; an XQuery *text* front-end (`parseXQuery`) doubles as the bridge to the W3C QT3 test suite. The language contracts live in [QUERY-FORMAT.md](packages/json/docs/QUERY-FORMAT.md) and [JSLT-FORMAT.md](packages/json/docs/JSLT-FORMAT.md). See [packages/json](packages/json/README.md).

### ⚙️ @jarenjs/validate — the validating compiler

The heart of the repository: compiles JSON Schemas into optimized validation functions, with annotation-based `unevaluatedProperties`/`unevaluatedItems`, spec-compliant dynamic references, per-document draft handling, `$vocabulary` support, instance-data references (`data`/`$data`), and the `$query` extension keyword that embeds a Jaren JSON Query as a cross-field assertion — the class of constraint (arithmetic, ordering, aggregates, quantification) JSON Schema is notoriously bad at. The complete keyword list and capability walkthroughs are in the package README. See [packages/validate](packages/validate/README.md).

### ✍ @jarenjs/formats — format validators

All standard JSON Schema string formats (`date-time`, `email`, `idn-hostname`, `uri-template`, `uuid`, ...) plus many extras (`isbn10`, `mac`, `iban`, `color`, ...), numeric formats (`int8` ... `uint64`, `float16` ... `float64`), and the JSON addressing formats — including a `json-path` format checked against the complete RFC 9535 grammar by the real JSONPath parser. One canonical name → predicate registry backs both the validator's format compilers and forms' per-keystroke testers, so the two can never drift. See [packages/formats](packages/formats/README.md).

### 🔗 @jarenjs/refs — bundled meta-schemas

The official JSON Schema meta-schemas for all supported drafts, bundled so draft detection, `$vocabulary` processing and meta-validation work offline. See [packages/refs](packages/refs/README.md).

### 📝 @jarenjs/forms — form generation

Turns a JSON Schema into a framework-agnostic form model: a tree of field descriptors with labels, input-control hints, constraints and enum options. Validation happens in three layers on one stack — per-field on every keystroke (core primitives + the shared format registry), cross-field on every keystroke (`x-form` rules written as query documents: visibility, enablement, computed values, assertions), and authoritatively on submit (the compiled schema, optionally with the same rules copied into a `$query` keyword). Use it with React, Vue or vanilla DOM — the [playground](https://jklarenbeek.github.io/jarenjs/#/playground) renders its "Generated Form" tab with it. See [packages/forms](packages/forms/README.md).

## 🤖 Why Jaren matters for AI

Since 2023 I worked extensively with LLMs, and this repository is shaped by one conviction: **to work with language models naturally, we need to speak JSON all the way down.** JSON Schema is already the lingua franca of the LLM ecosystem — tool and function definitions are JSON Schema documents, and every major provider's structured-output mode constrains generation against one. Jaren is built to be the infrastructure on the receiving end of that:

- **Validate what the model produced, locally and strictly.** Provider structured-output implementations enforce varying subsets of JSON Schema regardless of the draft they declare. A validator that passes 100% of the official test suite — and is faster than the alternatives — is what you want between a model's output and your program. Compile the schema once; validating each generation is then sub-microsecond work that can sit inside an agent's inner loop.
- **Give the model a whole language, not just a shape.** The Jaren JSON Query and JSLT grammars are *closed vocabularies published as JSON Schema* ([query](packages/json/schemas/jaren-query.schema.json), [JSLT](packages/json/schemas/jaren-jslt.schema.json), each with a mechanically derived draft-07 twin for providers pinned to older drafts). Hand the schema to a constrained decoder and the model cannot emit an unknown operator, a wrong arity, or a malformed phrase — it generates *programs* that are data: queries that join and aggregate, stylesheets that transform. See [Generating queries with LLMs](packages/json/README.md#generating-queries-with-llms) for the worked pipeline.
- **Every failure is machine-repairable.** Compile and runtime errors from the query and JSLT engines carry a stable error `code` and a `docPath` — a JSON Pointer into the offending document — plus "did you mean" suggestions for unknown operators. That is exactly the feedback shape an LLM repair loop (or a training pipeline generating verified data) needs: not "something failed", but *where* and *what*.
- **Constraints models can't cheat.** The `$query` keyword puts cross-field assertions (sums, date ordering, quantification) inside the schema itself, so generated data is checked for internal consistency, not just structure. The `$valid`/`$assert`/`$as` operators point the other direction: queries and transforms that type-check their own data with JSON Schema.
- **Runs anywhere an agent runs.** No `eval`, no `new Function`, no runtime dependencies: the compilers are CSP-safe and sandbox-friendly by construction.

The author's further belief — stated as motivation, not as a measured result — is that this combination could propel LLM *training*: a JSON-native program language with a machine-checkable grammar, an executable engine, and precisely located error feedback is a natural source of verifiable synthetic tasks (generate → validate → compile → run → compare). The pieces for that loop all exist in this repository today; the training experiments do not.

## 📚 Documentation

```
Procrastination

I will look up what that means, later...
```

- [HOWTO.md](HOWTO.md) — practical usage guide: installation profiles, options, formats, `$ref` patterns, performance tips, pitfalls, API reference.
- [ARCHITECTURE.md](ARCHITECTURE.md) — how the monorepo fits together and the shared compile-to-closures design; each package links its own deeper ARCHITECTURE document from there.
- [ROADMAP.md](ROADMAP.md) — release milestones and everything still to be done or optimized, per package.
- [PUBLISHING.md](PUBLISHING.md) — npm authentication, synchronized versioning, release checks and publishing the six public workspaces.
- [benchmark/README.md](benchmark/README.md) — the complete measuring and debugging toolbox: conformance suites, profilers, the test-failure debugger, code coverage, call graphs, and the QT3 scorecard.
- Language specifications: [QUERY-FORMAT.md](packages/json/docs/QUERY-FORMAT.md) (the Jaren JSON Query format), [JSLT-FORMAT.md](packages/json/docs/JSLT-FORMAT.md) (the JSLT stylesheet format), [XQUERY-FRONTEND.md](packages/json/docs/XQUERY-FRONTEND.md) (the XQuery text subset).

For detailed API documentation beyond that, visit our official documentation. Which is the code itself — every public function carries JSDoc.

## 📅 Roadmap

The roadmap moved to its own document: [ROADMAP.md](ROADMAP.md). It tracks the release milestones (0.9 → 1.0 stable → beyond) together with every open item and optimization opportunity recorded during development, grouped per package — from the JSLT single-walk matcher optimizer and query hash joins to `errorMessage`, i18n and the website playground.

## 🤝 Contributing to Jaren

```
Is it true that when computer software is designed,
a back door is left for the designer to enter at will?
```

![Visual Studio Code](https://img.shields.io/badge/Visual%20Studio%20Code-0078d7.svg?style=for-the-badge&logo=visual-studio-code&logoColor=white)
![JavaScript](https://img.shields.io/badge/javascript-%23323330.svg?style=for-the-badge&logo=javascript&logoColor=%23F7DF1E)

We welcome contributions from the community! Here's how you can help:

1. Report Issues: Found a bug or have a feature request? Open an issue.
2. Improve Documentation: Help us make Jaren easier to use by improving our docs.
3. Add Tests: Increase our test coverage.
4. Implement New Features: Pick an item from our [roadmap](ROADMAP.md) and submit a pull request.

Run the test suite with `npm test` (per package: `npm run test:core`, `npm run test:json`, `npm run test:validate`) and lint with `npm run lint`; the [benchmark workspace](benchmark/README.md) documents how to reproduce every performance and conformance claim.

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
