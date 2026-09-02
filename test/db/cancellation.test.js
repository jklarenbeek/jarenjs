//@ts-check
/**
 * @file Cancellation everywhere, at the granularity the driver has:
 * a migration stops between migrations, steps and batches (`JD2080`)
 * and refuses a passed deadline before any step (`JD2075`), read
 * against the store's injected clock; every maintenance operation and
 * the backup honour `signal`/`deadline` before their statements
 * (`JD2081`, `JD2079` for the backup's own lifecycle, `JD2075`); the
 * capability report states each granularity and that nothing
 * interrupts mid-statement; and a cursor over a binding with no lazy
 * iterator reports `streaming: 'buffered'` with a driver barrier
 * instead of a row stream it cannot deliver.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openStore, migrate, migrationStatus, planMigration, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { wasmDriver } from '@jarenjs/db/wasm';

import { asyncWasmHandle, tempDbPath } from './helpers.js';

const M0 = {
  $model: '0.1',
  collections: {
    users: {
      schema: { type: 'object', properties: { id: { type: 'string' }, first: { type: 'string' }, last: { type: 'string' } } },
      key: '/id',
      indexes: [],
    },
  },
};
const M1 = {
  $model: '0.1',
  collections: {
    users: M0.collections.users,
    events: { schema: { type: 'object' }, key: null, identity: 'integer' },
  },
};
const M2 = {
  $model: '0.1',
  collections: {
    users: {
      schema: { type: 'object', required: ['id', 'name'],
        properties: { id: { type: 'string' }, name: { type: 'string' } } },
      key: '/id',
      indexes: [{ name: 'by_name', path: '$.name' }],
    },
    events: M1.collections.events,
  },
};

/** Two migrations; the second carries a jslt step that walks the users in batches. */
function chainFor() {
  const m1 = planMigration(M0, M1, { dialect: sqliteDialect, id: '0001-add-events' }).migration;
  const m2 = planMigration(M1, M2, { dialect: sqliteDialect, id: '0002-split-name' }).migration;
  const jslt = m2.steps.find((step) => step.kind === 'jslt');
  delete jslt.draft;
  jslt.stylesheet = [{ match: '$', body: {
    id: '$.id', name: { $concat: [{ $default: ['$.first', ''] }, ' ', { $default: ['$.last', ''] }] } } }];
  return [m1, m2];
}

async function seeded(n = 3) {
  const { dbPath, cleanup } = tempDbPath();
  const store = await openStore(M0, { driver: nodeDriver(), path: dbPath });
  for (let i = 0; i < n; i++) await store.collection('users').insert({ id: `u${i}`, first: 'A', last: `${i}` });
  await store.close();
  return { dbPath, cleanup };
}

/** The applied history ids, read raw. */
function historyOf(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const exists = db.prepare("SELECT name FROM sqlite_schema WHERE name = '_jaren_migrations'").get();
  const ids = exists === undefined ? [] : db.prepare('SELECT id FROM "_jaren_migrations" ORDER BY applied_at, id').all().map((r) => r.id);
  db.close();
  return ids;
}

