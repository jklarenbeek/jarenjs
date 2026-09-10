//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createExternalEffects } from '@jarenjs/flow';
import { createDbEffectStore } from '@jarenjs/linq/db';
import { createProviderExecutor } from '@jarenjs/contract/provider';
import { fixture } from '../durable/fixtures.js';

const plan = { id: 'op', jobId: 'job', kind: 'external', actor: 'reviewer', reason: 'approved', hashVersion: 'canonical/1',
  legs: ['a', 'b'].map((id) => ({ id, maxAttempts: 1, request: { url: `https://effect.example/${id}`, method: 'POST', body: '{}', safety: 'single-send' } })) };
const classify = (response) => ({ state: 'confirmed', evidence: JSON.parse(response.text) });

for (const mode of ['disconnect', 'abort', 'malformed', 'timeout', 'lease-expiry', 'settle-crash']) it(`${mode} never automatically resends unresolved external writes`, async () => {
  const f = await fixture();
  let calls = 0, time = 0, expire;
  const timing = mode === 'timeout' ? { now: () => time, sleep: (ms, signal) => new Promise((resolve, reject) => {
    expire = () => { time += ms; resolve(); };
    signal.addEventListener('abort', () => reject(new Error('timer stopped')), { once: true });
  }) } : {};
  const abort = new AbortController();
  const store = createDbEffectStore(f.client, { operations: 'effects' });
  const executor = createProviderExecutor({ attempts: 4, attemptMs: 1000, ...timing, transport: async (_request, context) => {
    calls++;
    // A root transaction succeeds during I/O: no transaction from the effect is held.
    await f.client.transaction((tx) => tx.collections.audit.put({ id: `transport-${calls}` }, `transport-${calls}`));
    if (calls === 1) return new Response('{"providerId":"first"}');
    if (mode === 'disconnect') throw new Error('secret credential');
    if (mode === 'abort') abort.abort();
    if (mode === 'lease-expiry') f.advance(1001);
    if (mode === 'timeout') await new Promise((resolve) => { context.signal.addEventListener('abort', resolve, { once: true }); expire(); });
    return new Response(mode === 'malformed' ? 'broken' : '{"providerId":"second"}');
  } });
  try {
    await store.prepare(plan);
    const job = await f.client.store.jobs.claim({ kinds: ['external'], owner: 'first', leaseMs: 1000 });
    let crash = mode === 'settle-crash';
    const facade = { ...store, settle: (...args) => {
      if (crash && args[1] === 'b') { crash = false; throw new Error('commit crash'); }
      return store.settle(...args);
    } };
    const run = createExternalEffects({ store: facade, executor, authorize: () => true, classify });
    if (['lease-expiry', 'settle-crash', 'abort'].includes(mode)) await assert.rejects(run.run('op', { lease: job.lease, signal: abort.signal }));
    else await run.run('op', { lease: job.lease, signal: abort.signal });
    assert.equal(calls, 2);
    f.advance(1001);
    const next = await f.client.store.jobs.claim({ kinds: ['external'], owner: 'next', leaseMs: 1000 });
    const outcome = await run.run('op', { lease: next.lease });
    assert.equal(outcome.state, 'unresolved');
    assert.equal(calls, 2);
    assert.deepEqual((await store.get('op')).legs.map((leg) => leg.state), ['confirmed', 'unresolved']);
    assert.ok(!JSON.stringify(await store.get('op')).includes('secret'));
  }
  finally { await executor.close(); await f.client.close(); }
});

