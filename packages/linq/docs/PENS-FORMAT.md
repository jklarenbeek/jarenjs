# The Jaren pens (normative)

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119.

## 1. Scope and the pen rules

A **pen** is a by-code front-end to one of the suite's document formats:
named functions that build a standard document — a JSON Schema, a
`$model`, a `$jslt` stylesheet — the way the chain builds a query
document. `@jarenjs/linq` exports each pen under its own subpath
(`@jarenjs/linq/schema` is the first); `.` stays the chain. This document
is normative for every pen: §1 states the rules they all keep, §1.3 the
error codes they share, and one section per pen (§2 onward) carries the
mapping table — method, emitted member, type reading, status — and the
worked examples a test executes.

### 1.1 The rules

1. **The document is the deliverable.** A pen emits exactly the published
   document: plain, deep-frozen JSON (`JSON.parse(JSON.stringify(x))`
   deep-equals `x`; no functions, no class instances), valid under the
   published grammar. `.schema` is the document, `toJSON()` returns it,
   so `JSON.stringify(builder)` and `structuredClone(builder.schema)` are
   the document. A pen imports no engine; the engine's compiler is the
   only judge of semantics. A pen refuses only what it cannot SPELL, or
   what the engine's own rule would refuse and the pen can see earlier —
   mirrored, never invented — with a coded `JL01xx` build error. There is
   no pen-private dialect, no `.transform()`-style function member and
   no re-implementation of a compile check.
2. **Types are phantoms; the pen is the only inference route.** `Infer<>`,
   `Input<>` and their kin exist at compile time only. A JSON literal is
   never inferred: `from(json)` types as `unknown` unless the caller
   asserts (`from<T>(json)`), and a reference by name (`ref<T>(name)`)
   likewise. Every type claim is pinned three ways over one corpus — the
   pen's type equals emit's declaration for the emitted document, and both
   correspond to the validator's verdicts — plus a runtime twin.
3. **Home and shape.** A pen lives at `packages/linq/src/<pen>/` and
   exports NAMED functions (`import * as s`), never a namespace object; a
   pen that extends another does so by subclassing through the base
   class's `with()`, never by patching an imported prototype. The only
   shared runtime machine is the chain's recording proxy (and the
   builder brand). Every subpath has a tree-shaking probe: a pen-only
   bundle carries no chain module and no engine.
4. **Objects are closed by default.** `object()` emits
   `additionalProperties: false`; `.open()` removes it. The type follows
   emit's reading of the EMITTED document in both cases: an index
   signature only for an open object.

### 1.2 Immutability and identity

Every builder is immutable and frozen; every method answers a new
builder. `.schema` assembles once and memoizes; two builds of the same
spelling are one document (`deepStrictEqual`). A builder used in two
places emits twice, as JSON; a NAMED builder (`named(name, b)`) emits
once, into `$defs`, and is referenced by `$ref` from every place it is
reached — also when reached once, because a name is a statement of
intent and a stable `$defs` is what a contract's definitions and a
bundler read.

### 1.3 Error codes

Pen refusals are `LinqBuildError`s with these codes, in `LINQ_CODES` and
mirrored in LINQ-FORMAT §9 (one table, held equal by a test):

| Code | Condition |
|---|---|
| `JL0101` | a pen received a value it cannot spell: not JSON (a function, symbol, bigint, `NaN`, `±Infinity`, `-0`, a class instance, a cycle — the constant rule of LINQ-FORMAT §5 applied to defaults, literals, examples and annotations), or not what the keyword takes (`min('x')`, a member that is not a builder) |
| `JL0102` | a pen was asked for a construct the format cannot carry: a function `refine`/`transform` (cross-field rules are `check()`; transforms are application code), a coercion the normalizer would never run, closed objects under `allOf`, an annotation on `never()`, a draft the pen does not write |
| `JL0103` | a `$defs` name collision (two distinct builders under one name), a `ref()` no definition answers, or a `lazy()` that does not return a named builder |
| `JL0104` | a pen-owned keyword written through `meta()`, or a `check()` external other than `root`/`path` |

The message names the fix; `docPath` is the JSON pointer of the node
being assembled where one exists (`/properties/lines/items`).

## 2. The schema pen — `@jarenjs/linq/schema`

```js
import * as s from '@jarenjs/linq/schema';
```

