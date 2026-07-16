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
  asserts the EBV of that member (missing → empty sequence → false).
- Query **runtime** errors (`JQ2xxx` — e.g. arithmetic on a non-number, the
  EBV of a multi-item result) are validation **failures**, never throws; in
  `collectErrors` mode the error params carry the `code` and the query
  `docPath`. Malformed query documents and free externals other than
  `root`/`path` fail fast at `compile()`.
- Schema literals inside the query (`$valid`/`$assert`/`$as`,
  QUERY-FORMAT §8.11) compile against the **same validator instance**, so
  their `$ref`s resolve to your `addSchema` registrations.

See the repository [README](../../README.md), [HOWTO](../../HOWTO.md) and [ARCHITECTURE](../../ARCHITECTURE.md) for full documentation.
