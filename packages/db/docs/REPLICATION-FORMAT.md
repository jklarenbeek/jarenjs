# Replication format and runtime

`jaren-replication` 0.1 is a transport-neutral logical transaction. Open an empty
store with `replication: { replica: 'host-issued-id' }`; capture is enabled when
omitted. Existing replication stores must reopen with the same identity and
model. Every writer of that database must enable replication. External SQL writes
and opening a replicated database without replication are outside the history
contract; a detected before-image disagreement refuses with `JD2104`.

The host owns network transport, authentication, replica identity allocation and
resolver policy. A replica id must remain unique to its writer lineage. The
runtime works on SQLite Node, worker and wasm hosts through session or journal
capture, and on PostgreSQL through journal capture and native bounded cursors.
The same envelopes apply PostgreSQL → SQLite, SQLite → PostgreSQL and
PostgreSQL → PostgreSQL — for documents both engines can store. SQLite
stores a string holding U+0000 or an unpaired surrogate; PostgreSQL's
`jsonb` cannot (`JD2005`), so a SQLite-origin envelope carrying such a
document does not apply to a PostgreSQL replica: its apply is `JD2005`,
every later envelope of that origin `JD2100` (the gap it left), and a
`reset` from a snapshot holding the document `JD2005` again. Keep such
values out of documents that replicate to PostgreSQL. Drivers without `changeCapture`, and PostgreSQL's
buffered cursor mode, refuse at open. Both capture modes record the rows a delete's foreign keys
remove or null and the membership rows of every row it removes, so models with cascading and set-null
relations replicate in either mode, and an envelope whose side effects on the replica are absent
from its operations rolls back (`JD2104`). A journal origin records a deleted row under the key it
was given: a delete of an integer-keyed row by another spelling of its key (`'16.0'`, `'016'`)
refuses its replicated transaction `JD0060`, where session capture commits it.

