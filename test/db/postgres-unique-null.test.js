//@ts-check
/**
 * @file A unique index over a member PostgreSQL holds as `jsonb` (one the
 * schema does not type, or whose union lists a container first) keys a JSON
 * `null` as a missing member is: the member's generated column reads a JSON
 * `null` as SQL NULL, so two documents with `q: null` are both stored on both
 * engines, as two documents without `q` are, and every non-null duplicate is
 * refused as before. Queries over the member answer as before and seek the
 * same indexes. A table an earlier release created holds the column that keeps
 * a JSON `null` as a value: it opens, reads and refuses a second `null` as it
 * did, until `planColumnUpgrade` creates the column again.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, planCollection, planColumnUpgrade, planMigration, migrate, normalizeModel } from '@jarenjs/db';
import { postgresDialect } from '@jarenjs/db/postgres';

import { PG_URL, withPostgres, withStore } from './store-core-engines.js';

const dialect = postgresDialect();
/** @param {Record<string, any>} properties @param {any[]} indexes */
const modelOf = (properties, indexes) => ({ $model: '0.1', collections: { c: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, k: { type: 'string' }, ...properties } }, indexes } } });
const MEMBERS = { untyped: {}, 'container first': { type: ['object', 'string', 'null'] }, 'container first, no null': { type: ['object', 'string'] } };
const SHAPES = {
  single: [{ name: 'by_q', path: '$.q', unique: true }],
  composite: [{ name: 'by_qk', path: ['$.q', '$.k'], unique: true }],
  conditional: [{ name: 'by_k', path: '$.k' }, { name: 'by_q', path: '$.q', unique: true, where: { $eq: ['$.k', 'x'] } }],
};
/** The read of `q`, and the column over it: a JSON `null` as SQL NULL, and as an earlier release kept it. */
const AT = `("doc" #> '{"q"}')`;
/** @param {string} at */
const nullFree = (at) => `(CASE WHEN jsonb_typeof(${at}) <> 'null' THEN ${at} END)`;
const GUARD = `(CASE WHEN jsonb_typeof(("doc" #> '{"u"}')) = 'array' THEN "doc" END)`;
const AT_U = `(${GUARD} #> '{"u","0"}')`;
/** @param {any} model */
const planOf = (model) => planCollection('c', normalizeModel(model).get('c'), dialect);
/** The statements an earlier release created the table with. @param {any} model @param {string} at */
const earlierSql = (model, at) => planOf(model).createSql.map((/** @type {string} */ sql) => sql.replaceAll(nullFree(at), at));
const M = Symbol('missing');
/** @param {string} id @param {any} q */
const docOf = (id, q) => (q === M ? { id, k: 'x' } : { id, q, k: 'x' });
// [first, second, whether the second is refused], the answer of both engines
const PAIRS = /** @type {const} */ ([[null, null, false], [M, M, false], [null, M, false], [M, null, false],
  ['b', 'b', true], [1, 1, true], [1, 1.0, true], [true, true, true], [{ a: 1, b: 2 }, { b: 2, a: 1 }, true], [[1, 2], [1, 2], true],
  [[], [], true], [{}, {}, true], ['1', 1, false], [null, 'null', false], [0, false, false], [[1, 2], [2, 1], false]]);

