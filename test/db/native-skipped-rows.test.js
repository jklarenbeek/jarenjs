//@ts-check
/**
 * @file A named deviation (NATIVE-PLANS, "Named deviations"): a native count
 * or window over a constructor the schema proves cannot raise never
 * evaluates the rows it skips. On a store with no validation hook a row the
 * schema forbids can sit among them, and the native plan answers where the
 * engine (`pushdown: false`) raises `JQ2001` on that row; a store that
 * validates its writes cannot hold such a row, and there the two agree. A
 * store run is SQLite always, PostgreSQL where JAREN_PG_URL names a server.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
const UPPER = { k: { $upper: '$it.u' } };
const COUNT = { $count: { $for: { it: '$[*]' }, $return: UPPER } };
const WINDOW = { $subsequence: [{ $for: { it: '$[*]' }, $orderby: ['$it.o'], $return: UPPER }, 0, 1] };
/** A validation hook that refuses a non-string `u`, as a schema validator would. */
const compileSchema = () => (/** @type {any} */ doc) => doc.u === undefined || typeof doc.u === 'string';

/** What a call answers, or the code it raises. @param {() => any} call */
async function outcome(call) {
  try { return await call(); }
  catch (error) { return /** @type {any} */ (error).code; }
}

for (const engine of ENGINES) {
  describe(`a native count or window over a constructor that cannot raise, ${engine}`, { skip: skipFor(engine) }, () => {
    it('on a store that validates nothing, never evaluates the forbidden row it skips', async () => {
      await withStore(engine, MODEL, async (store) => {
        const rows = store.collection('c');
        for (const doc of [{ id: 'a', o: 1, u: 'x' }, { id: 'b', o: 2, u: 5 }, { id: 'c', o: 3, u: 'y' }]) await rows.insert(doc);
        // the count reads no row; the window's statement stops once it is full
        assert.deepEqual(await Promise.all([COUNT, WINDOW].map(async (document) => (await rows.explain(document)).mode)), ['native', 'row']);
        assert.deepEqual(await Promise.all([COUNT, WINDOW].map((document) => outcome(() => rows.execute(document)))), [3, { k: 'X' }]);
        assert.deepEqual(await Promise.all([COUNT, WINDOW].map((document) => outcome(() => rows.execute(document, { pushdown: false })))),
          ['JQ2001', 'JQ2001']);
      });
    });

    it('on a store that validates its writes, answers as the engine', async () => {
      await withStore(engine, MODEL, async (store) => {
        const rows = store.collection('c');
        for (const doc of [{ id: 'a', o: 1, u: 'x' }, { id: 'c', o: 3, u: 'y' }]) await rows.insert(doc);
        assert.equal(await outcome(() => rows.insert({ id: 'b', o: 2, u: 5 })), 'JD2003');
        for (const document of [COUNT, WINDOW]) {
          assert.deepEqual(await rows.execute(document), await rows.execute(document, { pushdown: false }));
        }
        assert.deepEqual(await Promise.all([COUNT, WINDOW].map((document) => rows.execute(document))), [2, { k: 'X' }]);
      }, { compileSchema });
    });
  });
}
