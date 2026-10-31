//@ts-check
/**
 * @file What an open reads and locks while it verifies tables that exist:
 * one read of the catalog serves every physical entity it maps, so its
 * statements grow with the entities and not with entities × tables, and
 * the verification holds no write lock — it runs under a read transaction,
 * and only an open that must create a table, or that found a difference to
 * refuse, takes the immediate bracket and verifies again inside it.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

import { tempDbPath } from './helpers.js';

/** A node driver whose connections hand every statement, prepared or executed, to `note`.
 * @param {(sql: string, kind: 'exec' | 'prepare') => void} note */
const noting = (note) => {
  const base = nodeDriver();
  return { ...base, open: async (/** @type {any[]} */ ...args) => {
    const connection = await base.open(...args);
    return { ...connection,
      exec: (/** @type {string} */ sql) => { const out = connection.exec(sql); note(sql, 'exec'); return out; },
      prepare: (/** @type {string} */ sql, /** @type {any} */ metadata) => { note(sql, 'prepare'); return connection.prepare(sql, metadata); } };
  } };
};

/** `count` tables `t0…`, each with a key, a NOT NULL text column, a nullable reference to the one before and an index.
 * @param {string} dbPath @param {number} count */
const createTables = (dbPath, count) => {
  const db = new DatabaseSync(dbPath);
  let ddl = 'PRAGMA journal_mode = WAL;';
  for (let i = 0; i < count; i++) {
    ddl += `CREATE TABLE t${i} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, ref INTEGER${i > 0 ? ` REFERENCES t${i - 1}(id)` : ''});`
      + `CREATE INDEX t${i}_name ON t${i} (name); INSERT INTO t${i} VALUES (1, 'a', ${i > 0 ? 1 : 'NULL'});`;
  }
  db.exec(ddl);
  db.close();
};

/** A model mapping `count` physical entities over `t0…`, the last one with `extra` columns. @param {number} count @param {Record<string, any>} [extra] */
const physicalModel = (count, extra = {}) => ({ $model: '0.1', entities: Object.fromEntries(Array.from({ length: count }, (_, i) => [`E${i}`, {
  schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, name: { type: 'string' }, ref: { type: ['integer', 'null'] },
    ...(i === count - 1 ? Object.fromEntries(Object.keys(extra).map((name) => [name, { type: ['string', 'null'] }])) : {}) } },
  physical: { table: `t${i}`, columns: { id: { name: 'id', codec: 'integer', null: 'reject' }, name: { name: 'name', codec: 'text', null: 'reject' },
    ref: { name: 'ref', codec: 'integer', null: 'null' }, ...(i === count - 1 ? extra : {}) },
  indexes: [{ name: `t${i}_name`, terms: [{ by: { $sql: 'column', name: 'name' } }] }] } }])) });

/** A model of store-owned tables: a collection and two entities, one referencing the other. @param {boolean} [withTags] - one entity more */
const ownedModel = (withTags = false) => ({ $model: '0.1',
  collections: { notes: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, by: { type: 'string' } } },
    indexes: [{ name: 'by_by', path: '$.by' }] } },
  entities: {
    Owner: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, name: { type: 'string' },
      items: { 'x-entity': { relation: { to: 'Item', many: true, via: 'ownerId', onDelete: 'cascade' } } } } } },
    Item: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, ownerId: { type: 'string' } } } },
    ...(withTags ? { Tag: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } } } } } } : {}),
  } });

/** The transaction statements an open ran. @param {string[]} statements */
const brackets = (statements) => statements.filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)\b/.test(sql));

