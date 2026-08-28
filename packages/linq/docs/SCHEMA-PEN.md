# The Jaren schema pen (normative)

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119. The rules every pen keeps, the
shared refusal table and the index of the other pens are the binder,
[LINQ-FORMAT.md](LINQ-FORMAT.md).

## 1. What it writes

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

Four things are worth naming before the tables, because the rest of this
document assumes them:

- **The format is standard.** The document a builder emits is JSON Schema
  2020-12 and nothing else, valid under the published meta-schema — which
  `test/linq/schema-pen.test.js` asserts for every corpus entry, over the
  draft `@jarenjs/refs` carries. Three keyword families ride beside it,
  each already part of the suite's own vocabulary and each ignored by a
  validator that does not know it: `$query` (a cross-field rule, the
  query language of `packages/json/docs/QUERY-FORMAT.md`),
  `errorMessage` (the validator's author-supplied messages, string, map
  or `$msgid` form), and `x-coerce`/`x-trim` (the normalizer's per-field
  predicates).
- **The engine is somewhere else.** Nothing under
  `packages/linq/src/schema/` imports `@jarenjs/validate`, `@jarenjs/emit`
  or `@jarenjs/db` — a test asserts it file by file. The pen writes a
  document; the validator's compiler stays the only judge of what a
  keyword means. That is what §7's price is made of.
- **Immutability and identity are the binder's rules, and this pen keeps
  them.** Every method answers a new builder, `.schema` assembles once
  and memoizes, and a `named()` builder is one `$defs` entry however many
  places reach it — stated in full, for every pen, in
  [LINQ-FORMAT.md](LINQ-FORMAT.md) §1.2.

One complete round trip — build, read the document, compile it, run it:

```js
import * as s from '@jarenjs/linq/schema';
import { JarenValidator } from '@jarenjs/validate';

const User = s.object({
  id: s.string().uuid(),
  name: s.string().min(1),
  age: s.integer().min(0).optional(),
});

const validate = new JarenValidator().compile(User.schema);
validate({ id: '3f1a…', name: 'Ada' });          // true
validate({ id: '3f1a…', name: '', age: -1 });    // false
```

The `$query` expressions a `check()` captures are the chain's own, and
their operators are documented once, in [QUERY-PEN.md](QUERY-PEN.md) §4.
The rules this pen keeps because every pen keeps them — immutability,
identity, the name → value map rule, the shared refusal table — are in
[LINQ-FORMAT.md](LINQ-FORMAT.md) and are not restated here.

## 2. The mapping table

Every name `@jarenjs/linq/schema` exports that a caller writes, and every
method reachable on a builder it hands back. The eight builder classes,
the one constant and the one guard it also exports are §5's, because a
caller meets those through a type annotation, a subclass or an
`instanceof` narrow rather than by calling one.

Status: **native** (emits the named keyword), **emulated** (a composition
with identical semantics), **refused** (a coded error naming the reason).

### 2.1 Primitives, literals and enums

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `string()` | `{ type: 'string' }` | `string` | native |
| `number()` | `{ type: 'number' }` | `number` | native |
| `integer()` | `{ type: 'integer' }` | `number` (integer-ness is a documented widening) | native |
| number `.int()` | `{ type: 'integer' }` — the same node, retyped; `number().int()` and `integer()` are one document | `number` | native |
| `boolean()` | `{ type: 'boolean' }` | `boolean` | native |
| `nil()` | `{ type: 'null' }` | `null` | native |
| `literal(v)` | `{ const: v }` | the literal | native |
| `enumOf(values)` | `{ enum: values }` — an UNTYPED enum, any mix of JSON values | the literal union | native; an empty or non-array argument is `JL0101` |
| string/number `.enumOf(values)` | `enum` beside the `type` — a typed enum (what a store maps to a column); values of another JSON type are `JL0101` | the literal union; with `.coerce()` the `Input` widens by the one source primitive that can reach a member (`1 \| 2 \| 3 \| string`) | native |
| `datetime()`, `date()` | `{ type: 'string', format: 'date-time' \| 'date' }` | `DateTime` | native |
| `time()`, `duration()` | `{ type: 'string', format: 'time' \| 'duration' }` | `string` | native |
| `any()` | `{}` | `unknown` | native |
| `never()` | `false` | `never` | native; it carries no annotation and no check (`JL0102`) |

