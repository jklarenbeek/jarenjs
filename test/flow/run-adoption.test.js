//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { createDomainRun } from '@jarenjs/flow';
import { createDbRunStore } from '@jarenjs/linq/db';
import { createRunPageHandler } from '@jarenjs/contract/app';
import { fixture, identity } from '../durable/fixtures.js';
import { tempDbPath } from '../db/helpers.js';
const doc = { $workflow: '0.2', revision: 'domain/1', initial: 'wait', states: {
  wait: { on: [{ event: 'go', to: 'work' }] }, work: { work: { task: 'step', version: '1' }, then: 'done' }, done: { final: true },
} };
const claim = (f) => f.client.store.jobs.claim({ kinds: ['domain'], owner: 'worker', leaseMs: 1000 });
const options = { runs: 'runs', events: 'events', maxPage: 2, statuses: { waiting: 'paused', done: 'completed' } };

it('existing IDs/status mappings survive restart, takeover and bounded concurrent readers', async () => {
  const { dbPath, cleanup } = tempDbPath();
  let f = await fixture({ path: dbPath });
  try {
    await f.client.store.jobs.enqueue('domain', {}, { id: 'job-1' });
    let job = await claim(f);
    let store = createDbRunStore(f.client, options);
    // This is an application-owned row existing before the workflow attaches.
    await f.client.collections.runs.insert({ id: 'existing-run', jobId: job.id, workflow: canonicalizeJson(doc), schemaVersion: '1',
      revision: 0, status: 'paused', summary: null, checkpoint: null, cancelRequested: false });
    let calls = 0;
    const tasks = { step: { version: '1', run: () => { calls++; return 7; } } };
    let runner = createDomainRun(doc, { store, schemaVersion: '1', tasks });
    assert.equal((await runner.run('existing-run', {}, { lease: job.lease })).status, 'waiting');
    assert.equal((await store.get('existing-run')).status, 'paused');
    const saved = await store.get('existing-run');
    assert.equal(await store.save('existing-run', saved.checkpoint, -1, job.lease), false);
    await f.client.close();
    f = await fixture({ path: dbPath }); f.advance(1001);
    store = createDbRunStore(f.client, options);
    const stale = job;
    job = await claim(f);
    await assert.rejects(store.load('existing-run', saved, stale.lease), { code: 'JD2066' });
    const incompatible = createDomainRun(doc, { store, schemaVersion: '2', tasks });
    await assert.rejects(incompatible.run('existing-run', {}, { lease: job.lease }), /incompatible/);
    runner = createDomainRun(doc, { store, schemaVersion: '1', tasks });
    assert.equal((await runner.run('existing-run', {}, { lease: job.lease, event: { type: 'go' } })).result, 7);
    assert.equal(calls, 1);
    const pages = await Promise.all([store.page('existing-run', { limit: 2 }), store.page('existing-run', { limit: 2 })]);
    assert.deepEqual(pages[0], pages[1]);
    let cursor = pages[0].cursor, count = pages[0].events.length;
    while (cursor < pages[0].revision) { const next = await store.page('existing-run', { after: cursor, limit: 2 }); count += next.events.length; cursor = next.cursor; }
    assert.equal(count, (await store.get('existing-run')).revision);
    assert.equal((await store.get('existing-run')).status, 'completed');
    let reads = 0;
    const read = createRunPageHandler({ page: (...args) => { reads++; return store.page(...args); }, authorize: () => false, maxPage: 2 });
    await assert.rejects(read({ id: 'existing-run', after: 0, limit: 2 }, {}), /refused/);
    assert.equal(reads, 0);
    const allowed = createRunPageHandler({ page: store.page, authorize: () => true, maxPage: 2 });
    assert.equal((await allowed({ id: 'existing-run', after: cursor, limit: 2 }, {})).events.length, 0);
    await f.client.collections.events.delete(canonicalizeJson(['existing-run', 1]));
    assert.equal((await store.page('existing-run', { limit: 2 })).state, 'reset-required');
  }
  finally { await f.client.close(); cleanup(); }
});

