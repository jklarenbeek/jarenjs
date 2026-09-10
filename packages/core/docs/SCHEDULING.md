# Bounded scheduling and retry policy

`@jarenjs/core/schedule` exports `createScheduler`. It owns admission, finite
concurrency and queues, fair service among ready scopes, start spacing and rate
observations. It does not perform network I/O or decide whether a request is safe
to retry. `@jarenjs/core/retry` owns shared delay arithmetic, header parsing,
abortable sleep and total dispatch credits.

```js
import { createScheduler } from '@jarenjs/core/schedule';
import { createAttemptBudget, backoffDelay } from '@jarenjs/core/retry';

const scheduler = createScheduler({ concurrency: 4, maxQueue: 64,
  maxScopes: 256, spacingMs: 25 });
const budget = createAttemptBudget(3, 'safe-read');
await scheduler.run(() => {
  if (!budget.take()) throw new Error('attempt budget exhausted');
  return doOneAttempt();
}, { scope: 'origin/account', signal, deadline: Date.now() + 1000 });
await scheduler.close();
const delay = backoffDelay({ policy: 'strict', maxMs: 1000 }, 1, 10000);
// delay is 10000: the caller must wait that long or refuse the retry.
```

The defaults are concurrency `4`, waiting queue `64`, retained rate scopes
`256`, and spacing `0` milliseconds. Bounds must be finite integers, with
positive concurrency/queue/scopes and nonnegative spacing. `now` and `sleep` are
injectable. `run(worker, {scope, signal, deadline})` returns the worker's value;
expired, cancelled or closed work never starts. Ready scopes take turns, and
each scope retains FIFO order. A waiting scope does not occupy a worker.
`observe(scope, delayMs)` delays subsequent starts in that scope by at least the
observation, including requests queued by other callers. Rate scopes are bounded
and expired records are discarded on activity.

`stats()` reports active and queued counts and closed state. `close()` stops
admission, rejects queued work and drains admitted work before resolving.
Workers which ignore cancellation can delay that resolution: resource owners
must wait, and transports must support abort for timely cleanup. Refusals are
errors with messages `closed`, `cancelled`, `deadline`, `queue-full` or
`scope-limit`; malformed options are `TypeError`s. A worker rejection preserves
its error and does not close the shared scheduler.

`backoffDelay({policy,baseMs,maxMs,random}, attempt, retryAfterMs)` uses an attempt
count starting at one. Strict exponential backoff uses full jitter up to its
cap, while an explicit server delay is honored without clamping. `ai-compat`
preserves the AI clients' half-to-full jitter and clamps server delays to the
cap. `contract-compat` preserves the HTTP client's additive integer jitter.
The published AI/contract attempt counts and wire semantics remain unchanged;
their transport-specific outcome loops are deliberate wrappers around this
shared arithmetic. Strict deadline refusal belongs to the provider executor.

`parseRetryAfter(raw, {dialect,now})` accepts HTTP seconds/date by default,
numeric milliseconds under `milliseconds`, or nothing under `none`.
`sleep(ms, signal)` removes its timer and listener on settlement. `abortError`
returns the signal's reason, or a platform-shaped AbortError.

`createAttemptBudget(totalAttempts, safety)` returns a private frozen capability
with `take()`, `used` and `remaining`. Categories are `safe-read`,
`provider-idempotent` and `single-send`; single-send caps the budget at one.
Reuse the same capability across outer SDK/workflow/job callbacks for the same
request. Disable SDK transport retries: one transport invocation must mean one
wire attempt. A method or timeout does not establish replay safety.
