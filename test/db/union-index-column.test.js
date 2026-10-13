//@ts-check
/**
 * @file An indexed member the schema lets hold several types: its generated
 * column on SQLite is the engine's untyped one, so every conforming document
 * is stored, and every comparison of the member reads the column and seeks its
 * index. Where the column cannot answer (PostgreSQL, a table an earlier
 * release created in the member's first type) the comparison reads the
 * document, and `explain().indexes` names only the indexes the statement
 * spells.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import { compileJsonQuery } from '@jarenjs/json/query';
import {
  openStore, planCollection, normalizeModel, planMigration, planQuery, emitPlan,
  sqliteDialect, compareShapeToModel, migrate,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect as postgresDialectOf } from '@jarenjs/db/postgres';

const postgresDialect = postgresDialectOf();

import { tempDbPath } from './helpers.js';

/** @param {any} type @returns {any} */
const modelOf = (type) => ({
  $model: '0.1',
  collections: { c: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, q: { type }, r: { type } } },
    key: '/id', indexes: [{ name: 'by_q', path: '$.q' }] } },
});
const where = (/** @type {any} */ predicate) => ({ $for: { it: '$[*]' }, $where: predicate, $return: '$it.id' });

/** The unions the schema lets hold several types, each with the documents that conform to it. */
const UNIONS = /** @type {[any, any[]][]} */ ([
  [['boolean', 'number', 'string', 'null'], [true, 2.5, 2, 'b', null]],
  [['number', 'string'], [2, 2.5, 'b', '2']],
  [['integer', 'string'], [2, 'b', '2']],
  [['integer', 'number'], [2, 2.5]],
  [['string', 'number'], ['b', 2, 2.5]],
  [['number', 'integer', 'null'], [2.5, 2, null]],
]);

const column = (/** @type {any} */ type, /** @type {any} */ dialect = sqliteDialect) => {
  return planCollection('c', normalizeModel(modelOf(type)).get('c'), dialect);
};

describe('the column of an indexed member of several types', () => {
  it('SQLite: untyped where the union lists several types, the member\'s own type otherwise', () => {
    for (const [type] of UNIONS) {
      const plan = column(type);
      assert.strictEqual(plan.generated[0].type, 'ANY', JSON.stringify(type));
      assert.deepStrictEqual([...plan.anyKindColumns], ['gx_q'], JSON.stringify(type));
    }
    assert.strictEqual(column(['string', 'object']).generated[0].type, 'ANY');
    for (const [type, stored] of /** @type {[any, string][]} */ ([
      ['string', 'TEXT'], [['string', 'null'], 'TEXT'], [['integer', 'null'], 'INTEGER'],
      ['number', 'REAL'], [['number', 'number'], 'REAL'], ['boolean', 'INTEGER'],
    ])) {
      const plan = column(type);
      assert.strictEqual(plan.generated[0].type, stored, JSON.stringify(type));
      assert.strictEqual(plan.anyKindColumns.size, 0, JSON.stringify(type));
    }
  });

  it('PostgreSQL: the first type, as before, and no column that holds every kind', () => {
    const plan = column(['number', 'string'], postgresDialect);
    assert.strictEqual(plan.generated[0].type, postgresDialect.typeFor('number', 'generated'));
    assert.strictEqual(plan.anyKindColumns.size, 0);
  });

  it('a migration that makes a member a union drops the old column and adds the untyped one', () => {
    const steps = (/** @type {any} */ to) => planMigration(modelOf('string'), modelOf(to), { dialect: sqliteDialect })
      .migration.steps.filter((step) => step.kind === 'ddl').map((step) => step.sql);
    assert.deepStrictEqual(steps(['string', 'number']), [
      'DROP INDEX "c_by_q"',
      'ALTER TABLE "c" DROP COLUMN "gx_q"',
      'ALTER TABLE "c" ADD COLUMN "gx_q" ANY GENERATED ALWAYS AS (jsonb_extract("doc", \'$."q"\')) VIRTUAL',
      'CREATE INDEX "c_by_q" ON "c" ("gx_q")',
    ]);
    // a number-first member reads its numbers as the doubles the REAL column of the previous release held
    assert.deepStrictEqual(steps(['number', 'string']), [
      'DROP INDEX "c_by_q"',
      'ALTER TABLE "c" DROP COLUMN "gx_q"',
      'ALTER TABLE "c" ADD COLUMN "gx_q" ANY GENERATED ALWAYS AS ((CASE WHEN json_type("doc", \'$."q"\') IN (\'integer\', \'real\') '
        + 'THEN CAST(jsonb_extract("doc", \'$."q"\') AS REAL) ELSE jsonb_extract("doc", \'$."q"\') END)) VIRTUAL',
      'CREATE INDEX "c_by_q" ON "c" ("gx_q")',
    ]);
    // narrowing a union to one type retypes the column to that type
    assert.ok(planMigration(modelOf(['number', 'string']), modelOf('number'), { dialect: sqliteDialect })
      .migration.steps.some((step) => step.sql?.startsWith('ALTER TABLE "c" ADD COLUMN "gx_q" REAL GENERATED')));
  });
});

