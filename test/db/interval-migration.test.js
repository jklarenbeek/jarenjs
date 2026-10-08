//@ts-check
/**
 * @file Adding, changing and removing a collection's interval declaration are
 * planned migrations. PostgreSQL adds the CHECK in place — one `ADD
 * CONSTRAINT`, which validates every row inside the link's transaction,
 * one `DROP CONSTRAINT` to remove it, the two to change it — after the bound
 * columns and indexes the same link adds; SQLite, which has no `ADD
 * CONSTRAINT`, rebuilds the collection in ONE step of the documented
 * procedure, the copy keeping every rowid (the collection's order, and the
 * ids of an R*Tree, which outlives the dropped table), and an atomic run
 * cannot hold it (`JD0026`). Before any step of a link runs, the stored rows
 * of every collection whose declaration is new or changed are counted
 * against the target CHECK, from the link's exact identity: a non-zero count
 * is refused `JD0021` naming the collection, the interval, the count and the
 * first keys in row order, and nothing changes — also where the same link
 * adds the bound columns, or renames the collection (counted under its
 * from-side table). A dry run lists the precondition and counts nothing; a
 * `0.1` document carries no identity and is admitted as before.
 * `introspectModel` reads the declaration back, the bounds required and
 * typed `integer`, with no loss row for it. On SQLite, and on PostgreSQL
 * where `JAREN_PG_URL` names a server (two pooled connections, each test in
 * a schema of its own, dropped after it).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  openStore, planModelMigration, migrate, migrationStatus, introspectModel, normalizeModel, planCollection, sqliteDialect,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';

import { tempDbPath } from './helpers.js';
import { PG_URL, withPostgres } from './store-core-engines.js';

const HOUR = 3_600_000;
const SPAN = { type: 'object', required: ['start', 'end'], properties: { start: { type: 'integer' }, end: { type: 'integer' } } };
const BOUNDS = [{ name: 'by_start', path: '$.span.start' }, { name: 'by_end', path: '$.span.end' }];
const SLOT = { name: 'slot', path: '$.span' };
const BOUNDED = { ...SLOT, maxDuration: 8 * HOUR };
const CELL = { name: 'by_cell', path: '$.at', derive: 'geohash', precision: 6 };
const BOX = { name: 'by_box', path: '$.at', derive: 'bbox', physical: 'rtree' };

/**
 * The booking model: a text-keyed collection with a span member, its two
 * bound indexes and whatever else the case declares.
 * @param {{ intervals?: any[], indexes?: any[], name?: string, rename?: string }} [options]
 */
const model = ({ intervals, indexes = BOUNDS, name = 'booking', rename } = {}) => ({
  $model: '0.1',
  collections: { [name]: {
    schema: { type: 'object', properties: {
      id: { type: 'string' }, span: SPAN, kind: { type: 'string' }, at: { type: 'array', items: { type: 'number' } } } },
    key: '/id',
    indexes,
    ...(intervals === undefined ? {} : { intervals }),
    ...(rename === undefined ? {} : { 'x-rename': rename }),
  } },
});
const UNDECLARED = model();
const DECLARED = model({ intervals: [SLOT] });
const BOUNDED_MODEL = model({ intervals: [BOUNDED] });
const RENAMED = model({ name: 'reservation', rename: 'booking', intervals: [SLOT] });

const REGION = { type: 'Polygon', coordinates: [[[4.7, 52.30], [5.1, 52.30], [5.1, 52.45], [4.7, 52.45], [4.7, 52.30]]] };
const INTERSECTS = { $for: { it: '$[*]' }, $where: { '$bbox-intersects': ['$it.at', REGION] }, $return: '$it.id' };
/** The ids the R*Tree answers for the region, as a list whatever their number. @param {any} booking */
const hits = async (booking) => [].concat(await booking.execute(INTERSECTS) ?? []);

