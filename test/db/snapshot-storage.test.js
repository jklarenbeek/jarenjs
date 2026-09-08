//@ts-check
/** Deterministic IDB transaction fixture; real engines exercise the same adapter in storage.spec.js. */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import init from '@sqlite.org/sqlite-wasm';
import { indexedDbSnapshotHandle, openSnapshotStorage, wasmDriver } from '@jarenjs/db/wasm';

function indexedFixture() {
  const records = new Map();
  let quota = false;
  let closes = 0;
  const db = {
    createObjectStore() {},
    close() { closes++; },
    transaction() {
      const changes = new Map(records);
      let aborted = false;
      const tx = {
        abort() { aborted = true; queueMicrotask(() => tx.onabort()); },
        objectStore: () => ({
          get(key) {
            const request = {};
            queueMicrotask(() => {
              request.result = changes.get(key);
              request.onsuccess();
              queueMicrotask(() => {
                if (aborted) return;
                records.clear();
                for (const [key, value] of changes) records.set(key, value);
                tx.oncomplete();
              });
            });
            return request;
          },
          put(value, key) { if (quota) throw new Error('quota'); changes.set(key, structuredClone(value)); },
          delete(key) { changes.delete(key); },
        }),
      };
      return tx;
    },
  };
  return {
    records, db,
    get closes() { return closes; },
    quota(value) { quota = value; },
    open() {
      const request = { result: db };
      queueMicrotask(() => { request.onupgradeneeded(); request.onsuccess(); });
      return request;
    },
  };
}

describe('versioned IndexedDB storage transactions', () => {
  it('publishes only completed versions, refuses stale writers, and preserves old bytes after quota failure', async () => {
    const fixture = indexedFixture();
    const storage = await openSnapshotStorage(fixture, 'test');
    assert.equal(await storage.read('db'), null);
    assert.equal(await storage.write('db', new Uint8Array([1, 2]), 0), 1);
    await assert.rejects(storage.write('db', new Uint8Array([3]), 0), /another connection/);
    fixture.quota(true);
    await assert.rejects(storage.write('db', new Uint8Array([4]), 1), /quota/);
    assert.deepEqual((await storage.read('db')).bytes, new Uint8Array([1, 2]));
    fixture.quota(false);
    await storage.remove('db');
    assert.equal(await storage.read('db'), null);
    fixture.db.onversionchange();
    storage.close();
    assert.equal(fixture.closes, 2);
    await assert.rejects(openSnapshotStorage(undefined, 'absent'), /unavailable/);
    const failure = new Error('opening denied');
    const request = { error: failure };
    const opening = openSnapshotStorage({ open: () => request }, 'denied');
    request.onerror();
    await assert.rejects(opening, (error) => error === failure);
  });

  it('closes a blocked open that succeeds after its rejection', async () => {
    let closes = 0;
    const request = { result: { close: () => { closes++; } } };
    const pending = openSnapshotStorage({ open: () => request }, 'blocked');
    request.onblocked();
    await assert.rejects(pending, /blocked/);
    request.onsuccess();
    assert.equal(closes, 1);
  });

  it('the public snapshot handle streams SQL rows and restores its committed database', async () => {
    const sqlite3 = await init({ print: () => {}, printErr: () => {} });
    const indexedDB = indexedFixture();
    const driver = wasmDriver(indexedDbSnapshotHandle(sqlite3, { indexedDB, name: 'test' }));
    let connection = await driver.open('db');
    await connection.exec('CREATE TABLE t(n); INSERT INTO t VALUES(7), (9)');
    const iterator = (await connection.prepare('SELECT n FROM t ORDER BY n')).iterate();
    assert.equal((await iterator.next()).value.n, 7);
    await iterator.return();
    await connection.close();
    connection = await driver.open('db');
    assert.deepEqual(await (await connection.prepare('SELECT n FROM t ORDER BY n')).all(), [{ n: 7 }, { n: 9 }]);
    await connection.close();
    indexedDB.records.set('db', { revision: -1, bytes: new Uint8Array(1) });
    await assert.rejects(driver.open('db'), { code: 'JD2094' });
  });
});
