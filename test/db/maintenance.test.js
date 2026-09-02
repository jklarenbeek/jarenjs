//@ts-check
/**
 * @file The maintenance surface: `checkpoint`, `integrityCheck`,
 * `foreignKeyCheck` and `optimize` as typed store operations — each
 * answering SQLite's own row as typed data, refused by code exactly
 * where `capabilities.maintenance` says it is unavailable (a read-only
 * store for the two that write; a binding that does not declare one),
 * running twice without changing anything the second time, and never
 * touching the change log's durable watermark.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { openStore, sqliteDialect, CHECKPOINT_MODES, MAINTENANCE_OPERATIONS } from '@jarenjs/db';
import { nodeDriver, adaptNodeDatabase } from '@jarenjs/db/node';
import { wasmDriver } from '@jarenjs/db/wasm';

import { declaringWasmHandle, tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    notes: {
      schema: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' } } },
      key: '/id',
    },
  },
};

const ENTITY_MODEL = {
  $model: '0.1',
  entities: {
    Author: {
      schema: { type: 'object', properties: {
        id: { type: 'string', 'x-entity': { key: true } }, name: { type: 'string' } } },
    },
    Post: {
      schema: { type: 'object', properties: {
        id: { type: 'string', 'x-entity': { key: true } },
        authorId: { type: 'string' },
        title: { type: 'string' },
        author: { 'x-entity': { relation: { to: 'Author', via: 'authorId', onDelete: 'restrict' } } } } },
    },
  },
};

/** A driver over ONE DatabaseSync the test also holds. */
function sharedDriver(db) {
  return { name: 'node-sqlite', dialect: sqliteDialect, open: () => adaptNodeDatabase(db) };
}

/** A store on a WAL file with `n` committed documents. */
async function seeded(dbPath, n, options = {}) {
  const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, ...options });
  const notes = store.collection('notes');
  for (let i = 0; i < n; i++) await notes.insert({ id: `n${i}`, body: 'x'.repeat(400) });
  return store;
}

describe('the maintenance surface exists and is reported', () => {
  it('the four operations are members, in the order the capability report lists them', async () => {
    assert.deepStrictEqual([...MAINTENANCE_OPERATIONS],
      ['checkpoint', 'integrityCheck', 'foreignKeyCheck', 'optimize']);
    assert.deepStrictEqual([...CHECKPOINT_MODES], ['passive', 'full', 'restart', 'truncate']);
    const store = await openStore(MODEL, { driver: nodeDriver() });
    for (const operation of MAINTENANCE_OPERATIONS) assert.strictEqual(typeof store[operation], 'function', operation);
    assert.deepStrictEqual(store.capabilities.maintenance,
      { checkpoint: true, integrityCheck: true, foreignKeyCheck: true, optimize: true, backup: true });
    assert.ok(Object.isFrozen(store.capabilities.maintenance));
    // a transaction view has no maintenance member: these are store-level operations
    await store.transaction(async (tx) => {
      for (const operation of MAINTENANCE_OPERATIONS) assert.strictEqual(tx[operation], undefined, operation);
    });
    await store.close();
  });
});

describe('checkpoint', () => {
  it('answers the engine\'s frame counts, and a second run reports the same or nothing left', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await seeded(dbPath, 60);
      const first = await store.checkpoint();
      assert.deepStrictEqual(Object.keys(first).sort(), ['busy', 'checkpointedFrames', 'logFrames']);
      assert.strictEqual(first.busy, false);
      assert.ok(first.logFrames > 0 && first.checkpointedFrames === first.logFrames, JSON.stringify(first));
      // two-run: a second passive checkpoint finds every frame already
      // checkpointed — the engine reports the same counts, nothing new
      const second = await store.checkpoint({ mode: 'passive' });
      assert.deepStrictEqual(second, first);
      // truncate empties the log; the run after it reports zeros
      const truncated = await store.checkpoint({ mode: 'truncate' });
      assert.strictEqual(truncated.busy, false);
      const again = await store.checkpoint({ mode: 'truncate' });
      assert.deepStrictEqual(again, { busy: false, logFrames: 0, checkpointedFrames: 0 });
      await store.close();
    }
    finally {
      cleanup();
    }
  });

  it('every mode is accepted; a word outside the set is refused before any statement', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await seeded(dbPath, 5);
      for (const mode of CHECKPOINT_MODES) {
        const result = await store.checkpoint({ mode });
        assert.strictEqual(typeof result.logFrames, 'number', mode);
      }
      await assert.rejects(store.checkpoint({ mode: /** @type {any} */ ('bogus') }),
        (error) => error instanceof TypeError && error.message.includes("'passive', 'full', 'restart', 'truncate'"));
      await store.close();
    }
    finally {
      cleanup();
    }
  });

  it('a store that is not in WAL mode answers the engine\'s -1, never an invented count', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    assert.deepStrictEqual(await store.checkpoint(), { busy: false, logFrames: -1, checkpointedFrames: -1 });
    await store.close();
  });

  it('leaves the change log\'s durable watermark untouched across a truncate checkpoint', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await seeded(dbPath, 20, { capture: { log: true } });
      const before = await store.changes.bounds();
      assert.ok(before.highWatermark >= 20, JSON.stringify(before));
      await store.checkpoint({ mode: 'truncate' });
      await store.integrityCheck();
      await store.foreignKeyCheck();
      await store.optimize();
      assert.deepStrictEqual(await store.changes.bounds(), before);
      await store.close();
      // and after a reopen the file still answers the same watermark
      const reopened = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, capture: { log: true } });
      assert.deepStrictEqual(await reopened.changes.bounds(), before);
      await reopened.close();
    }
    finally {
      cleanup();
    }
  });
});

