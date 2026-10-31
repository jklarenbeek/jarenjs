//@ts-check
/**
 * @file How a domain run records the way it ended. `finish` writes the
 * cancelled or failed status and, with it, the host's public summary and
 * the workflow's last checkpoint: the wind-up of the attempt that drained
 * after `requestCancel`, which stops admitting new work (`save` keeps
 * refusing) but not the record of how the run ended. The summary is held
 * to the byte budget `save` holds it to, it cannot state another status,
 * and a fourth argument is no longer dropped without notice.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createDbRunStore } from '@jarenjs/linq/db';
import { fixture } from '../durable/fixtures.js';

/** A run that saved generation 1 (progress 10) and then had its cancellation requested.
 * @param {any} f */
async function requested(f) {
  await f.client.store.jobs.enqueue('domain', {}, { id: 'job-1' });
  const { lease } = await f.client.store.jobs.claim({ kinds: ['domain'], owner: 'worker', leaseMs: 60_000 });
  const store = createDbRunStore(f.client, { runs: 'runs', events: 'events',
    summary: (/** @type {any} */ snapshot) => ({ status: snapshot.status, progress: snapshot.progress }) });
  await store.attach({ id: 'run-1', jobId: 'job-1', workflow: 'wf', schemaVersion: '1' }, lease);
  assert.equal(await store.save('run-1', { runId: 'run-1', generation: 1, status: 'running', progress: 10 }, 0, lease), true);
  await store.requestCancel('run-1', (await store.get('run-1')).revision, { actor: 'operator', reason: 'stop' });
  return { store, lease, before: await store.get('run-1') };
}
const generation2 = { runId: 'run-1', generation: 2, status: 'running', progress: 20 };
/** The record and its event history, to prove a refusal wrote nothing. @param {any} store */
const snapshot = async (store) => ({ record: await store.get('run-1'), events: (await store.page('run-1')).events });

describe('finish records the final observation', () => {
  it('after requestCancel, the summary lands in the record and in its event', async () => {
    const f = await fixture();
    try {
      const { store, lease, before } = await requested(f);
      await assert.rejects(store.save('run-1', generation2, 1, lease), { code: 'JL2009', message: /run cancellation stops admission/ });
      const summary = { status: 'cancelled', stoppedAt: 5_100, progress: 20 };
      const out = await store.finish('run-1', 'cancelled', lease, { summary });
      assert.deepEqual([out.changes, out.writes, out.revisions], [1, 2, 1]);
      const record = await store.get('run-1');
      assert.equal(record.status, 'cancelled');
      assert.deepEqual(record.summary, summary);
      assert.deepEqual(record.checkpoint, before.checkpoint);
      const last = (await store.page('run-1')).events.at(-1);
      assert.deepEqual([last.status, last.summary, last.revision], ['cancelled', summary, before.revision + 1]);
    }
    finally { await f.client.close(); }
  });

  it('a final checkpoint lands under the same lease after requestCancel, and save keeps refusing', async () => {
    const f = await fixture();
    try {
      const { store, lease } = await requested(f);
      await store.finish('run-1', 'cancelled', lease, { summary: { progress: 20 }, checkpoint: generation2 });
      const record = await store.get('run-1');
      assert.deepEqual(record.checkpoint, generation2);
      // the summary says how it ended: its status is finish's, filled in when absent
      assert.deepEqual(record.summary, { progress: 20, status: 'cancelled' });
      assert.equal(record.status, 'cancelled');
      // an event carries the summary, never the checkpoint
      assert.equal(Object.hasOwn((await store.page('run-1')).events.at(-1), 'checkpoint'), false);
      await assert.rejects(store.save('run-1', { ...generation2, generation: 3 }, 2, lease), { code: 'JL2009', message: /run cancellation stops admission/ });
    }
    finally { await f.client.close(); }
  });

  it('without options, or with null, finish answers as it always did', async () => {
    for (const options of [[], [undefined], [null]]) {
      const f = await fixture();
      try {
        const { store, lease, before } = await requested(f);
        const out = await store.finish('run-1', 'cancelled', lease, ...options);
        assert.equal(out.writes, 2);
        const record = await store.get('run-1');
        assert.deepEqual([record.status, record.summary, record.checkpoint], ['cancelled', { status: 'cancelled' }, before.checkpoint]);
        assert.deepEqual((await store.page('run-1')).events.at(-1).summary, { status: 'cancelled' });
      }
      finally { await f.client.close(); }
    }
  });

  it('a run already finished with that state, or done, is left as it is, options included', async () => {
    const f = await fixture();
    try {
      const { store, lease } = await requested(f);
      await store.finish('run-1', 'cancelled', lease, { summary: { progress: 20 } });
      const finished = await snapshot(store);
      const again = await store.finish('run-1', 'cancelled', lease, { summary: { progress: 30 }, checkpoint: generation2 });
      assert.deepEqual([again.changes, again.writes, again.revisions], [0, 0, 0]);
      assert.deepEqual(await snapshot(store), finished);
    }
    finally { await f.client.close(); }
  });
});

