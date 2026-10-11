//@ts-check
/**
 * @file The numbers and names a job call reads are checked before they are
 * stored or armed: a lease that is not a positive finite number of
 * milliseconds is refused by `claim`, `renew` and the worker (a `NaN` lease
 * stored a NULL expiry, a job leased for good that no claim could recover,
 * renew or settle), a worker's intervals are finite and inside the timer
 * range (a `NaN` or an overlarge poll interval polled every millisecond), and
 * a worker option that is none of the worker's is `JD0013` naming the nearest
 * one, as a misspelt `enqueue` option is.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = { $model: '0.1', collections: { x: { key: '/id', schema: { type: 'object' } } } };
const NOW = 1_000_000;

/** @param {(store: any) => Promise<void>} body */
async function withQueue(body) {
  const store = await openStore(MODEL, { driver: nodeDriver(), jobs: { now: () => NOW, random: () => 0.5 } });
  try { await body(store); }
  finally { await store.close(); }
}

describe('jobs: lease durations', () => {
  const bad = [NaN, Infinity, -Infinity, 0, -5, '30', true, 1n, {}];

  it('claim refuses a leaseMs that is not a positive finite number, and leases nothing', async () => {
    await withQueue(async (store) => {
      await store.jobs.enqueue('k', null, { id: 'a' });
      for (const leaseMs of bad) {
        await assert.rejects(async () => store.jobs.claim({ kinds: ['k'], owner: 'w', leaseMs }),
          { name: 'TypeError', message: 'claim: "leaseMs" is a positive finite number of milliseconds' }, String(leaseMs));
      }
      assert.equal((await store.jobs.get('a')).state, 'pending');
      const claimed = await store.jobs.claim({ kinds: ['k'], owner: 'w', leaseMs: 1500.5 });
      assert.equal(claimed.lease.expiresAt, NOW + 1500.5);
    });
  });

  it('renew refuses one too, before it retires the lease it was given', async () => {
    await withQueue(async (store) => {
      await store.jobs.enqueue('k', null, { id: 'a' });
      const claimed = await store.jobs.claim({ kinds: ['k'], owner: 'w', leaseMs: 1000 });
      for (const leaseMs of bad) {
        await assert.rejects(async () => store.jobs.renew(claimed.lease, { leaseMs }),
          { name: 'TypeError', message: 'renew: "leaseMs" is a positive finite number of milliseconds' }, String(leaseMs));
      }
      const renewed = await store.jobs.renew(claimed.lease, { leaseMs: 2000 });
      assert.equal(renewed.expiresAt, NOW + 2000);
      await store.jobs.complete(renewed, 'done');
      assert.equal((await store.jobs.get('a')).state, 'done');
    });
  });

  it('claim without options is the same TypeError as claim without kinds', async () => {
    await withQueue(async (store) => {
      await assert.rejects(async () => store.jobs.claim(), {
        name: 'TypeError', message: 'claim: needs a non-empty "kinds" array and an "owner"' });
    });
  });

  it('claim and renew name the option they read when one is misspelt', async () => {
    await withQueue(async (store) => {
      await store.jobs.enqueue('k', null, { id: 'a' });
      await assert.rejects(async () => store.jobs.claim({ kinds: ['k'], owner: 'w', leaseMS: 5 }),
        { code: 'JD0013', message: /jobs\.claim option 'leaseMS' is not one it reads.*leaseMs/s });
      assert.equal((await store.jobs.get('a')).state, 'pending');
      const claimed = await store.jobs.claim({ kinds: ['k'], owner: 'w' });
      await assert.rejects(async () => store.jobs.renew(claimed.lease, { leaseMs: 5, extra: 1 }),
        { code: 'JD0013', message: /jobs\.renew option 'extra' is not one it reads/ });
    });
  });
});

