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
  session mode emits and a `put` that changes nothing emits nothing;
  and of the
  database's own `ON DELETE` side effects it reconstructs exactly ONE
  — join-table membership dying with its entity (read before the
  delete) — while cascades into CHILD rows (`onDelete: 'cascade'` /
  `'setNull'` on one-to-many relations) stay invisible. For writes
  made through the store API within those bounds the two modes MUST
  produce the same op sets — proven by a differential test.
- Requesting `mode: 'session'` on a driver without sessions is a
  `TypeError` at open — an application that needs completeness can
  refuse to start rather than silently miss changes.

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
live.mode;                // { strategy, mode: 'incremental'|'rerun', reason }
const stop = live.subscribe(({ patch, seq, error }) => { /* … */ });
live.close();
```

`store.live(document, options)` registers an entity-root document (the
multi-entity shape of MODEL-FORMAT §10) the same way. Live queries
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
the maintenance are this table's — an entity chain re-runs, declared —
and this document stays the only place they are decided.

**This table is normative.** Every row is implemented and tested;
nothing outside it is attempted. Classification combines canonical document shapes with the compiled selection
plan; "extractable" below means what the pushdown planner already proves.

| Construct (as planned) | Strategy | Maintained state |
|---|---|---|
| `where` whose predicates translate (the plan's filter), no order, no aggregate | **incremental rows**: per-row re-evaluation; insert / remove / replace in the result | the result rows |
| the same with a per-row `select` projection (row-mode plan) | **incremental rows**: the affected row alone is recomputed; a source row may project to several items | result rows, grouped by source key |
| `orderBy` over extractable paths, optional `limit`, offset 0 | **maintained window**: a sorted structure; ties broken by the collection key, appended as the final sort term; an insert sorting beyond a full window is a no-op | the window rows and their sort keys |
| whole-query `count` / `sum` / `avg` / `min` / `max` (the plan's aggregate), optional `where` | **running accumulator** plus a per-row contribution map — a delete can only be answered from retained contributions (§3: a `remove` carries no old value). `min`/`max` removal of the last extremum holder FALLS BACK to a recompute over the retained contributions; the accumulator alone cannot answer, and this fallback is the documented cost | one contribution per matching row |
| single-level `groupBy` with one or more keys and canonical returns below | **group maintenance**: reevaluate affected groups through the engine in source-row order; first surviving source occurrence determines group order | source documents and group outputs, with entry and byte credits |
| unordered SQL-native typed scalar distinct projections | **distinct maintenance**: keep the source holders of each value; deleting its earliest holder may move the value in first-occurrence order | source documents and unique outputs, with entry and byte credits |
| count/sum/avg/min/max over canonical unwindowed groups | **group maintenance** followed by an engine fold over the retained group outputs in first-occurrence order | source documents and group outputs, with entry and byte credits |
| ordered/windowed distinct or other aggregates over groups | **re-run on invalidation** | the previous result, for diffing |
| `where` whose spatial predicate is **refined** (the plan pushed a bounding-box or cell-range pre-filter and left the exact `$within`, bounded `$distance` or over-long cell prefix to the residual — `explain().prefilters` with `exact: false`), no order, no aggregate; optional per-row `select` | **incremental rows** — the geofence: the initial fetch narrows through the derived index, and every touched row is re-evaluated by the engine's EXACT predicate, so a point emits `add` when it enters the region, `remove` when it leaves, and nothing while it moves within (a whole-document return sees a `replace` carrying the new position) | the result rows |
| a refined spatial predicate over a collection with **no document key** (`key: null`, rowid identity) | **re-run on invalidation** — the per-row strategy tracks a row by its declared key, and a rowid is not one; the reason says `rows without a document key cannot be tracked` | the previous result, for diffing |
| `orderBy` beside a refined spatial predicate — over `$distance` (not a path) or over a member (the set residual drops the planner's order terms) | **re-run on invalidation**, the ordering named as the reason | the previous result, for diffing |
| a whole-query aggregate or a `groupBy` whose `where` is a refined spatial predicate | **re-run on invalidation** — the accumulator needs a fully translated selection and a refinement is not one; the reason says so | the previous result, for diffing |
| a spatial predicate the planner **refused** (no `derive` index on the member, an untyped member, an unbounded probe) | **re-run on invalidation**, the refusal named — it never translated, so nothing narrows the fetch | the previous result, for diffing |
| a `$resample` or `$rolling` document over the collection, with an explicit `eventTime` and a fixed width (§13) | **event-time bucket / rolling state**: rows kept by bucket, or in instant order; only what a write can reach is folded again, through `@jarenjs/core/series` itself | the contributing rows, plus one fold per bucket |
| the same document with no `eventTime`, a calendar width, a named zone, a `locf`/`linear` fill, a `first`/`last` aggregate, or a retention that does not cover the window | **re-run on invalidation**, the member that stopped it named (§13.2) | the previous result, for diffing |
| indexed inner equi-joins and canonical allowing-empty left joins over mapped entity roots | **join dependency maintenance**; point-read changed keys and reevaluate their bounded outer owners | source rows, key indexes and projected tuples, bounded by `maxMaintained` and `maxBytes` |
| nested entity graph projections with indexed equality edges and unique binding names | **graph dependency maintenance**; a child change refreshes its bounded owners | source rows, reverse key indexes and graph outputs |
| explicit two-level collection groups with a singular parent key and bounded nested input | **nested-group maintenance**; recompute affected parents through the query engine | source leaves and parent outputs |
| unindexed/non-equi joins, self joins, explicit entity ordering/windows, object-root documents and load-spec graphs | **re-run on invalidation**, with the dependency or planner reason | previous result for diffing |
| anything else: non-translatable predicates, `limit` without `orderBy`, `offset` > 0, windowed aggregates, `@jarenjs/linq`'s nested two-level `groupBy` emission, non-canonical group returns | **re-run on invalidation**, the reason named | the previous result, for diffing |

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
to start.

The **canonical group form** the classifier recognises (the linq chain's group-of-groups emission still re-runs; explicit
nested groups have a separate bounded strategy below):

```json
{ "$for": { "it": "$[*]" },
  "$where": { "…optional, translatable…": [] },
  "$groupby": { "g": "$it.dept" },
  "$return": { "key": { "$default": ["$g", null] },
               "n": { "$count": "$it" }, "total": { "$sum": "$it.pay" } } }
