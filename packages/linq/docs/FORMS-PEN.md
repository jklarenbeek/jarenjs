# The Jaren forms pen (normative)

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119. The rules every pen keeps, the
shared refusal table and the index of the other pens are the binder,
[LINQ-FORMAT.md](LINQ-FORMAT.md).

## 1. What it writes

```js
import * as f from '@jarenjs/linq/forms';
import { assertOnSubmit } from '@jarenjs/linq/forms';
```

is the schema pen's every name from SUBCLASSES that carry the `x-form`
vocabulary — `form({ visible, enabled, assert, computed, message })` on
every builder — plus `assertOnSubmit()`, the one call that answers the
same rules' layer-3 `$query` twin
([the forms README](../../forms/README.md)).

A rule is an ANNOTATION. It never changes what the schema validates:
`required`, `additionalProperties` and every other keyword stay exactly
what the schema pen wrote, `Infer<>`/`Input<>` read exactly as they do
there, and the subclasses exist only so `form()` survives every chained
method. What `buildFormModel`, `compileFormRules` and
`evaluateFormRules` then read is the annotation.

The three predicates and `computed` are CALLBACKS captured over the
rule context, never paths typed as strings. The context spells the three
names the evaluator binds, and no others: `c.root` is the whole form
document (`$` — cross-field is the point), `c.value` the field's current
value (the `$value` external; an absent field binds `null`) and
`c.pointer` its data pointer (`$pointer`). Any other name is `JL0104`
here, where the fix can be named, rather than a compile error out of
`compileFormRules` naming the same two externals.

The pen imports nothing of `@jarenjs/forms`: the reader is the only
judge of what a rule means, and `assertOnSubmit()` is pinned deep-equal
to `formRulesToQueryAssertions` over the whole corpus.

## 2. The mapping table

| Method | Emits | Type reading | Status |
|---|---|---|---|
| every schema-pen name (`f.string()`, `f.object({…})`, …) | exactly what `@jarenjs/linq/schema` emits | `Infer<>`/`Input<>` unchanged — a rule is an annotation | native |
| `.form({ … })` | one `x-form` annotation, its members in the README's own order (`visible`, `enabled`, `assert`, `computed`, `message`) whatever order the author wrote; a second call merges into the same one | `this` — the builder's phantoms are untouched | native; a member `x-form` does not define, or a `message` that is neither a string nor a MessageSpec, `JL0101`; `preview` `JL0102`; a name the context does not bind `JL0104` |
| `visible` / `enabled` | an EBV query; a broken one fails OPEN — a broken rule must never hide data or lock a control | `Rule<Doc, Value>` | native |
| `assert` | an EBV query; a broken one fails CLOSED | `Rule<Doc, Value>` | native |
| `computed` | a query whose plain-JSON result is the field's derived value | `Rule<Doc, Value>` | native |
| `message` | a plain string (an inline template), or a `$msgid` MessageSpec, verbatim | `MessageSpec` | native |
| a rule on an array item's builder | the annotation at the item template, which `buildFormModel` reads at `/lines/-/amount` and evaluates per element | the same | native |
| `assertOnSubmit(root)` | the root with one `allOf` branch `{ $query, errorMessage }` per `x-form.assert`; a document with no assert answers itself | `JsonSchema` | native; a value that is not a builder or an object schema `JL0101` |
| `f.string().meta({ 'x-form': … })` | — | — | `JL0104`: the pen owns the keyword; spell it through `form()` |

**`preview` is not an authored member.** A field's preview hint is
DERIVED from its `format` by the registry —
`getFormatInfo(format).preview` is `{ kind: 'map' }` for `geojson`, and
`buildFormModel` reads it from there, never from `x-form` — so writing
one would be a keyword nothing reads. `form({ preview })` is `JL0102`
naming the derivation; spell the format instead, and a host that
understands the hint draws it beside the control.

**What the submit twin keeps**, each a place a naive copy went wrong
(the README's own three): an absent field binds `null` through
`$default`, so `$ne`/`$eq` cannot mean opposite things on the two
sides; an item-template assert quantifies over the ELEMENTS rather than
the selected leaves, so an element missing the member is evaluated with
`null` exactly as the keystroke path evaluates it; and an assert on a
field that also declares `visible` is guarded by it, holding vacuously
while the field is hidden — which is what the keystroke path already
does, since `buildFormViewModel` drops hidden nodes. The branches land
on the ROOT, where `$` is the instance root the rule context expects,
and each carries the rule's message with `params` merged over
`{ pointer }` so submit renders the same text in every locale.

What the pen does **not** judge is the reader's: a root-level `visible`
(a `TypeError` from `compileFormRules` — hiding the whole form would
null the render tree and its dirty summary), the rules' own operators,
and the schema's semantics.

## 3. Worked examples

Every `js` fence exports exactly one document, and the `json` fence that
follows is what the pen emits — executed by
`test/linq/pen-docs.test.js`. The forms README's own layer-2 document
is rebuilt the same way and held BYTE-equal to its fence by
`test/linq/forms-pen.test.js`.

An invoice: a cross-field visibility, an assert with a catalog message,
an item-template rule and a computed total:

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

The same rule, on submit — one call, and the branch the validator
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

The message names the fix, and `docPath` is the JSON pointer of the node
being assembled where the refusal has one.

## 5. The types

```ts
import { buildFormModel, compileFormRules, evaluateFormRules } from '@jarenjs/forms';
import { JarenValidator } from '@jarenjs/validate';
import * as f from '@jarenjs/linq/forms';
import { assertOnSubmit } from '@jarenjs/linq/forms';
import type { RuleContext } from '@jarenjs/linq/forms';
import type { Infer } from '@jarenjs/linq/schema';

type Invoice = Infer<typeof invoice>;     // the schema pen's reading, unchanged

const model = buildFormModel(invoice.schema);
evaluateFormRules(compileFormRules(model), data);          // per keystroke
new JarenValidator().compile(assertOnSubmit(invoice));     // on submit
```

The one limit is the same one the flow pen's `context` meets: a member
builder is written before the object that will hold it exists, so
`c.root` is the honest top until the rule is annotated —
`form<Invoice>({ visible: (c) => … })`, or
`(c: RuleContext<Invoice, string>) => …` on the callback itself.
`c.value` is typed by the builder the rule sits on, and `c.pointer` is
always a string.

## 6. What it cannot spell

Every construct the forms pen refuses as unspellable is `JL0102`. §2's
Status column names the ones that belong to a method of this pen, each
beside the spelling that works; the binder's shared table
([LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3) carries the condition in full.

## 7. Cost

`@jarenjs/linq/forms` builds to **36,448 bytes** as a minified,
tree-shaken ESM bundle — the figure `scripts/check-tree-shaking.js`
measures and `npm run test:tree-shaking` reports, published rounded
beside the other nine subpath prices in
[docs/CONSUMING.md](../../../docs/CONSUMING.md). It carries the schema pen it subclasses, and no chain module, no `@jarenjs/forms` byte and no model pen.
