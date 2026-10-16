# PostgreSQL composition and operational evidence

PostgreSQL and SQLite use the same Store, model/query documents, contract commands,
jobs, live binding and managed replication protocol. The host selects a driver and
supplies database access, scope, authorization, clocks and providers. A backend
selection does not migrate existing application data or replace its policies.

## Qualified capabilities

The required `npm run test:postgres` lane fails without an endpoint and rejects
skipped native cases. CI uses the exact images in
[`matrix.json`](../../../docker/postgres/matrix.json): PostgreSQL 16.15, 17.11 and
18.6, with pg 8.23.0 supplied by the test host. All three durable profiles require
`fsync`, `synchronous_commit` and `full_page_writes` on. The separate extension
fixture has different durability settings; installing extensions adds no native
spatial/vector execution capability to this release.

| Capability | Shared public behavior and native evidence | Boundary |
|---|---|---|
| Managed documents/entities | Common model, query, relation and transaction oracles in [postgres-live.test.js](../../../test/db/postgres-live.test.js) | SQL pushdown only where query semantics agree; residual work remains reported |
| Session ownership | Exact settings restored, missing/inaccessible schema refused, cached-plan failure preserved inside transactions: [session tests](../../../test/db/postgres-session.test.js) | Host provisions schema, roles, TLS and session-affine pool; a Store owns a client until close |
| Bounded execution | Native cursors, finite admission, server deadlines, cancellation settlement: [cursor tests](../../../test/db/postgres-cursor.test.js) | A normalized row/frame limit cannot prevent allocation inside an injected client; buffered compatibility declares weaker bounds |
| Retry, hold limit, lost sessions | Whole-transaction retry after 40001, a Store-level hold limit that rolls back without ending the session, a lost session coded JD2087 instead of an uncaught exception: [retry](../../../test/db/transaction-retry.test.js), [hold](../../../test/db/transaction-hold.test.js) and [loss](../../../test/db/connection-loss.test.js) tests | Retry is explicit and never follows a connection loss; the server-side idle/transaction timeouts stay unset because they end the session |
| Several sessions per Store | `sessions: N` runs independent transactions and reads at once, each on a session of its own; conflicts settle in the database; capture, jobs and live queries stay exact: [session tests](../../../test/db/postgres-sessions.test.js) | The store's own unit of work runs on the first session, one call at a time; captured writes stay ordered by the capture lock; replication runs on one session |
| Writer lock, isolation, owner | `mode: 'immediate'` loses no update between two Stores, the three isolation levels run and are reported, a lock wait past `lock_timeout` is busy and retryable, one owner per schema: [isolation](../../../test/db/postgres-isolation.test.js) and [owner](../../../test/db/postgres-owner.test.js) tests | The writer lock orders immediate transactions only; plain writes lock rows. The owner lock is cooperative and names no holder |
| Relational statements through the Store | `store.relational` and `tx.relational` over the native cursors, the write rules shared with trusted SQL, a failed write inside a transaction contained by its savepoint: [store-bound tests](../../../test/db/relational-store.test.js) | A root native cursor holds the session until released, so other root calls wait for it; `lastInsertRowid` is never reported |
| Physical tables and catalog | Explicit codecs, exact bigint/decimal strings, date/time distinctions, declared layout and rich loss/disposition inventory: [physical tests](../../../test/db/postgres-physical.test.js); a declared index's condition, and the key under each expression term, read back from the catalog and compared as one condition or expression across the server's spellings: [condition tests](../../../test/db/postgres-layout-condition.test.js), [expression term tests](../../../test/db/postgres-layout-expression.test.js) | Arbitrary catalog objects are inventoried, not automatically translated into model intent; a condition or key either side does not read back (a date or uuid literal, `TRIM`, another quantified comparison) is verified by the index's shape alone |
| Native migrations | Reviewed native catalog artifacts, dependency/sequence preservation, receipts, transaction rollback and separate shadow replay: [migration tests](../../../test/db/postgres-migration.test.js) | Concurrent index creation and unreviewed destructive dependencies refuse; opening never silently changes an existing schema |
| Entity migrations | A scalar moves between its column and the document, a rebuild retypes a member, and a key gains or drops `default: "auto"` (its referencing columns, sequence and rule functions converted by planned steps) with the values SQLite keeps, on 16, 17 and 18: [entity migration tests](../../../test/db/postgres-entity-migration.test.js) | A rebuild of an entity another object depends on refuses at the drop (`JD0023`); a conversion rewrites its table under an exclusive lock, and a session connected before it keeps what it prepared against the old column type |
| Database rules | Persistence invariants as PL/pgSQL trigger functions (SQLSTATE `23J01`) under a fixed `search_path = pg_catalog, pg_temp`, with a statement program refusing `TRUNCATE` where deletes are judged, installed by a reviewed migration and verified field by field through the catalog at open; one differential oracle with SQLite over refusals, audit rows, revisions, existence probes, store enforcement and fresh and migrated installs: [invariant tests](../../../test/db/postgres-invariants.test.js) | Physical layouts only; a refused trusted statement spends its transaction (`JD2088`); `TableTrigger` documents remain SQLite SQL |
| Committed feed | Shared write journal, transactionally locked high-water and finite resume/reset: [capture tests](../../../test/db/postgres-capture.test.js) | Participating managed writers only; arbitrary external SQL, unenrolled trigger effects and physical layouts are outside capture coverage |
| Jobs, flow and outbox | Shared engine, concurrent row-locked claims, leases, fenced checkpoints and atomic business/job writes: [job tests](../../../test/db/postgres-jobs.test.js) | Another database/file is another transaction; external delivery needs durable intent, receipts and reconciliation |
| Live and lexical freshness | Optional `@jarenjs/db/async-live`, bounded resnapshot and the existing lexical ranker: [async tests](../../../test/db/postgres-async-live.test.js) | Not synchronous incremental live or native PostgreSQL full-text ranking; NOTIFY only wakes a durable page reader |
| Managed replication | PostgreSQL ↔ SQLite and PostgreSQL ↔ PostgreSQL, receipts, conflicts, bounded reset, commit uncertainty and process-death recovery: [replication tests](../../../test/db/postgres-replication.test.js); the rows cascading and set-null relations change: [cascade replication tests](../../../test/db/postgres-replication-cascade.test.js) | Native cursors required; physical/external-writer replication, unbounded histories and paged bootstrap remain refused or unscheduled |
| Application composition | Identical app/contract/Store/jobs/feed/live/replication oracle: [backend-app.js](../../../test/consumer/backend-app.js) | Host authorization is checked again on replay; credentials, handles and callbacks stay outside JSON state |
| Operator recovery | Coherent logical backup on all three server versions; archived WAL and named target on 17.11 | Synthetic recovery is not power-loss, fleet failover, provider-side reconciliation or downstream cutover evidence |

