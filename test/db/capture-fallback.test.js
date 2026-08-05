//@ts-check
/**
 * @file The journal fallback: for writes made through the store API
 * its op SETS are identical to session mode (a differential test runs
 * the same script through both), the caught-inner-rollback edge holds
 * through the checkpointed buffer, a session-less driver falls back
 * automatically with the capability reported, a demanded session on
 * such a driver refuses at open, and the documented limitation — raw
 * SQL is invisible — is pinned as a fact, not an apology.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { fromBunModule } from '@jarenjs/db/bun';
import { BunShapedDatabase, tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    notes: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, body: { type: 'string' }, meta: { type: 'object' } } },
      key: '/id',
      indexes: [],
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
          extra: { type: 'object' },
          tags: { 'x-entity': { relation: { to: 'Tag', many: true } } },
        },
      },
    },
    Tag: {
      schema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', 'x-entity': { key: true } } },
      },
    },
  },
};

/** The differential script: every write shape in one pass. */
async function script(store) {
  const notes = store.collection('notes');
  const items = store.entity('Item');
  await notes.insert({ id: 'n1', body: 'a', meta: { deep: [1, 2] } });
  await notes.patch('n1', [{ op: 'replace', path: '/meta/deep/1', value: 9 }]);
  await notes.put({ id: 'n2', body: 'b' }, 'n2');
  await items.create({ id: 'i1', n: 1, on: true, extra: { x: 'y' } });
  await store.entity('Tag').create({ name: 't1' });
  await items.update('i1', { n: 2, on: false });
  const item = await items.get('i1');
  items.put({ ...item, n: 3, extra: { x: 'z' }, tags: ['t1'] });
  store.entity('Tag').add({ name: 't2' });
  await store.saveChanges();
  await store.transaction(async () => {
    await notes.delete('n2');
    await items.delete('i1'); // cascades nothing; tags row via UoW below
  });
  // same-row multi-op transactions must NET identically in both modes
  await store.transaction(async () => {
    await notes.insert({ id: 'ghost', body: 'in' });
    await notes.put({ id: 'ghost', body: 'still in' }, 'ghost');
    await notes.delete('ghost'); // insert+update+delete nets to NOTHING
    await notes.insert({ id: 'kept', body: 'v1' });
    await notes.put({ id: 'kept', body: 'v2' }, 'kept'); // nets to one add
    await notes.put({ id: 'n1', body: 'a', meta: { deep: [1, 9] } }, 'n1');
    await notes.put({ id: 'n1', body: 'a', meta: { deep: [1, 2] } }, 'n1');
    await notes.patch('n1', [{ op: 'replace', path: '/meta/deep/1', value: 9 }]);
    // n1 ends exactly where it started: nothing may be emitted for it
  });
  const tagged = await store.entity('Tag').get('t1');
  store.entity('Tag').remove(tagged);
  await store.saveChanges();
}

const canonical = (records) => records.map((record) =>
  [...record.patch].sort((a, b) =>
    ((a.path + a.op) < (b.path + b.op) ? -1 : 1)));