/** The steps of the plan from one model to another. @param {any} from @param {any} to @param {any} dialect @param {any} [options] */
const plan = (from, to, dialect, options = {}) => planModelMigration(from, to, { dialect, id: 'declare', ...options }).migration.steps;
/** @param {any[]} steps */
const texts = (steps) => steps.map((step) => step.sql ?? step.kind);
/** The physical plan of a model's one collection. @param {any} document @param {any} dialect @param {string} [name] */
const planned = (document, dialect, name = 'booking') => planCollection(name, normalizeModel(document).get(name), dialect);
/** The CHECK a model's interval installs, as the dialect spells it. @param {any} document @param {any} dialect @param {string} [name] */
const checkOf = (document, dialect, name = 'booking') => planned(document, dialect, name).intervals[0].sql;
/** The rebuild step a SQLite plan holds for `to`, without its note. @param {any} to @param {string[]} [carried] */
const rebuildOf = (to, carried = []) => {
  const columns = ['"rowid"', '"key"', '"doc"', ...carried.map((column) => `"${column}"`)].join(', ');
  return {
    kind: 'rebuild',
    table: 'booking',
    create: [planCollection('booking__rebuild', normalizeModel(to).get('booking'), sqliteDialect).createSql[0]],
    copy: `INSERT INTO "booking__rebuild" (${columns}) SELECT ${columns} FROM "booking"`,
    indexes: planned(to, sqliteDialect).createSql.slice(1),
  };
};
/** @param {any} step */
const shapeOf = ({ kind, table, create, copy, indexes }) => ({ kind, table, create, copy, indexes });

