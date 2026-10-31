//@ts-check
/**
 * @file A decision on a paused external effect, and its job's claim budget.
 *
 * A paused effect's job is `cancelled`: no lease exists to fence an
 * operator's decision, and a requeue followed by a claim by kind hands the
 * operator whichever job of that kind comes first. `reconcile` with a
 * `null` lease fences the decision by the record's revision instead, in
 * the command's own transaction, and refuses while the job is leased —
 * then the lease holder decides. Every pause and requeue spends one claim
 * of the effect's job, so a plan declares that job's own claim budget
 * (`jobClaimBudget`), which no reader can take for a leg's send budget
 * (`maxAttempts`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createDbEffectStore } from '@jarenjs/linq/db';
import { fixture } from '../durable/fixtures.js';

/** @param {string} id @param {string} jobId @param {any} [extra] */
const plan = (id, jobId, extra = {}) => ({ id, jobId, kind: 'external', actor: 'reviewer', reason: 'approved',
  hashVersion: 'canonical/1', ...extra,
  legs: [{ id: 'leg', maxAttempts: 1, request: { url: `https://provider.example/${id}`, method: 'POST', body: '{}', safety: 'single-send' } }] });
const decision = { id: 'decision-1', actor: 'operator', reason: 'provider confirmed by phone', action: 'confirm', evidence: { ticket: 'T-1' } };
const claim = (/** @type {any} */ f) => f.client.store.jobs.claim({ kinds: ['external'], owner: 'worker', leaseMs: 100 });
const writes = (/** @type {any} */ out) => [out.changes, out.writes, out.revisions];

/** op-A's leg is unresolved and its job paused (cancelled under its lease); op-B is prepared and pending.
 * @param {any} f */
async function paused(f) {
  const effects = createDbEffectStore(f.client, { operations: 'effects' });
  let { record } = await effects.prepare(plan('op-A', 'job-A'));
  const first = await claim(f);
  record = (await effects.begin('op-A', 'leg', record.revision, first.lease)).record;
  record = (await effects.settle('op-A', 'leg', record.revision, first.lease, { state: 'unresolved', evidence: { timeout: true } })).record;
  assert.equal(await f.client.store.jobs.cancel('job-A', { lease: first.lease }), true);
  f.advance(10);
  await effects.prepare(plan('op-B', 'job-B'));
  return { effects, record };
}

/** Requeue job-A behind job-B and claim both: a claim selects by kind, never by id.
 * @param {any} f */
async function leaseJobA(f) {
  f.advance(10);
  await f.client.store.jobs.requeue('job-A');
  const b = await claim(f);
  const a = await claim(f);
  assert.deepEqual([b.id, a.id], ['job-B', 'job-A']);
  return a.lease;
}

