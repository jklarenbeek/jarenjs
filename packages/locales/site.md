---
package: "@jarenjs/locales"
card:
  title: Locale packs
  blurb: >-
    Message catalogs for the validator's and the form model's errors, one
    pack per language, over the stable msgids and raw params every error
    carries — so switching language re-renders the text and re-validates
    nothing.
---

Jaren never bakes prose into a hot path. A failing check carries a stable
message key (`msgid`) and its raw structured `params`; human text is produced
later, at report or render time, from a **catalog** — a flat object of
templates and closures. This package is the home of the non-English catalogs
for the validator, the form model and the contract layer.

```js
import { JarenValidator, compileMessageCatalog, localizeErrors } from '@jarenjs/validate';
import { nl } from '@jarenjs/locales';

const catalog = compileMessageCatalog(nl);
const result = new JarenValidator({ collectErrors: true })
  .compile({ type: 'string', minLength: 2 })('x');
localizeErrors(result.errors, catalog);
// 'mag niet minder dan 2 tekens bevatten'
```

Arabic, German, Spanish, French, Japanese, Korean, Dutch, Portuguese, Russian,
Turkish and Traditional Chinese each ship as their own export and their own
subpath (`@jarenjs/locales/nl`), so a bundle carries only the languages it
imports. Because localization happens after the check, switching language
re-renders the text and re-validates nothing — the same result object answers
in a second language without the validator running again.

Arabic is a right-to-left pack, and the site's own language switcher is where
that is proven: the messages are isolated for bidirectional text so an
interpolated Latin-script value cannot reorder the Arabic sentence around it.
