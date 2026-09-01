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
    assert.match(outcome.message, /the store or client the callback received/);
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

  it('concurrent_root_write_never_joins_awaited_transaction', async () => {
    // The guarantee: a store-level handle is, by construction, somebody
    // other than the open transaction. It holds the connection for its own
    // extent instead of falling inside a stranger's savepoint, so it
    // cannot share a rollback it knows nothing about — which is what let
    // a request-per-connection server share one store at all.
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const docs = store.collection('docs');
    const gate = defer();
    const doomed = settle(store.transaction(async (tx) => {
      await tx.collection('docs').put({ id: 'in-tx' }, 'in-tx');
      await gate.promise;
      throw new Error('abort');
    }));
    const bare = docs.put({ id: 'bare' }, 'bare');   // an unrelated caller
    gate.resolve();
    await doomed;
    await bare;
    assert.notStrictEqual(await docs.get('bare'), undefined,
      'the bare write waited for the transaction and kept its own fate');
    assert.strictEqual(await docs.get('in-tx'), undefined,
      'the transaction still took its own writes with it');
    await store.close();
  });

  it('outer_rollback_does_not_rollback_unrelated_write', async () => {
    // two overlapping writers on ONE store: the second is not a
    // transaction, so nothing above tells it apart except the gate
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const docs = store.collection('docs');
    const gate = defer();
    const doomed = settle(store.transaction(async (tx) => {
      await tx.collection('docs').put({ id: 'a' }, 'a');
      await tx.collection('docs').put({ id: 'b' }, 'b');
      await gate.promise;
      throw new Error('abort');
    }));
    const unrelated = Promise.all([
      docs.put({ id: 'c' }, 'c'),
      docs.insert({ id: 'd' }),
    ]);
    gate.resolve();
    await doomed;
    await unrelated;
    assert.deepStrictEqual(
      await Promise.all(['a', 'b', 'c', 'd'].map((id) => docs.get(id))),
      [undefined, undefined, { id: 'c' }, { id: 'd' }]);
    await store.close();
  });

  it('cancelled_queued_transaction_never_executes', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const docs = store.collection('docs');
    const gate = defer();
    const holder = settle(store.transaction(async () => {
      await gate.promise;
      return 'held';
    }));
    const controller = new AbortController();
    let ran = false;
    const queued = settle(store.transaction(async (tx) => {
      ran = true;
      await tx.collection('docs').put({ id: 'never' }, 'never');
    }, { signal: controller.signal }));
    controller.abort();
    const outcome = await queued;
    assert.strictEqual(ran, false, 'the callback never started');
    assert.strictEqual(outcome.code, 'JD2064');
    gate.resolve();
    assert.deepStrictEqual(await holder, { value: 'held' });
    assert.strictEqual(await docs.get('never'), undefined);
    await store.close();
  });

  it('root_client_call_awaited_from_its_own_transaction_fails_coded_instead_of_deadlocking',
    async () => {
      const store = await openStore(MODEL,
        { driver: nodeDriver(), queueTimeout: 40 });
      const docs = store.collection('docs');
      const started = Date.now();
      const outcome = await settle(store.transaction(async (tx) => {
        await tx.collection('docs').put({ id: 'owned' }, 'owned');
        // the mistake: the STORE's handle, awaited from inside the
        // transaction that owns the connection — it waits for itself
        await docs.put({ id: 'self' }, 'self');
      }));
      assert.strictEqual(outcome.code, 'JD0012');
      assert.match(outcome.message, /tx\.collection/,
        'the refusal names the spelling that would have worked');
      assert.ok(Date.now() - started < 2000, 'bounded by queueTimeout, never a hang');
      await store.close();
    });

  it("transactions: 'strict' refuses a contended root call instead of waiting", async () => {
    const store = await openStore(MODEL,
      { driver: nodeDriver(), transactions: 'strict' });
    const docs = store.collection('docs');
    const gate = defer();
    const holder = settle(store.transaction(async () => {
      await gate.promise;
      return 'held';
    }));
    const started = Date.now();
    const refused = await settle(docs.put({ id: 'contended' }, 'contended'));
    assert.strictEqual(refused.code, 'JD0012');
    assert.match(refused.message, /strict/);
    assert.ok(Date.now() - started < 1000, 'refused at once, never queued');
    gate.resolve();
    assert.deepStrictEqual(await holder, { value: 'held' });
    // and with nothing open it is an ordinary write
    assert.strictEqual(await docs.put({ id: 'free' }, 'free'), 'free');
    await store.close();
  });

  it("an unknown transactions mode is API misuse, named", async () => {
    await assert.rejects(
      () => openStore(MODEL, { driver: nodeDriver(), transactions: 'queue' }),
      /transactions must be 'wait' or 'strict'/);
  });
});

