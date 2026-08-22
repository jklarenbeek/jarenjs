---
package: "@jarenjs/db"
card:
  title: Data — documents in SQLite
  blurb: >-
    Documents AND entities in SQLite behind driver and dialect seams: a
    pushdown planner that renders guarded parameter-bound SQL, one-statement
    graph loads, a copy-on-write unit of work with optimistic concurrency,
    generated entity types, and a jaren-db CLI whose migrations rebuild
    tables the documented twelve-step way.
  perf: >-
    the two-level graph load runs in ONE statement; statement counts
    published beside every timing
engines:
  - key: db
    suite: orm
    title: Data
---

A model document declares collections (a JSON Schema, a key declaration,
indexes over singular JSONPaths); `openStore` applies the physical mapping
through a dialect and gives transactional, schema-validated reads and writes on
Node, Bun, or an injected wasm build. Queries push down to guarded,
parameter-bound SQL where equivalence is proven — a 418-run differential oracle
keeps the pushed path and the engine agreeing — and `explain()` always names
the SQL, the indexes and the residual reasons.

A store can also open with an operator registry — `openStore`(model, {
operators: `createJsltRegistry()`.use(`mathPack`)… }) — and registered
operators (`$npv`, `$mean`, `$sqrt`) then work in query and entity documents.
They run correctly in the query residual, `explain()` names them, and the
pushable-scalar (math) subset is pushed into SQLite as deterministic UDFs where
the driver supports them (node yes; bun has no UDF API and stays the residual,
reported by capabilities.pushableOperators). The Data studio mounts them — run
{ "`$sqrt`": "`$it`.points" } in a where and watch `explain()` show the
`jaren_p_` UDF.

```js
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const store = await openStore(model, { driver: nodeDriver(), path: 'app.db' });
const users = store.collection('users');
await users.insert({ id: 'u1', email: 'ada@example.test', age: 36 });
const plan = await users.explain({
  $for: { it: '$[*]' }, $where: { $ge: ['$it.age', 21] }, $return: '$it',
});
// plan.sql, plan.indexes, plan.residual, plan.scanNarrative
```

Phase B makes it an ORM: entities declare keys, typed columns, relations and an
optimistic-concurrency token with the `x-entity` vocabulary INSIDE their JSON
Schema; a graph loads with its children in exactly ONE statement (asserted by a
counting driver, not promised); the unit of work diffs frozen snapshots into
minimal parameterised writes inside one transaction; and `jaren-db` plans,
checks and applies migrations from the command line, with drift detection for
CI.

```js
const store = await openStore(entityModel, { driver: nodeDriver(), path: 'app.db' });
const users = store.entity('User');

// one statement, two levels, filters INSIDE the subquery
const graph = await users.load({
  where: { $gt: ['$it.age', 21] },
  include: { posts: { orderBy: { $key: '$it.stars', $dir: 'desc' }, take: 3,
    include: { comments: true } } },
});

// the unit of work: frozen reads, replacement writes, one transaction
const ada = await users.get('u1');
users.put({ ...ada, age: 37 });
const report = await store.saveChanges();
// report.statements, report.fallbacks, report.concurrency
```

Generated types close the loop: `entityEmitModel` renders the same model
document into entity interfaces, input variants and an `EntityMetaMap`;
typedStore<`EntityMetaMap`>(store) then types every read, checks every write,
and widens load results by their include specification — u.age.gt(21) compiles,
u.age.gt("x") does not, and an omitted include means the member is not there.

Migrations are documents too: `planModelMigration` diffs two models into
rendered DDL, data steps and the twelve-step table rebuild (`foreign_key_check`
inside the transaction); the whole chain replays on a shadow database first; a
checksummed history refuses edited or reordered migrations; and after every
relational migration the schema must EQUAL what a fresh build of the target
model produces.

> **SQLite only, said plainly** — The dialect seam is real and tested against a
> double, but SQLite (3.45+) is the one shipped backend. There is no statement
> timeout on these drivers — the capability slot is honestly false — and the
> safe profile composes what CAN be bounded: engine limits, a mandatory row
> bound that refuses rather than truncates, allow-lists, and per-collection
> mandatory predicates no document shape can shed. The live in-browser store is
> phase C; the examples here are Node examples, and the ORM benchmark page
> publishes the Prisma/Drizzle/Kysely numbers with every loss and its reason.

**Try it.** [The Data studio](#/data) runs a store in your browser on a lazily
loaded sqlite-wasm build: edit the model, insert documents, run a query and
read the plan `explain()` produced for it.
