//@ts-check
/**
 * @file Exactly-once under contention (JOBS-FORMAT §3): several
 * workers on SEPARATE CONNECTIONS to the same database file — a
 * single synchronous connection cannot contend — hammer one queue
 * under the store's busy policy (WAL + busy_timeout are its file
 * defaults), and every job is executed exactly once: no loss, no
 * double-claim. Repeated, because a race that shows up one run in
 * three is still a race.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    x: { schema: { type: 'object', properties: { id: { type: 'string' } } },
      key: '/id', indexes: [] },
  },
};

describe('exactly-once execution under contention', () => {
  it('4 workers on 4 connections execute 200 jobs exactly once (×3 rounds)', async () => {
    for (let round = 0; round < 3; round++) {
      const { dbPath, cleanup } = tempDbPath();
      try {
        const producer = await openStore(MODEL,
          { driver: nodeDriver(), path: dbPath, jobs: true });
        /** @type {Map<string, number>} executions per job id, shared
         * across workers in this process */
        const executed = new Map();
        const stores = [];
        const workers = [];
        for (let w = 0; w < 4; w++) {
          const store = await openStore(MODEL,
            { driver: nodeDriver(), path: dbPath, jobs: true });
          stores.push(store);
          const worker = store.jobs.createWorker({
            handlers: {
              work: async (payload) => {
                executed.set(payload.id, (executed.get(payload.id) ?? 0) + 1);
                // yield so the loops genuinely interleave
                await new Promise((resolve) => setImmediate(resolve));
                return payload.id;
              },
            },
            concurrency: 2,
            pollInterval: 5,
            owner: `worker-${w}`,
          });
          workers.push(worker);
          worker.start();
        }

        const JOBS = 200;
        for (let i = 0; i < JOBS; i++) {
          await producer.jobs.enqueue('work', { id: `job-${i}` }, { id: `job-${i}` });
        }
        const deadline = Date.now() + 20_000;
        for (;;) {
          const counts = await producer.jobs.counts();
          if (counts.done === JOBS) break;
          assert.ok(Date.now() < deadline,
            `round ${round}: stalled at ${JSON.stringify(counts)}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        assert.strictEqual(executed.size, JOBS,
          `round ${round}: every job ran`);
        const doubles = [...executed.entries()].filter(([, n]) => n !== 1);
        assert.deepStrictEqual(doubles, [],
          `round ${round}: no job ran twice`);
        const claims = workers.reduce((n, worker) => n + worker.stats().claims, 0);
        assert.strictEqual(claims, JOBS,
          `round ${round}: claims across workers equal the jobs — no double-claim`);

        // every ordinary stop drains and quiesces BEFORE its store
        // closes: this is what keeps the database file releasable —
        // the Windows EPERM was a claim loop still holding it, and
        // more cleanup retries cannot cure that
        const stopped = await Promise.all(workers.map((worker) => worker.stop()));
        assert.deepStrictEqual(stopped,
          workers.map(() => ({ drained: true, inFlight: 0 })),
          `round ${round}: every worker drained and left nothing in flight`);
        await Promise.all(stores.map((store) => store.close()));
        await producer.close();
      }
      finally {
        cleanup();
      }
    }
  });
});
