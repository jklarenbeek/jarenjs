# The Jaren linq client (normative)

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119. The rules every pen keeps, the
shared refusal table and the index of the other pens are the binder,
[LINQ-FORMAT.md](LINQ-FORMAT.md).

## 1. What it writes

The store's front door: `open(model, options)` opens `@jarenjs/db`'s
store and fronts it with handles typed from the model pen. It is not a
pen in LINQ-FORMAT §1's sense — it emits no document of its own — but
it keeps the pen rules where they apply: every read is a chain (the
query document) or the store's own `load` specification, EMITTED here
and never run here; the types are the pen's phantoms (`InferMeta<>`, no cast, no
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

## 2. What is the store's and what is the client's

| Member | Whose | What the client does |
|---|---|---|
| `open(model, { driver, …, validator? })` | the store's `openStore`, every option forwarded verbatim (`capture`, `live`, `jobs`, `profile`, … included) | wires `validator` as `compileSchema` — the default, `defaultValidator()`, is `new JarenValidator({ collectErrors: true })` with the string and date-time formats registered (the configuration MIGRATING-FROM-ZOD's recipe reproduces, so `s.string().email()` asserts out of the box); an explicit `compileSchema` wins; `validator: null` opens unvalidated, by name (`capabilities.validated === false`) |
| `client.entities.<Name>` | one frozen handle per declared entity, built at open (no Proxy; an unknown name is `undefined`, and for a pen model a compile error) | the store's typed entity set, every member — `create get update delete load explainLoad add put remove discard link unlink asNoTracking execute explain root scope relations` — plus the rows below |
| `where`, `select`, `orderBy`, …, `toArray`, `first`, `count`, … | the chain: `fromAsync(handle)` (QUERY-PEN §8, §10) | every `AsyncSequence` operator and terminal, delegated — nothing is duplicated, every read is the chain's document and pushes down; the handle is iterable (`for await`); `explain()` without a document explains the empty chain, `explain(document)` is the store's; two handles of one client share a `scope`, so a join's inner may be `fromAsync(otherHandle)` |
| `include(pick, spec?)` | the store's `load(spec)` (MODEL-FORMAT §10.4, §10.5) | opens a graph that EMITS the spec (§3), typed `Loaded<>` by what it included; `where`/`orderBy`/`orderByDescending`/`thenBy`/`thenByDescending`/`take`/`skip`/`after`/`maxDepth` are the root's clauses; `asNoTracking()` the untracked load; `toSpec()`/`toJSON()` the document; `toArray()` is `load(spec)`; `explain()` is `explainLoad(spec)` — the SQL, the includes, the pagination strategy |
| `link(own, member, target)`, `unlink(…)` | the store's membership API (MODEL-FORMAT §11.7) | reads the relation table first — the member must be a many-to-many relation (`JL0107`, naming the kind it is, or the declared members) — then records through the store; `saveChanges()` writes the join rows; typed over exactly the many-to-many members (the ones the generated input type also carries) |
| `live(chain \| document, options?)` | the store's registration — `store.live` for an entity root, `collection.live` for a collection (LIVE-FORMAT §7) | hands over the chain's document and its `explain().bindings` as the externals (`options.externals` merge over them); the strategy, the reason and the maintenance are the store's — an entity chain re-runs, declared, a translatable collection chain is incremental; without capture the store's `JD0050` surfaces unchanged; a chain split by `mapAsync` has no document (`JL0005`); the rows are typed by the chain's item |
| `client.collections.<name>` | the store's collection | the same chain start and `live`, typed from the pen's collection schema |
| `saveChanges()`, `transaction(fn)`, `close()`, `capabilities`, `store` | the store's | pass-throughs (`saveChanges` and `live` exist exactly when the model declares entities, as on the store); `store` is the escape hatch, typed `TypedStore` |

## 3. Worked examples

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

## 4. Refusals

The client raises these `LinqBuildError` codes and no others —
`test/linq/pen-docs.test.js` holds this list equal, in both directions,
to the codes `packages/linq/src/db/` throws. The full condition each
code states across every pen is the binder's,
[LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3.

| Code | What this pen raises it for |
|---|---|
| `JL0101` | a value this pen cannot spell, or a name → value map it cannot read |
| `JL0107` | a member that is not the relation kind the operation needs |

The message names the fix, and `docPath` is the JSON pointer of the node
being assembled where the refusal has one.

## 5. The types

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

## 6. What it cannot spell

The client writes no document of its own — it hands the store a
specification and reads back rows — so it has no construct set to refuse
as unspellable and raises no `JL0102`. What it refuses instead is a
member that is not the relation kind the operation needs (`JL0107`, §4),
and everything the store's own vocabulary cannot carry is the store's
refusal, raised where the store raises it.

## 7. Cost

`@jarenjs/linq/db` builds to **477,874 bytes** as a minified,
tree-shaken ESM bundle — the figure `scripts/check-tree-shaking.js`
measures and `npm run test:tree-shaking` reports, published rounded
beside the other nine subpath prices in
[docs/CONSUMING.md](../../../docs/CONSUMING.md). The store, the validator and the formats ride by construction — they are what the client opens — and no other pen does.