describe('finish refuses what it cannot record as given, and writes nothing', () => {
  it('a summary over the byte budget refuses as save refuses one', async () => {
    const f = await fixture();
    try {
      const { store, lease } = await requested(f);
      const before = await snapshot(store);
      await assert.rejects(store.finish('run-1', 'cancelled', lease, { summary: { note: 'x'.repeat(262_144) } }),
        { code: 'JL2009', message: /public run summary exceeds byte budget/ });
      assert.deepEqual(await snapshot(store), before);
    }
    finally { await f.client.close(); }
  });

  it('an unknown option is refused by name, and options that are not an object too', async () => {
    const f = await fixture();
    try {
      const { store, lease } = await requested(f);
      const before = await snapshot(store);
      await assert.rejects(async () => store.finish('run-1', 'cancelled', lease, /** @type {any} */ ({ summry: { progress: 20 } })),
        { name: 'TypeError', message: "finish() does not take 'summry' — did you mean 'summary'?" });
      await assert.rejects(async () => store.finish('run-1', 'cancelled', lease, /** @type {any} */ ('stopped by the operator')),
        { name: 'TypeError', message: 'finish() takes a plain options object' });
      assert.deepEqual(await snapshot(store), before);
    }
    finally { await f.client.close(); }
  });

  it('a summary cannot state another status, and must be a JSON object', async () => {
    const f = await fixture();
    try {
      const { store, lease } = await requested(f);
      const before = await snapshot(store);
      for (const status of ['done', 'failed', 'CANCELLED', null]) {
        await assert.rejects(async () => store.finish('run-1', 'cancelled', lease, { summary: { status, progress: 20 } }),
          { code: 'JL2009', message: /final run summary states another status/ });
      }
      for (const summary of ['stopped', [20], null, 7]) {
        await assert.rejects(async () => store.finish('run-1', 'cancelled', lease, { summary: /** @type {any} */ (summary) }),
          { name: 'TypeError', message: 'finish summary must be a JSON object' });
      }
      assert.deepEqual(await snapshot(store), before);
    }
    finally { await f.client.close(); }
  });

  it('a checkpoint the run cannot take next is refused, and a done one cannot finish it', async () => {
    const f = await fixture();
    try {
      const { store, lease } = await requested(f);
      const before = await snapshot(store);
      for (const checkpoint of [{ ...generation2, runId: 'run-2' }, { ...generation2, generation: 3 }, { ...generation2, generation: 1 },
        { ...generation2, status: 'paused' }, null, 'generation 2']) {
        await assert.rejects(store.finish('run-1', 'failed', lease, { checkpoint }),
          { code: 'JL2009', message: /checkpoint run, generation or status mismatch/ });
      }
      await assert.rejects(store.finish('run-1', 'failed', lease, { checkpoint: { ...generation2, status: 'done' } }),
        { code: 'JL2009', message: /a done checkpoint cannot finish a run as cancelled or failed/ });
      assert.deepEqual(await snapshot(store), before);
    }
    finally { await f.client.close(); }
  });
});

describe('save takes the checkpoint check finish takes', () => {
  it('a null snapshot refuses with the coded mismatch, as every other value that is no checkpoint does', async () => {
    const f = await fixture();
    try {
      await f.client.store.jobs.enqueue('domain', {}, { id: 'job-1' });
      const { lease } = await f.client.store.jobs.claim({ kinds: ['domain'], owner: 'worker', leaseMs: 60_000 });
      const store = createDbRunStore(f.client, { runs: 'runs', events: 'events' });
      await store.attach({ id: 'run-1', jobId: 'job-1', workflow: 'wf', schemaVersion: '1' }, lease);
      for (const value of [null, 'text', [], 7]) {
        await assert.rejects(store.save('run-1', value, 0, lease), { code: 'JL2009', message: /checkpoint run, generation or status mismatch/ });
      }
      assert.equal((await store.get('run-1')).checkpoint, null);
    }
    finally { await f.client.close(); }
  });
});
