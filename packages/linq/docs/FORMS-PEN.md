# The Jaren forms pen

> `./forms` — the `x-form` vocabulary on JSON Schema, and
> `assertOnSubmit()`, the same rules' layer-3 `$query` twin. **Read it
> when** you are turning a schema into a form

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119. This document is a **guide** — read
it in order and you can write the format — whose one normative section is
[§2 The mapping table](#2-the-mapping-table); the rules every pen keeps, the shared refusal table, the
index of the other pens and every pen's mapping table collected in one
place are the normative reference,
[LINQ-FORMAT.md](LINQ-FORMAT.md).

## 1. What it writes

You have a schema for some data and now you need a form over it — this
field only when that one is filled, this one required when the company
box is not empty, this one computed rather than typed. Those are rules
about the same members the schema already describes, and keeping them in
a second file beside it is how a renamed member breaks a form silently.
This pen puts them on the member: one JSON Schema, with the form's rules
annotated onto it.

```js
import * as f from '@jarenjs/linq/forms';
import { assertOnSubmit, withForm } from '@jarenjs/linq/forms';
```

is the schema pen's every name from SUBCLASSES that carry the `x-form`
vocabulary — `form({ visible, enabled, assert, computed, message })` on
every builder — plus `assertOnSubmit()`, the one call that answers the
same rules' layer-3 `$query` twin
([the forms README](../../forms/README.md)).

There is no `jaren-form` format. What this pen writes is a **JSON
Schema**, exactly the one [SCHEMA-PEN.md](SCHEMA-PEN.md) describes, with
one namespaced annotation keyword added: `x-form`. That is the whole
difference between the two pens, and it is why this document is the
shortest of the nine — 27 of its 31 names are the schema pen's, emitting
the schema pen's documents, and §2 links them rather than restating them
(the binder's D4 rule: a fact has one home).

A rule is an ANNOTATION. It never changes what the schema validates:
`required`, `additionalProperties` and every other keyword stay exactly
what the schema pen wrote, `Infer<>`/`Input<>` read exactly as they do
there, and the subclasses exist only so `form()` survives every chained
method. What `buildFormModel`, `compileFormRules` and
`evaluateFormRules` then read is the annotation; a validator that has
never heard of `x-form` ignores it, which is what makes the keyword safe
under every metaschema.

The pen imports nothing of `@jarenjs/forms`: the reader is the only
judge of what a rule means, and `assertOnSubmit()` is pinned deep-equal
to `formRulesToQueryAssertions` over the whole corpus
(`test/linq/forms-pen.test.js`).

**The running example.** §3 is one shop's checkout, field by field: the
terms box that is the smallest rule the pen can write, the shipping
address where all three context names appear at once, the invoice block
whose VAT id is required only for companies, that same block's submit
twin, the project's own VAT string kind carrying the rules through a
subclass, and the delivery parcel whose map preview is derived rather
than authored. §5 reads the types off the same documents, and finds them
identical to the schema pen's — which is the point.

### 1.1 The rule context, and its three names

The three predicates and `computed` are CALLBACKS captured over the rule
context, never paths typed as strings. The context spells the three
names the evaluator binds, and no others:

| Written | Captured as | What it is |
|---|---|---|
| `c.root` | `$` | the whole form document — cross-field is the point |
| `c.value` | `$value` | the field's current value; an absent field binds `null`, because `undefined` is not a JSON value |
| `c.pointer` | `$pointer` | the field's data pointer, `'/vatId'` |

`c.root` is the capture's document proxy; `c.value` and `c.pointer` are
the two EXTERNALS `compileFormRules` binds per evaluation. Any other
name is `JL0104` here, where the fix can be named, rather than a compile
error out of `compileFormRules` naming the same two — which is why the
message says "exactly 2 externals" and then names all three spellings
(§4.3).

Wherever a rule takes a callback it also takes a query document written
by hand, copied through the JSON boundary. That is the escape for a
query the chain cannot spell, and it is unchecked: the pen copies what
it is given, so `form({ visible: 42 })` emits `"visible": 42` and the
reader is what refuses it. Prefer the callback.

### 1.2 The mixin: new classes, never a patched prototype

`withForm(Base)` answers a NEW class — `class extends Base` carrying
`form()` and an overriding `meta()`. `./forms` applies it to the schema
pen's eight exported builder classes at module scope and hands the eight
results to `createFactories()`
([SCHEMA-PEN.md](SCHEMA-PEN.md#210-the-document-and-the-builder-itself)),
so the factory wiring exists exactly once and no subpath ever patches
another's prototype. `with()` rebuilds `new this.constructor(state)`, so
the subclass survives every chained method: `f.string().min(1).form({…})
.optional().describe('d')` is one `FormStringBuilder` throughout.

The mixin adds exactly two names, and one of them shadows a base method.
A sweep over all eight classes — for each method the mixin defines, is
that name an own property anywhere on the base's prototype chain? —
finds `form` free everywhere and `meta` shadowed on all eight, from
`SchemaBuilder`. That shadow is the intentional override of §2.2, and it
calls `super.meta()`; nothing else collides.

## 2. The mapping table

Every name `@jarenjs/linq/forms` exports that a caller writes, and every
method reachable on a builder it hands back — 31 in all. The eight
builder classes, the one constant and the one guard it also exports are
§5's, because a caller meets those through a type annotation, a subclass
or an `instanceof` narrow rather than by calling one.

The rows come in three kinds, and each subsection below says which:

| Kind | Count | What the row does |
|---|---:|---|
| **re-exported unchanged** | 27 | links `SCHEMA-PEN.md` §2's row and states nothing of its own — the emission, the `Infer`/`Input` reading and every refusal are the schema pen's, and the only difference is the CLASS that comes back |
| **re-exported and extended** | 1 | the schema pen's behaviour plus what this pen adds, stated here |
| **forms-only** | 3 | this pen's own, stated here in full |

That distribution is the honest shape of the pen and not an abridgement:
the forms pen IS the schema pen plus `x-form`, so a document that
restated 27 rows would be a second copy of `SCHEMA-PEN.md` §2 waiting to
drift from it. `test/linq/pen-docs.test.js` holds every one of the 31
names named somewhere in this section.

Status: **native** (emits the named keyword), **emulated** (a
composition with identical semantics), **refused** (a coded error naming
the reason).

### 2.1 Re-exported unchanged — 27 names

Each row is a family, and the link is where the family's members are
documented: their emission, their `Infer`/`Input` reading and the
`JL0101`/`JL0102`/`JL0103` each can raise. Nothing about them changes
here; what changes is the class of the builder that comes back, which is
the linked class plus `form()`.

| Names | Documented at | The class that comes back |
|---|---|---|
| `string()`, `number()`, `integer()`, `boolean()`, `nil()`, `literal(v)`, `enumOf(values)`, `datetime()`, `date()`, `time()`, `duration()`, `any()`, `never()` | [SCHEMA-PEN.md §2.1](SCHEMA-PEN.md#21-primitives-literals-and-enums) | `FormStringBuilder`, `FormNumberBuilder`, `FormBuilder`, `FormNeverBuilder` |
| `object(props)`, `record(values)` | [SCHEMA-PEN.md §2.2](SCHEMA-PEN.md#22-objects) | `FormObjectBuilder`, `FormBuilder` |
| `array(items)`, `tuple(items)` | [SCHEMA-PEN.md §2.3](SCHEMA-PEN.md#23-arrays-and-tuples) | `FormArrayBuilder`, `FormTupleBuilder` |
| `union(options)`, `discriminated(key, options)`, `intersection(parts)`, `when(cond)` | [SCHEMA-PEN.md §2.6](SCHEMA-PEN.md#26-composition) | `FormBuilder`, `FormWhenBuilder` |
| `named(name, b)`, `ref(name)`, `lazy(thunk)`, `from(json)` | [SCHEMA-PEN.md §2.7](SCHEMA-PEN.md#27-references-and-defs) | `FormBuilder` (a `named()` builder is one of its own) |
| `document(root, { draft })`, `schemaOf(value)` | [SCHEMA-PEN.md §2.10](SCHEMA-PEN.md#210-the-document-and-the-builder-itself) | — (both answer a document, not a builder) |

This is the **grouped re-export row**, the row kind
[LINQ-FORMAT.md](LINQ-FORMAT.md) §5 defines: one row per family, linking
the schema pen's row rather than restating it, with a third column
carrying the one thing that IS different here. For this pen that column
is the class, because nothing else differs — the emission is byte for
byte the schema pen's. [MODEL-PEN.md
§2.5](MODEL-PEN.md#25-the-schema-pens-vocabulary-re-exported) uses the
same row kind with a status in that column instead, because there the
re-exports do gain behaviour.

Every builder METHOD the schema pen documents is reachable on these too
and behaves identically — the string constraints of
[§2.4](SCHEMA-PEN.md#24-strings), the number constraints of
[§2.5](SCHEMA-PEN.md#25-numbers), the annotations of
[§2.8](SCHEMA-PEN.md#28-annotations-and-messages) except `meta()`, and
the validation extensions of
[§2.9](SCHEMA-PEN.md#29-validation-extensions). Every one of the 26
factories, exercised with its own constraints and composed through both
pens, emits a byte-identical document — measured over all 26 while this
section was written, and the reason the links above are a claim rather
than a hope. Two gates hold the halves of it that can be gated:
`test/linq/forms-pen.test.js` rebuilds the forms README's own
hand-written JSON Schemas through this pen and asserts BYTE equality,
and `test/consumer/linq-app.ts` pins `Infer<>` over a ruled document
equal to the schema pen's reading of a rule-free one.

Two of the 27 carry a wrinkle worth reading before you meet it:

- **`never()`** answers `false`, and `false` carries no keywords at all —
  so `form()` on it is `JL0102` exactly as `meta()`, `describe()` and
  `message()` are ([§4.2](#42-jl0102--preview-and-the-boolean-schema)).
  It does not compile either: the factory answers `FormNeverBuilder`,
  which declares neither. `nullable()` is the way out and the message
  says so.
- **`when()`** answers a `FormWhenBuilder`, whose `then()`/`else()` take
  schemas — and which carries `form()` like every other class, because a
  conditional used as a member is a field whose rules evaluate
  ([§5.5](#55-the-two-refusals-the-types-close-and-the-one-node-that-carries-a-rule-anyway)).

### 2.2 Re-exported and extended — `meta()`

One name whose behaviour this pen changes, and the reason it had to.

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `.meta(annotations)` | the keys verbatim, in the order first set — exactly [SCHEMA-PEN.md §2.8](SCHEMA-PEN.md#28-annotations-and-messages)'s behaviour | — | native; a schema-pen-owned keyword is `JL0104` there, and `'x-form'` is `JL0104` HERE: the forms pen owns that keyword, and the fix is to spell it through `form()` |

`meta()` is the one re-exported name whose own behaviour differs. The
schema pen owns the structural keywords, the constraints and the
annotations it writes itself; the forms pen owns one more, `x-form`, and
a rule written through `meta()` would bypass every check `form()` makes
— the member set, the message shape, the capture, the `preview`
refusal. The override closes that door and names the one that is open.

### 2.3 Forms-only — three names

The pen's own surface: the method that writes a rule, the call that turns
the rules into their submit-time twin, and the door a third pen comes in
by.

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `.form({ visible?, enabled?, assert?, computed?, message? })` | one `x-form` annotation, its members in the README's own order whatever order the author wrote; a second call MERGES into the same annotation rather than replacing it | `this` — the builder's phantoms are untouched, because a rule is an annotation | native; a member `x-form` does not define, or a `message` that is neither a string nor a MessageSpec, `JL0101`; `preview` `JL0102`; a name the context does not bind `JL0104` |
| `withForm(Base)` | nothing: a NEW class, `Base` plus `form()` and the overriding `meta()`. The route by which a third pen — or a project's own vocabulary — carries `x-form` (§3.5) | `B` (the base class's own type) | native; a non-constructor argument is JavaScript's own `TypeError` from the `extends` clause, not a `LinqBuildError` |
| `assertOnSubmit(root)` | the root document with one `allOf` branch `{ $query, errorMessage }` per `x-form.assert` in it; a document with no assert answers ITSELF, because a needless `allOf` would be a second spelling of the same schema | `JsonSchema` | native; a value that is neither a builder nor an object schema is `JL0101` |

The four query-valued members of `form()`, and what a reader is deciding
between:

| Member | Kind | Emits | The reader's question |
|---|---|---|---|
| `visible` | EBV query | `x-form.visible` | should the field be shown? A broken rule fails **open** — it must never hide data |
| `enabled` | EBV query | `x-form.enabled` | should the field accept input? Fails **open**, same reason |
| `assert` | EBV query | `x-form.assert` | a cross-field preemptive assertion. Fails **closed**: an assertion that cannot be computed has not been satisfied |
| `computed` | query | `x-form.computed` | the field's derived value, mapped to plain JSON. A failure leaves the value absent |
| `message` | string or MessageSpec | `x-form.message`, verbatim | what an `assert` failure renders — an inline template, or `{ $msgid, message?, params? }` for the catalog |

The EBV rule and the three failure policies are the reader's, not the
pen's: the pen emits the query and `evaluateFormRules` applies them
(the forms README, layer 2). A rule on an array ITEM template lands on
the item schema, which is where `buildFormModel` expects it — it
compiles once at `/lines/-/amount` and evaluates per element, keyed by
the expanded pointer (§3.3).

### 2.4 What the submit twin keeps

`assertOnSubmit()` walks the structural spine `buildFormModel` walks —
`properties`, `prefixItems`, `items`, `allOf` — and copies every
`x-form.assert` onto the ROOT as its own branch. It does NOT resolve
`$ref`s: a definition's data location depends on its use site, and a
`$query` branch has to name one.

Four rules travel with each copy, and each is a place a naive copy went
wrong (the README's own list):

- **an absent field binds `null`**, through `$default`, so `$ne` and
  `$eq` cannot mean opposite things on the two sides;
- **an item-template assert quantifies over the ELEMENTS** (`$every` /
  `$satisfies` over `[*]`, one level per array crossed) rather than over
  the selected leaves, so an element missing the member is evaluated
  with `null` exactly as the keystroke path evaluates it;
- **an assert on a field that also declares `visible` is guarded by it**
  — `{ $or: [{ $not: visible }, assert] }` — so it holds vacuously while
  the field is hidden, which is what the keystroke path already does
  since `buildFormViewModel` drops hidden nodes;
- **the message travels with the branch**, as
  `errorMessage.$query` with `params` merged over `{ pointer }`, so
  submit renders the same text in every locale. A rule with no message
  gets the catalog default, `{ $msgid: 'x-form/assert' }`.

The branches land on the ROOT, where `$` is the instance root the rule
context expects. §3.4 shows one end to end.

### 2.5 What the pen does not judge

What the pen does **not** judge is the reader's: a root-level `visible`
(a `TypeError` out of `compileFormRules` — hiding the whole form would
null the render tree and its dirty summary), the rules' own operators,
the EBV of a multi-item sequence (`JQ2003` at evaluation), and the
schema's own semantics. It emits those documents and `@jarenjs/forms`
refuses them; the pen test builds each through the pen and asserts the
reader's behaviour.

## 3. Worked examples

Every `js` fence exports exactly one document, and the `json` fence that
follows is what the pen emits — executed by
`test/linq/pen-docs.test.js`. The forms README's own layer-2 document
and its opening usage schema are rebuilt the same way and held
BYTE-equal to their fences by `test/linq/forms-pen.test.js`.

### 3.1 One field, one rule

**The checkout's terms box.** The smallest thing the pen writes that the schema pen cannot: a
checkbox that must be ticked, with the message its failure renders.
Everything except `x-form` is the schema pen's document.

```js
import * as f from '@jarenjs/linq/forms';

export const consent = f.object({
  newsletter: f.boolean().default(false),
  terms: f.boolean().form({
    assert: (c) => c.value.eq(true),
    message: { $msgid: 'checkout.terms-required', message: 'Please accept the terms' },
  }),
});
```
```json
{
  "type": "object",
  "properties": {
    "newsletter": { "type": "boolean", "default": false },
    "terms": {
      "type": "boolean",
      "x-form": {
        "assert": { "$eq": ["$value", true] },
        "message": { "$msgid": "checkout.terms-required", "message": "Please accept the terms" }
      }
    }
  },
  "required": ["newsletter", "terms"],
  "additionalProperties": false
}
```

`required` still lists both members and `additionalProperties` is still
`false`: the annotation moved nothing. Drop the `x-form` node from the
emitted document and what is left is byte-identical to the same object
built through `@jarenjs/linq/schema` — which is what
`test/linq/forms-pen.test.js` asserts, member for member.

### 3.2 The rule context: `root`, `value`, `pointer`, and nothing else

**The shipping address.** All three names in one document, and each in the position a reader will
want it: `c.root` for a cross-field read, `c.value` for the field's own,
`c.pointer` for a rule that needs to name itself.

```js
import * as f from '@jarenjs/linq/forms';

export const shipping = f.object({
  country: f.string().enumOf(['NL', 'BE', 'DE']),
  postcode: f.string().form({
    visible: (c) => c.root.country.ne(''),
    enabled: (c) => c.root.country.eq('NL'),
    assert: (c) => c.value.matches('^[0-9]{4} ?[A-Z]{2}$'),
    message: { $msgid: 'address.postcode' },
  }),
  audit: f.string().optional().form({ computed: (c) => c.pointer }),
});
```
```json
{
  "type": "object",
  "properties": {
    "country": { "type": "string", "enum": ["NL", "BE", "DE"] },
    "postcode": {
      "type": "string",
      "x-form": {
        "visible": { "$ne": ["$.country", ""] },
        "enabled": { "$eq": ["$.country", "NL"] },
        "assert": { "$match": ["$value", "^[0-9]{4} ?[A-Z]{2}$"] },
        "message": { "$msgid": "address.postcode" }
      }
    },
    "audit": { "type": "string", "x-form": { "computed": "$pointer" } }
  },
  "required": ["country", "postcode"],
  "additionalProperties": false
}
```

`c.root.country` captured as `"$.country"` — a path into the whole
document, not into the field. `c.value` and `c.pointer` captured as the
two externals. A fourth name is `JL0104` at this line, not at
`compileFormRules` time: `(c) => c.previous.ne(c.value)` never reaches a
document.

The members come out in the README's order — `visible`, `enabled`,
`assert`, `computed`, `message` — whatever order the author wrote them
in, so two authors writing the same rule write the same bytes.

### 3.3 A cross-field form: visibility, an assert, an item template and a computed total

**The invoice block.** A VAT id visible only for companies and required when one is
named, a per-line assert on the item TEMPLATE, and a total derived from
the lines.

```js
import * as f from '@jarenjs/linq/forms';

export const invoice = f.object({
  company: f.string().optional(),
  vatId: f.string().optional().form({
    visible: (c) => c.root.company.ne(''),
    assert: (c) => c.root.company.eq('').or(c.value.ne('')),
    message: { $msgid: 'checkout.vat-required', message: 'A VAT id is required for companies' },
  }),
  lines: f.array(f.object({
    amount: f.number().form({ assert: (c) => c.value.gt(0), message: 'Every line must be positive' }),
  })).default([]),
  total: f.number().optional().form({ computed: (c) => c.root.lines.all().amount.sum() }),
});
```
```json
{
  "type": "object",
  "properties": {
    "company": { "type": "string" },
    "vatId": { "type": "string", "x-form": {
      "visible": { "$ne": ["$.company", ""] },
      "assert": { "$or": [{ "$eq": ["$.company", ""] }, { "$ne": ["$value", ""] }] },
      "message": { "$msgid": "checkout.vat-required", "message": "A VAT id is required for companies" } } },
    "lines": { "type": "array", "items": {
      "type": "object",
      "properties": { "amount": { "type": "number", "x-form": {
        "assert": { "$gt": ["$value", 0] },
        "message": "Every line must be positive" } } },
      "required": ["amount"],
      "additionalProperties": false }, "default": [] },
    "total": { "type": "number", "x-form": { "computed": { "$sum": "$.lines[*].amount" } } }
  },
  "required": ["lines"],
  "additionalProperties": false
}
```

Three things a reader should take from this document:

- **The item rule sits on the item schema**, once, at
  `/lines/-/amount`. `buildFormModel` finds it there and
  `compileFormRules` compiles it once; `evaluateFormRules` binds
  `$value`/`$pointer` per element and keys the results by the expanded
  pointer (`/lines/2/amount`). Writing the rule on the ARRAY instead
  would bind `$value` to the whole list.
- **`assert` and `visible` are one rule, not two.** The assert is
  written as if the field were always shown; §3.4 is what makes it
  vacuous while it is hidden, and the keystroke path already does the
  same by dropping hidden nodes from the view model.
- **`computed` reads the document, not the field.**
  `c.root.lines.all().amount.sum()` is a chain over `$`, captured as
  `{ "$sum": "$.lines[*].amount" }` — the field it sits on contributes
  only where the result lands.

### 3.4 The same rule on submit

**The same invoice block, on submit.** One call, over the document the pen just wrote. The branch the validator
enforces carries the `visible` guard, the `null` binding and the
message:

```js
import * as f from '@jarenjs/linq/forms';
import { assertOnSubmit } from '@jarenjs/linq/forms';

export const submit = assertOnSubmit(f.object({
  company: f.string().optional(),
  vatId: f.string().optional().form({
    visible: (c) => c.root.company.ne(''),
    assert: (c) => c.root.company.eq('').or(c.value.ne('')),
    message: 'VAT id is required for companies',
  }),
}));
```
```json
{
  "type": "object",
  "properties": {
    "company": { "type": "string" },
    "vatId": { "type": "string", "x-form": {
      "visible": { "$ne": ["$.company", ""] },
      "assert": { "$or": [{ "$eq": ["$.company", ""] }, { "$ne": ["$value", ""] }] },
      "message": "VAT id is required for companies" } }
  },
  "additionalProperties": false,
  "allOf": [
    { "$query": {
        "$let": { "value": { "$default": ["$['vatId']", { "$const": null }] },
                  "pointer": { "$const": "/vatId" } },
        "$return": { "$or": [
          { "$not": { "$ne": ["$.company", ""] } },
          { "$or": [{ "$eq": ["$.company", ""] }, { "$ne": ["$value", ""] }] }] } },
      "errorMessage": { "$query": {
        "message": "VAT id is required for companies",
        "params": { "pointer": "/vatId" } } } }
  ]
}
```

Read the branch outward: `$let` binds the two externals the keystroke
path binds — `$value` through `$default` so an absent `vatId` is `null`,
`$pointer` as a constant — and `$return` is the `visible` guard
`$or`-ed with the authored assert. The `x-form` node is untouched, so
one document serves both paths, and `assertOnSubmit()` over a document
with no assert answers that document unchanged.

### 3.5 `withForm()` over your own builder class

**The shop's own VAT string kind.** The rules ride on every builder because `./forms` built its eight
classes with the mixin. A project that wants its own vocabulary BESIDE
them takes the same route: subclass a schema-pen class, wrap the eight
in `withForm()`, and hand them to `createFactories()`.

```js
import { withForm } from '@jarenjs/linq/forms';
import {
  ArrayBuilder, NeverBuilder, NumberBuilder, ObjectBuilder, SchemaBuilder,
  StringBuilder, TupleBuilder, WhenBuilder, createFactories,
} from '@jarenjs/linq/schema';

/** the project's own string kind — one method, spelled once */
class VatStringBuilder extends StringBuilder {
  vat() { return this.pattern('^[A-Z]{2}[0-9A-Z]{2,12}$'); }
}

const p = createFactories({
  Base: withForm(SchemaBuilder), String: withForm(VatStringBuilder),
  Number: withForm(NumberBuilder), Array: withForm(ArrayBuilder),
  Tuple: withForm(TupleBuilder), Object: withForm(ObjectBuilder),
  When: withForm(WhenBuilder), Never: withForm(NeverBuilder),
});

export const supplier = p.object({
  company: p.string().optional(),
  vatId: p.string().vat().optional().form({ visible: (c) => c.root.company.ne('') }),
});
```
```json
{
  "type": "object",
  "properties": {
    "company": { "type": "string" },
    "vatId": {
      "type": "string",
      "pattern": "^[A-Z]{2}[0-9A-Z]{2,12}$",
      "x-form": { "visible": { "$ne": ["$.company", ""] } }
    }
  },
  "additionalProperties": false
}
```

`.vat()` and `.form()` chain in either order and the class survives
both, because every schema-pen method is written in terms of `with()`,
which rebuilds `new this.constructor(state)`. This is also exactly how
`./forms` and `./model` exist — neither patches a prototype, and
`createFactories` is the wiring both call.

The mixin is a class expression, so `withForm(42)` is JavaScript's own
`TypeError` from the `extends` clause rather than a `LinqBuildError`:
it is a build-your-own-pen call, not part of a document's authoring
path.

### 3.6 A format that DERIVES its preview

**The delivery parcel, drawn on a map.** `preview` is not something an author writes. The registry carries it
against the FORMAT, and `buildFormModel` reads it from there — so what
this pen emits for a previewable field is a plain `format`:

```js
import * as f from '@jarenjs/linq/forms';

export const parcel = f.object({
  label: f.string(),
  area: f.string().format('geojson').describe('Draw the parcel'),
});
```
```json
{
  "type": "object",
  "properties": {
    "label": { "type": "string" },
    "area": { "type": "string", "format": "geojson", "description": "Draw the parcel" }
  },
  "required": ["label", "area"],
  "additionalProperties": false
}
```

No `x-form` at all — and the field descriptor `buildFormModel` answers
for `/area` carries the hint anyway, out of `getFormatInfo('geojson')`:

```json
{
  "pointer": "/area",
  "control": "textarea",
  "placeholder": "{\"type\":\"Point\",\"coordinates\":[4.9,52.4]}",
  "preview": { "kind": "map" }
}
```

(The second `json` fence is engine OUTPUT, not the pen's emission; the
docs gate pairs the first with the `js` fence above and reads this one
only as JSON.) `form({ preview: … })` is `JL0102`
([§4.2](#42-jl0102--preview-and-the-boolean-schema)) because a hand-written
`preview` would be a keyword nothing reads: `buildFormModel` never looks
in `x-form` for one. Spell the format, and a host that understands
`preview.kind === 'map'` draws the map beside the control while a host
that does not gets exactly the textarea it always had. `geojson` is the
only format in the registry carrying a preview today.

## 4. Refusals

The forms pen raises these `LinqBuildError` codes and no others —
`test/linq/pen-docs.test.js` holds this list equal, in both directions,
to the codes `packages/linq/src/forms/` throws. The full condition each
code states across every pen is the binder's,
[LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3.

| Code | What this pen raises it for |
|---|---|
| `JL0101` | a value this pen cannot spell, or a name → value map it cannot read |
| `JL0102` | a construct the format cannot carry |
| `JL0104` | a pen-owned keyword written through `meta()`, or an external a captured rule did not declare |

Thirteen sites, the fewest of any pen — which is the same fact §2 states
from the other side: 27 of 31 names refuse what
[SCHEMA-PEN.md §4](SCHEMA-PEN.md#4-refusals) says they refuse, and only
four names have refusals of their own. Every message below is the one
the pen raised when the spelling beside it was run, with the code prefix
removed. `docPath`, where the refusal carries one, is the JSON pointer
of the node being assembled and is appended to the message text as well
(`… at /message`).

### 4.1 `JL0101` — the value, the member and the message

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `f.string().form(42)`, `.form(null)`, `.form([])` | `form() takes { visible?, enabled?, assert?, computed?, message? }, got 42` | a plain object of rule members |
| `f.string().form({ nope: 1 })` | `form() does not take 'nope' — x-form defines visible, enabled, assert, computed, message` | one of the five |
| `f.string().form({ message: 42 })`, `{ message: [] }` | `form() message is an inline string or a MessageSpec { $msgid?, message?, params? }, got 42` | `'text'`, or `{ $msgid, message?, params? }` |
| `f.string().form({ message: {} })`, `{ message: { params: {} } }` | `form() message as a MessageSpec needs '$msgid' and/or 'message'` | give the spec a `$msgid`, a `message`, or both |
| `f.string().form({ visible: { a: undefined } })` | `form() visible received a Object instance, which is not JSON — a document carries null, booleans, finite numbers (never -0), strings, arrays and plain objects, and nothing else` | a JSON value, or a callback |
| `f.assertOnSubmit(42)`, `([])`, `(true)` | `assertOnSubmit() takes the document's root builder or its schema object, got 42` | the root builder, or its `schema` |

The message rule is worth stating in full, because a reader meets it the
first time they reach for a translated string. `message` is the ONE
member of `form()` that is not a query: it is copied verbatim, either as
an inline template string or as a MessageSpec object, and a spec must
carry at least one of `$msgid` and `message` — a spec with only `params`
names no text to render, and rendering nothing is not a message. Every
other member is captured or copied through the JSON boundary, so the
`requireJson` refusal above is reachable under all four of them.

The `__proto__` case is the binder's rule 5 and is unchanged here —
`f.object({ __proto__: f.string() })` is
`object() received a map whose prototype was replaced: …`, and the
spelling that works is the computed key `{ ['__proto__']: … }`. The full
paragraph is [SCHEMA-PEN.md §4.1](SCHEMA-PEN.md#41-jl0101--the-value-or-the-map);
`test/linq/pen-docs.test.js` proves it on this pen's `object()` as well.

### 4.2 `JL0102` — `preview`, and the boolean schema

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `f.string().form({ preview: { kind: 'map' } })` | `form() cannot write 'preview' — a field's preview hint is DERIVED from its format by the registry (getFormatInfo(format).preview), never authored, and buildFormModel reads it from there; spell the format instead, and a host that understands the hint draws it beside the control` | `f.string().format('geojson')` |
| `f.never().form({ visible: … })` | `never() is the boolean schema false, which carries no 'x-form' — annotate the member that holds it, or nullable() it first` | rule the member that HOLDS the `never()`, or `f.never().nullable().form({ … })` |

**`preview` is a derivation, and the refusal is where a reader learns
that.** The registry answers `getFormatInfo('geojson').preview` as
`{ kind: 'map' }`; `buildFormModel` copies it onto the field and
`buildFormViewModel` onto the view node. `x-form` has no `preview`
member and nothing reads one, so a hand-written `preview` would be
silently inert — the worst failure a form can have, because the field
renders and the map does not and no error says why. The pen refuses it
instead and names the fix: set the `format`. §3.6 shows both halves.

**`never()` is `false`, and `false` carries nothing.** The refusal is
the schema pen's `annotate()` rule reaching through the mixin, and it
fires for `form()` for the same reason it fires for `meta()`,
`describe()`, `title()`, `example()` and `message()`: there is no object
to hang a keyword on. `nullable()` widens the node to
`{ anyOf: [false, { type: 'null' }] }` — an object — and every
annotation is legal again from there. Order matters:
`f.never().form({ … }).nullable()` still refuses, because the refusal is
raised at the `form()` call.

Typed code does not reach either refusal: `never()` answers a
`FormNeverBuilder`, which declares no `form()` and inherits a `meta()`
nothing is assignable to, so both spellings are compile errors as well
([§5.5](#55-the-two-refusals-the-types-close-and-the-one-node-that-carries-a-rule-anyway)).

### 4.3 `JL0104` — the owned keyword, and the unbound name

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `f.string().meta({ 'x-form': { visible: '$.a' } })` | `meta() cannot write 'x-form' — the forms pen owns that keyword; spell it through form()` | `f.string().form({ visible: … })` |
| `f.string().form({ assert: (c) => c.nope })` | `a form() assert rule cannot bind 'nope' — its query evaluates with exactly 2 externals, 'value' and 'pointer'; anything else has nothing to bind to — the document being edited is the context's root (c.root), the field's own value c.value and its pointer c.pointer` | `c.root`, `c.value`, `c.pointer` |

The unbound-name message opens with the shared capture's own sentence —
"exactly 2 externals" is a count of the EXTERNALS `compileFormRules`
binds, which is two — and then names all three spellings the context
answers, because `c.root` is the document proxy rather than an external
and a reader counting names would otherwise be one short. The refusal
fires under all four query members, with the member's name in the
message (`a form() visible rule …`, `a form() computed rule …`).

The schema pen's own `meta()` refusal is still here beside this one:
`f.string().meta({ type: 'x' })` is
`meta() cannot write 'type' — the pen owns that keyword; …`. The two
messages differ by one word — "the forms pen" against "the pen" — which
is how a reader tells which pen refused them.

## 5. The types

§3.3's invoice block again, this time with the `Doc` annotation that types
its three context names — and read through both readers, so the schema
half and the rule half are visible together.

```ts
import { buildFormModel, compileFormRules, evaluateFormRules } from '@jarenjs/forms';
import { JarenValidator } from '@jarenjs/validate';
import * as f from '@jarenjs/linq/forms';
import { assertOnSubmit, isSchemaBuilder, SCHEMA_BUILDER } from '@jarenjs/linq/forms';
import type { FormRules, MessageSpec, Rule, RuleContext } from '@jarenjs/linq/forms';
import type { Infer, Input } from '@jarenjs/linq/schema';

type Doc = { company?: string; vatId?: string; lines: { amount: number }[] };

const invoice = f.object({
  company: f.string().optional(),
  vatId: f.string().optional().form<Doc>({
    visible: (c) => c.root.company.ne(''),
    assert: (c) => c.root.company.eq('').or(c.value.ne('')),
    message: 'VAT id is required for companies',
  }),
  lines: f.array(f.object({
    amount: f.number().form<Doc>({ assert: (c) => c.value.gt(0), message: 'positive' }),
  })).default([]),
});

type Invoice = Infer<typeof invoice>;      // the schema pen's reading, unchanged
type InvoiceIn = Input<typeof invoice>;    // and so is the accepted twin

const model = buildFormModel(invoice.schema);
evaluateFormRules(compileFormRules(model), data);          // per keystroke
new JarenValidator().compile(assertOnSubmit(invoice));     // on submit

const annotated = (c: RuleContext<Doc, string>) => c.root.company.ne('');
const rules: FormRules<Doc, string> = { visible: annotated };
const msg: MessageSpec = { $msgid: 'address.postcode' };
const branded: boolean = isSchemaBuilder(invoice);
const brand: symbol = SCHEMA_BUILDER;
```

### 5.1 `Infer<>` and `Input<>` are the schema pen's

`Infer<typeof invoice>` is
`{ company?: string; vatId?: string; lines: { amount: number }[] }` —
the same reading `@jarenjs/linq/schema` gives the same builders, with no
trace of the rules. That is the type-level statement of the annotation
rule: a rule cannot make a member optional, cannot narrow it and cannot
add one, so it cannot appear in the inferred shape. The eight classes
re-declare `optional()`, `nullable()`, `default()`, `coerce()` and the
kind methods only to keep their OWN class through the chain — the
phantoms they pass along are `SchemaBuilder`'s, unchanged, and
[SCHEMA-PEN.md §5.1](SCHEMA-PEN.md#51-the-phantoms-and-the-flags)
documents them.

`test/consumer/linq-app.ts` pins both halves: `Infer<typeof Invoice>`
EQUAL (not merely assignable) to the hand-written shape, and the same
equality for a plain schema-pen object beside it.

### 5.2 The rule context, typed

`RuleContext<Doc, Value>` carries the three names §1.1 lists:
`root: MemberExpr<Doc>`, `value: MemberExpr<Value>` and
`pointer: StringExpr`. `Value` comes from the builder the rule sits on,
so `f.number().form({ assert: (c) => c.value.gt(0) })` types `c.value`
as a number expression with no annotation at all.

`Doc` does not, and cannot. A member builder is written before the
object that will hold it exists, so `c.root` is the honest top until the
callback is annotated — the same limit
[FLOW-PEN.md](FLOW-PEN.md)'s `context` meets, and TypeScript's own.
Two spellings do it, and the first is shorter:

```ts
f.string().form<Doc>({ visible: (c) => c.root.company.ne('') });
f.string().form({ visible: (c: RuleContext<Doc, string>) => c.root.company.ne('') });
```

Annotated, a member the document does not declare stops compiling:
`c.root.firm` is `Property 'firm' does not exist`, which
`test/consumer/linq-app.ts` pins with a `@ts-expect-error`.

`Rule<Doc, Value>` is the union of the callback and a hand-written query
document; `FormRules<Doc, Value>` is the five-member spec, and it has no
`preview` member on purpose — so `f.string().form({ preview })` fails to
compile as well as raising `JL0102`, which is the pin two lines below
that one in the same file.

### 5.3 The eight builder classes, the constant and the guard

Ten exports are surface a caller does not CALL, which is why none of
them is in §2:

| Export | What a caller meets it as |
|---|---|
| `FormBuilder` | the base every untyped kind is built from — `literal()`, `enumOf()`, `record()`, `union()`, `discriminated()`, `intersection()`, `ref()`, `lazy()`, `any()`, `from()`, `boolean()`, `nil()` all answer one. A type annotation, and the class a pen built over this one subclasses |
| `FormStringBuilder`, `FormNumberBuilder`, `FormArrayBuilder`, `FormTupleBuilder`, `FormObjectBuilder`, `FormWhenBuilder`, `FormNeverBuilder` | the seven kinds with their own methods; annotations, `instanceof` narrows, and the classes `createFactories` was handed |
| `SCHEMA_BUILDER` | the brand key, re-exported from the schema pen — a `Symbol.for` registry symbol, so a forms builder is a schema builder to every consumer that reads the brand |
| `isSchemaBuilder(value)` | the same guard, re-exported: `true` for any builder of either pen, `false` for a data object that merely carries a `toJSON` member |

The brand and the guard are RE-EXPORTS, not twins. A `FormObjectBuilder`
IS a `SchemaBuilder` — `isSchemaBuilder` from either subpath answers
`true` for it, and `schemaOf()` from either reads its document — which is
what lets a form schema be handed to anything that takes a schema-pen
builder, `defineApp({ state })` included.

All ten are VALUES, exported at run time and declared as one;
`test/linq/types.test.js` holds this pen's two export sets equal, in
both directions. `FormBooleanBuilder`, `FormNullBuilder` and
`FormNamedBuilder` are declared but NOT exported, exactly as
`BooleanBuilder`, `NullBuilder` and `NamedBuilder` are on the schema pen
— `boolean()`, `nil()` and `named()` each build a plain base builder, so
there is no class to export and importing one as a value does not
compile.

### 5.4 What the pins hold

`test/consumer/linq-app.ts` carries this pen's compile-level half beside
the app pen's — one file, because they are the two pens a form-shaped
application uses together. It holds:

- `Infer<typeof Invoice>` equal to the hand-written document shape, and
  the same equality for a rule-free schema-pen object, so a regression
  that let a rule leak into the inferred type fails the build;
- a rule annotated with `form<Doc>()` reading a member the document
  declares, and a `@ts-expect-error` on one it does not;
- `@ts-expect-error` on `f.string().form({ preview })` and on
  `f.string().meta({ 'x-form': … })` — the two refusals of §4 that the
  types also close;
- `f.never() instanceof FormNeverBuilder`, which is the runtime half of
  §5.3's "declared and exported are one set".

### 5.5 The two refusals the types close, and the one node that carries a rule anyway

- **`f.never().form({ … })` does not compile**, and neither does
  `f.never().meta({ … })`. `never()` answers a `FormNeverBuilder` — the
  class the runtime really builds — which declares no `form()` at all
  and inherits a `meta()` whose parameter is `never`, so nothing is
  assignable to it. Both are `JL0102` at run time (§4.2) and neither
  reaches run time from typed code. `nullable()` widens the node and
  hands back `FormBuilder`, where both are legal again — the remedy the
  message names, and `test/consumer/linq-app.ts` compiles it.
- **`f.when(cond).then(…).form({ … })` compiles and runs**, because a
  conditional carries a rule like any other node. `buildFormModel` reads
  `x-form` off whatever schema it builds a field for, so a `when()` used
  as an object MEMBER answers a field whose rules evaluate — with
  `visible: (c) => c.root.kind.eq('a')` on such a member,
  `evaluateFormRules` reports `{ '/gate': { visible: true } }` for a
  matching document and `{ visible: false }` for the rest.
  `test/linq/forms-pen.test.js` is that twin. `Value` is `unknown` there,
  as on the object and tuple builders: the node describes a shape rather
  than a value, so annotate `Doc` and read the document through
  `c.root`.

One thing a rule on a conditional does NOT reach: a rule written on a
member INSIDE `then()` or `else()`. `buildFormModel` resolves `$ref`s and
merges `allOf`, and descends `properties`, `prefixItems` and `items` — it
does not descend `if`/`then`/`else`, so a field only that branch declares
is never built and its rule never evaluates. §6 states it as the limit it
is.

## 6. What it cannot spell

The forms pen's limits are short, because the pen adds one keyword to a
format that already exists. What it cannot carry is what `x-form` does
not define, and the list is closed at five members: `visible`,
`enabled`, `assert`, `computed`, `message`. A sixth is `JL0101` naming
the five (§4.1).

Two limits are worth naming for the reader who will otherwise go looking
for a member that is not there:

- **`preview`** — a field's preview hint is DERIVED from its `format` by
  the registry and read from there by `buildFormModel`; there is no
  authored spelling, and the pen refuses the attempt rather than writing
  a keyword nothing reads. Set the `format` (§3.6, §4.2). Anything the
  registry does not carry a hint for has no preview at all, and adding
  one is a change to `@jarenjs/forms`' format registry rather than to a
  document.
- **A rule's own failure policy** — `visible`/`enabled` fail open,
  `assert` fails closed, `computed` leaves the value absent. Those are
  the reader's, fixed in `evaluateFormRules`, and no member of `x-form`
  overrides them. A rule that must not fail open is an `assert`.
- **A rule on a member inside `then()` or `else()`** — the pen writes it
  and nothing reads it. `buildFormModel` resolves `$ref`s, merges `allOf`
  and descends `properties`, `prefixItems` and `items`; it does not
  descend `if`/`then`/`else`, so a field only a conditional branch
  declares is never built and its rule never evaluates. A rule on the
  conditional NODE itself does evaluate
  ([§5.5](#55-the-two-refusals-the-types-close-and-the-one-node-that-carries-a-rule-anyway)),
  which is where a gate over a whole branch belongs; a per-field rule
  belongs on a member the model walks.

Everything else a reader might expect to be missing is present and
belongs to the schema pen: the constructs THAT pen cannot spell are
[SCHEMA-PEN.md §6](SCHEMA-PEN.md#6-what-it-cannot-spell) and are
unchanged here, because 27 of this pen's 31 names are its names. §6.1
closes the section with the cases where the honest answer is not to reach
for this pen at all.

### 6.1 When not to reach for this pen

- **The schema carries no rules.** A form over a document with no
  `visible`, `enabled`, `assert` or `computed` is the schema pen's
  document and `buildFormModel` builds a form from it perfectly well.
  This subpath's whole addition is `x-form`; where there is none, taking
  it costs a bundle and buys nothing (§7 has the figure).
- **You already have the schema, from anywhere else.** `x-form` is an
  annotation keyword: a hand-written schema, one from `@jarenjs/emit`, or
  one this pen never touched can carry it, and `form()` is a convenience
  rather than the only way in. A schema you do not author is a schema you
  should annotate where it lives, not re-author here.
- **The rule is about the world, not the document.** A context is
  `root`, `value` and `pointer` and nothing else (§3.2, §4.3) — no clock,
  no session, no server lookup. A field that is required only for users
  in a country the server decides is a field whose rule reads a member
  the server put in the document; put it there first.
- **The rules must run somewhere that does not read `x-form`.** The
  keyword is safe to ignore, which cuts both ways: a form rendered by a
  library that has never heard of it renders every field and asserts
  nothing. `assertOnSubmit()` (§3.4) is the answer where the rules have
  to hold on a plain validator, and it is worth deciding that before the
  rules are written.
- **The validation is the schema's job.** `assert` is for what
  `minLength` cannot say — a rule across two members, or one that depends
  on a third. A rule that restates a constraint the schema already
  carries is a second place to change it.

## 7. Cost

`@jarenjs/linq/forms` builds to **<!--fact:bundle.forms-->36,659<!--/fact--> bytes** as a minified,
tree-shaken ESM bundle — the figure `scripts/check-tree-shaking.js`
measures and `npm run test:tree-shaking` reports, published rounded
beside the other nine subpath prices in
[docs/CONSUMING.md](../../../docs/CONSUMING.md). It carries the schema
pen it subclasses, and no chain module, no `@jarenjs/forms` byte and no
model pen.

Most of that figure is the schema pen: `@jarenjs/linq/schema` alone
is <!--fact:bundle.schema-->32,499<!--/fact--> bytes, so the whole `x-form` vocabulary — the mixin, the rule
capture, the submit transform and their refusal messages — is about 4 kB
on top of a pen a form-shaped consumer usually already carries. A
consumer importing both subpaths pays the schema pen once.
