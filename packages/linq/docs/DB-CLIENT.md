# The Jaren linq client

> `./db` — the client: the store's typed front door, not a pen, and the
> package's one runtime edge. **Read it when** you are reading or
> writing rows: `load`, `include`, `link`/`unlink`, `live`

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119. This document is a **guide** — read
it in order and you can write the format — whose one normative section is
[§2 The surface](#2-the-surface); the rules every pen keeps, the shared refusal table, the
index of the other pens and every pen's mapping table collected in one
place are the normative reference,
[LINQ-FORMAT.md](LINQ-FORMAT.md).

## 1. What it writes

You have a store declared with the model pen and you want to read it — a
list with a filter, the related rows beside each one, a page after the
last key you saw. The store already answers a query document and a load
specification; what you would rather not do is write either by hand,
naming entities and relations in strings that nothing checks. This is the
door that types both from the model you already wrote.

The store's front door: `open(model, options)` opens `@jarenjs/db`'s
store and fronts it with handles typed from the model pen. **The running example**
throughout is the blog store [MODEL-PEN.md](MODEL-PEN.md) §3 declares —
users, their posts, the labels a post carries and the comments under it —
read four ways in §3 and typed in §5. It is **not a
pen** in [LINQ-FORMAT.md](LINQ-FORMAT.md) §1's sense — it emits no
document of its own, so there is no format it writes and no grammar to
validate against — but it keeps the pen rules where they apply:

- every read is a document, EMITTED here and run by the store: a chain
  over a handle is the query document ([QUERY-PEN.md](QUERY-PEN.md) §8),
  and a load graph is the `load` specification MODEL-FORMAT §10.4 reads.
  Both are plain, deep-frozen JSON, and `toJSON()` answers them as a
  pen's does;
- the types are the pen's phantoms (`InferMeta<>` of the model pen's
  document), with no cast and no generate step;
- refusals are coded `JL01xx` build errors (`JL0107`, `JL0101`), raised
  where the client can see them earlier than the store and mirrored from
  the store's own rules, never invented;
- the store stays the engine. The client adds no storage semantics and
  duplicates no algorithm: `include` emits the spec the store already
  runs, membership is the store's own `link`/`unlink`, `live` is the
  store's registration, and every read is one an `explain()` can name.

That distinction is why this document is `DB-CLIENT.md` and not
`DB-PEN.md`, and it is visible in every section below — most of all in
§2, which enumerates a surface rather than a mapping, and in §3, whose
fences are specifications the client hands over rather than documents it
authored.

### 1.1 The edge

This subpath is the package's one runtime import edge:
`packages/linq/src/db/` imports `@jarenjs/db`, `@jarenjs/validate` and
`@jarenjs/formats`, declared under `peerDependencies` with
`peerDependenciesMeta.optional: true` and never under `dependencies`. A
consumer of `.` (the chain) or of any pen installs nothing new; a
consumer of `./db` installs the three; the store never imports this
package.

Three gates hold it, and §7 states what it costs:

- the **tree-shaking probes** — the `.` entry carries no client module
  and not one byte of the three; the `./db` bundle carries all three and
  no other pen;
- the **packed-consumer gate** — every subpath is imported WITHOUT the
  peers first, where `./db` must fail by a peer's name and nothing else
  may fail, then with them installed from the tarballs;
- the **edge suite** in `test/db/provider.test.js` — both manifests, and
  every source and declaration file of both packages, for every import
  spelling.

## 2. The surface

**A note on this section's title.** Every other document in this family
titles its §2 "The mapping table", because a pen maps a method to the
member it emits. The client maps nothing: it opens a store and hands
back typed handles, so a table with an "Emits" column would have to
invent one. §2 keeps its D3 slot and its meaning — this is where every
name a caller writes is named — under the title that describes what it
holds.

The vocabulary is small and the surface is not. Two exported names, and
then whatever those two hand back: a client of frozen handles, each of
which is the store's own set plus the chain plus three additions. §2.1
divides the two; §2.2 to §2.5 enumerate them.

### 2.1 What is the store's and what is the client's

Which half of every member you meet belongs to `@jarenjs/db` and which
is added here — the line to have in mind before the tables, because it
decides which document answers a question about behaviour.

| Member | Whose | What the client does |
|---|---|---|
| `open(model, { driver, …, validator? })` | the store's `openStore`, every option forwarded verbatim (`capture`, `live`, `jobs`, `profile`, … included) | wires `validator` as `compileSchema` — the default, `defaultValidator()`, is `new JarenValidator({ collectErrors: true })` with the string and date-time formats registered (the configuration MIGRATING-FROM-ZOD's recipe reproduces, so `s.string().email()` asserts out of the box); an explicit `compileSchema` wins; `validator: null` opens unvalidated, by name (`capabilities.validated === false`) |
| `client.entities.<Name>` | one frozen handle per declared entity, built at open (no Proxy; an unknown name is `undefined`, and for a pen model a compile error) | the store's typed entity set, every member — `create get update delete load explainLoad add put remove discard link unlink asNoTracking execute explain root scope relations` — plus §2.3's additions |
| `where`, `select`, `orderBy`, …, `toArray`, `first`, `count`, … | the chain: `fromAsync(handle)` ([QUERY-PEN.md](QUERY-PEN.md) §8, §10) | every `AsyncSequence` operator and terminal, delegated — nothing is duplicated, every read is the chain's document and pushes down; the handle is iterable (`for await`); two handles of one client share a `scope`, so a join's inner may be `fromAsync(otherHandle)` |
| `include(pick, spec?)` | the store's `load(spec)` (MODEL-FORMAT §10.4, §10.5) | opens a graph that EMITS the spec (§2.4, §3), typed `Loaded<>` by what it included |
| `link(own, member, target)`, `unlink(…)` | the store's membership API (MODEL-FORMAT §11.7) | reads the relation table first — the member must be a many-to-many relation (`JL0107`, naming the kind it is, or the members that are) — then records through the store; `saveChanges()` writes the join rows |
| `live(chain \| document, options?)` | the store's registration — `store.live` for an entity root, `collection.live` for a collection (LIVE-FORMAT §7) | hands over the chain's document and its `explain().bindings` as the externals (`options.externals` merge over them); the strategy, the reason and the maintenance are the store's |
| `client.collections.<name>` | the store's collection | the same chain start and `live`, typed from the pen's collection schema (§2.5) |
| `saveChanges()`, `transaction(fn)`, `close()`, `capabilities`, `store` | the store's | pass-throughs; `saveChanges` and `live` exist exactly when the model declares entities, as on the store; `store` is the escape hatch, typed `TypedStore` |

