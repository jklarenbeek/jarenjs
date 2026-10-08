//@ts-check
/**
 * @file Changing an entity's or a collection's indexes is a planned, reviewable
 * migration. An added partial unique index is one CREATE carrying its
 * condition, a changed condition a DROP then a CREATE, a dropped index one
 * DROP, and identical models plan nothing; adding a unique index over rows
 * that violate it is the engine's own refusal (`JD0023` class `constraint`),
 * rolled back with the migration still pending; a table rebuild recreates the
 * index with its condition, and a member the condition reads, retyped, takes
 * the index down before its column and back after it; and every migrated
 * database reopens clean, a second run applying nothing. On SQLite, and on PostgreSQL where
 * `JAREN_PG_URL` names a server (two pooled connections at most, each test in
 * a schema of its own, dropped after it).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openStore, planModelMigration, migrate, migrationStatus, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';
import { tempDbPath } from './helpers.js';
import { PG_URL, withPostgres } from './store-core-engines.js';
import { ONE_ACTIVE, SHIFT_SCHEMA, createVerdicts, shiftModel } from './invariant-oracle.js';

const ACTIVE = `CREATE UNIQUE INDEX "Shift_one_active" ON "Shift" ("employeeId", "day") WHERE "status" IN ('active', 'pending')`;
const ONLY_ACTIVE = { ...ONE_ACTIVE, where: { $eq: ['$.status', 'active'] } };
const { where: _where, ...UNCONDITIONAL } = ONE_ACTIVE;
/** The motivating schema with a member `n` of the given type. @param {string} type */
const withN = (type) => ({ ...SHIFT_SCHEMA, properties: { ...SHIFT_SCHEMA.properties, n: { type } } });

/** A collection with one unique index over `$.s`, under the given condition. @param {any} [where] */
const collectionModel = (where = undefined) => ({ $model: '0.1', collections: { c: {
  schema: { type: 'object', required: ['a', 's'], properties: { a: { type: 'string' }, s: { type: 'string' } } }, key: '/a',
  indexes: [{ name: 'by_s', path: '$.s', unique: true, ...(where === undefined ? {} : { where }) }] } } });
const IN_XY = { $eq: ['$.s', { $seq: ['x', 'y'] }] };
/** A collection whose unique index over `$.a` holds where `$.s` is present, `s` of the given type. @param {string} type */
const conditioned = (type) => ({ $model: '0.1', collections: { c: {
  schema: { type: 'object', required: ['k', 'a'], properties: { k: { type: 'string' }, a: { type: 'string' }, s: { type } } }, key: '/k',
  indexes: [{ name: 'by_s', path: '$.s' }, { name: 'one_a', path: '$.a', unique: true, where: { $exists: '$.s' } }] } } });

const DIALECTS = /** @type {const} */ ([['sqlite', sqliteDialect], ['postgres', postgresDialect()]]);
/** The statements of the plan from one model to another. @param {any} from @param {any} to @param {any} dialect */
const planned = (from, to, dialect) => planModelMigration(from, to, { dialect, id: 'm' }).migration.steps.map((step) => step.sql ?? step.kind);

