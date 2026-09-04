# @jarenjs/db

Documents AND entities in SQLite. A **model document** declares
collections (a JSON Schema, a key, indexes) and — since phase B —
**entities**: keys, typed columns, relations, defaults and an
optimistic-concurrency token, all inside the schema through the
`x-entity` vocabulary. `openStore` applies the physical mapping
through a dialect and gives transactional, schema-validated reads and
writes; queries arrive as plain Jaren query documents (usually
written through `@jarenjs/linq`) and are **pushed down to SQL** where
equivalence is proven, with everything else running honestly in the
engine. The same code runs on Node, on Bun, and in a browser against
an injected wasm handle, with zero dependencies outside `@jarenjs/*`.

**The honest framing, first**: Prisma, Drizzle and Kysely are mature,
support several databases, and are faster on some benchmark rows —
those losses are published on the suite page with their reasons. What
none of them has is a query that is one serializable JSON document,
executable by two independent engines proven to agree by a
differential oracle, running unchanged in Node, Bun and the browser,
with schema-validated writes from the fastest validator in the
ecosystem. The composition is the product; the individual numbers are
what they are.

```js
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const store = await openStore({
  $model: '0.1',
  collections: {
    users: {
      schema: {
        type: 'object',
        required: ['id', 'email'],
        properties: {
          id: { type: 'string' },
          email: { type: 'string', format: 'email' },
          age: { type: 'integer' },
        },
      },
      key: '/id',
      indexes: [{ name: 'by_age', path: '$.age' }],
    },
  },
}, { driver: nodeDriver(), path: 'app.db' });

const users = store.collection('users');
await users.insert({ id: 'u1', email: 'ada@example.test', age: 36 });

// a query document — here written by hand; linq writes the same one,
// its source wrapped as ['$[*]'] so an item that is an array stays one item
const adults = await users.execute({
  $for: { it: '$[*]' },
  $where: { $ge: ['$it.age', 21] },
  $return: '$it',
});
```

Or, by code — the same document, written by the model pen
([MODEL-PEN.md](../linq/docs/MODEL-PEN.md)) and typed without a generate
step (`InferMeta<typeof model>` binds the typed store):

```js
import * as m from '@jarenjs/linq/model';

const model = m.defineModel({
  collections: {
    users: m.collection(
      m.object({ id: m.string(), email: m.string().email(), age: m.integer().optional() }).open(),
      { key: (u) => u.id, indexes: [m.index((u) => u.age)] },
    ),
  },
});
const store = await openStore(model, { driver: nodeDriver(), path: 'app.db' });
```

Over an entities model, an entity set is a provider too (MODEL-FORMAT
§10.1): a chain binds through the set's root and the store runs the
document whole — the translator for a bare-binding selection or
equijoin, the declared residual for a projection — while the store
itself, serving several roots, is refused by name (`JL0007`):

```js
import { from, fromAsync } from '@jarenjs/linq';

const starred = from(store.sync.entity('Post')).where((p) => p.stars.ge(3));
starred.toDocument();   // { $for: { it: '$.Post[*]' }, $where: { $ge: ['$it.stars', 3] }, $return: '$it' }
starred.toArray();      // the entity translator, one statement
await fromAsync(store.entity('Post'))
  .join(fromAsync(store.entity('User')), (p) => p.authorId, (u) => u.id, (p) => p)
  .toArray();           // a two-root equijoin, one statement
```

A declared relation navigates on the chain, and the document still
carries no relation name: the chain reads the set's relation table
(`store.entity('Post').relations`, MODEL-FORMAT §10.1) and lowers
`p.author.email` to the correlated phrase the engine and the store both
run. The store answers it as the residual it is — `explain()` says so,
`strict` refuses it — over the two fetched roots, never a statement per
row:

```js
const byAuthor = from(store.sync.entity('Post'))
  .where((p) => p.stars.ge(3))
  .select((p) => ({ title: p.title, by: p.author.email }));

byAuthor.toDocument();
// { $for: { it: '$.Post[*]' },
//   $where: { $ge: ['$it.stars', 3] },
//   $return: { title: '$it.title',
//              by: { $for: { r1: '$.User[*]' },
//                    $where: { $eq: ['$r1.id', '$it.authorId'] },
//                    $return: '$r1.email' } } }
byAuthor.explain().hops;   // [{ member: 'author', kind: 'oneToOne', binding: 'r1' }]
store.sync.explain(byAuthor.toDocument());
// { mode: 'set', referenced: ['Post', 'User'], sql: null,
//   reasons: [{ construct: '$return',
//               reason: 'entity queries return one bare binding natively; projections run in the engine' }], … }
byAuthor.toArray();        // the rows, two fetches — one per referenced root

from(store.sync.entity('User')).where((u) => u.posts.all().count().ge(2));
// … $where: { $ge: [{ $count: { $for: { r1: '$.Post[*]' },
//                                $where: { $eq: ['$r1.authorId', '$it.id'] },
//                                $return: '$r1' } }, 2] } …
```

A many-to-many member (`u.labels`) is refused at build time (`JL0105`)
naming the join table: it is not a queryable root in this version, so
`load({ include: { labels: true } })` is how the memberships are read.

