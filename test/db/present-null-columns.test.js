//@ts-check
/**
 * @file An adopted table whose columns read a NULL as a present `null`
 * (`null: 'null'`) is queried natively on PostgreSQL as on SQLite: its
 * predicates, groupings, aggregates, orderings, projections and windows run
 * in SQL beside the guards that raise what the engine raises (`JQ2005` for
 * a NULL group or order key, `JQ2001` for a NULL a sum folds), and a
 * difference from a value holds where the column is NULL too (`IS DISTINCT
 * FROM` on PostgreSQL, `IS NOT` on SQLite). Every answer, value or error
 * code, equals the residual's, over three data sets. A store run is SQLite
 * always, PostgreSQL where JAREN_PG_URL names a server.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { ENGINES, skipFor, withPostgres } from './store-core-engines.js';
import { tempDbPath } from './helpers.js';

const DATA = {
  nullKey: "(1, NULL, 1, 1.5), (2, 'a', 2, NULL), (3, 'a', NULL, 2.5), (4, 'b', 5, 0)",
  nullValue: "(1, 'c', 1, 1.5), (2, 'a', 2, NULL), (3, 'a', NULL, 2.5), (4, 'b', 5, 0)",
  noNull: "(1, 'c', 1, 1.5), (2, 'a', 2, 3), (3, 'a', 7, 2.5), (4, 'b', 5, 0)",
};
/** @param {string} rows */
const ddl = (rows) => `CREATE TABLE items (id integer PRIMARY KEY, g text, v integer, f double precision); INSERT INTO items VALUES ${rows}`;
/** @param {string | undefined} schema */
const model = (schema) => ({ $model: '0.1', entities: { Item: { schema: { type: 'object', properties: {
  id: { type: 'integer', 'x-entity': { key: true } }, g: { type: ['string', 'null'] }, v: { type: ['integer', 'null'] }, f: { type: ['number', 'null'] } } },
physical: { ...(schema ? { schema } : {}), table: 'items', columns: { id: { name: 'id', codec: 'integer', null: 'reject' },
  g: { name: 'g', codec: 'text', null: 'null' }, v: { name: 'v', codec: 'integer', null: 'null' }, f: { name: 'f', codec: 'number', null: 'null' } } } } } });
/** @param {any} rest */
const F = (rest) => ({ $for: { it: '$.Item[*]' }, ...rest });
const Q = {
  groupOrdered: F({ $groupby: { k: '$it.g' }, $orderby: ['$k'], $return: { k: '$k', n: { $count: '$it' } } }),
  groupFirstSeen: F({ $groupby: { k: '$it.g' }, $return: { k: '$k', n: { $count: '$it' } } }),
  groupSum: F({ $groupby: { k: '$it.g' }, $orderby: ['$k'], $return: { k: '$k', s: { $sum: '$it.v' } } }),
  groupAvg: F({ $groupby: { k: '$it.g' }, $orderby: ['$k'], $return: { k: '$k', s: { $avg: '$it.f' } } }),
  groupMax: F({ $groupby: { k: '$it.g' }, $orderby: ['$k'], $return: { k: '$k', m: { $max: '$it.v' } } }),
  groupMin: F({ $groupby: { k: '$it.g' }, $orderby: ['$k'], $return: { k: '$k', m: { $min: '$it.f' } } }),
  eq: F({ $where: { $eq: ['$it.g', 'a'] }, $return: '$it.id' }),
  eqNull: F({ $where: { $eq: ['$it.g', null] }, $return: '$it.id' }),
  ne: F({ $where: { $ne: ['$it.g', 'a'] }, $return: '$it.id' }),
  neNull: F({ $where: { $ne: ['$it.v', null] }, $return: '$it.id' }),
  gt: F({ $where: { $gt: ['$it.v', 1] }, $return: '$it.id' }),
  lt: F({ $where: { $lt: ['$it.f', 2] }, $return: '$it.id' }),
  starts: F({ $where: { '$starts-with': ['$it.g', 'a'] }, $return: '$it.id' }),
  orderBy: F({ $orderby: ['$it.g'], $return: '$it.id' }),
  orderByNumber: F({ $orderby: [{ key: '$it.f', order: 'descending' }], $return: '$it.id' }),
  project: F({ $orderby: ['$it.id'], $return: { g: '$it.g', v: '$it.v' } }),
  projectOne: F({ $orderby: ['$it.id'], $return: '$it.v' }),
  count: { $count: F({ $where: { $eq: ['$it.g', 'a'] }, $return: '$it.id' }) },
  sum: { $sum: F({ $return: '$it.v' }) },
  max: { $max: F({ $return: '$it.f' }) },
  distinct: { $distinct: F({ $return: '$it.g' }) },
  window: { $subsequence: [F({ $orderby: ['$it.v'], $return: '$it.id' }), 0, 2] },
};
/** A call's answer as JSON, or the code it raises. @param {() => any} call */
const outcome = async (call) => {
  try { return JSON.stringify(await call()); }
  catch (error) { return `!${/** @type {any} */ (error).code}`; }
};