describe('the journal fallback', () => {
  it('produces the SAME op sets as session mode for store-API writes', async () => {
    const viaSession = await openStore(MODEL,
      { driver: nodeDriver(), capture: { mode: 'session' } });
    const viaJournal = await openStore(MODEL,
      { driver: nodeDriver(), capture: { mode: 'journal' } });
    assert.strictEqual(viaSession.capabilities.capture, 'session');
    assert.strictEqual(viaJournal.capabilities.capture, 'journal');
    const fromSession = [];
    const fromJournal = [];
    viaSession.observe((record) => fromSession.push(record));
    viaJournal.observe((record) => fromJournal.push(record));
    await script(viaSession);
    await script(viaJournal);
    assert.strictEqual(fromSession.length, fromJournal.length,
      'the same commits produce the same record count');
    assert.deepStrictEqual(canonical(fromJournal), canonical(fromSession),
      'identical op sets, record by record');
    await viaSession.close();
    await viaJournal.close();
  });

  it('the caught-inner-rollback edge holds in journal mode too', async () => {
    const store = await openStore(MODEL,
      { driver: nodeDriver(), capture: { mode: 'journal' } });
    const seen = [];
    store.observe((record) => seen.push(record));
    await store.transaction(async () => {
      await store.collection('notes').insert({ id: 'kept', body: 'yes' });
      // a SUCCESSFUL nested async transaction keeps its records
      await store.transaction(async () => {
        await store.collection('notes').insert({ id: 'nested-async', body: 'in' });
      });
      try {
        await store.transaction(async () => {
          await store.collection('notes').insert({ id: 'ghost', body: 'no' });
          throw new Error('inner');
        });
      }
      catch {
        // survived — the checkpointed buffer must have truncated
      }
    });
    assert.strictEqual(seen.length, 1);
    assert.deepStrictEqual(
      [...seen[0].patch].sort((a, b) => (a.path < b.path ? -1 : 1)), [
        { op: 'add', path: '/notes/kept', value: { id: 'kept', body: 'yes' } },
        { op: 'add', path: '/notes/nested-async', value: { id: 'nested-async', body: 'in' } },
      ]);
    await store.close();
  });

  it('the same edge through the promise-free twin', async () => {
    const store = await openStore(MODEL,
      { driver: nodeDriver(), capture: { mode: 'journal' } });
    const seen = [];
    store.observe((record) => seen.push(record));
    store.sync.transaction(() => {
      store.sync.collection('notes').insert({ id: 'kept2', body: 'yes' });
      // a SUCCESSFUL nested twin transaction keeps its records
      store.sync.transaction(() => {
        store.sync.collection('notes').insert({ id: 'nested-ok', body: 'in' });
      });
      try {
        store.sync.transaction(() => {
          store.sync.collection('notes').insert({ id: 'ghost2', body: 'no' });
          throw new Error('inner sync');
        });
      }
      catch {
        // survived synchronously
      }
    });
    assert.strictEqual(seen.length, 1);
    assert.deepStrictEqual(
      [...seen[0].patch].sort((a, b) => (a.path < b.path ? -1 : 1)), [
        { op: 'add', path: '/notes/kept2', value: { id: 'kept2', body: 'yes' } },
        { op: 'add', path: '/notes/nested-ok', value: { id: 'nested-ok', body: 'in' } },
      ]);
    await store.close();
  });

  it('a session-less driver falls back automatically under auto', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const driver = {
        name: 'bun-shaped',
        dialect: nodeDriver().dialect,
        open: () => fromBunModule(
          { Database: BunShapedDatabase }, dbPath, {}),
      };
      const store = await openStore(MODEL, { driver, capture: true });
      assert.strictEqual(store.capabilities.capture, 'journal',
        'auto resolves to the journal where no session extension exists');
      const seen = [];
      store.observe((record) => seen.push(record));
      await store.collection('notes').insert({ id: 'x', body: 'works' });
      assert.strictEqual(seen[0].patch[0].path, '/notes/x');
      await store.close();

      await assert.rejects(
        async () => openStore(MODEL, { driver, capture: { mode: 'session' } }),
        /session.*unavailable/,
        'a demanded session on this driver refuses at open');
    }
    finally {
      cleanup();
    }
  });

  it('the documented limitation: raw SQL is invisible to the journal', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(MODEL, {
        driver: nodeDriver(), path: dbPath, capture: { mode: 'journal' } });
      const seen = [];
      store.observe((record) => seen.push(record));
      const raw = new DatabaseSync(dbPath);
      raw.exec(`INSERT INTO notes (key, doc) VALUES ('sneaky', jsonb('{"id":"sneaky"}'))`);
      raw.close();
      assert.strictEqual(seen.length, 0, 'stated plainly in LIVE-FORMAT §4');
      await store.close();
    }
    finally {
      cleanup();
    }
  });
});