describe('migration cancellation', () => {
  it('a signal aborted after the first batch stops with JD2080, the migration in flight rolled back, and a rerun completes', async () => {
    const { dbPath, cleanup } = await seeded(3);
    try {
      const controller = new AbortController();
      const events = [];
      await assert.rejects(migrate({ driver: nodeDriver(), path: dbPath }, chainFor(), {
        baseline: M0, model: M2, batchSize: 1, shadow: false, signal: controller.signal,
        onProgress: (progress) => {
          events.push(progress);
          if (events.length === 1) controller.abort(new Error('operator stop'));
        },
      }), (error) => error.code === 'JD2080' && error.cause?.message === 'operator stop');
      assert.strictEqual(events.length, 1, 'no batch ran after the abort');
      // the first migration committed; the second rolled back whole
      assert.deepStrictEqual(historyOf(dbPath), ['0001-add-events']);
      const check = new DatabaseSync(dbPath, { readOnly: true });
      const docs = check.prepare('SELECT json("doc") AS d FROM "users"').all().map((r) => JSON.parse(r.d));
      check.close();
      assert.ok(docs.every((doc) => doc.name === undefined), 'no transformed row survived the rollback');
      // the rerun from the recorded position completes
      const done = await migrate({ driver: nodeDriver(), path: dbPath }, chainFor(),
        { baseline: M0, model: M2, batchSize: 1, shadow: false });
      assert.deepStrictEqual(done.applied, ['0002-split-name']);
      assert.deepStrictEqual(historyOf(dbPath), ['0001-add-events', '0002-split-name']);
    }
    finally {
      cleanup();
    }
  });

  it('an already-aborted signal refuses before any migration runs; the shadow replay stops too', async () => {
    const { dbPath, cleanup } = await seeded(1);
    try {
      await assert.rejects(migrate({ driver: nodeDriver(), path: dbPath }, chainFor(),
        { baseline: M0, model: M2, signal: AbortSignal.abort() }),
      (error) => error.code === 'JD2080');
      assert.deepStrictEqual(historyOf(dbPath), []);
      // the shadow replay runs over an empty data set (no batch, so no
      // progress event) but checks every step boundary: a clock that
      // ticks once per check trips the deadline inside the shadow, and
      // nothing reaches the real store
      let ticks = 0;
      await assert.rejects(migrate({ driver: nodeDriver(), path: dbPath }, chainFor(), {
        baseline: M0, model: M2, batchSize: 1, deadline: 3, runtime: { now: () => ++ticks },
      }), (error) => error.code === 'JD2075');
      assert.ok(ticks >= 4, `the shadow replay checked its boundaries (${ticks} ticks)`);
      assert.deepStrictEqual(historyOf(dbPath), []);
    }
    finally {
      cleanup();
    }
  });

  it('a deadline in the past is JD2075 before any step, read against the injected runtime clock', async () => {
    const { dbPath, cleanup } = await seeded(1);
    try {
      await assert.rejects(migrate({ driver: nodeDriver(), path: dbPath }, chainFor(),
        { baseline: M0, model: M2, deadline: Date.now() - 1 }),
      (error) => error.code === 'JD2075' && /no further step ran/.test(error.message));
      assert.deepStrictEqual(historyOf(dbPath), []);
      // the platform clock says the deadline passed long ago; the
      // injected clock says otherwise — the injected clock is the one read
      const frozen = 1_000_000;
      const done = await migrate({ driver: nodeDriver(), path: dbPath }, chainFor(), {
        baseline: M0, model: M2, shadow: false, deadline: frozen + 1, runtime: { now: () => frozen },
      });
      assert.deepStrictEqual(done.applied, ['0001-add-events', '0002-split-name']);
      // and the reverse: a deadline the platform clock has not reached but
      // the injected clock has
      const status = migrationStatus({ driver: nodeDriver(), path: dbPath }, chainFor(),
        { deadline: Date.now() + 60_000, runtime: { now: () => Date.now() + 120_000 } });
      await assert.rejects(status, (error) => error.code === 'JD2075');
      await assert.rejects(migrate({ driver: nodeDriver(), path: dbPath }, chainFor(),
        { baseline: M0, model: M2, deadline: 'soon' }), TypeError);
    }
    finally {
      cleanup();
    }
  });

  it('a deadline passed between batches stops the walk at the batch boundary with JD2075', async () => {
    const { dbPath, cleanup } = await seeded(3);
    try {
      let at = 1_000_000;
      const events = [];
      await assert.rejects(migrate({ driver: nodeDriver(), path: dbPath }, chainFor(), {
        baseline: M0, model: M2, batchSize: 1, shadow: false,
        deadline: at + 10, runtime: { now: () => at },
        onProgress: (progress) => { events.push(progress); at += 100; },
      }), (error) => error.code === 'JD2075');
      assert.strictEqual(events.length, 1);
      assert.deepStrictEqual(historyOf(dbPath), ['0001-add-events']);
    }
    finally {
      cleanup();
    }
  });
});

describe('maintenance and backup cancellation', () => {
  it('each operation refuses an aborted signal (JD2081) and a passed deadline (JD2075) before its statement', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      let at = 5_000_000;
      const store = await openStore(M0, { driver: nodeDriver(), path: dbPath, runtime: { now: () => at } });
      const aborted = AbortSignal.abort(new Error('stop'));
      for (const [name, call] of [
        ['checkpoint', (o) => store.checkpoint(o)],
        ['integrityCheck', (o) => store.integrityCheck(o)],
        ['foreignKeyCheck', (o) => store.foreignKeyCheck(o)],
        ['optimize', (o) => store.optimize(o)],
      ]) {
        await assert.rejects(call({ signal: aborted }),
          (error) => error.code === 'JD2081' && error.cause?.message === 'stop', name);
        await assert.rejects(call({ deadline: at - 1 }), (error) => error.code === 'JD2075', name);
        await assert.rejects(call({ deadline: 'later' }), TypeError, name);
        // and a live signal with a deadline still ahead runs
        const result = await call({ signal: new AbortController().signal, deadline: at + 1 });
        assert.strictEqual(typeof result, 'object', name);
      }
      // the backup keeps its own lifecycle code for an abort, and the
      // deadline is honoured between pages with the same cleanup
      const target = path.join(path.dirname(dbPath), 'copy.db');
      await assert.rejects(store.backupTo(target, { signal: aborted }), (error) => error.code === 'JD2079');
      await assert.rejects(store.backupTo(target, { deadline: at - 1 }), (error) => error.code === 'JD2075');
      for (let i = 0; i < 200; i++) await store.collection('users').insert({ id: `b${i}`, first: 'x'.repeat(300), last: 'y' });
      let events = 0;
      await assert.rejects(store.backupTo(target, {
        rate: 2, deadline: at + 1, onProgress: () => { events++; at += 10; },
      }), (error) => error.code === 'JD2075');
      assert.ok(events >= 1);
      assert.strictEqual(fs.existsSync(target), false);
      assert.deepStrictEqual(fs.readdirSync(path.dirname(dbPath)).filter((n) => n.includes('jaren-tmp')), []);
      await store.close();
    }
    finally {
      cleanup();
    }
  });
});

