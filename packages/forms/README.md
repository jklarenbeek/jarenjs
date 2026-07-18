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

// pure schema-to-schema transform: every x-form.assert becomes its own
// allOf branch { $query, errorMessage } on the root, with value/pointer
// rebound to the field's location and the rule's message carried along
const submitSchema = formRulesToQueryAssertions(schema);

import { JarenValidator } from '@jarenjs/validate';                // app-side
const validate = new JarenValidator().compile(submitSchema);
validate({ company: 'ACME', vatId: '' }); // false - the vatId assert, now authoritative
```

Each branch's `errorMessage` carries the rule's `message` (inline string
or `$msgid` form) with `params` merged over `{ pointer: <field pointer> }`
— so every submit-time `$query` failure names its owning field in
`params.pointer`, letting the UI place root-level `$query` errors onto
fields, and renders the **same text** as the keystroke path (see below).

Item-template asserts quantify with `$every` over the actual elements. Two divergences from the keystroke path are inherent to the copy: on submit an absent field binds `$value` to the empty sequence (not `null`), and `$pointer` for template elements stays the template pointer (element indexes are a render-time notion).

## Messages & i18n

Every `FieldError` is structured: `{ keyword, params, msgid, message }`.
The `msgid` is `form/<keyword>` (field checks) or `x-form/assert` /
the author's `$msgid` (rules); `message` is rendered eagerly —
failure-only, cheap — through a **catalog** (see
[ERROR-MESSAGES.md](../validate/docs/ERROR-MESSAGES.md) for the shared
contract). `validateField`, `validateAllFields` and `evaluateFormRules`
take an optional compiled catalog, default English:

```javascript
import { validateAllFields, compileMessageCatalog } from '@jarenjs/forms';
import { nl } from '@jarenjs/locales';

const catalog = compileMessageCatalog(nl);
const errors = validateAllFields(model, data, catalog);
// errors['/name'][0].message === 'Dit veld is verplicht'
```

### MessageSpec in `x-form.message`

A rule's `message` may be a plain string (backward compatible — an inline
template, `{pointer}` etc. interpolated) or a `$msgid` spec resolving
through the catalog:

```javascript
{ "x-form": {
    "assert": { "$or": [{ "$eq": ["$.company", ""] }, { "$ne": ["$.vatId", ""] }] },
    "message": { "$msgid": "checkout.vat-required",
                 "message": "A VAT id is required for companies" } } }
```

### One rule, one message — keystroke and submit

The same rule renders the **identical string** per keystroke
(`evaluateFormRules`) and at submit (the transformed schema's `$query`
failure through the validator), in every locale:

```javascript
const compiled = compileFormRules(buildFormModel(schema));
evaluateFormRules(compiled, data, catalog);      // keystroke: Dutch text

const validate = new JarenValidator({ collectErrors: true })
  .compile(formRulesToQueryAssertions(schema));  // app-side
const result = validate(data);
localizeErrors(result.errors, catalog);          // submit: the same Dutch text
```

### Static text — the l10n surface everyone forgets

Labels, descriptions, placeholders and enum option labels resolve once at
model-build time; `buildFormModel` takes a `t` hook (default: identity)
receiving role-qualified message ids built from each field's base — its
`x-msgid` annotation or its data pointer:

```javascript
const staticNl = {
  '/firstName#label': 'Voornaam',
  'account.country#label': 'Land',
  'account.country#enum/nl': 'Nederland',
};
const model = buildFormModel(schema, {
  t: (msgid, fallback) => staticNl[msgid] ?? fallback,
});
```

Enum option labels come from the JSON Schema idiom
`oneOf: [{ "const": "nl", "title": "Netherlands" }, ...]` (treated as an
enum with per-option titles) or `String(value)`, each through
`t('<base>#enum/<value>', fallback)`; the labels land on
`field.enumLabels`, parallel to `field.enumValues`.

## Data helpers

Form data keeps plain JSON semantics — an untouched field is *absent*, not an empty string. Pointers parse, read AND write through the [`@jarenjs/json`](../json) engines (RFC 6901, one implementation repo-wide): reads hit a compiled-getter cache and allocate nothing, and writes run on the same copy-on-write kernel as the patch module (`compileJSONPointerSetter` with `parents: 'create'`), so untouched siblings are shared by reference on every keystroke — which feeds the JSLT memo and the view patcher's reference-equality fast path downstream:

- `createInitialData(model)` — defaults and `const` values filled in, everything else absent
- `parseFieldInput(field, raw)` — input coercion (`''` → undefined, numeric strings → numbers, enum options → typed values)
- `getValueAtPointer` / `setValueAtPointer` / `appendItem` / `removeItemAt` — immutable updates addressed by JSON pointer
- `createItemValue(field.item)` — starter value for a new array item

## The view model — one render tree per instant

`buildFormViewModel(model, data, options)` composes everything above — the field tree, the current data, per-field validation and `x-form` rule state — into **one plain-JSON render tree**: the "computed view" layer this README promised. Each node carries `pointer`, `label`, `control`, `value` (`x-form.computed` wins, `null` when absent), precomputed select `options` (with `selected`), localized `errors`, `enabled`, and the write discipline flags (`element`: array elements must be written with RFC 6902 `replace`, since `add` inserts; `removable`; `addValue` from `createItemValue`). Rule-hidden fields are *excluded* — a renderer cannot leak hidden data by accident. Array item templates expand per data element with concrete pointers (`/lines/2/amount`), matching the pointer keys of `evaluateFormRules` and `validateAllFields`.

```javascript
const model = buildFormModel(schema);
const rules = compileFormRules(model);
const tree = buildFormViewModel(model, data, { rules, validateFields: true, catalog });
// tree.children[0] -> { pointer: '/email', control: 'email', value: 'a@b',
//                       errors: ['Must be a valid email'], ... }
```

Render it with anything — a React component walking the tree, or **no framework at all**: the standard form rules of [`@jarenjs/app`](../app) are a shipped JSLT rule set that dispatches over exactly this shape and produces [`@jarenjs/view`](../view) vnodes, closing the loop from JSON Schema to live DOM without a single hand-written render function.

## Development

Unit tests live in `test/forms/` at the repository root. See the repository [README](../../README.md) for the full Jaren documentation, and the [ROADMAP](../../ROADMAP.md) for planned forms work (rule dependency memoization, hidden-field pruning on submit, computed views through JSLT).
