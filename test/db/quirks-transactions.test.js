//@ts-check
/**
 * @file Transaction quirks, each reproduced and pinned:
 *
 * 1. A hold limit gave the capture engine up while a nested scope of the
 *    expired body still ran; that scope's late failure truncated the NEXT
 *    owner's journal — committed rows went missing from the change log.
 * 2. After `close()`, a hold limit's giving-up threw from a closed
 *    session: an unhandled rejection, and a transaction that never settled.
 * 3. `store.transaction` called from inside a transaction's synchronous
 *    extent is nested by the driver, but read the ROOT option set: a
 *    `retry` deadlocked, a hold limit abandoned the outer's capture scope.
 * 4. `elapsedMs` was stamped at the limit, not when the rollback began.
 * 5. An edit staged after a save, on the row the save inserted, was
 *    dropped when a savepoint rolled the save back.
 * 6–10 (PostgreSQL): a lost autocommit write reported `retryable: true`
 *    though it committed; a `SELECT fn()` declared for writing did too;
 *    `queueTimeout` on the driver went unvalidated; one poisoned error was
 *    thrown to every later call, carrying the first caller's `attempts`;
 *    capture's lock wait counted against the hold limit.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { postgresDriver } from '@jarenjs/db/postgres';
import { pgLossProxy } from './helpers.js';

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
const coded = (/** @type {string} */ code) => (/** @type {any} */ e) => e?.code === code;
const DOCS = { $model: '0.1', collections: { docs: { schema: { type: 'object', properties: { id: { type: 'string' }, tags: { type: 'array' } } }, key: '/id', indexes: [] } } };

