# The Jaren pens (normative)

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119.

## 1. Scope and the pen rules

A **pen** is a by-code front-end to one of the suite's document formats:
named functions that build a standard document — a JSON Schema, a
`$model`, a `$jslt` stylesheet — the way the chain builds a query
document. `@jarenjs/linq` exports each pen under its own subpath
(`@jarenjs/linq/schema`, `/model` and `/jslt` so far); `.` stays the chain. This document
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