describe('a decision on a paused effect, fenced by the record revision', () => {
  it('a command records it in its own transaction, which takes it back if the command fails', async () => {
    const f = await fixture();
    try {
      const { effects, record } = await paused(f);
      assert.equal((await f.client.store.jobs.get('job-A')).state, 'cancelled');
      await assert.rejects(f.client.transaction(async (tx) => {
        await createDbEffectStore(tx, { operations: 'effects' }).reconcile('op-A', 'leg', record.revision, null, decision);
        throw new Error('the command failed');
      }), /the command failed/);
      assert.deepEqual(await effects.get('op-A'), record);
      const out = await f.client.transaction(async (tx) => {
        const decided = await createDbEffectStore(tx, { operations: 'effects' }).reconcile('op-A', 'leg', record.revision, null, decision);
        await tx.collections.audit.put({ id: 'audit-1', decision: decision.id }, 'audit-1');
        return decided;
      });
      assert.deepEqual(writes(out), [1, 1, 1]);
      assert.deepEqual([out.record.revision, out.record.legs[0].state], [record.revision + 1, 'confirmed']);
      assert.deepEqual(out.record.decisions, [{ ...decision, legId: 'leg' }]);
      assert.deepEqual(await effects.get('op-A'), out.record);
      assert.deepEqual(await f.client.collections.audit.get('audit-1'), { id: 'audit-1', decision: decision.id });
      // a decision is a record write, not a claim: the job stays paused
      assert.equal((await f.client.store.jobs.get('job-A')).state, 'cancelled');
    }
    finally { await f.client.close(); }
  });

  it('a stale revision refuses it and writes nothing', async () => {
    const f = await fixture();
    try {
      const { effects, record } = await paused(f);
      await assert.rejects(effects.reconcile('op-A', 'leg', record.revision - 1, null, decision),
        { code: 'JL2009', message: /stale operation revision/ });
      assert.deepEqual(await effects.get('op-A'), record);
    }
    finally { await f.client.close(); }
  });

  it('while a worker holds the job lease it refuses and writes nothing: the lease holder decides', async () => {
    const f = await fixture();
    try {
      const { effects, record } = await paused(f);
      const lease = await leaseJobA(f);
      await assert.rejects(effects.reconcile('op-A', 'leg', record.revision, null, decision),
        { code: 'JL2009', message: /the operation job is leased: its lease holder decides/ });
      assert.deepEqual(await effects.get('op-A'), record);
      const held = await effects.reconcile('op-A', 'leg', record.revision, lease, decision);
      assert.equal(held.record.legs[0].state, 'confirmed');
    }
    finally { await f.client.close(); }
  });

  it('a replay of the recorded decision answers the record under either fence, whoever holds the job', async () => {
    const f = await fixture();
    try {
      const { effects, record } = await paused(f);
      const decided = (await effects.reconcile('op-A', 'leg', record.revision, null, decision)).record;
      const replay = await effects.reconcile('op-A', 'leg', record.revision, null, decision);
      assert.deepEqual([writes(replay), replay.record], [[0, 0, 0], decided]);
      const lease = await leaseJobA(f);
      for (const fence of [null, lease]) {
        const again = await effects.reconcile('op-A', 'leg', record.revision, fence, decision);
        assert.deepEqual([writes(again), again.record], [[0, 0, 0], decided]);
      }
      await assert.rejects(effects.reconcile('op-A', 'leg', decided.revision, null, { ...decision, reason: 'changed' }),
        { code: 'JL2009', message: /reconciliation decision collision/ });
    }
    finally { await f.client.close(); }
  });

  it('every other check still holds, and a missing lease is still not a lease-less decision', async () => {
    const f = await fixture();
    try {
      const { effects, record } = await paused(f);
      await assert.rejects(effects.reconcile('op-A', 'leg', record.revision, undefined, decision),
        { code: 'JL2009', message: /foreign reconciliation job/ });
      await assert.rejects(async () => effects.reconcile('op-A', 'leg', record.revision, null, { ...decision, actor: '' }),
        { code: 'JL2009', message: /reconciliation needs actor\/reason and evidence/ });
      await assert.rejects(effects.reconcile('op-A', 'leg', record.revision, null, { ...decision, action: 'retry' }),
        { code: 'JL2009', message: /absence is not proof of non-application/ });
      await assert.rejects(effects.reconcile('op-A', 'leg', record.revision, null,
        { ...decision, action: 'retry', guarantee: 'authoritative-non-application' }),
      { code: 'JL2009', message: /durable attempt budget exhausted/ });
      await assert.rejects(effects.reconcile('op-B', 'leg', 1, null, decision),
        { code: 'JL2009', message: /only unresolved intent can be reconciled/ });
      const decided = (await effects.reconcile('op-A', 'leg', record.revision, null, decision)).record;
      await assert.rejects(effects.reconcile('op-A', 'leg', decided.revision, null, { ...decision, id: 'decision-2' }),
        { code: 'JL2009', message: /only unresolved intent can be reconciled/ });
      assert.deepEqual(await effects.get('op-A'), decided);
    }
    finally { await f.client.close(); }
  });
});

