//@ts-check
/**
 * @file Session-mode change capture: the probed scenario, net-op
 * coalescing, minimal nested diffs, the savepoint-rollback edge (the
 * classic session caveat, pinned NOT to hold here), observer
 * ordering/isolation, the persisted log with retention and reopen
 * continuity, entity column semantics (booleans, epoch, absence),
 * hostile keys in pointers, and the cross-connection data_version
 * signal.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import { openStore, CHANGES_TABLE } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    notes: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, body: { type: 'string' },
        meta: { type: 'object' } } },
      key: '/id',
      indexes: [{ name: 'by_body', path: '$.body' }],
    },
  },
  entities: {
    Item: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          n: { type: 'integer' },
          on: { type: 'boolean' },
          when: { type: 'string', format: 'date-time', 'x-entity': { column: 'integer' } },
          extra: { type: 'object' },
        },
      },
    },
    Grade: {
      schema: {
        type: 'object',
        required: ['student', 'course'],
        properties: {
          student: { type: 'string', 'x-entity': { key: true } },
          course: { type: 'string', 'x-entity': { key: true } },
          score: { type: 'integer' },
        },
      },
    },
  },
};

const open = (extra = {}) => openStore(MODEL,
  { driver: nodeDriver(), capture: true, ...extra });
const sortOps = (patch) => [...patch]
  .sort((a, b) => (a.path + a.op < b.path + b.op ? -1 : 1));

describe('session capture', () => {
  it('the probed scenario: insert, update and delete in one transaction', async () => {
    const store = await open();
    const seen = [];
    store.observe((record) => seen.push(record));
    const notes = store.collection('notes');
    await notes.insert({ id: 'a', body: 'one', meta: { k: 1 } });
    await notes.insert({ id: 'b', body: 'two' });
    await store.transaction(async () => {
      await notes.put({ id: 'a', body: 'ONE', meta: { k: 1 } }, 'a');
      await notes.insert({ id: 'c', body: 'three' });
      await notes.delete('b');
    });
    assert.strictEqual(seen.length, 3);
    assert.deepStrictEqual(seen.map((record) => record.seq), [1, 2, 3]);
    assert.deepStrictEqual(sortOps(seen[2].patch), sortOps([
      { op: 'replace', path: '/notes/a/body', value: 'ONE' },
      { op: 'add', path: '/notes/c', value: { id: 'c', body: 'three' } },
      { op: 'remove', path: '/notes/b' },
    ]));
    assert.deepStrictEqual(seen[2].collections.sort(), ['notes']);
    assert.strictEqual(seen[2].source, 'session');
    await store.close();
  });

  it('one NET op per row: insert+update coalesce, insert+delete vanish', async () => {
    const store = await open();
    const seen = [];
    store.observe((record) => seen.push(record));
    await store.transaction(async () => {
      const notes = store.collection('notes');
      await notes.insert({ id: 'x', body: 'v1' });
      await notes.put({ id: 'x', body: 'v2' }, 'x');
      await notes.insert({ id: 'gone', body: 'temp' });
      await notes.delete('gone');
    });
    assert.strictEqual(seen.length, 1);
    assert.deepStrictEqual(seen[0].patch, [
      { op: 'add', path: '/notes/x', value: { id: 'x', body: 'v2' } },
    ], 'the net change, nothing else');
    await store.close();
  });

  it('a 10k-row transaction translates iteratively (no stack overflow)', async () => {
    const store = await open();
    const seen = [];
    store.observe((record) => seen.push(record));
    const notes = store.collection('notes');
    await store.transaction(async () => {
      for (let i = 0; i < 10_000; i++) {
        await notes.insert({ id: `n${i}`, body: 'x' });
      }
    });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].patch.length, 10_000,
      'the recursive translation walk overflowed here before the iterative driver');
    await store.close();
  });

  it('a rolled-back transaction emits NOTHING', async () => {
    const store = await open();
    const seen = [];
    store.observe((record) => seen.push(record));
    await assert.rejects(() => store.transaction(async () => {
      await store.collection('notes').insert({ id: 'doomed', body: 'x' });
      throw new Error('abort');
    }), /abort/);
    assert.strictEqual(seen.length, 0);
    assert.strictEqual(await store.collection('notes').get('doomed'), undefined);
    await store.close();
  });

  it('THE EDGE: a caught inner-transaction rollback leaves no trace', async () => {
    const store = await open();
    const seen = [];
    store.observe((record) => seen.push(record));
    await store.transaction(async () => {
      await store.collection('notes').insert({ id: 'kept', body: 'yes' });
      try {
        await store.transaction(async () => {
          await store.collection('notes').insert({ id: 'ghost', body: 'no' });
          throw new Error('inner');
        });
      }
      catch {
        // the caller survives the inner failure; the outer commits
      }
    });
    assert.strictEqual(seen.length, 1);
    assert.deepStrictEqual(seen[0].patch, [
      { op: 'add', path: '/notes/kept', value: { id: 'kept', body: 'yes' } },
    ], 'the undone insert must not appear — sessions drop ROLLBACK TO rows');
    assert.strictEqual(await store.collection('notes').get('ghost'), undefined);
    await store.close();
  });

  it('minimal nested diffs; no-op writes emit nothing', async () => {
    const store = await open();
    const seen = [];
    store.observe((record) => seen.push(record));
    const notes = store.collection('notes');
    await notes.insert({ id: 'n', body: 'b', meta: { deep: { x: 1 }, list: ['a'] } });
    await notes.patch('n', [
      { op: 'replace', path: '/meta/deep/x', value: 2 },
      { op: 'add', path: '/meta/list/-', value: 'b' },
    ]);
    assert.deepStrictEqual(sortOps(seen[1].patch), sortOps([
      { op: 'replace', path: '/notes/n/meta/deep/x', value: 2 },
      { op: 'add', path: '/notes/n/meta/list/1', value: 'b' },
    ]), 'nested ops, never a whole-document replace');
    await notes.put({ id: 'n', body: 'b', meta: { deep: { x: 2 }, list: ['a', 'b'] } }, 'n');
    assert.strictEqual(seen.length, 2, 'an identical rewrite is a no-op');
    await store.close();
  });

  it('entity semantics: booleans, absence, and the derived epoch column', async () => {
    const store = await open();
    const seen = [];
    store.observe((record) => seen.push(record));
    const items = store.entity('Item');
    await items.create({ id: 'i1', n: 1, on: true, when: '2026-01-05T10:00:00Z' });
    assert.deepStrictEqual(seen[0].patch, [{
      op: 'add',
      path: '/Item/i1',
      value: { id: 'i1', n: 1, on: true, when: '2026-01-05T10:00:00Z' },
    }], 'booleans as booleans; the epoch column never leaks');
    await items.update('i1', { on: false, when: '2026-02-01T00:00:00Z', n: undefined });
    const ops = sortOps(seen[1].patch);
    assert.deepStrictEqual(ops, sortOps([
      { op: 'replace', path: '/Item/i1/on', value: false },
      { op: 'replace', path: '/Item/i1/when', value: '2026-02-01T00:00:00Z' },
      { op: 'remove', path: '/Item/i1/n' },
    ]), 'NULL reads as absence; the epoch column contributes no op');
    await store.close();
  });

  it('hostile keys and composite keys keep the pointer contract', async () => {
    const store = await open();
    const seen = [];
    store.observe((record) => seen.push(record));
    await store.collection('notes').insert({ id: 'a~b/c', body: 'esc' });
    assert.strictEqual(seen[0].patch[0].path, '/notes/a~0b~1c');
    await store.entity('Grade').create({ student: 'ada/lovelace', course: 'm~1', score: 9 });
    assert.strictEqual(seen[1].patch[0].path,
      `/Grade/${'["ada/lovelace","m~1"]'.replace(/~/g, '~0').replace(/\//g, '~1')}`);
    await store.entity('Grade').update({ student: 'ada/lovelace', course: 'm~1' }, { score: 10 });
    assert.match(seen[2].patch[0].path, /\/score$/);
    await store.close();
  });

  it('observers: order, isolation, unsubscribe', async () => {
    const store = await open();
    const calls = [];
    store.observe(() => {
      calls.push('thrower');
      throw new Error('observer bug');
    });
    const stop = store.observe((record) => calls.push(`a${record.seq}`));
    store.observe((record) => calls.push(`b${record.seq}`));
    await store.collection('notes').insert({ id: '1', body: 'x' });
    await store.collection('notes').insert({ id: '2', body: 'y' });
    assert.deepStrictEqual(calls,
      ['thrower', 'a1', 'b1', 'thrower', 'a2', 'b2'],
      'commit order; a throwing observer affects neither the write nor the rest');
    stop();
    await store.collection('notes').insert({ id: '3', body: 'z' });
    assert.strictEqual(calls.filter((c) => c.startsWith('a')).length, 2);
    assert.deepStrictEqual(await store.collection('notes').get('1'), { id: '1', body: 'x' });
    await store.close();
  });

  it('the log rides the same transaction, prunes, and survives reopen', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(MODEL, {
        driver: nodeDriver(), path: dbPath,
        capture: { log: { retention: 3 } },
      });
      for (let i = 0; i < 5; i++)
        await store.collection('notes').insert({ id: `n${i}`, body: 'x' });
      const raw = new DatabaseSync(dbPath);
      const rows = raw.prepare(
        `SELECT seq FROM "${CHANGES_TABLE}" ORDER BY seq`).all();
      raw.close();
      assert.deepStrictEqual(rows.map((row) => Number(row.seq)), [3, 4, 5],
        'retention pruned inside the same transactions');
      const tail = await store.changesSince(3);
      assert.deepStrictEqual(tail.map((record) => record.seq), [4, 5]);
      assert.deepStrictEqual(tail[0].patch[0].path, '/notes/n3');
      await store.close();

      const reopened = await openStore(MODEL, {
        driver: nodeDriver(), path: dbPath,
        capture: { log: { retention: 3 } },
      });
      const seen = [];
      reopened.observe((record) => seen.push(record));
      await reopened.collection('notes').insert({ id: 'later', body: 'x' });
      assert.strictEqual(seen[0].seq, 6, 'seq continues across reopen');
      await reopened.close();
    }
    finally {
      cleanup();
    }
  });

  it('capture off: capabilities say none, observe refuses, writes are unwrapped', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    assert.strictEqual(store.capabilities.capture, 'none');
    assert.throws(() => store.observe(() => {}), /capture/);
    await store.collection('notes').insert({ id: 'x', body: 'plain' });
    await assert.rejects(() => store.changesSince?.(0) ?? Promise.reject(new Error('absent')),
      /absent/);
    await store.close();
  });

  it('changesSince without a log is JD2051', async () => {
    const store = await open();
    await assert.rejects(() => store.changesSince(0),
      (error) => /** @type {any} */ (error).code === 'JD2051');
    await store.close();
  });

  it('cross-connection writes are invisible; data_version is the coarse signal', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(MODEL, {
        driver: nodeDriver(), path: dbPath, capture: true });
      const seen = [];
      store.observe((record) => seen.push(record));
      const before = await store.dataVersion();

      const other = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
      await other.collection('notes').insert({ id: 'foreign', body: 'unseen' });
      await other.close();

      assert.strictEqual(seen.length, 0, 'no local patch for a foreign write');
      // the coarse signal: reading THROUGH this connection after the
      // other commit moves data_version
      assert.deepStrictEqual(
        await store.collection('notes').get('foreign'),
        { id: 'foreign', body: 'unseen' });
      const after = await store.dataVersion();
      assert.notStrictEqual(after, before, 'data_version moved');
      await store.close();
    }
    finally {
      cleanup();
    }
  });
});
