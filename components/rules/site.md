---
package: "@jarenjs/rules"
card:
  title: Reviewed rules
  blurb: >-
    Schema-guided saved formulas, immutable previews and stable change selection.
  perf: >-
    bounded review pages with injected evaluation
---

Author JSON rule documents, inspect proposed values and select changes across
preview pages. The editor preserves draft text and caret during asynchronous
evaluation. Schema fields, evaluator services and commands are injected by the
host. Preview conveys no write authority: the command rechecks current saved
rules, rows, permissions and values in the existing receipt transaction.

[Try the reviewed-rule example](#/collection?mode=rules).

```js
import { createRuleEditor } from '@jarenjs/rules';
const editor = createRuleEditor({ text: '{}', preview: previewRule });
await editor.preview();
editor.dispose();
```
