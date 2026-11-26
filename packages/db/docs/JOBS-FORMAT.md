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
tables beside the model's own (a third once the store writes a
recurring schedule, §11):

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

SQLite and PostgreSQL use this same queue and injected flow composition.
Select the host driver when opening the Store; PostgreSQL needs an injected
pg-compatible source and `jobs: true`. The queue's SQL, schema and locking
strategy follow that driver. The public records, lease errors and checkpoint
identities stay the same; no PostgreSQL job engine or flow document is needed.

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
was once stored, and that job was pending forever. A payload (and a
checkpoint value) is JSON: one that `JSON.stringify` cannot express — a
function, a symbol, a BigInt, a cycle — is a `TypeError`, and nothing is
enqueued. They are a closed
set — `id`, `runAt`, `maxAttempts` — in a plain object: any other
member is `JD0013` naming the nearest one (a misspelt `runat` used to be
dropped, and the job ran at once), as are options that are not a plain
object and an `id` that is not a non-empty string.

PostgreSQL stores epochs and counters as NUMERIC, preserving finite JavaScript
epoch values including fractional milliseconds and attempt budgets beyond
32-bit integers. The public API still answers JavaScript numbers. Its text
columns use the C collation so queue key ordering is independent of server
locale. Startup serializes schema creation and forward upgrades with a
transaction advisory lock. `adopt: true` only verifies existing infrastructure;
a missing column or incompatible table/index refuses JD0002 without DDL.

## 3. Leasing, the fence, and exactly-once settlement

Claiming is ONE guarded statement — one statement is one transaction,
so two workers cannot claim the same job, without any distributed
lock — and it MINTS the fence the attempt will settle with:

```sql
UPDATE "_jaren_jobs" SET state=CASE WHEN spent THEN 'dead' ELSE 'leased' END,
  lease_owner=…, lease_until=…, lease_token=…,   -- NULL / unchanged when spent
  lease_generation=lease_generation+1, last_error=…, attempts=…, updated_at=?
WHERE id = (SELECT id FROM "_jaren_jobs"
  WHERE (state='pending' OR state='failed'
         OR (state='leased' AND lease_until < ?))
    AND run_at <= ? AND kind IN (…the worker's registered kinds…)
  ORDER BY run_at, created_at, id LIMIT 1)
RETURNING *
```

Here `spent` is `state='leased' AND attempts >= max_attempts`: the selected
row is an expired lease whose attempt budget is used up (§5). The statement
dead-letters it instead of leasing it, and `claim()` runs the statement
again until it leases a row or finds none. The expanded `SET` list is the
shape of the statement, not a second statement, so the claim stays one
transaction per row.

The example shows SQLite parameters. PostgreSQL emits numbered parameters and
adds `FOR UPDATE SKIP LOCKED` to the bounded candidate SELECT. Independent
workers skip candidates another transaction holds. Eligibility order therefore
applies to the available rows, with no global FIFO or starvation guarantee.
Lease assertions inside a Store transaction and checkpoint saves lock the job
row until that transaction settles. A sweep uses one selected and locked victim
set for both job and checkpoint deletion, even when another worker settles a
job concurrently.

Every host MUST inject a comparable epoch clock across workers sharing a queue,
or keep their system clocks synchronized with an allowance in the lease budget.
PostgreSQL does not silently replace `jobs.now` with its server clock. Clock
skew, event-loop stalls and network latency can expire a lease; the token and
expiry guards still apply. A lost claim or commit reply does not prove rollback:
inspect the durable job/receipt and recover by expiry, rather than replaying an
external effect. A caller-supplied enqueue id supplies durable request identity.

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
behind it, and the row's generation says whose settlement it carries. It
is idempotent only for the state the call writes: `complete()` over the
attempt's own `cancelled` row, or `cancel(id, { lease })` over its own
`done` row, is refused `JD2065` naming the state the lease left, since
neither did what the call says. A worker whose completion lands behind
the attempt's own cancellation records the attempt `cancelled`.

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
  future loop to that transaction. A settlement the gate refuses as
  contended is tried again inside the lease, not failed (§6).
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

An attempt that never settles counts too: `attempts` rises at every claim,
so a final attempt whose worker crashed leaves a leased row with
`attempts >= max_attempts` and an expired lease. The next claim for its
kind dead-letters that row (§5) instead of claiming it again.

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
claim**, while the budget lasts. The reclaimed attempt re-runs the handler; a §7 DAG job
resumes from its checkpoint rows rather than restarting, and the
reclaimed attempt reads the checkpoints written up to and including its
own generation, so it resumes from its predecessor's work.

