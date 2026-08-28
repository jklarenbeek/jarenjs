# The Jaren model pen (normative)

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119. The rules every pen keeps, the
shared refusal table and the index of the other pens are the binder,
[LINQ-FORMAT.md](LINQ-FORMAT.md).

## 1. What it writes

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

## 2. The mapping table

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
(QUERY-PEN §3, §4 "relation navigation"). The table the chain reads is
the one the store derives from these members (`store.entity(name)
.relations`, MODEL-FORMAT §10.1); `rel.belongsToMany` members are the one
kind it refuses (`JL0105`), because their join table is not a queryable
root in this version.

## 3. Worked examples

Every `js` fence exports exactly one model (or builder), and the
`json` fence that follows is what the pen emits — executed by
`test/linq/pen-docs.test.js`.

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

## 4. Refusals

The model pen raises these `LinqBuildError` codes and no others —
`test/linq/pen-docs.test.js` holds this list equal, in both directions,
to the codes `packages/linq/src/model/` throws. The full condition each
code states across every pen is the binder's,
[LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3.

| Code | What this pen raises it for |
|---|---|
| `JL0101` | a value this pen cannot spell, or a name → value map it cannot read |
| `JL0102` | a construct the format cannot carry |
| `JL0104` | a pen-owned keyword written through `meta()`, or an external a captured rule did not declare |

The message names the fix, and `docPath` is the JSON pointer of the node
being assembled where the refusal has one.

## 5. The types

```ts
import * as m from '@jarenjs/linq/model';
import type { InferMeta } from '@jarenjs/linq/model';
import { typedStore } from '@jarenjs/db/typed';

const model = m.defineModel({ entities: { User, Post } });
const store = typedStore<InferMeta<typeof model>>(await openStore(model, { driver: nodeDriver() }));
const users = await store.entity('User').load({ include: { posts: true } });
users[0].posts;   // Post[] — widened by the include, no generate step
```

## 6. What it cannot spell

Every construct the model pen refuses as unspellable is `JL0102`. §2's
Status column names the ones that belong to a method of this pen, each
beside the spelling that works; the binder's shared table
([LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3) carries the condition in full.

## 7. Cost

`@jarenjs/linq/model` builds to **37,857 bytes** as a minified,
tree-shaken ESM bundle — the figure `scripts/check-tree-shaking.js`
measures and `npm run test:tree-shaking` reports, published rounded
beside the other nine subpath prices in
[docs/CONSUMING.md](../../../docs/CONSUMING.md). It carries the schema pen it subclasses, and no chain module, no store and no engine.
