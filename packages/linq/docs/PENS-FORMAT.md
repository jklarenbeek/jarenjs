# The Jaren pens (normative)

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119.

## 1. Scope and the pen rules

A **pen** is a by-code front-end to one of the suite's document formats:
named functions that build a standard document — a JSON Schema, a
`$model`, a `$jslt` stylesheet — the way the chain builds a query
document. `@jarenjs/linq` exports each pen under its own subpath
(`@jarenjs/linq/schema`, `/model`, `/jslt` and `/migration` so far); `.` stays the chain. This document
is normative for every pen: §1 states the rules they all keep, §1.3 the
error codes they share, and one section per pen (§2 onward) carries the
mapping table — method, emitted member, type reading, status — and the
worked examples a test executes. §6 is the client (`@jarenjs/linq/db`),
the store's front door: not a pen, but held to the same rules where
they apply, and the package's one runtime edge.

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
   shared runtime machine is the chain's recording proxy — with the one
   root capture over it (`captureQuery`: a value at `$`, named externals)
   that every query-valued member is captured through, the JSON boundary
   (`requireJson`) and the builder brand. Every subpath has a tree-shaking
   probe: a pen-only bundle carries no chain module and no engine.
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
| `JL0102` | a pen was asked for a construct the format cannot carry: a function `refine`/`transform` (cross-field rules are `check()`; transforms are application code), a coercion the normalizer would never run, closed objects under `allOf`, an annotation on `never()`, a draft the pen does not write; in the JSLT pen an `apply()` as a bare object member (the `[]` idiom, JSLT-FORMAT §6.3 — the engine would fail at run time on the second child), a `match` of `{}` (the compiler's `JT0003`, earlier), an `apply()` outside a body |
| `JL0103` | a `$defs` name collision (two distinct builders under one name), a `ref()` no definition answers, or a `lazy()` that does not return a named builder |
| `JL0104` | a pen-owned keyword written through `meta()`, or an external a captured rule did not declare: a `check()` external other than `root`/`path`, a `compute()` external at all, a `body()` external other than `root`/`path` and its declared parameters — or `root`/`path` declared as one, since the engine binds them |
| `JL0105` | a relation hop on the chain — the query pen (LINQ-FORMAT §4, relation navigation) — cannot lower: the member is a many-to-many relation, whose join table is not a queryable root in this version (`load({ include })` reads the memberships); the relation's key column or the key it references is composite or undeclared; or the provider's relation table holds something that is not a relation record |
| `JL0106` | a migration step names an entity or collection the target model does not declare (`transform`, `assert`, `derive`); or a `transform` over a planned document finds no draft to replace, or two drafts for one name |
| `JL0107` | the client (`@jarenjs/linq/db`, §6) was handed a member that is not the relation kind the operation needs: `include()` picks a declared relation member — a scalar member, or a name the model does not declare, is refused naming the declared ones; `link()`/`unlink()` attach many-to-many memberships only — a to-one or to-many relation is refused naming its kind |

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
| string/number `.enumOf(values)` | `enum` beside the `type` — a typed enum (what a store maps to a column); values of another JSON type are `JL0101` | the literal union; with `.coerce()` the `Input` widens by the one source primitive that can reach a member (`1 \| 2 \| 3 \| string`) | native |
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

Every `js` fence below exports exactly one builder (or one document),
and the `json` fence that follows it is what the pen emits — executed by
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

## 3. The model pen — `@jarenjs/linq/model`

```js
import * as m from '@jarenjs/linq/model';
```

is the schema pen's every name, rebuilt from SUBCLASSES that carry the
`x-entity` vocabulary of MODEL-FORMAT §9 — new classes made by one mixin,
never a patched prototype, so a `./schema` consumer never carries an
entity method — plus the relation members, collections and their
indexes, and `defineModel()`, which writes one `$model` 0.1 document that
`openStore` accepts unchanged. Nothing here imports `@jarenjs/db`: the
pen writes what the store's own model walk reads, and refuses only what
that walk would refuse and the builder can already see.

### 3.1 The mapping table

| Method | Emits (`x-entity` member unless said otherwise) | `InferMeta` reading | Status |
|---|---|---|---|
| `.key()` | `key: true` — (part of) the primary key | `key`: the member's primitive (`string`/`number`), or the composite object over several `key()` members | native |
| `.identity('uuid')` (string), `.identity('auto')` (integer) | `key: true` + `default: 'uuid' \| 'auto'` — a store-allocated single key (§9.5) | `key` as above; the member is optional on `input` (store-written) | native; off its kind, or beside a composite key, `JL0102` |
| `.unique()`, `.index()` | `unique: true`, `index: true` — an index over the column (an entity has no other index: no composite, no derived) | — | native |
| `.version()` | `version: true` — the optimistic-concurrency token | — | native |
| `.column('integer')` | `column: 'integer'` — an epoch column, on `datetime()`/`date()` only | — | native; off a date `JL0102` |
| `.column('json')` | `column: 'json'` — the scalar stays in the document | — | native |
| `.now()`, `.updated()` | `default: 'now' \| 'updated'` — an RFC 3339 stamp on insert, or on every write | optional on `input` | native |
| `.fill(value)` | `default: { value }` — a literal, filled when absent | optional on `input` | native |
| `.compute(fn)`, `.compute(query)` | `default: { query }` — captured over the document being written (`$`), no externals; or a document verbatim | optional on `input` | native; a named external is `JL0104` |
| `.renamedFrom(name)` | `x-rename: name` on the entity (or collection) declaration — a migration hint the planner reads | — | native |
| `.meta({ 'x-entity': … })` | — | — | refused (`JL0104`): the pen owns the keyword here |
| `rel.hasMany(to, { via, onDelete })` | `relation: { to, many: true, via, onDelete }` — the FK on the TARGET (§9.4 one-to-many); optional by construction | `doc`: `to[]`, optional; dropped from `input`; `relations[name] = { entity: to, doc, many: true }` | native |
| `rel.hasOne(to, { via, onDelete })` | `relation: { to, via, onDelete }` — the FK on the DECLARING entity (§9.4 one-to-one, and the many-to-one side) | `doc`: `to`, optional; dropped from `input`; `many: false` | native |
| `rel.belongsToMany(to, { through? })` | `relation: { to, many: true, through? }` — a join table (§9.4 many-to-many) | `doc`: `to[]`, optional; `input`: `Array<key \| doc>`, optional; `many: true` | native |
| `collection(schema, { key, identity?, indexes?, renamedFrom? })` | a collection declaration: `{ schema, key, identity?, indexes?, x-rename? }` — `key` an RFC 6901 pointer, a captured member path (`(d) => d.id` → `/id`) or `null` | — (collections carry no entity types) | native |
| `index(path, options?)` | `{ name, path, unique?, derive?, precision?, dims?, physical? }` — `path` a captured lambda (`(p) => p.embedding` → `$.embedding`), a composite array, or a JSONPath string; `name` defaults to `by_<segments>`; the options ride verbatim (§2, §2.1) | a member the shape lacks is a compile error | native; a member named like a surface method reads with `get('name')` (`JL0102` says so) |
| `defineModel({ entities?, collections? })` | `{ $model: '0.1', entities?, collections? }`, deep-frozen | `InferMeta<typeof model>` | native; an undeclared relation target `JL0102`; a `collection()` under `entities` `JL0102` |

What `InferMeta<>` says, rule by rule, is what `entityEmitModel` +
`@jarenjs/emit` generate for the same document (pinned equal for the
shared fixture model): every entity interface is CLOSED, nested shapes
included, whatever `.open()` said (the runtime validator stays the judge
of a stored document; excess-property checking is the point of a
generated type); a relation member is an optional reference; a
`datetime()`/`date()` member is `DateTime` on `doc` and a plain `string`
on `input`; `input` drops to-one and to-many projections, makes every
store-written member optional, and types a many-to-many member as
key-or-document array; `key` is the key member's primitive — never its
literal union — or the composite object.

Three rules the table implies:

- **A relation target is a name, checked once.** `rel.hasMany('Post', …)`
  types `'Post'` as a member of `keyof Entities` — `'Psot'` is a compile
  error — and `defineModel` refuses an undeclared name at build time
  (`JL0102`, with the member's `docPath`). Inverse agreement, foreign-key
  types and the join-table rules stay the store's (`JD0031`, `JD0005`).
- **An entity has no `indexes` option.** Its indexes are `unique()`/
  `index()` per member — the vocabulary has no composite or derived
  entity index — so a `collection()` declaration under `entities` is
  refused rather than spelling a document the store would refuse.
- **`uuid()` is still the format shortcut.** The schema pen's `uuid()`
  writes `format: 'uuid'` on the model pen too; the store-allocated key is
  `identity('uuid')`, MODEL-FORMAT §9.5's own word, and a member may carry
  both.

A declared relation member is also what the chain — the query pen —
navigates: over a store opened with this model, `from(store.sync
.entity('Post'))` reads `p.author.email` and `u.posts.all().count()` as
relation HOPS and lowers each to the correlated phrase the engine and the
store both run, so the query document carries no relation name
(LINQ-FORMAT §3, §4 "relation navigation"). The table the chain reads is
the one the store derives from these members (`store.entity(name)
.relations`, MODEL-FORMAT §10.1); `rel.belongsToMany` members are the one
kind it refuses (`JL0105`), because their join table is not a queryable
root in this version.

### 3.2 Worked examples

Every `js` fence exports exactly one model (or builder), and the
`json` fence that follows is what the pen emits — executed by
`test/linq/pens-format.test.js`.

MODEL-FORMAT §9.1's own entity:

```js
import * as m from '@jarenjs/linq/model';

export const model = m.defineModel({
  entities: {
    User: m.object({
      id: m.string().identity('uuid'),
      email: m.string().email().unique(),
      created: m.datetime().now().column('integer').index().optional(),
      profile: m.object({}).open().optional(),
      posts: m.rel.hasMany('Post', { via: 'authorId', onDelete: 'cascade' }),
    }).open(),
    Post: m.object({
      pid: m.integer().identity('auto'),
      authorId: m.string(),
    }).open(),
  },
});
```

```json
{
  "$model": "0.1",
  "entities": {
    "User": {
      "schema": {
        "type": "object",
        "properties": {
          "id": { "type": "string", "x-entity": { "key": true, "default": "uuid" } },
          "email": { "type": "string", "format": "email", "x-entity": { "unique": true } },
          "created": { "type": "string", "format": "date-time",
                       "x-entity": { "default": "now", "column": "integer", "index": true } },
          "profile": { "type": "object" },
          "posts": { "x-entity": { "relation": { "to": "Post", "many": true,
                     "via": "authorId", "onDelete": "cascade" } } }
        },
        "required": ["id", "email"]
      }
    },
    "Post": {
      "schema": {
        "type": "object",
        "properties": {
          "pid": { "type": "integer", "x-entity": { "key": true, "default": "auto" } },
          "authorId": { "type": "string" }
        },
        "required": ["pid", "authorId"]
      }
    }
  }
}
```

A collection with a captured key and every index kind of §2/§2.1:

```js
import * as m from '@jarenjs/linq/model';

export const model = m.defineModel({
  collections: {
    places: m.collection(
      m.object({
        id: m.string(),
        loc: m.array(m.number()),
        series: m.string(),
        t: m.integer(),
        embedding: m.array(m.number()).length(768).optional(),
      }),
      {
        key: (d) => d.id,
        indexes: [
          m.index([(p) => p.series, (p) => p.t]),
          m.index((p) => p.loc, { name: 'by_cell', derive: 'geohash', precision: 7 }),
          m.index((p) => p.embedding, { derive: 'vector', dims: 768 }),
        ],
      },
    ),
  },
});
```

```json
{
  "$model": "0.1",
  "collections": {
    "places": {
      "schema": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "loc": { "type": "array", "items": { "type": "number" } },
          "series": { "type": "string" },
          "t": { "type": "integer" },
          "embedding": { "type": "array", "items": { "type": "number" }, "minItems": 768, "maxItems": 768 }
        },
        "required": ["id", "loc", "series", "t"],
        "additionalProperties": false
      },
      "key": "/id",
      "indexes": [
        { "name": "by_series_t", "path": ["$.series", "$.t"] },
        { "name": "by_cell", "path": "$.loc", "derive": "geohash", "precision": 7 },
        { "name": "by_embedding", "path": "$.embedding", "derive": "vector", "dims": 768 }
      ]
    }
  }
}
```

### 3.3 The types, in one place

```ts
import * as m from '@jarenjs/linq/model';
import type { InferMeta } from '@jarenjs/linq/model';
import { typedStore } from '@jarenjs/db/typed';

const model = m.defineModel({ entities: { User, Post } });
const store = typedStore<InferMeta<typeof model>>(await openStore(model, { driver: nodeDriver() }));
const users = await store.entity('User').load({ include: { posts: true } });
users[0].posts;   // Post[] — widened by the include, no generate step
```

## 4. The JSLT pen — `@jarenjs/linq/jslt`

```js
import { stylesheet, rule, body, apply, op } from '@jarenjs/linq/jslt';
```

writes `$jslt` 0.1 stylesheets ([JSLT-FORMAT](../../json/docs/JSLT-FORMAT.md)):
the envelope and its rules, whose bodies are callbacks captured over `$` —
the matched value — through the chain's recording proxy, with the two
externals the engine binds on every dispatch (`root`, `path`) and the
parameters a body declares. The document is what `compileJsltStylesheet`
takes unchanged; the pen imports no engine and judges nothing the compiler
judges — path syntax (`JT0003`), the body's operators (`JT0007`), a
`schema` match's hook (`JT0006`), the depth guard (`JT2001`) — with one
exception it can see earlier: the `[]` idiom. `body()` is the one
body-capture entry point the migration, flow and app pens reuse.

### 4.1 The mapping table

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `stylesheet(rules, { unmatched?, modes? })` | `{ $jslt: '0.1', unmatched?, modes?, rules }` — the envelope (§2.1), in that member order; the bare-array form is the rules array itself | `Stylesheet<In, Out>`: the FIRST rule's phantoms, or the author's (`stylesheet<In, Out>(…)`) | native; another option, a rule without `body`, a non-array `JL0101` |
| `unmatched` | `unmatched: 'share' \| 'fresh' \| 'error'` (§5) | `Disposition` | native; another value `JL0101` |
| `modes` | `modes: { name: { unmatched } }` (§2.1) | — | native; another member `JL0101` |
| `rule(match, body, { mode?, priority? })` | `{ mode?, match?, priority?, body }` — the rule object (§2.2), in that member order | `Rule<In, Out>` | native; another option `JL0101` |
| `match` as a JSONPath string | `match: '$..price'` (§3.1) | the honest top | native |
| `match` as `{ path?, schema? }` | the object; `schema` a schema-pen builder's document, or a schema verbatim | a builder types the body's value (`Infer<>`) | native; `{}` is `JL0102`; another member, a non-string `path` `JL0101` |
| `match` `null` or absent | no `match` member — the unconditional rule (default priority −1, §4) | the honest top | native |
| `mode` | `mode: 'toc'` (§7) | `string` | native; a non-string `JL0101` |
| `priority` | `priority: 2` (§4) | `number` | native; a non-finite number `JL0101` |
| `body(fn, { externals? })` | the captured query document — `fn(v, x)` with `v` at `$`, `x.root`/`x.path` (§8.2) and the declared parameters as `$name` externals (§8.1); a returned literal is a constructor, a string starting `$` is escaped `$$` | `BodyDocument<In, Out>`: `In` from the annotated `v` (`(v: Expr<Book>) => …`), `Out` the unwrapped return; a declared parameter is `UnknownExpr` until `x` is annotated (`x: Externals<{ rate: number }>`) | native; an undeclared external `JL0104`; `root`/`path` declared `JL0104` |
| a callback where a body is taken | `body(fn)` with no parameters | as above; the match's builder types `v` | native |
| a query document where a body is taken | the document, verbatim (a `body()` result, or by hand) | a `body()` document carries its phantoms; a hand-written one is `unknown` | native; not JSON `JL0101` |
| `apply(selector)` | `{ $apply: selector }` — the rule's own mode (§6.2); the selector an expression (`v.chapters.all()`), a path string verbatim (`'$.chapters[*]'`), or data (`[1, 2]` embeds as `$const`) | `UnknownExpr` — a dispatch to other rules | native; outside `body()` `JL0102` |
| `apply(selector, mode)` | `{ $apply: [selector, mode] }` — the argument-list form (§6.2) | `UnknownExpr` | native; a non-string mode `JL0101` |
| `[apply(…)]` as a member value | `[{ $apply: … }]` — the `[]` idiom (§6.3) | `unknown[]` | native |
| `apply(…)` as a bare member value | — | — | refused (`JL0102`): the engine fails at run time on the second child (`JQ2001`) |
| `op(name, operands)` | `{ [name]: operands }` — a registered operator (§13), spelled without judging it; one operand or a list | `UnknownExpr` | native; the engine's `JQ0002` decides; a name without `$` `JL0101`; outside any capture `JL0005` |

Three rules the table implies, spelled out:

- **A body's literal is a constructor, not a constant.** The chain folds a
  pure data tree into one `$const` (LINQ-FORMAT §3); a body spells it as
  the format's own object constructor — Appendix A.6's `{ "level":
  "unknown" }` — the same value, the published spelling. A string starting
  `$` is data only with the `$$` escape, so the pen writes it.
- **`root` and `path` need no declaration; a parameter needs one.** The
  engine binds the two on every dispatch (§8.2) and shadows any binding of
  the same name, so declaring them is the mistake and is refused. A
  parameter is `body(fn, { externals: ['rate'] })`, and `transform.externals`
  lists exactly the declared names the body used (§8.3).
- **The pen judges nothing the compiler judges.** A path that does not
  parse, an operator no registry answers, a `schema` match compiled without
  a hook, a self-applying loop: each is the engine's own error
  (`JT0003`, `JT0007`/`JQ0002`, `JT0006`, `JT2001`), unwrapped. The one
  refusal the pen adds is the one the engine would only raise at RUN time.

### 4.2 Worked examples

Every `js` fence exports exactly one stylesheet (or rule list), and the
`json` fence that follows is what the pen emits — executed by
`test/linq/pens-format.test.js`. The seven fixtures of JSLT-FORMAT
Appendix A are all rebuilt through the pen and held byte-equal to the
format doc by `test/linq/jslt-pen.test.js`; three of them here.

JSLT-FORMAT A.3 — the book example, done right (the `[]` around the
`apply`):

```js
import { stylesheet, rule, apply } from '@jarenjs/linq/jslt';

export const book = stylesheet([
  rule({ schema: { type: 'object', required: ['isbn'] } },
    (v) => ({ title: v.title, children: [apply(v.chapters.all())] })),
  rule({ schema: { type: 'object', required: ['heading'] } },
    (v) => ({ name: v.heading })),
]);
```

```json
{ "$jslt": "0.1",
  "rules": [
    { "match": { "schema": { "type": "object", "required": ["isbn"] } },
      "body": { "title": "$.title",
                "children": [ { "$apply": "$.chapters[*]" } ] } },
    { "match": { "schema": { "type": "object", "required": ["heading"] } },
      "body": { "name": "$.heading" } }
  ] }
```

A.4 — two modes, the argument-list form of `apply`:

```js
import { stylesheet, rule, apply } from '@jarenjs/linq/jslt';

export const guide = stylesheet([
  rule('$', (v) => ({
    toc: [apply(v.sections.all(), 'toc')],
    body: [apply(v.sections.all(), 'render')],
  })),
  rule('$.sections[*]', (v) => ({ ref: v.id, label: v.heading }), { mode: 'toc' }),
  rule('$.sections[*]', (v) => ({ anchor: v.id, heading: v.heading, text: v.text }), { mode: 'render' }),
]);
```

```json
{ "$jslt": "0.1",
  "rules": [
    { "match": "$",
      "body": { "toc":  [ { "$apply": ["$.sections[*]", "toc"] } ],
                "body": [ { "$apply": ["$.sections[*]", "render"] } ] } },
    { "mode": "toc", "match": "$.sections[*]",
      "body": { "ref": "$.id", "label": "$.heading" } },
    { "mode": "render", "match": "$.sections[*]",
      "body": { "anchor": "$.id", "heading": "$.heading", "text": "$.text" } }
  ] }
```

A.7 — a declared parameter and the two reserved externals, in the
bare-array form:

```js
import { rule, body } from '@jarenjs/linq/jslt';

export const priced = [
  rule('$..price', body(
    (v, x) => ({ amount: v.mul(x.rate), currency: x.root.currency, at: x.path }),
    { externals: ['rate'] })),
];
```

```json
[ { "match": "$..price",
    "body": { "amount": { "$mul": ["$", "$rate"] },
              "currency": "$root.currency",
              "at": "$path" } } ]
```

### 4.3 The types, in one place

```ts
import { stylesheet, rule, body, apply } from '@jarenjs/linq/jslt';
import type { Externals, Output, Stylesheet } from '@jarenjs/linq/jslt';
import type { Expr } from '@jarenjs/linq';

interface Chapter { heading: string }
interface Book { title: string; chapters: Chapter[] }

const chapter = rule({ schema: ChapterSchema }, (v) => ({ name: v.heading }));
//    ^ Rule<Infer<typeof ChapterSchema>, { name: string }> — the builder types v
const book = body((v: Expr<Book>) => ({ title: v.title, children: [apply(v.chapters.all())] }));
//    ^ BodyDocument<Book, { title: string; children: unknown[] }> — a dispatch is unknown
const priced = body(
  (v: Expr<Item>, x: Externals<{ rate: number }>) => ({ amount: v.price.mul(x.rate) }),
  { externals: ['rate'] });                        // x.limit does not compile

const sheet = stylesheet([rule(null, book), chapter]);
type Out = Output<typeof sheet>;                   // the FIRST rule's: { title: string; children: unknown[] }
const typed = stylesheet<Book, { title: string; children: { name: string }[] }>([rule(null, book), chapter]);
```

A stylesheet's output is its root rule's, and every `apply()` inside it
is `unknown` — a dispatch lands on whichever rule wins, which no type can
see. Where the author knows (a chapter always renders as `{ name }`), the
author says so with `stylesheet<In, Out>(…)`; the built-in rule's
rebuilds around an unmatched root are not typed at all.

## 5. The migration pen — `@jarenjs/linq/migration`

```js
import { defineMigration, fromPlanned } from '@jarenjs/linq/migration';
```

writes `$migration` 0.1 documents ([MIGRATION-FORMAT](../../db/docs/MIGRATION-FORMAT.md)):
the two shape hashes and the ordered steps the runner takes unchanged.
Identity stays the shape hash — `from`/`to` are
`hashContent(canonicalizeJson(model))` with the `x-rename` planning
hints stripped, the store's own rule, and a test holds the pen's hash
equal to the store's `shapeHash` over every corpus model. The planner
still plans: `jaren-db plan` renders the DDL and leaves the data
transform it cannot infer as a draft; `fromPlanned(planned, { from, to })`
takes that document up so a `transform` typed old row → new row REPLACES
the draft, in place. The pen never clears a `draft` flag — a draft left
alone still refuses to run (`JD0021`, the runner's rule) — and it imports
no store and no engine: the transform's body is the JSLT pen's capture,
the hash is `@jarenjs/core`'s over `@jarenjs/json`'s canonical form.

### 5.1 The mapping table

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `defineMigration({ id, from, to, note? })` | `{ $migration: '0.1', id, from, to, note?, steps }` — `from`/`to` the two models' shape hashes, exactly `shapeHash` (pinned) | `Migration<From, To>`, the two model documents' phantoms | native; not a `$model` document, an empty `id`, another member `JL0101` |
| `.ddl(sql, note?)` | `{ kind: 'ddl', sql, note? }` — one rendered statement (§2) | — | native; an empty statement `JL0101` |
| `.sql(sql, note?)` | `{ kind: 'sql', sql, note? }` — one data statement spelled directly (§9.4) | — | native |
| `.transform(name, (row, x) => …)` | `{ kind: 'jslt', collection: name, stylesheet: [{ match: '$', body }] }` — one root rule, the body captured through the JSLT pen's `body()` over the WHOLE row, `x.root`/`x.path` the externals the engine binds (§8.2 of JSLT-FORMAT) | `row` is `Expr<Old>` (`InferMeta<typeof from>[name]['doc']`); the result must spell `New` — a dropped, mistyped or foreign member does not compile; the honest top (`get()`) is admitted where a precise value is | native; a table the target model does not declare `JL0106`; an undeclared external `JL0104` |
| `.transform(name, stylesheet(…))`, `.transform(name, rules)` | the rules ARRAY — a `jslt` step carries the array, so the envelope's `unmatched`/`modes` have no place in it | a typed stylesheet's or first rule's `Out` must be `New`; a hand-written rule is the honest top | native; a disposition or a mode table `JL0102`; not JSON `JL0101` |
| `.assert(name, (row) => …, { expect? })` | `{ kind: 'query', collection: name, assert: { $for: { it: '$[*]' }, $where: <predicate>, $return: '$it' }, expect? }` — the format's own `$for` over the rows; the predicate names the VIOLATION (`expect: 'empty'`, the default, absent from the document) or the witness (`expect: 'ebv'`) | `row` is the members the two shapes share — a precondition sees old rows, a postcondition new ones, and what both agree on is what neither lies about; annotate (`(row: Expr<User>) => …`) when one shape is meant | native; another `expect` `JL0101`; an external `JL0104` |
| `.assert(name, query, { expect? })` | the query document verbatim | — | native |
| `.derive(name, columns)` | `{ kind: 'derive', collection: name, columns }` — a backfill of stored derived columns (§2.1), the columns verbatim | — | native; no columns `JL0101` |
| `.step(raw)` | any planner-emitted step, verbatim — the escape that keeps `rebuild` (§10) authorable without the pen re-implementing it; a `draft` flag rides untouched | `MigrationStep` | native; an unrecognised kind or a missing member (the runner's `JD0023` rules, seen early) `JL0101` |
| `fromPlanned(document, { from?, to? })` | the planner's document, taken up: `.transform(name, …)` replaces its draft for `name` in place; the other methods append | the models type the transforms and are checked against the document's hashes | native; a model that is not the planned one `JL0102`; two drafts for one name, or no draft and no target model `JL0106` |
| `.document`, `toJSON()` | the deep-frozen `$migration` document | `MigrationDocument` | native |

Three rules the table implies, spelled out:

- **Identity stays the shape hash.** A database stores hashes, not
  models; the pen computes what the store computes, from the same two
  functions, with the same hint stripped — and the pin over every corpus
  model is what keeps the two equal.
- **The planner still plans; the pen types the human part.** The
  workflow: a model module → `jaren-db plan --model ./model.js` (diffs
  the committed `model.snapshot.json` against the model, writes the
  migration with `--out`, advances the snapshot) → a migration module
  built with `fromPlanned(planned, { from, to })` and a typed `transform`
  → `jaren-db check` in CI (an unplanned model change, a pending
  migration or drift exits 1) → `jaren-db apply`. `jaren-db` loads model
  and migration modules beside JSON and refuses one that is not pure.
- **A step's table is one the target model declares.** The runner would
  fail the statement on a table that does not exist; the pen says so
  first (`JL0106`) — for `transform`, `assert` and `derive` alike, when
  it knows the target. Over a planned document alone it knows only the
  drafts, so a transform for another table is spelled with `step()`.

### 5.2 Worked examples

Every `js` fence exports exactly one migration, and the `json` fence that
follows is what the pen emits — executed by
`test/linq/pens-format.test.js`.

A migration by hand between two model-pen models — the DDL the planner
would render, a typed transform, an assertion:

```js
import * as m from '@jarenjs/linq/model';
import { defineMigration } from '@jarenjs/linq/migration';

const v1 = m.defineModel({ entities: { User: m.object({ id: m.string().key(), name: m.string() }) } });
const v2 = m.defineModel({ entities: { User: m.object({ id: m.string().key(), name: m.string(), handle: m.string() }) } });

export const handles = defineMigration({ id: '0002-handles', from: v1, to: v2 })
  .ddl('ALTER TABLE "User" ADD COLUMN "handle" TEXT')
  .transform('User', (u) => ({ id: u.id, name: u.name, handle: u.name.lower() }))
  .assert('User', (u) => u.handle.isEmpty());
```

```json
{ "$migration": "0.1", "id": "0002-handles", "from": "1410er5", "to": "eedea8",
  "steps": [
    { "kind": "ddl", "sql": "ALTER TABLE \"User\" ADD COLUMN \"handle\" TEXT" },
    { "kind": "jslt", "collection": "User",
      "stylesheet": [ { "match": "$",
                        "body": { "id": "$.id", "name": "$.name", "handle": { "$lower": "$.name" } } } ] },
    { "kind": "query", "collection": "User",
      "assert": { "$for": { "it": "$[*]" }, "$where": { "$empty": "$it.handle" }, "$return": "$it" } }
  ] }
```

The bridge — the document `jaren-db plan --model ./model.js` wrote,
with its draft replaced by a typed transform:

```js
import * as m from '@jarenjs/linq/model';
import { fromPlanned } from '@jarenjs/linq/migration';

const v1 = m.defineModel({ entities: { User: m.object({ id: m.string().key(), name: m.string() }) } });
const v2 = m.defineModel({ entities: { User: m.object({ id: m.string().key(), name: m.string(), handle: m.string() }) } });

// what the planner wrote: the DDL it rendered, and the transform it
// could not infer, left as a draft that refuses to run
const planned = {
  $migration: '0.1', id: '0002-handles', from: '1410er5', to: 'eedea8',
  steps: [
    { kind: 'ddl', sql: 'ALTER TABLE "User" ADD COLUMN "handle" TEXT', note: "add column 'handle' on 'User'" },
    { kind: 'jslt', collection: 'User', stylesheet: [], draft: true,
      note: "the document schema of entity 'User' changed; fill in the transform (or delete this step if every stored document already validates) and remove \"draft\"" },
  ],
};

export const typed = fromPlanned(planned, { from: v1, to: v2 })
  .transform('User', (u) => ({ id: u.id, name: u.name, handle: u.name.lower() }));
```

```json
{ "$migration": "0.1", "id": "0002-handles", "from": "1410er5", "to": "eedea8",
  "steps": [
    { "kind": "ddl", "sql": "ALTER TABLE \"User\" ADD COLUMN \"handle\" TEXT",
      "note": "add column 'handle' on 'User'" },
    { "kind": "jslt", "collection": "User",
      "stylesheet": [ { "match": "$",
                        "body": { "id": "$.id", "name": "$.name", "handle": { "$lower": "$.name" } } } ] }
  ] }
```

### 5.3 The types, in one place

```ts
import { defineMigration, fromPlanned } from '@jarenjs/linq/migration';
import type { DocOf } from '@jarenjs/linq/migration';
import type { Expr } from '@jarenjs/linq';
import { model as v1 } from './models/v1.js';   // the previous model module, kept beside the current one
import { model as v2 } from './model.js';

const handles = defineMigration({ id: '0002-handles', from: v1, to: v2 })
  .transform('User', (u) => ({ id: u.id, name: u.name, handle: u.name.lower() }));
//                     ^ Expr<DocOf<typeof v1, 'User'>> — the OLD row
//                                                        ^ must spell the NEW row: a dropped `handle` does not compile
fromPlanned(planned, { from: v1, to: v2 }).transform('User', (u) => ({ id: u.id, name: u.name, handle: u.name.lower() }));
```

The honest limit: from a JSON snapshot (`from: snapshot`) the old row is
`unknown` and `u` the honest top, because a JSON literal is never
inferred (§1.1, rule 2). Two routes keep the type: keep the previous
model module beside the current one, as above; or ask the CLI for emit's
declaration of the snapshot — `jaren-db snapshot --model ./model.js
--types ./model.d.ts` — and annotate the row from it, `(u: Expr<User>)
=> …`. A body's extra member is caught on a direct annotation of the
spelling (`Spell<New>`); a contextually typed callback result is not
excess-checked by TypeScript, and the closed target schema refuses the
member at run time.

## 6. The client — `@jarenjs/linq/db`

The store's front door: `open(model, options)` opens `@jarenjs/db`'s
store and fronts it with handles typed from the model pen. It is not a
pen in §1's sense — it emits no document of its own — but it keeps the
pen rules where they apply: every read is a chain (the query document)
or the store's own `load` specification, EMITTED here and never run
here; the types are the pen's phantoms (`InferMeta<>`, no cast, no
generate step); refusals are coded (`JL0107`, `JL0101`); and the store
stays the engine — the client adds no storage semantics and duplicates
no algorithm.

**The edge.** This subpath is the package's one runtime import edge:
`packages/linq/src/db/` imports `@jarenjs/db`, `@jarenjs/validate` and
`@jarenjs/formats`, declared under `peerDependencies` with
`peerDependenciesMeta.optional: true` and never under `dependencies`.
A consumer of `.` (the chain) or of any pen installs nothing new; a
consumer of `./db` installs the three; the store never imports this
package. Three gates hold it: the tree-shaking probes (the `.` entry
carries no client module and not one byte of the three; the `./db`
bundle carries all three and no other pen — its size is stated in
CONSUMING and checked against the measured bundle), the packed-consumer
gate (every subpath is imported WITHOUT the peers first — `./db` must
fail by a peer's name and nothing else may fail — then with them
installed from the tarballs), and the edge suite in
`test/db/provider.test.js` (both manifests, and every source and
declaration file of both packages, for every import spelling).

### 6.1 What is the store's and what is the client's

| Member | Whose | What the client does |
|---|---|---|
| `open(model, { driver, …, validator? })` | the store's `openStore`, every option forwarded verbatim (`capture`, `live`, `jobs`, `profile`, … included) | wires `validator` as `compileSchema` — the default, `defaultValidator()`, is `new JarenValidator({ collectErrors: true })` with the string and date-time formats registered (the configuration MIGRATING-FROM-ZOD's recipe reproduces, so `s.string().email()` asserts out of the box); an explicit `compileSchema` wins; `validator: null` opens unvalidated, by name (`capabilities.validated === false`) |
| `client.entities.<Name>` | one frozen handle per declared entity, built at open (no Proxy; an unknown name is `undefined`, and for a pen model a compile error) | the store's typed entity set, every member — `create get update delete load explainLoad add put remove discard link unlink asNoTracking execute explain root scope relations` — plus the rows below |
| `where`, `select`, `orderBy`, …, `toArray`, `first`, `count`, … | the chain: `fromAsync(handle)` (LINQ-FORMAT §8, §10) | every `AsyncSequence` operator and terminal, delegated — nothing is duplicated, every read is the chain's document and pushes down; the handle is iterable (`for await`); `explain()` without a document explains the empty chain, `explain(document)` is the store's; two handles of one client share a `scope`, so a join's inner may be `fromAsync(otherHandle)` |
| `include(pick, spec?)` | the store's `load(spec)` (MODEL-FORMAT §10.4, §10.5) | opens a graph that EMITS the spec (§6.2), typed `Loaded<>` by what it included; `where`/`orderBy`/`orderByDescending`/`thenBy`/`thenByDescending`/`take`/`skip`/`after`/`maxDepth` are the root's clauses; `asNoTracking()` the untracked load; `toSpec()`/`toJSON()` the document; `toArray()` is `load(spec)`; `explain()` is `explainLoad(spec)` — the SQL, the includes, the pagination strategy |
| `link(own, member, target)`, `unlink(…)` | the store's membership API (MODEL-FORMAT §11.7) | reads the relation table first — the member must be a many-to-many relation (`JL0107`, naming the kind it is, or the declared members) — then records through the store; `saveChanges()` writes the join rows; typed over exactly the many-to-many members (the ones the generated input type also carries) |
| `live(chain \| document, options?)` | the store's registration — `store.live` for an entity root, `collection.live` for a collection (LIVE-FORMAT §7) | hands over the chain's document and its `explain().bindings` as the externals (`options.externals` merge over them); the strategy, the reason and the maintenance are the store's — an entity chain re-runs, declared, a translatable collection chain is incremental; without capture the store's `JD0050` surfaces unchanged; a chain split by `mapAsync` has no document (`JL0005`); the rows are typed by the chain's item |
| `client.collections.<name>` | the store's collection | the same chain start and `live`, typed from the pen's collection schema |
| `saveChanges()`, `transaction(fn)`, `close()`, `capabilities`, `store` | the store's | pass-throughs (`saveChanges` and `live` exist exactly when the model declares entities, as on the store); `store` is the escape hatch, typed `TypedStore` |

### 6.2 Worked examples

`include((u) => u.posts, spec)` captures the member's NAME — `(u) =>
u.posts`, or `u.get('posts')` for a name that collides with a method; a
scalar member, or one the model does not declare, is `JL0107` naming the
declared relations — and lowers the spec to exactly what MODEL-FORMAT
§10.4 reads. Every callback is captured over `$it` through the chain's
recording proxy with no parameters (a load clause binds no externals:
`p.min` is `JL0004`):

| Spec member | Emitted | Note |
|---|---|---|
| absent, or `true` | `true` | the rows |
| `{ count: true }` | `{ count: true }` | the number; any other member beside it is the store's `JD0032` |
| `where: (p) => p.stars.ge(3)` | `where: { $ge: ['$it.stars', 3] }` | the target row is `it`; translatability is the store's verdict (`JD0032`), a relation hop is a plain path here and refused there |
| `orderBy: (p) => p.pid` | `orderBy: '$it.pid'` | a bare key, ascending |
| `orderBy: { key: (p) => p.stars, desc: true, empty?, collation? }` | `orderBy: { $key: '$it.stars', $dir: 'desc', $empty?, $collation? }` | as the chain spells `$orderby`; an array of either is an array |
| `take`, `skip` | `take`, `skip` | the window inside the subquery (a non-integer is the store's `JD0032`) |
| `include: { comments: spec }` | `include: { comments: <lowered> }` | over the TARGET's relation table (the scope carries every root's); an undeclared member is `JL0107` |
| anything else | `JL0101` | the vocabulary is closed; `after` paginates the root (`.after(cursor)` on the graph), never an include |

Member order is fixed — `where, orderBy, take, skip, count, include` in
an include; `where, orderBy, take, skip, after, maxDepth, include` at the
root — and consecutive root `where`s conjoin under one `$and`, so one
graph is one deep-frozen document (a snapshot: mutating it changes
nothing; two builds are one document).

```js
import { open } from '@jarenjs/linq/db';
import * as m from '@jarenjs/linq/model';
import { nodeDriver } from '@jarenjs/db/node';

const User = m.object({
  id: m.string().identity('uuid'),
  email: m.string().email(),
  posts: m.rel.hasMany('Post', { via: 'authorId', onDelete: 'cascade' }),
  labels: m.rel.belongsToMany('Label'),
});
const Post = m.object({ pid: m.integer().identity('auto'), stars: m.integer(), authorId: m.string() });
const Label = m.object({ name: m.string().key() });
const client = await open(m.defineModel({ entities: { User, Post, Label } }), { driver: nodeDriver() });

// the graph EMITS the load spec below; toArray() is load(spec) — one statement — and
// explain() is explainLoad(spec); the rows type as User & { posts: Post[]; labels: number }
export const graph = client.entities.User
  .include((u) => u.posts, { where: (p) => p.stars.ge(3), take: 2 })
  .include((u) => u.labels, { count: true });
```
```json
{ "include": { "posts": { "where": { "$ge": ["$it.stars", 3] }, "take": 2 }, "labels": { "count": true } } }
```

### 6.3 The types, in one place

```ts
import { open } from '@jarenjs/linq/db';
import type { Client, EntityHandle, Graph, TypedLiveQuery } from '@jarenjs/linq/db';
import type { InferMeta } from '@jarenjs/linq/model';
import type { EntityMetaMap } from './generated.js';   // a JSON model's map, when one exists

const client = await open(model, { driver });          // Client<InferMeta<typeof model>>
client.entities.Post.where((p) => p.stars.ge(3));      // AsyncSequence<Post> — the entity document, no cast
const users = await client.entities.User
  .include((u) => u.posts, { where: (p) => p.stars.ge(3) })   // p: Expr<Post> — the TARGET entity
  .include((u) => u.labels, { count: true })
  .toArray();                                          // (User & { posts: Post[]; labels: number })[]
client.entities.User.link('u1', 'labels', 'admin');    // member: the many-to-many members only
client.entities.User.link('u1', 'posts', 1);           // does not compile — posts is oneToMany
client.entities.User.include((u) => u.email);          // does not compile — not a relation member
const live: TypedLiveQuery<Post> = await client.live(client.entities.Post.where((p) => p.stars.ge(3)));
open<EntityMetaMap>(json, { driver });                 // a JSON model with a named map
open(json, { driver });                                // Client<Record<string, EntityMeta>> — a literal is never inferred
```

The honest limits: `where`/`orderBy` inside an include are typed over
the target entity but checked for translatability by the store, not by
TypeScript; a `link` target is typed as the target's key or document,
and the store's own reading of it applies (`JD2003` for a document
without the key); a JSON model opened without a named map is the wide
map — every name exists at the type level and an unknown one is
`undefined` at run time; and the client's members mirror the store's
presence, so a collections-only model has no `saveChanges` and no
`live` (a compile error on a pen model, `undefined` on the wide map).