describe('transaction quirks', () => {
  it('1. an expired body\'s late nested failure leaves the next owner\'s journal whole', async () => {
    const store = await openStore(DOCS, { driver: nodeDriver(), capture: { mode: 'journal', log: true } });
    try {
      /** @type {string[]} */
      const observed = [];
      store.observe((record) => { for (const op of record.patch) observed.push(`${op.op} ${op.path}`); });
      const expired = store.transaction(async (tx) => {
        await tx.transaction(async (inner) => { await sleep(300); await inner.collection('docs').put({ id: 'late' }); });
      }, { holdTimeoutMs: 100 }).catch((/** @type {any} */ e) => e.code);
      await sleep(150);
      await store.transaction(async (tx) => {
        await tx.collection('docs').put({ id: 'a' });
        await tx.collection('docs').put({ id: 'b' });
        await sleep(250);
        await tx.collection('docs').put({ id: 'c' });
      });
      assert.equal(await expired, 'JD2098');
      assert.deepEqual(observed, ['add /docs/a', 'add /docs/b', 'add /docs/c']);
      assert.deepEqual((await store.changesSince(0)).flatMap((r) => r.patch.map((op) => `${op.op} ${op.path}`)),
        ['add /docs/a', 'add /docs/b', 'add /docs/c'], 'the durable log agrees');
    }
    finally { await store.close(); }
  });

  it('2. a hold limit that fires after close() still settles the transaction, and nothing is unhandled', async () => {
    const store = await openStore(DOCS, { driver: nodeDriver(), capture: { mode: 'session' } });
    /** @type {unknown[]} */
    const unhandled = [];
    const onUnhandled = (/** @type {unknown} */ e) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const running = store.transaction(async (tx) => { await tx.collection('docs').put({ id: 'a' }); await sleep(300); }, { holdTimeoutMs: 100 });
      await sleep(50);
      await store.close();
      await assert.rejects(running, coded('JD2098'));
      await sleep(10);
      assert.deepEqual(unhandled, []);
    }
    finally { process.off('unhandledRejection', onUnhandled); }
  });

  it('3. store.transaction inside a transaction\'s synchronous extent is nested: the nested option set, and the outer keeps its writes', async () => {
    const store = await openStore(DOCS, { driver: nodeDriver(), capture: { mode: 'journal' }, holdTimeoutMs: 100 });
    try {
      await assert.rejects(store.transaction(() => store.transaction(async () => {}, { retry: { attempts: 2 } })), coded('JD0014'));
      await assert.rejects(store.transaction(() => store.transaction(async () => {}, { holdTimeoutMs: 50 })), coded('JD0014'));
      await assert.rejects(store.transaction(() => store.transaction(async () => {}, { mode: 'immediate' })), coded('JD0014'),
        'a deferred root took no writer lock the nested call could claim');
      // the nested body outlives the store default hold (100 ms) under the outer's own limit
      const out = await store.transaction((tx) => store.transaction(async () => { await sleep(150); return 'inner'; })
        .then(async (w) => { await tx.collection('docs').put({ id: 'outer' }); return w; }), { holdTimeoutMs: 2000 });
      assert.equal(out, 'inner');
      assert.equal((await store.collection('docs').get('outer'))?.id, 'outer');
    }
    finally { await store.close(); }
  });

  it('4. elapsedMs is when the rollback began: after the statement under way finished', async () => {
    const store = await openStore(DOCS, { driver: nodeWorkerDriver() });
    try {
      let finishedAt = 0;
      const started = performance.now();
      const error = await store.transaction(async (tx) => {
        await tx.sql.prepare('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000000) SELECT count(*) AS n FROM c', { access: 'read' }).get([]);
        finishedAt = performance.now() - started;
      }, { holdTimeoutMs: 50 }).catch((/** @type {any} */ e) => e);
      assert.equal(error.code, 'JD2098');
      assert.equal(error.holdTimeoutMs, 50);
      assert.ok(finishedAt > 50, 'the statement outlived the limit');
      assert.ok(error.elapsedMs >= Math.floor(finishedAt) - 5, `elapsedMs ${error.elapsedMs} vs the statement's end ${Math.round(finishedAt)}`);
    }
    finally { await store.close(); }
  });

  it('5. an edit staged after a save survives the savepoint rollback that took the save back', async () => {
    const MODEL = { $model: '0.1', entities: { Post: { schema: { type: 'object', required: ['pid'], properties: {
      pid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, title: { type: 'string' } } } } } };
    const store = await openStore(MODEL, { driver: nodeDriver() });
    try {
      await store.transaction(async (tx) => {
        tx.entity('Post').add({ title: 'a' });
        await tx.transaction(async (inner) => {
          await inner.saveChanges();
          inner.entity('Post').put({ pid: 1, title: 'b' });
          inner.entity('Post').remove(99);
          throw new Error('undo the savepoint');
        }).catch(() => {});
        await tx.saveChanges();
      });
      assert.deepEqual(/** @type {any[]} */ (await store.entity('Post').load()).map((p) => ({ ...p })), [{ pid: 1, title: 'b' }]);
    }
    finally { await store.close(); }
  });
});