### 2.2 The three exported names

The whole export surface: a door, a type-level reader for what it hands
back, and the durable ledger over what it opened.

| Name | Answers | Type reading |
|---|---|---|
| `open(model, options)` | a promise of the frozen client — `store`, `capabilities`, `entities`, `collections`, `transaction`, `close`, and `saveChanges`/`live` when the model declares entities | `Client<InferMeta<typeof model>>` for a pen model; `Client<E>` for `open<E>(json, …)`; the wide map for a bare JSON model |
| `defaultValidator()` | `new JarenValidator({ collectErrors: true })` with `stringFormats` and `dateTimeFormats` registered | `JarenValidator` |
| `createDbLedger(client, options?)` | the contract idempotency ledger (`claim`/`commit`/`fail`/`lookup`/`sweep`) over a declared collection of the client's store — §2.6 | `DbLedger`; structurally `@jarenjs/contract`'s `Ledger` |

`open` is the only door, and it is deliberately not a coded refusal: a
missing `options`, or a `validator` that is not a `JarenValidator`, is a
plain `TypeError` naming the driver imports (`open needs { driver } from
@jarenjs/db/node, /bun or /wasm`). A `JL01xx` is a refusal to write
something into a document, and neither of those is about a document.

`defaultValidator()` is exported so a host can build the same validator
and add to it — `defaultValidator().addFormats(myFormats)` — rather than
reconstruct the configuration by reading this paragraph.

### 2.3 The entity handle

A handle is 59 members and no Proxy: 18 from the store's entity set, 40
from the chain, one name in both (`explain`, resolved below), and two of
the client's own.

| Group | Members |
|---|---|
| the unit of work | `create` `get` `update` `delete` `add` `put` `remove` `discard` `asNoTracking` |
| the store's reads | `load` `explainLoad` `execute` |
| the provider seam | `root` `scope` `relations` |
| membership | `link` `unlink` — the store's, behind §4.2's check |
| the chain | every `AsyncSequence` operator and terminal: `where` `select` `selectMany` `orderBy` `orderByDescending` `thenBy` `thenByDescending` `groupBy` `aggregate` `join` `groupJoin` `skip` `take` `distinct` `reverse` `concat` `defaultIfEmpty` `ofType` `cast` `zip` `mapAsync` `params` `toDocument` `toArray` `first` `firstOrDefault` `single` `singleOrDefault` `last` `lastOrDefault` `elementAt` `elementAtOrDefault` `count` `sum` `average` `min` `max` `any` `all`, and `Symbol.asyncIterator` |
| the client's own | `include` (§2.4) and `live` |
| in both | `explain` |

**`explain` is the one name the store's set and the chain both carry, and
it is resolved by arity rather than by precedence.** `handle.explain()`
with no argument explains the EMPTY chain — `{ barriers: [], hops: [],
bindings: {}, document: '$.Post[*]' }` — and `handle.explain(document,
options?)` is the store's own explanation of that document, the one that
names the translator, the SQL and the referenced roots. It is the only
collision: a sweep of the chain's 40 names against the entity set's 18
finds `explain` and nothing else, which is what makes the delegation
safe to state as a rule rather than as a list of exceptions.

A chain over a handle is the query document and pushes down:

```js
client.entities.Post.where((p) => p.stars.ge(3)).toDocument()
```
```jsonc
{ "$for": { "it": "$.Post[*]" }, "$where": { "$ge": ["$it.stars", 3] }, "$return": "$it" }
```

That document is the chain's, not the client's — `fromAsync(handle)`
would build the same one — which is exactly the claim "nothing is
duplicated" makes checkable. `test/linq/client.test.js` asserts it, then
hands it to `explain()` and asserts `mode: 'native'` with no residual.

### 2.4 The graph

`include(pick, spec?)` opens a graph: an immutable builder of the store's
`load` specification, with 17 members of its own.

