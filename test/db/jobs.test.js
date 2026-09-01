//@ts-check
/**
 * @file The job queue (JOBS-FORMAT §§2–4, §6): the record and its
 * states, idempotent enqueue by explicit id, claim ordering and the
 * kind filter (an unregistered kind stays pending and reports — the
 * deploy-ordering protection), FENCE-guarded transitions, retry with
 * DETERMINISTIC injected backoff, dead-lettering with the last error
 * retained, and the worker loop: wake-on-enqueue, drain-on-stop,
 * store-close stops workers. The clock and randomness are injected
 * everywhere — no test sleeps to make time pass.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = {
  $model: '0.1',
  collections: {
    x: { schema: { type: 'object', properties: { id: { type: 'string' } } },
      key: '/id', indexes: [] },
  },
};

/** A mutable injected clock. */
const makeClock = (start = 1_000_000) => {
  let at = start;
  const clock = () => at;
  clock.advance = (ms) => { at += ms; };
  return clock;
};

const open = (jobs = {}) => openStore(MODEL,
  { driver: nodeDriver(), jobs: { ...jobs } });

describe('the job record and enqueue (§2)', () => {
  it('an explicit id makes enqueue idempotent; defaults land as documented', async () => {
    const clock = makeClock();
    const store = await open({ now: clock });
    const first = await store.jobs.enqueue('mail', { to: 'ada' }, { id: 'job-1' });
    const again = await store.jobs.enqueue('mail', { to: 'SOMEONE ELSE' }, { id: 'job-1' });
    assert.strictEqual(first, 'job-1');
    assert.strictEqual(again, 'job-1');
    const job = await store.jobs.get('job-1');
    assert.deepStrictEqual(job.payload, { to: 'ada' },
      're-enqueueing an existing id changes NOTHING');
    assert.strictEqual(job.state, 'pending');
    assert.strictEqual(job.attempts, 0);
    assert.strictEqual(job.maxAttempts, 5);
    assert.strictEqual(job.runAt, clock());
    assert.strictEqual(await store.jobs.get('missing'), undefined);
    const bare = await store.jobs.enqueue('mail', null);
    assert.strictEqual((await store.jobs.get(bare)).payload, null,
      'a null payload round-trips as null');
    await assert.rejects(() => store.jobs.enqueue('', {}), TypeError);
    await store.close();
  });

  it('a future runAt schedules; the claim respects eligibility', async () => {
    const clock = makeClock();
    const store = await open({ now: clock });
    await store.jobs.enqueue('later', {}, { id: 'j', runAt: clock() + 5_000 });
    assert.strictEqual(
      await store.jobs.claim({ kinds: ['later'], owner: 'w' }), undefined);
    clock.advance(5_000);
    const job = await store.jobs.claim({ kinds: ['later'], owner: 'w' });
    assert.strictEqual(job.id, 'j');
    assert.strictEqual(job.state, 'leased');
    assert.strictEqual(job.attempts, 1, 'attempts increment AT claim');
    await store.close();
  });
});

