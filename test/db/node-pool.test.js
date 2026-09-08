//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@jarenjs/db';
import { nodeWorkerPoolDriver } from '../../packages/db/src/drivers/node-pool.js';
import { workerQueue } from '../../packages/db/src/drivers/worker-queue.js';

async function fixture(options = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'jaren-pool-'));
  const connection = await nodeWorkerPoolDriver(options).open(join(folder, 'db.sqlite'));
  return { connection, close: async () => { await connection.close(); await rm(folder, { recursive: true }); } };
}

describe('worker pool FIFO scheduler', () => {
  it('bounds queue depth, respects roles and records wait with an injected clock', async () => {
    let now = 0;
    const slots = [{ readOnly: false, healthy: true }, { readOnly: true, healthy: true }];
    const queue = workerQueue(slots, 1, () => now);
    const writer = await queue.acquire(false);
    const reader = await queue.acquire(true);
    const pending = queue.acquire(true);
    await assert.rejects(queue.acquire(false), { code: 'JD2091', depth: 1, retryable: true });
    assert.equal(queue.metrics().active, 2);
    assert.equal(queue.metrics().queued, 1);
    now = 20;
    reader.release();
    reader.release();
    const second = await pending;
    assert.equal(second.slot, slots[1]);
    second.release();
    writer.release();
    await queue.drain();
    assert.equal(queue.metrics().waitMs.p95, 20);
    queue.stop();
    await assert.rejects(queue.acquire(false), { code: 'JD2063' });
  });
  it('stops queued work without executing it while current leases drain', async () => {
    const queue = workerQueue([{ readOnly: false, healthy: true }], 2, () => 0);
    const lease = await queue.acquire(false);
    const rejected = assert.rejects(queue.acquire(false), { code: 'JD2063' });
    const drain = queue.drain();
    queue.stop();
    await rejected;
    lease.release();
    await drain;
    assert.equal(queue.metrics().active, 0);
  });
});

describe('WAL worker pool', () => {
  it('uses one writer, holds reader cursor affinity, and refuses writes on readers', async () => {
    const { connection, close } = await fixture({ readers: 2, queueCapacity: 1 });
    try {
      assert.equal(connection.mustQueue, false);
      await connection.exec('CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1), (2)');
      const statement = connection.prepare('SELECT n FROM t', { readOnly: true, ephemeral: true });
      const first = await statement.iterate();
      const second = await statement.iterate();
      assert.equal(connection.metrics().active, 2);
      const waiting = statement.iterate();
      await assert.rejects(statement.iterate(), { code: 'JD2091', depth: 1 });
      await first.return();
      const third = await waiting;
      assert.equal((await second.next()).value.n, 1);
      await second.return();
      await third.return();
      await assert.rejects(connection.prepare('INSERT INTO t VALUES (3)', { readOnly: true }).run(),
        (error) => error.errcode === 8 || error.code === 'JD2083');
      assert.deepEqual(await connection.prepare('SELECT n FROM t').all(), [{ n: 1 }, { n: 2 }]);
      const metrics = connection.metrics();
      assert.equal(metrics.workers.filter((worker) => !worker.readOnly).length, 1);
      assert.ok(metrics.workers.filter((worker) => worker.readOnly).every((worker) => worker.executions > 0));
    }
    finally { await close(); }
  });
  it('pins nested transactions to the writer and checkpoints after releasing the readers', async () => {
    const { connection, close } = await fixture();
    try {
      await connection.exec('CREATE TABLE t (n INTEGER)');
      await connection.transaction(async (scope) => {
        await scope.exec('INSERT INTO t VALUES (1)');
        assert.deepEqual(await scope.prepare('SELECT n FROM t', { readOnly: true }).all(), [{ n: 1 }]);
        await assert.rejects(scope.transaction(async (inner) => {
          await inner.exec('INSERT INTO t VALUES (2)');
          throw new Error('nested rollback');
        }), /nested rollback/);
        assert.equal(connection.metrics().workers[0].active, true);
      });
      assert.deepEqual(await connection.prepare('SELECT n FROM t', { readOnly: true }).all(), [{ n: 1 }]);
      const result = await connection.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      assert.equal(result.busy, 0);
    }
    finally { await close(); }
  });
  it('runs the Store lifecycle on file and memory, reporting the actual reader count', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'jaren-pool-store-'));
    try {
      for (const path of [':memory:', join(folder, 'db.sqlite')]) {
        const store = await openStore({ $model: '0.1', collections: {
          notes: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } } } },
        } }, { driver: nodeWorkerPoolDriver(), path, capture: { mode: 'journal', log: true } });
        try {
          await store.collection('notes').insert({ id: 'one', text: 'before' });
          await store.transaction(async (tx) => { await tx.collection('notes').put({ id: 'one', text: 'after' }); });
          assert.equal((await store.collection('notes').get('one')).text, 'after');
          assert.equal(store.capabilities.poolReaders, path === ':memory:' ? 0 : 2);
          assert.equal(store.capabilities.poolWriters, 1);
          assert.ok((await store.changesSince(0)).length > 0);
        }
        finally { await store.close(); }
      }
    }
    finally { await rm(folder, { recursive: true }); }
  });
});

