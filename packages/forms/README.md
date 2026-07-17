# @jarenjs/forms

Framework-agnostic form generation for JSON Schema. Turns a schema into a renderable field tree and validates it in **three layers, one stack**:

1. **Per field, every keystroke** — cheap, synchronous checks powered directly by [`@jarenjs/core`](../core) primitives (grapheme-aware string lengths, unicode patterns, deep equality) and the canonical format-tester registry of [`@jarenjs/formats`](../formats): everything one field can know about itself.
2. **Cross field, every keystroke** — visibility, enablement, computed values, and preemptive assertions expressed as [Jaren JSON Query](../json/docs/QUERY-FORMAT.md) documents in an `x-form` annotation, compiled once per model by [`@jarenjs/json`](../json) and evaluated per keystroke as cheap closures.
3. **Authoritative, on submit** — the complete compiled schema validation with [`@jarenjs/validate`](../validate), which owns `required` combinations, `dependentSchemas`, `if/then/else`, `unevaluatedProperties`, and (via the `$query` keyword) the very same cross-field rules.

No DOM, no framework: render the model with React, Vue, vanilla JS or anything else. Forms never imports the validator — apps wire the authoritative layer themselves. See it in action in the [Jaren playground](https://jklarenbeek.github.io/jarenjs/#/playground).

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
| `rules` | The raw `x-form` rules annotation, if any (see below) |
| `enumValues` / `constValue` / `defaultValue` / `placeholder` | Values for the UI |
| `children` | Child fields (object kinds) |
| `item` / `tuple` | Item template and tuple prefix fields (array kinds) |

Field kinds are inferred from structural keywords when `type` is absent, and `format` maps to input controls and placeholders through the same registry the preemptive validation uses (`getFormatInfo`).

## Layer 1 — preemptive per-field validation

`validateField(field, value)` returns `[{ keyword, message }]` using `@jarenjs/core` directly:

- **strings**: grapheme-aware `minLength`/`maxLength` (`getStringLength`), unicode `pattern` (`createRegExp`, cached), and 50+ `format` testers from the [`@jarenjs/formats`](../formats) `formatTesters` registry — the same name → predicate table the authoritative validator's format compilers wrap, so both layers accept exactly the same strings
- **numbers**: type/integer checks, bounds, `multipleOf`
- **enum/const**: deep equality (`equalsDeep`)
- **arrays**: `minItems`/`maxItems`/`uniqueItems` (`isUniqueDeepArray`)

`validateAllFields(model, data)` walks the whole tree and returns a `{ '/pointer': errors }` map — ideal for rendering inline errors next to every field.

## Layer 2 — `x-form` rules: cross-field behavior per keystroke

One namespaced annotation keyword — safe under every metaschema, invisible to validators — on any subschema. Its members are [Jaren JSON Query](../json/docs/QUERY-FORMAT.md) documents (a bare RFC 9535 JSONPath string is the degenerate query):

```json
{ "type": "object",
  "properties": {
    "company":  { "type": "string" },
    "vatId":    { "type": "string",
                  "x-form": { "visible": { "$ne": ["$.company", ""] },
                              "assert":  { "$or": [ { "$eq": ["$.company", ""] },
                                                    { "$ne": ["$.vatId", ""] } ] },
                              "message": "VAT id is required for companies" } },
    "total":    { "type": "number",
                  "x-form": { "computed": { "$sum": "$.lines[*].amount" } } }
  } }
```

Recognized members — unknown members are ignored for forward compatibility:

| Member | Kind | Meaning |
|---|---|---|
| `visible` | EBV query | Should the field be shown? |
| `enabled` | EBV query | Should the field accept input? |
| `assert` | EBV query | Cross-field preemptive validation |
| `computed` | query | The field's derived value, mapped to plain JSON |
| `message` | string | Shown when `assert` fails |

Rules compile **once per model** and evaluate per keystroke:

```javascript
import { buildFormModel, compileFormRules, evaluateFormRules } from '@jarenjs/forms';

const model = buildFormModel(schema);
const rules = compileFormRules(model);          // throws on malformed rules, with the field pointer

// per keystroke, after updating `data`:
const state = evaluateFormRules(rules, data);
// { '/vatId': { visible: true, errors: [{ keyword: 'x-form/assert',
//               message: 'VAT id is required for companies' }] },
//   '/total': { computed: 20 } }
```

### The rule query context

Every rule kind shares one context:

- **`$`** — the input document is the **whole form data root**: cross-field is the point.
- **`$value`** — the field's current value, bound as an external per evaluation. An absent field binds `null` (`undefined` is not a JSON value).
- **`$pointer`** — the field's data pointer string (`'/vatId'`).

These two externals are the whole vocabulary: any other free name in a rule is a **compile-time** error naming it.

`visible`/`enabled`/`assert` are asserted by **effective boolean value** (EBV, [QUERY-FORMAT.md §2.2](../json/docs/QUERY-FORMAT.md)): the empty sequence is `false`, a singleton counts per its type, a multi-item sequence is runtime error `JQ2003`. Runtime errors follow a fixed policy: `visible`/`enabled` **fail open** (evaluate to `true` — a broken rule must never hide data or lock a control), `assert` **fails closed** (an assertion that cannot be computed has not been satisfied), and `computed` leaves the value absent.

### Array item templates

A rule on an array item template (`/lines/-/amount`) compiles **once** and evaluates **per element** of the actual array, binding `$value`/`$pointer` per index — results are keyed by the expanded pointer (`/lines/2/amount`). That compiled-once/dispatch-per-node generalization now exists as the [`@jarenjs/json/jslt`](../json/docs/JSLT-FORMAT.md) `$apply` engine: a future forms computed-view layer can generalize `x-form.computed` into schema-dispatched view-model stylesheets without changing forms' validator-independent boundary.

### Schema literals in rules

Rules may use the query engine's schema operators (`$valid`/`$as`) by passing the same `compileTypeTest` hook the engine defines ([QUERY-FORMAT.md §8.11](../json/docs/QUERY-FORMAT.md)) — this is the only door through which a validator reaches forms, and the app holds the key:

```javascript
import { createTypeTestCompiler } from '@jarenjs/validate/query'; // app-side, not a forms dependency
const rules = compileFormRules(model, { compileTypeTest: createTypeTestCompiler() });
```

### Composing rule errors with field errors

`validateAllFields` and `evaluateFormRules` stay separate on purpose (a render loop usually wants them at different times). Both speak the same error shape, so merging is one spread per pointer:

```javascript
const fieldErrors = validateAllFields(model, data);   // layer 1
const ruleState = evaluateFormRules(rules, data);     // layer 2
const errorsAt = (pointer) => [
  ...(fieldErrors[pointer] ?? []),
  ...(ruleState[pointer]?.errors ?? []),
];
```

## Layer 3 — write the rule once, enforce it on submit

The same constraint can be spelled twice — `x-form.assert` for keystroke feedback, the [`$query` keyword](../validate) for authoritative submit validation — or written **once** and copied:

```javascript
import { formRulesToQueryAssertions } from '@jarenjs/forms';

// pure schema-to-schema transform: every x-form.assert is copied into a
// root-level $query (joined to an existing one through allOf), with
// value/pointer rebound to the field's location
const submitSchema = formRulesToQueryAssertions(schema);

import { JarenValidator } from '@jarenjs/validate';                // app-side
const validate = new JarenValidator().compile(submitSchema);
validate({ company: 'ACME', vatId: '' }); // false - the vatId assert, now authoritative
```

Item-template asserts quantify with `$every` over the actual elements. Two divergences from the keystroke path are inherent to the copy: on submit an absent field binds `$value` to the empty sequence (not `null`), and `$pointer` for template elements stays the template pointer (element indexes are a render-time notion).

## Data helpers

Form data keeps plain JSON semantics — an untouched field is *absent*, not an empty string. Pointers parse and read through the [`@jarenjs/json`](../json) compiled pointer engine (RFC 6901, one implementation repo-wide); reads hit a compiled-getter cache and allocate nothing:

- `createInitialData(model)` — defaults and `const` values filled in, everything else absent
- `parseFieldInput(field, raw)` — input coercion (`''` → undefined, numeric strings → numbers, enum options → typed values)
- `getValueAtPointer` / `setValueAtPointer` / `appendItem` / `removeItemAt` — immutable updates addressed by JSON pointer
- `createItemValue(field.item)` — starter value for a new array item

See the repository [README](../../README.md) for the full Jaren documentation.
