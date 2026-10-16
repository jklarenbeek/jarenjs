//@ts-check
/**
 * @file A unique index on SQLite over a member its untyped generated column
 * holds (a member of several types, or of none): the column holds a JSON
 * boolean as the integer `0` or `1`, so the index keys, after its columns,
 * whether each such member is a boolean. `true` and `1` are two keys, as the
 * query engine compares them and as PostgreSQL keys them; every other
 * answer stays: equal values of one kind are one key, `1` and `'1'` two,
 * nulls and missing members never meet, a condition still bounds the index.
 * A table an earlier release created holds the index without those keys:
 * it opens and answers as it did, and `planColumnUpgrade` creates the index
 * again with them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { compileJsonQuery } from '@jarenjs/json/query';
import {
  openStore, introspectModel, planCollection, planColumnUpgrade, planMigration, migrate, normalizeModel, sqliteDialect, compareShapeToModel,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';

import { tempDbPath } from './helpers.js';

/** The key a unique index adds after the column of the member at `name`. @param {string} name */
const flag = (name) => `(json_type("doc", '$."${name}"') IN ('true', 'false'))`;
const ALL = ['string', 'number', 'boolean', 'null'];
/** @param {any} q @param {any[]} indexes @param {any} [r] @returns {any} */
const modelOf = (q, indexes, r = { type: 'string' }) => ({ $model: '0.1', collections: { c: { key: '/id',
  schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, q, k: { type: 'string' }, r } }, indexes } } });
const SHAPES = {
  single: [{ name: 'by_q', path: '$.q', unique: true }],
  composite: [{ name: 'by_qk', path: ['$.q', '$.k'], unique: true }],
  conditional: [{ name: 'by_k', path: '$.k' }, { name: 'by_q', path: '$.q', unique: true, where: { $eq: ['$.k', 'x'] } }],
};
/** The statement that creates the index named `name`. @param {any} model @param {string} name @param {any} [dialect] */
const indexSql = (model, name, dialect = sqliteDialect) =>
  planCollection('c', normalizeModel(model).get('c'), dialect).createSql.find((/** @type {string} */ sql) => sql.includes(`INDEX "${name}" `));
/** @param {any} model @param {(store: any) => Promise<void>} body */
const withMemory = async (model, body) => {
  const store = await openStore(model, { driver: nodeDriver() });
  try { await body(store); }
  finally { await store.close(); }
};
/** The second insert's answer: 'stored' or the refusal's code. @param {any} store @param {any[]} pair @param {string} [k] */
const second = async (store, [a, b], k = 'x') => {
  const docs = store.collection('c');
  const doc = (/** @type {string} */ id, /** @type {any} */ q) => (q === undefined ? { id, k } : { id, q, k });
  await docs.insert(doc(`${k}1`, a));
  return docs.insert(doc(`${k}2`, b)).then(() => 'stored', (/** @type {any} */ error) => error.code);
};
/** Each pair of `q` values and the second insert's answer under a unique index over `q`. */
const PAIRS = /** @type {[any[], string][]} */ ([
  [[true, 1], 'stored'], [[1, true], 'stored'], [[false, 0], 'stored'], [[0, false], 'stored'], [[true, false], 'stored'],
  [[true, true], 'JD2005'], [[false, false], 'JD2005'], [[1, 1], 'JD2005'], [[1, 1.5], 'stored'], [[1, '1'], 'stored'],
  [['b', 'b'], 'JD2005'], [['a', 'A'], 'stored'], [[null, null], 'stored'], [[undefined, undefined], 'stored'], [[1e21, 1e21], 'JD2005'],
]);