| Member | Emits | Note |
|---|---|---|
| `include(pick, spec?)` | one entry of `include` | `pick` is `(u) => u.posts`, or `u.get('posts')` for a name that collides with a proxy method |
| `where(predicate)` | `where` | consecutive calls conjoin under one `$and` |
| `orderBy(key, options?)`, `orderByDescending(key, options?)` | `orderBy` | replaces; `options` is `{ empty?, collation? }` |
| `thenBy(key, options?)`, `thenByDescending(key, options?)` | appends to `orderBy` | `JL0005` when no `orderBy` precedes it |
| `take(n)`, `skip(n)` | `take`, `skip` | the offset window |
| `after(cursor)` | `after` | the keyset continuation (§10.5) a `page()` over the same ordering emitted — typed by the declared ordering, so a bare key does not compile; the ROOT only |
| `maxDepth(n)` | `maxDepth` | the include depth bound (§10.4) |
| `asNoTracking()` | — | changes the load, never the document |
| `toSpec()`, `toJSON()` | the spec | plain deep-frozen JSON, a snapshot: mutating it changes nothing, and two builds are one document |
| `toArray()` | — | `load(spec)`: the store's one statement |
| `cursor(options?)` | — | `loadCursor(spec, options)`: one root graph per pull from that same statement, its includes attached and bounded per root; `return()` releases it; `{ signal?, tracking? }` — untracked unless `tracking: true` |
| `page(options?)` | — | `page(spec, options)`: one bounded page over the composite keyset — `{ items, continuation, hasMore, snapshot }`, never more than `limit` roots or `maxBytes` bytes; `{ limit?, after?, maxBytes?, consistency?, signal?, tracking? }`; a `take`/`skip` on the graph beside it is the store's `JD0032` |
| `explain()` | — | `explainLoad(spec)`: the SQL, the includes, the pagination strategy, the per-root bounds |

The spec's member order is fixed — `where, orderBy, take, skip, after,
maxDepth, include` at the root; `where, orderBy, take, skip, count,
maxRows, maxBytes, include` in an include — so one graph is one document
however it was built. An include spec is `true` (or absent) for the rows, `{ count:
true }` for the number, or an object of clauses:

| Spec member | Emitted | Note |
|---|---|---|
| absent, or `true` | `true` | the rows |
| `{ count: true }` | `{ count: true }` | the number; any other member beside it is the store's `JD0032` |
| `where: (p) => p.stars.ge(3)` | `where: { $ge: ["$it.stars", 3] }` | the target row is `it`; translatability is the store's verdict (`JD0032`), and a relation hop is a plain path here and refused there |
| `orderBy: (p) => p.pid` | `orderBy: "$it.pid"` | a bare key, ascending |
| `orderBy: { key, desc?, empty?, collation? }` | `orderBy: { $key, $dir, $empty, $collation }` | as the chain spells `$orderby`; an array of either is an array |
| `take`, `skip` | `take`, `skip` | the window inside the subquery (a non-integer is the store's `JD0032`) |
| `maxRows`, `maxBytes` | `maxRows`, `maxBytes` | the per-root bounds (MODEL-FORMAT §10.4): rows of the relation per parent and serialised bytes per parent; crossing one is the store's `JD2073`, never a truncated graph. Defaults 1000 rows / 1 MiB (a `take` is the row bound of the include it windows); `Infinity` spells the unbounded case and emits as `null` |
| `include: { comments: spec }` | `include: { comments: <lowered> }` | over the TARGET's relation table (the scope carries every root's) |
| anything else | `JL0101` | the vocabulary is closed; `after` paginates the root, never an include |

Every callback is captured over `$it` through the chain's recording proxy
with **no parameters** — a load clause binds no externals, so `p.min` is
`JL0004` and a value that varies belongs in a JavaScript constant the
capture closes over.

What comes back from `explain()` is the store's, and it is worth showing
once because it is the answer to "did my graph become one statement":

```jsonc
// client.entities.User.include((u) => u.posts).explain(), abridged
{
  "sql": "SELECT \"r\".*, … (SELECT json_group_array(…) FROM \"Post\" …) AS \"__posts\" FROM \"User\" AS \"r\" …",
  "pagination": "none",
  "includes": [{ "path": "posts", "kind": "oneToMany", "count": false }]
}
```

One `sql`, one `pagination` strategy, and one `includes` entry per loaded
relation with the path it was reached by. `test/linq/client.test.js`
counts the driver's statement executions and asserts exactly one for a
graph with two includes.

### 2.5 The collection handle

A collection handle is 49 members: 10 from the store's collection
(`stats` `get` `insert` `put` `patch` `delete` `execute` `query`
`explain` `live`), the same 40 chain members, and the same one overlap on
`explain`. It has no `include`, no `link`/`unlink` and no unit of work,
because a collection has no relations and no tracking — and neither does
its client: a collections-only model opens a client with no
`saveChanges` and no `live` of its own, exactly as the store does.

### 2.6 The ledger

`createDbLedger(client, { collection = 'ledger', ttlMs = 86_400_000,
runtime, now })` is the `Ledger` the `@jarenjs/contract` http binding
calls under `policy.idempotency` (CONTRACT-FORMAT.md §8), over a
declared collection of the store the client opened — the collection
`idempotencyLedgerModel` declares, or any collection with that
record's schema (`collection` names it; a name the model does not
declare is a `TypeError` at construction, not at the first claim).
The implementation is the client's own surface and nothing else: it
imports no contract module, no driver, no store; the record it writes
is exactly the model's, and the id is the same versioned JSON tuple the
memory ledger spells (`1:["op","scope","key"]`, injective over `|`,
control characters and Unicode). The contract package keeps its D1
edge: it depends on no store, and this door depends on no contract.

**Which client decides the transaction.** A root client (the one `open`
answered) runs every claim, settlement, lookup and sweep in a
transaction of its own with `mode: 'immediate'` — the write lock taken
before the read, so two processes claiming one key from one file see
exactly one `new` and the other `in-progress`, never two handlers. The
client a transaction callback received runs them as savepoints inside
that transaction instead: a domain write and the settlement then
commit together or roll back together — the ledger a lifecycle
settlement lease carries. Atomicity is same-store only: a ledger on
one file and a domain write on another are two commits.

**The generation fence.** A `new` claim mints a `generation` (the
runtime record's `uuid`), persists it with the record and hands it
back in the ref (`{ id, generation }`). `commit`/`fail` settle the
record whose id AND generation the ref names while it is `started`; a
ref whose key expired, was reclaimed under a newer generation, or was
settled already is refused with **`JL2007`** (rejected), and the
record it would have touched is unchanged — across processes and
restarts, because the generation is in the file. The binding reports
the refusal to its `onError`; the response still goes out.

**Clocks and expiry.** `now` wins, then the runtime record's clock;
given neither, the ledger follows the instants the binding passes with
each call (a host-side `lookup`/`sweep` without one uses the latest).
A record past `expiresAt` is dropped on `claim` and `lookup`;
`sweep(now?)` drops every expired record and answers the count. A
record written under the earlier `"<op>|<scope>|<key>"` id spelling
is matched by no claim: it expires by its own `expiresAt`, or a host
rewrites its `id` once with `ledgerId` from `@jarenjs/contract/ledger`.

```js
import { open, createDbLedger } from '@jarenjs/linq/db';
import { nodeDriver } from '@jarenjs/db/node';
import { idempotencyLedgerModel } from '@jarenjs/contract/ledger';
import { serveHttp } from '@jarenjs/contract/http';