describe('planning an interval declaration', () => {
  const pg = postgresDialect();
  const ADD = `ALTER TABLE "booking" ADD CONSTRAINT "slot_interval" CHECK (${checkOf(DECLARED, pg)})`;
  const DROP = 'ALTER TABLE "booking" DROP CONSTRAINT "slot_interval"';

  it('postgres: one ADD CONSTRAINT to add, one DROP CONSTRAINT to remove, the two to change, nothing for identical models', () => {
    assert.deepEqual(texts(plan(UNDECLARED, DECLARED, pg)), [ADD]);
    assert.ok(!ADD.includes('NOT VALID'), 'the constraint validates every row as it is added');
    assert.deepEqual(texts(plan(DECLARED, UNDECLARED, pg)), [DROP]);
    assert.deepEqual(texts(plan(DECLARED, BOUNDED_MODEL, pg)),
      [DROP, `ALTER TABLE "booking" ADD CONSTRAINT "slot_interval" CHECK (${checkOf(BOUNDED_MODEL, pg)})`]);
    assert.deepEqual(texts(plan(DECLARED, DECLARED, pg)), []);
    assert.deepEqual(texts(plan(BOUNDED_MODEL, BOUNDED_MODEL, pg)), []);
  });

  it('postgres: the ADD CONSTRAINT follows the bound columns and indexes the link adds, and a rename in the link comes first', () => {
    const steps = texts(plan(model({ indexes: [] }), DECLARED, pg));
    assert.equal(steps.length, 5, JSON.stringify(steps));
    assert.ok(steps.slice(0, 4).every((sql) => /ADD COLUMN "gx_span_(start|end)"|CREATE INDEX "booking_by_(start|end)"/.test(sql)), JSON.stringify(steps));
    assert.equal(steps[4], ADD);
    const renamed = texts(plan(UNDECLARED, RENAMED, pg));
    assert.equal(renamed[0], 'ALTER TABLE "booking" RENAME TO "reservation"');
    assert.equal(renamed.at(-1), `ALTER TABLE "reservation" ADD CONSTRAINT "slot_interval" CHECK (${checkOf(RENAMED, pg, 'reservation')})`);
    assert.equal(renamed.filter((sql) => sql.includes('CONSTRAINT')).length, 1, JSON.stringify(renamed));
  });

  it('sqlite: adding, changing and removing the declaration is ONE rebuild step whose copy keeps every rowid', () => {
    for (const [from, to] of [[UNDECLARED, DECLARED], [DECLARED, BOUNDED_MODEL], [BOUNDED_MODEL, UNDECLARED]]) {
      const steps = plan(from, to, sqliteDialect);
      assert.equal(steps.length, 1, JSON.stringify(texts(steps)));
      assert.deepEqual(shapeOf(steps[0]), rebuildOf(to));
      assert.equal(typeof steps[0].note, 'string');
      assert.equal(steps[0].create[0].includes('CONSTRAINT "slot_interval" CHECK'), to !== UNDECLARED);
    }
    assert.deepEqual(plan(DECLARED, DECLARED, sqliteDialect), []);
    assert.deepEqual(plan(BOUNDED_MODEL, BOUNDED_MODEL, sqliteDialect), []);
  });

  it('sqlite: a rebuilding collection takes no other column or index step in the link, and a rename still runs first', () => {
    const steps = plan(model({ indexes: [] }), DECLARED, sqliteDialect);
    assert.deepEqual(texts(steps), ['rebuild']);
    assert.deepEqual(shapeOf(steps[0]), rebuildOf(DECLARED));
    const renamed = plan(UNDECLARED, RENAMED, sqliteDialect);
    assert.deepEqual(texts(renamed), ['ALTER TABLE "booking" RENAME TO "reservation"', 'rebuild']);
    assert.equal(renamed[1].table, 'reservation');
    assert.equal(renamed[1].copy, 'INSERT INTO "reservation__rebuild" ("rowid", "key", "doc") SELECT "rowid", "key", "doc" FROM "reservation"');
  });

  it('sqlite: an R*Tree the table keeps is not recreated — its sync triggers are, since DROP TABLE takes them', () => {
    const from = model({ indexes: [...BOUNDS, BOX] });
    const to = model({ indexes: [...BOUNDS, BOX], intervals: [SLOT] });
    const [step] = plan(from, to, sqliteDialect);
    const [virtual] = planned(to, sqliteDialect).virtualTables;
    assert.equal(step.kind, 'rebuild');
    assert.ok(!step.indexes.includes(virtual.createSql), 'the virtual table survives the dropped table');
    assert.ok(!step.indexes.includes(virtual.fillSql), 'its rows survive with it');
    for (const trigger of virtual.triggers) assert.ok(step.indexes.includes(trigger.sql), trigger.name);
    // one the link adds beside the declaration is created whole, filled from the copied rows
    const rebuilt = plan(UNDECLARED, to, sqliteDialect);
    assert.deepEqual(texts(rebuilt), ['rebuild']);
    const [added] = rebuilt;
    assert.ok(added.indexes.includes(virtual.createSql) && added.indexes.includes(virtual.fillSql));
    assert.ok(added.indexes.indexOf(virtual.createSql) < added.indexes.indexOf(virtual.fillSql));
  });

  it('sqlite: the copy carries a stored derived column the table keeps, and a new one is backfilled after the rebuild', () => {
    const stored = { derived: 'stored' };
    const kept = model({ indexes: [...BOUNDS, CELL] });
    const keptDeclared = model({ indexes: [...BOUNDS, CELL], intervals: [SLOT] });
    const [column] = planCollection('booking', normalizeModel(kept).get('booking'), sqliteDialect, stored).generated
      .filter((g) => g.stored === true).map((g) => g.name);
    assert.ok(column !== undefined, 'the geohash column is stored under this mapping');
    const steps = plan(kept, keptDeclared, sqliteDialect, stored);
    assert.deepEqual(texts(steps), ['rebuild']);
    assert.equal(steps[0].copy, `INSERT INTO "booking__rebuild" ("rowid", "key", "doc", "${column}") SELECT "rowid", "key", "doc", "${column}" FROM "booking"`);
    const added = plan(UNDECLARED, keptDeclared, sqliteDialect, stored);
    assert.deepEqual(texts(added), ['rebuild', 'derive']);
    assert.equal(added[0].copy, 'INSERT INTO "booking__rebuild" ("rowid", "key", "doc") SELECT "rowid", "key", "doc" FROM "booking"');
    assert.deepEqual(added[1].columns.map((c) => c.name), [column]);
  });
});

