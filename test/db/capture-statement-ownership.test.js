//@ts-check
/**
 * @file The change log's statements are released after each use. A host
 * that keeps every preparation until told otherwise (the worker, pool and
 * process endpoints, up to `maxStatements`) serves a store with journal
 * capture — and the live registrations and lease renewals that read and
 * write beside its log — for any number of commits, holding a stable
 * number of statement slots rather than three more per commit.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { openStore } from '@jarenjs/db';
import { asyncLive } from '@jarenjs/db/async-live';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';

const model = { $model: '0.1', collections: { notes: { key: '/id', schema: { type: 'object', properties: {
  id: { type: 'string' }, n: { type: 'integer' } } } } } };
const journal = { mode: 'journal', log: { retention: 1000 } };
const ns = [{ $for: { it: '$[*]' }, $return: '$it.n' }];

/** @type {[string, (limits: any) => any][]} */
const HOSTS = [
  ['worker', (limits) => nodeWorkerDriver(limits)],
  ['pool', (limits) => nodeWorkerPoolDriver({ readers: 0, worker: limits })],
];
// The process host requires Node 24+; Bun exercises workers and their pool.
if (!process.versions.bun) HOSTS.push(['process', (limits) => nodeProcessDriver(limits)]);

/**
 * The driver, with every connection it opens kept where a test can read
 * the endpoint's own statement count (`metrics().statements`).
 * @param {any} driver
 * @returns {{ driver: any, connections: any[] }}
 */
function observed(driver) {
  /** @type {any[]} */
  const connections = [];
  return { connections, driver: { ...driver, open: (/** @type {any[]} */ ...args) =>
    Promise.resolve(driver.open(...args)).then((connection) => { connections.push(connection); return connection; }) } };
}

for (const [host, driver] of HOSTS) {
  it(`${host}: 100 journal-captured commits and their log reads fit 64 statement slots`, async () => {
    const store = await openStore(model, { driver: driver({ maxStatements: 64 }), capture: journal });
    try {
      for (let i = 0; i < 100; i++) {
        await store.collection('notes').put({ id: 'n1', n: i });
        const page = await store.changes.page({ after: 0, limit: 2 });
        assert.equal(page.highWatermark, i + 1, `page after commit ${i + 1}`);
        assert.equal((await store.changes.bounds()).earliestAvailable, 1, `bounds after commit ${i + 1}`);
        assert.equal((await store.changesSince(i)).length, 1, `changesSince after commit ${i + 1}`);
      }
      assert.deepEqual(await store.collection('notes').execute(ns), [99]);
    }
    finally { await store.close(); }
  });
}

it('worker: 1500 journal-captured commits hold a stable number of statement slots', async () => {
  const { driver, connections } = observed(nodeWorkerDriver());
  const store = await openStore(model, { driver, capture: journal });
  try {
    assert.equal(connections.length, 1);
    const slots = () => connections[0].metrics().statements;
    let settled = 0;
    for (let i = 0; i < 1500; i++) {
      await store.collection('notes').put({ id: 'n1', n: i });
      if (i === 9) settled = slots();
      else if (i > 9) assert.equal(slots(), settled, `slots after commit ${i + 1}`);
    }
    assert.ok(settled > 0 && settled < 64, `a bounded fixed set, got ${settled}`);
    assert.ok(connections[0].metrics().pending <= 1, 'no request backlog');
    assert.deepEqual(await store.collection('notes').execute(ns), [1499]);
  }
  finally { await store.close(); }
});

it('worker: an asyncLive registration refreshed on every commit keeps its slots and answers the last write', async () => {
  const { driver, connections } = observed(nodeWorkerDriver());
  const store = await openStore(model, { driver, capture: journal, live: asyncLive({ pollMs: 60000 }) });
  try {
    const live = await store.collection('notes').live(ns);
    try {
      const slots = () => connections[0].metrics().statements;
      let settled = 0;
      for (let i = 0; i < 400; i++) {
        await store.collection('notes').put({ id: 'n1', n: i });
        if (i === 9) settled = slots();
        else if (i > 9) assert.equal(slots(), settled, `slots after commit ${i + 1}`);
        await live.refresh();
        assert.deepEqual(live.result.rows, [i], `rows after commit ${i + 1}`);
      }
      assert.ok(settled > 0 && settled < 64, `a bounded fixed set, got ${settled}`);
    }
    finally { await live.close(); }
  }
  finally { await store.close(); }
});

it('worker: the owner lease renews without holding a statement slot per renewal', async () => {
  const { driver, connections } = observed(nodeWorkerDriver());
  const store = await openStore(model, { driver, owner: { id: 'slots', leaseMs: 1000 } });
  try {
    const slots = () => connections[0].metrics().statements;
    await store.collection('notes').put({ id: 'n1', n: 0 });
    const settled = slots();
    assert.ok(settled > 0, `the endpoint reports its count, got ${settled}`);
    // a third of the lease per renewal: several of them
    await delay(1400);
    await store.collection('notes').put({ id: 'n1', n: 1 });
    assert.equal(slots(), settled);
    assert.deepEqual(await store.collection('notes').execute(ns), [1]);
  }
  finally { await store.close(); }
});
