//@ts-check
/**
 * @file `explain()` answers for the run it describes. Given the externals
 * `execute` is given, a value the database cannot bind is reported as the
 * set residual it becomes — mode, SQL, reasons — not as the native plan
 * that will not run; the diversion is counted in `stats().bind.diverted`
 * so production sees it without anyone calling `explain()`; every
 * explanation carries `streaming` and `barrier`, the same classification
 * the cursor carries, proven equal by running both; and `strictStreaming`
 * declines a buffering plan by name before any statement runs.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { compileJsonQuery } from '@jarenjs/json/query';

import { statementCountingDriver } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    users: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, name: { type: 'string' }, age: { type: 'integer' },
        active: { type: 'boolean' } } },
      key: '/id',
      indexes: [{ name: 'by_age', path: '$.age' }],
    },
  },
  entities: {
    Row: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'integer', 'x-entity': { key: true } },
          n: { type: 'integer', 'x-entity': { index: true } },
        },
      },
    },
  },
};
const DATA = [
  { id: 'a', name: 'ada', age: 36, active: true },
  { id: 'b', name: 'kid', age: 8, active: false },
  { id: 'c', name: 'lin', age: 64, active: true },
  { id: 'd', name: 'nil' },
];

async function fresh() {
  const counters = { iterate: 0, next: 0, return: 0, all: 0 };
  const store = await openStore(MODEL, { driver: statementCountingDriver(counters) });
  const users = store.collection('users');
  for (const row of DATA) await users.insert(row);
  const rows = store.entity('Row');
  for (let i = 1; i <= 5; i++) await rows.create({ id: i, n: i });
  counters.iterate = 0;
  counters.next = 0;
  counters.return = 0;
  counters.all = 0;
  return { store, users, rows, counters };
}

const codeIs = (code, pattern = undefined) => (error) =>
  error.code === code && (pattern === undefined || pattern.test(error.message));

const FLAGGED = { $for: { it: '$[*]' }, $where: { $eq: ['$it.active', '$flag'] }, $return: '$it.id' };

describe('explain reads the externals it is given', () => {
  it('a boolean external that cannot bind is reported as the set residual execute runs, and counted', async () => {
    const { store, users, counters } = await fresh();
    const native = await users.explain(FLAGGED, { externals: { flag: 'yes' } });
    assert.strictEqual(native.mode, 'native', 'one member path projects natively');
    assert.strictEqual(native.streaming, 'row');
    assert.strictEqual(native.barrier, null);
    assert.match(native.sql, /"active"/, 'the native statement binds the predicate');

    const diverted = await users.explain(FLAGGED, { externals: { flag: true } });
    assert.strictEqual(diverted.mode, 'set', 'the run reads the whole collection and the engine answers');
    assert.strictEqual(diverted.streaming, 'buffered');
    assert.deepStrictEqual(diverted.barrier?.construct, 'external');
    assert.match(diverted.barrier?.reason ?? '', /'flag'/);
    assert.doesNotMatch(diverted.sql, /"active"/, 'the diversion statement is the whole collection');
    assert.strictEqual(diverted.residual?.mode, 'set');
    // the plan's own reason (the projection the row residual applies)
    // stays first; the value that would not bind is appended, named
    assert.strictEqual(diverted.residual?.reasons.at(-1).construct, 'external');
    assert.deepStrictEqual(diverted.barriers.at(-1).operator, 'external');
    assert.strictEqual(counters.iterate, 0, 'explain opened no row iterator (its EXPLAIN QUERY PLAN is not the document)');

    // the same call through execute answers what the engine answers, and
    // the diversion is counted where nobody calls explain()
    assert.deepStrictEqual(store.stats().statementCache.misses > 0, true);
    const viaDb = await Promise.resolve(users.execute(FLAGGED, { externals: { flag: true } }));
    assert.deepStrictEqual(viaDb, compileJsonQuery(FLAGGED)(structuredClone(DATA), { flag: true }));
    assert.deepStrictEqual(users.stats().bind, { diverted: 1 });
    for await (const item of users.query(FLAGGED, { externals: { flag: true } })) void item;
    assert.deepStrictEqual(users.stats().bind, { diverted: 2 }, 'a diverted cursor counts too');
    await Promise.resolve(users.execute(FLAGGED, { externals: { flag: 'yes' } }));
    assert.deepStrictEqual(users.stats().bind, { diverted: 2 }, 'a bound call is not a diversion');
    await store.close();
  });

  it('the entity engine reads them the same way', async () => {
    const { store, rows } = await fresh();
    const document = { $for: { r: '$.Row[*]' }, $where: { $eq: ['$r.n', '$flag'] }, $return: '$r' };
    const native = await rows.explain(document, { externals: { flag: 2 } });
    assert.strictEqual(native.mode, 'native');
    assert.strictEqual(native.streaming, 'row');
    assert.ok(typeof native.sql === 'string');
    const diverted = await rows.explain(document, { externals: { flag: true } });
    assert.strictEqual(diverted.mode, 'set');
    assert.strictEqual(diverted.streaming, 'buffered');
    assert.strictEqual(diverted.barrier?.construct, 'external');
    assert.strictEqual(diverted.sql, null, 'no single statement answers a residual over the fetched root');
    assert.strictEqual(diverted.residual?.reasons.at(-1).construct, 'external');
    await store.close();
  });
});

describe('a set, group or barrier plan declares that it materializes', () => {
  it('the barrier is a stable identifier, asserted by exact value', async () => {
    const { store, users, rows } = await fresh();
    const cases = [
      [users, { $for: { it: '$[*]' }, $let: { x: 1 }, $where: { $exists: '$it.name' }, $return: '$it.id' }, {}, '$let'],
      [users, { $for: { it: '$[*]' }, $groupby: { g: '$it.active' }, $return: { g: '$g', n: { $count: '$it' } } }, {}, '$groupby'],
      [users, FLAGGED, { flag: true }, 'external'],
      [users, [{ $for: { it: '$[*]' }, $return: '$it' }], {}, 'window'],
      [rows, { $for: { r: '$.Row[*]' }, $return: '$r.n' }, {}, '$return'],
      [rows, { $for: { r: '$.Row[*]' }, $let: { k: 1 }, $return: '$r' }, {}, '$let'],
    ];
    for (const [handle, document, externals, construct] of cases) {
      const explained = await handle.explain(document, { externals });
      assert.strictEqual(explained.streaming, 'buffered', JSON.stringify(document));
      assert.strictEqual(explained.barrier?.construct, construct, JSON.stringify(document));
      assert.ok(typeof explained.barrier?.reason === 'string' && explained.barrier.reason.length > 0);
    }
    const forced = await users.explain({ $for: { it: '$[*]' }, $return: '$it' }, { pushdown: false });
    assert.deepStrictEqual([forced.streaming, forced.barrier?.construct], ['buffered', 'pushdown']);
    await store.close();
  });
});

describe('the classification agrees with what the cursor does', () => {
  it('for every shape, explain().streaming equals the cursor\'s, and the statement accounting proves the class', async () => {
    const { store, users, rows, counters } = await fresh();
    const cases = [
      [users, { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 10] }, $return: '$it' }, {}],
      [users, { $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: { i: '$it.id' } }, {}],
      [users, { $for: { it: '$[*]' }, $let: { x: 1 }, $where: { $exists: '$it.name' }, $return: '$it.id' }, {}],
      [users, FLAGGED, { flag: true }],
      [users, FLAGGED, { flag: 'yes' }],
      [users, { $count: { $for: { it: '$[*]' }, $return: '$it' } }, {}],
      [rows, { $for: { r: '$.Row[*]' }, $where: { $gt: ['$r.n', 1] }, $return: '$r' }, {}],
      [rows, { $for: { r: '$.Row[*]' }, $return: '$r.n' }, {}],
      [rows, { $count: { $for: { r: '$.Row[*]' }, $return: '$r' } }, {}],
    ];
    for (const [handle, document, externals] of cases) {
      const explained = await handle.explain(document, { externals });
      const cursor = (handle.query ?? handle.cursor).call(handle, document, { externals });
      assert.strictEqual(cursor.streaming, explained.streaming, JSON.stringify(document));
      assert.deepStrictEqual(cursor.barrier, explained.barrier, JSON.stringify(document));
      counters.iterate = 0;
      counters.all = 0;
      let n = 0;
      for await (const item of cursor) {
        void item;
        n++;
      }
      if (explained.streaming === 'row' && !('$count' in document)) {
        assert.strictEqual(counters.iterate, 1, `${JSON.stringify(document)}: a row-streamable plan pulls through iterate()`);
        assert.strictEqual(counters.all, 0);
      }
      else if (explained.streaming === 'buffered') {
        assert.strictEqual(counters.iterate, 0, `${JSON.stringify(document)}: a buffered plan opens no row iterator`);
        assert.ok(counters.all >= 1 || n === 1, 'it materialised, or answered its one window');
      }
    }
    await store.close();
  });

  it('a graph load is always row-streaming, and says so beside its keyset facts', async () => {
    const { store, rows } = await fresh();
    const explained = rows.explainLoad({ orderBy: '$it.n' });
    assert.strictEqual(explained.streaming, 'row');
    assert.strictEqual(explained.barrier, null);
    const paged = rows.explainLoad({ orderBy: '$it.n', after: { order: [
      { column: 'n', desc: false, nullsFirst: true }, { column: 'id', desc: false, nullsFirst: true }], keys: [2], key: 2 } });
    assert.deepStrictEqual([paged.pagination, paged.streaming, paged.snapshot], ['keyset', 'row', false]);
    await store.close();
  });
});

describe('strictStreaming refuses a buffered plan before any statement runs', () => {
  it('names the barrier, runs nothing, and leaves a row-streamable plan alone', async () => {
    const { store, users, rows, counters } = await fresh();
    const set = { $for: { it: '$[*]' }, $let: { x: 1 }, $where: { $exists: '$it.name' }, $return: '$it.id' };
    assert.throws(() => users.query(set, { strictStreaming: true }),
      codeIs('JD0037', /strictStreaming refused a plan that buffers: '\$let'/));
    assert.throws(() => users.query(FLAGGED, { externals: { flag: true }, strictStreaming: true }),
      codeIs('JD0037', /'external' — the external 'flag'/));
    assert.throws(() => rows.cursor({ $for: { r: '$.Row[*]' }, $return: '$r.n' }, { strictStreaming: true }),
      codeIs('JD0037', /'\$return'/));
    assert.strictEqual(counters.all + counters.iterate + counters.next, 0, 'no statement ran');
    const seen = [];
    for await (const id of users.query(FLAGGED, { externals: { flag: 'yes' }, strictStreaming: true })) seen.push(id);
    assert.deepStrictEqual(seen, []);
    const streamed = [];
    for await (const row of rows.cursor({ $for: { r: '$.Row[*]' }, $where: { $gt: ['$r.n', 3] }, $return: '$r' },
      { strictStreaming: true })) streamed.push(row.n);
    assert.deepStrictEqual(streamed, [4, 5]);
    // a whole answer has no stream to hold to: execute refuses the option as misuse
    assert.throws(() => users.execute(set, { strictStreaming: true }), TypeError);
    await store.close();
  });
});