describe('a unique index over a member the untyped column holds, on SQLite', () => {
  it('keys whether the member is a boolean after its columns, in every shape, and nothing else', () => {
    const union = { type: ['number', 'boolean'] };
    assert.equal(indexSql(modelOf(union, SHAPES.single), 'c_by_q'), `CREATE UNIQUE INDEX "c_by_q" ON "c" ("gx_q", ${flag('q')})`);
    assert.equal(indexSql(modelOf(union, SHAPES.composite), 'c_by_qk'), `CREATE UNIQUE INDEX "c_by_qk" ON "c" ("gx_q", "gx_k", ${flag('q')})`);
    assert.equal(indexSql(modelOf(union, SHAPES.conditional), 'c_by_q'),
      `CREATE UNIQUE INDEX "c_by_q" ON "c" ("gx_q", ${flag('q')}) WHERE "gx_k" = 'x'`);
    assert.equal(indexSql(modelOf(union, [{ name: 'by_qr', path: ['$.q', '$.k', '$.r'], unique: true }], {}), 'c_by_qr'),
      `CREATE UNIQUE INDEX "c_by_qr" ON "c" ("gx_q", "gx_k", "gx_r", ${flag('q')}, ${flag('r')})`);
    for (const q of [{}, { enum: [1, true] }, { type: ['integer', 'boolean'] }, { type: ['object', 'number', 'boolean'] }, { type: ['number', 'string'] }])
      assert.equal(indexSql(modelOf(q, SHAPES.single), 'c_by_q'), `CREATE UNIQUE INDEX "c_by_q" ON "c" ("gx_q", ${flag('q')})`, JSON.stringify(q));
    // a non-unique index, a column of one type, and PostgreSQL's typed columns key the column alone
    assert.equal(indexSql(modelOf(union, [{ name: 'by_q', path: '$.q' }]), 'c_by_q'), 'CREATE INDEX "c_by_q" ON "c" ("gx_q")');
    for (const type of ['number', 'integer', 'boolean', 'string'])
      assert.equal(indexSql(modelOf({ type }, SHAPES.single), 'c_by_q'), 'CREATE UNIQUE INDEX "c_by_q" ON "c" ("gx_q")', type);
    assert.equal(indexSql(modelOf(union, SHAPES.single), 'c_by_q', postgresDialect()), 'CREATE UNIQUE INDEX "c_by_q" ON "c" ("gx_q")');
  });

  for (const [label, indexes] of Object.entries(SHAPES)) {
    it(`keeps true apart from 1 and every other answer of a ${label} unique index`, async () => {
      const verdicts = [];
      for (const [pair] of PAIRS) await withMemory(modelOf({ type: ALL }, indexes), async (store) => { verdicts.push(await second(store, pair)); });
      assert.deepEqual(verdicts, PAIRS.map(([, verdict]) => verdict));
      if (label === 'conditional') {
        await withMemory(modelOf({ type: ALL }, indexes), async (store) => { assert.equal(await second(store, [1, 1], 'y'), 'stored'); });
      }
    });
  }

  it('keeps true apart from 1 for every member the untyped column holds', async () => {
    for (const q of [{}, { enum: [1, true] }, { type: ['integer', 'boolean'] }, { type: ['object', 'number', 'boolean'] }, { type: ['number', 'string'] }]) {
      const verdicts = [];
      for (const pair of [[true, 1], [false, 0], [1, 1], [true, true]])
        await withMemory(modelOf(q, SHAPES.single), async (store) => { verdicts.push(await second(store, pair)); });
      assert.deepEqual(verdicts, ['stored', 'stored', 'JD2005', 'JD2005'], JSON.stringify(q));
    }
  });

  it('refuses a duplicate a write makes, names a held key as the key, and compares and seeks as the engine does', async () => {
    await withMemory(modelOf({ type: ['number', 'boolean'] }, SHAPES.single), async (store) => {
      const docs = store.collection('c');
      for (const [id, q] of /** @type {[string, any][]} */ ([['t', true], ['1', 1], ['f', false], ['0', 0]])) await docs.insert({ id, q });
      await assert.rejects(docs.put({ id: '1', q: true }), { code: 'JD2005', class: 'constraint', retryable: false, collection: 'c', key: '1' });
      await assert.rejects(docs.insert({ id: 't', q: 1 }), { code: 'JD2001' });
      const all = [{ id: 't', q: true }, { id: '1', q: 1 }, { id: 'f', q: false }, { id: '0', q: 0 }];
      for (const value of [true, 1, false, 0]) {
        const query = { $for: { it: '$[*]' }, $where: { $eq: ['$it.q', value] }, $return: '$it.id' };
        const engine = compileJsonQuery(query)(structuredClone(all));
        assert.deepEqual([await docs.execute(query), await docs.execute(query, { pushdown: false })], [engine, engine], JSON.stringify(value));
      }
      assert.deepEqual((await docs.explain({ $for: { it: '$[*]' }, $where: { $eq: ['$it.q', 1] }, $return: '$it.id' })).indexes, ['c_by_q']);
    });
  });

  it('plans the keys with a link that gives the member its untyped column or makes the index unique, and no step otherwise', () => {
    const steps = (/** @type {any} */ from, /** @type {any} */ to) => planMigration(from, to, { dialect: sqliteDialect }).migration.steps
      .filter((/** @type {any} */ step) => step.kind === 'ddl' && step.sql.includes('INDEX')).map((/** @type {any} */ step) => step.sql);
    const created = `CREATE UNIQUE INDEX "c_by_q" ON "c" ("gx_q", ${flag('q')})`;
    assert.deepEqual(steps(modelOf({ type: 'number' }, SHAPES.single), modelOf({ type: ['number', 'boolean'] }, SHAPES.single)),
      ['DROP INDEX "c_by_q"', created]);
    assert.deepEqual(steps(modelOf({ type: ALL }, [{ name: 'by_q', path: '$.q' }]), modelOf({ type: ALL }, SHAPES.single)),
      ['DROP INDEX "c_by_q"', created]);
    assert.deepEqual(steps(modelOf({ type: ALL }, SHAPES.single), modelOf({ type: ALL }, [{ name: 'by_q', path: '$.q' }])),
      ['DROP INDEX "c_by_q"', 'CREATE INDEX "c_by_q" ON "c" ("gx_q")']);
    assert.deepEqual(steps(modelOf({ type: ['number', 'string'] }, SHAPES.single), modelOf({ type: ['number', 'string', 'boolean'] }, SHAPES.single)), []);
    assert.deepEqual(steps(modelOf({ type: ALL }, SHAPES.single), modelOf({ type: ALL }, SHAPES.single)), []);
  });

  /** The table an earlier release created for each shape over `q: ALL`: the unique index keys the column alone. */
  const EARLIER = {
    single: ['CREATE UNIQUE INDEX "c_by_q" ON "c" ("gx_q")'],
    composite: ['CREATE UNIQUE INDEX "c_by_qk" ON "c" ("gx_q", "gx_k")'],
    conditional: ['CREATE INDEX "c_by_k" ON "c" ("gx_k")', 'CREATE UNIQUE INDEX "c_by_q" ON "c" ("gx_q") WHERE "gx_k" = \'x\''],
  };
  /** @param {boolean} k - whether the shape indexes `k` too */
  const table = (k) => 'CREATE TABLE "c" ("key" TEXT PRIMARY KEY, "doc" BLOB NOT NULL, '
    + `"gx_q" ANY GENERATED ALWAYS AS (jsonb_extract("doc", '$."q"')) VIRTUAL${k ? ', "gx_k" TEXT GENERATED ALWAYS AS (jsonb_extract("doc", \'$."k"\')) VIRTUAL' : ''}) STRICT`;
  const DOCS = [{ id: 'a', q: true, k: 'x' }, { id: 'b', q: 2, k: 'x' }, { id: 'c', q: '1', k: 'x' }, { id: 'd', k: 'x' }];
  /** @param {string} file @param {string[]} indexes */
  const seed = (file, indexes) => {
    const raw = new DatabaseSync(file);
    try {
      for (const sql of [table(indexes.some((index) => index.includes('"gx_k"'))), ...indexes]) raw.exec(sql);
      for (const doc of DOCS) raw.prepare('INSERT INTO "c" ("key", "doc") VALUES (?, jsonb(?))').run(doc.id, JSON.stringify(doc));
    }
    finally { raw.close(); }
  };
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
    try { return await store.collection('c').insert(doc).then(() => 'stored', (/** @type {any} */ error) => error.code); }
    finally { await store.close(); }
  };

  for (const [label, indexes] of Object.entries(SHAPES)) {
    it(`opens a ${label} unique index an earlier release created as it answered, and the upgrade keys booleans apart`, async () => {
      const model = modelOf({ type: ALL }, indexes);
      const name = label === 'composite' ? 'c_by_qk' : 'c_by_q';
      const { dbPath, cleanup } = tempDbPath();
      try {
        seed(dbPath, EARLIER[/** @type {keyof typeof EARLIER} */ (label)]);
        assert.equal(await insertInto(dbPath, model, { id: 'e', q: 1, k: 'x' }), 'JD2005');
        assert.equal(await shapeDifference(dbPath, model), null);
        const { migration, report } = await upgradeOf(dbPath, model);
        assert.deepEqual(report.upgraded, [`c.${name}`]);
        assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.sql), [`DROP INDEX "${name}"`, indexSql(model, name)]);
        assert.deepEqual((await migrate({ driver: nodeDriver(), path: dbPath }, [migration], { baseline: model, model })).applied, [migration.id]);
        assert.deepEqual((await upgradeOf(dbPath, model)).migration.steps, []);
        assert.equal(await shapeDifference(dbPath, model), null);
        assert.equal(await insertInto(dbPath, model, { id: 'e', q: 1, k: 'x' }), 'stored');
        assert.equal(await insertInto(dbPath, model, { id: 'f', q: true, k: 'x' }), 'JD2005');
        const store = await openStore(model, { driver: nodeDriver(), path: dbPath });
        try { assert.deepEqual(await store.collection('c').execute({ $for: { it: '$[*]' }, $return: '$it.id' }), ['a', 'b', 'c', 'd', 'e']); }
        finally { await store.close(); }
      }
      finally { cleanup(); }
    });
  }

  it('reads the index back as the declared one, from a table it creates and from one an earlier release created', async () => {
    // number-first unions: introspection types the member back as one, and plans no column either way
    const numberFirst = ['number', 'string', 'boolean', 'null'];
    for (const model of [modelOf({ type: numberFirst }, SHAPES.single), modelOf({ type: ['number', 'boolean'] }, SHAPES.composite),
      modelOf({ type: numberFirst }, [{ name: 'by_qr', path: ['$.q', '$.r'], unique: true }], { type: ['number', 'boolean'] })]) {
      const { dbPath, cleanup } = tempDbPath();
      try {
        await (await openStore(model, { driver: nodeDriver(), path: dbPath })).close();
        const connection = await nodeDriver().open(dbPath, {});
        let derived, report;
        try { ({ model: derived, report } = await introspectModel(connection, { keys: { c: '/id' } })); }
        finally { await connection.close(); }
        assert.deepEqual(report.filter((/** @type {any} */ row) => row.code === 'unmapped-index'), []);
        assert.deepEqual(derived.collections.c.indexes, model.collections.c.indexes);
        await (await openStore(derived, { driver: nodeDriver(), path: dbPath })).close();
        for (const [from, to] of [[model, derived], [derived, model]])
          assert.deepEqual(planMigration(from, to, { dialect: sqliteDialect }).migration.steps.filter((/** @type {any} */ step) => step.kind === 'ddl'), []);
      }
      finally { cleanup(); }
    }
    const { dbPath, cleanup } = tempDbPath();
    try {
      seed(dbPath, EARLIER.single);
      const connection = await nodeDriver().open(dbPath, {});
      let derived, report;
      try { ({ model: derived, report } = await introspectModel(connection, { keys: { c: '/id' } })); }
      finally { await connection.close(); }
      assert.deepEqual(report.filter((/** @type {any} */ row) => row.code === 'unmapped-index'), []);
      assert.deepEqual(derived.collections.c.indexes, SHAPES.single);
      assert.equal(await insertInto(dbPath, derived, { id: 'e', q: 1, k: 'x' }), 'JD2005');
    }
    finally { cleanup(); }
  });

  it('refuses an index keyed by another expression after its columns, and reads it back as no declared index', async () => {
    const model = modelOf({ type: ALL }, SHAPES.single);
    for (const index of [`CREATE UNIQUE INDEX "c_by_q" ON "c" ("gx_q", (json_type("doc", '$."q"') IN ('true')))`,
      `CREATE UNIQUE INDEX "c_by_q" ON "c" ("gx_q", ${flag('k')})`, `CREATE UNIQUE INDEX "c_by_q" ON "c" (${flag('q')}, "gx_q")`]) {
      const { dbPath, cleanup } = tempDbPath();
      try {
        seed(dbPath, [index]);
        await assert.rejects(openStore(model, { driver: nodeDriver(), path: dbPath }), { code: 'JD0002' }, index);
        const connection = await nodeDriver().open(dbPath, {});
        try {
          const { report } = await introspectModel(connection, { keys: { c: '/id' } });
          assert.deepEqual(report.filter((/** @type {any} */ row) => row.object === 'c.c_by_q').map((/** @type {any} */ row) => row.code), ['unmapped-index'], index);
        }
        finally { await connection.close(); }
      }
      finally { cleanup(); }
    }
  });
});
