---
package: "@jarenjs/forms"
card:
  title: Forms
  blurb: >-
    JSON Schema to a framework-agnostic field tree with three validation
    layers on one stack — per keystroke, cross-field, and authoritative on
    submit.
  perf: >-
    this site renders forms with it
engines:
  - key: forms
---

JSON Schema to a framework-agnostic field tree, validated in three layers on
one stack: per-field on every keystroke, cross-field `x-form` rules
(visibility, enablement, computed values, assertions — written as query
documents), and the authoritative compiled schema on submit.

```js
import { buildFormModel, compileFormRules, buildFormViewModel } from '@jarenjs/forms';
const model = buildFormModel(schema);
const rules = compileFormRules(model);
const tree = buildFormViewModel(model, data, { rules, validateFields: true });
```

> **This site eats it** — Play’s JSON Schema engine can swap its data pane for
> a generated form: that form is exactly this view model, rendered through the
> standard forms stylesheet of `@jarenjs/app` — no hand-written form code
> anywhere.
