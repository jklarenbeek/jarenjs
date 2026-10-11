//@ts-check
/**
 * @file Statement slots on the hosts that keep every preparation until told
 * otherwise (the worker, pool and process endpoints, up to `maxStatements`):
 * the job queue's pages, the maintenance operations and trusted SQL hold a
 * bounded number however often they run; the process host's own bookkeeping
 * mirrors its endpoint, so a long-lived store's settlement stays truthful; a
 * one-shot's release is never refused by a full request queue; the pool
 * reports each worker's count; and every error path of the change log's
 * page gives its statement back.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { openStore } from '@jarenjs/db';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';
import { nodeDriver } from '@jarenjs/db/node';
import { useStatementOnce, iterateStatementOnce } from '../../packages/db/src/driver.js';

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
  it(`${host}: 100 job queue pages fit 64 statement slots`, async () => {
    const store = await openStore(model, { driver: driver({ maxStatements: 64 }), jobs: {} });
    try {
      await store.jobs.enqueue('mail', { to: 'ada' }, { id: 'j1' });
      for (let i = 0; i < 100; i++) {
        let seen = 0;
        for await (const job of store.jobs.page({ limit: 10 })) seen += job.id === 'j1' ? 1 : 0;
        assert.equal(seen, 1, `page ${i + 1}`);
      }
      // a page left before its end gives its statement back too
      for (let i = 0; i < 100; i++) {
        const page = store.jobs.page({ limit: 10 });
        await page.next();
        await page.return();
      }
    }
    finally { await store.close(); }
  });

  it(`${host}: 100 maintenance operations fit 64 statement slots`, async () => {
    const store = await openStore(model, { driver: driver({ maxStatements: 64 }) });
    try {
      for (let i = 0; i < 100; i++) {
        const answer = i % 4 === 0 ? await store.checkpoint()
          : i % 4 === 1 ? await store.optimize()
            : i % 4 === 2 ? await store.integrityCheck() : await store.foreignKeyCheck();
        assert.equal(typeof answer, 'object', `operation ${i + 1}`);
      }
      assert.deepEqual(await store.integrityCheck(), { ok: true, problems: [] });
    }
    finally { await store.close(); }
  });

  it(`${host}: 100 transactions each preparing and closing one trusted statement fit 64 statement slots`, async () => {
    const store = await openStore(model, { driver: driver({ maxStatements: 64 }) });
    try {
      for (let i = 0; i < 100; i++) {
        const value = await store.transaction(async (tx) => {
          const statement = tx.sql.prepare('SELECT ? AS v', { access: 'read' });
          const row = await statement.get([i]);
          statement.close();
          statement.close();
          await assert.rejects(async () => statement.get([i]), { code: 'JD2095' });
          return row.v;
        });
        assert.equal(value, i, `transaction ${i + 1}`);
      }
    }
    finally { await store.close(); }
  });

  it(`${host}: 100 transactions each preparing a trusted statement and never closing it fit 64 statement slots`, async () => {
    const store = await openStore(model, { driver: driver({ maxStatements: 64 }) });
    try {
      for (let i = 0; i < 100; i++) {
        const value = await store.transaction(async (tx) => (await tx.sql.prepare('SELECT ? AS v', { access: 'read' }).get([i])).v);
        assert.equal(value, i, `transaction ${i + 1}`);
      }
    }
    finally { await store.close(); }
  });
}

if (!process.versions.bun) {
  it('process: the settlement stays committed after more one-shots than maxStatements', async () => {
    const { driver, connections } = observed(nodeProcessDriver({ maxStatements: 24 }));
    const store = await openStore(model, { driver, capture: journal });
    try {
      const connection = connections[0];
      for (let i = 0; i < 40; i++) await store.collection('notes').put({ id: 'n1', n: i });
      assert.equal(connection.settlement().transaction, 'committed');
      assert.deepEqual(await store.collection('notes').get('n1'), { id: 'n1', n: 39 });
      assert.equal(connection.settlement().transaction, 'committed', 'after a root read');
      assert.equal(connection.metrics().owner.transaction, 'committed');
      assert.ok(connection.metrics().statements < 24, `the endpoint holds ${connection.metrics().statements}`);
    }
    finally { await store.close(); }
  });

  it('process: a loss during a root read after more one-shots than maxStatements stays retryable', async () => {
    const { driver, connections } = observed(nodeProcessDriver({ maxStatements: 24 }));
    const store = await openStore(model, { driver, capture: journal });
    const connection = connections[0];
    try {
      for (let i = 0; i < 40; i++) await store.collection('notes').put({ id: 'n1', n: i });
      const read = store.collection('notes').get('n1');
      process.kill(connection.metrics().owner.pid, 'SIGKILL');
      await assert.rejects(read, { code: 'JD2090', retryable: true });
      assert.equal((await connection.settled()).transaction, 'committed');
    }
    finally { await store.close().catch(() => {}); }
  });
}

it('worker: a one-shot release the request queue would refuse is reserved like a cursor return', async () => {
  const connection = await nodeWorkerDriver({ maxPending: 1 }).open(':memory:');
  try {
    const base = connection.metrics().statements;
    let pending;
    const value = await useStatementOnce(connection, 'SELECT 1 AS one', (statement) => {
      pending = statement.get([]);
      return 'settled early';
    });
    assert.equal(value, 'settled early');
    assert.deepEqual(await pending, { one: 1 });
    await delay(50);
    assert.equal(connection.metrics().statements, base, 'the statement was given back');
    assert.equal(connection.metrics().pending, 0);
  }
  finally { await connection.close(); }
});

it('the iterator a one-cursor preparation hands back is its own iterable, sync and async, and gives its statement back', async () => {
  const sync = await nodeDriver().open(':memory:');
  try {
    const rows = [];
    for (const row of iterateStatementOnce(sync, 'SELECT 1 AS n UNION ALL SELECT 2', [])) rows.push(row.n);
    assert.deepEqual(rows, [1, 2]);
  }
  finally { await sync.close(); }
  const worker = await nodeWorkerDriver().open(':memory:');
  try {
    const base = worker.metrics().statements;
    const rows = [];
    for await (const row of await iterateStatementOnce(worker, 'SELECT 1 AS n UNION ALL SELECT 2', [])) rows.push(row.n);
    assert.deepEqual(rows, [1, 2]);
    await delay(50);
    assert.equal(worker.metrics().statements, base, 'the statement was given back');
  }
  finally { await worker.close(); }
});

it('pool: metrics report the statements each worker holds, stable over 100 journal-captured commits', async () => {
  const { driver, connections } = observed(nodeWorkerPoolDriver({ readers: 0 }));
  const store = await openStore(model, { driver, capture: journal });
  try {
    const slots = () => connections[0].metrics().workers.map((/** @type {any} */ worker) => worker.statements);
    let settled = [];
    for (let i = 0; i < 100; i++) {
      await store.collection('notes').put({ id: 'n1', n: i });
      if (i === 9) settled = slots();
      else if (i > 9) assert.deepEqual(slots(), settled, `slots after commit ${i + 1}`);
    }
    assert.equal(settled.length, 1);
    assert.ok(Number.isSafeInteger(settled[0]) && settled[0] > 0 && settled[0] < 64, `a bounded count, got ${settled[0]}`);
    assert.deepEqual(await store.collection('notes').execute(ns), [99]);
  }
  finally { await store.close(); }
});