describe('SQLite stores every document the schema allows under an indexed union', () => {
  for (const [type, values] of UNIONS) {
    it(`${JSON.stringify(type)}: ${values.map((value) => JSON.stringify(value)).join(', ')}`, async () => {
      const store = await openStore(modelOf(type), { driver: nodeDriver() });
      try {
        const docs = store.collection('c');
        for (const [i, value] of values.entries()) await docs.insert({ id: `k${i}`, q: value });
        for (const [i, value] of values.entries())
          assert.deepStrictEqual(await docs.get(`k${i}`), { id: `k${i}`, q: value });
      }
      finally {
        await store.close();
      }
    });
  }
});

describe('a comparison of an indexed union member reads its column and seeks', () => {
  const MIXED = [{ id: 'n2', q: 2 }, { id: 's2', q: '2' }, { id: 'f35', q: 3.5 }, { id: 'sb', q: 'b' }, { id: 't', q: true },
    { id: 'one', q: 1 }, { id: 'f', q: false }, { id: 'zero', q: 0 }, { id: 'n10', q: 10 }, { id: 's10', q: '10' },
    { id: 'nul', q: null }, { id: 'none' }];
  const TYPE = ['boolean', 'number', 'string', 'null'];

  it('every comparison answers what the engine answers, and the number ones spell the column', async () => {
    const store = await openStore(modelOf(TYPE), { driver: nodeDriver() });
    try {
      const docs = store.collection('c');
      for (const doc of MIXED) await docs.insert(doc);
      for (const [predicate, externals] of /** @type {[any, any][]} */ ([
        [{ $eq: ['$it.q', 2] }], [{ $eq: ['$it.q', 1] }], [{ $eq: ['$it.q', 0] }], [{ $ne: ['$it.q', 2] }],
        [{ $gt: ['$it.q', 2] }], [{ $ge: ['$it.q', 3.5] }], [{ $lt: ['$it.q', 10] }], [{ $le: ['$it.q', 2] }],
        [{ $eq: ['$it.q', 'b'] }], [{ $lt: ['$it.q', 'b'] }], [{ $eq: ['$it.q', '2'] }],
        [{ $eq: ['$it.q', true] }], [{ $eq: ['$it.q', false] }], [{ $eq: ['$it.q', null] }],
        [{ $eq: ['$it.q', { $seq: [1, 2, 'b'] }] }], [{ $eq: ['$it.q', { $seq: [true, 0] }] }],
        [{ $eq: ['$it.q', '$v'] }, { v: 2 }], [{ $lt: ['$it.q', '$v'] }, { v: 10 }], [{ $eq: ['$it.q', '$v'] }, { v: 'b' }],
        [{ $and: [{ $ge: ['$it.q', 2] }, { $lt: ['$it.q', 4] }] }],
      ])) {
        const options = externals === undefined ? undefined : { externals };
        assert.deepStrictEqual(await docs.execute(where(predicate), options),
          compileJsonQuery(where(predicate))(structuredClone(MIXED), externals), JSON.stringify([predicate, externals]));
      }
      const explained = await docs.explain(where({ $eq: ['$it.q', 2] }));
      assert.ok(explained.sql.includes('"gx_q" = ?'), explained.sql);
      assert.strictEqual(explained.scanNarrative, 'SEARCH c USING INDEX c_by_q (gx_q=?)');
      assert.deepStrictEqual(explained.indexes, ['c_by_q']);
      assert.strictEqual((await docs.explain(where({ $and: [{ $ge: ['$it.q', 2] }, { $lt: ['$it.q', 4] }] }))).scanNarrative
        .startsWith('SEARCH c USING INDEX c_by_q (gx_q>? AND gx_q<?)'), true);
      assert.strictEqual((await docs.explain(where({ $eq: ['$it.q', 'b'] }))).scanNarrative, 'SEARCH c USING INDEX c_by_q (gx_q=?)');
    }
    finally {
      await store.close();
    }
  });

  it('two indexed members of several types compare as the engine compares them', async () => {
    const pairs = [{ id: 'a', q: 2, r: 2 }, { id: 'b', q: 2, r: '2' }, { id: 'c', q: 'x', r: 'x' }, { id: 'd', q: true, r: 1 },
      { id: 'e', q: 1, r: 2 }, { id: 'f', q: 'a', r: 'b' }, { id: 'g', q: null, r: null }];
    const model = modelOf(TYPE);
    model.collections.c.indexes.push({ name: 'by_r', path: '$.r' });
    const store = await openStore(model, { driver: nodeDriver() });
    try {
      const docs = store.collection('c');
      for (const doc of pairs) await docs.insert(doc);
      for (const op of ['$eq', '$ne', '$lt', '$le', '$gt', '$ge']) {
        const document = where({ [op]: ['$it.q', '$it.r'] });
        assert.deepStrictEqual(await docs.execute(document), compileJsonQuery(document)(structuredClone(pairs)), op);
      }
    }
    finally {
      await store.close();
    }
  });

  it('explain().indexes names an index only when the statement spells its column', async () => {
    const store = await openStore(modelOf(TYPE), { driver: nodeDriver() });
    try {
      const docs = store.collection('c');
      // a comparison with a boolean or a null reads the document's JSON type alone
      assert.deepStrictEqual((await docs.explain(where({ $eq: ['$it.q', true] }))).indexes, []);
      assert.deepStrictEqual((await docs.explain(where({ $eq: ['$it.q', null] }))).indexes, []);
      assert.deepStrictEqual((await docs.explain(where({ $gt: ['$it.q', 2] }))).indexes, ['c_by_q']);
      assert.deepStrictEqual((await docs.explain(where({ $eq: ['$it.id', 'x'] }))).indexes, []);
    }
    finally {
      await store.close();
    }
  });

  it('PostgreSQL: a number comparison of a string-first union reads the document and names no index', () => {
    const plan = column(['string', 'number', 'boolean', 'null'], postgresDialect);
    const shape = { collection: 'c', schema: modelOf(['string', 'number', 'boolean', 'null']).collections.c.schema,
      columnByCanonical: plan.columnByCanonical, anyKindColumns: plan.anyKindColumns,
      indexes: plan.expected.indexes, intervals: [], virtualByStem: new Map(), operators: null };
    const physical = { table: 'c', keyColumn: 'key', docColumn: 'doc' };
    const spelled = (/** @type {any} */ predicate) => {
      const planned = /** @type {any} */ (planQuery(where(predicate), shape));
      assert.strictEqual(planned.mode, 'native', JSON.stringify(predicate));
      return emitPlan(planned.plan, postgresDialect, physical).columns;
    };
    assert.deepStrictEqual(spelled({ $eq: ['$it.q', 2] }), []);
    assert.deepStrictEqual(spelled({ $eq: ['$it.q', 'b'] }), [plan.generated[0].name]);
  });
});

