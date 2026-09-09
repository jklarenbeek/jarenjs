# Database execution hosts

All hosts implement the same Driver and Connection contracts. Model, query,
transaction, cursor, include and capture behavior stays in the Store. Host
capabilities are observed when the connection opens. The common oracle and
lifecycle corpus is `test/db/store-hosts.test.js`; it checks values and coded
errors across Node, worker, pool, wasm sessions and wasm journal fallback.

Concurrent PostgreSQL first opens can race while creating the same collection
or entity table. Each initialization transaction retries one catalog-creation
collision after rollback, then re-reads and verifies the winning shape. Ordinary
constraint failures remain errors, and a repeated collision refuses the open.

## Node workers

```js
import { openStore } from '@jarenjs/db';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';

const driver = nodeWorkerDriver({ windowRows: 64, windowBytes: 1024 * 1024 });
const store = await openStore(model, { driver, path: 'application.sqlite' });
// The ordinary Store methods and transaction scopes apply here.
await store.close();

const pool = nodeWorkerPoolDriver({ readers: 2, queueCapacity: 64, graceMs: 5000 });
const pooledStore = await openStore(model, { driver: pool, path: 'application.sqlite' });
await pooledStore.close();
```

Each worker owns one `DatabaseSync`. Requests use structured clone, versioned
frames, opaque statement/cursor IDs and a connection generation. A cursor receives
at most its row and byte credits per frame; the endpoint may retain one lookahead
row. Credits measure JSON keys/scalars plus raw blob bytes, excluding fixed frame
metadata. One oversized row is `JD2092`. Abort takes effect at a row boundary;
`return()` awaits remote cleanup. Neither serializes a function or replays a write.

| Worker option | Default | Meaning |
|---|---:|---|
| `windowRows` | 64 | Rows per credit frame |
| `windowBytes` | 1048576 | Counted row bytes per frame |
| `maxPending` | 64 | Admitted non-cleanup requests |
| `maxStatements` | 1024 | Remote prepared statements per connection |
| `maxCursors` | 64 | Remote open cursors |
| `allMaxRows` | 100000 | Compatibility `all()` maximum rows |
| `allMaxBytes` | 16777216 | Compatibility `all()` maximum counted bytes |
| `startupTimeoutMs` | 10000 | Worker readiness deadline |
| `closeTimeoutMs` | 5000 | Cleanup acknowledgement deadline |

All worker options are positive safe integers. Cleanup reserves at most one
request per cursor plus one close beyond `maxPending`; total pending admission is
also capped. A compiled transient cursor marks its statement ephemeral, releasing
its remote ID on exhaustion or return. Cached statements remain subject to the
statement cap. `all()` drains credited frames under both limits and refuses excess;
it never receives an unbounded whole-result frame. `metrics()` on an opened driver
connection reports pending requests, frame/row high-water marks, generation and
health. It contains no SQL or parameter values.

Worker exit or restart fences every old statement, cursor and transaction with
`JD2090`. The failure is retryable only outside a transaction; this is permission
to reopen, **not evidence that an uncertain write can be retried safely**. The
connection's `restart()` returns a new connection; old Store handles stay invalid.
A failed transaction is never migrated or replayed. Queue overflow is `JD2091`,
with `retryable: true` and the observed queue `depth`. `JD2093` identifies malformed
requests; malformed responses invalidate the generation.

Close stops admission and awaits cleanup, then requests worker termination at the
deadline and rejects with `JD2090`. Node cannot preempt a synchronous native SQLite
call with V8 worker termination. The expired generation is fenced immediately,
but the native call and its locks may outlive that refusal; process exit can wait
for the native call too. A timeout therefore has an unknown write outcome, not a
promised rollback. `capabilities.cancellation.midStatement` remains false.

Worker connections declare sessions, user functions, aggregates and online backup
unavailable: journal capture provides the same logical patches, and query residuals
run on the caller. Synchronous Store methods and live queries are unavailable on
these asynchronous connections. Bun can import both subpaths; opening a Node
SQLite worker there reports the named unavailable-binding failure (`JD0003`).

## WAL pool policy

A file pool opens exactly one writer and `readers` read-only workers, verifies WAL,
and routes explicitly classified reads to readers. Unclassified work goes to the
writer. `:memory:` uses the writer alone. A pool opened with `readOnly: true` has
only read-only workers and requires an already-WAL file. Default reader count is
two (allowed range zero through 32); the queue admits at most `queueCapacity`
waiting requests (default 64, zero allowed), in strict FIFO order. A blocked writer
at the head can leave a reader idle. Metrics report active/idle/queued, worker
health/generation/role/executions, and wait p50/p95 over the last 1024 admissions.

Compiled operation metadata supplies read classification, and SQLite itself
refuses a write on a read-only worker. Transactions pin one worker for their entire
lifetime, including nested savepoints. Normal writable Store transactions pin the
writer; a read-only opened pool pins a reader. There is no extra transport-specific
transaction API. Store root admission still serializes unrelated operations to
preserve existing ownership rules. Multiple classified Connection reads can run
concurrently; the pool does not promise parallel root Store calls.

