//@ts-check
/**
 * @file The job queue (JOBS-FORMAT §§2–4, §6): the record and its
 * states, idempotent enqueue by explicit id, claim ordering and the
 * kind filter (an unregistered kind stays pending and reports — the
 * deploy-ordering protection), owner-guarded transitions, retry with
 * DETERMINISTIC injected backoff, dead-lettering with the last error
 * retained, and the worker loop: wake-on-enqueue, drain-on-stop,
 * store-close stops workers. The clock and randomness are injected
 * everywhere — no test sleeps to make time pass.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

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

  it('transitions are owner-guarded: a stale worker changes nothing', async () => {
    const clock = makeClock();
    const store = await open({ now: clock });
    await store.jobs.enqueue('t', { n: 1 }, { id: 'j' });
    await store.jobs.claim({ kinds: ['t'], owner: 'w1', leaseMs: 100 });
    clock.advance(200); // the lease expires
    const reclaimed = await store.jobs.claim({ kinds: ['t'], owner: 'w2' });
    assert.strictEqual(reclaimed.id, 'j');
    assert.strictEqual(reclaimed.attempts, 2);

    assert.strictEqual(await store.jobs.complete('j', 'w1', { late: true }), false,
      "the stale owner's completion is DISCARDED");
    assert.strictEqual(await store.jobs.fail('j', 'w1', new Error('late')), false);
    const job = await store.jobs.get('j');
    assert.strictEqual(job.state, 'leased');
    assert.strictEqual(job.leaseOwner, 'w2');

    assert.strictEqual(await store.jobs.complete('j', 'w2', { ok: 1 }), true);
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

    await store.jobs.claim({ kinds: ['flaky'], owner: 'w' });
    await store.jobs.fail('j', 'w', new Error('boom 1'));
    let job = await store.jobs.get('j');
    assert.strictEqual(job.state, 'failed');
    assert.strictEqual(job.lastError, 'boom 1');
    assert.strictEqual(job.runAt, clock() + 750, 'min(cap, 1000·2⁰)·0.75');

    assert.strictEqual(await store.jobs.claim({ kinds: ['flaky'], owner: 'w' }),
      undefined, 'not eligible until the backoff passes');
    clock.advance(750);
    await store.jobs.claim({ kinds: ['flaky'], owner: 'w' });
    await store.jobs.fail('j', 'w', new Error('boom 2'));
    job = await store.jobs.get('j');
    assert.strictEqual(job.runAt, clock() + 1_500, 'min(cap, 1000·2¹)·0.75');

    clock.advance(1_500);
    await store.jobs.claim({ kinds: ['flaky'], owner: 'w' });
    await store.jobs.fail('j', 'w', new Error('boom 3'));
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
      await store.jobs.fail('j', 'w', new Error('x'));
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