describe('a table an earlier release created in the member\'s first type', () => {
  /** The table that release wrote for ['string', 'number']: a TEXT column, which holds the number 2 as the text '2'. */
  const LEGACY = 'CREATE TABLE "c" ("key" TEXT PRIMARY KEY, "doc" BLOB NOT NULL, '
    + '"gx_q" TEXT GENERATED ALWAYS AS (jsonb_extract("doc", \'$."q"\')) VIRTUAL) STRICT';
  const REPAIR = [
    'DROP INDEX "c_by_q"',
    'ALTER TABLE "c" DROP COLUMN "gx_q"',
    'ALTER TABLE "c" ADD COLUMN "gx_q" ANY GENERATED ALWAYS AS (jsonb_extract("doc", \'$."q"\')) VIRTUAL',
    'CREATE INDEX "c_by_q" ON "c" ("gx_q")',
  ];
  const TYPE = ['string', 'number'];
  const ROWS = [['a', { id: 'a', q: 2 }], ['b', { id: 'b', q: 3 }], ['c', { id: 'c', q: 'x' }]];

  /** The ids a query answers: one is bare, none is nothing. */
  const ids = async (/** @type {any} */ docs, /** @type {any} */ predicate) => [await docs.execute(where(predicate))].flat().filter((id) => id !== undefined);

  /** @param {string} file @param {string} create @param {any[][]} rows */
  const seed = (file, create = LEGACY, rows = ROWS) => {
    const raw = new DatabaseSync(file);
    raw.exec(create);
    raw.exec('CREATE INDEX "c_by_q" ON "c" ("gx_q")');
    for (const [key, doc] of rows) raw.prepare('INSERT INTO "c" ("key", "doc") VALUES (?, jsonb(?))').run(key, JSON.stringify(doc));
    return raw;
  };

  it('still opens, answers as the engine does, and reads the document where its column cannot', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      seed(dbPath).close();
      const store = await openStore(modelOf(TYPE), { driver: nodeDriver(), path: dbPath });
      try {
        const docs = store.collection('c');
        assert.deepStrictEqual(await ids(docs, { $eq: ['$it.q', 2] }), ['a']);
        assert.deepStrictEqual(await ids(docs, { $gt: ['$it.q', 2] }), ['b']);
        const number = await docs.explain(where({ $eq: ['$it.q', 2] }));
        assert.ok(!number.sql.includes('"gx_q"'), number.sql);
        assert.deepStrictEqual(number.indexes, []);
        const text = await docs.explain(where({ $eq: ['$it.q', 'x'] }));
        assert.ok(text.sql.includes('"gx_q" = ?'), text.sql);
        assert.deepStrictEqual(text.indexes, ['c_by_q']);
        assert.deepStrictEqual(await ids(docs, { $eq: ['$it.q', 'x'] }), ['c']);
      }
      finally {
        await store.close();
      }
    }
    finally {
      cleanup();
    }
  });

  it('is repaired by dropping and adding its column, after which it seeks and stores every type', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const raw = seed(dbPath);
      for (const sql of REPAIR) raw.exec(sql);
      raw.close();
      const store = await openStore(modelOf(TYPE), { driver: nodeDriver(), path: dbPath });
      try {
        const docs = store.collection('c');
        await docs.insert({ id: 'd', q: 2 });
        assert.deepStrictEqual(await ids(docs, { $eq: ['$it.q', 2] }), ['a', 'd']);
        const number = await docs.explain(where({ $eq: ['$it.q', 2] }));
        assert.ok(number.sql.includes('"gx_q" = ?'), number.sql);
        assert.strictEqual(number.scanNarrative, 'SEARCH c USING INDEX c_by_q (gx_q=?)');
      }
      finally {
        await store.close();
      }
    }
    finally {
      cleanup();
    }
  });

  it('a column that differs in anything but the type word is still drift', async () => {
    for (const [create, difference] of /** @type {[string, string][]} */ ([
      [LEGACY.replace('"gx_q" TEXT', '"gx_q" INTEGER'), "column 'gx_q' is INTEGER generated, the model declares 'gx_q' ANY generated"],
      [LEGACY.replace('$."q"', '$."r"'), 'is declared as'],
    ])) {
      const { dbPath, cleanup } = tempDbPath();
      try {
        seed(dbPath, create, []).close();
        await assert.rejects(() => openStore(modelOf(TYPE), { driver: nodeDriver(), path: dbPath }), (error) => {
          assert.strictEqual(/** @type {any} */ (error).code, 'JD0002');
          assert.ok(/** @type {any} */ (error).message.includes(difference), /** @type {any} */ (error).message);
          return true;
        });
      }
      finally {
        cleanup();
      }
    }
  });
});

