# The Jaren jobs format — the durable queue

This document is normative. The key words MUST, MUST NOT, SHOULD and
MAY are to be interpreted as described in RFC 2119. Error codes join
the package's single runtime table (MODEL-FORMAT §7) — the fence's five
are listed in §9.

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
| `state` | `pending` → `leased` → `done`, or `failed` (awaiting retry) → `dead` (attempts exhausted); `cancelled` (terminal, set only by `cancel()`, §10) |
| `run_at` | epoch ms eligibility: scheduling and retry backoff are the same mechanism |
| `attempts` | claims so far; incremented AT claim, so a crashed attempt counts |
| `max_attempts` | per job, default 5 |
| `lease_until`, `lease_owner` | the lease (§3); null unless leased. The owner is DIAGNOSTICS: one worker reuses one owner for every attempt it makes, so it never guards anything |
| `lease_generation` | the attempt this row is on, incremented by every claim. It identifies the attempt, which the owner cannot |
| `lease_token` | the opaque fence one claim mints; the guard every settling call carries. Never handed out by `get` |
| `last_error` | the last failure's `message`, retained through retries and into `dead` |
| `result` | the completion value, JSON text (§7 records the DAG output here) |
| `created_at`, `updated_at` | epoch ms |

`_jaren_job_checkpoints` holds `(run_id, node_id, value, generation)`
rows — the flow checkpoint store of §7, keyed by the JOB id (the run id
IS the job id) and stamped with the generation that wrote them. Both
tables are created on open when `jobs` is requested;
neither appears in the model. A database written before the fence is
upgraded IN PLACE — the three columns are added behind a presence check,
because jobs rows are live work and a rebuild would drop a queue.
`enqueue`'s options are validated as
they are stored: `runAt` must be a finite epoch in milliseconds and
`maxAttempts` a positive integer (`TypeError`) — a `NaN` eligibility
was once stored, and that job was pending forever.

## 3. Leasing, the fence, and exactly-once settlement

Claiming is ONE guarded statement — one statement is one transaction,
so two workers cannot claim the same job, without any distributed
lock — and it MINTS the fence the attempt will settle with:

```sql
UPDATE "_jaren_jobs" SET state='leased', lease_owner=?, lease_until=?,
  lease_generation=lease_generation+1, lease_token=?,
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
- Eligibility order is `run_at, created_at, id` — oldest first,
  deterministic. There are no priority classes (§8).

### The lease is a capability

`claim` answers the job record with a frozen `lease` beside it:

```jsonc
{ "jobId": "…", "token": "…", "generation": 3,
  "attempt": 3, "owner": "worker-a", "expiresAt": 1730000000000 }
