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

// a query document — here written by hand; linq writes the same thing
const adults = await users.execute({
  $for: { it: '$[*]' },
  $where: { $ge: ['$it.age', 21] },
  $return: '$it',
});
```

- **The pushdown planner with `explain()`.** A query compiles through
  the engine's published AST into a dialect-neutral plan and renders
  to guarded, parameter-bound SQL; whatever cannot be proven
  equivalent runs as a real compiled Jaren query (the residual), and
  `explain()` always says which is which — the SQL, the bound
  parameters, the indexes used (verified against the database's own
  plan output), and the residual's named reasons. A 418-run
  differential oracle keeps both paths agreeing. `strict: true` turns
  any residual into a compile error.
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
- **Migrations are documents.** `planMigration` diffs two models into
  rendered-DDL + JSLT-transform + assertion steps; a shadow database
  replays the whole chain before the real store is touched; a
  checksummed history refuses edited or reordered migrations; a
  narrowing without an adequate transform is refused against the REAL
  data, inside the transaction.
- **The safe profile.** Untrusted query documents run under composed
  bounds: engine limits on the residual, a mandatory row bound that
  refuses rather than truncates, reference allow-lists, optional
  full-scan refusal, and per-collection mandatory predicates no
  document shape can shed. Read-only stores refuse writes at the
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

**The numbers, the loss included.** `benchmark/spatial.js` stores <!--bm:spatial.corpus-->50,000 points<!--/bm-->
over the Netherlands and probes one box at <!--bm:spatial.rows-->258 of 50,000 (0.5 %)<!--/bm--> selectivity,
asserting every plan case of the committed spatial corpus and every timed shape against the JavaScript
engine before a single timing is printed. The `$within` a consumer writes went from <!--bm:spatial.scan-->80 ms<!--/bm-->
as a full scan to <!--bm:spatial.within-->2 ms<!--/bm--> over the `bbox` index (<!--bm:spatial.scanVsIndexed-->40.0<!--/bm-->×);
`$bbox-intersects` is <!--bm:spatial.bboxIntersects-->1.9 ms<!--/bm-->, a bounded `$distance` <!--bm:spatial.distance-->1.5 ms<!--/bm-->;
one geohash cell answers in <!--bm:spatial.cellOne-->0.0068 ms for 0 row(s)<!--/bm--> and the honest nine-cell
probe in <!--bm:spatial.cellNine-->0.026 ms for 2 row(s)<!--/bm-->. The row the store had to win is the same
`$within` in the in-memory engine over the parsed array, no database at all: <!--bm:spatial.engine-->32 ms<!--/bm-->.
The indexed store is now <!--bm:spatial.engineVsIndexed-->16.1× faster than<!--/bm--> it — but the un-indexed scan
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
`$within` measures <!--bm:spatial.rtreeStore-->0.46 ms against 2 ms — 4.3× in the R\*Tree's favour<!--/bm-->; loading the same rows
costs <!--bm:spatial.rtreeLoad-->718 ms against 399 ms for 50,000 documents in one transaction — 1.8× the write cost<!--/bm-->, because the R\*Tree is a
second table written inside every write transaction. Isolated from the
store on a raw connection the probe is <!--bm:spatial.rtree-->0.3 ms against 1.9 ms — 6.4× in the R\*Tree's favour<!--/bm-->.
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
  conflicts, and a report of every statement, fallback and count.
- **Generated types**: `entityEmitModel` + `@jarenjs/emit` render the
  model into entity interfaces, input variants and an `EntityMetaMap`;
  `typedStore` (from `@jarenjs/db/typed`) types every read, checks
  every write, and widens `load` results by their include
  specification.
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
- **Live queries** (LIVE-FORMAT §§7–12): `collection.live(document)`
  maintains a result as writes arrive and emits patches — incremental
  for `where`/`select`/`orderBy`+`limit`/aggregates/single-level
  `groupBy` and a spatial `where` over a derived index (the geofence;
  the normative maintenance table), re-run for everything else,
  **declared, never silent** (`live.mode` names the reason).
  Unaffected rows stay reference-identical; a seeded oracle holds the
  maintained result equal to a fresh re-query after every mutation.
- **Durable runs and the job queue** (JOBS-FORMAT, FLOW-FORMAT §7.6):
  a `@jarenjs/flow` DAG run checkpoints declared nodes and RESUMES
  after a crash; `store.jobs` leases work in one guarded statement
  (exactly-once completion, no distributed lock), retries with
  backoff, dead-letters, and reclaims expired leases as recovery.
- **The browser** (`@jarenjs/db/wasm`): the same store, the same
  queries, the same live updates run on the official SQLite wasm build
  over the header-free OPFS SAH-pool VFS — one tab owns the
  connection, others are clients. Proven in the `#/data` studio across
  Chromium, Firefox and WebKit.

## Sync-readiness — what exists and what does not

The change stream is an ordered log of RFC 6902 patches with a
monotonic sequence, and SQLite's own changeset/conflict primitives are
available — which is what a replication protocol would be *built
from*. **No replication is shipped.** There is no conflict resolution,
no site identity, no causal ordering across writers, and no capture of
writes made by another connection (the coarse `dataVersion()` signal
is the honest mitigation, not a pretend fine-grained one). Building
replication on these primitives is a roadmap item, not a hint.

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
- **The wasm build journals** (its session extension is not yet
  adapted); OPFS needs a secure context, and where it is absent the
  store runs in memory with the durability difference stated.
- **Named future work, not silent gaps**: `$groupby` pushdown,
  relation-name query sugar, a many-to-many membership API, incremental
  joins, other SQL dialects, replication, database introspection
  (MODEL-FORMAT §10.6, the roadmap).

The normative formats are
[docs/MODEL-FORMAT.md](docs/MODEL-FORMAT.md) (storage §§1–7, safe
profile §8, entities §9, relational translation §10, the unit of work
§11), [docs/MIGRATION-FORMAT.md](docs/MIGRATION-FORMAT.md) (documents
§§1–8, relational changes §§9–12),
[docs/LIVE-FORMAT.md](docs/LIVE-FORMAT.md) (capture §§1–6, live queries
§§7–12) and [docs/JOBS-FORMAT.md](docs/JOBS-FORMAT.md) (the durable
queue §§1–9); the seams, the pushdown contract and every engine are in
[ARCHITECTURE.md](ARCHITECTURE.md); the benchmark methodology is in
[benchmark/README.md](../../benchmark/README.md).
