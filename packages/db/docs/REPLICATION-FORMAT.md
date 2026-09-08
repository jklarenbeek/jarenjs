# Replication format and runtime

`jaren-replication` 0.1 is a transport-neutral logical transaction. Open an empty
store with `replication: { replica: 'host-issued-id' }`; capture is enabled when
omitted. Existing replication stores must reopen with the same identity and
model. Every writer of that file must enable replication. External SQL writes
and opening a replicated file without replication are outside the history
contract; a detected before-image disagreement refuses with `JD2104`.

The host owns network transport, authentication, replica identity allocation and
resolver policy. A replica id must remain unique to its writer lineage. The
runtime works on SQLite Node, worker and wasm hosts through session or journal
capture. Drivers without `changeCapture` refuse at open; PostgreSQL capture is
not implemented. Journal replication refuses models with cascading or set-null
child foreign keys (`JD0051`), because the journal cannot observe those effects.
Session capture includes them. Both modes support membership cascades and
roll back an envelope whose side effects are absent from its logical operations.

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

Data, receipt, per-row causal metadata, capture record and frontier settle in
the same transaction. Replication is available only on the root Store; transaction
views expose no replication API. Failed validation, cancellation, constraint checks or
commit roll everything back. Subscribers run through the existing committed
capture delivery path. Tests kill a process immediately before and after commit
and verify both data and frontier after reopening.

Pages use the shared cursor and byte-credit drain. `limit` counts whole envelopes;
`maxBytes` counts complete canonical envelope bytes. An indivisible oversize
envelope is `JD2074`. Retention loss returns `resetRequired: true`, no items and
no continuation. `earliestAvailable`, `highWatermark`, `next` and `hasMore` describe
the local outbox. Pages and snapshots take a consistent store transaction.
`signal` and `deadline` are honored through existing cancellation contracts:
queue cancellation is `JD2064`, operation-boundary cancellation `JD2072`, and an
expired deadline `JD2075`.

Defaults are `retention: 1000`, `maxOperations: 10000`, `maxBytes: 4194304`.
Operation overflow is `JD2106`; all credits are positive safe integers. Retention
prunes only outgoing envelope history. Replay receipts, row tombstones and
conflict evidence remain durable. They are deliberately not claimed to be a
bounded total database size. Internal tables use the reserved `_jaren_replica`
prefix. No schema migration or revision rewrite of this protocol is implicit.

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

Measured 2026-09-08, v24.19.0, AMD Ryzen 9 5900HX with Radeon Graphics; 15 mutations per case.

| Shape | Strategy | Initialize ms | Mutation p50 ms | Mutation p95 ms | Initialization heap bytes |
|---|---|---:|---:|---:|---:|
| selective join | join | 16.663 | 0.323 | 2.119 | 4878848 |
| selective join | rerun | 0.899 | 0.746 | 1.622 | 347160 |
| high fan-out join | join | 7.314 | 1.901 | 3.179 | 4851232 |
| high fan-out join | rerun | 0.860 | 0.850 | 1.188 | 340328 |
| graph | graph | 7.462 | 0.459 | 0.750 | 4811712 |
| graph | rerun | 4.539 | 4.042 | 4.979 | 1417928 |
| nested groups | nested-group | 6.775 | 0.252 | 0.795 | 2057832 |
| nested groups | rerun | 0.897 | 0.472 | 0.685 | 295808 |
| offset groups | rerun | 1.519 | 0.459 | 0.547 | 383648 |
| offset groups | rerun | 0.884 | 0.426 | 0.585 | 282280 |

| Capture | Envelopes | Operations | Bytes | Apply p50 ms | Replay p50 ms | Conflict p50 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| session | 15 | 15 | 3169 | 0.458 | 0.118 | 0.204 |
| journal | 15 | 15 | 3169 | 0.294 | 0.092 | 0.161 |

Selective maintenance avoids repeated full SQL evaluation. Initialization and high-fan-out maintenance can cost more than rerunning; the table includes both. Offset groups remain rerun in both requested modes.

<!--/fact-->
