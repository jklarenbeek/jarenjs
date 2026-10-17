//@ts-check
/**
 * @file A unique index on SQLite over a member whose generated column has a
 * real SQL type: `REAL` for `number`, `INTEGER` for `integer` and `boolean`,
 * `TEXT` for `string`. The store does not validate a member against its
 * declared type by default, and such a column holds a value of another kind
 * as its own type reads it (`true` and `"1"` as the `REAL` `1.0`, `1` and
 * `true` as the `TEXT` `'1'`), so the index keys, after its columns, `''`
 * for a value of the column's own kind and any other value as its text. A
 * second document is refused exactly when the query engine compares its
 * member equal to a stored one's: `true` beside `1`, `"1"` beside `1`, `1`
 * beside `"1"` are two keys, `1` beside `1.0` one. Seeks over the column are
 * unchanged. A table an earlier release created holds the index without the
 * key (or, beside an untyped column, with that column's boolean key alone):
 * it opens and answers as it did, and `planColumnUpgrade` creates the index
 * again with it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  openStore, introspectModel, planCollection, planColumnUpgrade, planModelMigration, migrate, normalizeModel, sqliteDialect, compareShapeToModel,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';

import { kindKey, tempDbPath } from './helpers.js';

/** @param {any} q @param {any[]} indexes @param {any} [k] @returns {any} */
const modelOf = (q, indexes, k = { type: 'string' }) => ({ $model: '0.1', collections: { c: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, q, k } }, indexes } } });
const SHAPES = {
  single: [{ name: 'by_q', path: '$.q', unique: true }],
  composite: [{ name: 'by_kq', path: ['$.k', '$.q'], unique: true }],
  conditional: [{ name: 'by_k', path: '$.k' }, { name: 'by_q', path: '$.q', unique: true, where: { $eq: ['$.k', 'x'] } }],
};
/** The member's declared type and its column's SQL type. */
const TYPES = /** @type {const} */ ([['number', 'REAL'], ['integer', 'INTEGER'], ['boolean', 'INTEGER'], ['string', 'TEXT']]);
/** Values of every scalar kind, some equal to others by the engine (`1`, `1.0`) or by a typed column (`true`, `1`, `'1'`). */
const VALUES = [1, 1.5, 0, true, false, '1', '1.5', 'x', 0.3, 0.30000000000000004, 1e21];
/** The statement that creates the index named `name`. @param {any} model @param {string} name @param {any} [dialect] */
const indexSql = (model, name, dialect = sqliteDialect) =>
  planCollection('c', normalizeModel(model).get('c'), dialect).createSql.find((/** @type {string} */ sql) => sql.includes(`INDEX "${name}" `));
/** @param {Promise<any>} write */
const answer = (write) => write.then(() => 'stored', (/** @type {any} */ error) => error.code);
/** @param {any} model @param {(store: any) => Promise<void>} body */
const withMemory = async (model, body) => {
  const store = await openStore(model, { driver: nodeDriver() });
  try { await body(store); }
  finally { await store.close(); }
};

