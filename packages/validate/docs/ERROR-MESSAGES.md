# Jaren Error Messages & i18n

**Status: normative.** This document specifies the error record shape, the
message-key space, the `MessageSpec` value type, the `errorMessage`
keyword, catalogs, and the resolution precedence chain implemented by
`@jarenjs/validate` (src/messages.js) and mirrored by `@jarenjs/forms`
(src/messages.js), and the coded refusals the validator throws where it
cannot answer (§9). Locale packs live in `@jarenjs/locales`.

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
| validate keywords | the keyword itself: `type`, `required`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`, `additionalProperties`, `minProperties`, `maxProperties`, `minItems`, `maxItems`, `uniqueItems`, `contains`, `minContains`, `maxContains`, `items`, `allOf`, `anyOf`, `oneOf`, `not`, `format`, `contentEncoding`, `contentMediaType`, `nullable`, `if`, `then`, `else`, `false schema`, `const`, `enum`, `dependentRequired`, `dependencies`, `unevaluatedProperties`, `unevaluatedItems`, `$query` | `type`/`types`; `missingProperty`; `limit` (+ `comparison` for the numeric bounds); `multipleOf`; `pattern`; `additionalProperty`; `format`; `encoding` (`contentEncoding`, and `contentMediaType` beside a declared `contentEncoding`, whose check decodes the string first); `mediaType`; `allowedValue` (`const`: the value it expected); `allowedValues` (`enum`: the list it allows); `property` + `missingProperty` (`dependentRequired` and the array form of `dependencies`: the present property and the first dependency the object lacks); `unevaluatedProperty` (the member name); `unevaluatedItem` (the index) |
| `basic` output | `subschema`: the error of a branch unit, "A subschema had errors." (rendered in English: an output format takes no catalog, so the packs' entry is not read yet) | none |
| query runtime via `$query` | the `JQ2xxx` code of a failure that judges the instance (`JQ2001` to `JQ2005`, `JQ2008`; every other runtime refusal is thrown) | `{ code, docPath }` |
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

A bound read from the instance through `$data` or `data` (`{ minimum: {
$data: '1/m' } }`) carries the value it resolved in its params, as a static
bound carries the schema's: `limit`, `multipleOf`, `pattern`, `format`,
`allowedValue` and `allowedValues` name what the instance was held to, never
the pointer that found it.

A message key without a built-in English entry renders the generic
`validation failed for keyword '<keyword>'` with empty `params`; its
`msgid` is still the keyword, so a catalog (or an application) may cover
it. *Upgrade: `const`, `enum`, `dependentRequired`, `dependencies`,
`unevaluatedProperties` and `unevaluatedItems` used to render the generic
message, and `const`, `enum`, `dependentRequired` and `dependencies`
carried empty `params`. `minContains`, `maxContains`, `contentEncoding`,
`contentMediaType` and `nullable` rendered the generic message with empty
`params` too; they now carry `limit`, `encoding` and `mediaType` and render
their own entry. A data-referenced bound used to carry its pointer (`limit:
'1/m'`, "must be >= 1/m"); it now carries the resolved value ("must be >=
5"), also inside an `errorMessage` template that reads `{limit}`.*

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
interpolation in v1** (`${/foo}` ajv-style is not planned; params
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
  those express (not planned).

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

## 9. Coded refusals

A schema the validator cannot decide is not answered `true` or `false`: it
is refused with a thrown error carrying a stable `code` (the suite's coded
error contract, `@jarenjs/core/errors`). A refusal is never folded into a
failed validation, because a `false` under `not` would read as success.
`VALIDATE_CODES` is the runtime table of the codes below.

| Code | Class | Meaning |
|---|---|---|
| `JK0001` | `SchemaCompileError` | A loop of references and in-place applicators never reads the instance: refused by `compile()` |
| `JK0002` | `SchemaCompileError` | The `maxReferenceDepth` option is not a positive safe integer: refused when a schema compiles |
| `JK0003` | `SchemaCompileError` | The `outputFormat` option is not a format of `@jarenjs/validate/output`: refused when a schema compiles |
| `JK0004` | `SchemaCompileError` | `compileAsync`'s `loadSchema` threw or rejected for a document a schema references |
| `JK0005` | `SchemaCompileError` | `compileAsync`'s `loadSchema` returned something that is not a schema (an object or a boolean) |
| `JK0006` | `SchemaCompileError` | One `compileAsync` call needs more document loads than its `maxLoads` option (default 100) |
| `JK0007` | `SchemaCompileError` | `compileAsync` was given something that is not a `JarenValidator`, a `loadSchema` that is not a function, or a `maxLoads` that is not a positive safe integer |
| `JK2001` | `SchemaRuntimeError` | Validation nests schema references deeper than `maxReferenceDepth` (default 256): refused where the bound is crossed |

**`JK0001` — a loop that never reads the instance.** A `$ref` that leads
back to itself through `$ref`s alone is refused wherever it sits in the
document. A root schema is also refused when following, from the root, the
`$ref` (evaluated before its siblings) or the one in-place applicator a
schema evaluates first on every instance — its only `not`, its `if` beside a
`then` or an `else`, the target of its only `$dynamicRef` or `$recursiveRef`,
or the first member its only `allOf`, `anyOf` or `oneOf` reaches on every
instance, with nothing beside it that can fail an instance — comes back to a
schema already on the way: such a validator decides nothing on any instance.

- *Can fail an instance* is read the way the compiler reads it: the
  validation and applicator keywords do, except `format` while it compiles to
  no validator (formats annotate under the dialect and options, or no format
  compiler is registered under the name), `contentEncoding` and
  `contentMediaType` while content is not validated, and `items`,
  `additionalItems`, `additionalProperties`, `propertyNames`,
  `unevaluatedItems` or `unevaluatedProperties` holding `true` or `{}`.
  Annotations, identifiers, `$defs`, unknown and `x-` keywords never do.
- *The first member reached on every instance*: `allOf` passes over leading
  members that pass everything (`true`, `{}`, a member of annotations), since
  it stops only at a failing one; `anyOf` passes over leading `false` members,
  since it stops at a passing one; `oneOf` passes over leading `false` members
  and at most one member that passes everything, since it stops at a second
  match.
- A `$dynamicRef` or `$recursiveRef` is followed only while the walk stays in
  the root's own resource, where its dynamic target is its static one.

*Upgrade: such a root used to compile and refused every instance `JK2001`.*
The message names every schema location on the loop:

```text
JK0001: $ref cycle: http://loop.test/a# -> http://loop.test/a#/allOf/0 -> http://loop.test/a# never reads the instance
```

A loop that only some instances reach still compiles, and answers every
instance that does not reach it: `{ "anyOf": [{ "type": "string" }, { "$ref": "#" }] }`
accepts `"a"`, and is refused `JK2001` on `1`.

**`JK2001` — the reference depth bound.** One validation enters at most
`maxReferenceDepth` (default 256) nested schema references: a `$ref` resolved
on first use, a `$dynamicRef` or a `$recursiveRef`. Every recursion through a schema passes one, so the bound
holds an instance nested deeper than the schema can follow (an array 257
levels deep against `{ "items": { "$ref": "#" } }`) and a loop that never
descends into the instance alike, before the host's call stack can overflow.
The default is fixed, so the refusal is the same on every host; a schema that
descends several levels per reference admits a deeper instance, and one that
validates a meta-schema reference per level admits a shallower one. The
message names the reference where the bound was crossed.

**`JK0002` — the option.** `new JarenValidator({ maxReferenceDepth: 2000 })`
raises the bound for every schema that validator compiles, `validateSchema`
included, so an application with legitimately deep data gets its answers
back. Raising it hands the decision back to the host: past the default, a
deep enough instance can overflow the call stack again, at a depth that
differs from host to host. Anything but a positive safe integer is refused
`JK0002` when a schema compiles; `null` or absent means the default.

**`JK0003` — the output format.** The `outputFormat` option takes one of
the formats `@jarenjs/validate/output` exports (`flagOutput`,
`basicOutput`, `detailedOutput`, `verboseOutput`, `listOutput`,
`hierarchicalOutput`; the README's *Standard output formats*). Anything
else, a format's name as a string (`'list'`) included, is refused `JK0003`
when a schema compiles, naming the subpath and the value given, rather
than quietly returning the default shape:

```text
JK0003: outputFormat takes a format of '@jarenjs/validate/output', got 'list'
```

The formats live behind the subpath so that a validator given none ships
none of their code. Absent means the `collectErrors` shapes.

**`JK0004`–`JK0007` — loading what a schema references.** `compileAsync`
(`@jarenjs/validate/load`, the README's *Loading referenced schemas*) loads
every document a schema's references need that the validator does not hold
through the host's `loadSchema(uri)`. A load that cannot be used refuses the
whole compilation; the message names the URI asked for, and `docPath` is the
reference that needed it — in the schema (`#/…`) or in a document loaded
for it (`https://…#/…`). A loader that throws or rejects is `JK0004`, its
error kept as `cause`:

```text
JK0004: loadSchema('https://x.test/a.json') failed: 503 Service Unavailable at #/properties/a/%24ref
```

A reference inside a schema the validator held before the call has no
location in the schema being compiled; its refusal says so instead:

```text
JK0004: loadSchema('https://x.test/name.json') failed: no document at https://x.test/name.json, referenced by a schema the validator held
```

A loader that returns anything but an object or a boolean — the document's
JSON text included, which the host parses — is `JK0005`, rather than a
document `addSchema` would skip and `compile` then cannot resolve:

```text
JK0005: loadSchema('https://x.test/s.json') returned the string '{"type":"string"}', not a schema (an object or a boolean) at #/items/%24ref
```

A `JK0004` or `JK0005` for a URI under the validator's default base — a
relative reference in a schema without `$id`, on a validator whose
`traverse` names no origin — names the base it resolved against and the two
repairs:

```text
JK0004: loadSchema('https://github.com/jklarenbeek/name.json') failed: no document at https://github.com/jklarenbeek/name.json; the URI is under the validator's default base 'https://github.com/jklarenbeek/jarenjs', which no $id and no traverse origin names: give the schema an $id, or the validator a base (traverse: new TraverseOptions(base)) at #/%24ref
```

A call that needs more documents than `maxLoads` (default 100) stops at the
first one past the bound, so a loader that keeps answering with documents
that reference new ones cannot run without end:

```text
JK0006: compileAsync needs more than 100 schema loads (maxLoads); one more is 'https://x.test/100.json' at https://x.test/99.json#/%24ref
```

An argument `compileAsync` does not take is `JK0007` (`compileAsync takes a
loadSchema(uri) function, got undefined`; `maxLoads must be a positive safe
integer, got 0`), refused before anything is loaded.