describe('the capability report', () => {
  it('states every cancellation granularity and that nothing interrupts mid-statement', async () => {
    const store = await openStore(M0, { driver: nodeDriver() });
    assert.deepStrictEqual(store.capabilities.cancellation, {
      query: 'row', queue: true, migration: 'step', maintenance: 'statement', backup: 'page',
      midStatement: false,
    });
    assert.ok(Object.isFrozen(store.capabilities.cancellation));
    assert.strictEqual(store.capabilities.lazyIteration, true);
    assert.strictEqual(store.capabilities.statementTimeout, false);
    await store.close();
  });
});

describe('a binding without a lazy iterator', () => {
  const ENTITIES = {
    $model: '0.1',
    collections: M0.collections,
    entities: {
      Item: {
        schema: { type: 'object', properties: {
          id: { type: 'string', 'x-entity': { key: true } }, n: { type: 'integer' } } },
      },
    },
  };

  it('reports streaming: buffered with a driver barrier on every cursor, explain agrees, strictStreaming refuses', async () => {
    const store = await openStore(ENTITIES, { driver: wasmDriver(asyncWasmHandle()) });
    assert.strictEqual(store.capabilities.lazyIteration, false);
    const users = store.collection('users');
    await users.insert({ id: 'u1', first: 'a', last: 'b' });
    const document = { $for: { it: '$[*]' }, $return: '$it' };
    const cursor = users.query(document);
    assert.strictEqual(cursor.streaming, 'buffered');
    assert.deepStrictEqual(cursor.barrier, { construct: 'driver',
      reason: 'the driver binding has no lazy iterator; the first pull materialises the whole result' });
    const rows = [];
    for await (const row of cursor) rows.push(row);
    assert.strictEqual(rows.length, 1);
    const explained = await users.explain(document);
    assert.strictEqual(explained.streaming, 'buffered');
    assert.strictEqual(explained.barrier.construct, 'driver');
    assert.strictEqual(explained.mode, 'native', 'the plan itself still pushes down');
    await assert.rejects(async () => users.query(document, { strictStreaming: true }),
      (error) => error.code === 'JD0037' && /driver/.test(error.message));
    // the entity cursor and the graph cursor classify the same way
    const items = store.entity('Item');
    await items.create({ id: 'i1', n: 1 });
    const entityCursor = items.cursor({ $for: { it: '$.Item[*]' }, $return: '$it' });
    assert.strictEqual(entityCursor.streaming, 'buffered');
    assert.strictEqual(entityCursor.barrier.construct, 'driver');
    await entityCursor.return();
    const loadCursor = items.loadCursor({});
    assert.strictEqual(loadCursor.streaming, 'buffered');
    assert.strictEqual(loadCursor.barrier.construct, 'driver');
    await loadCursor.return();
    assert.strictEqual((await items.explainLoad({})).streaming, 'buffered');
    await store.close();
  });

  it('the node binding still streams: streaming row, barrier null', async () => {
    const store = await openStore(ENTITIES, { driver: nodeDriver() });
    const cursor = store.collection('users').query({ $for: { it: '$[*]' }, $return: '$it' });
    assert.deepStrictEqual({ streaming: cursor.streaming, barrier: cursor.barrier }, { streaming: 'row', barrier: null });
    await cursor.return();
    const loadCursor = store.entity('Item').loadCursor({});
    assert.strictEqual(loadCursor.streaming, 'row');
    await loadCursor.return();
    await store.close();
  });
});

describe('one clock', () => {
  it('no cancellation path reads the platform clock on its own', () => {
    for (const file of ['migrate.js', 'maintenance.js', 'backup.js', 'cancellation.js']) {
      const source = fs.readFileSync(path.resolve('packages/db/src', file), 'utf8');
      assert.doesNotMatch(source, /Date\.now/, file);
    }
  });
});
