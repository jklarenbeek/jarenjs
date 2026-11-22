//@ts-check
/**
 * @file On a real PostgreSQL server, a collection member's comparison with an
 * external, and its membership in an external list, seek the member's index
 * where the external is a number or the list holds only numbers: the
 * external's JSON type is a constant of the call, so the branch of the other
 * kind folds away, and the number branch compares the generated `numeric`
 * column with the interval of decimals that round to the external's double,
 * bound as `numeric`, as a literal is compared; a list of strings over a
 * string member seeks its index the same way. Every answer equals the
 * residual's, a wide integer, an infinity and a document of another kind
 * (a store that validates nothing holds one) included.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';

const url = process.env.JAREN_PG_URL;
const MODEL = {
  $model: '0.1',
  collections: {
    c: {
      key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'number' }, s: { type: 'string' } } },
      indexes: [{ name: 'by_n', path: '$.n' }, { name: 'by_s', path: '$.s' }],
    },
  },
};
const ROWS = 3000;
/** @param {any} where */
const over = (where) => ({ $for: { it: '$[*]' }, $where: where, $orderby: ['$it.id'], $return: '$it.id' });
const SEEKS = /Index (Only )?Scan using c_by_[ns] on c\b|Bitmap Index Scan on c_by_[ns]\b/;

/** The cases: a document, its externals, and whether its statement seeks the member's index. */
const CASES = {
  eq: [over({ $eq: ['$it.n', '$v'] }), { v: 5 }, true],
  eqFraction: [over({ $eq: ['$it.n', '$v'] }), { v: 0.1 }, true],
  eqWide: [over({ $eq: ['$it.n', '$v'] }), { v: 2 ** 53 }, true],
  eqWideDigits: [over({ $eq: ['$it.n', '$v'] }), { v: Number('9007199254740993') }, true],
  lt: [over({ $lt: ['$it.n', '$v'] }), { v: 4 }, true],
  le: [over({ $le: ['$it.n', '$v'] }), { v: 4 }, true],
  gt: [over({ $gt: ['$it.n', '$v'] }), { v: ROWS - 4 }, true],
  ge: [over({ $ge: ['$it.n', '$v'] }), { v: ROWS - 4 }, true],
  ne: [over({ $ne: ['$it.n', '$v'] }), { v: 5 }, false],
  belowInfinity: [over({ $lt: ['$it.n', '$v'] }), { v: Infinity }, false],
  aboveNegativeInfinity: [over({ $gt: ['$it.n', '$v'] }), { v: -Infinity }, false],
  atInfinity: [over({ $eq: ['$it.n', '$v'] }), { v: Infinity }, false],
  string: [over({ $eq: ['$it.n', '$v'] }), { v: 's1' }, false],
  boolean: [over({ $eq: ['$it.n', '$v'] }), { v: true }, false],
  list: [over({ $eq: ['$it.n', '$ids[*]'] }), { ids: [5, 7] }, true],
  listOfOne: [over({ $eq: ['$it.n', '$ids[*]'] }), { ids: [5] }, true],
  listOfFifty: [over({ $eq: ['$it.n', '$ids[*]'] }), { ids: Array.from({ length: 50 }, (_, i) => i * 41) }, true],
  listObject: [over({ $eq: ['$it.n', '$ids[*]'] }), { ids: { a: 5, b: 9 } }, true],
  listWide: [over({ $eq: ['$it.n', '$ids[*]'] }), { ids: [2 ** 53, 0.1] }, true],
  listMixed: [over({ $eq: ['$it.n', '$ids[*]'] }), { ids: [5, 's1'] }, false],
  listStrings: [over({ $eq: ['$it.n', '$ids[*]'] }), { ids: ['s1'] }, false],
  listEmpty: [over({ $eq: ['$it.n', '$ids[*]'] }), { ids: [] }, false],
  textList: [over({ $eq: ['$it.s', '$ids[*]'] }), { ids: ['s5', 's7'] }, true],
  textListMixed: [over({ $eq: ['$it.s', '$ids[*]'] }), { ids: ['s5', 7] }, false],
  textExternal: [over({ $eq: ['$it.s', '$v'] }), { v: 's5' }, true],
};

describe('PostgreSQL: an external compared with an indexed number member', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let admin;
  /** @type {any} */
  let pool;
  /** @type {any} */
  let store;
  const schema = `jaren_external_seek_${process.pid}`;

  before(async () => {
    const pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    // costed with sequential scans off: the index is usable, not merely chosen at this table's size
    pool = new pg.Pool({ connectionString: url, max: 1, options: '-c enable_seqscan=off' });
    store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }) });
    await admin.query(`INSERT INTO "${schema}"."c" (key, doc) SELECT 'r' || g, jsonb_build_object('id', 'r' || g, 'n', g, 's', 's' || g) `
      + `FROM generate_series(0, ${ROWS - 1}) g`);
    // what a store that validates nothing can hold: another kind, a wide integer by two spellings, a fraction by
    // two, a number past the double range, a null
    await store.transaction(async (/** @type {any} */ tx) => {
      for (const doc of [{ id: 's', n: 's1' }, { id: 'w1', n: 2 ** 53 }, { id: 'f', n: 0.1 }, { id: 'nul', n: null }])
        await tx.collection('c').put(doc);
    });
    await admin.query(`INSERT INTO "${schema}"."c" (key, doc) VALUES ('w2', '{"id":"w2","n":9007199254740993}'), `
      + `('f2', '{"id":"f2","n":0.10000000000000000001}'), ('big', '{"id":"big","n":1e400}')`);
    await admin.query(`ANALYZE "${schema}"."c"`);
  });
  after(async () => {
    await store?.close().catch(() => {});
    await pool?.end().catch(() => {});
    if (admin) {
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });

  it('answers every case as the residual does', async () => {
    const c = store.collection('c');
    for (const [name, [document, externals]] of Object.entries(CASES)) {
      assert.deepEqual(await c.execute(document, { externals }), await c.execute(document, { externals, pushdown: false }), name);
    }
    assert.deepEqual(await c.execute(CASES.eqWide[0], { externals: CASES.eqWide[1] }), ['w1', 'w2']);
    assert.deepEqual(await c.execute(CASES.eqFraction[0], { externals: CASES.eqFraction[1] }), ['f', 'f2']);
    assert.deepEqual(await c.execute(CASES.atInfinity[0], { externals: CASES.atInfinity[1] }), 'big');
    assert.deepEqual(await c.execute(CASES.listWide[0], { externals: CASES.listWide[1] }), ['f', 'f2', 'w1', 'w2']);
    assert.deepEqual(await c.execute(CASES.listMixed[0], { externals: CASES.listMixed[1] }), ['r5', 's']);
  });

  it('seeks the member\'s index for a number external and a list of numbers', async () => {
    const c = store.collection('c');
    for (const [name, [document, externals, seeks]] of Object.entries(CASES)) {
      if (!seeks) continue;
      const plan = await c.explain(document, { externals });
      assert.equal(plan.mode, 'native', name);
      assert.match(plan.scanNarrative, SEEKS, `${name}: ${plan.scanNarrative}`);
      // the outer read, not only a list's inner read of its intervals
      assert.doesNotMatch(plan.scanNarrative, /Seq Scan on c(?!\w| interval_row)/, `${name}: ${plan.scanNarrative}`);
    }
  });
});