The [host contract](HOSTS.md#postgresql-sessions), [physical format](MODEL-FORMAT.md#12-existing-column-layouts),
[migration format](MIGRATION-FORMAT.md), [feed/live contract](LIVE-FORMAT.md),
[jobs contract](JOBS-FORMAT.md) and [replication contract](REPLICATION-FORMAT.md)
define the options, refusal codes and resource owners.

Row order is each engine's own row identity, and for an entity whose key is an
`integer` the two differ: SQLite keeps such rows in key order, because that key
IS its `rowid`, while PostgreSQL keeps them in insertion order through the
separate `rid`. A query, include or graph load without a total order — rows that
tie on every ordering term, or a plain `$.Entity[*]` — answers in that order on
each engine, so order by the key where both must answer alike. A collection, and
a managed entity with any other key, is in insertion order on both.

A literal comparison, a bound membership list and a string operator over a
collection member or an entity's document member read the member's typed
extraction alone — the generated column where the member is indexed, else the
`CASE` that column would hold — because that value's own SQL `NULL` already
stands for an absent member, a stored JSON `null` and every other JSON type, so
no `jsonb_typeof` discriminator sits beside it (the dialect declares
`typedExtract`). `$ne` keeps presence through the member's JSON value: a stored
`null` and a value of another type differ, an absent member does not, as the
engine answers. An external operand and a type test keep the discriminator — an
external's type is known only when it binds, and a type test asks for the type
by name — and SQLite's extraction is untyped, so its `json_type` guards stay.
The discriminator was a `CASE` over three `jsonb_typeof` calls, twice per term,
that every row evaluated beside the typed extraction's own `CASE` and that the
planner's selectivity estimate could not price; where the member is indexed the
typed form is the column itself, which the planner estimates from its statistics.

A path step `#>` could read off the wrong kind of container is guarded. `#>`
takes the element `0` of an array and the key `0` of an object for the one path
step, and the array branch reads any text `strtol` accepts as an index (`00`,
`+1`, `-1`, ` 1`), so `$it.u['0']` also matched an array and `$it.u[0]` also
matched an object, where the query engine and SQLite match one each. A query now
reads such a path from a document wrapped in a `CASE` that requires each
parent to be the container its step means, in a collection and in an entity's
document alike (a predicate, a projected leaf, an ordering, and the ordering
of a graph load or of an included relation); a path with no such step is
written as before. Where the schema leaves the step's container open (no
declared `type`: `items` binds arrays alone and `properties` objects alone, so
the other kind conforms) the generated column, an index expression and a
declared interval's CHECK over the path read the member from the same guarded
document, so a conforming document whose open container is an object keyed `0`
holds nothing at an index step (it neither collides in a unique index with the
array that holds the same element nor reads as a span), as the engine and
SQLite read it; a comparison, an ordering or a grouping reads the guarded
document instead of the indexed column, and does not seek that index, and the
declared interval's exact seek holds the document to the span's container
beside its bound columns. Where the container is declared (`type: 'array'` for
an index step, `type: 'object'` for a digit name) a comparison over the path
reads the column, and a document of the other kind, which the schema forbids,
is still read through the column, its index and the CHECK. An index step off a
declared array is spelled as before. A member name the path text spells as an
index (`'0'`, the document's own `$['0']` included) is read under the object
guard whatever the schema declares: unguarded it is the index's text, which the
catalog reads back as that index, so `introspect()` derived an array where an
object was declared and an interval over it did not reopen. The store's own interval check
reads an index step off an array and a name off an object, on every engine. A
table holds either spelling of such a column, index expression and CHECK and
opens as it is: a model that changes how it declares the container plans no
change to them (one that moves the path between an index step and a name
rebuilds them, the guard naming the kind of step), and a table an earlier release created, which holds the
unguarded definitions, keeps reading an object's key `0` at an index step (and
answers `JD2005` from its CHECK for a bad span there), and keeps a name `'0'`
that `introspect()` reads back as an index (its interval CHECK refused `JD0002`
at the next open), until the link
`planColumnUpgrade` plans from the catalog rebuilds them
([MIGRATION-FORMAT §3](MIGRATION-FORMAT.md#upgrading-the-definitions-a-table-holds)),
or its index and interval are dropped by a migration and declared again.

One statement carries at most 128 predicate terms (the dialect's
`maxPredicateTerms`), a leaf predicate being one term but for the one weighed
below, counted over everything the statement holds once the
planner has regrouped: the document's filters, every include filter of a graph
load, the profile's mandatory predicate and every comparison between two
bindings that refines a join (the equality that joins them is merged by the
server and is not counted). A membership list is one leaf
however long it is, so a `$seq`, a same-member `$or` of equalities and a chain
mixing equalities and ranges on two members all stay native; an `$or` of `$and`
pairs and a top-level `$and` of `$ne` count per leaf, and a comparison of two
member paths decided one family at a time counts a leaf for each family the two
share. An inequality, or any comparison under a `$not`, between a document
member and an external operand counts four, because the server compiles that
leaf several times slower than one against a literal: a chain of 33 of them is
past the bound, while a member in its own column, an unnegated ordering or
equality against an external, and a comparison against a literal count one. A
member's membership in an external list (`'$ids[*]'`), the slowest leaf of all
to compile whatever the list's length, counts sixteen from the document, four in
its own column and eight there under a `$not`: a chain of nine distinct lists is
past the bound. The bound exists because
the planner prices every leaf per row, and a chain whose cost crosses the
server's JIT thresholds is compiled by LLVM, whose passes check for no
interrupt: a cancel, a termination and a `statement_timeout` all wait for that
compile to end before the backend answers. Past the bound a query document runs
in the engine, named `predicate.termBound` in `explain()` (strict mode refuses
it `JD0010`), and a graph load (`JD0032`) or a native mutation (`JD0038`), which
have no engine path, refuse it by name; under a profile the residual is refused
where its fetch is (`JD2007` past `maxRows`, `JD0011` under `refuseFullScan`),
and an asynchronous live registration re-snapshots through `execute()`, so its
snapshot is the engine's answer. The price: a top-level `$and` of more than 128
`$ne` over a PostgreSQL collection (more than 32 against externals) runs in the
engine, and a `load({ where })`
or native `mutate()` above the bound that ran before is refused. SQLite has no
JIT and sets no bound. Within the bound, a conjunction's `$ne` literals over
one member are spelled as the member's presence and one negated membership
list bound as one value, so the server compiles one leaf however many there
are; they still count one term each, so what runs natively is unchanged. A
profile's mandatory predicate past the bound reaches the residual's fetch in
that spelling too. A `number` column keeps one comparison per literal (its
list would compare a `numeric`, not the double the column holds), and so do
an external operand and a literal the server cannot hold in a list.

`explain().budget.estimatedRows` is the planner's own row estimate for a native
plan: `{ rows, source: 'postgresql-planner' }`, where `rows` is the `Plan Rows`
of the top plan node from `EXPLAIN (FORMAT JSON)`. The store runs that as a
statement of its own beside the plain `EXPLAIN` whose prose is `scanNarrative`,
over the same bound values, so `explain()` of a native plan makes one more
round trip. Collection `explain`, entity `explain` and `explainLoad` carry it;
`explainLoad` runs no other statement, so it answers a promise here and stays a
plain value on SQLite. It is an estimate and never a count: the planner prices
the statement from the table's statistics (`ANALYZE`) and errs in either
direction. A range over a member that is not indexed has no statistics to read
and is priced as a default fraction of the table, and an external operand or a
type test (above) keeps the discriminator `CASE`, which it can only price as a
constant. No profile bound reads it. The slot stays `'unavailable'` for a plan
the engine answers (`pushdown: false`, a document past the term bound, a
diverted external), for a statement a slot of which the call left unbound — the
statement `explain()` sends binds NULL there, which the planner prices as no
row — and on SQLite, whose bindings expose no per-statement estimate.

The committed [measurement](../../../benchmark/postgres-membership-result.json)
puts the bound, the regrouping and the estimate to a server at its own JIT
settings, which it reads and never changes. It runs chains of membership terms
of growing length (the plan each gets, the milliseconds it takes and the
engine's own time for the same chain), the same number of terms regrouped into
one list, the server's account of the native statements, and a small corpus of
statements whose estimates it sets against the rows they return. It pins the
SHA-256 of the planner, the emitter, the query compiler, the PostgreSQL dialect
and its own source, so `npm run docs:check` refuses it once any of them
changes, until it is measured again:

<!--fact:postgres.membership-->

Measured 2026-10-16T13:20:15.297Z: PostgreSQL 17.11 (Debian 17.11-1.pgdg12+2) (jit=on, jit_above_cost=100000, jit_inline_above_cost=500000, jit_optimize_above_cost=500000), Node 24.20.0, pg 8.23.0; 2000 documents in each table, analyzed first; the median of 31 calls after 6 warm-up calls; host load (one-minute average) 2.58 before and 2.61 after, on 16 cores.

One statement carries at most 128 leaf predicates. A chain of `$and` pairs (pairs) is not regrouped, so every term is a leaf; the same number of terms written as equalities on one member and ranges on another (regrouped) becomes one membership list and one bound.

| Chain | Terms | Leaf predicates | Plan | `execute()` ms | The engine alone, ms | Rows |
|---|---:|---:|---|---:|---:|---:|
| pairs | 50 | 50 | native | 2.21 | 10.08 | 25 |
| pairs | 100 | 100 | native | 2.71 | 13.30 | 50 |
| pairs | 200 | 200 | engine, `predicate.termBound` | 19.55 | same route | 100 |
| pairs | 400 | 400 | engine, `predicate.termBound` | 32.61 | same route | 200 |
| regrouped | 400 | 2 | native | 4.04 | 43.59 | 200 |

The native statements under `EXPLAIN (ANALYZE)`: the planner priced them at 147.29 to 288.37 against jit_above_cost=100000, the server planned them in 0.09 to 0.35 ms and ran them in 0.13 to 1.81 ms, and its JIT compiled 0 of the 3.

The planner's own estimate, `explain().budget.estimatedRows`, against the rows each statement returns:

| Statement | Estimated rows | Actual rows | Estimate / actual |
|---|---:|---:|---:|
| collection `people`: `$eq` on an indexed member | 200 | 200 | 1.00× |
| collection `items`: 8 unregrouped terms | 1 | 4 | 0.25× |
| collection `items`: 64 unregrouped terms | 11 | 32 | 0.34× |
| collection `items`: 400 regrouped terms | 1332 | 200 | 6.66× |
| entity `Item`: 8 unregrouped terms | 4 | 4 | 1.00× |
| entity `Item`: 64 unregrouped terms | 32 | 32 | 1.00× |
| entity `Item`: 400 regrouped terms | 1000 | 200 | 5.00× |
| `explainLoad` of `Item`: 8 unregrouped terms | 4 | 4 | 1.00× |
| `explainLoad` of `Item`: 64 unregrouped terms | 32 | 32 | 1.00× |
| `explainLoad` of `Item`: 400 regrouped terms | 1000 | 200 | 5.00× |
| collection `people`: an external the call leaves unbound | unavailable | 200 | n/a |
| collection `people`: an external bound to the value | 1 | 200 | 0.005× |

One host, client and server on one machine, one pooled connection beside one administrative one. Each table holds the documents above and was analyzed before the first call. Milliseconds are the median wall-clock time of the calls above, after the warm-up calls: the statement's construction, the round trip, the server's work and the decoding of the rows, with no commit. The engine column runs the same chain with pushdown: false, which fetches the collection and filters it in the engine. The server's JIT settings are its own and are never changed; the server view is EXPLAIN (ANALYZE) of each native statement. An estimate is the planner's own and never a count. No production latency claim.

<!--/fact-->

A physical keyset page compares its continuation as the stored values on
PostgreSQL as on SQLite — integer, bigint (bound as its exact decimal string,
which the server types from the column), text, and a native `uuid` column,
whose order is the code-point order of its lowercase text — and an identity
of NOT NULL terms in one direction compares as one row value
([MODEL-FORMAT §10.5](MODEL-FORMAT.md#105-pagination)), which the key's index
serves as its condition. A text term is the bare column where its collation
is a code-point one of the server's own, in `pg_catalog` (`C`, `POSIX`, `ucs_basic`,
`pg_c_utf8`, or the database default of a libc-provider database collated `C` or
`POSIX`; a collation a user made and named `C` elsewhere is not one) and
`((column)::text COLLATE "C")` otherwise: correct, and served by no index, as
`explainLoad().sql` shows; a builtin- or ICU-provider database default takes
that branch, because the catalog row the open reads carries no locale.
Predicates, join edges and grouping keep `COLLATE "C"` over every text column,
since two code-point columns of different collations compared bare resolve no
collation, and a collection group key an `$orderby` orders is read at its own
kind (`COLLATE "C"` for a string, `numeric` for a number) instead of from the
projected text, so neither the database's collation nor the digits of a number
decide the order. What does not seek: the page's `ORDER BY` spells the identity's
null placement (`ASC NULLS FIRST`), which is not the order an ascending index
provides, so the rows past the row value are sorted rather than read in index
order. A text keyset requires the `UTF8` database encoding, read at open — no
per-row byte proof runs here — and refuses `JD0032` naming any other. An
explicit `orderBy` over a text or uuid column with the `null` NULL policy stays
refused, as every such column is for the typed path.

The server types a bound literal from the column it is compared with, so an
integer past an adopted `smallint` or `integer` column's own width
(`qty < 3000000000` on an `integer` column) would be refused while the parameter
is read. A literal outside `smallint`'s range is therefore spelled
`($n)::bigint` against an `integer`-codec column: the btree integer family
compares `int2` and `int4` with `int8`, so the bare column's index still serves
the condition, and the comparison answers as the engine does on every operator,
through `execute`, `load` and `mutate` (`qty < 3000000000` is every present
row, `qty = 3000000000` none). A literal within `smallint` binds as itself. A
statement that addresses a row by its key — a point read (`get`), the row a
store rule reads locked, a tracked update or delete, `mutate({ key })` — spells
the key's parameter `($n)::bigint` against such a key column whatever the key,
so a key past the column's width (`get(3000000000)` on an `integer` key) names
no row, as the engine answers, and the primary key's index serves every key. A
fraction, an infinity and a magnitude past 64 bits are folded at plan time
([MODEL-FORMAT §10.1](MODEL-FORMAT.md#101-entity-query-documents)), and a membership list compares as
`numeric` whatever the column's width.

A duplicate key is the violation of the table's primary-key constraint under
the name the catalog gives it, read when the store opens: by the table probe for
a table the store owns (again after it creates the table, since the server
numbers a key name another relation holds), and from the catalog rows the open
already reads for a physical entity. A partitioned table keeps its rows in
partitions that each carry a key constraint of their own, and the server names
the partition's when it finds a key twice: the open reads the constraint of the
table and of every partition below it in the store's schema, so a partition
attached while the store is open reports `JD2005` naming its own until the next
open. A table renamed by a migration, an adopted
table whose key has any name and a table with a unique member called `pkey1`
therefore answer `JD2001` for a duplicate key and `JD2005` naming the member
for a duplicate member. A write that collides on its key and on another unique
member is `JD2001` too: the server checks the oldest index of a table first,
and the store creates the key's index first. One difference remains, on a table
the store adopted rather than created: where a unique index is older than the
primary key, the server reports that index first, and a write colliding on both
reads `JD2005` naming it. A PostgreSQL failure aborts its transaction, so the
store never reads the key after one; on SQLite it does, after a unique failure
that does not name the key.

A number group key or distinct leaf is read as PostgreSQL's exact `numeric`,
so a number a foreign writer or trusted SQL stored with more digits than a
double holds (`1.0000000000000001`), or two spellings of one denormal, groups
apart where the engine, which compares doubles, holds them equal. Every number
the store itself writes is canonical, so the store's own data groups as the
engine groups. Reading the key as `double precision` was measured and made
every number grouping slower, so it is not done.

An entity's `integer` and `number` columns are `numeric`, which holds an
integer past 2^53 exactly. An `integer` member read from its column is refused
`JD2003` (class `data`, the reason SQLite's refusal of an integer its driver
cannot hand over carries) when the JavaScript number it reads as would round
it: the number is neither the stored integer nor spelled by its digits, as
`9007199254740993` written by trusted SQL is — kept with a scale too
(`9007199254740993.0`, which a retype from text leaves), since the digits
before the point are the integer. Every integer within
±(2^53 − 1), every integer a double holds exactly and every integer a
JavaScript number wrote (2^60 is stored as `1152921504606847000`) reads as the
number, so the store's own data reads as before. SQLite refuses every integer
past ±(2^53 − 1) its `INTEGER` column holds, the store's own writes included;
PostgreSQL refuses only the read that would change the value. A `number`
member reads the double nearest to its column's value, as SQLite's `REAL`
column holds it, and so does a `numeric` a statement computes (an aggregate, a
cast of a document member), as the engine reads the member it comes from. The
driver tells a stored value from a computed one by the table the server names
for a result column; a client that names none reads every `numeric` as the
nearest double. The refusal is made where a row is read whole (`get`, `load`,
`page`, a query that returns the entity) and where a native statement projects
the `integer` member (`$return: '$it.v'`, or a constructor of it); an included
child and change capture still read such a value as the nearest double.

## The writer lock and the lock family

`store.transaction(fn, { mode: 'immediate' })` runs `BEGIN`, then takes the
store's writer lock — `SELECT pg_catalog.pg_advisory_xact_lock(1246907984, …)`
keyed by the current schema's OID — and only then runs the body. Two
immediate transactions on two Stores of one schema therefore run one after
the other, and a read-then-write body cannot lose an update to the other:

- at `read committed`, the server default, every statement reads a fresh
  snapshot, so the body that waited reads the commit it waited for — two
  concurrent increments of `n = 0` leave `2`, with no retry;
- at `repeatable read` and `serializable` the snapshot is taken by the lock
  statement itself, before the wait, so the waiter reads the old value and
  its write fails 40001 — busy and retryable, which `retry` absorbs.

The lock is advisory: it orders immediate transactions among themselves
only. A plain collection write, a keyed write's convergence, a relational
write or a deferred transaction takes the row locks it needs and never
waits for it, so no plain write serializes every writer. A wait is bounded
by the session's `lock_timeout` (the driver's `lockTimeoutMs`, 5 seconds by
default): past it the wait fails 55P03, which is `JD2005`, busy and
retryable, and the refused transaction is rolled back before the session
serves anything else. The wait is not counted against `holdTimeoutMs`,
whose clock starts when the body does.

`isolation` (MODEL-FORMAT §5.1) is a floor. A transaction that asks for no
level runs a plain `BEGIN` at the session's `default_transaction_isolation`,
read at open (`capabilities.postgres.defaultIsolation`); one that asks runs
`BEGIN ISOLATION LEVEL …` at that level, or at the session's own when an
operator raised it higher, and `tx.isolation` reports the level that ran.

Every advisory lock the store takes is a class of one family (`0x4A524E__`,
the first key) and is keyed by the session's current schema (the second
key) — the store's own, once the driver has set its search path. The writer
and owner locks key the schema by its OID (looked up by exact name, shifted
into `int4`), which no two schemas share. The migration, capture and jobs
locks key it by `pg_catalog.hashtext(current_schema())`, as stores of earlier
releases do: two releases migrating one schema must meet on one lock, so those
keys stay as they are, and a 32-bit hash two schema names can share makes two
such schemas wait for each other there — a wait, never a wrong answer:

| Class | Lock | Held for | Taken |
|---|---|---|---|
| `1246907982` | migration | the transaction | by a native migration run, before it reads its receipts |
| `1246907983` | capture | the transaction | by a captured write, before the journal allocates its high-water |
| `1246907984` | writer | the transaction | by `mode: 'immediate'`, before the body runs |
| `1246907985` | owner | the store's session | by `openStore(model, { owner })`, until `close()` or the session ends |
| `1246907990` | jobs | the transaction | by the job queue's catalog initialization |

Two classes never contend, and two schemas never contend for the writer or
the owner lock. An immediate
transaction on a capturing Store takes the writer lock first and the
capture lock right after it, as its capture scope opens; nothing takes
them the other way round, so the two cannot deadlock. The owner lock is session-scoped: it is
taken with `pg_try_advisory_lock` at open (a held lock refuses `JD2061`),
and released explicitly at `close()` — before the driver restores the
session's search path and returns it to its pool, which a session lock
would otherwise outlive — or by the server when the session ends; a
session whose release could not run is destroyed rather than pooled. An
adopted Store takes it too: it needs no table.

## Several sessions per Store

A Store holds one session unless it is opened with `sessions: N`
([MODEL-FORMAT §5.1](MODEL-FORMAT.md#51-transaction-ownership)). On one session
every root call and transaction waits its turn behind the one in progress, so a
server answering many users from one process runs their commits one after
another. With N sessions each root call or transaction checks out a session of
its own and the server works on N of them together: conflicts between them are
the database's (a serialization failure or deadlock is busy and retryable, and
immediate transactions take the writer lock in turn). The store's own unit of
work stays on the first session, one call at a time, every transaction has its
own, and a paused cursor holds one session rather than the store. On a store
with capture, every transaction — a root write included, and a transaction that
only reads — takes capture's allocation lock when it begins and holds it to its
end, so they run one at a time; root reads, which open no transaction, gain the
concurrency. Replication runs on one session.

Lost sessions are removed from admission and are never replaced inside the
same Store. Unpinned work can continue on surviving sessions. If the first
session is lost, the Store's own tracked unit of work refuses `JD2087`; an
owner lock is tied to that session too. Close and reopen the Store to restore
those facilities. This does not authorize replaying an uncertain write or
reusing an old transaction handle.

The committed [measurement](../../../benchmark/postgres-sessions-result.json)
compares one Store on N sessions with N Stores of one session each; the last
column is what being one Store costs (below 1×) or gains (above):

<!--fact:postgres.sessions-->

Measured 2026-10-15T10:31:22.538Z: PostgreSQL 17.11 (Debian 17.11-1.pgdg12+2) (fsync=on, synchronous_commit=on, full_page_writes=on), Node 24.20.0, pg 8.23.0; 8 clients at once, each 40 one-document write transactions on keys of its own; the median of 5 rounds, each measuring every shape once.

| N | One store on N sessions, tx/s | N stores of one session, tx/s | One store over N stores |
|---:|---:|---:|---:|
| 1 | 1248 | 1232 | 1.01× |
| 2 | 2630 | 2689 | 0.98× |
| 4 | 4933 | 5016 | 0.98× |
| 8 | 7134 | 7268 | 0.98× |

One transaction with nothing beside it: 0.773 ms on a store of one session, 0.830 ms through the router of a store on two (7.4%). A store on one session has no router.

One host, client and server on one machine; each client a run of one-document transactions on keys of its own (no conflicts), every commit durable, so it waits on a disk the host shares with whatever else runs there. A store on one session runs them in turn; several sessions and separate stores let the server work on them together. No production throughput claim.

<!--/fact-->

## Select the backend at build time

[`backend-entry.js`](../../../test/consumer/backend-entry.js) is an executable
example. A literal `process.env.JAREN_BACKEND` build define selects `sqlite` or
`postgres`; `process.env.JAREN_RUNTIME` selects `node` or `bun`. The application
composition stays in one module. For example, an esbuild configuration selects:

```js
const define = {
  'process.env.JAREN_BACKEND': JSON.stringify('postgres'),
  'process.env.JAREN_RUNTIME': JSON.stringify('node'),
};
```

The PostgreSQL branch imports a host-installed `pg`, injects its pool into
`postgresDriver`, and passes that driver to the same application. The local branch
uses `nodeDriver` or `bunDriver` and an owned SQLite path. Use the bounded
`resnapshot` live mode when the application should work on either backend.
Provision tenant schemas separately; the example creates synthetic schemas solely
for its oracle. Select explicit physical mappings when existing storage differs.

The installed qualification recipe is:

```sh
HOST_CONSUMER_OUTPUT=/tmp/backend-consumer npm run test:packed:release
# Set JAREN_PG_URL to an owned disposable server before this command.
npm run test:backend-executables -- /tmp/backend-consumer
```

Choose a fresh output directory. The gate builds both SQLite executables before
installing `pg`, checks that emitted SQLite inputs exclude the PostgreSQL driver
and client, then builds PostgreSQL executables. It removes source and modules
before running all four relocated Linux binaries. An opposite runtime environment
value cannot override the compiled backend. Node SEA and Bun compilation reuse
[`standalone.js`](../../../scripts/lib/standalone.js). The host owns compiler and
native toolchain distribution; no compiler or `pg` dependency enters public packages.

Each binary verifies exact decimal text, permanent command replay, current
authorization, tenant refusal, rollback exclusion, jobs/checkpoint fencing, feed
resume, replication duplicates/no echo, live cleanup and a second reopen. These
are generic managed-data applications, separate from the existing physical SQLite
adoption journeys and from any downstream product migration.

## Logical backup and restore

Use an operator-owned complete database backup with compatible PostgreSQL tools.
Business tables alone are insufficient: retain model/migration history,
capture high-water/log, job leases/checkpoints, replica identity, causal state and
receipts in the same consistent snapshot. Stop delivery during cutover and fence
the previous writable owner before restoring its replica identity.

[`check-postgres-operations.js`](../../../scripts/check-postgres-operations.js)
qualifies this recipe against a disposable loopback Docker server selected by
`JAREN_PG_URL` and `JAREN_PG_CONTAINER`. It confirms that the SQL endpoint and CLI
tools address the same cluster, creates two owned empty databases, runs the
server's `pg_dump --format=custom --no-owner --no-privileges`, and restores with
`pg_restore --single-transaction --exit-on-error`. CLI subprocesses have finite
time/output limits. Run `npm run test:postgres:operations` after setting those
host variables; cleanup removes only databases created by this invocation.

Before opening Store, an independent bounded SQL oracle compares all tenant
tables, columns, indexes and sequence state. It deliberately omits each populated
metadata table in a rolled-back transaction to prove that restored business rows
alone cannot pass. Public APIs then verify history, exact values, feed positions,
durable duplicate receipts and a reclaimed job/checkpoint through two reopens.
A write after the backup is absent. Roles/ACLs, tablespaces, host keys and storage
encryption are operator responsibilities excluded by this fixture.

See the PostgreSQL [SQL dump guidance](https://www.postgresql.org/docs/18/backup-dump.html),
[`pg_dump`](https://www.postgresql.org/docs/18/app-pgdump.html) and
[`pg_restore`](https://www.postgresql.org/docs/18/app-pgrestore.html).

## Archived WAL and point-in-time recovery

Run `npm run test:postgres:recovery` on a Docker host. The runner uses the pinned
17.11 image and a unique Compose project with owned data/archive/recovery volumes.
Its ports default to 55460/55461; override `JAREN_PG_RECOVERY_SOURCE_PORT` and
`JAREN_PG_RECOVERY_TARGET_PORT` when needed. It takes a base backup before any
application table exists, enables durable WAL archiving, commits the complete
fixture, creates a named recovery point, and commits a later write. It waits for
the target WAL to be archived, stops the source, and promotes the restored owner
at that named point. The same independent metadata and public API oracle runs
before the unique project and volumes are removed.

Physical sequence allocation can advance during WAL replay. The oracle requires
unchanged definitions, no allocation rewind and fresh identifiers above restored
allocation; it still requires exact table rows and application feed/causal clocks.
It never rewinds sequence counters to make a snapshot appear identical. PostgreSQL
[sequence semantics](https://www.postgresql.org/docs/17/functions-sequence.html)
permit gaps. Follow [continuous archiving guidance](https://www.postgresql.org/docs/18/continuous-archiving.html)
for production retention, monitoring, recovery targets and fencing. This fixture
does not prove actual power loss, arbitrary failover infrastructure, distributed
provider effects or an operator's recovery-time objective.

PostgreSQL maintenance uses its own diagnostics, VACUUM/ANALYZE and operator
monitoring. SQLite checkpoint/integrity/optimize/backup methods are not aliases for
those operations. A lost commit reply remains unknown until a durable receipt
settles it; neither killing a client nor inspecting WAL invents a logical request ID.

## Measurement and release scope

The committed [binary evidence](../../../benchmark/backend-executables-result.json)
records per-package integrity and binary hashes:

<!--fact:postgres.executables-->

linux/x64, 13 locally packed public packages; local npm pack; not registry publication.

| Backend | Runtime | Binary bytes | Application ms | Sampled RSS / heap MiB | Raw process max RSS MiB |
|---|---|---:|---:|---:|---:|
| sqlite | node 24.20.0 | 128453824 | 75.29 | 68.52 / 14.48 | 208.97 |
| sqlite | bun 1.4.2 | 83174880 | 61.67 | 55.69 / 6.87 | 208.98 |
| postgres | node 24.20.0 | 128650432 | 396.77 | 83.13 / 17.63 | 86.29 |
| postgres | bun 1.4.2 | 83420640 | 371.88 | 72.80 / 9.15 | 86.29 |

Sampled process RSS/heap, and raw resourceUsage maxRSS including launcher history. Not app-only peak, not server memory, and not an isolated backend comparison.

<!--/fact-->

The [operational evidence](../../../benchmark/postgres-operations-result.json)
records matching tool versions and each recovery assertion:

<!--fact:postgres.recovery-->

| Logical backup / restore server | Tables / rows | Archive bytes | Omitted metadata cases detected | Elapsed ms |
|---|---:|---:|---:|---:|
| 16.15 (Debian 16.15-1.pgdg12+2) | 14 / 16 | 27443 | 10 | 1157.22 |
| 17.11 (Debian 17.11-1.pgdg12+2) | 14 / 16 | 27863 | 10 | 1099.73 |
| 18.6 (Debian 18.6-1.pgdg12+2) | 14 / 16 | 27802 | 10 | 1109.42 |

Archived WAL: 17.11 (Debian 17.11-1.pgdg12+2), 14 tables / 16 rows, 7426.68 ms; source stopped before promotion: true. Physical sequence advances are retained in the result. Power loss and fleet failover were not tested.

<!--/fact-->

The [portable cost table](../README.md#what-postgresql-costs) records the current
measurement, including costs that increased. Native cursor reads require multiple
SQL submissions for transaction/cursor lifetime. Memory samples exclude server
memory and include runtime/launcher history; they are not application-only peaks.
Resource history in [`adoption-memory-history.json`](../../../benchmark/adoption-memory-history.json)
retains earlier Bun memory-budget losses even when a later sample passes.

<!--fact:postgres.adoption-resources-->

| Existing SQLite adoption executable | Workload | RSS bytes | Frozen reference bytes | RSS disposition |
|---|---|---:|---:|---|
| bun-executable | catalog | 250380288 | 536870912 | within reference |
| bun-executable | archive-stock | 970162176 | 1073741824 | within reference |
| node-executable | catalog | 268124160 | 536870912 | within reference |
| node-executable | archive-stock | 830304256 | 1073741824 | within reference |

These larger physical SQLite workloads are separate from the small build-selected managed application. Functional recovery success does not imply memory-budget success. Earlier samples remain in the resource history.

<!--/fact-->

Local tarball versions and integrity records prove the installed bytes tested.
A Git tag or website deployment does not prove npm registry publication. Record
registry version/integrity separately when selecting packages for deployment.
Original product upgrades, native operating systems beyond tested Linux, manual
accessibility/input behavior and actual provider acceptance need their own evidence.
