//@ts-check
/**
 * @file A number an integer column cannot take as a value of its own type
 * — a fraction, an infinity, a magnitude past 64 bits — compares as the
 * integers it admits (`x < 2.5` is `x <= 2`; an infinity bounds nothing or
 * everything), on every path: `execute`, `load({ where })` and a native
 * `mutate`. PostgreSQL types the parameter from the column and refused the
 * statement; SQLite always compared by value. An integer past the column's
 * own width there (`3000000000` against an `integer`, `40000` against a
 * `smallint`) binds as a `bigint` and compares as written, through the
 * column's index. The oracle is the engine (`pushdown: false`). The
 * PostgreSQL half needs `JAREN_PG_URL`.
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

/**
 * The three widths an integer codec maps on PostgreSQL, with a row at each
 * column's own edges and one whose SQL NULL reads as an absent member.
 */
const WIDE_ROWS = [[1, 32767, 2147483647, 9007199254740991], [2, -32768, -2147483648, -9007199254740991],
  [3, 0, 0, 0], [4, 7, 40000, 3000000000], [5, null, null, null]];
const WIDE_DDL = `CREATE TABLE wide (id integer PRIMARY KEY, s smallint, i integer, b bigint, tag text NOT NULL);
  CREATE INDEX wide_s ON wide (s); CREATE INDEX wide_i ON wide (i); CREATE INDEX wide_b ON wide (b);
  INSERT INTO wide VALUES ${WIDE_ROWS.map((row) => `(${row.map((v) => (v === null ? 'NULL' : v)).join(', ')}, 'x')`).join(', ')};`;
const absent = (/** @type {string} */ name) => ({ name, codec: 'integer', null: 'absent' });
const WIDE = { Wide: { schema: { type: 'object', properties: {
  id: { type: 'integer', 'x-entity': { key: true } }, s: { type: 'integer' }, i: { type: 'integer' }, b: { type: 'integer' },
  tag: { type: 'string' } } },
physical: { table: 'wide', columns: { id: { name: 'id', codec: 'integer', null: 'reject' },
  s: absent('s'), i: absent('i'), b: absent('b'), tag: { name: 'tag', codec: 'text', null: 'reject' } } } } };
/** Each member's literals: its own edges and one past each, a fraction past each, and a wider integer. */
const WIDE_LITERALS = {
  s: [32767, 32768, -32768, -32769, 32768.5, -32769.5, 40000, 3000000000, -3000000000],
  i: [2147483647, 2147483648, -2147483648, -2147483649, 2147483648.5, -2147483649.5, 40000, 3000000000, -3000000000],
  b: [3000000000, -3000000000, 9007199254740991, -9007199254740991, 40000],
};

describe('an integer literal outside a PostgreSQL column\'s own width answers as the engine does', () => {
  it('every operator on both sides of smallint, integer and bigint, a NULL row included, on every path', { skip: !url && 'JAREN_PG_URL is not set' }, async () => {
    const handle = await adoptedPostgres(WIDE_DDL, WIDE, { label: 'intwide' });
    const store = handle.store;
    try {
      let compared = 0;
      for (const [member, literals] of Object.entries(WIDE_LITERALS)) {
        for (const op of OPS) {
          for (const literal of literals) {
            const where = { [op]: [`$it.${member}`, literal] };
            const query = { $for: { it: '$.Wide[*]' }, $where: where, $return: '$it.id' };
            const name = `${member} ${op} ${literal}`;
            const expected = ids(await store.execute(query, { pushdown: false }));
            assert.equal((await store.explain(query)).mode, 'native', `native: ${name}`);
            assert.deepEqual(ids(await store.execute(query)), expected, `execute: ${name}`);
            assert.deepEqual(ids((await store.entity('Wide').load({ where })).map((/** @type {any} */ row) => row.id)), expected, `load: ${name}`);
            const mutated = await store.entity('Wide').mutate({ op: 'update', where, set: { tag: 'x' }, reporting: 'matched' });
            assert.deepEqual(ids(mutated.rows.map((/** @type {any} */ row) => row.id)), expected, `mutate: ${name}`);
            compared++;
          }
        }
      }
      assert.equal(compared, OPS.length * 23);
      // the edges themselves: a NULL row is in no answer, `$ne` past the edge is every present row
      const run = (/** @type {any} */ where) => store.execute({ $for: { it: '$.Wide[*]' }, $where: where, $return: '$it.id' });
      assert.deepEqual(ids(await run({ $lt: ['$it.i', 3000000000] })), [1, 2, 3, 4]);
      assert.deepEqual(ids(await run({ $ne: ['$it.s', 40000] })), [1, 2, 3, 4]);
      assert.deepEqual(ids(await run({ $ge: ['$it.s', 32768] })), []);
      assert.deepEqual(ids(await run({ $gt: ['$it.b', 2147483648] })), [1, 4]);
    }
    finally { await handle.close(); }
  });

  it('a membership list and an external holding such a number compare as the engine does', { skip: !url && 'JAREN_PG_URL is not set' }, async () => {
    const handle = await adoptedPostgres(WIDE_DDL, WIDE, { label: 'intwidel' });
    const store = handle.store;
    try {
      const cases = [
        [{ $eq: ['$it.i', { $seq: [40000, 3000000000] }] }, {}, [4]],
        [{ $eq: ['$it.s', { $seq: [7, 40000] }] }, {}, [4]],
        [{ $or: [{ $eq: ['$it.s', 7] }, { $eq: ['$it.s', 3000000000] }] }, {}, [4]],
        [{ $lt: ['$it.i', '$x'] }, { x: 3000000000 }, [1, 2, 3, 4]],
        [{ $eq: ['$it.s', '$xs[*]'] }, { xs: [7, 40000] }, [4]],
      ];
      for (const [where, externals, expected] of cases) {
        const query = { $for: { it: '$.Wide[*]' }, $where: where, $return: '$it.id' };
        assert.deepEqual(ids(await store.execute(query, { pushdown: false, externals })), expected, JSON.stringify(where));
        assert.deepEqual(ids(await store.execute(query, { externals })), expected, JSON.stringify(where));
      }
    }
    finally { await handle.close(); }
  });

  it('the statement keeps the bare column, so its index still seeks; a literal within smallint binds as before', { skip: !url && 'JAREN_PG_URL is not set' }, async () => {
    const handle = await adoptedPostgres(`${WIDE_DDL} INSERT INTO wide SELECT g, 1, 1, 1, 'y' FROM generate_series(10, 5009) g; ANALYZE wide;`, WIDE, { label: 'intwides' });
    try {
      const explained = (/** @type {any} */ where) => handle.store.explain({ $for: { it: '$.Wide[*]' }, $where: where, $return: '$it.id' });
      const above = await explained({ $gt: ['$it.i', 3000000000] });
      assert.match(above.sql, /"t0"\."i" > \(\$1\)::bigint/);
      assert.match(above.scanNarrative, /Index Cond: \(\(i IS NOT NULL\) AND \(i > '3000000000'::bigint\)\)/);
      const small = await explained({ $gt: ['$it.s', 40000] });
      assert.match(small.scanNarrative, /Index Cond: \(\(s IS NOT NULL\) AND \(s > '40000'::bigint\)\)/);
      assert.match((await explained({ $gt: ['$it.i', 30000] })).sql, /"t0"\."i" > \$1\)/, 'within smallint: the parameter as before');
    }
    finally { await handle.close(); }
  });
});