A row whose lease expired at `attempts >= max_attempts` was a crashed final
attempt, and it is not reclaimed: the claim moves it to `state='dead'`
instead (in the same statement, §3), keeping its `last_error` (`lease expired`
when no attempt recorded one), clearing the lease and moving
`lease_generation`, so the crashed attempt's token settles nothing (`JD2065`:
the job is dead). The handler does not run again; `requeue` (§10) is the
deliberate way to give it one more attempt. Only jobs of the claim's kinds
are touched, and a live lease never is.

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
renew, onOutcome, effectSafety, backoffBase, backoffCap, stopGraceMs, tick })`
returns `{ start(), stop(), stats(), leases() }`. The options are a closed
set (any other member is `JD0013` naming the nearest, as for `enqueue`), and
each is checked before the worker exists: `leaseMs` is a positive finite
number of milliseconds, `pollInterval`, `backoffBase`, `backoffCap` and
`stopGraceMs` non-negative finite ones (the two that arm a timer no longer than
a timer keeps, 2^31 − 1), `owner` a non-empty string, `renew` a boolean and
`onOutcome` a function — a `TypeError` otherwise. `claim` (`kinds`, `owner`,
`leaseMs`), `renew` (`leaseMs`), `stop` (`graceMs`) and the administration calls
of §10 each read a closed set of their own, and hold `leaseMs` and `graceMs` to
the rules above (a lease that is not a finite number stored no expiry, and the
job it leased was never claimed, renewed or settled again). A worker renews at
a third of its lease, and at most every 2^31 − 1 milliseconds:

- `concurrency` (default 1, a positive integer — `TypeError`
  otherwise, because a worker with zero loops would `start()` and never
  claim) independent claim-execute loops share one worker registration;
- an idle loop sleeps `pollInterval` (default 500 ms — at most
  2 claims/s of idle cost per loop, stated). An `enqueue` on the SAME
  store wakes every idle local loop immediately, so same-process
  latency is not poll-bound; **cross-process wake-up is polling**,
  plainly (§8);
- `tick` (`true`, or `{ limit }` as `tick()` takes it; absent, `null` or
  `false` by default) fires the due recurring schedules (§11) before each claim,
  through `tick()` itself, so the jobs a tick fires are claimable by that
  same claim and two workers ticking one schedule fire each occurrence
  once. It needs `jobs.schedules` (`JD0016` at `createWorker` otherwise);
  anything but `true`, `false` or `{ limit }` is a `TypeError`, and another
  member `JD0013`. One tick runs at a time per worker, shared by its loops.
  While the schedule table does not exist, the worker asks whether it does
  at its first loop pass (a tick before a claim) and again every 16th —
  one statement per 16 passes, and between them an idle poll runs exactly
  the statements it runs without `tick` (an idle claim answers no row, so
  it cannot carry the answer). This store's own `schedule()`,
  `schedules()` or `tick()` finding the table starts the ticking at once,
  and a table another process creates is found within 16 passes, without
  a restart: an idle worker passes once per `pollInterval` (8 s at the
  default 500 ms), a busy one once per claim.
  Once the table exists, every poll pays one tick transaction (the due-row read)
  before its claim. A tick that fails — a zone without the runtime's
  provider (`JD0016`), a busy database — is counted in `stats().tickErrors`
  (`stats().ticks` counts the ones that ran) and never stops the claim;
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
  that is the one recorded loss. A renewal hands its new lease to the
  attempt inside its own gated call, so a settlement queued behind it
  settles under that lease rather than being refused as superseded;
- **a settlement the gate refuses as contended is not a failure either.**
  The completion write and the failure write take the root gate, and
  while another caller holds the connection the gate refuses them
  `JD0012` — at once under `transactions: 'strict'`, after `queueTimeout`
  in the queue under `'wait'` — so the write never ran. The worker tries
  it again under the attempt's current lease every `pollInterval`, and at
  least once per renewal period, until the gate admits it: a handler that
  returned is recorded `completed` once, and a failure is reported only
  once its write has landed. A hold that outlives the lease ends in the
  one recorded loss: the admitted write answers `JD2067`, or `JD2066` when
  another claim took the job first. Any other refusal (a result JSON
  cannot express, a storage failure) fails the attempt as before. A
  cancellation or a lost lease that lands while the write waits is
  recorded as itself, and `stop()` abandons the write: no outcome is
  reported, and the leased row recovers by lease expiry (§5), as a
  cancelled loop's does;
- an attempt whose lease is **lost** — superseded or expired — has its
  signal aborted with the refusal as the reason, and is then barred from
  settling. It is its own outcome: `lostSettlements`, never a completion
  (which is how a corpse once reported success over work another attempt
  was still doing) and never a failure (which would burn a retry the job
  never spent);
- `onOutcome` is called once per settled attempt —
  `{ outcome: 'completed' | 'failed' | 'lost' | 'cancelled', jobId, kind,
  attempt, generation, phase?, code?, reason? }` (`cancelled`: §10). An
  observer that throws never affects the loop;
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
lease expiry (§5) lets another worker re-claim its job while attempts remain.

A loop the grace period could not drain is **cancelled**, not merely
uncounted: when its wedged handler finally settles, the loop exits
without writing the completion or the failure, without claiming again,
and without re-arming its poll timer — the store it would touch is the
one the caller is closing, and the job it abandons recovers by lease
expiry (§5). A later `start()` builds fresh loops in a new session (and
re-registers the worker's wake-on-enqueue hook and its place in
`stopAll`), so a cancelled loop can never be revived as an extra
claimer. That `start()` must wait for the `stop()`: one made before it
resolves throws a `TypeError` (`the worker is stopping`), since the
stopping loops would otherwise run on beside the new ones and the stop
would end the new session.

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

- The engine arrives as a capability (the validation hook's shape, applied to flow);
  `@jarenjs/db`'s manifest and import graph name `@jarenjs/flow`
  nowhere, asserted by test.
- The options are a closed set: `compileDag`, `documents`, `tasks`,
  `resources`, and the worker's own (`concurrency`, `pollInterval`, `leaseMs`, `owner`, `renew`,
  `onOutcome`, `backoffBase`, `backoffCap`, `stopGraceMs`, `effectSafety`). A
  member outside it is `JD0013` naming the nearest (`concurency` ran one loop);
  `maxAttempts` belongs to the job (`enqueue`).
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
- **A task fences its own writes with the attempt.** Every task receives,
  as its third argument, the flow engine's host-private `resources`
  (FLOW-FORMAT, never input, never checkpoint identity): a frozen object of
  the host's own `resources` option merged with three members the runner
  sets per attempt — `jobId` (the idempotency key to thread into what the
  task touches), `assertLease(tx)` (`tx.jobs.assertLease` with the
  attempt's current lease, which follows renewals) and `signal` (the
  attempt's own, which a sibling node's failure does not abort, unlike the
  task's second argument). A task that publishes a result — a provider's
  response arriving after a long call — checks the lease in the
  transaction that writes it, so an attempt whose job another worker
  reclaimed, or whose lease expired, publishes nothing:

  ```js
  createDagJobRunner(store, { compileDag, documents: { answer: answerDag },
    resources: { provider },
    tasks: { publish: async ({ input }, signal, { provider, assertLease, jobId }) => {
      const response = await provider.call(input, { signal, idempotencyKey: jobId });
      return store.transaction(async (tx) => {
        await assertLease(tx); // JD2066 superseded, JD2067 expired
        await tx.collection('responses').put({ id: jobId, response });
        return { id: jobId };
      });
    } } });
  ```

  `assertLease` takes the transaction the write runs in, where the check
  and the write share one lock; a value with no `jobs` surface is `JD0014`.
  Given the root store it checks only the instant it ran. The lease itself
  is never handed out — it settles the job and writes checkpoint rows, so a
  task holding it could finish the run with a result of its own — and
  neither are the handler context's `checkpoints` (the run's own rows) and
  `pause` (settles the queue attempt). The host's members come first and
  the runner's last; a host member named `jobId`, `assertLease` or
  `signal`, or a `resources` that is not a plain object, is `JD0013` when
  the runner is built. **Upgrading:** a task's third argument
  was `undefined` under this runner; it is now this object.
- The runner forwards the worker options it declares — `concurrency`,
  `pollInterval`, `leaseMs`, `owner`, `renew`, `onOutcome`, the backoff
  pair and `stopGraceMs`. A `runner.stop()` with no override observes
  the runner's declared `stopGraceMs` default; an explicit
  `stop({ graceMs })` still wins.
- **A resume must be the same run.** Three exact identities are persisted
  beside a run's checkpoints, under a reserved node id, and pruned with
  them: the canonical workflow document (`workflowIdentity`), the canonical
  input (`inputIdentity`), and the map of DECLARED task versions
  (`taskVersions`, FLOW-FORMAT §7.8). Object-member order does not change
  identity. The short `revision`, `inputHash` and `taskVersionsHash`
  fingerprints remain diagnostic labels; equal hashes never establish
  equality. A resume that disagrees with any identity is `JD2069` naming what
  changed — each is identified separately, and a moved task version names
  the task and both versions (`'draft' moved from version 1 to 2`).
  A deploy that edits a dag document therefore does not have to drain old
  jobs to be safe: the in-flight ones refuse by name.

  The third component is what a document revision cannot see: a handler
  reimplemented while its document stayed byte-equal. The host declares
  that identity and the registry supplies it, so the queue can tell a
  redeployed implementation from the one that wrote the checkpoints.

  **The legacy rule is deterministic, and never reads unknown as equal.**
  Releases that recorded only workflow/input hashes lack `workflowIdentity`
  and `inputIdentity`; older releases can also lack task identity. Identity
  inspection reads only the reserved metadata value and probes whether other
  rows exist; it does not load or parse node values. Missing or hash-only
  identities with saved node values refuse `JD2069` before checkpoint load
  or task execution, leaving the original run untouched. A matching legacy
  identity with no node values can upgrade through the existing fenced save;
  existing hash mismatches still refuse.

  **Upgrading from 0.99.x to 0.100.x:** finish populated legacy runs with
  their original runner before switching workers, or deliberately enqueue
  under a new id or reset the inactive run with its observed generation
  (§10). This checkpoint compatibility change requires a minor release.
  Reset discards checkpoints and recomputes;
  neither reset nor a new id undoes external effects. The runner never
  automatically resets or replays a run whose exact identity is unknown.
- A resume that DOES agree changes nothing: the recorded nodes are
  restored rather than re-run, no checkpoint row is written, and none is
  pruned.

## 8. Non-goals

- **SQLite uses one local database.** Leasing coordinates workers on one
  SQLite file. Over a network filesystem (NFS, SMB, many container
  volume mounts) SQLite's locking is **not reliable — this queue is
  NOT a safe cross-machine coordination substrate there**. Same-host
  processes over WAL are the supported topology.
- **PostgreSQL coordinates independent clients of one database.** Business
  writes and `tx.jobs.enqueue` co-commit on the same Store transaction. Separate
  databases, including PostgreSQL business rows and a SQLite queue, require an
  idempotent outbox relay and durable receipts; they share no atomic transaction.
- No priority classes in 0.1 (`run_at` ordering only), no cron
  expressions (recurring schedules are RFC 5545 rules from
  `@jarenjs/core/calendar`, §11, of every frequency it enumerates), no timer of
  the queue's own that fires them (a host calls `tick()`), no
  workflow-level compensation or sagas, no cross-process
  push — wake-on-write is same-process; everything else polls. A
  per-job cancellation exists (§10) and aborts a handler's signal in the
  process that holds the attempt; across processes the lease is still
  the timeout story.
- SQLite throughput remains bounded by its single writer. PostgreSQL uses
  row locks and separate clients, while each Store serializes its own work.
  Jobs use the driver's finite admission, statement and cleanup bounds; a
  paused job-page cursor must be returned promptly to release its snapshot.

## 9. Errors

The fence adds five, all in the package's single runtime table
(MODEL-FORMAT §7), all raised where a silent `false` used to be:

| code | raised when |
|---|---|
| `JD2065` | a settling call names a job that is not leased — unknown, or already settled by someone else |
| `JD2066` | the lease was superseded by a newer claim or renewal |
| `JD2067` | the lease expired before the call |
| `JD2068` | a settling call used the pre-fence `(id, owner)` spelling instead of the lease |
| `JD2069` | a resumed run disagrees with its exact workflow, input or declared task identities, or saved values lack a provable identity (§7) |

Recurring schedules (§11) add `JD0016`: a schedule call on a store
opened without `jobs.schedules`, or a tick that met a schedule in a zone
in a process without a zone provider.

Otherwise: API misuse (a malformed handler map, a
non-string kind, a worker started twice) is a `TypeError` at the
call, matching the capture and live precedents — except `enqueue`'s
closed option set, whose unknown or malformed members are `JD0013`
(§2), the code every store operation's options refuse with; storage failures ride
the store's one driver-failure classification (MODEL-FORMAT §7 — a
locked or read-only file arrives classed) and a coded error passes
through it
unchanged (`JD2063` after `close()`); `store.jobs` on a read-only
store is `JD0002` at first use, because the queue tables cannot be
created — named there, not a raw `SQLITE_READONLY` at the first
enqueue; the open reads the queue's tables, claim index and upgraded
columns holding no write lock and creates or upgrades them in the
store's immediate bracket only where one is missing, so a re-open runs
beside a live writer, and a bracket whose lock it cannot take is the
store's busy failure (`JD2005`, `class: 'busy'`, retryable), not
`JD0002`; a job's own failure is DATA — recorded in
`last_error` and the state machine of §4 — because a queue that
throws away its failure story has failed twice.

## 10. Administration

Four root operations let an operator inspect and steer the queue
without raw SQL. Each is a mechanism with a coded failure surface and
an honest second run; none of them decides WHEN — a retention horizon,
a cancellation policy, a retry policy are the host's.

- **`page({ state, kind, after, limit, signal, deadline, yieldEvery })`** — a
  keyset cursor over the queue by job id (the id to continue past in
  `after`, at most `limit` items, default 100), filtered by a closed
  state and a kind; each item is the record `get` answers. It is the
  store's own cursor: admitted per pull under the store gate, cancelled
  at row boundaries (`JD2072` / `JD2075`), classified by the driver's
  streaming capability, every driver failure classified, and given a
  turn of the event loop between pulls by `yieldEvery` as every root
  cursor is (MODEL-FORMAT §5.1).
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
- **`reset(id, { expectedGeneration })`** — explicitly discard one inactive
  run's checkpoints and restart its attempts at zero. Read the job's
  `leaseGeneration` first and pass that observation. One transaction
  conditionally updates the job, increments its fence generation and deletes
  its checkpoint rows. A concurrent generation change refuses `JD2066`, a
  live lease `JD2068`, an unknown or completed job `JD2065`; no refusal
  discards values. The next claim recomputes the workflow under current
  identity. Reset does not undo external task effects; their idempotency
  keys remain the host's responsibility. It is root-only administration,
  with the same signal/deadline options as requeue.
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

## 11. Recurring schedules

A schedule fires a recurrence from `@jarenjs/core/calendar` as ordinary
jobs. The calendar is a subpath of its own, so a store that never
schedules carries none of it: enable schedules with `jobSchedules()`,
and give the runtime record the zone provider every zone question goes
to.

```js
import { jobSchedules } from '@jarenjs/db/schedules';
import { compileRecurrence, floatingValue } from '@jarenjs/core/calendar';
import { createRuntime } from '@jarenjs/core/runtime';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const runtime = createRuntime({ zoneProvider: createIntlZoneProvider({ revision: 'host ICU' }) });
const store = await openStore(model, { driver: nodeDriver(), runtime, jobs: { schedules: jobSchedules() } });
await store.jobs.schedule({
  id: 'weekly-report', kind: 'report', payload: { to: 'team' },
  series: compileRecurrence({ dtstart: floatingValue('2026-03-02', '09:00'), rrule: 'FREQ=WEEKLY;BYDAY=MO' }),
  zone: 'Europe/Amsterdam', zoneSource: 'explicit', missed: 'skip',
});
await store.jobs.tick(); // on the host's own cadence, or:
store.jobs.createWorker({ handlers: { report: async () => {} }, tick: true }).start(); // before each claim (§6)
```

- **`schedule({ id, kind, payload?, series, zone?, zoneSource?, policy?, missed, limits?, latenessMs? })`**
  validates and computes the definition before anything is stored, and
  answers the stored record:
  - `series` is a compiled recurrence (`compileRecurrence`) or a series
    (`defineSeries`), as values or as their JSON, of any frequency the
    calendar enumerates, SECONDLY through YEARLY (sub-daily rules below).
    A rule the calendar refuses refuses here with the calendar's code, at
    schedule time and never at a fire.
  - A date or floating series is bound in `zone`, checked against the
    provider now (an unknown zone is `JY0001`; a zone with no provider is
    `JY0004`). Without a zone the schedule is `unresolved` and never
    fires: no zone is ever assumed. A utc or zoned series takes no `zone`.
  - `policy` is how a gap or fold binds a date or floating occurrence
    (`'rfc5545'`, `'later'`, `'reject'`); for a utc or zoned series it is
    the rule's own, and any other is refused. It defaults to the rule's.
  - `missed` is `'skip'`, `'once'` or `{ catchUp: n }` (below); `limits`
    are the calendar's expansion limits for each search; `latenessMs`, a
    positive whole number of milliseconds, is how late an occurrence may
    fire (below). It is stored in the `limits` column's JSON beside the
    calendar's limits, and surfaced as its own member (`null` when absent),
    never in `limits`; a `latenessMs` inside `limits` is `JD0013`.
  - Any other member, or a malformed one, is `JD0013`.
  - Writing an existing id replaces its definition and keeps its history:
    the next occurrence is the first after its last fired one, or from its
    creation when none fired, so a replacement never fires an occurrence
    twice.
- **`tick({ limit })`** fires the due schedules, earliest first, at most
  `limit` (default 100), in one transaction, and answers
  `{ fired, skipped, advanced, more }`:
  - each occurrence that fires is enqueued as job
    `${scheduleId}@${recurrenceId}` with `runAt` the occurrence's
    instant, through the idempotent enqueue (§2), so a second tick, a
    second process or a replaced definition cannot fire it twice;
  - the schedule advances to its next occurrence in the same transaction,
    guarded by the instant it was due at. On PostgreSQL the due rows are
    read `FOR UPDATE SKIP LOCKED`, as a claim reads jobs; SQLite's single
    writer serializes ticks. The answers are the same;
  - an occurrence due more than `latenessMs` before the tick's instant
    (`runtime.now`) is skipped under every `missed` policy, the latest one
    too; one exactly `latenessMs` late fires. Of the rest, an occurrence is
    **missed** when a later one was due too by the time a tick saw it, after
    downtime or a tick that came late. The latest due occurrences (every one
    at the latest instant) fire; `'skip'` fires no missed one, `'once'` the
    latest missed one, `{ catchUp: n }` the latest n. Every occurrence that
    does not fire is counted as skipped (but for a backlog read from the
    tick backwards, below), and the schedule passes it:
    `lastRunAt` and `lastRecurrenceId` name the latest due occurrence,
    fired or skipped;
  - a tick in a process whose runtime has no zone provider refuses
    `JD0016` when it meets a schedule in a zone, and leaves every schedule
    as it was: the fault is the process's, not the schedule's.
- **`schedules()`** answers every schedule by id; **`unschedule(id)`**
  removes one (`false` when there was none); the jobs it fired stay.

Each record carries `state`:

| state | meaning |
|---|---|
| `active` | `nextRunAt` and `nextRecurrenceId` name the next occurrence |
| `unresolved` | a date or floating series with no zone: never fires |
| `stalled` | a search a limit stopped (`stall: { limit, counts: { emitted, work, providerCalls } }`), or an occurrence its policy refused to bind (`stall: { code, message, recurrenceId }`); the occurrences before it fired. Never dropped: write the schedule again to resume |
| `ended` | the series has no occurrence left within its horizon |

and `counts: { fired, skipped }`, `lastRunAt`, `lastRecurrenceId`, and
`providerRevision` (the zone provider's revision the instants were
computed under).

**Sub-daily rules.** A SECONDLY, MINUTELY or HOURLY schedule is fired by
the same tick as any other; nothing refuses a rule finer than the
host's cadence. A tick fires what was due since the last one, so a rule
due every second ticked every 500 ms fires each occurrence, and ticked
every minute sees sixty due ones: `missed` and `latenessMs` decide which
fire, exactly as after downtime. Each search for a schedule's next
occurrence looks 64 of the rule's periods past the tick first (64
seconds for SECONDLY), widening eightfold until one is found, before the
day windows every rule uses, so a tick resolves the occurrences it
passes and a few past it, not days of them.

**A backlog of any length.** A search's work is bounded by the
calendar's limits (`limits`, default `maxOccurrences` 10000), and a
tick's first search reads every occurrence due since the last tick, so
each is counted. When that backlog is longer than the limits let one
search read — a day without ticks is 86400 due occurrences of a SECONDLY
rule — the tick reads it from its own instant backwards instead: a span
ending at the tick, `n + 1` of the rule's cycles wide (`n` the missed
occurrences the policy fires: 0, 1 or `catchUp`), widening eightfold
until it holds them and the latest due ones. The policy then fires
exactly what it fires over the whole backlog, the schedule moves past
everything due, and it stays `active`: downtime never stalls a schedule.
The occurrences before that span are passed without being counted: the
tick's `skipped` and `counts.skipped` hold only those the span read, and
`counts.uncounted` (absent until it happens) counts the ticks that
passed a backlog so. A rule with COUNT walks from its DTSTART, so its
backward span costs the walk; a span the limits cannot read at any width
leaves the schedule `stalled`, as a limit always did. The tick's
statements are the same whatever the backlog: one read of the due rows,
one enqueue per fired job, one advance per schedule.

**Floating series and zones.** A floating series is bound occurrence by
occurrence, so a tick expands only the wall clock its span's instants
can read: those instants under every offset the zone keeps around them.
A provider that lists its offset changes (`offsetChanges`, a compiled
VTIMEZONE, and the Intl provider, which reads the offset once a day and
bisects to the change) names them, and the wall clock is the span's own
widened by the changes near it; a provider without the list is read
under every offset a zone of the tz database keeps, UTC-12:00 to
UTC+14:00, so 26 hours of wall clock around the span are bound. The
occurrences outside the span are the binding's work: `maxOccurrences`
counts those that bind into the span and `maxProviderCalls` the
binding's calls, so a floating SECONDLY schedule ticks under the default
limits, binding each of the 26 hours' seconds a tick only with a provider
that lists no changes. A date series is expanded over two civil days
either side of the span. A zoned sub-daily walk under a provider without
`offsetChanges` resolves each wall-clock time of the day before its
horizon (CALENDAR.md), so a zoned SECONDLY schedule spends about 86400
provider calls a tick there, within the default `maxProviderCalls`; with
the list it asks about the hours around its changes. A utc series costs
neither.

## 12. Long computations

A computation that outlives a lease, a deploy or a process runs as a job
that saves its incumbent as it goes: each attempt reads the checkpoint
its predecessors wrote (§5), works in bounded slices, saves after each
one, and gives the event loop a turn between them, where the handler's
`signal` (§6) and the worker's lease renewal land. The assignment
engine's `solve` (`@jarenjs/core/assign`, [ASSIGN.md
§9](../../core/docs/ASSIGN.md#9-search)) is the worked case: it is
synchronous and storage-free, so a call cannot be interrupted, but a
`local` search started from a list continues from it. A slice is one
`solve` with a `maxMoves` budget; the job carries the problem, which is
data, and the handler holds the rules, which are code.

```js
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { solve, registerRules } from '@jarenjs/core/assign';

