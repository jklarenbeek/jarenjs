# The Jaren live format — change capture and live queries

This document is normative. The key words MUST, MUST NOT, SHOULD and
MAY are to be interpreted as described in RFC 2119.

Change capture and live queries are ONE story — patches out — and
share this document. This order writes §§1–6 (capture); live queries
continue at §7. Error codes join the package's single runtime table
(MODEL-FORMAT §7), never a per-document list.

## 1. Scope

Every committed write to a store opened with `capture` produces an
observable, ordered stream of **RFC 6902 patches** describing what
changed — derived from SQLite's own session changesets where the
binding has them, from a write-path journal where it does not. One
diff format then runs end to end: store → patch → live query → patch
→ O(k) render. The patches MUST be consumable by
`applyJSONPatch` from `@jarenjs/json/patch`, unmodified.

```js
const store = await openStore(model, {
  driver: nodeDriver(),
  capture: { mode: 'auto', log: { retention: 1000 } },
});
const stop = store.observe(({ seq, at, source, collections, patch }) => {
  // one record per committed transaction, in commit order
});
```

Capture is **opt-in per store** — it costs a transaction wrapper and
(in session mode) a session per commit; the measured overhead is
published with the benchmarks, not waved away.

## 2. The pointer contract

Every op's `path` is `/<table>/<key>/<path…>`, each token escaped per
RFC 6901 (`~` → `~0`, `/` → `~1`):

- `<table>` is the collection, entity or join-table name.
- `<key>`: a SINGLE key renders as its scalar text (integers in
  decimal); a COMPOSITE key renders as the JSON text of its parts
  array (`["ada","math"]`), then escaped as one token. The encoding is
  deterministic: parts appear in declared key order.
- `<path…>` is the document-relative remainder, RFC 6901 as always.

The contract is stable — consumers depend on it. Join-table rows are
tiny documents under the join table's name (`/Label_User/["admin","u1"]`
→ `{ "Label_key": "admin", "User_key": "u1" }`, columns in the sorted
pair order): membership changes are part of the stream, not a blind
spot.

**Op order within a record is UNSPECIFIED.** A commit carries one net
op per row (SQLite sessions coalesce insert+update, drop
insert+delete, omit no-op updates — and the journal mirrors that
discipline), every op targets a distinct pointer, and the record
applies correctly in any order. The two capture modes MAY order the
same ops differently; they MUST agree as sets.

## 3. The op mapping

| Row change | Patch |
|---|---|
| INSERT | `add` at `/<table>/<key>` with the full document (mapped columns folded back: booleans as `true`/`false`, SQL `NULL` absent, derived epoch columns skipped — the document string is authoritative) |
| DELETE | `remove` at `/<table>/<key>` |
| UPDATE, document column changed | old JSONB diffed against new (`createJSONPatch`) → minimal nested ops under `/<table>/<key>` |
| UPDATE, mapped scalar/foreign-key column changed | property-level op at `/<table>/<key>/<property>`: `replace` (both present), `add` (was `NULL`), `remove` (now `NULL` — absent per MODEL-FORMAT §9.3) |
| join-table INSERT / DELETE | `add` / `remove` of the membership row document |

Changesets (not patchsets) are used because they carry OLD values —
that is what makes the minimal nested diff and the add/remove/replace
discrimination possible; the price is a larger in-memory blob per
transaction, stated here. Integer values beyond ±2⁵³ convert lossily
to JS numbers (a raw-SQL concern only; JS documents cannot produce
them).

## 4. Capture modes and their limitations

`capture.mode` is `'auto'` (default), `'session'` or `'journal'`;
`store.capabilities.capture` reports what actually runs
(`'session'`, `'journal'` or `'none'`).

- **`session`** — SQLite's session extension records row changes at
  the storage layer: every write through this connection is seen,
  including future raw-SQL surfaces. Requires the binding to expose
  `createSession` (node:sqlite does; **bun:sqlite does not**; a wasm
  build may not). Sessions are per COMMIT, never long-lived (an
  unbounded session is a memory leak); a rolled-back transaction —
  and a rolled-back savepoint inside a committed one — contributes
  nothing (probed and pinned by test).
- **`journal`** — the write path itself emits records: the store
  already knows what it wrote. **Less complete, stated plainly**: it
  cannot see writes made through raw SQL, triggers, or another
  connection; a journal-mode delete of a row the store never read
  emits its `remove` without having seen the old document; a keyed
  `put` reads the stored document first, so it emits the `replace`
  session mode emits and a `put` that changes nothing emits nothing.
  It reconstructs the database's own `ON DELETE` actions: before a
  store delete runs it reads the rows the declared foreign keys will
  remove or null — descendants through `onDelete: 'cascade'` at every
  depth, the foreign-key member of `'setNull'` rows, the membership
  rows of every removed row — locking them where the engine locks rows,
  and records them once the delete removed its row (a row both nulled
  and removed is recorded as removed; a delete the database refuses
  records nothing). For writes
  made through the store API within those bounds the two modes MUST
  produce the same op sets — proven by a differential test.
- Requesting `mode: 'session'` on a driver without sessions is a
  `TypeError` at open — an application that needs completeness can
  refuse to start rather than silently miss changes.