builds JSON Schema 2020-12 documents: every keyword `@jarenjs/validate`
supports, `$query` captured through the chain's proxy, `$defs`/`$ref`
recursion, the normalizer's per-field annotations. The type reading is
emit's (EMIT-FORMAT §5–§7), because the agreement pins them equal; a
constraint (`min`, `pattern`, `format`) never changes a type — the honest
widening emit documents — with one addition: a string with
`format: 'date-time'` or `'date'` is the `DateTime` brand, so the chain's
date operators light up on a chain over the pen's shape.

### 2.1 The mapping table

Status: **native** (emits the named keyword), **emulated** (a composition
with identical semantics), **refused** (a coded error naming the reason).

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `string()` | `{ type: 'string' }` | `string` | native |
| `number()` | `{ type: 'number' }` | `number` | native |
| `integer()`, `number().int()` | `{ type: 'integer' }` | `number` (integer-ness is a documented widening) | native |
| `boolean()` | `{ type: 'boolean' }` | `boolean` | native |
| `nil()` | `{ type: 'null' }` | `null` | native |
| `literal(v)` | `{ const: v }` | the literal | native |
| `enumOf(values)` | `{ enum: values }` | the literal union | native |
| `datetime()`, `date()` | `{ type: 'string', format: 'date-time' \| 'date' }` | `DateTime` | native |
| `time()`, `duration()` | `{ type: 'string', format: 'time' \| 'duration' }` | `string` | native |
| `object(props)` | `{ type: 'object', properties, required, additionalProperties: false }` — `required` lists every member not `optional()`, in declaration order, and is omitted when empty | a closed object: members required unless `optional()`; no index signature; `object({})` is `Record<string, never>` | native |
| `.open()` | drops `additionalProperties: false` | `& { [k: string]: unknown }` | native |
| `.optional()` | the member leaves `required` | `?:` (on both sides; a `default()`ed member is present on `Infer`) | native |
| `.nullable()` | `type: [t, 'null']` on a typed node; `enum: [..., null]` on `enumOf`/`literal`; `anyOf: [node, { type: 'null' }]` on the rest | `\| null` | native / emulated |
| `.default(v)` | `default: v` | present on `Infer`, `?:` on `Input` (the normalizer's `useDefaults`) | native |
| `.describe(text)`, `.title(text)`, `.example(v)` | `description`, `title`, `examples: [...]` | — | native |
| `.meta(annotations)` | the keys verbatim, in the order first set | — | native; a pen-owned keyword is `JL0104` |
| `.message(spec)` | `errorMessage: spec` (the validator's string, map or `$msgid` forms) | — | native |
| `.check(fn)` | `$query`: the callback captured through the chain's proxy — `fn(value, { root, path })`, the value at `$`, the two externals the validator binds; two checks conjoin with `$and` | — (a dropped constraint) | native; another external is `JL0104` |
| `.check(query)` | `$query`: a query document embedded verbatim | — | native |
| `.coerce()` | `'x-coerce': true` on a scalar — the normalizer's per-field predicate | `Input` widens to the transport forms: string `\| number \| boolean`, number/integer `\| string`, boolean `\| string`, null `\| string` | native; on a non-scalar, a nullable, or a date-formatted string `JL0102` |
| `.trim()` | `'x-trim': true` on a string | — | native |
| string `.min(n)`, `.max(n)`, `.length(n)` | `minLength`, `maxLength`, both | — | native |
| string `.pattern(p)` | `pattern` (a string, or a flagless `RegExp` by its source) | — | native; flags are `JL0102` |
| string `.format(f)`, `.email()`, `.uuid()`, `.uri()` | `format` | `DateTime` for `'date-time'`/`'date'`, `string` otherwise | native |
| number `.min(n)`, `.max(n)`, `.gt(n)`, `.lt(n)`, `.multipleOf(n)` | `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` | — | native |
| `array(items)` | `{ type: 'array', items }` | `T[]` | native |
| array `.min(n)`, `.max(n)`, `.length(n)`, `.unique()`, `.contains(b)` | `minItems`, `maxItems`, both, `uniqueItems: true`, `contains` | — | native |
| `tuple(items)` | `{ type: 'array', prefixItems, minItems: items.length }` | `[A, B, ...unknown[]]` — every position required, the rest open (emit's reading of an omitted `items`) | native |
| tuple `.rest(b)` | `items: b`; `rest(never())` is `items: false` | `[A, B, ...R[]]`; `[A, B]` | native |
| `record(values)` | `{ type: 'object', additionalProperties: values }` | `{ [k: string]: V }` | native |
| object `.minProperties(n)`, `.maxProperties(n)`, `.dependentRequired(map)`, `.propertyNames(b)` | the keyword | — | native |
| object `.patternProperties(map)` | `patternProperties` | on a closed object the index signature carries the pattern values widened over the members (`[k: string]: V \| members`); on an open one `unknown` | native |
| object `.extend(props)`, `.pick(keys)`, `.omit(keys)`, `.partial()`, `.required(keys?)` | the reshaped `properties`/`required` | the reshaped members | emulated |
| `union(options)` | `{ anyOf }` (a hand-written option is `from(json)`) | `A \| B` | native |
| `discriminated(key, options)` | `{ oneOf }` — every option an object declaring `key` as a `literal()`/`enumOf()` member | `A \| B` | native; a missing tag is `JL0102` |
| `intersection(parts)` | `{ allOf }` | `A & B` | native; a closed object part is `JL0102` (the parts would reject each other's members — `open()` them, or `extend()`) |
| `named(name, b)` | `$defs[name]` at the document root, `{ $ref: '#/$defs/name' }` where reached | `Infer<b>` | native |
| `ref(name)` | `{ $ref: '#/$defs/name' }` | `T` as asserted (`ref<T>`) | native; unanswered is `JL0103` |
| `lazy(() => Named)` | as `named` — the recursion spelling | `T` as annotated on the recursive constant | native; an unnamed target is `JL0103` |
| `any()` | `{}` | `unknown` | native |
| `never()` | `false` | `never` | native; it carries no annotations (`JL0102`) |
| `when(cond).then(b).else(b)` | `{ if, then, else }` | `unknown` (emit records a conditional, never types it) | native |
| `from(json)` | the JSON, verbatim (cloned) | `T` as asserted (`from<T>`) | native |
| `document(root, { draft })` | the document, with `$schema` first for `'2020-12'` | — | native; another draft is `JL0102` |
| `.refine(fn)`, `.transform(fn)`, `.superRefine(fn)` | — | — | refused: not methods (cross-field rules are `check()`; transforms are application code) |

Three rules the table implies, spelled out:

- **A default or coercion lives where the normalizer reaches.**
  `compileNormalizer` does not descend `anyOf`/`oneOf` branches,
  `if`/`then`/`else`, `contains` or `propertyNames`, so a `default()`,
  `coerce()` or `trim()` under one would promise a normalization that
  never happens; the pen refuses it (`JL0102`) at assembly, naming the
  branch. The same rule is why `coerce()` and `nullable()` exclude each
  other: the normalizer coerces only a single-typed scalar.
- **A rule against the root reads from the root.** `check()`'s `root` is
  an object whose members are the honest top, so a typed member compares
  with it from the root's side — `x.root.currency.eq(l.currency)` — the
  unknown expression takes any operand; the typed one takes its own kind.
- **A `when()` builder is thenable-shaped.** Its `then()` takes a schema,
  so a promise that resolves one calls it with a function and is refused
  by name (`JL0101`); keep builders out of async return positions.

### 2.2 Worked examples

Every ```js fence below exports exactly one builder (or one document),
and the ```json fence that follows it is what the pen emits — executed by
`test/linq/pens-format.test.js`, which imports each fence from the
workspace and asserts the document.

A closed object with the common member shapes:

```js
import * as s from '@jarenjs/linq/schema';

export const User = s.object({
  id: s.string().uuid(),
  name: s.string().min(1).trim(),
  age: s.integer().min(0).optional(),
  role: s.enumOf(['admin', 'user']).default('user'),
  created: s.datetime(),
  tags: s.array(s.string()).unique().optional(),
});
```

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string", "format": "uuid" },
    "name": { "type": "string", "minLength": 1, "x-trim": true },
    "age": { "type": "integer", "minimum": 0 },
    "role": { "enum": ["admin", "user"], "default": "user" },
    "created": { "type": "string", "format": "date-time" },
    "tags": { "type": "array", "items": { "type": "string" }, "uniqueItems": true }
  },
  "required": ["id", "name", "role", "created"],
  "additionalProperties": false
}
```

The validator README's own invoice rule, as a captured `check()`:

```js
import * as s from '@jarenjs/linq/schema';

export const Invoice = s.object({
  lines: s.array(s.object({ amount: s.number() })),
  total: s.number(),
}).check((o) => o.total.eq(o.lines.all().amount.sum()));
```

```json
{
  "type": "object",
  "properties": {
    "lines": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": { "amount": { "type": "number" } },
        "required": ["amount"],
        "additionalProperties": false
      }
    },
    "total": { "type": "number" }
  },
  "required": ["lines", "total"],
  "additionalProperties": false,
  "$query": { "$eq": ["$.total", { "$sum": "$.lines[*].amount" }] }
}
```

A recursion — a named builder, reached again through `lazy()`, hoisted to
`$defs` once:

```js
import * as s from '@jarenjs/linq/schema';