```

After `$groupby`, `$it` is the group's item sequence and `$g` its key;
return members are the group key or an aggregate over `$it` (a path
below it selects the aggregated member). A bare key or a single aggregate is also canonical; other return shapes
re-run. Multiple declared keys follow the same rule.

## 8. Invalidation

Each live query derives its dependencies from the plan at
registration:

- the collection (or, for entity documents, every entity the plan
  binds), matched first against a record's `collections` — a
  non-matching record costs ONE array scan;
- for accumulator and group strategies, the top-level members the
  plan actually reads (filter refs, the aggregated path, the group
  key): an update record touching only other members is skipped;
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
change is a new registration.

Maintenance runs synchronously inside patch delivery, in commit
order, on the store's own connection. Delivery is never re-entered: a
write made from inside an observer or a subscriber commits at once,
but its record is queued and delivered after the current record has
reached every consumer, so sibling live views see commits in commit
order rather than in call-stack order. Writes from ANOTHER connection
are invisible to capture (§6) and therefore to live queries; the
coarse `dataVersion()` signal and the §11 topology are the honest
answers, and re-registering re-reads.

## 9. The emitted patch contract

The result document is `{ "rows": [...] }` — always. Row and window
strategies fill `rows` with result items; group strategies with one
row per group; a whole-query aggregate is a ZERO-OR-ONE row result
(`rows: [42]`; an empty `min()` is `rows: []`, the engine's
undefined-as-absent mapping made visible). Consumers hold the result
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
- **Order.** An ordered (window) query's row order is the engine's,
  with ties broken by the collection key — the key is appended to the
  declared terms at registration, so the order is total and stable by
  construction. An UNORDERED query's initial order is the engine's;
  maintenance then appends newly matching rows and splices removed
  ones, which is deterministic given the write history but is NOT
  re-derived rowid order — a consumer that needs a specific order
  declares an `orderBy`. Group rows keep first-appearance order.
- `seq` is the capture record's `seq`; re-run emissions carry it too.

## 10. The app binding

A live query reaches an app as a SUBSCRIPTION (APP-FORMAT §5.3) whose
handler dispatches a patch-carrying action — generated documents, no
import in either direction (the `fsmToApp` precedent):

```js
import { liveAppBinding, createLiveSubscription } from '@jarenjs/db/app';