const url = process.env.JAREN_PG_URL;
describe('transaction quirks on PostgreSQL', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let pg;
  /** @type {any} */
  let admin;
  const schema = `jaren_quirks_tx_${process.pid}`;
  before(async () => {
    pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
  });
  after(async () => {
    if (admin) {
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });
  /** A store whose session runs through a proxy that can lose a reply. */
  const lossy = async () => {
    const target = Number(new URL(/** @type {string} */ (url)).port || 5432);
    const proxy = await pgLossProxy(target);
    const through = new URL(/** @type {string} */ (url));
    through.port = String(proxy.port);
    const pool = new pg.Pool({ connectionString: through.toString(), max: 1 });
    pool.on('error', () => {});
    const store = await openStore(DOCS, { driver: postgresDriver(pool, { schema }) });
    return { store, proxy, close: async () => { await store.close().catch(() => {}); await pool.end().catch(() => {}); proxy.close(); } };
  };

  it('6. an autocommit write whose reply was lost is JD2087 retryable: false — it may have committed', async () => {
    const { store, proxy, close } = await lossy();
    try {
      await store.collection('docs').put({ id: 'k', tags: [] });
      // a put is one autocommit statement (a patch reads and writes in a
      // transaction of its own, which the next case covers)
      proxy.arm('INSERT');
      const error = await store.collection('docs').put({ id: 'k', tags: ['x'] }).catch((/** @type {any} */ e) => e);
      assert.deepEqual([error.code, error.class, error.retryable], ['JD2087', 'connection', false]);
      const row = (await admin.query(`SELECT doc FROM "${schema}"."docs" WHERE key = 'k'`)).rows[0].doc;
      assert.deepEqual(row.tags, ['x'], 'it had committed — a retry would have applied it twice');
      // 9: every later call is refused with an error of its own
      const first = await store.transaction(async () => {}, { retry: { attempts: 5 } }).catch((/** @type {any} */ e) => e);
      const second = await store.collection('docs').get('k').catch((/** @type {any} */ e) => e);
      assert.equal(first.code, 'JD2087');
      assert.equal(second.code, 'JD2087');
      assert.notEqual(first, second, 'not one object thrown to every caller');
      assert.equal(second.attempts, undefined, "the first caller's attempts stay the first caller's");
    }
    finally { await close(); }
  });

  it('6b. a patch whose UPDATE reply was lost inside its own transaction is one JD2087, and nothing committed', async () => {
    const { store, proxy, close } = await lossy();
    try {
      await store.collection('docs').put({ id: 'p', tags: [] });
      proxy.arm('UPDATE');
      const error = await store.collection('docs').patch('p', [{ op: 'add', path: '/tags/-', value: 'x' }]).catch((/** @type {any} */ e) => e);
      // the failed ROLLBACK on the lost session is the same failure, not a second one
      assert.equal(error instanceof AggregateError, false, 'not a TransactionFailure');
      assert.deepEqual([error.code, error.class, error.retryable], ['JD2087', 'connection', false]);
      const row = (await admin.query(`SELECT doc FROM "${schema}"."docs" WHERE key = 'p'`)).rows[0].doc;
      assert.deepEqual(row.tags, [], 'its transaction never committed: the server rolled it back with the session');
    }
    finally { await close(); }
  });

  it('7. a statement declared for writing counts as a write whatever its text: a lost COMMIT is retryable: false', async () => {
    await admin.query(`CREATE TABLE "${schema}".ledger (n int)`);
    await admin.query(`CREATE FUNCTION "${schema}".bump() RETURNS int LANGUAGE sql AS $$ INSERT INTO "${schema}".ledger VALUES (1) RETURNING n $$`);
    const { store, proxy, close } = await lossy();
    try {
      const error = await store.transaction(async (tx) => {
        await tx.sql.prepare(`SELECT "${schema}".bump() AS n`, { access: 'write' }).get([]);
        proxy.arm('COMMIT');
      }).catch((/** @type {any} */ e) => e);
      assert.deepEqual([error.code, error.retryable], ['JD2087', false]);
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM "${schema}".ledger`)).rows[0].n, 1);
    }
    finally { await close(); }
  });

  it('8. the driver\'s queueTimeout follows the store\'s rule', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      for (const queueTimeout of [Infinity, -5, 1.5, '100']) {
        assert.throws(() => postgresDriver(pool, { schema, queueTimeout: /** @type {any} */ (queueTimeout) }), coded('JD0003'), String(queueTimeout));
      }
      assert.doesNotThrow(() => postgresDriver(pool, { schema, queueTimeout: 250 }));
    }
    finally { await pool.end(); }
  });

  it('10. capture\'s lock wait is not held against the hold limit', async () => {
    const pa = new pg.Pool({ connectionString: url, max: 1 });
    const pb = new pg.Pool({ connectionString: url, max: 1 });
    const a = await openStore(DOCS, { driver: postgresDriver(pa, { schema }), capture: { mode: 'journal', log: true } });
    const b = await openStore(DOCS, { driver: postgresDriver(pb, { schema }), capture: { mode: 'journal', log: true } });
    try {
      const holding = b.transaction(async (tx) => { await tx.collection('docs').put({ id: 'b' }); await sleep(400); });
      await sleep(50);
      await a.transaction(async (tx) => { await tx.collection('docs').put({ id: 'a' }); }, { holdTimeoutMs: 150 });
      await holding;
      assert.equal((await a.collection('docs').get('a'))?.id, 'a', 'a body of a moment committed after its wait');
    }
    finally { await a.close(); await b.close(); await pa.end(); await pb.end(); }
  });
});
