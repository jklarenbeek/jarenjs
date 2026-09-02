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
import * as fs from 'node:fs';

import { openStore, createCursor } from '@jarenjs/db';
import { admitCursor } from '../../packages/db/src/cursor.js';
import { nodeDriver } from '@jarenjs/db/node';
import { createRuntime } from '@jarenjs/core/runtime';
import { statementCountingDriver } from './helpers.js';

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
      // the untracked door is scope-bound too, async and sync alike
      assert.deepStrictEqual(await notes.asNoTracking().get('n1'), { id: 'n1', stars: 1 });
      assert.deepStrictEqual(tx.sync.entity('Note').asNoTracking().get('n1'),
        { id: 'n1', stars: 1 });
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

  it('a transaction view exposes no close, at runtime — the root owns the connection', async () => {
    // C9: `tx.close()` used to close the raw connection mid-savepoint and
    // leak raw ERR_INVALID_STATE from settlement. The member is ABSENT
    // rather than a second way to close.
    const store = await openStore(ENTITY_MODEL, { driver: nodeDriver() });
    const out = await store.transaction(async (tx) => {
      assert.strictEqual(tx.close, undefined);
      await tx.entity('Note').create({ id: 'kept', stars: 1 });
      return 'settled-normally';
    });
    assert.strictEqual(out, 'settled-normally');
    assert.deepStrictEqual(await store.entity('Note').asNoTracking().get('kept'),
      { id: 'kept', stars: 1 });
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

describe('a transaction handle is pinned to its exact scope (JD2070)', () => {
  const isScopeRefusal = (outcome) => {
    assert.strictEqual(outcome.code, 'JD2070');
    assert.match(outcome.message, /LIVE transaction callback/);
  };

  it('settled_transaction_handle_cannot_join_a_later_transaction', async () => {
    // C1: at v0.57.0 a retained handle followed whatever scope was
    // current later, and its write shared the later owner's rollback
    const store = await openStore(MODEL, { driver: nodeDriver() });
    /** @type {any} */
    let retained;
    /** @type {any} */
    let retainedTx;
    await store.transaction(async (tx) => {
      retained = tx.collection('docs');
      retainedTx = tx;
      await retained.put({ id: 'first' }, 'first');
    });
    // every stateful member of the settled view refuses before a statement
    isScopeRefusal(await settle(retained.put({ id: 'escaped' }, 'escaped')));
    isScopeRefusal(await settle(retained.get('first')));
    isScopeRefusal(await settle(retainedTx.transaction(async () => {})));
    isScopeRefusal(await settle(retainedTx.dataVersion()));
    assert.throws(() => retainedTx.sync.collection('docs').put({ id: 's' }, 's'),
      (error) => /** @type {any} */ (error).code === 'JD2070');

    // the later transaction: its own row rolls back, the escaped
    // handle's work never ran, so the rollback cannot take it
    const out = await settle(store.transaction(async (tx) => {
      await tx.collection('docs').put({ id: 'owner' }, 'owner');
      await retained.put({ id: 'escaped' }, 'escaped');
      throw new Error('unreached');
    }));
    isScopeRefusal(out);
    assert.strictEqual(await store.collection('docs').get('owner'), undefined,
      'the later owner rolled back its own write');
    assert.strictEqual(await store.collection('docs').get('escaped'), undefined,
      'the escaped write never ran at all');
    assert.deepStrictEqual(await store.collection('docs').get('first'), { id: 'first' },
      'the settled transaction kept its own commit');
    await store.close();
  });

  it('a retained entity handle cannot smuggle pending work into a later scope', async () => {
    const store = await openStore(ENTITY_MODEL, { driver: nodeDriver() });
    /** @type {any} */
    let notes;
    /** @type {any} */
    let retainedTx;
    await store.transaction(async (tx) => {
      notes = tx.entity('Note');
      retainedTx = tx;
      await tx.saveChanges();
    }, { unitOfWork: 'own' });
    // local unit-of-work bookkeeping carries the identity too: add()
    // on a settled handle is JD2070, never a document staged into
    // whatever unit of work is in force later
    assert.throws(() => notes.add({ id: 'smuggled', stars: 1 }),
      (error) => /** @type {any} */ (error).code === 'JD2070');
    isScopeRefusal(await settle(retainedTx.saveChanges()));
    isScopeRefusal(await settle(notes.create({ id: 'direct', stars: 1 })));

    const report = await store.transaction(async (tx) => {
      await tx.saveChanges();
      return tx.stats().tracker;
    }, { unitOfWork: 'own' });
    assert.strictEqual(report.pendingInserts, 0,
      'the later own unit of work holds nothing the retained handle staged');
    assert.deepStrictEqual(await store.entity('Note').asNoTracking().load(), []);
    await store.close();
  });

  it('root stats report rootWork while tx stats report the exact scope, own unit open', async () => {
    const store = await openStore(ENTITY_MODEL, { driver: nodeDriver() });
    store.entity('Note').add({ id: 'root-pending', stars: 0 });
    await store.transaction(async (tx) => {
      tx.entity('Note').add({ id: 'tx-pending', stars: 1 });
      tx.entity('Note').add({ id: 'tx-pending-2', stars: 2 });
      assert.strictEqual(tx.stats().tracker.pendingInserts, 2,
        "the view's stats are its exact scope's unit of work");
      assert.strictEqual(store.stats().tracker.pendingInserts, 1,
        'root stats stay the root tracker while the own-unit scope is current');
    }, { unitOfWork: 'own' });
    assert.strictEqual(store.stats().tracker.pendingInserts, 1,
      'nothing changed merely because a scope opened and settled');
    await store.close();
  });

  it('a root entity handle first constructed inside an own-unit transaction binds rootWork', async () => {
    const store = await openStore(ENTITY_MODEL, { driver: nodeDriver() });
    await store.transaction(async (tx) => {
      // FIRST construction of both root handles, while the own-unit
      // scope is current: the local bookkeeping goes to the ROOT
      // tracker, never to this transaction's
      store.entity('Note').add({ id: 'root-staged', stars: 5 });
      store.sync.entity('Note').add({ id: 'root-staged-sync', stars: 6 });
      assert.strictEqual(tx.stats().tracker.pendingInserts, 0,
        "the transaction's own unit of work saw neither");
      await tx.entity('Note').create({ id: 'tx-own', stars: 1 });
    }, { unitOfWork: 'own' });
    const report = await store.saveChanges();
    assert.strictEqual(report.inserted, 2, 'the root save writes both staged documents once');
    assert.deepStrictEqual(
      (await store.entity('Note').asNoTracking().load()).map((note) => note.id).sort(),
      ['root-staged', 'root-staged-sync', 'tx-own']);
    await store.close();
  });

  it('an_outer_handle_cannot_fall_into_an_async_inner_savepoint', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await store.transaction(async (tx) => {
      await tx.collection('docs').put({ id: 'outer' }, 'outer');
      const inner = await settle(tx.transaction(async (nested) => {
        await nested.collection('docs').put({ id: 'inner' }, 'inner');
        // the OUTER view while the inner scope is current: JD2070, so
        // the outer handle can never write inside the inner savepoint
        isScopeRefusal(await settle(tx.collection('docs').put({ id: 'fell-in' }, 'fell-in')));
        throw new Error('inner rollback');
      }));
      assert.strictEqual(inner.message, 'inner rollback');
      // back in the outer scope the same handle works again
      await tx.collection('docs').put({ id: 'outer-2' }, 'outer-2');
    });
    assert.deepStrictEqual(
      await Promise.all(['outer', 'inner', 'fell-in', 'outer-2']
        .map((id) => store.collection('docs').get(id))),
      [{ id: 'outer' }, undefined, undefined, { id: 'outer-2' }],
      'exactly the inner rows rolled back; the refused write never ran');
    await store.close();
  });

  it('a lazy query cursor can neither begin nor continue outside its exact scope', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    /** @type {any} */
    let begun;
    /** @type {any} */
    let unbegun;
    await store.transaction(async (tx) => {
      await tx.collection('docs').put({ id: 'a', n: 1 }, 'a');
      await tx.collection('docs').put({ id: 'b', n: 2 }, 'b');
      const document = { $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it.id' };
      // a full for-await inside the scope walks the wrapped cursor
      const walked = [];
      for await (const id of tx.collection('docs').query(document)) walked.push(id);
      assert.deepStrictEqual(walked, ['a', 'b']);
      begun = tx.collection('docs').query(document);
      assert.deepStrictEqual(await begun.next(), { value: 'a', done: false },
        'iteration inside the scope works');
      unbegun = tx.collection('docs').query(document);
    });
    isScopeRefusal(await settle(begun.next()));
    isScopeRefusal(await settle(unbegun.next()));
    await store.close();
  });
});

/**
 * The model the root-cursor admission tests read through: a collection
 * and an entity with a to-many relation, so the three root cursor
 * surfaces — a collection's `query`, an entity set's `cursor` and its
 * graph `loadCursor` — are all exercised.
 */
const ROOTS = {
  $model: '0.1',
  collections: {
    docs: {
      schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      key: '/id',
      indexes: [],
    },
  },
  entities: {
    Item: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'integer', 'x-entity': { key: true } },
          tag: { type: 'string' },
        },
      },
    },
  },
};

