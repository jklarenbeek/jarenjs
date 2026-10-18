//@ts-check
/**
 * @file An entity's order over a column that holds no NULL on PostgreSQL —
 * a key of a table the store created — is spelled with the default null
 * placement (`ASC`, `DESC`), the order its B-tree index gives in either
 * direction: the engine's empty-first placement (`ASC NULLS FIRST`, `DESC
 * NULLS LAST`) places nothing there, and spelled so it is no index's order,
 * so a window, a load's `orderBy`, an include's and a keyset page over the
 * key sorted every row. A column that may hold NULL keeps the placement.
 * Every answer equals the engine's (`pushdown: false`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { adoptedPostgres } from './helpers.js';
import { PG_URL, withStore } from './store-core-engines.js';

const key = { 'x-entity': { key: true } };
const MODEL = { $model: '0.1', entities: {
  A: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', ...key },
    s: { type: 'string', 'x-entity': { index: true } },
    bs: { 'x-entity': { relation: { to: 'B', many: true, via: 'aId', onDelete: 'cascade' } } } } } },
  B: { schema: { type: 'object', required: ['id', 'aId'], properties: { id: { type: 'string', ...key }, aId: { type: 'string' } } } } } };
/** @param {any} by @param {'asc' | 'desc'} dir */
const windowOf = (by, dir) => ({ $subsequence: [{ $for: { it: '$.A[*]' }, $orderby: [{ $key: by, $dir: dir }], $return: '$it.id' }, 1, 3] });
/** @param {any[]} rows */
const idsOf = (rows) => rows.map((row) => row.id);

