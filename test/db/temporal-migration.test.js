//@ts-check
/**
 * @file Declaring, changing and dropping a temporal member on a collection
 * that holds rows (MODEL-FORMAT §2, `temporals`), on SQLite and PostgreSQL:
 * the planned link adds the key columns and the CHECK (one rebuild on
 * SQLite, in place on PostgreSQL), refuses `JD0021` before any step where a
 * stored member is no value of its kind's shape, leaves a zoned member's keys
 * empty — every row a candidate — until `rekey()`, keys no row under a policy
 * it changed, and `introspectModel` reads every declaration back, so the
 * derived model opens the tables this tree creates and plans no rebuild of
 * them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, planModelMigration, migrate, introspectModel, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';
import { compileJsonQuery } from '@jarenjs/json/query';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

import { PG_URL, withPostgres } from './store-core-engines.js';
import { tempDbPath } from './helpers.js';

const zoneProvider = createIntlZoneProvider({ revision: 'migration' });
const plain = { $model: '0.1', collections: { ev: { schema: { type: 'object' }, key: '/id', indexes: [{ name: 'by_x', path: '$.x' }] } } };
/** @param {string} policy */
const declared = (policy) => ({ $model: '0.1', collections: { ev: { schema: { type: 'object' }, key: '/id',
  temporals: [{ name: 'u', path: '$.u', kind: 'utc' }, { name: 'z', path: '$.z', kind: 'zoned', policy }, { name: 'f', path: '$.f', kind: 'floating' }],
  indexes: [{ name: 'by_x', path: '$.x' }, { name: 'by_u', path: '$.u' }, { name: 'by_z', path: '$.z' }] } } });
const ROWS = [
  { id: 'a', x: 1, u: { kind: 'utc', instant: '2026-01-01T00:00:00.5Z' }, z: { kind: 'zoned', date: '2026-10-25', time: '02:30', zone: 'Europe/Amsterdam' },
    f: { kind: 'floating', date: '2026-01-01', time: '10:00' } },
  { id: 'b', x: 2, u: { kind: 'utc', instant: '2026-01-01T00:00:00Z' }, z: { kind: 'zoned', date: '2026-10-25', time: '01:50', zone: 'Europe/London' } },
  { id: 'n', x: 3 },
];
const byInstant = { $for: { it: '$[*]' }, $orderby: [{ $instant: ['$it.u'] }, '$it.id'], $return: '$it.id' };
/** @param {string} policy */
const zonedBefore = (policy) => ({ $for: { it: '$[*]' }, $where: { $lt: [{ $instant: ['$it.z', policy] }, Date.parse('2026-10-25T00:45:00Z')] }, $return: '$it.id' });
const list = (/** @type {any} */ answer) => (answer === undefined ? [] : [answer].flat());
const expected = (/** @type {any} */ doc) => list(compileJsonQuery(doc, { zoneProvider })(ROWS));

/**
 * @typedef {{ dialect: any, open: (model: any) => Promise<any>, run: (links: any[], model: any) => Promise<any>,
 *   connection: () => Promise<any>, stamps: () => Promise<any[]> }} Engine
 */
/** @param {(engine: Engine) => Promise<void>} fn */
async function onSqlite(fn) {
  const { dbPath: path, cleanup } = tempDbPath();
  const { DatabaseSync } = await import('node:sqlite');
  try {
    await fn({
      dialect: sqliteDialect,
      open: (model) => openStore(model, { driver: nodeDriver(), path, zoneProvider }),
      run: (links, model) => migrate({ driver: nodeDriver(), path }, links, { baseline: plain, model }),
      connection: () => nodeDriver().open(path, {}),
      stamps: async () => {
        const db = new DatabaseSync(path);
        try { return db.prepare('SELECT * FROM "ev" ORDER BY "key"').all().map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => /^tk_z/.test(k)))); }
        finally { db.close(); }
      },
    });
  }
  finally { cleanup(); }
}
/** @param {(engine: Engine) => Promise<void>} fn */
async function onPostgres(fn) {
  await withPostgres(async ({ pool, schema, driver }) => {
    await fn({
      dialect: postgresDialect({ searchPath: schema }),
      open: (model) => openStore(model, { driver: driver(), zoneProvider }),
      run: (links, model) => migrate({ driver: driver() }, links, { baseline: plain, model, shadow: false }),
      connection: () => driver().open(),
      stamps: async () => (await pool.query(`SELECT * FROM "${schema}"."ev" ORDER BY "key"`)).rows
        .map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => /^tk_z/.test(k)).map(([k, v]) => [k, v === null ? null : /\$/.test(k) ? v : Number(v)]))),
    });
  });
}
const ENGINES = /** @type {const} */ ([['sqlite', onSqlite, false], ['postgres', onPostgres, !PG_URL && 'JAREN_PG_URL is not set']]);

