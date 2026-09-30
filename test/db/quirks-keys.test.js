//@ts-check
/**
 * @file Key quirks the phase 1 sweep reproduced, each pinned:
 *
 * 1. A string key spelled like a legacy float (`'7.0'`) was taken for
 *    number 7's old-style row: reads of 7 answered it, writes of 7 moved
 *    and overwrote it, `insert(7)` refused with a duplicate that was not.
 * 2. The same spelling test let one float take another's row where an
 *    older SQLite rounded both to fifteen digits (`0.3`, `0.1 + 0.2`).
 * 3. A numeric key's write read before it wrote in a deferred
 *    transaction, so under a concurrent writer it failed busy at once —
 *    the upgrade the busy handler cannot wait out.
 * 4. A migration's key-change check accepted any text that parses to the
 *    number (`'0042'` for 42), leaving a document its key cannot reach.
 * 5. `patch` could rewrite a document's key member, which `put(doc, key)`
 *    refuses.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, planMigration, migrate, sqliteDialect } from '@jarenjs/db';
import { DatabaseSync } from 'node:sqlite';
import { nodeDriver, adaptNodeDatabase } from '@jarenjs/db/node';
import { storedKeyMatches } from '../../packages/db/src/key-text.js';

const RELEASES = { $model: '0.1', collections: { releases: { schema: { type: 'object', properties: { id: {}, label: { type: 'string' } } }, key: '/id', indexes: [] } } };
const coded = (/** @type {string} */ code) => (/** @type {any} */ e) => e?.code === code;

/** A store over `driver` with the raw connection kept, for planting rows. */
async function withRaw(/** @type {any} */ model, /** @type {any} */ options = {}) {
  const driver = nodeDriver();
  /** @type {any} */
  let raw;
  const store = await openStore(model, { driver: { ...driver, open: async (/** @type {any[]} */ ...args) => (raw = await driver.open(...args)) }, ...options });
  return { store, raw };
}

