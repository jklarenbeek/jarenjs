# The Jaren jobs format — the durable queue

This document is normative. The key words MUST, MUST NOT, SHOULD and
MAY are to be interpreted as described in RFC 2119. Error codes join
the package's single runtime table (MODEL-FORMAT §7); this order adds
none — see §9.

## 1. Scope

A single-database job queue: enqueue, lease, execute, retry with
backoff, dead-letter, and recover after a crash — the persistence,
polling, locking, retries and recovery an adopter otherwise builds as
infrastructure. It is enabled per store and lives in two internal
tables beside the model's own:

```js
const store = await openStore(model, { driver: nodeDriver(), jobs: true });
const id = await store.jobs.enqueue('welcome-mail', { userId: 'u1' });
const worker = store.jobs.createWorker({
  handlers: { 'welcome-mail': async (payload, context) => { /* … */ } },
  concurrency: 2,
});
worker.start();
```

The queue composes with `@jarenjs/flow` checkpointed runs through §7
— that composition, not the queue alone, is the reason this exists:
a run that crashes resumes from its recorded nodes instead of
restarting.

## 2. The job record

`_jaren_jobs`, one row per job, surfaced camel-cased and frozen:

| column | meaning |
|---|---|
| `id` | TEXT primary key; caller-supplied or a UUID. **A caller-supplied id makes `enqueue` idempotent**: re-enqueueing an existing id changes nothing and answers the id — this is the idempotency key of §7 |
| `kind` | the registered handler name (the suite's named-registry discipline) |
| `payload` | the enqueue payload, JSON text; `null` stays null |
| `state` | `pending` → `leased` → `done`, or `failed` (awaiting retry) → `dead` (attempts exhausted) |
| `run_at` | epoch ms eligibility: scheduling and retry backoff are the same mechanism |
| `attempts` | claims so far; incremented AT claim, so a crashed attempt counts |
| `max_attempts` | per job, default 5 |
| `lease_until`, `lease_owner` | the lease (§3); null unless leased |
| `last_error` | the last failure's `message`, retained through retries and into `dead` |
| `result` | the completion value, JSON text (§7 records the DAG output here) |
| `created_at`, `updated_at` | epoch ms |

`_jaren_job_checkpoints` holds `(run_id, node_id, value)` rows — the
flow checkpoint store of §7, keyed by the JOB id (the run id IS the
job id). Both tables are created on open when `jobs` is requested;
neither appears in the model.

## 3. Leasing and exactly-once execution

Claiming is ONE guarded statement — one statement is one transaction,
so two workers cannot claim the same job, without any distributed
lock:

```sql
UPDATE "_jaren_jobs" SET state='leased', lease_owner=?, lease_until=?,
  attempts=attempts+1, updated_at=?
WHERE id = (SELECT id FROM "_jaren_jobs"
  WHERE (state='pending' OR state='failed'
         OR (state='leased' AND lease_until < ?))
    AND run_at <= ? AND kind IN (…the worker's registered kinds…)
  ORDER BY run_at, created_at, id LIMIT 1)
RETURNING *
```

- The `kind IN` clause is the deploy-ordering protection: **a job
  whose kind has no registered handler on this worker is simply never
  claimed by it** — it stays `pending` and shows in `counts()`, it is
  NOT dead-lettered by an accident of rollout order.
- Every later transition is guarded by the lease:
  `… WHERE id=? AND state='leased' AND lease_owner=?`. A worker whose
  lease expired mid-run (a stall, a long GC, a laptop lid) finds its
  completion matching ZERO rows and its result discarded — the job
  belongs to whoever re-claimed it. Execution is therefore
  AT-LEAST-ONCE; **completion is exactly-once**. Idempotency of side
  effects is the handler's responsibility (§7).
- Eligibility order is `run_at, created_at, id` — oldest first,
  deterministic. There are no priority classes (§8).

## 4. Retry and dead-lettering

A failed attempt (the handler threw or rejected) records
`last_error` and either:

- `attempts < max_attempts` → `state='failed'`,
  `run_at = now + backoff(attempts)` — the retry IS a scheduled job;
- else → `state='dead'`, terminal. Dead jobs keep their `last_error`
  and their checkpoint rows (a post-mortem can read exactly how far
  the run got).

Backoff is exponential with jitter:
`min(cap, base × 2^(attempts−1)) × (0.5 + random()/2)`, defaults
`base` 1 000 ms, `cap` 60 000 ms. `Math.random` is the runtime
default; the `random` option injects a deterministic source and every
test in this repository does.

## 5. Recovery

A worker that dies mid-job leaves a `leased` row whose `lease_until`
passes; the claim statement (§3) treats an expired lease exactly like
`pending`, so **recovery is not a separate sweeper — it is the next
claim**. The reclaimed attempt re-runs the handler; a §7 DAG job
resumes from its checkpoint rows rather than restarting. The lease
duration (`leaseMs`, default 30 000 ms) is therefore the recovery
latency ceiling: a handler that legitimately outlives its lease gets
reclaimed — size `leaseMs` to the slowest honest handler.

## 6. Workers and concurrency

`createWorker({ handlers, concurrency, pollInterval, leaseMs, owner,
maxAttempts, backoff, random })` returns `{ start(), stop(),
stats() }`:

- `concurrency` (default 1) independent claim-execute loops share one
  worker registration;
- an idle loop sleeps `pollInterval` (default 500 ms — at most
  2 claims/s of idle cost per loop, stated). An `enqueue` on the SAME
  store wakes every idle local loop immediately, so same-process
  latency is not poll-bound; **cross-process wake-up is polling**,
  plainly (§8);
- `stop({ graceMs })` aborts in-flight handlers and resolves once they
  settle **or** the grace period expires (default 5 s), answering
  `{ drained, inFlight }`; a loop the grace period could not drain is
  **cancelled**, not left running — see §6.1;
- `stats()` reports claims, completions, failures, wakes, polls and the
  in-flight handler count.

### 6.1 A handler cannot break the loop, and cannot hold shutdown

Two invariants a long-running process depends on.

**No handler outcome rejects the claim-execute loop.** A handler is host
code: it may resolve with something JSON cannot express (a `BigInt`, a
cycle, a throwing `toJSON`) or reject with a value whose own `message`
throws when read. Both are normalized totally and become an ordinary
failed attempt — retried with backoff, dead-lettered at `maxAttempts`,
recorded in `last_error`. The reason this matters more than it looks: a
rejected loop stops claiming, and a queue that has silently stopped
draining looks exactly like a queue with nothing to do.

**Shutdown is bounded.** Handlers receive an `AbortSignal` alongside the
job:

```js
handlers: {
  sync: async (payload, { job, signal, checkpointsFor }) => {
    const res = await fetch(url, { signal });   // cancelled on stop()
    …
  },
}
```

`stop({ graceMs })` aborts the signal, waits up to `graceMs`, and then
returns `{ drained, inFlight }` regardless. `store.close({ graceMs })`
does the same and **closes the connection either way**, then reports
`JD2062` when handlers were left running — a report, not a refusal: the
handle really is released. A handler that ignores its signal therefore
cannot hold the database file open for the life of the process, and the
lease expiry (§5) lets another worker re-claim its job.

A loop the grace period could not drain is **cancelled**, not merely
uncounted: when its wedged handler finally settles, the loop exits
without writing the completion or the failure, without claiming again,
and without re-arming its poll timer — the store it would touch is the
one the caller is closing, and the job it abandons recovers by lease
expiry (§5). A later `start()` builds fresh loops in a new session (and
re-registers the worker's wake-on-enqueue hook and its place in
`stopAll`), so a cancelled loop can never be revived as an extra
claimer.

## 7. The DAG composition

```js
import { compileDag } from '@jarenjs/flow';
const runner = createDagJobRunner(store, {
  compileDag,                      // INJECTED — db never imports flow
  documents: { 'sync-report': dagDocument },
  tasks: { fetch: async () => { /* … */ } },
});
runner.start();
await store.jobs.enqueue('sync-report', { input: { day: '2026-08-05' } });
```

- The engine arrives as a capability (the D10 shape applied to flow);
  `@jarenjs/db`'s manifest and import graph name `@jarenjs/flow`
  nowhere, asserted by test.
- The job id is the run id. Node values save into
  `_jaren_job_checkpoints` as the run progresses; `complete` records
  the DAG result AND marks the job `done` **in one guarded
  statement** — one transaction, so a failure leaves neither, and the
  checkpoint rows of a finished job are pruned in the same breath.
- A reclaimed DAG job resumes: recorded nodes seed (FLOW-FORMAT
  §7.6), the rest re-run. A task node with side effects MUST thread
  an idempotency key (the job id is the natural one) into whatever it
  touches; the queue cannot make a non-idempotent effect safe, and
  does not pretend to.
- The document belongs WITH the job kind at worker construction —
  resuming under a different document is undefined (FLOW-FORMAT
  §7.6), so deploys that change a dag document SHOULD drain old jobs
  first or version the kind name.

## 8. Non-goals

- **One database, one machine.** Leasing coordinates workers on one
  SQLite file. Over a network filesystem (NFS, SMB, many container
  volume mounts) SQLite's locking is **not reliable — this queue is
  NOT a safe cross-machine coordination substrate there**. Same-host
  processes over WAL are the supported topology.
- No priority classes in 0.1 (`run_at` ordering only), no cron or
  recurring schedules (re-enqueue from a completed handler if
  needed), no workflow-level compensation or sagas, no per-job abort
  signal (the lease is the timeout story), no cross-process push —
  wake-on-write is same-process; everything else polls.
- Throughput is SQLite's single-writer throughput; the measured
  numbers live in the execution notes, not in marketing.

## 9. Errors

This format adds NO codes. API misuse (a malformed handler map, a
non-string kind, a worker started twice) is a `TypeError` at the
call, matching the capture and live precedents; storage failures ride
the existing `JD2005` wrap; a job's own failure is DATA — recorded in
`last_error` and the state machine of §4 — because a queue that
throws away its failure story has failed twice.
