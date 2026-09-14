//@ts-check
/** Public queue and committed-feed contracts on the Node SQLite hosts. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';

const model = { $model: '0.1', collections: { notes: { key: '/id', schema: {
  type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' } },
} } } };
const hosts = [nodeDriver, nodeWorkerDriver, nodeWorkerPoolDriver, nodeProcessDriver];

for (const factory of hosts) describe(`public jobs and feed: ${factory.name}`, { skip: !!process.versions.bun }, () => {
  it('settles renewed leases and checkpoints, rolls back an outbox, and recovers after reopen', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'jaren-jobs-host-'));
    const driver = factory();
    const options = { driver, path: join(folder, 'jobs.sqlite'), jobs: { now: () => at } };
    let at = 1000;
    let store;
    try {
      store = await openStore(model, options);
      assert.equal(store.capabilities.jobs, true);
      await store.jobs.enqueue('probe', { value: 1 }, { id: 'job' });
      assert.deepEqual((await store.jobs.get('job')).payload, { value: 1 });
      assert.equal((await store.jobs.counts()).pending, 1);
      const job = await store.jobs.claim({ kinds: ['probe'], owner: 'first', leaseMs: 100 });
      const renewed = await store.jobs.renew(job.lease, { leaseMs: 200 });
      const checkpoints = store.jobs.checkpointsFor({ ...job, lease: renewed });
      await checkpoints.save('job', 'loaded', { rows: 1 });
      assert.deepEqual(await checkpoints.load('job'), { values: { loaded: { rows: 1 } } });
      await assert.rejects(store.transaction(async tx => {
        await tx.collection('notes').insert({ id: 'rolled' });
        await tx.jobs.enqueue('probe', {}, { id: 'rolled' });
        throw new Error('rollback outbox');
      }), /rollback outbox/);
      assert.equal(await store.jobs.get('rolled'), undefined);
      assert.equal(await store.collection('notes').get('rolled'), undefined);
      await store.close();
      at = 2000;
      store = await openStore(model, options);
      const recovered = await store.jobs.claim({ kinds: ['probe'], owner: 'second', leaseMs: 100 });
      assert.equal(recovered.attempts, 2);
      const resumed = store.jobs.checkpointsFor(recovered);
      assert.deepEqual(await resumed.load('job'), { values: { loaded: { rows: 1 } } });
      await resumed.complete('job', { done: true });
      assert.equal((await store.jobs.get('job')).state, 'done');
      assert.deepEqual((await store.jobs.get('job')).result, { done: true });
      assert.equal(await resumed.load('job'), null);
      assert.equal(await store.jobs.complete(recovered.lease, { done: true }), true);
      assert.equal((await store.jobs.counts()).done, 1);
    } finally { await store?.close(); await rm(folder, { recursive: true, force: true }); }
  });

  if (factory !== nodeDriver) it('journals bounded committed pages, excludes rollback and signals retention resets', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'jaren-feed-host-'));
    const driver = factory();
    const path = join(folder, 'feed.sqlite');
    let store;
    try {
      store = await openStore(model, { driver, path, capture: { mode: 'auto', log: { retention: 2 } } });
      assert.equal(store.capabilities.capture, 'journal');
      assert.equal(store.capabilities.sessions, false);
      assert.equal(store.capabilities.live, false);
      await store.collection('notes').insert({ id: 'a', body: 'one' });
      await assert.rejects(store.transaction(async tx => {
        await tx.collection('notes').insert({ id: 'rolled' });
        throw new Error('rollback feed');
      }), /rollback feed/);
      const first = await store.changes.page({ after: 0, limit: 1, maxBytes: 1000 });
      assert.deepEqual(first.items.map(item => item.seq), [1]);
      await store.collection('notes').put({ id: 'a', body: 'two' });
      await store.collection('notes').put({ id: 'a', body: 'three' });
      assert.equal((await store.changes.page({ after: 0, limit: 1 })).resetRequired, true);
      await store.close();
      store = await openStore(model, { driver, path, capture: { mode: 'journal', log: true } });
      assert.deepEqual((await store.changes.page({ after: 1, limit: 2 })).items.map(item => item.seq), [2, 3]);
      await store.close();
      await assert.rejects(openStore(model, { driver, path, capture: { mode: 'session', log: true } }),
        error => error instanceof TypeError && /journal.*auto/.test(error.message));
    } finally { await store?.close(); await rm(folder, { recursive: true, force: true }); }
  });
});