describe('a unique index over a typed column on SQLite', () => {
  it('keys the member\'s kind after the column in every shape, beside a container key too, and nowhere else', () => {
    for (const [type, sql] of TYPES) {
      assert.equal(indexSql(modelOf({ type }, SHAPES.composite), 'c_by_kq'),
        `CREATE UNIQUE INDEX "c_by_kq" ON "c" ("gx_k", "gx_q", ${kindKey('k', 'TEXT')}, ${kindKey('q', sql)})`, type);
      assert.equal(indexSql(modelOf({ type }, SHAPES.conditional), 'c_by_q'),
        `CREATE UNIQUE INDEX "c_by_q" ON "c" ("gx_q", ${kindKey('q', sql)}) WHERE "gx_k" = 'x'`, type);
      // a non-unique index and PostgreSQL's typed columns key the column alone
      assert.equal(indexSql(modelOf({ type }, [{ name: 'by_q', path: '$.q' }]), 'c_by_q'), 'CREATE INDEX "c_by_q" ON "c" ("gx_q")', type);
      assert.equal(indexSql(modelOf({ type }, SHAPES.single), 'c_by_q', postgresDialect()), 'CREATE UNIQUE INDEX "c_by_q" ON "c" ("gx_q")', type);
    }
    // beside an untyped member, the index that keys its container keys the typed column's kind too
    const mixed = modelOf({ type: ['string', 'object'] }, [{ name: 'by_qk', path: ['$.q', '$.k'], unique: true }], { type: 'number' });
    assert.equal(indexSql(mixed, 'c_by_qk'),
      `CREATE UNIQUE INDEX "c_by_qk" ON "c" ("gx_q", "gx_k", (json_type("doc", '$."q"') IN ('true', 'false')), ${kindKey('k', 'REAL')})`);
    assert.equal(indexSql(mixed, 'c_by_qk$container'),
      `CREATE UNIQUE INDEX "c_by_qk$container" ON "c" ("kx_q", "gx_k", ${kindKey('k', 'REAL')}) WHERE "kx_q" IS NOT NULL`);
  });

  for (const [label, indexes] of Object.entries(SHAPES)) {
    it(`refuses a second document exactly when the query engine compares its member equal, ${label}`, async () => {
      let pairs = 0;
      const wrong = [];
      for (const [type] of TYPES) {
        // the values the column holds at all: a STRICT column refuses one its type cannot read
        const held = [];
        for (const value of VALUES) {
          await withMemory(modelOf({ type }, indexes), async (store) => {
            if (await answer(store.collection('c').insert({ id: '1', q: value, k: 'x' })) === 'stored') held.push(value);
          });
        }
        for (const first of held) {
          for (const second of held) {
            await withMemory(modelOf({ type }, indexes), async (store) => {
              const docs = store.collection('c');
              await docs.insert({ id: '1', q: first, k: 'x' });
              const equal = [await docs.execute({ $for: { it: '$[*]' }, $where: { $eq: ['$it.q', second] }, $return: '$it.id' },
                { pushdown: false })].flat().includes('1');
              const verdict = await answer(docs.insert({ id: '2', q: second, k: 'x' }));
              if (verdict !== (equal ? 'JD2005' : 'stored')) wrong.push(`${type}: ${JSON.stringify(first)} then ${JSON.stringify(second)}: ${verdict}`);
              // outside the condition nothing is refused
              if (label === 'conditional') assert.equal(await answer(docs.insert({ id: '3', q: second, k: 'y' })), 'stored');
              pairs++;
            });
          }
        }
      }
      assert.deepEqual(wrong, []);
      assert.equal(pairs, 271);
    });
  }

  it('keeps an untyped member\'s container apart by the typed member beside it', async () => {
    const model = modelOf({ type: ['string', 'object'] }, [{ name: 'by_qk', path: ['$.q', '$.k'], unique: true }], { type: 'number' });
    await withMemory(model, async (store) => {
      const docs = store.collection('c');
      await docs.insert({ id: '1', q: { a: 1, b: 2 }, k: 1 });
      assert.deepEqual([await answer(docs.insert({ id: '2', q: { b: 2, a: 1 }, k: true })), await answer(docs.insert({ id: '3', q: { b: 2, a: 1 }, k: '1' })),
        await answer(docs.insert({ id: '4', q: { b: 2, a: 1 }, k: 1 })), await answer(docs.insert({ id: '5', q: 'z', k: true })),
        await answer(docs.insert({ id: '6', q: 'z', k: true }))], ['stored', 'stored', 'JD2005', 'stored', 'JD2005']);
    });
  });

  it('refuses a duplicate as a constraint, names a held key as the key, seeks as before, and keys what another writer spells', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const model = modelOf({ type: 'number' }, SHAPES.single);
      const store = await openStore(model, { driver: nodeDriver(), path: dbPath });
      try {
        const docs = store.collection('c');
        await docs.insert({ id: 'a', q: 1 });
        await docs.insert({ id: 'b', q: true });
        const refused = await docs.put({ id: 'c', q: 1 }).then(() => null, (/** @type {any} */ error) => error);
        assert.deepEqual([refused?.code, refused?.class, refused?.retryable, refused?.collection, refused?.key], ['JD2005', 'constraint', false, 'c', 'c']);
        assert.equal(await answer(docs.insert({ id: 'b', q: 2 })), 'JD2001');
        for (const $where of [{ $eq: ['$it.q', 1] }, { $gt: ['$it.q', 1] }])
          assert.deepEqual((await docs.explain({ $for: { it: '$[*]' }, $where, $return: '$it.id' })).indexes, ['c_by_q']);
      }
      finally { await store.close(); }
      const raw = new DatabaseSync(dbPath);
      try {
        const write = (/** @type {string} */ key, /** @type {string} */ text) => {
          try { raw.prepare('INSERT INTO "c" ("key", "doc") VALUES (?, jsonb(?))').run(key, text); return 'stored'; }
          catch (error) { return /** @type {any} */ (error).message; }
        };
        assert.deepEqual([write('d', '{"id":"d","q":"1"}'), write('e', '{"id":"e","q":1.0}'), write('f', '{"id":"f","q":"1.0"}'), write('g', '{"id":"g","q":"1"}')],
          ['stored', "UNIQUE constraint failed: index 'c_by_q'", 'stored', "UNIQUE constraint failed: index 'c_by_q'"]);
        assert.deepEqual(raw.prepare(`SELECT "key", ${kindKey('q', 'REAL')} AS "kind" FROM "c" ORDER BY "key"`).all().map((row) => [row.key, row.kind]),
          [['a', ''], ['b', 'true'], ['d', "'1'"], ['f', "'1.0'"]]);
      }
      finally { raw.close(); }
    }
    finally { cleanup(); }
  });

  /** The unique index an earlier release created for each model, without the kind key, in the table this one creates. */
  const EARLIER = /** @type {const} */ ([
    ['a typed member', modelOf({ type: 'number' }, SHAPES.single), 'c_by_q', 'CREATE UNIQUE INDEX "c_by_q" ON "c" ("gx_q")',
      { id: 'n', q: 1 }, { id: 'm', q: true }, []],
    ['a typed member beside an untyped one, keyed by its boolean key alone',
      modelOf({ type: ['string', 'boolean'] }, [{ name: 'by_qk', path: ['$.q', '$.k'], unique: true }], { type: 'integer' }), 'c_by_qk',
      'CREATE UNIQUE INDEX "c_by_qk" ON "c" ("gx_q", "gx_k", (json_type("doc", \'$."q"\') IN (\'true\', \'false\')))',
      { id: 'n', q: 'b', k: 1 }, { id: 'm', q: 'b', k: true }, ['c.kx_q', 'c.c_by_qk$container']],
  ]);
  /** @param {string} file @param {any} model */
  const upgradeOf = async (file, model) => {
    const connection = await nodeDriver().open(file, {});
    try { return await planColumnUpgrade(connection, model); }
    finally { await connection.close(); }
  };
  /** What the table holds unlike a fresh store, or null. @param {string} file @param {any} model */
  const shapeDifference = async (file, model) => {
    const connection = await nodeDriver().open(file, {});
    try { return await compareShapeToModel(nodeDriver(), connection, model, undefined, undefined); }
    finally { await connection.close(); }
  };
  /** @param {string} file @param {any} model @param {any} doc */
  const insertInto = async (file, model, doc) => {
    const store = await openStore(model, { driver: nodeDriver(), path: file });
    try { return await answer(store.collection('c').insert(doc)); }
    finally { await store.close(); }
  };
  /** The model the file reads back as, and what it could not map. @param {string} file */
  const readBack = async (file) => {
    const connection = await nodeDriver().open(file, {});
    try { return await introspectModel(connection, { keys: { c: '/id' } }); }
    finally { await connection.close(); }
  };

  for (const [label, model, name, earlierIndex, first, second, containers] of EARLIER) {
    it(`opens the unique index over ${label} an earlier release created as it answered, and the upgrade keys the kind`, async () => {
      const { dbPath, cleanup } = tempDbPath();
      try {
        const raw = new DatabaseSync(dbPath);
        // the table without the column a container key needs, which no earlier release created
        const table = planCollection('c', normalizeModel(model).get('c'), sqliteDialect).createSql[0].replace(', "kx_q" TEXT', '');
        try { for (const sql of [table, earlierIndex]) raw.exec(sql); }
        finally { raw.close(); }
        assert.equal(await insertInto(dbPath, model, first), 'stored');
        assert.equal(await insertInto(dbPath, model, second), 'JD2005');
        assert.equal(await shapeDifference(dbPath, model), null);
        // read back as the declared index, which plans the same table again
        const earlier = await readBack(dbPath);
        assert.deepEqual(earlier.report.filter((/** @type {any} */ row) => row.object === `c.${name}`), []);
        assert.deepEqual(earlier.model.collections.c.indexes, model.collections.c.indexes);
        assert.deepEqual(planModelMigration(earlier.model, model, { dialect: sqliteDialect, id: 'm' }).migration.steps
          .filter((/** @type {any} */ step) => step.kind === 'ddl'), []);
        const { migration, report } = await upgradeOf(dbPath, model);
        // (and the container key an untyped member's index has, which no earlier release created)
        assert.deepEqual(report.upgraded, [`c.${name}`, ...containers]);
        const steps = migration.steps.map((/** @type {any} */ step) => step.sql);
        assert.deepEqual([steps[0], steps.filter((sql) => sql.startsWith(`CREATE UNIQUE INDEX "${name}" `))], [`DROP INDEX "${name}"`, [indexSql(model, name)]]);
        assert.deepEqual((await migrate({ driver: nodeDriver(), path: dbPath }, [migration], { baseline: model, model })).applied, [migration.id]);
        assert.deepEqual((await upgradeOf(dbPath, model)).migration.steps, []);
        assert.equal(await shapeDifference(dbPath, model), null);
        assert.equal(await insertInto(dbPath, model, second), 'stored');
        assert.equal(await insertInto(dbPath, model, { ...first, id: 'o' }), 'JD2005');
        const upgraded = await readBack(dbPath);
        assert.deepEqual(upgraded.report.filter((/** @type {any} */ row) => row.object === `c.${name}`), []);
        assert.deepEqual(upgraded.model.collections.c.indexes, model.collections.c.indexes);
      }
      finally { cleanup(); }
    });
  }

  it('reads an index keyed otherwise after its typed column back as no declared index, and refuses to open it', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const model = modelOf({ type: 'number' }, SHAPES.single);
      await (await openStore(model, { driver: nodeDriver(), path: dbPath })).close();
      const raw = new DatabaseSync(dbPath);
      try { raw.exec(`DROP INDEX "c_by_q"; CREATE UNIQUE INDEX "c_by_q" ON "c" ("gx_q", ${kindKey('q', 'TEXT')})`); }
      finally { raw.close(); }
      const refused = await openStore(model, { driver: nodeDriver(), path: dbPath }).then(async (store) => { await store.close(); return null; }, (error) => error);
      assert.equal(refused?.code, 'JD0002');
      const { report } = await readBack(dbPath);
      assert.deepEqual(report.filter((/** @type {any} */ row) => row.object === 'c.c_by_q').map((/** @type {any} */ row) => row.code), ['unmapped-index']);
    }
    finally { cleanup(); }
  });
});
