# The Jaren model pen

> `./model` — the `x-entity` vocabulary on JSON Schema, and the `$model`
> 0.1 document `openStore` accepts unchanged. **Read it when** you are
> declaring a store's entities, their keys and their relations

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119. This document is a **guide** — read
it in order and you can write the format — whose one normative section is
[§2 The mapping table](#2-the-mapping-table); the rules every pen keeps,
the shared refusal table, the index of the other pens and every pen's
mapping table collected in one place are the normative reference,
[LINQ-FORMAT.md](LINQ-FORMAT.md).

## 1. What it writes

You have a database to declare — its entities, their keys, which members
become columns, which relations the store may follow — and the format for
that is a JSON document with a JSON Schema inside it. Writing one by hand
means keeping a schema and a mapping vocabulary in step in the same file,
by eye. This pen is the schema pen with that vocabulary added to every
builder, so the mapping is a method on the member it belongs to and the
document is assembled for you.

```js
import * as m from '@jarenjs/linq/model';
```

builds `$model` 0.1 documents — the `jaren-model` grammar
`packages/db/schemas/jaren-model.schema.json` publishes, whose one
specification is
[MODEL-FORMAT.md](../../db/docs/MODEL-FORMAT.md) §2, §2.1 and §9 — and
`@jarenjs/db`'s `openStore(model, { driver })` accepts what this pen
emits unchanged. A model declares `entities`, `collections`, or both: an
entity is a JSON Schema whose members carry the `x-entity` mapping
vocabulary (MODEL-FORMAT §9.2), a collection is a document schema with a
key pointer and a list of indexes (§2, §2.1).

Four things are worth naming before the tables:

- **The pen is the schema pen, subclassed.** Every factory here answers a
  builder of a NEW class — `withEntity(Base)` applied to each of the
  eight schema-pen classes at module scope
  (`packages/linq/src/model/index.js:20-28`), then handed to the same
  `createFactories()` the schema pen builds its own names from
  (`index.js:30-39`). Nothing is patched onto an imported prototype, so a
  `./schema` consumer never carries an entity method: `typeof
  s.string().key` is `undefined` and `m.string() instanceof
  s.StringBuilder` is `true`, both asserted.
- **The schema stays a valid JSON Schema.** Strip every `x-entity` block
  and the document accepts and rejects exactly the same values — the
  vocabulary is invisible to a validator that does not know it, by the
  same argument as `x-form` (MODEL-FORMAT §9.1). That is why §2's
  re-exported rows link [SCHEMA-PEN.md](SCHEMA-PEN.md) rather than repeat
  it: the member's schema half is the schema pen's, unchanged.
- **The engine is somewhere else.** Nothing under
  `packages/linq/src/model/` imports `@jarenjs/db`, `@jarenjs/validate`
  or `@jarenjs/emit` — a test asserts it file by file
  (`test/linq/model-pen.test.js`, "no store behind it"). The pen refuses
  only what it cannot spell and what the store's own model walk would
  refuse and the builder can already see; inverse agreement, foreign-key
  types and the rest stay `normalizeEntities`'s (`JD0005`, `JD0030`,
  `JD0031`), never re-implemented, and §6 draws the line.
- **Immutability and identity are the binder's rules, and this pen keeps
  them.** Every method answers a new builder, `.schema` assembles once
  and memoizes, and `defineModel()` deep-freezes what it returns — stated
  in full, for every pen, in [LINQ-FORMAT.md](LINQ-FORMAT.md) §1.2.

One complete round trip — declare, open, write, read back:

```js
import * as m from '@jarenjs/linq/model';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const model = m.defineModel({
  entities: {
    User: m.object({
      id: m.string().identity('uuid'),
      email: m.string().email().unique(),
      created: m.datetime().now().optional(),
    }),
  },
});

const store = await openStore(model, { driver: nodeDriver() });
const ada = await store.entity('User').create({ email: 'ada@x.test' });
ada.id;        // the store allocated it
ada.created;   // the store stamped it
```

**The running example.** The round trip above is one blog's store, and it
is the store §3 declares in full — the authors and their posts, the
labels on a post, the comments the store stamps and fills, the two kinds
of key, and the collections that hold what is not an entity. §5 opens the
same model through `typedStore` and reads its types back. One example in
§3 stands outside the blog and says so where it starts.

What the store then DOES with the document — the hybrid column mapping,
relations and referential integrity, identity, defaults, the relational
translation — is MODEL-FORMAT's, linked rather than restated here. What
the migration pen does with two of these is
[MIGRATION-PEN.md](MIGRATION-PEN.md).

## 2. The mapping table

Every name `@jarenjs/linq/model` exports that a caller writes, and every
method reachable on a builder it hands back. The eight builder classes,
the one constant and the one guard it also exports are §5's, because a
caller meets those through a type annotation, a subclass or an
`instanceof` narrow rather than by calling one.

Status: **native** (emits the named member), **refused** (a coded error
naming the reason).

### 2.1 The `x-entity` vocabulary

Every builder this pen hands back carries these, whatever its kind. They
merge into the ONE `x-entity` annotation, and its members keep the order
they were FIRST set in (`src/model/entity.js:46-49`, and the annotation
rule of `src/schema/emit.js:221`): setting one twice replaces the value
and keeps the position, which is why `.fill('x')` after `.identity('uuid')`
leaves `key` where it was and replaces `default`.