describe('claiming (§3)', () => {
  it('claims oldest-eligible first and only REGISTERED kinds; the rest stay pending', async () => {
    const clock = makeClock();
    const store = await open({ now: clock });
    await store.jobs.enqueue('unknown-kind', {}, { id: 'u1' });
    clock.advance(10);
    await store.jobs.enqueue('known', {}, { id: 'k1' });
    clock.advance(10);
    await store.jobs.enqueue('known', {}, { id: 'k2' });

    const first = await store.jobs.claim({ kinds: ['known'], owner: 'w' });
    const second = await store.jobs.claim({ kinds: ['known'], owner: 'w' });
    assert.deepStrictEqual([first.id, second.id], ['k1', 'k2'], 'oldest first');
    assert.strictEqual(await store.jobs.claim({ kinds: ['known'], owner: 'w' }),
      undefined, 'the unregistered kind is NEVER claimed by this worker');
    const counts = await store.jobs.counts();
    assert.strictEqual(counts.pending, 1);
    assert.deepStrictEqual(counts.pendingKinds, { 'unknown-kind': 1 },
      'the stranded kind REPORTS instead of dead-lettering');
    await assert.rejects(() => store.jobs.claim({ kinds: [], owner: 'w' }), TypeError);
    await store.close();
  });

  it('transitions are fence-guarded: a stale attempt is refused, by name', async () => {
    const clock = makeClock();
    const store = await open({ now: clock });
    await store.jobs.enqueue('t', { n: 1 }, { id: 'j' });
    const first = await store.jobs.claim({ kinds: ['t'], owner: 'w1', leaseMs: 100 });
    clock.advance(200); // the lease expires
    const reclaimed = await store.jobs.claim({ kinds: ['t'], owner: 'w2' });
    assert.strictEqual(reclaimed.id, 'j');
    assert.strictEqual(reclaimed.attempts, 2);
    assert.strictEqual(reclaimed.lease.generation, first.lease.generation + 1);

    await assert.rejects(() => store.jobs.complete(first.lease, { late: true }),
      (e) => e.code === 'JD2066', "the stale attempt's completion is REFUSED, not dropped");
    await assert.rejects(() => store.jobs.fail(first.lease, new Error('late')),
      (e) => e.code === 'JD2066');
    const job = await store.jobs.get('j');
    assert.strictEqual(job.state, 'leased');
    assert.strictEqual(job.leaseOwner, 'w2');

    assert.strictEqual(await store.jobs.complete(reclaimed.lease, { ok: 1 }), true);
    assert.deepStrictEqual((await store.jobs.get('j')).result, { ok: 1 });
    await store.close();
  });
});

describe('retry and dead-lettering (§4)', () => {
  it('backoff is exponential, jittered, DETERMINISTIC under the injected source', async () => {
    const clock = makeClock();
    // random () => 0.5 → jitter factor 0.75 exactly
    const store = await open({ now: clock, random: () => 0.5, maxAttempts: 3 });
    await store.jobs.enqueue('flaky', {}, { id: 'j' });

    let held = await store.jobs.claim({ kinds: ['flaky'], owner: 'w' });
    await store.jobs.fail(held.lease, new Error('boom 1'));
    let job = await store.jobs.get('j');
    assert.strictEqual(job.state, 'failed');
    assert.strictEqual(job.lastError, 'boom 1');
    assert.strictEqual(job.runAt, clock() + 750, 'min(cap, 1000·2⁰)·0.75');

    assert.strictEqual(await store.jobs.claim({ kinds: ['flaky'], owner: 'w' }),
      undefined, 'not eligible until the backoff passes');
    clock.advance(750);
    held = await store.jobs.claim({ kinds: ['flaky'], owner: 'w' });
    await store.jobs.fail(held.lease, new Error('boom 2'));
    job = await store.jobs.get('j');
    assert.strictEqual(job.runAt, clock() + 1_500, 'min(cap, 1000·2¹)·0.75');

    clock.advance(1_500);
    held = await store.jobs.claim({ kinds: ['flaky'], owner: 'w' });
    await store.jobs.fail(held.lease, new Error('boom 3'));
    job = await store.jobs.get('j');
    assert.strictEqual(job.state, 'dead', 'attempts exhausted max_attempts 3');
    assert.strictEqual(job.lastError, 'boom 3', 'the LAST error is retained');
    assert.strictEqual(await store.jobs.claim({ kinds: ['flaky'], owner: 'w' }),
      undefined, 'dead is terminal');
    assert.strictEqual((await store.jobs.counts()).dead, 1);
    await store.close();
  });

  it('the backoff cap bounds the delay', async () => {
    const clock = makeClock();
    const store = await open({
      now: clock, random: () => 1, maxAttempts: 20,
      backoffBase: 1_000, backoffCap: 4_000,
    });
    await store.jobs.enqueue('f', {}, { id: 'j' });
    for (let i = 0; i < 5; i++) {
      const job = await store.jobs.claim({ kinds: ['f'], owner: 'w' });
      if (job === undefined) break;
      await store.jobs.fail(job.lease, new Error('x'));
      const failed = await store.jobs.get('j');
      clock.advance(failed.runAt - clock());
    }
    const job = await store.jobs.get('j');
    assert.ok(job.attempts >= 4);
    // with random()=1 the factor is 1: the 4th delay is min(4000, 8000)=4000
    await store.close();
  });
});

