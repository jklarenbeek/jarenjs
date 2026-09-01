//@ts-check
/**
 * @file Named partial rollback (MODEL-FORMAT §5.2): a live transaction
 * view can create, roll back to and release a checkpoint by label,
 * without throwing for control flow. The label never reaches SQL — the
 * driver generates the same monotonic `jaren_sp_*` identifiers
 * structured nesting uses, so both savepoint kinds share ONE engine
 * stack — and the public contract follows the engine's own semantics
 * exactly: `ROLLBACK TO` keeps its target active and discards what came
 * after; `RELEASE` removes the target and what came after, keeping the
 * rows. Database state, tracker withdrawal, capture and the savepoint
 * stack agree after every partial rollback.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { wasmDriver } from '@jarenjs/db/wasm';

import { asyncWasmHandle } from './helpers.js';

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

const settle = (p) => Promise.resolve(p).then(
  (value) => ({ value }), (error) => ({ code: error.code, message: error.message }));

/** A wasm-shaped SYNCHRONOUS handle over node:sqlite that records the
 * exact SQL text the engine receives — savepoint statements included,
 * which the connection-level recording double cannot see. */
const recordingHandle = () => {
  /** @type {string[]} */
  const executed = [];
  return {
    executed,
    handle: {
      synchronous: true,
      /** @param {string} dbPath */
      open: (dbPath) => {
        const db = new DatabaseSync(dbPath);
        return {
          /** @param {string} sql */
          exec: (sql) => {
            executed.push(String(sql));
            db.exec(sql);
          },
          /** @param {string} sql */
          prepare: (sql) => {
            const statement = db.prepare(sql);
            return {
              run: (params = []) => statement.run(...params),
              get: (params = []) => statement.get(...params),
              all: (params = []) => statement.all(...params),
            };
          },
          close: () => db.close(),
        };
      },
    },
  };
};

describe('the engine semantics, pinned through the driver surface', () => {
  it('ROLLBACK TO keeps its target; RELEASE removes target and later, keeping rows', async () => {
    const connection = await Promise.resolve(nodeDriver().open(':memory:', {}));
    await connection.transaction(async (scope) => {
      await scope.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
      const rows = () => scope.prepare('SELECT COUNT(*) AS n FROM t').get([]).n;

      const a = await Promise.resolve(scope.savepoint());
      await scope.exec("INSERT INTO t VALUES ('after-a')");
      const b = await Promise.resolve(scope.savepoint());
      await scope.exec("INSERT INTO t VALUES ('after-b')");
      await Promise.resolve(scope.rollbackTo(a));
      // the engine discarded B with the rows after A…
      assert.throws(() => scope.rollbackTo(b), /no such savepoint/);
      assert.strictEqual(rows(), 0);
      // …while A stays active and accepts a SECOND rollback
      await scope.exec("INSERT INTO t VALUES ('again')");
      await Promise.resolve(scope.rollbackTo(a));
      assert.strictEqual(rows(), 0);
      await Promise.resolve(scope.release(a));

      const c = await Promise.resolve(scope.savepoint());
      await scope.exec("INSERT INTO t VALUES ('after-c')");
      const d = await Promise.resolve(scope.savepoint());
      await scope.exec("INSERT INTO t VALUES ('after-d')");
      await Promise.resolve(scope.release(c));
      // RELEASE removed the target AND the savepoints nested after it…
      assert.throws(() => scope.release(d), /no such savepoint/);
      assert.throws(() => scope.rollbackTo(c), /no such savepoint/);
      // …but every row remains
      assert.strictEqual(rows(), 2);
    });
    await Promise.resolve(connection.close());
  });
});