Node worker, worker-pool and process Stores expose no sessions. Their `auto`
mode selects `journal`; explicit `journal` plus `log` supports asynchronous
`changes.page()` with finite row/byte limits, rollback exclusion, retention
resets and resume after reopen. Opting into `asyncLive()` adds bounded
`resnapshot` live maintenance (§12.1); without it `live` remains false. The public
host matrix and delivery recipe are in [HOSTS](HOSTS.md#async-sqlite-jobs-and-committed-feeds).

### PostgreSQL managed journals

PostgreSQL supports `auto` → `journal`, optional durable `log`, bounded
`changes.page`, and process-local `observe`. Sessions remain unavailable;
explicit session mode refuses with `TypeError`. `asyncLive()` enables the shared
resnapshot registry (§12.1); synchronous incremental maintenance is unavailable.
Managed replication is a separate capability.

Participating captured transactions take a schema-scoped transaction advisory
lock before reading journal before-images, including absent rows. This
serializes captured transactions within that schema and preserves the patch
sequence when writers update the same document. A slow transaction delays
other captured writers under the configured finite lock timeout. The durable
high-water row is allocated and the log pruned in the same transaction as the
business writes; a rollback rolls back both. A transaction begun earlier can
reach that lock later and commit later: consumers resume by committed sequence,
never transaction start time or wall-clock timestamps. Sequence overflow
refuses before commit rather than persisting an imprecise continuation.

The journal observes Jaren-managed API writes made with capture enabled.
Other connections must also participate through that API for their writes to
appear in the same log. Arbitrary SQL and custom triggers are not enrolled;
the foreign-key actions of a captured delete are (§4). Physical-table
adoption refuses capture; trusted SQL writes refuse while capture is active.
Use an explicit schema on
the driver; the driver puts it before `pg_temp` and restores the original
search path before releasing the session. Host-provided unscoped search paths
and external schema changes remain the host's responsibility.

Optional `postgresDriver(source, { schema, notifyChannel })` sends an empty
transactional notification after persisting each nonempty patch. It requires
`capture.log`. `postgresNotifications(listenerSource, { channel })` owns a
separate session and returns an async iterator of coalesced `null` wake tokens.
There is one pending pull and at most one retained token. After initial LISTEN
and every successful reconnect, it emits a token so the consumer re-reads the
durable log from its saved cursor. Its lifetime reconnect budget is finite;
terminal connection failures reach the pending/next pull. Close drains a
pending pull, removes its LISTEN registration and restores the borrowed session
before reuse; failed cleanup discards the session and is reported.

Notifications carry no records or authorization and are visible to database
users. Notification loss or coalescing does not remove durable records. Persist
the returned `next` only after processing a page, handle `resetRequired` by a
bounded resnapshot, and poll durable pages independently when prompt recovery
is required. Never substitute `highWatermark` for the last processed `next`.
The host owns channel allocation, tenant authorization, durable checkpoints,
resnapshot policy and the lifetime of both pools. A listener needs a dedicated
session lease with `on`, `off`, `query` and `release`; an already registered
channel refuses rather than taking another owner's registration.

These semantics follow PostgreSQL's
[LISTEN startup ordering](https://www.postgresql.org/docs/17/sql-listen.html)
and [transactional notification contract](https://www.postgresql.org/docs/17/sql-notify.html).
The native journal tests include reversed start/commit order, concurrent first
open, before-image consistency, rollback/log failures, retention, process
restart, disconnect recovery and listener disposal.

## 5. The persisted log and retention

With `capture.log`, each record is appended to `_jaren_changes`
**inside the same transaction** as the writes it describes — an
observer crash cannot lose a committed record, and a late joiner
reads forward:

```js
const records = await store.changesSince(lastSeq);  // JD2051 when no log
```

`seq` is monotonic; with the log enabled the DATABASE allocates it —
one statement, inside the write's own transaction, advances a durable
singleton row (`_jaren_changes_state`, the highest sequence this file
ever allocated) and reads the new value back through `RETURNING`, and
the record is then inserted under it — so two stores over one file
never collide on the log's key, each sees the other's sequence continue,
and a write that rolls back takes its allocation back with its row. The
state row is engine metadata: it is created beside the log, seeded once
from an existing file's surviving `MAX(seq)` (0 for a file that never
held a row; a later open changes nothing), never lowered, never pruned,
and never a capture, live, model or migration subject. Without the log,
`seq` is per-process. `changesSince`
answers records in the shape observers receive, `collections`
included; a cursor that is not a number is a `TypeError`, as is a
`retention` that is not a positive integer. Retention is
a bounded count (`retention`, default 1000): older rows are pruned in
the same transaction — every write deletes the records more than
`retention` behind the one it just appended, and nothing else prunes
the log. The log is an ordered, replayable stream — which is what
makes a late-joining consumer possible.

**`changesSince` is unbounded, and unsafe for a reconnecting
consumer.** It answers every surviving record in one array, with no
limit, no byte bound and no watermark: a consumer whose last `seq` fell
below the retention floor receives the suffix that happens to survive
and cannot distinguish "everything you missed" from "some of what you
missed, and the rest is gone" — it believes itself caught up with a
hole in its state. It stays as a published member, and it is not the
supported path for a consumer that reconnects.

**The bounded reader: `store.changes`.** Present exactly when the log
is enabled (`JD2051` otherwise, as `changesSince`).

- `changes.bounds()` answers the two watermarks: `earliestAvailable`,
  the earliest surviving sequence (`MIN(seq)` over the log; `null` when
  nothing survives), and `highWatermark`, the highest sequence the FILE
  ever allocated, read from the durable state row — so a log that
  retention emptied, reopened in a new process, still answers
  `{ earliestAvailable: null, highWatermark: N }` and a cursor below `N`
  meets `resetRequired` rather than a plausible empty history. Both are
  the file's facts, never a process counter or a clock; cheap, and what a
  consumer needs before it decides whether its cursor is usable.
- `changes.page({ after, limit, maxBytes, signal })` answers
  `{ items, next, earliestAvailable, highWatermark, hasMore,
  resetRequired }`. `after` is the last sequence seen and is required:
  there is no legitimate "give me everything" for a change log. The
  page never holds more than `limit` records (default 100, applied as
  SQL `LIMIT`) nor more than `maxBytes` serialised patch bytes,
  accumulated at record boundaries; a single record larger than
  `maxBytes` is the refusal `JD2074` without advancing `next` — the
  same rule and the same implementation an entity page uses
  (MODEL-FORMAT §10.5). `hasMore` is decided by one peek past the
  page; `next` is the sequence to continue from (`after` itself when
  nothing was delivered); `signal` cancels at a record boundary
  (`JD2072`).
- **`resetRequired: true`** when the record after `after` no longer
  survives — `after + 1 < earliestAvailable` (or the log is empty
  above `after`'s successor). Then `items` is **empty** and `next` is
  **absent**: the refusal is total, because a partial suffix beside a
  reset flag would invite a consumer to use both. The watermarks are
  read after the rows, so a floor that rose during the read can only
  make the verdict stricter, never let a pruned gap pass as a
  continuation.

**The consumer's recovery procedure**, in words: keep the last `seq`
you applied; on reconnect, call `changes.page({ after: lastSeq })` and
apply pages while `hasMore`, storing `next` as you go; when a page
answers `resetRequired: true`, stop applying — your state has a hole —
re-seed it from a full snapshot of the collections you follow, and
resume paging from that page's `highWatermark`, because every record
at or below it is already reflected in the snapshot you just took.
Choosing how much history to keep is the host's decision
(`retention`); what the reader owes is that when rows go, it reports
the gap instead of hiding it.

**The log alone is not replication.** Replica identity, causal frontiers,
durable receipts, conflicts and bounded reset snapshots belong to the opt-in
[replication subsystem](REPLICATION-FORMAT.md). Its protocol builds on these
watermarks; a change-log cursor by itself supplies no conflict policy or causal
ordering across writers.

## 6. Cross-connection behaviour and non-claims

Another process (or another connection) writing to the same file
produces NO local patches — sessions and journals are per-connection
facts. The honest mitigation is a coarse signal, not a pretend
fine-grained one: `store.dataVersion()` reads `PRAGMA data_version`,
which changes when ANOTHER connection commits; poll it and treat a
change as "re-read what you care about". Cross-tab delivery is §7's
story (the live-query layer).

Capture-layer non-claims: no conflict resolution or capture of writes made
by other connections, no capture on stores
opened without `capture`, and no statement-level ordering within a
commit (§2).

## 7. Live queries: the maintenance table

A live query is a registered query document whose result is
**maintained** as committed writes arrive, emitting RFC 6902 patches
against its own result document (§9). Registration:

```js
const live = await store.collection('users').live(document, {
  externals: {},          // fixed at registration (§8)
  mode: 'auto',           // 'auto' | 'incremental' | 'rerun'
  eventTime: undefined,   // a temporal view's watermark (§13)
});
live.result;              // the maintained result document
live.mode;                // { strategy, mode: 'incremental'|'rerun'|'resnapshot', reason }
const stop = live.subscribe(({ patch, seq, error }) => { /* … */ });
live.close();
```

`store.live(document, options)` registers an entity-root document (the
multi-entity shape of MODEL-FORMAT §10) the same way. A document that
ranges over no entity array is `JD0033`, as `store.execute` refuses it —
a load specification (`load({ include })`'s argument, which a
`@jarenjs/linq` `include()` chain builds) is one: a graph is maintained
as the entity-root projection the table below names. Live queries
REQUIRE change capture — the patch stream is the invalidation source —
and registering on a store opened without `capture` is `JD0050`. Both
registrations run under the store gate through their **initial query**
(MODEL-FORMAT §5.1): a registration made while another transaction is
open waits for it to settle and initializes from committed rows only, a
rolled-back row never reaches `result`, and a refused registration
leaves `stats().liveQueries` unchanged. A registration made from INSIDE
a transaction view initializes from that transaction's rows and shares
its fate — kept and maintained on commit, closed on rollback. Once
registered, the handle is maintained by committed writes alone and takes
no gate of its own. `changes.page()` takes the same `deadline` every
other page does (`JD2075` at a record boundary).

A producer may hand a registration a CHAIN instead of a document: the
`@jarenjs/linq/db` client's `live(chain, options)` passes the chain's
`toDocument()` and its `explain().bindings` as the externals to exactly
these two registrations (`store.live` for an entity-root chain,
`collection.live` for a collection's), so the strategy, the reason and
the maintenance are this table's, and this document stays the only place
they are decided. An entity chain is classified like any entity
document: a `where` chain over one entity whose filter the entity
planner translates is maintained as `join`; the bare set, whose document
is the path `$.<Entity>[*]` and not a FLWOR, and a chain that orders or
windows re-run with the reason named; an `include()` chain is a load
specification and `JD0033`.

**This table is normative.** Every row is implemented and tested;
nothing outside it is attempted. Classification combines canonical document shapes with the compiled selection
plan; "extractable" below means what the pushdown planner already proves. The table is what a synchronous
connection maintains (`@jarenjs/db/node`, `@jarenjs/db/bun`, `@jarenjs/db/wasm` over a synchronous handle); over an asynchronous one —
PostgreSQL, or SQLite in a worker, a pool or a process — every registration is a resnapshot whatever its shape
(with the `asyncLive()` helper and durable capture; without them it is `JD0051`), and a demanded
`mode: 'incremental'` is `JD0051` (§12.1).

| Construct (as planned) | Strategy | Maintained state |
|---|---|---|
| `where` whose predicates translate (the plan's filter) and read no collection root, no order, no aggregate | **incremental rows**: per-row re-evaluation; insert / remove / replace in the result | the result rows |
| the same with a per-row `select` projection (row-mode plan) that reads no collection root | **incremental rows**: the affected row alone is recomputed; a source row may project to several items | result rows, grouped by source key |
| `orderBy` over extractable paths, an optional literal offset and limit (non-negative integers, written as numbers or quoted with `$const`; nested windows compose as the planner composes them, the innermost first), and a return that yields at most one item per row, reads no collection root and compiles without the store's registered operators | **maintained window**: a sorted structure over every matching row, the visible rows the `limit` after the first `offset`; ties broken by the collection key's text in code-point order — for a numeric key `10` sorts before `9`, which can differ from `execute`, whose ties follow row identity (declare the key as the last `orderBy` term for one tie order everywhere); an insert sorting beyond a full window is a no-op, one sorting above the offset shifts the visible rows. The window orders schema-conformant sort values: a stored `null`, or numbers beside strings, is outside that contract — the engine refuses to order it (`JQ2005`), SQL ranks a `null` where `$empty` puts an absent value, and the window ranks numbers before other values in the term's ascending order and the rest by their text | every matching row and its sort values, each an entry — the rows before the offset included (§12) |
| whole-query `count` / `min` / `max`, and `sum` / `avg` over an `integer` member (the plan's aggregate), optional `where` | **running accumulator** plus a per-row contribution map — a delete can only be answered from retained contributions (§3: a `remove` carries no old value). `min`/`max` removal of the last extremum holder FALLS BACK to a recompute over the retained contributions; the accumulator alone cannot answer, and this fallback is the documented cost. Every aggregate but `count` skips a stored `null` term, as SQL does; a `sum` or `avg` answers from its terms only while the largest magnitude times the number of terms stays within ±(2^53 − 1) — the guard the query path checks; a term that is not an integer, which an `integer` member stores as given, counts as past it — because past it a fresh run adds left to right in the order it reads the rows (or SQL compensates a non-integer term's rounding), so from the write that crosses it the registration re-runs and `live.mode` says so (`{ strategy: 'rerun', mode: 'rerun', reason: "'accumulation' — integer accumulation exceeded its runtime exactness bound" }`; under a demanded `mode: 'incremental'` that write errors it `JD0051`, and a registration already past the bound refuses `JD0051`; beside a stored `null` term the re-run raises `JQ2001`, as `execute` does) | one contribution per matching row |
| whole-query `sum` / `avg` over a `number` member | **re-run on invalidation**, the reason `plan.floatingAccumulation`: the answer is the engine's left-to-right addition over the matching rows in collection order, which a running accumulator would not reproduce, so every invalidation re-runs the whole document | the previous result, for diffing |
| whole-query `count` over a constructor with an operator (an object or array of member paths, literals and operators that cannot raise, at least one an operator: the plan's statement is one `COUNT(*)` that evaluates no constructor) | **re-run on invalidation**: one statement of one row, where a running accumulator would retain a contribution for every row to answer it, so no number of rows refuses the registration (`live.maxMaintained`, `JD2060`); a demanded `mode: 'incremental'` is `JD0051` | the previous result, for diffing |
| single-level `groupBy` with one or more keys and any return that reads only the group — its keys, its rows, externals — with no ordering, window or global read (the group form below), alone or as a group emission — `@jarenjs/linq`'s one `groupBy` followed by `select`/`where` steps (below) | **group maintenance**: reevaluate affected groups through the engine in source-row order; first surviving source occurrence determines group order | source documents and group outputs, with entry and byte credits — a return that copies rows charges their bytes again inside its output |
| unordered SQL-native typed scalar distinct projections | **distinct maintenance**: keep the source holders of each value; deleting its earliest holder may move the value in first-occurrence order | source documents and unique outputs, with entry and byte credits |
| count/sum/avg/min/max over unwindowed single-level groups or group emissions | **group maintenance** followed by an engine fold over the retained group outputs in first-occurrence order | source documents and group outputs, with entry and byte credits |
| ordered or windowed distinct, ordered or windowed groups, aggregates over windowed groups and any other aggregate over groups | **re-run on invalidation** | the previous result, for diffing |
| `where` whose spatial predicate is **refined** (the plan pushed a bounding-box or cell-range pre-filter and left the exact `$within`, bounded `$distance` or over-long cell prefix to the residual — `explain().prefilters` with `exact: false`), no order, no aggregate; optional per-row `select` | **incremental rows** — the geofence: the initial fetch narrows through the derived index, and every touched row is re-evaluated by the engine's EXACT predicate, so a point emits `add` when it enters the region, `remove` when it leaves, and nothing while it moves within (a whole-document return sees a `replace` carrying the new position) | the result rows |
| a refined spatial predicate over a collection with **no document key** (`key: null`, rowid identity) | **re-run on invalidation** — the per-row strategy tracks a row by its declared key, and a rowid is not one; the reason says `rows without a document key cannot be tracked` | the previous result, for diffing |
| `orderBy` beside a refined spatial predicate — over `$distance` (not a path) or over a member (the set residual drops the planner's order terms) | **re-run on invalidation**, the ordering named as the reason | the previous result, for diffing |
| a whole-query aggregate or a `groupBy` whose `where` is a refined spatial predicate | **re-run on invalidation** — the accumulator needs a fully translated selection and a refinement is not one; the reason says so | the previous result, for diffing |
| a spatial predicate the planner **refused** (no `derive` index on the member, an untyped member, an unbounded probe) | **re-run on invalidation**, the refusal named — it never translated, so nothing narrows the fetch | the previous result, for diffing |
| a `$resample` or `$rolling` document over the collection, with an explicit `eventTime` and a fixed width (§13) | **event-time bucket / rolling state**: rows kept by bucket, or in instant order; only what a write can reach is folded again, through `@jarenjs/core/series` itself | the contributing rows, plus one fold per bucket |
| the same document with no `eventTime`, a calendar width, a named zone, a `locf`/`linear` fill, a `first`/`last` aggregate, a retention that does not cover the window, or an operand `$where` that reads the collection root | **re-run on invalidation**, the member that stopped it named (§13.2) | the previous result, for diffing |
| indexed inner equi-joins — flat self joins included (one `$for` binding an entity under several aliases, each later alias evaluated as its own input root) — and canonical allowing-empty left joins over mapped entity roots, reading no entity root outside their `$for` | **join dependency maintenance**; point-read changed keys — once per changed row, however many aliases hold it — and reevaluate their bounded outer owners | source rows (a self join's once per alias), key indexes and projected tuples, bounded by `maxMaintained` and `maxBytes` |
| nested entity graph projections with indexed equality edges and unique binding names — a child query counted, or windowed without an ordering (literal, quoted or external bounds, each owner's window taken as `execute` takes it), included | **graph dependency maintenance**; a child change refreshes its bounded owners | source rows, reverse key indexes and graph outputs |
| explicit two-level collection groups with a singular parent key and bounded nested input | **nested-group maintenance**; recompute affected parents through the query engine | source leaves and parent outputs |
| unindexed/non-equi joins, a join whose `$where` or `$return` reads an entity root outside its `$for` (a nested query over `$.<Entity>[*]`, `an entity root read outside the join bindings re-runs`), self joins inside a graph projection, an allowing-empty join or a flattened projection or over a packed `$for` source (`a self join has ambiguous root invalidation`), a graph projection whose child query is ordered, windowed or not, or that reads an entity root outside its child queries (a `$count` over `$.<Entity>[*]` in its return), an entity aggregate, an entity grouping over one binding or a join, an equality that is no join edge (a boolean, columns of two comparison families or that store another kind than their type claims, a property that is a union of kinds, two columns that can each read a NULL as a `null`, a column of no declared type), a graph projection or allowing-empty join that needs the store's registered operators or zone provider, explicit entity ordering/windows and object-root documents | **re-run on invalidation**, with the dependency or planner reason | previous result for diffing |
| any document on a store opened with a `profile` (MODEL-FORMAT §8), whatever its shape and whichever roots the profile names — its mandatory predicates, member allow-lists, engine `limits`, `maxRows` and `maxBytes` and declared externals apply to every read `execute` makes, and maintenance repeats none of them | **re-run on invalidation**, the reason `the store profile's predicates, member lists and limits apply to every read, which maintenance does not repeat`; over an asynchronous connection a resnapshot, which reads through the profile (§12.1) | the previous result, for diffing |
| anything else: non-translatable predicates, `limit` without `orderBy`, a window bound that is not a literal non-negative integer, an offset or limit over a group, distinct projection, aggregate or nested group, an entity window, a query or aggregate inside a one-item array constructor, ordered or not (its one row is the whole array), an ordered query whose return yields several items per row, a query whose filter or return reads the collection root, ordered or not (a row is evaluated alone), a group whose return reads the collection root, a document the live evaluator cannot compile without the store's registered operators or zone provider (a rows, window or group document using a registered operator, or a named zone in a group key or a projection — the planner's reason names what stopped it; a zoned `$where` fails registration `JQ0003`, as `execute` fails), `@jarenjs/linq`'s nested two-level `groupBy` emission (a group of groups), and a `@jarenjs/linq` chain that orders, windows or deduplicates after `groupBy` | **re-run on invalidation**, the reason named | the previous result, for diffing |

**A join the planner does not take is re-run, not maintained.** Join dependency
maintenance reads the plan, so a join whose equality is no join edge
(MODEL-FORMAT §10.2: a boolean, columns of two comparison families or that store
another kind than their type claims, a property that is a union of kinds, two
columns that can each read a NULL as a `null`, a column of no declared type) is
the engine's, and its live view re-runs on invalidation, naming the reason and
fetching both tables whole for each read; the equality of a nullable foreign key
against its key, an optional relation, is an edge and stays maintained. An
entity grouping, over one binding or a join, re-runs too: a group holds the rows
of many tuples and no tuple is maintained alone. A demanded
`mode: 'incremental'` over any of them is `JD0051`, naming the reason; an entity
grouping was accepted as an incremental join before, and its view drifted from a
fresh run once a group held several rows.

The **physical mapping** of a `derive: 'bbox'` index (MODEL-FORMAT §2.1,
`physical`) does not move a query between these rows. It can change one
input to the choice — `$bbox-intersects` translates exactly over four
generated columns and is refined over an R\*Tree, whose stored box is a
32-bit-float superset — but both the exact row above and the refined one
below it are the maintained per-row strategy, so the geofence behaves
identically under either shape. That is checked, not assumed:
`test/db/geofence.test.js` runs the same watch under both mappings and
asserts the same strategy, the same emissions and the same rows.

**What the geofence costs, stated rather than discovered.** A refined
spatial predicate is maintained *per row*, not incrementally: there is
no live spatial index, and none is planned. Every insert or update the
collection sees runs the exact predicate — `$within` against the
region, a geodesic `$distance` — once for that row, inside capture
delivery, on the store's own connection. Over a large region (a ring of
thousands of vertices) at a high write rate that is real work on every
write, and a consumer with such a region either simplifies it for the
fence (`$geo-simplify`) or accepts the cost knowingly. The region is
bound at registration like every external (§8): the initial fetch binds
it through the same derived parameter slots the planner uses for a
one-off query, so an external region narrows exactly as a literal one
does, and a region with no bounding box diverts to a full initial read
and is still correct.

Re-run is a first-class, documented outcome, not a failure. What is
forbidden is *silently* re-running while the reader believes the query
is incremental: `live.mode` reports `'incremental'` or `'rerun'`, the
strategy, and — for re-run — the reason. `mode: 'incremental'` in the
options DEMANDS incrementality: a query that classifies as re-run then
refuses at registration (`JD0051`), the same shape as capture's
demanded session — an application that needs the property can refuse
to start. A `mode` other than `'auto'`, `'incremental'`, `'rerun'` and
`'resnapshot'` is `JD0013`, so a misspelt demand is never taken for `'auto'`.

**A store profile re-runs every registration.** On a store opened with a
`profile` (MODEL-FORMAT §8) — any profile, `'safe'` included, since a
normalized profile always carries engine `limits` and a `maxRows` bound —
every registration re-runs whatever its shape, with the reason
`the store profile's predicates, member lists and limits apply to every read, which maintenance does not repeat`,
and a demanded `mode: 'incremental'` refuses it `JD0051`. The profile
shapes every read `execute` makes: a root's mandatory predicate is
conjoined into its fetch, a member allow-list is checked against every
member the document reads, the engine limits bound every evaluation,
`maxRows` and `maxBytes` bound the rows and items, and a document may
reference only the declared externals. A maintained strategy repeats none
of them — it admits an inserted document as the capture record carries
it, re-reads a changed row by its key and evaluates the projection with
an evaluator compiled without the limits — so another tenant's row, an
undeclared external or an unbounded evaluation would reach `result`
where `execute` hides or refuses it. A re-run IS `execute`, so it answers
what `execute` answers, refusals included: a document past `limits.steps`
fails registration with `execute`'s own `JQ2009`, and errors a
registration a later write pushes past it; a join whose whole-row initial
read a member allow-list refused (`JD0011`) answers, while a document
reading a member the list denies is refused as `execute` refuses it. An
explicit `mode: 'rerun'` keeps its own reason, and over an asynchronous
connection every registration is a resnapshot, which reads through the
profile with its limits narrowed to the resnapshot credits (§12.1): a
result past them is `JD2060` where `execute` answers or refuses `JD2007`.
A registration reads the options `externals`, `mode` and
`eventTime` and refuses any other `JD0013`, so a per-call `profile` —
which `execute` reads — is never dropped silently: a profile a live query
must honour is the store's.

The **group form** the classifier recognises (the linq chain's group-of-groups emission still re-runs; explicit
nested groups have a separate bounded strategy below), here with a return of key and aggregate members:

```json
{ "$for": { "it": "$[*]" },
  "$where": { "…optional, translatable…": [] },
  "$groupby": { "g": "$it.dept" },
  "$return": { "key": { "$default": ["$g", null] },
               "n": { "$count": "$it" }, "total": { "$sum": "$it.pay" } } }
```

After `$groupby`, `$it` is the group's item sequence and `$g` its key.
The return may be any expression that reads only the group: a key (plain
or `$default`ed to `null`), an aggregate over `$it` (a path below it
selects the aggregated member), an object of those as above, arithmetic
over aggregates (`{ "$add": [{ "$sum": "$it.pay" }, 1] }`), the rows
themselves (`"items": ["$it"]`), a nested query over `$it`, a bare member
path. All are maintained the same way — every output depends on one
group's rows alone, which is what per-group recomputation needs — and
what the key, filter and return read decides the dependencies (§8). A
return that reads the collection root (`$`, `$.…`, `$[…]`, or the root
named inside a path filter, as in `$it[?@.n > $[0].n]`, but not a `$$`
literal, which reads nothing), an `$orderby`
or any other phrase key, a window over the group, and a document the live
evaluator cannot compile without the store's registered operators or
zone provider re-run, named. Multiple declared keys follow the same rule.

A **group emission** — how `@jarenjs/linq` spells one `groupBy` followed
by `select`/`where` steps — is maintained the same way. Every level
around the group form is
`{ "$for": { "it": [<the level inside>] }, "$where"?, "$return" }` — one
binding over a one-item packed source, with a filter and a return that
read no collection root. The steps `groupBy((r) => r.dept)`,
`where((g) => g.items.count().gt(1))` and
`select((g) => ({ key: g.key, total: g.items.all().pay.sum() }))` emit:

```json
{ "$for": { "it": [{ "$for": { "it": "$[*]" },
                     "$groupby": { "g": "$it.dept" },
                     "$return": { "key": { "$default": ["$g", null] },
                                  "items": ["$it"] } }] },
  "$where": { "$gt": [{ "$count": "$it.items[*]" }, 1] },
  "$return": { "key": "$it.key", "total": { "$sum": "$it.items[*].pay" } } }
```

Each outer level maps or filters one group object at a time, so only the
affected groups are evaluated again, and an aggregate over an emission
(`{ "$sum": <emission> }`, the chain's `sum()`) folds the group outputs.
A `where` before `groupBy` is the row filter, which decides whether a row
is filed at all (its key decides the group); one after it filters group
objects. The outer levels
read the rows only through `items`, a bare row read, so an emission
depends on every member (§8). A group of groups (`groupBy().groupBy()`)
and a chain that orders (`orderBy`), windows (`take`, `skip`) or
deduplicates (`distinct`) after `groupBy` re-run with the reason named —
a window after the last step as `a windowed group re-runs`.

## 8. Invalidation

Each live query derives its dependencies from the plan at
registration:

- the collection (or, for entity documents, every entity the plan
  binds), matched first against a record's `collections` — a
  non-matching record costs ONE array scan;
- for accumulator and group strategies, the top-level members the
  plan actually reads (filter refs, the aggregated path, the group
  key): an update record touching only other members is skipped — but
  a group that reads a row bare (`"items": ["$it"]`, `$get` over a row,
  a nested query over `$it`, a row-valued key) depends on every member,
  and so does every group emission (§7), while counting a group's rows
  (`{ "$count": "$it" }`) reads none. A group
  still reads the position of each row it holds that a skipped record
  touches (one statement per row): a key deleted and inserted again with
  another value in one transaction reaches capture as a diff of its
  members, yet it is a new row at the end of the source order, and the
  group moves it there as a delete and an insert would. Inserted again
  with an EQUAL value, the key reaches capture as no change at all (a
  commit that changed nothing else carries no record): a group, distinct
  projection or nested group keeps the row in its old place until a later
  change to that row reaches capture, while `execute` reads it at its new
  place at once (and a re-run does at its next record). Telling that move
  apart would mean reading every held row's position on every record,
  which maintenance does not do;
- row and window strategies depend on their WHOLE collection — the
  result carries the row documents, so any member change changes an
  emitted row.

Matching is by table plus pointer prefix — cheap, sound, and
**over-approximate in exactly one direction**: an unnecessary
re-evaluation is a performance bug; a missed one would be a
correctness bug, so the approximation always leans toward
re-evaluating. Row inserts arrive with their full document in the
patch; row UPDATES are minimal (§3), so maintenance issues a
point-read of the touched row (one indexed lookup per touched key per
record) to re-evaluate; deletes are answered entirely from maintained
state. `externals` are fixed at registration — a query whose inputs
change is a new registration; the registration holds a copy, so changing
the object it was given changes nothing.

Incremental and rerun maintenance runs synchronously inside patch delivery, in commit
order, on the store's own connection. Delivery is never re-entered: a
write made from inside an observer or a subscriber commits at once,
but its record is queued and delivered after the current record has
reached every consumer, so sibling live views see commits in commit
order rather than in call-stack order. Writes from ANOTHER connection
are invisible to this local synchronous registry; the coarse `dataVersion()`
signal and the §11 topology apply. Resnapshot mode (§12.1) follows enrolled
commits from other connections through the durable log.

## 9. The emitted patch contract

The result document is `{ "rows": [...] }` — always. Row and window
strategies fill `rows` with result items; group strategies with one
row per group; a whole-query aggregate is a ZERO-OR-ONE row result
(`rows: [42]`; an empty `min()` is `rows: []`, the engine's
undefined-as-absent mapping made visible). In every mode — maintained,
re-run and resnapshot, on PostgreSQL too — `rows` is the document's result
sequence, the array `execute` answers for the document packed in a
one-element array: a document registered unpacked whose result is ONE
array value has that array as its one row, where `execute` of the
unpacked document answers the array itself. Consumers hold the result
document and apply patches to it; ops are `add`, `remove` and
`replace` only.

- **One record, one emission.** A committed transaction touching any
  number of rows produces at most ONE `{ patch, seq }` event per live
  query — the record's changes coalesce into one patch array, and a
  record that ends up changing nothing emits nothing.
- **Structural sharing is the contract, not an optimisation.** After
  an emission, every unaffected row in `live.result` is
  REFERENCE-IDENTICAL to before; the `rows` array and the result
  object are fresh per emission (a held previous result is never
  mutated). Applying the emitted patch with `applyJSONPatch`'s
  copy-on-write preserves the same sharing on the consumer's side —
  which is what keeps the O(k) renderer's fast paths alive end to
  end.
- **Order.** An ordered (window) query's row order — offset windows
  included — is the engine's over the declared terms, with ties broken
  by the collection key's text in code-point order, so the order is
  total and stable by construction. For a string key that is the order
  the key gives as a final term; for a numeric key it is not (`10`
  sorts before `9`), and `execute` breaks ties by row identity — a
  consumer that needs one tie order everywhere declares the key as the
  last `orderBy` term. An UNORDERED query's initial order is the engine's;
  maintenance then appends newly matching rows and splices removed
  ones, which is deterministic given the write history but is NOT
  re-derived rowid order — a consumer that needs a specific order
  declares an `orderBy`. Group rows keep first-appearance order.
- `seq` is the capture record's `seq`; re-run emissions carry it too.
- **An emission reaches the observers subscribed when it began.** An
  observer subscribed from inside another's callback starts from
  `live.result`, which already holds that emission, and hears the next
  one; an observer unsubscribed before its turn hears nothing more.

## 10. The app binding

A live query reaches an app as a SUBSCRIPTION (APP-FORMAT §5.3) whose
handler dispatches a patch-carrying action — generated documents, no
import in either direction (the `fsmToApp` precedent):

```js
import { liveAppBinding, createLiveSubscription } from '@jarenjs/db/app';

const { subscription, actions } = liveAppBinding({
  run: 'db/live', action: 'db/liveChanged', statePath: '/live/users',
  collection: 'users', query: [{ $for: { u: '$[*]' }, $return: '$u' }] });
// subscription → { run: 'db/live', with: { …, collection, query, statePath, action } }
// actions      → { 'db/liveChanged': { patch: '$payload' } }

createApp({ ...doc, subs: [subscription], actions: { ...doc.actions, ...actions } },
  { subs: { 'db/live': createLiveSubscription(store) } });
```

The handler registers the live query, dispatches ONE initializing
patch (`replace` of the whole `statePath` slot with the initial
result), then forwards each emission with every op's path prefixed by
`statePath` — the prefixing happens in the handler, so the action
document stays the two-line literal above and the app loop needs
nothing new: `@jarenjs/app` already applies patches copy-on-write and
derives changed paths, which is the payoff of one diff format end to
end. Closing is the subscription's cleanup; a handler props change
restarts it through the app's own key rule.

## 11. Cross-tab: the owner topology

Decided by a platform fact: OPFS synchronous access handles are
**exclusive** — a second tab cannot open the same database files at
all, so "one connection per tab" is not available and never will be.
Therefore:

- ONE owning context holds the sole connection — the first tab's
  dedicated worker to install the OPFS access-handle pool owns it (the
  pool is exclusive by construction) and holds a `navigator.locks` lock
  for its lifetime so a later tab can tell a busy owner from no owner
  (a `BroadcastChannel` ping is the fallback where locks are absent) —
  and every other tab is a client;
- queries, writes and the patch stream travel between clients and the
  owner over `BroadcastChannel` / `MessagePort`; a client's live query
  is a remote registration whose emissions arrive as messages;
- a second context attempting to OPEN the database is refused with
  `JD2061` — a coded refusal, never a mysterious storage failure;
- conflict handling stays out of scope: there is one writer by
  construction.

Node and Bun present the same API with no channel at all — the store
is its own owner, and application code is identical everywhere. The
in-browser proof of this topology (delivery across real tabs, the
refusal, reload survival) is the website's Playwright suite over the
`#/data` studio; this section is the decided contract it implements.

The wasm session adapter performs an actual disposable create/attach/changeset/delete
probe. It declares sessions only after success; `sessionReason` explains journal
fallback. Changeset bytes are detached from wasm-owned memory before transfer, and
capture cleanup deletes every session even on rollback or connection close.

The studio probes isolated SharedArrayBuffer OPFS, header-free SAH-pool OPFS,
atomic IndexedDB snapshots, then visibly non-durable memory. IndexedDB snapshots
require exclusive ownership and acknowledge writes after atomic version replacement.
The studio's configuration exposes no synchronous/live surface; its Store pane refreshes after
writes. Failed snapshot persistence invalidates the connection without publishing
partial state. [Execution hosts](HOSTS.md) specifies bounds and the observed matrix.

**The browser boot is a closed protocol.** Reaching an owner, a client
or a standalone memory store passes through five named stages —
`worker-start`, `sqlite-init`, `vfs-acquire`, `topology`,
`store-open` — and every attempt ends in exactly one of two states:
ready, or a stable failure record `{ code: 'DATA_BOOT', stage, message }`
naming the stage that failed. Each stage carries its own budget, so a
stage that never settles fails under its own name rather than under an
outer deadline that cannot say which resource to release; an OPFS pool
that is absent advances to the next persistence probe; an existing owner
produces the `client` answer above, while a pool install that hangs is a `vfs-acquire` failure
and never masquerades as absence. A failed attempt releases everything it
created — worker, port client, channel, listeners, timers — before the
page hears of it, so a retry (or a reload) starts clean, and the page
shows the stage and offers the retry. The stage runner is
`packages/website/src/lib/boot-stages.js`; the site's transport and its
owner worker are the two halves that run it.

## 12. Lifecycle, bounds, and non-goals

A live query holds resources: dependency registrations, its
maintained state, possibly a sorted window. `close()` releases all of
them and is MANDATORY; closing the store closes every live query
first; after close, `subscribe` and re-registration refuse, `result`
stays readable (the last value), and a leak test asserts the live set
after a forced GC.

Bounds, both configurable at `openStore({ live: { … } })`, both
ERRORING rather than degrading (the bound is printed, never silent):

- `maxQueries` (default 64): registrations beyond it are `JD0052`;
- `maxMaintained` (default 10 000): the per-query ceiling on
  maintained ENTRIES — result rows, window rows, accumulator and
  per-group contributions all count, because the state is the cost.
  Crossing it mid-maintenance is `JD2060`: the live query delivers the
  error to its subscribers and CLOSES — degraded silence is the one
  outcome this format forbids. An unbounded live query over a growing
  table is the classic memory leak of this category; the accumulator
  strategies trade exactly one contribution entry per matching row for
  delete-correctness, and a count over a table larger than the bound
  is a conscious `maxMaintained` raise, not a silent one.

Incremental maintenance does not cover unindexed or non-equality joins or
cross-connection changes. Async hosts require the optional resnapshot configuration
below; a missing helper or durable log refuses with `JD0051` (missing capture
itself remains `JD0050`). Replication is specified separately in
[REPLICATION-FORMAT](REPLICATION-FORMAT.md). There is no ordering guarantee for
unordered queries beyond §9's determinism.

### 12.1 Asynchronous resnapshots

```js
import { asyncLive } from '@jarenjs/db/async-live';
const store = await openStore(model, {
  driver, capture: { mode: 'journal', log: { retention: 1000 } },
  live: asyncLive({ maxInputRows: 10000, maxInputBytes: 4194304 }),
});
const live = await store.collection('notes').live(query);
const unsubscribe = live.subscribe(event => render(live.result, event));
await live.refresh();
unsubscribe();
await live.close();
await store.close();
```

The same collection/entity query surface and result/patch registry are used on
Node worker, pool and process SQLite and PostgreSQL. `capabilities.liveModes`
names available `incremental`, `rerun` and `resnapshot` modes. Async connections
offer only `resnapshot`; synchronous connections keep their existing default
and select it per query with `{ mode: 'resnapshot' }`. The helper is executable
host configuration, outside JSON application documents. It requires durable
capture and lazy row iteration; incremental/event-time demands on the async
path refuse (`JD0051`/`JD0053`).

Registration fixes a detached query and external bindings. Each evaluation uses
the ordinary query compiler and narrows host predicates, member permissions and
execution limits. It reads the committed high-water mark before and after the
query inside a transaction. A changed mark discards that evaluation. SQLite
retains its transaction snapshot; PostgreSQL validates enrolled commits without
holding the journal's writer lock. The immediate post-registration poll closes
the read/subscribe gap. Local commits wake the reader; polling catches other
Store connections. A host can also call `refresh()` from a notification hint;
the durable checkpoint remains authoritative after reconnect or missed hints.

One evaluation and one coalesced invalidation are owned per registration. The
defaults are `maxQueries: 64`, `maxMaintained: 10000`, `maxBytes: 4194304`,
`maxInputRows: 10000`, `maxInputBytes: 4194304`, `maxObservers: 8`,
`pageRows: 32`, `pollMs: 1000` and `maxAttempts: 3`; all must be positive finite
safe integers, with the timer also within its platform range. Input credits span
all fetched roots/statements, including a small residual result over a large
scan; reading exactly a credit registers, and a row past it is `JD2060`,
the first row a statement reads included. Binding bytes are bounded at registration. Result bytes and observer event
counts are bounded separately. These are serialized payload credits plus finite driver
prefetch and a detection row, not a total JavaScript heap or database-internal
work limit. Native work uses the driver's declared timeout capabilities.

An expired checkpoint, oversized indivisible log record or bounded backlog causes
an authoritative resnapshot; retention/record resets carry `resetRequired: true`.
Repeated revision races stop after `maxAttempts`, retain the last verified rows
and checkpoint, and emit `lag: true`; a later successful poll clears lag. Initial
registration cannot publish unverified rows and refuses with `JD2060` on attempt
exhaustion. Row/byte exhaustion is a terminal coded error; inspect `live.error`
and `state`. No partial result is reported as complete.

`refresh()` joins an active bounded round, so its promise may settle with
`lag: true` even if writers have just finished. To request a fresh snapshot after
writers quiesce, first await that outstanding work, then call `refresh()` again;
check `state` and `stats().lag` before treating the result as current. Each round
retains the same attempt and resource limits.

Each observer has one active callback and at most one latest pending event.
Coalescing emits a complete `/rows` replacement with `coalesced: true`, so a
consumer never applies a patch whose predecessor was dropped. Callbacks are
isolated. Closing suppresses pending delivery, aborts and drains owned reads,
releases registrations and timers, and is idempotent; it cannot cancel arbitrary
work inside a host callback. An already busy observer may miss the terminal error
event when closed, so `live.error` remains authoritative. Await async `close()`;
the last verified `result` remains readable. Stats expose checkpoint, lag,
pending work, input credits, subscriptions, coalescing and resets.

Coverage is enrolled managed writes. Unenrolled SQL, arbitrary trigger
effects and external databases require a separate host freshness mechanism.

## 13. Event time

A live view over time needs to know what "now" is — which reading counts
as late — and the machine's clock is a different quantity from the
instant a reading carries. So there is no clock in this layer and none
under it: the **watermark arrives**.

```js
const live = await store.collection('readings').live(
  [{ $resample: ['$[*]', { every: 60_000, aggregate: 'mean' }] }],
  { eventTime: {
      path: '$.at',              // the instant member, as a row selector
      watermark: 1767225600000,  // a finite epoch the HOST supplies
      allowedLateness: 300_000,  // how late a reading may still be
      retention: 900_000,        // the horizon this view claims
  } });

live.advance(1767225660000);     // the only way a watermark moves
live.stats().watermark;          // what it is now
```

`eventTime` is a **closed** member set: `path`, `watermark`,
`allowedLateness` (default 0) and `retention`. Anything else — a
misspelling, a non-finite epoch, a negative lateness, a `path` that is
not a singular row selector — is `JD0053` at registration (its
`docPath` names the collection, `/collections/<name>`), not a member
quietly ignored. `advance()` refuses a value that is not finite or that
goes backwards (a `TypeError`), and it is absent on every view
registered without an `eventTime`. An entity document has no collection
for an event-time view to maintain, so an `eventTime` on `store.live` is
`JD0053` too, whatever the document.

### 13.1 What is maintained

Two documents, and only these two shapes: `$resample` and `$rolling`
whose series operand is the collection (`"$[*]"`, or a FLWOR over it
whose `$where` narrows and whose `$return` is the bare binding). A
spec that spells `at` and `value` explicitly — the spelling the query
language accepts — is maintained: the view folds with the kernel
reading the declared instant member and the `value` member the spec
names, and a `value` selector the view cannot follow re-runs with the
reason named, never a maintained view that dies on its first fold.

- **A bucket view keeps its rows by bucket.** A write touches one bucket
  — two, when it moves a reading across a boundary — and exactly those
  are folded again by calling `resampleSeries` over that bucket's own
  rows. The aggregate is therefore the kernel's, and cannot drift from
  what a fresh query would answer.
- **A rolling view keeps its rows in instant order.** A write at `t` can
  only change the windows ending in `[t, t + width)`, so exactly that
  stretch is recomputed — again by the kernel, over the slice those
  windows can see.

`retention` is the horizon the view claims, and it is checked rather
than assumed: it must cover the width plus `allowedLateness`, which is
the span a single repair can read. A shorter one is a re-run with the
numbers printed. It is **not** a compaction policy — the maintained
state is bounded by `live.maxMaintained` exactly as every other
strategy's is (§12), and nothing an answer still depends on is dropped.
That is the honest statement of what this version buys: bounded repair
work and a visible lateness contract, not a smaller heap.

### 13.2 What re-runs, and why

| Refused | Because |
|---|---|
| no `eventTime` | a temporal view maintains event time, and a hidden clock is the one source this suite will not use |
| a calendar `every`/`width` (`P1M`, `P1D` on a zone) | a calendar ladder walks a wall clock and a month has no width, so its boundaries move with the data rather than with arithmetic |
| a named `zone` | it resolves through the injected provider, which maintenance would have to consult per boundary |
| `fill: 'locf'` / `'linear'` | they fill an empty bucket from its neighbours, so one late reading moves buckets it never belonged to |
| `aggregate: 'first'` / `'last'` | they name a row by its position in the series, which a per-key state does not preserve — the same refusal the pushdown planner makes |
| a `retention` under `width + allowedLateness` | a repair could read outside the horizon the view claims |
| a `$subsequence` window, a projecting operand, a collection with no document key | there is no row a key can be tracked through |
| a spec whose `at` selector is not `eventTime.path` | the state would place a row by one instant and aggregate it by another |
| an operand `$where` that reads the collection root (`$`, `$.…`, `$[…]`, or the root inside a path filter) | the state files each row alone through the filter, and one row is not the collection the kernel's own run reads |

Each of those is `live.mode.reason`, and `mode: 'incremental'` still
refuses them at registration with `JD0051`.

### 13.3 Late data is visible, never lost

A reading is **late** when its instant — before the write, after it, or
both — is behind `watermark - allowedLateness`. Late readings are not
dropped and not quietly folded in. The view **re-reads** from the store,
so the answer still equals what a fresh query would give, and the
emission carries the reason:

```js
live.subscribe(({ patch, seq, lateData }) => {
  if (lateData !== undefined) {
    // { reason: 'late-data', at, key, watermark, allowedLateness, boundary }
  }
});
```

`stats().lateData` counts them and `stats().reruns` counts the re-reads
they forced. A reading outside the view's own `start`/`end` window is
not late data: it belongs to no bucket this view maintains, so there is
nothing to be late for.

The maintained answer is **equal to a full recomputation after every
mutation** — not approximately, and not eventually. `test/db/live-time.test.js`
holds a shuffled stream of inserts, in-place updates, instant moves and
deletes against `resampleSeries` / `rollingSeries` over the whole
collection after each one, which is the only oracle that cannot drift
with the implementation.


## Bounded joins, graph projections and nested groups

`join`, `graph` and `nested-group` strategies charge their source rows and
result entries to `live.maxMaintained`, and serialized input/output payloads to
`live.maxBytes` (default 4 MiB). These credits bound cached payloads rather than
claiming to measure JavaScript heap overhead. Initialization uses a limited
source read; updates read changed keys, then visit cached indexed dependencies.
Bounds are checked while caches grow. Overflow is `JD2060`, emits one error,
closes the subscription and releases dependency caches. It never relabels an
unbounded query as incremental.

Entity equality columns need a primary-key prefix, declared index or mapped
foreign-key index. Every binding needs a key; a flat inner join may bind one
entity under several aliases, each cached and charged as its own root, so a self
join holds the shared rows once per alias against `live.maxMaintained` and
`live.maxBytes` — where a plain join over the same rows fits, a self join can be
`JD2060`. A graph projection, an allowing-empty join or a flattened projection
(one outer binding over a query) reaching one entity twice, and a self join over
a packed `$for` source (`['$.Author[*]']`), re-run with
`a self join has ambiguous root invalidation`. The projected
identity is the tuple of source identities, so duplicate projected values remain
distinct. Default entity result order follows physical row insertion order;
point reads preserve that order even when a key is deleted and reinserted. The
exception is a row deleted and inserted again with identical values in one
transaction — an `unlink` and `link` of the same pair included: capture records
no change for it, so no live registration moves it when `execute` starts
listing it last. A re-run takes the new place at its next record, a maintained
join or graph when a later change to that row reaches capture. A
left join uses a canonical `$allowing-empty` binding over an equality-filtered
inner subquery. Its absent child can be defaulted to null. Graph projections
embed equality-filtered child queries in a single outer row's return object.
A root read outside the bindings re-runs: in a join's `$where` or `$return` — a
nested query over `$.<Entity>[*]` included — because the maintenance evaluates
each outer row over its connected rows alone
(`an entity root read outside the join bindings re-runs`), and in a graph
projection because changing one row can change every projected graph.

`dependencyReads`, `refreshedRoots` and `refreshedGroups` expose the work done.
`dependencyReads` counts logical changed-row reads — one per changed row, shared
by every alias holding it; a row-position lookup is an additional statement. No
full query reruns occur under these strategy labels.
Materializing and diffing the final bounded output still costs work proportional
to its size. See the equal-correctness [measurements](REPLICATION-FORMAT.md#measurements)
for startup and high-fan-out losses beside selective wins.

Two-level grouping currently accepts an explicit parent `$groupby` over a
singular member, with one nested group over that parent's bound row sequence.
Count, sum, average, minimum and maximum recompute from only the affected
parent's bounded leaves. An offset, an unsupported operator, a global input to
the nested group, or a group-of-groups LINQ emission remains a named rerun.
Replicated writes enter the same committed capture stream as local writes.

### Group maintenance details

Single-level groups accept one or more key expressions over one collection
binding, an optional fully translated filter, and a return that reads only
the group: a bare key, one count/sum/avg/min/max expression, or an object
containing key, `$default: [key, null]`, and aggregate members, or any
other expression over the group's keys and rows — arithmetic over
aggregates, the rows themselves, a nested query over them. Global-root
reads, ordering, and windows remain rerun shapes, and so does a return the
live evaluator cannot compile without the store's registered operators or
zone provider. Return expressions are evaluated by the query engine,
including empty results and errors — a return that raises for some data (an
object member evaluating to two items is `JQ2001`) refuses registration or
closes the query with the engine's code. That is `execute`'s code too,
except where `execute` answers a group's aggregates natively: SQL skips a
stored `null` that the engine refuses, so `{ "$sum": "$it.pay" }` beside a
stored `null` answers in `execute` and raises `JQ2001` here. Maintenance
does not substitute JavaScript arithmetic for query operators.

Keys preserve structural equality and distinguish missing from null. Source
holders retain physical row positions: changing a holder preserves its
position, a key deleted and inserted again takes a new one at the end — in
one transaction too, unless it comes back with an equal value, which
capture records as no change: the holder then keeps its old position until
a later change to that row reaches capture (§8) — and deleting a group's
earliest holder may move that group's output. Unaffected group outputs retain reference identity. Only affected
groups are reevaluated, followed by an optional final aggregate over all group
outputs. This costs work proportional to the affected groups plus group-output
ordering/folding, rather than constant-time arithmetic deltas.

`live.maxMaintained` counts source holders and group output items;
`live.maxBytes` counts their serialized documents. This includes document
members omitted from a small aggregate result, and a return that copies
rows (`"items": ["$it"]`) charges their bytes twice — as source holders and
again inside the group output. Exceeding a bound refuses
registration or closes an active query with `JD2060`; the last delivered
result remains unchanged. At the default bound of 10,000 entries a group of
9,999 rows with one output item registers and the next row closes it;
`mode: 'rerun'`, which keeps only the result, or a raised
`live.maxMaintained` (and `live.maxBytes`) serves a larger one. Engine
failures follow the same invalidation path.

`node --expose-gc benchmark/changeflow.js` compares every mutation against a
fresh query and a patch-only consumer. The
[generated comparison table](REPLICATION-FORMAT.md#measurements) includes
multiple-key groups, an aggregate of groups and distinct beside forced reruns.
It reports initialization allocations and both median and tail mutation time;
heap deltas before collection are not precise retained-state sizes. The fixture
has 200 initial rows and 15 mutations per case, so these measurements establish
correctness and costs for that fixture rather than a universal crossover.

## Structural range adapter

`@jarenjs/linq/db` exposes bounded ranges over captured hybrid entity roots, using the existing keyset pager and committed observer. Its live event is an explicit source reset with monotone revision; this does not promote entity offset windows or the remaining incremental shapes. See [COLLECTION-PROVIDER](../../app/docs/COLLECTION-PROVIDER.md) for credits, snapshot identity and disposal. Maintained top windows check offscreen rows against their bound and release retained state on close.
