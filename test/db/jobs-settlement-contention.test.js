//@ts-check
/**
 * @file A worker's settlement under a contended store gate.
 *
 * The gate refuses a call while another caller holds the connection — at
 * once under `transactions: 'strict'`, after `queueTimeout` in the queue
 * under `'wait'` — and that refusal (`JD0012`) means the call never ran.
 * A completion or failure write refused that way decided nothing, so the
 * worker tries it again inside the lease: the handler that returned is
 * recorded once, never reported `failed` over a row that stayed leased and
 * then re-run when that lease expired. A hold that outlives the lease still
 * ends in the one coded loss. And a renewal queued ahead of a settlement
 * hands it the lease the renewal minted, so the fence does not refuse the
 * attempt's own settlement as superseded.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { postgresDriver } from '@jarenjs/db/postgres';

const url = process.env.JAREN_PG_URL;
const MODEL = { $model: '0.1', collections: { x: { key: '/id', schema: { type: 'object' }, indexes: [] } } };
const HOSTS = {
  'in-thread': () => nodeDriver(),
  'node-worker': () => nodeWorkerDriver(),
  pool: () => nodeWorkerPoolDriver(),
};

/** Poll until `done()` holds, or fail after `ms`. @param {() => boolean} done */
const until = async (done, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!done()) {
    assert.ok(Date.now() < deadline, 'timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const pause = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A store over a temporary file, closed and removed after `fn`.
 * @param {any} options @param {(store: any) => Promise<void>} fn */
async function withStore(options, fn) {
  const folder = await mkdtemp(join(tmpdir(), 'jaren-settle-'));
  const store = await openStore(MODEL, { path: join(folder, 'jobs.db'), jobs: true, ...options });
  try { await fn(store); }
  finally {
    await store.close();
    await rm(folder, { recursive: true, force: true });
  }
}

/**
 * Start a worker over job `job-1` whose handler, on its first run, opens a
 * root transaction that holds the gate for `holdMs`, waits until it is open
 * (and `afterMs` more), then answers `first()` while it still holds it.
 * @param {any} store
 * @param {{ holdMs: number, afterMs?: number, leaseMs?: number, first?: () => any, workerOptions?: any }} spec
 */
async function contended(store, { holdMs, afterMs = 0, leaseMs = 500, first = () => ({ done: true }), workerOptions = {} }) {
  /** @type {any[]} */
  const outcomes = [];
  const state = { runs: 0, committed: false, held: /** @type {Promise<any> | undefined} */ (undefined) };
  await store.jobs.enqueue('work', { n: 1 }, { id: 'job-1' });
  const worker = store.jobs.createWorker({
    leaseMs, pollInterval: 20, ...workerOptions,
    onOutcome: (/** @type {any} */ event) => outcomes.push(event),
    handlers: {
      work: async () => {
        state.runs += 1;
        if (state.runs > 1) return { done: true };
        const opened = Promise.withResolvers();
        state.held = store.transaction(async () => {
          opened.resolve(undefined);
          await pause(holdMs);
          state.committed = true;
        });
        await opened.promise;
        if (afterMs > 0) await pause(afterMs);
        return first();
      },
    },
  });
  worker.start();
  return { worker, outcomes, state };
}

const counts = (/** @type {any} */ worker) => {
  const { completions, failures, lostSettlements } = worker.stats();
  return { completions, failures, lostSettlements };
};

describe("under transactions: 'strict', a contended settlement is retried inside the lease", () => {
  for (const [host, driver] of Object.entries(HOSTS)) {
    it(`a handler that returns while a transaction holds the gate 150 ms runs once and is recorded completed (${host})`, async () => {
      await withStore({ driver: driver(), transactions: 'strict' }, async (store) => {
        const run = await contended(store, { holdMs: 150 });
        await until(() => run.outcomes.length > 0);
        await run.state.held;
        await run.worker.stop();
        assert.deepStrictEqual(run.outcomes.map((event) => event.outcome), ['completed']);
        assert.strictEqual(run.state.runs, 1);
        assert.deepStrictEqual(counts(run.worker), { completions: 1, failures: 0, lostSettlements: 0 });
        const row = await store.jobs.get('job-1');
        assert.deepStrictEqual([row.state, row.attempts], ['done', 1]);
      });
    });
  }

  it('a hold longer than the lease still ends in the coded loss JD2067, and the next claim re-runs the job', async () => {
    await withStore({ driver: nodeDriver(), transactions: 'strict' }, async (store) => {
      // one claim-execute loop: nothing re-claims the job before its own
      // settlement is admitted, so the fence answers "expired"
      const run = await contended(store, { holdMs: 700, leaseMs: 300 });
      await until(() => run.outcomes.some((event) => event.outcome === 'completed'));
      await run.state.held;
      await run.worker.stop();
      assert.deepStrictEqual(run.outcomes.map((event) => [event.outcome, event.code ?? null]),
        [['lost', 'JD2067'], ['completed', null]]);
      assert.strictEqual(run.state.runs, 2);
      assert.deepStrictEqual(counts(run.worker), { completions: 1, failures: 0, lostSettlements: 1 });
      const row = await store.jobs.get('job-1');
      assert.deepStrictEqual([row.state, row.attempts], ['done', 2]);
    });
  });

  it('a handler that throws while the gate is held records its failure once the write is admitted', async () => {
    await withStore({ driver: nodeDriver(), transactions: 'strict' }, async (store) => {
      const run = await contended(store, { holdMs: 150, first: () => { throw new Error('boom'); },
        workerOptions: { backoffBase: 60_000 } });
      await until(() => run.outcomes.length > 0);
      await run.state.held;
      await run.worker.stop();
      assert.deepStrictEqual(run.outcomes.map((event) => [event.outcome, event.reason]), [['failed', 'boom']]);
      assert.deepStrictEqual(counts(run.worker), { completions: 0, failures: 1, lostSettlements: 0 });
      const row = await store.jobs.get('job-1');
      assert.deepStrictEqual([row.state, row.attempts, row.lastError], ['failed', 1, 'boom']);
    });
  });

  it('a result JSON cannot express still fails the attempt, with its own reason, once the gate admits the write', async () => {
    await withStore({ driver: nodeDriver(), transactions: 'strict' }, async (store) => {
      const run = await contended(store, { holdMs: 150, first: () => ({ big: 1n }),
        workerOptions: { backoffBase: 60_000 } });
      await until(() => run.outcomes.length > 0);
      await run.state.held;
      await run.worker.stop();
      assert.deepStrictEqual(run.outcomes.map((event) => event.outcome), ['failed']);
      assert.match(run.outcomes[0].reason, /could not be serialized/);
      const row = await store.jobs.get('job-1');
      assert.deepStrictEqual([row.state, row.attempts], ['failed', 1]);
      assert.match(row.lastError, /could not be serialized/);
    });
  });

  it('stop() abandons a settlement still waiting for the gate: no outcome, and the leased row recovers by expiry', async () => {
    await withStore({ driver: nodeDriver(), transactions: 'strict' }, async (store) => {
      const run = await contended(store, { holdMs: 600, leaseMs: 300 });
      await until(() => run.state.runs === 1);
      await pause(50);
      assert.deepStrictEqual(await run.worker.stop(), { drained: true, inFlight: 0 });
      // stop() did not wait the transaction out
      assert.strictEqual(run.state.committed, false);
      assert.deepStrictEqual(run.outcomes, []);
      assert.deepStrictEqual(counts(run.worker), { completions: 0, failures: 0, lostSettlements: 0 });
      await run.state.held;
      const row = await store.jobs.get('job-1');
      assert.deepStrictEqual([row.state, row.attempts, row.lastError], ['leased', 1, null]);
      await until(() => Date.now() > row.leaseUntil);
      const next = [];
      const again = store.jobs.createWorker({ leaseMs: 300, pollInterval: 20,
        onOutcome: (/** @type {any} */ event) => next.push(event.outcome), handlers: { work: () => ({ done: true }) } });
      again.start();
      await until(() => next.length > 0);
      await again.stop();
      assert.deepStrictEqual(next, ['completed']);
      const done = await store.jobs.get('job-1');
      assert.deepStrictEqual([done.state, done.attempts], ['done', 2]);
    });
  });

  it('a cancellation that lands while the settlement waits is recorded as the outcome, never a completion', async () => {
    await withStore({ driver: nodeDriver(), transactions: 'strict' }, async (store) => {
      // a long poll makes the retry wait long: only the cancellation can cut it short
      const run = await contended(store, { holdMs: 100, leaseMs: 9_000, workerOptions: { pollInterval: 5_000 } });
      await until(() => run.state.held !== undefined);
      await run.state.held;
      await until(() => run.worker.leases().length === 1);
      assert.strictEqual(await store.jobs.cancel('job-1', { lease: run.worker.leases()[0] }), true);
      await run.worker.stop();
      assert.deepStrictEqual(run.outcomes.map((event) => event.outcome), ['cancelled']);
      assert.deepStrictEqual(counts(run.worker), { completions: 0, failures: 0, lostSettlements: 0 });
      assert.strictEqual(run.worker.stats().cancellations, 1);
      assert.strictEqual((await store.jobs.get('job-1')).state, 'cancelled');
    });
  });
});

describe("under the default 'wait' admission", () => {
  it('a handler that returns while a transaction holds the gate 150 ms completes once, as before', async () => {
    await withStore({ driver: nodeDriver() }, async (store) => {
      const run = await contended(store, { holdMs: 150 });
      await until(() => run.outcomes.length > 0);
      await run.worker.stop();
      assert.deepStrictEqual(run.outcomes.map((event) => event.outcome), ['completed']);
      assert.strictEqual(run.state.committed, true);
      assert.deepStrictEqual(counts(run.worker), { completions: 1, failures: 0, lostSettlements: 0 });
    });
  });

  it('a settlement that waited out the queue timeout is queued again, not reported failed', async () => {
    await withStore({ driver: nodeDriver(), queueTimeout: 100 }, async (store) => {
      const run = await contended(store, { holdMs: 400, leaseMs: 2_000 });
      await until(() => run.outcomes.length > 0);
      await run.worker.stop();
      assert.deepStrictEqual(run.outcomes.map((event) => event.outcome), ['completed']);
      assert.strictEqual(run.state.runs, 1);
      assert.deepStrictEqual(counts(run.worker), { completions: 1, failures: 0, lostSettlements: 0 });
      const row = await store.jobs.get('job-1');
      assert.deepStrictEqual([row.state, row.attempts], ['done', 1]);
    });
  });

  for (const [host, driver] of Object.entries(HOSTS).slice(0, 2)) {
    it(`a completion queued behind the attempt's own renewal settles under the renewed lease (${host})`, async () => {
      await withStore({ driver: driver() }, async (store) => {
        // the renewal (every 400 ms) queues behind the transaction first,
        // the completion (at 500 ms) behind the renewal; both run at 700 ms,
        // with 500 ms of the first lease still to go
        const run = await contended(store, { holdMs: 700, afterMs: 500, leaseMs: 1_200 });
        await until(() => run.outcomes.length > 0);
        await run.worker.stop();
        assert.deepStrictEqual(run.outcomes.map((event) => [event.outcome, event.code ?? null]), [['completed', null]]);
        assert.strictEqual(run.state.runs, 1);
        assert.deepStrictEqual(counts(run.worker), { completions: 1, failures: 0, lostSettlements: 0 });
        assert.strictEqual(run.worker.stats().renewals, 1);
        const row = await store.jobs.get('job-1');
        assert.deepStrictEqual([row.state, row.attempts], ['done', 1]);
      });
    });
  }
});

describe("PostgreSQL under transactions: 'strict'", { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  it('a handler that returns while a transaction holds the gate 150 ms runs once and is recorded completed', async () => {
    const pg = (await import('pg')).default;
    const schema = `jaren_settle_${process.pid}`;
    const pool = new pg.Pool({ connectionString: url, max: 3 });
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }), jobs: true, transactions: 'strict' });
      try {
        const run = await contended(store, { holdMs: 150 });
        await until(() => run.outcomes.length > 0);
        await run.state.held;
        await run.worker.stop();
        assert.deepStrictEqual(run.outcomes.map((event) => event.outcome), ['completed']);
        assert.strictEqual(run.state.runs, 1);
        assert.deepStrictEqual(counts(run.worker), { completions: 1, failures: 0, lostSettlements: 0 });
        const row = await store.jobs.get('job-1');
        assert.deepStrictEqual([row.state, row.attempts], ['done', 1]);
      }
      finally { await store.close(); }
    }
    finally {
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await pool.end(); }
    }
  });
});