/** A model with entities, so the scope-bound store has a unit of work and
 * a multi-entity provider root to answer for. */
const ENTITY_MODEL = {
  $model: '0.1',
  entities: {
    Note: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          stars: { type: 'integer' },
        },
      },
    },
  },
};

describe('the store a transaction callback receives carries the whole surface', () => {
  it('its entity, unit of work and provider members all run as the owner', async () => {
    const store = await openStore(ENTITY_MODEL, { driver: nodeDriver() });
    await store.entity('Note').create({ id: 'n1', stars: 1 });
    const document = { $for: { n: '$.Note[*]' }, $orderby: ['$n.id'], $return: '$n.id' };

    const inside = await store.transaction(async (tx) => {
      const notes = tx.entity('Note');
      notes.add({ id: 'n2', stars: 5 });
      const report = await tx.saveChanges();
      assert.strictEqual(report.inserted, 1);
      // the provider members answer for the transaction's own rows
      assert.deepStrictEqual(await tx.execute(document), ['n1', 'n2']);
      assert.strictEqual(typeof (await tx.explain(document)), 'object');
      assert.strictEqual(typeof await tx.dataVersion(), 'number');
      // and so does the synchronous twin, bound to the same scope
      tx.sync.entity('Note').add({ id: 'n3', stars: 9 });
      assert.strictEqual(tx.sync.saveChanges().inserted, 1);
      assert.deepStrictEqual(tx.sync.execute(document), ['n1', 'n2', 'n3']);
      assert.strictEqual(typeof tx.sync.explain(document), 'object');
      assert.strictEqual(tx.sync.collection === undefined, false);
      return 'kept';
    });
    assert.strictEqual(inside, 'kept');
    assert.deepStrictEqual(await store.execute(document), ['n1', 'n2', 'n3']);
    await store.close();
  });

  it('a rollback takes every one of them with it', async () => {
    const store = await openStore(ENTITY_MODEL, { driver: nodeDriver() });
    await store.entity('Note').create({ id: 'n1', stars: 1 });
    await store.entity('Note').create({ id: 'n2', stars: 2 });
    await assert.rejects(() => store.transaction(async (tx) => {
      tx.entity('Note').add({ id: 'doomed', stars: 3 });
      await tx.saveChanges();
      tx.sync.entity('Note').add({ id: 'doomed-sync', stars: 4 });
      tx.sync.saveChanges();
      throw new Error('abort');
    }), /abort/);
    const document = { $for: { n: '$.Note[*]' }, $orderby: ['$n.id'], $return: '$n.id' };
    assert.deepStrictEqual(await store.execute(document), ['n1', 'n2']);
    await store.close();
  });

  it('the synchronous store-level surface refuses while a transaction is open', async () => {
    const store = await openStore(ENTITY_MODEL, { driver: nodeDriver() });
    await store.entity('Note').create({ id: 'n1', stars: 1 });
    const gate = defer();
    const holder = settle(store.transaction(async () => {
      await gate.promise;
      return 'held';
    }));
    // it answers VALUES, so it cannot queue — waiting would hand a
    // Promise back under a value's type
    const document = { $for: { n: '$.Note[*]' }, $return: '$n.id' };
    for (const call of [
      () => store.sync.entity('Note').get('n1'),
      () => store.sync.saveChanges(),
      () => store.sync.execute(document),
      () => store.sync.explain(document),
    ]) assert.throws(call, (error) => /** @type {any} */ (error).code === 'JD0012');
    gate.resolve();
    assert.deepStrictEqual(await holder, { value: 'held' });
    // free again, the same calls answer values
    assert.deepStrictEqual(store.sync.entity('Note').get('n1'), { id: 'n1', stars: 1 });
    assert.strictEqual(store.sync.saveChanges().statements.length, 0);
    assert.strictEqual(store.sync.execute(document), 'n1');
    assert.strictEqual(store.sync.entity('Note').load().length, 1);
    assert.strictEqual(typeof store.sync.explain(document), 'object');
    await store.close();
  });
});