const resources = ['ana', 'ben', 'cy', 'dee', 'eli', 'fay'].map((id) => ({ id, revision: 1 }));
const tasks = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, revision: 1,
  interval: { start: i * 240, end: i * 240 + 300 }, demands: [{ slot: 'crew', count: 1 + (i % 2) }] }));
const problem = { revision: 'week-12', resources, tasks, assignments: [] };
const rules = registerRules([
  // each place a task leaves open
  { id: 'covered', version: 1, level: 'service', scope: 'task', evaluate(view, unit) {
    const open = view.task(unit.id).demands.reduce((sum, demand) => sum + demand.count, 0) - view.assignmentsFor(unit.id).length;
    return open > 0 ? { matches: [{ magnitude: open, messageId: 'open', subjects: { tasks: [unit.id] } }] } : {};
  } },
  // two tasks of one resource that overlap
  { id: 'overlap', version: 1, level: 'hard', scope: 'resource', evaluate(view, unit) {
    const mine = view.assignmentsOf(unit.id).map((a) => view.task(a.task).interval).sort((a, b) => a.start - b.start);
    const clashes = mine.filter((interval, i) => i > 0 && interval.start < mine[i - 1].end).length;
    return clashes > 0 ? { matches: [{ magnitude: clashes, messageId: 'overlap', subjects: { resources: [unit.id] } }] } : {};
  } },
  // more than two tasks for one resource, squared
  { id: 'fair', version: 1, level: 'soft', scope: 'resource', evaluate(view, unit) {
    const over = view.assignmentsOf(unit.id).length - 2;
    return over > 0 ? { matches: [{ magnitude: over * over, messageId: 'load', subjects: { resources: [unit.id] } }] } : {};
  } },
]);

