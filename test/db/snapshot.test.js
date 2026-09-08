//@ts-check
import { describe, it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import init from '@sqlite.org/sqlite-wasm';
import { openStore } from '@jarenjs/db';
import { wasmDriver } from '@jarenjs/db/wasm';
import { snapshotHandle } from '../../packages/db/src/drivers/indexeddb-snapshot.js';

let sqlite3;
before(async () => { sqlite3 = await init({ print: () => {}, printErr: () => {} }); });
const model = { $model: '0.1', collections: { notes: { key: '/id', schema: {
  type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' } },
} } } };
function storage() {
  const rows = new Map();
  let failure = null;
  let paused = null;
  return {
    rows,
    fail: (error) => { failure = error; },
    pause: (promise) => { paused = promise; },
    read: async (key) => rows.get(key),
    write: async (key, bytes, revision) => {
      if (paused !== null) await paused;
      if (failure !== null) throw failure;
      assert.equal(rows.get(key)?.revision ?? 0, revision);
      rows.set(key, { bytes: bytes.slice(), revision: revision + 1 });
      return revision + 1;
    },
    close() {},
  };
}
describe('bounded durable SQLite snapshots', () => {
  it('preserves Store values and session capture across close/reopen', async () => {
    const disk = storage();
    const driver = wasmDriver(snapshotHandle(sqlite3, { openStorage: async () => disk }));
    let store = await openStore(model, { driver, path: 'db', capture: true });
    assert.equal(store.capabilities.live, false);
    assert.equal(store.sync, undefined);
    assert.equal(store.capabilities.sessions, true);
    await store.collection('notes').insert({ id: 'a', body: 'durable' });
    await store.close();
    store = await openStore(model, { driver, path: 'db', capture: true });
    assert.deepEqual(await store.collection('notes').get('a'), { id: 'a', body: 'durable' });
    await store.close();
  });
  it('acknowledges only after atomic storage, and failed persistence leaves the previous version', async () => {
    const disk = storage();
    const driver = wasmDriver(snapshotHandle(sqlite3, { openStorage: async () => disk }));
    let store = await openStore(model, { driver, path: 'db', capture: true });
    await store.collection('notes').insert({ id: 'a', body: 'before' });
    const previous = disk.rows.get('db').bytes.slice();
    disk.fail(new Error('quota denied'));
    await assert.rejects(store.collection('notes').put({ id: 'a', body: 'uncommitted' }), { code: 'JD2094' });
    await assert.rejects(store.collection('notes').get('a'), { code: 'JD2094' });
    assert.deepEqual(disk.rows.get('db').bytes, previous);
    await store.close();
    disk.fail(null);
    store = await openStore(model, { driver, path: 'db' });
    assert.equal((await store.collection('notes').get('a')).body, 'before');
    const release = Promise.withResolvers();
    disk.pause(release.promise);
    let settled = false;
    const write = store.collection('notes').put({ id: 'a', body: 'acknowledged' }).then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    release.resolve();
    await write;
    await store.close();
  });
  it('refuses an oversized snapshot and read-only writes before publishing another version', async () => {
    const disk = storage();
    const driver = wasmDriver(snapshotHandle(sqlite3, { openStorage: async () => disk, maxBytes: 32768 }));
    let store = await openStore(model, { driver, path: 'db' });
    await assert.rejects(store.collection('notes').insert({ id: 'huge', body: 'x'.repeat(100000) }), { code: 'JD2094' });
    await store.close();
    store = await openStore(model, { driver, path: 'db', readOnly: true });
    await assert.rejects(store.collection('notes').insert({ id: 'readonly' }), { code: 'JD2083' });
    await store.close();
  });
});