describe('the generated column of a member held as jsonb', () => {
  it('reads a JSON null as SQL NULL, unique or not, under a guard too', () => {
    for (const member of Object.values(MEMBERS)) {
      for (const indexes of [[{ name: 'by_q', path: '$.q' }], ...Object.values(SHAPES)]) {
        assert.ok(planOf(modelOf({ q: member }, indexes)).createSql[0].includes(`"gx_q" jsonb GENERATED ALWAYS AS (${nullFree(AT)}) STORED`));
      }
    }
    assert.ok(planOf(modelOf({ u: {} }, [{ name: 'by_u', path: '$.u[0]', unique: true }])).createSql[0]
      .includes(`"gx_u_0" jsonb GENERATED ALWAYS AS (${nullFree(AT_U)}) STORED`));
    // a column of a scalar type holds a JSON null as SQL NULL already
    assert.ok(planOf(modelOf({ q: { type: ['number', 'string', 'null'] } }, SHAPES.single)).createSql[0]
      .includes(`"gx_q" numeric GENERATED ALWAYS AS ((CASE WHEN jsonb_typeof(${AT}) = 'number' THEN (${AT})::numeric END)) STORED`));
  });

  it('is no change between two models, unique or not', () => {
    const plain = modelOf({ q: {} }, [{ name: 'by_q', path: '$.q' }]);
    const unique = modelOf({ q: {} }, SHAPES.single);
    const ddl = (/** @type {any} */ from, /** @type {any} */ to) => planMigration(from, to, { dialect }).migration.steps
      .filter((/** @type {any} */ step) => step.kind === 'ddl').map((/** @type {any} */ step) => step.sql);
    assert.deepEqual(ddl(plain, unique), ['DROP INDEX "c_by_q"', 'CREATE UNIQUE INDEX "c_by_q" ON "c" ("gx_q")']);
    assert.deepEqual(ddl(unique, unique), []);
  });
});

describe('a unique index over a member held as jsonb, on both engines', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  for (const [label, member] of Object.entries(MEMBERS)) {
    for (const [shape, indexes] of Object.entries(SHAPES)) {
      it(`stores two nulls as two missing members, and refuses every other duplicate as before (${label}, ${shape})`, async () => {
        for (const engine of ['sqlite', 'postgres']) {
          /** @type {boolean[]} */
          const verdicts = [];
          await withStore(engine, modelOf({ q: member }, indexes), async (store) => {
            const rows = store.collection('c');
            let n = 0;
            for (const [first, second] of PAIRS) {
              const a = String(++n), b = String(++n);
              await rows.insert(docOf(a, first));
              verdicts.push(await rows.insert(docOf(b, second)).then(() => false,
                (/** @type {any} */ error) => error.code === 'JD2005' && error.class === 'constraint'));
              await rows.delete(a);
              await rows.delete(b);
            }
          });
          assert.deepEqual(verdicts, PAIRS.map(([, , refused]) => refused), `${engine} ${label} ${shape}`);
        }
      });
    }
  }

  it('stores two nulls under a guarded path, and reopens', () => withPostgres(async ({ driver }) => {
    const model = modelOf({ u: {} }, [{ name: 'by_u', path: '$.u[0]', unique: true }]);
    for (let round = 0; round < 2; round++) {
      const store = await openStore(model, { driver: driver() });
      try {
        const rows = store.collection('c');
        if (round === 0) {
          for (const doc of [{ id: '1', u: [null] }, { id: '2', u: [null] }, { id: '3', u: { 0: null } }, { id: '4', u: ['b'] }]) await rows.insert(doc);
          await assert.rejects(rows.insert({ id: '5', u: ['b'] }), { code: 'JD2005' });
        }
        assert.deepEqual(await rows.execute({ $for: { it: '$[*]' }, $where: { $eq: ['$it.u[0]', null] }, $return: '$it.id' }), ['1', '2']);
      }
      finally { await store.close(); }
    }
  }));

  it('answers every query over the member as before, pushed down or not', async () => {
    const DOCS = [{ id: 'm1' }, { id: 'n1', q: null }, { id: 'm2' }, { id: 'n2', q: null }, { id: 's1', q: 'b' }, { id: 's2', q: 'a' },
      { id: 'x1', q: 1 }, { id: 'x2', q: 2.5 }, { id: 't1', q: true }, { id: 'o1', q: { a: 1 } }, { id: 'a1', q: [1] }, { id: 'sn', q: 'null' }];
    const W = (/** @type {any} */ where) => ({ $for: { it: '$[*]' }, $where: where, $return: '$it.id' });
    const QUERIES = [
      [W({ $eq: ['$it.q', null] }), ['n1', 'n2']],
      [W({ $ne: ['$it.q', null] }), ['s1', 's2', 'x1', 'x2', 't1', 'o1', 'a1', 'sn']],
      [W({ $exists: '$it.q' }), ['n1', 'n2', 's1', 's2', 'x1', 'x2', 't1', 'o1', 'a1', 'sn']],
      [W({ $not: { $exists: '$it.q' } }), ['m1', 'm2']],
      [W({ $eq: ['$it.q', 1] }), 'x1'],
      [W({ $ne: ['$it.q', 1] }), ['n1', 'n2', 's1', 's2', 'x2', 't1', 'o1', 'a1', 'sn']],
      [W({ $lt: ['$it.q', 2] }), 'x1'],
      [W({ $eq: ['$it.q', { $seq: [1, 2.5, 'a', null] }] }), ['n1', 'n2', 's2', 'x1', 'x2']],
      [W({ $gt: ['$it.q', 'a'] }), ['s1', 'sn']],
    ];
    for (const engine of ['sqlite', 'postgres']) {
      await withStore(engine, modelOf({ q: {} }, SHAPES.single), async (store) => {
        const rows = store.collection('c');
        for (const doc of DOCS) await rows.insert(doc);
        for (const [query, answer] of QUERIES) {
          assert.deepEqual([await rows.execute(query), await rows.execute(query, { pushdown: false })], [answer, answer], `${engine} ${JSON.stringify(query.$where)}`);
        }
      });
    }
  });
});

