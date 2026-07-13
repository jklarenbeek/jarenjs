# @jarenjs/forms

Framework-agnostic form generation for JSON Schema. Turns a schema into a renderable field tree and gives every field **preemptive validation** — cheap, synchronous checks powered directly by [`@jarenjs/core`](../core) primitives (grapheme-aware string lengths, unicode patterns, format testers, deep equality) that run on every keystroke, *before* the complete schema validation with [`@jarenjs/validate`](../validate) takes place.

No DOM, no framework: render the model with React, Vue, vanilla JS or anything else. See it in action in the [Jaren playground](https://jklarenbeek.github.io/jarenjs/#/playground).

## Usage

```javascript
import {
  buildFormModel,
  createInitialData,
  validateField,
  parseFieldInput,
  setValueAtPointer,
} from '@jarenjs/forms';

const schema = {
  type: 'object',
  title: 'Sign up',
  properties: {
    username: { type: 'string', minLength: 3, pattern: '^[a-z0-9_]+$' },
    email: { type: 'string', format: 'email' },
    age: { type: 'integer', minimum: 13 },
  },
  required: ['username', 'email'],
};

// 1. Build the field tree once
const model = buildFormModel(schema);
// model.children -> [{ pointer: '/username', label: 'Username', control: 'text',
//                      required: true, constraints: {...} }, ...]

// 2. Start with the schema's defaults (untouched fields stay absent)
let data = createInitialData(model);

// 3. On every keystroke: coerce the raw input and validate the field
const field = model.children.find((f) => f.key === 'email');
const value = parseFieldInput(field, 'not-an-email');   // '' -> undefined, numbers -> Number, ...
const errors = validateField(field, value);
// [{ keyword: 'format', message: 'Must be a valid email' }]

data = setValueAtPointer(data, field.pointer, value);   // immutable update

// 4. On submit (or continuously): the authoritative validation
import { JarenValidator } from '@jarenjs/validate';
const validate = new JarenValidator({ skipErrors: false, collectErrors: true }).compile(schema);
const result = validate(data); // { valid, errors: [{ instancePath, keyword, message, ... }] }
```

The two layers complement each other: `validateField` covers everything a single field can know about itself (type, length, bounds, pattern, format, enum/const, array item counts), while the compiled schema validation owns cross-field rules — `required` combinations, `dependentSchemas`, `if/then/else`, `unevaluatedProperties` — and reports them with JSON-pointer `instancePath`s you can match back onto fields.

## The form model

`buildFormModel(schema)` resolves local `$ref`s (`#/$defs/...`), merges `allOf` branches, and returns a tree of field descriptors:

| Property | Meaning |
|---|---|
| `pointer` | JSON pointer into the data (`/user/name`) |
| `label` | `title` or a humanized property name (`firstName` → "First Name") |
| `kind` | `string` `number` `integer` `boolean` `enum` `const` `object` `array` |
| `control` | Rendering hint: `text` `email` `url` `password` `textarea` `number` `checkbox` `select` `date` `color` `json` |
| `required` | Whether the parent object requires this property |
| `constraints` | `minLength`/`maxLength`/`pattern`/`format`/`minimum`/`maximum`/`multipleOf`/`minItems`/... |
| `enumValues` / `constValue` / `defaultValue` / `placeholder` | Values for the UI |
| `children` | Child fields (object kinds) |
| `item` / `tuple` | Item template and tuple prefix fields (array kinds) |

Field kinds are inferred from structural keywords when `type` is absent, and `format` maps to input controls and placeholders through the same registry the preemptive validation uses (`getFormatInfo`).

## Preemptive per-field validation

`validateField(field, value)` returns `[{ keyword, message }]` using `@jarenjs/core` directly:

- **strings**: grapheme-aware `minLength`/`maxLength` (`getStringLength`), unicode `pattern` (`createRegExp`, cached), and 40+ `format` testers (`isValidEmail`, `isValidIPv6`, `isDateTimeRFC3339`, `isValidUUID`, `isValidIBAN`, ...)
- **numbers**: type/integer checks, bounds, `multipleOf`
- **enum/const**: deep equality (`equalsDeep`)
- **arrays**: `minItems`/`maxItems`/`uniqueItems` (`isUniqueDeepArray`)

`validateAllFields(model, data)` walks the whole tree and returns a `{ '/pointer': errors }` map — ideal for rendering inline errors next to every field.

## Data helpers

Form data keeps plain JSON semantics — an untouched field is *absent*, not an empty string:

- `createInitialData(model)` — defaults and `const` values filled in, everything else absent
- `parseFieldInput(field, raw)` — input coercion (`''` → undefined, numeric strings → numbers, enum options → typed values)
- `getValueAtPointer` / `setValueAtPointer` / `appendItem` / `removeItemAt` — immutable updates addressed by JSON pointer
- `createItemValue(field.item)` — starter value for a new array item

See the repository [README](../../README.md) for the full Jaren documentation.