describe('planning an index change', () => {
  for (const [engine, dialect] of DIALECTS) {
    it(`${engine}: an entity index is created with its condition, changed by a DROP then a CREATE, and dropped`, () => {
      assert.deepEqual(planned(shiftModel([]), shiftModel(), dialect), [ACTIVE]);
      assert.deepEqual(planned(shiftModel(), shiftModel([ONLY_ACTIVE]), dialect), ['DROP INDEX "Shift_one_active"',
        `CREATE UNIQUE INDEX "Shift_one_active" ON "Shift" ("employeeId", "day") WHERE "status" = 'active'`]);
      assert.deepEqual(planned(shiftModel([UNCONDITIONAL]), shiftModel(), dialect), ['DROP INDEX "Shift_one_active"', ACTIVE]);
      assert.deepEqual(planned(shiftModel(), shiftModel([UNCONDITIONAL]), dialect), ['DROP INDEX "Shift_one_active"',
        'CREATE UNIQUE INDEX "Shift_one_active" ON "Shift" ("employeeId", "day")']);
      assert.deepEqual(planned(shiftModel(), shiftModel([]), dialect), ['DROP INDEX "Shift_one_active"']);
      assert.deepEqual(planned(shiftModel(), shiftModel(), dialect), []);
      assert.deepEqual(planned(shiftModel([ONLY_ACTIVE]), shiftModel([ONLY_ACTIVE]), dialect), []);
    });

    it(`${engine}: a collection index whose condition changed is dropped and recreated`, () => {
      assert.deepEqual(planned(collectionModel(), collectionModel(IN_XY), dialect), ['DROP INDEX "c_by_s"',
        `CREATE UNIQUE INDEX "c_by_s" ON "c" ("gx_s") WHERE "gx_s" IN ('x', 'y')`]);
      assert.deepEqual(planned(collectionModel(IN_XY), collectionModel({ $eq: ['$.s', 'x'] }), dialect), ['DROP INDEX "c_by_s"',
        `CREATE UNIQUE INDEX "c_by_s" ON "c" ("gx_s") WHERE "gx_s" = 'x'`]);
      assert.deepEqual(planned(collectionModel(IN_XY), collectionModel(), dialect), ['DROP INDEX "c_by_s"',
        'CREATE UNIQUE INDEX "c_by_s" ON "c" ("gx_s")']);
      assert.deepEqual(planned(collectionModel(IN_XY), collectionModel(IN_XY), dialect), []);
    });

    it(`${engine}: an index whose condition reads a retyped member is dropped before its column and recreated after`, () => {
      const steps = planned(conditioned('string'), conditioned('integer'), dialect);
      const dropIndex = steps.indexOf('DROP INDEX "c_one_a"');
      const dropColumn = steps.findIndex((sql) => /DROP COLUMN "gx_s"/.test(sql));
      const addColumn = steps.findIndex((sql) => /ADD COLUMN "gx_s"/.test(sql));
      const create = steps.indexOf(`CREATE UNIQUE INDEX "c_one_a" ON "c" ("gx_a") WHERE "gx_s" IS NOT NULL`);
      assert.ok(dropIndex >= 0 && dropIndex < dropColumn && dropColumn < addColumn && addColumn < create, JSON.stringify(steps));
    });

    it(`${engine}: a table rebuild recreates the index with its condition`, () => {
      const steps = planModelMigration(shiftModel([ONE_ACTIVE], withN('string')), shiftModel([ONE_ACTIVE], withN('integer')),
        { dialect, id: 'm' }).migration.steps;
      const rebuild = steps.find((step) => step.kind === 'rebuild');
      assert.ok(rebuild !== undefined, 'a type change rebuilds the table');
      assert.ok(rebuild.indexes.includes(ACTIVE), JSON.stringify(rebuild.indexes));
    });
  }
});

/**
 * One engine's handles for the live scenarios: a store over `model`, a
 * migration run, its status, and the rows of a table.
 * @typedef {{ open: (model: any) => Promise<any>, run: (migrations: any[], from: any, to: any) => Promise<any>,
 *   status: (migrations: any[]) => Promise<any>, count: (table: string) => Promise<number>,
 *   indexes: () => Promise<string[]>, dialect: any }} Engine
 */

/** A fresh SQLite file. @param {(engine: Engine) => Promise<void>} fn */
async function onSqlite(fn) {
  const { dbPath: path, cleanup } = tempDbPath();
  const read = (/** @type {string} */ sql) => {
    const db = new DatabaseSync(path);
    try { return db.prepare(sql).all(); }
    finally { db.close(); }
  };
  try {
    await fn({
      dialect: sqliteDialect,
      open: (model) => openStore(model, { driver: nodeDriver(), path }),
      run: (migrations, from, to) => migrate({ driver: nodeDriver(), path }, migrations, { baseline: from, model: to }),
      status: (migrations) => migrationStatus({ driver: nodeDriver(), path }, migrations),
      count: async (table) => Number(read(`SELECT count(*) AS n FROM "${table}"`)[0].n),
      indexes: async () => read("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").map((row) => String(row.name)),
    });
  }
  finally { cleanup(); }
}