describe('integrityCheck', () => {
  it('answers ok on a healthy store and the identical answer on a second run', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await seeded(dbPath, 10);
      const first = await store.integrityCheck();
      assert.deepStrictEqual(first, { ok: true, problems: [] });
      assert.deepStrictEqual(await store.integrityCheck({ limit: 3 }), first);
      await assert.rejects(store.integrityCheck({ limit: 0 }), TypeError);
      await store.close();
    }
    finally {
      cleanup();
    }
  });

  it('reports corruption as the RESULT — ok: false with the engine\'s rows — and does not throw', async () => {
    const source = tempDbPath();
    const copy = tempDbPath();
    try {
      const store = await seeded(source.dbPath, 300);
      await store.checkpoint({ mode: 'truncate' });
      await store.close();
      fs.copyFileSync(source.dbPath, copy.dbPath);
      // page 1 (the schema) stays intact so the store opens and verifies
      // its shape; a data page is overwritten with junk
      const fd = fs.openSync(copy.dbPath, 'r+');
      fs.writeSync(fd, Buffer.alloc(3000, 0xff), 0, 3000, 4096 * 2 + 100);
      fs.closeSync(fd);
      const corrupted = await openStore(MODEL, { driver: nodeDriver(), path: copy.dbPath });
      const report = await corrupted.integrityCheck();
      assert.strictEqual(report.ok, false);
      assert.ok(report.problems.length > 0 && report.problems.every((p) => typeof p === 'string'));
      assert.ok(report.problems.join('\n').includes('page 3'), report.problems.join('\n'));
      const bounded = await corrupted.integrityCheck({ limit: 1 });
      assert.strictEqual(bounded.ok, false);
      assert.ok(bounded.problems.length >= 1);
      await corrupted.close();
    }
    finally {
      source.cleanup();
      copy.cleanup();
    }
  });

  it('JD2078: a driver failure is wrapped with the original as cause', async () => {
    const db = new DatabaseSync(':memory:');
    const store = await openStore(MODEL, { driver: sharedDriver(db) });
    // the test closes the raw handle under the store: every later
    // statement is the driver's own failure
    db.close();
    await assert.rejects(store.integrityCheck(),
      (error) => error.code === 'JD2078' && error.cause instanceof Error
        && error.message.includes("'integrityCheck'"));
  });
});

describe('foreignKeyCheck', () => {
  it('answers ok with no violations on a consistent entity store, twice', async () => {
    const store = await openStore(ENTITY_MODEL, { driver: nodeDriver() });
    await store.entity('Author').create({ id: 'a1', name: 'Ada' });
    await store.entity('Post').create({ id: 'p1', authorId: 'a1', title: 't' });
    const first = await store.foreignKeyCheck();
    assert.deepStrictEqual(first, { ok: true, violations: [] });
    assert.deepStrictEqual(await store.foreignKeyCheck(), first);
    await store.close();
  });

  it('reports every violating row, typed', async () => {
    const db = new DatabaseSync(':memory:');
    const store = await openStore(ENTITY_MODEL, { driver: sharedDriver(db) });
    // a dangling reference written with enforcement off, as a foreign
    // tool would leave it
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`INSERT INTO "Post" ("id", "authorId", "title", "doc") VALUES ('p9', 'ghost', 't', jsonb('{}'))`);
    db.exec('PRAGMA foreign_keys = ON');
    const report = await store.foreignKeyCheck();
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.violations.length, 1);
    assert.deepStrictEqual(Object.keys(report.violations[0]).sort(), ['fkid', 'parent', 'rowId', 'table']);
    assert.strictEqual(report.violations[0].table, 'Post');
    assert.strictEqual(report.violations[0].parent, 'Author');
    assert.strictEqual(typeof report.violations[0].rowId, 'number');
    assert.strictEqual(report.violations[0].fkid, 0);
    await store.close();
  });
});