describe('pool recovery and commit settlement', () => {
  it('fences a lost reader and replaces it before the next lease without replay', async () => {
    const { workerPoolDriver } = await import('../../packages/db/src/drivers/worker-pool.js');
    const { nodeWorkerDriver } = await import('../../packages/db/src/drivers/node-worker.js');
    const folder = await mkdtemp(join(tmpdir(), 'jaren-pool-fault-'));
    const opened = [];
    const factory = () => {
      const driver = nodeWorkerDriver();
      return { open: async (...args) => { const connection = await driver.open(...args); opened.push(connection); return connection; } };
    };
    const pool = await workerPoolDriver({ readers: 1 }, factory).open(join(folder, 'db.sqlite'));
    let orphan;
    try {
      await pool.exec('CREATE TABLE t(n); INSERT INTO t VALUES(1)');
      const cursor = await pool.prepare('SELECT n FROM t', { readOnly: true }).iterate();
      const oldGeneration = pool.metrics().workers[1].generation;
      orphan = await opened[1].restart();
      await assert.rejects(cursor.next(), { code: 'JD2090', retryable: true });
      assert.equal(pool.metrics().workers[1].healthy, true);
      assert.ok(pool.metrics().workers[1].generation > oldGeneration);
      assert.deepEqual(await pool.prepare('SELECT n FROM t', { readOnly: true }).all(), [{ n: 1 }]);
    }
    finally { await orphan?.close(); await pool.close(); await rm(folder, { recursive: true }); }
  });

  it('never closes a writer while its submitted commit is awaiting acknowledgement', async () => {
    const { workerPoolDriver } = await import('../../packages/db/src/drivers/worker-pool.js');
    let commitResolve;
    let commitEntered;
    const entered = new Promise((resolve) => { commitEntered = resolve; });
    const commit = new Promise((resolve) => { commitResolve = resolve; });
    let closed = 0;
    const fake = { capabilities: {}, generation: 1, exec: (sql) => {
      if (sql.startsWith('RELEASE')) { commitEntered(); return commit; }
    }, close: () => { closed++; } };
    const pool = await workerPoolDriver({ readers: 0, graceMs: 1 }, () => ({ open: async () => fake })).open();
    const transaction = pool.transaction(async () => {});
    await entered;
    const closing = pool.close();
    // Drain the event loop past the explicit grace, while the commit remains held.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(closed, 0);
    commitResolve();
    await transaction;
    await closing;
    assert.equal(closed, 1);
  });
});

describe('pool close admission', () => {
  it('refuses queued reads, closes an abandoned reader after grace, and reports no healthy worker', async () => {
    const { connection, close } = await fixture({ readers: 1, graceMs: 1 });
    const statement = connection.prepare('SELECT 1 AS n', { readOnly: true });
    const cursor = await statement.iterate();
    const queued = assert.rejects(statement.get(), { code: 'JD2063' });
    await close();
    await queued;
    await assert.rejects(async () => cursor.next(), { code: 'JD2063' });
    assert.equal(connection.metrics().active, 0);
    assert.ok(connection.metrics().workers.every((worker) => !worker.healthy));
  });
});

describe('pool transaction loss and replacement failure', () => {
  it('holds a failed transaction on its old worker until rollback settles and never replays the body', async () => {
    const { workerPoolDriver } = await import('../../packages/db/src/drivers/worker-pool.js');
    const { nodeWorkerDriver } = await import('../../packages/db/src/drivers/node-worker.js');
    const folder = await mkdtemp(join(tmpdir(), 'jaren-pool-tx-fault-'));
    const opened = [];
    const driver = nodeWorkerDriver();
    const pool = await workerPoolDriver({ readers: 1 }, () => ({ open: async (...args) => {
      const connection = await driver.open(...args); opened.push(connection); return connection;
    } })).open(join(folder, 'db.sqlite'));
    let replacement;
    let bodies = 0;
    try {
      await pool.exec('CREATE TABLE t(n)');
      await assert.rejects(pool.transaction(async (scope) => {
        bodies++;
        await scope.exec('INSERT INTO t VALUES(1)');
        await scope.transaction(async (inner) => {
          replacement = await opened[0].restart();
          assert.equal(opened.length, 2, 'no pool replacement while the scope owns its failed lease');
          await inner.exec('INSERT INTO t VALUES(2)');
        });
      }), { code: 'JD2090', retryable: false });
      assert.equal(bodies, 1);
      assert.equal(opened.length, 3, 'replacement follows rollback settlement');
      assert.deepEqual(await pool.prepare('SELECT n FROM t', { readOnly: true }).all(), []);
    }
    finally { await replacement?.close(); await pool.close(); await rm(folder, { recursive: true }); }
  });
  it('refuses admission with the actual replacement error when a lost slot cannot reopen', async () => {
    const { workerPoolDriver } = await import('../../packages/db/src/drivers/worker-pool.js');
    let opens = 0;
    const unavailable = new Error('replacement unavailable');
    const lost = Object.assign(new Error('generation lost'), { code: 'JD2090' });
    const pool = await workerPoolDriver({ readers: 0 }, () => ({ open: async () => {
      if (opens++ > 0) throw unavailable;
      return { capabilities: {}, generation: 1, close: async () => {}, exec: async () => { throw lost; } };
    } })).open();
    await assert.rejects(pool.exec('SELECT 1'), (error) => error === lost);
    await assert.rejects(pool.exec('SELECT 1'), (error) => error === unavailable);
    assert.equal(pool.metrics().workers[0].healthy, false);
    await pool.close();
  });
});