describe('an open reads the catalog once for its physical entities', () => {
  /** The catalog statements an open of `entities` physical entities over `tables` tables runs. @param {number} entities @param {number} tables @param {boolean} adopt */
  const reads = async (entities, tables, adopt) => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      createTables(dbPath, tables);
      const statements = /** @type {string[]} */ ([]);
      const store = await openStore(physicalModel(entities), { driver: noting((sql) => statements.push(sql)), path: dbPath, adopt });
      try {
        for (let i = 0; i < entities; i++) assert.strictEqual((await store.entity(`E${i}`).get(1))?.name, 'a');
      }
      finally { await store.close(); }
      return {
        tableLists: statements.filter((sql) => /FROM sqlite_schema WHERE type IN \('table', 'view'\)/.test(sql)).length,
        columnReads: statements.filter((sql) => sql.includes('FROM pragma_table_xinfo(')).length,
        indexLists: statements.filter((sql) => sql.includes('FROM pragma_index_list(')).length,
        total: statements.length,
      };
    }
    finally { cleanup(); }
  };

  for (const adopt of [true, false]) {
    it(`3 physical entities over 12 tables: one table list, each mapped table read once, as many statements as over 3 tables (adopt: ${adopt})`, async () => {
      const wide = await reads(3, 12, adopt);
      const narrow = await reads(3, 3, adopt);
      assert.deepStrictEqual({ ...wide, total: wide.total - narrow.total }, { tableLists: 1, columnReads: 3, indexLists: 3, total: 0 });
    });
  }

  it('each further physical entity adds the reads of its own table only', async () => {
    const three = await reads(3, 12, false);
    const six = await reads(6, 12, false);
    assert.deepStrictEqual([six.columnReads - three.columnReads, six.tableLists - three.tableLists], [3, 0]);
  });

  it('two entities mapping one table read it once', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      createTables(dbPath, 2);
      const model = physicalModel(1);
      model.entities.Twin = model.entities.E0;
      const statements = /** @type {string[]} */ ([]);
      const store = await openStore(model, { driver: noting((sql) => statements.push(sql)), path: dbPath });
      await store.close();
      assert.strictEqual(statements.filter((sql) => sql.includes('FROM pragma_table_xinfo(')).length, 1);
    }
    finally { cleanup(); }
  });

  it('a physical entity verified after the bracket creates a table reads the catalog again, and finds that table', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      createTables(dbPath, 1);
      const physical = /** @type {any} */ (physicalModel(1)).entities.E0;
      // E0 reads the catalog first; A is created next; B maps the table A just created
      const model = { $model: '0.1', entities: { E0: physical,
        A: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } } } } },
        B: { ...physical, physical: { ...physical.physical, table: 'A', indexes: [] } } } };
      await assert.rejects(openStore(model, { driver: nodeDriver(), path: dbPath }), (/** @type {any} */ error) => {
        assert.deepStrictEqual([error.code, error.message], ['JD0002', "JD0002: physical 'A': 'id' type TEXT cannot guarantee codec integer"]);
        return true;
      });
      const db = new DatabaseSync(dbPath);
      try { assert.deepStrictEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map((row) => row.name), ['t0']); }
      finally { db.close(); }
    }
    finally { cleanup(); }
  });
});