export const Node = s.named('Node', s.object({
  label: s.string(),
  children: s.array(s.lazy(() => Node)).optional(),
}));
```

```json
{
  "$defs": {
    "Node": {
      "type": "object",
      "properties": {
        "label": { "type": "string" },
        "children": { "type": "array", "items": { "$ref": "#/$defs/Node" } }
      },
      "required": ["label"],
      "additionalProperties": false
    }
  },
  "$ref": "#/$defs/Node"
}
```

A discriminated union, a nullable, a tuple closed by `never()`:

```js
import * as s from '@jarenjs/linq/schema';

export const Shape = s.object({
  shape: s.discriminated('kind', [
    s.object({ kind: s.literal('circle'), r: s.number() }),
    s.object({ kind: s.literal('square'), side: s.number() }),
  ]),
  label: s.string().nullable(),
  at: s.tuple([s.number(), s.number()]).rest(s.never()),
});
```

```json
{
  "type": "object",
  "properties": {
    "shape": {
      "oneOf": [
        {
          "type": "object",
          "properties": { "kind": { "const": "circle" }, "r": { "type": "number" } },
          "required": ["kind", "r"],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": { "kind": { "const": "square" }, "side": { "type": "number" } },
          "required": ["kind", "side"],
          "additionalProperties": false
        }
      ]
    },
    "label": { "type": ["string", "null"] },
    "at": {
      "type": "array",
      "prefixItems": [{ "type": "number" }, { "type": "number" }],
      "items": false,
      "minItems": 2
    }
  },
  "required": ["shape", "label", "at"],
  "additionalProperties": false
}
```

A standalone file — `document()` with the draft declared — over an open
object extended with a conditional:

```js
import * as s from '@jarenjs/linq/schema';

