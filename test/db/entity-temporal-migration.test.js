//@ts-check
/**
 * @file Migrating an entity member's calendar kind (`x-entity.temporal`) over
 * stored rows, and reading one back. Declaring the kind rebuilds the table
 * with its key columns and CHECK — refused `JD0021` before any step when a
 * stored member is no value of its kind — a zoned member's key arriving
 * empty (a candidate the engine decides); dropping it rebuilds the table
 * without them, the value staying in the document. `introspectModel` reads
 * every declaration back, so the derived model opens and plans no step.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, planModelMigration, migrate, introspectModel, shapeHash, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';
import { compileJsonQuery } from '@jarenjs/json/query';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { storeTemporals } from '@jarenjs/db/temporals';
import { queryCalendar } from '@jarenjs/json/query/calendar';

import { migrationIdentity } from './migration-fixture.js';
import { PG_URL, withPostgres } from './store-core-engines.js';
import { tempDbPath } from './helpers.js';

const zoneProvider = createIntlZoneProvider({ revision: 'migration' });
const temporalSeam = storeTemporals();
const calendar = queryCalendar();
/** The entity, its members plain document objects or declared calendar kinds.
 * @param {Record<string, any>} [members] */
const entityModel = (members = {}) => ({ $model: '0.1', entities: { Ev: { schema: { type: 'object', properties: {
  id: { type: 'string', 'x-entity': { key: true } }, x: { type: 'integer' },
  u: { type: 'object', ...members.u }, z: { type: 'object', ...members.z }, f: { type: 'object', ...members.f } } } } } });
const plain = entityModel();
/** @param {string} policy */
const declared = (policy) => entityModel({ u: { 'x-entity': { temporal: { kind: 'utc' }, unique: true } },
  z: { 'x-entity': { temporal: { kind: 'zoned', policy }, index: true } }, f: { 'x-entity': { temporal: { kind: 'floating' } } } });
const ROWS = [
  { id: 'a', x: 1, u: { kind: 'utc', instant: '2026-01-01T00:00:00.5Z' }, z: { kind: 'zoned', date: '2026-10-25', time: '02:30', zone: 'Europe/Amsterdam' },
    f: { kind: 'floating', date: '2026-01-01', time: '10:00' } },
  { id: 'b', x: 2, u: { kind: 'utc', instant: '2026-01-01T00:00:00Z' }, z: { kind: 'zoned', date: '2026-10-25', time: '01:50', zone: 'Europe/London' } },
  { id: 'n', x: 3 },
];
const byInstant = { $for: { it: '$.Ev[*]' }, $orderby: [{ $instant: ['$it.u'] }, '$it.id'], $return: '$it.id' };
/** @param {string} policy */
const zonedBefore = (policy) => ({ $for: { it: '$.Ev[*]' }, $where: { $lt: [{ $instant: ['$it.z', policy] }, Date.parse('2026-10-25T00:45:00Z')] }, $return: '$it.id' });
const list = (/** @type {any} */ answer) => (answer === undefined ? [] : [answer].flat());
const expected = (/** @type {any} */ doc) => list(compileJsonQuery(doc, { zoneProvider, calendar })({ Ev: ROWS }));

/**
 * @typedef {{ dialect: any, open: (model: any) => Promise<any>, run: (links: any[], model: any, baseline?: any) => Promise<any>,
 *   connection: () => Promise<any>, columns: () => Promise<string[]>, stamps: () => Promise<any[][]> }} Engine
 */
