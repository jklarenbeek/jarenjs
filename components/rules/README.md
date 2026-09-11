# @jarenjs/rules

Reusable schema-guided JSON rule authoring and reviewed change selection. The
engine imports core only; evaluator and authoritative command services are
injected. The component layer uses view/forms and the existing app widget lifecycle.

```js
import { mountRuleEditor } from '@jarenjs/rules/component';
import '@jarenjs/rules/styles/rules.css';
const editor = mountRuleEditor(host, {
  text: JSON.stringify(savedRule, null, 2),
  schema: rowSchema,
  preview: async (text) => previewSavedRule(JSON.parse(text)),
  command: async (request) => validatedCommand.execute(request),
});
// editor.dispose() on unmount
```

The host supplies saved rule/dataset revisions and policy. Preview is read-only;
`command` must revalidate current authorization, rows, rule identity and proposed
values inside its transaction. Omitting it enables report-only authoring.
[The formula/plan contract](../../packages/json/docs/FORMULA-FORMAT.md) specifies
outcomes, conflicts, migration, refused shapes and qualification limits.

`createRuleEditor` owns draft text/caret, stable selection IDs and generation
fences. Call `edit`, `preview`, `select`, `commit`, `state` and `dispose`.
`mountRuleEditor` presents schema fields, a controlled JSON textarea, bounded
review pages and commit status. `createRuleEditorWidget` uses existing mount /
update / unmount semantics. The default page holds 20 changes; hosts can select
1–100. `maxChanges` defaults to 10000 and refuses larger preview documents.
Selection survives unmounted pages, but a changed draft or plan clears it.
Repeated commit admission shares one pending command; durable replay belongs to
the host. Disposal fences preview publication; an accepted domain command stays
host-owned. CSS uses the host theme tokens with standalone fallbacks.

Automated desktop/mobile browser checks cover typing, caret preservation,
selection, preview failure and durable commits. Physical-device and manual
accessibility qualification remain pending.

<!--fact:exports.rules-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/rules` | JavaScript | declared |
| `@jarenjs/rules/component` | JavaScript | declared |
| `@jarenjs/rules/package.json` | metadata | — |
| `@jarenjs/rules/styles/rules.css` | asset | — |
<!--/fact-->