/**
 * Pause op-A `pauses` times (a claim, a cancel under its lease, a requeue),
 * then let the next attempt persist `sending` and crash: its lease expires,
 * and recovery is the next claim (JOBS-FORMAT §5).
 * @param {any} f @param {any} effects @param {number} pauses
 */
async function crashAfterPauses(f, effects, pauses) {
  const jobs = f.client.store.jobs;
  for (let i = 0; i < pauses; i++) {
    const held = await claim(f);
    await jobs.cancel('job-A', { lease: held.lease });
    f.advance(10);
    await jobs.requeue('job-A');
  }
  const crashing = await claim(f);
  await effects.begin('op-A', 'leg', (await effects.get('op-A')).revision, crashing.lease);
  assert.equal((await effects.get('op-A')).legs[0].state, 'sending');
  f.advance(1_000);
  return { crashing, next: await claim(f) };
}

describe("an effect's job takes the claim budget its plan declares", () => {
  it('a budget of 10, paused and requeued six times, recovers the crashed seventh attempt at the next claim', async () => {
    const f = await fixture();
    try {
      const effects = createDbEffectStore(f.client, { operations: 'effects' });
      await effects.prepare(plan('op-A', 'job-A', { jobClaimBudget: 10 }));
      assert.equal((await f.client.store.jobs.get('job-A')).maxAttempts, 10);
      const { crashing, next } = await crashAfterPauses(f, effects, 6);
      assert.equal(crashing.attempts, 7);
      assert.deepEqual([next?.id, next?.attempts], ['job-A', 8]);
      const recovered = await effects.recover('op-A', (await effects.get('op-A')).revision, next.lease);
      assert.equal(recovered.record.legs[0].state, 'unresolved');
    }
    finally { await f.client.close(); }
  });

  it('with no budget declared, the store default applies: the same crash is dead-lettered and the leg stays sending', async () => {
    const f = await fixture();
    try {
      const effects = createDbEffectStore(f.client, { operations: 'effects' });
      await effects.prepare(plan('op-A', 'job-A'));
      assert.equal((await f.client.store.jobs.get('job-A')).maxAttempts, 5);
      const { crashing, next } = await crashAfterPauses(f, effects, 6);
      assert.deepEqual([crashing.attempts, next], [7, undefined]);
      assert.equal((await f.client.store.jobs.get('job-A')).state, 'dead');
      assert.equal((await effects.get('op-A')).legs[0].state, 'sending');
    }
    finally { await f.client.close(); }
  });

  it('the budget is part of the reviewed plan: a replay with another refuses as a changed payload', async () => {
    const f = await fixture();
    try {
      const effects = createDbEffectStore(f.client, { operations: 'effects' });
      const first = await effects.prepare(plan('op-A', 'job-A', { jobClaimBudget: 10 }));
      assert.deepEqual(writes(await effects.prepare(plan('op-A', 'job-A', { jobClaimBudget: 10 }))), [0, 0, 0]);
      for (const extra of [{ jobClaimBudget: 11 }, {}]) {
        await assert.rejects(effects.prepare(plan('op-A', 'job-A', extra)), { code: 'JL2009', message: /reviewed operation payload changed/ });
      }
      assert.deepEqual(await effects.get('op-A'), first.record);
    }
    finally { await f.client.close(); }
  });

  it('a budget enqueue would refuse as maxAttempts is refused before anything is written', async () => {
    const f = await fixture();
    try {
      const effects = createDbEffectStore(f.client, { operations: 'effects' });
      for (const jobClaimBudget of [0, -1, 1.5, '3', null, true]) {
        assert.throws(() => effects.prepare(plan('op-A', 'job-A', { jobClaimBudget })), { name: 'TypeError', message: /attempt budgets/ });
      }
      assert.deepEqual(await f.client.collections.effects.toArray(), []);
      assert.equal(await f.client.store.jobs.get('job-A'), undefined);
    }
    finally { await f.client.close(); }
  });
});