it('worker: every refused or abandoned change page gives its statement back', async () => {
  const { driver, connections } = observed(nodeWorkerDriver({ windowRows: 1, maxCursors: 1 }));
  // the store's clock is read at every record boundary of a page that
  // carries a deadline, so it places the abort exactly: a microtask queued by
  // the fifth reading runs while the drain awaits its next one-row window.
  // A timer would race the drain (50 one-row windows, about 2.5 ms): a page
  // that finishes first is complete and rightly not refused
  /** @type {(() => void) | null} */
  let onClock = null;
  const store = await openStore(model, { driver, capture: journal, runtime: { now: () => { onClock?.(); return Date.now(); } } });
  try {
    const connection = connections[0];
    for (let i = 0; i < 60; i++) await store.collection('notes').put({ id: `n${i % 6}`, n: i });
    const base = connection.metrics().statements;
    /** @param {string} label @param {() => Promise<any>} run @param {any} expected */
    const refused = async (label, run, expected) => {
      await assert.rejects(run, expected, label);
      await delay(30);
      assert.equal(connection.metrics().statements, base, `${label}: slots`);
    };
    await refused('deadline passed', () => store.changes.page({ after: 0, limit: 10, deadline: Date.now() - 1000 }), { code: 'JD2075' });
    await refused('signal already aborted', () => store.changes.page({ after: 0, limit: 10, signal: AbortSignal.abort() }), { code: 'JD2072' });
    const controller = new AbortController();
    let readings = 0;
    onClock = () => { if (++readings === 5) queueMicrotask(() => controller.abort()); };
    try {
      await refused('aborted mid-drain', () => store.changes.page({
        after: 0, limit: 50, deadline: Date.now() + 60_000, signal: controller.signal }), { code: 'JD2072' });
    }
    finally { onClock = null; }
    assert.ok(readings >= 5 && readings < 50, `the page read the clock ${readings} times: it stopped inside its drain`);
    await refused('oversize record', () => store.changes.page({ after: 0, limit: 10, maxBytes: 1 }), { code: 'JD2074' });
    // the one cursor slot held by a raw statement of this test's own: the
    // page's iterate is refused, and its preparation leaves with the refusal
    const raw = await connection.prepare('SELECT * FROM notes');
    const held = await raw.iterate([]);
    await held.next();
    try { await assert.rejects(() => store.changes.page({ after: 0, limit: 3 }), { code: 'JD2092' }, 'cursor capacity'); }
    finally { await held.return(); await raw.finalize(); }
    await delay(30);
    assert.equal(connection.metrics().statements, base, 'cursor capacity: slots');
    assert.equal((await store.changes.page({ after: 0, limit: 3 })).items.length, 3);
  }
  finally { await store.close(); }
});
