//@ts-check
/**
 * @file A transaction's isolation is a FLOOR (MODEL-FORMAT §5.1): the
 * store's `isolation` sets the default of every `store.transaction`, a
 * call's own `isolation` overrides it, and the backend runs the level
 * asked for or a stronger one and reports the level it ran — as
 * `tx.isolation`, and the levels it can run as `capabilities.isolation`.
 * SQLite runs every transaction serializably, so it accepts any floor
 * and reports `serializable` for every request. A malformed level is
 * refused before anything runs — `JD0013` on a transaction, `JD0009` on
 * the open (before a file exists) — and a nested transaction, which is a
 * savepoint of its root, refuses one (`JD0014`). The PostgreSQL half,
 * which actually runs the three levels, is `postgres-isolation.test.js`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { open } from '@jarenjs/linq/db';
import { tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    docs: {
      schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' } }, required: ['id'] },
      key: '/id',
      indexes: [],
    },
  },
};

const LEVELS = /** @type {const} */ (['read committed', 'repeatable read', 'serializable']);

/** @param {string} code */
const coded = (code) => (/** @type {any} */ error) => error?.code === code;

describe('SQLite runs every transaction serializably, and says so', () => {
  it('capabilities: the writer lock is taken up front, and serializable is the one level', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    try {
      assert.strictEqual(store.capabilities.immediateTransactions, true);
      assert.deepStrictEqual([...store.capabilities.isolation], ['serializable']);
      assert.ok(Object.isFrozen(store.capabilities.isolation));
    }
    finally { await store.close(); }
  });

  it('tx.isolation is serializable whatever was asked, on every surface', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    try {
      assert.strictEqual(await store.transaction(async (tx) => tx.isolation), 'serializable');
      for (const isolation of LEVELS) {
        for (const mode of /** @type {const} */ (['deferred', 'immediate'])) {
          const seen = await store.transaction(async (tx) => {
            await tx.collection('docs').put({ id: `${isolation}-${mode}`, n: 1 }, `${isolation}-${mode}`);
            // a nested savepoint runs in its root's transaction, at its level
            const nested = await tx.transaction(async (inner) => inner.isolation);
            return [tx.isolation, nested, tx.sync?.isolation];
          }, { isolation, mode });
          assert.deepStrictEqual(seen, ['serializable', 'serializable', 'serializable'], `${isolation} ${mode}`);
        }
        assert.strictEqual(store.sync?.transaction((tx) => tx.isolation, { isolation }), 'serializable');
      }
      assert.strictEqual((await store.collection('docs').get('serializable-immediate'))?.n, 1);
    }
    finally { await store.close(); }
  });

  it("the store's isolation is the default: accepted, and still serializable", async () => {
    for (const isolation of LEVELS) {
      const store = await openStore(MODEL, { driver: nodeDriver(), isolation });
      try {
        assert.strictEqual(await store.transaction(async (tx) => tx.isolation), 'serializable');
        assert.strictEqual(await store.transaction(async (tx) => tx.isolation, { isolation: 'read committed' }), 'serializable');
      }
      finally { await store.close(); }
    }
  });

  it('the typed client forwards isolation and reports tx.isolation', async () => {
    const client = await open(MODEL, { driver: nodeDriver(), validator: null, isolation: 'repeatable read' });
    try {
      assert.deepStrictEqual([...client.capabilities.isolation], ['serializable']);
      assert.strictEqual(await client.transaction(async (tx) => tx.isolation), 'serializable');
      assert.strictEqual(await client.transaction(async (tx) => tx.isolation, { isolation: 'serializable' }), 'serializable');
      await assert.rejects(client.transaction(async () => {}, /** @type {any} */ ({ isolation: 'snapshot' })), coded('JD0013'));
    }
    finally { await client.close(); }
  });
});

describe('a malformed or misplaced isolation is refused before anything runs', () => {
  it('a transaction: JD0013 for a value outside the three levels, on every root surface', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    let ran = 0;
    try {
      for (const isolation of ['snapshot', 'SERIALIZABLE', 'read uncommitted', '', 1, null, ['serializable']]) {
        await assert.rejects(store.transaction(async () => { ran++; }, /** @type {any} */ ({ isolation })),
          (/** @type {any} */ error) => error.code === 'JD0013' && /isolation must be/.test(error.message),
          `store.transaction isolation ${JSON.stringify(isolation)}`);
        assert.throws(() => store.sync?.transaction(() => { ran++; }, /** @type {any} */ ({ isolation })), coded('JD0013'),
          `store.sync.transaction isolation ${JSON.stringify(isolation)}`);
      }
      assert.strictEqual(ran, 0);
    }
    finally { await store.close(); }
  });

  it('a nested transaction: JD0014 — a savepoint runs at its root level', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    let ran = 0;
    try {
      await store.transaction(async (tx) => {
        for (const isolation of LEVELS) {
          await assert.rejects(tx.transaction(async () => { ran++; }, { isolation }),
            (/** @type {any} */ error) => error.code === 'JD0014' && /isolation cannot act on a nested transaction/.test(error.message));
          assert.throws(() => tx.sync?.transaction(() => { ran++; }, /** @type {any} */ ({ isolation })), coded('JD0014'));
        }
      });
      // called from inside a synchronous body, store.sync.transaction IS nested
      store.sync?.transaction(() => {
        assert.throws(() => store.sync?.transaction(() => { ran++; }, { isolation: 'serializable' }), coded('JD0014'));
      });
      assert.strictEqual(ran, 0);
    }
    finally { await store.close(); }
  });

  it('the open: JD0009 for a malformed store isolation, before the driver opens a file', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      for (const isolation of ['snapshot', 'Serializable', 1, null, {}]) {
        await assert.rejects(openStore(MODEL, { driver: nodeDriver(), path: dbPath, isolation: /** @type {any} */ (isolation) }),
          (/** @type {any} */ error) => error.code === 'JD0009' && /isolation/.test(error.message),
          `isolation ${JSON.stringify(isolation)}`);
        assert.strictEqual(fs.existsSync(dbPath), false, 'refused before a file was created');
      }
      await assert.rejects(openStore(MODEL, /** @type {any} */ ({ driver: nodeDriver(), path: dbPath, isolaton: 'serializable' })),
        (/** @type {any} */ error) => error.code === 'JD0009' && /'isolation'/.test(error.message), 'the nearest member is named');
    }
    finally { cleanup(); }
  });
});
