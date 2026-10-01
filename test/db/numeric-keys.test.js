//@ts-check
/**
 * @file One key, one spelling (MODEL-FORMAT §6). A number reaching a
 * TEXT key column is bound as its canonical JSON text on every driver.
 * Before, node:sqlite bound it as a REAL — the column held `'7.0'` —
 * while Bun stored `'7'`: on one file Bun could not find a node-written
 * key and its upsert made a second row; an index-only migration was
 * refused as "a transform changed the key"; session capture recorded
 * `/items/1.0` where journal capture recorded `/items/1`. Files an
 * earlier node write left are still read, converge as they are written,
 * and a key held under both spellings is refused by name. The repair
 * statement MODEL-FORMAT documents is the one this suite runs.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openStore, planModelMigration, migrate, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    items: {
      schema: { type: 'object', properties: { id: {}, label: { type: 'string' } } },
      key: '/id',
      indexes: [],
    },
  },
};

/** @param {string} code */
const coded = (code) => (/** @type {any} */ error) => error?.code === code;

/** A fresh file holding the collection's table, and nothing else. */
async function freshFile() {
  const { dbPath, cleanup } = tempDbPath();
  await (await openStore(MODEL, { driver: nodeDriver(), path: dbPath })).close();
  return { dbPath, cleanup };
}

/**
 * Plant a row exactly as an earlier node write stored it: the number
 * bound as node:sqlite binds it (a REAL, which the TEXT column spells
 * `'7.0'`), or a key text given as a string.
 * @param {string} file
 * @param {number | string} key
 * @param {any} id - the document's key member
 * @param {string} label
 */
function plant(file, key, id, label) {
  const db = new DatabaseSync(file);
  db.prepare('INSERT INTO "items" ("key", "doc") VALUES (?, jsonb(?))').run(key, JSON.stringify({ id, label }));
  db.close();
}

/** @param {string} file @returns {string[]} */
function storedKeys(file) {
  const db = new DatabaseSync(file);
  const rows = db.prepare('SELECT "key" FROM "items" ORDER BY "key"').all();
  db.close();
  return rows.map((row) => String(row.key));
}

describe('a numeric key has one canonical spelling', () => {
  it('is stored as its canonical JSON text and found by every read', async () => {
    const { dbPath, cleanup } = tempDbPath();
    const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
    const items = store.collection('items');
    for (const id of [7, 1.5, -3, 0]) await items.put({ id, label: `n${id}` });
    for (const id of [7, 1.5, -3, 0]) assert.strictEqual((await items.get(id))?.label, `n${id}`);
    await store.close();
    assert.deepStrictEqual(storedKeys(dbPath), ['-3', '0', '1.5', '7']);
    cleanup();
  });

  it('a numeric key must be finite (JD2002)', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const items = store.collection('items');
    await assert.rejects(items.get(Number.NaN), coded('JD2002'));
    await assert.rejects(items.put({ id: Number.POSITIVE_INFINITY }), coded('JD2002'));
    await assert.rejects(items.insert({ id: Number.NaN }), coded('JD2002'));
    await assert.rejects(items.delete(Number.NEGATIVE_INFINITY), coded('JD2002'));
    await store.close();
  });
});

describe('a lookup on a numeric key column by text that is no number', () => {
  const NUMBERED = {
    $model: '0.1',
    collections: { nums: { schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] }, key: '/id', indexes: [] } },
    entities: { Doc: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer', 'x-entity': { key: true } }, t: { type: 'string' } } } } },
  };
  it('names no row: absent, nothing deleted, nothing to patch or update — and decimal text still finds its number', async () => {
    const store = await openStore(NUMBERED, { driver: nodeDriver() });
    try {
      const nums = store.collection('nums');
      await nums.put({ id: 7 });
      for (const key of ['abc', 'NaN', 'Infinity', '0x7', '1_000', '-', '']) {
        assert.strictEqual(await nums.get(key), undefined, key);
        assert.strictEqual(await nums.delete(key), false, key);
        await assert.rejects(Promise.resolve(nums.patch(key, [{ op: 'add', path: '/x', value: 1 }])), coded('JD2006'), key);
      }
      for (const key of ['7', ' 7', '7.0', '+7', '7e0']) assert.deepStrictEqual(await nums.get(key), { id: 7 }, key);
      const docs = store.entity('Doc');
      await docs.create({ id: 7, t: 'x' });
      assert.strictEqual(await docs.get('abc'), undefined);
      assert.strictEqual(await docs.delete('abc'), false);
      await assert.rejects(Promise.resolve(docs.update('abc', { t: 'y' })), coded('JD2006'));
      assert.deepStrictEqual(await docs.get('7'), { id: 7, t: 'x' });
      assert.deepStrictEqual(await nums.all(), [{ id: 7 }], 'nothing was written or removed');
    }
    finally { await store.close(); }
  });
});