### 2.2 Objects

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `object(props)` | `{ type: 'object', properties, required, additionalProperties: false }` — `required` lists every member not `optional()`, in declaration order, and is omitted when empty | a closed object: members required unless `optional()`; no index signature; `object({})` is `Record<string, never>` | native |
| `.open()` | drops `additionalProperties: false` | `& { [k: string]: unknown }` | native |
| `.optional()` | the member leaves `required` | `?:` (on both sides; a `default()`ed member is present on `Infer`) | native |
| `.nullable()` | `type: [t, 'null']` on a typed node; `enum: [..., null]` on `enumOf`/`literal`; `anyOf: [node, { type: 'null' }]` on the rest | `\| null` | native / emulated |
| `record(values)` | `{ type: 'object', additionalProperties: values }` | `{ [k: string]: V }` | native |
| `.minProperties(n)`, `.maxProperties(n)` | `minProperties`, `maxProperties` | — | native |
| `.dependentRequired(map)` | `dependentRequired`, cloned | — | native; anything but a name → array-of-names map is `JL0101` |
| `.propertyNames(b)` | `propertyNames` | — | native |
| `.patternProperties(map)` | `patternProperties` | on a closed object the index signature carries the pattern values widened over the members (`[k: string]: V \| members`); on an open one `unknown` | native |
| `.extend(props)` | the reshaped `properties`/`required` — a later spelling of a name REPLACES the earlier one and moves to the end | the reshaped members | emulated |
| `.pick(keys)`, `.omit(keys)` | the selected `properties`, in the original order | `Pick<>` / `Omit<>` | emulated; a name the object does not carry is `JL0101` |
| `.partial()` | every member `optional()`, so `required` disappears | every member `?:` | emulated |
| `.required(keys?)` | the named members required again; every member when no keys are given | the members no longer `?:` | emulated |