/** A fresh PostgreSQL schema; migrations run without a shadow database. @param {(engine: Engine) => Promise<void>} fn */
async function onPostgres(fn) {
  await withPostgres(async ({ pool, schema, driver }) => {
    await fn({
      dialect: postgresDialect({ searchPath: schema }),
      open: (model) => openStore(model, { driver: driver() }),
      run: (migrations, from, to) => migrate({ driver: driver() }, migrations, { baseline: from, model: to, shadow: false }),
      status: (migrations) => migrationStatus({ driver: driver() }, migrations),
      count: async (table) => Number((await pool.query(`SELECT count(*)::int AS n FROM "${schema}"."${table}"`)).rows[0].n),
      indexes: async () => (await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname NOT LIKE '%_pkey' ORDER BY indexname",
        [schema])).rows.map((row) => String(row.indexname)),
    });
  });
}

const ENGINES = /** @type {const} */ ([['sqlite', onSqlite, false], ['postgres', onPostgres, !PG_URL && 'JAREN_PG_URL is not set']]);

/** Seed a store over `model` with rows, then close it. @param {Engine} engine @param {any} model @param {string} entity @param {any[]} rows */
async function seed(engine, model, entity, rows) {
  const store = await engine.open(model);
  try { for (const row of rows) await (entity === 'c' ? store.collection('c').insert(row) : store.entity(entity).create(row)); }
  finally { await store.close(); }
}

/** Plan, migrate, reopen clean, run again for nothing; the reopened store goes to `use`. A
 * draft transform is dropped: the seeded documents stay valid under the target schema.
 * @param {Engine} engine @param {any} from @param {any} to @param {(store: any) => Promise<void>} use
 * @returns {Promise<any>} the migration, which a later one is planned after */
async function migrated(engine, from, to, use) {
  const { migration } = planModelMigration(from, to, { dialect: engine.dialect, id: 'change-index' });
  migration.steps = migration.steps.filter((/** @type {any} */ step) => !(step.kind === 'jslt' && step.draft));
  assert.deepEqual((await engine.run([migration], from, to)).applied, ['change-index']);
  const again = await engine.run([migration], from, to);
  assert.deepEqual(again.applied, [], 'a second run applies nothing');
  const store = await engine.open(to);
  try { await use(store); }
  finally { await store.close(); }
  return migration;
}