describe('a file an earlier node write left', () => {
  it('is read under either spelling, and every write converges the row to one canonical key', async () => {
    const { dbPath, cleanup } = await freshFile();
    plant(dbPath, 7, 7, 'legacy seven');
    plant(dbPath, 8, 8, 'legacy eight');
    plant(dbPath, 9, 9, 'legacy nine');
    plant(dbPath, 1234567890123456, 1234567890123456, 'sixteen digits');
    assert.deepStrictEqual(storedKeys(dbPath), ['1234567890123456.0', '7.0', '8.0', '9.0']);
    const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
    const items = store.collection('items');
    assert.strictEqual((await items.get(7))?.label, 'legacy seven');
    assert.strictEqual((await items.get(1234567890123456))?.label, 'sixteen digits');
    await items.put({ id: 7, label: 'upserted' });
    await items.patch(8, [{ op: 'replace', path: '/label', value: 'patched' }]);
    assert.strictEqual(await items.delete(9), true);
    await items.put({ id: 1234567890123456, label: 'exact again' });
    await store.close();
    assert.deepStrictEqual(storedKeys(dbPath), ['1234567890123456', '7', '8']);
    const reopened = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
    assert.strictEqual((await reopened.collection('items').get(7))?.label, 'upserted');
    assert.strictEqual((await reopened.collection('items').get(8))?.label, 'patched');
    await reopened.close();
    cleanup();
  });

  it('an insert over a legacy row is the duplicate it is (JD2001), and the row stays as it was', async () => {
    const { dbPath, cleanup } = await freshFile();
    plant(dbPath, 10, 10, 'legacy ten');
    const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
    await assert.rejects(store.collection('items').insert({ id: 10, label: 'again' }), coded('JD2001'));
    await store.close();
    assert.deepStrictEqual(storedKeys(dbPath), ['10.0'], 'the refused insert rolled its convergence back');
    cleanup();
  });

  it('a key held under BOTH spellings is refused on write by name, and a read answers the canonical row', async () => {
    const { dbPath, cleanup } = await freshFile();
    plant(dbPath, 7, 7, 'node row');
    plant(dbPath, '7', 7, 'bun row');
    const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
    const items = store.collection('items');
    const both = (/** @type {any} */ error) => error.code === 'JD2001'
      && error.message.includes("'7'") && error.message.includes("'7.0'");
    await assert.rejects(items.put({ id: 7, label: 'third' }), both);
    await assert.rejects(items.delete(7), both);
    await assert.rejects(items.patch(7, [{ op: 'replace', path: '/label', value: 'x' }]), both);
    assert.strictEqual((await items.get(7))?.label, 'bun row');
    await store.close();
    assert.deepStrictEqual(storedKeys(dbPath), ['7', '7.0'], 'nothing was merged');
    cleanup();
  });

  it('an index-only migration over node-written numeric keys applies', async () => {
    const { dbPath, cleanup } = await freshFile();
    plant(dbPath, 1, 1, 'x');
    plant(dbPath, 2, 2, 'y');
    const target = structuredClone(MODEL);
    /** @type {any} */ (target.collections.items).indexes = [{ name: 'by_label', path: '$.label' }];
    const { migration } = planModelMigration(MODEL, target, { dialect: sqliteDialect, id: 'index-only' });
    const applied = await migrate({ driver: nodeDriver(), path: dbPath }, [migration], { baseline: MODEL, model: target });
    assert.deepStrictEqual(applied.applied, ['index-only']);
    cleanup();
  });
});

