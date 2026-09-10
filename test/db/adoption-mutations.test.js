//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@jarenjs/db';
import { nodeDriver, adaptNodeDatabase } from '@jarenjs/db/node';
import { loadSqlCensus, storeForSqlCensus } from './oracle/harness.js';

describe('native column mutation plans', () => {
  it('case-sensitive changes are not hidden by a physical NOCASE column', async () => {
    const { store, db } = await storeForSqlCensus();
    try {
      db.exec("DROP TABLE app_settings; CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT COLLATE NOCASE,updated_at TEXT DEFAULT '2026-09-10T00:00:00.000Z'); INSERT INTO app_settings(key,value) VALUES('locale','en')");
      const update = { op: 'update', key: 'locale', set: { value: 'EN' } };
      assert.equal((await store.entity('Setting').mutate(update)).affected, 1);
      assert.equal((await store.entity('Setting').mutate(update)).affected, 0);
      const upsert = { op: 'upsert', values: { key: 'locale', value: 'en' }, conflict: ['key'], update: ['value'] };
      assert.equal((await store.entity('Setting').mutate(upsert)).affected, 1);
      assert.equal((await store.entity('Setting').mutate(upsert)).affected, 0);
      assert.equal((await store.entity('Setting').get('locale')).value, 'en');
    }
    finally { await store.close(); }
  });
  it('output and commit failures withdraw native data, allocated receipts and co-committed jobs', async () => {
    const raw = new DatabaseSync(':memory:');
    const fixture = JSON.parse(readFileSync(new URL('../adoption/fixtures/relational.json', import.meta.url), 'utf8'));
    for (const sql of [...fixture.ddl, ...fixture.seed]) raw.exec(sql);
    let failCommit = false;
    const db = await adaptNodeDatabase({ prepare: (sql) => raw.prepare(sql), close: () => raw.close(),
      exec: (sql) => { if (failCommit && /^COMMIT\b/.test(sql)) { failCommit = false; throw new Error('commit failed'); } return raw.exec(sql); } });
    const store = await openStore(loadSqlCensus().model, { driver: { ...nodeDriver(), open: async () => db }, jobs: {} });
    try {
      for (const failure of ['output', 'commit']) {
        const mutation = loadSqlCensus().mutations[0];
        await assert.rejects(store.transaction(async (tx) => {
          await tx.entity(mutation.entity).mutate(mutation.document);
          await tx.entity('Receipt').create({ body: 'abcd' });
          await tx.jobs.enqueue('native-proof', { input: {} }, { id: failure });
          if (failure === 'output') throw new Error('output failed');
          failCommit = true;
        }, { mode: 'immediate' }), /failed/);
        assert.equal((await store.entity('Inventory').get(mutation.document.key)).revision, 1);
        assert.equal(await store.entity('Receipt').get(2), undefined);
        assert.equal(await store.jobs.get(failure), undefined);
      }
    }
    finally { await store.close(); }
  });
  it('separate SQLite connections race one complete revision predicate', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jaren-native-race-'));
    const path = join(directory, 'race.sqlite');
    const fixture = JSON.parse(readFileSync(new URL('../adoption/fixtures/relational.json', import.meta.url), 'utf8'));
    const seed = await nodeDriver().open(path);
    for (const sql of [...fixture.ddl, ...fixture.seed]) seed.exec(sql);
    seed.close();
    const stores = [];
    try {
      for (let i = 0; i < 2; i++) stores.push(await openStore(loadSqlCensus().model, { driver: nodeDriver(), path, adopt: true }));
      const document = loadSqlCensus().mutations[0].document;
      const answers = await Promise.all(stores.map((store, i) => store.entity('Inventory').mutate({ ...document, set: { quantity: 4 + i } })));
      assert.deepEqual(answers.map((r) => r.affected).sort(), [0, 1]);
      assert.equal((await stores[0].entity('Inventory').get(document.key)).revision, 2);
    }
    finally { for (const store of stores) await store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('compares supplied values with the same bound values, including SQL NULL', async () => {
    const { store, db } = await storeForSqlCensus();
    try {
      const target = store.entity('Inventory');
      const document = { op: 'update', key: { environment: 'test', sku: '0012' }, expectedRevision: 1, set: { quantity: 3 } };
      const before = db.prepare('SELECT total_changes() AS n').get([]).n;
      assert.equal((await target.mutate(document)).affected, 0);
      assert.equal(db.prepare('SELECT total_changes() AS n').get([]).n, before);
      assert.equal((await target.mutate({ ...document, key: { environment: 'test', sku: '0007' }, set: { quantity: 5 } })).affected, 1);
      assert.equal((await target.get({ environment: 'test', sku: '0007' })).quantity, 5);
    }
    finally { await store.close(); }
  });
  for (const mutation of loadSqlCensus().mutations) it(`${mutation.id}: one statement and a zero-write replay`, async () => {
    const { store, db, calls } = await storeForSqlCensus();
    try {
      const target = store.entity(mutation.entity);
      calls.length = 0;
      const first = await target.mutate(mutation.document);
      assert.deepEqual(first.rows, mutation.first);
      assert.equal(first.affected, mutation.first.length);
      assert.equal(calls.length, 1);
      const before = db.prepare('SELECT total_changes() AS n').get([]).n;
      const second = await target.mutate(mutation.document);
      assert.deepEqual(second.rows, []);
      assert.equal(second.affected, 0);
      assert.equal(db.prepare('SELECT total_changes() AS n').get([]).n, before);
    }
    finally { await store.close(); }
  });
  it('a failed outer transaction withdraws conditional writes and generated receipts', async () => {
    const { store } = await storeForSqlCensus();
    try {
      const mutation = loadSqlCensus().mutations[0];
      await assert.rejects(store.transaction(async (tx) => {
        await tx.entity(mutation.entity).mutate(mutation.document);
        await tx.entity('Receipt').create({ body: 'abcd' });
        throw new Error('output failed');
      }), /output failed/);
      assert.equal((await store.entity('Inventory').get(mutation.document.key)).revision, 1);
      assert.equal(await store.entity('Receipt').get(2), undefined);
    }
    finally { await store.close(); }
  });
  it('source overflow refuses atomically even when every source row would conflict', async () => {
    const { store } = await storeForSqlCensus();
    try {
      const mutation = loadSqlCensus().mutations[2];
      await assert.rejects(store.entity('Inventory').mutate({ ...mutation.document, maxRows: 1 }), { code: 'JD2007' });
      assert.equal(await store.entity('Inventory').get({ environment: 'copy', sku: '0007' }), undefined);
      await store.entity('Inventory').mutate(mutation.document);
      await assert.rejects(store.entity('Inventory').mutate({ ...mutation.document, maxRows: 1 }), { code: 'JD2007' });
    }
    finally { await store.close(); }
  });
  it('byte-bound failures withdraw trigger effects and independent contenders have one winner', async () => {
    const { store, db } = await storeForSqlCensus();
    try {
      db.exec('CREATE TABLE native_audit(sku TEXT); CREATE TRIGGER native_audit_update AFTER UPDATE ON inventory BEGIN INSERT INTO native_audit VALUES(NEW.sku); END');
      const mutation = loadSqlCensus().mutations[0];
      await assert.rejects(store.entity('Inventory').mutate({ ...mutation.document, maxBytes: 1 }), { code: 'JD2007' });
      assert.equal(db.prepare('SELECT count(*) AS n FROM native_audit').get([]).n, 0);
      const results = await Promise.all([4, 5].map((quantity) => store.entity('Inventory').mutate({ ...mutation.document, set: { quantity } })));
      assert.deepEqual(results.map((r) => r.affected), [1, 0]);
      assert.equal(db.prepare('SELECT count(*) AS n FROM native_audit').get([]).n, 1);
      assert.equal((await store.entity('Inventory').get(mutation.document.key)).revision, 2);
    }
    finally { await store.close(); }
  });
  it('refuses unknown grammar, unbounded inputs and unsupported conflict or codec shapes', async () => {
    const { store } = await storeForSqlCensus();
    try {
      const [update, upsert, select] = loadSqlCensus().mutations.map((m) => m.document);
      for (const document of [null, [], { op: 'delete' }, { ...update, ignored: true },
        { ...update, maxRows: Infinity }, { ...update, maxBytes: 0 }, { ...update, returning: [] },
        { ...update, returning: ['missing'] }, { ...update, set: {} }, { ...update, set: { sku: 'x' } },
        { ...update, expectedRevision: null }, { ...select, conflict: ['sku'] },
        { ...select, source: 'Catalog' }, { ...select, select: {} }, { ...select, select: null },
        { ...select, select: { sku: '$it.quantity', environment: '$it.environment' } },
        { ...select, select: { sku: '$it.sku', environment: '$it.environment', revision: { $literal: 2 } } },
        { ...select, select: { sku: 'not a path', environment: '$it.environment' } },
        { ...select, where: { $eq: ['$it.quantity', null] } }]) {
        await assert.rejects(store.entity('Inventory').mutate(document));
      }
      for (const document of [{ ...upsert, values: null }, { ...upsert, update: [] },
        { ...upsert, update: ['updated_at'] }, { ...upsert, values: { value: 'en' } }])
        await assert.rejects(store.entity('Setting').mutate(document));
      await assert.rejects(store.entity('Setting').mutate({ op: 'update', key: 'locale', expectedRevision: 1, set: { value: 'x' } }), { code: 'JD0038' });
    }
    finally { await store.close(); }
  });
});
