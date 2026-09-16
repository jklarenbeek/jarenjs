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
| Physical tables and catalog | Explicit codecs, exact bigint/decimal strings, date/time distinctions, declared layout and rich loss/disposition inventory: [physical tests](../../../test/db/postgres-physical.test.js) | Arbitrary catalog objects are inventoried, not automatically translated into model intent |
| Native migrations | Reviewed native catalog artifacts, dependency/sequence preservation, receipts, transaction rollback and separate shadow replay: [migration tests](../../../test/db/postgres-migration.test.js) | Concurrent index creation and unreviewed destructive dependencies refuse; opening never silently changes an existing schema |
| Committed feed | Shared write journal, transactionally locked high-water and finite resume/reset: [capture tests](../../../test/db/postgres-capture.test.js) | Participating managed writers only; arbitrary external SQL, unenrolled trigger/cascade effects and physical layouts are outside capture coverage |
| Jobs, flow and outbox | Shared engine, concurrent row-locked claims, leases, fenced checkpoints and atomic business/job writes: [job tests](../../../test/db/postgres-jobs.test.js) | Another database/file is another transaction; external delivery needs durable intent, receipts and reconciliation |
| Live and lexical freshness | Optional `@jarenjs/db/async-live`, bounded resnapshot and the existing lexical ranker: [async tests](../../../test/db/postgres-async-live.test.js) | Not synchronous incremental live or native PostgreSQL full-text ranking; NOTIFY only wakes a durable page reader |
| Managed replication | PostgreSQL ↔ SQLite and PostgreSQL ↔ PostgreSQL, receipts, conflicts, bounded reset, commit uncertainty and process-death recovery: [replication tests](../../../test/db/postgres-replication.test.js) | Native cursors required; physical/external-writer replication, cascading/set-null journal models, unbounded histories and paged bootstrap remain refused or unscheduled |
| Application composition | Identical app/contract/Store/jobs/feed/live/replication oracle: [backend-app.js](../../../test/consumer/backend-app.js) | Host authorization is checked again on replay; credentials, handles and callbacks stay outside JSON state |
| Operator recovery | Coherent logical backup on all three server versions; archived WAL and named target on 17.11 | Synthetic recovery is not power-loss, fleet failover, provider-side reconciliation or downstream cutover evidence |

The [host contract](HOSTS.md#postgresql-sessions), [physical format](MODEL-FORMAT.md#12-existing-column-layouts),
[migration format](MIGRATION-FORMAT.md), [feed/live contract](LIVE-FORMAT.md),
[jobs contract](JOBS-FORMAT.md) and [replication contract](REPLICATION-FORMAT.md)
define the options, refusal codes and resource owners.

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
| 16.15 (Debian 16.15-1.pgdg12+2) | 13 / 14 | 24239 | 9 | 2329.70 |
| 17.11 (Debian 17.11-1.pgdg12+2) | 13 / 14 | 24569 | 9 | 1845.89 |
| 18.6 (Debian 18.6-1.pgdg12+2) | 13 / 14 | 24513 | 9 | 2023.24 |

Archived WAL: 17.11 (Debian 17.11-1.pgdg12+2), 13 tables / 14 rows, 7632.22 ms; source stopped before promotion: true. Physical sequence advances are retained in the result. Power loss and fleet failover were not tested.

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
| bun-executable | catalog | 237187072 | 536870912 | within reference |
| bun-executable | archive-stock | 1080086528 | 1073741824 | loss (+6344704) |
| node-executable | catalog | 290295808 | 536870912 | within reference |
| node-executable | archive-stock | 849428480 | 1073741824 | within reference |

These larger physical SQLite workloads are separate from the small build-selected managed application. Functional recovery success does not imply memory-budget success. Earlier samples remain in the resource history.

<!--/fact-->

Local tarball versions and integrity records prove the installed bytes tested.
A Git tag or website deployment does not prove npm registry publication. Record
registry version/integrity separately when selecting packages for deployment.
Original product upgrades, native operating systems beyond tested Linux, manual
accessibility/input behavior and actual provider acceptance need their own evidence.