```

It is a **token, never an owner**. One worker mints one owner and reuses
it for every attempt it ever makes, so an owner cannot say *which*
attempt is speaking — and the two attempts that matter are exactly the
ones an owner cannot tell apart: the corpse of an expired attempt and
the live one that re-claimed the job. The `generation` names the attempt;
the `token` proves the caller holds it.

It is also **immutable**. `renew` answers a NEW lease and retires the one
it was given, so a reference someone kept across a renewal can never
quietly become valid again.

`get()` returns the record with `leaseGeneration` but **no token**: a
record anyone can read must not carry the capability to settle the job it
describes.

### Every settling call carries the fence

`renew`, `complete`, `fail` and a checkpoint `save` all guard on:

```sql
… WHERE id=? AND state='leased' AND lease_token=? AND lease_until > ?
```

The owner appears nowhere in that clause, and the validity check is not
optional: without it, a lease thirty seconds dead still completed a job.

A guard that matches nothing is **never `false`**. It is a coded refusal
naming which of three things happened, because a caller that cannot tell
"already done" from "you are stale" guesses, and guesses wrong:

| code | what happened |
|---|---|
| `JD2065` | the job is not leased — unknown, or already settled by someone else |
| `JD2066` | the lease was superseded: another claim or renewal holds it now, and the message names both generations |
| `JD2067` | the lease expired before the call, and the message says by how long |

A fourth, `JD2068`, catches the pre-fence spelling: `complete(id, owner,
result)` is refused by name and pointed at `job.lease`.

Settling **twice from one attempt** is idempotent, not a refusal — a §7
handler completes transactionally and the worker's own completion lands
behind it, and the row's generation says whose settlement it carries.

### What exactly-once means here, and what it does not

Execution is AT-LEAST-ONCE. **Settlement is exactly-once against the
store**: exactly one attempt's result can ever land on the row, and every
other attempt is told, by code, that it is not the one.

That is not the same as making an *external* effect exactly-once. If a
handler sends an email, charges a card or writes to another system, the
fence cannot un-send it: a reclaimed job runs the handler again, and both
runs reach the outside world even though only one of them will ever
settle the row. Idempotency of side effects remains the handler's
responsibility — the fence guarantees the *record*, not the world.

### Renewal

`jobs.renew(lease, { leaseMs })` moves the expiry out and mints a new
token, keeping the same generation (a renewal is the same attempt, so its
checkpoints stay its own). It is what a handler that legitimately
outlives `leaseMs` uses instead of hoping; the worker does it
automatically (§6).

### Ownership: root calls and the transactional outbox

The handle decides whose transaction a job write belongs to, exactly as
it does for collections (MODEL-FORMAT §5.1):

- **Root `store.jobs.*`** finite calls take the store gate. An enqueue,
  claim, checkpoint or settlement made while an unrelated application
  transaction is open **waits for its commit** (or refuses under
  `transactions: 'strict'`) and can never join its rollback.
- **`tx.jobs.*`** — the jobs view a transaction callback receives — runs
  as that exact scope. This is the **transactional outbox** spelling: an
  enqueue there becomes visible with the domain transaction's commit and
  vanishes with its rollback, atomically. A retained `tx.jobs` view is
  `JD2070` once its scope settles.
- **A worker is a root-owned long-lived component**, wherever it was
  created: its claims, renewals, checkpoint stores and settlements take
  the root gate even when an application transaction happens to be open,
  and creating a worker through a transaction view does not bind its
  future loop to that transaction.
- **A checkpoint store keeps the ownership of the jobs view that created
  it** — root stores gate, transaction-scoped stores stay pinned to
  their exact scope and cannot switch.

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
`base` 1 000 ms, `cap` 60 000 ms. `Math.random` is the platform
default; the `random` option — or the store's runtime record
(`@jarenjs/core/runtime`), where no explicit option is given — injects a deterministic source and every
test in this repository does.

## 5. Recovery

A worker that dies mid-job leaves a `leased` row whose `lease_until`
passes; the claim statement (§3) treats an expired lease exactly like
`pending`, so **recovery is not a separate sweeper — it is the next
claim**. The reclaimed attempt re-runs the handler; a §7 DAG job
resumes from its checkpoint rows rather than restarting, and the
reclaimed attempt reads the checkpoints written up to and including its
own generation, so it resumes from its predecessor's work.

The reclaim also FENCES the attempt it displaced: the older token settles
nothing from that moment, and its settlement is refused `JD2066` rather
than silently discarded. A stale attempt therefore cannot mark the job
done over the live one's result, and cannot prune the live one's
checkpoints — a settlement deletes only generations at or below its own.

The lease duration (`leaseMs`, default 30 000 ms) is the recovery
latency ceiling. A handler that legitimately outlives it does not have to
be reclaimed: the worker renews while it runs (§6).

## 6. Workers and concurrency

`createWorker({ handlers, concurrency, pollInterval, leaseMs, owner,
renew, onOutcome, backoffBase, backoffCap, stopGraceMs })` returns
`{ start(), stop(), stats(), leases() }`:

- `concurrency` (default 1, a positive integer — `TypeError`
  otherwise, because a worker with zero loops would `start()` and never
  claim) independent claim-execute loops share one worker registration;
- an idle loop sleeps `pollInterval` (default 500 ms — at most
  2 claims/s of idle cost per loop, stated). An `enqueue` on the SAME
  store wakes every idle local loop immediately, so same-process
  latency is not poll-bound; **cross-process wake-up is polling**,
  plainly (§8);
- retry backoff is `min(backoffCap, backoffBase × 2^(attempts − 1))`,
  jittered to between half and all of itself (defaults 1 s and 60 s);
  `maxAttempts` belongs to the JOB (`enqueue(kind, payload,
  { maxAttempts })`, default 5), not to the worker;
- `stop({ graceMs })` aborts in-flight handlers and resolves once they
  settle **or** the grace period expires (default `stopGraceMs`, 5 s),
  answering
  `{ drained, inFlight }`; a loop the grace period could not drain is
  **cancelled**, not left running — see §6.1;
- each in-flight attempt's lease is **renewed** while its handler runs,
  at a third of `leaseMs`, so two renewals may fail before the attempt
  is actually at risk. Every renewal replaces the lease. `renew: false`
  turns it off for a handler that must not outlive its lease.
  **A renewal that fails for a storage reason is not lease loss**: only
  the three fence codes (`JD2065`/`JD2066`/`JD2067`) prove the attempt
  no longer holds the job. On any other failure — a busy database, a
  contended gate — the current immutable lease stays in force, the
  handler's signal stays live, and the next renewal is armed; if the
  lease truly expires first, the next fenced call answers `JD2067` and
  that is the one recorded loss;
- an attempt whose lease is **lost** — superseded or expired — has its
  signal aborted with the refusal as the reason, and is then barred from
  settling. It is its own outcome: `lostSettlements`, never a completion
  (which is how a corpse once reported success over work another attempt
  was still doing) and never a failure (which would burn a retry the job
  never spent);
- `onOutcome` is called once per settled attempt —
  `{ outcome: 'completed' | 'failed' | 'lost', jobId, kind, attempt,
  generation, code?, reason? }`. An observer that throws never affects
  the loop;
- `leases()` lists the leases this worker holds right now, one per
  in-flight attempt. In-flight state is keyed by the fence TOKEN, never
  by the owner: one worker reuses one owner, and two attempts of one job
  must not collide in its own bookkeeping;
- `stats()` reports claims, completions, failures, wakes, polls,
  renewals, lost settlements, the in-flight handler count and
  `claimErrors` — a claim statement the database refused (a read-only
  file, a closed store), counted rather than swallowed, so a worker that
  can never claim is visible instead of silently idle.

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
  sync: async (payload, { job, signal, checkpoints }) => {
    const res = await fetch(url, { signal });   // cancelled on stop()
    …
  },
}
```

