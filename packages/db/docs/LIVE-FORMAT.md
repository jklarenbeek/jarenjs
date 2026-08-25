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
  emits its `remove` without having seen the old document; and of the
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

`seq` is monotonic; with the log enabled it continues across reopens
(seeded from `MAX(seq)`), without it it is per-process. Retention is
a bounded count (`retention`, default 1000): older rows are pruned in
the same transaction. The log is an ordered, replayable stream —
which is what makes a late-joining consumer possible. **Replication
is not built here**, and this log alone does not make it safe: there
is no conflict resolution, no site identity, no causal ordering
across writers. That sentence is the whole claim.

## 6. Cross-connection behaviour and non-claims

Another process (or another connection) writing to the same file
produces NO local patches — sessions and journals are per-connection
facts. The honest mitigation is a coarse signal, not a pretend
fine-grained one: `store.dataVersion()` reads `PRAGMA data_version`,
which changes when ANOTHER connection commits; poll it and treat a
change as "re-read what you care about". Cross-tab delivery is §7's
story (the live-query layer).

Non-claims, in one place: no replication, no conflict resolution, no
capture of writes made by other connections, no capture on stores
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
});
live.result;              // the maintained result document
live.mode;                // { strategy, mode: 'incremental'|'rerun', reason }
const stop = live.subscribe(({ patch, seq, error }) => { /* … */ });
live.close();
```

`store.live(document, options)` registers an entity-root document (the
multi-entity shape of MODEL-FORMAT §10) the same way. Live queries
REQUIRE change capture — the patch stream is the invalidation source —
and registering on a store opened without `capture` is `JD0050`.

**This table is normative.** Every row is implemented and tested;
nothing outside it is attempted. Classification reads the compiled
PLAN (never the raw document), so "extractable" below means exactly
what the pushdown planner already means by it.

| Construct (as planned) | Strategy | Maintained state |
|---|---|---|
| `where` whose predicates translate (the plan's filter), no order, no aggregate | **incremental rows**: per-row re-evaluation; insert / remove / replace in the result | the result rows |
| the same with a per-row `select` projection (row-mode plan) | **incremental rows**: the affected row alone is recomputed; a source row may project to several items | result rows, grouped by source key |
| `orderBy` over extractable paths, optional `limit`, offset 0 | **maintained window**: a sorted structure; ties broken by the collection key, appended as the final sort term; an insert sorting beyond a full window is a no-op | the window rows and their sort keys |
| whole-query `count` / `sum` / `avg` / `min` / `max` (the plan's aggregate), optional `where` | **running accumulator** plus a per-row contribution map — a delete can only be answered from retained contributions (§3: a `remove` carries no old value). `min`/`max` removal of the last extremum holder FALLS BACK to a recompute over the retained contributions; the accumulator alone cannot answer, and this fallback is the documented cost | one contribution per matching row |
| single-level `groupBy` with aggregate returns, in the canonical form below | **per-group deltas**: the accumulator machinery, one instance per group; groups appear in first-appearance order, exactly the engine's order | per-group, per-row contributions |
| `where` whose spatial predicate is **refined** (the plan pushed a bounding-box or cell-range pre-filter and left the exact `$within`, bounded `$distance` or over-long cell prefix to the residual — `explain().prefilters` with `exact: false`), no order, no aggregate; optional per-row `select` | **incremental rows** — the geofence: the initial fetch narrows through the derived index, and every touched row is re-evaluated by the engine's EXACT predicate, so a point emits `add` when it enters the region, `remove` when it leaves, and nothing while it moves within (a whole-document return sees a `replace` carrying the new position) | the result rows |
| a refined spatial predicate over a collection with **no document key** (`key: null`, rowid identity) | **re-run on invalidation** — the per-row strategy tracks a row by its declared key, and a rowid is not one; the reason says `rows without a document key cannot be tracked` | the previous result, for diffing |
| `orderBy` beside a refined spatial predicate — over `$distance` (not a path) or over a member (the set residual drops the planner's order terms) | **re-run on invalidation**, the ordering named as the reason | the previous result, for diffing |
| a whole-query aggregate or a `groupBy` whose `where` is a refined spatial predicate | **re-run on invalidation** — the accumulator needs a fully translated selection and a refinement is not one; the reason says so | the previous result, for diffing |
| a spatial predicate the planner **refused** (no `derive` index on the member, an untyped member, an unbounded probe) | **re-run on invalidation**, the refusal named — it never translated, so nothing narrows the fetch | the previous result, for diffing |
| joins, multi-entity roots, graph loads, every entity query | **re-run on invalidation — declared, not attempted** in this version | the previous result, for diffing |
| anything else: non-translatable predicates, `limit` without `orderBy`, `offset` > 0, windowed aggregates, `@jarenjs/linq`'s nested two-level `groupBy` emission, non-canonical group returns | **re-run on invalidation**, the reason named | the previous result, for diffing |

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

The **canonical group form** the classifier recognises (and the only
one — the linq chain's nested emission re-runs, stated plainly):

```json
{ "$for": { "it": "$[*]" },
  "$where": { "…optional, translatable…": [] },
  "$groupby": { "g": "$it.dept" },
  "$return": { "key": { "$default": ["$g", null] },
               "n": { "$count": "$it" }, "total": { "$sum": "$it.pay" } } }
```

After `$groupby`, `$it` is the group's item sequence and `$g` its key;
return members are the group key or an aggregate over `$it` (a path
below it selects the aggregated member). Anything else in the return
is not canonical and re-runs.

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
order, on the store's own connection. Writes from ANOTHER connection
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

- ONE owning context holds the sole connection — a `SharedWorker`
  where available, else a leader tab elected via `navigator.locks` —
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
refusal, reload survival) belongs to the browser-driver order and its
Playwright suite; this section is the decided contract it implements.

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

Non-claims, in one place: no incremental joins (re-run is the declared
strategy), no cross-connection invalidation (§6's `data_version` is
the signal), no maintenance over asynchronous connections in this
version (every current driver is synchronous; the browser driver's
order owns that story), no replication, and no ordering guarantee for
unordered queries beyond §9's determinism.
