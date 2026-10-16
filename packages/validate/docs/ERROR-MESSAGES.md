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
| validate keywords | the keyword itself: `type`, `required`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`, `additionalProperties`, `minProperties`, `maxProperties`, `minItems`, `maxItems`, `uniqueItems`, `contains`, `minContains`, `maxContains`, `items`, `allOf`, `anyOf`, `oneOf`, `not`, `format`, `contentEncoding`, `contentMediaType`, `nullable`, `if`, `then`, `else`, `false schema`, `const`, `enum`, `dependentRequired`, `dependencies`, `unevaluatedProperties`, `unevaluatedItems`, `$query` | `type`/`types`; `missingProperty`; `limit` (+ `comparison` for the numeric bounds); `multipleOf`; `pattern`; `additionalProperty`; `format`; `encoding` (`contentEncoding`, and `contentMediaType` beside `contentEncoding: 'base64'`, whose check decodes the string first); `mediaType`; `allowedValue` (`const`: the value it expected); `allowedValues` (`enum`: the list it allows); `property` + `missingProperty` (`dependentRequired` and the array form of `dependencies`: the present property and the first dependency the object lacks); `unevaluatedProperty` (the member name); `unevaluatedItem` (the index) |
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
| `JK0008` | `SchemaCompileError` | A draft-07 `$ref` beside an `$id`, which does not set its base, resolves to no schema the validator holds: refused when a schema compiles, or by the first call that reaches a reference resolved on first use |
| `JK0009` | `SchemaCompileError` | A reference resolves to no schema the validator holds (a document nothing holds, a pointer that misses, or an anchor nothing declares): refused when a schema compiles, or by the first call that reaches a reference resolved on first use, a `$dynamicRef`, or a `$recursiveRef` in a document that declares no draft and is not read as 2019-09 |
| `JK0010` | `SchemaCompileError` | A `$ref`, `$dynamicRef`, `$recursiveRef` or `$id` (`id`) is not a valid URI reference: refused where the text is read, naming the keyword, the text and where it sits |
| `JK0011` | `SchemaCompileError` | A `$recursiveRef` read as draft 2019-09 is not `"#"`: refused by the first call that reaches it, naming the `$ref` that applies the schema it names |
| `JK0012` | `SchemaCompileError` | An identifier (`$id`, `$anchor`, `$dynamicAnchor`) names two schemas — a document declares it twice, or it already names another schema the validator holds: refused where the second is read, naming both places; in a registered document, refused by the compile that reads it |
| `JK0101` | `SchemaCompileError` | Retired, no longer raised: `deriveStrictProfile` (`@jarenjs/validate/strict-profile`) carries a schema that accepts any value — `true`, `{}`, a node with no type, a free-form object, a tuple — as JSON text |
| `JK0102` | `SchemaCompileError` | `deriveStrictProfile`: an object whose member names are open and that no entries array carries — a map beside declared `properties`, a map that may also be an array, a schema-valued `unevaluatedProperties` |
| `JK0103` | `SchemaCompileError` | `deriveStrictProfile`: a keyword that applies members, items or branches beside its node and that no distribution makes exact — `if`/`then`/`else`, `dependentSchemas` or a draft-07 `dependencies` schema beside an object type, a branch beside an object type that is more than members (a `$ref`, a nested union, an `enum`), a branch giving a member a second schema that is not an `enum` or `const`, an untyped `allOf` of more than one branch, a `$ref` or `anyOf` beside structural siblings |
| `JK0104` | `SchemaCompileError` | `deriveStrictProfile`: a reference cannot be bundled — a `$dynamicRef` or `$recursiveRef`, a document neither the schema nor its `references` hold, or a target that is no schema |
| `JK0105` | `SchemaCompileError` | `deriveStrictProfile` or `relaxSchema`: a node carries both `oneOf` and `anyOf`, and the profile turns `oneOf` into `anyOf` |
| `JK0106` | `SchemaCompileError` | `deriveStrictProfile`: a member that `required`, or a `dependentRequired` (draft-07 `dependencies` list) firing on a declared member, requires is not declared under `properties` (or is declared `false`), so a closed object could never hold it |
| `JK0107` | `SchemaCompileError` | `deriveStrictProfile` or `relaxSchema` was given an argument it does not take |
| `JK0108` | `SchemaCompileError` | `deriveStrictProfile`: a schema that accepts no value (`false` or a `$ref` to it, an `anyOf` branch `false`, `items: false`, an object whose own `additionalProperties: false` refuses a member a branch requires) has no strict form |
| `JK2001` | `SchemaRuntimeError` | Validation nests schema references deeper than `maxReferenceDepth` (default 256): refused where the bound is crossed |
| `JK2002` | `SchemaRuntimeError` | A strict profile's `fromProfile`: a member carried as JSON text is a string that is not JSON text: refused naming its `dataPath` in the answer |
| `JK2003` | `SchemaRuntimeError` | A strict profile's `fromProfile`: a map carried as `{ key, value }` entries names one key twice: refused naming the second entry's `dataPath` |

**`JK0001` — a loop that never reads the instance.** A `$ref` that leads
back to itself through `$ref`s alone is refused wherever it sits in the
document. A root schema is also refused when following, from the root, the
`$ref` (evaluated before its siblings) or the one in-place applicator a
schema evaluates first on every instance — its only `not`, its `if` beside a
`then` or an `else`, the target of its only `$dynamicRef` or `$recursiveRef`
its document's draft defines, or the first member its only `allOf`, `anyOf` or `oneOf` reaches on every
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

**`JK0008` — a draft-07 `$ref` beside an `$id`.** Before 2019-09 a `$ref`
replaces the schema object it sits in, so an `$id` beside it names the
object but does not set the base the reference resolves against: the
reference resolves against the enclosing base, as `compile`, `addSchema`
and `compileAsync` all read it (the schema being compiled reads `$ref` and
the `$id` beside it as draft-07 does when it declares no `$schema`). When nothing the validator holds has that URI, the
compilation is refused, naming the URI and the two repairs (register a
schema at that URI, or declare `$schema` 2019-09 or later so the `$id` sets
the base):

```text
JK0008: Can not resolve schema for 'https://github.com/jklarenbeek/name.json#': a draft-07 $ref ignores the $id beside it; register that URI, or declare $schema 2019-09 or later
```

From 2019-09 on the `$id` sets the base of the `$ref` beside it. A document
registered with `addSchema` (or loaded by `compileAsync`) that declares no
`$schema` is read by each compile under the draft that compile names,
whichever reference reaches the object (its `$id` or a pointer), and a
draft-07 compile resolves such a `$ref` when it first runs: the first call
that reaches it is refused `JK0008` there (the `SchemaCompileError` is thrown
by the call), and an instance that does not reach it answers.

**`JK0009` — a reference nothing resolves.** A reference whose document
nothing registered or loaded, or whose pointer misses in a document the
validator holds, is refused naming the reference and the repair. A
reference the compilation resolves is refused when the schema compiles,
under whichever applicator it sits; one resolved on first use is refused by
the first call that reaches it:

```text
JK0009: Can not resolve schema for 'https://github.com/jklarenbeek/nope.json#': no schema the validator holds has that URI; register it with addSchema, load it with compileAsync, or fix the reference
JK0009: Can not resolve schema for 'https://github.com/jklarenbeek/jarenjs#/$defs/missing': '/$defs' is not a schema in 'https://github.com/jklarenbeek/jarenjs#'; fix the pointer
```

A `$dynamicRef` or `$recursiveRef` whose target nothing resolves is refused
the same way by the first call that reaches it, never answered (answered, it
would read `false` on every instance and `true` under `not`); read as 2019-09,
a `$recursiveRef` other than `"#"` is `JK0011` instead. Each is a keyword only
where its document declares a draft that defines it (`$recursiveRef`
2019-09, `$dynamicRef` 2020-12), declares none, or declares a `$schema` that
names no draft this package knows: elsewhere it is an unknown keyword, applies
nothing and is never refused. A plain-name fragment
no `$anchor` or `$dynamicAnchor` declares (`#nope`) names nothing; a name is
matched as the URI spells it, whatever characters it holds (`#a b` is
`#a%20b`). A fragment that decodes to one starting with `/` is a JSON Pointer
(`#%2F$defs%2Fx` is `#/$defs/x`): its `%2F`s separate tokens as its `/`s do,
so `#/$defs/a%2Fb` names `b` in `a` (`#/$defs/a~1b` names `a/b`). A blank
`$ref` or `$dynamicRef` is the empty URI reference and names the current
resource, as `#` does.