describe('workers (§6)', () => {
  it('an enqueue wakes an idle local worker immediately', async () => {
    const store = await open({});
    const done = [];
    const worker = store.jobs.createWorker({
      handlers: { fast: (payload) => { done.push(payload.n); } },
      pollInterval: 60_000, // a poll this slow would fail the test on its own
    });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 20)); // reach the sleep
    await store.jobs.enqueue('fast', { n: 1 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepStrictEqual(done, [1], 'woken, not polled');
    assert.ok(worker.stats().wakes >= 1);
    assert.strictEqual(worker.stats().completions, 1);
    await worker.stop();
    await store.close();
  });

  it('a throwing handler fails the job; stop() drains; close() stops workers', async () => {
    const clock = makeClock();
    const store = await open({ now: clock, random: () => 0.5 });
    const worker = store.jobs.createWorker({
      handlers: { boom: () => { throw new Error('handler bug'); } },
      pollInterval: 10,
    });
    assert.throws(() => store.jobs.createWorker({ handlers: {} }), TypeError);
    worker.start();
    assert.throws(() => worker.start(), TypeError, 'double start refuses');
    await store.jobs.enqueue('boom', {}, { id: 'j' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const job = await store.jobs.get('j');
    assert.strictEqual(job.state, 'failed');
    assert.strictEqual(job.lastError, 'handler bug');
    assert.strictEqual(worker.stats().failures, 1);
    await worker.stop();
    await store.close(); // second stop through close is a no-op
  });
});

// ————— the fence (§3): a token, a validity, and a coded refusal —————

describe('the lease fence', () => {
  it('expired_lease_cannot_settle', async () => {
    const clock = makeClock();
    const store = await open({ now: clock });
    await store.jobs.enqueue('t', {}, { id: 'j1' });
    const held = await store.jobs.claim({ kinds: ['t'], owner: 'worker-A', leaseMs: 30_000 });
    assert.strictEqual(held.lease.expiresAt, clock() + 30_000);

    clock.advance(60_000); // the lease lapsed half a minute ago
    for (const settle of [
      () => store.jobs.complete(held.lease, { late: true }),
      () => store.jobs.fail(held.lease, new Error('late')),
      () => store.jobs.renew(held.lease),
      () => store.jobs.checkpointsFor(held).save('j1', 'n', 1),
    ]) {
      await assert.rejects(async () => settle(),
        (e) => e.code === 'JD2067' && /expired/.test(e.message));
    }
    assert.strictEqual((await store.jobs.get('j1')).state, 'leased',
      'a lease 30 s dead settles nothing');
    assert.strictEqual((await store.jobs.get('j1')).result, null);
    await store.close();
  });

  it('same_owner_reclaim_fences_the_first_attempt', async () => {
    const clock = makeClock();
    const store = await open({ now: clock });
    await store.jobs.enqueue('t', {}, { id: 'j2' });
    // ONE worker, one owner, two attempts — which is every real worker
    const first = await store.jobs.claim({ kinds: ['t'], owner: 'worker-B', leaseMs: 100 });
    clock.advance(200);
    const second = await store.jobs.claim({ kinds: ['t'], owner: 'worker-B' });
    assert.strictEqual(first.lease.owner, second.lease.owner,
      'the owner cannot tell the two attempts apart');
    assert.strictEqual(second.lease.generation, first.lease.generation + 1);
    assert.deepStrictEqual([first.attempts, second.attempts], [1, 2]);

    for (const settle of [
      () => store.jobs.complete(first.lease, { from: 'the STALE attempt' }),
      () => store.jobs.fail(first.lease, new Error('stale')),
      () => store.jobs.renew(first.lease),
      () => store.jobs.checkpointsFor(first).save('j2', 'n', 1),
    ]) {
      await assert.rejects(async () => settle(),
        (e) => e.code === 'JD2066' && /superseded/.test(e.message));
    }
    // attempt 2 is the one that decides what the row ends with
    assert.strictEqual(await store.jobs.complete(second.lease, { from: 'attempt 2' }), true);
    assert.deepStrictEqual((await store.jobs.get('j2')).result, { from: 'attempt 2' });
    await store.close();
  });

  it('renew_returns_a_replacement_and_retires_the_old_lease', async () => {
    const clock = makeClock();
    const store = await open({ now: clock });
    await store.jobs.enqueue('t', {}, { id: 'j3' });
    const held = await store.jobs.claim({ kinds: ['t'], owner: 'w', leaseMs: 1_000 });
    clock.advance(600);
    const renewed = await store.jobs.renew(held.lease, { leaseMs: 1_000 });

    assert.notStrictEqual(renewed.token, held.lease.token, 'a NEW lease, never a mutation');
    assert.strictEqual(Object.isFrozen(renewed), true);
    assert.strictEqual(renewed.expiresAt, clock() + 1_000);
    assert.strictEqual(renewed.generation, held.lease.generation,
      'a renewal is the same attempt, so the generation stands');
    assert.strictEqual(renewed.attempt, held.lease.attempt);
    assert.strictEqual(held.lease.expiresAt, 1_000_000 + 1_000,
      'the old lease is a value: nothing mutated it');

    for (const settle of [
      () => store.jobs.complete(held.lease, {}),
      () => store.jobs.fail(held.lease, new Error('x')),
      () => store.jobs.renew(held.lease),
      () => store.jobs.checkpointsFor(held).save('j3', 'n', 1),
    ]) {
      await assert.rejects(async () => settle(),
        (e) => e.code === 'JD2066', 'the superseded token settles nothing');
    }
    assert.strictEqual(await store.jobs.complete(renewed, { ok: true }), true);
    await store.close();
  });

  it('renew_racing_reclaim_has_exactly_one_winner', async () => {
    const clock = makeClock();
    const store = await open({ now: clock });
    await store.jobs.enqueue('t', {}, { id: 'j4' });
    const held = await store.jobs.claim({ kinds: ['t'], owner: 'w1', leaseMs: 100 });
    clock.advance(200);
    // the reclaim gets there first; the renewal then arrives against a
    // token the reclaim has already replaced
    const reclaimed = await store.jobs.claim({ kinds: ['t'], owner: 'w2' });
    await assert.rejects(() => store.jobs.renew(held.lease), (e) => e.code === 'JD2066');
    assert.strictEqual(await store.jobs.complete(reclaimed.lease, { winner: 'reclaim' }), true);

    // and the other order: the renewal lands first, so the reclaim finds
    // no expired lease to take
    await store.jobs.enqueue('t', {}, { id: 'j5' });
    const other = await store.jobs.claim({ kinds: ['t'], owner: 'w1', leaseMs: 100 });
    clock.advance(50);
    const stillMine = await store.jobs.renew(other.lease, { leaseMs: 10_000 });
    clock.advance(60); // past the ORIGINAL expiry, inside the renewed one
    assert.strictEqual(await store.jobs.claim({ kinds: ['t'], owner: 'w2' }), undefined,
      'the renewal moved the expiry, so there is nothing to reclaim');
    assert.strictEqual(await store.jobs.complete(stillMine, { winner: 'renew' }), true);
    await store.close();
  });

  it('stale_attempt_cannot_prune_newer_checkpoints', async () => {
    const clock = makeClock();
    const store = await open({ now: clock });
    await store.jobs.enqueue('t', {}, { id: 'j6' });
    const first = await store.jobs.claim({ kinds: ['t'], owner: 'w', leaseMs: 100 });
    store.jobs.checkpointsFor(first).save('j6', 'step-1', { by: 'attempt 1' });
    clock.advance(200);
    const second = await store.jobs.claim({ kinds: ['t'], owner: 'w' });
    const live = store.jobs.checkpointsFor(second);

    // the live attempt resumes from its predecessor's work…
    assert.deepStrictEqual(live.load('j6'), { values: { 'step-1': { by: 'attempt 1' } } });
    live.save('j6', 'step-2', { by: 'attempt 2' });

    // …and the corpse can neither write nor settle, so it prunes nothing
    await assert.rejects(() => store.jobs.complete(first.lease, {}),
      (e) => e.code === 'JD2066');
    assert.deepStrictEqual(live.load('j6'), {
      values: { 'step-1': { by: 'attempt 1' }, 'step-2': { by: 'attempt 2' } },
    }, 'the live attempt kept its checkpoints through the stale settlement');
    await store.close();
  });

  it('an unknown or already-settled job is its own refusal', async () => {
    const clock = makeClock();
    const store = await open({ now: clock });
    await store.jobs.enqueue('t', {}, { id: 'j7' });
    const held = await store.jobs.claim({ kinds: ['t'], owner: 'w' });
    assert.strictEqual(await store.jobs.complete(held.lease, { ok: 1 }), true);
    // settling twice from ONE attempt is idempotent — that settlement is
    // the one the row already carries
    assert.strictEqual(await store.jobs.complete(held.lease, { ok: 1 }), true);
    await assert.rejects(() => store.jobs.renew(held.lease),
      (e) => e.code === 'JD2065' && /already settled/.test(e.message));
    await assert.rejects(async () => store.jobs.checkpointsFor(held).save('j7', 'n', 1),
      (e) => e.code === 'JD2065');
    // a lease naming a job that never existed
    const ghost = { ...held.lease, jobId: 'never' };
    await assert.rejects(() => store.jobs.complete(ghost, {}),
      (e) => e.code === 'JD2065' && /unknown/.test(e.message));
    await store.close();
  });

  it('the pre-fence owner spelling is a coded refusal naming the lease', async () => {
    const store = await open({});
    await store.jobs.enqueue('t', {}, { id: 'j8' });
    const held = await store.jobs.claim({ kinds: ['t'], owner: 'w' });
    for (const call of [
      () => store.jobs.complete('j8', 'w', { ok: 1 }),
      () => store.jobs.fail('j8', 'w', new Error('x')),
      () => store.jobs.renew('j8', 'w'),
    ]) {
      await assert.rejects(async () => call(),
        (e) => e.code === 'JD2068' && /job\.lease/.test(e.message));
    }
    assert.strictEqual((await store.jobs.get('j8')).state, 'leased');
    assert.strictEqual(await store.jobs.complete(held.lease, { ok: 1 }), true);
    await store.close();
  });

  it('a readable job record never carries the capability to settle it', async () => {
    const store = await open({});
    await store.jobs.enqueue('t', {}, { id: 'j9' });
    const held = await store.jobs.claim({ kinds: ['t'], owner: 'w' });
    const read = await store.jobs.get('j9');
    assert.strictEqual(read.lease, undefined, 'get() hands out no lease');
    assert.strictEqual(Object.values(read).includes(held.lease.token), false,
      'and no token under any other name');
    assert.strictEqual(read.leaseGeneration, held.lease.generation);
    await store.close();
  });
});

describe('the drift gate the fence owes itself', () => {
  it('no settling statement in jobs.js is guarded by lease_owner without a token', () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('../../packages/db/src/jobs.js', import.meta.url)), 'utf8');
    // every UPDATE of the jobs table, split into what it writes and what
    // it is guarded by. A statement that SETTLES a claim — done, dead,
    // failed, or a renewed expiry — must be guarded by the token, and by
    // nothing that a second attempt of the same worker would also match.
    // That is the shape whose absence let a 30-second-dead lease complete
    // a job, and the shape whose absence let a corpse discard the living
    // attempt's result.
    // the shared guard is a constant, so the gate reads it and puts it
    // back — a fence weakened THERE has to fail here too
    const fence = source.match(/const FENCE = ("|')(.*?)\1;/);
    assert.ok(fence !== null, 'jobs.js declares one shared fence');
    assert.strictEqual(fence[2], "state='leased' AND lease_token=? AND lease_until > ?");
    const updates = [...source.matchAll(/UPDATE "\$\{JOBS_TABLE\}"([\s\S]*?)`/g)]
      .map((match) => match[1].replaceAll('${FENCE}', fence[2]));
    assert.ok(updates.length >= 5, `expected the job updates, found ${updates.length}`);
    let settling = 0;
    for (const sql of updates) {
      const [writes, ...guard] = sql.split(/\bWHERE\b/);
      const where = guard.join(' WHERE ');
      // the CLAIM mints the fence rather than checking one: it is the
      // only statement allowed to write an owner and a token
      if (/state='leased'/.test(writes)) {
        assert.match(writes, /lease_generation = lease_generation \+ 1/,
          'the claim must bump the generation');
        assert.match(writes, /lease_token=\?/, 'the claim must mint a token');
        continue;
      }
      if (!/state='(done|dead|failed)'|lease_until=\?/.test(writes)) continue;
      settling += 1;
      assert.ok(/lease_token=\?/.test(where),
        `a settling statement carries no token guard:\n${sql}`);
      assert.ok(/lease_until > \?/.test(where),
        `a settling statement does not check the lease is still valid:\n${sql}`);
      assert.ok(!/lease_owner/.test(where),
        `a settling statement is guarded by lease_owner:\n${sql}`);
    }
    assert.ok(settling >= 4,
      `expected renew, complete, dead and retry to be fenced, found ${settling}`);
  });
});

// ————— the worker over the fence (§5, §6) —————

/** Resolve once the predicate holds, or fail the test at the deadline. */
const until = async (predicate, what, deadlineMs = 15_000) => {
  const stop = Date.now() + deadlineMs;
  for (;;) {
    if (predicate()) return;
    assert.ok(Date.now() < stop, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('the worker over the fence', () => {
  it('a handler that runs longer than its lease completes, because the lease is renewed', async () => {
    const store = await open({});
    let release = () => {};
    const held = new Promise((resolve) => { release = resolve; });
    const outcomes = [];
    // one second of lease, renewed every third of one, and a handler that
    // runs past the original expiry: without renewal this is B4 —
    // unfenced by construction, and reclaimable out from under itself.
    // The interval is generous on purpose: this is a real timer, and the
    // suite runs many files at once.
    const leaseMs = 1_000;
    const worker = store.jobs.createWorker({
      handlers: { slow: async () => { await held; return { ok: true }; } },
      leaseMs, pollInterval: 5,
      onOutcome: (event) => outcomes.push(event),
    });
    worker.start();
    await store.jobs.enqueue('slow', {}, { id: 'j' });
    await until(() => worker.stats().renewals >= 1, 'the first renewal');
    const first = worker.leases()[0];

    // the lease really moved, and it is the same ATTEMPT that holds it
    const midway = await store.jobs.get('j');
    assert.strictEqual(midway.state, 'leased');
    assert.strictEqual(midway.attempts, 1, 'nothing reclaimed it');
    assert.ok(midway.leaseUntil > 0);
    assert.strictEqual(worker.leases().length, 1);
    assert.strictEqual(first.generation, 1);

    // …and stays held past the expiry the ORIGINAL claim wrote
    await new Promise((resolve) => setTimeout(resolve, leaseMs + 200));
    assert.strictEqual((await store.jobs.get('j')).attempts, 1,
      'the renewals kept it: a handler outliving its lease is supported now');
    assert.ok(worker.stats().renewals >= 2);

    release();
    await until(() => worker.stats().completions === 1, 'the completion');
    assert.deepStrictEqual((await store.jobs.get('j')).result, { ok: true });
    assert.strictEqual(worker.stats().lostSettlements, 0);
    assert.deepStrictEqual(outcomes.map((event) => event.outcome), ['completed']);
    await worker.stop();
    await store.close();
  });

  it('renew: false keeps the old behaviour, deliberately', async () => {
    const store = await open({});
    let release = () => {};
    const held = new Promise((resolve) => { release = resolve; });
    const worker = store.jobs.createWorker({
      handlers: { slow: async () => { await held; return 1; } },
      leaseMs: 40, pollInterval: 5, renew: false,
    });
    worker.start();
    await store.jobs.enqueue('slow', {}, { id: 'j' });
    await until(() => worker.stats().claims === 1, 'the claim');
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.strictEqual(worker.stats().renewals, 0, 'nothing renewed');
    release();
    await worker.stop();
    await store.close();
  });

  it('lease_loss_aborts_the_attempt_before_another_checkpoint', async () => {
    // the eligibility clock is injected, so the lease can be made to
    // lapse on demand however long the renewal timer actually waits
    const clock = makeClock();
    const store = await open({ now: clock });
    const written = [];
    let sawAbort = null;
    const outcomes = [];
    const worker = store.jobs.createWorker({
      handlers: {
        stepped: async (payload, { job, checkpoints, signal }) => {
          checkpoints.save(job.id, 'step-1', { n: 1 });
          written.push('step-1');
          // the lease is taken from under this attempt while it waits
          await new Promise((resolve) => {
            if (signal.aborted) { resolve(undefined); return; }
            signal.addEventListener('abort', () => resolve(undefined), { once: true });
          });
          sawAbort = signal.reason;
          // a handler that ignores the abort still cannot write
          assert.throws(() => checkpoints.save(job.id, 'step-2', { n: 2 }),
            (e) => e.code === 'JD2066' || e.code === 'JD2067');
          return { finished: 'anyway' };
        },
      },
      leaseMs: 60, pollInterval: 5,
      onOutcome: (event) => outcomes.push(event),
    });
    worker.start();
    await store.jobs.enqueue('stepped', {}, { id: 'j' });
    await until(() => written.length === 1, 'the first checkpoint');

    // another process reclaims the job: the renewal that follows finds a
    // token it no longer holds
    assert.strictEqual(
      await store.jobs.claim({ kinds: ['stepped'], owner: 'someone-else' }), undefined,
      'not yet — the lease is still live');
    clock.advance(10_000); // far past any renewal this attempt has made
    const taken = await store.jobs.claim({ kinds: ['stepped'], owner: 'someone-else' });
    assert.notStrictEqual(taken, undefined, 'the lapsed lease is reclaimable');
    assert.strictEqual(taken.lease.generation, 2);

    await until(() => sawAbort !== null, 'the abort to reach the handler');
    assert.strictEqual(sawAbort.code === 'JD2066' || sawAbort.code === 'JD2067', true,
      `the signal carries the reason, got ${sawAbort.code}`);

    await until(() => worker.stats().lostSettlements === 1, 'the lost settlement');
    assert.strictEqual(worker.stats().completions, 0, 'never counted as a completion');
    assert.strictEqual(worker.stats().failures, 0, 'nor as a failure — it spent no retry');
    const lost = outcomes.find((event) => event.outcome === 'lost');
    assert.strictEqual(lost.jobId, 'j');
    assert.strictEqual(lost.generation, 1);
    assert.ok(['JD2066', 'JD2067'].includes(lost.code));

    // the row still belongs to the attempt that took it
    const job = await store.jobs.get('j');
    assert.strictEqual(job.state, 'leased');
    assert.strictEqual(job.leaseOwner, 'someone-else');
    assert.strictEqual(job.result, null);
    await worker.stop();
    await store.close();
  });

  it('in-flight attempts are keyed by the fence token, never by owner', async () => {
    const store = await open({});
    const release = [];
    const worker = store.jobs.createWorker({
      handlers: {
        hold: () => new Promise((resolve) => release.push(resolve)),
      },
      concurrency: 2, leaseMs: 5_000, pollInterval: 5, owner: 'one-owner',
    });
    worker.start();
    await store.jobs.enqueue('hold', {}, { id: 'a' });
    await store.jobs.enqueue('hold', {}, { id: 'b' });
    await until(() => worker.leases().length === 2, 'two in-flight attempts');

    const leases = worker.leases();
    assert.strictEqual(new Set(leases.map((lease) => lease.owner)).size, 1,
      'one worker, one owner — which is why the owner cannot be the key');
    assert.strictEqual(new Set(leases.map((lease) => lease.token)).size, 2,
      'two attempts, two tokens');
    for (const resolve of release) resolve(1);
    await until(() => worker.stats().completions === 2, 'both completions');
    await worker.stop();
    await store.close();
  });

it('a cancelled loop stops renewing: no store write after stop() gave up', async () => {
    // §6.1's invariant, applied to the renewal timer a lease needs. A
    // renewal is a store WRITE, and the store is the one the caller is
    // about to close — so a loop the grace period could not drain must
    // stop holding its lease, and let the job recover by re-claim (§5).
    const store = await open({});
    const worker = store.jobs.createWorker({
      // a handler that ignores its signal entirely: the wedge §6.1 is about
      handlers: { wedged: () => new Promise(() => {}) },
      leaseMs: 60, pollInterval: 5,
    });
    worker.start();
    await store.jobs.enqueue('wedged', {}, { id: 'j' });
    // the claim is the only thing worth waiting on: the renewal timer is
    // armed with the attempt, so the invariant holds however many times
    // it has already fired
    await until(() => worker.stats().claims === 1, 'the claim');

    const stopped = await worker.stop({ graceMs: 30 });
    assert.strictEqual(stopped.drained, false, 'the wedge could not be drained');
    const atStop = worker.stats().renewals;
    await new Promise((resolve) => setTimeout(resolve, 250)); // many intervals
    assert.strictEqual(worker.stats().renewals, atStop,
      'the cancelled loop renewed nothing further');

    // and the lease it abandoned really does lapse, so the job recovers
    const reclaimed = await store.jobs.claim({ kinds: ['wedged'], owner: 'next' });
    assert.notStrictEqual(reclaimed, undefined,
      'the abandoned lease expired and the job is claimable again');
    await store.close();
  });

  it('a settlement that fails for a STORAGE reason is a failure, not a lost lease', async () => {
    // only the three FENCE refusals mean the job moved on; anything else
    // is this attempt's own problem, and it spends this attempt's retry
    const store = await open({ random: () => 0.5 });
    const outcomes = [];
    const worker = store.jobs.createWorker({
      // a BigInt is not representable as JSON, so the completion write
      // refuses before it touches the database
      handlers: { odd: () => ({ n: 1n }) },
      pollInterval: 5,
      onOutcome: (event) => outcomes.push(event),
    });
    worker.start();
    await store.jobs.enqueue('odd', {}, { id: 'j' });
    await until(() => worker.stats().failures === 1, 'the failed attempt');
    assert.strictEqual(worker.stats().lostSettlements, 0,
      'the lease was never in question');
    assert.strictEqual(worker.stats().completions, 0);
    assert.deepStrictEqual(outcomes.map((event) => event.outcome), ['failed']);
    assert.match(outcomes[0].reason, /could not be serialized/);
    assert.strictEqual((await store.jobs.get('j')).state, 'failed',
      'the job is scheduled for its retry, as any failed attempt is');
    await worker.stop();
    await store.close();
  });
});