export const Settings = s.document(
  s.intersection([
    s.object({ mode: s.enumOf(['dark', 'light']), accent: s.any() }).open(),
    s.when(s.object({ mode: s.literal('dark') }).open())
      .then(s.object({ accent: s.string() }).open()),
  ]),
  { draft: '2020-12' },
);
```

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "allOf": [
    {
      "type": "object",
      "properties": { "mode": { "enum": ["dark", "light"] }, "accent": {} },
      "required": ["mode", "accent"]
    },
    {
      "if": {
        "type": "object",
        "properties": { "mode": { "const": "dark" } },
        "required": ["mode"]
      },
      "then": {
        "type": "object",
        "properties": { "accent": { "type": "string" } },
        "required": ["accent"]
      }
    }
  ]
}
```

### 2.3 The types, in one place

```ts
import * as s from '@jarenjs/linq/schema';
import type { Infer, Input } from '@jarenjs/linq/schema';

const Config = s.object({
  host: s.string().optional().default('localhost'),
  port: s.integer().coerce(),
  name: s.string(),
});
type Config = Infer<typeof Config>;   // { host: string; port: number; name: string }
type Raw = Input<typeof Config>;      // { host?: string; port: number | string; name: string }
```

`Infer<>` is the shape AFTER the normalizer ran with the pen's own profile
— `useDefaults: true`, `coerceTypes`/`trimStrings` as the `x-coerce`/`x-trim`
predicates — which is what the rest of a program handles; `Input<>` is
what a caller may hand in before it. Where nothing is defaulted or
coerced the two are one type. A recursive definition is annotated, as
every recursive inference must be:

```ts
interface Node { label: string; children?: Node[] }
const Node: s.NamedBuilder<Node> = s.named('Node', s.object({
  label: s.string(),
  children: s.array(s.lazy<Node>(() => Node)).optional(),
}));
```

The chain takes a builder where it took a document, and types the
element from it: `from(rows).ofType(User)` is `Sequence<Infer<typeof User>>`.
