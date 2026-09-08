//@ts-check
/**
 * @file The Bun binding's cursor classification, both ways: a
 * bun:sqlite-shaped database whose statements carry a lazy `iterate`
 * declares `lazyIteration: true` and streams one row per pull (the
 * open-time probe is inert — it reads the member, never calls it, and
 * prepares nothing beyond the two statements every open issues); one
 * whose statements do not carry it declares `lazyIteration: false` and
 * every cursor says `streaming: 'buffered'` with the driver barrier,
 * `explain()` agrees, and `strictStreaming` refuses (`JD0037`). Then the
 * real runtime: when a `bun` binary is on PATH the probe fixture runs
 * under it against the actual `bun:sqlite` and must report a native row
 * stream; without one the case is skipped by name.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '@jarenjs/db';
import { adaptBunDatabase } from '@jarenjs/db/bun';

import { BunShapedDatabase } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    notes: { schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' } } }, key: '/id' },
  },
};
const DOCUMENT = { $for: { it: '$[*]' }, $return: '$it.id' };

/** A bun:sqlite-shaped database whose statements carry a lazy iterator, with counters. */
class LazyBunShapedDatabase extends BunShapedDatabase {
  /** @param {string} dbPath */
  constructor(dbPath) {
    super(dbPath);
    this.counts = { prepare: 0, iterate: 0, all: 0 };
  }

  /** @param {string} sql */
  prepare(sql) {
    this.counts.prepare++;
    const statement = this.db.prepare(sql);
    const counts = this.counts;
    return {
      /** @param {any[]} params */
      run: (...params) => statement.run(...params),
      /** @param {any[]} params */
      get: (...params) => statement.get(...params) ?? null,
      /** @param {any[]} params */
      all: (...params) => { counts.all++; return statement.all(...params); },
      /** @param {any[]} params */
      iterate: (...params) => { counts.iterate++; return statement.iterate(...params); },
    };
  }
}

/** @param {any} db */
function driverOver(db) {
  return { name: 'bun-shaped', dialect: /** @type {any} */ (undefined), open: () => adaptBunDatabase(db) };
}

describe('the Bun binding releases uncached prepared statements', () => {
  it('finalizes reachable statements and removes collected weak entries without retaining their targets', (t) => {
    const refs = [];
    const entries = [];
    const unregistered = [];
    let collected;
    t.mock.method(globalThis, 'WeakRef', function (target) {
      const ref = { target, deref() { return this.target; } };
      refs.push(ref);
      return ref;
    });
    t.mock.method(globalThis, 'FinalizationRegistry', function (callback) {
      collected = callback;
      return {
        register(target, held, token) { entries.push({ target, held, token }); },
        unregister(token) { unregistered.push(token); return true; },
      };
    });
    const finalized = [];
    const db = new BunShapedDatabase(':memory:');
    const prepare = db.prepare.bind(db);
    t.mock.method(db, 'prepare', (sql) => ({ ...prepare(sql), finalize() { finalized.push(sql); } }));
    const close = t.mock.method(db, 'close');
    const connection = adaptBunDatabase(db);
    connection.prepare('SELECT 1 AS n');
    connection.prepare('SELECT 2 AS n');
    assert.strictEqual(refs.length, 4);
    for (const entry of entries) {
      assert.strictEqual(entry.held, entry.token);
      assert.strictEqual(entry.held.deref(), entry.target);
    }
    // Collection can precede its finalizer; both states must close safely.
    refs[0].target = undefined;
    collected(refs[0]);
    refs[1].target = undefined;
    connection.close();
    connection.close();
    assert.deepStrictEqual(finalized, ['SELECT 1 AS n', 'SELECT 2 AS n']);
    assert.deepStrictEqual(unregistered, refs.slice(1));
    assert.strictEqual(close.mock.callCount(), 1);
  });

  for (const failureMode of ['statement', 'database', 'both']) {
    it(`closes every resource when ${failureMode} cleanup fails`, (t) => {
      const statementError = new Error('statement finalization failed');
      const databaseError = new Error('database close failed');
      const finalized = [];
      const db = new BunShapedDatabase(':memory:');
      const prepare = db.prepare.bind(db);
      t.mock.method(db, 'prepare', (sql) => ({
        ...prepare(sql),
        finalize() {
          finalized.push(sql);
          if (sql === 'SELECT 1' && failureMode !== 'database') throw statementError;
        },
      }));
      const close = db.close.bind(db);
      const closed = t.mock.method(db, 'close', () => {
        close();
        if (failureMode !== 'statement') throw databaseError;
      });
      const connection = adaptBunDatabase(db);
      connection.prepare('SELECT 1');
      connection.prepare('SELECT 2');
      assert.throws(() => connection.close(), (error) => {
        if (failureMode === 'both') {
          assert.ok(error instanceof AggregateError);
          assert.deepStrictEqual(error.errors, [statementError, databaseError]);
        }
        else assert.strictEqual(error, failureMode === 'statement' ? statementError : databaseError);
        return true;
      });
      assert.ok(finalized.includes('SELECT 2'), 'a failed finalizer does not skip later statements');
      assert.strictEqual(closed.mock.callCount(), 1);
      connection.close();
      assert.strictEqual(closed.mock.callCount(), 1);
    });
  }
});