/**
 * A job handler that solves in slices and resumes from the last one saved.
 * @param {import('@jarenjs/core/assign').RuleSet} rules
 * @returns {(payload: any, context: any) => Promise<unknown>}
 */
function solveInSlices(rules) {
  return async ({ problem, seed, maxMoves, limits }, { job, signal, checkpoints }) => {
    const saved = /** @type {any} */ (await checkpoints.load(job.id));
    let state = saved?.values.incumbent ?? { maxMoves, assignments: problem.assignments };
    for (;;) {
      signal.throwIfAborted();
      const answer = solve({ ...problem, assignments: state.assignments }, rules,
        { strategy: 'local', seed, limits, budgets: { maxMoves: state.maxMoves }, signal });
      // a slice the signal cut is not saved: the next attempt repeats it whole
      signal.throwIfAborted();
      if (answer.status !== 'limit') return answer;
      // a slice that moved nothing gets twice the budget, so a whole sweep fits at last
      const moved = JSON.stringify(answer.best) !== JSON.stringify(state.assignments);
      state = { maxMoves: moved ? state.maxMoves : 2 * state.maxMoves, assignments: answer.best };
      await checkpoints.save(job.id, 'incumbent', state);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

const store = await openStore({ $model: '0.1', collections: { rosters: { key: '/id', schema: { type: 'object' } } } },
  { driver: nodeDriver(), jobs: true });
const id = await store.jobs.enqueue('solve', { problem, seed: 7, maxMoves: 40 });
const settled = new Promise((resolve) => {
  store.jobs.createWorker({ handlers: { solve: solveInSlices(rules) }, onOutcome: resolve }).start();
});
await settled;
const { result } = await store.jobs.get(id);
const { hard, service, soft } = result.score.score;
const solved = { status: result.status, hard, service, soft };
await store.close();
// → { status: 'feasible', hard: 0, service: 0, soft: -3 }
```

What makes a resumed run answer what an uninterrupted one does:

- **Each slice is a function of the checkpoint alone.** The incumbent
  and the slice's budget are all a slice reads beside the job's payload,
  and the `seed` is the payload's, so the slices after a resume are the
  ones the uninterrupted run made, and the final answer is the same
  bytes. Nothing reads a clock: budgets count work (ASSIGN.md, Budgets
  and the signal).
- **A slice the signal cut is thrown away.** `solve` reads `signal`
  before each move and answers `limit` with `cancelled: true` where it
  stopped, which depends on when the abort came; the handler throws
  instead of saving it, the attempt fails (retried with backoff, §4) or
  its lease lapses (§5), and the next attempt repeats the slice from the
  same incumbent.
- **The checkpoint follows the lease.** `save` is fenced like any
  settling call (§3), so a superseded attempt writes nothing; `load` reads
  what attempts up to this one saved, one row per node id, the last save
  kept. The job's `maxAttempts` bounds how many times it starts again.
- **`limits` are the scoring's** (ASSIGN.md §5) and travel in the
  payload with the seed and the slice budget. Only `maxMoves` bounds a
  slice here: the doubling assumes it is what stopped one.
- **A slice holds the event loop.** `solve` is synchronous, so the lease
  is renewed only between slices: a slice, its budget doubled, must end
  well inside `leaseMs` (§5), or a second worker reclaims the job and the
  first one's next save is refused.

A finished job keeps its result in the queue row (`get`); its checkpoint
rows stay until `sweep` (§10) removes them with the job.

## Business receipt and external-effect composition

`jobs.assertLease(lease)` checks current execution authority without a write or
renewal. It uses the same token/expiry guard and `JD2065`/`JD2066`/`JD2067` refusals
as settlement; malformed authority is `JD2068`. Inside `tx.jobs`, this read and
subsequent mapped writes share the transaction lock. A decision made without a
lease reads the job the same way: `tx.jobs.get(id, { lock: true })` holds the
row until the transaction ends (PostgreSQL's `FOR UPDATE`; SQLite's writer
already keeps a claim out), so another store's claim cannot lease the job
between that read and the commit — it skips the row and claims it after — and
a second such decision waits at the row for the first one's commit. Workers receive
`context.lease()` to read their current token after automatic renewal, and
every task of a DAG job checks the same lease with `resources.assertLease(tx)` (§7).

`createWorker({ effectSafety(job, context), ... })` optionally gates each handler
admission. Only `true` admits; any other resolved value pauses the queue attempt
in its existing `cancelled` state without running the handler. The worker
`context.pause()` exposes the same operation. A paused job has no lease, so an
authorized operator records the decision without one — the mapped effect
store's `reconcile` with a `null` lease, fenced by the effect record's revision
([DB-CLIENT](../../linq/docs/DB-CLIENT.md#durable-mapped-records)) — and then
`requeue`s the job: whichever worker claims it next continues from that
decision. A claim selects by kind, never by id, so a requeue followed by a
claim hands the operator whichever job of the kind comes first. The job never
becomes an unreclaimable completed job merely because its external outcome is
unknown, and every pause spends one of its attempts, which `requeue` keeps
(§10): an effect plan declares its job's claim budget.
A thrown policy error follows the ordinary failure path and is checked again on
a later attempt. `createDagJobRunner` forwards the same hook. The hook supplements
the mapped effect store's mandatory pre-dispatch fence and durable intent; it is
not a replacement for them.

Business receipts and external intents belong to application-mapped tables via
`@jarenjs/linq/db`. Job reset/sweep operate on queue/checkpoint rows only and do
not erase those facts. An expired lease, reset or retryable job failure cannot
provide permission to resend unresolved external writes. Local co-commit does
not mean exactly-once remote delivery. See the contract package's
[durable composition](../../contract/docs/DURABLE.md).
