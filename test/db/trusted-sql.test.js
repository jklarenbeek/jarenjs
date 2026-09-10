//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, DB_CODES } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { wasmDriver } from '@jarenjs/db/wasm';
import { asyncWasmHandle } from './helpers.js';

const model = { $model: '0.1', entities: { Item: { schema: { type: 'object', properties: {
  id: { type: 'string', 'x-entity': { key: true } }, count: { type: 'integer' },
} } } } };

it('SQL, entity and jobs use one connection and co-commit or co-rollback', async () => {
  let opens = 0;
  const driver = { ...nodeDriver(), open: (...args) => { opens++; return nodeDriver().open(...args); } };
  const store = await openStore(model, { driver, jobs: true });
  let escaped;
  try {
    for (const failAt of ['sql', 'entity', 'job', null]) {
      const attempt = store.transaction(async (tx) => {
        escaped = tx.sql.prepare('INSERT INTO "Item"(id,count,doc) VALUES (?, ?, jsonb(?))', { access: 'write' });
        await escaped.run(['one', 1, '{}']);
        if (failAt === 'sql') throw new Error('injected');
        await tx.entity('Item').update('one', { count: 2 });
        if (failAt === 'entity') throw new Error('injected');
        await tx.jobs.enqueue('publish', { id: 'one' }, { id: 'out' });
        if (failAt === 'job') throw new Error('injected');
      }, { mode: 'immediate', unitOfWork: 'own' });
      if (failAt) {
        await assert.rejects(attempt, /injected/);
        assert.equal(await store.entity('Item').get('one'), undefined);
        assert.equal(await store.jobs.get('out'), undefined);
      }
      else await attempt;
    }
    assert.equal(opens, 1);
    assert.equal((await store.entity('Item').get('one')).count, 2);
    assert.ok(await store.jobs.get('out'));
    assert.throws(() => escaped.run(['two', 3, '{}']), { code: 'JD2070' });
  }
  finally { await store.close(); }
});

it('nested SQL rollback retains outer writes and rejects ownership escapes', async () => {
  const store = await openStore(model, { driver: nodeDriver() });
  try {
    await store.transaction(async (tx) => {
      await tx.entity('Item').create({ id: 'outer', count: 1 });
      await assert.rejects(tx.transaction(async (inner) => {
        inner.sql.prepare('UPDATE "Item" SET count=?', { access: 'write' }).run([8]);
        throw new Error('withdraw');
      }), /withdraw/);
      assert.equal((await tx.entity('Item').get('outer')).count, 1);
      for (const sql of ['COMMIT', 'PRAGMA foreign_keys=OFF', 'SELECT 1; DELETE FROM Item', 'ATTACH DATABASE ? AS x'])
        assert.throws(() => tx.sql.prepare(sql, { access: 'write' }), { code: 'JD2095' });
      assert.throws(() => tx.sql.prepare('UPDATE Item SET count=9', { access: 'read' }), { code: 'JD2095' });
      const s = tx.sql.prepare('SELECT count FROM Item', { access: 'read' });
      assert.equal(s.get([]).count, 1);
      assert.deepEqual(s.all([]).map((row) => ({ ...row })), [{ count: 1 }]);
      s.close();
      assert.throws(() => s.get([]), { code: 'JD2095' });
    });
    assert.ok(Object.hasOwn(DB_CODES, 'JD2095'));
  }
  finally { await store.close(); }
});

it('sync callbacks reject thenables and all post-return SQL refuses', async () => {
  const store = await openStore(model, { driver: nodeDriver() });
  let continuation;
  try {
    assert.throws(() => store.sync.transaction((tx) => {
      tx.sync.entity('Item').create({ id: 'withdraw', count: 1 });
      continuation = Promise.resolve().then(() => tx.sql.prepare('SELECT 1', { access: 'read' }));
      return continuation;
    }, { mode: 'immediate' }), { code: 'JD2095' });
    await assert.rejects(continuation, { code: 'JD2070' });
    assert.equal(await store.entity('Item').get('withdraw'), undefined);
  }
  finally { await store.close(); }
});