describe('an instant that is a member of several types', () => {
  const T0 = 1767225600000;
  const resample = { $resample: [{ $for: { s: '$[*]' }, $where: { $eq: ['$s.series', 'a'] }, $return: '$s' },
    { every: 60000, at: '$.at', aggregate: 'count' }] };

  /** @param {any} at */
  const reasonsFor = async (at) => {
    const model = { $model: '0.1', collections: { sample: { key: null, identity: 'integer',
      schema: { type: 'object', properties: { series: { type: 'string' }, at, value: { type: 'number' } } },
      indexes: [{ name: 'by_series_at', path: ['$.series', '$.at'] }] } } };
    const store = await openStore(model, { driver: nodeDriver() });
    try {
      const docs = store.collection('sample');
      for (let i = 0; i < 4; i++) await docs.insert({ series: 'a', at: T0 + i * 30000, value: i });
      const explained = await docs.explain(resample);
      return { mode: explained.mode, reasons: (explained.series?.reasons ?? []).map((/** @type {any} */ r) => r.code) };
    }
    finally {
      await store.close();
    }
  };

  it('is no whole epoch for a native bucket: its untyped column may hold a text or a fraction', async () => {
    assert.deepStrictEqual(await reasonsFor({ type: 'integer' }), { mode: 'native', reasons: [] });
    assert.deepStrictEqual(await reasonsFor({ type: ['integer', 'string'] }),
      { mode: 'set', reasons: ['instant-not-integer'] });
  });
});

