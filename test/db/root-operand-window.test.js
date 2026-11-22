//@ts-check
/**
 * @file The bare root wildcard as the operand of a top-level window or
 * existence test — what a chain's `first()`, `elementAt(n)`, `take(n)` and
 * `any()` send over a collection handle — is planned as the `$for` scan it
 * abbreviates (NATIVE-PLANS): the window is the statement's LIMIT and the
 * test a one-row probe, never a fetch of every document. A store run is
 * SQLite always, PostgreSQL where JAREN_PG_URL names a server.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { reasonId } from '@jarenjs/db';
import { planQuery } from '../../packages/db/src/plan.js';
import { classifyLiveQuery } from '../../packages/db/src/live.js';
import { ENGINES, skipFor, withStore } from './store-core-engines.js';

const MODEL = {
  $model: '0.1',
  collections: {
    c: {
      key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, o: { type: 'number' }, u: { type: 'string' } } },
      indexes: [{ name: 'by_o', path: '$.o' }],
    },
  },
};
const SCAN = { $for: { it: '$[*]' }, $return: '$it' };
/** @param {any} where */
const over = (where) => ({ $for: { it: '$[*]' }, $where: where, $return: '$it' });

/** The documents a chain sends, and what each must read. */
const WINDOWS = {
  first: [{ $subsequence: ['$[*]', 0, 1] }],
  elementAt: [{ $subsequence: ['$[*]', 5, 1] }],
  take: [{ $subsequence: ['$[*]', 0, 3] }],
  bare: { $subsequence: ['$[*]', 2, 2] },
  nested: { $subsequence: [{ $subsequence: ['$[*]', 1, 6] }, 2, 2] },
  open: { $subsequence: ['$[*]', 4] },
  past: [{ $subsequence: ['$[*]', 50, 1] }],
};
const TESTS = {
  any: { $exists: '$[*]' },
  overPhrase: { $exists: SCAN },
  seeks: { $exists: over({ $eq: ['$it.o', 7] }) },
  none: { $exists: over({ $eq: ['$it.o', -1] }) },
  member: { $exists: { $for: { it: '$[*]' }, $return: '$it.u' } },
  absentMember: { $exists: { $for: { it: '$[*]' }, $where: { $gt: ['$it.o', 8] }, $return: '$it.u' } },
};

/** What a call answers, or the code it raises. @param {() => any} call */
async function outcome(call) {
  try { return await call(); }
  catch (error) { return /** @type {any} */ (error).code; }
}