describe('PostgreSQL: an entity order over a key reads the key\'s index', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  it('spells the default placement over a key alone, and answers as the engine', async () => {
    await withStore('postgres', MODEL, async (store) => {
      const A = store.entity('A');
      for (const [id, s] of [['a3', 'x'], ['a1', undefined], ['a4', 'w'], ['a2', 'x'], ['a5', undefined]])
        await A.create({ id, ...(s === undefined ? {} : { s }) });
      for (const id of ['a3', 'a1', 'a4', 'a2', 'a5']) for (const n of [2, 1]) await store.entity('B').create({ id: `b${id}${n}`, aId: id });
      assert.match((await store.explain(windowOf('$it.id', 'asc'))).sql, / ORDER BY "t0"\."id" ASC, "t0"\."rid" LIMIT/);
      assert.match((await store.explain(windowOf('$it.id', 'desc'))).sql, / ORDER BY "t0"\."id" DESC, "t0"\."rid" LIMIT/);
      assert.match((await store.explain(windowOf('$it.s', 'asc'))).sql, / ORDER BY "t0"\."s" ASC NULLS FIRST, "t0"\."rid" LIMIT/);
      assert.match((await store.explain(windowOf('$it.s', 'desc'))).sql, / ORDER BY "t0"\."s" DESC NULLS LAST, "t0"\."rid" LIMIT/);
      /** @type {[any, string[]][]} */
      const windows = [[windowOf('$it.id', 'asc'), ['a2', 'a3', 'a4']], [windowOf('$it.id', 'desc'), ['a4', 'a3', 'a2']],
        [windowOf('$it.s', 'asc'), ['a5', 'a4', 'a3']], [windowOf('$it.s', 'desc'), ['a2', 'a4', 'a1']]];
      for (const [query, expected] of windows) {
        assert.deepEqual(await store.execute(query, { pushdown: false }), expected);
        assert.deepEqual(await store.execute(query), expected);
      }
      const load = await A.explainLoad({ orderBy: [{ $key: '$it.id', $dir: 'desc' }], include: { bs: { orderBy: '$it.id' } } });
      assert.match(load.sql, / ORDER BY "r"\."id" DESC, "r"\."rid"/);
      assert.match(load.sql, /"id" ASC, "[^"]+"\."rid"/);
      const loaded = await A.asNoTracking().load({ orderBy: [{ $key: '$it.id', $dir: 'desc' }], include: { bs: { orderBy: '$it.id' } } });
      assert.deepEqual(idsOf(loaded), ['a5', 'a4', 'a3', 'a2', 'a1']);
      assert.deepEqual(idsOf(loaded[0].bs), ['ba51', 'ba52']);
      const first = await A.page({ orderBy: ['$it.id'] }, { limit: 2 });
      assert.deepEqual(idsOf(first.items), ['a1', 'a2']);
      const paged = await A.explainLoad({ orderBy: ['$it.id'], after: first.continuation });
      assert.equal(paged.pagination, 'keyset');
      assert.match(paged.sql, / ORDER BY "r"\."id" ASC$/);
      assert.deepEqual(idsOf((await A.page({ orderBy: ['$it.id'] }, { limit: 2, after: first.continuation })).items), ['a3', 'a4']);
      const bySecond = await A.explainLoad({ orderBy: ['$it.s', '$it.id'], after: (await A.page({ orderBy: ['$it.s', '$it.id'] }, { limit: 2 })).continuation });
      assert.match(bySecond.sql, / ORDER BY "r"\."s" ASC NULLS FIRST, "r"\."id" ASC$/);
    });
  });

  it('reads an adopted column the catalog declares NOT NULL as one that holds no NULL, and keeps a nullable one\'s placement', async () => {
    const ddl = `CREATE TABLE crew(id integer PRIMARY KEY, rank integer NOT NULL, alt integer);
      INSERT INTO crew VALUES (1, 3, NULL), (2, 1, 7), (3, 2, NULL), (4, 1, 5);`;
    /** @param {string} name @param {string} codec @param {string} [policy] */
    const column = (name, codec, policy = 'reject') => ({ name, codec, null: policy });
    const { store, close } = await adoptedPostgres(ddl, { Crew: { schema: { type: 'object', required: ['id', 'rank'], properties: {
      id: { type: 'integer', ...key }, rank: { type: 'integer' }, alt: { type: 'integer' } } },
    physical: { table: 'crew', columns: { id: column('id', 'integer'), rank: column('rank', 'integer'), alt: column('alt', 'integer', 'absent') } } } },
    { label: 'crew' });
    try {
      const crew = store.entity('Crew');
      assert.match((await crew.explainLoad({ orderBy: '$it.rank' })).sql, /ORDER BY "r"\."rank" ASC, /);
      assert.match((await crew.explainLoad({ orderBy: '$it.alt' })).sql, /ORDER BY "r"\."alt" ASC NULLS FIRST, /);
      assert.deepEqual(idsOf(await crew.load({ orderBy: '$it.rank' })), [2, 4, 3, 1]);
      assert.deepEqual(idsOf(await crew.load({ orderBy: [{ $key: '$it.rank', $dir: 'desc' }] })), [1, 3, 2, 4]);
      assert.deepEqual(idsOf(await crew.load({ orderBy: '$it.alt' })), [1, 3, 4, 2]);
      for (const by of ['$it.rank', '$it.alt']) for (const dir of ['asc', 'desc']) {
        const query = { $for: { it: '$.Crew[*]' }, $orderby: [{ $key: by, $dir: dir }], $return: '$it.id' };
        assert.deepEqual(await store.execute(query), await store.execute(query, { pushdown: false }), `${by} ${dir}`);
      }
    }
    finally { await close(); }
  });

  it('reads the order from the key\'s index, sorting no row', async () => {
    await withStore('postgres', MODEL, async (store, pg) => {
      const admin = await pg?.pool.connect();
      try {
        await admin.query(`SET search_path TO "${pg?.schema}"`);
        await admin.query(`INSERT INTO "A" (id, doc) SELECT 'a' || lpad(g::text, 5, '0'), jsonb_build_object('id', 'a' || lpad(g::text, 5, '0')) `
          + 'FROM generate_series(1, 2000) AS g');
        await admin.query('ANALYZE "A"');
        await admin.query('SET enable_seqscan = off');
        const A = store.entity('A');
        const first = await A.page({ orderBy: ['$it.id'] }, { limit: 2 });
        for (const sql of [(await store.explain(windowOf('$it.id', 'asc'))).sql, (await store.explain(windowOf('$it.id', 'desc'))).sql,
          (await A.explainLoad({ orderBy: ['$it.id'], take: 5 })).sql]) {
          const plan = (await admin.query(`EXPLAIN ${sql}`)).rows.map((/** @type {any} */ row) => row['QUERY PLAN']).join('\n');
          assert.match(plan, /Index (Only )?Scan( Backward)? using "A_pkey"/, plan);
          assert.doesNotMatch(plan, /(?<!Incremental )Sort {2}\(/, plan);
        }
        const paged = await A.explainLoad({ orderBy: ['$it.id'], after: first.continuation });
        const plan = (await admin.query({ text: `EXPLAIN ${paged.sql}`, values: ['a00002'] })).rows.map((/** @type {any} */ row) => row['QUERY PLAN']).join('\n');
        assert.match(plan, /Index (Only )?Scan using "A_pkey"/, plan);
        assert.doesNotMatch(plan, /Sort/, plan);
      }
      finally {
        await admin.query('RESET enable_seqscan');
        await admin.query('RESET search_path');
        admin.release();
      }
    });
  });
});