it('unknown SQL writes invalidate clean tracking and refuse pending changes or incomplete capture', async () => {
  const store = await openStore(model, { driver: nodeDriver() });
  try {
    await store.entity('Item').create({ id: 'one', count: 1 });
    await store.transaction((tx) => tx.sql.prepare('UPDATE Item SET count=2', { access: 'write' }).run([]));
    assert.equal((await store.entity('Item').get('one')).count, 2);
    store.entity('Item').put({ id: 'one', count: 3 });
    await assert.rejects(store.transaction((tx) => tx.sql.prepare('UPDATE Item SET count=4', { access: 'write' }).run([])), { code: 'JD2040' });
  }
  finally { await store.close(); }
  const captured = await openStore(model, { driver: nodeDriver(), capture: true });
  try {
    await assert.rejects(captured.transaction((tx) => tx.sql.prepare('DELETE FROM Item', { access: 'write' }).run([])), { code: 'JD0051' });
  }
  finally { await captured.close(); }
});

it('async-only hosts share prepared statements with entities and offer no synchronous scope', async () => {
  const { nodeWorkerDriver } = await import('@jarenjs/db/node-worker');
  const store = await openStore(model, { driver: nodeWorkerDriver() });
  try {
    assert.equal(store.sync, undefined);
    await store.transaction(async (tx) => {
      assert.equal(tx.sync, undefined);
      await tx.sql.prepare('INSERT INTO Item(id,count,doc) VALUES(?,?,jsonb(?))', { access: 'write' }).run(['async', 1, '{}']);
      assert.equal((await tx.entity('Item').get('async')).count, 1);
      const s = tx.sql.prepare('SELECT count FROM Item', { access: 'read' });
      assert.equal((await s.get([])).count, 1);
      s.close();
    });
  }
  finally { await store.close(); }
});

it('unrelated requests wait for SQL scope settlement and failed commit withdraws SQL, entity and jobs', async () => {
  const driver = { ...nodeDriver(), open: async (...args) => {
    const db = await nodeDriver().open(...args);
    db.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)');
    return db;
  } };
  const store = await openStore(model, { driver, jobs: true });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  try {
    const pending = store.transaction(async (tx) => {
      tx.sql.prepare('INSERT INTO Item(id,count,doc) VALUES(?,?,jsonb(?))', { access: 'write' }).run(['withdraw', 1, '{}']);
      await tx.entity('Item').update('withdraw', { count: 2 });
      await tx.jobs.enqueue('publish', {}, { id: 'withdraw-job' });
      tx.sql.prepare('INSERT INTO child VALUES(1,99)', { access: 'write' }).run([]);
      entered.resolve(); await release.promise;
    }, { mode: 'immediate' });
    const refused = assert.rejects(pending, /FOREIGN KEY constraint failed/);
    await entered.promise;
    let joined = false;
    const unrelated = store.entity('Item').get('withdraw').then((row) => { joined = true; return row; });
    await Promise.resolve(); assert.equal(joined, false);
    release.resolve(); await refused;
    assert.equal(await unrelated, undefined);
    assert.equal(await store.jobs.get('withdraw-job'), undefined);
    assert.equal(await store.entity('Item').get('withdraw'), undefined);
  }
  finally { release.resolve(); await store.close(); }
});


it('a delayed statement preparation cannot execute SQL after its transaction settled', async () => {
  const ready = Promise.withResolvers();
  const handle = asyncWasmHandle();
  const driver = wasmDriver({ ...handle, open: async (...args) => {
    const raw = await handle.open(...args);
    return { ...raw, prepare: (sql, options) => /^INSERT INTO Item/.test(sql)
      ? ready.promise.then(() => raw.prepare(sql, options)) : raw.prepare(sql, options) };
  } });
  const store = await openStore(model, { driver });
  let pending;
  try {
    await store.transaction((tx) => {
      pending = tx.sql.prepare('INSERT INTO Item(id,count,doc) VALUES(?,?,jsonb(?))', { access: 'write' }).run(['escaped', 1, '{}']);
    });
    assert.equal(typeof pending.then, 'function');
    ready.resolve();
    await assert.rejects(pending, { code: 'JD2070' });
    assert.equal(await store.entity('Item').get('escaped'), undefined);
  }
  finally { ready.resolve(); await store.close(); }
});