it('provider-idempotent reconciliation reuses the reviewed key and finite durable budget', async () => {
  const f = await fixture();
  const seen = [];
  const store = createDbEffectStore(f.client, { operations: 'effects' });
  const executor = createProviderExecutor({ attempts: 5, transport: async (request) => {
    seen.push(request.idempotencyKey);
    if (seen.length === 1) throw new Error('unknown');
    return new Response('{"providerId":"one"}');
  } });
  try {
    await store.prepare({ ...plan, legs: [{ id: 'a', maxAttempts: 2, request: { ...plan.legs[0].request, safety: 'provider-idempotent', idempotencyKey: 'stable-key' } }] });
    const job = await f.client.store.jobs.claim({ kinds: ['external'], owner: 'worker', leaseMs: 1000 });
    const run = createExternalEffects({ store, executor, authorize: () => true, classify });
    assert.equal((await run.run('op', { lease: job.lease })).state, 'unresolved');
    assert.deepEqual(seen, ['stable-key'], 'no invisible executor retries');
    const record = await store.get('op');
    await store.reconcile('op', 'a', record.revision, job.lease, { id: 'retry-1', actor: 'policy', reason: 'provider guarantees idempotency', action: 'retry', evidence: { providerKey: 'stable-key' } });
    assert.equal((await run.run('op', { lease: job.lease })).state, 'complete');
    assert.deepEqual(seen, ['stable-key', 'stable-key']);
    assert.equal((await store.get('op')).legs[0].attempts, 2);
    assert.equal((await run.run('op', { lease: job.lease })).state, 'complete');
    assert.equal(seen.length, 2);
  }
  finally { await executor.close(); await f.client.close(); }
});

it('current authority and the worker admission hook stop execution without a send', async () => {
  const f = await fixture();
  let calls = 0;
  const executor = createProviderExecutor({ transport: async () => { calls++; return new Response('{}'); } });
  try {
    const store = createDbEffectStore(f.client, { operations: 'effects' });
    await store.prepare(plan);
    const finished = Promise.withResolvers();
    const worker = f.client.store.jobs.createWorker({ handlers: { external: () => { calls++; } }, effectSafety: async (job, context) => {
      assert.equal(context.lease().jobId, job.id);
      assert.equal(await f.client.store.jobs.assertLease(context.lease()), true);
      return false;
    },
      onOutcome: finished.resolve, pollInterval: 1 });
    worker.start();
    await finished.promise;
    await worker.stop();
    assert.equal(calls, 0);
    assert.equal((await f.client.store.jobs.get('job')).state, 'cancelled');
    assert.throws(() => f.client.store.jobs.createWorker({ handlers: { external: () => {} }, effectSafety: 1 }), /effectSafety/);
    const effects = createExternalEffects({ store, executor, authorize: () => false, classify });
    assert.equal((await effects.run('op', { lease: null })).reason, 'unauthorized');
  }
  finally { await executor.close(); await f.client.close(); }
});

it('an actual worker pauses uncertain effects and a requeued lease can reconcile and complete without resending', async () => {
  const f = await fixture();
  let sends = 0;
  const store = createDbEffectStore(f.client, { operations: 'effects' });
  const executor = createProviderExecutor({ transport: async () => {
    sends++;
    if (sends === 2) throw new Error('lost response');
    return new Response('{"providerId":"one"}');
  } });
  let worker;
  try {
    await store.prepare(plan);
    const effects = createExternalEffects({ store, executor, authorize: () => true, classify });
    const stopped = Promise.withResolvers();
    worker = f.client.store.jobs.createWorker({ handlers: { external: effects.handler }, pollInterval: 1, onOutcome: stopped.resolve });
    worker.start(); await stopped.promise; await worker.stop();
    assert.equal((await f.client.store.jobs.get('job')).state, 'cancelled');
    assert.equal(sends, 2);
    await f.client.store.jobs.requeue('job');
    const lease = (await f.client.store.jobs.claim({ kinds: ['external'], owner: 'reconciler', leaseMs: 1000 })).lease;
    const record = await store.get('op');
    await store.reconcile('op', 'b', record.revision, lease, { id: 'readback', actor: 'operator', reason: 'correlated receipt', action: 'confirm', evidence: { receipt: 'two' } });
    const done = await effects.run('op', { lease: () => lease });
    assert.equal(done.state, 'complete');
    await f.client.store.jobs.complete(lease, done);
    assert.equal(sends, 2);
    assert.equal((await f.client.store.jobs.get('job')).state, 'done');
    await assert.rejects(effects.handler({ operationId: 'op' }, {}), /pause capability/);
  }
  finally { await worker?.stop(); await executor.close(); await f.client.close(); }
});
