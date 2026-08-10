//@ts-check
/**
 * @file Transaction OWNERSHIP on one connection.
 *
 * A SQLite connection holds one savepoint stack, so two transactions that
 * overlap in time cannot both be correct: `RELEASE` discards everything
 * opened after its target, so whichever finished first took the other's
 * savepoint with it — and the second then failed with "no such savepoint"
 * over rows it had already committed. A commit reporting failure is the
 * worst outcome a store can produce, so a top-level transaction now holds
 * the connection until it settles and an overlapping one waits.
 *
 * Nesting still works, and the two ways to ask for it are the point:
 * synchronous code nests implicitly (nothing can interleave while it is on
 * the stack), while an async callback — which has already awaited — nests
 * through the scope it was handed.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = {
  $model: '0.1',
  collections: {
    docs: {
      schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
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

const settle = (p) => Promise.resolve(p).then(
  (value) => ({ value }), (error) => ({ code: error.code, message: error.message }));

describe('concurrent transactions on one connection', () => {
  it('overlapping transactions both commit and both report success', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const docs = store.collection('docs');
    const first = defer();
    const second = defer();

    const a = settle(store.transaction(async () => {
      await docs.put({ id: 'a' }, 'a');
      await first.promise;
      return 'a-done';
    }));
    const b = settle(store.transaction(async () => {
      await docs.put({ id: 'b' }, 'b');
      await second.promise;
      return 'b-done';
    }));
    // release the FIRST one first: the order that used to break the stack
    first.resolve();
    const aOut = await a;
    second.resolve();
    const bOut = await b;

    assert.deepStrictEqual(aOut, { value: 'a-done' });
    assert.deepStrictEqual(bOut, { value: 'b-done' },
      'a committed transaction must never report a savepoint error');
    assert.notStrictEqual(await docs.get('a'), undefined);
    assert.notStrictEqual(await docs.get('b'), undefined);
    await store.close();
  });

  it('a rolled-back transaction takes only its own writes', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const docs = store.collection('docs');
    const gate = defer();

    const doomed = settle(store.transaction(async () => {
      await docs.put({ id: 'doomed' }, 'doomed');
      await gate.promise;
      throw new Error('abort');
    }));
    // an independent transaction queued behind it
    const survivor = settle(store.transaction(async () => {
      await docs.put({ id: 'survivor' }, 'survivor');
      return 'kept';
    }));
    gate.resolve();
    assert.strictEqual((await doomed).message, 'abort');
    assert.deepStrictEqual(await survivor, { value: 'kept' });

    assert.strictEqual(await docs.get('doomed'), undefined);
    assert.notStrictEqual(await docs.get('survivor'), undefined,
      'the queued transaction is not inside the rolled-back one');
    await store.close();
  });

  it('an async callback nests through the store it RECEIVED', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const docs = store.collection('docs');
    const out = await store.transaction(async (tx) => {
      await docs.put({ id: 'outer' }, 'outer');
      try {
        await tx.transaction(async () => {
          await docs.put({ id: 'inner' }, 'inner');
          throw new Error('inner boom');
        });
      }
      catch (error) {
        assert.strictEqual(/** @type {Error} */ (error).message, 'inner boom');
      }
      return 'outer-kept';
    });
    assert.strictEqual(out, 'outer-kept');
    assert.notStrictEqual(await docs.get('outer'), undefined);
    assert.strictEqual(await docs.get('inner'), undefined,
      'exactly one level rolled back');
    await store.close();
  });

  it('reaching back through the OUTER store is JD0012, not a hang', async () => {
    const store = await openStore(MODEL,
      { driver: nodeDriver(), queueTimeout: 40 });
    const docs = store.collection('docs');
    const outcome = await settle(store.transaction(async () => {
      await docs.put({ id: 'outer' }, 'outer');
      // the mistake: an async nested transaction asked of the outer store,
      // which cannot tell it from an unrelated caller — so it waits for
      // the transaction it is part of
      await store.transaction(async () => {});
    }));
    assert.strictEqual(outcome.code, 'JD0012');
    assert.match(outcome.message, /scope the callback received/);
    await store.close();
  });

  it('synchronous nesting needs no scope — nothing can interleave', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const sync = store.sync;
    const out = sync.transaction(() => {
      sync.collection('docs').put({ id: 'outer' }, 'outer');
      try {
        sync.transaction(() => {
          sync.collection('docs').put({ id: 'inner' }, 'inner');
          throw new Error('inner boom');
        });
      }
      catch (error) {
        assert.strictEqual(/** @type {Error} */ (error).message, 'inner boom');
      }
      return 'kept';
    });
    assert.strictEqual(out, 'kept');
    assert.notStrictEqual(sync.collection('docs').get('outer'), undefined);
    assert.strictEqual(sync.collection('docs').get('inner'), undefined);
    await store.close();
  });

  it('a bare statement issued while a transaction is open JOINS it', async () => {
    // The documented residual of one shared connection: SQLite has no
    // per-statement transaction scope, so a write that is not part of the
    // transaction cannot be told apart from one that is, and it shares the
    // transaction's fate. Give each concurrent writer its own store.
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const docs = store.collection('docs');
    const gate = defer();
    const doomed = settle(store.transaction(async () => {
      await docs.put({ id: 'in-tx' }, 'in-tx');
      await gate.promise;
      throw new Error('abort');
    }));
    await docs.put({ id: 'bare' }, 'bare');   // not part of the transaction
    gate.resolve();
    await doomed;
    assert.strictEqual(await docs.get('bare'), undefined,
      'pinned, not endorsed: the bare write shared the rollback');
    await store.close();
  });
});