for (const [name, on, skip] of ENGINES) {
  describe(`migrating a temporal declaration on ${name}`, { skip }, () => {
    it('declares it over stored rows, keys a zoned member on rekey(), and drops it again', async () => {
      await on(async (engine) => {
        const seed = await engine.open(plain);
        for (const row of ROWS) await seed.collection('ev').put(row);
        await seed.close();
        const up = planModelMigration(plain, declared('later'), { dialect: engine.dialect, id: 'up' }).migration;
        assert.deepEqual((await engine.run([up], declared('later'))).applied, ['up']);
        assert.deepEqual(await engine.stamps(), [{ tk_z: null, 'tk_z$later': null }, { tk_z: null, 'tk_z$later': null }, { tk_z: null, 'tk_z$later': null }],
          'a zoned key arrives empty');
        const store = await engine.open(declared('later'));
        try {
          assert.deepEqual(list(await store.collection('ev').execute(byInstant)), expected(byInstant));
          assert.deepEqual(list(await store.collection('ev').execute(zonedBefore('later'))), expected(zonedBefore('later')), 'an empty key is a candidate');
          assert.equal(await store.collection('ev').rekey(), 2);
          assert.deepEqual(list(await store.collection('ev').execute(zonedBefore('later'))), expected(zonedBefore('later')));
          await assert.rejects(store.collection('ev').put({ id: 'c', u: { kind: 'utc', instant: 'soon' } }), /JD2003/);
        }
        finally { await store.close(); }
        // a changed policy is a new stamp column: no row is keyed under it until rekey()
        const turn = planModelMigration(declared('later'), declared('rfc5545'), { dialect: engine.dialect, id: 'turn' }).migration;
        assert.deepEqual((await engine.run([up, turn], declared('rfc5545'))).applied, ['turn']);
        assert.deepEqual((await engine.stamps()).map((row) => row['tk_z$rfc5545']), [null, null, null]);
        const turned = await engine.open(declared('rfc5545'));
        try {
          assert.deepEqual(list(await turned.collection('ev').execute(zonedBefore('rfc5545'))), expected(zonedBefore('rfc5545')));
          assert.equal(await turned.collection('ev').rekey(), 2);
        }
        finally { await turned.close(); }
        const down = planModelMigration(declared('rfc5545'), plain, { dialect: engine.dialect, id: 'down' }).migration;
        assert.deepEqual((await engine.run([up, turn, down], plain)).applied, ['down']);
        const back = await engine.open(plain);
        try { await back.collection('ev').put({ id: 'c', u: { kind: 'utc', instant: 'soon' } }); }
        finally { await back.close(); }
      });
    });

    it('refuses JD0021 before any step over a stored member that is no value of its kind', async () => {
      await on(async (engine) => {
        const seed = await engine.open(plain);
        for (const row of [...ROWS, { id: 'bad', u: { kind: 'utc', instant: 5 } }, { id: 'odd', f: { kind: 'utc', instant: '2026-01-01T00:00:00Z' } }])
          await seed.collection('ev').put(row);
        await seed.close();
        const up = planModelMigration(plain, declared('later'), { dialect: engine.dialect, id: 'up' }).migration;
        await assert.rejects(engine.run([up], declared('later')), (/** @type {any} */ e) => {
          assert.equal(e.code, 'JD0021', e.message);
          assert.match(e.message, /collection 'ev': 1 stored document\(s\) violate (utc|floating) member '(u|f)' \(first keys: '(bad|odd)'\)/);
          return true;
        });
        const still = await engine.open(plain);
        try { assert.equal((await still.collection('ev').all()).length, 5, 'nothing changed'); }
        finally { await still.close(); }
      });
    });

    it('introspectModel reads every declaration back; the derived model opens and plans no rebuild', async () => {
      await on(async (engine) => {
        const model = { $model: '0.1', collections: { ev: { schema: { type: 'object' }, key: '/id',
          temporals: [{ name: 'd', path: '$.d', kind: 'date' }, { name: 'f', path: '$.f', kind: 'floating' }, { name: 'u', path: '$.u', kind: 'utc' },
            { name: 'z', path: '$.z', kind: 'zoned', policy: 'later' }, { name: 'r', path: '$.r["a b"]', kind: 'date-range' }],
          indexes: [{ name: 'by_u', path: '$.u', unique: true }, { name: 'by_z', path: '$.z' }, { name: 'by_r', path: '$.r["a b"]' }, { name: 'by_d', path: ['$.d', '$.x'] }] } } };
        const created = await engine.open(model);
        await created.close();
        const connection = await engine.connection();
        let derived;
        try {
          const read = await introspectModel(connection, { keys: { ev: '/id' } });
          derived = read.model;
          assert.deepEqual(read.report.filter((/** @type {any} */ row) => /unmapped-(column|constraint|index)/.test(row.code)), []);
        }
        finally { await connection.close?.(); }
        const ev = derived.collections.ev;
        assert.deepEqual([...ev.temporals].sort((a, b) => (a.name < b.name ? -1 : 1)), [...model.collections.ev.temporals].sort((a, b) => (a.name < b.name ? -1 : 1)));
        assert.deepEqual(ev.indexes.map((/** @type {any} */ index) => [index.name, index.path, index.unique === true]).sort(),
          [['by_d', ['$.d', '$.x'], false], ['by_r', '$.r["a b"]', false], ['by_u', '$.u', true], ['by_z', '$.z', false]]);
        const reopened = await engine.open(derived);
        await reopened.close();
        const steps = planModelMigration(derived, model, { dialect: engine.dialect, id: 'again' }).migration.steps;
        assert.deepEqual(steps.filter((/** @type {any} */ step) => step.kind === 'rebuild' || step.kind === 'ddl'), [], JSON.stringify(steps.map((/** @type {any} */ s) => s.note)));
      });
    });
  });
}
