//@ts-check
/**
 * @file A number an integer column cannot take as a value of its own type
 * — a fraction, an infinity, a magnitude past 64 bits — compares as the
 * integers it admits (`x < 2.5` is `x <= 2`; an infinity bounds nothing or
 * everything), on every path: `execute`, `load({ where })` and a native
 * `mutate`. PostgreSQL types the parameter from the column and refused the
 * statement; SQLite always compared by value. The oracle is the engine
 * (`pushdown: false`). The PostgreSQL half needs `JAREN_PG_URL`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { adopted, adoptedPostgres } from './helpers.js';

const url = process.env.JAREN_PG_URL;
const ROWS = [[1, -3], [2, 0], [3, 3], [4, 7], [5, 100]];
const ddl = (/** @type {boolean} */ pg) => `CREATE TABLE rows (id integer PRIMARY KEY, qty integer NOT NULL, w ${pg ? 'double precision' : 'real'} NOT NULL);
  INSERT INTO rows VALUES ${ROWS.map(([id, qty]) => `(${id}, ${qty}, ${qty})`).join(', ')};`;
const entities = { Row: { schema: { type: 'object', properties: {
  id: { type: 'integer', 'x-entity': { key: true } }, qty: { type: 'integer' }, w: { type: 'number' } } },
physical: { table: 'rows', columns: {
  id: { name: 'id', codec: 'integer', null: 'reject' }, qty: { name: 'qty', codec: 'integer', null: 'reject' },
  w: { name: 'w', codec: 'number', null: 'reject' } } } } };
const LITERALS = { fraction: 2.5, negativeFraction: -0.5, hugeFraction: 1e300, hugeNegative: -1e300,
  pastInt64: 1e19, pastNegativeInt64: -1e19, infinity: Infinity, negativeInfinity: -Infinity, zero: 0, plain: 3 };
const OPS = ['$eq', '$ne', '$lt', '$le', '$gt', '$ge'];
/** @param {any} value */
const ids = (value) => (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(Number).sort((a, b) => a - b);

/** @param {any} store */
async function agree(store) {
  let compared = 0;
  for (const member of ['qty', 'w']) {
    for (const op of OPS) {
      for (const [label, literal] of Object.entries(LITERALS)) {
        const where = { [op]: [`$it.${member}`, literal] };
        const query = { $for: { it: '$.Row[*]' }, $where: where, $return: '$it.id' };
        const name = `${member} ${op} ${label}`;
        const expected = ids(await store.execute(query, { pushdown: false }));
        assert.deepEqual(ids(await store.execute(query)), expected, `execute: ${name}`);
        assert.deepEqual(ids((await store.entity('Row').load({ where })).map((/** @type {any} */ row) => row.id)), expected, `load: ${name}`);
        const mutated = await store.entity('Row').mutate({ op: 'update', where, set: { w: 0.25 }, reporting: 'matched' });
        assert.deepEqual(ids(mutated.rows.map((/** @type {any} */ row) => row.id)), expected, `mutate: ${name}`);
        for (const [id, qty] of ROWS) await store.entity('Row').mutate({ op: 'update', key: id, set: { w: qty }, reporting: 'matched' });
        compared++;
      }
    }
  }
  return compared;
}

describe('an integer column compared with a number of another kind answers as the engine does', () => {
  it('SQLite', async () => {
    const handle = await adopted(ddl(false), entities);
    try { assert.equal(await agree(handle.store), 2 * OPS.length * Object.keys(LITERALS).length); }
    finally { await handle.close(); }
  });

  it('PostgreSQL', { skip: !url && 'JAREN_PG_URL is not set' }, async () => {
    const handle = await adoptedPostgres(ddl(true), entities, { label: 'intlit' });
    try { assert.equal(await agree(handle.store), 2 * OPS.length * Object.keys(LITERALS).length); }
    finally { await handle.close(); }
  });

  it('the statement keeps the integer column\'s own comparison: a fraction is a bound on the integers, an infinity none', async () => {
    const handle = await adopted(ddl(false), entities);
    try {
      const sql = async (/** @type {any} */ where) => (await handle.store.explain({ $for: { it: '$.Row[*]' }, $where: where, $return: '$it.id' })).sql;
      assert.match(await sql({ $lt: ['$it.qty', 2.5] }), /"qty" <= \?/);
      assert.match(await sql({ $gt: ['$it.qty', 2.5] }), /"qty" >= \?/);
      assert.match(await sql({ $lt: ['$it.qty', Infinity] }), /WHERE "t0"\."qty" IS NOT NULL ORDER BY/);
      assert.doesNotMatch(await sql({ $lt: ['$it.qty', Infinity] }), /\?/, 'no value is bound for it');
      assert.match(await sql({ $eq: ['$it.qty', 2.5] }), /WHERE 0 ORDER BY/);
    }
    finally { await handle.close(); }
  });
});