/** @param {(engine: Engine) => Promise<void>} fn */
async function onSqlite(fn) {
  const { dbPath: path, cleanup } = tempDbPath();
  const { DatabaseSync } = await import('node:sqlite');
  try {
    await fn({
      dialect: sqliteDialect,
      open: (model) => openStore(model, { driver: nodeDriver(), temporals: temporalSeam, path, zoneProvider }),
      run: (links, model, baseline = plain) => migrate({ driver: nodeDriver(), path }, links, { baseline, model }),
      connection: () => nodeDriver().open(path, {}),
      stamps: async () => {
        const db = new DatabaseSync(path);
        try { return db.prepare('SELECT "tk_z" AS k, "tk_z$later" AS s FROM "Ev" ORDER BY "id"').all().map((row) => [row.k, row.s]); }
        finally { db.close(); }
      },
      columns: async () => {
        const db = new DatabaseSync(path);
        try { return db.prepare('SELECT name FROM pragma_table_xinfo(\'Ev\') ORDER BY name').all().map((row) => String(row.name)); }
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
      open: (model) => openStore(model, { driver: driver(), temporals: temporalSeam, zoneProvider }),
      run: (links, model, baseline = plain) => migrate({ driver: driver() }, links, { baseline, model, shadow: false }),
      connection: () => driver().open(),
      stamps: async () => (await pool.query(`SELECT "tk_z" AS k, "tk_z$later" AS s FROM "${schema}"."Ev" ORDER BY "id"`)).rows
        .map((row) => [row.k === null ? null : Number(row.k), row.s]),
      columns: async () => (await pool.query('SELECT column_name AS name FROM information_schema.columns WHERE table_schema = $1 '
        + 'AND table_name = \'Ev\' ORDER BY column_name', [schema])).rows.map((row) => String(row.name)),
    });
  });
}
const ENGINES = /** @type {const} */ ([['sqlite', onSqlite, false], ['postgres', onPostgres, !PG_URL && 'JAREN_PG_URL is not set']]);

