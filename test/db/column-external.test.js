//@ts-check
/**
 * @file An external operand against an entity column answers as the engine
 * does, on SQLite and, under `JAREN_PG_URL`, on PostgreSQL: a `$ne` against
 * an external of the column's other type is true for every present value,
 * a boolean column equals and orders against neither a string nor a number,
 * and a boolean, null or object external crosses to the engine rather than
 * into the statement (the PostgreSQL statement carries every external as
 * JSON text, which binds whatever it holds). The oracle is the engine
 * (`pushdown: false`).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';

import { adopted, adoptedPostgres } from './helpers.js';

const url = process.env.JAREN_PG_URL;
const key = { 'x-entity': { key: true } };
const MODEL = {
  $model: '0.1',
  entities: {
    Item: { schema: { type: 'object', properties: {
      id: { type: 'string', ...key },
      s: { type: 'string', 'x-entity': { index: true } },
      n: { type: 'number', 'x-entity': { index: true } },
      b: { type: 'boolean', 'x-entity': { index: true } },
      i: { type: 'integer', 'x-entity': { index: true } },
    } } },
  },
};
const DOCS = [
  { id: 'd0', s: 'a', n: 0, b: true, i: 0 }, { id: 'd1', s: 'b', n: 1, b: false, i: 1 },
  { id: 'd2', s: 'é', n: 5, b: true, i: 5 }, { id: 'd3', s: '5', n: 2.5, b: false, i: 7 },
  { id: 'd4', s: 'a', n: -1, i: 9 }, { id: 'd5', n: 5, b: true }, { id: 'd6', s: 'z' },
];
const EXTERNALS = { text: 'a', accent: 'é', numeric: '5', number: 5, negative: -1, fraction: 2.5, true: true, false: false, null: null, object: { k: 1 } };
const OPS = ['$eq', '$ne', '$lt', '$le', '$gt', '$ge'];
/** @param {any} value */
const sorted = (value) => [...(Array.isArray(value) ? value : value === undefined ? [] : [value])].sort();

/**
 * Every comparison of every member with every external, plain and negated,
 * against the engine.
 * @param {any} store @param {string[]} members @param {string} entity @param {Record<string, any>} externals
 */
async function agreeWithTheEngine(store, members, entity, externals = EXTERNALS) {
  let compared = 0;
  for (const member of members) {
    for (const op of OPS) {
      for (const [label, x] of Object.entries(externals)) {
        for (const negated of [false, true]) {
          const comparison = { [op]: [`$it.${member}`, '$x'] };
          const query = { $for: { it: `$.${entity}[*]` }, $where: negated ? { $not: comparison } : comparison, $return: '$it.id' };
          const options = { externals: { x } };
          assert.deepEqual(sorted(await store.execute(query, options)), sorted(await store.execute(query, { ...options, pushdown: false })),
            `${negated ? 'not ' : ''}${op} ${member} against ${label}`);
          compared++;
        }
      }
    }
  }
  return compared;
}

/**
 * The cases, once per engine.
 * @param {{ store: () => any }} engine
 */
function cases(engine) {
  it('every comparison of a column member with an external of any type answers as the engine does', async () => {
    const compared = await agreeWithTheEngine(engine.store(), ['s', 'n', 'b', 'i', 'id'], 'Item');
    assert.equal(compared, 5 * OPS.length * Object.keys(EXTERNALS).length * 2);
  });

  it('a $ne against an external of the other type keeps every present value', async () => {
    const store = engine.store();
    const present = (/** @type {string} */ member) => sorted(DOCS.filter((doc) => member in doc).map((doc) => doc.id));
    for (const [member, x] of /** @type {[string, any][]} */ ([['s', 5], ['n', 'a'], ['i', 'a'], ['b', 'a'], ['b', 5], ['id', 5]])) {
      const query = { $for: { it: '$.Item[*]' }, $where: { $ne: [`$it.${member}`, '$x'] }, $return: '$it.id' };
      assert.deepEqual(sorted(await store.execute(query, { externals: { x } })), present(member), `${member} against ${JSON.stringify(x)}`);
    }
  });

  it('a boolean or an object external sends the call to the engine; a null one binds', async () => {
    const store = engine.store();
    const query = { $for: { it: '$.Item[*]' }, $where: { $eq: ['$it.s', '$x'] }, $return: '$it.id' };
    for (const x of [true, false, { k: 1 }]) {
      const plan = await store.explain(query, { externals: { x } });
      assert.equal(plan.mode, 'set', JSON.stringify(x));
      assert.match(plan.residual.reasons[0].reason, /is not a value the database binds/);
    }
    // a string, a number and a null bind: the column's own null differs from them all
    for (const x of ['a', 5, null]) assert.equal((await store.explain(query, { externals: { x } })).mode, 'native', JSON.stringify(x));
  });
}

describe('an external against an entity column (SQLite)', () => {
  /** @type {any} */
  let store;
  before(async () => {
    store = await openStore(MODEL, { driver: nodeDriver(), path: ':memory:' });
    for (const doc of DOCS) await store.entity('Item').create(doc);
  });
  after(async () => { await store?.close(); });
  cases({ store: () => store });
});

describe('an external against an entity column (PostgreSQL)', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let pool;
  /** @type {any} */
  let store;
  const schema = `jaren_column_external_${process.pid}`;
  before(async () => {
    const pg = (await import('pg')).default;
    pool = new pg.Pool({ connectionString: url, max: 2 });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }) });
    for (const doc of DOCS) await store.entity('Item').create(doc);
  });
  after(async () => {
    await store?.close();
    try { await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await pool?.end(); }
  });
  cases({ store: () => store });
});

describe('an external against an adopted table\'s columns', () => {
  const T = (/** @type {boolean} */ pg) => (pg ? 'true' : '1');
  const F = (/** @type {boolean} */ pg) => (pg ? 'false' : '0');
  const ddl = (/** @type {boolean} */ pg) => `CREATE TABLE rows (id integer PRIMARY KEY, label text NOT NULL, qty integer NOT NULL,
    flag ${pg ? 'boolean NOT NULL' : 'integer NOT NULL CHECK (flag IN (0, 1))'});
    INSERT INTO rows VALUES (1, 'a', 1, ${T(pg)}), (2, 'b', 2, ${F(pg)}), (3, '5', 5, ${T(pg)}), (4, 'a', 7, ${F(pg)});`;
  const entities = { Row: { schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, label: { type: 'string' }, qty: { type: 'integer' }, flag: { type: 'boolean' } } },
  physical: { table: 'rows', columns: {
    id: { name: 'id', codec: 'integer', null: 'reject' }, label: { name: 'label', codec: 'text', null: 'reject' },
    qty: { name: 'qty', codec: 'integer', null: 'reject' }, flag: { name: 'flag', codec: 'boolean', null: 'reject' } } } } };

  it('SQLite columns answer as the engine does', async () => {
    const handle = await adopted(ddl(false), entities);
    try { await agreeWithTheEngine(handle.store, ['label', 'qty', 'flag', 'id'], 'Row'); }
    finally { await handle.close(); }
  });

  it('PostgreSQL columns answer as the engine does', { skip: !url && 'JAREN_PG_URL is not set' }, async () => {
    const handle = await adoptedPostgres(ddl(true), entities, { label: 'colext' });
    try { await agreeWithTheEngine(handle.store, ['label', 'qty', 'flag', 'id'], 'Row'); }
    finally { await handle.close(); }
  });
});