describe('an open holds no write lock while it verifies tables that exist', () => {
  /** Open `model` on `dbPath`, trying BEGIN IMMEDIATE (no busy wait) from a second connection at every statement.
   * @param {string} dbPath @param {any} model @param {Record<string, any>} [options] */
  const probing = async (dbPath, model, options = {}) => {
    const probe = new DatabaseSync(dbPath, { timeout: 0 });
    const statements = /** @type {string[]} */ ([]);
    let held = 0;
    try {
      const store = await openStore(model, { ...options, path: dbPath, driver: noting((sql) => {
        statements.push(sql);
        try { probe.exec('BEGIN IMMEDIATE'); probe.exec('ROLLBACK'); }
        catch (error) {
          if (!/locked|busy/i.test(String(/** @type {any} */ (error)?.message))) throw error;
          held++;
        }
      }) });
      await store.close();
    }
    finally { probe.close(); }
    return { held, brackets: brackets(statements), statements };
  };

  it('physical entities, adopted or not: the writer is free at every statement, one read transaction', async () => {
    for (const adopt of [false, true]) {
      const { dbPath, cleanup } = tempDbPath();
      try {
        createTables(dbPath, 6);
        const { held, brackets: seen } = await probing(dbPath, physicalModel(6), { adopt });
        assert.deepStrictEqual({ held, seen }, { held: 0, seen: ['BEGIN', 'COMMIT'] }, `adopt: ${adopt}`);
      }
      finally { cleanup(); }
    }
  });

  it('store-owned tables that all exist: the writer is free at every statement of the second open', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      await (await openStore(ownedModel(), { driver: nodeDriver(), path: dbPath })).close();
      const { held, brackets: seen } = await probing(dbPath, ownedModel());
      assert.deepStrictEqual({ held, seen }, { held: 0, seen: ['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT'] });
    }
    finally { cleanup(); }
  });

  it('a table to create: the read finds it missing, and the immediate bracket verifies again and creates it', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      await (await openStore(ownedModel(), { driver: nodeDriver(), path: dbPath })).close();
      const { held, brackets: seen, statements } = await probing(dbPath, ownedModel(true));
      assert.deepStrictEqual(seen, ['BEGIN', 'COMMIT', 'BEGIN', 'ROLLBACK', 'BEGIN IMMEDIATE', 'COMMIT']);
      const begin = statements.indexOf('BEGIN IMMEDIATE');
      const created = statements.findIndex((sql) => /^CREATE TABLE IF NOT EXISTS "Tag"/.test(sql));
      assert.ok(created > begin && begin > 0, 'the table is created inside the immediate bracket');
      assert.ok(held > 0, 'the bracket holds the writer');
    }
    finally { cleanup(); }
  });

  it('a second process takes BEGIN IMMEDIATE and opens the same store, without waiting, while the first verifies it', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      createTables(dbPath, 4);
      const model = physicalModel(4);
      const child = `
        import { DatabaseSync } from 'node:sqlite';
        import { openStore } from '@jarenjs/db';
        import { nodeDriver } from '@jarenjs/db/node';
        const [dbPath] = process.argv.slice(1);
        const probe = new DatabaseSync(dbPath, { timeout: 0 });
        let immediate = true;
        try { probe.exec('BEGIN IMMEDIATE'); probe.exec('ROLLBACK'); } catch { immediate = false; }
        probe.close();
        let open;
        try { await (await openStore(${JSON.stringify(model)}, { driver: nodeDriver(), path: dbPath, busyTimeout: 0 })).close(); open = 'opened'; }
        catch (error) { open = error.code; }
        console.log(JSON.stringify({ immediate, open }));`;
      let outcome = null;
      const store = await openStore(model, { path: dbPath, driver: noting((sql) => {
        // halfway through the verification: the third mapped table's columns
        if (outcome !== null || sql !== `SELECT name, type, hidden, pk, "notnull" AS not_null, dflt_value AS default_value FROM pragma_table_xinfo('t2') ORDER BY cid`) return;
        const run = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', child, dbPath],
          { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
        outcome = run.stdout.trim() || run.stderr;
      }) });
      await store.close();
      assert.deepStrictEqual(JSON.parse(String(outcome)), { immediate: true, open: 'opened' });
    }
    finally { cleanup(); }
  });

  it('a table a rival creates between the read and the bracket is verified there, not created again', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      await (await openStore(ownedModel(), { driver: nodeDriver(), path: dbPath })).close();
      const rival = `
        import { openStore } from '@jarenjs/db';
        import { nodeDriver } from '@jarenjs/db/node';
        const [dbPath] = process.argv.slice(1);
        await (await openStore(${JSON.stringify(ownedModel(true))}, { driver: nodeDriver(), path: dbPath })).close();
        console.log('created');`;
      const statements = /** @type {string[]} */ ([]);
      let raced = '';
      const store = await openStore(ownedModel(true), { path: dbPath, driver: noting((sql, kind) => {
        statements.push(sql);
        if (kind !== 'exec' || sql !== 'ROLLBACK' || raced !== '') return;
        raced = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', rival, dbPath],
          { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } }).stdout.trim();
      }) });
      try {
        assert.strictEqual(raced, 'created');
        assert.deepStrictEqual(brackets(statements), ['BEGIN', 'COMMIT', 'BEGIN', 'ROLLBACK', 'BEGIN IMMEDIATE', 'COMMIT']);
        assert.deepStrictEqual(statements.filter((sql) => /^CREATE TABLE/.test(sql)), []);
        await store.entity('Tag').create({ id: 't' });
      }
      finally { await store.close(); }
    }
    finally { cleanup(); }
  });

  it('a difference the read finds is judged again under the writer, after the migration in flight commits, and opens', async () => {
    const { dbPath, cleanup } = tempDbPath();
    const signal = `${dbPath}.go`;
    let holder;
    try {
      createTables(dbPath, 1);
      // a migration holds the writer, its new column written but not committed until the open's read has refused
      holder = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', `
        import { DatabaseSync } from 'node:sqlite';
        import { existsSync } from 'node:fs';
        const [dbPath, signal] = process.argv.slice(1);
        const db = new DatabaseSync(dbPath);
        db.exec('BEGIN IMMEDIATE; ALTER TABLE t0 ADD COLUMN note TEXT');
        console.log('held');
        const started = Date.now();
        const wait = setInterval(() => {
          if (!existsSync(signal) && Date.now() - started < 20000) return;
          clearInterval(wait);
          db.exec('COMMIT');
          db.close();
        }, 5);`, dbPath, signal], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, FORCE_COLOR: '0' } });
      const exited = new Promise((resolve) => holder?.on('exit', resolve));
      await new Promise((resolve) => holder?.stdout?.on('data', (chunk) => { if (String(chunk).includes('held')) resolve(null); }));
      const statements = /** @type {string[]} */ ([]);
      const store = await openStore(physicalModel(1, { note: { name: 'note', codec: 'text', null: 'null' } }), { path: dbPath, busyTimeout: 10000,
        driver: noting((sql, kind) => {
          statements.push(sql);
          if (kind === 'exec' && sql === 'ROLLBACK') fs.writeFileSync(signal, '');
        }) });
      try {
        assert.deepStrictEqual(brackets(statements), ['BEGIN', 'ROLLBACK', 'BEGIN IMMEDIATE', 'COMMIT']);
        assert.deepStrictEqual(await store.entity('E0').get(1), { id: 1, name: 'a', ref: null, note: null });
      }
      finally { await store.close(); }
      await exited;
    }
    finally {
      fs.writeFileSync(signal, '');
      holder?.kill();
      cleanup();
    }
  });
});