describe('integers past 2^53 under a number-first indexed union compare as the doubles the engine compares', () => {
  const VALUES = [2 ** 60, 2 ** 53 + 2, 2 ** 53, 1e20, 1.2345678901234568e20, 0.1, 5e-324, -(2 ** 62), 1.7976931348623157e308];
  for (const type of /** @type {any[]} */ ([['number', 'string'], ['number', 'integer'], ['number', 'integer', 'null']])) {
    it(JSON.stringify(type), async () => {
      const store = await openStore(modelOf(type), { driver: nodeDriver() });
      try {
        const docs = store.collection('c');
        const stored = VALUES.map((value, i) => ({ id: `k${i}`, q: value }));
        for (const doc of stored) await docs.insert(doc);
        for (const value of VALUES) {
          for (const op of ['$eq', '$lt', '$ge']) {
            const document = where({ [op]: ['$it.q', value] });
            assert.deepStrictEqual(await docs.execute(document), compileJsonQuery(document)(structuredClone(stored)), `${op} ${value}`);
          }
        }
        assert.ok((await docs.explain(where({ $eq: ['$it.q', 2 ** 60] }))).sql.includes('"gx_q" = ?'));
      }
      finally {
        await store.close();
      }
    });
  }
});

describe('a store an earlier release created, under the tools that plan and migrate', () => {
  const NUMBER_FIRST = ['number', 'string'];
  const entityModel = (/** @type {any} */ type, /** @type {boolean} */ more = false) => {
    const model = modelOf(type);
    model.collections.c.schema.properties.q = { type };
    delete model.collections.c.schema.properties.r;
    if (more) {
      model.collections.c.schema.properties.z = { type: 'string' };
      model.collections.c.indexes.push({ name: 'by_z', path: '$.z' });
    }
    model.entities = { Item: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, name: { type: 'string' } } } } };
    return model;
  };
  /** The store the previous release wrote for this model: the column in its first type. */
  const legacyStore = async (/** @type {any} */ model, /** @type {string} */ file, /** @type {string} */ word) => {
    const first = await openStore(model, { driver: nodeDriver(), path: file });
    await first.close();
    const raw = new DatabaseSync(file);
    raw.exec('DROP INDEX "c_by_q"');
    raw.exec('ALTER TABLE "c" DROP COLUMN "gx_q"');
    raw.exec(`ALTER TABLE "c" ADD COLUMN "gx_q" ${word} GENERATED ALWAYS AS (jsonb_extract("doc", '$."q"')) VIRTUAL`);
    raw.exec('CREATE INDEX "c_by_q" ON "c" ("gx_q")');
    raw.prepare('INSERT INTO "c" ("key", "doc") VALUES (?, jsonb(?))').run('a', JSON.stringify({ id: 'a', q: 2 }));
    raw.close();
  };

  it('compareShapeToModel accepts it, and still names any other difference', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const model = entityModel(NUMBER_FIRST);
      await legacyStore(model, dbPath, 'REAL');
      const driver = nodeDriver();
      const connection = await driver.open(dbPath, {});
      try {
        assert.strictEqual(await compareShapeToModel(driver, connection, model, undefined), null);
        assert.strictEqual(await compareShapeToModel(driver, connection, entityModel(['string', 'number']), undefined), null);
        const other = await compareShapeToModel(driver, connection, entityModel(['number', 'string'], true), undefined);
        assert.ok(/gx_z|by_z|differs|missing/.test(String(other)), String(other));
      }
      finally {
        await connection.close();
      }
    }
    finally {
      cleanup();
    }
  });

  it('migrate() of a model that declares entities applies a link over it', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const from = entityModel(NUMBER_FIRST);
      const to = entityModel(NUMBER_FIRST, true);
      await legacyStore(from, dbPath, 'REAL');
      const { migration } = planMigration(from, to, { dialect: sqliteDialect });
      migration.steps = migration.steps.filter((step) => step.kind === 'ddl');
      const result = await migrate({ driver: nodeDriver(), path: dbPath }, [migration], { baseline: from, model: to, shadow: false });
      assert.strictEqual(/** @type {any} */ (result).applied?.length ?? 1, 1);
      const store = await openStore(to, { driver: nodeDriver(), path: dbPath });
      try {
        assert.deepStrictEqual(await store.collection('c').execute(where({ $eq: ['$it.q', 2] })), 'a');
      }
      finally {
        await store.close();
      }
    }
    finally {
      cleanup();
    }
  });

  it('opens under a model that reorders the union, and reads the document for what its column cannot answer', async () => {
    for (const [word, from, to] of /** @type {[string, any, any][]} */ ([
      ['REAL', NUMBER_FIRST, ['string', 'number']], ['REAL', NUMBER_FIRST, ['boolean', 'number', 'string']],
      ['TEXT', ['string', 'number'], NUMBER_FIRST], ['INTEGER', ['integer', 'string'], ['string', 'integer']],
    ])) {
      const { dbPath, cleanup } = tempDbPath();
      try {
        await legacyStore(modelOf(from), dbPath, word);
        const store = await openStore(modelOf(to), { driver: nodeDriver(), path: dbPath });
        try {
          const docs = store.collection('c');
          assert.deepStrictEqual(await docs.execute(where({ $eq: ['$it.q', 2] })), 'a', word);
          assert.deepStrictEqual((await docs.explain(where({ $eq: ['$it.q', 2] }))).indexes, [], word);
        }
        finally {
          await store.close();
        }
      }
      finally {
        cleanup();
      }
    }
  });

  it('is retyped by the plan between two models that change the union, whichever types it holds', async () => {
    for (const [word, from, to] of /** @type {[string, any, any][]} */ ([
      ['INTEGER', ['integer', 'string'], NUMBER_FIRST], ['INTEGER', ['integer', 'string'], ['string', 'number']],
      ['REAL', NUMBER_FIRST, ['string', 'number']], ['TEXT', ['string', 'number'], NUMBER_FIRST],
      ['REAL', NUMBER_FIRST, ['boolean', 'number', 'string', 'null']], ['INTEGER', ['boolean', 'integer'], NUMBER_FIRST],
    ])) {
      const { dbPath, cleanup } = tempDbPath();
      try {
        await legacyStore(modelOf(from), dbPath, word);
        const { migration } = planMigration(modelOf(from), modelOf(to), { dialect: sqliteDialect });
        const sql = migration.steps.filter((step) => step.kind === 'ddl').map((step) => step.sql);
        assert.strictEqual(sql.length, 4, word);
        assert.deepStrictEqual([sql[0], sql[1], sql[3]], ['DROP INDEX "c_by_q"', 'ALTER TABLE "c" DROP COLUMN "gx_q"', 'CREATE INDEX "c_by_q" ON "c" ("gx_q")'], word);
        assert.ok(sql[2].startsWith('ALTER TABLE "c" ADD COLUMN "gx_q" ANY GENERATED ALWAYS AS ('), sql[2]);
        migration.steps = migration.steps.filter((step) => step.kind === 'ddl');
        await migrate({ driver: nodeDriver(), path: dbPath }, [migration], { baseline: modelOf(from), model: modelOf(to), shadow: false });
        const store = await openStore(modelOf(to), { driver: nodeDriver(), path: dbPath });
        try {
          const docs = store.collection('c');
          assert.deepStrictEqual(await docs.execute(where({ $eq: ['$it.q', 2] })), 'a', word);
          const explained = await docs.explain(where({ $eq: ['$it.q', 2] }));
          assert.deepStrictEqual(explained.indexes, ['c_by_q'], word);
          await docs.insert({ id: 'z', q: 'text' });
        }
        finally {
          await store.close();
        }
      }
      finally {
        cleanup();
      }
    }
  });
});