it('explicit cancellation drains tasks and persists final status before resource release; reset consults durable history', async () => {
  const f = await fixture();
  try {
    await f.client.store.jobs.enqueue('domain', {}, { id: 'job' });
    const job = await claim(f);
    const store = createDbRunStore(f.client, { ...options, canReset: async (tx) => (await tx.collections.receipts.toArray()).length === 0 });
    const started = Promise.withResolvers(), drained = Promise.withResolvers();
    const order = [];
    const working = { ...doc, initial: 'work' };
    const runner = createDomainRun(working, { store, schemaVersion: '1', tasks: { step: { version: '1', run: async (_value, signal) => {
      started.resolve(undefined);
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      await drained.promise; order.push('drained'); return 1;
    } } } });
    const running = runner.run('run', {}, { lease: job.lease, release: async () => { assert.equal((await store.get('run')).status, 'cancelled'); order.push('released'); } });
    const rejected = assert.rejects(running);
    await started.promise;
    const before = await store.get('run');
    const cancelling = runner.cancel('run', before.revision, { actor: 'operator', reason: 'stop' });
    while (!(await store.get('run')).cancelRequested) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, []);
    drained.resolve(undefined);
    await rejected;
    assert.equal((await cancelling).status, 'cancelled');
    assert.deepEqual(order, ['drained', 'released']);
    const final = await store.get('run');
    assert.equal((await store.requestCancel('run', final.revision, { actor: 'operator', reason: 'stop' })).writes, 0);
    await f.receipts.execute(identity(), async () => ({ outcome: 1, references: ['audit'] }));
    await assert.rejects(store.reset('run', final.revision, { actor: 'operator', reason: 'retry' }, job.lease), /prevents reset/);
    assert.equal((await f.receipts.lookup(identity())).state, 'replay');
    const defaultStore = createDbRunStore(f.client, options);
    assert.throws(() => defaultStore.reset('run', final.revision, { actor: 'operator', reason: 'retry' }, job.lease), /safety policy/);
  }
  finally { await f.client.close(); }
});

it('run pages bound the full response and preserve checkpoint/audit state on summary or cursor refusal', async () => {
  const f = await fixture();
  try {
    await f.client.store.jobs.enqueue('domain', {}, { id: 'job' });
    const job = await claim(f);
    const store = createDbRunStore(f.client, { runs: 'runs', events: 'events', maxBytes: 450, maxPage: 5 });
    const recordIdentity = { id: 'run', jobId: job.id, workflow: canonicalizeJson(doc), schemaVersion: '1' };
    await store.attach(recordIdentity, job.lease);
    assert.equal((await store.attach(recordIdentity, job.lease)).writes, 0);
    assert.throws(() => store.page('run', { limit: 6 }), /bounded limit/);
    await assert.rejects(store.page('run', { after: 99 }), /future run cursor/);
    await assert.rejects(store.load('run', { ...recordIdentity, schemaVersion: 'old' }, job.lease), /incompatible/);
    const snapshot = { runId: 'run', generation: 1, status: 'waiting' };
    const oversized = createDbRunStore(f.client, { runs: 'runs', events: 'events', maxBytes: 450, summary: () => 'x'.repeat(1000) });
    await assert.rejects(oversized.save('run', snapshot, 0, job.lease), /byte budget/);
    assert.equal((await store.get('run')).checkpoint, null);
    assert.equal(await store.save('run', snapshot, 0, job.lease), true);
    const page = await store.page('run');
    assert.ok(new TextEncoder().encode(JSON.stringify(page)).byteLength <= 450);
    const smaller = createDbRunStore(f.client, { runs: 'runs', events: 'events', maxBytes: 32 });
    await assert.rejects(smaller.page('run', { after: 2 }), /byte budget/);
    await f.client.collections.events.delete(canonicalizeJson(['run', 1]));
    await assert.rejects(smaller.page('run'), /byte budget/);
    await assert.rejects(store.requestCancel('run', 0, { actor: 'operator', reason: 'stop' }), /stale/);
    await assert.rejects(store.save('run', { ...snapshot, runId: 'foreign', generation: 2 }, 1, job.lease), /mismatch/);
    const badEvent = { id: canonicalizeJson(['run', 1]), runId: 'foreign', revision: 1, status: 'running', summary: null, cancelRequested: false };
    await f.client.collections.events.put(badEvent, badEvent.id);
    await assert.rejects(store.page('run'), /event identity/);
  }
  finally { await f.client.close(); }
});