describe('jobs: worker options', () => {
  const handlers = { k: async () => null };

  it('an option that is none of the worker\'s is JD0013 naming the nearest', async () => {
    await withQueue(async (store) => {
      assert.throws(() => store.jobs.createWorker({ handlers, concurency: 3 }),
        { code: 'JD0013', message: /jobs\.createWorker option 'concurency' is not one it reads.*concurrency/s });
    });
  });

  it('refuses each interval that is not a finite number in range, and each owner, flag and callback of the wrong type', async () => {
    await withQueue(async (store) => {
      const refusals = [
        [{ pollInterval: NaN }, '"pollInterval" is a non-negative finite number of milliseconds up to 2147483647'],
        [{ pollInterval: -1 }, '"pollInterval" is a non-negative finite number of milliseconds up to 2147483647'],
        [{ pollInterval: 'x' }, '"pollInterval" is a non-negative finite number of milliseconds up to 2147483647'],
        [{ pollInterval: 2 ** 31 }, '"pollInterval" is a non-negative finite number of milliseconds up to 2147483647'],
        [{ leaseMs: NaN }, '"leaseMs" is a positive finite number of milliseconds'],
        [{ leaseMs: 0 }, '"leaseMs" is a positive finite number of milliseconds'],
        [{ leaseMs: '30' }, '"leaseMs" is a positive finite number of milliseconds'],
        [{ backoffBase: NaN }, '"backoffBase" is a non-negative finite number of milliseconds'],
        [{ backoffCap: -1 }, '"backoffCap" is a non-negative finite number of milliseconds'],
        [{ backoffCap: Infinity }, '"backoffCap" is a non-negative finite number of milliseconds'],
        [{ stopGraceMs: NaN }, '"stopGraceMs" is a non-negative finite number of milliseconds up to 2147483647'],
        [{ owner: 5 }, '"owner" is a non-empty string'],
        [{ owner: '' }, '"owner" is a non-empty string'],
        [{ renew: 'no' }, '"renew" is true or false'],
        [{ onOutcome: 'log' }, '"onOutcome" is a function'],
      ];
      for (const [options, message] of refusals) {
        assert.throws(() => store.jobs.createWorker({ handlers, ...options }),
          { name: 'TypeError', message: `createWorker: ${message}` }, JSON.stringify(options));
      }
      const worker = store.jobs.createWorker({ handlers, pollInterval: 0, backoffBase: 0, backoffCap: 0, stopGraceMs: 0,
        leaseMs: 0.5, owner: 'w', renew: false, onOutcome: () => {} });
      await worker.stop();
    });
  });

  it('a lease too long for a timer renews at the longest delay a timer keeps, not every millisecond', async () => {
    await withQueue(async (store) => {
      const worker = store.jobs.createWorker({ pollInterval: 5, leaseMs: 1e10,
        handlers: { k: async () => { await new Promise((resolve) => setTimeout(resolve, 150)); } } });
      worker.start();
      await store.jobs.enqueue('k', null, { id: 'long' });
      for (let i = 0; i < 200 && (await store.jobs.get('long')).state !== 'done'; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal((await store.jobs.get('long')).state, 'done');
      assert.equal(worker.stats().renewals, 0);
      await worker.stop();
    });
  });

  it('stop refuses a graceMs that is not a finite number in range, and the worker keeps running', async () => {
    await withQueue(async (store) => {
      const worker = store.jobs.createWorker({ handlers, pollInterval: 5 });
      worker.start();
      await assert.rejects(async () => worker.stop({ graceMs: NaN }),
        { name: 'TypeError', message: 'stop: "graceMs" is a non-negative finite number of milliseconds up to 2147483647' });
      await store.jobs.enqueue('k', null, { id: 'late' });
      for (let i = 0; i < 200 && (await store.jobs.get('late')).state !== 'done'; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal((await store.jobs.get('late')).state, 'done', 'still serving after the refused stop');
      assert.deepEqual(await worker.stop({ graceMs: 1000 }), { drained: true, inFlight: 0 });
    });
  });
});

describe('jobs: administration options', () => {
  it('a misspelt option is JD0013 naming the nearest, and the call changes nothing', async () => {
    await withQueue(async (store) => {
      await store.jobs.enqueue('k', null, { id: 'a' });
      const refused = [
        ['page', () => store.jobs.page({ lmit: 1 }), /jobs\.page option 'lmit' is not one it reads.*limit/s],
        ['cancel', () => store.jobs.cancel('a', { leas: {} }), /jobs\.cancel option 'leas' is not one it reads.*lease/s],
        ['requeue', () => store.jobs.requeue('a', { sginal: 1 }), /jobs\.requeue option 'sginal' is not one it reads.*signal/s],
        ['reset', () => store.jobs.reset('a', { expectedGeneration: 0, deadlin: 1 }), /jobs\.reset option 'deadlin' is not one it reads.*deadline/s],
        ['sweep', () => store.jobs.sweep({ settledBefore: NOW, limt: 1 }), /jobs\.sweep option 'limt' is not one it reads.*limit/s],
      ];
      for (const [name, call, message] of refused) {
        await assert.rejects(async () => call(), { code: 'JD0013', message }, name);
      }
      assert.equal((await store.jobs.get('a')).state, 'pending');
      const seen = [];
      for await (const job of store.jobs.page({ state: 'pending', limit: 5 })) seen.push(job.id);
      assert.deepEqual(seen, ['a']);
      assert.equal(await store.jobs.cancel('a'), true);
      assert.deepEqual(await store.jobs.sweep({ settledBefore: NOW + 1 }), { removed: 1 });
    });
  });
});

describe('store.close and null options', () => {
  it('close checks its options before it touches anything: a bad one leaves the store open, its worker polling and its live query live', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), jobs: {}, capture: { mode: 'journal', log: true }, live: {} });
    const worker = store.jobs.createWorker({ handlers: { k: async () => null }, pollInterval: 5 });
    worker.start();
    const handle = await store.collection('x').live({ $for: { it: '$[*]' }, $return: '$it.id' }, {});
    let events = 0;
    handle.subscribe(() => { events++; });
    for (const [options, expected] of [[{ graceMs: Infinity }, { name: 'TypeError' }], [{ graceMs: -1 }, { name: 'TypeError' }],
      [{ graceMs: 'x' }, { name: 'TypeError' }], [{ grace: 5 }, { code: 'JD0013' }], [5, { code: 'JD0013' }]]) {
      await assert.rejects(async () => store.close(options), expected, JSON.stringify(options));
      const polls = worker.stats().polls;
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.ok(worker.stats().polls > polls, 'the worker still polls');
      const before = events;
      await store.collection('x').put({ id: `n${events}` });
      for (let i = 0; i < 100 && events === before; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(events > before, 'the live query still hears the store');
    }
    await store.close({ graceMs: null });
  });

  it('null is as good as no options on every call that reads them, and an object that is not plain is still refused', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), jobs: {}, capture: { mode: 'journal', log: true }, replication: { replica: 'a' } });
    try {
      await store.collection('x').put({ id: 'a' });
      await store.jobs.enqueue('k', null, { id: 'j' });
      const worker = store.jobs.createWorker({ handlers: { k: async () => null }, pollInterval: null, leaseMs: null,
        owner: null, renew: null, onOutcome: null, backoffBase: null, backoffCap: null, stopGraceMs: null });
      for (const call of [() => store.jobs.page(null), () => store.jobs.cancel('j', null), () => store.jobs.requeue('j', null),
        () => store.jobs.claim({ kinds: ['k'], owner: 'w', leaseMs: null }),
        () => store.checkpoint(null), () => store.integrityCheck(null), () => store.foreignKeyCheck(null), () => store.optimize(null),
        () => store.replication.page(null), () => store.replication.snapshot(null), () => store.replication.conflicts(null),
        () => store.introspect(null), () => worker.stop(null), () => worker.stop({ graceMs: null })]) {
        const out = await call();
        if (out && typeof out.next === 'function') await out.return();
      }
      class Options { constructor() { this.limit = 1; } }
      await assert.rejects(async () => store.jobs.page(new Options()), { code: 'JD0013', message: /options must be a plain object/ });
    }
    finally { await store.close({ graceMs: null }); }
  });
});