/**
 * One engine's handles for the live scenarios.
 * @typedef {{ dialect: any,
 *   open: (model: any, options?: any) => Promise<any>,
 *   run: (migrations: any[], from: any, to: any, options?: any) => Promise<any>,
 *   status: (migrations: any[]) => Promise<any>,
 *   connection: () => Promise<any>,
 *   rawInsert: (table: string, key: string, doc: any) => Promise<void>,
 *   dropIndex: (name: string) => Promise<void>,
 *   shape: () => Promise<any>,
 *   keys: (table: string) => Promise<string[]>,
 *   checks: (table: string) => Promise<{ name: string, validated: boolean }[]>,
 *   declaredText: (table: string) => Promise<string | null> }} Engine
 */

/**
 * A driver whose connections record every statement they prepare, inside a
 * transaction's scope too — what a dry run must not count with.
 * @param {any} driver @param {string[]} prepared
 */
const preparing = (driver, prepared) => {
  /** @param {any} target @returns {any} */
  const recording = (target) => Object.freeze({
    ...target,
    /** @param {string} sql @param {any[]} rest */
    prepare: (sql, ...rest) => { prepared.push(String(sql)); return target.prepare(sql, ...rest); },
    /** @param {(scope: any) => any} fn @param {any[]} rest */
    transaction: (fn, ...rest) => target.transaction((scope) => fn(recording(scope)), ...rest),
  });
  return { ...driver, open: (/** @type {any[]} */ ...args) => Promise.resolve(driver.open(...args)).then(recording) };
};

/** A fresh SQLite file. @param {(engine: Engine) => Promise<void>} fn */
async function onSqlite(fn) {
  const { dbPath: path, cleanup } = tempDbPath();
  /** @param {string} sql @param {any[]} [params] */
  const read = (sql, params = []) => {
    const db = new DatabaseSync(path);
    try { return db.prepare(sql).all(...params); }
    finally { db.close(); }
  };
  try {
    await fn({
      dialect: sqliteDialect,
      open: (document, options = {}) => openStore(document, { driver: nodeDriver(), path, ...options }),
      run: (migrations, from, to, { prepared, ...options } = {}) => migrate(
        { driver: prepared === undefined ? nodeDriver() : preparing(nodeDriver(), prepared), path },
        migrations, { baseline: from, model: to, ...options }),
      status: (migrations) => migrationStatus({ driver: nodeDriver(), path }, migrations),
      connection: () => nodeDriver().open(path, {}),
      rawInsert: async (table, key, doc) => {
        const db = new DatabaseSync(path);
        try { db.prepare(`INSERT INTO "${table}" ("key", "doc") VALUES (?, jsonb(?))`).run(key, JSON.stringify(doc)); }
        finally { db.close(); }
      },
      dropIndex: async (index) => {
        const db = new DatabaseSync(path);
        try { db.exec(`DROP INDEX "${index}"`); }
        finally { db.close(); }
      },
      shape: async () => read("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"),
      keys: async (table) => read(`SELECT "key" AS k FROM "${table}" ORDER BY "rowid"`).map((row) => String(row.k)),
      checks: async (table) => (read(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = '${table}'`)[0]?.sql ?? '')
        .toString().split('CONSTRAINT ').slice(1).map((text) => ({ name: text.slice(1, text.indexOf('"', 1)), validated: true })),
      declaredText: async (table) => (read(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = '${table}'`)[0]?.sql ?? null),
    });
  }
  finally { cleanup(); }
}