`execute` answers in the ENGINE's result shape (QUERY-FORMAT §1,
"singleton ≡ item"): `undefined` for no rows, the document itself for
exactly one, an array for more — typed `SequenceResult<R>`, with `R`
stated per call (`users.execute<User>(…)`) because only the caller
knows what its `$return` produces. `query()` answers the same document
as an item cursor (`for await`), one item per pull and never unwrapped —
the read to use when an item may itself be an array. The handle's own
shape binds at `store.collection<User>('users')`. An entity set answers
the same cursor as `cursor(document, options)`: one row per pull from
an open statement, the statement released exactly once when the loop
breaks, throws, finishes or its `signal` aborts (`JD2072` on the next
pull). Every cursor says what it will do — `streaming: 'row'`, or
`'buffered'` with the `barrier` that forces it (a set residual's
construct, an external the database cannot bind, a chain's window) —
and a linq chain's `for await` over a set IS this cursor, so a
`break` after three rows of twenty thousand costs three rows. A cursor
registers no snapshots unless asked (`tracking: true`, one per yielded
row — unbounded in the result size, by the caller's choice). A graph
streams the same way: `loadCursor(spec)` yields one root with its
includes attached, and every include is bounded per root (`maxRows`,
`maxBytes`, defaults 1000 rows and 1 MiB; `Infinity` spelled for the
unbounded case) — crossing a bound is `JD2073` naming the root, the
member and the bound, never a silently truncated graph. A list pages
over a composite keyset — `entity.page(spec, { limit, after, maxBytes })`
with `orderBy` over `(updatedAt, id)`-shaped orderings, the primary
key appended as the tie-breaker and null placement matching the plan —
and answers `{ items, continuation, hasMore, snapshot }`: the
continuation is unsigned and structural (the host signs it), an item
larger than `maxBytes` is `JD2074` without advancing it, and
`snapshot` is true only over an immutable ordering; over a mutable one
the page is live and says so (MODEL-FORMAT §10.5). `explainLoad()`
reports both facts separately: `order` is the deterministic order the
statement executes under in EVERY load mode — the declared terms and the
tie-breaker the clause appends, the primary key in keyset mode and the
row identity otherwise — and `identity` is the ordering identity a
continuation carries and is checked against, `null` for a load that has
no continuation to emit.

- **The pushdown planner with `explain()`.** A query compiles through
  the engine's published AST into a dialect-neutral plan and renders
  to guarded, parameter-bound SQL; whatever cannot be proven
  equivalent runs as a real compiled Jaren query (the residual), and
  `explain()` always says which is which — the SQL, the bound
  parameters, the indexes used (verified against the database's own
  plan output), and the residual's named reasons. It answers for the
  RUN it describes: given the externals `execute` is given, a value the
  database cannot bind (a boolean, a null, a missing name) is reported
  as the set residual the call becomes — mode, statement and reason —
  and counted in `stats().bind.diverted`, so a production diversion is
  visible where nobody calls `explain()`. Every explanation carries
  `streaming` (`'row'` or `'buffered'`) and `barrier` (the construct
  that forces a buffer, or `null`), the same classification the cursor
  itself carries; `strictStreaming: true` on a cursor declines a
  buffering plan by name (`JD0037`) before any statement runs. Every
  explanation also carries `order`: the deterministic order the
  statement executes under, in one closed vocabulary — a mapped
  `column`, a `document` path, a bucketed plan's `group` key, or the
  row `identity` the plan appends so a sequence answers in insertion
  order — read from the plan rather than parsed back out of SQL, and
  `null` only for a statement that orders nothing at all (an aggregate
  answers one row; a k-nearest fetch is unordered because the engine
  ranks it). Each refusal reason is drawn from a closed vocabulary too,
  so a reason a caller matched on stays the sentence it was. A
  `$return` that is ONE member path over the binding projects that
  path into the statement — its value beside its JSON type, so a
  present `null`, an absent member and a boolean read back exactly as
  the engine answers them — and `$count` over it counts the rows where
  the member is present with a `COUNT(*)`. A `$return` that is a nested
  SHAPE — objects, arrays, literals and member paths, to any depth —
  projects the same way: the statement fetches one value/type pair per
  DISTINCT leaf (a path named twice is fetched once) and the decoder
  rebuilds the shape, so an absent member is omitted from its object
  and skipped in its array exactly as the engine does it, and a literal
  `null` stays present where a path that finds nothing does not.
  `explain().projection` names the path or the leaf `paths`, and
  reading a shape no longer reads every document. A shape the tree
  cannot rebuild — an operator over a member, a reference to the
  binding itself, a projection with no path at all — refuses WHOLE and
  runs per row, with `explain().residualProjection` naming what stayed
  behind: promoting the half that composes would answer a shape nobody
  asked for. Every `explain()` also carries `budget`: the profile
  that applied, every bound it imposed, and the two driver slots
  (`time`, `estimatedRows`) reported `unavailable` on SQLite rather
  than estimated (MODEL-FORMAT §8). A differential
  oracle — a committed corpus and a seeded generator, every case run
  resident, native, native again over a store with every declared index
  removed, and forced-residual — keeps every path agreeing, with the one
  arithmetic deviation declared rather than hidden (MODEL-FORMAT §10.6: SQLite's
  compensated `SUM` and the engine's naive one differ in the last
  bit). `strict: true` turns any residual into a compile error.
- **Registered operators, correct in the residual, pushed where it
  pays.** Open with a registry (`operators:
  createJsltRegistry().use(mathPack).use(financePack)`) and a query may
  use `$npv`, `$mean`, `$sqrt`, … over stored documents. Each runs
  correctly in the residual — identical to the in-memory engine,
  `explain()` names it. The `pushable:'scalar'` subset (the math ops) is
  additionally accelerated into SQLite as **deterministic UDFs** where
  the driver allows (node:sqlite yes; bun:sqlite has no UDF API and stays
  the residual — reported by `capabilities.pushableOperators`). Pushdown
  is a large win beside a selective native predicate or a `LIMIT` (3.9×,
  615× measured) and a wash on a solo full-table computed predicate —
  published honestly in MODEL-FORMAT §8.2, not gated behind a cost model
  SQLite gives no row estimates to build. A first-class operator is
  allowed under a profile by default (which also blocks host-side UDF
  registration for untrusted documents); the profile's `functions`
  allow-list still governs a `$call`-reached `fn`; the row bound still
  fires. Without a registry the store is unchanged — `$npv` is `JQ0002`.
  A pack may also mark a whole-sequence summary `pushable: 'aggregate'`
  (the statistics pack's `$mean`, `$median`, `$variance`, `$stddev`):
  where the driver has an aggregate API it becomes a registered **SQL
  aggregate** over the member's column, folded by the same pure
  function, so the accumulation runs in SQLite rather than over fetched
  rows. The token is a promise the store checks — one `seq<number>`
  operand and a scalar result, or the declaration is refused at
  `openStore` by name — and the promotion still needs a numeric member
  the schema forbids `null` on, because SQL cannot tell a stored `null`
  from an absent one and the engine can.
- **Grouping and joins lower whole, or not at all.** A `$groupby` over
  schema-typed member keys becomes a real `GROUP BY`: the keys come back
  with their JSON types beside them, so a group whose key is ABSENT
  leaves that member out exactly as the object constructor does, the
  closed aggregate set (`$count`, `$sum`, `$avg`, `$min`, `$max`) folds
  in SQL under the ENGINE's empty rules (`0` for a count or a sum, no
  member at all for the other three), and the groups come out in the
  engine's own order of first appearance unless an `$orderby` over the
  keys says otherwise. Entity queries join any number of bindings: every
  binding past the first must be attached by a column equality to one
  already joined, which is what makes the plan a nested loop the engine
  can be compared against — a binding nothing attaches would be a
  cartesian product, so it is the residual, named, and `strict: true`
  refuses it. `explain()` lists the join order with the equalities that
  attached each binding, and the group's keys, aggregates and order.
  A join predicate that is not an equality — a range between two mapped
  columns of one family — refines a match it never makes: the anchor is
  still an equality, so a range alone stays the residual. A projected
  join lowers too, through the same leaf decoder a single-binding
  projection uses, each leaf read from its own binding's alias.
- **A declared join table is a read-only query root.** `$.<JoinTable>[*]`
  answers rows carrying exactly its two key columns and joins to the
  entities it relates, so `Person → Person_Tag → Tag` is one statement
  over three roots — while `store.entity('<JoinTable>')` is still
  `JD2004` and memberships are still written through `link`/`unlink`.
  Because the root exists, a many-to-many hop on the chain lowers
  through it (two links: the membership, then the row it names) instead
  of refusing.
- **Storage is declarative.** Indexed paths become generated columns
  plus real indexes, typed from the collection's schema. Opening an
  existing database verifies the declared shape and refuses to alter
  it — reshaping is the migration story.
- **Spatial members get indexable columns.** A position is an array and
  a geometry is an object, so neither is indexable as it stands. An
  index declaring `derive: 'geohash'` (with a required `precision`) or
  `derive: 'bbox'` materializes the cell, or the four box edges, as
  columns computed by `@jarenjs/core/geo` — a generated column over a
  registered deterministic function where the driver can index one, and
  a stored column the store writes where it cannot.
- **A spatial query is two stages, and `explain()` names both.** A
  `$within`, a `$bbox-intersects`, a bounded `$distance` or a geohash
  probe over such a collection narrows **in SQLite** through the index
  and refines **in the engine**. `$bbox-intersects` and a geohash cell
  test are exact and need no refinement; `$within` and a bounded
  `$distance` push a bounding box the truth table proves they imply,
  and the exact predicate re-runs over the narrowed candidates —
  `explain().prefilters` says which, over what columns, and whether it
  decided or merely narrowed. The worked example, the geofence and the
  measured numbers are in [Spatial storage](#spatial-storage--the-model-the-plan-the-fence-the-numbers)
  below.
- **A time series is a composite index, not a storage kind.** Declare
  `{ "path": ["$.series", "$.at"] }` over a numeric epoch member and the
  planner recognizes three shapes over it: a half-open range under a
  series equality, an as-of lookup (the index read backwards, one row),
  and a fixed-width bucket ladder — a `$groupby` over `$time-bucket`, or
  a `$resample` whose spec asks for nothing a `GROUP BY` cannot do — as
  integer arithmetic in SQL. A fill policy, a calendar width, a rolling
  window and an as-of JOIN are **named refinements**: the index bounds
  the fetch and `@jarenjs/core/series` decides, with `explain().series`
  carrying the reason code and the last run's actual candidate and
  result counts. See [Time series](#time-series--the-index-the-ladder-the-refinement).
- **Migrations are documents.** `planMigration` diffs two models into
  rendered-DDL + JSLT-transform + assertion steps; a shadow database
  replays the whole chain before the real store is touched; a
  checksummed history refuses edited or reordered migrations; a
  narrowing without an adequate transform is refused against the REAL
  data, inside the transaction. And by code: `@jarenjs/linq/migration`
  ([MIGRATION-PEN.md](../linq/docs/MIGRATION-PEN.md))
  writes the same document with the data transform typed old row → new
  row, `jaren-db` loads model and migration MODULES beside JSON, plans
  from the committed `model.snapshot.json`, refuses a module that is
  not pure, and `jaren-db check` fails CI on a model that moved without
  a plan (MIGRATION-FORMAT §11).
- **The safe profile.** Untrusted query documents run under composed
  bounds: engine limits on the residual, a mandatory row bound that
  refuses rather than truncates, reference allow-lists, optional
  full-scan refusal, per-collection mandatory predicates no document
  shape can shed, and a per-root MEMBER allow-list — the members a
  document may read, checked wherever it names one, where allowing a
  member allows what is under it and reading the item whole is refused
  rather than quietly narrowed. Read-only stores refuse writes at the
  driver.
- **Writes validate** through an injected hook; without one,
  `store.capabilities.validated` is `false` and the docs say what that
  costs. The public API is asynchronous (the browser's OPFS story
  forces it) with a promise-free `store.sync` twin where the driver is
  synchronous.

## Spatial storage — the model, the plan, the fence, the numbers

A collection stores GeoJSON as it is — a position is an array, a
geometry is an object, nothing is wrapped — and declares what to index
over it:

```js
const store = await openStore({
  $model: '0.1',
  collections: {
    places: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          // typed as geography: a spatial predicate is only pushed onto a
          // member the schema types as an array or an object and nothing else
          at: { type: ['array', 'object'] },
        },
      },
      key: '/id',
      indexes: [
        { name: 'by_box', path: '$.at', derive: 'bbox' },
        { name: 'by_cell', path: '$.at', derive: 'geohash', precision: 6 },
      ],
    },
  },
}, { driver: nodeDriver() });
```

`derive: 'bbox'` materializes the member's bounding box as four
columns and `derive: 'geohash'` its cell, both computed by
`@jarenjs/core/geo` — generated columns over registered deterministic
functions where the driver can index one, stored columns the store
writes where it cannot (MODEL-FORMAT §§2.1, 3). The query a consumer
writes then narrows in SQLite and refines in the engine, and
`explain()` says so:

```js
const places = store.collection('places');
const inside = {
  $for: { p: '$[*]' },
  $where: { $within: ['$p.at', '$region'] },
  $return: '$p',
};
await places.execute(inside, { externals: { region } });

const how = await places.explain(inside, { externals: { region } });
how.prefilters;
// [{ construct: '$within',
//    columns: ['gx_at_bbox_w', 'gx_at_bbox_e', 'gx_at_bbox_s', 'gx_at_bbox_n'],
//    exact: false }]
how.residual.reasons[0].reason;
// 'a bounding-box pre-filter is pushed; exact containment refines in the engine'
how.scanNarrative;
// 'SEARCH places USING INDEX places_by_box (gx_at_bbox_w>? AND gx_at_bbox_w<?); …'
```

The region arrives as a bound parameter: a GeoJSON object is not a
value any database can bind, so what binds is one edge of its box per
slot, computed at bind time from the same kernel the stored columns
came from. `$bbox-intersects` and a geohash cell test are exact and
need no refinement; `$within` and a bounded `$distance` push the box
they provably imply and re-run the exact predicate over the narrowed
candidates. A circle that reaches a pole or crosses the antimeridian
pushes **nothing** — there is no single box to push — and the answer is
the same, reached by reading more rows. A proximity probe is **nine
cells** (`$geohash-neighbours`), never one prefix: two points ten
metres apart can differ in the first character of their cell, so a
single-cell range is bucketing, not proximity.

**The geofence.** Register the same document as a live query and it is
maintained as writes arrive — the initial fetch narrows through the
index, and every touched row is re-evaluated by the engine's *exact*
predicate:

```js
const fence = await places.live([{
  $for: { p: '$[*]' },
  $where: { $within: ['$p.at', '$region'] },
  $return: '$p.id',
}], { externals: { region } });
fence.mode; // { strategy: 'rows', mode: 'incremental' }
fence.subscribe(({ patch }) => {
  // add    when a point enters the region
  // remove when it leaves
  // nothing while it moves within (a whole-document return sees a replace)
});
```

That is per-row evaluation, not an incremental spatial index: every
write runs `$within` against the region once, on the store's
connection, and a large region at a high write rate pays for it on
every write (LIVE-FORMAT §7 states the cost). An ordering by
`$distance` or a spatial aggregate re-runs on invalidation with the
reason in `live.mode` — declared, never silent.

**The numbers, the loss included.** `benchmark/spatial.js` stores <!--fact:spatial.corpus-->50,000 points<!--/fact-->
over the Netherlands and probes one box at <!--fact:spatial.rows-->258 of 50,000 (0.5 %)<!--/fact--> selectivity,
asserting every plan case of the committed spatial corpus and every timed shape against the JavaScript
engine before a single timing is printed. The `$within` a consumer writes went from <!--fact:spatial.scan-->80 ms<!--/fact-->
as a full scan to <!--fact:spatial.within-->2 ms<!--/fact--> over the `bbox` index (<!--fact:spatial.scanVsIndexed-->40.0<!--/fact-->×);
`$bbox-intersects` is <!--fact:spatial.bboxIntersects-->1.9 ms<!--/fact-->, a bounded `$distance` <!--fact:spatial.distance-->1.5 ms<!--/fact-->;
one geohash cell answers in <!--fact:spatial.cellOne-->0.0068 ms for 0 row(s)<!--/fact--> and the honest nine-cell
probe in <!--fact:spatial.cellNine-->0.026 ms for 2 row(s)<!--/fact-->. The row the store had to win is the same
`$within` in the in-memory engine over the parsed array, no database at all: <!--fact:spatial.engine-->32 ms<!--/fact-->.
The indexed store is now <!--fact:spatial.engineVsIndexed-->16.1× faster than<!--/fact--> it — but the un-indexed scan
is not, and the comparison is not an even one either way: the engine starts from parsed objects where the
store starts from bytes on a page and pays JSON materialisation for every row it returns. Both rows stay
published. The deterministic-UDF hatch takes a literal `$within` on a collection with no derived index, and
its profile is measured on the same rows in MODEL-FORMAT §8.2 (a loss as a sole predicate, a large win
beside a selective conjunct or a `LIMIT`).

**Two shapes on disk for one declaration.** `derive: 'bbox'` has a
second physical realization: `physical: 'rtree'` keeps the same four
derived columns and stores the boxes in a SQLite R\*Tree beside the
collection, synced by three declared triggers, with no B-tree over the
columns (MODEL-FORMAT §2.1). The logical model is unchanged — the
spatial corpus runs every entry under both mappings, in all three
executors, with no special-cased entry — and the pushed conjunct becomes
a `rowid` subquery over the virtual table. Through the store the same
`$within` measures <!--fact:spatial.rtreeStore-->0.46 ms against 2 ms — 4.3× in the R\*Tree's favour<!--/fact-->; loading the same rows
costs <!--fact:spatial.rtreeLoad-->718 ms against 399 ms for 50,000 documents in one transaction — 1.8× the write cost<!--/fact-->, because the R\*Tree is a
second table written inside every write transaction. Isolated from the
store on a raw connection the probe is <!--fact:spatial.rtree-->0.3 ms against 1.9 ms — 6.4× in the R\*Tree's favour<!--/fact-->.
Both halves are published because both are the price. One honest
difference comes with it: an R\*Tree stores 32-bit floats rounded
outward, so its box is a superset and `$bbox-intersects` is refined
rather than exact there — same rows, and `strict: true` says so.

**One document, three executors, proven to agree.** The same spatial
query document runs in three places — the JavaScript engine
(`compileJsonQuery`), SQLite through the Node driver, and SQLite
compiled to wasm in a real browser tab — and one committed corpus holds
all three to the same answers. `test/json/fixtures/spatial-corpus.json`
records what the engine answers for every case (generated, never
hand-typed); `test/db/spatial-oracle.test.js` runs every entry through
the Node driver under all three mappings — the derived indexes as
columns, the same indexes as R\*Trees, and none; and
`packages/website/e2e/spatial-agreement.spec.js` drives the data
studio's Store pane to run the same entries through the wasm build in
Chromium, Firefox and WebKit, asserting every answer against the
fixture on disk and the number of entries run against the corpus. Each
runner names the executor, the entry and the query when it disagrees.
That is the whole claim — not faster than anyone, not PostGIS — and the
browser leg's limit is stated with it: **it proves execution, not
durability.** Where OPFS is unavailable the tab's store is in-memory,
which is a property of the host, not of the suite.

**No head-to-head rival, and saying so.** Nothing else in JavaScript
stores GeoJSON in SQLite from a JSON query document, so the suite
invents none. The rivals to know about: MongoDB (`$geoWithin`, `$near`,
a `2dsphere` index) has a GeoJSON-native query document and a real
spatial index, and runs on a server — no browser execution, and no
second engine to agree with; DuckDB-wasm with `spatial` runs in a tab
with a real index and the overlay operations this store refuses to
build, and its query is SQL, not a document. Neither runs one document
through three executors proven to agree, and neither validates ring
closure in a schema.

## Vector storage — the column, the cut, the price, the ceiling

A collection can declare that one member is an embedding, and the store
keeps it as a packed column beside the document:

```js
const store = await openStore({
  $model: '0.1',
  collections: {
    memories: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          // typed `array` and nothing else: a column over a member that
          // may also be a string or null is a column that lies about
          // some documents. minItems/maxItems make a wrong-width write
          // a validation error instead of an unrankable row.
          embedding: { type: 'array', items: { type: 'number' },
            minItems: 768, maxItems: 768 },
        },
      },
      key: '/id',
      indexes: [{ name: 'by_vec', path: '$.embedding', derive: 'vector', dims: 768 }],
    },
  },
}, { driver: nodeDriver() });
```

`derive: 'vector'` materializes the member **l2-normalized and packed as
little-endian binary32** — `4·dims` bytes, computed by
`@jarenjs/core/vector` — into one **stored** column on every driver, with
**no B-tree over it and no registered function** (MODEL-FORMAT §§2.1,
3.1). Nothing seeks a blob of floats, so the entry names a column rather
than an index; and because the column is stored rather than generated, a
plain `SELECT`, a backup or a foreign tool can read the table without
registering anything — which is also what lets `bun`, whose SQLite
binding has no function API at all, store and read the same bytes.

**"The k most similar" is not a keyword.** It is the query language's own
ordering and window (QUERY-FORMAT §8.15) — `$orderby` on a `$similarity`
key, descending, under a `$subsequence`:

```js
const memories = store.collection('memories');
const nearest = {
  $subsequence: [{
    $for: { m: '$[*]' },
    $where: { $eq: ['$m.topic', 'deploys'] },
    $orderby: [{ $key: { $similarity: ['$m.embedding', '$q'] }, $dir: 'desc', $empty: 'least' },
      '$m.id'],
    $return: '$m',
  }, 0, 10],
};
await memories.execute(nearest, { externals: { q: probe } });

const how = await memories.explain(nearest, { externals: { q: probe } });
how.mode;                       // 'knn'
how.rank;                       // { column: 'gx_embedding_v768', dims: 768,
                                //   probe: { external: 'q' }, offset: 0, limit: 10,
                                //   margin: 1e-6, decides: 'engine' }
how.sql;                        // SELECT "rowid", "gx_embedding_v768" … WHERE …
                                // — no ORDER BY, no LIMIT, no similarity call
memories.stats().knn;           // { queries, rows, candidates, fullFetches, diverted }
```

The pushed `$where` narrows in SQL exactly as in any other mode; the
statement then projects `(row identity, packed column)` and nothing else;
the **engine** unpacks, scores and keeps every row within `1e-6` of the
`offset + limit`-th best; the candidates' documents are fetched by
identity, and the ORIGINAL document — its whole `$orderby`, its window,
its `$return` — runs over exactly those. So **the column cuts and the
engine decides**: ties break by the document's own secondary keys,
offsets and nested windows compose for free, and the rows the column
cannot rank still appear where `$empty: 'least'` puts them. `strict: true`
refuses the shape with `JD0010` naming the rank, because the ordering is
engine work — the same honesty the spatial refinement gets. A probe of
the wrong width, or one that is not an array of numbers, **diverts** to
the residual, so a query can never quietly become an O(table) scan nobody
counted (ARCHITECTURE, "The k-nearest plan"). A *literal* probe of the
wrong width is refused at plan time and `explain()` says why; an
**external** one is only knowable when it is bound, so the plan stays
`knn` and the fallback is counted instead — `stats().knn.diverted` is
that count, and a consumer who binds probes from a model should watch it.

**Several declared widths, one compiled query.** A member may carry more
than one `derive: 'vector'` index — a 384-wide embedding beside a
768-wide one — and an external probe then binds the column its OWN width
names. The plan carries one alternative per declared width and emits one
statement per alternative, prepared once and kept with the plan; the
bind picks exactly one. No `CASE` across the columns (that would read
every one of them per row) and no statement per call (that would give up
the prepared cache). `explain().rank` names the `alternatives` and, when
the call was given its externals, the `selected` width — the probe is
named, never printed. A width the model does not declare is the same
counted diversion any unbindable probe is.

**The numbers, the losses included.** `benchmark/vector.js` measures one
k-nearest query every physical way it can run — over <!--fact:vector.grid-->10,000 and 50,000 vectors at 384 and 768 dimensions, k = 10, the median of 10 probes<!--/fact--> —
and asserts that every path returns the identical top-k, ids and order,
on every probe before a single timing prints. The flagship row is the
plan a consumer's own document runs, which measures <!--fact:vector.plan-->206 ms at 50,000 × 768<!--/fact-->:
<!--fact:vector.table-->
| path (ms) | 10,000 × 384 | 10,000 × 768 | 50,000 × 384 | 50,000 × 768 |
|---|---:|---:|---:|---:|
| engine resident sweep (no database) | 3.3 | 6.7 | 17 | 32 |
| **the k-nearest plan (the store's own)** | 22 | 33 | 139 | 206 |
| raw fetch + engine sweep (the plan's statement) | 20 | 31 | 130 | 202 |
| `ORDER BY` over a registered function | 18 | 31 | 121 | 180 |
| JSON-doc sweep (no vector column) | 249 | 501 | — | — |
| sqlite-vec | 3.6 | 7.5 | 18 | 38 |
<!--/fact-->

The row the column exists to beat is the last one that has no column: the
same query document over a collection that stores the embedding only
inside the document costs <!--fact:vector.jsonDoc-->15.0× the plan at 10,000 × 768<!--/fact-->,
because every row's vector is parsed out of JSON before it can be
compared. The row the store **cannot** beat is the one with no database
in it: the same top-k over a resident `Float32Array` is <!--fact:vector.resident-->32 ms, which the plan is 6.4× slower than<!--/fact-->.
That comparison is not an even one and the direction is the point — the
sweep starts from decoded floats in RAM and pays nothing for durability,
for filters that compose with the ranking, or for a process that can
restart — but it stays published, because a store that is worth its
price should be able to say what the price is.

**Both halves of the price.** The column costs on the way in as well as
saving on the way out: writing the same documents with
the index costs <!--fact:vector.write-->10.6 s against 5.0 s for 50,000 documents in one transaction — 2.1× the write cost<!--/fact-->,
because every write pays a JSON round trip of the member plus a
normalize and a pack. On disk one vector is <!--fact:vector.storage-->3,072 B packed against 16,141 B as a JSON number array inside the document — 5.3× smaller<!--/fact--> —
smaller, but *added*, since the document still carries the member the
column is derived from.

**Pushing the rank into SQL, re-measured.** A registered similarity
function inside an `ORDER BY … LIMIT k` is the obvious alternative, and
the suite measures it against the real column with the probe hoisted out
of the per-row call: <!--fact:vector.udf-->180 ms against 202 ms at 50,000 × 768, and 0.87–1.00× the fetch-and-rank across the grid — rough parity on speed<!--/fact-->.
The plan does not emit it, and after that measurement the reasons are not
speed: `bun` has no user-function API, so a plan that needed one would
exclude an executor outright; and an ordering decided in SQL cannot break
a tie by the document's own secondary keys, which is what the three
executors have to agree on.

**The rival, and the ceiling.** `sqlite-vec` is the extension built for
exactly this, and it is measured rather than described: it answers the
same probes in <!--fact:vector.rival-->38 ms against 206 ms at 50,000 × 768 — 5.4× in sqlite-vec's favour, out of a database 6.6× smaller that holds no documents<!--/fact-->,
over <!--fact:vector.agreement-->40 probes, no disagreements<!--/fact-->. It is a
loadable native extension, which is the one thing this store will not
require — it would exclude the wasm tab and stock `bun`, half the
execution story — so the comparison is published as what it is: a faster
engine you may prefer, and a dependency this one does not take. What
neither of them is, is an approximate index. Exact brute force is linear
in `n · d`, and the suite states the envelope as arithmetic rather than
opinion: <!--fact:vector.ceiling-->5.546 ns per vector component — one query reaches 100 ms at about 22,000 vectors of 768 dimensions and one second at about 234,000<!--/fact-->.
Past that this design is the wrong tool and no margin changes it; what
lies beyond is an approximate index, and this store does not have one.

**One document, three executors, proven to agree.** As with the spatial
family, the k-nearest shapes of a committed corpus
(`test/json/fixtures/vector-corpus.json`) run through the JavaScript
engine, SQLite through the Node driver, and a real wasm build — indexed
and unindexed — and every entry must answer identically, including a
deliberate one-binary32-ulp near-tie and the windows that reach past the
scored rows into the tail the column cannot rank.

## Time series — the index, the ladder, the refinement

The physical declaration is one a model already has:

```json
{ "name": "by_series_at", "path": ["$.series", "$.at"] }
```

No `derive` kind, no column type, no host function, no extension. What
the planner adds is the reading of that index — a B-tree seeks as far
as its leading columns are decided, so a query that pins `series` with
an equality and ranges over `at` is a SEARCH, and one that only bounds
`at` is a scan the plan says so about.

```js
// native: SEARCH sample USING INDEX sample_by_series_at (gx_series=? AND gx_at>? AND gx_at<?)
await sample.execute({
  $for: { s: '$[*]' },
  $where: { $and: [
    { $eq: ['$s.series', 'sensor-a'] },
    { $ge: ['$s.at', from] },
    { $lt: ['$s.at', to] },
  ] },
  $orderby: [{ $key: '$s.at' }],
  $return: '$s',
});

// native: the same index, GROUP BY over integer bucket arithmetic
await sample.execute({ $resample: [
  { $for: { s: '$[*]' }, $where: { $eq: ['$s.series', 'sensor-a'] }, $return: '$s' },
  { every: 'PT1M', aggregate: 'mean' },
] });

// hybrid: the index bounds the fetch, rollingSeries decides
await sample.execute({ $rolling: [
  { $for: { s: '$[*]' }, $where: { $eq: ['$s.series', 'sensor-a'] }, $return: '$s' },
  { width: 'PT1M', aggregate: 'mean', minPeriods: 30 },
] });
```

**The numbers, the loss included.** `benchmark/series.js` answers the
same range, the same buckets, the same rolling window and the same
as-of join over one seeded corpus by plain references, by the temporal
kernel, by a generic query document, by hand-written SQL and by the
store — every route checked against the others before a timing is
taken. At <!--fact:series.corpus-->100,000 samples at 1-second spacing, Node v24.19.0<!--/fact-->,
the store is measured three ways at once — <!--fact:series.storeShapes-->the planned range costs 4.0× the hand-written statement and 1416.4× the resident cut, and the pushed bucket ladder 2.5× the hand-written GROUP BY, 1.7× FASTER than the generic query route, and 128.0× the one-pass loop<!--/fact-->.
The range row is not the planner's price: the statement selects two
COLUMNS where the store renders and parses a whole JSON document per
row, which is what storing documents costs.

And what a refinement costs, with the loss in it: <!--fact:series.storeRefinement-->A window measured in time is not pushed: the store answers it at 17.8× the kernel over an array already in memory, over 100,000 candidates the index bounded. The batched as-of join reads 99,129 rows in 1 statement and costs 1835.4× fifty-one separate index reads — a bound is what it buys, not a speed-up, and without a tolerance a backward join can only be bounded above.<!--/fact-->

**A refinement is named, never quiet.** `explain().series` reports
`mode` — `native`, `hybrid` or `engine` — the declared index the fetch
seeks through, the instant bounds it used, which kernel finished the
answer, and a reason code for every thing the database could not do:
`fill-policy`, `calendar-width`, `named-zone`, `rolling-refinement`,
`asof-refinement`, `unsupported-aggregate`, `nonliteral-spec`,
`instant-not-integer`, `missing-series-prefix`, `row-selector`,
`value-not-numeric`, `nonnative-grouping`, `invalid-spec`. `strict: true` refuses
every one of them before a statement runs, and the counts `explain()`
prints are the LAST ACTUAL execution's — `null` until the document has
run, because an estimate wearing a count's name is worse than no
number. Every path counts: a set residual, a row projection, a native
aggregate (whose `candidates` stays `null`, since no row reached the
engine and SQLite reports no visited-row count) and a cursor, which
counts as it is drained and is final when it settles — read
mid-iteration, `counts.partial` is `true`. `series.mode` follows the
plan mode: a selection the engine finishes is `hybrid` when the index
narrowed the fetch and `engine` when nothing did, never `native` on the
strength of an index alone.

**The as-of join is bounded, and the bound is the claim.** `$asof` with
the collection on the right reads the probes it was given, bounds the
fetch by their own span and by a membership test over their `by` keys,
and issues exactly ONE statement whatever the probes number — the
failure mode a batch exists to refuse is one seek per left row, and
`test/db/statement-count.test.js` pins it at 1, 10 and 200 probes.
Without a `tolerance` a backward join can only be bounded ABOVE, so
that one statement can read most of a long history: the benchmark
publishes the candidate count beside the timing rather than netting it
out, and at fifty-one probes over a hundred thousand rows the batch
LOSES to fifty-one separate index reads. Few questions of a large
series belong to a batch; a join of two series does.

**One corpus, five executors, proven to agree.** The committed temporal
corpus (`test/json/fixtures/series-corpus.json`) runs through the plain
references, the query vocabulary, `node:sqlite`, a real wasm build and
both drivers again with pushdown forced off — indexed and unindexed —
and every case must answer identically, plan mode and reason codes
included.

## What SQLite-only means, frankly

SQLite is the supported backend — 3.45 or newer, on `node:sqlite`,
`bun:sqlite`, or your injected wasm build — and nothing else is
promised. The dialect seam exists and is tested against a double, but
no second dialect ships. Concretely: there is **no statement timeout**
(the drivers expose no interrupt; the capability slot is honestly
`false`), no server, no replication, and cross-process concurrency is
SQLite's own story (WAL plus a busy timeout, both set and visible on
`store.capabilities`).

## The relational half (phase B)

- **Entities and relations** (`x-entity`, MODEL-FORMAT §9): hybrid
  rows — key and mapped scalar columns beside one JSONB document —
  with real foreign keys (`PRAGMA foreign_keys` set AND verified),
  all three relation kinds, and derived epoch columns for indexed
  instant ranges.
- **One-statement graph loads** (§10): `entity('User').load({ include:
  { posts: { include: { comments: true } } } })` runs in exactly ONE
  statement regardless of depth or parent count — asserted by a
  counting driver in the tests, and published with statement counts
  beside the timings on the benchmark page. Keyset pagination when
  the ordering allows it, reported, never silent.
- **The unit of work** (§11): reads are plain deep-frozen JSON (no
  proxies, asserted); mutation is replacement; `saveChanges()` diffs
  snapshots into minimal parameterised statements in one transaction,
  with insert batching, `JD0040` cycle refusal, `JD2040` optimistic
  conflicts, and a report of every statement, fallback and count. Its
  fate is its transaction's: an enclosing rollback WITHDRAWS the advance,
  so a caller's retry plans the same statements again instead of
  reporting a success it never had.
- **Transaction ownership** (MODEL-FORMAT §5.1): the store a transaction
  callback receives IS the transaction — `tx.collection`, `tx.entity`,
  `tx.sync`, `tx.jobs`, `tx.saveChanges()`, and `tx.transaction()`
  nesting through its savepoint. A store-level handle is by construction
  somebody else: it holds the connection for its own extent, so an
  unrelated writer on a shared store keeps its own fate rather than
  sharing a rollback it knows nothing about. Contention waits under
  `queueTimeout` and then names itself `JD0012`, or refuses at once under
  `openStore(model, { transactions: 'strict' })`. One store is safe for a
  handler per request. Every `tx` view is pinned to its EXACT scope: a
  handle retained past its callback, or an outer handle used while an
  async inner savepoint is open, refuses `JD2070` instead of joining a
  transaction it does not own — and a transaction view carries no
  `close`, because it never owns the connection's lifetime. A root
  cursor (`collection.query()`, `entity.cursor()`, `entity.loadCursor()`)
  is admitted **per pull**: construction holds nothing, each `next()` and
  `return()` borrows the gate for one item's work and releases before it
  settles, so a paused consumer blocks no transaction and no pull ever
  reads another transaction's uncommitted row; `store.live()` registers
  under the same gate through its initial query.
- **Named savepoints** (MODEL-FORMAT §5.2): `tx.savepoints.create /
  rollbackTo / release` give a live transaction checkpoint-and-continue
  without a sentinel exception — the target stays active after a
  rollback, `release` keeps the rows, labels never reach SQL, and the
  tracker, capture stream and `tx.jobs` outbox all agree with the
  database after every partial rollback. The synchronous twin is
  `tx.sync.savepoints`; a blank, duplicate or unknown label is `JD2071`.
- **Generated types**: `entityEmitModel` + `@jarenjs/emit` render the
  model into entity interfaces, input variants and an `EntityMetaMap`;
  `typedStore` (from `@jarenjs/db/typed`) types every read, checks
  every write, and widens `load` results by their include
  specification.
- **Membership** (§11.7): `link(own, member, target)` and `unlink` attach
  and detach one many-to-many membership at a time through the unit of
  work — written against the join table as it stands at save time, so a
  repeated save changes nothing.
- **The front door**: `@jarenjs/linq/db` opens this store behind a
  client typed from the model pen — `db.entities.Post.where((p) =>
  p.stars.ge(3))` is the chain over the entity set, pushed down;
  `db.entities.User.include((u) => u.posts, { where: (p) => p.stars.ge(3),
  take: 2 }).toArray()` emits exactly the `load` spec above and runs in
  the same one statement; `link`/`unlink` reach §11.7 and `live` the
  registration below. It imports this package as an optional peer; this
  package never imports it.
- **Relational migrations and the `jaren-db` CLI** (MIGRATION-FORMAT
  §§9–12): the strategy-table diff, the documented twelve-step table
  rebuild with `foreign_key_check` inside the transaction, shape
  EQUALITY against a fresh build as the acceptance criterion, drift
  detection, and `jaren-db check` for CI.

## The reactive and durable half (phase C)

- **Change capture** (LIVE-FORMAT §§1–6): every committed write
  becomes an observable stream of RFC 6902 patches — from SQLite's
  own session changesets where the binding has them, from a write-path
  journal where it does not (`bun:sqlite`, the wasm build). One diff
  format runs store → patch → live query → O(k) render. Capture is
  opt-in; the overhead is published, not waved away.
- **Live queries** (LIVE-FORMAT §§7–13): `collection.live(document)`
  maintains a result as writes arrive and emits patches — incremental
  for `where`/`select`/`orderBy`+`limit`/aggregates/single-level
  `groupBy` and a spatial `where` over a derived index (the geofence;
  the normative maintenance table), re-run for everything else,
  **declared, never silent** (`live.mode` names the reason).
  Unaffected rows stay reference-identical; a seeded oracle holds the
  maintained result equal to a fresh re-query after every mutation.
- **Event time** (LIVE-FORMAT §13): a `$resample` or `$rolling` view
  over a fixed width maintains exact event-time buckets and windows
  against a watermark the HOST supplies — never a clock — and a reading
  behind the declared lateness re-reads and emits a `lateData` record
  rather than being folded in as though it had arrived on time.
- **Durable runs and the job queue** (JOBS-FORMAT, FLOW-FORMAT §7.6):
  a `@jarenjs/flow` DAG run checkpoints declared nodes and RESUMES
  after a crash; `store.jobs` leases work in one guarded statement (no
  distributed lock), retries with backoff, dead-letters, and reclaims
  expired leases as recovery. Every settling call carries a FENCE — the
  opaque token one claim mints, plus a lease that is still valid — so an
  expired or superseded attempt cannot mark a job done over the live
  one's result, and is told which of three things happened rather than
  answered `false`. `jobs.renew()` replaces a lease while a handler runs;
  the worker does it automatically, retries a renewal that failed for a
  mere storage reason, and aborts only an attempt whose lease is proven
  lost by a fence code. Settlement is exactly-once **against the store**
  — an external effect is still the handler's to make idempotent.
  Ownership follows the handle: root `store.jobs.*` and all worker I/O
  take the store gate and never join an open application transaction,
  while `tx.jobs` is the transactional outbox that co-commits with it;
  and `worker.stop()` quiesces every claim, renewal, checkpoint and
  settlement before it resolves, so closing the store releases the
  database file deterministically.
- **The browser** (`@jarenjs/db/wasm`): the same store, the same
  queries, the same live updates run on the official SQLite wasm build
  over the header-free OPFS SAH-pool VFS — one tab owns the
  connection, others are clients. Proven in the `#/data` studio across
  Chromium, Firefox and WebKit, whose boot is a closed five-stage protocol
  (LIVE-FORMAT §11): every attempt ends ready or in a named, retryable
  `DATA_BOOT` failure, never a status line stuck at boot. The subpath exports the two helpers
  that studio is built on: `sqlite3Handle(sqlite3, { DbClass })` builds
  the injected handle from a loaded wasm module and the database class
  the host picks (`sqlite3.oo1.DB` in memory, the SAH-pool
  `OpfsSAHPoolDb` for OPFS), and `adaptOo1Database(sqlite3, db)` wraps
  an oo1 database the host already opened.
- **The runtime record** (`@jarenjs/core/runtime`): `openStore(model,
  { runtime })` and `migrate(target, migrations, { runtime })` take one
  frozen record — `{ now, uuid, random, zoneProvider }`, defaulting
  member for member to the platform's own — for the clock the capture
  log and the job queue stamp, the identifier a `uuid` identity and a
  `default: 'uuid'` allocate, the backoff jitter, and the zone provider
  a temporal spec naming a zone compiles through. The store hands it to
  the job engine it constructs, so a consumer configures it once, and a
  subsystem's own explicit option (`zoneProvider`, `jobs.now`,
  `jobs.random`) wins over the record's member. A query `deadline` is an
  absolute instant the caller computed and is compared against the
  record's `now` — before a statement runs and at every row boundary of
  a cursor or page — so a deterministic run computes its deadlines from
  the same clock the store reads.

### What an event-time view costs

`benchmark/live.js` maintains a 60 s bucket ladder and a 5 minute
rolling window over a seeded series and rewrites one reading per commit,
inside the lateness the view allows. The maintained rows are checked
against `resampleSeries` / `rollingSeries` over the **whole** collection
before a single timing is printed — a fast live view with the wrong
answer is not a fast live view — and the run exits non-zero if they
disagree.

<!--fact:live.eventTimeTable-->
| view | maintained | re-run | ratio |
|---|---:|---:|---:|
| bucket (60 s ladder, mean), 1000 rows | 119 µs | 1.09 ms | 9.2× |
| rolling (5 min window, mean), 1000 rows | 407 µs | 3.86 ms | 9.5× |
| bucket (60 s ladder, mean), 10000 rows | 136 µs | 10.9 ms | 80.2× |
| rolling (5 min window, mean), 10000 rows | 13.7 ms | 62.7 ms | 4.6× |
<!--/fact-->

The gain is <!--fact:live.eventTimeBand-->80.2× for the bucket and 4.6× for the rolling at 10,000 readings<!--/fact-->. A bucket
view is nearly flat in the series length, because a write folds one
bucket again and the rest of the ladder is untouched. A rolling view is
not, and the table says so: its answer is one row per reading, so the
emitted diff walks every one of them whatever changed. A bucket view
also holds one maintained entry per reading *plus* one per bucket, which
is over §12's default `maxMaintained` at ten thousand readings — the
bound errors rather than degrading, and raising it is a decision
somebody makes.

## Sync-readiness — what exists and what does not

The change stream is an ordered log of RFC 6902 patches with a
monotonic sequence, and SQLite's own changeset/conflict primitives are
available — which is what a replication protocol would be *built
from*. **No replication is shipped.** There is no conflict resolution,
no site identity, no causal ordering across writers, and no capture of
writes made by another connection (the coarse `dataVersion()` signal
is the honest mitigation, not a pretend fine-grained one). Building
replication on these primitives is a roadmap item, not a hint.

## Operating a store — configuration, maintenance, backup, cancellation, the queue

Everything an operator does to a production SQLite database is a typed
operation with a capability, a cancellation and an error class; none of
it needs raw SQL or the raw handle. The rules, in one place:

- **Configuration is a closed, validated set, read back.** Eight
  connection pragmas are `openStore` options — `busyTimeout`,
  `journalMode`, `synchronous`, `walAutocheckpoint`, `journalSizeLimit`,
  `cacheSize`, `mmapSize`, `tempStore` — validated before anything
  reaches SQL. An option naming any other pragma is refused (`JD0006`),
  one the driver or the store kind cannot apply is refused (`JD0007`),
  and after the open every declared pragma is read back:
  `store.capabilities.pragmas` carries the values the connection
  actually has, and an explicitly requested value the engine did not
  take refuses the open (`JD0008`) rather than leaving a store that
  believes a configuration it does not have.
- **Maintenance is four typed operations under the store gate** —
  `checkpoint({ mode })`, `integrityCheck({ limit })`, `foreignKeyCheck()`,
  `optimize()` — each answering SQLite's own row as typed data, refused
  by code (`JD2077`) exactly where `capabilities.maintenance` says
  `false` (a read-only store for the two that write; a binding that
  declares one absent). Corruption an integrity check finds is its
  RESULT, never a throw.
- **A backup is published whole or not at all.** `backupTo(path)` copies
  a live store while writers proceed, into a temporary sibling in the
  same directory, and renames it onto the target only once the platform
  reported the copy complete; a cancelled (`JD2079`) or failed copy
  leaves neither the target nor the temporary file. Where it goes, how
  it is named, rotated or encrypted is the host's.
- **Cancellation is honoured where the driver can honour it, and the
  report says where.** `capabilities.cancellation` states the
  granularity per lifecycle — `query: 'row'`, `queue: true`, `migration:
  'step'`, `maintenance: 'statement'`, `backup: 'page'`, `midStatement:
  false` — and every operation with more than one unit of work takes
  `{ signal, deadline }` on the store's injected clock. A cursor over a
  binding with no lazy iterator says `streaming: 'buffered'` with a
  driver barrier instead of a row stream it cannot deliver.
- **One classification of driver failures.** A locked, full, read-only,
  corrupt or unopenable database arrives under one code with a stable
  `class` and a `retryable` verdict from every path alike (`JD2005`
  busy, `JD2082`–`JD2085`; `JD0002` at open), the driver's error as
  `cause`; a pushed integer aggregate past int64 is answered by the
  engine as the coded residual it always was elsewhere.
- **The queue is administrable, never scheduled.** `store.jobs.page`,
  `cancel` (through the lease fence), `requeue` and `sweep` (with a
  required horizon) are mechanisms; WHEN to sweep or cancel is the
  host's call, and priority classes stay a documented non-goal.

```js
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const store = await openStore(model, {
  driver: nodeDriver(), path: 'app.db', jobs: true,
  synchronous: 'normal', cacheSize: -8000, walAutocheckpoint: 250,
});
// the values the CONNECTION has, read back — not the request
const { journalMode, synchronous } = store.capabilities.pragmas;

const checkpoint = await store.checkpoint({ mode: 'truncate' });   // { busy, logFrames, checkpointedFrames }
const health = await store.integrityCheck();                        // { ok, problems }
const copy = await store.backupTo('backups/app.db', {
  rate: 64,
  onProgress: ({ totalPages, remainingPages }) => report(totalPages - remainingPages, totalPages),
  signal: controller.signal,                                        // JD2079 between pages, nothing left behind
});

for await (const job of store.jobs.page({ state: 'failed', kind: 'mail' })) await store.jobs.requeue(job.id);
await store.jobs.sweep({ settledBefore: Date.now() - 7 * 24 * 3600 * 1000 });

try {
  await store.collection('users').insert(user);
}
catch (error) {
  if (error.class === 'busy' && error.retryable) scheduleRetry(); // one class, whichever path met it
  else throw error;
}
```

The normative contract is [MODEL-FORMAT](docs/MODEL-FORMAT.md) §4 (the
pragma set, the maintenance and backup rules, the cancellation report)
and §7 (the codes and the classifier); the queue's administration is
[JOBS-FORMAT](docs/JOBS-FORMAT.md) §10; a migration's cancellation and
its side-effect-free status read are in
[MIGRATION-FORMAT](docs/MIGRATION-FORMAT.md) §6.

## What this is not — every non-claim in one place

- **SQLite only.** One backend (3.45+); the dialect seam is tested
  against a double but no second dialect ships. No server.
- **No replication or sync engine** (see above). No cross-connection
  change capture — another connection's writes are invisible locally.
- **No statement timeout** on SQLite (the drivers expose no interrupt;
  the capability slot is honestly `false`), no row estimates.
- **Not safe for mutually hostile tenants** without the profile's
  mandatory predicate — SECURITY states the claims and non-claims.
- **The job queue is one database, one machine.** A shared SQLite file
  over a NETWORK FILESYSTEM (NFS, SMB, many container volume mounts) is
  NOT a safe coordination substrate — SQLite's locking is unreliable
  there. Same-host processes over WAL are the supported topology. No
  priority classes, no cron, no workflow compensation.
- **Live-query maintenance is limited to the declared table** (§7);
  joins, entity queries and non-canonical shapes re-run, reported.
- **`eventTime.retention` bounds repair work, not memory.** It is the
  horizon a view claims and is checked against the window it maintains;
  the maintained state is still bounded by `live.maxMaintained`, and no
  version of this compacts a bucket's rows away.
- **The wasm build journals** (its session extension is not yet
  adapted); OPFS needs a secure context, and where it is absent the
  store runs in memory with the durability difference stated.
- **Named future work, not silent gaps**: `$groupby` pushdown beyond
  the `$time-bucket` ladder, a many-to-many hop on the chain, membership
  on an auto-keyed pending insert, incremental joins, other SQL dialects,
  replication, database introspection (MODEL-FORMAT §10.6, the roadmap).

The normative formats are
[docs/MODEL-FORMAT.md](docs/MODEL-FORMAT.md) (storage §§1–7, safe
profile §8, entities §9, relational translation §10, the unit of work
§11), [docs/MIGRATION-FORMAT.md](docs/MIGRATION-FORMAT.md) (documents
§§1–8, relational changes §§9–12),
[docs/LIVE-FORMAT.md](docs/LIVE-FORMAT.md) (capture §§1–6, live queries
§§7–12, event time §13) and [docs/JOBS-FORMAT.md](docs/JOBS-FORMAT.md) (the durable
queue §§1–9); the seams, the pushdown contract and every engine are in
[ARCHITECTURE.md](ARCHITECTURE.md); the benchmark methodology is in
[benchmark/README.md](../../benchmark/README.md).

## Exports

Every subpath a consumer can import, derived from the manifest by
`npm run docs:derive` (`npm run docs:check` fails when the two drift):

<!--fact:exports.db-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/db` | JavaScript | declared |
| `@jarenjs/db/node` | JavaScript | declared |
| `@jarenjs/db/bun` | JavaScript | declared |
| `@jarenjs/db/wasm` | JavaScript | declared |
| `@jarenjs/db/typed` | JavaScript | declared |
| `@jarenjs/db/app` | JavaScript | declared |
| `@jarenjs/db/schemas/jaren-migration.draft-07.schema.json` | schema | — |
| `@jarenjs/db/schemas/jaren-migration.schema.json` | schema | — |
| `@jarenjs/db/schemas/jaren-model.draft-07.schema.json` | schema | — |
| `@jarenjs/db/schemas/jaren-model.schema.json` | schema | — |
| `@jarenjs/db/package.json` | metadata | — |
<!--/fact-->