/**
 * Open the adopted table holding `rows` on `engine`, run `fn` over the store, and close it.
 * @param {string} engine @param {string} rows @param {(store: any) => Promise<void>} fn
 */
async function withItems(engine, rows, fn) {
  if (engine === 'postgres') {
    return withPostgres(async ({ pool, schema, driver }) => {
      await pool.query(`SET search_path TO "${schema}"; ${ddl(rows)}; RESET search_path`);
      const store = await openStore(model(schema), { driver: driver(), adopt: true });
      try { await fn(store); }
      finally { await store.close(); }
    });
  }
  const { dbPath, cleanup } = tempDbPath();
  try {
    const raw = new DatabaseSync(dbPath);
    raw.exec(ddl(rows).replace('double precision', 'real'));
    raw.close();
    const store = await openStore(model(undefined), { driver: nodeDriver(), path: dbPath, adopt: true });
    try { await fn(store); }
    finally { await store.close(); }
  }
  finally { cleanup(); }
}

for (const engine of ENGINES) {
  describe(`columns that read a NULL as a present null, ${engine}`, { skip: skipFor(engine) }, () => {
    for (const [set, rows] of Object.entries(DATA)) {
      it(`answers every shape natively as the engine does: ${set}`, async () => {
        await withItems(engine, rows, async (store) => {
          const modes = [];
          for (const [label, document] of Object.entries(Q)) {
            modes.push((await store.explain(document)).mode);
            assert.equal(await outcome(() => store.execute(document)), await outcome(() => store.execute(document, { pushdown: false })), label);
          }
          // the groupings, predicates, orderings, projections, aggregates and the window
          assert.equal(modes.filter((mode) => mode === 'native').length, 17, JSON.stringify(modes));
        });
      });
    }
  });
}

/** A boolean column beside them, five rows; the same three policies. */
/** @param {string} bool */
const ddl2 = (bool) => `CREATE TABLE items (id integer PRIMARY KEY, g text, v integer, b ${bool});
  INSERT INTO items VALUES (1, NULL, 1, NULL), (2, 'a', 2, TRUE), (3, 'b', NULL, FALSE), (4, 'a', 5, NULL), (5, NULL, 7, TRUE)`;
/** @param {string | undefined} schema */
const model2 = (schema) => ({ $model: '0.1', entities: { Item: { schema: { type: 'object', properties: {
  id: { type: 'integer', 'x-entity': { key: true } }, g: { type: ['string', 'null'] }, v: { type: ['integer', 'null'] }, b: { type: ['boolean', 'null'] } } },
physical: { ...(schema ? { schema } : {}), table: 'items', columns: { id: { name: 'id', codec: 'integer', null: 'reject' },
  g: { name: 'g', codec: 'text', null: 'null' }, v: { name: 'v', codec: 'integer', null: 'null' }, b: { name: 'b', codec: 'boolean', null: 'null' } } } } } });
/** @param {any} where */
const W = (where) => ({ $for: { it: '$.Item[*]' }, $where: where, $orderby: ['$it.id'], $return: '$it.id' });
/** @type {Record<string, any>} */
const READS = {
  boolTrue: W({ $eq: ['$it.b', true] }), boolNeTrue: W({ $ne: ['$it.b', true] }), boolNull: W({ $eq: ['$it.b', null] }),
  boolFalse: W({ $eq: ['$it.b', false] }), list: W({ $eq: ['$it.g', { $seq: ['a', 'b'] }] }), listNull: W({ $eq: ['$it.g', { $seq: ['b', null] }] }),
  external: [W({ $eq: ['$it.g', '$x'] }), { x: 'a' }], externalNull: [W({ $eq: ['$it.g', '$x'] }), { x: null }],
  externalNe: [W({ $ne: ['$it.g', '$x'] }), { x: 'a' }],
  numberExtNull: [W({ $eq: ['$it.v', '$x'] }), { x: null }], numberExtNe: [W({ $ne: ['$it.v', '$x'] }), { x: 2 }],
  numberExtEq: [W({ $eq: ['$it.v', '$x'] }), { x: 2 }], numberExtLt: [W({ $lt: ['$it.v', '$x'] }), { x: 6 }],
  numberExtNeNull: [W({ $ne: ['$it.v', '$x'] }), { x: null }], textExtNeNull: [W({ $ne: ['$it.g', '$x'] }), { x: null }],
  boolExt: [W({ $eq: ['$it.b', '$x'] }), { x: true }], boolExtNull: [W({ $eq: ['$it.b', '$x'] }), { x: null }],
  boolExtNe: [W({ $ne: ['$it.b', '$x'] }), { x: true }], textExtNum: [W({ $ne: ['$it.g', '$x'] }), { x: 5 }], externalList: [W({ $eq: ['$it.g', '$xs[*]'] }), { xs: ['a', null] }],
  orderBool: { $for: { it: '$.Item[*]' }, $where: { $ne: ['$it.b', null] }, $orderby: ['$it.b', '$it.id'], $return: '$it.id' },
};