/** A fresh PostgreSQL schema; migrations run without a shadow database. @param {(engine: Engine) => Promise<void>} fn */
async function onPostgres(fn) {
  await withPostgres(async ({ pool, schema, driver }) => {
    await fn({
      dialect: postgresDialect({ searchPath: schema }),
      open: (document, options = {}) => openStore(document, { driver: driver(), ...options }),
      run: (migrations, from, to, { prepared, ...options } = {}) => migrate(
        { driver: prepared === undefined ? driver() : preparing(driver(), prepared) },
        migrations, { baseline: from, model: to, shadow: false, ...options }),
      status: (migrations) => migrationStatus({ driver: driver() }, migrations),
      connection: () => driver().open(),
      rawInsert: async (table, key, doc) => {
        await pool.query(`INSERT INTO "${schema}"."${table}" ("key", "doc") VALUES ($1, $2::jsonb)`, [key, JSON.stringify(doc)]);
      },
      dropIndex: async (index) => { await pool.query(`DROP INDEX "${schema}"."${index}"`); },
      shape: async () => (await pool.query('SELECT c.relname AS name, a.attname AS column FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid '
        + "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r', 'i') AND a.attnum > 0 "
        + 'AND NOT a.attisdropped ORDER BY 1, 2', [schema])).rows,
      keys: async (table) => (await pool.query(`SELECT "key" AS k FROM "${schema}"."${table}" ORDER BY "rid"`)).rows.map((row) => String(row.k)),
      checks: async (table) => (await pool.query('SELECT c.conname AS name, c.convalidated AS validated FROM pg_constraint c '
        + 'JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace '
        + "WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = 'c' ORDER BY 1", [schema, table])).rows
        .map((row) => ({ name: String(row.name), validated: row.validated === true })),
      declaredText: async () => null,
    });
  });
}

const ENGINES = /** @type {const} */ ([['sqlite', onSqlite, false], ['postgres', onPostgres, !PG_URL && 'JAREN_PG_URL is not set']]);

/** Store `docs` through a store over `document`, then close it. @param {Engine} engine @param {any} document @param {any[]} docs @param {string} [name] */
async function seed(engine, document, docs, name = 'booking') {
  const store = await engine.open(document);
  try { for (const doc of docs) await store.collection(name).insert(doc); }
  finally { await store.close(); }
}

/** An inverted row through the store and a half span through raw SQL: two rows the declaration refuses. @param {Engine} engine @param {any} document @param {string} [name] */
async function violating(engine, document, name = 'booking') {
  await seed(engine, document, [{ id: 'ok', span: { start: 1, end: 2 } }, { id: 'a', span: { start: 5, end: 1 } }], name);
  await engine.rawInsert(name, 'b', { id: 'b', span: { start: 5 } });
}

/** The refusal of a link over violating rows, with nothing changed. @param {Engine} engine @param {any} migration @param {any} from @param {any} to @param {string} collection @param {string} table */
async function refused(engine, migration, from, to, collection, table) {
  const before = { shape: await engine.shape(), keys: await engine.keys(table) };
  await assert.rejects(engine.run([migration], from, to), (/** @type {any} */ error) => {
    assert.equal(error.code, 'JD0021', error.message);
    assert.match(error.message, new RegExp(`collection '${collection}': 2 stored document\\(s\\) violate interval 'slot' \\(first keys: 'a', 'b'\\)`));
    return true;
  });
  assert.deepEqual({ shape: await engine.shape(), keys: await engine.keys(table) }, before, 'no DDL ran and no row moved');
  const status = await engine.status([migration]);
  assert.deepEqual([status.applied, status.pending], [[], ['declare']]);
}

/**
 * Plan `from` → `to`, apply it after `applied`, run the list again for
 * nothing, and hand the reopened store to `use`.
 * @param {Engine} engine @param {any[]} applied @param {any} baseline @param {any} from @param {any} to @param {string} id
 * @param {(store: any) => Promise<void>} use
 */
async function migrated(engine, applied, baseline, from, to, id, use) {
  const { migration } = planModelMigration(from, to, { dialect: engine.dialect, id });
  applied.push(migration);
  assert.deepEqual((await engine.run(applied, baseline, to)).applied, [id]);
  assert.deepEqual((await engine.run(applied, baseline, to)).applied, [], 'a second run applies nothing');
  const store = await engine.open(to);
  try { await use(store); }
  finally { await store.close(); }
}