describe('optimize', () => {
  it('answers { ran: true } and changes nothing observable on a second run', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await seeded(dbPath, 10);
      assert.deepStrictEqual(await store.optimize(), { ran: true });
      const version = await store.dataVersion();
      const shape = await store.integrityCheck();
      assert.deepStrictEqual(await store.optimize(), { ran: true });
      assert.strictEqual(await store.dataVersion(), version);
      assert.deepStrictEqual(await store.integrityCheck(), shape);
      await store.close();
    }
    finally {
      cleanup();
    }
  });
});

describe('refusals', () => {
  it('a read-only store refuses the two operations that write (JD2077) and runs the two that read', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const writer = await seeded(dbPath, 5);
      await writer.close();
      const reader = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, readOnly: true });
      assert.deepStrictEqual(reader.capabilities.maintenance,
        { checkpoint: false, integrityCheck: true, foreignKeyCheck: true, optimize: false, backup: true });
      await assert.rejects(reader.checkpoint(),
        (error) => error.code === 'JD2077' && error.message.includes('read-only'));
      await assert.rejects(reader.optimize(), (error) => error.code === 'JD2077');
      assert.deepStrictEqual(await reader.integrityCheck(), { ok: true, problems: [] });
      assert.deepStrictEqual(await reader.foreignKeyCheck(), { ok: true, violations: [] });
      await reader.close();
    }
    finally {
      cleanup();
    }
  });

  it('a binding that does not declare an operation: the capability says false and the call is JD2077', async () => {
    const driver = wasmDriver(declaringWasmHandle(
      { userFunctions: true, maintenance: { checkpoint: true, integrityCheck: false, foreignKeyCheck: true, optimize: false } }));
    const store = await openStore(MODEL, { driver });
    assert.deepStrictEqual(store.capabilities.maintenance,
      { checkpoint: true, integrityCheck: false, foreignKeyCheck: true, optimize: false, backup: false });
    await assert.rejects(store.integrityCheck(),
      (error) => error.code === 'JD2077' && error.message.includes('does not declare'));
    await assert.rejects(store.optimize(), (error) => error.code === 'JD2077');
    assert.deepStrictEqual(await store.foreignKeyCheck(), { ok: true, violations: [] });
    await store.close();
  });

  it('a closed store refuses by name (JD2063), never with the driver\'s own error', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await store.close();
    for (const operation of MAINTENANCE_OPERATIONS) {
      await assert.rejects(store[operation](), (error) => error.code === 'JD2063', operation);
    }
  });
});

describe('the gate', () => {
  it('a maintenance operation waits for an open transaction rather than interleaving it', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await seeded(dbPath, 5);
      const order = [];
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      const transaction = store.transaction(async (tx) => {
        await tx.collection('notes').insert({ id: 'inside', body: 'b' });
        order.push('tx-open');
        await held;
        order.push('tx-done');
      });
      // issued while the transaction owns the connection: it must not run yet
      const checkpoint = store.checkpoint().then((result) => { order.push('checkpoint'); return result; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepStrictEqual(order, ['tx-open']);
      release();
      await transaction;
      const result = await checkpoint;
      assert.deepStrictEqual(order, ['tx-open', 'tx-done', 'checkpoint']);
      assert.strictEqual(typeof result.logFrames, 'number');
      await store.close();
    }
    finally {
      cleanup();
    }
  });
});

describe('the spellings', () => {
  it('the dialect spells every maintenance pragma with guarded arguments', () => {
    assert.strictEqual(sqliteDialect.pragma.walCheckpoint('truncate'), 'PRAGMA wal_checkpoint(truncate)');
    assert.strictEqual(sqliteDialect.pragma.integrityCheck(undefined), 'PRAGMA integrity_check');
    assert.strictEqual(sqliteDialect.pragma.integrityCheck(5), 'PRAGMA integrity_check(5)');
    assert.strictEqual(sqliteDialect.pragma.optimize(), 'PRAGMA optimize');
    assert.throws(() => sqliteDialect.pragma.walCheckpoint('truncate); DROP TABLE x; --'), TypeError);
    assert.throws(() => sqliteDialect.pragma.integrityCheck(Number.NaN), TypeError);
  });
});
