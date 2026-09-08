//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { nodeWorkerDriver } from '../../packages/db/src/drivers/node-worker.js';
import { validRequest, validResponse, validResult, rowBytes } from '../../packages/db/src/drivers/worker-protocol.js';

const model = { $model: '0.1', entities: { Item: { schema: {
  type: 'object', required: ['id'], properties: {
    id: { type: 'integer', 'x-entity': { key: true } },
    rank: { type: 'integer', 'x-entity': { index: true } },
    body: { type: 'string' },
  },
} } } };
const query = { $for: { i: '$.Item[*]' }, $orderby: '$i.id', $return: '$i' };

describe('Node worker protocol and lifecycle', () => {
  it('validates version, generation, opaque identities and credits', () => {
    const base = { v: 1, generation: 1, id: 1, kind: 'request', op: 'next', cursor: 2, rows: 3, bytes: 100 };
    assert.equal(validRequest(base), true);
    for (const mutation of [{ v: 2 }, { generation: 0 }, { id: -1 }, { op: 'eval' },
      { cursor: 'sql' }, { rows: Infinity }, { bytes: 0 }, { kind: 'result' }])
      assert.equal(validRequest({ ...base, ...mutation }), false);
    assert.equal(validRequest(null), false);
    assert.equal(validResponse({ v: 1, generation: 1, id: 1, kind: 'result', value: 3 }, 1), true);
    for (const frame of [null, {}, { v: 1, generation: 1, id: 1, kind: 'failure', error: null },
      { v: 1, generation: 2, id: 1, kind: 'result' }]) assert.equal(validResponse(frame, 1), false);
    const limits = { rows: 1, bytes: 100 };
    assert.equal(validResult('next', { rows: [], bytes: 0, done: true }, limits), true);
    for (const value of [null, { rows: [1, 2], bytes: 2, done: false },
      { rows: [1], bytes: 0, done: false }, { rows: [], bytes: 0, done: false }])
      assert.equal(validResult('next', value, limits), false);
    assert.equal(rowBytes(new Uint8Array(17)), 17);
  });
  it('streams by hard row/byte credits and bounds all() without one whole-result frame', async () => {
    const connection = await nodeWorkerDriver({ windowRows: 3, windowBytes: 100, allMaxRows: 5 }).open();
    try {
      const statement = await connection.prepare('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<20) SELECT x FROM n');
      const cursor = await statement.iterate();
      const values = [];
      for await (const row of cursor) values.push(row.x);
      assert.equal(values.length, 20);
      const metrics = connection.metrics();
      assert.ok(metrics.frames >= 7);
      assert.ok(metrics.maxFrameRows <= 3);
      assert.ok(metrics.maxFrameBytes <= 100);
      await assert.rejects(statement.all(), { code: 'JD2092' });
      const large = await connection.prepare("SELECT printf('%200s', 'a') AS text");
      await assert.rejects(large.get(), { code: 'JD2092' });
      const tooLarge = await large.iterate();
      await assert.rejects(tooLarge.next(), { code: 'JD2092' });
      await tooLarge.return();
    }
    finally { await connection.close(); }
  });
  it('restart fences statements and cursors; no write is replayed', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'jaren-worker-'));
    const driver = nodeWorkerDriver({ windowRows: 1 });
    const connection = await driver.open(join(folder, 'db.sqlite'));
    let restarted;
    try {
      await connection.exec('CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1), (2)');
      const statement = await connection.prepare('SELECT n FROM t');
      const cursor = await statement.iterate();
      assert.equal((await cursor.next()).value.n, 1);
      restarted = await connection.restart();
      assert.equal(restarted.generation, connection.generation + 1);
      await assert.rejects(statement.get(), { code: 'JD2090', retryable: true });
      await assert.rejects(cursor.next(), { code: 'JD2090', retryable: true });
      assert.deepEqual(await (await restarted.prepare('SELECT n FROM t')).all(), [{ n: 1 }, { n: 2 }]);
    }
    finally { await restarted?.close(); await connection.close().catch(() => {}); await rm(folder, { recursive: true }); }
  });
  it('transaction restart is non-retryable and the lost write rolls back', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'jaren-worker-tx-'));
    const connection = await nodeWorkerDriver().open(join(folder, 'db.sqlite'));
    let restarted;
    let bodies = 0;
    try {
      await connection.exec('CREATE TABLE t (n INTEGER)');
      await assert.rejects(connection.transaction(async (scope) => {
        bodies++;
        await scope.exec('INSERT INTO t VALUES (1)');
        await scope.transaction(async () => {});
        restarted = await connection.restart();
        await scope.exec('INSERT INTO t VALUES (2)');
      }), (error) => error.code === 'JD2090' || error.cause?.code === 'JD2090');
      assert.equal(bodies, 1);
      assert.deepEqual(await (await restarted.prepare('SELECT n FROM t')).all(), []);
      await assert.rejects(connection.exec('SELECT 1'), { code: 'JD2090', retryable: false });
    }
    finally { await restarted?.close(); await connection.close().catch(() => {}); await rm(folder, { recursive: true }); }
  });
  it('queue overflow is deterministic and reports its depth', async () => {
    const connection = await nodeWorkerDriver({ maxPending: 1 }).open();
    try {
      const first = connection.exec('SELECT 1');
      await assert.rejects(connection.exec('SELECT 2'), { code: 'JD2091', retryable: true, depth: 1 });
      await first;
    }
    finally { await connection.close(); }
  });
  it('releases ephemeral statements so repeated short cursors stay within capacity', async () => {
    const connection = await nodeWorkerDriver({ maxStatements: 2 }).open();
    for (let i = 0; i < 20; i++) {
      const statement = await connection.prepare('SELECT 1 AS n UNION ALL SELECT 2', { ephemeral: true });
      const cursor = await statement.iterate();
      await cursor.next();
      await cursor.return();
    }
    await connection.close();
    await connection.close();
    await assert.rejects(async () => connection.exec('SELECT 1'), { code: 'JD2063' });
  });
});