for (const [name, on, skip] of ENGINES) {
  describe(`migrating an entity member's calendar kind on ${name}`, { skip }, () => {
    it('declares it over stored rows, answers through its keys, changes its policy and drops it again', async () => {
      await on(async (engine) => {
        const seed = await engine.open(plain);
        for (const row of ROWS) await seed.entity('Ev').create(row);
        await seed.close();
        const up = planModelMigration(plain, declared('later'), { dialect: engine.dialect, id: 'up' }).migration;
        assert.deepEqual((await engine.run([up], declared('later'))).applied, ['up']);
        assert.deepEqual((await engine.columns()).filter((column) => column.startsWith('tk_')), ['tk_f', 'tk_u', 'tk_z', 'tk_z$later']);
        const store = await engine.open(declared('later'));
        try {
          const ev = store.entity('Ev');
          assert.deepEqual(list(await ev.execute(byInstant)), expected(byInstant));
          assert.equal((await ev.explain(byInstant)).mode, 'native');
          assert.deepEqual(list(await ev.execute(zonedBefore('later'))), expected(zonedBefore('later')), 'an empty key is a candidate');
          assert.deepEqual(await ev.get('a'), ROWS[0]);
          await assert.rejects(ev.create({ id: 'c', u: { kind: 'utc', instant: 'soon' } }), /JD2003/);
          await assert.rejects(ev.create({ id: 'c', u: { kind: 'utc', instant: '2026-01-01T00:00:00.000Z' } }), /JD2005/);
        }
        finally { await store.close(); }
        // a changed policy is a new stamp column
        const turn = planModelMigration(declared('later'), declared('rfc5545'), { dialect: engine.dialect, id: 'turn' }).migration;
        assert.deepEqual((await engine.run([up, turn], declared('rfc5545'))).applied, ['turn']);
        assert.deepEqual((await engine.columns()).filter((column) => column.startsWith('tk_z')), ['tk_z', 'tk_z$rfc5545']);
        const turned = await engine.open(declared('rfc5545'));
        try { assert.deepEqual(list(await turned.entity('Ev').execute(zonedBefore('rfc5545'))), expected(zonedBefore('rfc5545'))); }
        finally { await turned.close(); }
        const down = planModelMigration(declared('rfc5545'), plain, { dialect: engine.dialect, id: 'down' }).migration;
        assert.deepEqual((await engine.run([up, turn, down], plain)).applied, ['down']);
        assert.deepEqual((await engine.columns()).filter((column) => column.startsWith('tk_')), []);
        const back = await engine.open(plain);
        try {
          await back.entity('Ev').create({ id: 'c', u: { kind: 'utc', instant: 'soon' } });
          assert.deepEqual(await back.entity('Ev').get('a'), ROWS[0]);
        }
        finally { await back.close(); }
      });
    });

    it('a document step that rewrites a row writes its zoned key anew: absent without a zone provider', async () => {
      await on(async (engine) => {
        const model = declared('later');
        const seed = await engine.open(model);
        for (const row of ROWS) await seed.entity('Ev').create(row);
        await seed.close();
        const step = { $migration: '0.2', identity: migrationIdentity(model), id: 'touch', from: shapeHash(model), to: shapeHash(model),
          steps: [{ kind: 'jslt', collection: 'Ev', stylesheet: [{ match: '$', body: { id: '$.id', x: { $add: ['$.x', 10] }, u: '$.u', z: '$.z', f: '$.f' } }] }] };
        await engine.run([step], model, model);
        assert.deepEqual(await engine.stamps(), [[null, null], [null, null], [null, null]]);
        const store = await engine.open(model);
        try {
          assert.deepEqual((await store.entity('Ev').get('a')).x, 11);
          assert.deepEqual(list(await store.entity('Ev').execute(zonedBefore('later'))), expected(zonedBefore('later')), 'an empty key is a candidate');
        }
        finally { await store.close(); }
      });
    });

    it('refuses JD0021 before any step over a stored member that is no value of its kind', async () => {
      await on(async (engine) => {
        const seed = await engine.open(plain);
        for (const row of [...ROWS, { id: 'bad', u: { kind: 'utc', instant: 5 } }]) await seed.entity('Ev').create(row);
        await seed.close();
        const up = planModelMigration(plain, declared('later'), { dialect: engine.dialect, id: 'up' }).migration;
        await assert.rejects(engine.run([up], declared('later')), (/** @type {any} */ e) => {
          assert.equal(e.code, 'JD0021', e.message);
          assert.match(e.message, /entity 'Ev': 1 stored document\(s\) violate utc member 'u' \(first keys: 'bad'\)/);
          return true;
        });
        assert.deepEqual((await engine.columns()).filter((column) => column.startsWith('tk_')), [], 'nothing changed');
      });
    });

    it('introspectModel reads every declaration back; the derived model opens and plans no step', async () => {
      await on(async (engine) => {
        const kinds = { d: { kind: 'date' }, f: { kind: 'floating' }, u: { kind: 'utc' }, z: { kind: 'zoned', policy: 'later' }, r: { kind: 'date-range' } };
        const flags = /** @type {Record<string, any>} */ ({ u: { unique: true }, z: { index: true }, r: { index: true } });
        const model = { $model: '0.1', entities: { Ev: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } },
          ...Object.fromEntries(Object.entries(kinds).map(([member, temporal]) => [member,
            { type: 'object', 'x-entity': { temporal, ...flags[member] } }])) }, required: ['id'] } } } };
        const created = await engine.open(model);
        await created.close();
        const connection = await engine.connection();
        let derived;
        try {
          const read = await introspectModel(connection, { temporals: temporalSeam });
          derived = read.model;
          assert.deepEqual(read.report.filter((/** @type {any} */ row) => /unmapped-(column|constraint|index)/.test(row.code)), []);
        }
        finally { await connection.close?.(); }
        assert.deepEqual(derived.entities.Ev.schema.properties, model.entities.Ev.schema.properties);
        const reopened = await engine.open(derived);
        await reopened.close();
        const steps = planModelMigration(derived, model, { dialect: engine.dialect, id: 'again' }).migration.steps;
        assert.deepEqual(steps, [], JSON.stringify(steps.map((/** @type {any} */ s) => s.note)));
        // without the seam no CHECK is a member's: each is a loss, and so is each generated key
        const bare = await engine.connection();
        try {
          const read = await introspectModel(bare);
          assert.equal('u' in read.model.entities.Ev.schema.properties, false);
          assert.ok(read.report.some((/** @type {any} */ row) => row.code === 'unmapped-constraint' && /u_temporal/.test(row.object)));
          assert.ok(read.report.some((/** @type {any} */ row) => row.code === 'unmapped-column' && /Ev\.tk_u$/.test(row.object)));
        }
        finally { await bare.close?.(); }
      });
    });
  });
}
