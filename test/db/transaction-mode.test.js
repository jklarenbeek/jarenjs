//@ts-check
/**
 * @file A root transaction's `mode` (MODEL-FORMAT §5.1): `'immediate'`
 * takes the write lock the moment the transaction begins — before any
 * statement — and commits or rolls back as a whole; the default stays
 * the deferred savepoint, which takes no lock until its first write; a
 * nested `tx.transaction()` is a savepoint under either; an unknown
 * mode is refused by name; a queued immediate transaction abandoned by
 * its signal never begins; and — the reason the mode exists — a
 * read-then-write body that races another connection's commit meets
 * the busy the handler cannot retry under the default, and simply waits
 * its turn under `'immediate'`. The lock is observed the way SQLite
 * exposes it: through what a second connection on the same file can do.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
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

/** A promise plus its resolver, for suspending a callback on demand. */
const defer = () => {
  /** @type {(v?: any) => void} */
  let resolve = () => {};
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

/** Two stores on one fresh file; `b` gives up on a lock quickly. */
async function pair() {
  const { dbPath, cleanup } = tempDbPath();
  const a = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, busyTimeout: 2000 });
  const b = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, busyTimeout: 100 });
  return {
    a,
    b,
    close: async () => {
      await a.close();
      await b.close();
      cleanup();
    },
  };
}

/** Whether a rejection is the classified busy, never a raw driver error. */
const busy = (/** @type {any} */ err) => typeof err.code === 'string' && err.code.startsWith('JD') && (err.class === 'busy' || /busy|locked/i.test(err.message));