Worker loss settles in-flight work once and discards the slot's prepared cache.
Replacement occurs only after its lease/transaction settles. Failed replacement
stops further admission with its actual error rather than leaving callers queued
forever. Close refuses queued work, grants active work `graceMs`, and closes the
workers after that grace. A commit already submitted to SQLite owns its settlement;
close waits for its acknowledgement even beyond grace, without interrupting that
writer. Native-call termination has the limitation described above.

## Synchronous cursors and include accounting

`store.sync.entity(name).cursor(document)`, `.loadCursor(spec)` and `.page(spec,
options)` use the same plans, classification, keysets and bounds as the asynchronous
entity set. Cursors implement `Symbol.iterator`, `next`, `return` and
`Symbol.dispose`; page methods return values. Early break, consumer throw, abort,
error and Store close release the row source exactly once. A scope cannot outlive
its transaction, and root cursors acquire admission per pull.

Include text is byte-checked before decoding. JSON parsing's construction traversal
records serialized UTF-8 sizes bottom-up; nested bounds read those sizes before
attaching reconstructed children. There is no second full nested stringify.
Numbers, control escapes, paired and lone surrogates have differential coverage
against the native JSON serializer. This is a bounded decoded graph, not a streaming
JSON parser: SQLite still produces the outer include text and JSON.parse constructs
its bounded value. The measurement below records the cost of the counting traversal
and WeakMap, including its timing and heap-growth regressions.

## Wasm capture and browser persistence

The wasm adapter probes create/attach/changeset/delete on a disposable live session.
Only success declares `sessions: true`; missing or failing bindings select journal
capture with `sessionReason`. Each changeset is copied out of wasm memory before its
native allocation is freed, so its buffer can be transferred. Every capture extent
and connection close deletes its owned session handles. Large integral JavaScript
numbers outside the safe integer range bind as doubles, avoiding the pinned oo1
binding's int64 truncation.

The data studio probes this ordered ladder independently of user agent:

| Mode | Requirements and durability | Synchronous/live |
|---|---|---|
| `opfs-sab` | COOP/COEP isolation, SharedArrayBuffer, registered VFS and write/reopen probe | Yes |
| `opfs-sahpool` | SAH-pool APIs and write/reopen probe; no isolation headers required | Yes |
| `indexeddb-snapshot` | IndexedDB atomic write/reopen probe and an exclusive Web Lock | No |
| `memory` | Last fallback; visibly non-durable, lost on reload | Yes |

A selected durable mode has an owner worker; other tabs use its channel. The UI
names the selected mode, durability and each rejected rung. The existing five boot
stages still name hung or failed work. The isolated fixture sets COOP `same-origin`
and COEP `require-corp`; this does not change production hosting headers.

`indexedDbSnapshotHandle(sqlite3, { name, indexedDB, maxBytes })` is an injected wasm
handle, not an OPFS VFS. It runs SQLite in memory and atomically replaces a versioned
IndexedDB snapshot after an autocommit write or transaction commit. A compare-and-swap
revision prevents independent connections overwriting a newer snapshot. The promise
resolves only on IndexedDB transaction completion. The default whole-database bound
is 16 MiB, checked before export and on restore. Each acknowledged write can therefore
copy the whole database: this fallback favors bounded durability over throughput.

Quota, revision conflict or persistence failure preserves the previously committed
snapshot and invalidates the in-memory connection (`JD2094`, non-retryable). Reopen
reads the last committed version. Interrupted replacements never publish partial
bytes. Read-only opens refuse writes. Live maintenance is explicitly unavailable
because commit acknowledgements are asynchronous; the studio Store pane refreshes
after writes. `openSnapshotStorage` exposes the versioned storage primitive for
hosts that need explicit snapshot cleanup.

## Measurements and reproducibility

<!--fact:db.hosts-->

Measured 2026-09-08, v24.19.0, AMD Ryzen 9 5900HX with Radeon Graphics; 7 samples per latency/include case.

| Host | Open p50 ms | Slow SQL p50 ms | Event-loop max ms | Tiny reads/s | Mixed work ms | Wait p95 ms |
|---|---:|---:|---:|---:|---:|---:|
| node | 0.19 | 87.04 | 92.34 | 876870 | 207.12 | 0.00 |
| worker | 52.99 | 85.23 | 3.52 | 19168 | 198.57 | 0.00 |
| pool-1-reader | 76.73 | 81.95 | 1.62 | 25109 | 207.11 | 190.32 |
| pool-3-readers | 152.95 | 82.50 | 1.86 | 26201 | 74.79 | 63.91 |

| Host | Cursor rows | Cursor ms | Sampled heap growth MiB | Sampled total RSS MiB |
|---|---:|---:|---:|---:|
| node | 100000 | 113.84 | 8.39 | 70.26 |
| worker | 100000 | 316.64 | 5.60 | 100.64 |
| pool-1-reader | 100000 | 295.61 | 8.45 | 124.79 |
| pool-3-readers | 100000 | 287.91 | 13.29 | 168.73 |

