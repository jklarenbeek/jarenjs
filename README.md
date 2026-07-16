![Jaren](jaren.png)

# Jaren

Jaren is a high-performance JSON Schema Validating Compiler written in vanilla JavaScript. It offers full support for `draft-06`, `draft-07`, `draft 2019-09` and `draft 2020-12`.

## ✅ Conformance & Speed

Jaren passes **100% of the official [JSON-Schema-Test-Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite)** — including the optional format suites — for all benchmarked drafts, while validating faster than Ajv:

| Draft | Jaren | Ajv | Speed (full suite, 1000 iterations) |
|---|---|---|---|
| draft-07 | **0 failures / 0 errors** | 13 failures / 1 error | Jaren 425ms vs Ajv 530ms |
| 2019-09 | **0 failures / 0 errors** | 15 failures / 4 errors | Jaren 592ms vs Ajv 835ms |
| 2020-12 | **0 failures / 0 errors** | 33 failures / 10 errors | Jaren 647ms vs Ajv 714ms |

Reproduce these numbers yourself with `node benchmark/profiler.js --profile-all --draft draft2020-12`.

The same treatment is applied to JSONPath: `@jarenjs/json` ships an [RFC 9535](https://www.rfc-editor.org/rfc/rfc9535.html) query compiler that passes all 703 tests of the official [JSONPath Compliance Test Suite](https://github.com/jsonpath-standard/jsonpath-compliance-test-suite) (normalized paths included) and backs the strict `json-path` format. Run `node benchmark/jsonpath.js --profile` to compare it against [json-p3](https://www.npmjs.com/package/json-p3).

On top of that sits the **Jaren JSON Query** engine: FLWOR joins, grouping and reshaping with XQuery 3.1 semantics, written as JSON documents with JSONPath leaves. Run `npm run benchmark:jsonquery:profile` to compare it against [fontoxpath](https://www.npmjs.com/package/fontoxpath) and [jsonata](https://www.npmjs.com/package/jsonata), or `npm run benchmark:qt3` for the W3C QT3 scorecard. See [packages/json](packages/json/README.md).

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

There is an extensive [HOWTO](HOWTO.md) document in the root of this repository.

### Debug Tool

A powerful debugging utility for investigating test failures and understanding schema validation behavior.

```bash
# List all test files for a draft
node benchmark/debug.js --list-files --draft 2019

# List all test cases in a file with keyword summaries
node benchmark/debug.js '/anchor.json' --list --draft 2019

# Run a specific test suite with draft selection
node benchmark/debug.js '/anchor.json' --draft 2019

# Run a specific test by description (partial match)
node benchmark/debug.js '/anchor.json' 'same $anchor' --draft 2019

# Run a specific test by index
node benchmark/debug.js '/anchor.json' --index 3 --draft 2019

# Export test suite to JSON
node benchmark/debug.js '/anchor.json' --export anchor-tests.json --draft 2019

# Export specific test case
node benchmark/debug.js '/anchor.json' --index 3 --export-test test.json --draft 2019

# Dry run - show schema and assertions without validating
node benchmark/debug.js '/anchor.json' --dry-run --draft 2019

# Show detailed validation errors
node benchmark/debug.js '/ref.json' 'nested refs' --show-errors

# Interactive mode - step through assertions
node benchmark/debug.js '/ref.json' 'nested refs' --interactive

# Detailed comparison between Jaren and AJV
node benchmark/debug.js '/ref.json' 'nested refs' --compare

# Verbose output with full schema and data
node benchmark/debug.js '/ref.json' 'nested refs' --verbose
```

### Running the Benchmark Suite

The benchmark suite runs Jaren against the official JSON Schema Test Suite and compares results with Ajv.

```bash
# Profile specific test suite with draft selection
node benchmark/profiler.js '/ref.json' --profile --draft 2019 --iterations 1000

# Profile all tests for multiple drafts
node benchmark/profiler.js --profile-all --draft draft7,draft2019-09,draft2020-12

# Export results to JSON with custom file path
node benchmark/profiler.js --profile-all --output json --filepath results.json

# Show only top 10 slowest tests
node benchmark/profiler.js '/ref.json' --profile --top 10

# Only include tests where all engines succeed
node benchmark/profiler.js '/ref.json' --profile --success-only

# Full options
Options:
  --profile              Profile a specific test file
  --profile-all          Profile all test files
  --iterations, -i N     Number of iterations (default: 1000)
  --output, -o FORMAT    Output format: console, csv, json (default: console)
  --draft, -d VERSION    JSON Schema draft version(s), comma-separated
                         Supported: draft6, draft7, draft2019-09, 2019, draft2020-12, 2020
  --filepath, -f PATH    Output file path for csv/json
  --top N                Show only top N slowest tests
  --success-only         Only include tests where all agents succeed
  --verbose, -v          Verbose output
```

The JSONPath compiler has its own benchmark, driven by the official [JSONPath Compliance Test Suite](https://github.com/jsonpath-standard/jsonpath-compliance-test-suite) (a git submodule at `benchmark/jsonpath-suite/`, initialized with `git submodule update --init`):

```bash
# Compliance run over all engines (Jaren and json-p3)
node benchmark/jsonpath.js

# Performance comparison per query, plus synthetic large-document scenarios
node benchmark/jsonpath.js --profile --scale
```

### Code Coverage Analysis

Analyze which functions are touched - and which are not - when running the
official test suite and/or the repository unit tests. Coverage from every
run is merged into a single report, so you get one complete picture to
decide where tests are missing and what might be dead code:

```bash
# The full picture: every draft of the official suite PLUS the unit tests
node benchmark/coverage.js --all --unit-tests

# Complete official suite (draft7, 2019-09, 2020-12) with per-function detail
node benchmark/coverage.js --all --functions

# Machine readable output for diffing between runs
node benchmark/coverage.js --all --unit-tests --json coverage/analysis.json

# What does a single suite file touch?
node benchmark/coverage.js '/required.json' --threshold 25

# Show TOUCHED and NOT touched functions with hit counts
node benchmark/coverage.js '/required.json' --functions

# Full options
What to run (combine freely; at least one is required):
  <testfile.json>    Cover a single official-suite file (e.g. '/ref.json')
  --all              Cover the COMPLETE official suite (all drafts)
  --unit-tests       Cover the repository unit tests (node --test test/)

Options:
  --draft <list>     Draft(s) to run, comma separated
                     (default for --all: draft7,draft2019-09,draft2020-12)
  --iterations <n>   Profiling iterations (default: 1 with --all, 1000 single file)
  --threshold <n>    Only show files with function coverage > n% (default: 0)
  --functions        Show TOUCHED and NOT touched functions
  --touched-only     Show only TOUCHED functions
  --json <path>      Write the full analysis as JSON
  --temp-dir <dir>   Temporary directory for V8 coverage data
```

The report ends with three actionable sections: **untouched functions**
(add tests or consider removal), **files with 0% function coverage**, and
**files never loaded at all** - the strongest dead-code candidates.

The benchmark results are written to `benchmark/results/results.html`.

### Call Graph Analysis

Call graph analysis using Node.js built-in profiler.

```bash
# Generate call graph for a test suite
node benchmark/callgraph.js '/ref.json'

# More iterations for better accuracy
node benchmark/callgraph.js '/ref.json' --iterations 5000 --top-functions=30

# Show deeper call chains
node benchmark/callgraph.js '/ref.json' --max-depth=15

# Include Node.js internal functions
node benchmark/callgraph.js '/ref.json' --include-internals

# Filter by pattern
node benchmark/callgraph.js '/ref.json' --filter 'validate'

# Full options
Options:
  --iterations, -i N       Number of iterations (default: 1000)
  --top-functions N        Show top N hottest functions (default: 20)
  --max-depth N            Maximum call chain depth (default: 10)
  --filter <pattern>       Filter functions by pattern (default: jaren)
  --include-internals      Include Node.js internal functions
  --verbose, -v            Show detailed output
```

### Running Tests

```bash
# Run all tests
npm test

# Run all tests with coverage
npm run cover

# Run only core or validate package tests
npm run test:core
npm run test:validate
```

## 🔑 JSON Schema Validation Keywords

```
Programming is like sex.

One mistake and you have to support it for the rest of your life.
```

Jaren supports the full set of JSON Schema validation keywords. Here's a quick overview:

- JSON data type: `type`, `nullable`, `required`
- Numbers: `maximum`, `minimum`, `multipleOf`
- Strings: `maxLength`, `minLength`, `pattern`
- Arrays: `maxItems`, `minItems`, `uniqueItems`, `items`, `prefixItems`, `contains`, `unevaluatedItems`
- Objects: `maxProperties`, `minProperties`, `required`, `properties`, `patternProperties`, `unevaluatedProperties`
- All types: `enum`, `const`
- Compound: `not`, `oneOf`, `anyOf`, `allOf`, `if/then/else`
- Meta: `$schema`, `$id`, `$ref`, `$anchor`, `$dynamicRef`/`$dynamicAnchor`, `$recursiveRef`/`$recursiveAnchor`, `$vocabulary`
- **Non-standard**: `data` (json-everything's [data-ref](https://docs.json-everything.net/schema/examples/data-ref/) proposal) and Ajv-style `$data` references

<details>
<summary>🔥 For a complete list of supported keywords and their implementation status, click here</summary>

### 🔑 JSON data type

- type
- nullable | _(OpenAPI)_
- required | _as boolean (OpenAPI)_

### 🔑 Keywords for numbers

- maximum / minimum<br />or exclusiveMaximum / exclusiveMinimum
- multipleOf

### 🔑 Keywords for strings

- maxLength / minLength
- pattern

### 🔑 Keywords for format

- format
- formatMinimum / formatMaximum<br />or formatExclusiveMinimum / formatExclusiveMaximum

### 🔑 Keywords for array

- maxItems / minItems
- uniqueItems
- items
  - items | as schema or tuple _deprecated in `draft2020`_
  - items | as schema only _new `draft2020`_
- prefixItems | as tuple _new `draft2020`_
- additionalItems | as schema _deprecated in `draft2020`_
- contains
- maxContains / minContains | _new `draft2019`_
- unevaluatedItems | _new `draft2019`_

### 🔑 Keywords for object

- maxProperties / minProperties
- required | _as array!_
- properties
- patternProperties
- additionalProperties
- dependencies | _deprecated in `draft2019`_
- dependentRequired | _new `draft2019`_
- dependentSchemas | _new `draft2019`_
- propertyNames
- unevaluatedProperties | _new `draft2019`_
- ❌ [propertyDependencies](https://github.com/json-schema-org/json-schema-spec/blob/main/proposals/propertyDependencies.md)

### 🔑 Keywords for all types

- enum
- const

### 🔑 Compound keywords

- not
- oneOf
- anyOf
- allOf
- if / then / else

See also:
- [Schema Composition](https://json-schema.org/understanding-json-schema/reference/combining)
- [Applying Subschemas Conditionally](https://json-schema.org/understanding-json-schema/reference/conditionals)

### 🔑 Meta keywords

- $schema | used for draft detection, vocabulary selection and cross-draft references
- $id
- $ref
- $anchor
- $recursiveRef | _new `draft2019` &amp; deprecated in `draft2020`_
- $recursiveAnchor | _new `draft2019` &amp; deprecated in `draft2020`_
- $dynamicRef | _new `draft2020`_
- $dynamicAnchor | _new `draft2020`_
- $data | _(Ajv specific)_
- [$vocabulary](https://github.com/json-schema-org/json-schema-spec/blob/main/proposals/vocabularies.md) | _new `draft2019`_ - a custom metaschema that omits the validation vocabulary turns keywords like `type` and `minimum` into annotations; a metaschema that declares the `format-assertion` vocabulary turns format assertion on

### 🔑 Non-standard keywords

- `data` | json-everything's [data-ref](https://docs.json-everything.net/schema/examples/data-ref/) proposal

  The `data` keyword allows you to reference values from the instance being validated, enabling dynamic constraints based on other parts of the data.

  **Example - Requiring B >= A:**
  ```json
  {
    "type": "object",
    "properties": {
      "A": { "type": "number" },
      "B": {
        "type": "number",
        "data": {
          "minimum": "/A"
        }
      }
    }
  }
  ```
  - Passes: `{ "A": 5, "B": 10 }` (10 >= 5)
  - Fails: `{ "A": 15, "B": 10 }` (10 < 15)

  **Example - Enum from instance array:**
  ```json
  {
    "type": "object",
    "properties": {
      "color": {
        "data": {
          "enum": "/validColors"
        }
      },
      "validColors": {
        "type": "array",
        "items": { "type": "string" }
      }
    }
  }
  ```

  **Supported keywords within `data`:**
  - Number constraints: `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`
  - String constraints: `minLength`, `maxLength`, `pattern`, `format`
  - Array constraints: `minItems`, `maxItems`
  - Object constraints: `minProperties`, `maxProperties`
  - Value constraints: `enum`, `const`

  Both absolute JSON Pointers (e.g., `/A`, `/limits/min`) and relative JSON Pointers (e.g., `0/parent`, `1/sibling`) are supported.

### 🔑 Miscellaneous keywords

- ❌ strict
- ❌ strictFormat
- ❌ strictTuple
- ❌ errorMessage
- definitions | used by initial schema traversal _deprecated in `draft2019`_
- $defs | used by initial schema traversal _new `draft2019`_
- components | _(OpenAPI)_

</details>

## ✍ JSON Schema Validation Formats

Jaren supports various format validators for strings and numbers, including:

- Date and Time: `date-time`, `date`, `time`
- URLs and Emails: `url`, `email`, `hostname`, `ipv4`, `ipv6`
- Identifiers: `uuid`, `guid`, `identifier`
- Numbers: `int8`, `uint8`, `int16`, `uint16`, `int32`, `uint32`, `float32`, `float64`

But we have many more formats that are not listed here!

Format assertion follows the specification per draft: through draft 2019-09 the `format` keyword asserts by default; from draft 2020-12 on it is annotation-only unless enabled. You can control this explicitly with the `formatAssertion` option (`new JarenValidator({ formatAssertion: true })`), or through a custom metaschema that declares the `format-assertion` vocabulary.

<details>
<summary>🔥 For a complete list of supported formats, click here</summary>

### ✍ Formats for strings

These format validators are based on the [json-schema.org](https://json-schema.org/understanding-json-schema/reference/string.html#built-in-formats) website.

#### 🗨 Formats for datetime

- `date-time` | according to [RFC3339](https://datatracker.ietf.org/doc/html/rfc3339#section-5.6), time-zone is mandatory
- `date` | according to [RFC3339](https://datatracker.ietf.org/doc/html/rfc3339#section-5.6), time-zone is mandatory
- `time` | according to [RFC3339](https://datatracker.ietf.org/doc/html/rfc3339#section-5.6), time-zone is mandatory

- `duration` | duration from RFC3339
- `iso-date-time` | ISO 8601 date-time with optional timezone
- `iso-time` | ISO 8601 time with optional timezone

*Note: All date time formats can use formatMinimum / formatMaximum and formatExclusiveMinimum and formatExclusiveMaximum*

#### 🗨 Formats for url's, hostnames and emails

- `url` | full URL
- `url--full` | same as `url`, but more comprehensive
- `uri` | full URI
- `uri--full` | same as `uri`, but more comprehensive
- `uri-reference` | URI reference, including full and relative URIs
- `uri-reference--full` | same as `uri-reference`, but more comprehensive
- `uri-template` | URI template according to [RFC6570](https://datatracker.ietf.org/doc/html/rfc6570)
- `iri` | full URI with international characters
- `iri-reference` | full URI reference with with international characters

- `email` | email address
- `email--full` | same as email, but more comprehensive
- `hostname` | host name according to [RFC1034](https://datatracker.ietf.org/doc/html/rfc1034#section-3.5)
- `idn-hostname` | host name with international characters
- `idn-email` | email address with international characters

#### 🗨 Formats for identifiers

- `uuid` | Universally Unique IDentifier according to [RFC4122](https://datatracker.ietf.org/doc/html/rfc4122)
- `guid` | Globally Unique IDentifier according to Microsoft

- `identifier` | C-type identifier
- `html-identifier` | html element `id` attribute identifier according to [RFC7992](https://datatracker.ietf.org/doc/html/rfc7992#section-5.1)
- `css-identifier` | css class name identifier according to [RFC7993](https://datatracker.ietf.org/doc/html/rfc7993)

- `mac` | ethernet interface identifier (EUI-48) according to [IEEE820](https://en.wikipedia.org/wiki/MAC_address)
- `ipv4` | IP v4 address according to [RFC791](https://datatracker.ietf.org/doc/html/rfc791)
- `ipv6` | IP v6 address according to [RFC2460](https://datatracker.ietf.org/doc/html/rfc2460)

#### 🗨 Formats for json pointers and paths

These are grouped in `jsonFormats` of the `@jarenjs/formats` package.

- `json-pointer` | JSON-pointer according to [RFC6901](https://datatracker.ietf.org/doc/html/rfc6901)
- `json-pointer-uri-fragment` | JSON-pointer fragment according to [RFC6901](https://datatracker.ietf.org/doc/html/rfc6901#section-6)
- `relative-json-pointer` | relative JSON-pointer according to [draft-luff-relative-json-pointer-00](https://datatracker.ietf.org/doc/html/draft-luff-relative-json-pointer-00)
- `json-path` | JSONPath query according to [RFC9535](https://www.rfc-editor.org/rfc/rfc9535.html), checked against the complete grammar (including filter well-typedness) by the parser of the JSONPath compiler in `@jarenjs/json`

#### 🗨 Miscellaneous formats

- `alpha` | allow only ASCII alpha characters (a-zA-Z)
- `numeric` | allow only numeric characters (0-9)
- `alphanumeric` | allow only ASCII alpha numeric characters
- `hexadecimal` | allow only hexadecimal characters (0-9a-fA-F)
- `uppercase` | allow only upper case alpha characters
- `lowercase` | allow only lower case alpha characters
- `color` | web color hex string (starts with #, must be 3 or 6 hax characters)
- `regex` | tests whether a string is a valid regular expression
- `base64` | base64 encoded data
- `byte` | same as `base64` format

- `isbn10` | International Standard Book Number 10 digit number
- `isbn13` | International Standard Book Number 13 digit number

- `country2` | Country code by alpha-2 according to ISO3166-1 _!No tests exists!_
- `iban` | International Bank Account Number _!No tests exists!_

### ✍ Formats for numbers

Formats for numbers validate both numbers and strings as number types; combine them with the `type` keyword (e.g. `{ "type": "integer", "format": "int32" }`) when only real number types should be allowed.

#### 🗨 Formats integer numbers

- `int8` | signed 8 bit integer
- `uint8` | unsigned 8 bit integer
- `int16` | signed 16 bit integer
- `uint16` | unsigned 16 bit integer
- `int32` | signed 32 bit integer
- `uint32` | unsigned 32 integer
- `int64` | signed 64 integer
- `uint64` | unsigned 64 integer

#### 🗨 Formats floating point numbers

- `float16` | 16 bit floating point number
- `float32` | 32 bit floating point number
- `float64` | 64 bit floating point number
- `float` | 32 bit floating point number
- `double` | 64 bit floating point number

</details>

## 📅 Roadmap

```
My manager tried to open that door before,
but it apparently was scheduled for the next release.
```

- 0.9
  - current
  - [x] Jaren as a drop-in replacement for Ajv
  - [x] add [benchmark](https://github.com/ebdrup/json-schema-benchmark) test suite for `draft7`
  - [x] Fixing JSON error schema output
  - [x] add error reporting tests
  - [x] full `draft7` compliance (100% of the official test suite)
  - [x] full `draft2019` compliance: `unevaluatedProperties`, `unevaluatedItems`, `$recursiveRef`/`$recursiveAnchor`, `$vocabulary`, cross-draft references
  - [x] full `draft2020` compliance: `prefixItems`/`items`, `$dynamicRef`/`$dynamicAnchor`, format-annotation semantics
  - [x] Runtime schema manipulation of constraints (via `data` keyword - json-everything's data-ref proposal)
  - [x] add development documentation
  - [x] add examples
- 🎉 1.0 Stable release
  - [ ] add AI bot workflow and bootstrap prompt
  - [ ] add a website to github pages with typescript and react.
  - [ ] add i18n - translations of errors should be available!
- 1.1
  - [ ] [propertyDependencies](https://github.com/json-schema-org/json-schema-spec/blob/main/proposals/propertyDependencies.md) proposal
  - [ ] `errorMessage` keyword ([Fixing JSON Schema output](https://json-schema.org/blog/posts/fixing-json-schema-output))
- 1.2
  - [ ] compileAsync for asynchronous schema loading
  - [ ] JSON.parse reviver / JSON.stringify replacer integration

<details>
<summary>🔥 For details about the notable capabilities behind that roadmap, click here</summary>

## 🛠️ Notable capabilities

### 👉 Modelling Inheritance with JSON Schema

Jaren fully supports `unevaluatedProperties`, so the inheritance patterns from the [Modelling Inheritance](https://json-schema.org/blog/posts/modelling-inheritance) blog post work out of the box. Annotations flow from `properties`, `patternProperties`, `additionalProperties` and every in-place applicator (`allOf`/`anyOf`/`oneOf`/`if-then-else`/`$ref`/`dependentSchemas`), with annotations from failed branches correctly discarded.

See also:
- [json-schema-core](https://json-schema.org/draft/2020-12/json-schema-core#name-unevaluatedproperties)
- [Combining unevaluatedProperties and ref: # #375](https://github.com/orgs/json-schema-org/discussions/375)

### 👉 Express array constraints more cleanly

Jaren fully supports `unevaluatedItems`, covering the array patterns from the 2020-12 [release notes](https://json-schema.org/draft/2020-12/release-notes#contains-and-unevaluateditems): items evaluated by `items`, `prefixItems`, `additionalItems` and (in 2020-12) `contains` are tracked, and everything left over is validated by the `unevaluatedItems` schema.

### 👉 Using Dynamic References to Support Generic Types

Jaren fully supports `$dynamicRef`/`$dynamicAnchor` (2020-12) and `$recursiveRef`/`$recursiveAnchor` (2019-09), including the generic-type patterns from the [dynamicRef and generics](https://json-schema.org/blog/posts/dynamicref-and-generics) blog post. Resolution follows the specification's dynamic-scope rules: entering a schema resource brings all of its dynamic anchors into scope, and a `$dynamicRef` resolves to the anchor in the outermost resource of the dynamic scope.

See also:
- [Understanding lexical dynamic scopes](https://json-schema.org/blog/posts/understanding-lexical-dynamic-scopes)
- [$dynamicRef and $dynamicAnchor](https://json-schema.org/draft/2020-12/release-notes#dollardynamicref-and-dollardynamicanchor)

### 👉 Runtime schema manipulation of constraints

Jaren supports the `data-ref` proposal from json-everything through the `data` keyword, plus Ajv-style `$data` references. Both allow a schema constraint to take its value from the instance being validated:

- Absolute JSON Pointers (e.g., `/A`, `/limits/min`)
- Relative JSON Pointers (e.g., `0/parent`, `1/sibling`)
- All common constraint keywords: `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`, `format`, `enum`, `const`, `minItems`, `maxItems`, `minProperties`, `maxProperties`

See also:
- [$data](https://github.com/json-schema-org/json-schema-spec/issues/51)
- [Ajv $data spec](https://github.com/ajv-validator/ajv/tree/master/spec/extras/%24data)
- [data-ref](https://docs.json-everything.net/schema/examples/data-ref/)

### 👉 Vocabularies and cross-draft references

A schema's `$schema` declaration is honored per document: referenced documents that declare a different draft are processed with that draft's keyword set (a draft-07 document ignores `dependentRequired`; a 2019-09 document ignores `prefixItems`). Custom metaschemas with `$vocabulary` are respected — omitting the validation vocabulary turns validation keywords into annotations, and declaring `format-assertion` turns format assertion on.

</details>

## 📚Documentation

```
Procrastination

I will look up what that means, later...
```

For a detailed overview of the [architecture](ARCHITECTURE.md) and how Jaren works please see [ARCHITECTURE.md](ARCHITECTURE.md) in the root of this repository.

For detailed documentation on using Jaren, including API references and advanced usage examples, visit our official documentation. Which is the code itself.

### 🔍 JSON Addressing & Queries

The `@jarenjs/json` package implements the JSON addressing and query standards as compilers: JSON Pointer ([RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901)), the fully compliant JSONPath engine ([RFC 9535](https://www.rfc-editor.org/rfc/rfc9535.html)), and the **Jaren JSON Query format** — a declarative query-and-transformation language with XQuery 3.1 semantics (FLWOR, joins, grouping, quantifiers, a 58-operator library) whose queries are themselves JSON documents with JSONPath strings as navigation leaves. The whole language is published as a JSON Schema, which makes it a natural target for LLM structured output; an XQuery *text* front-end (`parseXQuery`) doubles as the bridge to the W3C QT3 test suite. See [packages/json](packages/json/README.md) and its [ARCHITECTURE](packages/json/ARCHITECTURE.md).

### 📝 Form Generation

The `@jarenjs/forms` package turns a JSON Schema into a framework-agnostic form model: a tree of field descriptors with labels, input-control hints, constraints and enum options. Every field validates **preemptively** on each keystroke using `@jarenjs/core` primitives (grapheme-aware lengths, unicode patterns, 40+ format testers), before the complete schema validation with `@jarenjs/validate` runs. Use it with React, Vue or vanilla DOM — the [playground](https://jklarenbeek.github.io/jarenjs/#/playground) renders its "Generated Form" tab with it. See [packages/forms](packages/forms/README.md).

### 🤓 Javascript Type Extensions

Even though es2017 is becoming pretty cool, `jaren` includes an extensive set of additional extensions to common types found in `@jarenjs/core`. We have added functionality for Number, String, Date, Object and Array classes including a set of test and getters related to the javascript type system.

For object types `@jarenjs/core` has special functions to manipulate array and objects alike including types like Map. `@jarenjs/core` also added some additional classes to queue or traverse tree like data structures.

### 🛂 String and Regex Extensions

We've added some additional string and regex functionality to the `@jarenjs/core/text` package to make it more powerful and flexible. You will find a lot of functionality to validate your input with. You can do this without using json schema and its formats. It can be really useful in day to day usage like checking for country codes, zip codes, iban numbers, etc. The `@jarenjs/formats` package exposes all the validation functions for the `@jarenjs/validate` package if you want to make use of them in a schema kind of way.

### 🧐Math and Vector classes

There are 4 extensive math classes defined in `@jarenjs/core/calc`; `int32`, `float64`, `vec2i32`, `vec2f64` and `vec3f64`. The Matrix class is not yet supported. `@jarenjs/core/calc` tries to encapsulate and group math functionality as much as possible. This with the idea to help the Javascript Runtime compiler determine what we are looking at. Each class has two types of operator groups; pure and impure. As the name suggests, pure operators are immutable and return a new structure, impure operators operates on the structure itself. The `@jarenjs/formats` package exposes some of these functions to make them available for the `@jarenjs/validate` package.

The `int32` and `float32` classes are mere helper functions to speed up your inner loops as some [benchmarks](https://jsperf.com/math-hypot-vs-math-sqrt/7) suggests. However, these benchmarks are highly [speculative](https://mrale.ph/blog/2014/02/23/the-black-cat-of-microbenchmarks.html) and the results differ greatly between browser versions. I still implemented them for two reasons; 1) sometimes I like to be explicit. 2) sometimes it helps me to remember how stuff works. The `int32` class also implements some complex operators like `sin`, `cos` and others too.

The vector classes `vec2i32`, `vec2f64` and `vec3f64` contain enough functionality to quickly do about any operation you want. The primitive pure operators (`add`, `sub`, `mul`, `div`) and impure operators (`iadd`, `isub`, `imul`, `idiv`) are supported for the `vec2i32`, `vec2f64` and `vec2f64` classes. They also contain product operators (`mag2` - magnitude square, `mag` - magnitude, `dot`, `crossABAB`) and other more complex vector operators (`unit`, `iunit`).

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
4. Implement New Features: Pick an item from our roadmap and submit a pull request.

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
