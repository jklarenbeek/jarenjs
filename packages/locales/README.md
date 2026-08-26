# @jarenjs/locales

Locale packs (message catalogs) for the error messages of
[`@jarenjs/validate`](../validate/README.md),
[`@jarenjs/forms`](../forms/README.md) and
[`@jarenjs/contract`](../contract/README.md), and the calendar language
`@jarenjs/core/dates` refuses to invent.

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

## Calendar language

`@jarenjs/core/dates` is locale-free by design: its `MMMM`, `EEE` and `a`
pattern tokens raise rather than fall back to English. Every pack carries
the data those tokens need, on the same flat msgid machinery as the error
messages, and `compileDateLocale` turns a pack into the frozen record a
formatter and a UI read:

```js
import { compileDateFormat, parseRFC3339Parts } from '@jarenjs/core/dates';
import { compileDateLocale, nl } from '@jarenjs/locales';

const dates = compileDateLocale(nl);
const long = compileDateFormat('EEEE d MMMM yyyy', dates.names);
long(parseRFC3339Parts('2026-07-05'));           // 'zondag 5 juli 2026'
dates.relative(-3, 'day');                        // '3 dagen geleden'
dates.relative(-1, 'day', { numeric: 'auto' });   // 'gisteren'
dates.formatName('date-time');                    // 'datum en tijd'
```

The compiled record has three members: `names` (the five arrays
`compileDateFormat` takes), `relative(amount, unit, options?)` and
`formatName(format)`. `relative` takes an **explicit signed amount** -
negative is past, positive is future - and reads no clock; deciding how
long ago something was is the caller's job, and phrasing it is this
package's. `numeric: 'auto'` reaches for `yesterday`/`today`/`tomorrow`
and `now` only where they are exact (a whole day away, a zero-second
offset); a fractional amount, an unsupported unit and an unknown mode are
each refused. Compilation reads the catalog once, so a formatter built
from `names` costs no message lookup per date.

The msgids are closed and mechanical, so a pack cannot half-cover them:

| Family | Keys |
|---|---|
| months | `date/month/01`…`12` × `/wide`, `/short` |
| weekdays | `date/weekday/0`…`6` × `/wide`, `/short` (Sunday = 0) |
| day period | `date/meridiem/am`, `date/meridiem/pm` |
| relative | `date/relative/{second,minute,hour,day,week,month,year}/{past,future}` |
| named days | `date/relative/{now,yesterday,today,tomorrow}` |
| format names | `format/name/{date,time,date-time,iso-date,iso-time,iso-date-time}` |

`dateMessagesEn` is the English set and the canonical key list. Name
entries take no parameters; a relative entry receives the **absolute**
amount as `{ value }` and owns its language's plural and case grammar -
the direction is already in the key. A pack authors the forty name keys
through `dateNameEntries({ months, monthsShort, weekdays, weekdaysShort,
meridiem })`, which checks the lengths as it expands them.

Two consequences worth knowing before writing a pack. The month array
feeds a *pattern*, so a language that inflects months by position ships
the **format** forms rather than the standalone ones (Russian's
`5 июля 2026`, not `июль`). And a language whose abbreviations equal its
full names ships them equal (Arabic, Japanese, Chinese) rather than
inventing shorter ones.

### Format display names, and why they exist

A format's name is its wire name - `date-time`, `iso-time` - which is
English by construction. Interpolated into a translated sentence it reads
as gibberish: a Dutch user used to be told *"Moet een geldige date-time
zijn"*. `@jarenjs/forms` now resolves `format/name/<format>` through the
catalog it is rendering with, so the same failure reads *"Moet een
geldige datum en tijd zijn"* while the error's own
`params.format` stays `'date-time'` - structural, so re-rendering it in a
second language answers in that language rather than repeating the first
one's noun. A format the catalog cannot name keeps its own, which is the
readable answer for names that are already words (`email`, `hostname`)
and the only possible one for a format this repository has never heard of.

