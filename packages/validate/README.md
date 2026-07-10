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

See the repository [README](../../README.md), [HOWTO](../../HOWTO.md) and [ARCHITECTURE](../../ARCHITECTURE.md) for full documentation.