describe('the Bun binding declares its iterator honestly', () => {
  it('a statement API with iterate: lazyIteration true, one row per pull, and an inert probe', async () => {
    const db = new LazyBunShapedDatabase(':memory:');
    const store = await openStore(MODEL, { driver: /** @type {any} */ (driverOver(db)) });
    assert.strictEqual(store.capabilities.lazyIteration, true);
    assert.strictEqual(db.counts.iterate, 0, 'the open-time probe read the member and never called it');
    const notes = store.collection('notes');
    await notes.insert({ id: 'a', n: 1 });
    await notes.insert({ id: 'b', n: 2 });
    const cursor = notes.query(DOCUMENT);
    assert.strictEqual(cursor.streaming, 'row');
    assert.strictEqual(cursor.barrier, null);
    const before = db.counts.iterate;
    const ids = [];
    for await (const id of cursor) ids.push(id);
    assert.deepStrictEqual(ids.sort(), ['a', 'b']);
    assert.strictEqual(db.counts.iterate, before + 1, 'the cursor pulled through iterate()');
    const explained = await notes.explain(DOCUMENT);
    assert.strictEqual(explained.streaming, 'row');
    const strict = notes.query(DOCUMENT, { strictStreaming: true });
    assert.strictEqual(strict.streaming, 'row');
    await strict.return();
    await store.close();
  });

  it('a statement API without iterate: lazyIteration false, buffered with the driver barrier, explain agrees, strict refuses', async () => {
    const db = new BunShapedDatabase(':memory:');
    const store = await openStore(MODEL, { driver: /** @type {any} */ (driverOver(db)) });
    assert.strictEqual(store.capabilities.lazyIteration, false);
    const notes = store.collection('notes');
    await notes.insert({ id: 'a', n: 1 });
    const cursor = notes.query(DOCUMENT);
    assert.strictEqual(cursor.streaming, 'buffered');
    assert.deepStrictEqual(cursor.barrier, { construct: 'driver',
      reason: 'the driver binding has no lazy iterator; the first pull materialises the whole result' });
    const ids = [];
    for await (const id of cursor) ids.push(id);
    assert.deepStrictEqual(ids, ['a']);
    const explained = await notes.explain(DOCUMENT);
    assert.strictEqual(explained.streaming, 'buffered');
    assert.strictEqual(explained.barrier?.construct, 'driver');
    assert.throws(() => notes.query(DOCUMENT, { strictStreaming: true }),
      (/** @type {any} */ error) => error.code === 'JD0037' && /driver/.test(error.message));
    await store.close();
  });

  it('the real runtime: bun:sqlite under Bun declares a native row stream', (t) => {
    const which = spawnSync('bun', ['--version'], { encoding: 'utf8' });
    if (which.error !== undefined || which.status !== 0) {
      t.skip('no bun binary on PATH');
      return;
    }
    const probe = fileURLToPath(new URL('./fixtures/bun-probe.mjs', import.meta.url));
    const run = spawnSync('bun', ['run', probe], { encoding: 'utf8', cwd: fileURLToPath(new URL('../..', import.meta.url)) });
    assert.strictEqual(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}');
    assert.match(report.runtime, /^bun \d/);
    assert.strictEqual(report.lazyIteration, true);
    assert.strictEqual(report.streaming, 'row');
    assert.strictEqual(report.barrier, null);
    assert.strictEqual(report.explainStreaming, 'row');
    assert.strictEqual(report.strict, 'accepted');
    assert.deepStrictEqual(report.rows, ['a', 'b']);
    assert.strictEqual(report.closedFileRemoved, true);
    assert.strictEqual(report.reopenedFileRemoved, true);
    assert.deepStrictEqual(report.failedTransactionRows, { deferred: [], immediate: [] });
  });
});

// the double is over node:sqlite; make sure the module it needs loads here
void DatabaseSync;