for (const [name, on, skip] of ENGINES) {
  describe(`migrating index changes on ${name}`, { skip }, () => {
    it('adds the motivating index to a populated table, which then refuses a second active shift', async () => {
      await on(async (engine) => {
        await seed(engine, shiftModel([]), 'Shift', [{ id: 's1', employeeId: 'e1', day: 'd1', status: 'active' },
          { id: 's3', employeeId: 'e1', day: 'd1', status: 'cancelled' }, { id: 's4', employeeId: 'e1', day: 'd1' }]);
        await migrated(engine, shiftModel([]), shiftModel(), async (store) => {
          assert.deepEqual(await createVerdicts(store.entity('Shift'), [{ id: 's2', employeeId: 'e1', day: 'd1', status: 'active' },
            { id: 's5', employeeId: 'e1', day: 'd1', status: 'pending' }, { id: 's6', employeeId: 'e1', day: 'd1', status: 'cancelled' }]),
          ['JD2005/constraint', 'JD2005/constraint', 'ok']);
        });
        assert.deepEqual(await engine.indexes(), ['Shift_one_active']);
      });
    });

    it('refuses to add a unique index over rows that violate it, and keeps the migration pending', async () => {
      await on(async (engine) => {
        await seed(engine, shiftModel([]), 'Shift', [{ id: 's1', employeeId: 'e1', day: 'd1', status: 'active' },
          { id: 's2', employeeId: 'e1', day: 'd1', status: 'active' }]);
        const { migration } = planModelMigration(shiftModel([]), shiftModel(), { dialect: engine.dialect, id: 'add-one-active' });
        await assert.rejects(engine.run([migration], shiftModel([]), shiftModel()),
          (/** @type {any} */ error) => error.code === 'JD0023' && error.class === 'constraint');
        assert.equal(await engine.count('Shift'), 2);
        assert.deepEqual(await engine.indexes(), []);
        const status = await engine.status([migration]);
        assert.deepEqual([status.applied, status.pending], [[], ['add-one-active']]);
        await assert.rejects(engine.open(shiftModel()), (/** @type {any} */ error) => error.code === 'JD0002');
      });
    });

    it('changes a condition by a DROP then a CREATE, and drops an index', async () => {
      await on(async (engine) => {
        await seed(engine, shiftModel(), 'Shift', [{ id: 's1', employeeId: 'e1', day: 'd1', status: 'active' }]);
        const changed = await migrated(engine, shiftModel(), shiftModel([ONLY_ACTIVE]), async (store) => {
          // pending is no longer covered by the condition
          assert.deepEqual(await createVerdicts(store.entity('Shift'), [{ id: 's5', employeeId: 'e1', day: 'd1', status: 'pending' },
            { id: 's2', employeeId: 'e1', day: 'd1', status: 'active' }]), ['ok', 'JD2005/constraint']);
        });
        const dropped = planModelMigration(shiftModel([ONLY_ACTIVE]), shiftModel([]), { dialect: engine.dialect, id: 'drop-index' }).migration;
        assert.deepEqual((await engine.run([changed, dropped], shiftModel(), shiftModel([]))).applied, ['drop-index']);
        assert.deepEqual(await engine.indexes(), []);
        const store = await engine.open(shiftModel([]));
        try { assert.deepEqual(await createVerdicts(store.entity('Shift'), [{ id: 's7', employeeId: 'e1', day: 'd1', status: 'active' }]), ['ok']); }
        finally { await store.close(); }
      });
    });

    it('recreates the index with its condition after a table rebuild', async () => {
      await on(async (engine) => {
        const from = shiftModel([ONE_ACTIVE], withN('string'));
        const to = shiftModel([ONE_ACTIVE], withN('integer'));
        await seed(engine, from, 'Shift', [{ id: 's1', employeeId: 'e1', day: 'd1', status: 'active' }]);
        await migrated(engine, from, to, async (store) => {
          assert.deepEqual(await createVerdicts(store.entity('Shift'), [{ id: 's3', employeeId: 'e1', day: 'd1', status: 'cancelled' },
            { id: 's2', employeeId: 'e1', day: 'd1', status: 'active' }]), ['ok', 'JD2005/constraint']);
        });
      });
    });

    it('rebuilds an index whose condition reads a member the migration retypes', async () => {
      await on(async (engine) => {
        await seed(engine, conditioned('string'), 'c', [{ k: '1', a: 'x' }, { k: '2', a: 'x' }]);
        await migrated(engine, conditioned('string'), conditioned('integer'), async (store) => {
          const c = store.collection('c');
          await c.insert({ k: '3', a: 'y', s: 1 });
          await assert.rejects(c.insert({ k: '4', a: 'y', s: 2 }), (/** @type {any} */ error) => error.code === 'JD2005' && error.class === 'constraint');
          await c.insert({ k: '5', a: 'y' });
        });
      });
    });

    it('recreates a collection index whose condition changed', async () => {
      await on(async (engine) => {
        await seed(engine, collectionModel(), 'c', [{ a: '1', s: 'x' }, { a: '2', s: 'z' }]);
        await migrated(engine, collectionModel(), collectionModel(IN_XY), async (store) => {
          const c = store.collection('c');
          await c.insert({ a: '3', s: 'z' });
          await assert.rejects(c.insert({ a: '4', s: 'x' }), (/** @type {any} */ error) => error.code === 'JD2005' && error.class === 'constraint');
        });
      });
    });
  });
}