describe('both capture modes record one canonical path', () => {
  it('a put, patch and delete of a numeric key read alike under session and journal capture', async () => {
    /** @type {Record<string, string[][]>} */
    const seen = {};
    for (const mode of ['session', 'journal']) {
      const store = await openStore(MODEL, { driver: nodeDriver(), capture: { mode } });
      /** @type {any[]} */
      const records = [];
      store.observe((record) => records.push(record));
      const items = store.collection('items');
      await items.put({ id: 1, label: 'a' });
      await items.patch(1, [{ op: 'replace', path: '/label', value: 'b' }]);
      await items.delete(1);
      seen[mode] = records.map((record) => record.patch.map((/** @type {any} */ op) => `${op.op} ${op.path}`));
      await store.close();
    }
    assert.deepStrictEqual(seen.session, [['add /items/1'], ['replace /items/1/label'], ['remove /items/1']]);
    assert.deepStrictEqual(seen.journal, seen.session);
  });
});

describe('the repair statement MODEL-FORMAT documents', () => {
  const doc = fs.readFileSync(fileURLToPath(new URL('../../packages/db/docs/MODEL-FORMAT.md', import.meta.url)), 'utf8');
  const from = doc.indexOf('To converge a whole file at once');
  const fence = /```sql\n([\s\S]*?)```/.exec(doc.slice(from));
  assert.ok(from > 0 && fence !== null, 'MODEL-FORMAT carries the repair statement');
  const statement = /** @type {RegExpExecArray} */ (fence)[1].replaceAll('<table>', 'items').replaceAll('<member>', '$.id');

  it('converges a file, leaves a string key alone, and changes nothing the second time', async () => {
    const { dbPath, cleanup } = await freshFile();
    plant(dbPath, 7, 7, 'seven');
    plant(dbPath, 8, 8, 'eight');
    plant(dbPath, 1234567890123456, 1234567890123456, 'long');
    plant(dbPath, '1.0', '1.0', 'a version label, a STRING key');
    const db = new DatabaseSync(dbPath);
    assert.strictEqual(Number(db.prepare(statement).run().changes), 3);
    assert.strictEqual(Number(db.prepare(statement).run().changes), 0, 'the second run changes nothing');
    db.close();
    assert.deepStrictEqual(storedKeys(dbPath), ['1.0', '1234567890123456', '7', '8']);
    const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
    assert.strictEqual((await store.collection('items').get(1234567890123456))?.label, 'long');
    assert.strictEqual((await store.collection('items').get('1.0'))?.label, 'a version label, a STRING key');
    await store.close();
    cleanup();
  });

  it('refuses as a whole when a key is held under both spellings', async () => {
    const { dbPath, cleanup } = await freshFile();
    plant(dbPath, 7, 7, 'node row');
    plant(dbPath, '7', 7, 'bun row');
    plant(dbPath, 8, 8, 'eight');
    const db = new DatabaseSync(dbPath);
    assert.throws(() => db.prepare(statement).run(), /UNIQUE|PRIMARY KEY|constraint/i);
    db.close();
    assert.deepStrictEqual(storedKeys(dbPath), ['7', '7.0', '8.0'], 'nothing changed');
    cleanup();
  });
});

describe('the same file under Bun', () => {
  it('finds a node-written key and converges it on upsert — one row, keyed canonically', async (t) => {
    const which = spawnSync('bun', ['--version'], { encoding: 'utf8' });
    if (which.error !== undefined || which.status !== 0) {
      t.skip('no bun binary on PATH');
      return;
    }
    const fixture = fileURLToPath(new URL('./fixtures/numeric-keys-bun.mjs', import.meta.url));
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const cases = [
      { label: 'a legacy node row', key: 7 },
      { label: 'a canonical row', key: '7' },
    ];
    for (const { label, key } of cases) {
      const { dbPath, cleanup } = await freshFile();
      plant(dbPath, key, 7, 'written by node');
      const run = spawnSync('bun', ['run', fixture, dbPath, JSON.stringify(MODEL)], { encoding: 'utf8', cwd: root });
      assert.strictEqual(run.status, 0, run.stderr);
      const report = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}');
      assert.match(report.runtime, /^bun \d/);
      assert.deepStrictEqual(report.found, { id: 7, label: 'written by node' }, `${label}: found by Bun`);
      assert.deepStrictEqual(report.keys, ['7'], `${label}: one row, keyed canonically`);
      assert.strictEqual(report.after.label, 'upserted by bun');
      cleanup();
    }
  });
});
