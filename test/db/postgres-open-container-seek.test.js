//@ts-check
/**
 * @file A comparison or an ordering over an index path whose container the
 * schema leaves open (`$.u[0]`, `$.u['0']`) on PostgreSQL. A table this
 * release creates reads such a member into its generated column under the
 * dialect's guard (an index step off an array alone, a name that reads as an
 * index off an object alone), so a query reads the column and the index
 * serves the comparison, as it does for a declared container. A table that
 * holds the column read without the guard — one an earlier release created,
 * or one created while the model declared the container — holds the other
 * container's member there, so a query over it reads the guarded document
 * until `planColumnUpgrade` rebuilds the column. Every answer equals the
 * query engine's (`pushdown: false`) over documents of both container kinds.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, planCollection, planColumnUpgrade, migrate, normalizeModel } from '@jarenjs/db';
import { postgresDialect } from '@jarenjs/db/postgres';

import { PG_URL, withPostgres } from './store-core-engines.js';

const INT = { type: 'integer' };
/** @param {any} u */
const modelOf = (u) => ({ $model: '0.1', collections: { rows: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, u } },
  indexes: [{ name: 'by_u0', path: '$.u[0]' }, { name: 'by_un', path: "$.u['0']" }] } } });
/** The container `u` leaves open: an array's items and an object's member `0` are both integers. */
const OPEN = modelOf({ items: INT, properties: { 0: INT } });
const DECLARED = modelOf({ type: 'array', items: INT, properties: { 0: INT } });
/** Documents of both container kinds, each conforming to OPEN. */
const DOCS = [{ id: 'a', u: [7] }, { id: 'b', u: { 0: 5 } }, { id: 'c', u: [3, 9] }, { id: 'd' }, { id: 'e', u: { 0: 8 } },
  { id: 'f', u: [] }, { id: 'g', u: [5] }, { id: 'h', u: 'x' }, { id: 'i', u: { 0: 7 } }];
/** @param {any} where @param {any} [extra] */
const query = (where, extra = {}) => ({ $for: { it: '$[*]' }, ...(where === null ? {} : { $where: where }), ...extra, $return: '$it.id' });
const QUERIES = {
  eq: query({ $eq: ['$it.u[0]', 5] }),
  gt: query({ $gt: ['$it.u[0]', 4] }),
  le: query({ $le: ['$it.u[0]', 5] }),
  ne: query({ $ne: ['$it.u[0]', 5] }),
  not: query({ $not: { $eq: ['$it.u[0]', 7] } }),
  order: query(null, { $orderby: '$it.u[0]' }),
  rangeOrder: query({ $ge: ['$it.u[0]', 5] }, { $orderby: '$it.u[0]' }),
  nameEq: query({ $eq: ["$it.u['0']", 5] }),
  nameGt: query({ $gt: ["$it.u['0']", 6] }),
  nameOrder: query(null, { $orderby: "$it.u['0']" }),
};
/** What the engine answers: an index step reads arrays alone, a name objects alone. */
const EXPECTED = {
  eq: 'g', gt: ['a', 'g'], le: ['c', 'g'], ne: ['a', 'c'], not: ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
  order: ['b', 'd', 'e', 'f', 'h', 'i', 'c', 'g', 'a'], rangeOrder: ['g', 'a'],
  nameEq: 'b', nameGt: ['e', 'i'], nameOrder: ['a', 'c', 'd', 'f', 'g', 'h', 'b', 'i', 'e'],
};
/** The columns of the two paths, by the path a query names. */
const COLUMN = { index: '"gx_u_0"', name: '"gx_u_0_2"' };
const GUARD = /CASE WHEN jsonb_typeof\(\("doc" #> '\{"u"\}'\)\) = '(array|object)' THEN "doc" END/g;
/** The createSql an earlier release wrote for `model`: every definition read without the guard. @param {any} model */
const unguardedSql = (model) => planCollection('rows', normalizeModel(model).get('rows'), postgresDialect())
  .createSql.map((/** @type {string} */ sql) => sql.replace(GUARD, '"doc"'));

/**
 * Each query's native answer, the engine's, and whether the native statement
 * reads the column of the path the query names in its WHERE or ORDER BY.
 * @param {any} store
 */
const run = async (store) => {
  const rows = store.collection('rows');
  /** @type {Record<string, any>} */
  const out = {};
  for (const [name, q] of Object.entries(QUERIES)) {
    const explained = await rows.explain(q);
    const tail = explained.sql.slice(explained.sql.indexOf(' FROM "rows"'));
    out[name] = { native: await rows.execute(q), engine: await rows.execute(q, { pushdown: false }),
      mode: explained.mode, column: tail.includes(name.startsWith('name') ? COLUMN.name : COLUMN.index) };
  }
  return out;
};
/**
 * @param {Record<string, any>} result
 * @param {boolean | ((name: string) => boolean)} reading - whether each query reads its column
 */
const assertAnswers = (result, reading) => {
  for (const [name, { native, engine, mode, column: reads }] of Object.entries(result)) {
    const column = typeof reading === 'function' ? reading(name) : reading;
    assert.deepEqual(native, engine, `${name}: the native answer is the engine's`);
    assert.deepEqual(native, EXPECTED[/** @type {keyof typeof EXPECTED} */ (name)], name);
    assert.equal(mode, 'native', name);
    assert.equal(reads, column, `${name}: ${column ? 'reads' : 'does not read'} the column`);
  }
};
/** Open `model` on the context's schema, put DOCS in, run every query. @param {any} context @param {any} model */
const answersOf = async ({ driver }, model, insert = true) => {
  const store = await openStore(model, { driver: driver() });
  try {
    if (insert) for (const doc of DOCS) await store.collection('rows').insert(doc);
    return await run(store);
  }
  finally { await store.close(); }
};
/** Replace the table with the one an earlier release created for OPEN. @param {any} context */
const earlierTable = async ({ pool, schema, driver }) => {
  await (await openStore(OPEN, { driver: driver() })).close();
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schema}"`);
    await client.query('DROP TABLE rows');
    for (const sql of unguardedSql(OPEN)) await client.query(sql);
  }
  finally { client.release(); }
};
/** The two generated columns of each document, as the table holds them. @param {any} context */
const heldColumns = async ({ pool, schema }) => (await pool.query(`SELECT key, gx_u_0, gx_u_0_2 FROM "${schema}".rows WHERE key IN ('b', 'g') ORDER BY key`)).rows;

