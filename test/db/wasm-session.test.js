//@ts-check
import { describe, it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import init from '@sqlite.org/sqlite-wasm';
import { openStore, parseChangeset } from '@jarenjs/db';
import { wasmDriver, sqlite3Handle, adaptOo1Database } from '@jarenjs/db/wasm';
import { wasmSessions } from '../../packages/db/src/drivers/wasm-session.js';

let sqlite3;
before(async () => { sqlite3 = await init({ print: () => {}, printErr: () => {} }); });
const model = { $model: '0.1', collections: { notes: { key: '/id', schema: {
  type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' } },
} } } };

describe('wasm session probing and cleanup', () => {
  it('probes a live handle, transfers detached changeset bytes and closes every session once', () => {
    const db = new sqlite3.oo1.DB(':memory:');
    const capi = { ...sqlite3.capi };
    let creates = 0;
    let deletes = 0;
    capi.sqlite3session_create = (...args) => { creates++; return sqlite3.capi.sqlite3session_create(...args); };
    capi.sqlite3session_delete = (...args) => { deletes++; return sqlite3.capi.sqlite3session_delete(...args); };
    const raw = adaptOo1Database({ ...sqlite3, capi }, db);
    assert.equal(creates, 1);
    assert.equal(deletes, 1);
    raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)');
    const session = raw.session('t');
    raw.exec("INSERT INTO t VALUES(1, 'é😀')");
    const bytes = session.changeset();
    const transferred = structuredClone(bytes, { transfer: [bytes.buffer] });
    assert.equal(bytes.byteLength, 0);
    assert.equal(parseChangeset(transferred)[0].newValues[1], 'é😀');
    session.close();
    session.close();
    raw.session();
    raw.close();
    assert.equal(creates, 3);
    assert.equal(deletes, 3);
  });
  it('missing or failed bindings report a named reason and no leaked handle', async () => {
    const db = new sqlite3.oo1.DB(':memory:');
    const missing = wasmSessions({ ...sqlite3, capi: {} }, db);
    assert.equal(missing.session, undefined);
    assert.match(missing.reason, /lacks/);
    const capi = { ...sqlite3.capi, sqlite3session_attach: () => 1 };
    let deleted = 0;
    capi.sqlite3session_delete = (pointer) => { deleted++; sqlite3.capi.sqlite3session_delete(pointer); };
    const failed = wasmSessions({ ...sqlite3, capi }, db);
    assert.equal(failed.session, undefined);
    assert.match(failed.reason, /probe failed/);
    assert.equal(deleted, 1);
    db.close();
    const driver = wasmDriver(sqlite3Handle({ ...sqlite3, capi }));
    const store = await openStore(model, { driver, capture: true });
    assert.equal(store.capabilities.sessions, false);
    assert.equal(store.capabilities.capture, 'journal');
    await store.collection('notes').insert({ id: 'a', body: 'fallback' });
    assert.equal((await store.collection('notes').get('a')).body, 'fallback');
    await store.close();
  });
  it('session and journal capture agree over commits, rollbacks, coalescing and deletes', async () => {
    const results = [];
    for (const mode of ['session', 'journal']) {
      const store = await openStore(model, { driver: wasmDriver(sqlite3Handle(sqlite3)), capture: { mode } });
      const records = [];
      store.observe((record) => records.push(record.patch));
      await store.collection('notes').insert({ id: 'a', body: 'before' });
      await store.transaction(async (tx) => {
        await tx.collection('notes').put({ id: 'a', body: 'after' });
        await tx.collection('notes').insert({ id: 'b', body: 'transient' });
        await tx.collection('notes').delete('b');
        await assert.rejects(tx.transaction(async (nested) => {
          await nested.collection('notes').put({ id: 'a', body: 'rollback' });
          throw new Error('rollback');
        }), /rollback/);
      });
      await store.collection('notes').delete('a');
      results.push(records);
      await store.close();
    }
    assert.deepEqual(results[0], results[1]);
  });
});

describe('session allocation failure after a successful probe', () => {
  it('does not leave the next capture extent nested in the failed allocation', async () => {
    let fail = false;
    const capi = { ...sqlite3.capi,
      sqlite3session_create: (...args) => fail ? 1 : sqlite3.capi.sqlite3session_create(...args),
    };
    const store = await openStore(model, { driver: wasmDriver(sqlite3Handle({ ...sqlite3, capi })), capture: true });
    try {
      fail = true;
      await assert.rejects(store.collection('notes').insert({ id: 'lost' }), /session API failed/);
      fail = false;
      const changes = [];
      store.observe((record) => changes.push(record));
      await store.collection('notes').insert({ id: 'next', body: 'captured' });
      assert.equal(changes.length, 1);
      assert.equal(await store.collection('notes').get('lost'), undefined);
    }
    finally { await store.close(); }
  });
});