const db = await open(idempotencyLedgerModel, { driver: nodeDriver(), path: 'ledger.db' });
const server = serveHttp(contract, handlers, { ledger: createDbLedger(db) });   // root: immediate claims

await db.transaction(async (tx) => {                          // a settlement inside the host's transaction
  await tx.collections.orders.insert(order);
  await createDbLedger(tx).commit(ref, response);             // commits with the order, or not at all
});
```

## 3. Worked examples

The client's examples are not builder-to-document pairs, and this is
where a reader who has read a pen document should slow down. A `js`
fence here exports a **graph**, and the `json` fence beside it is the
`load` specification that graph emits — a document the client hands the
store, not one it authored. Every pair is executed by
`test/linq/pen-docs.test.js`, and each graph in it also loads: the
fences were run through `explain()` and `toArray()` against a real
`node:sqlite` store before they were written down.

A chain over a handle cannot be a pair, because the chain's document is
not read by `schemaOf`; §2.3 shows one as prose with its assertion cited
from `test/linq/client.test.js`, and §2.4 does the same for an
`explain()`. Four pairs is what the graph surface supports honestly, and
four is what §3 carries.

Each fence opens its own store over the smallest model that carries the
relations it needs, so a reader can run any one of them alone — but they
are all the same store, the blog [MODEL-PEN.md](MODEL-PEN.md) §3
declares: users, their posts, the labels a post carries and the comments
under it. Read in order, the four are one reading session against it: an
include with a spec and a counted membership, then the root clauses and a
cursor, then every way to spell an ordering, then a bracketed pick with a
two-level include.

### 3.1 An include with a spec, and a counted membership

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

// the graph EMITS the spec below; toArray() is load(spec) — one statement — and
// explain() is explainLoad(spec). The rows type as User & { posts: Post[]; labels: number }
export const graph = client.entities.User
  .include((u) => u.posts, { where: (p) => p.stars.ge(3), orderBy: { key: (p) => p.stars, desc: true }, take: 2 })
  .include((u) => u.labels, { count: true });
```
```json
{
  "include": {
    "posts": {
      "where": { "$ge": ["$it.stars", 3] },
      "orderBy": { "$key": "$it.stars", "$dir": "desc" },
      "take": 2
    },
    "labels": { "count": true }
  }
}
```

`labels` is a many-to-many member and `{ count: true }` is the shape that
answers "how many" without loading the rows — a number on the loaded
row, not an array. The include's `where` and `orderBy` are captured over
the TARGET (`p` is a `Post`), which is the one thing about `include`
that a reader coming from the chain has to re-learn.

### 3.2 The root clauses, and the keyset cursor

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
const Post = m.object({
  pid: m.integer().identity('auto'),
  title: m.string(),
  stars: m.integer(),
  authorId: m.string(),
  author: m.rel.hasOne('User', { via: 'authorId', onDelete: 'cascade' }),
  comments: m.rel.hasMany('Comment', { via: 'postId', onDelete: 'cascade' }),
});
const Comment = m.object({ cid: m.integer().identity('auto'), text: m.string(), postId: m.integer() });
const Label = m.object({ name: m.string().key() });
const entities = { User, Post, Comment, Label };
const client = await open(m.defineModel({ entities }), { driver: nodeDriver() });

// the root clauses: two where()s conjoin under one $and, orderBy is a bare key
// ascending, and after() is the keyset cursor the store pages on
export const graph = client.entities.Post
  .include((p) => p.author, { include: { labels: true } })
  .include((p) => p.comments, { count: true })
  .where((p) => p.stars.ge(1))
  .where((p) => p.title.ne('none'))
  .orderBy((p) => p.pid)
  .take(2)
  .after(1)
  .maxDepth(4);
```
```json
{
  "where": { "$and": [{ "$ge": ["$it.stars", 1] }, { "$ne": ["$it.title", "none"] }] },
  "orderBy": "$it.pid",
  "take": 2,
  "after": 1,
  "maxDepth": 4,
  "include": { "author": { "include": { "labels": true } }, "comments": { "count": true } }
}
```

Three facts the fence carries that a sentence would only assert. The
member order is the spec's, not the call order — `include` was called
first and is written last. Two `where`s became one `$and` rather than
two members, because a spec has one `where`. And `include: { labels:
true }` under `author` resolved against **`User`**'s relation table, not
`Post`'s: a nested include walks the TARGET's relations, which the graph
finds through the provider scope every root of one store shares.
`explain().pagination` for this graph is `"keyset"`; drop the `after`
and add a `skip` and it is `"offset"`.

### 3.3 Every ordering spelling

```js
import { open } from '@jarenjs/linq/db';
import * as m from '@jarenjs/linq/model';
import { nodeDriver } from '@jarenjs/db/node';

