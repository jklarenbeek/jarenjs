# @jarenjs/validate

The JSON Schema validating compiler at the heart of [Jaren](https://github.com/jklarenbeek/jarenjs). It compiles JSON Schemas into optimized validation functions and fully supports `draft-06`, `draft-07`, `draft 2019-09` and `draft 2020-12` — passing 100% of the official [JSON-Schema-Test-Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite) for draft-07, 2019-09 and 2020-12.

## Usage

```javascript
import { JarenValidator } from '@jarenjs/validate';

const jaren = new JarenValidator();

const validate = jaren.compile({
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer', minimum: 0 }
  },
  required: ['name']
});

validate({ name: 'John', age: 30 }); // true
```

Key entry points:

- `new JarenValidator(options)` — create a validator instance
- `.addSchema(schema, key)` — register schemas for `$ref` resolution
- `.addMetaSchema(schemas, key)` — register (custom) meta-schemas, honoring `$vocabulary`
- `.addFormats(formats)` — register format validators (see [`@jarenjs/formats`](../formats))
- `.compile(schema)` — compile a schema into a validation function

Highlights:

- Annotation-based `unevaluatedProperties`/`unevaluatedItems`
- Spec-compliant dynamic scope for `$dynamicRef`/`$dynamicAnchor` and `$recursiveRef`/`$recursiveAnchor`
- Per-document draft handling for cross-draft references
- `$vocabulary`-aware keyword selection and per-draft `format`/content assertion defaults
- Instance-data references via the `data` keyword (json-everything data-ref) and Ajv-style `$data`
- Cross-field assertions via the `$query` extension keyword (a [Jaren JSON Query](../json/docs/QUERY-FORMAT.md) inside the schema)

## 🔑 JSON Schema validation keywords

Jaren supports the full set of JSON Schema validation keywords. Here's a quick overview:

- JSON data type: `type`, `nullable`, `required`
- Numbers: `maximum`, `minimum`, `multipleOf`
- Strings: `maxLength`, `minLength`, `pattern`
- Content: `contentEncoding`, `contentMediaType`
- Arrays: `maxItems`, `minItems`, `uniqueItems`, `items`, `prefixItems`, `contains`, `unevaluatedItems`
- Objects: `maxProperties`, `minProperties`, `required`, `properties`, `patternProperties`, `unevaluatedProperties`
- All types: `enum`, `const`
- Compound: `not`, `oneOf`, `anyOf`, `allOf`, `if/then/else`
- Meta: `$schema`, `$id`, `$ref`, `$anchor`, `$dynamicRef`/`$dynamicAnchor`, `$recursiveRef`/`$recursiveAnchor`, `$vocabulary`
- **Non-standard**: `data` (json-everything's [data-ref](https://docs.json-everything.net/schema/examples/data-ref/) proposal), Ajv-style `$data` references, and the [`$query` keyword](#query--cross-field-assertions) below

<details>
<summary>🔥 For a complete list of supported keywords and their implementation status, click here</summary>

### 🔑 JSON data type

- type
- nullable | _(OpenAPI)_
- required | _as boolean (OpenAPI)_

### 🔑 Keywords for numbers

- maximum / minimum<br />or exclusiveMaximum / exclusiveMinimum
- multipleOf

BigInt instance values are supported too: `maximum`/`minimum`/`exclusiveMaximum`/`exclusiveMinimum` and `multipleOf` compile dedicated BigInt comparators when the data is a `bigint`.

### 🔑 Keywords for strings

- maxLength / minLength
- pattern

### 🔑 Keywords for content

- contentEncoding | asserts in `draft7`, annotation-only from `draft2019` on (spec default), controlled by the `contentValidation` option
- contentMediaType | same assertion defaults; `application/json` content is parse-checked
- ❌ contentSchema | annotation only (never asserted)

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

- `$data` | Ajv-style instance references (`{ "minimum": { "$data": "1/limit" } }`) — supports every keyword the `data` list above supports, plus `uniqueItems` and `required`. Refs compile once at schema compile time through the compiled pointer engine of `@jarenjs/json`.

- `$query` | Jaren's cross-field assertion keyword — see [below](#query--cross-field-assertions)

### 🔑 Miscellaneous keywords

- ❌ strict
- ❌ strictFormat
- ❌ strictTuple
- errorMessage | author-supplied messages that override text (never structure) — see [Error messages &amp; i18n](#error-messages--i18n)
- definitions | used by initial schema traversal _deprecated in `draft2019`_
- $defs | used by initial schema traversal _new `draft2019`_
- components | _(OpenAPI)_

</details>

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

The refs compile once at schema compile time through the compiled pointer engine of [`@jarenjs/json`](../json) and resolve allocation-free per validation.

See also:
- [$data](https://github.com/json-schema-org/json-schema-spec/issues/51)
- [Ajv $data spec](https://github.com/ajv-validator/ajv/tree/master/spec/extras/%24data)
- [data-ref](https://docs.json-everything.net/schema/examples/data-ref/)

### 👉 Vocabularies and cross-draft references

A schema's `$schema` declaration is honored per document: referenced documents that declare a different draft are processed with that draft's keyword set (a draft-07 document ignores `dependentRequired`; a 2019-09 document ignores `prefixItems`). Custom metaschemas with `$vocabulary` are respected — omitting the validation vocabulary turns validation keywords into annotations, and declaring `format-assertion` turns format assertion on.

## `$query` — cross-field assertions

`$query` is a **Jaren extension keyword**: its value is a
[Jaren JSON Query](../json/docs/QUERY-FORMAT.md) document, compiled once at
schema compile time and evaluated per validation against the current instance
location. The instance is valid when the query result's
[effective boolean value](../json/docs/QUERY-FORMAT.md#22-effective-boolean-value-ebv)
is true. This gives JSON Schema the class of constraint it is notoriously bad
at — cross-field arithmetic, ordering, aggregate consistency, quantification —
through the query engine that already sits underneath the stack. Other
validators treat `$query` as an unknown-keyword annotation, so schemas using
it stay portable; the constraint simply only asserts here.

An invoice whose `total` must equal the sum of its line amounts:

```javascript
const validate = jaren.compile({
  type: 'object',
  properties: {
    lines: { type: 'array', items: { type: 'object' } },
    total: { type: 'number' }
  },
  $query: { $eq: ['$.total', { $sum: '$.lines[*].amount' }] }
});

validate({ lines: [{ amount: 12.5 }, { amount: 7.5 }], total: 20 }); // true
validate({ lines: [{ amount: 12.5 }, { amount: 7.5 }], total: 21 }); // false
```

Date ordering (`$le` compares strings by code points, QUERY-FORMAT §8.4 —
exactly right for ISO dates):

```javascript
jaren.compile({ $query: { $le: ['$.start', '$.end'] } });
```

Quantification over items:

```javascript
jaren.compile({
  $query: { $every: { l: '$.lines[*]' }, $satisfies: { $gt: ['$l.qty', 0] } }
});
```

Two external parameters are bound on every evaluation: `root` — the instance
root — and `path` — the current instance location as a JSON pointer string.
(The JSLT template layer reserves the same two names with one twist: its
matching language is JSONPath, so its `path` is an RFC 9535 *normalized
path*, not a pointer — see [JSLT-FORMAT §8.2](../json/docs/JSLT-FORMAT.md).)
So a subschema can reach across the document:

```javascript
jaren.compile({
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        // every line's currency must match the document-level currency
        $query: { $eq: ['$.currency', '$root.currency'] }
      }
    }
  }
});
```

Semantics and composition:

- `$query` works at **any subschema level** and composes like every other
  keyword: under `properties`/`items` the query's `$` is that location's
  value, `$path` its pointer (`/lines/0`, ...), `$root` the whole document.
- A bare JSONPath string is the degenerate query: `{ "$query": "$.approved" }`
  asserts the **EBV** of that member, not its mere existence: existence would
  let `$.approved` pass on a literal `false`, exactly the case the constraint
  means to reject (missing → empty sequence → false either way).
- `$query` is a **validation keyword**, so under 2019-09 and 2020-12 it
  asserts as a sibling of `$ref` (both apply together). Under draft-07 the
  `$ref`-overrides-siblings rule stands, so a `$query` written beside a `$ref`
  is ignored on that node.
- Query **runtime** errors (`JQ2xxx` — e.g. arithmetic on a non-number, the
  EBV of a multi-item result) are validation **failures**, never throws; in
  `collectErrors` mode the error params carry the `code` and the query
  `docPath`. Malformed query documents and free externals other than
  `root`/`path` fail fast at `compile()`.
- Schema literals inside the query (`$valid`/`$assert`/`$as`,
  QUERY-FORMAT §8.11) compile against the **same validator instance**, so
  their `$ref`s resolve to your `addSchema` registrations. The bridge
  (`createTypeTestCompiler`) accepts nothing (a fresh default instance), a
  `JarenValidator` instance, or a zero-arg factory, and probes the compiled
  validator's return shape **once per schema literal** — so even a
  `collectErrors` instance is unwrapped into a boolean predicate.

## Compatibility settings

Five options decide answers that differ between validators, between JSON
Schema drafts, or between Jaren and the library you are migrating from. Each
one is a deliberate default, and each one is worth setting explicitly in a
shared factory rather than inheriting.

| Option | Default | What it decides |
|---|---|---|
| `collectErrors` | `false` | Whether the compiled validator returns a boolean or `{ valid, errors }` |
| `skipErrors` | `!collectErrors` | Whether validation stops at the first failure |
| `useGrapheme` | **`true`** | Whether `minLength`/`maxLength` count grapheme clusters or UTF-16 code units |
| `formatAssertion` | auto by draft | Whether `format` asserts or only annotates |
| `contentValidation` | auto by draft | Whether `contentEncoding`/`contentMediaType` assert |

### The return shape is `collectErrors`

`collectErrors` is the *only* switch between the two return shapes, and it is
off by default:

```javascript
new JarenValidator().compile(schema)(data);
// => true | false

new JarenValidator({ collectErrors: true }).compile(schema)(data);
// => { valid: false, errors: [ /* ValidationError */ ] }
```

Setting `collectErrors: true` implies `skipErrors: false` (collecting errors
means recording them), so you do not need to set both. Set `skipErrors`
yourself only to keep first-failure short-circuiting while still collecting.

There is **no `validator.errors` property**. Errors arrive in the returned
object and nowhere else, which is what makes a compiled validator reentrant
and safe to share across concurrent requests.

Each `ValidationError` carries six fields:

```javascript
{
  keyword: 'format',                 // the JSON Schema keyword that failed
  instancePath: '/email',            // RFC 6901 JSON Pointer into the DATA
  schemaPath: 'https://…#/properties/email',  // absolute URI into the SCHEMA
  params: { format: 'email' },       // raw structured values, never prose
  msgid: 'format',                   // stable catalog key for i18n
  message: 'must match format "email"'
}
```

Two notes for anyone diffing this against another validator's output. The
data location is `instancePath`, a **JSON Pointer string** — not the dotted
`dataPath` of Ajv v6, and not an array path. `parseJSONPointer` from
[`@jarenjs/json`](../json/README.md) decodes it into segments. And for
`additionalProperties: false`, Jaren points `instancePath` at the offending
member (`/nested/extra`) where Ajv points at the parent object — deliberate,
and spec-truer.

### String lengths count graphemes by default

`useGrapheme` defaults to **`true`**, so `minLength`/`maxLength` count
user-perceived characters. Most other validators — and the JSON Schema
specification itself — count UTF-16 code units:

```javascript
const family = '👨‍👩‍👧‍👦';   // 1 grapheme cluster, 11 UTF-16 code units

new JarenValidator().compile({ type: 'string', maxLength: 2 })(family);
// => true   (1 grapheme)

new JarenValidator({ useGrapheme: false })
  .compile({ type: 'string', maxLength: 2 })(family);
// => false  (11 code units)
```

**If you are migrating from a validator that counts code units, set
`useGrapheme: false`,** or strings containing emoji, combining marks, flags
or astral-plane characters will silently change validity at the boundaries.
Grapheme mode is not expensive — ASCII takes a `str.length` fast path and
most Unicode takes a code-point count; only cluster-forming strings reach
`Intl.Segmenter` — so the default is about correctness, not speed, and
switching to it later is a product decision rather than a performance one.

### `format` and content assertion follow the draft

Both are annotation-only in the drafts that say so, and both take an explicit
override:

- **`format`** asserts through draft 2019-09 and is annotation-only from
  draft 2020-12 on, per spec. It also turns on automatically when the
  schema's meta-schema declares the `format-assertion` vocabulary.
- **`contentEncoding`/`contentMediaType`** assert through draft-07 and are
  annotation-only from 2019-09 on.

```javascript
const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema',
                 type: 'string', format: 'email' };

new JarenValidator().addFormats(formats.stringFormats)
  .compile(schema)('nope');                       // => true  (annotation only)

new JarenValidator({ formatAssertion: true }).addFormats(formats.stringFormats)
  .compile(schema)('nope');                       // => false (asserted)
```

> **Known defect.** Constructing with an options *object* that sets any
> validation option (`new JarenValidator({ collectErrors: true })`) also
> pins `contentValidation` to `false`, defeating the auto-by-draft rule
> above; only `new JarenValidator()` with no options gets the draft default.
> Set `contentValidation: true` explicitly if you rely on it. Tracked in the
> [ROADMAP](../../ROADMAP.md).

### Formats are never registered implicitly

`@jarenjs/validate` does not depend on `@jarenjs/formats`. An unregistered
format name is an unknown annotation and **passes**, per spec — so a
`format: 'email'` that was never registered validates everything:

```javascript
import * as formats from '@jarenjs/formats';

const jaren = new JarenValidator()
  .addFormats(formats.stringFormats)     // email, uri, uuid, hostname, ...
  .addFormats(formats.dateTimeFormats);  // date-time, date, time, duration
```

Registration never overwrites an existing name, so register your own
overrides *before* a bundled group if you want them to win.

### Recipe: migrating from Zod

Zod counts UTF-16 code units, always reports every issue, and always
asserts formats. This factory reproduces those three answers:

```javascript
import { JarenValidator } from '@jarenjs/validate';
import * as formats from '@jarenjs/formats';

export const jaren = new JarenValidator({
  collectErrors: true,     // { valid, errors } instead of a boolean
  useGrapheme: false,      // UTF-16 code units, like Zod's .min()/.max()
  formatAssertion: true,   // assert format even under draft 2020-12
  contentValidation: true, // see the known defect above
})
  .addFormats(formats.stringFormats)
  .addFormats(formats.dateTimeFormats);
```

What this recipe does **not** give you is Zod's output normalization. Jaren
validates without modifying its input: `default` values are not materialized,
types are not coerced, strings are not trimmed, and unknown properties are
not stripped. That is a deliberate boundary — the compiled validator is a
pure predicate — so a migration that relies on Zod's parsed *output* needs a
normalization step of its own between parsing and validation. See
[Pitfall 3](../../HOWTO.md#pitfall-3-validation-never-modifies-your-data) in
the HOWTO.

## Error messages & i18n

Every collected error carries a stable message key (`msgid`) and raw
structured `params` next to its rendered `message` — prose is produced at
report time from a **catalog** (a plain object of closures), never on the
validation hot path. The normative spec is
[ERROR-MESSAGES.md](./docs/ERROR-MESSAGES.md).

### The `errorMessage` keyword

Author-supplied messages that override *text*, never structure (no error
aggregation or removal — the deliberate divergence from ajv-errors, whose
two official plugins are mutually incompatible). Registered at schema
compile time, resolved only over the failed set at report time — zero
validation-time cost.

```javascript
// string form: covers the node AND its subtree (quiet oneOf noise)
{ "type": "string", "minLength": 8, "errorMessage": "Use at least 8 characters" }

// map form: per failing keyword, '_' as the node catch-all
{ "type": "integer", "minimum": 18,
  "errorMessage": { "minimum": "Must be an adult", "_": "Invalid age" } }

// required: per missing property
{ "required": ["vatId", "name"],
  "errorMessage": { "required": { "vatId": "VAT id is required for business accounts" } } }

// $query: EBV-false default and per runtime code
{ "$query": { "$le": ["$.start", "$.end"] },
  "errorMessage": { "$query": {
    "default": "start must not be after end",
    "JQ2003": "start/end must be single values" } } }
```

Templates interpolate params: `"errorMessage": "needs {limit} characters"`.

### `$msgid` — translatable authored messages

An `errorMessage` (or forms `x-form.message`) may be a **MessageSpec**
object pointing into the catalog space instead of inline text — that keeps
schema-authored messages translatable:

```javascript
{ "type": "number",
  "errorMessage": { "type": {
    "$msgid": "checkout.total-invalid",       // catalog key
    "message": "Total must be a number"       // fallback when no catalog covers it
  } } }
```

### Locale packs

```javascript
import { JarenValidator, compileMessageCatalog, localizeErrors } from '@jarenjs/validate';
import { nl } from '@jarenjs/locales';

const catalog = compileMessageCatalog(nl);
const validator = new JarenValidator({ collectErrors: true });
const validate = validator.compile({ type: 'string', minLength: 2 });

const result = validate('x');                 // English messages
localizeErrors(result.errors, catalog);       // Dutch, re-rendered from msgid + params
// 'mag niet minder dan 2 tekens bevatten'
```

The locale is chosen at **report time**; switching locale never recompiles
anything. Catalog entries are plain functions, so packs use the platform's
`Intl.PluralRules`/`Intl.NumberFormat` — see
[`@jarenjs/locales`](../locales/README.md) for the pack-authoring guide.

### `messages: false`

For applications that render exclusively through `localizeErrors` (or
their own resolver), skip English rendering entirely:

```javascript
const validator = new JarenValidator({ collectErrors: true, messages: false });
// errors arrive with message: '', params and msgid still set
```

## Development

Unit tests live in `test/validate/` at the repository root (`npm run test:validate`). Performance against Ajv is measured over the official test suite with the [benchmark workspace](../../benchmark/README.md) (`node benchmark/profiler.js --profile-all`), which also houses the test-failure debugger, coverage and call-graph tools.

This package's internals — the four-phase compile pipeline, ref flattening, annotation tracking, dynamic scope — are described in its own [ARCHITECTURE](./ARCHITECTURE.md) document. For practical usage recipes (options, lightweight setups, custom formats, pitfalls) see the repository [HOWTO](../../HOWTO.md); for the monorepo picture see the repository [README](../../README.md) and [ARCHITECTURE](../../ARCHITECTURE.md); for what is planned next see the [ROADMAP](../../ROADMAP.md).
