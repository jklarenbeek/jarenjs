# Jaren Error Messages & i18n

**Status: normative.** This document specifies the error record shape, the
message-key space, the `MessageSpec` value type, the `errorMessage`
keyword, catalogs, and the resolution precedence chain implemented by
`@jarenjs/validate` (src/messages.js) and mirrored by `@jarenjs/forms`
(src/messages.js). Locale packs live in `@jarenjs/locales`.

The design premise: **the validator and the forms engine are not the place
where prose is born.** Every failure is identified by a stable message key
(`msgid`) plus raw structured `params`; human text is produced only at
report/render time, over the already-failed set, by a locale catalog. The
validation hot path (boolean mode, the `skipErrors` no-op handlers, the
fast-path node compilers) is untouched: switching locale never recompiles
a validator or a form model's rules.

---

## 1. The error record

Collect-mode validation (`collectErrors: true`) returns
`{ valid, errors: ValidationError[] }` where every error is:

| member | type | meaning |
|---|---|---|
| `keyword` | string | the failed keyword (`type`, `required`, `$query`, ...) |
| `instancePath` | string | RFC 6901 JSON Pointer to the failing data location |
| `schemaPath` | string | the schema location (the compiled node's URI path) |
| `params` | object | keyword-specific raw parameters (section 2) |
| `msgid` | string | the resolved message key (section 2) |
| `message` | string | human text — `''` when `messages: false` |

`toJSON()` serializes exactly these six members.

`msgid` resolution: the matched `errorMessage` spec's `$msgid` if any,
else `params.code` if present (the `$query` runtime codes), else the
keyword.

With the validator option `messages: false`, conversion skips message
rendering entirely (`message: ''`; `params` and `msgid` still set) — the
fast path for applications that render exclusively through
`localizeErrors` or their own resolver.

### The handler-contract invariant (internal)

Every internal error handler call site obeys: normal handlers
`addError(data, dataPath, ...extra)`, keyed handlers
`addKeyedError(dataKey, data, dataPath, ...extra)` — the first meta
argument is ALWAYS the instance data path, so `instancePath` is a straight
read. A charCode guard keeps a non-pointer value from ever becoming a
wrong path (it yields `''`).

### Deliberate `additionalProperties` divergence from ajv

An `additionalProperties: false` failure reports `instancePath` at the
**offending member** (`/nested/extra`), not at the parent object
(`/nested`). The object compiler passes the child path
(`${dataPath}/${dataKey}`) as the error's data path, so the pointer lands
on the disallowed property itself. This is spec-correct (the failing
location *is* that property) and friendlier for a UI that highlights the
field. ajv reports the parent object's path with the property name in
`params.additionalProperty`; Jaren carries the same `additionalProperty`
param, so a consumer diffing error sets against ajv should treat the
`instancePath` difference as intentional, not a bug.

## 2. The message-key registry

One flat namespace:

| Producer | Keys | Params carried |
|---|---|---|
| validate keywords | the keyword itself: `type`, `required`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`, `additionalProperties`, `minProperties`, `maxProperties`, `minItems`, `maxItems`, `uniqueItems`, `contains`, `items`, `allOf`, `anyOf`, `oneOf`, `not`, `format`, `if`, `then`, `else`, `false schema`, `$query` | `type`/`types`; `missingProperty`; `limit` + `comparison`; `multipleOf`; `pattern`; `additionalProperty`; `format` |
| query runtime via `$query` | the `JQ2xxx` code (`JQ2001`, `JQ2003`, ...) | `{ code, docPath }` |
| forms field checks | `form/` + the emitted keyword: `form/required`, `form/type`, `form/const`, `form/enum`, `form/minLength`, `form/maxLength`, `form/pattern`, `form/format`, `form/minimum`, `form/maximum`, `form/exclusiveMinimum`, `form/exclusiveMaximum`, `form/multipleOf`, `form/minItems`, `form/maxItems`, `form/uniqueItems`, `form/minProperties`, `form/maxProperties` | per branch: `limit`, `len`, `type`, `format`, `enumValues`, `constValue`, `pattern`, `multipleOf` |
| forms rules | `x-form/assert` (the default), else the author's `$msgid` | `{ pointer, ...spec.params }` |
| calendar language | `date/month/01`…`12` and `date/weekday/0`…`6`, each `/wide` and `/short`; `date/meridiem/am|pm`; `date/relative/<unit>/past|future` over `second`…`year`; `date/relative/{now,yesterday,today,tomorrow}`; `format/name/<format>` | names take none; a relative entry takes the ABSOLUTE `{ value }` |
| applications | any `$msgid` they invent — recommend dotted names (`checkout.total-too-low`) | error params + spec params |

The calendar family is data rather than a failure: `@jarenjs/core/dates`
is locale-free, so its `MMMM`/`EEE`/`a` tokens need a names provider, and
`@jarenjs/locales`' `compileDateLocale` reads that family into one.
`format/name/<format>` is the one entry a message *resolves through*: the
forms layer swaps a format's wire name for the catalog's display name
before rendering `form/format`, leaving `params.format` structural so the
same error re-renders in a second language. See the
[`@jarenjs/locales` README](../../locales/README.md).

Keywords without a built-in English entry (`const`, `enum`,
`dependentRequired`, `dependencies`, `unevaluatedProperties`, ...) render
the generic `validation failed for keyword '<keyword>'`; their `msgid` is
still the keyword, so a catalog (or an application) may cover them.

## 3. MessageSpec

The value type used identically by `errorMessage` (validate),
`x-form.message` (forms), and anywhere else a message is authored:

```
MessageSpec = string                      // inline template (author's language)
            | { "$msgid": string,         // catalog key to resolve at render time
                "message"?: string,       // inline template fallback on catalog miss
                "params"?: object }       // merged OVER the error's params
```

The object form requires `$msgid` and/or `message`; any other member is a
compile-time error. Spec `params` merge over the error's params **into the
error record**, so post-hoc localization sees them too.

### Template syntax

Applies to inline templates and to string-valued catalog entries:

- `{name}` substitutes the merged params member `name` — `String(v)` for
  primitives, `JSON.stringify(v)` otherwise;
- an unknown name leaves the placeholder literally (debuggability);
- `{{` escapes a literal `{`.

Compiled templates expose a frozen `parameters` array of unique placeholder
names, read from the same parse that produces the renderer.

Templates compile ONCE into a closure (`compileMessageTemplate`) — the
two-stage house rule applies to messages too. There is **no pointer/data
interpolation in v1** (`${/foo}` ajv-style is a roadmap follow-up; params
already carry the relevant values).

## 4. Catalogs

A catalog is a plain flat object:
`{ [key]: (params, error) => string | templateString }`.
`compileMessageCatalog(catalogLike)` returns a functions-only frozen copy
(template strings compiled).

English catalogs are **built in**: validate's `messagesEn`
(src/messages.js) and forms' `formsMessagesEn` (src/messages.js) — neither
package gains a dependency. Non-English packs live in `@jarenjs/locales`
(`nl`, `fr`, `es`, `pt`, `de`, `ja`, `ko`, `zhTW`, `ru`, `tr`, `ar` —
each also a subpath export, e.g. `@jarenjs/locales/fr`,
`@jarenjs/locales/zh-tw`) and must have key parity with the built-in
English (enforced by repo tests).

### Pack authoring (globalization mechanics)

Catalog entries are functions precisely so packs can use the platform:

- `Intl.PluralRules` for plural category selection ("1 teken" /
  "2 tekens" — see the `nl` pack's `minLength`),
- `Intl.NumberFormat` for `{limit}`-style numbers,
- `Intl.ListFormat` for enum lists.

Hold these as module-level singletons (allocation discipline). **Bidi:**
packs targeting RTL scripts should isolate interpolated user values with
FSI/PDI (U+2068/U+2069) — the pack author's call, not core's. A pack
depends on nothing outside the Jaren suite, and inside it on nothing but
`@jarenjs/core` — never on `@jarenjs/validate` or `@jarenjs/forms`, so
either consumer can serve any pack.

## 5. Resolution precedence

Implemented in validate's conversion (`convertInternalErrors`); forms
mirrors the tail of the chain:

1. the nearest `errorMessage` spec for the error (section 6 matching);
2. if the spec has `$msgid`: active catalog → built-in English catalog →
   the spec's inline `message` template;
3. if the spec is inline (string / `message`-only): render it;
4. no spec: active catalog[`msgid`] → built-in English[`msgid`] →
   catalog[`keyword`] → English[`keyword`] (so uncovered `JQ*` codes still
   say something) → `validation failed for keyword '<keyword>'`.

At conversion time the "active catalog" is the built-in English; other
locales enter through `localizeErrors` / `renderErrorMessage` (section 7)
or, in forms, through the `catalog` parameters.

## 6. The `errorMessage` keyword

**Overrides text, never structure.** Deliberate divergences from
ajv-errors:

- errors are never removed, merged, or aggregated;
- no synthetic `keyword: "errorMessage"` error is created;
- originals are never moved into `params.errors`;
- no `${/pointer}` data interpolation (v1);
- no `properties`/`items` map forms — the subtree prefix rule covers what
  those express (roadmap follow-up if demand appears).

An `errorMessage` spec only changes what `message` (and `msgid`) say on
the errors it matches.

### Grammar

Validated at schema compile time; malformed specs throw with the schema
path.

```jsonc
"errorMessage": MessageSpec                        // string form: whole subtree
"errorMessage": {                                  // map form
  "minLength": MessageSpec,                        // per failing keyword, this node
  "required": MessageSpec                          // all required failures here
           | { "vatId": MessageSpec, ... },        // or per missing property
  "$query": MessageSpec                            // EBV-false and any runtime code
          | { "default": MessageSpec,              // EBV-false
              "JQ2001": MessageSpec, ... },        // per runtime code
  "_": MessageSpec                                 // node-level catch-all
}
```

### Matching

The compiler registers each spec by schema location on the compilation
root — **no validator closure is emitted**; the keyword contributes zero
validation-time work and never knocks a node off the fast paths. At
report time:

- candidate nodes are the registered locations that equal the error's
  `schemaPath` or are a segment-aware prefix of it (`/foo` never matches
  `/foobar`); the longest prefix is tried first;
- **at the error's own node**: keyword-map entry (with `required`
  per-property matching on `params.missingProperty`, `$query` per-code on
  `params.code`, `default` on its absence) > `_` > string form;
- **at an ancestor**: only the string form applies (it covers the
  subtree — this is what lets one string on a `oneOf` replace the branch
  noise);
- no match at the nearest node falls through to farther ancestors.

## 7. Post-hoc localization

```js
import { JarenValidator, compileMessageCatalog, localizeErrors } from '@jarenjs/validate';
import { nl } from '@jarenjs/locales';

const catalog = compileMessageCatalog(nl);
const result = validate(data);          // English messages
localizeErrors(result.errors, catalog); // Dutch messages, same array
```

`localizeErrors(errors, catalog)` re-renders `message` on each error from
`msgid` + `params` through the given compiled catalog with built-in
English fallback. Contract details:

- **inline schema-authored text without `$msgid` is single-language by
  definition and is NOT re-rendered** — that is why `$msgid` exists;
- an error whose `msgid` resolves in no catalog keeps its current message
  (e.g. a custom `$msgid`'s inline fallback text);
- `renderErrorMessage(error, catalog?)` is the single-error form of the
  same chain (section 5 step 4).

Forms renders eagerly (failure-only, cheap, keeps UI consumers simple)
but through the same catalog contract: `validateField` /
`validateAllFields` / `evaluateFormRules` accept an optional compiled
catalog, default English, and every `FieldError` carries
`{ keyword, params, msgid, message }` so consumers can re-render.

## 8. Why not MessageFormat 2

`Intl.MessageFormat` (MessageFormat 2) is TC39 Stage 2 and stalled,
shipping in no runtime; adopting it would mean a runtime dependency or a
homegrown MF2 engine for pluralization the platform already provides
through `Intl.PluralRules`. Catalogs-as-functions cover the same ground
with no runtime dependency beyond the platform, and with full generality.

**Revisit trigger:** Intl.MessageFormat reaching TC39 Stage 3 or shipping
in a major runtime. At that point, MF2 syntax could become a supported
catalog *entry format* (compiled by `compileMessageCatalog`) without
changing the catalog contract.