const { subscription, actions } = liveAppBinding({
  run: 'db/live', action: 'db/liveChanged', statePath: '/live/users' });
// subscription → { run: 'db/live', with: { …, statePath, action } }
// actions      → { 'db/liveChanged': { patch: '$payload' } }

createApp({ …doc, subs: [subscription], actions: { …doc.actions, ...actions } },
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
They expose no synchronous/live surface; the Store pane explicitly refreshes after
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
ERRORING rather than degrading (the D14 rule — the bound is printed):

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

Non-claims, in one place: no maintenance of unindexed or non-equality joins,
no cross-connection invalidation (§6's `data_version` is
the signal), no maintenance over asynchronous connections —
`capabilities.live` is `false` there and a registration is `JD0051`
naming the reason, because maintenance point-reads rows synchronously
inside delivery (the wasm driver's oo1 API is synchronous, which is
why the browser has live queries at all). Replication is specified separately in
[REPLICATION-FORMAT](REPLICATION-FORMAT.md). There is no ordering guarantee for
unordered queries beyond §9's determinism.

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
to place rows in and re-runs, so an `eventTime` on `store.live` is
`JD0053` too.

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
foreign-key index. Every binding needs a key and a distinct root. The projected
identity is the tuple of source identities, so duplicate projected values remain
distinct. Default entity result order follows physical row insertion order;
point reads preserve that order even when a key is deleted and reinserted. A
left join uses a canonical `$allowing-empty` binding over an equality-filtered
inner subquery. Its absent child can be defaulted to null. Graph projections
embed equality-filtered child queries in a single outer row's return object.
Global-root reads outside those bindings re-run because changing one row can
change every projected graph.

`dependencyReads`, `refreshedRoots` and `refreshedGroups` expose the work done.
`dependencyReads` counts logical changed-row reads; a row-position lookup is an
additional statement. No full query reruns occur under these strategy labels.
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

Canonical single-level groups accept one or more key expressions over one
collection binding, an optional fully translated filter, and either a bare
key, one count/sum/avg/min/max expression, or an object containing key,
`$default: [key, null]`, and aggregate members. Global-root reads, ordering,
and windows remain rerun shapes. Aggregate expressions are evaluated by the
query engine, including empty results and errors; maintenance does not
substitute JavaScript arithmetic for query operators.

Keys preserve structural equality and distinguish missing from null. Source
holders retain physical row positions: changing a holder preserves its
position, and deleting a group's earliest holder may move that group's
output. Unaffected group outputs retain reference identity. Only affected
groups are reevaluated, followed by an optional final aggregate over all group
outputs. This costs work proportional to the affected groups plus group-output
ordering/folding, rather than constant-time arithmetic deltas.

`live.maxMaintained` counts source holders and group output items;
`live.maxBytes` counts their serialized documents. This includes document
members omitted from a small aggregate result. Exceeding a bound refuses
registration or closes an active query with `JD2060`; the last delivered
result remains unchanged. Engine failures follow the same invalidation path.

`node --expose-gc benchmark/changeflow.js` compares every mutation against a
fresh query and a patch-only consumer. The
[generated comparison table](REPLICATION-FORMAT.md#measurements) includes
multiple-key groups, an aggregate of groups and distinct beside forced reruns.
It reports initialization allocations and both median and tail mutation time;
heap deltas before collection are not precise retained-state sizes. The fixture
has 200 initial rows and 15 mutations per case, so these measurements establish
correctness and costs for that fixture rather than a universal crossover.

## Structural range adapter

`@jarenjs/linq/db` exposes bounded ranges over captured hybrid entity roots, using the existing keyset pager and committed observer. Its live event is an explicit source reset with monotone revision; this does not promote offset windows or the remaining incremental shapes. See [COLLECTION-PROVIDER](../../app/docs/COLLECTION-PROVIDER.md) for credits, snapshot identity and disposal. Maintained top windows check offscreen rows against their bound and release retained state on close.
