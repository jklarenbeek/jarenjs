# @jarenjs/forms

Framework-agnostic form generation for JSON Schema. Turns a schema into a renderable field tree and validates it in **three layers, one stack**:

1. **Per field, every keystroke** — cheap, synchronous checks powered directly by [`@jarenjs/core`](../core) primitives (string lengths in the validator's unit, deep equality), the validator's own `pattern` reading and the canonical format-tester registry of [`@jarenjs/formats`](../formats): everything one field can know about itself, answered as the validator answers the field's schema.
2. **Cross field, every keystroke** — visibility, enablement, computed values, and preemptive assertions expressed as [Jaren JSON Query](../json/docs/QUERY-FORMAT.md) documents in an `x-form` annotation, compiled once per model by [`@jarenjs/json`](../json) and evaluated per keystroke as cheap closures.
3. **Authoritative, on submit** — the complete compiled schema validation with [`@jarenjs/validate`](../validate), which owns `required` combinations, `dependentSchemas`, `if/then/else`, `unevaluatedProperties`, and (via the `$query` keyword) the very same cross-field rules.

No DOM, no framework: render the model with React, Vue, vanilla JS or anything else. Forms never runs the validator — apps wire the authoritative layer themselves; all it imports from `@jarenjs/validate` is two pure pieces of `@jarenjs/validate/references`: the same-document `$ref`/`$anchor` resolution and the `pattern` reading. See it in action in the [Jaren playground](https://jklarenbeek.github.io/jarenjs/#/playground).

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
  properties: {
    username: { type: 'string', minLength: 3, pattern: '^[a-z0-9_]+$' },
    email: { type: 'string', format: 'email' },
    age: { type: 'integer', minimum: 13 },
  },
  required: ['username', 'email'],
  title: 'Sign up',
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

`buildFormModel(schema)` follows local `$ref`s (`#/$defs/...`), folds `allOf` branches into the field they describe, and returns a tree of field descriptors:

| Property | Meaning |
|---|---|
| `pointer` | JSON pointer into the data (`/user/name`) |
| `label` | `title` or a humanized property name (`firstName` → "First Name") |
| `kind` | `string` `number` `integer` `boolean` `enum` `const` `object` `array` `unknown`: what chooses the `control`, and nothing else (see below) |
| `control` | Rendering hint: `text` `email` `url` `password` `textarea` `number` `checkbox` `select` `date` `datetime-local` `time` `color` `json` |
| `required` | Whether the parent object requires this property |
| `nullable` | Whether the schema admits `null`, as the validator reads it: a type list naming `'null'` (an `enum` or `const` beside it must admit `null` too), OpenAPI's `nullable: true`, an `anyOf`/`oneOf` with a branch that admits it, or none of `type`, `enum`, `const`, `anyOf` and `oneOf` at all — `{}` or `{ maxLength: 20 }`, whose keywords judge only values of their own type — unless `nullable: false` stands there, which refuses `null` without a `type` too |
| `constraints` | `minLength`/`maxLength`/`pattern`/`format`/`minimum`/`maximum`/`multipleOf`/`minItems`/... for the control; where several places of the schema hold a bound, the tightest (see `allOf` below) |
| `asserted` | What layer 1 judges: one record of keywords per place of the schema that asserts (the node, the schema its `$ref` names, each `allOf` branch) |
| `lengthUnit` | What `minLength`/`maxLength` count on the field: `grapheme` (the default), `codepoint` or `utf16` — the validator's unit, from the options `buildFormModel` was handed (see Layer 1) |
| `rules` | The raw `x-form` rules annotation, if any (see below) |
| `enumValues` / `constValue` / `defaultValue` / `placeholder` | Values for the UI |
| `preview` | A preview hint, or `null`: what a host MAY draw beside the control, as data (`{ kind: 'map' }` for `geojson`) — see below |
| `children` | Child fields (object kinds) |
| `item` / `tuple` | Item template and tuple prefix fields (array kinds) |

A `kind` chooses the control and nothing else: layer 1 judges a field by its schema's keywords under every control (see Layer 1 below). A declared `type` gives the kind — of a list of names, or a `Set` of them, the first that is not `null`. Without a `type` a control exists for, the keywords give it. A schema that describes members or items is an object or an array field, whatever stands beside them: only that control makes them fields of their own. Any other schema is a number or a string field where its keywords agree on that: every keyword that constrains values of one type alone (the groups of `TYPE_SCOPED_KEYWORDS` in [`@jarenjs/core/schema`](../core)) belongs to the same type.

| Keywords of a schema without a `type` | Kind | Why that control |
|---|---|---|
| `properties` `patternProperties` `additionalProperties`, whatever stands beside them | `object` | the object control shows the members `properties` declares, each a field |
| `items` `prefixItems` (and none of the three above), whatever stands beside them | `array` | the array control adds and removes items, each a field |
| only `minimum` `maximum` `multipleOf` `exclusiveMinimum` `exclusiveMaximum`, or a `format` that names a number format (`int32`, `float`, …) | `number` | they bound numbers, which a number control writes |
| only `minLength` `maxLength` `pattern` `format`, `formatMinimum` and the other format bounds, `contentEncoding` `contentMediaType` `contentSchema` | `string` | they judge text: a text control, a `textarea` for content, the control of the `format` |
| `minItems` `maxItems` `uniqueItems` `contains` (`minContains`, `maxContains`, `unevaluatedItems`) | `unknown` | they describe no item an array control could show, and an array field starts as `[]`, never absent, which `minItems` alone would refuse on an untouched form: the `json` control edits the array as text |
| `minProperties` `maxProperties` `required` (a list of names) `propertyNames` (`dependentRequired`, `dependentSchemas`, `unevaluatedProperties`) | `unknown` | they name no member an object control could show: the `json` control edits the object as text |
| keywords of two of the last four rows (`{ minLength: 1, minimum: 0 }`), or none (`{}`, `{ title: … }`) | `unknown` | the `json` control holds any value |

`format` maps to input controls and placeholders through the same registry the preemptive validation uses (`getFormatInfo`). *Upgrade: twelve keywords inferred a kind (`properties`, `patternProperties`, `additionalProperties`, `items`, `prefixItems`, `minLength`, `maxLength`, `pattern`, `format`, `minimum`, `maximum`, `multipleOf`), the first found in the order object, array, string, number. A schema of `exclusiveMinimum` or `exclusiveMaximum` alone was a `json` control and is a number control; of a format bound, `contentEncoding` or `contentMediaType` a text control or a `textarea`. `{ format: 'int32' }` was a string field under a number control, whose text never passed the format, and is a number field. A new array item of such a schema starts as its kind's starter value, `0` for a number field and `''` for a string field, where it started as `null` (as `''` under a number format). A schema that describes neither members nor items and holds keywords of two types was a field of the first kind found, and is a `json` control: `{ minLength: 1, minimum: 0 }` was a text field and `{ format: 'date', minimum: 0 }` a date field. A `type` held as a `Set` was not read, and gives the kind of its first name that is not `null`; a `null` member of a `type` list is the name `'null'`, as to the validator: `{ type: [null, 'number'] }` was a `json` control that reported `required` for a `null` in a required member, and is a nullable number field.*

A kind says which control fits the values the keywords are about; it is no judgement of the value. So a field whose kind was inferred may hold a value its control cannot show: `{ minimum: 5 }` is a number control, and `'abc'` is valid there, as it is to the validator. The view node then carries the value as held — `value: 'abc'` under `control: 'number'` — and no error; what the control displays for it is the renderer's (an `<input type=number>` shows nothing for text), and the value stays in the data until the user enters another. A field that must not hold it declares its `type`, which reports `type` for it. `parseFieldInput` hands a number control's text that reads as no number on as that text either way: an error under a declared `type`, a value the schema takes without one.

The two spellings of a nullable member are one field. `{ type: ['string', 'null'], format: 'date' }` and `{ anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] }` both give kind `string`, control `date`, the same constraints and `nullable: true`. The union's branch is read through `splitNullable` from [`@jarenjs/core/schema`](../core) (a `$ref` branch resolves like any field), and the node's own `title` and other annotations apply over it. Only the non-null branch picks the control; the authoritative validator still judges the whole schema. The `oneOf` const/title idiom is not a nullable spelling: `oneOf: [{ const: 'high', title: 'High' }, { const: null, title: 'None' }]` stays an `enum` select, its `null` one of the options.

### The preview hint — a renderer described as data

A `geojson` field is a `textarea` whose text is validated by parsing it and judging the
object (`isValidGeoJson`), and that is where a text control stops: the value can be valid
GeoJSON long before it is the shape the user meant, and no textarea can show the
difference. The format registry therefore carries a **preview hint** —
`getFormatInfo('geojson').preview` is `{ kind: 'map' }` — and the field and the view node
carry it through as `preview`. It is a description, not a renderer: `@jarenjs/forms`
imports no chart, and the dependency arrow forbids it (`@jarenjs/charts` sits above this
package). A **host that understands** `preview.kind === 'map'` parses the field's text and
hands it to a map renderer — `@jarenjs/charts` draws a `FeatureCollection`, a `Feature` or a
geometry through `compileChart({ type: 'map' }, { features })` — beside the control. A host
that does **not** ignores the member, and the field is exactly the textarea it always was:
same control, same placeholder, same test. Both paths are tests; the `@jarenjs/app` form
stylesheet is the second kind of host, and the website's data studio the first.

Which date formats get a **native** control is decided by the offset, not by convenience. HTML's `datetime-local` and `time` inputs cannot produce one, and RFC 3339 requires one — binding them to `date-time`/`time` would make the control emit values its own schema rejects, so those stay text inputs. The `iso-date-time`/`iso-time` formats leave the offset optional and are exactly what those inputs spell, so they map losslessly. `formatMinimum`/`formatMaximum` reach the field as constraints and become the control's `min`/`max`, so the picker itself refuses an out-of-range date; HTML has no exclusive date bounds, so `formatExclusive*` stays a submit-time check.

### The same model, by code

The schema above is what `@jarenjs/linq/forms` emits, byte for byte:

```javascript
import * as f from '@jarenjs/linq/forms';

export const signup = f.object({
  username: f.string().min(3).pattern('^[a-z0-9_]+$'),
  email: f.string().format('email'),
  age: f.integer().min(13).optional(),
}).open().title('Sign up');

const model = buildFormModel(signup.schema);
```

Every rule of the next section is a `.form({ … })` on the member it
belongs to; the pen's document is
[FORMS-PEN.md](../linq/docs/FORMS-PEN.md), and nothing in this package
depends on it — the schema is the contract.

## Layer 1 — preemptive per-field validation

`validateField(field, value)` returns `[{ keyword, message }]` using `@jarenjs/core` directly. It answers **as the validator answers the field's schema**: each keyword below applies to a value of that keyword's own type and to no other, whatever the field's kind — a kind chooses the control, never an answer — so for these keywords the two layers give one verdict and name the same keyword. [`test/forms/validator-agreement.test.js`](../../test/forms/validator-agreement.test.js) holds the two side by side over a grid of field schemas and values, each intended difference a named row with its reason.

- **`type`**: asserted only where the schema declares one, and read as the validator reads it: a name, a list of names or a `Set` of them; a number is no NaN, an `integer` is what `Number.isInteger` takes, only the validator's `bigint` name takes a bigint (`number` and `integer` refuse every one), and `null` passes under OpenAPI's `nullable: true`. The message names the first declared type that is not `null` (an `integer` field says `number` for a value that is no number at all). A field whose kind was inferred from its keywords asserts no type: `{ minimum: 5 }` takes `'abc'`, `[1]`, `true`, `{}` and `'7'`; `{ minLength: 2 }`, `{ pattern: '^a' }` and `{ format: 'email' }` take `5`; `{ items: … }` and `{ properties: … }` take `'abc'`, as the validator does. *Upgrade: a field without a `type` reported `type` for every value its inferred kind was not (`{ minimum: 5 }` refused `'abc'` and `[1]`, `{ minLength: 2 }` refused `5`, `{ additionalProperties: false }` refused `[1]`), and takes them now. A `type` list was judged by its first name alone, so `{ type: ['string', 'number'] }` refused `5`, which it takes. A `type` no control exists for was not read: `{ type: 'null' }` and `{ type: 'bigint' }` took every value, and a `type` held as a `Set` asserted nothing (`{ type: new Set(['number']), minimum: 0 }` took `21n`); they refuse what the validator refuses (`{ type: 'null' }` refuses `5`).* Upgrade note: layer 1 used to accept anything that converts to a number, and took a bigint under `type: 'number'` or `'integer'` (`21n`), which the validator refuses.
- **every keyword, under every control**: a field reports each keyword that fails, beside a `type` that fails too (`{ type: 'string', minimum: 5 }` reports `type` and `minimum` for `3`), and a field is judged by every keyword it holds whatever its control: `{ exclusiveMinimum: 5 }` refuses `5`, and under the `json` control `{ minItems: 2 }` refuses `[1]`, `{ uniqueItems: true }` refuses `[1, 1]` and `{ maxProperties: 0 }` refuses `{ a: 1 }`. *Upgrade: a field judged only the keywords of its kind. One whose keywords inferred no kind checked nothing (`{ exclusiveMinimum: 5 }` took `5`, `{ maxProperties: 0 }` took `{ a: 1 }`); an `enum` or `const` field checked nothing beside it (`{ enum: [1, 7], minimum: 5 }` took `1`, `{ type: 'string', enum: [1, 2] }` took `1`, `{ const: 1, enum: [2] }` took `1`); a number field checked no `format` (`{ type: 'integer', format: 'int32' }` took `2 ** 31`); and a field whose `type` refused a value reported nothing else for it. They refuse those values, and report those keywords, now.*
- **strings**: `minLength`/`maxLength` in the model's length unit (below), `pattern` (`createSchemaPatternTester` from [`@jarenjs/validate/references`](../validate), cached: an ECMA-262 source in Unicode mode, so `"/a/"` matches only text that contains `/a/`; a pattern that compiles neither way asserts nothing per keystroke), and 50+ `format` testers from the [`@jarenjs/formats`](../formats) `formatTesters` registry — the same name → predicate table the authoritative validator's format compilers wrap, each applied to the values its compiler judges: a string format to strings; a number format (`int32`, `uint8`, `float`, …) to numbers, taking every value of another type (`'12'`, `'abc'` and `{}` are no numbers; `2 ** 31` is no `int32`), and an integer format to a bigint too, by its own range and exactly (`int64` takes `2n ** 63n - 1n` and refuses `2n ** 63n`; a floating point format takes a bigint); `geojson` to an object, and to the text of one, which is what a field holds (the validator takes every string there). An empty string is judged by no format: it is what a cleared text control holds, and the submit layer says what the schema makes of it. *Upgrade: a number format was tested on the text itself, so `{ format: 'int32' }` refused `'12'` and `12` (as no string), which it takes; and `{ format: 'geojson' }` refused an object as no string, where it judges the object now.* *Upgrade: with the validator, a number format judged every value as the number it converts to, so `{ format: 'int32' }` refused `'abc'`, `{}`, `[1, 2]`, `'4294967296'` and `'1.5'`, which it takes now as values of another type; and a bigint was judged as the number it converts to, so `int64` refused `2n ** 60n` and `float` refused `10n ** 60n`, which they take.*
- **numbers and bigints**: bounds and `multipleOf`, by the validator's own rule (its `number.js` and `bigint.js`): a number is judged by the bounds and steps that are numbers or number strings, a bigint by those that are bigints, each exactly and neither as the other. So `{ minimum: 5 }` takes `1n`, `{ maximum: 5 }` takes `21n` and `{ multipleOf: 2 }` takes `3n`, as `{ minimum: 5n }` takes `3`; `{ maximum: 2n ** 60n }` refuses `2n ** 60n + 1n` and `{ multipleOf: 2n }` refuses `3n`. *Upgrade: a field whose `type` names `bigint`, or that declares none, read a bigint as the number it converts to: `{ minimum: 5 }` refused `1n`, `{ maximum: 5 }` `21n`, `{ multipleOf: 2 }` `3n` and `{ type: 'bigint', minimum: 5 }` `1n`, which they take; `{ multipleOf: 2n }` took `3n` and `{ maximum: 2n ** 60n }` took `2n ** 60n + 1n` (compared after rounding), which they refuse; and `{ type: 'bigint', minimum: 5 }` took the number `7`, which its `type` refuses.* The bounds are read as the validator reads them, under every draft: a number `exclusiveMinimum` or `exclusiveMaximum` is an exclusive bound of its own, and the draft-04 boolean makes the `minimum` or `maximum` beside it exclusive (`true`) or leaves it inclusive (`false`), bounding nothing alone; a bound written as a number string is that number, and a bigint bound bounds bigints and no number. Upgrade note: layer 1 compared a value with the boolean itself, as `1` or `0`, so under `maximum: 5, exclusiveMaximum: true` it refused `4` ("less than true"), under `exclusiveMaximum: false` it refused `0` and `5`, and under `minimum: 5, exclusiveMinimum: true` it took `5`; and it bounded a number by a bigint bound (`3` under `minimum: 5n`), which the validator does not. `multipleOf` is read as the validator reads it, by the validator's own test (`multipleOfTester` from [`@jarenjs/core/math`](../core/docs/MATH.md), built once per step): a value is a multiple when the decimals it and the step spell divide whole, so `0.3` is a multiple of `0.1` and `20000001` is none of `10000000`. A step written as a number string (`"5"`) is that number; a bigint step judges bigints and no number, and a step the validator refuses when the schema compiles (zero, `null`, a boolean, an object) asserts nothing per keystroke. Upgrade note: layer 1 took any value within 1e-6 of a whole quotient, which the validator refuses (`5` and `20000001` under `multipleOf: 10000000`, `0.30000000000000004` under `0.1`, `Infinity` under any step), and refused true multiples whose float quotient drifted (`0.5` under `1e-15`, `1234567890.1` under `0.1`); a bigint step threw, and a step of `true` or of a one-number array was read as that number
- **enum/const**: compared as the validator compares them — a scalar or `null` by identity, anything else deeply (`equalsDeep`); the `oneOf` const/title idiom is judged as the `enum` of its options
- **`allOf`, and the keywords beside a `$ref`**: every place of the schema that asserts is judged on its own, as the validator applies each — the node's own keywords, the schema its `$ref` names and every `allOf` branch, followed alike (`field.asserted` holds one record per place). A keyword two places hold is judged twice and never merged: `{ allOf: [{ minimum: 5 }, { minimum: 7 }] }` and `{ minimum: 5, allOf: [{ minimum: 7 }] }` refuse `6`, `{ allOf: [{ type: 'string' }, { type: 'number' }] }` refuses `'a'`, and `{ $ref: '#/$defs/x', minimum: 5 }` refuses `6` where `x` asks `minimum: 7`. A member, an item or a tuple slot two places describe is a field judged by both, and a field is `nullable` where every place admits `null`. A place that is `false` admits none and names no keyword of this layer: the validator refuses every value there, at submit. One fault is said once (a `$ref` reached twice), and each of two different bounds that fail is reported. What the **control** is drawn from is one schema folded from those places (`field.schema`, `field.constraints`): of a bound or a count two places hold the tightest — the greatest `minimum`, the least `maxLength` — which is what a control can use; `uniqueItems` where one place asks it; of `enum` the options every place lists; of `type` the names every place takes (`integer` where one says `number` and another `integer`); and of a keyword a control holds one of (`pattern`, `format`, `multipleOf`) the first, the node's own before its `$ref`'s and its branches'. *Upgrade: a keyword two places hold was read once, from the first. `{ allOf: [{ minimum: 5 }, { minimum: 7 }] }` and `{ minimum: 5, allOf: [{ minimum: 7 }] }` took `6`, `{ allOf: [{ type: 'string' }, { type: 'number' }] }` took `'a'`, `{ allOf: [{ pattern: '^a' }, { pattern: 'b$' }] }` took `'a'`, `{ allOf: [{ enum: [1, 2] }, { enum: [2, 3] }] }` took `1`, and `{ $ref: '#/$defs/x', minimum: 5 }` took `6`: they refuse those now. A member two branches describe was judged by the first (`{ allOf: [{ properties: { a: { type: 'string' } } }, { properties: { a: { minLength: 3 } } }] }` took `{ a: 'x' }`), and the `properties` beside a `$ref` replaced its target's, so the target's members were no fields; `{ allOf: [{ type: ['string', 'null'] }, { type: 'string' }] }` took `null`; a field one of whose places is `false` was `nullable`, so a required member holding `{ allOf: [false] }` took `null`, where it reports `required` under its `json` control; and a member whose schema is `true` reported `required` for a `null`. `constraints` held the first bound (`minimum: 5`, now `7`), an `enum` field offered the first list (`[1, 2]`, now `[2]`), and `{ allOf: [{ type: ['string', 'number'] }, { type: 'number' }] }` was a text field (a number field now).*
- **arrays**: `minItems`/`maxItems`/`uniqueItems` (`isUniqueDeepArray`); **objects**: `minProperties`/`maxProperties`, over the members `Object.keys` lists
- **keyword values** are read as the validator reads them: a count or a bound written as a number string is that number (`minLength: "2"`), and a value the validator refuses when the schema compiles (`JK0013`: `minimum: null`, `minLength: true`, a `type` name it does not know, a zero `multipleOf`) asserts nothing per keystroke, as a pattern that does not compile. *Upgrade: such a value was compared as JavaScript converts it, so `{ minimum: null }` refused `-1` and `{ minLength: true }` refused an empty string.*
- **`null` is a value**, as it is to the validator: a `nullable` field accepts it, and any other field reports what refuses it — its `type`, its `enum` and its `const`, each that does. Only an absent member (`undefined`) meets `required`, except under a `json` control: there a `null` is what the control writes for half-typed input, and where no keyword of the field refuses it (a union without a null branch does, at submit) a required field reports `required` for it. *Upgrade: `{ type: 'string', enum: ['a'] }` reported `enum` alone for `null`, and reports `type` too; a required `json`-control field whose own `type` refuses `null` (`{ type: 'bigint' }`) reported `required`, and reports `type`; and `nullable: false` without a `type` is read as the validator reads it, as refusing `null`: such a field's `nullable` was `true`, and a required one under a `json` control reported nothing for `null`.*

**The length unit is the validator's.** `buildFormModel(schema, options)` takes the two options a `JarenValidator` takes for it — `lengthUnit` (`'grapheme'`, the default, `'codepoint'` or `'utf16'`) and the older `useGrapheme` (`false` counts UTF-16 code units; `lengthUnit` wins when both are given) — and every field of the model counts `minLength` and `maxLength` in that unit (`field.lengthUnit`). A value that names no unit is a `TypeError`, as it is to the validator: read on, a misspelt unit would count graphemes. Hand both the same options, and a host that validates in code points gets a form that counts code points:

```javascript
const options = { lengthUnit: 'codepoint' };
const validate = new JarenValidator(options).compile(schema);
const model = buildFormModel(schema, options);   // 'e\u0301' is 2 under maxLength, as to `validate`
```

*Upgrade: `lengthUnit` and `useGrapheme` are new on `buildFormModel`, which read neither and counted graphemes whatever the host's validator counted; without them a form counts graphemes as before.*

**What layer 1 leaves to the submit layer.** It implements no other keyword, so these stay the validator's, with every subschema they hold: `anyOf` and `oneOf` (read only as a nullable union or as the const/title idiom), `not`, `if`/`then`/`else`, `contains` with `minContains`/`maxContains`, `propertyNames`, `patternProperties`, `additionalProperties`, an item no schema admits (`items: false`, `additionalItems: false`), `dependentRequired`, `dependentSchemas`, `dependencies`, `unevaluatedProperties`, `unevaluatedItems`, the format bounds (`formatMinimum`, `formatMaximum`, `formatExclusiveMinimum`, `formatExclusiveMaximum`), `contentEncoding`, `contentMediaType`, `nullable: false`, a `required` member the schema declares no property for, `$data` references and `$query`. Where two bounds fail together layer 1 reports each, and the collecting validator the first.

**The form model reads no draft.** It reads a schema's keywords as the latest draft reads them, whatever the document declares, because a form that ignored one would show a control that checks less than its author wrote. That differs from a validator reading an older draft, or one that annotates, in three ways, and no other:

- **the keywords beside a `$ref` apply.** A validator reading draft-07 or an older draft (its default for a document that declares none) lets the `$ref` replace them: under `$schema` draft-07, `{ $ref: '#/definitions/x', minimum: 5 }` with `x: { type: 'number' }` takes `1`, which the field refuses;
- **`prefixItems` builds tuple slots.** A validator does not read the keyword in a document that declares a draft before 2020-12: under `$schema` draft-07, `{ prefixItems: [{ type: 'string' }] }` takes `[5]`, which the field refuses at `/0`;
- **a `format` is asserted.** A validator reading 2020-12 annotates it unless `formatAssertion` is set: `{ $schema: …/2020-12/schema, format: 'email' }` takes `'x'`, which the field refuses.

A host whose validator must answer as its form does compiles with `formatAssertion: true` and declares `$schema` 2020-12 in its documents.

`validateAllFields(model, data)` walks the whole tree and returns a `{ '/pointer': errors }` map — ideal for rendering inline errors next to every field. The members of a field are judged where the value is an object and its items where it is an array, as `properties` and `items` judge them (*Upgrade: an array under an object field had its members reported as missing, `required` for each, beside the `type`*). It reads own JSON members, like the pointer helpers: a field named `constructor`, `toString` or `__proto__` is absent until the data supplies that member. The same holds for names looked up in a table: a `format`, a message id (`$msgid`) or a catalog key named like an `Object.prototype` member is an unknown one, and a rule inside an array item reads an object's own members and an array's elements by index only. Upgrade note: such names used to answer as a format, a message or a member (`renderFormsMessage(undefined, 'toString', {})` is now `'toString'`, the id).

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

These annotations can be **written by code**: `@jarenjs/linq/forms` is
the schema pen plus `form({ visible, enabled, assert, computed,
message })` on every builder, with the rules captured as callbacks over
the same context (`c.root`, `c.value`, `c.pointer`) rather than typed
as path strings, and `assertOnSubmit()` answering the layer-3 twin
below in one call. The document above is what it emits, byte for byte
— see [the by-code twin](#the-same-model-by-code) and
[FORMS-PEN.md](../linq/docs/FORMS-PEN.md). This package depends on
none of it; the annotation is the contract.

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

A rule on an array item template (`/lines/-/amount`) compiles **once** and evaluates **per element** of the actual array, binding `$value`/`$pointer` per index — results are keyed by the expanded pointer (`/lines/2/amount`). Rendering uses [`@jarenjs/json/jslt`](../json/docs/JSLT-FORMAT.md) rules over the composed view model. Composition retains the model, data and session cursors together; see the addressing measurement below. On a tuple the item template applies from the first element after the fixed slots (`prefixItems`, or an `items` array); a slot's rules are its own. Upgrade note: the template's rules used to replace those of the slots in front of it.

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

**One rule, one meaning.** Whatever the keystroke evaluation says about a
document, submit says too — the copy is not allowed to change what an author
wrote. Three things enforce that, and each is a place the naive copy went
wrong:

- an **absent field binds `null`**, not the empty sequence, so `$ne`/`$eq`
  cannot mean opposite things on the two sides (the binding is wrapped in
  `$default`);
- an **item-template assert quantifies over the ELEMENTS**, not over the
  selected leaf values — quantifying over leaves silently skips an element
  that lacks the member, where the keystroke path evaluates it with `null`;
- an assert is **guarded by the field's own and ancestor `visible` rules**,
  each with its own value/pointer bindings, holding vacuously while the
  field is hidden — which is what the keystroke path already does, since
  `buildFormViewModel` drops hidden subtrees and their errors never render
  or count. Ordinary schema constraints still apply to retained values.

The copy reads a tuple the way `buildFormModel` does: fixed slots from
`prefixItems` or an `items` array, and the elements after them (`items`
beside `prefixItems`, `additionalItems` beside an `items` array) as the item
template. An element that is itself an array is walked by index, because a
query sequence splices the arrays it holds. Upgrade note: the copy used to
skip an `items` array and `additionalItems`, apply the template to the slots
in front of it, and accept an invalid cell of an array inside an array.

A **tuple slot the data does not hold yet** has no node in the view model, so
its rules hold vacuously, as for a hidden field: `evaluateFormRules` returns an
empty result for it (and for everything under it) and the submit copy guards
its assert on the array holding that index. Add the slot (`addValue`) and the
assert applies. Upgrade note: an assert on a missing slot used to fail on
`null`, on submit and in the rule results, naming a field the operator could
not see.

One divergence remains: `$pointer` for template elements stays the template
pointer, because element indexes are a render-time notion.

A hidden field's *value* is a separate question, and the answer is explicit:
values are kept while editing — a field that reappears must not have
forgotten what the operator typed — and dropped only at the submit boundary,
by a caller who asks:

```javascript
import { pruneHiddenValues } from '@jarenjs/forms';

const submitted = pruneHiddenValues(compiledRules, session.data);
```

Visibility is evaluated once, against the incoming document. Hidden array
elements are removed and their siblings renumber, which is right for a
document being sent — and means the returned pointers no longer line up with
the ones the view model rendered.

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

### A format's name, in the reader's language

A format's name is its wire name — `date-time`, `iso-time` — which is
English by construction and reads as gibberish inside a translated
sentence (*"Moet een geldige date-time zijn"*). A catalog that carries
`format/name/<format>` says how that format is called in its own
language, and `renderFormsMessage` swaps it in before `form/format`
renders. The error's own `params.format` stays the raw wire name, so the
same error re-rendered through a second catalog answers in *that*
language rather than repeating the first one's noun:

```javascript
import { renderFormsMessage, compileMessageCatalog, formatDisplayName } from '@jarenjs/forms';
import { de } from '@jarenjs/locales';

const error = validateField(whenField, 'nope', catalog)[0];
error.message;       // 'Moet een geldige datum en tijd zijn'
error.params.format; // 'date-time'
renderFormsMessage(compileMessageCatalog(de), error.msgid, error.params);
// 'Muss dem Format Datum und Uhrzeit entsprechen'
renderFormsMessage(undefined, error.msgid, error.params); // English: 'Must be a valid date-time'
formatDisplayName(catalog, 'email');  // 'email' — already a word
```

`@jarenjs/locales` carries the six date and time names in every pack; a
format the catalog cannot name keeps its own, which is the readable
answer for the names that are already words and the only possible one for
a format nobody has heard of.

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
`field.enumLabels`, parallel to `field.enumValues`. An explicit `enum`
supplies its own values and `String(value)` labels even when `oneOf` is
also present. The view model selects object and array options by JSON
equality, so values loaded from JSON keep their selection.

## Data helpers

Form data keeps plain JSON semantics — an untouched field is *absent*, not an empty string. Pointers parse, read AND write through the [`@jarenjs/json`](../json) engines (RFC 6901, one implementation repo-wide): reads hit a compiled-getter cache and allocate nothing, and writes run on the same copy-on-write kernel as the patch module (`compileJSONPointerSetter` with `parents: 'create'`), so untouched siblings are shared by reference on every keystroke — which feeds the JSLT memo and the view patcher's reference-equality fast path downstream:

- `createInitialData(model)` — defaults and `const` values filled in as own JSON members (including `__proto__`); a required boolean without a default starts `false`, because a checkbox cannot show "absent" and layer 1 and the validator must judge the same value; everything else absent
- `parseFieldInput(field, raw)` — input coercion (`''` → undefined, numeric strings → numbers, enum options → typed values: an option is found by the `key` the view model gives it, which names one option exactly, or else by its own text, so a select hands back the typed option, a bigint one too; *Upgrade: only an option's text was read, so a `key` that is not its text (`'"a"'` for the option `'a'`) was handed back as that text, and under `enum: ['1', 1]` the text `'1'` named the first of the two, where it names the option whose key it is, `1`*). Blank or non-finite text in a number field stays text: layer 1 reports it under a declared number `type`, and a number field inferred from its keywords holds it as the string its schema takes; upgrade note: `'  '` used to become `0` and `'Infinity'` became `Infinity`, which JSON cannot carry
- `getValueAtPointer` / `setValueAtPointer` / `appendItem` / `removeItemAt` — immutable updates addressed by JSON pointer; `removeItemAt` takes an integer or its canonical decimal text (`'1'`); an index that names no item (`-1`, past the end, other text) returns the document itself (upgrade note: `-1` used to remove the last item)
- `parseJsonText(text)` — reads the text of a `json` control back into a value: JSON, in which an integer followed by `n` is a bigint (`12n`, `[5n]`), as the view model writes one; `undefined` for text that is neither
- `createItemValue(field.item)` — starter value for a new array item

## The view model — one render tree per instant

`buildFormViewModel(model, data, options)` composes everything above — the field tree, the current data, per-field validation and `x-form` rule state — into **one plain-JSON render tree**: the "computed view" layer this README promised. Each node carries `pointer`, `label`, `control`, `value` (`x-form.computed` wins, `null` when absent; the value as held, also where the kind's control cannot show it), precomputed select `options` (with `selected`), localized `errors`, `enabled`, and the write discipline flags (`element`: array elements must be written with RFC 6902 `replace`, since `add` inserts; `removable`; `addValue` from `createItemValue`). Rule-hidden fields are *excluded* — a renderer cannot leak hidden data by accident. Array item templates expand per data element with concrete pointers (`/lines/2/amount`), matching the pointer keys of `evaluateFormRules` and `validateAllFields`. A short tuple's `addValue` comes from its next prefix slot; the tail item template supplies starters only after the prefix is filled.

A `json` control's node carries the value as text in `json`, and a select option carries its value as text in `key`: the value's JSON text. A bigint, which JSON cannot spell, is written as JavaScript writes one, its digits followed by `n` — the `json` of `5n` is `5n` and of `[5n]` is `[\n  5n\n]`, and the option `5n` has the `key` `5n`, apart from the number `5`'s `5` (its label is `String(value)`, the digits, as every option's) — so a value that holds a bigint is shown as it is, and an `enum` option that is a bigint is offered, `selected` for that value, and kept: `parseFieldInput(field, key)` hands the option back as the bigint it is. An edited `json` text reads back with `parseJsonText(text)`: JSON, in which an integer followed by `n` is a bigint, and `undefined` for text that is neither. `JSON.parse` reads every text that holds no bigint alike, and refuses one that does; a host that reads its controls back with it (the standard actions of `@jarenjs/app` do) writes no bigint. *Upgrade: `buildFormViewModel` threw `TypeError: Do not know how to serialize a BigInt` for a `json` control holding a bigint at any depth (`buildFormViewModel(buildFormModel({}), 5n)`, `[5n]`) and for an `enum` with a bigint option (`{ enum: [5n, 6n] }`).*

The composition walk carries the current **raw data cursor** and the
session's **initial cursor** down beside each field. It reads one pointer
suffix per descent instead of starting from the document root per field;
computed container values do not replace the raw cursor used by children.
Missing baseline ancestors stay missing, preserving dirty-state detection.

`$fold` can implement a second cursor with typed segments, but this alone
is not a reason to replace the composer. The executable experiment in
`benchmark/forms-composition.js` compares a fold-based JSLT rule with root
pointer getters and carried cursors on the same expanded fields. Its
parity tests include escaped keys, array indexes and missing ancestors.

<!--fact:forms.addressing-->

Measured on v24.19.0, linux/x64; median milliseconds per expanded-field projection. Compilation and field expansion are excluded from all contenders.

| Depth | Nodes | Root pointers | Carried cursors | Fold stylesheet |
|---|---|---|---|---|
| 1 | 33 | 0.0043 | 0.0040 | 0.0817 |
| 8 | 136 | 0.0314 | 0.0101 | 0.6325 |
| 24 | 536 | 0.2811 | 0.0319 | 5.1716 |

<!--/fact-->

The shallow timings are close and do not justify a universal speedup
claim; deeper trees benefit from carrying cursors. The fold stylesheet loses on every
fixture even with expansion excluded. These measurements cover addressing
only, not the complete session/validation/render pipeline. The production
composer therefore keeps the JS walk. A complete stylesheet replacement is
not planned: it would have to show parity for array-template expansion,
hidden fields, enum values, errors and session state, and then beat the
walk across the complete pipeline; first-class functions are not a
prerequisite.

```javascript
const model = buildFormModel(schema);
const rules = compileFormRules(model);
const tree = buildFormViewModel(model, data, { rules, validateFields: true, catalog });
// tree.children[0] -> { pointer: '/email', control: 'email', value: 'a@b',
//                       errors: ['Must be a valid email'], ... }
```

Render it with anything — a React component walking the tree, or **no framework at all**: the standard form rules of [`@jarenjs/app`](../app) are a shipped JSLT rule set that dispatches over exactly this shape and produces [`@jarenjs/view`](../view) vnodes, closing the loop from JSON Schema to live DOM without a single hand-written render function.

Two node members exist because a **DOM control's value is a string** and not
every field's value is: each select option carries `key`, its value as JSON
text, and a `json`-control node carries `json`, its value as indented JSON
text. A renderer puts those in the control and hands them back verbatim;
`@jarenjs/app`'s `formEventFields()` decodes them. That keeps a `enum: [1, 2]`
selection a number instead of `"2"`.

### Re-evaluating only what changed

Rules compile once and run per keystroke. On a wide form most of that work is
wasted — a keystroke in one field cannot change what a rule reading two other
fields concludes — so pass a **memo** and only the reachable rules re-run:

```javascript
import { createRuleMemo } from '@jarenjs/forms';

const memo = createRuleMemo();                       // one per form session
const tree = buildFormViewModel(model, data, { rules, memo, catalog });
```

Each rule's dependencies are derived at compile time from the root-anchored
paths in its query documents (plus its own location). That over-approximates
every read, and soundly: the only way into the document is such a path, and a
`$let`/`$for` variable can only hold what one of them produced.

Nested filters contribute their root reads too. Replacing the compiled rule set
invalidates the memo's results and template keys, even when the data is unchanged.
The memo diffs the previous document against the new one — reference-equal
subtrees are skipped whole, so an immutable edit costs O(change). A host that
already knows what it wrote can skip even that with `memo.touch(pointer)`,
which is a promise as much as an optimization: touch one pointer while
changing another and the rules you did not name keep stale results.

Measured on a 200-rule form (one `visible` + one `assert` each):

| tick | cost |
|---|---|
| full evaluation | ~54 µs |
| memo, one field changed (diffed) | ~13 µs |
| memo, one field changed (declared) | ~4.7 µs |
| memo, a field every rule reads | ~58 µs |

The last row is the honest one: when a change reaches every rule there is
nothing to skip, and the memo's bookkeeping makes it slightly *slower* than
evaluating straight through. It pays when a form is wide and its rules are
mostly local — which is what a large form usually is, and exactly when the
full evaluation starts to hurt.

### The form session — submit/draft lifecycle around one document

Pass `options.session` and every node additionally carries `id` (a stable, **injective** accessible element id derived from the pointer — distinct pointers can never collide, because every character outside `[A-Za-z0-9]` (`-` and `_` themselves included) is escaped as `_<codepoint>_` *before* the segments are joined on `-`, so a member name containing the separator or an escape cannot forge another pointer's id: `/a/b` → `<prefix>--f-a-b`, `/a-b` → `<prefix>--f-a_45_b`. Member ids carry the `f-` marker so the `<prefix>--root` sentinel is disjoint from every member, a member literally named `root` included. Write the same escaping in your `<label for=…>` if you build an id by hand), `describedBy` (the id of the node's error text, or `null`), `dirty` (presence-aware deep compare against `session.initial` — adding or removing a member counts even when both sides read back `null`), `touched`, and `serverErrors` (kept distinct from client `errors`). The root gains a `session` summary:

```javascript
const tree = buildFormViewModel(model, data, {
  rules, validateFields: true,
  session: {
    initial,                       // the baseline document
    touched: ['/email'],           // pointers the operator visited
    submitted: true,
    submitStatus: 'pending',       // echoed verbatim
    requestId: 'req-7',            // the in-flight submit's identity
    serverErrors: { '/email': ['Al in gebruik.'] },
    idPrefix: 'customer',          // ids become customer--…
  },
});
tree.session;
// { dirty, dirtyPaths, submitted, submitStatus, requestId,
//   errorCount, serverErrorCount }
```

`session.dirty`/`session.dirtyPaths` are the **navigation-guard authority**: they come from a full JSON diff of `initial` against the current data — independent of what is rendered — so removed array tails, members removed or added (including explicit `null`), and values retained under rule-hidden fields all count, each contributing its pointer. The diff walks **own** keys only (`Object.hasOwn`), so hostile-but-legal member names like `constructor` or a JSON-parsed `__proto__` diff as data, never through the prototype chain, and it RFC 6901-encodes every member name as it builds the pointer (`~` → `~0`, `/` → `~1`, the same `encodeJSONPointerSegment` the model, rule and validation walks use) — so a key containing a slash or a tilde cannot collide with a nested path, and the entries of `dirtyPaths` feed straight back into `getValueAtPointer`. To keep the authority unconditional, a root-level `x-form` `visible` rule is rejected by `compileFormRules` with a `TypeError` — hiding the whole form would null the render tree *and* its summary; gate whole-form visibility at the mount boundary instead. The per-node `dirty`/`errors` members remain the render-layer, visible-only summary. `serverErrors` entries are text: a string, or a number shown as its text, is a message; anything else (an entry without one, `null`, a boolean, an object) is ignored instead of being written as `undefined`, `null`, `true` or `[object Object]`. Without `session`, the tree is byte-identical to the sessionless shape.

## Exports

Every subpath a consumer can import, derived from the manifest by
`npm run docs:derive` (`npm run docs:check` fails when the two drift):

<!--fact:exports.forms-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/forms` | JavaScript | declared |
| `@jarenjs/forms/package.json` | metadata | — |
<!--/fact-->

## Development

Unit tests live in `test/forms/` at the repository root. See the repository [README](../../README.md) for the full Jaren documentation, and the [ROADMAP](../../docs/ROADMAP.md) for planned forms work (rule dependency memoization, hidden-field pruning on submit, computed views through JSLT).

## Form chrome policy

`formChromeLabels(catalog)` supplies `addItem`, `removeItem` and
`jsonPlaceholder`, with English fallbacks and translations in every
locale pack. Pass them to `createFormView({ labels })`; the JSON hint is
both an empty-editor placeholder and an accessible description. A label
beginning with `$` remains literal text. When the language can change
while the form is open, put them in the view input document instead and
name the place with `createFormView({ labelsPath: '$.formLabels' })`: the
stylesheet reads them at render time, a member they lack falling back to
`labels`, then to English.

The add/remove glyphs and required marker are decoration, not message
keys: customize `addLabel`, `removeLabel` and `requiredMarker` on the
stylesheet. Required controls carry `aria-required`; the decorative
marker stays hidden from assistive technology. JSON syntax and the name
“JSON” retain their wire spelling; instructions around them are localized.
