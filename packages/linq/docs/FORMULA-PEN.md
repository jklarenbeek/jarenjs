# Formula document authoring

> `./formula` — author versioned saved JSON Query profiles without executing them.

## 1. What it writes

`defineFormula(id, expression, options?)` from `@jarenjs/linq/formula` emits a frozen
`$formula: "1"` JSON document. The default revision is `"1"`. Options declare
revision, immutable bindings, input/result schema references, helper versions and
result mode. The expression is an existing JSON Query document. The pen validates
the envelope and JSON boundary without executing a formula or importing a component.

```js
import { defineFormula } from '@jarenjs/linq/formula';
const amount = defineFormula('amount', { $mul: ['$.price', '$.quantity'] }, {
  revision: '2',
  inputSchema: { id: 'row', version: '1' },
});
```

Compile the document using `@jarenjs/json/formula` and a host schema registry/type
compiler. [The formula format](../../json/docs/FORMULA-FORMAT.md) owns execution,
missing/null arithmetic, explicit migration and reviewed-plan semantics.

## 2. The mapping table

| Call / option | Emitted member |
|---|---|
| `defineFormula(id, expression)` | `$formula`, `id`, `expression`, default `revision` |
| `revision`, `bindings`, schema/helper references, result mode | Same named profile members |

## 3. Refusals

Non-JSON authoring input is `JL0101`; invalid envelopes and unresolved runtime
capabilities use the owning JSON formula registry. The pen never executes a query.

## 4. Cost

The isolated formula pen costs **<!--fact:bundle.formula-->14,850<!--/fact--> bytes**.
Its bundle contains envelope validation and JSON helpers, with no Query evaluator
or component. The tree-shaking gate enforces the separate authoring boundary.