for (const engine of ENGINES) {
  describe(`a window or an existence test over the bare root wildcard, ${engine}`, { skip: skipFor(engine) }, () => {
    it('reads the window as the scan\'s LIMIT, answering as the engine', async () => {
      await withStore(engine, MODEL, async (store) => {
        const rows = store.collection('c');
        for (let i = 0; i < 10; i++) await rows.insert({ id: `d${i}`, o: i, ...(i > 8 ? {} : { u: `u${i}` }) });
        for (const [name, document] of Object.entries(WINDOWS)) {
          const explained = await rows.explain(document);
          assert.equal(explained.mode, 'native', name);
          assert.match(explained.sql, /LIMIT|OFFSET/, name);
          assert.deepEqual(await rows.execute(document), await rows.execute(document, { pushdown: false }), name);
        }
        assert.deepEqual(await rows.execute(WINDOWS.elementAt), [{ id: 'd5', o: 5, u: 'u5' }]);
        assert.deepEqual(await rows.execute(WINDOWS.past), []);
      });
    });

    it('reads an existence test as a one-row probe, answering as the engine', async () => {
      await withStore(engine, MODEL, async (store) => {
        const rows = store.collection('c');
        assert.equal(await rows.execute(TESTS.any), false);
        assert.equal(await rows.execute(TESTS.any, { pushdown: false }), false);
        for (let i = 0; i < 10; i++) await rows.insert({ id: `d${i}`, o: i, ...(i > 8 ? {} : { u: `u${i}` }) });
        for (const [name, document] of Object.entries(TESTS)) {
          const explained = await rows.explain(document);
          assert.equal(explained.mode, 'native', name);
          assert.match(explained.sql, /^(DECLARE .* FOR )?SELECT COUNT\(\*\) AS "value" FROM \(SELECT 1 AS "_row" FROM "c".* LIMIT 1\) AS "_exists"$/, name);
          assert.deepEqual(await rows.execute(document), await rows.execute(document, { pushdown: false }), name);
        }
        assert.deepEqual(await Promise.all(Object.values(TESTS).map((document) => rows.execute(document))),
          [true, true, true, false, true, false]);
        // a strict run accepts what plans native, and a cursor yields the one boolean
        assert.equal(await rows.execute(TESTS.seeks, { strict: true }), true);
        const drained = async (/** @type {any} */ cursor) => { const items = []; for await (const item of cursor) items.push(item); return items; };
        for (const document of [TESTS.any, TESTS.none]) {
          assert.deepEqual(await drained(await rows.query(document)), await drained(await rows.query(document, { pushdown: false })));
        }
      });
    });

    it('leaves a test it cannot probe to the engine', async () => {
      await withStore(engine, MODEL, async (store) => {
        const rows = store.collection('c');
        for (let i = 0; i < 4; i++) await rows.insert({ id: `d${i}`, o: i % 2, u: `u${i}` });
        const kept = {
          grouped: { $exists: { $for: { it: '$[*]' }, $groupby: { k: '$it.o' }, $return: '$k' } },
          windowed: { $exists: { $subsequence: ['$[*]', 0, 1] } },
          inWindow: { $subsequence: [{ $exists: '$[*]' }, 0, 1] },
          raising: { $exists: { $for: { it: '$[*]' }, $return: { $upper: '$it.o' } } },
        };
        for (const [name, document] of Object.entries(kept)) {
          assert.equal((await rows.explain(document)).mode, 'set', name);
          assert.deepEqual(await outcome(() => rows.execute(document)), await outcome(() => rows.execute(document, { pushdown: false })), name);
        }
      });
    });
  });
}

describe('an existence test beside a conjunct that runs as a registered function', () => {
  // the database may leave such a conjunct unevaluated on a row past the first, which the engine evaluates and
  // raises on: a count reads every row, a one-row probe does not, so the test stays in the engine
  const shape = { collection: 'c', schema: MODEL.collections.c.schema, columnByCanonical: new Map() };
  const udf = () => ({ name: 'registered_stub', key: 'stub' });
  const where = { $eq: [{ $upper: '$it.u' }, 'A'] };
  it('keeps the test in the engine under the reason that names the function, and the count native', () => {
    const exists = planQuery({ $exists: { $for: { it: '$[*]' }, $where: where, $return: '$it.id' } }, shape, { udf });
    assert.equal(exists.mode, 'set');
    assert.equal(reasonId(exists.reasons[0].reason), 'plan.registeredFunction');
    assert.equal(planQuery({ $count: { $for: { it: '$[*]' }, $where: where, $return: '$it.id' } }, shape, { udf }).mode, 'native');
    assert.equal(planQuery({ $exists: { $for: { it: '$[*]' }, $where: { $eq: ['$it.u', 'A'] }, $return: '$it.id' } }, shape, { udf }).mode, 'native');
  });
});

describe('a live query over an existence test', () => {
  // the test answers one boolean, which no row strategy maintains, however its phrase plans
  const shape = { collection: 'c', schema: MODEL.collections.c.schema, columnByCanonical: new Map() };
  it('re-runs', () => {
    for (const document of [TESTS.any, TESTS.seeks, { $exists: { $for: { it: '$[*]' }, $where: { $eq: [{ $upper: '$it.u' }, 'A'] }, $return: '$it' } }]) {
      assert.equal(classifyLiveQuery(document, shape, true).strategy, 'rerun', JSON.stringify(document));
    }
  });
});