/**
 * Open the five-row table on `engine`, run `fn` over the store, and close it.
 * @param {string} engine @param {(store: any) => Promise<void>} fn
 */
async function withFive(engine, fn) {
  if (engine === 'postgres') {
    return withPostgres(async ({ pool, schema, driver }) => {
      await pool.query(`SET search_path TO "${schema}"; ${ddl2('boolean')}; RESET search_path`);
      const store = await openStore(model2(schema), { driver: driver(), adopt: true });
      try { await fn(store); }
      finally { await store.close(); }
    });
  }
  const { dbPath, cleanup } = tempDbPath();
  try {
    const raw = new DatabaseSync(dbPath);
    raw.exec(ddl2('integer').replace(/TRUE/g, '1').replace(/FALSE/g, '0'));
    raw.close();
    const store = await openStore(model2(undefined), { driver: nodeDriver(), path: dbPath, adopt: true });
    try { await fn(store); }
    finally { await store.close(); }
  }
  finally { cleanup(); }
}

for (const engine of ENGINES) {
  describe(`columns that read a NULL as a present null, beyond reads, ${engine}`, { skip: skipFor(engine) }, () => {
    it('compares a boolean column, a literal list and an external (a null one too) as the engine does', async () => {
      await withFive(engine, async (store) => {
        for (const [label, q] of Object.entries(READS)) {
          const [document, externals] = Array.isArray(q) ? q : [q, undefined];
          assert.equal(await outcome(() => store.execute(document, { externals })),
            await outcome(() => store.execute(document, { externals, pushdown: false })), label);
        }
      });
    });

    it('pages, loads and mutates natively, the nulls first and a difference holding where the column is NULL', async () => {
      await withFive(engine, async (store) => {
        const items = store.entity('Item');
        /** @param {any} orderBy */
        const pages = async (orderBy) => {
          const ids = [];
          let after;
          for (let i = 0; i < 6; i++) {
            const page = await items.page({ orderBy }, { limit: 2, ...(after ? { after } : {}) });
            ids.push(...page.items.map((/** @type {any} */ row) => row.id));
            if (!page.continuation) break;
            after = page.continuation;
          }
          return ids;
        };
        assert.deepEqual(await pages('$it.g'), [1, 5, 2, 4, 3]);
        assert.deepEqual(await pages({ $key: '$it.g', $dir: 'desc' }), [3, 2, 4, 1, 5]);
        assert.deepEqual(await pages({ $key: '$it.v', $dir: 'desc' }), [5, 4, 2, 1, 3]);
        assert.deepEqual((await items.asNoTracking().load({ orderBy: '$it.b' })).map((/** @type {any} */ row) => row.id), [1, 4, 3, 2, 5]);
        const affected = async (/** @type {any} */ document) => {
          const report = await items.mutate(document);
          assert.equal(report.mode, 'native');
          return report.affected;
        };
        assert.equal(await affected({ op: 'update', where: { $ne: ['$it.g', 'a'] }, set: { v: 99 }, reporting: 'matched' }), 3);
        assert.equal(await affected({ op: 'delete', where: { $eq: ['$it.b', null] } }), 2);
        assert.equal(await affected({ op: 'update', where: { $ne: ['$it.b', true] }, set: { g: 'z' }, reporting: 'matched' }), 1);
        assert.deepEqual((await items.asNoTracking().load({ orderBy: '$it.id' })).map((/** @type {any} */ row) => [row.id, row.g, row.v, row.b]),
          [[2, 'a', 2, true], [3, 'z', 99, false], [5, null, 99, true]]);
      });
    });
  });
}