| Include accounting | Encoded bytes | Time p50 ms | Uncollected heap growth p50 MiB |
|---|---:|---:|---:|
| serialize-again | 3218891 | 12.38 | 8.00 |
| count-during-decode | 3218891 | 21.36 | 8.84 |

The worker event-loop acceptance bound is 50 ms. The original in-process baseline measured p50/p95/max event-loop delay of 1.07/86.97/87.62 ms, bare worker startup p50 27.48 ms, and duplicate include serialization 14.68 ms with 8.00 MiB uncollected heap growth. The current open measurement also includes driver probing; its startup cost is broader than that bare-worker baseline.

<!--/fact-->

The tiny workload is sequential `SELECT 7`; the mixed workload is 24 classified
reads with six interspersed writes. RSS includes worker heaps. Heap-growth figures
are uncollected allocations sampled in this process, not retained memory and not
portable heap limits. Cursor sampling occurs every 1024 rows. The final runner
measures all hosts on the same file-based workload. Timing, memory and throughput
losses are kept beside event-loop gains; these are observations, not speed promises.

Run `node --expose-gc benchmark/store-hosts.js` for the current measurements.
`benchmark/store-hosts-baseline.js` reproduces the separate initial recipe; do not
replace the baseline when measuring a change. The JSON records include runtime,
host, SQL and sample count. `npm run docs:derive` bakes these tables;
`npm run docs:check` rejects drift.

<!--fact:db.browserHosts-->

15 storage scenarios passed without skips, measured 2026-09-08.

| Engine | Version | Isolated | Ordinary | OPFS denied | All storage denied / quota |
|---|---|---|---|---|---|
| chromium | 149.0.7827.55 | opfs-sab | opfs-sahpool | indexeddb-snapshot | memory (non-durable) |
| firefox | 151.0 | opfs-sab | opfs-sahpool | indexeddb-snapshot | memory (non-durable) |
| webkit | 26.5 | indexeddb-snapshot | indexeddb-snapshot | indexeddb-snapshot | memory (non-durable) |

webkit isolated fallback: JD2061 — opfs-sab: the SharedArrayBuffer OPFS VFS is not registered; opfs-sahpool: Missing required OPFS APIs.. Selected indexeddb-snapshot (persistent).

<!--/fact-->

Build the website, run `storage.spec.js` with Playwright's JSON reporter, then pass
the report to `node benchmark/store-hosts-browser.js /tmp/storehosts-browser.json`.
The committed JSON includes the exact recipe. On a host lacking WebKit libraries,
run the browser command in the Ubuntu Playwright container as the workspace user.
The matrix tests actual write/reopen, aborted snapshot replacement, denied storage
and quota failure. Both initial capability observations and the final storage
results are retained under `benchmark/store-hosts-browser-*.json`.

## Scoped quirk review

Confirmed and fixed in the host path:

- Cursor abort/open races and late rows after return now release the eventual
  source exactly once; asynchronous failure/disposal waits for cleanup.
- Lost transaction generations unwind only when each owning rollback settles;
  failed commits retain their lease for rollback. Replacement failure stops admission
  with its actual error.
- Connection close releases active iterators. Remote shutdown starts its deadline
  before waiting for a native row; closed pools report no healthy or active worker.
- A failed session allocation no longer leaves capture depth open for the next
  write. Wasm session bytes have independent ownership and deterministic deletion.
- The pinned oo1 numeric binder truncates huge integral Numbers through int64;
  the adapter binds these as doubles, proven by the shared adversarial oracle.
- IndexedDB synchronous put failures and blocked opens settle and clean up;
  failed replacement preserves the previous committed bytes and invalidates the
  in-memory state. Browser tests prove the same behavior in actual storage.
- The pinned wasm build removes its private OPFS helper after initialization;
  the SAB path now removes closed files through the public storage API.
- Storage selection can finish before the Store opens. Query and insert controls
  now wait for the open acknowledgement, preserving input during slower IndexedDB
  boots. Browser assertions use stored rows when live maintenance is unavailable.
- The requested generation-code slot was already assigned to seek-anchor typing.
  Generation fencing uses the fresh `JD2090` code and preserves `JD2086`.

Confirmed beside this path, left unchanged:

- Root Store admission intentionally serializes unrelated operations; concurrent
  classified Connection reads are the pool's current parallelism boundary.
- V8 termination cannot preempt native SQLite execution. A true statement interrupt
  would need binding support; shutdown documents the unknown outcome explicitly.
- Asynchronous live maintenance remains unavailable; IndexedDB and Node workers
  expose that capability limitation instead of returning stale live results.

Checked and dropped:

- Browser database work already runs outside the UI thread; adding another Store
  or another query/transaction API was unnecessary.
- Build flags alone do not establish session support, and isolation headers alone
  do not establish a working VFS. Disposable live probes decide both.
- A second include serialization was unnecessary for exact Unicode byte bounds;
  the differential counter and deliberate off-by-one mutation detected disagreement.
- Read-only WAL workers do not accept writes, nested scopes do not migrate,
  transient cursors do not exhaust the statement cap, and failed writes are not
  automatically replayed. The lifecycle and fault corpus exercises each boundary.
