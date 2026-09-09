# @jarenjs/forms

Framework-agnostic form generation for JSON Schema. Turns a schema into a renderable field tree and validates it in **three layers, one stack**:

1. **Per field, every keystroke** — cheap, synchronous checks powered directly by [`@jarenjs/core`](../core) primitives (grapheme-aware string lengths, unicode patterns, deep equality) and the canonical format-tester registry of [`@jarenjs/formats`](../formats): everything one field can know about itself.
2. **Cross field, every keystroke** — visibility, enablement, computed values, and preemptive assertions expressed as [Jaren JSON Query](../json/docs/QUERY-FORMAT.md) documents in an `x-form` annotation, compiled once per model by [`@jarenjs/json`](../json) and evaluated per keystroke as cheap closures.
3. **Authoritative, on submit** — the complete compiled schema validation with [`@jarenjs/validate`](../validate), which owns `required` combinations, `dependentSchemas`, `if/then/else`, `unevaluatedProperties`, and (via the `$query` keyword) the very same cross-field rules.

No DOM, no framework: render the model with React, Vue, vanilla JS or anything else. Forms never runs the validator — apps wire the authoritative layer themselves; the only thing it imports from `@jarenjs/validate` is the pure same-document `$ref`/`$anchor` resolution in `@jarenjs/validate/normalize`. See it in action in the [Jaren playground](https://jklarenbeek.github.io/jarenjs/#/playground).

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

`buildFormModel(schema)` resolves local `$ref`s (`#/$defs/...`), merges `allOf` branches, and returns a tree of field descriptors:

| Property | Meaning |
|---|---|
| `pointer` | JSON pointer into the data (`/user/name`) |
| `label` | `title` or a humanized property name (`firstName` → "First Name") |
| `kind` | `string` `number` `integer` `boolean` `enum` `const` `object` `array` |
| `control` | Rendering hint: `text` `email` `url` `password` `textarea` `number` `checkbox` `select` `date` `datetime-local` `time` `color` `json` |
| `required` | Whether the parent object requires this property |
| `constraints` | `minLength`/`maxLength`/`pattern`/`format`/`minimum`/`maximum`/`multipleOf`/`minItems`/... |
| `rules` | The raw `x-form` rules annotation, if any (see below) |
| `enumValues` / `constValue` / `defaultValue` / `placeholder` | Values for the UI |
| `preview` | A preview hint, or `null`: what a host MAY draw beside the control, as data (`{ kind: 'map' }` for `geojson`) — see below |
| `children` | Child fields (object kinds) |
| `item` / `tuple` | Item template and tuple prefix fields (array kinds) |

Field kinds are inferred from structural keywords when `type` is absent, and `format` maps to input controls and placeholders through the same registry the preemptive validation uses (`getFormatInfo`).

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

`validateField(field, value)` returns `[{ keyword, message }]` using `@jarenjs/core` directly:

- **strings**: grapheme-aware `minLength`/`maxLength` (`getStringLength`), unicode `pattern` (`createRegExp`, cached), and 50+ `format` testers from the [`@jarenjs/formats`](../formats) `formatTesters` registry — the same name → predicate table the authoritative validator's format compilers wrap, so both layers accept exactly the same strings
- **numbers**: type/integer checks, bounds, `multipleOf`
- **enum/const**: deep equality (`equalsDeep`)
- **arrays**: `minItems`/`maxItems`/`uniqueItems` (`isUniqueDeepArray`)

`validateAllFields(model, data)` walks the whole tree and returns a `{ '/pointer': errors }` map — ideal for rendering inline errors next to every field. It reads own JSON members, like the pointer helpers: a field named `constructor`, `toString` or `__proto__` is absent until the data supplies that member.

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

A rule on an array item template (`/lines/-/amount`) compiles **once** and evaluates **per element** of the actual array, binding `$value`/`$pointer` per index — results are keyed by the expanded pointer (`/lines/2/amount`). Rendering uses [`@jarenjs/json/jslt`](../json/docs/JSLT-FORMAT.md) rules over the composed view model. Composition retains the model, data and session cursors together; see the addressing measurement below.

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

One divergence remains, and is inherent: `$pointer` for template elements
stays the template pointer, because element indexes are a render-time notion.

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
const error = validateField(whenField, 'nope', catalog)[0];
error.message;       // 'Moet een geldige datum en tijd zijn'
error.params.format; // 'date-time'
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

- `createInitialData(model)` — defaults and `const` values filled in as own JSON members (including `__proto__`), everything else absent
- `parseFieldInput(field, raw)` — input coercion (`''` → undefined, numeric strings → numbers, enum options → typed values)
- `getValueAtPointer` / `setValueAtPointer` / `appendItem` / `removeItemAt` — immutable updates addressed by JSON pointer
- `createItemValue(field.item)` — starter value for a new array item

## The view model — one render tree per instant

`buildFormViewModel(model, data, options)` composes everything above — the field tree, the current data, per-field validation and `x-form` rule state — into **one plain-JSON render tree**: the "computed view" layer this README promised. Each node carries `pointer`, `label`, `control`, `value` (`x-form.computed` wins, `null` when absent), precomputed select `options` (with `selected`), localized `errors`, `enabled`, and the write discipline flags (`element`: array elements must be written with RFC 6902 `replace`, since `add` inserts; `removable`; `addValue` from `createItemValue`). Rule-hidden fields are *excluded* — a renderer cannot leak hidden data by accident. Array item templates expand per data element with concrete pointers (`/lines/2/amount`), matching the pointer keys of `evaluateFormRules` and `validateAllFields`. A short tuple's `addValue` comes from its next prefix slot; the tail item template supplies starters only after the prefix is filled.

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
composer therefore keeps the JS walk. A complete stylesheet replacement
still needs evidence for array-template expansion, hidden fields, enum
values, errors and session state; first-class functions are not a
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

`session.dirty`/`session.dirtyPaths` are the **navigation-guard authority**: they come from a full JSON diff of `initial` against the current data — independent of what is rendered — so removed array tails, members removed or added (including explicit `null`), and values retained under rule-hidden fields all count, each contributing its pointer. The diff walks **own** keys only (`Object.hasOwn`), so hostile-but-legal member names like `constructor` or a JSON-parsed `__proto__` diff as data, never through the prototype chain, and it RFC 6901-encodes every member name as it builds the pointer (`~` → `~0`, `/` → `~1`, the same `encodeJSONPointerSegment` the model, rule and validation walks use) — so a key containing a slash or a tilde cannot collide with a nested path, and the entries of `dirtyPaths` feed straight back into `getValueAtPointer`. To keep the authority unconditional, a root-level `x-form` `visible` rule is rejected by `compileFormRules` with a `TypeError` — hiding the whole form would null the render tree *and* its summary; gate whole-form visibility at the mount boundary instead. The per-node `dirty`/`errors` members remain the render-layer, visible-only summary. Without `session`, the tree is byte-identical to the sessionless shape.

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
beginning with `$` remains literal text.

The add/remove glyphs and required marker are decoration, not message
keys: customize `addLabel`, `removeLabel` and `requiredMarker` on the
stylesheet. Required controls carry `aria-required`; the decorative
marker stays hidden from assistive technology. JSON syntax and the name
“JSON” retain their wire spelling; instructions around them are localized.