const Post = m.object({
  pid: m.integer().identity('auto'),
  title: m.string(),
  stars: m.integer(),
  comments: m.rel.hasMany('Comment', { via: 'postId', onDelete: 'cascade' }),
});
const Comment = m.object({ cid: m.integer().identity('auto'), text: m.string(), postId: m.integer() });
const client = await open(m.defineModel({ entities: { Post, Comment } }), { driver: nodeDriver() });

// a bare key is ascending; anything more is the $orderby spec the chain writes;
// an include's own orderBy takes the same spellings, and an array of them
export const graph = client.entities.Post
  .include((p) => p.comments, { orderBy: [(c) => c.postId, { key: (c) => c.text, desc: true }], skip: 1, take: 5 })
  .orderByDescending((p) => p.stars)
  .thenBy((p) => p.title, { empty: 'greatest' })
  .thenByDescending((p) => p.pid)
  .skip(1)
  .take(2);
```
```json
{
  "orderBy": [
    { "$key": "$it.stars", "$dir": "desc" },
    { "$key": "$it.title", "$empty": "greatest" },
    { "$key": "$it.pid", "$dir": "desc" }
  ],
  "take": 2,
  "skip": 1,
  "include": {
    "comments": {
      "orderBy": ["$it.postId", { "$key": "$it.text", "$dir": "desc" }],
      "take": 5,
      "skip": 1
    }
  }
}
```

One term is written as the bare key and the rest as `{ $key, … }`,
because the spec form is what carries a direction, an empty-ordering or
a collation and the bare form is what a plain ascending key needs. The
rule is mechanical: a term with nothing but a key IS the key. Note the
second term — `thenBy(key, { empty: 'greatest' })` — carries `$empty`
and no `$dir`, since ascending is the default and §1.1's no-defaults
rule is the chain's too.

### 3.4 A bracketed pick, a two-level include, and `asNoTracking()`

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
const Post = m.object({
  pid: m.integer().identity('auto'),
  title: m.string(),
  stars: m.integer(),
  authorId: m.string(),
  author: m.rel.hasOne('User', { via: 'authorId', onDelete: 'cascade' }),
  comments: m.rel.hasMany('Comment', { via: 'postId', onDelete: 'cascade' }),
});
const Comment = m.object({ cid: m.integer().identity('auto'), text: m.string(), postId: m.integer() });
const Label = m.object({ name: m.string().key() });
const entities = { User, Post, Comment, Label };
const client = await open(m.defineModel({ entities }), { driver: nodeDriver() });

// a member picked by its bracketed name (u.get('labels')), a two-level include
// over the TARGET's relation table, and asNoTracking() — which changes the load,
// never the document
export const graph = client.entities.User
  .include((u) => u.get('labels'))
  .include((u) => u.posts, { include: { comments: { where: (c) => c.text.ne(''), take: 3 } } })
  .asNoTracking();
```
```json
{
  "include": {
    "labels": true,
    "posts": { "include": { "comments": { "where": { "$ne": ["$it.text", ""] }, "take": 3 } } }
  }
}
```

`u.get('labels')` and `u.labels` capture the same member. The bracketed
spelling exists for a member whose name collides with a method of the
recording proxy — `at`, `get`, `all`, `count` and their kin — where the
plain read would answer the proxy's function instead of recording a
path. A model that names a relation `count` needs `u.get('count')`, and
nothing else about it changes.

`asNoTracking()` is absent from the emitted spec, and that is correct:
it selects `set.asNoTracking().load(spec)` over `set.load(spec)`, which
is a choice about the unit of work rather than about the query. Two
graphs that differ only in it are one document.

## 4. Refusals

