//@ts-check
/**
 * @file Crash recovery (JOBS-FORMAT §5, §7): a worker dies mid-job —
 * simulated by an expiring lease under an injected clock — and the
 * next claim reclaims the job with its checkpoint rows intact, so the
 * DAG run RESUMES (completed nodes seed, counting handlers prove no
 * re-run) rather than restarting. The stale owner's checkpoint saves
 * and completion are refused by the lease guard. Driven manually
 * through the low-level surface — no timer races, no sleeps for time.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileDag } from '@jarenjs/flow';
import { openStore, JOB_CHECKPOINTS_TABLE } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { DatabaseSync } from 'node:sqlite';
import { tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    x: { schema: { type: 'object', properties: { id: { type: 'string' } } },
      key: '/id', indexes: [] },
  },
};

const DAG = {
  $dag: '0.1',
  nodes: {
    in: { kind: 'input' },
    expensive: { kind: 'task', run: 'expensive', checkpoint: true },
    fragile: { kind: 'task', run: 'fragile' },
    out: { kind: 'output' },
  },
  edges: [
    { from: 'in', to: 'expensive' },
    { from: 'expensive', to: 'fragile' },
    { from: 'fragile', to: 'out' },
  ],
};

const makeClock = (start = 5_000_000) => {
  let at = start;
  const clock = () => at;
  clock.advance = (ms) => { at += ms; };
  return clock;
};

describe('recovery: the reclaimed job RESUMES from its checkpoint', () => {
  it('an expired lease is reclaimed; completed nodes do not re-run', async () => {
    const clock = makeClock();
    const store = await openStore(MODEL,
      { driver: nodeDriver(), jobs: { now: clock } });
    const counts = { expensive: 0, fragile: 0 };
    let crash = true;
    const dag = (job) => compileDag(DAG, {
      checkpoint: store.jobs.checkpointsFor(job),
      tasks: {
        expensive: ({ input }) => {
          counts.expensive += 1;
          return { loaded: input.day };
        },
        fragile: ({ input }) => {
          counts.fragile += 1;
          if (crash) throw new Error('the process died here');
          return input;
        },
      },
    });

    await store.jobs.enqueue('report', { input: { day: 'mon' } }, { id: 'job-1' });
    const attempt1 = await store.jobs.claim({
      kinds: ['report'], owner: 'w1', leaseMs: 1_000 });
    await assert.rejects(
      () => dag(attempt1).run(attempt1.payload.input, { runId: attempt1.id }),
      /died here/);
    // the "crash": w1 never reports failure; its lease just expires
    assert.strictEqual((await store.jobs.get('job-1')).state, 'leased');
    assert.strictEqual(counts.expensive, 1);

    assert.strictEqual(await store.jobs.claim({
      kinds: ['report'], owner: 'w2' }), undefined, 'the lease still holds');
    clock.advance(1_500);
    const attempt2 = await store.jobs.claim({ kinds: ['report'], owner: 'w2' });
    assert.strictEqual(attempt2.id, 'job-1', 'recovery IS the next claim');
    assert.strictEqual(attempt2.attempts, 2);

    crash = false;
    const restored = [];
    const result = await dag(attempt2).run(attempt2.payload.input, {
      runId: attempt2.id,
      onNode: (record) => {
        if (record.status === 'restored') restored.push(record.id);
      },
    });
    assert.deepStrictEqual(result, { loaded: 'mon' });
    assert.strictEqual(counts.expensive, 1,
      'the checkpointed node did NOT re-run — the resume is the whole point');
    assert.strictEqual(counts.fragile, 2, 'the undeclared node recomputed');
    assert.deepStrictEqual(restored, ['expensive']);

    const job = await store.jobs.get('job-1');
    assert.strictEqual(job.state, 'done',
      'the dag completion marked the job done transactionally');
    assert.deepStrictEqual(job.result, { loaded: 'mon' });
    await store.close();
  });

  it("the stale owner's checkpoint saves and completion are refused", async () => {
    const clock = makeClock();
    const store = await openStore(MODEL,
      { driver: nodeDriver(), jobs: { now: clock } });
    await store.jobs.enqueue('r', { input: {} }, { id: 'j' });
    const stale = await store.jobs.claim({ kinds: ['r'], owner: 'w1', leaseMs: 100 });
    clock.advance(200);
    const fresh = await store.jobs.claim({ kinds: ['r'], owner: 'w2' });
    assert.strictEqual(fresh.leaseOwner, 'w2');

    const staleStore = store.jobs.checkpointsFor(stale);
    assert.throws(() => staleStore.save('j', 'n', { v: 1 }), /lease.*lost/,
      'a stale save ABORTS the stale run fast');
    assert.throws(() => staleStore.complete('j', { v: 1 }), /lease.*lost/);
    assert.strictEqual((await store.jobs.get('j')).state, 'leased',
      'the fresh lease is untouched');
    assert.strictEqual((await store.jobs.get('j')).leaseOwner, 'w2');

    const freshStore = store.jobs.checkpointsFor(fresh);
    freshStore.save('j', 'n', { v: 2 });
    assert.deepStrictEqual(freshStore.load('j'), { values: { n: { v: 2 } } });
    freshStore.complete('j', { done: true });
    assert.strictEqual((await store.jobs.get('j')).state, 'done');
    await store.close();
  });

  it('a WORKER-driven reclaim resumes too (real loops, fake eligibility clock)', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const clock = makeClock();
      const seen = [];
      const openWorkerStore = () => openStore(MODEL,
        { driver: nodeDriver(), path: dbPath, jobs: { now: clock } });
      const storeA = await openWorkerStore();
      const storeB = await openWorkerStore();

      // worker A hangs forever on its first claim — the simulated
      // wedge; its lease expires under the fake clock
      const hang = new Promise(() => {});
      const workerA = storeA.jobs.createWorker({
        handlers: { w: () => { seen.push('A'); return hang; } },
        pollInterval: 5, owner: 'A', leaseMs: 1_000,
      });
      workerA.start();
      await storeA.jobs.enqueue('w', { input: null }, { id: 'j' });
      const until = Date.now() + 5_000;
      while (seen.length === 0 && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.deepStrictEqual(seen, ['A']);

      clock.advance(2_000); // A's lease is now expired
      const workerB = storeB.jobs.createWorker({
        handlers: { w: () => { seen.push('B'); return { by: 'B' }; } },
        pollInterval: 5, owner: 'B',
      });
      workerB.start();
      const deadline = Date.now() + 5_000;
      for (;;) {
        const job = await storeB.jobs.get('j');
        if (job.state === 'done') break;
        assert.ok(Date.now() < deadline, `stalled: ${job.state}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const job = await storeB.jobs.get('j');
      assert.deepStrictEqual(job.result, { by: 'B' });
      assert.strictEqual(job.attempts, 2);
      assert.deepStrictEqual(seen, ['A', 'B']);

      await workerB.stop();
      // worker A is wedged on purpose: closing its store must not hang
      // the test — stop only B's loops, then close B's store.
      await storeB.close();
      cleanup();
    }
    finally { /* cleanup ran above; the wedged worker dies with the process */ }
  });

  it('checkpoint rows are pruned on completion and kept for the dead', async () => {
    const clock = makeClock();
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(MODEL,
        { driver: nodeDriver(), path: dbPath, jobs: { now: clock, maxAttempts: 1 } });
      // claim order is (run_at, created_at, id): 'doomed' sorts first
      await store.jobs.enqueue('r', { input: {} }, { id: 'doomed' });
      await store.jobs.enqueue('r', { input: {} }, { id: 'ok' });

      const doomed = await store.jobs.claim({ kinds: ['r'], owner: 'w' });
      assert.strictEqual(doomed.id, 'doomed');
      store.jobs.checkpointsFor(doomed).save(doomed.id, 'n', { v: 2 });
      await store.jobs.fail(doomed.id, 'w', new Error('gone'));
      assert.strictEqual((await store.jobs.get('doomed')).state, 'dead');

      const okJob = await store.jobs.claim({ kinds: ['r'], owner: 'w' });
      assert.strictEqual(okJob.id, 'ok');
      const okStore = store.jobs.checkpointsFor(okJob);
      okStore.save(okJob.id, 'n', { v: 1 });
      okStore.complete(okJob.id, { fine: true });
      await store.close();

      const raw = new DatabaseSync(dbPath);
      const rows = raw.prepare(
        `SELECT run_id FROM "${JOB_CHECKPOINTS_TABLE}" ORDER BY run_id`).all();
      raw.close();
      assert.deepStrictEqual(rows.map((row) => row.run_id), ['doomed'],
        'done runs prune; dead runs keep their post-mortem');
    }
    finally {
      cleanup();
    }
  });
});