for (const [name, on, skip] of ENGINES) {
  describe(`migrating an interval declaration on ${name}`, { skip }, () => {
    it('refuses JD0021 naming the count and the first keys over an inverted row and a raw half span, changing nothing', async () => {
      await on(async (engine) => {
        await violating(engine, UNDECLARED);
        const { migration } = planModelMigration(UNDECLARED, DECLARED, { dialect: engine.dialect, id: 'declare' });
        await refused(engine, migration, UNDECLARED, DECLARED, 'booking', 'booking');
        // a dry run lists the precondition and counts nothing
        /** @type {string[]} */
        const prepared = [];
        const dry = await engine.run([migration], UNDECLARED, DECLARED, { dryRun: true, shadow: false, prepared });
        assert.deepEqual(dry.pending, ['declare']);
        assert.ok(dry.statements.includes("-- precondition: interval 'slot' on 'booking'"), JSON.stringify(dry.statements));
        assert.deepEqual(prepared.filter((sql) => /OVER \(\)/.test(sql)), [], 'the dry run counted');
        // a 0.1 document carries no identity: admitted (and refused) exactly as before
        const legacy = { $migration: '0.1', id: 'declare', from: migration.from, to: migration.to, steps: migration.steps };
        await assert.rejects(engine.run([legacy], UNDECLARED, DECLARED), { code: 'JD0028' });
      });
    });

    it('counts the rows where the link also adds the bound columns, and under the from-side table where it renames the collection', async () => {
      await on(async (engine) => {
        const bare = model({ indexes: [] });
        await violating(engine, bare);
        const { migration } = planModelMigration(bare, DECLARED, { dialect: engine.dialect, id: 'declare' });
        assert.ok(migration.steps.some((/** @type {any} */ step) => /ADD COLUMN|rebuild/.test(step.sql ?? step.kind)), 'the link adds the bound columns');
        await refused(engine, migration, bare, DECLARED, 'booking', 'booking');
        const renamed = planModelMigration(bare, RENAMED, { dialect: engine.dialect, id: 'declare' }).migration;
        assert.equal(renamed.steps[0].sql, 'ALTER TABLE "booking" RENAME TO "reservation"');
        await refused(engine, renamed, bare, RENAMED, 'reservation', 'booking');
      });
    });

    it('without violating rows adds, changes and removes the declaration: the CHECK in place, reopening clean, a second run applying nothing', async () => {
      await on(async (engine) => {
        const boxed = name === 'sqlite';
        const from = boxed ? model({ indexes: [...BOUNDS, BOX] }) : UNDECLARED;
        const declared = boxed ? model({ indexes: [...BOUNDS, BOX], intervals: [SLOT] }) : DECLARED;
        const bounded = boxed ? model({ indexes: [...BOUNDS, BOX], intervals: [BOUNDED] }) : BOUNDED_MODEL;
        const store = await engine.open(from);
        let before;
        try {
          const booking = store.collection('booking');
          await booking.insert({ id: 'ams', at: [4.9041, 52.3676], kind: 'city', span: { start: 1, end: 2 } });
          await booking.insert({ id: 'rtm', at: [4.4777, 51.9244], kind: 'city' });
          await booking.insert({ id: 'hil', at: [5.1714, 52.2292], kind: 'town', span: { start: 5, end: 9 } });
          // a gap in the rowids, so order and id are not the same thing
          await booking.delete('rtm');
          await booking.insert({ id: 'rtm', at: [4.4777, 51.9244], kind: 'city' });
          before = { order: (await booking.all()).map((doc) => doc.id), hits: boxed ? await hits(booking) : [] };
        }
        finally { await store.close(); }
        assert.deepEqual(before.order, ['ams', 'hil', 'rtm']);
        /** @type {any[]} */
        const applied = [];
        await migrated(engine, applied, from, from, declared, 'declare', async (reopened) => {
          const booking = reopened.collection('booking');
          assert.deepEqual((await booking.all()).map((doc) => doc.id), before.order, 'the order survives the copy');
          if (boxed) {
            assert.deepEqual(await hits(booking), before.hits, 'the R*Tree answers as before');
            assert.deepEqual(before.hits, ['ams']);
            await booking.insert({ id: 'utr', at: [5.0, 52.4], kind: 'city', span: { start: 1, end: 3 } });
            assert.deepEqual(await hits(booking), [...before.hits, 'utr'], 'a write after the rebuild reaches the R*Tree');
          }
          await assert.rejects(booking.put({ id: 'bad', span: { start: 9, end: 1 } }), { code: 'JD2003' });
        });
        assert.deepEqual(await engine.checks('booking'), [{ name: 'slot_interval', validated: true }]);
        const text = await engine.declaredText('booking');
        if (text !== null) assert.equal(text, planned(declared, sqliteDialect).createSql[0]);
        assert.deepEqual(plan(declared, declared, engine.dialect), []);
        await migrated(engine, applied, from, declared, bounded, 'bound', async (reopened) => {
          await assert.rejects(reopened.collection('booking').put({ id: 'long', span: { start: 0, end: 9 * HOUR } }), { code: 'JD2003' });
          await reopened.collection('booking').put({ id: 'short', span: { start: 0, end: HOUR } });
        });
        assert.deepEqual(await engine.checks('booking'), [{ name: 'slot_interval', validated: true }]);
        await migrated(engine, applied, from, bounded, from, 'undeclare', async (reopened) => {
          await reopened.collection('booking').put({ id: 'bad', span: { start: 9, end: 1 } });
          assert.deepEqual((await reopened.collection('booking').all()).map((doc) => doc.id).slice(0, 3), before.order);
        });
        assert.deepEqual(await engine.checks('booking'), []);
      });
    });

    it('introspectModel reads the declaration back, the bounds required and typed integer, with no loss row for it', async () => {
      await on(async (engine) => {
        await seed(engine, BOUNDED_MODEL, [{ id: 'ok', span: { start: 1, end: 2 } }]);
        const connection = await engine.connection();
        try {
          const { model: derived, report } = await introspectModel(connection, { keys: { booking: '/id' } });
          const booking = derived.collections.booking;
          assert.deepEqual(booking.intervals, [{ name: 'slot', path: '$.span', maxDuration: 8 * HOUR }]);
          assert.deepEqual(booking.schema.properties.span,
            { type: 'object', required: ['start', 'end'], properties: { start: { type: 'integer' }, end: { type: 'integer' } } });
          assert.deepEqual(report.filter((row) => row.code === 'unmapped-constraint'), []);
          assert.deepEqual(report.filter((row) => row.code === 'lossy-type' && /gx_span_/.test(row.object)), []);
          assert.equal(normalizeModel(derived).get('booking').intervals[0].maxDuration, 8 * HOUR);
        }
        finally { await connection.close(); }
      });
    });

    it('reports a loss row, not a declaration, for an interval CHECK whose bound index was dropped by hand', async () => {
      await on(async (engine) => {
        await seed(engine, DECLARED, [{ id: 'ok', span: { start: 1, end: 2 } }]);
        await engine.dropIndex('booking_by_start');
        const connection = await engine.connection();
        try {
          const { model: derived, report } = await introspectModel(connection, { keys: { booking: '/id' } });
          const booking = derived.collections.booking;
          assert.equal(booking.intervals, undefined, 'no model can declare an interval over an unindexed bound');
          assert.equal(booking.schema.properties.span.required, undefined);
          const losses = report.filter((row) => row.code === 'unmapped-constraint');
          assert.deepEqual(losses.map((row) => row.object), ['booking.slot_interval']);
          assert.match(losses[0].detail, /no index covers/);
          // the bounds are typed as any other generated column again
          assert.deepEqual(report.filter((row) => row.code === 'lossy-type').map((row) => row.object), ['booking.gx_span_end', 'booking.gx_span_start']);
          assert.doesNotThrow(() => normalizeModel(derived), 'the derived model is a model that normalizes');
        }
        finally { await connection.close(); }
      });
    });
  });
}

describe('an atomic run on SQLite', () => {
  it('refuses JD0026 a link that rebuilds the collection', async () => {
    await onSqlite(async (engine) => {
      await seed(engine, UNDECLARED, [{ id: 'ok', span: { start: 1, end: 2 } }]);
      const { migration } = planModelMigration(UNDECLARED, DECLARED, { dialect: sqliteDialect, id: 'declare' });
      await assert.rejects(engine.run([migration], UNDECLARED, DECLARED, { atomic: true }), { code: 'JD0026' });
      assert.deepEqual((await engine.status([migration])).pending, ['declare']);
    });
  });
});
