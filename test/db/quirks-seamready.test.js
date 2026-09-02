//@ts-check
/**
 * @file Quirks found and fixed in the root-cursor admission, deadline
 * clock and change-log surfaces, each pinned by the reproduction that
 * found it: two root cursors over one document no longer share a
 * prepared statement; a refused release still releases; a settled cursor
 * answers `{ done: true }` without borrowing the gate and whatever the
 * clock says; the change page honours `deadline`; the engine's own
 * tables are not shape drift; a gate wait that times out forgets its
 * abort listener; a live query registered inside a transaction that
 * rolls back is closed with it.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { getEventListeners } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { openStore, compareShapeToModel, CHANGES_TABLE, CHANGES_STATE_TABLE } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { createRuntime } from '@jarenjs/core/runtime';
import { statementCountingDriver } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    docs: { schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, key: '/id', indexes: [] },
  },
  entities: {
    Item: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer', 'x-entity': { key: true } }, tag: { type: 'string' } } } },
  },
};
const DOCS = { $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it' };
const ITEMS = { $for: { it: '$.Item[*]' }, $orderby: ['$it.id'], $return: '$it' };
const settle = (p) => Promise.resolve(p).then((value) => ({ value }), (error) => ({ code: error.code, message: error.message }));
const defer = () => {
  /** @type {(v?: any) => void} */
  let resolve = () => {};
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const clockAt = (start) => {
  let at = start;
  const now = () => at;
  now.advance = (ms) => { at += ms; };
  return now;
};

async function seeded(options = {}) {
  const counters = { iterate: 0, next: 0, return: 0, all: 0 };
  const store = await openStore(MODEL, { driver: statementCountingDriver(counters), ...options });
  await store.transaction(async (tx) => {
    for (const id of ['a', 'b', 'c']) await tx.collection('docs').put({ id }, id);
    for (const id of [1, 2, 3]) await tx.entity('Item').create({ id, tag: `t${id}` });
  });
  for (const key of Object.keys(counters)) counters[key] = 0;
  const openers = {
    query: (o) => store.collection('docs').query(DOCS, o),
    cursor: (o) => store.entity('Item').cursor(ITEMS, o),
    loadCursor: (o) => store.entity('Item').loadCursor({ orderBy: '$it.id' }, o),
  };
  return { store, counters, openers };
}

describe('two root cursors over one document each iterate a statement of their own', () => {
  it('interleaving two cursors over the same document yields every row to both, on all three surfaces', async () => {
    const { store, openers } = await seeded();
    for (const [surface, open] of Object.entries(openers)) {
      const a = open();
      const b = open();
      const first = (await a.next()).value;
      const second = (await b.next()).value;
      const rest = [];
      for await (const item of a) rest.push(item);
      const restB = [];
      for await (const item of b) restB.push(item);
      assert.strictEqual(rest.length, 2, `${surface}: the first cursor finished after the second opened`);
      assert.strictEqual(restB.length, 2, `${surface}: the second cursor finished too`);
      assert.deepStrictEqual(first.id, second.id, `${surface}: both read the same first row`);
    }
    await store.close();
  });
});

describe('a refused or pointless release', () => {
  it('a return() the gate refuses still releases the statement, once, and answers done', async () => {
    const { store, counters, openers } = await seeded({ queueTimeout: 60 });
    for (const open of Object.values(openers)) {
      const cursor = open();
      assert.strictEqual((await cursor.next()).done, false);
      const hold = defer();
      const tx = store.transaction(async () => { await hold.promise; });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const returns = counters.return;
      const released = await settle(cursor.return());
      assert.deepStrictEqual(released, { value: { done: true, value: undefined } }, 'the refusal is not the consumer\'s');
      assert.strictEqual(counters.return, returns + 1, 'the statement was released off-gate');
      hold.resolve();
      await tx;
      assert.deepStrictEqual(await cursor.next(), { done: true, value: undefined }, 'and the cursor is finished');
      assert.strictEqual(counters.return, returns + 1, 'released exactly once');
    }
    await store.close();
  });

  it('a settled cursor answers done at once under contention, and done past its deadline', async () => {
    const now = clockAt(0);
    const { store, openers } = await seeded({ queueTimeout: 100, runtime: createRuntime({ now }) });
    for (const open of Object.values(openers)) {
      const drained = open({ deadline: 10 });
      for await (const _ of drained) { /* drain */ }
      now.advance(999);
      assert.deepStrictEqual(await drained.next(), { done: true, value: undefined }, 'done, not JD2075');
      now.advance(-999);
      const returned = open();
      await returned.return();
      const hold = defer();
      const tx = store.transaction(async () => { await hold.promise; });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const started = Date.now();
      assert.deepStrictEqual(await returned.next(), { done: true, value: undefined });
      assert.deepStrictEqual(await returned.return(), { done: true, value: undefined });
      assert.deepStrictEqual(await drained.return(), { done: true, value: undefined });
      assert.ok(Date.now() - started < 50, 'nothing waited for the open transaction');
      hold.resolve();
      await tx;
    }
    await store.close();
  });
});