The same signal aborts for the other reason a handler must wind up: this
attempt no longer holds the job. Its `reason` is then the coded refusal
that says which — so a handler can tell "we are shutting down" from "you
have been superseded" without asking. `checkpoints` is the §7 store
already bound to this attempt, and it follows the attempt's current
lease, so a renewal does not strand it.

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

`stop()` carries a second, UNCONDITIONAL obligation beside the
grace-bounded handler drain, and the two never share one unresolved
promise: **quiescence**. Before `stop()` resolves, every claim, renewal,
checkpoint and settlement the worker itself started is cancelled or
drained — a claim still queued behind an open application transaction
leaves the connection's queue on the shutdown signal instead of running
later against a closing store — and no poll or renewal timer stays
armed or re-arms. A grace timeout may detach a hostile handler
(`{ drained: false, inFlight }`); it may not leave a database operation
behind it. This is what makes `worker.stop()` followed by
`store.close()` release the database file deterministically.

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
  `_jaren_job_checkpoints` as the run progresses, each stamped with the
  writing attempt's generation; `complete` records the DAG result AND
  marks the job `done` **in one guarded statement** — one transaction, so
  a failure leaves neither, and the checkpoint rows of a finished job are
  pruned in the same breath. The prune deletes only generations at or
  below the settling lease's, so a stale attempt cannot take a live one's
  work with it.
- A reclaimed DAG job resumes: recorded nodes seed (FLOW-FORMAT
  §7.6), the rest re-run. A task node with side effects MUST thread
  an idempotency key (the job id is the natural one) into whatever it
  touches; the queue cannot make a non-idempotent effect safe, and
  does not pretend to (§3, *what exactly-once means here*).
- Every task's handler receives the run's signal, which is the job
  handler's: a worker winding down inside its `graceMs`, or an attempt
  whose lease has been lost, reaches every task rather than only the
  outermost await.
- The runner forwards the worker options it declares — `concurrency`,
  `pollInterval`, `leaseMs`, `owner`, `renew`, `onOutcome`, the backoff
  pair and `stopGraceMs`. A `runner.stop()` with no override observes
  the runner's declared `stopGraceMs` default; an explicit
  `stop({ graceMs })` still wins.
- **A resume must be the same run.** THREE things are persisted beside a
  run's checkpoints, under a reserved node id, and pruned with them: the
  workflow document's revision, a hash of the run's input, and the
  canonical map of DECLARED task versions (FLOW-FORMAT §7.8) with its
  hash. A resume that disagrees with any of them is `JD2069` naming what
  changed — each is identified separately, and a moved task version names
  the task and both versions (`'draft' moved from version 1 to 2`).
  A deploy that edits a dag document therefore does not have to drain old
  jobs to be safe: the in-flight ones refuse by name.

  The third component is what a document revision cannot see: a handler
  reimplemented while its document stayed byte-equal. The host declares
  that identity and the registry supplies it, so the queue can tell a
  redeployed implementation from the one that wrote the checkpoints.

  **The legacy rule is deterministic, and never reads unknown as equal.**
  A run checkpointed by a release that did not record task identity has
  no `taskVersionsHash`. If it recorded no node value yet, there is
  nothing that could be replayed wrongly, so the identity is upgraded in
  place and the run proceeds. If it DID record values, the implementation
  that produced them cannot be confirmed and the resume is refused,
  saying exactly that.
- A resume that DOES agree changes nothing: the recorded nodes are
  restored rather than re-run, no checkpoint row is written, and none is
  pruned.

## 8. Non-goals