describe('a comparison over a path that leaves a container open on PostgreSQL', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  it('reads the column a fresh table holds under the guard, the index serving it, and answers as the engine', () => withPostgres(async (context) => {
    assertAnswers(await answersOf(context, OPEN), true);
    assert.deepEqual(await heldColumns(context), [{ key: 'b', gx_u_0: null, gx_u_0_2: '5' }, { key: 'g', gx_u_0: '5', gx_u_0_2: null }]);
    // the database's own plan for the native statement seeks the index
    const store = await openStore(OPEN, { driver: context.driver() });
    const client = await context.pool.connect();
    try {
      await client.query(`SET search_path TO "${context.schema}"`);
      await client.query('SET enable_seqscan = off');
      for (const [where, index] of [[{ $eq: ['$it.u[0]', 5] }, 'rows_by_u0'], [{ $gt: ["$it.u['0']", 6] }, 'rows_by_un']]) {
        // the literal binds the edges of the interval that rounds to it
        const { sql, params } = await store.collection('rows').explain(query(where));
        const plan = (await client.query({ text: `EXPLAIN ${sql}`, values: params.map((/** @type {any} */ slot) => slot.literal) })).rows
          .map((/** @type {any} */ row) => row['QUERY PLAN']).join('\n');
        assert.match(plan, new RegExp(`Index (Only )?Scan on ${index}|Index (Only )?Scan using ${index}`), plan);
      }
    }
    finally { client.release(); await store.close(); }
  }));

  it('reads the guarded document where the table holds the column unguarded, and the column after planColumnUpgrade rebuilds it', () => withPostgres(async (context) => {
    await earlierTable(context);
    // the unguarded column holds the member of the other container kind: reading it would answer wrongly
    const before = await answersOf(context, OPEN);
    assert.deepEqual(await heldColumns(context), [{ key: 'b', gx_u_0: '5', gx_u_0_2: '5' }, { key: 'g', gx_u_0: '5', gx_u_0_2: '5' }]);
    assertAnswers(before, false);
    const connection = await context.driver().open();
    let upgrade;
    try { upgrade = await planColumnUpgrade(connection, OPEN); }
    finally { await connection.close(); }
    assert.deepEqual(upgrade.report.upgraded, ['rows.gx_u_0', 'rows.gx_u_0_2']);
    await migrate({ driver: context.driver() }, [upgrade.migration], { baseline: OPEN, model: OPEN, shadow: false });
    assert.deepEqual(await heldColumns(context), [{ key: 'b', gx_u_0: null, gx_u_0_2: '5' }, { key: 'g', gx_u_0: '5', gx_u_0_2: null }]);
    assertAnswers(await answersOf(context, OPEN, false), true);
  }));

  it('reads the guarded document where the table was created while the model declared the container', () => withPostgres(async (context) => {
    // the index step off a declared array is read unguarded; the name, which reads as an
    // index, is read under the object guard either way, so its column is read
    await (await openStore(DECLARED, { driver: context.driver() })).close();
    assertAnswers(await answersOf(context, OPEN), (name) => name.startsWith('name'));
    assert.deepEqual(await heldColumns(context), [{ key: 'b', gx_u_0: '5', gx_u_0_2: '5' }, { key: 'g', gx_u_0: '5', gx_u_0_2: null }]);
  }));
});
