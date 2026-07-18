# @jarenjs/locales

Locale packs (message catalogs) for the error messages of
[`@jarenjs/validate`](../validate/README.md) and
[`@jarenjs/forms`](../forms/README.md).

Jaren validators and form checks never bake prose into the hot path: every
failure carries a stable message key (`msgid`) plus raw structured
`params`, and human text is produced at report/render time through a
**catalog** - a plain flat object of closures. This package is the home of
the non-English catalogs. The normative contract (message-key registry,
template syntax, resolution precedence) lives in
[`packages/validate/docs/ERROR-MESSAGES.md`](../validate/docs/ERROR-MESSAGES.md).

## Usage

Post-hoc localization of a collect-mode validation result:

```js
import { JarenValidator, compileMessageCatalog, localizeErrors } from '@jarenjs/validate';
import { nl } from '@jarenjs/locales';

const catalog = compileMessageCatalog(nl);
const validator = new JarenValidator({ collectErrors: true });
const validate = validator.compile({ type: 'string', minLength: 2 });

const result = validate('x');
localizeErrors(result.errors, catalog);
// result.errors[0].message === 'mag niet minder dan 2 tekens bevatten'
```

Per-keystroke form feedback in Dutch:

```js
import { buildFormModel, validateAllFields, compileMessageCatalog } from '@jarenjs/forms';
import { nl } from '@jarenjs/locales';

const catalog = compileMessageCatalog(nl);
const errors = validateAllFields(model, data, catalog);
// errors['/name'][0].message === 'Dit veld is verplicht'
```

Subpath import when you only want one pack (tree-shaking friendly either
way - the package is `sideEffects: false`):

```js
import { nl } from '@jarenjs/locales/nl';
```

## Authoring a pack

A catalog is a plain flat object; each entry is either a **template
string** or a **closure**:

```js
export const xx = {
  // template string: {name} substitutes the params member 'name';
  // {{ escapes a literal brace; unknown names stay literal
  pattern: 'must match pattern "{pattern}"',

  // closure: full control, receives (params, error)
  minLength: (p) => `at least ${p.limit} character${p.limit === 1 ? '' : 's'}`,
};
```

Rules of the road:

1. **Key parity.** Cover every key of validate's `messagesEn`, every
   `form/*` key of forms' `formsMessagesEn`, plus `x-form/assert` and the
   `JQ2xxx` query runtime codes. The repo enforces this with tests
   (`test/locales/`); missing keys silently fall back to English.
2. **Zero dependencies.** Packs must stay importable without dragging in
   the validator - use only the platform.
3. **Use `Intl`, as module-level singletons.** `Intl.PluralRules` for
   plural categories (see `nl.js`: "1 teken" / "2 tekens"),
   `Intl.NumberFormat` for `{limit}`-style numbers, `Intl.ListFormat` for
   enum lists. Construct them once at module level - catalog entries run
   on the failure path, which is cheap, but allocation discipline is the
   house rule.
4. **Bidi.** Packs targeting RTL scripts should isolate interpolated user
   values with FSI/PDI (U+2068/U+2069) so a Latin value cannot reorder
   the surrounding text. That call belongs to the pack author, not core.
5. **Voice.** Validate keys speak about the document ("must have required
   property 'x'"); `form/*` keys speak to the person filling the field
   ("This field is required"). Keep both voices.

## Available packs

| Export | Locale |
|--------|--------|
| `nl` | Dutch (Nederlands) |
