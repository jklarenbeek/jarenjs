//@ts-check
/**
 * @file Job administration (JOBS-FORMAT §10): an operator pages the
 * queue through a keyset cursor admitted per pull under the store
 * gate, cancels a queued job by its identity or a claimed one through
 * its lease (the handler's signal aborts and the call resolves when the
 * attempt has wound up), requeues a failed, dead, cancelled or expired
 * job with an honest attempt history, and sweeps settled history older
 * than a horizon it must name — each a mechanism with a coded failure
 * surface and a two-run answer, never a schedule.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = {
  $model: '0.1',
  collections: {
    x: { schema: { type: 'object', properties: { id: { type: 'string' } } }, key: '/id', indexes: [] },
  },
};

/** A mutable injected clock. */
const makeClock = (start = 1_000_000) => {
  let at = start;
  const clock = () => at;
  clock.advance = (ms) => { at += ms; };
  return clock;
};

const open = (jobs = {}) => openStore(MODEL, { driver: nodeDriver(), jobs: { random: () => 0.5, ...jobs } });

/** Drain a cursor into its items. */
async function drain(cursor) {
  const items = [];
  for await (const item of cursor) items.push(item);
  return items;
}

describe('page', () => {
  it('walks the queue in keyset pages by id, filtered by state and kind, admitted under the gate', async () => {
    const clock = makeClock();
    const store = await open({ now: clock });
    for (let i = 0; i < 7; i++) await store.jobs.enqueue(i % 2 === 0 ? 'mail' : 'sms', { i }, { id: `j${i}` });
    const lease = (await store.jobs.claim({ kinds: ['mail'], owner: 'w' })).lease;
    await store.jobs.complete(lease, { ok: true });
    const all = await drain(store.jobs.page());
    assert.deepStrictEqual(all.map((job) => job.id), ['j0', 'j1', 'j2', 'j3', 'j4', 'j5', 'j6']);
    assert.deepStrictEqual(Object.keys(all[0]).sort(), Object.keys(await store.jobs.get('j0')).sort(),
      'an item is the job record get() answers');
    assert.strictEqual(all[0].state, 'done');
    const pending = await drain(store.jobs.page({ state: 'pending' }));
    assert.deepStrictEqual(pending.map((job) => job.id), ['j1', 'j2', 'j3', 'j4', 'j5', 'j6']);
    const sms = await drain(store.jobs.page({ kind: 'sms', limit: 2 }));
    assert.deepStrictEqual(sms.map((job) => job.id), ['j1', 'j3']);
    const rest = await drain(store.jobs.page({ kind: 'sms', after: 'j3' }));
    assert.deepStrictEqual(rest.map((job) => job.id), ['j5']);
    // the cursor classifies itself like every other cursor of the store
    const cursor = store.jobs.page();
    assert.strictEqual(cursor.streaming, 'row');
    await cursor.return();
    await assert.rejects(async () => store.jobs.page({ state: /** @type {any} */ ('queued') }), TypeError);
    await assert.rejects(async () => store.jobs.page({ limit: 0 }), TypeError);
    // a page pull is admitted per pull: it waits for an open transaction
    const order = [];
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const transaction = store.transaction(async (tx) => {
      await tx.jobs.enqueue('mail', {}, { id: 'inside' });
      order.push('tx');
      await held;
    });
    const pull = drain(store.jobs.page({ state: 'pending' })).then((items) => { order.push('page'); return items; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepStrictEqual(order, ['tx']);
    release();
    await transaction;
    const items = await pull;
    assert.ok(items.some((job) => job.id === 'inside'), 'the page read the committed row');
    await store.close();
  });

  it('honours signal (JD2072) and deadline (JD2075) at row boundaries', async () => {
    const clock = makeClock();
    const store = await openStore(MODEL, { driver: nodeDriver(), jobs: { now: clock }, runtime: { now: clock } });
    for (let i = 0; i < 3; i++) await store.jobs.enqueue('k', {}, { id: `j${i}` });
    const controller = new AbortController();
    const cursor = store.jobs.page({ signal: controller.signal });
    assert.strictEqual((await cursor.next()).value.id, 'j0');
    controller.abort();
    await assert.rejects(cursor.next(), (error) => error.code === 'JD2072');
    const timed = store.jobs.page({ deadline: clock() + 10 });
    assert.strictEqual((await timed.next()).value.id, 'j0');
    clock.advance(20);
    await assert.rejects(timed.next(), (error) => error.code === 'JD2075');
    await store.close();
  });
});

describe('cancel', () => {
  it('a queued job settles as cancelled; a later claim never hands it out; get reports it', async () => {
    const store = await open();
    await store.jobs.enqueue('k', { n: 1 }, { id: 'q' });
    assert.strictEqual(await store.jobs.cancel('q'), true);
    const job = await store.jobs.get('q');
    assert.strictEqual(job.state, 'cancelled');
    assert.strictEqual(job.lastError, 'cancelled');
    assert.strictEqual(await store.jobs.claim({ kinds: ['k'], owner: 'w' }), undefined);
    assert.strictEqual((await store.jobs.counts()).cancelled, 1);
    // two-run: cancelling again changes nothing and says so
    assert.strictEqual(await store.jobs.cancel('q'), false);
    // an unknown id, and a settled one, refuse as a settling call does
    await assert.rejects(store.jobs.cancel('nope'), (error) => error.code === 'JD2065');
    await store.jobs.enqueue('k', {}, { id: 'd' });
    const lease = (await store.jobs.claim({ kinds: ['k'], owner: 'w' })).lease;
    await store.jobs.complete(lease, null);
    await assert.rejects(store.jobs.cancel('d'), (error) => error.code === 'JD2065');
    await assert.rejects(store.jobs.cancel(''), TypeError);
    await store.close();
  });

  it('a claimed job needs its CURRENT lease: stale or absent leases refuse with the fence codes', async () => {
    const clock = makeClock();
    const store = await open({ now: clock, leaseMs: 1000 });
    await store.jobs.enqueue('k', {}, { id: 'c' });
    const first = (await store.jobs.claim({ kinds: ['k'], owner: 'w' })).lease;
    // without a lease, a claimed job is not the enqueuer's to cancel
    await assert.rejects(store.jobs.cancel('c'), (error) => error.code === 'JD2068');
    const renewed = await store.jobs.renew(first);
    await assert.rejects(store.jobs.cancel('c', { lease: first }), (error) => error.code === 'JD2066');
    await assert.rejects(store.jobs.cancel('c', { lease: { jobId: 'c', token: 'x', generation: 1 } }),
      (error) => error.code === 'JD2066');
    clock.advance(5000);
    await assert.rejects(store.jobs.cancel('c', { lease: renewed }), (error) => error.code === 'JD2067');
    // the API-misuse spellings
    await assert.rejects(store.jobs.cancel('c', { lease: { id: 'c', owner: 'w' } }), (error) => error.code === 'JD2068');
    await store.close();
  });

  it('with the current lease the handler\'s signal aborts, the call resolves on its settlement, and the outcome is cancelled', async () => {
    const store = await open();
    await store.jobs.enqueue('slow', { n: 1 }, { id: 's' });
    let observed = null;
    let unblock;
    const outcomes = [];
    const worker = store.jobs.createWorker({
      handlers: {
        slow: (_payload, { job, signal }) => new Promise((resolve, reject) => {
          observed = job.lease;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          unblock = resolve;
        }),
      },
      pollInterval: 5,
      onOutcome: (event) => outcomes.push(event),
    }).start();
    while (observed === null) await new Promise((resolve) => setTimeout(resolve, 5));
    let settled = false;
    const cancelling = store.jobs.cancel('s', { lease: observed }).then((out) => { settled = true; return out; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(await cancelling, true);
    assert.strictEqual(settled, true);
    const job = await store.jobs.get('s');
    assert.strictEqual(job.state, 'cancelled');
    assert.strictEqual(job.leaseUntil, null);
    assert.ok(outcomes.some((event) => event.outcome === 'cancelled' && event.jobId === 's'),
      JSON.stringify(outcomes));
    assert.strictEqual(worker.stats().cancellations, 1);
    assert.strictEqual(worker.stats().failures, 0);
    assert.deepStrictEqual(await worker.stop({ graceMs: 200 }), { drained: true, inFlight: 0 });
    void unblock;
    await store.close();
  });
});

describe('requeue', () => {
  it('a failed job is claimable again with an honest attempt history; dead and cancelled too', async () => {
    const clock = makeClock();
    const store = await open({ now: clock, maxAttempts: 1, backoffBase: 1000 });
    await store.jobs.enqueue('k', {}, { id: 'r' });
    const first = await store.jobs.claim({ kinds: ['k'], owner: 'w' });
    await store.jobs.fail(first.lease, new Error('boom'));
    assert.strictEqual((await store.jobs.get('r')).state, 'dead', 'maxAttempts 1: dead after one failure');
    assert.strictEqual(await store.jobs.requeue('r'), true);
    const requeued = await store.jobs.get('r');
    assert.strictEqual(requeued.state, 'pending');
    assert.strictEqual(requeued.attempts, 1, 'the attempt history is kept');
    assert.strictEqual(requeued.runAt, clock(), 'runs at the clock, the queue\'s deterministic order');
    assert.strictEqual(requeued.leaseUntil, null);
    // two-run: requeueing a pending job changes nothing
    assert.strictEqual(await store.jobs.requeue('r'), false);
    const second = await store.jobs.claim({ kinds: ['k'], owner: 'w' });
    assert.strictEqual(second.attempts, 2);
    assert.strictEqual(second.lease.generation, 2);
    // a live lease is not this call's to take
    await assert.rejects(store.jobs.requeue('r'), (error) => error.code === 'JD2068');
    // an expired one is
    clock.advance(60_000);
    assert.strictEqual(await store.jobs.requeue('r'), true);
    // a cancelled job returns to the queue too; a done one does not
    await store.jobs.cancel('r');
    assert.strictEqual(await store.jobs.requeue('r'), true);
    const third = await store.jobs.claim({ kinds: ['k'], owner: 'w' });
    await store.jobs.complete(third.lease, null);
    await assert.rejects(store.jobs.requeue('r'), (error) => error.code === 'JD2065');
    await assert.rejects(store.jobs.requeue('nope'), (error) => error.code === 'JD2065');
    await store.close();
  });
});

describe('sweep', () => {
  it('removes settled jobs older than the horizon with their checkpoints, bounded, and reports zero the second time', async () => {
    const clock = makeClock();
    const store = await open({ now: clock });
    for (let i = 0; i < 6; i++) await store.jobs.enqueue('k', {}, { id: `s${i}` });
    // settle four with checkpoints, in time order; leave two live
    for (let i = 0; i < 4; i++) {
      const claimed = await store.jobs.claim({ kinds: ['k'], owner: 'w' });
      const checkpoints = store.jobs.checkpointsFor(claimed);
      await checkpoints.save(claimed.id, 'node', { i });
      if (i % 2 === 0) await store.jobs.complete(claimed.lease, { i });
      else await store.jobs.fail(claimed.lease, new Error('x'));
      clock.advance(100);
    }
    const live = await store.jobs.claim({ kinds: ['k'], owner: 'w' });
    await store.jobs.checkpointsFor(live).save(live.id, 'node', { live: true });
    // settled at +0 (s0 done), +100 (s1 failed), +200 (s2 done), +300
    // (s3 failed); the clock is at +400 and the horizon at +250: the two
    // done jobs are older than it, the failed ones are claimable, not
    // settled, and stay whatever their age
    const horizon = clock() - 150;
    await assert.rejects(store.jobs.sweep(/** @type {any} */ ({})), TypeError, 'the horizon is required');
    const swept = await store.jobs.sweep({ settledBefore: horizon });
    assert.deepStrictEqual(swept, { removed: 2 });
    assert.strictEqual(await store.jobs.get('s0'), undefined);
    assert.strictEqual(await store.jobs.get('s2'), undefined);
    assert.notStrictEqual(await store.jobs.get('s1'), undefined);
    assert.notStrictEqual(await store.jobs.get('s3'), undefined);
    assert.strictEqual(await store.jobs.checkpointsFor({ id: 's0' }).load('s0'), null, 'its checkpoints went with it');
    assert.deepStrictEqual(await store.jobs.checkpointsFor(live).load(live.id), { values: { node: { live: true } } });
    assert.deepStrictEqual(await store.jobs.sweep({ settledBefore: horizon }), { removed: 0 }, 'two-run');
    // a bounded sweep takes the oldest settled first: cancel two, sweep one
    await store.jobs.cancel('s5');
    clock.advance(10);
    await store.jobs.cancel('s1');
    clock.advance(1000);
    const bounded = await store.jobs.sweep({ settledBefore: clock(), limit: 1 });
    assert.deepStrictEqual(bounded, { removed: 1 });
    assert.strictEqual(await store.jobs.get('s5'), undefined, 'the older cancellation went first');
    assert.notStrictEqual(await store.jobs.get('s1'), undefined);
    assert.deepStrictEqual(await store.jobs.sweep({ settledBefore: clock() }), { removed: 1 }, 's1 cancelled goes; s4 leased and s3 failed stay');
    assert.deepStrictEqual((await store.jobs.counts()).leased, 1);
    assert.deepStrictEqual((await store.jobs.counts()).failed, 1);
    await store.close();
  });

  it('a transaction view carries no administration member', async () => {
    const store = await open();
    await store.transaction(async (tx) => {
      for (const member of ['page', 'cancel', 'requeue', 'sweep']) assert.strictEqual(tx.jobs[member], undefined, member);
      assert.strictEqual(typeof tx.jobs.enqueue, 'function');
    });
    await store.close();
  });
});