describe("store.transaction(fn, { mode: 'immediate' })", () => {
  it('holds the write lock from the first instant — a second connection cannot write while the body has not written yet; the default takes none', async () => {
    const { a, b, close } = await pair();
    try {
      for (const mode of /** @type {const} */ (['immediate', 'deferred'])) {
        const started = defer();
        const proceed = defer();
        const held = a.transaction(async (tx) => {
          started.resolve();
          await proceed.promise;
          await tx.collection('docs').put({ id: `${mode}-1`, n: 1 }, `${mode}-1`);
          await tx.collection('docs').put({ id: `${mode}-2`, n: 2 }, `${mode}-2`);
        }, { mode });
        await started.promise;
        const other = await Promise.allSettled([b.collection('docs').put({ id: `${mode}-other`, n: 0 }, `${mode}-other`)]);
        if (mode === 'immediate') {
          assert.strictEqual(other[0].status, 'rejected', 'the lock is taken before any statement of the body');
          assert.ok(busy(/** @type {any} */ (other[0]).reason), 'classified busy, never raw');
        }
        else {
          assert.strictEqual(other[0].status, 'fulfilled', 'a deferred transaction that has not written holds no lock');
        }
        proceed.resolve();
        await held;
        assert.strictEqual((await b.collection('docs').get(`${mode}-1`))?.n, 1, 'committed as a whole');
        assert.strictEqual((await b.collection('docs').get(`${mode}-2`))?.n, 2);
      }
    }
    finally {
      await close();
    }
  });

  it('a throw rolls the whole immediate transaction back; a nested tx.transaction() is a savepoint whose rollback takes only its own writes', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await assert.rejects(store.transaction(async (tx) => {
      await tx.collection('docs').put({ id: 'a', n: 1 }, 'a');
      await tx.transaction(async (inner) => {
        await inner.collection('docs').put({ id: 'b', n: 2 }, 'b');
      });
      throw new Error('boom');
    }, { mode: 'immediate' }), /boom/);
    assert.strictEqual(await store.collection('docs').get('a'), undefined);
    assert.strictEqual(await store.collection('docs').get('b'), undefined);

    await store.transaction(async (tx) => {
      await tx.collection('docs').put({ id: 'a', n: 1 }, 'a');
      await assert.rejects(tx.transaction(async (inner) => {
        await inner.collection('docs').put({ id: 'b', n: 2 }, 'b');
        throw new Error('inner');
      }), /inner/);
      assert.strictEqual((await tx.collection('docs').get('a'))?.n, 1, 'the outer write survives the inner rollback');
      assert.strictEqual(await tx.collection('docs').get('b'), undefined);
    }, { mode: 'immediate' });
    assert.strictEqual((await store.collection('docs').get('a'))?.n, 1);
    assert.strictEqual(await store.collection('docs').get('b'), undefined);
    await store.close();
  });

  it('an unknown mode is refused by name before anything runs; the synchronous twin supports writer admission', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    let ran = false;
    await assert.rejects(store.transaction(async () => { ran = true; }, /** @type {any} */ ({ mode: 'exclusive' })),
      (/** @type {any} */ err) => err instanceof TypeError && /mode must be 'deferred' or 'immediate'/.test(err.message));
    assert.strictEqual(ran, false);
    assert.strictEqual(store.sync?.transaction.length, 2, 'sync.transaction(fn, options) accepts mode');
    await store.close();
  });

  it('a queued immediate transaction abandoned by its signal never begins (JD2064) and the owner runs on', async () => {
    const { a, b, close } = await pair();
    try {
      const gate = defer();
      const owner = a.transaction(async (tx) => {
        await tx.collection('docs').put({ id: 'a', n: 1 }, 'a');
        await gate.promise;
      });
      await new Promise((r) => setTimeout(r, 10));
      const controller = new AbortController();
      const queued = a.transaction(async () => { throw new Error('must not run'); }, { mode: 'immediate', signal: controller.signal });
      controller.abort();
      await assert.rejects(queued, (/** @type {any} */ err) => err.code === 'JD2064');
      // nothing began for the abandoned caller: the other connection still sees only the owner's lock — released here
      gate.resolve();
      await owner;
      assert.strictEqual((await b.collection('docs').get('a'))?.n, 1);
    }
    finally {
      await close();
    }
  });

  it('two connections: a read-then-write body under the default meets the busy the handler cannot retry; under immediate it waits its turn and both commit', async () => {
    const { a, b, close } = await pair();
    try {
      await a.collection('docs').put({ id: 'k', n: 0 }, 'k');
      /**
       * The claim shape on `a`: read, wait for the test, then write —
       * while `b` commits an immediate write in the gap.
       * @param {'deferred' | 'immediate'} mode
       */
      const race = async (mode) => {
        const read = defer();
        const proceed = defer();
        const first = a.transaction(async (tx) => {
          const row = await tx.collection('docs').get('k');
          read.resolve();
          await proceed.promise;
          await tx.collection('docs').put({ id: 'k', n: (row?.n ?? 0) + 1 }, 'k');
          return 'a';
        }, { mode });
        await read.promise;
        // the other connection's write: under `a`'s deferred read it begins
        // at once and commits, turning `a`'s upgrade into the unretryable
        // busy; under `a`'s immediate lock its BEGIN IMMEDIATE waits its turn
        const second = b.transaction(async (tx) => {
          await tx.collection('docs').put({ id: `other-${mode}`, n: 1 }, `other-${mode}`);
        }, { mode: 'immediate' });
        // the synchronous driver settles `second` before this turn ends:
        // observe both outcomes from here on, never as a late-handled rejection
        const outcomes = Promise.allSettled([first, second]);
        await new Promise((r) => setTimeout(r, 50));
        proceed.resolve();
        return outcomes;
      };

      const deferred = await race('deferred');
      assert.strictEqual(deferred[1].status, 'fulfilled', "the other connection's write commits at once");
      assert.strictEqual(deferred[0].status, 'rejected', 'the deferred read→write upgrade is the busy the handler cannot retry');
      assert.ok(busy(/** @type {any} */ (deferred[0]).reason), 'classified, never raw');
      assert.strictEqual((await a.collection('docs').get('k'))?.n, 0, 'nothing of the failed body landed');

      const immediate = await race('immediate');
      assert.strictEqual(immediate[0].status, 'fulfilled', 'the immediate body holds the lock through its read');
      assert.strictEqual(immediate[1].status, 'rejected', "`b` gave up inside its 100 ms busy timeout — it waited, it was not refused outright");
      assert.ok(busy(/** @type {any} */ (immediate[1]).reason));
      assert.strictEqual((await a.collection('docs').get('k'))?.n, 1, 'exactly one increment landed');
    }
    finally {
      await close();
    }
  });
});
