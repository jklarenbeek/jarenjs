//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createDbEffectStore } from '@jarenjs/linq/db';
import { fixture } from '../durable/fixtures.js';

export const plan = { id: 'operation-1', jobId: 'effect-job-1', kind: 'external', actor: 'reviewer', reason: 'approved selection', hashVersion: 'canonical/1',
  selection: ['item-1'], payload: { amount: 3 }, legs: ['first', 'second'].map((id) => ({ id, maxAttempts: 1,
    request: { url: `https://provider.example/${id}`, method: 'POST', body: '{"amount":3}', safety: 'single-send' } })) };
const claim = (f) => f.client.store.jobs.claim({ kinds: ['external'], owner: 'worker', leaseMs: 100 });

it('preparation/outbox is atomic, frozen, repeatable and requires separate compensation authority', async () => {
  const f = await fixture();
  try {
    const effects = createDbEffectStore(f.client, { operations: 'effects' });
    await assert.rejects(effects.prepare(plan, async (tx) => { await tx.collections.items.put({ id: 'prepared' }, 'prepared'); throw new Error('crash'); }));
    assert.deepEqual(await f.client.collections.effects.toArray(), []);
    assert.equal(await f.client.store.jobs.get(plan.jobId), undefined);
    assert.deepEqual(await f.client.collections.items.toArray(), []);
    const first = await effects.prepare(plan);
    const second = await effects.prepare(plan);
    assert.deepEqual([second.changes, second.writes, second.revisions], [0, 0, 0]);
    assert.deepEqual(second.record, first.record);
    await assert.rejects(effects.prepare({ ...plan, payload: { amount: 4 } }), { code: 'JL2009' });
    assert.throws(() => effects.prepare({ ...plan, compensationOf: plan.id }), /compensation/);
    const compensation = { ...plan, id: 'compensation-1', jobId: 'compensation-job', compensationOf: plan.id, compensationAuthorized: true, actor: 'approver', reason: 'reverse reviewed leg' };
    assert.equal((await effects.prepare(compensation)).record.plan.compensationOf, plan.id);
  }
  finally { await f.client.close(); }
});

it('crashes before send, after intent and after remote success preserve uncertainty and partial legs', async () => {
  const f = await fixture();
  try {
    const effects = createDbEffectStore(f.client, { operations: 'effects' });
    let { record } = await effects.prepare(plan);
    const first = await claim(f);
    assert.equal((await effects.recover(record.id, record.revision, first.lease)).writes, 0, 'before send remains prepared');
    record = (await effects.begin(record.id, 'first', record.revision, first.lease)).record;
    record = (await effects.settle(record.id, 'first', record.revision, first.lease, { state: 'confirmed', evidence: { providerId: 'receipt-1' } })).record;
    record = (await effects.begin(record.id, 'second', record.revision, first.lease)).record;
    // The remote may already have committed; no local confirmation survived.
    f.advance(101);
    const next = await claim(f);
    await assert.rejects(effects.settle(record.id, 'second', record.revision, first.lease, { state: 'confirmed', evidence: {} }), { code: 'JD2066' });
    await assert.rejects(effects.begin(record.id, 'second', record.revision, first.lease), { code: 'JD2066' });
    record = (await effects.recover(record.id, record.revision, next.lease)).record;
    assert.deepEqual(record.legs.map((leg) => leg.state), ['confirmed', 'unresolved']);
    assert.equal((await effects.recover(record.id, record.revision, next.lease)).writes, 0);
    const absent = { id: 'probe', actor: 'operator', reason: 'read-back absent', action: 'retry', evidence: { absent: true } };
    await assert.rejects(effects.reconcile(record.id, 'second', record.revision, next.lease, absent), /absence/);
    const proof = { ...absent, action: 'confirm', evidence: { correlation: 'provider-receipt-2' } };
    const revision = record.revision;
    record = (await effects.reconcile(record.id, 'second', revision, next.lease, proof)).record;
    assert.equal((await effects.reconcile(record.id, 'second', revision, next.lease, proof)).writes, 0);
    await assert.rejects(effects.reconcile(record.id, 'second', record.revision, next.lease, { ...proof, reason: 'changed' }), /collision/);
    assert.deepEqual(record.legs.map((leg) => leg.state), ['confirmed', 'confirmed']);
  }
  finally { await f.client.close(); }
});

it('job lease assertion is read-only and refuses foreign, expired and settled authority', async () => {
  const f = await fixture();
  try {
    await f.client.store.jobs.enqueue('external', {}, { id: 'fence' });
    const first = await claim(f);
    assert.equal(await f.client.store.jobs.assertLease(first.lease), true);
    await assert.rejects(async () => f.client.store.jobs.assertLease(null), { code: 'JD2068' });
    f.advance(101);
    await assert.rejects(async () => f.client.store.jobs.assertLease(first.lease), { code: 'JD2067' });
    const next = await claim(f);
    await f.client.store.jobs.complete(next.lease, {});
    await assert.rejects(async () => f.client.store.jobs.assertLease(next.lease), { code: 'JD2065' });
  }
  finally { await f.client.close(); }
});