### The optional `Intl` provider

`createIntlDateLocale(locale, options?)` builds the same shape out of the
platform's ICU data, for a host that wants a hundred locales more than it
wants byte stability:

```js
import { createIntlDateLocale } from '@jarenjs/locales/intl-dates';

const dates = createIntlDateLocale('hu-HU');   // same three members
```

It is a separate module and an explicit call because it cannot be the
default. ICU output moves between Node versions and between a browser and
a server, and this repository's own site is server-rendered under
byte-comparison tests. Nothing on the default path constructs an `Intl`
object, and a bundler drops the provider from a bundle that never calls
it. ICU has no date-format display names, so that member carries the
repository's English ones unless `options.formatNames` overrides them.

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
   `form/*` key of forms' `formsMessagesEn`, every `contract/*` wire-error
   key of contract's `contractMessagesEn`, every `date/*` and
   `format/name/*` key of this package's own `dateMessagesEn`, plus
   `x-form/assert` and the `JQ2xxx` query runtime codes. The repo enforces
   this with tests (`test/locales/`); missing keys silently fall back to
   English.
2. **Never depend on a consumer.** A pack must stay importable without
   dragging in `@jarenjs/validate` or `@jarenjs/forms`, so that either one
   can serve any pack. The platform and `@jarenjs/core` are the only things
   a pack may reach for - core is where the shared value renderer lives, so
   a pack cannot drift from the catalog contract by re-implementing it.
3. **Use `Intl`, as module-level singletons.** `Intl.PluralRules` for
   plural categories (see `nl.js`: "1 teken" / "2 tekens"),
   `Intl.NumberFormat` for `{limit}`-style numbers, `Intl.ListFormat` for
   enum lists. Construct them once at module level - catalog entries run
   on the failure path, which is cheap, but allocation discipline is the
   house rule.
4. **Bidi.** Packs targeting RTL scripts should isolate interpolated user
   values with FSI/PDI (U+2068/U+2069) so a Latin value cannot reorder
   the surrounding text. That call belongs to the pack author, not core.
   The harder rule, paid for by `ar.js`: **an ASCII comparison operator
   placed between RTL text and a number displays flipped** - the
   operator is bidi-neutral, so `>=` before a Latin-digit limit reorders
   and reads as `=<`. Never interpolate `{comparison}` as a symbol.
   Arabic therefore renders the four operators validate emits for
   `minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum` as whole
   **phrases** ("يجب ألا تقل القيمة عن 2" - "the value must not be less
   than 2"), and falls back for an operator it does not know to the
   symbol wrapped in a directional isolate (U+2066 … U+2069) so it at
   least still reads left-to-right inside the RTL sentence. Do the same
   before shipping a Hebrew, Farsi or Urdu pack, and always eyeball the
   rendered strings - a flipped operator is silently *valid* text.
5. **Voice.** Validate keys speak about the document ("must have required
   property 'x'"); `form/*` keys speak to the person filling the field
   ("This field is required"). Keep both voices.

## Available packs

| Export | Subpath | Locale |
|--------|---------|--------|
| `ar` | `./ar` | Arabic (العربية) - RTL |
| `de` | `./de` | German (Deutsch) |
| `es` | `./es` | Spanish (Español) |
| `fr` | `./fr` | French (Français) |
| `ja` | `./ja` | Japanese (日本語) |
| `ko` | `./ko` | Korean (한국어) |
| `nl` | `./nl` | Dutch (Nederlands) |
| `pt` | `./pt` | Portuguese (Português) |
| `ru` | `./ru` | Russian (Русский) |
| `tr` | `./tr` | Turkish (Türkçe) |
| `zhTW` | `./zh-tw` | Traditional Chinese, Taiwan (繁體中文) |

The named export is the locale tag camel-cased (`zhTW`), the subpath keeps
the tag itself (`@jarenjs/locales/zh-tw`).