describe('a store this release created, under a plan that changes the union', () => {
  const PAIRS = /** @type {[any, any][]} */ ([
    [['number', 'string'], ['string', 'number']], [['string', 'number'], ['number', 'string']],
    [['number', 'string'], ['number', 'string', 'boolean']], [['number', 'string'], ['boolean', 'number', 'string']],
    [['number', 'string'], ['integer', 'string']], [['integer', 'string'], ['number', 'string']],
    ['number', ['number', 'string']], ['string', ['string', 'number']],
    [['null', 'number', 'string'], ['string', 'number']], [['number', 'string'], ['number', 'string']],
  ]);

  it('rebuilds the column in the new spelling, and the store opens and seeks', async () => {
    for (const [from, to] of PAIRS) {
      const { dbPath, cleanup } = tempDbPath();
      try {
        const first = await openStore(modelOf(from), { driver: nodeDriver(), path: dbPath });
        await first.collection('c').insert({ id: 'a', q: 2 });
        await first.close();
        const { migration } = planMigration(modelOf(from), modelOf(to), { dialect: sqliteDialect });
        const ddl = migration.steps.filter((step) => step.kind === 'ddl');
        const same = JSON.stringify(from) === JSON.stringify(to);
        assert.strictEqual(ddl.length, same ? 0 : 4, `${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
        migration.steps = ddl;
        await migrate({ driver: nodeDriver(), path: dbPath }, [migration], { baseline: modelOf(from), model: modelOf(to), shadow: false });
        const store = await openStore(modelOf(to), { driver: nodeDriver(), path: dbPath });
        try {
          assert.deepStrictEqual(await store.collection('c').execute(where({ $eq: ['$it.q', 2] })), 'a');
        }
        finally {
          await store.close();
        }
      }
      finally {
        cleanup();
      }
    }
  });
});

describe('introspection of an indexed member of several types', () => {
  it('reads the index back over an untyped member and reports the column it cannot type', async () => {
    for (const type of /** @type {any[]} */ ([['number', 'string'], ['string', 'number']])) {
      const store = await openStore(modelOf(type), { driver: nodeDriver() });
      try {
        const { model, report } = await store.introspect();
        assert.deepStrictEqual(model.collections.c.indexes, [{ name: 'by_q', path: '$.q' }]);
        assert.deepStrictEqual(model.collections.c.schema.properties, { q: {} });
        assert.deepStrictEqual(report.filter((loss) => loss.code === 'unmapped-type').map((loss) => loss.object), ['c.gx_q']);
      }
      finally {
        await store.close();
      }
    }
  });
});