describe('tx.savepoints — named partial rollback on the store', () => {
  it('named_partial_rollback_keeps_outer_work_and_target_checkpoint', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await store.transaction(async (tx) => {
      const docs = tx.collection('docs');
      await docs.put({ id: 'pre' }, 'pre');
      await tx.savepoints.create('a');
      await docs.put({ id: 'after-a' }, 'after-a');
      await tx.savepoints.create('b');
      await docs.put({ id: 'after-b' }, 'after-b');

      await tx.savepoints.rollbackTo('a');
      // b was created after the target, so it is invalidated by name…
      assert.strictEqual((await settle(tx.savepoints.rollbackTo('b'))).code, 'JD2071');
      // …while a remains active and usable for a second rollback
      await docs.put({ id: 'again' }, 'again');
      await tx.savepoints.rollbackTo('a');
      await tx.savepoints.release('a');
      await docs.put({ id: 'post' }, 'post');
    });
    assert.deepStrictEqual(
      await Promise.all(['pre', 'after-a', 'after-b', 'again', 'post']
        .map((id) => store.collection('docs').get(id))),
      [{ id: 'pre' }, undefined, undefined, undefined, { id: 'post' }],
      'exactly the pre-checkpoint work survives, and releasing lets the outer commit');
    await store.close();
  });

  it('labels never appear in SQL — the dialect receives generated unique identifiers', async () => {
    const { executed, handle } = recordingHandle();
    const store = await openStore(MODEL, { driver: wasmDriver(handle) });
    const label = "not an identifier'; DROP TABLE docs; --";
    await store.transaction(async (tx) => {
      await tx.savepoints.create(label);
      await tx.collection('docs').put({ id: 'x' }, 'x');
      await tx.savepoints.rollbackTo(label);
      await tx.savepoints.release(label);
    });
    assert.ok(!executed.some((sql) => sql.includes('DROP TABLE')),
      'the caller label is a map key and diagnostic only, never SQL');
    const names = executed
      .map((sql) => /^SAVEPOINT "(jaren_sp_\d+)"$/.exec(sql)?.[1])
      .filter((name) => name !== undefined);
    assert.ok(names.length >= 1, 'the generated identifier family carries the checkpoint');
    assert.strictEqual(new Set(names).size, names.length, 'identifiers are never reused');
    await store.close();
  });

  it('blank, duplicate and unknown labels are JD2071, before any statement', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await store.transaction(async (tx) => {
      await tx.collection('docs').put({ id: 'pre' }, 'pre');
      await tx.savepoints.create('x');
      await tx.collection('docs').put({ id: 'after-x' }, 'after-x');

      for (const [outcome, why] of [
        [await settle(tx.savepoints.create('x')), 'duplicate'],
        [await settle(tx.savepoints.create('')), 'blank'],
        [await settle(tx.savepoints.create(/** @type {any} */ (7))), 'non-string'],
        [await settle(tx.savepoints.rollbackTo('never-created')), 'unknown rollback target'],
        [await settle(tx.savepoints.release('never-created')), 'unknown release target'],
      ]) {
        assert.strictEqual(/** @type {any} */ (outcome).code, 'JD2071', String(why));
      }
      // the refusals changed neither the database nor the marks: the
      // checkpoint still undoes exactly the post-checkpoint work
      await tx.savepoints.rollbackTo('x');
      assert.strictEqual(await tx.collection('docs').get('after-x'), undefined);
      assert.deepStrictEqual(await tx.collection('docs').get('pre'), { id: 'pre' });
      await tx.savepoints.release('x');
    });
    await store.close();
  });

  it('direct collection and tx.jobs writes roll back with SQLite; release keeps them', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), jobs: true });
    await store.transaction(async (tx) => {
      await tx.jobs.enqueue('work', { keep: true }, { id: 'kept-job' });
      await tx.collection('docs').put({ id: 'kept' }, 'kept');
      await tx.savepoints.create('cp');
      await tx.jobs.enqueue('work', {}, { id: 'undone-job' });
      await tx.collection('docs').put({ id: 'undone' }, 'undone');
      await tx.savepoints.rollbackTo('cp');
      await tx.savepoints.create('cp2');
      await tx.jobs.enqueue('work', {}, { id: 'released-job' });
      await tx.savepoints.release('cp2');
    });
    assert.notStrictEqual(await store.jobs.get('kept-job'), undefined);
    assert.strictEqual(await store.jobs.get('undone-job'), undefined,
      'the enqueue after the checkpoint rolled back with the database');
    assert.notStrictEqual(await store.jobs.get('released-job'), undefined,
      'release keeps the rows of the checkpoints it removes');
    assert.deepStrictEqual(await store.collection('docs').get('kept'), { id: 'kept' });
    assert.strictEqual(await store.collection('docs').get('undone'), undefined);
    await store.close();
  });

  it('an inner scope cannot target an outer label; the outer view cannot cross the inner', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await store.transaction(async (tx) => {
      await tx.savepoints.create('outer-label');
      await tx.transaction(async (inner) => {
        // a structured inner transaction has its own exact namespace
        assert.strictEqual(
          (await settle(inner.savepoints.rollbackTo('outer-label'))).code, 'JD2071');
        // and the outer view is JD2070 while the inner scope is current,
        // so it cannot destroy the inner savepoint from outside
        assert.strictEqual(
          (await settle(tx.savepoints.rollbackTo('outer-label'))).code, 'JD2070');
        await inner.collection('docs').put({ id: 'inner' }, 'inner');
      });
      await tx.savepoints.release('outer-label');
    });
    assert.deepStrictEqual(await store.collection('docs').get('inner'), { id: 'inner' });
    await store.close();
  });

  it('releasing an older label invalidates it plus every later label, keeping their rows', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await store.transaction(async (tx) => {
      await tx.savepoints.create('c');
      await tx.collection('docs').put({ id: 'after-c' }, 'after-c');
      await tx.savepoints.create('d');
      await tx.collection('docs').put({ id: 'after-d' }, 'after-d');
      await tx.savepoints.release('c');
      assert.strictEqual((await settle(tx.savepoints.release('d'))).code, 'JD2071');
      assert.strictEqual((await settle(tx.savepoints.rollbackTo('c'))).code, 'JD2071');
    });
    assert.deepStrictEqual(await store.collection('docs').get('after-c'), { id: 'after-c' });
    assert.deepStrictEqual(await store.collection('docs').get('after-d'), { id: 'after-d' });
    await store.close();
  });

  it('only a live transaction view carries the controller', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), jobs: true });
    assert.strictEqual(/** @type {any} */ (store).savepoints, undefined,
      'the root store exposes no savepoint controller');
    assert.strictEqual(/** @type {any} */ (store.sync).savepoints, undefined,
      'nor does the root synchronous surface');
    const worker = store.jobs.createWorker({ handlers: { work: () => null } });
    assert.deepStrictEqual(
      Object.keys(worker).filter((k) => k === 'savepoints'), [],
      'a worker exposes none of it');
    /** @type {any} */
    let escaped;
    await store.transaction(async (tx) => { escaped = tx.savepoints; });
    assert.strictEqual((await settle(escaped.create('late'))).code, 'JD2070',
      'a stale view is the earlier JD2070, checked before any label logic');
    await worker.stop();
    await store.close();
  });

  it('the synchronous twin shares stack and semantics, answering values', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const out = store.sync.transaction((tx) => {
      const docs = tx.sync.collection('docs');
      docs.put({ id: 'pre' }, 'pre');
      tx.sync.savepoints.create('a');
      docs.put({ id: 'after-a' }, 'after-a');
      tx.sync.savepoints.rollbackTo('a');
      assert.throws(() => tx.sync.savepoints.rollbackTo('missing'),
        (error) => /** @type {any} */ (error).code === 'JD2071');
      tx.sync.savepoints.release('a');
      return docs.get('after-a');
    });
    assert.strictEqual(out, undefined, 'the rolled-back row is gone, synchronously');
    assert.deepStrictEqual(store.sync.collection('docs').get('pre'), { id: 'pre' });
    await store.close();
  });

  it('the all-async wasm driver carries the same async surface', async () => {
    const store = await openStore(MODEL, { driver: wasmDriver(asyncWasmHandle()) });
    await store.transaction(async (tx) => {
      assert.strictEqual(tx.sync, undefined, 'no synchronous twin on an async driver');
      await tx.collection('docs').put({ id: 'pre' }, 'pre');
      await tx.savepoints.create('cp');
      await tx.collection('docs').put({ id: 'undone' }, 'undone');
      await tx.savepoints.rollbackTo('cp');
      await tx.savepoints.release('cp');
    });
    assert.deepStrictEqual(await store.collection('docs').get('pre'), { id: 'pre' });
    assert.strictEqual(await store.collection('docs').get('undone'), undefined);
    await store.close();
  });
});