describe('common Store corpus on in-process and worker connections', () => {
  for (const driver of [nodeDriver(), nodeWorkerDriver({ windowRows: 2 })]) {
    it(driver.name, async () => {
      const store = await openStore(model, { driver, capture: { mode: 'journal', log: true } });
      try {
        const items = store.entity('Item');
        for (let id = 1; id <= 7; id++) await items.create({ id, rank: id % 3, body: 'é😀' });
        assert.deepEqual(await items.get(1), { id: 1, rank: 1, body: 'é😀' });
        await assert.rejects(items.create({ id: 1 }), { code: 'JD2001' });
        const seen = [];
        for await (const item of items.cursor(query)) seen.push(item.id);
        assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7]);
        const first = await items.page({ orderBy: '$it.rank' }, { limit: 2 });
        assert.deepEqual(first.items.map((item) => item.id), [3, 6]);
        assert.equal(first.hasMore, true);
        await assert.rejects(store.transaction(async (tx) => {
          await tx.entity('Item').update(1, { body: 'rolled back' });
          throw new Error('rollback');
        }), /rollback/);
        assert.equal((await items.get(1)).body, 'é😀');
        await store.transaction(async (tx) => {
          await tx.entity('Item').update(1, { body: 'committed' });
          await tx.transaction(async (nested) => { await nested.entity('Item').delete(7); });
        });
        assert.equal((await items.get(1)).body, 'committed');
        assert.equal(await items.get(7), undefined);
        assert.ok((await store.changesSince(0)).length > 0);
        const abort = new AbortController();
        const cursor = items.loadCursor({}, { signal: abort.signal });
        await cursor.next();
        abort.abort();
        await assert.rejects(cursor.next(), { code: 'JD2072' });
        await cursor.return();
      }
      finally { await store.close(); }
    });
  }
});

describe('bounded worker shutdown', () => {
  it('forces shutdown of a native statement still running at the deadline and settles every pending caller', async () => {
    const connection = await nodeWorkerDriver({ closeTimeoutMs: 20, maxPending: 1 }).open();
    assert.equal(connection.mustQueue, false);
    const statement = await connection.prepare('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5000000) SELECT sum(x) FROM n');
    const iterator = await statement.iterate();
    const pulling = assert.rejects(iterator.next(), { code: 'JD2090' });
    // The pull posts before close, so the endpoint cannot acknowledge close
    // until SQLite yields. The shutdown outcome is fenced meanwhile.
    await Promise.resolve();
    const closing = connection.close();
    assert.equal(connection.close(), closing);
    await assert.rejects(closing, { code: 'JD2090' });
    await pulling;
    assert.equal(connection.metrics().pending, 0);
    assert.equal(connection.metrics().healthy, false);
  });
});
