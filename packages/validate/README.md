# @jarenjs/validate

The JSON Schema validating compiler at the heart of [Jaren](https://github.com/jklarenbeek/jarenjs). It compiles JSON Schemas into optimized validation functions and fully supports `draft-06`, `draft-07`, `draft 2019-09` and `draft 2020-12` — passing the official [JSON-Schema-Test-Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite) for draft-07, 2019-09 and 2020-12, including the `$dynamicRef` scope cases.

## Usage

```javascript
import { JarenValidator } from '@jarenjs/validate';

const jaren = new JarenValidator();

const validate = jaren.compile({
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer', minimum: 0 }
  },
  required: ['name']
});

validate({ name: 'John', age: 30 }); // true
```

Key entry points:

- `new JarenValidator(options)` — create a validator instance
- `.addSchema(schema, key)` — register schemas for `$ref` resolution
- `.addMetaSchema(schemas, key)` — register (custom) meta-schemas, honoring `$vocabulary`
- `.addFormats(formats)` — register format validators (see [`@jarenjs/formats`](../formats))
- `.compile(schema)` — compile a schema into a validation function
- `compileAsync(validator, schema, { loadSchema })` from `@jarenjs/validate/load` — load the documents a schema's references need, then compile it — see [Loading referenced schemas](#loading-referenced-schemas)

Highlights:

- Annotation-based `unevaluatedProperties`/`unevaluatedItems`
- Spec-compliant dynamic scope for `$dynamicRef`/`$dynamicAnchor` and `$recursiveRef`/`$recursiveAnchor`
- Per-document draft handling for cross-draft references
- `$vocabulary`-aware keyword selection and per-draft `format`/content assertion defaults
- Instance-data references via the `data` keyword (json-everything data-ref) and Ajv-style `$data`
- Cross-field assertions via the `$query` extension keyword (a [Jaren JSON Query](../json/docs/QUERY-FORMAT.md) inside the schema)
- The JSON Schema standard output formats (`flag`, `basic`, `detailed`, `verbose`, `list`, `hierarchical`) from `@jarenjs/validate/output`, via the `outputFormat` option — see [Standard output formats](#standard-output-formats)

Schema registrations accept boolean schemas when supplied an explicit key.
Document URIs with or without an empty `#` fragment are aliases; replacing a
registration replaces both aliases. Named anchor fragments remain distinct.
A plain-name fragment is matched as the URI spells it, whatever characters the
name holds: `$anchor: 'a b'` is named by `#a b` (or `#a%20b`), `_a` and names
longer than 31 characters resolve as `$anchor`, `$dynamicAnchor` and a draft-07
`$id: '#name'`, and a name no anchor declares is refused `JK0009`. *Upgrade: an
anchor that was no HTML identifier of at most 31 characters (`a b`, `_a`, `1a`, a
longer name) threw an uncoded `Error` ("… already exists") where it was
declared, and in a registered document ended its registration there; a
reference to such a name named the whole document, so with no anchor of that
name `{ "$ref": "#_a" }` answered as the document.*
A fragment that decodes to one starting with `/` is a JSON Pointer:
`{ "$ref": "#%2F$defs%2Fx" }` names `$defs/x`, and a `%2F` separates tokens as a
`/` does wherever it sits in a pointer (`#/$defs/a%2Fb` names `b` in `a`;
`#/$defs/a~1b` names `a/b`), as `@jarenjs/validate/normalize` reads it.
*Upgrade: `#%2F$defs%2Fx` was refused `JK0009`, and `#/$defs/a%2Fb` named the
member `a/b`.* A blank `$ref` (or `$dynamicRef`) is the empty URI reference and
names the current resource, as `#` does: `{ "properties": { "p": { "$ref": "" }
}, "type": "object" }` rejects `{ "p": 1 }`. *Upgrade: a blank reference was read as
none, so that schema accepted `{ "p": 1 }`, and `{ "$ref": "" }` (a schema referring to
itself) accepted everything where it is now refused `JK0001`, as its `#` spelling is.*
`addMetaSchema` accepts the bundles from `@jarenjs/refs` without mutating them,
and `validateSchema` always returns a boolean. A schema with no `$schema`
uses draft-07 for both compilation and meta-schema validation.

## 🔑 JSON Schema validation keywords

Jaren supports the full set of JSON Schema validation keywords. Here's a quick overview:

- JSON data type: `type`, `nullable`, `required`
- Numbers: `maximum`, `minimum`, `multipleOf`
- Strings: `maxLength`, `minLength`, `pattern`
- Content: `contentEncoding`, `contentMediaType`
- Arrays: `maxItems`, `minItems`, `uniqueItems`, `items`, `prefixItems`, `contains`, `unevaluatedItems`
- Objects: `maxProperties`, `minProperties`, `required`, `properties`, `patternProperties`, `unevaluatedProperties`
- All types: `enum`, `const`
- Compound: `not`, `oneOf`, `anyOf`, `allOf`, `if/then/else`
- Meta: `$schema`, `$id`, `$ref`, `$anchor`, `$dynamicRef`/`$dynamicAnchor`, `$recursiveRef`/`$recursiveAnchor`, `$vocabulary`
- **Non-standard**: `data` (json-everything's [data-ref](https://docs.json-everything.net/schema/examples/data-ref/) proposal), Ajv-style `$data` references, and the [`$query` keyword](#query--cross-field-assertions) below

A `pattern`, a `patternProperties` key and a string checked by the `regex`
format are ECMA-262 pattern sources, as JSON Schema 2020-12 Validation §6.3.3
reads them, compiled in Unicode mode: `"/a/"` matches only text that contains
`/a/`, and `"/a/i"` only text that contains `/a/i`. A failure's
`params.pattern` is the string the schema wrote. A RegExp that JavaScript code
places in a schema keeps its own flags. A string that is no valid Unicode-mode
source but compiles as a `v`-mode literal (`"/[\\p{L}--[a-z]]/v"`) is still
read as that literal. *Upgrade: a string written
`/source/flags` used to be read as a regular-expression literal, so `"/a/"`
accepted `"a"` and `"/a/i"` accepted `"A"`; drop the slashes and spell a
flag inside the source (`"[Aa]"` for case-insensitivity). `params.pattern`
used to carry the compiled source, with every `/` escaped as `\/`.*

The same reading is exported as `createSchemaPatternTester(pattern)` from
`@jarenjs/validate/normalize`: it
returns a repeatable `(text) => boolean` predicate (`undefined` for no
pattern) and throws a `SyntaxError` for a string that compiles neither way.
`@jarenjs/forms` compiles a field's `pattern` through it, so a form field and
the validator accept the same strings.

<details>
<summary>🔥 For a complete list of supported keywords and their implementation status, click here</summary>

### 🔑 JSON data type

- type
- nullable | _(OpenAPI)_
- required | _as boolean: rejects `undefined` when this schema is invoked; object member presence is declared with the parent's `required` array_

### 🔑 Keywords for numbers

- maximum / minimum<br />and exclusiveMaximum / exclusiveMinimum
- multipleOf

A numeric `exclusiveMinimum`/`exclusiveMaximum` is its own bound and applies beside `minimum`/`maximum`: `{ "minimum": 5, "exclusiveMinimum": 3 }` rejects `4`, `{ "maximum": 5, "exclusiveMaximum": 10 }` rejects `6`, and the same holds for `bigint` values and for `formatMinimum`/`formatExclusiveMinimum` and `formatMaximum`/`formatExclusiveMaximum`. The draft-04 boolean spelling still modifies the inclusive bound: `true` makes it exclusive and `false` leaves it inclusive. *Upgrade: the exclusive bound used to replace the inclusive one, so `4` and `6` above passed, and `{ "minimum": 5, "exclusiveMinimum": false }` accepted `1` while `{ "maximum": 5, "exclusiveMaximum": false }` rejected `5`.*

BigInt instance values are supported too: `maximum`/`minimum`/`exclusiveMaximum`/`exclusiveMinimum` and `multipleOf` compile dedicated BigInt comparators when the data is a `bigint`.

### 🔑 Keywords for strings

- maxLength / minLength
- pattern

### 🔑 Keywords for content

- contentEncoding | asserts in `draft7`, annotation-only from `draft2019` on (spec default), controlled by the `contentValidation` option
- contentMediaType | same assertion defaults; `application/json` content is parse-checked, decoded first under `contentEncoding: 'base64'`; under an encoding the validator does not decode (`base32`, `BASE64`) it is not checked, as `contentEncoding` alone does not check it. *Upgrade: the check decoded the string as base64 whatever `contentEncoding` named, so `{ "contentEncoding": "base32", "contentMediaType": "application/json" }` rejected the base32 JSON document `'PMRGC5BCHI2H2==='`; collected errors lose those `contentMediaType` failures.*
- ❌ contentSchema | annotation only (never asserted)

Base64 JSON content validation decodes UTF-8 in both browser and Node runtimes;
it does not require Node's `Buffer` global.

### 🔑 Keywords for format

- format
- formatMinimum / formatMaximum<br />or formatExclusiveMinimum / formatExclusiveMaximum

### 🔑 Keywords for array

- maxItems / minItems
- uniqueItems
- items
  - items | as schema or tuple _deprecated in `draft2020`_
  - items | as schema only _new `draft2020`_
- prefixItems | as tuple _new `draft2020`_
- additionalItems | as schema _deprecated in `draft2020`_
- contains
- maxContains / minContains | _new `draft2019`_
- unevaluatedItems | _new `draft2019`_

### 🔑 Keywords for object

- maxProperties / minProperties
- required | _as array!_
- properties
- patternProperties
- additionalProperties
- dependencies | _deprecated in `draft2019`_
- dependentRequired | _new `draft2019`_
- dependentSchemas | _new `draft2019`_
- propertyNames
- unevaluatedProperties | _new `draft2019`_
- [propertyDependencies](https://github.com/json-schema-org/json-schema-spec/blob/main/specs/proposals/propertyDependencies.md) | _proposal, off unless the `propertyDependencies` option is set — see [below](#propertydependencies--select-a-subschema-by-a-members-value)_

### 🔑 Keywords for all types

- enum
- const

### 🔑 Compound keywords

- not
- oneOf
- anyOf
- allOf
- if / then / else

See also:
- [Schema Composition](https://json-schema.org/understanding-json-schema/reference/combining)
- [Applying Subschemas Conditionally](https://json-schema.org/understanding-json-schema/reference/conditionals)

### 🔑 Meta keywords

- $schema | used for draft detection, vocabulary selection and cross-draft references
- $id
- $ref
- $anchor
- $recursiveRef | _new `draft2019` &amp; deprecated in `draft2020`_
- $recursiveAnchor | _new `draft2019` &amp; deprecated in `draft2020`_
- $dynamicRef | _new `draft2020`_
- $dynamicAnchor | _new `draft2020`_
- $data | _(Ajv specific)_
- [$vocabulary](https://github.com/json-schema-org/json-schema-spec/blob/main/proposals/vocabularies.md) | _new `draft2019`_ - a custom metaschema that omits the validation vocabulary turns keywords like `type` and `minimum` into annotations; a metaschema that declares the `format-assertion` vocabulary turns format assertion on

### 🔑 Non-standard keywords

- `data` | json-everything's [data-ref](https://docs.json-everything.net/schema/examples/data-ref/) proposal

  The `data` keyword allows you to reference values from the instance being validated, enabling dynamic constraints based on other parts of the data.

  **Example - Requiring B >= A:**
  ```json
  {
    "type": "object",
    "properties": {
      "A": { "type": "number" },
      "B": {
        "type": "number",
        "data": {
          "minimum": "/A"
        }
      }
    }
  }
  ```
  - Passes: `{ "A": 5, "B": 10 }` (10 >= 5)
  - Fails: `{ "A": 15, "B": 10 }` (10 < 15)

  **Example - Enum from instance array:**
  ```json
  {
    "type": "object",
    "properties": {
      "color": {
        "data": {
          "enum": "/validColors"
        }
      },
      "validColors": {
        "type": "array",
        "items": { "type": "string" }
      }
    }
  }
  ```

  **Supported keywords within `data`:**
  - Number constraints: `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`
  - String constraints: `minLength`, `maxLength`, `pattern`, `format`
  - Array constraints: `minItems`, `maxItems`
  - Object constraints: `minProperties`, `maxProperties`
  - Value constraints: `enum`, `const`

  Both absolute JSON Pointers (e.g., `/A`, `/limits/min`) and relative JSON Pointers (e.g., `0/parent`, `1/sibling`) are supported. A reference that cannot be compiled (`{ "minimum": "abc" }`) fails the compile, as it does for `$data`; a reference that compiles but finds no value in the instance asserts nothing.

- `$data` | Ajv-style instance references (`{ "minimum": { "$data": "1/limit" } }`) — supports every keyword the `data` list above supports, plus `uniqueItems` and `required`. Takes the same three reference forms: empty for the whole instance, an absolute JSON Pointer (`/limit`), or a Relative JSON Pointer (`1/limit`). Refs compile once at schema compile time through the compiled pointer engine of `@jarenjs/json`, and a reference that cannot be compiled **fails the compile** rather than quietly resolving to nothing — a constraint that disables itself is worse than a rejected schema.

- `$query` | Jaren's cross-field assertion keyword — see [below](#query--cross-field-assertions)

### 🔑 Miscellaneous keywords

- ❌ strict
- ❌ strictFormat
- ❌ strictTuple
- errorMessage | author-supplied messages that override text (never structure) — see [Error messages &amp; i18n](#error-messages--i18n)
- definitions | used by initial schema traversal _deprecated in `draft2019`_
- $defs | used by initial schema traversal _new `draft2019`_
- components | _(OpenAPI)_

</details>

## 🛠️ Notable capabilities

### 👉 Modelling Inheritance with JSON Schema

Jaren fully supports `unevaluatedProperties`, so the inheritance patterns from the [Modelling Inheritance](https://json-schema.org/blog/posts/modelling-inheritance) blog post work out of the box. Annotations flow from `properties`, `patternProperties`, `additionalProperties` and every in-place applicator (`allOf`/`anyOf`/`oneOf`/`if-then-else`/`$ref`/`dependentSchemas`/`propertyDependencies`), with annotations from failed branches correctly discarded.

See also:
- [json-schema-core](https://json-schema.org/draft/2020-12/json-schema-core#name-unevaluatedproperties)
- [Combining unevaluatedProperties and ref: # #375](https://github.com/orgs/json-schema-org/discussions/375)

### 👉 Express array constraints more cleanly

Jaren fully supports `unevaluatedItems`, covering the array patterns from the 2020-12 [release notes](https://json-schema.org/draft/2020-12/release-notes#contains-and-unevaluateditems): items evaluated by `items`, `prefixItems`, `additionalItems` and (in 2020-12) `contains` are tracked, and everything left over is validated by the `unevaluatedItems` schema.

### 👉 Using Dynamic References to Support Generic Types

Jaren fully supports `$dynamicRef`/`$dynamicAnchor` (2020-12) and `$recursiveRef`/`$recursiveAnchor` (2019-09), including the generic-type patterns from the [dynamicRef and generics](https://json-schema.org/blog/posts/dynamicref-and-generics) blog post. Resolution follows the specification's dynamic-scope rules: entering a schema resource brings all of its dynamic anchors into scope, and a `$dynamicRef` resolves to the anchor in the outermost resource of the dynamic scope.

See also:
- [Understanding lexical dynamic scopes](https://json-schema.org/blog/posts/understanding-lexical-dynamic-scopes)
- [$dynamicRef and $dynamicAnchor](https://json-schema.org/draft/2020-12/release-notes#dollardynamicref-and-dollardynamicanchor)

### 👉 Runtime schema manipulation of constraints

Jaren supports the `data-ref` proposal from json-everything through the `data` keyword, plus Ajv-style `$data` references. Both allow a schema constraint to take its value from the instance being validated:

- Absolute JSON Pointers (e.g., `/A`, `/limits/min`)
- Relative JSON Pointers (e.g., `0/parent`, `1/sibling`); `relativePointerDialect: 'bhutton-00'` also takes index manipulation (`0+1`, `1-1/name`), see [below](#relative-pointer-dialect)
- All common constraint keywords: `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`, `format`, `enum`, `const`, `minItems`, `maxItems`, `minProperties`, `maxProperties`

The refs compile once at schema compile time through the compiled pointer engine of [`@jarenjs/json`](../json) and resolve allocation-free per validation.

Dynamic `const` and `enum` use the same structural object/array equality as
their static forms. Dynamic string bounds honor the compiler's `useGrapheme`
option as well.

#### Relative pointer dialect

A Relative JSON Pointer has two revisions. The validator speaks
draft-handrews-relative-json-pointer-01 by default, the one JSON Schema 2020-12
references and the official `relative-json-pointer` format suite asserts: a
level count, then `#` or a JSON Pointer. `relativePointerDialect: 'bhutton-00'`
selects draft-bhutton-relative-json-pointer-00, which adds an index
manipulation, a `+` or `-` and a non-negative integer after the level count,
that steps along the array the location is an item of. The one option decides
the `data` keyword, `$data` and the `relative-json-pointer` format together:

```javascript
const jaren = new JarenValidator({ relativePointerDialect: 'bhutton-00' });

// Each item may not exceed the item after it; the last item has none.
const ascending = jaren.compile({
  type: 'array',
  items: { type: 'number', maximum: { $data: '0+1' } },
});
ascending([1, 2, 3]); // true
ascending([1, 3, 2]); // false

const pointer = jaren.addFormats(jsonFormats).compile({ format: 'relative-json-pointer' }); // formatAssertion on
pointer('1-1/name'); // true under 'bhutton-00', false by default
pointer('+1/foo/bar'); // false under both
```

A reference the default grammar refuses (`0+1`) is a compile-time error, as
every malformed reference is; a shifted reference that reaches no array item (the
last item's `0+1`) finds no value and asserts nothing. Any value other than
`'handrews-01'` or `'bhutton-00'` throws a `TypeError` when a schema compiles,
so a misspelling cannot leave the default grammar in force unnoticed.

A meta-schema that asserts the `relative-json-pointer` format (the `$data`
reference meta-schema `@jarenjs/refs` keeps in `src/data.json` does) is checked
in the grammar of the validator that compiles it, so a `$data` of `0+1` passes
that meta-schema under `'bhutton-00'` and fails it by default; a validator that
checks schemas for another application must be given the same option.

See also:
- [$data](https://github.com/json-schema-org/json-schema-spec/issues/51)
- [Ajv $data spec](https://github.com/ajv-validator/ajv/tree/master/spec/extras/%24data)
- [data-ref](https://docs.json-everything.net/schema/examples/data-ref/)

### 👉 Vocabularies and cross-draft references

A schema's `$schema` declaration is honored per document: referenced documents that declare a different draft are processed with that draft's keyword set (a draft-07 document ignores `dependentRequired`, `dependentSchemas`, `minContains`, `maxContains`, `unevaluatedProperties` and `unevaluatedItems`; a 2019-09 or draft-07 document ignores `prefixItems`, so its `items: false` forbids every item; a draft-07 or 2020-12 document ignores `$recursiveRef`, a draft-07 or 2019-09 one `$dynamicRef`, while one whose `$schema` names no known draft reads both). A document that declares no `$schema` reads every keyword. A `$ref` target is processed with the draft its own place declares — the nearest `$schema` on the way to it in the document that holds it, the referencing one or another — however it is compiled (`compile`, `addSchema` + `compile`, `compileAsync`). *Upgrade: a reference target was compiled with no declared draft, so `{ "$schema": "https://json-schema.org/draft/2019-09/schema", "$defs": { "t": { "prefixItems": [{ "type": "integer" }] } }, "$ref": "#/$defs/t" }` rejected `["5"]`, which the same `prefixItems` written inline accepts; the other declared-draft gates (`dependentRequired`, `dependentSchemas`, `minContains`, `maxContains`, `unevaluatedProperties`, `unevaluatedItems`, `propertyDependencies`) read a target the same way, so collected errors lose the failures of keywords the target's draft does not have. The keywords beside a target's own `$ref` assert by its document's draft too: a draft-07 target `{ "$ref": "#/definitions/y", "minimum": 5 }` referenced from a 2020-12 schema no longer asserts `minimum`, and a 2020-12 one referenced from a draft-07 schema now does; and a 2020-12 document referenced from a draft-07 schema, or from one that declares no draft, now counts the items its `contains` matches as evaluated for its `unevaluatedItems`.* Custom metaschemas with `$vocabulary` are respected — omitting the validation vocabulary turns validation keywords into annotations (`type` and `required` inside `items`, `minContains`/`maxContains` beside `contains`, and `maxItems`, which then no longer bounds the items `items` and `contains` look at), and declaring `format-assertion` turns format assertion on. *Upgrade: under a metaschema without the validation vocabulary, `{ "items": { "type": "string" } }` used to reject `[5]`, `minContains`/`maxContains` counted, and `{ "maxItems": 1, "items": { "properties": { "x": false } } }` accepted `[{}, { "x": 1 }]` because it stopped at the first item; a 2019-09 or draft-07 document with `prefixItems` beside `items: false` accepted any array, and a draft-07 document asserted `minContains`, `maxContains`, `unevaluatedProperties` and `unevaluatedItems`.*

Modern reference chains preserve supported sibling assertions, including
dependent schemas and dynamic references. Draft-07 retains its reference-only
behavior, ignoring siblings beside `$ref`: an `$id` beside a draft-07 `$ref`
names the object but does not set the base the reference resolves against
(the schema being compiled reads `$ref` and the `$id` beside it as draft-07
does when it declares no `$schema`). `compile`,
`addSchema` and `compileAsync` read it alike, and a reference that then
resolves to nothing the validator holds is refused when it compiles
(`JK0008`, naming the URI and the repairs). A document registered with
`addSchema` (or loaded) that declares no `$schema` is read by each compile
under the draft that compile names, whichever reference reaches the object —
its `$id` or a pointer (`#/$defs/a`): a draft-07 (or undeclared) compile
resolves the `$ref` beside the `$id` against the enclosing base, a 2019-09 or
2020-12 compile against the `$id`. A draft-07 compile resolves such a `$ref`
when a call first reaches it: with nothing held at the URI draft-07 reads, that
call is refused `JK0008` naming it (an instance that does not reach it
answers), and the URI the `$id` names is not needed; `compileAsync` loads the
URI the compile reads, and one its loader cannot serve is refused by that call
too, as `compile` refuses it. *Upgrade: a call that reached such a
reference threw an uncoded `Error` ("…, is not found in init-cache").* *Upgrade: a
draft-07 compile read such an object two ways — a reference to its `$id`
against the enclosing base, a pointer to it against the `$id` — so with both
URIs held the two references answered differently; a pointer now reads what the
`$id` reference reads (with only the URI the `$id` names held it answered, and
it is now refused `JK0008` on the call that reaches it). With only the URI
draft-07 reads held the compilation was refused `JK0009` naming the other, and
it now answers; a loop only the `$id` reading makes (`sub/name.json` holding `{ "$ref":
"…/root.json#/$defs/a" }`) refused a draft-07 compile `JK0001`, and it now answers;
`compileAsync` asked the loader for the URI the `$id` names (`sub/name.json`), and now
asks for the one draft-07 reads (`name.json`).* *Upgrade: the walk that registers a schema resolved such a
`$ref` against the `$id`, so `compileAsync` loaded `sub/name.json` for
`{ "$defs": { "a": { "$id": "sub/a.json", "$ref": "name.json" } }, "$ref":
"sub/a.json" }` and the validator then threw an uncoded `Error` on its first
call, and a pointer to that object (`#/$defs/a`) read `sub/name.json` where
draft-07 reads `name.json` — with only `sub/name.json` held it answered, and
it is now refused `JK0008`.*

## `propertyDependencies` — select a subschema by a member's value

`propertyDependencies` is the
[proposal](https://github.com/json-schema-org/json-schema-spec/blob/main/specs/proposals/propertyDependencies.md)
that replaces the `oneOf`/`if`-`then` ladder for the commonest dispatch: pick the
schema an object must satisfy from the string held by one of its members. It is
not part of 2020-12, so it is **off by default** — an unknown keyword, exactly
as before — and asserts only when the `propertyDependencies` option is set.
While it is off the keyword is not looked into at all: a `$ref`, `$id`, `$anchor`
or `$dynamicAnchor` inside it registers nothing, so a schema written for a
validator that supports it compiles here exactly as it did before.

With the option on it applies to documents of draft 2020-12, to documents that
declare the proposal's own dialect (`https://json-schema.org/draft/next/schema`,
read as 2020-12) and to documents that declare no draft. A document that declares
draft 2019-09 or older, or any `$schema` this package does not recognise (read as
draft-07), keeps ignoring the keyword and does not look into it either; the
`draftVersion` option does not matter, only the declared `$schema`.
*Upgrade: a document that declares `https://json-schema.org/draft/next/schema`
was read as draft-07 for every keyword; it is now read as 2020-12, the draft
next descends from.*

```javascript
const jaren = new JarenValidator({ propertyDependencies: true, collectErrors: true });

const validate = jaren.compile({
  type: 'object',
  required: ['kind'],
  properties: { kind: { type: 'string' } },
  propertyDependencies: {
    kind: {
      circle: { required: ['radius'], properties: { radius: { type: 'number' } } },
      square: { required: ['side'], properties: { side: { type: 'number' } } }
    }
  },
  unevaluatedProperties: false
});

validate({ kind: 'circle', radius: 2 }).valid;   // true
validate({ kind: 'circle', side: 2 }).valid;     // false: required 'radius' is missing
validate({ kind: 'square', side: 2 }).valid;     // true
validate({ kind: 'triangle' }).valid;            // true: no subschema is listed for it
```

When the instance is an object, the outer key is a member of it, that member
holds a **string** and the inner key is equal to that string, the **whole
instance** must validate against the subschema stored there — the keyword reads
as `{ if: { properties: { kind: { const: 'circle' } }, required: ['kind'] }, then: … }`
without evaluating the `if`. A member that is absent or holds any other type
selects nothing, and the lookup is by exact own name, so a value such as
`"toString"` never reaches `Object.prototype`.

It is an in-place applicator like `dependentSchemas`: the matching subschema's
errors are located at the object (`required` at `""`), no error of its own is
added, and the members the subschema evaluated count as evaluated for an
enclosing `unevaluatedProperties` (the example above accepts `radius`). A
subschema that fails contributes no annotations. Without errors collected,
validation stops at the first failing subschema; with `collectErrors` every
selected subschema reports. Subschemas are addressable like any other:
`#/propertyDependencies/kind/circle` is a valid `$ref` target, and an `$id`,
`$anchor` or `$dynamicAnchor` inside one is registered. With the option set, an entry
that is not an object, or a subschema that is not a schema, is a compile error; a
keyword value that is not an object is ignored, as it is for `dependentSchemas`.

## `$query` — cross-field assertions

`$query` is a **Jaren extension keyword**: its value is a
[Jaren JSON Query](../json/docs/QUERY-FORMAT.md) document, compiled once at
schema compile time and evaluated per validation against the current instance
location. The instance is valid when the query result's
[effective boolean value](../json/docs/QUERY-FORMAT.md#22-effective-boolean-value-ebv)
is true. This gives JSON Schema the class of constraint it is notoriously bad
at — cross-field arithmetic, ordering, aggregate consistency, quantification —
through the query engine that already sits underneath the stack. Other
validators treat `$query` as an unknown-keyword annotation, so schemas using
it stay portable; the constraint simply only asserts here.

An invoice whose `total` must equal the sum of its line amounts:

```javascript
const validate = jaren.compile({
  type: 'object',
  properties: {
    lines: { type: 'array', items: { type: 'object' } },
    total: { type: 'number' }
  },
  $query: { $eq: ['$.total', { $sum: '$.lines[*].amount' }] }
});

validate({ lines: [{ amount: 12.5 }, { amount: 7.5 }], total: 20 }); // true
validate({ lines: [{ amount: 12.5 }, { amount: 7.5 }], total: 21 }); // false
```

Date ordering (`$le` compares strings by code points, QUERY-FORMAT §8.4 —
exactly right for ISO dates):

```javascript
jaren.compile({ $query: { $le: ['$.start', '$.end'] } });
```

Quantification over items:

```javascript
jaren.compile({
  $query: { $every: { l: '$.lines[*]' }, $satisfies: { $gt: ['$l.qty', 0] } }
});
```

Two external parameters are bound on every evaluation: `root` — the instance
root — and `path` — the current instance location as a JSON pointer string.
(The JSLT template layer reserves the same two names with one twist: its
matching language is JSONPath, so its `path` is an RFC 9535 *normalized
path*, not a pointer — see [JSLT-FORMAT §8.2](../json/docs/JSLT-FORMAT.md).)
So a subschema can reach across the document:

```javascript
jaren.compile({
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        // every line's currency must match the document-level currency
        $query: { $eq: ['$.currency', '$root.currency'] }
      }
    }
  }
});
```

Semantics and composition:

- `$query` works at **any subschema level** and composes like every other
  keyword: under `properties`/`items` the query's `$` is that location's
  value, `$path` its pointer (`/lines/0`, ...), `$root` the whole document.
- A bare JSONPath string is the degenerate query: `{ "$query": "$.approved" }`
  asserts the **EBV** of that member, not its mere existence: existence would
  let `$.approved` pass on a literal `false`, exactly the case the constraint
  means to reject (missing → empty sequence → false either way).
- `$query` is a **validation keyword**, so under 2019-09 and 2020-12 it
  asserts as a sibling of `$ref` (both apply together). Under draft-07 the
  `$ref`-overrides-siblings rule stands, so a `$query` written beside a `$ref`
  is ignored on that node.
- Query **runtime** errors that judge the instance (`JQ2001` to `JQ2005` and
  `JQ2008` — e.g. arithmetic on a non-number, the EBV of a multi-item result,
  an item a schema literal rejects) are validation **failures**; in
  `collectErrors` mode the error params carry the `code` and the query
  `docPath`. Every other runtime refusal is thrown, never reported as a
  failure that `not` would turn into success: it decides nothing about the
  instance. These are the execution limits — `JQ2009`, a descendant segment
  (`$..`) over a value nested deeper than 1000 levels, and `JQ2007`, a
  `$range` materializing more than 1,000,000 items. *Upgrade: the deep
  instance overflowed the call stack with an uncoded `RangeError`; the long
  `$range` reported a failure, so `not` answered `true`.* Malformed query
  documents and free externals other than `root`/`path` fail fast at
  `compile()`.
- Schema literals inside the query (`$valid`/`$assert`/`$as`,
  QUERY-FORMAT §8.11) compile against the **same validator instance**, so
  their `$ref`s resolve to your `addSchema` registrations. The bridge
  (`createTypeTestCompiler`) accepts nothing (a fresh default instance), a
  `JarenValidator` instance, or a zero-arg factory, and probes the compiled
  validator's return shape **once per schema literal** — so even a
  `collectErrors` instance is unwrapped into a boolean predicate.

A schema literal in `$query` has its own document scope; its local `$ref`s do
not reach the enclosing schema's `$defs`. Register shared schema documents with
`addSchema` and reference their IDs. Recursive compilation through such a query
literal is refused at compile time instead of repeatedly opening another root;
ordinary recursive `$ref` validation remains supported.

## Compatibility settings

Eight options decide answers that differ between validators, between JSON
Schema drafts, or between Jaren and the library you are migrating from. Each
one is a deliberate default, and each one is worth setting explicitly in a
shared factory rather than inheriting.

| Option | Default | What it decides |
|---|---|---|
| `collectErrors` | `false` | Whether the compiled validator returns a boolean or `{ valid, errors }` |
| `skipErrors` | `!collectErrors` | Whether validation stops at the first failure |
| `useGrapheme` | **`true`** | Whether `minLength`/`maxLength` count grapheme clusters or UTF-16 code units |
| `formatAssertion` | auto by draft | Whether `format` asserts or only annotates |
| `contentValidation` | auto by draft | Whether `contentEncoding`/`contentMediaType` assert |
| `propertyDependencies` | **`false`** | Whether the proposed `propertyDependencies` keyword asserts or is an unknown keyword |
| `relativePointerDialect` | **`'handrews-01'`** | Which Relative JSON Pointer grammar `data`, `$data` and the `relative-json-pointer` format speak; `'bhutton-00'` also accepts index manipulation (`0+1`, `1-1/name`, `0-1#`) |
| `maxReferenceDepth` | **`256`** | How many schema references one validation may nest before it throws `JK2001`; fixed by default so every host answers alike, raising it lets the host's call stack decide again |

### The return shape is `collectErrors`

`collectErrors` is the switch between the two default return shapes, and it is
off by default (the `outputFormat` option replaces both with a JSON Schema
standard output; see [Standard output formats](#standard-output-formats)):

```javascript
new JarenValidator().compile(schema)(data);
// => true | false

new JarenValidator({ collectErrors: true }).compile(schema)(data);
// => { valid: false, errors: [ /* ValidationError */ ] }
```

In TypeScript the collect-mode result is discriminated by `valid`:
`{ valid: true, errors: [] }` or `{ valid: false, errors: ValidationError[] }`.
It carries no copy of the data, so it cannot narrow the data's type. The
collector's `narrow(data)` answers the same validation with the data itself as
`value` on the valid branch, typed by the `T` of `compile<T>(schema)`, so one
call gives both the errors and the narrowed data:

```typescript
const check = new JarenValidator({ collectErrors: true }).compile<User>(userSchema);
const result = check.narrow(input);
if (result.valid) save(result.value);       // result.value is User
else repair(result.errors);                 // ValidationError[]
```

The plain call's answer is unchanged, and a caller that does not use `narrow`
pays nothing for it; the boolean mode's `compile<T>(schema)` is itself the
`data is T` type guard. *Upgrade: the result used to type `valid` as `boolean`,
with `ValidationError[]` on either branch; `CompiledCollector` now takes the
`T` of the compile (`CompiledCollector<T>`, default `unknown`).*

Setting `collectErrors: true` implies `skipErrors: false` (collecting errors
means recording them), so you do not need to set both. Set `skipErrors`
yourself only to keep first-failure short-circuiting while still collecting.

Read errors from the returned object. The `JarenValidator` instance has no
`errors` property. A compiled function retains a legacy `errors` getter exposing
its internal last-call diagnostics; that getter is not the public
`ValidationError[]` result and should not be used as a request's error record.

Each `ValidationError` carries six fields:

```javascript
{
  keyword: 'format',                 // the JSON Schema keyword that failed
  instancePath: '/email',            // RFC 6901 JSON Pointer into the DATA
  schemaPath: 'https://…#/properties/email',  // absolute URI into the SCHEMA
  params: { format: 'email' },       // raw structured values, never prose
  msgid: 'format',                   // stable catalog key for i18n
  message: 'must match format "email"'
}
```

Two notes for anyone diffing this against another validator's output. The
data location is `instancePath`, a **JSON Pointer string** — not the dotted
`dataPath` of Ajv v6, and not an array path. `parseJSONPointerPath` from
[`@jarenjs/json`](../json/README.md) converts it to the `(string|number)[]`
path shape that Zod's `issue.path` and most diffing tools use, narrowing
canonical array indexes to numbers:

```javascript
import { parseJSONPointerPath } from '@jarenjs/json';

parseJSONPointerPath('/items/0/id');   // ['items', 0, 'id']
```

And for `additionalProperties: false`, Jaren points `instancePath` at the
offending member (`/nested/extra`) where Ajv points at the parent object —
deliberate, and spec-truer.

`allOf` keeps its branches' errors, because every branch must hold, so a branch that fails deep inside reports its own fault and then one `allOf` error at the schema that holds the keyword, once per failing branch. A `false` branch reports nothing but that wrapper, so dropping every `allOf` error would hide it. A consumer that wants one issue per fault drops a wrapper only when an error from one of its own branches was reported since the previous wrapper at that location:

```javascript
const withoutWrappers = (errors) => errors.filter((e, i) => {
  if (e.keyword !== 'allOf') return true;
  let from = i;
  while (from > 0 && !(errors[from - 1].keyword === 'allOf'
    && errors[from - 1].schemaPath === e.schemaPath
    && errors[from - 1].instancePath === e.instancePath)) from--;
  return !errors.slice(from, i).some((x) => x.schemaPath.startsWith(`${e.schemaPath}/allOf/`));
});
```

It never hides the only trace of a failure; a branch reached through `$ref` reports under the referenced schema, so its wrapper is kept as well.

A member name is one pointer token, so `/` and `~` inside it are escaped as
`~1` and `~0`: the member `a/b` is `/a~1b`, and a relative `$data` reference
walks back up from that same escaped location. *Upgrade: these names used to
appear unescaped (`/a/b`), which read as two nested members and made a
`$data` reference from such a member resolve against the wrong location.*

A subschema's errors, and any relative `$data` reference inside it, are located
at the instance the subschema applies to. `dependentSchemas`, `propertyDependencies`
and the schema form of draft 7 `dependencies` apply to the object that holds the
trigger member, so their errors sit at that object (`required` at `""`, not at `/x`);
the schema form of `unevaluatedProperties` and `unevaluatedItems` applies to
each leftover member or item, so its errors sit there. A failed draft 7 array
`dependencies` entry reports the keyword `dependencies`. `dependentRequired` and
the array form of `dependencies` name a member that must exist beside the trigger
member and no subschema runs, so they keep reporting the trigger member's
location (`/x`), like `required` and `additionalProperties` do for the member
they name. *Upgrade: these used
the trigger member's location (or the parent's, for unevaluated members), so a
`$data` reference inside such a subschema resolved against the wrong place, and
the array form reported the dependent member's name as its keyword.*

An `unevaluatedProperties` or `unevaluatedItems` failure names the member in its
`params` (`unevaluatedProperty`, the member name; `unevaluatedItem`, the index), while
its `instancePath` stays at the object or array that holds it (`additionalProperties`
reports at the member). That is the JSON Schema reading: the keyword applies to the object
or array, over what the other keywords left unevaluated, so its result belongs to that
instance, and the leftover members are what it found there. The schema form is the one
place a member is applied to:
what its subschema finds wrong in a member sits at the member (`type` at `/q`) beside
the keyword's own failure at the holder (`unevaluatedProperties` at `""`). A consumer that
wants the member's location joins the holder's `instancePath` and the member from
`params` (as one pointer token: `/` and `~` escaped). *Upgrade: `params` used to be empty, so two failing members read alike.*

Collected errors carry what every keyword found. Beside a failed sibling,
`unevaluatedProperties` and `unevaluatedItems` still report the members and
items nothing evaluated (`{ "properties": { "a": { "type": "string" } },
"unevaluatedProperties": false }` on `{ "a": 1, "x": 1 }` reports `type` at
`/a` and `unevaluatedProperties` naming `x`); a member a sibling matched counts
as evaluated even when its subschema failed, so it is reported once, by that
sibling. Every failing `$data` and `data` keyword reports its own error, and
the item walk reports failing items past `maxItems`. The recording output
formats (`basic`, `detailed`, `verbose`, `list`, `hierarchical`) record the
same units. The answer is the boolean mode answer in every case, and `flag`
output is unchanged. *Upgrade: a failed sibling silenced
`unevaluatedProperties`/`unevaluatedItems`, collection stopped at the first
failing `$data`/`data` keyword, and the item walk stopped at `maxItems` (where
a `contains` that only an item past it matched also reported a `contains`
failure), so the collected error lists and the output formats' error units,
and their counts, grow; `verbose` used to list such an `unevaluatedProperties`,
`unevaluatedItems` or `$data` keyword unit as passing.*

A reference from `items`, `prefixItems` or a tuple form back to a schema that is
still being compiled (`{ "type": "array", "items": { "$ref": "#" } }`, or a cycle through
two definitions) resolves when it is first used, like every other recursive `$ref`.
*Upgrade: compiling it built the enclosing schema again until the call stack ran out,
which took milliseconds and, in collecting mode, threw `Object at '…#/items' is already created`.*

An inconsistent count pair (`minItems` above `maxItems`, `minProperties` above
`maxProperties`) compiles, like a `minimum` above a `maximum`, and no instance of that
type passes it; inside a `not` or an `anyOf` branch it is satisfiable. *Upgrade: it was a
compile error.*

A schema whose `$ref` leads back to itself without reading the instance is refused when
the schema is compiled, with a `SchemaCompileError` whose `code` is `JK0001`. A reference
to itself (`{ "$ref": "#" }`, with or without siblings,
`{ "properties": { "a": { "$ref": "#/properties/a" } } }`, or a `$defs` entry that refers to
itself) fails with `JK0001: $ref cycle: <id> refers to itself and never reads the instance`;
a ring of definitions fails naming every hop, `JK0001: $ref cycle: <a> -> <b> -> <a> never
reads the instance`, whether or not anything refers to the ring. A ring of top-level
registrations is refused by `addSchema`, where the second member is added; a ring inside
a registered document is refused when something compiled reaches it, and does not affect
other compiles. In a document that declares no draft, a ring only one reading makes (an
`$id` beside a `$ref` sets its base from 2019-09 on, not before) is refused by the
compile that reads it so, not by `addSchema`. *Upgrade: `addSchema` refused a ring only
the 2019-09 reading made, so a document registered after another closed it was refused
although a draft-07 compile over them answered (registered in the other order, it
already did).* *Upgrade: a reference to itself used to overflow the call stack when it validated, and a
loop through other references compiled to the empty schema and answered `true`; the
refusal was a plain `Error` whose message began `$ref cycle:`.*
A root schema is refused the same way when the loop runs through the in-place applicator
it evaluates first on every instance: `{ "allOf": [{ "$ref": "#" }] }` fails with
`JK0001: $ref cycle: <id># -> <id>#/allOf/0 -> <id># never reads the instance`
(the rule is in [ERROR-MESSAGES.md §9](docs/ERROR-MESSAGES.md#9-coded-refusals)).
*Upgrade: it compiled, and every validation overflowed the call stack.* A loop that only
some instances reach still compiles and answers every instance that does not reach it —
`{ "anyOf": [{ "type": "string" }, { "$ref": "#" }] }` accepts `"a"` — and a reference that
passes through `properties`, `items` or another applicator that descends into the
instance before it comes back is recursion and is unchanged.

Documents can be added in any order: a resource embedded in one
(`$defs: { e: { $id: 'https://x.test/e.json' } }`) is found by a reference
that a document added before it makes. *Upgrade: such a reference used to stay
unresolved, and compiling failed `Can not resolve schema for
'https://x.test/e.json#'`.* A place `addSchema` cannot register — an `$id` or a
`$ref` that is no URI reference, an identifier the document declares twice — does
not end the registration: the rest of the document is registered, the compile that
reads the place refuses it (`JK0010`), what lies below a refused identifier is not
registered, and an identifier declared twice keeps its first place (a schema being
compiled that declares one twice is refused `JK0012`, below); a ring of
references in such a document is refused by the compile that reaches it (`JK0001`),
not by `addSchema`, so what else it holds answers. *Upgrade: the registration ended at
such a place, so a compile naming an identifier declared after it was refused `JK0009`
naming that identifier.*

A reference that resolves to no schema the validator holds — a document nothing
registered or loaded, or a pointer that misses in a held one — is refused with a
`SchemaCompileError` whose `code` is `JK0009`, naming the reference and the repair:
`compile({ "$ref": "nope.json" })` fails with `JK0009: Can not resolve schema for
'https://github.com/jklarenbeek/nope.json#': no schema the validator holds has that URI;
register it with addSchema, load it with compileAsync, or fix the reference`, and
`{ "$ref": "#/$defs/missing" }` with `…: '/$defs' is not a schema in
'https://github.com/jklarenbeek/jarenjs#'; fix the pointer`. It is refused where it was
refused before: when the schema compiles, or, for a reference resolved on first use, by
the first call that reaches it. *Upgrade: these were plain `Error`s whose messages read
`Can not resolve schema for '<uri>'`, `The root of reference: '$ref': '<uri>', is not
found in init-cache` and `The '<pointer>' is not a valid schema in '<uri>'`; the message
now begins with the code and ends with the repair.*

A `$dynamicRef` or `$recursiveRef` whose target nothing resolves — a document
nothing holds, a pointer that misses, an anchor no schema declares
(`"$dynamicRef": "#nope"`) — is refused `JK0009` the same way by the first call that
reaches it; an instance that does not reach it answers (an output format runs every
branch, so there every instance that reaches the applicator reaches it). *Upgrade: such
a reference answered `false` on every instance that reached it, so `not` around it
answered `true` for everything; a `$recursiveRef` other than `"#"` answered `true`; and
`"$dynamicRef": "#nope"` was refused `JK0001` as a loop that never reads the instance.*

`$recursiveRef` is a keyword where the document declares 2019-09 and `$dynamicRef`
where it declares 2020-12; in a document that declares another draft each is an unknown
keyword, which applies nothing whatever its value; a document that declares no
draft reads both, and so does one whose `$schema` names no draft this package knows
(a vocabulary metaschema, OpenAPI 3.1's dialect), which the other declared-draft gates
read as draft-07. *Upgrade: `{ "$schema": "https://json-schema.org/draft/2020-12/schema",
"type": "object", "properties": { "p": { "$recursiveRef": "#" } } }` applied the root to
`p` and rejected `{ "p": 1 }`; a value nothing resolves was refused `JK0009` (`JK0010`
when no URI) and a root `"$recursiveRef": "#"` `JK0001`; a `$ref` beside it in 2020-12
asserted the root too; a `$dynamicRef` in a draft-07 or 2019-09 document applied its
target the same way.*

2019-09 defines `$recursiveRef` only as `"#"` and lets another value be an error: read
as 2019-09 (the place's `$schema`, or the compile's), another value is refused
`JK0011` by the call that reaches it, naming the `$ref` that applies the schema it
names: `{ "$recursiveRef": "#/$defs/x" }` under `properties.a` fails with `JK0011:
$recursiveRef '#/$defs/x' is defined only as "#"; to apply the schema it names, write
$ref '#/$defs/x' at <uri>#/properties/a/%24recursiveRef`. A document that declares no
draft, compiled as another draft, applies nothing for a value that names a held schema,
and refuses one nothing resolves `JK0009`. *Upgrade: read as 2019-09 such a value applied nothing (with
`$defs: { x: { type: 'string' } }`, `{ a: 1 }` answered `true`), or was refused `JK0009`
or `JK0010` with a repair that led there.*

A `$ref`, `$dynamicRef`, `$recursiveRef` or `$id` (`id`) that is no valid URI reference —
`http://[x`, a port past 65535 — is refused `JK0010`, naming the keyword, the text and
where it sits: `compile({ "$ref": "http://[x" })` fails with `JK0010: $ref 'http://[x' is
not a valid URI reference; correct it, percent-encoding any character a URI does not
allow at #/%24ref`. It is refused where the text is read: when the schema compiles, by
the first call that builds a registered document's subschema holding it, and, for a
`$recursiveRef` other than `"#"` in a document that declares no draft, by the call that
reaches it (read as 2019-09 it is `JK0011`). *Upgrade: these threw an
uncoded `TypeError` (`ERR_INVALID_URL`, `Invalid URL`); a malformed `$recursiveRef`
answered `true`.*

An identifier (`$id`, `$anchor`, `$dynamicAnchor`) names one schema. A schema being
compiled that declares one twice, or declares one that already names another schema
the validator holds, is refused `JK0012` when it compiles, naming both places:
`compile({ "$defs": { "a": { "$id": "x.json" }, "b": { "$id": "x.json" } } })` fails with
`JK0012: 'https://github.com/jklarenbeek/x.json#' is declared twice (first at
'#/%24defs/a/%24id'); give one of them another name at #/%24defs/b/%24id`. A document
registered with `addSchema` keeps the first place, as above. Where `TraverseOptions`
does not allow anchors, an `$anchor` or `$dynamicAnchor` declares nothing. *Upgrade:
these threw an uncoded `Error` ("Schema '…' for path '…' in '…' already exists"), as did
every `$anchor` below the root where anchors are not allowed.*

One validation nests at most 256 schema references (a `$ref` resolved on first use, a
`$dynamicRef` or a `$recursiveRef`); one more throws a `SchemaRuntimeError` whose `code`
is `JK2001`, naming the reference, before the host's call stack can overflow. The
`maxReferenceDepth` option moves the bound (`new JarenValidator({ maxReferenceDepth: 2000 })`,
which also bounds `validateSchema`); a value that is not a positive safe integer is refused
`JK0002` when a schema compiles. The default is fixed so the answer is the same on every
host; raising it lets the host's call stack decide again. Every
recursion passes such a reference, so the bound refuses an instance nested deeper than
the schema follows (an array 257 levels deep against `{ "items": { "$ref": "#" } }`) and an
instance that reaches a loop never reading it (`1` against the `anyOf` above). It throws
rather than failing, because a `false` under `not` would read as success. *Upgrade: such
an instance overflowed the call stack with an uncoded `RangeError`, and an instance
nested between the bound and the host's stack limit used to validate, and validates again
with `maxReferenceDepth` raised; the default is fixed so the answer is the same on every
host.*

An uncompilable reference in the `data` keyword (`{ "data": { "minimum": "abc" } }`) is
refused when the schema is compiled, as it is for `$data`. *Upgrade: the keyword compiled
and never asserted, so a document that should have failed passed.*

The default (first-failure) validator and the collecting one answer alike for a
one-keyword item schema. *Upgrade: in the default mode `items`/`prefixItems`
with an array-form `type` (`{ "type": ["string"] }`) accepted any item, a
`required` item schema counted inherited names such as `toString` as present,
and a `$data` `required` there asserted nothing; an item schema whose only
keyword is a `type` word the validator does not know, such as
`{ "items": { "type": "strin" } }`, used to accept every item and is now
refused when the schema is compiled, like the same schema in the collecting
mode.* The one-keyword `required` shortcut treats a member inherited from a
custom prototype as present, except for the names every object inherits
(`toString`, `constructor`, ...), which must be own members. A member named `constructor`
is data wherever it appears, so a `$defs` entry of that name is usable and a
missing `$ref` target beside a `constructor` property is refused at compile
time like any other. An unknown type name in a `type` list is refused naming
the type and the list.

**Collected errors are exhaustive across independent keywords.** Every
keyword that can fail independently reports its own fault, rather than the
first failure hiding the rest: keyword groups on one node (`enum` beside
`minLength`), `minProperties` beside `required`, a numeric bound beside
`multipleOf`, `minItems` beside `uniqueItems` and beside failing items, every
`allOf` branch, independent applicator groups, and every absent `required`
property. Boolean mode still stops at the first failure — that is the whole
point of it — so the two modes deliberately differ in how much work they do:

```javascript
const contract = {
  type: 'object',
  properties: { slug: { type: 'string', minLength: 3, pattern: '^[a-z]+$' } },
  required: ['name', 'slug'],
};

collecting.compile(contract)({ slug: '!' }).errors;
// required at '', minLength at '/slug', pattern at '/slug'  — three issues
```

**A speculative applicator never reports.** An `anyOf`/`oneOf` branch that was
not the one that matched, the subschema of a `not`, an `if` condition, and a
`contains` candidate that is not the match are all probes — the document was
never required to satisfy them, so their failures are rolled back rather than
handed to your caller. What survives is what genuinely explains the failure:
if *no* `anyOf` branch matched, every branch's errors are kept, because then
they are the reason.

```javascript
collecting.compile({
  type: 'string', minLength: 5,
  anyOf: [{ type: 'number' }, { type: 'string' }],
})('x').errors;
// [minLength]  — not a type error from the number branch that was never required
```

A `required` error points at the **owning object**, not at the absent member
(there is no location for something that is not there); the missing name is in
`params.missingProperty`, which is what an adapter appends to build a
Zod-style path.

### String lengths count graphemes by default

`useGrapheme` defaults to **`true`**, so `minLength`/`maxLength` count
user-perceived characters. Setting it to `false` makes this package count
UTF-16 code units instead:

```javascript
const family = '👨‍👩‍👧‍👦';   // 1 grapheme cluster, 11 UTF-16 code units

new JarenValidator().compile({ type: 'string', maxLength: 2 })(family);
// => true   (1 grapheme)

new JarenValidator({ useGrapheme: false })
  .compile({ type: 'string', maxLength: 2 })(family);
// => false  (11 code units)
```

**If you are migrating from a validator that counts code units, set
`useGrapheme: false`,** or strings containing emoji, combining marks, flags
or astral-plane characters will silently change validity at the boundaries.
Grapheme mode is not expensive — ASCII takes a `str.length` fast path (a CR LF
pair counted as the one cluster it is) and most Unicode takes a code-point
count; only cluster-forming strings reach `Intl.Segmenter` — so the default is
about correctness, not speed, and switching to it later is a product decision
rather than a performance one. Upgrade note: CR LF counts as one grapheme in
the default mode, so a browser textarea value with line breaks is one
character shorter per break than it was read before (`'a\r\nb'` has length 3,
not 4, against `maxLength: 3`); `useGrapheme: false` still counts both code units.

### `format` and content assertion follow the draft

Both are annotation-only in the drafts that say so, and both take an explicit
override:

- **`format`** asserts through draft 2019-09 and is annotation-only from
  draft 2020-12 on, per spec. It also turns on automatically when the
  schema's meta-schema declares the `format-assertion` vocabulary.
- **`contentEncoding`/`contentMediaType`** assert through draft-07 and are
  annotation-only from 2019-09 on.

```javascript
const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema',
                 type: 'string', format: 'email' };

new JarenValidator().addFormats(formats.stringFormats)
  .compile(schema)('nope');                       // => true  (annotation only)

new JarenValidator({ formatAssertion: true }).addFormats(formats.stringFormats)
  .compile(schema)('nope');                       // => false (asserted)
```

### Formats are never registered implicitly — and an unregistered one is an error

`@jarenjs/validate` does not depend on `@jarenjs/formats`, so a fresh
validator has an **empty format registry**. Registering the groups you use is
the whole setup:

```javascript
import * as formats from '@jarenjs/formats';

const jaren = new JarenValidator()
  .addFormats(formats.stringFormats)     // email, uri, uuid, hostname, iban, ...
  .addFormats(formats.dateTimeFormats)   // date-time, date, time, duration
  .addFormats(formats.numberFormats)     // int32, double, decimal, ...
  .addFormats(formats.jsonFormats)       // json-pointer, json-path, regex, ...
  .addFormats(formats.geoFormats);       // geohash, lat-long, ...
```

**An unregistered format name asserts nothing, and by default says nothing** —
that is the specification's rule ("implementations MUST NOT fail validation or
cease processing due to an unknown format attribute"), and it is the default
because a library has to be able to compile a schema it did not write. The
cost is a real trap: a `format: 'date-time'` you believed was checking
timestamps, checking nothing, and looking exactly like one that works.

**`unknownFormats: 'error'` turns that into a compile-time throw.** Set it for
schemas you own:

```javascript
new JarenValidator({ unknownFormats: 'error' })
  .compile({ type: 'string', format: 'date-time' });
// => Error: Unknown format 'date-time': no compiler is registered for it,
//    so this schema would accept every value for that keyword. Register one
//    (addFormats(dateTimeFormats) …), or pass { unknownFormats: 'ignore' } …
```

Instance validation is untouched either way — **no data is ever invalidated by
an unknown format**, so `'error'` stays inside the specification's letter: it
reports to the schema's *author*, at compile time, where a missing
registration is a fact about the setup rather than about the data. The
official suite's `optional/format/unknown.json` (unknown format, assertion
forced on, everything must validate) passes on the default and is the one
thing `'error'` would fail, which is why it is opt-in.

This repository sets `'error'` for every schema it ships, and a gate
(`test/validate/our-schema-formats.test.js`) fails if any of them names a
format `@jarenjs/formats` does not implement. It is worth copying: the
published `jaren-query` grammar declared `format: "json-path"` from the day it
was written, nothing that compiled it registered `jsonFormats`, and so no path
string was ever checked by that keyword. Nothing failed. That is the shape of
this bug.

Where **not** to reach for `'error'`: a schema a user hands you. Refusing to
compile a stranger's valid schema over a format you happen not to implement is
your problem presented as theirs — this repo keeps the default for the
validator playground's input and for project files in the studio, and uses
`'error'` only for its own grammars. A portable schema may put a `pattern` beside an annotation-only `format` to enforce its lexical constraint without requiring a format registry.

Two things `'error'` deliberately leaves alone. It does not fire where
`format` is annotation-only anyway (draft 2020-12 without the format-assertion
vocabulary) — nothing is lost there, so there is nothing to report. And
**meta-schemas** are exempt: every JSON Schema meta-schema declares
`format: "uri-reference"` on `$id`, and nobody registers formats in order to
check that a *schema* is well-formed, so `addMetaSchema` compiles with
`unknownFormats: 'ignore'` regardless.

Registering a format with something that is **not a compiler** throws under
either setting, because that mistake is never intentional:

```javascript
new JarenValidator().addFormats(formats.formatTesters)   // testers, not compilers
  .compile({ type: 'string', format: 'email' });
// => Error: Format 'email' failed to compile: … Register the format COMPILERS
//    (stringFormats, dateTimeFormats, …) rather than the raw testers.
```

`formatTesters` and `stringFormats` are both objects full of functions, so the
mistake registers cleanly and then checks nothing. Only the **compilers** take
`(schemaObj, jsonSchema)` and return the per-value validator.

Registration never overwrites an existing name, so register your own
overrides *before* a bundled group if you want them to win.

### Recipe: migrating from Zod

Zod counts UTF-16 code units, always reports every issue, and always
asserts formats. This factory reproduces those three answers:

```javascript
import { JarenValidator } from '@jarenjs/validate';
import * as formats from '@jarenjs/formats';

export const jaren = new JarenValidator({
  collectErrors: true,     // { valid, errors } instead of a boolean
  useGrapheme: false,      // UTF-16 code units, like Zod's .min()/.max()
  formatAssertion: true,   // assert format even under draft 2020-12
  contentValidation: true, // assert contentEncoding/contentMediaType
})
  .addFormats(formats.stringFormats)
  .addFormats(formats.dateTimeFormats);
```

What this recipe does **not** give you is Zod's output normalization: a
compiled validator is a pure predicate and never modifies its input. That
boundary does not move — but the normalization itself ships beside it, as a
separately compiled pass. See [Normalization](#normalization) below.

## Loading referenced schemas

`compile` resolves a `$ref` only to a document the validator already holds.
When the documents live elsewhere — on a schema registry, in a database, in
files a tool call names — `compileAsync` from `@jarenjs/validate/load` loads
them first. It walks the schema for the documents its `$ref` and
`$dynamicRef` targets live in, asks the host's `loadSchema(uri)` for each one
the validator does not hold, registers it with `addSchema`, walks what it
loaded the same way, and then compiles with `compile` — so the validator it
returns is the one `compile` returns over the same documents added
beforehand:

```javascript
import { JarenValidator } from '@jarenjs/validate';
import { compileAsync } from '@jarenjs/validate/load';

// The host's documents, by URI (an HTTP fetch or a database read works the same).
const documents = {
  'https://schemas.example.com/person.json': {
    type: 'object',
    properties: {
      name: { $ref: 'name.json' },
      friends: { type: 'array', items: { $ref: '#' } },
    },
    required: ['name'],
  },
  'https://schemas.example.com/name.json': { type: 'string', minLength: 1 },
};

const validator = new JarenValidator();
const validate = await compileAsync(validator,
  { $ref: 'https://schemas.example.com/person.json' },
  { loadSchema: async (uri) => documents[uri] });

validate({ name: 'Ada', friends: [{ name: 'Alan' }] }); // true
validate({ name: 'Ada', friends: [{ name: '' }] });     // false: name.json needs one character
validator.getSchema('https://schemas.example.com/name.json') === documents['https://schemas.example.com/name.json']; // true: it stays added
```

- **What it loads.** The document a reference names: `loadSchema` is called
  with an absolute URI without its fragment (`name.json#/$defs/x` loads
  `name.json`), resolved against the `$id` the reference sits under — in a
  loaded document, against the URI it was loaded from. A schema without an
  `$id` sits under the validator's base, `https://github.com/jklarenbeek/jarenjs`
  unless the host names another, so its `{ "$ref": "name.json" }` asks for
  `https://github.com/jklarenbeek/name.json`: give the schema an `$id`, or
  the validator a base, to name what its relative references resolve
  against (`new JarenValidator({ traverse: new TraverseOptions('https://schemas.example.com/root.json') })`
  asks for `https://schemas.example.com/name.json`). A load refusal for a
  URI under the default base says so and names both repairs. Also the meta-schema
  a schema's `$schema` names, unless that is a json-schema.org dialect (the
  validator implements those itself), because `compile` reads its
  `$vocabulary`; and what a schema the validator already held references and
  nothing holds, since `compile` resolves those too. A schema whose
  references the validator all holds loads nothing.
- **Once each.** A document is loaded at most once per validator: several
  references to it, in one call or in calls running at the same time, wait
  on the same load. A loaded document stays added, so a later compile finds
  it held. A load that failed is not remembered; the next call asks again.
  A cycle of references between documents ends, since a document already
  reached is not walked again.
- **Whichever load settles first.** The documents found together are loaded
  together, and registered and walked in the order they were found once
  all of them settled, so what a call loads and answers never depends on
  the loader's timing: a reference into a resource another loaded document
  embeds is held, and a load that failed is no refusal when a document
  loaded beside it or after it embeds what it was asked for. `maxLoads`
  counts the loads the call itself asks its loader for, not one it waits
  on for another call. *Upgrade: such a call used to refuse `JK0004` or
  `JK0006`, or compile, depending on which load settled first.*
- **What `loadSchema` returns.** The parsed document — an object or a
  boolean — or a promise of it. Its JSON text is not a schema: parse it
  first.
- **Refusals.** A loader that throws or rejects refuses with `JK0004` (its
  error kept as `cause`), something that is not a schema with `JK0005`, a
  call that needs more than `maxLoads` documents (default 100) with
  `JK0006`, and an argument `compileAsync` does not take with `JK0007`.
  Each load refusal names the URI and, as `docPath`, the reference that
  needed it ([ERROR-MESSAGES §9](docs/ERROR-MESSAGES.md#9-coded-refusals)).
  A loaded document is registered as `addSchema` registers it: it is not
  validated against a meta-schema.

`compileAsync` lives behind its own subpath, so a validator that never loads
a schema ships none of its code.

## Standard output formats

The `outputFormat` option makes a compiled validator return one of the
output formats JSON Schema publishes, instead of a boolean or
`{ valid, errors }`. The formats are exported by `@jarenjs/validate/output`,
and the option takes one of them: a validator that is given none never
loads that module, so an application that does not use them ships none of
their code. Apart from `flag`, each one locates every failure (and, for a
passing instance, every annotation) twice: along the evaluation, through
every `$ref`, and at the absolute location of the schema that holds it.

| `outputFormat` | Specification | Shape |
|---|---|---|
| `flagOutput` | both | `{ valid }`, from the boolean validator |
| `basicOutput` | JSON Schema 2020-12 Core §12 | the units that carry an `error` or an `annotation`, and the branch units of a failure, flat |
| `detailedOutput` | JSON Schema 2020-12 Core §12 | those units nested by the schema, condensed |
| `verboseOutput` | JSON Schema 2020-12 Core §12 | every keyword the validator evaluates in every applied subschema, nested |
| `listOutput` | the output specification that followed 2020-12 | the units that carry `errors` or `annotations`, flat under `details` |
| `hierarchicalOutput` | the output specification that followed 2020-12 | every applied subschema, nested under `details` |

The two specifications name their units differently, and each format uses
its own specification's names. The 2020-12 formats have one unit per keyword:
`keywordLocation` (the path through `$ref` hops), `absoluteKeywordLocation`
(the keyword's absolute URI, present once the evaluation passed a reference),
`instanceLocation`, and a singular `error` or `annotation`, with nested
results under `errors` or `annotations`. `list` and `hierarchical` have one
unit per subschema: `evaluationPath`, `schemaLocation` (the subschema's
absolute URI with a JSON Pointer fragment, never an anchor name),
`instanceLocation`, `errors` and `annotations` as objects keyed by keyword,
and nested results under `details`. The value is checked when a schema
compiles: anything but a format of `@jarenjs/validate/output` (a format's
name as a string included) is refused `JK0003`, naming the subpath (a
misspelled option name is ignored, like any unknown option).

A schema, an instance:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/order",
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "lines": { "type": "array", "items": { "$ref": "#/$defs/line" } }
  },
  "required": ["id"],
  "$defs": {
    "line": {
      "type": "object",
      "properties": { "qty": { "type": "integer", "minimum": 1 } },
      "required": ["sku"]
    }
  }
}
```

```json
{ "lines": [{ "sku": "a", "qty": 0 }, { "qty": 2 }] }
```

```javascript
import { JarenValidator } from '@jarenjs/validate';
import { listOutput } from '@jarenjs/validate/output';

// orderSchema and order are the two documents above
const validate = new JarenValidator({ outputFormat: listOutput }).compile(orderSchema);
validate(order);
```

returns:

```json
{
  "valid": false,
  "details": [
    {
      "valid": false,
      "evaluationPath": "",
      "schemaLocation": "https://example.com/order#",
      "instanceLocation": "",
      "errors": { "required": "must have required property 'id'" },
      "droppedAnnotations": { "properties": ["lines"] }
    },
    {
      "valid": false,
      "evaluationPath": "/properties/lines/items/$ref/properties/qty",
      "schemaLocation": "https://example.com/order#/$defs/line/properties/qty",
      "instanceLocation": "/lines/0/qty",
      "errors": { "minimum": "must be >= 1" }
    },
    {
      "valid": false,
      "evaluationPath": "/properties/lines/items/$ref",
      "schemaLocation": "https://example.com/order#/$defs/line",
      "instanceLocation": "/lines/1",
      "errors": { "required": "must have required property 'sku'" },
      "droppedAnnotations": { "properties": ["qty"] }
    }
  ]
}
```

and with `outputFormat: basicOutput`:

```json
{
  "valid": false,
  "errors": [
    {
      "valid": false,
      "keywordLocation": "",
      "instanceLocation": "",
      "error": "A subschema had errors."
    },
    {
      "valid": false,
      "keywordLocation": "/properties/lines/items",
      "instanceLocation": "/lines",
      "error": "A subschema had errors."
    },
    {
      "valid": false,
      "keywordLocation": "/properties/lines/items/$ref/properties/qty/minimum",
      "absoluteKeywordLocation": "https://example.com/order#/$defs/line/properties/qty/minimum",
      "instanceLocation": "/lines/0/qty",
      "error": "must be >= 1"
    },
    {
      "valid": false,
      "keywordLocation": "/properties/lines/items/$ref/required",
      "absoluteKeywordLocation": "https://example.com/order#/$defs/line/required",
      "instanceLocation": "/lines/1",
      "error": "must have required property 'sku'"
    },
    {
      "valid": false,
      "keywordLocation": "/required",
      "instanceLocation": "",
      "error": "must have required property 'id'"
    }
  ]
}
```

What the units say:

- **Annotations survive only where the specification keeps them**: on a unit
  that passed, inside units that all passed. A failed unit carries the
  annotations its own keywords produced as `droppedAnnotations` (`list` and
  `hierarchical`); a passing unit inside a failed one carries none. The
  annotations are the keywords' values (`title`, `description`, `default`,
  `deprecated`, `readOnly`, `writeOnly`, `examples`, `format`, and the
  `content*` keywords on a string), the member names `properties`,
  `patternProperties`, `additionalProperties` and `unevaluatedProperties`
  applied to, the indexes `contains` matched, and the largest index or `true`
  of `prefixItems`, `items`, `additionalItems` and `unevaluatedItems`.
  Unknown keywords are not reported as annotations, nor a keyword of a later
  draft (`readOnly`, `writeOnly`, `contentEncoding` and `contentMediaType`
  before draft-07, `deprecated` and `contentSchema` before 2019-09). Before
  2019-09 a `$ref` makes its siblings inert, so no format reports them.
  *Upgrade: such siblings were reported as annotations and, in `verbose`,
  as passing keywords.*
- **Every failure is explained once.** An applicator whose subschemas
  failed (`allOf`, `properties`, `items`, `$ref`, ...) reports nothing of its
  own; the failed subschemas do. An applicator that fails by itself reports
  its message: `not`, `oneOf` matching twice, an `anyOf` or `contains` that
  matched nothing (beside the failed probes), and a boolean `false`
  subschema the validator evaluates in place, such as
  `additionalProperties: false` (in `list` and `hierarchical` at the unit
  holding it; a `false` schema evaluated as a subschema keys its message by
  `""`). `basic` also lists, as the 2020-12 example does, each failed unit
  of the condensed hierarchy that holds two or more failed units, with the
  error "A subschema had errors." (the `subschema` message; `''` under
  `messages: false`). Two errors of one keyword in one unit (two missing `required`
  members) are one entry in `list` and `hierarchical`, the messages joined
  by `; `, and two units in the 2020-12 formats.
- **The flat and condensed forms keep what decides the answer**: a passing
  subschema inside a failing one, a failed `anyOf` branch beside one that
  passed, and an `if` condition that failed are left out of `basic`,
  `detailed` and `list`. `hierarchical` keeps every applied subschema, and
  `verbose` every keyword the validator evaluates in every applied
  subschema (a `true` subschema has none, so it adds no unit there). An
  unknown keyword (`x-ui`) is not evaluated, nor a keyword of a later draft
  than the one the document declares (`prefixItems` before 2020-12;
  `dependentRequired`, `dependentSchemas`, `minContains`, `maxContains` and
  `unevaluated*` before 2019-09; the later annotations above), nor
  `propertyDependencies` while its option is off; a document that declares
  no draft has every keyword the validator asserts. *Upgrade: `verbose`
  used to list such keywords as passing units.*
- **Messages and `errorMessage` are the collected errors' own**: the
  English messages render them, an `errorMessage` replaces them, and
  `messages: false` leaves them `''`. A unit carries the rendered text
  only, so `localizeErrors`, which re-renders collected errors from their
  `msgid` and `params`, does not reach an output: the formats answer in
  English.

`outputFormat` takes precedence over `collectErrors`. `flagOutput` runs the
boolean validator, which stops at the first failure; the other five record a
unit per applied subschema and evaluate every `anyOf` branch (each passing
branch has annotations to report), so they cost about an order of magnitude
more than the `collectErrors` output. The boolean default and
`collectErrors` are unchanged. Against the specifications' examples, two
answers differ: `basic` adds the `valid` its output schema requires to
every unit; and `droppedAnnotations` follows one rule (every failed unit
reports what its own keywords produced), where the example shows it on
some failed units and not others. `list` lists no branch units: its own
specification's example has none (*upgrade: `basic` used to leave out the
2020-12 example's branch units*).

## Normalization

Validation answers a question; it does not change your data. When you need
the *normalized output* that a parse-and-transform library returns —
materialized defaults, decoded transport values, stripped unknown members —
compile a normalizer from the same schema and run it first:

```javascript
import { compileNormalizer } from '@jarenjs/validate/normalize';

const normalize = compileNormalizer(schema, {
  useDefaults: true,       // fill absent properties from `default`, recursively
  removeAdditional: true,  // drop members the schema forbids
  coerceTypes: true,       // '9000' -> 9000 where the schema says integer
  trimStrings: true,       // '  jaren  ' -> 'jaren'
  coerceJsonText: true,    // '{"a":1}' -> { a: 1 } where the schema says object
});

const shaped = normalize(input);   // a NEW value; `input` is untouched
const result = validate(shaped);
```

Every option is **off by default** — each one changes what your data means,
so each is a decision you make rather than one you inherit.
`compileNormalizer(schema)` with no options is the identity. The option set
is closed, and each refusal is a `TypeError` that says what is wrong: a
member other than `useDefaults`, `removeAdditional`, `coerceTypes`,
`trimStrings` and `coerceJsonText` names the nearest one (`coerceType` — did you mean
`coerceTypes`?), a value of the wrong type names the member and what it takes
(`coerceTypes: 'yes'`, a member set to `null`, a `removeAdditional` other
than `true`, `false` or `'all'`), and options that are not a plain object —
`null` among them — are refused as such. A misspelt or mistyped switch used
to compile a normalizer with that switch off, in silence, and `null` options
used to throw a raw `TypeError` (`Cannot read properties of null`).

### Per-field control, not just a global switch

`useDefaults`, `coerceTypes`, `trimStrings` and `coerceJsonText` each accept a **predicate**
`(schemaNode) => boolean` in place of a boolean. It runs once per node during
compilation, so it decides per field and costs nothing at runtime:

```javascript
const normalize = compileNormalizer(schema, {
  trimStrings: (node) => node['x-trim'] === true,
});
```

This matters more than it looks. A contract typically trims a handful of its
string fields and must leave the rest byte-for-byte as supplied — a timezone
name, a deliberately padded identifier, a field whose whitespace is data.
`trimStrings: true` would quietly rewrite all of them. The predicate reads
whatever you put in the schema (an `x-` annotation, a `format`, a name
pattern), which keeps the policy next to the field it governs and portable
with the schema.

### It never mutates, and it shares what it can

Ajv's `useDefaults`/`coerceTypes` write into the document you hand them.
This does not: it is a copy-on-write walk, so the input is exactly as it was
afterwards — you can normalize a frozen document, or keep the original as an
audit record, without defensive copying.

The other half of that design is identity. A subtree that needs no change is
returned by reference, and a document that needs no change at all returns the
input itself:

```javascript
normalize(alreadyClean) === alreadyClean;   // true
```

So a no-op costs nothing, and downstream memoization keyed on identity keeps
working.

### What it walks, and what it deliberately does not

Walked: `properties`, `patternProperties`, `additionalProperties`,
`items`/`prefixItems`/`additionalItems` (both tuple spellings), same-document
`$ref` including recursive ones, and `allOf` — whose branches compose, with
stripping disabled inside them because one branch cannot know what a sibling
declares.

Same-document references use the fragment forms `#`, `#/pointer` and `#anchor`,
and a blank `$ref`, which names the document as `#` does; absolute URI spellings
are not followed by the normalizer. *Upgrade: a blank `$ref` was not followed, so
nothing behind it was coerced or defaulted.* Defaults materialize
only on directly annotated, absent properties: an own property set to
`undefined` remains present, and a default found only behind a `$ref` does not
create an absent property. A supplied value still follows that reference.

Tuple tail normalization starts after the declared prefix, including prefix
positions that need no changes. `prefixItems` is read where the validator
reads it: a document that declares a draft before 2020-12 treats it as an
unknown keyword (its `items` then applies to every item), and a same-document
reference target is read in the draft its place in the document declares (the
nearest `$schema` on the way to it; the root's for an anchor). *Upgrade: the
normalizer used to coerce and default `prefixItems` positions under every
draft, so `{ $schema: 2019-09, prefixItems: [{ type: 'integer' }], items: {
type: 'string' } }` turned `['5']`, which the validator accepts, into `[5]`,
which it rejects.* Same-document anchors are collected from schema
positions; anchor-looking keys in defaults, constants and examples are data.

A `patternProperties` key is a pattern source here as in the validator, so
both cover the same members.

Member schemas **compose the way JSON Schema says they do**: a member covered
by `properties` *and* by one or more matching `patternProperties` is
normalized by every one of them, in that order, and `additionalProperties`
applies only to a member nothing else covered. A materialized `default` runs
through its own property's normalizer too, so a defaulted `{ port: '8080' }`
is shaped exactly like a supplied one rather than keeping its string.

`allOf` branches compose **in declaration order, once**: a `$ref` first, then
each branch, then the schema's own keywords, every step working on what the
step before it returned. That order is the contract, and the normalizer does
not iterate branches to a fixed point. The consequence shows when one branch
supplies a default and another coerces the same member:

```javascript
const schema = {
  allOf: [
    { properties: { count: { type: 'integer' } } },   // coerces, but runs first
    { properties: { count: { default: '42' } } },     // supplies the default after
  ],
};
const normalize = compileNormalizer(schema, { useDefaults: true, coerceTypes: true });

normalize({});                // { count: '42' }  - the coercion had already run
normalize(normalize({}));     // { count: 42 }    - a second application coerces it
```

Keep one application enough by putting the `type` and the `default` on the same
property schema, or by listing the branch that supplies the default first.
Defining cross-branch default processing would change the order existing
normalizers rely on, so the order stays as declared.

Not walked: `anyOf`, `oneOf`, `if`/`then`/`else`, `not`. Which branch applies
is only known after validating, and normalizing under one branch can change
which branch validates — so guessing would be worse than declining. There is
also no transform hook: an arbitrary transform is application code, not
schema semantics, and belongs on your side of the boundary.

### The coercion table

Coercion exists to decode transport encodings — query strings, form fields,
environment variables, CSV cells — where everything arrives as a string. It
is conservative on purpose: a value it cannot convert unambiguously is passed
through unchanged, so validation reports the type error instead of the
normalizer hiding it.

| Declared `type` | Converted | Left alone |
|---|---|---|
| `number` | a string that is exactly a JSON number (`'1e5'`, `'-0.5'`) | `'0x10'`, `'1_000'`, `''`, `'Infinity'` |
| `integer` | as `number`, when the result is a safe integer | `'4.5'`, integer strings outside ±(2⁵³−1) |
| `boolean` | `'true'`, `'false'` | `'yes'`, `'1'`, `0` |
| `string` | finite numbers and booleans | objects, arrays, `null` |
| `null` | `'null'` | `''`, `0`, `false` |

A union `type` (`['string', 'number']`) gives no single target, so coercion is
skipped rather than guessed. Trimming runs before coercion, so `'  42  '`
decodes for an integer field.

### Structure sent as JSON text

A model calling a tool often sends a nested object or array as its JSON
*text*: one quoted string where the schema wants the structure. Validation
refuses it as a string, and the repair costs the model another round trip.
`coerceJsonText` decodes that string where the schema says what it must be,
at any depth, and then normalizes inside the decoded value, so `coerceTypes`,
`useDefaults` and `removeAdditional` apply to its members as they would to
a member sent as structure:

```js
import { compileNormalizer } from '@jarenjs/validate/normalize';
import { JarenValidator } from '@jarenjs/validate';

const searchArgs = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    filter: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer', default: 10 },
      },
      additionalProperties: false,
    },
  },
  required: ['query', 'filter'],
};
const normalize = compileNormalizer(searchArgs, {
  coerceJsonText: true, coerceTypes: true, useDefaults: true,
});
const validate = new JarenValidator().compile(searchArgs);

// The arguments as the model sent them: `filter` is JSON text, and `tags`
// inside it is JSON text again.
const call = { query: 'jaren', filter: '{"tags":"[\\"json\\",\\"schema\\"]"}' };
console.log(validate(call));                  // false
const args = normalize(call);
console.log(JSON.stringify(args), validate(args));
// {"query":"jaren","filter":{"tags":["json","schema"],"limit":10}} true
```

A string is decoded only where it cannot be what was meant:

- **The node's own `type` names `object` or `array` and not `string`.** A
  node without a `type`, or with `type: ['string', 'object']`, accepts the
  string as sent, so it stays a string. The strict-profile
  spelling `type: ['object', 'null']` decodes; the text `'null'` stays text.
- **Unions are not chosen by trying a parse.** `anyOf` and `oneOf` are not
  walked (above), so a member typed only through their branches stays a
  string. `allOf` branches and `$ref` targets are walked and decode by their
  own `type`. The keywords beside a `$ref` decode only where the declared
  draft asserts them (2019-09 and later); in a draft-07 document, or one
  declaring no draft, the validator ignores them by default, so nothing in
  them decodes (their `type`, `allOf`, `properties`, `items`) and the
  reference's target decides.
- **Text that does not decode to the wanted container stays as sent.**
  Malformed JSON, the JSON text of a scalar (`'42'`, `'"{}"'`), or an array's
  text where an object is wanted is returned unchanged, and validation
  reports it as the wrong type.
- **What decodes is still validated.** A decoded object that misses a
  required member is reported at its own instance path (`/filter`), not
  hidden by the normalizer.

A second pass changes nothing: a decoded container is no longer a string,
and text that did not decode does not decode the next time either. With
`trimStrings` on the same node, the decode reads the trimmed text, as
coercion does, so `'\u00a0{"a":1}'` decodes in the first pass rather than
trimming into text the second pass would decode. Decoding
uses `JSON.parse`, so an integer beyond ±(2⁵³−1) inside the text becomes the
nearest double, as it would in the call's outer JSON.

## Strict structured-output profiles

A provider's strict structured-output mode decodes only answers its schema
subset can describe: one self-contained document, every object closed
(`additionalProperties: false`) with every declared member `required`,
`anyOf` but no `oneOf`, and few value keywords. Most schemas a host writes
have optional members, so a host either turns strict mode off or derives a
second schema by hand. `deriveStrictProfile` (`@jarenjs/validate/strict-profile`)
derives it, together with the map that turns a strict answer back into the
original's shape:

```js
import { JarenValidator } from '@jarenjs/validate';
import { deriveStrictProfile } from '@jarenjs/validate/strict-profile';

const patchSchema = {
  type: 'object',
  required: ['ops'],
  properties: { ops: { type: 'array', items: { $ref: '#/$defs/op' } } },
  $defs: {
    op: {
      type: 'object',
      required: ['op', 'path'],
      properties: {
        op: { enum: ['add', 'replace', 'remove'] },
        path: { type: 'string', pattern: '^/' },
        value: { type: 'string' },
      },
    },
  },
};

const strict = deriveStrictProfile(patchSchema);
// strict.schema.$defs.op:
// { type: 'object', required: ['op', 'path', 'value'],
//   properties: { op: { enum: ['add', 'replace', 'remove'] },
//     path: { type: 'string', description: '(strict profile: pattern "^/" is relaxed here; the original schema enforces it)' },
//     value: { type: ['string', 'null'] } },
//   additionalProperties: false }

// A stand-in for a provider called in strict mode: it answers in the
// profile's shape, so a member the original lets be absent arrives as null.
const provider = async (request) => {
  void request.schema;
  return { ops: [{ op: 'remove', path: '/draft', value: null }, { op: 'add', path: '/title', value: 'Q3' }] };
};
const answer = await provider({ schema: strict.schema, strict: true });

const patch = strict.fromProfile(answer);
const check = new JarenValidator().compile(patchSchema);
console.log(JSON.stringify(patch), check(patch));
// {"ops":[{"op":"remove","path":"/draft"},{"op":"add","path":"/title","value":"Q3"}]} true
```

What the derivation does, node by node:

- **References are bundled.** Every `$ref` the schema uses — into itself, or
  into a document passed as `references` (each with an absolute `$id`) — is
  rewritten to `#/$defs/<name>` of the one profile document. A recursive
  reference stays recursive.
- **Objects are closed and every member is required.** An optional member's
  type is widened to also admit `null`. A member whose original schema
  already admits `null` is left as it is.
- **What the profile does not carry moves into `description`.** `pattern`,
  `format`, lengths, bounds, `uniqueItems`, `contains`, `not` and every other
  keyword outside the strict subset are restated in the node's description,
  where the model still reads them; `oneOf` becomes `anyOf`, and an `allOf`
  of one branch becomes that branch. `relaxSchema` is that rule on its own.
- **A value of any shape is carried as JSON text.** A member that accepts
  any value (`{}`, `true`, a node with no type), a free-form
  `{ "type": "object" }`, the items of an array with no `items` schema and a
  tuple (`prefixItems`) become a `string` whose description says to write
  the value as JSON; `fromProfile` parses it, and the original judges what
  it decodes to. Beside a union branch that also takes a string, the text is
  boxed as `{ "json": "…" }` so the two cannot be read for each other.
- **A map is carried as entries.** An object whose members come from
  `patternProperties` or a schema-valued `additionalProperties` becomes an
  array of closed `{ key, value }` objects (the name patterns restated on
  `key`); `fromProfile` builds the object back.
- **An object beside `allOf`, `anyOf` or `oneOf` is distributed** when its
  branches only add, require or narrow members: each `allOf` branch is
  folded into the object, and the object is copied into each `anyOf` branch
  as a closed object of its own. A branch that names a member the object
  also declares narrows it exactly when one side is an `enum` or `const`
  (the values the other side accepts are kept) or only adds value keywords;
  a branch closed with `additionalProperties: false` keeps its own members.
- **A root that is not one closed object is wrapped** as the one member
  `value` (strict modes take an object at the root); `fromProfile` unwraps it.

**How a placeholder `null` is told from a real one.** When the profile is
derived, the original's own validator is asked whether each optional
member's schema accepts `null`. Only a member it refuses `null` for is
widened, and only that member's `null` is removed by `fromProfile`. A member
typed `['string', 'null']`, a `$ref` to a nullable definition, an `anyOf`
with a `null` branch or an `enum` that lists `null` keeps its `null` —
unless the original refuses the answer with it and accepts the member
absent (a constraint on presence, such as `not: { required: [...] }`), in
which case those nulls are removed. An answer read through two union
branches that disagree about it is returned as written.
`toProfile` is the forward map (absent members filled with `null`, members
the profile closed out dropped), for few-shot examples and tests.

**The original stays the authority.** Everything the profile drops is a
relaxation, so validate what `fromProfile` returns with the original
schema: for every instance the original accepts, `toProfile` gives one the
profile accepts, and for every answer the profile accepts, `fromProfile`
gives one the original accepts, refuses with its own errors, or — for JSON
text that is not JSON (`JK2002`) and entries that repeat a key (`JK2003`) —
refuses itself with a coded `SchemaRuntimeError` naming the place in the
answer. Closing is the one narrowing: a member an open object never
declared cannot be written by a model. A schema a closed profile would read
wrong — a map beside declared members, members contributed or required by
`if`/`then`, a dependency or a branch that is more than members, two
schemas for one member that no `enum` narrows, a `$dynamicRef` — is refused
with a coded `SchemaCompileError` (`JK0102`–`JK0108`, in
[ERROR-MESSAGES](./docs/ERROR-MESSAGES.md#9-coded-refusals)) naming the
place and the repair, never answered with a profile that is silently wrong.
The derivation also compiles the original, so a reference it cannot resolve
is refused then (`JK0009`), not by the first answer.

**Which strict modes it targets.** The subset is the one OpenAI's
Structured Outputs and strict function calling accept (every member
required, `null` unions for optional ones, `additionalProperties: false`,
an object root, no `allOf`, `oneOf`, `not` or `if`) with the value keywords
narrowed to what Anthropic's structured outputs and strict tool use also
accept (no numeric bounds, lengths or array sizes; these are relaxed into
descriptions as that provider's own SDKs do). Two limits stay with the
host: Anthropic's strict mode refuses recursive schemas and `enum` values
that are not scalars, and OpenAI's caps size (5,000 object properties,
10 levels of nesting, 1,000 `enum` values), none of which the derivation
checks.

## Error messages & i18n

Every collected error carries a stable message key (`msgid`) and raw
structured `params` next to its rendered `message` — prose is produced at
report time from a **catalog** (a plain object of closures), never on the
validation hot path. The normative spec is
[ERROR-MESSAGES.md](./docs/ERROR-MESSAGES.md).

### The `errorMessage` keyword

Author-supplied messages that override *text*, never structure (no error
aggregation or removal — the deliberate divergence from ajv-errors, whose
two official plugins are mutually incompatible). Registered at schema
compile time, resolved only over the failed set at report time — zero
validation-time cost.

```javascript
// string form: covers the node AND its subtree (quiet oneOf noise)
{ "type": "string", "minLength": 8, "errorMessage": "Use at least 8 characters" }

// map form: per failing keyword, '_' as the node catch-all
{ "type": "integer", "minimum": 18,
  "errorMessage": { "minimum": "Must be an adult", "_": "Invalid age" } }

// required: per missing property
{ "required": ["vatId", "name"],
  "errorMessage": { "required": { "vatId": "VAT id is required for business accounts" } } }

// $query: EBV-false default and per runtime code
{ "$query": { "$le": ["$.start", "$.end"] },
  "errorMessage": { "$query": {
    "default": "start must not be after end",
    "JQ2003": "start/end must be single values" } } }
```

Templates interpolate params: `"errorMessage": "needs {limit} characters"`.

### `$msgid` — translatable authored messages

An `errorMessage` (or forms `x-form.message`) may be a **MessageSpec**
object pointing into the catalog space instead of inline text — that keeps
schema-authored messages translatable:

```javascript
{ "type": "number",
  "errorMessage": { "type": {
    "$msgid": "checkout.total-invalid",       // catalog key
    "message": "Total must be a number"       // fallback when no catalog covers it
  } } }
```

A `$msgid` or a catalog key resolves by own member only, so a name every object
inherits (`constructor`, `toString`, `__proto__`) is an unknown key: the inline
`message` renders, or the keyword's own message when there is none. *Upgrade:
such a `$msgid` used to render the inherited function's result (`[object Undefined]`,
or the parameters object as the message) or throw.*

### Locale packs

```javascript
import { JarenValidator, compileMessageCatalog, localizeErrors } from '@jarenjs/validate';
import { nl } from '@jarenjs/locales';

const catalog = compileMessageCatalog(nl);
const validator = new JarenValidator({ collectErrors: true });
const validate = validator.compile({ type: 'string', minLength: 2 });

const result = validate('x');                 // English messages
localizeErrors(result.errors, catalog);       // Dutch, re-rendered from msgid + params
// 'mag niet minder dan 2 tekens bevatten'
```

The locale is chosen at **report time**; switching locale never recompiles
anything. Catalog entries are plain functions, so packs use the platform's
`Intl.PluralRules`/`Intl.NumberFormat` — see
[`@jarenjs/locales`](../locales/README.md) for the pack-authoring guide.

### `messages: false`

For applications that render exclusively through `localizeErrors` (or
their own resolver), skip English rendering entirely:

```javascript
const validator = new JarenValidator({ collectErrors: true, messages: false });
// errors arrive with message: '', params and msgid still set
```

## Not planned

- **A code-generating backend.** Validators are closures built without `eval` or `new Function`, so they run under a strict Content-Security-Policy; generated source would reach a lower floor on trivial schemas, and the guarantee is worth more than that floor.
- **`errorMessage` maps over `properties` and `items`.** A string `errorMessage` already covers its node and everything under it, which is what those map forms express.
- **Data interpolation by relative pointer in message templates.** A template reads the error's `params`, which already carry the offending values.

## Exports

Every subpath a consumer can import, derived from the manifest by
`npm run docs:derive` (`npm run docs:check` fails when the two drift):

<!--fact:exports.validate-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/validate` | JavaScript | declared |
| `@jarenjs/validate/query` | JavaScript | declared |
| `@jarenjs/validate/normalize` | JavaScript | declared |
| `@jarenjs/validate/output` | JavaScript | declared |
| `@jarenjs/validate/load` | JavaScript | declared |
| `@jarenjs/validate/strict-profile` | JavaScript | declared |
| `@jarenjs/validate/package.json` | metadata | — |
<!--/fact-->

## Development

Unit tests live in `test/validate/` at the repository root (`npm run test:validate`). Performance against Ajv is measured over the official test suite with the [benchmark workspace](../../benchmark/README.md) (`node benchmark/profiler.js --profile-all`), which also houses the test-failure debugger, coverage and call-graph tools.

This package's internals — the four-phase compile pipeline, ref flattening, annotation tracking, dynamic scope — are described in its own [ARCHITECTURE](./ARCHITECTURE.md) document. For practical usage recipes (options, lightweight setups, custom formats, pitfalls) see the repository [HOWTO](../../docs/HOWTO.md); for the monorepo picture see the repository [README](../../README.md) and [ARCHITECTURE](../../docs/ARCHITECTURE.md); for what is planned next see the [ROADMAP](../../docs/ROADMAP.md).