### 2.3 Arrays and tuples

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `array(items)` | `{ type: 'array', items }` | `T[]` | native |
| array `.min(n)`, `.max(n)`, `.length(n)` | `minItems`, `maxItems`, both | — | native |
| array `.unique()` | `uniqueItems: true` | — | native |
| array `.contains(b)` | `contains` | — | native; a normalizer keyword inside it is `JL0102` |
| `tuple(items)` | `{ type: 'array', prefixItems, minItems: items.length }` | `[A, B, ...unknown[]]` — every position required, the rest open (emit's reading of an omitted `items`) | native |
| tuple `.rest(b)` | `items: b`; `rest(never())` is `items: false` | `[A, B, ...R[]]`; `[A, B]` | native |

### 2.4 Strings

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| string `.min(n)`, `.max(n)`, `.length(n)` | `minLength`, `maxLength`, both | — | native |
| string `.pattern(p)` | `pattern` (a string, or a flagless `RegExp` by its source) | — | native; flags are `JL0102` |
| string `.format(f)` | `format` | `DateTime` for `'date-time'`/`'date'`, `string` otherwise | native |
| string `.email()`, `.uuid()`, `.uri()` | `format: 'email' \| 'uuid' \| 'uri'` | `string` | native |

### 2.5 Numbers

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| number `.min(n)`, `.max(n)` | `minimum`, `maximum` | — | native |
| number `.gt(n)`, `.lt(n)` | `exclusiveMinimum`, `exclusiveMaximum` | — | native |
| number `.multipleOf(n)` | `multipleOf` | — | native; zero or a negative is `JL0101` |

### 2.6 Composition

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `union(options)` | `{ anyOf }` — an option may be a builder or a hand-written JSON Schema (`true`/`false` included), wrapped as `from(json)` | `A \| B` | native |
| `discriminated(key, options)` | `{ oneOf }` — every option an object declaring `key` as a `literal()`/`enumOf()` member | `A \| B` | native; a missing tag is `JL0102` |
| `intersection(parts)` | `{ allOf }` | `A & B` | native; a closed object part is `JL0102` (the parts would reject each other's members — `open()` them, or `extend()`) |
| `when(cond)`, `.then(b)`, `.else(b)` | `{ if, then, else }` | `unknown` (emit records a conditional, never types it) | native |

### 2.7 References and `$defs`

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `named(name, b)` | `$defs[name]` at the document root, `{ $ref: '#/$defs/name' }` where reached — once, however many places reach it | `Infer<b>` | native; a name outside `[A-Za-z_][A-Za-z0-9_.-]*` is `JL0101`; two distinct builders under one name are `JL0103` |
| `ref(name)` | `{ $ref: '#/$defs/name' }` | `T` as asserted (`ref<T>`) | native; a name no `named()` in the document answers is `JL0103` |
| `lazy(() => Named)` | as `named` — the recursion spelling | `T` as annotated on the recursive constant | native; a thunk that is not a function is `JL0101`; an unnamed or non-builder target is `JL0103` |
| `from(json)` | the JSON, verbatim (cloned, so the document is its own tree) | `T` as asserted (`from<T>`) | native; anything but an object or a boolean is `JL0101` |

### 2.8 Annotations and messages

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `.describe(text)`, `.title(text)` | `description`, `title` | — | native |
| `.example(v)` | one more entry of `examples`, in call order | — | native |
| `.meta(annotations)` | the keys verbatim, in the order first set | — | native; a pen-owned keyword is `JL0104` |
| `.message(spec)` | `errorMessage: spec` (the validator's string, map or `$msgid` forms) | — | native |
| `.annotate(key, value)` | one annotation keyword — the primitive the four above are written in terms of, and the one a subclass overrides | `this` | native; `never()` overrides it to refuse (`JL0102`) |
| `.annotation(key)` | nothing: it READS the annotation a builder already carries, or `undefined` — what a subclass consults before it folds one into a keyword it owns | the value as stored | native |

Annotations are written after the structural keywords and the
constraints, in the order they were FIRST set; setting one twice replaces
the value and keeps the position. Constraint keywords follow the same
rule through `.keyword()`.

### 2.9 Validation extensions

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `.check(fn)` | `$query`: the callback captured through the chain's proxy — `fn(value, { root, path })`, the value at `$`, the two externals the validator binds; two checks conjoin with `$and` | — (a dropped constraint) | native; another external is `JL0104` |
| `.check(query)` | `$query`: a query document embedded verbatim | — | native; a value that is not JSON is `JL0101` |
| `.coerce()` | `'x-coerce': true` on a scalar — the normalizer's per-field predicate | `Input` widens to the transport forms: string `\| number \| boolean`, number/integer `\| string`, boolean `\| string`, null `\| string` | native; on a non-scalar or a nullable, `JL0102` |
| `.trim()` | `'x-trim': true` on a string | — | native; off a string, `JL0102` |

### 2.10 The document, and the builder itself

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `document(root, { draft })` | the document, with `$schema` first for `'2020-12'`; without a draft, the root's document unchanged | — | native; another draft, or a draft on a boolean schema, is `JL0102` |
| `.schema` | the assembled document — a deep-frozen value, computed once and memoized | `JsonSchema \| boolean` | native |
| `.toJSON()` | the same document, so `JSON.stringify(builder)` is the document | `JsonSchema \| boolean` | native |
| `.state` | the frozen builder state (kind, children, keywords, annotations) — what a subclass reads, never a document | the state object | native |
| `.with(patch)` | nothing: a NEW builder of the same class with part of the state replaced. Every method above is written in terms of it, and a subclass keeps its own class through all of them | `this` | native |
| `.keyword(key, value)` | one constraint keyword, in the order first set | `this` | native |
| `schemaOf(value)` | nothing: the document of a builder, or the value as given — the one call a consumer needs to accept "a schema, by hand or by pen" | `unknown` | native |
| `requireJson(value, what)` | nothing: the JSON boundary every value entering a document crosses, exported so a pen built over this one uses the same door | `T` | native; a non-JSON value is `JL0101` |
| `createFactories(classes)` | nothing: the named factories above, built for one SET of builder classes. `@jarenjs/linq/model` and `@jarenjs/linq/forms` call it with their subclasses, which is why the wiring exists exactly once and no subpath patches another's prototype | the factory record | native |

Three rules the tables imply, spelled out:

- **A default or coercion lives where the normalizer reaches.**
  `compileNormalizer` does not descend `anyOf`/`oneOf` branches,
  `if`/`then`/`else`, `contains` or `propertyNames`, so a `default()`,
  `coerce()` or `trim()` under one would promise a normalization that
  never happens; the pen refuses it (`JL0102`) at assembly, naming the
  branch and the `docPath`. The same rule is why `coerce()` and
  `nullable()` exclude each other: the normalizer coerces only a
  single-typed scalar.
- **A rule against the root reads from the root.** `check()`'s `root` is
  an object whose members are the honest top, so a typed member compares
  with it from the root's side — `x.root.currency.eq(l.currency)` — the
  unknown expression takes any operand; the typed one takes its own kind.
- **A `when()` builder is thenable-shaped.** Its `then()` takes a schema,
  so a promise that resolves one calls it with a function and is refused
  by name (`JL0101`); keep builders out of async return positions.

## 3. Worked examples

Every `js` fence below exports exactly one builder (or one document),
and the `json` fence that follows it is what the pen emits — executed by
`test/linq/pen-docs.test.js`, which imports each fence from the
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

`required` is every member not `optional()`, in declaration order — `age`
and `tags` are out of it, `role` is in it because a `default()` does not
make a member optional (it makes it optional on the way IN; see §5).

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

The callback is not stored and not called at validation time: it runs
ONCE, at build, against a recording proxy, and what it leaves behind is
the `$query` document above. `o.total` records `$.total`; `.all()` on an
array member records the `[*]` segment; `.sum()` and `.eq()` are the
query language's `$sum` and `$eq`. That is why a rule can only spell what
the query language has an operator for, and why an `if` or a `for` in the
callback would silently capture one branch: build a `union()` or a
`when()` instead.

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

A definition reached from three places, one of them by name — the
identity rule made visible. `Uuid` is spelled once and appears in `$defs`
once; every place that reaches it emits a `$ref`, including `ref('Uuid')`,
which reaches it by name rather than by value:

```js
import * as s from '@jarenjs/linq/schema';

const Uuid = s.named('Uuid', s.string().uuid());

export const Trace = s.object({
  id: Uuid,
  parent: Uuid.optional(),
  seen: s.array(s.ref('Uuid')).optional(),
});
```

```json
{
  "$defs": {
    "Uuid": { "type": "string", "format": "uuid" }
  },
  "type": "object",
  "properties": {
    "id": { "$ref": "#/$defs/Uuid" },
    "parent": { "$ref": "#/$defs/Uuid" },
    "seen": { "type": "array", "items": { "$ref": "#/$defs/Uuid" } }
  },
  "required": ["id"],
  "additionalProperties": false
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

A coercion. `Infer<>` and `Input<>` differ here and nowhere else in this
section, so both are printed:

```js
import * as s from '@jarenjs/linq/schema';

// Infer<typeof Config> = { port: number; on?: boolean; name: string;
//                          ratio: number; label?: string | null }
// Input<typeof Config> = { port: number | string; on?: boolean | string;
//                          name: string; ratio?: number | string;
//                          label?: string | null }
export const Config = s.object({
  port: s.integer().coerce(),
  on: s.boolean().coerce().optional(),
  name: s.string().trim(),
  ratio: s.number().coerce().default(1),
  label: s.string().nullable().optional(),
});
```

```json
{
  "type": "object",
  "properties": {
    "port": { "type": "integer", "x-coerce": true },
    "on": { "type": "boolean", "x-coerce": true },
    "name": { "type": "string", "x-trim": true },
    "ratio": { "type": "number", "x-coerce": true, "default": 1 },
    "label": { "type": ["string", "null"] }
  },
  "required": ["port", "name", "ratio"],
  "additionalProperties": false
}
```

`ratio` is in `required` and optional on `Input` — a defaulted member is
absent on the way in and present on the way out, which is the whole point
of the two types. `x-coerce` and `x-trim` are not assertions: they are
predicates the NORMALIZER reads, and a document validated without running
the normalizer first will reject `{ port: '80' }`.

A typed enum, on both sides of a nullable. `null` is folded into the
`enum` list rather than added as a union arm, because an enum admits
exactly what it lists:

```js
import * as s from '@jarenjs/linq/schema';

export const Level = s.object({
  level: s.integer().enumOf([1, 2, 3]).coerce(),
  role: s.string().enumOf(['admin', 'user']).nullable().optional(),
});
```

```json
{
  "type": "object",
  "properties": {
    "level": { "type": "integer", "enum": [1, 2, 3], "x-coerce": true },
    "role": { "type": ["string", "null"], "enum": ["admin", "user", null] }
  },
  "required": ["level"],
  "additionalProperties": false
}
```

Object reshaping — the emulated rows of §2.2, and the `required` order
they produce. `extend()` replaces a name and moves it to the end,
`omit()` and `pick()` keep the original order, `partial()` empties
`required` and `required(['id'])` puts one member back:

```js
import * as s from '@jarenjs/linq/schema';

const Base = s.object({ id: s.string(), name: s.string(), age: s.integer().optional() });

export const Derived = s.object({
  one: Base.extend({ email: s.string() }).omit(['name']).partial().required(['id']),
  two: Base.pick(['name']).optional(),
});
```

```json
{
  "type": "object",
  "properties": {
    "one": {
      "type": "object",
      "properties": {
        "id": { "type": "string" },
        "age": { "type": "integer" },
        "email": { "type": "string" }
      },
      "required": ["id"],
      "additionalProperties": false
    },
    "two": {
      "type": "object",
      "properties": { "name": { "type": "string" } },
      "required": ["name"],
      "additionalProperties": false
    }
  },
  "required": ["one"],
  "additionalProperties": false
}
```

Annotations, in the order they were first set, on a member and on the
object that holds it:

```js
import * as s from '@jarenjs/linq/schema';

export const Annotated = s.object({
  id: s.string().describe('The id').title('Id').example('abc').example('def')
    .meta({ 'x-vendor': { a: 1 }, deprecated: true })
    .message('need an id'),
  n: s.integer().min(18).message({ minimum: 'Must be an adult', _: 'Invalid age' }).optional(),
}).title('Annotated').describe('An annotated object');
```

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "The id",
      "title": "Id",
      "examples": ["abc", "def"],
      "x-vendor": { "a": 1 },
      "deprecated": true,
      "errorMessage": "need an id"
    },
    "n": {
      "type": "integer",
      "minimum": 18,
      "errorMessage": { "minimum": "Must be an adult", "_": "Invalid age" }
    }
  },
  "required": ["id"],
  "additionalProperties": false,
  "title": "Annotated",
  "description": "An annotated object"
}
```

`example()` accumulates into one `examples` array; `describe()` twice
replaces the value and keeps the position; `meta()` writes its keys
verbatim, which is how `deprecated` — a 2020-12 annotation the pen has no
method for — and a vendor extension both reach the document.

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

Both `allOf` parts are `open()`. Closed ones would reject each other's
members and the document would accept nothing, so the pen refuses them
(§4, `JL0102`).

## 4. Refusals

The schema pen raises these four `LinqBuildError` codes and no others —
`test/linq/pen-docs.test.js` holds this list equal, in both directions,
to the codes `packages/linq/src/schema/` throws. The full condition each
code states across every pen is the binder's,
[LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3.

| Code | What this pen raises it for |
|---|---|
| `JL0101` | a value this pen cannot spell, or a name → value map it cannot read |
| `JL0102` | a construct the format cannot carry |
| `JL0103` | a `$defs` name collision, or a reference no definition answers |
| `JL0104` | a pen-owned keyword written through `meta()`, or an external a captured rule did not declare |

Every message below is the one the pen raised when the spelling beside it
was run, with the code prefix (`JL0101: `) removed. Where a row lists
several spellings, the message shown is the first one's: the shared
predicates interpolate the method name, so the others differ only in the
word the message opens with. `docPath`, where the refusal carries one, is
the JSON pointer of the node being assembled, and is appended to the
message text as well (`… at /properties/b`).

### 4.1 `JL0101` — the value, or the map

Raised at the door, before anything is assembled. The first four rows are
one predicate each, reached from every method that takes that kind of
argument.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `s.array(42)`, `s.object({ a: 42 })`, `s.when(42)` | `array() takes a schema builder, got 42 — wrap a hand-written JSON Schema with from()` | `s.array(s.from({ type: 'integer' }))` |
| `s.string().min('x')` | `min() takes a non-negative integer, got a string` | `s.string().min(1)` |
| `s.number().min('x')`, `s.number().multipleOf(0)` | `min() takes a finite number, got a string`; `multipleOf() takes a positive number, got 0` | `s.number().min(0).multipleOf(0.5)` |
| `s.string().describe(42)`, `s.discriminated(42, […])` | `describe() takes a string, got 42` | `s.string().describe('…')` |
| `s.string().default(() => 1)`, `s.literal(NaN)`, `s.number().default(-0)` | `default() received a function, which is not JSON — a document carries null, booleans, finite numbers (never -0), strings, arrays and plain objects, and nothing else` | a JSON value |
| `s.named('9bad', b)`, `s.ref('a/b')` | `named() takes a definition name (letters, digits, '_', '.', '-', not starting with a digit), got a string` | `s.named('Bad9', b)` |
| `s.object([])`, `s.object(null)` | `object() takes a plain object of builders, got a Array instance` | a plain object |
| `s.enumOf([])`, `s.string().enumOf([1])` | `enumOf() takes a non-empty array of JSON values`; `enumOf() on a string takes string values; 1 could never satisfy the enum` | `s.string().enumOf(['a'])` |
| `s.tuple(b)`, `s.union([])` | `tuple() takes an array of builders`; `union() takes a non-empty array of builders or schemas` | an array with at least one entry |
| `s.lazy(Node)` (the builder, not a thunk) | `lazy() takes a function returning a named builder` | `s.lazy(() => Node)` |
| `s.from(null)`, `s.from([])` | `from() takes a JSON Schema object or boolean, got null` | `s.from({})`, `s.from(true)` |
| `Base.pick(['zzz'])`, `Base.omit('name')` | `pick(): 'zzz' is not a member of this object`; `omit() takes an array of member names` | a name the object carries |
| `.dependentRequired({ id: 'name' })` | `dependentRequired() takes a plain object mapping a member name to an array of member names` | `.dependentRequired({ id: ['name'] })` |
| `.meta([…])` | `meta() takes a plain object of annotations, got a Array instance` | a plain object |
| `await s.when(b)`, or a `when()` builder returned from an `async` function | `a when() builder is not a promise — it was awaited or handed to a promise resolution; keep builders out of async return positions` | keep builders out of async return positions |

**The `__proto__` case.** It is the one refusal whose cause is invisible
in the source text, so it gets its own paragraph:

```js
s.object({ __proto__: s.string() })
// JL0101: object() received a map whose prototype was replaced: a
// '__proto__:' key in an object literal sets the prototype instead of
// adding a member, so that member is not there to emit — spell it
// { ['__proto__']: … }, which is an own key
```

`{ __proto__: builder }` in an object LITERAL does not add a member: it
invokes the `Object.prototype.__proto__` setter and replaces the object's
prototype. The member never reaches the pen — there is nothing to emit
and nothing to see. The one thing that IS visible is the prototype, and
no plain map has one, so the pen refuses the map by it rather than
emitting it a member short. The rule is the binder's §1.1 rule 5, it
applies at all three doors this pen has (`object()`, `.extend()`,
`.patternProperties()`), and the spelling that works is the computed key:

```js
s.object({ ['__proto__']: s.string() })   // an own property; emitted as a member
```

The same asymmetry runs the other way on the emission side: a document
carrying a `__proto__` member has to be written with `setObjectMember`,
because a plain `out[name] = value` would reassign the emitted object's
prototype and drop the member. That is why the emitted `properties`
object still has `Object.prototype` and still carries the key.

### 4.2 `JL0102` — the construct the format cannot carry

Raised either by the method (a constraint that cannot be spelled) or at
assembly (a shape whose emitted form would mean something else).

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `s.object({}).coerce()` | `coerce() applies to a scalar (string, number, integer, boolean, nil); a object has no single type the normalizer could coerce to` | coerce the scalar members |
| `s.string().nullable().coerce()` | `a nullable value cannot be coerced — the normalizer coerces only a single-typed scalar, so the coercion would never run; drop nullable() or coerce()` | drop one of the two |
| `s.string().coerce().nullable()` | `a coerced value cannot be nullable — the normalizer coerces only a single-typed scalar, so a nullable coercion would never run; drop coerce() or nullable()` | drop one of the two |
| `s.number().trim()` | `trim() applies to a string; a number carries no whitespace to trim` | `s.string().trim()` |
| `s.string().pattern(/a/i)` | `pattern() cannot carry the flags 'i' — a JSON Schema pattern is a bare regular expression source; spell the flag inside the expression, or drop it` | `s.string().pattern(/[Aa]/)` |
| `s.never().describe('x')` | `never() is the boolean schema false, which carries no 'description' — annotate the member that holds it, or nullable() it first` | annotate the member |
| `s.never().check(fn)` | `never() is the boolean schema false; nothing reaches a check on it` | check the member |
| `s.discriminated('kind', [A, B])` where `B` does not declare `kind` | `discriminated('kind') option 1 does not declare 'kind' as a literal() or enumOf() member — without the tag on every option the oneOf is not a discriminated union; use union() for an untagged one` | `s.union([A, B])`, or give `B` the tag |
| `s.intersection([closedA, closedB])` | `closed objects do not intersect — under allOf each part rejects the other's members, so the document would accept neither; open() the parts, or merge them with extend()` | `.open()` both, or `A.extend(B's members)` |
| `s.union([s.string().default('x'), …])` | `a default(), coerce() or trim() under union() never runs — the normalizer does not descend that branch, so the document would promise a normalization that does not happen; move it to the member that holds the branch, or drop it` | move the `default()` to the member holding the union |
| `s.document(b, { draft: 'draft-07' })` | `document() writes the 2020-12 vocabulary only; 'draft-07' is not a draft it can declare` | `{ draft: '2020-12' }`, or no draft |
| `s.document(s.never(), { draft: '2020-12' })` | `a boolean schema cannot declare a $schema` | give the document a non-boolean root |

The normalizer rule fires under seven names, and the message carries
whichever one it was: `union()`, `discriminated()`, `when()`, `then()`,
`else()`, `contains()` and `propertyNames()`. Its `docPath` names the
exact branch (`/anyOf/0`, `/if`, `/contains`, `/propertyNames`).

### 4.3 `JL0103` — the definition

Raised at assembly, when the `$defs` block is closed and every name a
`ref()` demanded must be answered.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `s.object({ a: s.ref('Nope') })` | `ref('Nope') names no definition in this document — a name is defined by named('Nope', …) somewhere the root can reach` | `named('Nope', …)` somewhere the root reaches |
| `s.object({ a: s.named('T', s.string()), b: s.named('T', s.number()) })` | `two distinct builders are named 'T' in one document — a $defs entry can hold one definition; rename one of them` | rename one, or reach the SAME builder twice |
| `s.lazy(() => s.string())` | `lazy() must return a NAMED builder — a recursion is spelled as a $ref, and a $ref needs a definition to point at: lazy(() => Node) where Node = named('Node', …)` | `s.lazy(() => Node)` |
| `s.lazy(() => 42)` | `lazy() must return a builder` | a named builder |

"Two distinct builders" is by identity, not by shape: the same builder
under one name, reached from anywhere, is one definition — that is the
identity rule §3's `Trace` example shows. Two builders that emit the same
JSON are still two, and still a collision.

### 4.4 `JL0104` — the keyword, and the external

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `s.string().meta({ type: 'x' })` | `meta() cannot write 'type' — the pen owns that keyword; spell it through the builder method that emits it, or wrap a hand-written schema with from()` | the method that emits it, or `s.from({ … })` |
| `.check((o, x) => x.foo.eq(1))` | `a check() rule cannot bind 'foo' — its query evaluates with exactly 2 externals, 'root' and 'path'; anything else has nothing to bind to` | `x.root` and `x.path`, and nothing else |

The owned set is every keyword the pen writes itself plus every keyword
that would change what a document asserts — the structural ones, the
constraints, `$schema`/`$id`/`$ref`/`$defs` and the anchors, `$query`,
`default`/`title`/`description`/`examples`/`errorMessage`, and
`x-coerce`/`x-trim`. `meta()` is for everything else: a 2020-12
annotation the pen has no method for (`deprecated`, `readOnly`,
`writeOnly`), and any vendor extension. The type declaration carries the
same set as `OwnedKeyword`, so a forbidden key does not compile either
(§5).

`check()`'s two externals are the two the validator binds on every
`$query` evaluation. The refusal is raised at BUILD time, earlier than
the validator's own compile error and with the same meaning.

## 5. The types

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
  children: s.array(s.lazy(() => Node)).optional(),
}));
```

The chain takes a builder where it took a document, and types the
element from it: `from(rows).ofType(User)` is `Sequence<Infer<typeof User>>`.

### 5.1 The phantoms, and the flags

Every builder declares four carriers and never has any of them at run
time (`packages/linq/types/schema.d.ts`): `__out`, the shape after
normalization; `__in`, the shape before it; `__flags`, a union of the
member marks; and `schema`, the document type. `Infer<B>` reads `__out`,
`Input<B>` reads `__in`, `SchemaOf<B>` reads `schema`.

`Flag` is `'optional' | 'defaulted' | 'generated' | 'key'` — the last two
belong to the model pen, which extends these declarations. Two rules read
the flags, and they are deliberately different:

| | required on `Infer` | required on `Input` |
|---|---|---|
| plain | yes | yes |
| `.optional()` | no | no |
| `.default(v)` | **yes** — the normalizer materializes it | no |
| `.optional().default(v)` | **yes** | no |

That is the one asymmetry to carry: a `default()`ed member is present
afterwards and absent-able before, which is exactly what §3's `Config`
example prints.

A builder-shaped position is typed `BuilderLike<Out, In, F>`, an
INTERFACE compared by those four carriers rather than by its methods —
so a subclass of another pen (`EntityStringBuilder`, `FormObjectBuilder`)
fits wherever "a builder" is asked for without either pen importing the
other.

### 5.2 What each family reads

- **Scalars, dates, literals and enums.** `string()` is `string`,
  `number()`/`integer()` are `number` — integer-ness is a documented
  widening — and a constraint never narrows: `.min(1)`, `.pattern(…)` and
  `.format('email')` all answer `this`. The two date formats are the
  exception: `.format('date-time')`, `.format('date')`, `datetime()` and
  `date()` answer `StringBuilder<DateTime, DateTime>`, which is what makes
  the chain's date operators legal over a pen shape, while `time()` and
  `duration()` stay `string`. `literal(v)` and `enumOf(values)` are the
  const and the literal union, inferred through `const` type parameters.
- **Objects.** A closed object is exactly its members, with no index
  signature; `object({})` is `Record<string, never>`. `.open()` adds
  `[key: string]: unknown`. `.patternProperties()` on a CLOSED object
  adds an index signature that carries the pattern values widened over
  the declared members — emit's rule, and an honest widening rather than
  a lie: `{ id: 'a', 'x-1': 'no' }` type-checks and fails validation, and
  `test/consumer/linq-schema.ts` pins both halves.
- **Arrays and tuples.** `array(b)` is `Infer<B>[]`. A tuple is
  `[...positions, ...unknown[]]` until `.rest(b)` names the tail, and
  `[...positions]` exactly once `.rest(never())` closes it.
- **Composition.** `union` and `discriminated` are the union of the
  options; `intersection` is their intersection. `when()` is `unknown` on
  both sides — emit records a conditional and never types it.
- **The two asserted, and the one inferred.** `ref<T>(name)` and
  `from<T>(json)` carry the type the CALLER asserts, because a name and a
  JSON literal carry none — both default to `unknown`, so an unannotated
  one is honest rather than wrong. `lazy(thunk)` is different: it demands
  a `NamedLike` — a builder carrying the `__named` phantom — and reads
  the type off it, which is why `lazy(() => s.string())` does not compile
  and why the recursion's annotation belongs on the `named()` constant
  rather than on the `lazy()` call.

### 5.3 The exported classes, the constant and the guard

Ten exports are surface a caller does not CALL, which is why none of them
is in §2:

| Export | What a caller meets it as |
|---|---|
| `SchemaBuilder` | the base every builder extends; a type annotation, and the class a pen built over this one subclasses |
| `StringBuilder`, `NumberBuilder`, `ArrayBuilder`, `TupleBuilder`, `ObjectBuilder`, `WhenBuilder`, `NeverBuilder` | the seven kinds with their own methods; annotations, `instanceof` narrows, and the classes `createFactories` is handed |
| `SCHEMA_BUILDER` | the brand key, a `Symbol.for` registry symbol — how the chain recognises a builder without importing this directory |
| `isSchemaBuilder(value)` | the guard that reads the brand; `true` for a builder, `false` for a data object that merely carries a `toJSON` member |

The eight classes are how the model and forms pens exist at all: each
calls `createFactories()` with subclasses of these, so the factory wiring
is written once and no subpath patches another's prototype. A consumer
subclassing them takes the same route — `with()` keeps the subclass
through every method, so a subclass never has to re-declare one.

The declaration file and the runtime export set are not identical today:
`BooleanBuilder`, `NullBuilder` and `NamedBuilder` are declared as
classes — and are load-bearing as TYPES, which the model and forms
declarations extend — while the subpath exports no binding under those
names; `NeverBuilder` and `createFactories` are the other way round. Use
those five as types, never as values. `docs/ROADMAP.md` carries the entry.

### 5.4 What the pins hold

Two files, both compiled by `npm run test:types`:

| File | What it proves |
|---|---|
| `test/consumer/linq-schema-generated.ts` | emit's own declarations for every document the corpus emits, produced by `scripts/generate-schema-pen-fixture.js`. `test/linq/schema-pen.test.js` asserts the committed file is exactly what the generator produces today, so it cannot drift |
| `test/consumer/linq-schema.ts` | for all 33 corpus entries, `Infer<>` EQUAL (not merely assignable) to the generated declaration and `Input<>` equal to its accepted twin; the `DateTime` brand on a date member; a `check()` rule seeing its shape; valid instances assignable; and eight negatives |

The negatives are worth reading as a list of what the types forbid, since
each one FAILS the build the day it starts compiling:

```ts
void s.string().min('x');                       // a string constraint takes a number
void s.object({}).meta({ type: 'x' });          // a pen-owned keyword through meta()
void s.lazy(() => s.string());                  // lazy() demands a NAMED builder
void s.number().trim();                         // trim() is a string method
void s.object({ a: s.string() }).pick(['zzz']); // pick() names members the object has
void s.integer().default('three');              // a default is a value of the member's type
void s.object({ n: s.number() }).check((o) => o.m.exists());   // a check reads the shape
void s.object({ n: s.number() }).check((o, x) => o.n.eq(x.limit)); // root and path, nothing else
```

Beside them the same file pins the closed-object rejection of an extra
member, the defaulted member present only on `Infer`, the coerced
transport form accepted only on `Input`, the discriminator picking the
arm, recursion typed all the way down, a closed tuple having no rest,
`Record<string, never>` for `object({})`, and `never()` admitting nothing.

## 6. What it cannot spell

Everything below is a `JL0102` or an absence, and each has the same
cause: the deliverable is a JSON document, so a construct that cannot BE
one has nowhere to go. This is the section a reader arriving from a
JavaScript-first schema library needs, because four of these are methods
they are used to having.

- **`refine`, `superRefine`, `transform`, `preprocess`.** They do not
  exist — calling one is a `TypeError`, not a coded refusal, because
  there is no method to refuse from. A refinement is a JavaScript
  closure, and a closure cannot be serialized into a document that a
  store, a browser and a CLI all have to read the same way. The two
  halves have separate homes: a cross-field RULE is `check()`, which
  captures into `$query` and travels with the document; a TRANSFORM is
  application code that runs before or after validation, and the two
  transforms common enough to be worth a keyword — coercion and trimming
  — are `coerce()` and `trim()`, which the normalizer performs.
- **A coercion the normalizer would never run.** `coerce()` on a
  non-scalar, and `coerce()` with `nullable()` in either order.
  `compileNormalizer` coerces a value toward ONE type; a union of two has
  no single target, so the annotation would be a promise the pipeline
  does not keep. Coerce the scalar members instead.
- **A default, coercion or trim inside a branch.** Under `anyOf`/`oneOf`,
  `if`/`then`/`else`, `contains` or `propertyNames`, the normalizer does
  not descend — so the document would say a member is defaulted and no
  default would ever appear. Move it to the member that HOLDS the branch.
- **Closed objects under `allOf`.** `additionalProperties: false` is
  evaluated per-subschema in 2020-12: each part rejects the other's
  members and the intersection accepts nothing. `open()` the parts, or
  merge them with `extend()` — which is a better document anyway, since
  it produces one object rather than an `allOf` a reader has to intersect
  in their head.
- **An annotation or a check on `never()`.** `never()` is the boolean
  schema `false`, and `false` has no place to put a `description` or a
  `$query`. `optional()` and `nullable()` DO work on it, because neither
  writes into the node: `optional()` marks the member and `nullable()`
  wraps it in `anyOf: [false, { type: 'null' }]`. Annotate the member
  that holds it.
- **A regular-expression flag.** JSON Schema's `pattern` is a bare
  source string with no flag syntax, so `/a/i` cannot be carried. Spell
  the flag inside the expression (`/[Aa]/`) or drop it.
- **Any draft but 2020-12.** `document()` declares
  `https://json-schema.org/draft/2020-12/schema` and refuses to declare
  another, because the pen writes that vocabulary and only that one.
  Emitting a `$schema` it does not honour would be worse than emitting
  none — which is what `document(root)` without a draft does, and what a
  schema embedded in a larger document wants.
- **A `$schema` or `$defs` on a boolean root.** `never()` and
  `from(true)` emit `false` and `true`; a boolean is not an object and
  can carry neither. Name the root instead (`named('X', …)`).
- **A keyword the pen owns, through `meta()`.** Not a limit of the format
  but of the door: `meta()` writes verbatim, so letting it write `type`
  or `required` would make the annotation a back way around the builder
  and the phantom types would stop describing the document. Use the
  method, or wrap a hand-written schema with `from()` — which is the
  general escape hatch and is exactly as honest, since `from<T>()` makes
  the type the caller's assertion.
- **A rule the query language has no operator for.** `check()` captures a
  callback against a recording proxy: only what the proxy records becomes
  the `$query`, so a JavaScript `if`, a loop or a call into another
  library records one branch or nothing. The operator set is
  `packages/json/docs/QUERY-FORMAT.md` §8; a rule outside it is
  application code, run beside validation rather than inside it.

## 7. Cost

`@jarenjs/linq/schema` builds to **32,092 bytes** as a minified,
tree-shaken ESM bundle — the figure `scripts/check-tree-shaking.js`
measures and `npm run test:tree-shaking` reports, published rounded (32
kB) beside the other nine subpath prices in
[docs/CONSUMING.md](../../../docs/CONSUMING.md).

The probe is a gate, not a report: building
`s.object({ id: s.string() }).schema` as a consumer would, it asserts
three things and fails the build on any of them:

- **no chain module** — none of `sequence.js`, `document.js`, `async.js`,
  `concurrency.js`, `provider.js`, `sources.js` or `schema-of.js`
  contributes a byte;
- **no engine** — not one byte of `@jarenjs/json`, `@jarenjs/validate`,
  `@jarenjs/emit`, `@jarenjs/db`, `@jarenjs/formats` or `@jarenjs/refs`,
  which is the tree-shaken proof of §1's claim that the pen writes a
  document and compiles nothing;
- **no model pen** — the subclasses are built by the `./model` subpath,
  never patched onto these classes, so taking the schema pen never drags
  the model pen in.

Two things ride along by construction and are part of the ceiling: the
recording proxy in `expression.js`, which `check()` captures through (a
class method cannot be tree-shaken away), and every factory function,
built as one closure per class set so the model and forms pens construct
their subclasses through the same wiring.

A consumer who takes the chain as well pays for both, and the two prices
add rather than overlap: the chain's own bundle is 172,668 bytes and
carries nothing from this directory, because `ofType`/`cast` recognise a
builder by the registry symbol `SCHEMA_BUILDER` rather than by an import.
A consumer who takes only the pen — which is what a shared `schemas.js`
module in an application usually is — pays the first alone.