describe('a table an earlier release created over a member held as jsonb', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  /** @param {any} context @param {string[]} statements */
  const create = async (context, statements) => {
    await context.pool.query(`SET search_path TO "${context.schema}"`);
    for (const sql of statements) await context.pool.query(sql);
  };
  /** @param {any} context @param {any} model */
  const upgradeOf = async (context, model) => {
    const connection = await context.driver().open();
    try { return await planColumnUpgrade(connection, model); }
    finally { await connection.close(); }
  };
  /** The plan PostgreSQL makes for a statement, with sequential scans off. @param {any} context @param {any} store @param {any} query */
  const indexesOf = async (context, store, query) => {
    const explained = await store.collection('c').explain(query);
    const { default: pg } = await import('pg');
    // a connection of its own beside the store's two
    const client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
    try {
      await client.query(`SET search_path TO "${context.schema}"; SET enable_seqscan = off`);
      const plan = await client.query(`EXPLAIN (COSTS OFF) ${explained.sql}`, explained.params.map((/** @type {any} */ slot) => slot.literal));
      return [...new Set(plan.rows.map((/** @type {any} */ row) => row['QUERY PLAN']).join('\n').match(/(?<=Index Scan on |Index Scan using |Index Only Scan using )\S+/g))];
    }
    finally { await client.end(); }
  };

  for (const [label, member] of Object.entries(MEMBERS)) {
    for (const [shape, indexes] of Object.entries(SHAPES)) {
      it(`opens and answers as it did, refusing a second null, until planColumnUpgrade creates the column again (${label}, ${shape})`, () => withPostgres(async (context) => {
        const model = modelOf({ q: member }, indexes);
        await create(context, earlierSql(model, AT));
        const declared = `c_${indexes.at(-1)?.name}`;
        // a conditional index serves no comparison outside its condition
        const seeks = shape === 'conditional' ? [] : [declared];
        const store = await openStore(model, { driver: context.driver() });
        try {
          const rows = store.collection('c');
          for (const doc of [{ id: 'a', q: null, k: 'x' }, { id: 'b', k: 'x' }, { id: 'c', k: 'x' }, { id: 'd', q: 1, k: 'x' }]) await rows.insert(doc);
          await assert.rejects(rows.insert({ id: 'e', q: null, k: 'x' }), { code: 'JD2005', class: 'constraint' });
          assert.deepEqual(await rows.execute({ $for: { it: '$[*]' }, $where: { $eq: ['$it.q', null] }, $return: '$it.id' }), 'a');
          // a number comparison seeks the column's index on the table as it is
          assert.deepEqual(await indexesOf(context, store, { $for: { it: '$[*]' }, $where: { $eq: ['$it.q', 1] }, $return: '$it.id' }), seeks);
        }
        finally { await store.close(); }
        const { migration, report } = await upgradeOf(context, model);
        const kind = planOf(model).createSql.filter((/** @type {string} */ sql) => /^CREATE (UNIQUE )?INDEX "[^"]*\$/.test(sql));
        const created = planOf(model).createSql.filter((/** @type {string} */ sql) => sql.startsWith(`CREATE UNIQUE INDEX "${declared}"`));
        assert.deepEqual([report.upgraded, migration.steps.map((/** @type {any} */ step) => step.sql)], [['c.gx_q'], [
          `DROP INDEX "${declared}"`, ...kind.map((/** @type {string} */ sql) => `DROP INDEX IF EXISTS "${/** @type {string[]} */ (sql.match(/"([^"]*)"/))[1]}"`),
          'ALTER TABLE "c" DROP COLUMN "gx_q"', `ALTER TABLE "c" ADD COLUMN "gx_q" jsonb GENERATED ALWAYS AS (${nullFree(AT)}) STORED`, ...created, ...kind]]);
        assert.deepEqual((await migrate({ driver: context.driver() }, [migration], { baseline: model, model, shadow: false })).applied, [migration.id]);
        const again = await upgradeOf(context, model);
        assert.deepEqual([again.migration.steps, again.report.upgraded], [[], []], 'the two-run check');
        const upgraded = await openStore(model, { driver: context.driver() });
        try {
          const rows = upgraded.collection('c');
          await rows.insert({ id: 'e', q: null, k: 'x' });
          await assert.rejects(rows.insert({ id: 'f', q: 1, k: 'x' }), { code: 'JD2005' });
          assert.deepEqual(await rows.execute({ $for: { it: '$[*]' }, $where: { $eq: ['$it.q', null] }, $return: '$it.id' }), ['a', 'e']);
          assert.deepEqual(await indexesOf(context, upgraded, { $for: { it: '$[*]' }, $where: { $eq: ['$it.q', 1] }, $return: '$it.id' }), seeks);
        }
        finally { await upgraded.close(); }
      }));
    }
  }

  it('keeps reading a guarded column under its guard, and plans it again', () => withPostgres(async (context) => {
    const model = modelOf({ u: {} }, [{ name: 'by_u', path: '$.u[0]', unique: true }]);
    await create(context, earlierSql(model, AT_U));
    const store = await openStore(model, { driver: context.driver() });
    try {
      const rows = store.collection('c');
      for (const doc of [{ id: 'a', u: [null] }, { id: 'b', u: [1] }, { id: 'c', u: { 0: 1 } }]) await rows.insert(doc);
      await assert.rejects(rows.insert({ id: 'd', u: [null] }), { code: 'JD2005' });
      const query = { $for: { it: '$[*]' }, $where: { $eq: ['$it.u[0]', 1] }, $return: '$it.id' };
      assert.equal(await rows.execute(query), 'b');
      assert.deepEqual(await indexesOf(context, store, query), ['c_by_u']);
    }
    finally { await store.close(); }
    const { migration, report } = await upgradeOf(context, model);
    assert.deepEqual([report.upgraded, migration.steps.map((/** @type {any} */ step) => step.sql)], [['c.gx_u_0'], ['DROP INDEX "c_by_u"',
      'ALTER TABLE "c" DROP COLUMN "gx_u_0"', `ALTER TABLE "c" ADD COLUMN "gx_u_0" jsonb GENERATED ALWAYS AS (${nullFree(AT_U)}) STORED`,
      'CREATE UNIQUE INDEX "c_by_u" ON "c" ("gx_u_0")']]);
  }));

  it('opens a column the earlier release read under the other spelling of the guard', () => withPostgres(async (context) => {
    const model = modelOf({ u: {} }, [{ name: 'by_u', path: '$.u[0]', unique: true }]);
    const unguarded = `("doc" #> '{"u","0"}')`;
    await create(context, planOf(model).createSql.map((/** @type {string} */ sql) => sql.replaceAll(nullFree(AT_U), unguarded)));
    const store = await openStore(model, { driver: context.driver() });
    try {
      await store.collection('c').insert({ id: 'a', u: [null] });
      await assert.rejects(store.collection('c').insert({ id: 'b', u: [null] }), { code: 'JD2005' });
    }
    finally { await store.close(); }
    const { report } = await upgradeOf(context, model);
    assert.deepEqual(report.upgraded, ['c.gx_u_0']);
  }));
});