describe('the change page honours a deadline, and engine tables are not drift', () => {
  const LOGGED = { capture: { log: { retention: 1000 } } };

  it('changes.page refuses a passed deadline before another record and a malformed one as API misuse', async () => {
    const now = clockAt(1_000);
    const store = await openStore(MODEL, { driver: nodeDriver(), runtime: createRuntime({ now }), ...LOGGED });
    await store.collection('docs').put({ id: 'a' }, 'a');
    await store.collection('docs').put({ id: 'b' }, 'b');
    const page = await store.changes.page({ after: 0, deadline: 2_000 });
    assert.strictEqual(page.items.length, 2, 'a live deadline lets the page through');
    now.advance(5_000);
    const late = await settle(store.changes.page({ after: 0, deadline: 2_000 }));
    assert.strictEqual(late.code, 'JD2075', late.message);
    await assert.rejects(async () => store.changes.page({ after: 0, deadline: /** @type {any} */ ('soon') }), TypeError);
    await store.close();
  });

  it('the change log, its state row and the job queue are never a shape-drift finding', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-engine-tables-'));
    const dbPath = path.join(dir, 'x.db');
    try {
      const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, jobs: true, ...LOGGED });
      await store.collection('docs').put({ id: 'a' }, 'a');
      await store.jobs.enqueue('k', {});
      await store.close();
      const { DatabaseSync } = await import('node:sqlite');
      const raw = new DatabaseSync(dbPath);
      const names = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map((row) => String(row.name));
      raw.close();
      assert.ok(names.includes(CHANGES_TABLE) && names.includes(CHANGES_STATE_TABLE) && names.some((n) => n.startsWith('_jaren_jobs')),
        `the engine tables exist: ${names.join(', ')}`);
      const connection = await nodeDriver().open(dbPath, {});
      try {
        assert.strictEqual(await compareShapeToModel(nodeDriver(), connection, MODEL, undefined), null, 'no drift: the engine tables are its own');
      }
      finally {
        await connection.close();
      }
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a gate wait that times out forgets its abort listener', () => {
  it('three timed-out pulls on one signal leave only the cursors\' own listeners, which their release removes', async () => {
    const { store, openers } = await seeded({ queueTimeout: 30 });
    const controller = new AbortController();
    const hold = defer();
    const tx = store.transaction(async () => { await hold.promise; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const cursors = [];
    for (let i = 0; i < 3; i++) {
      const cursor = openers.query({ signal: controller.signal });
      cursors.push(cursor);
      const refused = await settle(cursor.next());
      assert.strictEqual(refused.code, 'JD0012');
    }
    // one listener per unsettled cursor (its own abort hook); the gate's
    // timed-out waits left none
    assert.strictEqual(getEventListeners(controller.signal, 'abort').length, 3);
    for (const cursor of cursors) await cursor.return();
    assert.strictEqual(getEventListeners(controller.signal, 'abort').length, 0);
    hold.resolve();
    await tx;
    await store.close();
  });
});

describe('a live query registered inside a transaction shares its fate', () => {
  it('rolls back with the transaction: closed, and out of the registry; a committed one stays and is maintained', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
    await store.collection('docs').put({ id: 'a' }, 'a');
    /** @type {any} */
    let undone;
    await store.transaction(async (tx) => {
      await tx.collection('docs').put({ id: 'b' }, 'b');
      undone = await tx.collection('docs').live(DOCS);
      assert.deepStrictEqual(undone.result.rows.map((r) => r.id), ['a', 'b'], 'inside the transaction it sees the transaction\'s rows');
      throw new Error('undo');
    }).catch(() => {});
    assert.strictEqual(undone.state, 'closed');
    assert.strictEqual(store.stats().liveQueries, 0, 'a rolled-back registration leaves no live query');
    /** @type {any} */
    let kept;
    await store.transaction(async (tx) => {
      await tx.collection('docs').put({ id: 'c' }, 'c');
      kept = await tx.collection('docs').live(DOCS);
    });
    assert.strictEqual(kept.state, 'live');
    assert.deepStrictEqual(kept.result.rows.map((r) => r.id), ['a', 'c']);
    await store.collection('docs').put({ id: 'd' }, 'd');
    assert.deepStrictEqual(kept.result.rows.map((r) => r.id), ['a', 'c', 'd'], 'a committed registration is maintained');
    // the entity-root twin
    /** @type {any} */
    let entityLive;
    await store.transaction(async (tx) => {
      await tx.entity('Item').create({ id: 9, tag: 'staged' });
      entityLive = await tx.live({ Item: [{ $for: { i: '$.Item[*]' }, $return: '$i.id' }] });
      throw new Error('undo');
    }).catch(() => {});
    assert.strictEqual(entityLive.state, 'closed');
    assert.strictEqual(store.stats().liveQueries, 1);
    kept.close();
    await store.close();
  });
});