PostgreSQL enrollment verifies engine metadata, deterministic binary text
collation, permanent managed tables and deferrable foreign keys. New managed
foreign keys are `DEFERRABLE INITIALLY IMMEDIATE`; the restrictive delete action
uses `NO ACTION`. Ordinary writes still enforce each statement. Replay explicitly
defers checks until transaction settlement, because canonical envelope ordering
is independent of relationship order. Earlier immediate `RESTRICT` tables remain
usable for ordinary Store operations; replication refuses them with `JD0051`
until a reviewed native migration makes their foreign keys deferrable with
`NO ACTION`. Opening never performs that migration implicitly. PostgreSQL's
[constraint documentation](https://www.postgresql.org/docs/18/ddl-constraints.html)
explains why `RESTRICT` cannot be deferred.

Malformed replication metadata refuses with `JD0002`. Physical/adopted tables,
user triggers, rewrite rules, row-level policies, inherited/unlogged tables and
incoming foreign keys from unmanaged tables are outside enrollment. Schema changes
and external writers after enrollment remain host-owned; startup verification
is not continuous DDL monitoring or universal CDC.

## Envelope

```json
{
  "$replication": "0.1",
  "replica": "site-a",
  "seq": 1,
  "frontier": {},
  "model": "application-model-revision",
  "operations": [
    { "table": "notes", "key": "note/one", "before": null,
      "after": { "id": "note/one", "body": "hello" } }
  ]
}
```

`model` is the store's `shapeHash(model)` revision. `seq` is a positive safe
integer, allocated from the replica's durable frontier in the data transaction.
The identity is `replicationIdentity(replica, seq)`, the JSON encoding of their
pair, so separators inside host ids cannot collide. A frontier maps host ids to
non-negative safe sequences. The sender's frontier entry must equal `seq - 1`,
with an absent entry meaning zero. Property names such as `__proto__` and
`constructor` remain ordinary replica ids.

Each operation is one net row transition. `before: null` inserts, `after: null`
deletes, and two objects replace the complete logical row. A table/key occurs
once per envelope. Composite keys use the capture format's JSON-array token;
single keys use their scalar text. Entity documents include mapped scalar and
foreign-key fields, omit relation projections and retain authored version and
timestamp values. Membership tables carry their two keys. Application performs
schema validation through the store's configured validator and reuses physical
column plans; it does not generate fresh defaults or version stamps.

`normalizeReplication` validates and detaches the document. `encodeReplication`
produces deterministic JSON. Object members are canonically ordered; operation
array order remains part of identity. Capture sorts net rows by table/key, making
physical session and journal output equal. Envelope order preserves transaction
order. Physical insertion order inside a netted transaction or snapshot is not a
portable query ordering: use an explicit query order when comparing replicas.
Receipts retain the entire canonical payload, avoiding hash-collision ambiguity.

Unknown members and versions, empty ids, unsafe sequences, non-JSON values,
cycles, duplicate net rows and unchanged operations are `JD0060`. Nesting is
limited to 128 object/array ancestors. JSON Schema artifacts describe structural
validation; cross-field sequence, uniqueness and causal checks are runtime
constraints. Current and draft-07 artifacts ship for envelopes and snapshots:

- `@jarenjs/db/schemas/jaren-replication.schema.json`
- `@jarenjs/db/schemas/jaren-replication.draft-07.schema.json`
- `@jarenjs/db/schemas/jaren-replication-snapshot.schema.json`
- `@jarenjs/db/schemas/jaren-replication-snapshot.draft-07.schema.json`

## Applying and exporting

```js
const source = await openStore(model, {
  driver, replication: { replica: 'site-a', retention: 1000 }
});
const page = await source.replication.page({ after: 0, limit: 100, maxBytes: 1048576 });
for (const envelope of page.items) {
  const result = await target.replication.apply(envelope);
  if (result.status === 'conflict') hostReport(result.conflicts);
}
```

`apply` returns `applied`, `duplicate` or `conflict`, together with the committed
frontier and conflict records. Successful duplicate delivery performs no row
write or live emission. An acknowledged identity with different bytes is
`JD2101`. A sequence or causal gap is `JD2100`: no suffix is applied. Deliver
missing envelopes first, then retry, or perform an explicit reset. Model mismatch
is `JD2102`. Imported envelopes keep their original identity and produce no local
outbox entry, preventing echoes. A host forwarding between peers must preserve
the original envelopes; `page()` exports this replica's own commits only.

Replay writes an envelope's rows in its order — the canonical (table, key)
order every exported envelope has; a reset sorts the rows it writes into it —
with foreign-key checks deferred to the commit, except where an entity row has
to wait for another. A row the envelope keeps whose stored cascading key names
a row it removes, directly or through removed rows whose own cascading keys
lead there, is written before each of those removals, which the replica's own
cascade would otherwise apply to it first. The write that releases a value of
an entity's unique slot — a one-to-one key, a unique member, a unique index,
composite or partial (a partial index holds the rows its condition is true
for) — runs before the write that takes it, because uniqueness is checked as
each write runs. So a transaction that moves a child to a new parent and
deletes the old one applies and resets, and so does one that passes unique
values between entity rows, unless no order can replay it: values rotated
between rows, or a row moved off a removed parent that takes a value the
removal releases (only a self-referencing table, or a cascading path that
returns to the table, can form this). Such an envelope refuses `JD2005` when
the replay reaches the taking write first, `JD2104` when it reaches the
removal first, whose cascade removes the row that had to move. Collection
documents keep canonical order: a unique value passed to a document that sorts
before the one releasing it refuses `JD2005`. A child added on one replica under a parent
another replica deletes refuses on both sides: `JD2104` where the deletion
arrives (its cascade would remove a row the envelope does not name), `JD2005`
where the child arrives (its parent is gone). Neither replica can then apply
the other's later envelopes (`JD2100`) or reset from the other's snapshot
(`JD2105`); a store resets from either snapshot only while that snapshot covers
its whole acknowledged history — an empty store, or one holding only what the
two replicas shared. Under journal capture a
cascading delete counts itself and its removed, nulled and membership rows
against `maxOperations`, and their documents against `maxBytes`, and refuses
`JD2106` before it runs; its complete envelope can still exceed `maxBytes` at
commit (`JD2074`). Under session capture both bounds apply at commit.

Data, receipt, per-row causal metadata, capture record and frontier settle in
the same transaction. Replication is available only on the root Store; transaction
views expose no replication API. Failed validation, cancellation, constraint checks or
commit roll everything back. Subscribers run through the existing committed
capture delivery path. Tests kill disposable SQLite and PostgreSQL client
processes before and after commit and verify data, frontier and receipt replay
after reopening. Native tests repeat the restart and lose a successful COMMIT
reply: the call fails with `JD2087`, and a fresh Store reconciles the durable
receipt as `duplicate`. The lost connection alone does not establish rollback.
These are client-death/acknowledgement tests; they do not simulate server power loss.

Pages use the shared cursor and byte-credit drain. `limit` counts whole envelopes;
`maxBytes` counts complete canonical envelope bytes. An indivisible oversize
envelope is `JD2074`. Retention loss returns `resetRequired: true`, no items and
no continuation. `earliestAvailable`, `highWatermark`, `next` and `hasMore` describe
the local outbox. Pages and snapshots take a consistent store transaction.
PostgreSQL shares the schema-scoped capture lock with writers while reading
the frontier and bounded rows. The lock prevents mixed checkpoints under
READ COMMITTED; a slow bounded snapshot can therefore delay a writer within
the configured lock and statement deadlines.
`signal` and `deadline` are honored through existing cancellation contracts:
queue cancellation is `JD2064`, operation-boundary cancellation `JD2072`, and an
expired deadline `JD2075`.

Defaults are `retention: 1000`, `maxOperations: 10000`, `maxBytes: 4194304`.
Operation overflow is `JD2106`; all credits are positive safe integers. Retention
prunes only outgoing envelope history. Replay receipts, row tombstones and
conflict evidence remain durable. They are deliberately not claimed to be a
bounded total database size. Internal tables use the reserved `_jaren_replica`
prefix and are excluded from model introspection and migration shape comparisons.
No schema migration or revision rewrite of this protocol is implicit.

## Conflicts

Concurrent incompatible whole-row writes reject by default. A `conflict` result
does not acknowledge the remote envelope and leaves the local row intact.
`replication.conflicts({ limit, maxBytes, signal, deadline })` reads persisted evidence: the common base,
local value and frontier, remote value and envelope position, resolver identity
and decision. A rejected envelope reserves its canonical identity too, so retries
cannot replace its contender with different content.

An optional `replication.resolver` has `{ id, resolve }`. Its synchronous pure
function receives frozen evidence and returns `{ action: 'local' }`,
`{ action: 'remote' }`, or `{ action: 'merged', value }`; a merged value may be
null for deletion. Invalid decisions refuse with `JD2103`. Both contenders and
the resolver id are retained for every resolution. No resolver is bundled.
Determinism and convergence of a custom policy are the host's responsibility:
choosing the receiver's local value on each replica is deterministic but does
not make replicas agree. Independent non-conflicting deliveries converge without
resolver policy. Concurrent changes to different fields of the same row are
conservatively whole-row conflicts in this version.

## Reset handshake

`source.replication.snapshot()` returns a `jaren-replication-snapshot` 0.1
document containing `model`, `frontier`, logical `rows` with their causal
frontiers, and complete acknowledged `receipts`.
`target.replication.reset(snapshot)` validates and atomically installs it while
emitting ordinary live invalidations. The snapshot must dominate all target
acknowledgements and preserve every known receipt's bytes. It cannot discard
unsynchronized local history (`JD2105`) or rewrite identities (`JD2101`).
Snapshot receipt sequences must completely cover their frontier, and row
frontiers cannot be ahead of it. Subsequent duplicate deliveries remain
verifiable because the receipts travel with the snapshot.

Resets are intentionally bounded single documents: rows plus receipts must fit
`maxOperations`, and the complete encoding must fit `maxBytes`. Snapshot and
conflict readers pull through the shared cursor and stop before accumulating
beyond the configured credits. Resolver outputs and conflict evidence also
obey `maxBytes`. Very large
histories require a separately designed paged snapshot/receipt compaction
protocol; this implementation refuses them rather than splicing partial state.
A reset preserves the receiver's own replica identity and clears its outgoing
history. Future writes continue its sequence from the imported frontier.

## Authoring

`@jarenjs/linq/db` exports a deterministic pen using the same validator:

```js
const envelope = defineReplication({ replica: 'site-a', seq: 1,
  frontier: {}, model: revision })
  .change('notes', 'one', null, { id: 'one', body: 'hello' })
  .toDocument();
```

The pen snapshots its input and emits the same canonical bytes as hand-authored
JSON. Normal applications export committed Store envelopes; constructing an
envelope does not allocate or acknowledge a Store sequence.

## Measurements

Run `npm run benchmark:changeflow`. Every timed mutation is followed by a fresh
query and a patch-only consumer comparison; every measured mutation changes its
visible result. Graph measurements mutate a child of one owner. Replication deliveries compare
complete database state, including relations. Conflict timings retry one
rejected contender and assert unchanged data/frontier plus durable evidence. Timing includes capture and live
delivery; oracle time is reported separately. Heap deltas are uncollected
allocations observed after initialization, not precise retained-heap sizes.

<!--fact:db.changeflow-->

Measured 2026-10-07, v24.20.0, AMD Ryzen 9 5900HX with Radeon Graphics; 15 mutations per case.

| Shape | Strategy | Initialize ms | Mutation p50 ms | Mutation p95 ms | Initialization heap bytes |
|---|---|---:|---:|---:|---:|
| selective join | join | 17.956 | 0.388 | 2.542 | 5308632 |
| selective join | rerun | 1.125 | 0.845 | 1.365 | 394016 |
| high fan-out join | join | 7.760 | 2.192 | 2.957 | 5015568 |
| high fan-out join | rerun | 0.879 | 0.835 | 1.220 | 404168 |
| graph | graph | 7.985 | 0.301 | 0.640 | 5179712 |
| graph | rerun | 4.385 | 4.075 | 4.648 | 1505048 |
| multiple-key groups | group | 7.964 | 0.261 | 1.102 | 2253296 |
| multiple-key groups | rerun | 0.903 | 0.520 | 0.625 | 307712 |
| group aggregate | group | 3.767 | 0.248 | 0.379 | 2009520 |
| group aggregate | rerun | 0.735 | 0.453 | 0.542 | 272248 |
| distinct | distinct | 3.564 | 0.177 | 0.305 | 1764384 |
| distinct | rerun | 0.664 | 0.241 | 0.388 | 87656 |
| nested groups | nested-group | 3.815 | 0.210 | 0.313 | 1915256 |
| nested groups | rerun | 0.820 | 0.530 | 0.634 | 306696 |
| offset groups | rerun | 1.252 | 0.462 | 0.652 | 376872 |
| offset groups | rerun | 0.865 | 0.512 | 0.586 | 294328 |

| Capture | Envelopes | Operations | Bytes | Apply p50 ms | Replay p50 ms | Conflict p50 ms |
|---|---:|---:|---:|---:|---:|---:|
| session | 15 | 15 | 3169 | 0.472 | 0.121 | 0.214 |
| journal | 15 | 15 | 3169 | 0.301 | 0.099 | 0.174 |

Selective maintenance avoids repeated full SQL evaluation. Initialization and high-fan-out maintenance can cost more than rerunning; the table includes both. Offset groups remain rerun in both requested modes.

<!--/fact-->