**`JK0010` — a reference or an identifier that is no URI.** A `$ref`,
`$dynamicRef`, `$recursiveRef` or `$id` (`id`) whose text, resolved against
its base, is no valid URI (a host in brackets that is no IP address, a port
past 65535) is refused naming the keyword, the text and where it sits: a `$ref`
or `$id` of the schema being compiled as a pointer into it (read when the schema
is registered for the compile), a `$dynamicRef`, a `$recursiveRef` or a keyword
of a registered document as the URI of the schema object that holds it with the
keyword appended. A `$recursiveRef` other than `"#"` in a document that
declares no draft is refused by the call that reaches it (read as 2019-09 it
is `JK0011`); a document that declares a draft other than 2019-09 does not
read it. A registered document's place that is no URI reference does not end
its registration: the rest of the document is registered, and the compile that
reads the place refuses it. `deriveStrictProfile` refuses such an `$id` with the
same message at the same place:

```text
JK0010: $ref 'http://[x' is not a valid URI reference; correct it, percent-encoding any character a URI does not allow at #/%24ref
JK0010: $dynamicRef 'http://[x' is not a valid URI reference; correct it, percent-encoding any character a URI does not allow at https://github.com/jklarenbeek/jarenjs#/properties/a/%24dynamicRef
```

**`JK0011` — a `$recursiveRef` other than `"#"`.** Draft 2019-09 defines
`$recursiveRef` only as `"#"` and lets another value be an error. Read as
2019-09 (the place's `$schema`, or the compile's when the place declares
none), another value is refused by the first call that reaches it, naming the
`$ref` that applies the schema it names; an instance that does not reach it
answers. A document that declares a draft that does not define the keyword
(draft-07, 2020-12) reads it as an unknown keyword, which applies nothing,
whatever its value:

```text
JK0011: $recursiveRef '#/$defs/x' is defined only as "#"; to apply the schema it names, write $ref '#/$defs/x' at https://github.com/jklarenbeek/jarenjs#/properties/a/%24recursiveRef
```

**`JK0012` — an identifier that names two schemas.** An `$id`, `$anchor` or
`$dynamicAnchor` names one schema. A schema being compiled (or the schemas
given to that compile, or the schema `compileAsync` compiles) that declares
one twice is refused when it compiles, naming both places; one that declares
an identifier already naming another schema the validator holds is refused
naming the keyword and its place; and a further document a compile is given
with no `$id` of its own, read under a URI that already names one, is
refused with the repair of giving it one. A document registered with
`addSchema` (or loaded by `compileAsync`) is not refused: an identifier it
declares at two places that differ, or a nested one two registered documents
declare differently, is refused only by the compile that reads it (when it
compiles, or, for a reference resolved on first use, by the first call that
reaches it), naming both places or both documents, since it would answer by
the place registered first. Where anchors are not allowed
(`TraverseOptions`), an `$anchor` or `$dynamicAnchor` declares nothing:

```text
JK0012: 'https://github.com/jklarenbeek/x.json#' is declared twice (first at '#/%24defs/a/%24id'); give one of them another name at #/%24defs/b/%24id
JK0012: $id declares 'https://a.test/x.json#', which names another schema the validator holds; give one of them another name at #/%24defs/a/%24id
JK0012: 'https://d.test/x.json#' names two schemas (in 'https://d.test/r.json', at '#/%24defs/a/%24id' and at '#/%24defs/b/%24id'), and this compile reads it, which would answer by the one registered first; give one of them another name
JK0012: 'https://d.test/x.json#' names two schemas (one registered under 'https://d.test/one.json', one under 'https://d.test/two.json'), and this compile reads it, which would answer by the one registered first; give one of them another name
```

**`JK0102`–`JK0108` — a schema with no strict form.** `deriveStrictProfile`
closes every object and requires every member, so it refuses each shape a
closed profile would read wrong — a profile that could never hold an answer
the original accepts by declaration, or one that silently accepts what the
original's members never declared — naming the place in the original schema
(a place inside a document passed as a reference is named by that
document's `$id`). Each message ends with its repair:

```text
JK0102: a map beside declared properties admits members of any name next to fixed ones, which neither a closed object nor an entries array carries; move the map into a member of its own at #/properties/tags
JK0103: a branch gives a member a schema of its own beside the object's, and a strict profile cannot apply both; give the member one schema, or an enum on one side at #/allOf/0/properties/a
JK0103: if beside an object type adds members a closed profile object cannot carry; move the members into the object (or into each branch) at #/if
JK0104: $ref 'https://x.test/a.json' names a document neither the schema nor its references hold; pass it in references at #/properties/a
JK0105: a node carries both oneOf and anyOf, and a profile turns oneOf into anyOf; merge them into one anyOf at #/properties/a
JK0106: required member 'id' is not declared under properties, so a closed profile object could never hold it; declare it at #/required
JK0107: deriveStrictProfile takes a schema and { references }: an array of schema documents
JK0108: a schema that accepts no value has no strict form at #
```

A refusal the original's own validator raises while the derivation asks it
whether a member admits `null` (a `JK0009` for a reference inside a relaxed
keyword that no document given resolves) passes through unchanged.

**`JK2002`, `JK2003` — an answer `fromProfile` cannot read back.** A value
of any shape travels as JSON text, and a map as `{ key, value }` entries.
Text that is not JSON, and entries that name one key twice, have no reading
in the original's shape; returning them as written could pass silently where
the original accepts a string or an array, so they are refused, naming the
place in the answer — a message a host can hand the model to repair. Text
that decodes to a value the original refuses is not refused here: the
original's validator refuses it with its own error.

```text
JK2002: a member carried as JSON text is not JSON text; write the value as a string of JSON in data /m
JK2003: the entries name member 'k' twice; write each key once in data /t/1
```