- **One database, one machine.** Leasing coordinates workers on one
  SQLite file. Over a network filesystem (NFS, SMB, many container
  volume mounts) SQLite's locking is **not reliable — this queue is
  NOT a safe cross-machine coordination substrate there**. Same-host
  processes over WAL are the supported topology.
- No priority classes in 0.1 (`run_at` ordering only), no cron or
  recurring schedules (re-enqueue from a completed handler if
  needed), no workflow-level compensation or sagas, no cross-process
  push — wake-on-write is same-process; everything else polls. A
  per-job cancellation exists (§10) and aborts a handler's signal in the
  process that holds the attempt; across processes the lease is still
  the timeout story.
- Throughput is SQLite's single-writer throughput; the measured
  numbers live in the execution notes, not in marketing.

## 9. Errors

The fence adds five, all in the package's single runtime table
(MODEL-FORMAT §7), all raised where a silent `false` used to be:

| code | raised when |
|---|---|
| `JD2065` | a settling call names a job that is not leased — unknown, or already settled by someone else |
| `JD2066` | the lease was superseded by a newer claim or renewal |
| `JD2067` | the lease expired before the call |
| `JD2068` | a settling call used the pre-fence `(id, owner)` spelling instead of the lease |
| `JD2069` | a resumed run disagrees with the workflow revision, the input hash or the declared task versions its checkpoints were written under (§7) |

Otherwise: API misuse (a malformed handler map, a
non-string kind, a worker started twice) is a `TypeError` at the
call, matching the capture and live precedents; storage failures ride
the store's one driver-failure classification (MODEL-FORMAT §7 — a
locked or read-only file arrives classed) and a coded error passes
through it
unchanged (`JD2063` after `close()`); `store.jobs` on a read-only
store is `JD0002` at first use, because the queue tables cannot be
created — named there, not a raw `SQLITE_READONLY` at the first
enqueue; a job's own failure is DATA — recorded in
`last_error` and the state machine of §4 — because a queue that
throws away its failure story has failed twice.

## 10. Administration

Four root operations let an operator inspect and steer the queue
without raw SQL. Each is a mechanism with a coded failure surface and
an honest second run; none of them decides WHEN — a retention horizon,
a cancellation policy, a retry policy are the host's.

- **`page({ state, kind, after, limit, signal, deadline })`** — a
  keyset cursor over the queue by job id (the id to continue past in
  `after`, at most `limit` items, default 100), filtered by a closed
  state and a kind; each item is the record `get` answers. It is the
  store's own cursor: admitted per pull under the store gate, cancelled
  at row boundaries (`JD2072` / `JD2075`), classified by the driver's
  streaming capability, every driver failure classified.
- **`cancel(id, { lease })`** — two cases, both fenced. A QUEUED job
  (pending or failed) is settled as `cancelled` in one write; the
  enqueue-time identity authorises. A CLAIMED job needs the CURRENT
  lease its attempt holds (§3's rule, so no stranger settles another's
  work): the fenced write settles the row, and an attempt of this
  process is aborted through the handler's `signal` (its reason is the
  coded `JD2065` naming the cancellation); the call resolves once that
  attempt has wound up — the acknowledgement §3's settling calls named.
  `true` when this call cancelled the job, `false` when it already was;
  unknown or settled `JD2065`, claimed-without-lease `JD2068`, a stale
  or expired lease `JD2066`/`JD2067`. A worker reports such an attempt
  as `outcome: 'cancelled'` (neither a completion, a failure nor a loss)
  and counts it under `stats().cancellations`; an attempt held by
  another process meets the fence at its next settling call and records
  a loss, as any superseded attempt does.
- **`requeue(id)`** — returns a failed, dead, cancelled or lease-expired
  job to `pending` at the clock's instant (the queue's own order). The
  attempt history is KEPT: `attempts` counts every claim the job ever
  had and the next claim increments it, so `maxAttempts` still bounds
  what follows (a dead job requeued gets exactly one more attempt before
  it is dead again). `false` when the job already was pending; a live
  lease refuses `JD2068` (requeue is not a steal); unknown or done
  `JD2065`.
- **`sweep({ settledBefore, limit })`** — deletes settled jobs (`done`,
  `dead`, `cancelled`) whose last change is older than the horizon,
  oldest first, at most `limit` of them, together with their
  checkpoints, in one transaction; answers `{ removed }`, and a second
  identical sweep answers `{ removed: 0 }`. The horizon is REQUIRED: a
  sweep with none is a retention policy. Live jobs' checkpoints and the
  change log's watermark are untouched.

`cancelled` is a sixth job state, terminal like `done` and `dead`, set
only by `cancel()`; `counts()` reports it. A transaction view's `jobs`
(the outbox, §3) carries none of the four: an administration call is a
root call.