The client raises these two `LinqBuildError` codes and no others —
`test/linq/pen-docs.test.js` holds this list equal, in both directions,
to the codes `packages/linq/src/db/` names. The full condition each code
states across every pen is the binder's,
[LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3.

| Code | What this pen raises it for |
|---|---|
| `JL0101` | a value the client cannot put in a specification: a clause that is not a callback, a spec member the vocabulary does not carry, or a value that is not JSON |
| `JL0107` | a member that is not the relation kind the operation needs |

Every message below is the one the client raised when the spelling beside
it was run, with the code prefix removed. None of them carries a
`docPath`: a load specification's positions are named in the message text
itself (`the include spec at posts.comments`), because a spec is not
assembled node by node the way a pen's document is.

Two codes the client does NOT raise, and a reader will meet both. `JL0004`
and `JL0005` are the chain's, and they reach a graph unchanged — a load
clause that binds an external is `JL0004` (`parameter 'x' is not
declared`), and a `thenBy()` with no `orderBy` before it is `JL0005`.
Everything the store's own vocabulary cannot carry is the store's
refusal, raised where the store raises it: `JD0032` for a spec the load
engine cannot translate, `JD2003` for a write or a membership target the
store rejects, `JD0050` for a live query on a store opened without
capture.

### 4.1 `JL0101` — the clause and the spec member

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `include('posts')` | `include() takes a callback over the row, got a string` | `include((u) => u.posts)` |
| `include((u) => u.posts, { wehre: 1 })` | `the include spec at posts does not take 'wehre' — the members are where, orderBy, take, skip, count, include` | `{ where: (p) => … }` |
| `include((u) => u.posts, { after: 1 })` | `the include spec at posts does not take 'after' — the members are where, orderBy, take, skip, count, include; a keyset cursor paginates the root: after() on the graph` | `.after(cursor)` on the graph |
| `include((u) => u.posts, 7)` | `the include spec at posts is true or { where?, orderBy?, take?, skip?, count?, include? }, got 7` | `true`, or a spec object |
| `include((u) => u.posts, { count: 1 })` | `the include spec at posts: count takes true` | `{ count: true }` |
| `include((u) => u.posts, { orderBy: 5 })` | `posts orderBy takes a key callback ((p) => p.stars) or { key, desc?, empty?, collation? }, got 5` | `{ orderBy: (p) => p.pid }` |
| `include((u) => u.posts, { include: 3 })` | `include at posts is a record of relation members, got 3` | `{ include: { comments: true } }` |
| `include((u) => u.posts, { take: new Date(0) })` | `posts take received a Date instance, which is not JSON — a document carries null, booleans, finite numbers (never -0), strings, arrays and plain objects, and nothing else` | `{ take: 2 }` |
| `.orderBy(5)`, `.thenBy(5)`, `.thenByDescending(5)`, `.where(5)` | `orderBy() takes a callback over the row, got 5` | a callback |

Rows two, three and four are one rule seen three ways, and they are held
to each other: the member list the shape message shows is DERIVED from
the same constant the member check reads, so the two cannot disagree.
They did — the message named `after?` while the check refused `after` by
name — and `test/linq/client.test.js` now reads the members out of the
message and asserts the spec accepts every one of them, which is the
check that would have caught it.

### 4.2 `JL0107` — the relation kind

`JL0107` is the client's own code — no pen raises it — and it has exactly
two conditions, one per operation that reads the relation table.

**`include()` picks a declared relation member.** The pick is captured to
a member PATH and looked up; a scalar member, a name the model does not
declare, or a callback that is not a bare member read is refused naming
what the entity does declare.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `client.entities.User.include((u) => u.email)` | `'email' is not a relation member of 'User' — include() loads a declared relation ('posts', 'labels')` | `include((u) => u.posts)` |
| `client.entities.User.include((u) => u.nope)` | `'nope' is not a relation member of 'User' — include() loads a declared relation ('posts', 'labels')` | a declared relation |
| `client.entities.User.include((u) => u.age.ge(1))` | `include() picks one relation member of 'User' by name ((u) => u.posts); got an operator result` | a bare member read |
| `include((u) => u.posts, { include: { nope: true } })` | `'nope' is not a relation member of 'Post' — a nested include loads a declared relation ('author', 'comments')` | a relation of the TARGET |

The last row names `Post`'s relations rather than `User`'s, which is the
whole point of resolving a nested include against the target's table: a
reader who mistyped a member is shown the members that exist where they
mistyped it.

**`link()` and `unlink()` attach many-to-many memberships only.** The
member must be a `manyToMany` relation of the entity; anything else is
refused naming the kind it actually is, or the many-to-many members the
entity does declare.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `client.entities.User.link('u1', 'posts', 1)` | `'posts' is a oneToMany relation of 'User' — link() attaches many-to-many memberships only; write the related entity's foreign key instead` | `post.authorId = 'u1'` and `put()` |
| `client.entities.Post.link(1, 'author', 'u1')` | `'author' is a oneToOne relation of 'Post' — link() attaches many-to-many memberships only; write the related entity's foreign key instead` | write the foreign key |
| `client.entities.User.unlink('u1', 'email', 'x')` | `'email' is not a relation member of 'User' — unlink() attaches a many-to-many membership ('labels')` | `unlink('u1', 'labels', 'admin')` |
| `client.entities.Comment.link(1, 'nope', 'x')` | `'nope' is not a relation member of 'Comment' — link() attaches a many-to-many membership, and 'Comment' declares none` | declare a `belongsToMany` |

The two messages differ in what they can name. When the member exists,
the client knows its kind and says it; when it does not, the client lists
the many-to-many members the entity has — or says plainly that it has
none, which is the case where a caller is looking for a feature the model
never declared.

The store would refuse the same members itself (`JD2003`, MODEL-FORMAT
§11.7); the client sees it earlier, from a table it already reads, and
the check is mirrored rather than invented. What stays the store's is
everything about the TARGET: a document with no key, and an own side
whose `auto` key the save has not allocated yet (`JD2003`: "save the
entity first, then attach").

## 5. The types

The client is typed from the model pen's phantom with no cast and no
generate step. `open()` reads `InferMeta<>` off a pen model; a JSON
literal is never inferred, so a bare JSON model opens the honest wide map
and a caller who has a generated map names it. The model below is §3's —
the blog — and every line is a reading of it.

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

### 5.1 `NoInfer` is what keeps a spec's callbacks typed

`include<K, const I extends IncludeSpec<…> = true>(pick, spec?: I |
NoInfer<IncludeSpec<…>>)` looks redundant and is not. `I` has to be
inferred from the spec LITERAL, because `Loaded<>` reads it to widen the
row; the callbacks inside that literal have to be contextually typed from
`IncludeSpec`, because `(p) => p.stars.ge(3)` has no annotation. Without
the `NoInfer` arm TypeScript fixes `I` to its default before it types
them, and `p` arrives as `any` — which compiles, and silently stops
catching the mistake the pin's third negative is about (`{ where: (p) =>
p.email.eq('x') }` over a target that has no `email`).

### 5.2 The auto key is in `required`, and the exemption is the store's

`identity('auto')` emits `{ key: true, default: 'auto' }` and the member
stays in the entity schema's `required`, because the model pen writes the
schema of a STORED document. The write-time exemption is the store's
(MODEL-FORMAT §9.6), and the types say the same from the other side:
`generated` makes the member optional on `EntityInput` and required on
`EntityDoc`. `create({ title, stars, authorId })` therefore type-checks
with no `pid`, and every row that comes back has one. Spelling it
`optional()` in the model to "fix" the emission would make the READ shape
wrong — see [MODEL-PEN.md](MODEL-PEN.md) §5.

### 5.3 Two `include` behaviours a reader meets at run time otherwise

- **An include that is `skip`ped still renders.** `skip` is an include's
  own member and the store runs it inside the subquery, so
  `include((u) => u.posts, { skip: 1, take: 2 })` emits `{ take: 2, skip:
  1 }` and loads the second and third rows. Empty is not absent either: a
  `true` include that matched nothing renders `[]` and a `{ count: true }`
  one renders `0`, so a `??` guard on an included member is dead code and
  the widened type (`posts: Post[]`, `labels: number`) is honest.
- **An include that arrives `after` is refused.** `after` is the one
  window member an include does NOT take: a keyset cursor pages the root
  and only the root, because the cursor is a key of the root entity and
  there is one root per load. `{ after: 1 }` inside a spec is `JL0101`
  naming the graph's own `after()` (§4.1); `.after(cursor)` on the graph
  is the spelling that works, and the graph's `after` is typed by the
  declared ordering — the continuation a `page()` over the same
  `orderBy`/`thenBy` chain emitted, its `keys` tuple following the
  ordering and its `key` the row's primary key — so a bare key, or a
  continuation with the wrong number of values, does not compile.

### 5.4 What the pin holds

`test/consumer/linq-db.ts`, compiled by `npm run test:types`, proves over
the model corpus: `open()` inferring `Client<Meta, {}>` from a pen model;
the chain over a handle typed by the entity document, including a join
between two handles; `include` widening the loaded rows by exactly what
it included, two levels deep and through `asNoTracking()`; membership
typed over the many-to-many members with the target as its key or its
document; `live` rows typed by the chain's item; the pass-throughs and
the escape hatch; the wide map and the named map; and a collection handle
typed from the pen's collection schema.

Nine negatives sit beside them, each of which FAILS the build the day it
starts compiling:

```ts
void client.entities.Post.where((p) => p.strs.ge(3));        // a misspelled member
void client.entities.User.include((u) => u.email);           // not a relation member
void client.entities.User.include((u) => u.posts, { where: (p) => p.email.eq('x') });  // the target's shape
void client.entities.Post.include((p) => p.author, { include: { nope: true } });       // the target's relations
void client.entities.Post.include((p) => p.author).after('one');  // the cursor is the ordering's continuation, never a bare key
client.entities.User.link('u1', 'posts', 1);                 // oneToMany is not a membership
client.entities.Post.link(1, 'author', 'u1');                // oneToOne is not a membership
client.entities.User.link('u1', 'labels', 42);               // the target's key type
void places.saveChanges;                                     // a collections-only model has no unit of work
void named.entities.Nope;                                    // the named map declares no such entity
```

The honest limits, stated where a reader will look for them:
`where`/`orderBy` inside an include are typed over the target entity but
checked for TRANSLATABILITY by the store, not by TypeScript, so
`c.text.length().gt(1)` compiles and is `JD0032` at `explain()`; a `link`
target is typed as the target's key or document and the store's own
reading of it still applies (`JD2003` for a document carrying no key);
and a JSON model opened without a named map is the wide map, where every
name exists at the type level and an unknown one is `undefined` at run
time.

## 6. What it cannot spell

The client writes no document of its own, so it has no construct set to
refuse as unspellable and raises no `JL0102`. This section is therefore
about something else: what the client deliberately does not do, where the
edges of what it can express actually are, and — in §6.1 — when the
honest answer is to open the store some other way.

**It is not a second engine.** The store's planner, its unit of work, its
translator and its live maintenance are `@jarenjs/db`'s, and nothing here
reimplements one. `include` emits a specification and hands it over;
`link` records through the store's own membership API;`live` calls the
store's registration. The consequence a reader should expect is that a
verdict about a query — is it translatable, is it one statement, is it
incremental — comes from `explain()` and never from this document.

**A join across two different sources is not expressible.** Two entity
sets of one store join in one document, because they share a provider
scope; a join between two STORES, or between a store and an array, would
need one query document with two inputs and there is no such document.
Three or more bindings the entity translator names a residual. Both are
on [docs/ROADMAP.md](../../../docs/ROADMAP.md) under `@jarenjs/linq &
@jarenjs/db`, "Cross-source linq joins beyond one store".

**A many-to-many join table is not a queryable root in this version.**
`u.labels` as a chain HOP is `JL0105` — the join table has no root to
bind, so there is no phrase to lower to — and the way to read a
membership is `include`: `client.entities.User.include((u) => u.labels)`
loads the rows and `{ count: true }` counts them. A question ABOUT the
membership ("which pairs were attached since Friday") is reachable only
by loading and then asking in JavaScript. The change that closes all of
it is one change, on [docs/ROADMAP.md](../../../docs/ROADMAP.md) under
`@jarenjs/linq & @jarenjs/db`, "Join tables are not queryable roots".

**A chain split by a host callback has no document to register.**
`mapAsync` runs a JavaScript function per row, so the chain after it is
not one query document; `live()` over such a chain is the chain's own
`JL0005` naming the operator that split it. Register the part before the
split, or write the document by hand.

**The client is not the place a model is authored.** `open()` takes a
`$model` document, from [MODEL-PEN.md](MODEL-PEN.md) or from JSON, and
never builds one; the migration between two of them is
[MIGRATION-PEN.md](MIGRATION-PEN.md)'s.

### 6.1 When not to reach for this door

- **You want the store, not the types.** `openStore` from `@jarenjs/db`
  is the same store with untyped handles, and it is what a program that
  reads its model from JSON at boot already has. This subpath's whole
  value is the phantoms; where there is no model constant to read them
  off, there is nothing to buy. §7 is what the difference costs.
- **The model is not the model pen's.** `InferMeta<>` reads a model-pen
  document's phantoms. A `$model` parsed from a file carries no phantom, so
  `InferMeta<>` over it is the honest wide map, the handles come back
  untyped, and the door is `openStore` with a generated map named
  explicitly (§5) — or a model-pen constant the parsed document is
  checked against.
- **The question is about the plan, not the rows.** `explain()` answers
  whether a chain translates, in how many statements, and what stayed
  residual. Read it there. Nothing in this document decides it, and a
  spelling change made to please a sentence here rather than an
  `explain()` output is a guess.
- **The read is one statement of SQL you already know.** The store takes
  raw statements; a reporting query with three joins and a window
  function is a statement, not a chain, and pretending otherwise costs a
  residual nobody sees until it is slow.
- **The relation is a membership you want to interrogate.** §6 says it
  above: a join table is not a queryable root, so a question about the
  pairs themselves is a load and then JavaScript. That is a real cost and
  it is worth knowing before the model is shaped around it.

## 7. Cost

`@jarenjs/linq/db` builds to **<!--fact:bundle.db-->588,547<!--/fact--> bytes** as a minified,
tree-shaken ESM bundle — the figure `scripts/check-tree-shaking.js`
measures and `npm run test:tree-shaking` reports, published rounded
(<!--fact:bundle.db.kb-->589<!--/fact--> kB) beside the other nine subpath prices in
[docs/CONSUMING.md](../../../docs/CONSUMING.md).

It is by far the largest of the ten, and the reason is §1.1's edge rather
than the client itself: the store, the validator and the formats ride by
construction, because they are what the client opens. The client's own
six modules are under 600 source lines. Taking `./db` means taking a SQL
planner, a unit of work, a live-maintenance engine and a JSON Schema
validator, and the honest way to read the figure is as the price of the
database, not of the front door.

What the probe asserts, and fails the build on:

- **all three peers ride** — `@jarenjs/db`, `@jarenjs/validate` and
  `@jarenjs/formats` each contribute bytes. This direction matters as
  much as the exclusions: a bundle that had shaken one of them away
  would mean the client had stopped opening a real store;
- **no other pen** — not the contract, flow, app or forms pens, and no
  `@jarenjs/emit` or `@jarenjs/refs` byte;
- **the edge is droppable everywhere else** — the `.` entry (the chain,
  priced in [QUERY-PEN.md](QUERY-PEN.md) §17) carries no module of
  `packages/linq/src/db/` and not one byte of the three peers, which is
  the tree-shaken proof that a consumer of the chain or of any pen
  installs nothing new. The same probe run over each pen's own bundle
  asserts the same exclusion.

A consumer who wants the model pen's types without the store pays
`./model`'s <!--fact:bundle.model-->41,582<!--/fact--> bytes and installs no peer; one who wants to run
queries against an array rather than a database pays the chain's price
(§17 of [QUERY-PEN.md](QUERY-PEN.md)) and installs no peer. `./db` is
the one subpath whose `package.json` entry carries an optional peer at
all.

### 7.1 What the door costs at run time, measured

`benchmark/orm.js` runs the client as one more route in every table
beside Prisma, Drizzle and Kysely over the same SQLite corpus, equality
asserted before anything is timed and statement counts printed beside
the timings.

Against the store it fronts, the door is nearly free: <!--fact:orm.clientDoorPrice-->1.0× on a point read, 1.0× on an indexed predicate at 10 % selectivity, 1.1× on the two-level graph load<!--/fact-->
— because it issues the same documents the store would. What it does
NOT amortize is capture: a chain re-captures its callbacks and re-emits
its document on **every** call, by design, which is the predicate row's
difference and which a caller with a hot query removes by holding the
`Sequence` (or the emitted document) instead of rebuilding it.

Against the rivals, at this corpus, it is faster on <!--fact:orm.clientVsRivals-->8 of 9 against Prisma, 4 of 9 against Drizzle, 1 of 9 against Kysely<!--/fact-->,
and here is every row where the *fastest* rival beats it — <!--fact:orm.clientLosses-->update one column by primary key 13.1× (Drizzle), nested json member filter 5.8× (Kysely), cold start 3.4× (Prisma), graph load 2.8× (Kysely), posts per user 2.4× (Kysely), indexed predicate over 500 users, ids only 1.7× (Kysely), insert 1.6× (Kysely), pagination over 5000 comments, page size 20 1.6× (Kysely), point read by primary key 1.4× (Drizzle)<!--/fact-->.

Three things make that list readable rather than damning, and none of
them removes a row from it. **Kysely is a SQL builder**: on every row it
wins, you wrote the SQL — the comparison it belongs in is against a
hand-written statement, not against a schema-first ORM. **The update row
is the widest loss and has one cause**: the client's only write door is
the unit of work (`get`, mutate, `saveChanges`), where a rival issues one
prepared `UPDATE`; the store's own `update()` sits in the same table so
the difference is visible rather than argued. And **the claim that
survives is structural, not temporal** — the graph load's statement
counts are printed beside its timings, and the client answers a
two-level graph in ONE statement where the schema-first ORM takes three,
whatever the corpus and whatever the clock says.