describe('key quirks', () => {
  it('1. the string key "7.0" and the number 7 are two keys', async () => {
    const { store } = await withRaw(RELEASES);
    try {
      const r = store.collection('releases');
      await r.put({ id: '7.0', label: 'the version string' });
      assert.equal(await r.get(7), undefined);
      await r.insert({ id: 7, label: 'the number' });
      assert.deepEqual(await r.get('7.0'), { id: '7.0', label: 'the version string' });
      assert.deepEqual(await r.get(7), { id: 7, label: 'the number' });
      assert.equal(await r.delete(7), true);
      assert.deepEqual(await r.get('7.0'), { id: '7.0', label: 'the version string' }, 'deleting 7 left "7.0" alone');
    }
    finally { await store.close(); }
  });

  it('1b. a genuine legacy row of 7 (stored as "7.0" by a float binding) is still found and converged', async () => {
    const { store, raw } = await withRaw(RELEASES);
    try {
      raw.prepare('INSERT INTO "releases" ("key", "doc") VALUES (?, jsonb(?))').run(['7.0', JSON.stringify({ id: 7, label: 'legacy' })]);
      assert.deepEqual(await store.collection('releases').get(7), { id: 7, label: 'legacy' });
      await store.collection('releases').put({ id: 7, label: 'converged' });
      assert.deepEqual(raw.prepare('SELECT "key" AS k FROM "releases"').all([]).map((/** @type {any} */ row) => row.k), ['7']);
    }
    finally { await store.close(); }
  });

  it('2. a legacy spelling of one float never answers for another', async () => {
    const { store, raw } = await withRaw(RELEASES);
    try {
      // what an older SQLite stored for 0.3: its fifteen-digit spelling, which 0.1 + 0.2 shares
      raw.prepare('INSERT INTO "releases" ("key", "doc") VALUES (?, jsonb(?))').run(['0.3', JSON.stringify({ id: 0.3, label: 'point three' })]);
      assert.equal(await store.collection('releases').get(0.1 + 0.2), undefined);
      await store.collection('releases').put({ id: 0.1 + 0.2, label: 'the sum' });
      assert.deepEqual(await store.collection('releases').get(0.3), { id: 0.3, label: 'point three' }, 'the sum took nothing of 0.3');
    }
    finally { await store.close(); }
  });

  it('3. a numeric key\'s write takes the writer lock before its first read — with capture and without', async () => {
    for (const capture of [undefined, { mode: 'journal' }]) {
      /** @type {string[]} */
      const execs = [];
      const db = new DatabaseSync(':memory:');
      // every statement the driver EXECUTES — transaction control among them
      const recorded = new Proxy(db, { get: (target, prop) => {
        if (prop === 'exec') return (/** @type {string} */ sql) => { execs.push(sql); return target.exec(sql); };
        const value = /** @type {any} */ (target)[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const traced = { name: 'node-sqlite', dialect: sqliteDialect, open: async () => adaptNodeDatabase(recorded) };
      const store = await openStore(RELEASES, { driver: traced, ...(capture === undefined ? {} : { capture }) });
      try {
        execs.length = 0;
        await store.collection('releases').put({ id: 7, label: 'n' });
        const first = execs.find((sql) => /^(BEGIN|SAVEPOINT)/.test(sql));
        assert.equal(first, 'BEGIN IMMEDIATE', `${capture?.mode ?? 'no capture'}: the transaction took the lock up front`);
      }
      finally { await store.close(); }
    }
  });

  it('4. a migration may not move a document to a key that merely parses like its stored one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-keys-'));
    const file = path.join(dir, 'db.sqlite');
    try {
      const target = structuredClone(RELEASES);
      /** @type {any} */ (target.collections.releases.schema.properties).note = { type: 'string' };
      const seeded = await openStore(RELEASES, { driver: nodeDriver(), path: file });
      await seeded.collection('releases').put({ id: '0042', label: 'string key 0042' });
      await seeded.close();
      const { migration } = planMigration(RELEASES, target, { dialect: sqliteDialect, id: '0001-key-type' });
      const step = /** @type {any} */ (migration.steps.find((s) => s.kind === 'jslt'));
      delete step.draft;
      step.stylesheet = [{ match: '$', body: { id: 42, label: '$.label' } }];
      await assert.rejects(migrate({ driver: nodeDriver(), path: file }, [migration], { baseline: RELEASES, model: target }), coded('JD0023'));
      assert.equal(storedKeyMatches(42, '0042'), false);
      assert.equal(storedKeyMatches(1000, '1e3'), false);
      assert.equal(storedKeyMatches(7, '7.00'), false);
      assert.equal(storedKeyMatches(7, '7.0'), true, 'the spelling a float binding stored');
      assert.equal(storedKeyMatches(1e21, '1.0e+21'), true);
      assert.equal(storedKeyMatches(1e-7, '1.0e-07'), true);
      assert.equal(storedKeyMatches(1234567890123456, '1.23456789012346e+15'), false, 'a rounded spelling names another number');
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('5. patch cannot rewrite a document\'s key (JD2002), as put(doc, key) cannot', async () => {
    const store = await openStore({ $model: '0.1', collections: { docs: { schema: { type: 'object', properties: { id: { type: 'string' }, v: { type: 'integer' } } }, key: '/id', indexes: [] } } }, { driver: nodeDriver() });
    try {
      const docs = store.collection('docs');
      await docs.put({ id: 'a', v: 1 });
      await assert.rejects(docs.patch('a', [{ op: 'replace', path: '/id', value: 'b' }]), coded('JD2002'));
      assert.deepEqual(await docs.get('a'), { id: 'a', v: 1 });
      assert.deepEqual(await docs.patch('a', [{ op: 'replace', path: '/v', value: 2 }]), { id: 'a', v: 2 });
    }
    finally { await store.close(); }
  });
});
