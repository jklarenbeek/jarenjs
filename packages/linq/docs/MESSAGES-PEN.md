# The messages pen

> `./messages` — JSON message catalogs and message references. **Read it when**
> you want checked translation keys, placeholders and explicit completeness.

## 1. What it writes

The pen writes a flat JSON map of msgid to template string, or the existing
MessageSpec string/object used by `errorMessage` and `x-form.message`. The
`validate`, `forms` and `contract` scopes derive from their English catalogs;
`all` combines those disjoint key spaces. The locale name is diagnostic metadata
and never appears in the emitted catalog.

A catalog draft is immutable. `complete()` emits only when every required id is
present; `partial()` explicitly emits the entries supplied so far. Both exits
check ids and placeholders. `JSON.stringify(draft)` requires completeness too.
An emitted document is an independent, deeply frozen JSON snapshot.

## 2. The mapping table

| Method | Emits | Type | Status |
|---|---|---|---|
| `catalog(source?, locale?)` | starts an empty draft; defaults to all/en | source key space | native |
| `.entry(id, template)` | adds or replaces one string entry | adds present id | native |
| `.entries(map)` | adds or replaces several entries | adds literal keys | native |
| `.complete()` | complete frozen catalog | every source id | native |
| `.partial()` | frozen subset | explicitly present ids | native |
| `.toJSON()` | complete frozen catalog | requires completeness | native |
| `from(document, options?)` | raw draft; options choose source/locale | literal keys where known | native |
| `inline(template)` | inline MessageSpec string | string | native |
| `message(id, options?)` | `{ $msgid, params?, message? }` | known id/parameter names | native |

Catalog entries are strings. A structured MessageSpec is a **reference to** a
catalog entry, used in a schema or form; it is not itself a catalog entry.
Template placeholders are checked through the shared message compiler, including
escaped and repeated braces. Translations must preserve the English parameter
set. A MessageSpec fallback may use a subset; params may override known members.

## 3. Worked examples

```js
import { catalog } from '@jarenjs/linq/messages';
export const messages = catalog('contract', 'nl')
  .entry('contract/body-too-large', 'Operatie {op} overschrijdt {limit} bytes')
  .partial();
```
```json
{"contract/body-too-large":"Operatie {op} overschrijdt {limit} bytes"}
```

```js
import { message } from '@jarenjs/linq/messages';
export const errorMessage = message('minimum', {
  params: { limit: 10 }, message: 'At least {limit}',
});
```
```json
{"$msgid":"minimum","params":{"limit":10},"message":"At least {limit}"}
```

Pass an emitted catalog to `compileMessageCatalog` from `@jarenjs/core/message`.
Use the emitted MessageSpec as a schema's `errorMessage` or form message.

## 4. Refusals

| Code | Condition |
|---|---|
| `JL0101` | unknown source/id/parameter, invalid locale/map/template, a missing or extra placeholder, a non-JSON input, or an incomplete catalog at complete()/serialization |

Placeholder diagnostics name the locale, msgid and missing/extra names. The raw
factory preserves input but does not bypass checks at either publication exit.

## 5. The types

`CatalogBuilder<Source, Present>` carries completeness only as phantoms.
`CATALOGS` contains the generated, frozen parameter vocabulary grouped by owner.
`CatalogSource`, `CatalogIds`, `Msgid`, `MessageParameters`, `CatalogDocument`
and `MessageSpec` are types. `complete()` is unavailable on a known incomplete
draft. Dynamic string-indexed maps, optional entries and a single union-valued
id do not claim compile-time completeness. A parameterless id accepts no named
parameters.
Parameter value types stay JSON; no numeric or semantic inference is invented.

## 6. What it cannot spell

Existing locale packs also contain render functions for pluralization, localized
numbers and lists. Those functions are not JSON and are not serialized by this
pen. Every locale's string entries round-trip exactly; its function entries keep
running through the existing renderer. Contract catalogs consist entirely of
strings, so their full catalogs round-trip for every shipped locale.

Ids derive from the actual English objects. String placeholders come from the
shared compiler; function parameter names are read statically from their
JavaScript syntax using the existing development parser. An unfamiliar or opaque
function shape fails generation. This records available parameter names without
claiming to reproduce branching or formatting as a string template. An author
may deliberately supply a string replacement using that parameter vocabulary.
Run `node scripts/generate-message-pen.js` after changing English catalogs; the
gate compares generated files and all locale parameter sets with their sources.

## 7. Cost

The isolated messages pen costs **<!--fact:bundle.messages-->18,363<!--/fact--> bytes**.
It carries the shared template compiler and generated vocabulary, with no locale,
validator, forms or contract engine and no query chain.