describe('rollback_to_withdraws_tracker_advance_and_capture', () => {
  for (const mode of /** @type {const} */ (['session', 'journal'])) {
    it(`${mode} capture: the save after the checkpoint is withdrawn, retried once, and absent from the patch`, async () => {
      const store = await openStore(ENTITY_MODEL,
        { driver: nodeDriver(), capture: { mode } });
      /** @type {any[]} */
      const records = [];
      store.observe((record) => records.push(record));
      await store.entity('Note').create({ id: 'n1', stars: 1 });
      records.length = 0;

      await store.transaction(async (tx) => {
        const notes = tx.entity('Note');
        const mine = await notes.get('n1');
        await tx.savepoints.create('cp');
        notes.put({ ...mine, stars: 50 });
        const first = await tx.saveChanges();
        assert.strictEqual(first.updated, 1, 'the save advanced with its statements');

        await tx.savepoints.rollbackTo('cp');
        // the database no longer holds 50, and the intention is pending
        // again — a corrected saveChanges() writes exactly once
        notes.put({ ...mine, stars: 7 });
        const second = await tx.saveChanges();
        assert.strictEqual(second.updated, 1);
        await tx.savepoints.release('cp');
      });

      assert.deepStrictEqual(await store.entity('Note').asNoTracking().get('n1'),
        { id: 'n1', stars: 7 });
      assert.strictEqual(records.length, 1, 'one commit, one record');
      const values = records[0].patch
        .filter((op) => op.path.startsWith('/Note/n1'))
        .map((op) => op.value);
      assert.ok(values.includes(7), 'the kept save is in the patch');
      assert.ok(!values.includes(50), 'the withdrawn save never reaches an observer');
      await store.close();
    });
  }

  it('an outer rollback still withdraws the advance made after a named rollback', async () => {
    const store = await openStore(ENTITY_MODEL, { driver: nodeDriver() });
    await store.entity('Note').create({ id: 'n1', stars: 1 });
    await settle(store.transaction(async (tx) => {
      const notes = tx.entity('Note');
      const mine = await notes.get('n1');
      await tx.savepoints.create('cp');
      notes.put({ ...mine, stars: 50 });
      await tx.saveChanges();
      await tx.savepoints.rollbackTo('cp');
      notes.put({ ...mine, stars: 9 });
      await tx.saveChanges();       // the LATER advance
      throw new Error('outer rollback');
    }));
    assert.deepStrictEqual(await store.entity('Note').asNoTracking().get('n1'),
      { id: 'n1', stars: 1 }, 'the outer rollback withdrew the later advance too');
    const retried = await store.saveChanges();
    assert.strictEqual(retried.updated, 1, 'the withdrawn intention is pending, once');
    assert.deepStrictEqual(await store.entity('Note').asNoTracking().get('n1'),
      { id: 'n1', stars: 9 });
    await store.close();
  });
});