| Method | Emits (an `x-entity` member) | `InferMeta` reading | Status |
|---|---|---|---|
| `.key()` | `key: true` — (part of) the primary key; several members make a composite one (MODEL-FORMAT §9.5) | marks the member `key`: `EntityKey` is its primitive, or the composite object over all of them | native; on a kind that can hold no column, `JL0102` |
| `.identity('uuid')` on a string, `.identity('auto')` on an integer | `key: true` **and** `default: 'uuid' \| 'auto'` — a store-allocated single key (§9.5) | marks it `key` **and** `generated`: optional on `input`, required on `doc` | native; off its kind, or beside a second `key()`, `JL0102` |
| `.unique()` | `unique: true` — a unique index over the member's column. On an ARRAY builder the schema pen already owns the name, and the base wins: it is `uniqueItems` there, unchanged ([SCHEMA-PEN.md §2.3](SCHEMA-PEN.md#23-arrays-and-tuples)) | — | native; on a kind that can hold no column, `JL0102` |
| `.index()` | `index: true` — a non-unique index over the member's column | — | native; on a kind that can hold no column, `JL0102` |
| `.version()` | `version: true` — the optimistic-concurrency token (§11.5), engine-owned: one plain integer column per entity | — | native; off an integer, `JL0102` |
| `.column('integer')` | `column: 'integer'` — an epoch-milliseconds column beside the RFC 3339 string, on a `datetime()`/`date()` member only (§9.3) | — | native; off a date-formatted string, `JL0102` |
| `.column('json')` | `column: 'json'` — the scalar stays in the JSONB document, which is the opt-out that preserves present-`null` (§9.3) | — | native |
| `.now()` | `default: 'now'` — an RFC 3339 stamp on insert, when the member is absent | marks it `generated`: optional on `input` | native |
| `.updated()` | `default: 'updated'` — a stamp on insert AND on every update | marks it `generated` | native |
| `.fill(value)` | `default: { value }` — a literal, filled when absent; the value crosses the JSON boundary (`requireJson`) | marks it `generated` | native; a value that is not JSON is `JL0101` |
| `.compute(fn)`, `.compute(query)` | `default: { query }` — captured over the document being written (`$`), or a query document verbatim | marks it `generated` | native; a captured rule that binds ANY external is `JL0104` |
| `.renamedFrom(name)` | `x-rename: name` on the ENTITY (or collection) declaration — a planning hint the migration planner reads, never part of the shape (MIGRATION-FORMAT §3) | — | native on the declaration's own builder; on a member, `JL0102` (the document has no place for one) |
| `.meta(annotations)` | as the schema pen ([SCHEMA-PEN.md](SCHEMA-PEN.md#28-annotations-and-messages)), minus one key | — | refused (`JL0104`) for `x-entity`: the pen owns that keyword |
| `.entity(patch)` | the patch, merged into `x-entity` — the primitive every row above is written in terms of, and the way to spell a member of the vocabulary that has no method of its own | — (it sets no flag; the named methods do — §5.2) | native; a member outside the closed vocabulary, `JL0102` |

A member may carry several: `m.string().unique().index().identity('uuid')`
emits `{ unique: true, index: true, key: true, default: 'uuid' }`, in
that order. **Six of these rows are checked against the member's KIND**, each
mirroring a rule the store's own walk would raise later. What a builder
cannot see is its POSITION — a scalar nested inside an object takes no
column either — so §6's second list is what remains the store's.

### 2.2 The relation members

`rel` is a frozen object of three factories, one per kind MODEL-FORMAT
§9.4 names. Each answers a builder of no type (`{}`) whose whole
document is its `x-entity.relation` block, and each is `optional()` by
construction — a relation member is a PROJECTION, never stored state, so
it never joins `required` (`src/model/relation.js:44-46`).

| Method | Emits | `InferMeta` reading | Status |
|---|---|---|---|
| `rel.hasMany(to, { via, onDelete })` | `relation: { to, many: true, via, onDelete }` — one-to-many; `via` names the foreign key on the TARGET entity | `doc`: `to[]`, optional; dropped from `input`; `relations[name] = { entity: to, doc, many: true }` | native |
| `rel.hasOne(to, { via, onDelete })` | `relation: { to, via, onDelete }` — one-to-one, and the many-to-one side; `via` names the foreign key on the DECLARING entity | `doc`: `to`, optional; dropped from `input`; `many: false` | native |
| `rel.belongsToMany(to, { through? })` | `relation: { to, many: true, through? }` — many-to-many through a join table | `doc`: `to[]`, optional; `input`: `Array<key \| doc>`, optional; `many: true` | native |

`onDelete` is REQUIRED on the two foreign-key kinds and never defaulted
silently (`relation.js:26-30`, MODEL-FORMAT §9.4); `belongsToMany` takes
neither, because a join row dies with either side and that is not
configurable in this version.

**The join table's endpoints come from the mapping, never from its
name.** `through` names the table; without it the store derives the
sorted `<A>_<B>`. Either way the mapping records which entity each column
references, which is what a rename follows (MIGRATION-FORMAT §3 — an
entity name may itself contain `_`, so splitting the table's name is
never the answer). `explainMapping()` on §3's second example returns:

```json
{
  "Label_Post": {
    "left":  { "entity": "Label", "column": "Label_key", "referencesKey": "name" },
    "right": { "entity": "Post",  "column": "Post_key",  "referencesKey": "pid" },
    "onDelete": "cascade"
  },
  "post_tags": {
    "left":  { "entity": "Post", "column": "Post_key", "referencesKey": "pid" },
    "right": { "entity": "Tag",  "column": "Tag_key",  "referencesKey": "name" },
    "onDelete": "cascade"
  }
}
```

### 2.3 Collections and their indexes

A collection is an entity whose every member is JSONB and which declares
no relations (MODEL-FORMAT §9.1); one physical engine sits under both.

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `collection(schema, { key?, identity?, indexes?, renamedFrom? })` | `{ schema, key?, identity?, indexes?, 'x-rename'? }` — `key` is an RFC 6901 pointer, a captured member path (`(d) => d.id` → `/id`) or `null` (the store allocates, `identity` says how); the other options ride verbatim | `CollectionSpec<Infer<B>>`, carrying the document shape its paths are checked against | native; an option outside the four, a key that is neither pointer nor lambda nor `null`, an `indexes` that is not an array of `index()` entries, all `JL0101` |
| `index(path, options?)` | `{ name, path, unique?, derive?, precision?, dims?, physical? }` — `path` is a captured lambda (`(p) => p.cell` → `$.cell`), a non-empty array of them (a composite), or a JSONPath string; `name` defaults to `by_<segments>`; the rest ride verbatim for the store's model walk to judge (§2.1) | `IndexPath<D>` over the collection's shape: a member the shape lacks does not compile | native; an option outside the six is `JL0101`; a lambda that answers an operator result or a surface method is `JL0102` |

| `expressionIndex(expression, options?)` | `{ name, expression, unique? }` — an index over a COMPUTED value: a `{ call, args }` node whose arguments are member lambdas, JSONPath strings, JSON scalars or further calls; `name` defaults to `by_<call>_<members>` | the expression's member lambdas are checked against the collection's shape | native; a node outside the vocabulary, an option outside the two, and anything that looks like SQL text are all `JL0101` |

The option set for `index()` is exactly `name`, `unique`, `derive`,
`precision`, `dims`, `physical` (`src/model/collection.js:18`); the
default name is `by_` plus the path's member segments, identifier-safe
(`collection.js:76-80`) — `by_series_t`, `by_x_y`.

`expressionIndex()` takes only `name` and `unique`, because an
expression names the members it reads itself — nothing that describes a
member's storage belongs beside one. The pen resolves NO function name:
arity and determinism are the store's to check against the declarations
`openStore({ expressions })` was given, and a name this pen has never
heard of is not an error here. What it decides is the shape.

### 2.4 The model document

The three calls that assemble the whole thing — the document, the
collection declaration inside it, and the index declaration inside that.

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `defineModel({ entities?, collections? })` | `{ $model: '0.1', collections?, entities? }`, deep-frozen; each entity is `{ schema, 'x-rename'? }` | `ModelDocument<E, C>`, whose phantoms `InferMeta<>` and the migration pen read | native; neither member given, a member outside the two, a name that is not an identifier, or a declaration of the wrong kind, all `JL0101`; an undeclared relation target or a `collection()` under `entities`, `JL0102` |
| `document(root, { draft? })` | as [SCHEMA-PEN.md](SCHEMA-PEN.md#210-the-document-and-the-builder-itself) — a standalone JSON Schema, with `x-entity` blocks riding as annotations. It writes a schema, never a `$model` | — | native |
| `schemaOf(value)` | as [SCHEMA-PEN.md](SCHEMA-PEN.md#210-the-document-and-the-builder-itself) — the document of a builder, or the value as given | `unknown` | native |
| `withEntity(Base)` | nothing: a NEW class, `Base` plus §2.1's vocabulary. The eight exported classes are made with it at module scope, and a consumer subclassing one takes the same route | `B` — the base class's own type | native |

`collections` is emitted before `entities` when both are given
(`src/model/define.js:65-120`), and every name is written with
`setObjectMember` so a member called `__proto__` is ordinary data
(LINQ-FORMAT §1.1, rule 5).

### 2.5 The schema pen's vocabulary, re-exported

These are the schema pen's names, rebuilt from the entity-aware
subclasses. **What each emits, what it infers and what it refuses is
unchanged** — the row is [SCHEMA-PEN.md](SCHEMA-PEN.md)'s, and this table
links it rather than repeating it. The one difference is the class of the
builder that comes back: it carries §2.1's methods, so any of these can
be a key, an index, a column override or a store-written default.

This is the **grouped re-export row**, the row kind
[LINQ-FORMAT.md](LINQ-FORMAT.md) §5 defines: one row per family, linking
the schema pen's row rather than restating it, with a third column
carrying the one thing that IS different here. For this pen that column
is the status, because these builders gain behaviour — `x-entity` lands
on them the moment a §2.1 method is called. [FORMS-PEN.md
§2.1](FORMS-PEN.md#21-re-exported-unchanged--27-names) uses the same row
kind with the class in that column instead, because there nothing gains
behaviour and the class is the whole difference.

| Method | Row | Status |
|---|---|---|
| `string()`, `number()`, `integer()`, `boolean()`, `nil()`, `literal(v)`, `enumOf(values)`, `datetime()`, `date()`, `time()`, `duration()`, `any()`, `never()` | [SCHEMA-PEN.md §2.1](SCHEMA-PEN.md#21-primitives-literals-and-enums) | native, plus `x-entity` when a §2.1 method is called on it |
| `object(props)`, `record(values)` | [SCHEMA-PEN.md §2.2](SCHEMA-PEN.md#22-objects) | native; an entity's own builder is an `object()` (or an `intersection()` of them), and it is where `.renamedFrom()` lands |
| `array(items)`, `tuple(items)` | [SCHEMA-PEN.md §2.3](SCHEMA-PEN.md#23-arrays-and-tuples) | native; an array or tuple member is JSONB, so it takes no column of its own (§6) |
| `union(options)`, `discriminated(key, options)`, `intersection(parts)`, `when(cond)` | [SCHEMA-PEN.md §2.6](SCHEMA-PEN.md#26-composition) | native; a union of several scalar types stays in the document (MODEL-FORMAT §9.3) |
| `named(name, b)`, `ref(name)`, `lazy(thunk)`, `from(json)` | [SCHEMA-PEN.md §2.7](SCHEMA-PEN.md#27-references-and-defs) | native; `x-entity` is read through an entity's `allOf`, `$defs` and `definitions` blocks and nowhere deeper (MODEL-FORMAT §9.2) |

Every builder method the schema pen documents — `.optional()`,
`.open()`, `.min()`, `.format()`, `.check()`, `.describe()`, `.extend()`,
`.with()`, and the rest — is reachable here too and behaves identically;
[SCHEMA-PEN.md](SCHEMA-PEN.md) §2 is their one home (D4). `.with()` is
what keeps the subclass: `m.string().min(1).nullable().key` is still a
function.

**One name is in both vocabularies, and the schema pen's meaning wins.**
An array's `.unique()` is `uniqueItems: true`, a validation keyword; this
pen's is an entity index. On an array builder the base owns the name and
keeps it (`m.array(m.string()).unique().schema` is asserted equal to
`s.array(s.string()).unique().schema`), because a mixin may add to what a
document says and must never change it — and an array member takes no
column of its own in any case (§6).

### 2.6 Three rules the tables imply

- **A relation target is a name, checked twice.**
  `rel.hasMany('Post', …)` types `'Post'` as a member of `keyof
  Entities` — `'Psot'` is a compile error — and `defineModel` refuses an
  undeclared name at build time (`JL0102`, with the member's `docPath`).
  Inverse agreement, foreign-key types and the join-table rules stay the
  store's (`JD0031`, `JD0005`): two declarations that name the same `via`
  and disagree are refused by `normalizeEntities`, not here.
- **An entity has no `indexes` option.** Its indexes are `unique()` and
  `index()` per member — the vocabulary has no composite and no derived
  entity index — so a `collection()` declaration handed to `entities` is
  refused (`JL0102`) rather than emitted as a document the store would
  reject.
- **`uuid()` is the format, `identity('uuid')` is the key.** The schema
  pen's `.uuid()` writes `format: 'uuid'` here as everywhere; the
  store-allocated key is `identity('uuid')`, MODEL-FORMAT §9.5's own
  word. A member may carry both, side by side.

A declared relation member is also what the chain — the query pen —
navigates: over a store opened with this model,
`from(store.sync.entity('Post'))` reads `p.author.email` and
`u.posts.all().count()` as relation HOPS and lowers each to the
correlated phrase the engine and the store both run, so the query
document carries no relation name ([QUERY-PEN.md](QUERY-PEN.md) §3, §4
"relation navigation"). The table the chain reads is the one the store
derives from these members (`store.entity(name).relations`,
MODEL-FORMAT §10.1); a `rel.belongsToMany` member is the one kind it
refuses (`JL0105`), because its join table is not a queryable root in
this version.

## 3. Worked examples

Every `js` fence below exports exactly one model, and the `json` fence
that follows it is the document the pen emits — executed by
`test/linq/pen-docs.test.js`, which imports each fence from the workspace
and asserts the document. Every model here also opens under the node
driver, normalizes through `normalizeModel`/`normalizeEntities` and
validates against `jaren-model.schema.json`.

One blog's store, declared piece by piece. Each fence is a complete model
on its own — that is what the gate runs — and read in order they are one
store's entities and then its collections: the authors and their posts,
the two ways posts carry labels, the comments with every store-written
default on them, the two kinds of key, and the collections that hold what
is not an entity. Only the last stands apart, and it says so.

The spine — MODEL-FORMAT §9.1's own entity, with both sides of one edge
declared:

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
      author: m.rel.hasOne('User', { via: 'authorId', onDelete: 'cascade' }),
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
          "authorId": { "type": "string" },
          "author": { "x-entity": { "relation": { "to": "User",
                      "via": "authorId", "onDelete": "cascade" } } }
        },
        "required": ["pid", "authorId"]
      }
    }
  }
}
```

Both entities are `open()`, so neither carries `additionalProperties:
false`, and `posts` and `author` are absent from both `required` lists
without anyone writing `optional()` — a relation builder is optional by
construction. The two declarations are one edge (same `via`, one `many`
side and one `one` side, agreeing on `onDelete`), which is what
`normalizeEntities` checks and `JD0031` refuses.

A post carries labels two ways, and the difference is who names the join
table — the two many-to-many spellings, one implicit and one named:

```js
import * as m from '@jarenjs/linq/model';

export const model = m.defineModel({
  entities: {
    Post: m.object({
      pid: m.integer().identity('auto'),
      labels: m.rel.belongsToMany('Label'),
      tags: m.rel.belongsToMany('Tag', { through: 'post_tags' }),
    }),
    Label: m.object({ name: m.string().key() }),
    Tag: m.object({ name: m.string().key() }),
  },
});
```

```json
{
  "$model": "0.1",
  "entities": {
    "Post": {
      "schema": {
        "type": "object",
        "properties": {
          "pid": { "type": "integer", "x-entity": { "key": true, "default": "auto" } },
          "labels": { "x-entity": { "relation": { "to": "Label", "many": true } } },
          "tags": { "x-entity": { "relation": { "to": "Tag", "many": true,
                    "through": "post_tags" } } }
        },
        "required": ["pid"],
        "additionalProperties": false
      }
    },
    "Label": {
      "schema": {
        "type": "object",
        "properties": { "name": { "type": "string", "x-entity": { "key": true } } },
        "required": ["name"],
        "additionalProperties": false
      }
    },
    "Tag": {
      "schema": {
        "type": "object",
        "properties": { "name": { "type": "string", "x-entity": { "key": true } } },
        "required": ["name"],
        "additionalProperties": false
      }
    }
  }
}
```

The emitted document names no table: `labels` gets the derived
`Label_Post` and `tags` the declared `post_tags`, and both mappings
record which entity each column references (§2.2's `joinTables` block).
An implicit name is safe to derive and unsafe to parse — a rename follows
the endpoints, not the string.

A comment is where the store writes the most on your behalf: an entity
with every store-written default, and a rename hint for the migration
that follows:

```js
import * as m from '@jarenjs/linq/model';

export const model = m.defineModel({
  entities: {
    Comment: m.object({
      id: m.string().identity('uuid'),
      text: m.string(),
      slug: m.string().compute((d) => d.text.lower()).optional(),
      created: m.datetime().now().optional(),
      touched: m.datetime().updated().column('integer').optional(),
      kind: m.string().enumOf(['memo', 'todo']).fill('memo').optional(),
      weight: m.integer().fill(1).optional(),
    }).renamedFrom('Remark'),
  },
});
```

```json
{
  "$model": "0.1",
  "entities": {
    "Comment": {
      "schema": {
        "type": "object",
        "properties": {
          "id": { "type": "string", "x-entity": { "key": true, "default": "uuid" } },
          "text": { "type": "string" },
          "slug": { "type": "string",
                    "x-entity": { "default": { "query": { "$lower": "$.text" } } } },
          "created": { "type": "string", "format": "date-time",
                       "x-entity": { "default": "now" } },
          "touched": { "type": "string", "format": "date-time",
                       "x-entity": { "default": "updated", "column": "integer" } },
          "kind": { "type": "string", "enum": ["memo", "todo"],
                    "x-entity": { "default": { "value": "memo" } } },
          "weight": { "type": "integer", "x-entity": { "default": { "value": 1 } } }
        },
        "required": ["id", "text"],
        "additionalProperties": false
      },
      "x-rename": "Remark"
    }
  }
}
```

`compute()`'s callback is not stored and never runs at write time: it
runs ONCE, at build, against the chain's recording proxy, leaving the
`{ $lower: '$.text' }` document above — the query the store evaluates
over the document being written. It sees `$` and nothing else, which is
why a second parameter is `JL0104` (§4.3). `x-rename` rides on the
ENTITY: `.renamedFrom()` writes builder state and `defineModel` lifts it
(`src/model/define.js:116`), and on a member it is refused (§4.2).

The store's two kinds of key, on a revision and on a follow — one
store-allocated, one composite, and what each does to
`required`:

```js
import * as m from '@jarenjs/linq/model';

export const model = m.defineModel({
  entities: {
    Revision: m.object({
      rid: m.integer().identity('auto'),
      title: m.string(),
      rev: m.integer().version().optional(),
    }),
    Follow: m.object({
      follower: m.string().key(),
      followed: m.string().key(),
      score: m.integer().optional(),
    }),
  },
});
```

```json
{
  "$model": "0.1",
  "entities": {
    "Revision": {
      "schema": {
        "type": "object",
        "properties": {
          "rid": { "type": "integer", "x-entity": { "key": true, "default": "auto" } },
          "title": { "type": "string" },
          "rev": { "type": "integer", "x-entity": { "version": true } }
        },
        "required": ["rid", "title"],
        "additionalProperties": false
      }
    },
    "Follow": {
      "schema": {
        "type": "object",
        "properties": {
          "follower": { "type": "string", "x-entity": { "key": true } },
          "followed": { "type": "string", "x-entity": { "key": true } },
          "score": { "type": "integer" }
        },
        "required": ["follower", "followed"],
        "additionalProperties": false
      }
    }
  }
}
```

**`rid` is still in `required`, and that is deliberate.** The pen writes
the schema of a STORED document, and a stored ticket always has its key.
The exemption belongs to the write: a store-allocated key is allocated
after validation, so the store validates an insert with that member
dropped from `required` (MODEL-FORMAT §9.6), and the type says the same
from the other side — `identity('auto')` marks the member `generated`, so
it is optional on `EntityInput` and required on `EntityDoc` (§5.2).
Spelling it `optional()` to "fix" the emission would make the READ shape
wrong. `Follow` has no such member: a composite key is caller-supplied,
both parts are required, and `EntityKey` is
`{ follower: string; followed: string }`.

Not everything in the store is an entity. A collection is a document
schema with a key pointer, and the blog keeps two: one with a captured
key and one whose key the store allocates:

```js
import * as m from '@jarenjs/linq/model';

export const model = m.defineModel({
  collections: {
    notes: m.collection(
      m.object({ id: m.string(), body: m.string(), pinned: m.boolean().optional() }),
      { key: (d) => d.id },
    ),
    log: m.collection(m.object({ line: m.string() }), { key: null, identity: 'integer' }),
  },
});
```

```json
{
  "$model": "0.1",
  "collections": {
    "notes": {
      "schema": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "body": { "type": "string" },
          "pinned": { "type": "boolean" }
        },
        "required": ["id", "body"],
        "additionalProperties": false
      },
      "key": "/id"
    },
    "log": {
      "schema": {
        "type": "object",
        "properties": { "line": { "type": "string" } },
        "required": ["line"],
        "additionalProperties": false
      },
      "key": null,
      "identity": "integer"
    }
  }
}
```

`(d) => d.id` is captured, checked to be a member path and rewritten as
the RFC 6901 pointer `/id` (`src/model/collection.js:116-129`, escaping
`~` and `/` as `~0`/`~1`) — a pointer string is accepted verbatim, and
`key: null` says the store allocates, with `identity` naming how.

**The one example here that is not part of the blog**, and why: an index
is only worth reading on members that show what the three kinds do, and
the blog has no coordinate and no embedding. This collection has both — a
composite, a geohash and a vector, over one collection:

```js
import * as m from '@jarenjs/linq/model';

export const model = m.defineModel({
  collections: {
    places: m.collection(
      m.object({
        id: m.string(),
        series: m.string(),
        t: m.integer(),
        loc: m.array(m.number()),
        embedding: m.array(m.number()).length(4).optional(),
      }),
      {
        key: '/id',
        indexes: [
          m.index([(p) => p.series, (p) => p.t]),
          m.index((p) => p.loc, { name: 'by_cell', derive: 'geohash', precision: 7 }),
          m.index((p) => p.embedding, { derive: 'vector', dims: 4 }),
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
          "series": { "type": "string" },
          "t": { "type": "integer" },
          "loc": { "type": "array", "items": { "type": "number" } },
          "embedding": { "type": "array", "items": { "type": "number" },
                         "minItems": 4, "maxItems": 4 }
        },
        "required": ["id", "series", "t", "loc"],
        "additionalProperties": false
      },
      "key": "/id",
      "indexes": [
        { "name": "by_series_t", "path": ["$.series", "$.t"] },
        { "name": "by_cell", "path": "$.loc", "derive": "geohash", "precision": 7 },
        { "name": "by_embedding", "path": "$.embedding", "derive": "vector", "dims": 4 }
      ]
    }
  }
}
```

The composite takes its default name from both segments
(`by_series_t`); the other two are named or derive it from the one
member. `derive`, `precision` and `dims` ride verbatim — the pen does not
know whether a driver has R\*Tree, and `normalizeModel` is the judge
(MODEL-FORMAT §2.1, §3.1).

## 4. Refusals

The model pen raises these three `LinqBuildError` codes and no others —
`test/linq/pen-docs.test.js` holds this list equal, in both directions,
to the codes `packages/linq/src/model/` throws. The full condition each
code states across every pen is the binder's,
[LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3.

| Code | What this pen raises it for |
|---|---|
| `JL0101` | a value this pen cannot spell, an option it does not know, or a name → value map it cannot read |
| `JL0102` | a construct the format cannot carry, or a mapping the store's own walk would refuse and the builder can already see |
| `JL0104` | `x-entity` written through `meta()`, or an external a captured `compute()` rule named |

Every message below is the one the pen raised when the spelling beside it
was run, with the code prefix (`JL0101: `) removed. Where a row lists
several spellings, the message shown is the first one's — the shared
predicates interpolate the method name, so the others differ only in the
word the message opens with. `docPath`, where the refusal carries one, is
the JSON pointer of the node being assembled, and is appended to the
message text as well (`… at /entities/A`).

The schema pen's own refusals reach a caller here unchanged — a member
that is not a builder, a constraint given the wrong kind of value, a
`$defs` collision — and are
[SCHEMA-PEN.md](SCHEMA-PEN.md#4-refusals)'s rows, not repeated below.
This section is the vocabulary this pen adds.

### 4.1 `JL0101` — the value, the option and the map

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `m.string().column('text')` | `column() takes 'integer' (an epoch column for a date) or 'json' (stay in the document), got "text"` | `.column('integer')` or `.column('json')` |
| `m.string().identity('random')` | `identity() takes 'uuid' or 'auto', got "random"` | `.identity('uuid')` on a string, `.identity('auto')` on an integer |
| `m.string().entity(null)`, `m.string().entity([])` | `entity() takes a plain object of x-entity members` | a plain object |
| `m.string().fill(() => 1)` | `fill() received a function, which is not JSON — a document carries null, booleans, finite numbers (never -0), strings, arrays and plain objects, and nothing else` | a JSON value |
| `m.rel.hasMany('Post', { via: 'authorId' })` | `rel.hasMany() must declare onDelete: 'cascade', 'restrict' or 'setNull' — a foreign key is never defaulted silently; got undefined` | `{ via: 'authorId', onDelete: 'cascade' }` |
| `m.rel.hasMany('Post', { via, onDelete, through })` | `rel.hasMany() does not take 'through'` | `through` belongs to `rel.belongsToMany()` |
| `m.rel.belongsToMany('Label', { via: 'x' })` | `rel.belongsToMany() does not take 'via'` | `{ through: 'post_tags' }`, or no options |
| `m.rel.hasMany('Post', null)` | `rel.hasMany() takes { via, onDelete }` | an options object |
| `m.rel.hasMany(42, { … })` | `rel.hasMany() takes a definition name (letters, digits, '_', '.', '-', not starting with a digit), got 42` | an entity name |
| `m.index(42)`, `m.index([])` | `index() takes a path lambda, a JSONPath string, or a non-empty array of them` | `m.index((p) => p.cell)` |
| `m.index([42])` | `index()[0] is neither a path lambda nor a JSONPath string` | a lambda or a path string per position |
| `m.index((p) => p.a, { derived: 'bbox' })` | `index() does not take 'derived' — the options are name, unique, derive, precision, dims, physical` | `{ derive: 'bbox' }` |
| `m.index((p) => p.a, null)` | `index() takes an options object` | `{}`, or no second argument |
| `m.index((p) => p.a, { name: '9 x' })` | `index() name takes a definition name (letters, digits, '_', '.', '-', not starting with a digit), got a string` | an identifier-shaped name |
| `m.collection(m.object({}), { key: 'id' })` | `collection() key is an RFC 6901 pointer, a member path lambda, or null` | `'/id'`, or `(d) => d.id` |
| `m.collection({}, {})` | `collection() takes a schema builder as its document schema` | a builder |
| `m.collection(b, { keys: [] })` | `collection() does not take 'keys' — the options are key, identity, indexes, renamedFrom` | `key` |
| `m.collection(b, { indexes: {} })` | `collection() indexes is an array of index() entries` | an array |
| `m.collection(b, { indexes: [{ path: '$.a' }] })` | `collection() indexes[0] is not an index() entry` | `m.index('$.a')` |
| `m.defineModel({})` | `defineModel() needs entities, collections, or both` | declare one of the two |
| `m.defineModel({ tables: {} })` | `defineModel() does not take 'tables'` | `entities` or `collections` |
| `m.defineModel({ entities: [] })` | `defineModel() entities is a plain object of declarations` | a plain object |
| `m.defineModel({ entities: { 'bad name': b } })` | `defineModel() entities names are identifiers, got 'bad name'` | `User` |
| `m.defineModel({ entities: { A: { schema: {} } } })` | `entities.A is not a schema builder` | a builder |
| `m.defineModel({ collections: { a: { schema: {} } } })` | `collections.a is not a collection() declaration` | `m.collection(…)` |

**The `__proto__` case.** It is the one refusal whose cause is invisible
in the source text, and this pen has two doors it reaches — the members
of an `object()`, and the names of `entities`/`collections`:

```js
m.defineModel({ entities: { __proto__: m.object({ id: m.string().key() }) } })
// JL0101: defineModel() entities received a map whose prototype was
// replaced: a '__proto__:' key in an object literal sets the prototype
// instead of adding a member, so that member is not there to emit —
// spell it { ['__proto__']: … }, which is an own key
```

The rule, the reason and the spelling that works are the binder's
([LINQ-FORMAT.md](LINQ-FORMAT.md) §1.1, rule 5): a computed key is an own
property, and the emitted document carries it as an ordinary member
because `defineModel` writes through `setObjectMember`.

### 4.2 `JL0102` — the construct, and the mapping the store would refuse

Raised either by the method (a mapping directive the builder can already
see is wrong) or by `defineModel` (a shape whose emitted form would mean
something else). Each of these has a twin in the store's own walk, and
the pen raises it earlier, at build, with the same meaning.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `m.string().column('integer')`, `m.integer().column('integer')` | `column('integer') applies to a date-time or date formatted string — the epoch column is derived from the RFC 3339 text; spell the member datetime() or date()` | `m.datetime().column('integer')` |
| `m.integer().identity('uuid')` | `identity('uuid') allocates a single string key — the member is a integer` | `m.string().identity('uuid')` |
| `m.string().identity('auto')` | `identity('auto') is allocated by the database for a single integer key only — the member is a string` | `m.integer().identity('auto')` |
| `m.number().identity('auto')` | `identity('auto') is allocated by the database for a single integer key only — the member is a number; spell it integer()` | `m.integer().identity('auto')` |
| `m.defineModel({ entities: { A: m.object({ a: m.integer().identity('auto'), b: m.string().key() }) } })` | `identity('auto') on A.a: a store-allocated key is a SINGLE key, and A declares a composite one (a, b)` — `docPath` `/entities/A/schema/properties/a/x-entity/default` | one `key()`, or a caller-supplied composite |
| `m.defineModel({ entities: { User: m.object({ posts: m.rel.hasMany('Psot', …) }), Post: … } })` | `relation target 'Psot' on User.posts is not a declared entity — the model declares 'User', 'Post'` — `docPath` `/entities/User/schema/properties/posts/x-entity/relation/to` | the declared name |
| `m.defineModel({ entities: { A: m.collection(b, { key: '/id', indexes: [] }) } })` | `entities.A is a collection() declaration — an entity has no key pointer and no indexes option: its key is key() on a member and its indexes are unique()/index() per member (the vocabulary has no composite or derived entity index)` — `docPath` `/entities/A` | put it under `collections`, or spell the entity as a builder |
| `m.object({}).key()`, `m.array(m.string()).index()`, `m.rel.hasMany(…).key()` | `key() applies to a member with a column of its own — this one's kind is 'object', and only a top-level scalar (string, number, integer, boolean, null) is column-mapped; everything else lives in the JSON document` | a top-level scalar member |
| `m.string().version()`, `m.number().version()` | `version() is the optimistic-concurrency token and lives in a plain integer column — this member's kind is 'string'; spell it integer()` | `m.integer().version()` |
| `m.string().entity({ bogus: true })` | `entity() writes the closed x-entity vocabulary (key, unique, index, default, column, relation, version); 'bogus' is not a member of it, and the store refuses one it cannot read rather than ignoring it (a mapping directive that is silently dropped loses data)` | a member of the vocabulary, or the method that spells it |
| `m.defineModel({ entities: { A: m.object({ id: m.string().key(), p: m.object({ x: m.string() }).renamedFrom('oldP') }) } })` | `renamedFrom() on entities.A.p is not written — $model 0.1 carries x-rename on an entity or a collection declaration, never on a member, so the hint would be lost and a rename the planner cannot see is a drop plus a create; put it on the declaration's own builder, or rename the member with a migration transform` — `docPath` `/entities/A` | the hint on the entity's own builder; a member is renamed by a migration `transform` |
| `m.index((p) => p.at)` | `index() answered a function, not a path — a member named like a surface method (\`at\`, \`get\`, \`all\`, …) is read with get('name'): (d) => d.get('at')` | `m.index((p) => p.get('at'))` |
| `m.index((p) => p.a.upper())` | `index() takes a member path ((d) => d.member); an operator result is not a path` | index the member; compute the value into one |
| `m.collection(b, { key: (d) => d.a.all() })` | `collection() key must select members by name ((d) => d.id), got the path $.a[*]` | `(d) => d.a` |

The surface-method case is worth its own sentence, because it is the one
that surprises: the capture proxy answers a real object, so a member
whose name collides with one of its methods (`at`, `get`, `all`, `count`,
…) reads as that method and the lambda returns a function rather than a
path. `get('name')` is the escape, and it is what the message names.

The column rows name the kinds the pen is CERTAIN about — `object`,
`record`, `array`, `tuple`, `enum`, `literal`, `any`, `never`, `union`,
`discriminated`, `when`. `from(json)`, `named()`, `ref()`, `lazy()` and
`intersection()` are deliberately absent: the store resolves a `$ref` and
merges an `allOf` before reading the type, so any may still be a scalar
and refusing one here would be an invention rather than a mirror. The
`renamedFrom` row's message names a builder-tree PATH at whatever depth
(`entities.A.p.items.q`) while `docPath` stays the declaration; a
`lazy()` thunk is never invoked by that walk, so a recursion terminates.

### 4.3 `JL0104` — the keyword, and the external

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `m.string().meta({ 'x-entity': { key: true } })` | `meta() cannot write 'x-entity' — the model pen owns that keyword; spell it through key(), identity(), unique(), index(), column(), now(), updated(), fill(), compute() or rel.*` | the method that emits it |
| `m.string().compute((d, x) => x.root.eq(1))` | `a compute() rule cannot bind 'root' — its query evaluates with no externals at all; anything else has nothing to bind to — it evaluates over the document being written, which its argument IS; there is nothing else to read` | read the document: `(d) => d.first.concat(d.last)` |
| `m.collection(User, { key: (d, x) => x.root })` | the same, `a collection() key rule cannot bind 'root'` | `(d) => d.id` |

The ownership is local to this pen. The schema pen does NOT own
`x-entity`, so `s.string().meta({ 'x-entity': { key: true } })` writes
the annotation happily — which is the honest behaviour there, since the
schema pen has no vocabulary to contradict. The refusal exists here
because this pen does, and a caller writing the block by hand would slip
past every check the methods perform.

`compute()`'s "no externals" is stricter than `check()`'s two: a default
is evaluated over the document being written, with no root and no path to
bind, so any second parameter names something that cannot exist.

## 5. The types

```ts
import * as m from '@jarenjs/linq/model';
import type { InferMeta } from '@jarenjs/linq/model';
import { openStore } from '@jarenjs/db';
import { typedStore } from '@jarenjs/db/typed';
import { nodeDriver } from '@jarenjs/db/node';

const model = m.defineModel({ entities: { User, Post } });   // §3's first model
const store = typedStore<InferMeta<typeof model>>(
  await openStore(model, { driver: nodeDriver() }));

const users = await store.entity('User').load({ include: { posts: true } });
users[0].posts;   // Post[] — widened by the include, no generate step
```

### 5.1 `InferMeta<>` is emit's map, derived

`InferMeta<M>` reads a model document's `__entities` phantom
(`packages/linq/types/model.d.ts:345-352`) and produces, per entity, the
four members `@jarenjs/db`'s `typedStore` takes: `doc`, `input`, `key`
and `relations`. The claim it makes is an equality, not a resemblance:
for the fixture model, `InferMeta<>` of the model rebuilt through this
pen is IDENTICAL — by the strict `Equals<>` test, not by assignability —
to the `EntityMetaMap` that `entityEmitModel` plus `@jarenjs/emit`
generate for the same document. `test/consumer/linq-model.ts` pins it
member by member and then as a whole, so a drift names its member.

Rule by rule, and each is a rule of emit's the declarations mirror:

- **Every entity interface is CLOSED**, nested shapes included, whatever
  `.open()` said. `Unopen<T>` strips every index signature recursively
  (`model.d.ts:285-289`) because `entityEmitModel` asks emit for
  `openObjects: 'closed'`: the runtime validator stays the judge of a
  stored document, and excess-property checking is the whole point of a
  generated type.
- **A relation member is an optional reference.** `doc` carries
  `to`/`to[]` optionally; `input` drops the to-one and to-many
  projections entirely and types a many-to-many member as
  `Array<key | doc>`, which is what `create()` accepts.
- **A date-formatted member is `DateTime` on `doc` and a plain `string`
  on `input`** (`model.d.ts:303-305`). The brand discriminates
  expressions; it never blocks a caller's literal.
- **`key` is the key member's primitive** — `string` or `number`, never
  its literal union — **or the composite object** over every `key()`
  member (`model.d.ts:317-327`).

### 5.2 The two flags this pen adds

The schema pen's `Flag` is `'optional' | 'defaulted' | 'generated' |
'key'`; the last two belong here (`packages/linq/types/schema.d.ts:37`,
and §5.1 of [SCHEMA-PEN.md](SCHEMA-PEN.md#51-the-phantoms-and-the-flags)
for the first two). `key()` and `identity()` set `key`; `identity()`,
`now()`, `updated()`, `fill()` and `compute()` set `generated`
(`model.d.ts:27-28`).

| | in the document (`doc`) | accepted by `create()` (`input`) |
|---|---|---|
| plain | required | required |
| `.optional()` | absent-able | absent-able |
| `.now()`, `.updated()`, `.fill()`, `.compute()` | required unless also `optional()` | **optional** — the store writes it |
| `.identity('uuid' \| 'auto')` | **required** | **optional** — the store allocates it |

That last row is §3's fourth example in type form: the key is in the
emitted `required` and in `EntityDoc`, and optional on `EntityInput`
alone.

The declarations narrow every kind-checked method to a receiver that can
carry it — `version()` to the integer builder, `column('integer')` to a
`DateTime`-typed one (`model.d.ts:66`), `identity('uuid')`/`'auto'` to
the string and integer builders, `key()`/`unique()`/`index()` to the
classes that can hold a column — and §4.2 is the runtime twin of each. A
strict consumer is stopped by the declaration, a JavaScript one by
`JL0102`. `.entity(patch)` is typed by `EntityBlock`, the closed
vocabulary MODEL-FORMAT §9.2 defines, so a member outside it neither
compiles nor builds; it carries no flag, because `key()`, `identity()`,
`fill()` and the rest are what `InferMeta<>` reads.

### 5.3 The exported classes, the constant and the guard

Ten exports are surface a caller does not CALL, which is why none of them
is in §2:

| Export | What a caller meets it as |
|---|---|
| `EntityBuilder` | the base of every untyped kind; a type annotation, and what `rel.*` members are built from |
| `EntityStringBuilder`, `EntityNumberBuilder`, `EntityArrayBuilder`, `EntityTupleBuilder`, `EntityObjectBuilder`, `EntityWhenBuilder`, `EntityNeverBuilder` | the seven kinds with their own methods; annotations and `instanceof` narrows — `m.string() instanceof m.EntityStringBuilder` is `true` and `s.string() instanceof m.EntityStringBuilder` is `false` |
| `SCHEMA_BUILDER` | the brand key, re-exported from the schema pen: a `Symbol.for` registry symbol, so the chain and the store recognise a builder without importing this directory |
| `isSchemaBuilder(value)` | the guard that reads the brand; `collection()` and `defineModel()` are written on it |

All eight are made by `withEntity(Base)` at module scope, which is how
this pen exists at all: `createFactories()` is called once with the eight
subclasses, so the factory wiring is written once and no subpath patches
another's prototype. A consumer subclassing one takes the same route —
`with()` keeps the subclass through every method.

All ten are VALUES, exported at run time and declared as one — including
`EntityNeverBuilder`, whose declaration says what the entity vocabulary
does on it: `false` carries no keywords, so `entity()`, `key()` and the
rest raise `JL0102` (`identity()` raises `JL0101`) and none is declared;
`renamedFrom()` writes outside the schema and survives. `RelationBuilder`
is the one TYPE here — a relation member is a plain builder over an `any`
schema at run time, met through `rel.hasMany()`, `rel.hasOne()` and
`rel.belongsToMany()`. Importing it as a value does not compile, and
`test/linq/types.test.js` holds each pen's two export sets equal.

### 5.4 What the pins hold

| File | What it proves |
|---|---|
| `test/consumer/linq-model.ts` | `InferMeta<>` of the fixture model EQUAL (not merely assignable) to the generated `EntityMetaMap`, member by member and whole; the `DateTime` brand on both sides; `typedStore` binding with no generate step; `load({ include })` widening the result; an index path checked against the collection's shape; and ten negatives |
| `test/linq/model-corpus.js` + `model-pen.test.js` | the runtime twin: every corpus model emits its hand-written document byte-equal, validates against `jaren-model.schema.json`, normalizes through the store's own model walk, opens under the node driver, round-trips a write through the defaults the pen declared, and hashes equal across two emissions |

The negatives are worth reading as a list of what the types forbid, since
each FAILS the build the day it starts compiling:

```ts
void m.defineModel({ entities: { User: m.object({
  posts: m.rel.hasMany('Psot', { via: 'authorId', onDelete: 'cascade' }) }) } });
void m.integer().identity('uuid');       // 'uuid' allocates a string key
void m.string().identity('auto');        // 'auto' is the database's, on an integer
void m.string().column('integer');       // the epoch column is a date's
void m.string().meta({ 'x-entity': { key: true } });   // owned here
void m.collection(Place, { indexes: [m.index((p) => p.nope)] });  // not a member
void m.defineModel({ entities: { Place: m.collection(Place, { indexes: [] }) } });
void (await import('@jarenjs/linq/schema')).string().key();  // no vocabulary there
```

**An entity handle is a provider**, and that is the one place this pen
and the chain meet: `from(store.sync.entity('User'))` types its element
through the model pen's phantoms — the `doc` shape `InferMeta<>` derived
— so a chain over it reads `u.email` as a member and `u.posts` as a
relation hop ([QUERY-PEN.md](QUERY-PEN.md) §3, §4).

## 6. What it cannot spell

The model pen's own limits are `JL0102`s (§4.2) and one absence. They
divide into two lists a reader must not conflate, because the two fail at
different times and a reader looking in the wrong one will hunt the wrong
error. A third list closes the section: the cases where the honest answer
is not to reach for this pen at all.

### 6.1 What the format cannot carry — refused here, at build

- **A composite or derived index on an entity, or a key pointer.** The
  vocabulary is `unique: true` and `index: true` per member, and nothing
  else: no multi-member entity index, no `derive: 'geohash'`, no
  `physical` choice, and no pointer key — an entity's key is `key()` on
  the members that make it. All four belong to a collection (§2.3), so
  the alternative is a collection, or a stored member the index can be
  single-column over. It is why a `collection()` under `entities` is
  refused by name rather than silently emitted.
- **An epoch column off a date.** `column('integer')` derives its value
  from RFC 3339 text; there is nothing to derive from an integer or a
  bare string. Spell the member `datetime()` or `date()`.
- **A store-allocated key beside a composite one.** `'uuid'` and
  `'auto'` allocate ONE value; a composite key has no single member to
  allocate. Supply the composite from the caller.
- **A relation to an entity the model does not declare.** The check is
  the pen's because it is the one relation rule the pen can see: the
  target is a name in the same document. Everything else about relations
  is the store's.
- **A mapping directive on a kind that can hold no column.** `key()`,
  `unique()` and `index()` need a column of their own and only a
  top-level scalar gets one (MODEL-FORMAT §9.3); `version()` needs an
  integer one. Put the directive on a scalar member — or, for a
  collection, use an `index()` over the path (§2.3), which is the one
  place a composite or derived index exists.
- **A `renamedFrom()` anywhere but a declaration's own builder.**
  `$model` 0.1 carries `x-rename` on an entity or a collection and
  nowhere else, so a hint on a member has nothing to be written into and
  a rename the planner cannot see is a drop plus a create. Put it on the
  declaration's builder; rename a member with a migration `transform`
  ([MIGRATION-PEN.md](MIGRATION-PEN.md) §3).
- **An `x-entity` member outside the vocabulary.** The set is closed
  (MODEL-FORMAT §9.2) because a silently ignored mapping directive is a
  data-loss bug waiting to happen; `entity()` holds the same set.

### 6.2 What the pen does not check, and the store does

These emit happily and fail at `openStore` — the pen would have to
re-implement a compile check, or know something a builder cannot see, to
catch them:

- **Inverse agreement.** Two declarations naming the same `via` must be
  one `many` side and one `one` side and must agree on `onDelete`;
  contradictions are `JD0031` from `normalizeEntities`, not `JL0102` from
  here.
- **POSITION.** A builder knows its kind, not where it is placed:
  `m.string().index()` is right as an entity member and wrong inside a
  nested object, where the store answers `JD0005`. The same holds for a
  type the pen cannot resolve — `from(json)`, `ref()`, `lazy()`,
  `named()` and `intersection()` are all accepted here (§4.2).
- **COMBINATION.** `column('json')` beside a `key()`, a `version()` that
  is also the key or is column-mapped, two `version()` members in one
  entity, an entity with no `key()` at all — each is a fact about several
  members, and the store's walk is where the whole entity is in view.
- **Anything about a `derive`, `precision`, `dims` or `physical`
  option.** They ride verbatim from `index()`; the model walk decides
  whether the driver can honour them.
- **An `x-entity` block written through the schema pen's `annotate()`.**
  `entity()` holds the closed vocabulary and `meta()` refuses the keyword
  outright (§4.3), but `annotate('x-entity', …)` is the low-level
  primitive both are built on and writes what it is given. The store's
  `JD0030` is the backstop.

### 6.3 When not to reach for this pen

- **The model is data.** A `$model` read from a file, fetched over the
  wire or produced by a tool is a value, and `openStore(model, …)` takes
  it as it stands. Nothing here has to be in the path.
- **The database already exists and you are matching it.** Planning runs
  one way — the model describes what the store should build — and reading
  a model back out of a live database is open work, tracked in
  [docs/ROADMAP.md](../../../docs/ROADMAP.md) under the data pair
  ("Introspection of an existing database"). Until it lands, a model over
  a database somebody else made is a transcription, and a transcription
  is as easy to get wrong in code as in JSON.
- **Nothing carries `x-entity`.** A collection takes a builder from any
  pen — `m.collection(s.object({ id: s.string() }), { key: '/id' })` is
  accepted and emits the same document — so a store of plain document
  collections with no keys, no relations and no column overrides needs
  the schema pen and `collection()`, not this whole subpath. §7 is what
  the difference costs.
- **It is one entity in a test.** `{ $model: '0.1', entities: { A: {
  schema: … } } }` is shorter than the import. The pen earns its place at
  the point where a relation has two ends to keep in agreement, or a
  member's mapping and its schema are edited together.
- **You want the store's own vocabulary and not the format's.** This pen
  writes `$model` 0.1 and refuses what MODEL-FORMAT §9.2 does not define.
  A directive the store would honour but the format has not published has
  no spelling here and should not get one — it belongs in the format
  first.

## 7. Cost

`@jarenjs/linq/model` builds to **<!--fact:bundle.model-->41,582<!--/fact--> bytes** as a minified,
tree-shaken ESM bundle — the figure `scripts/check-tree-shaking.js`
measures and `npm run test:tree-shaking` reports, published rounded
(<!--fact:bundle.model.kb-->42<!--/fact--> kB) beside the other nine subpath prices in
[docs/CONSUMING.md](../../../docs/CONSUMING.md).

The probe is a gate, not a report: building a two-member model as a
consumer would, it asserts four things and fails the build on any of
them:

- **no chain module** — none of `sequence.js`, `document.js`, `async.js`,
  `concurrency.js`, `provider.js`, `sources.js` or `schema-of.js`
  contributes a byte;
- **no engine and no store** — not one byte of `@jarenjs/json`,
  `@jarenjs/validate`, `@jarenjs/emit`, `@jarenjs/db`,
  `@jarenjs/formats` or `@jarenjs/refs`, the tree-shaken proof of §1;
- **a ceiling** of 41,000 bytes;
- **and the other direction** — the schema pen's own bundle carries no
  byte of `packages/linq/src/model/`, because the subclasses are built by
  this subpath rather than patched onto the base classes.

The price above the schema pen's <!--fact:bundle.schema-->33,156<!--/fact--> is about 8 kB: the mixin, the
three relation factories, `collection()`/`index()` with their capture,
`defineModel()` — and the refusal MESSAGES, which are most of what §4
costs. That is a deliberate trade: naming the rule and the spelling that
works is why a mapping mistake is a `JL0102` at build rather than a
`JD0005` at `openStore`, so the ceiling is raised with the reason and the
text is not shaved.