/** Whether a promise has settled within a short grace period. */
const settledWithin = (promise, ms = 25) => Promise.race([
  Promise.resolve(promise).then(() => true, () => true),
  new Promise((resolve) => setTimeout(() => resolve(false), ms)),
]);

/** A mutable clock. */
function clockAt(start) {
  let at = start;
  const now = () => at;
  now.advance = (ms) => { at += ms; };
  return now;
}

describe('root cursors borrow admission per pull (MODEL-FORMAT §5.1)', () => {
  // a bare binding streams one row per pull; a projection would buffer (a barrier)
  const ITEMS = { $for: { it: '$.Item[*]' }, $orderby: ['$it.id'], $return: '$it' };
  const DOCS = { $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it.id' };

  /** Open a seeded store and expose the three root cursors as openers. */
  async function seeded(options = {}) {
    const counters = { iterate: 0, next: 0, return: 0, all: 0 };
    const store = await openStore(ROOTS, { driver: statementCountingDriver(counters), ...options });
    await store.transaction(async (tx) => {
      await tx.collection('docs').put({ id: 'a' }, 'a');
      await tx.collection('docs').put({ id: 'b' }, 'b');
      await tx.entity('Item').create({ id: 1, tag: 'x' });
      await tx.entity('Item').create({ id: 2, tag: 'y' });
    });
    for (const key of Object.keys(counters)) counters[key] = 0;
    const openers = {
      query: (o) => store.collection('docs').query(DOCS, o),
      cursor: (o) => store.entity('Item').cursor(ITEMS, o),
      loadCursor: (o) => store.entity('Item').loadCursor({ orderBy: '$it.id' }, o),
    };
    return { store, counters, openers };
  }
  const drain = async (cursor) => {
    const out = [];
    for await (const item of cursor) out.push(typeof item === 'object' ? item.id : item);
    return out;
  };

  it('a pull made while a transaction is open waits, then reads the committed state — and never a rolled-back row', async () => {
    const { store, openers } = await seeded();
    for (const [surface, open] of Object.entries(openers)) {
      for (const outcome of ['commit', 'rollback']) {
        const hold = defer();
        const tx = settle(store.transaction(async (t) => {
          await t.collection('docs').put({ id: 'staged' }, 'staged');
          await t.entity('Item').create({ id: 9, tag: 'staged' });
          await hold.promise;
          if (outcome === 'rollback') throw new Error('undo');
        }));
        // wait until the transaction owns the connection
        await new Promise((resolve) => setTimeout(resolve, 5));
        const cursor = open();
        const first = cursor.next();
        assert.strictEqual(await settledWithin(first), false, `${surface}/${outcome}: the pull waits for the open transaction`);
        hold.resolve();
        await tx;
        const items = [(await first).value, ...(await drain(cursor))];
        const ids = items.map((item) => (typeof item === 'object' ? item.id : item));
        if (outcome === 'commit') assert.ok(ids.some((id) => id === 9 || id === 'staged'), `${surface}: the committed row is read (${JSON.stringify(ids)})`);
        else assert.ok(!ids.some((id) => id === 9 || id === 'staged'), `${surface}: a rolled-back row is never read (${JSON.stringify(ids)})`);
        // clean the committed rows for the next round
        if (outcome === 'commit') {
          await store.collection('docs').delete('staged');
          await store.entity('Item').delete(9);
        }
      }
    }
    await store.close();
  });

  it('a consumer paused between pulls blocks no unrelated transaction', async () => {
    const { store, openers } = await seeded();
    for (const open of Object.values(openers)) {
      const cursor = open();
      assert.strictEqual((await cursor.next()).done, false, 'one item consumed; the statement is open');
      // the unrelated transaction must not wait for the paused consumer:
      // under a held gate this would queue until JD0012 (5 s)
      const started = Date.now();
      await store.transaction(async (t) => {
        await t.collection('docs').put({ id: 'between' }, 'between');
      });
      assert.ok(Date.now() - started < 1000, 'the transaction ran while the cursor was paused');
      assert.notStrictEqual(await store.collection('docs').get('between'), undefined);
      assert.strictEqual((await cursor.next()).done, false, 'the paused cursor continues afterwards');
      await cursor.return();
      await store.collection('docs').delete('between');
    }
    await store.close();
  });

  it('queued abort is JD2064, row-boundary abort is JD2072, a passed deadline is JD2075; the source is released once', async () => {
    const now = clockAt(1_000);
    const { store, counters, openers } = await seeded({ runtime: createRuntime({ now }) });
    for (const open of Object.values(openers)) {
      // queued: the transaction owns the connection, the pull waits, the abort leaves the queue
      const hold = defer();
      const tx = store.transaction(async () => { await hold.promise; });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const controller = new AbortController();
      const queued = open({ signal: controller.signal });
      const pull = settle(queued.next());
      controller.abort(new Error('gave up waiting'));
      const refusal = await pull;
      assert.strictEqual(refusal.code, 'JD2064', `${refusal.message}`);
      hold.resolve();
      await tx;
      // the same cursor afterwards: aborted at construction level, so JD2072, no statement
      const before = counters.iterate;
      assert.strictEqual((await settle(queued.next())).code, 'JD2072');
      assert.strictEqual(counters.iterate, before, 'an aborted cursor opens no statement');

      // row boundary: one row pulled, then aborted — released exactly once
      const boundary = new AbortController();
      const active = open({ signal: boundary.signal });
      assert.strictEqual((await active.next()).done, false);
      const returns = counters.return;
      boundary.abort();
      assert.strictEqual((await settle(active.next())).code, 'JD2072');
      assert.strictEqual((await settle(active.next())).code, 'JD2072');
      await active.return();
      assert.strictEqual(counters.return, returns + 1, 'released once, at the row boundary');

      // deadline against the record's clock
      const timed = open({ deadline: now() + 10 });
      assert.strictEqual((await timed.next()).done, false);
      now.advance(11);
      const late = await settle(timed.next());
      assert.strictEqual(late.code, 'JD2075');
      assert.match(late.message, /before the next row/);
    }
    await store.close();
  });

  it('return() is admitted like a pull and releases the source exactly once; a never-pulled cursor releases nothing', async () => {
    const { store, counters, openers } = await seeded();
    for (const open of Object.values(openers)) {
      const cursor = open();
      assert.strictEqual((await cursor.next()).done, false);
      const hold = defer();
      const tx = store.transaction(async () => { await hold.promise; });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const returning = cursor.return();
      assert.strictEqual(await settledWithin(returning), false, 'the release waits for the open transaction');
      const returns = counters.return;
      hold.resolve();
      await tx;
      assert.deepStrictEqual(await returning, { done: true, value: undefined });
      await cursor.return();
      assert.strictEqual(counters.return, returns + 1, 'the underlying return ran once');
      assert.deepStrictEqual(await cursor.next(), { done: true, value: undefined });
      // a cursor that never pulled: nothing to release
      const untouched = open();
      const before = counters.return;
      await untouched.return();
      assert.strictEqual(counters.return, before);
      assert.strictEqual(counters.iterate, counters.iterate, 'no statement was ever opened for it');
    }
    await store.close();
  });

  it('construction touches no connection: preflight refusals are still synchronous, and no statement is prepared before the first pull', async () => {
    const { store, counters, openers } = await seeded();
    const prepared = counters.iterate + counters.all;
    for (const open of Object.values(openers)) {
      assert.throws(() => open({ signal: AbortSignal.abort() }), (e) => e.code === 'JD2072');
      assert.throws(() => open({ deadline: 0 }), (e) => e.code === 'JD2075');
      const cursor = open();
      assert.ok(['row', 'buffered'].includes(cursor.streaming), 'the classification is the inner cursor\'s');
      assert.ok('barrier' in cursor);
      assert.strictEqual(cursor[Symbol.asyncIterator](), cursor, 'iterator identity');
    }
    assert.strictEqual(counters.iterate + counters.all, prepared, 'constructing cursors issued nothing');
    await store.close();
  });

  it("transactions: 'strict' refuses a contended pull as a rejection, not a throw", async () => {
    const { store, openers } = await seeded({ transactions: 'strict' });
    const hold = defer();
    const tx = store.transaction(async () => { await hold.promise; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (const open of Object.values(openers)) {
      const cursor = open();
      const refused = await settle(cursor.next());
      assert.strictEqual(refused.code, 'JD0012', refused.message);
    }
    hold.resolve();
    await tx;
    await store.close();
  });

  it('the admitted cursor and the inner cursor each keep their own asynchronous-iterator identity', async () => {
    const inner = createCursor({ streaming: 'buffered', barrier: { construct: 'test', reason: 'a fixture' },
      materialize: () => [1, 2, 3] });
    assert.strictEqual(inner[Symbol.asyncIterator](), inner);
    const walked = [];
    for await (const item of inner) walked.push(item);
    assert.deepStrictEqual(walked, [1, 2, 3], 'the inner cursor iterates on its own');
    let admitted = 0;
    const wrapped = admitCursor(createCursor({ streaming: 'buffered', barrier: null, materialize: () => ['a', 'b'] }),
      (fn) => { admitted++; return fn(); }, undefined, 'a test pull');
    assert.strictEqual(wrapped[Symbol.asyncIterator](), wrapped);
    const out = [];
    for await (const item of wrapped) out.push(item);
    assert.deepStrictEqual(out, ['a', 'b']);
    assert.strictEqual(admitted, 3, 'each pull was admitted once (two items and the exhausting pull)');
  });

  it('exactly one admission implementation exists, and it neither buffers nor imports a store', () => {
    const cursor = fs.readFileSync(new URL('../../packages/db/src/cursor.js', import.meta.url), 'utf8');
    const store = fs.readFileSync(new URL('../../packages/db/src/store.js', import.meta.url), 'utf8');
    assert.strictEqual((cursor.match(/export function admitCursor\(/g) ?? []).length, 1);
    // the collection query, the entity cursor, the graph cursor and the
    // job page: every root cursor surface routes through it
    assert.strictEqual((store.match(/admitCursor\(/g) ?? []).length, 4, 'the four root cursor surfaces route through it');
    assert.ok(!/query is deliberately NOT gated/.test(store), 'the ungated exception is gone');
    const body = cursor.slice(cursor.indexOf('export function admitCursor('));
    const fn = body.slice(0, body.indexOf('\n}\n') + 3);
    assert.ok(!/\.all\(\)|toArray\(|\[\]/.test(fn), 'the decorator holds no buffer');
  });
});
