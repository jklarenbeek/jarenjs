//@ts-check
/**
 * @file A hold limit bounds how long a transaction body may hold the
 * connection (MODEL-FORMAT §5.1). At the limit the transaction is rolled
 * back and the connection handed on — another transaction commits while
 * the body still awaits — every handle of the rolled-back transaction
 * refuses `JD2098`, and when the body finally settles the caller gets
 * `JD2098` carrying `holdTimeoutMs` and `elapsedMs`. Before, nothing
 * bounded a held transaction: a 1 s await committed after 1,002 ms under
 * every option, and PostgreSQL's server-side timeouts were 0. On an
 * asynchronous host a handle operation already under way at the limit
 * finishes first — its statements land in the transaction that is then
 * rolled back — so no statement of the expired body ever reaches the
 * connection after it was handed on.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { postgresDriver } from '@jarenjs/db/postgres';
import { tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    docs: { schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, key: '/id', indexes: [] },
  },
};

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** @param {string} code */
const coded = (code) => (/** @type {any} */ error) => error?.code === code;

/**
 * The acceptance scenario on one host: a body writes, then awaits 2 s
 * under a 500 ms limit; another transaction commits during the await;
 * the body's later write refuses JD2098; nothing of it is committed.
 * @param {any} store
 */
async function heldTooLong(store) {
  const docs = store.collection('docs');
  /** @type {string[]} */
  const events = [];
  /** @type {unknown} */
  let laterWrite;
  const started = performance.now();
  const held = store.transaction(async (/** @type {any} */ tx) => {
    await tx.collection('docs').put({ id: 'held' }, 'held');
    await sleep(2000);
    try {
      await tx.collection('docs').put({ id: 'late' }, 'late');
    }
    catch (error) { laterWrite = error; }
  }, { holdTimeoutMs: 500 });
  const outcome = held.then(() => 'committed', (error) => { events.push('held rejected'); return error; });
  await sleep(600);
  await store.transaction(async (/** @type {any} */ tx) => { await tx.collection('docs').put({ id: 'other' }, 'other'); });
  events.push('other committed');
  const error = /** @type {any} */ (await outcome);
  assert.equal(error.code, 'JD2098');
  assert.equal(error.holdTimeoutMs, 500);
  assert.ok(error.elapsedMs >= 500 && error.elapsedMs <= 700, `elapsedMs ${error.elapsedMs} in [500, 700]`);
  assert.ok(performance.now() - started >= 1900, 'the caller heard it only once the body had settled');
  assert.deepEqual(events, ['other committed', 'held rejected'], 'another transaction committed during the await');
  assert.equal(/** @type {any} */ (laterWrite)?.code, 'JD2098', 'the late write through the handle refused');
  assert.equal(await docs.get('held'), undefined, 'nothing of the body was committed');
  assert.equal(await docs.get('late'), undefined);
  assert.deepEqual(await docs.get('other'), { id: 'other' });
}

/**
 * A nested transaction still awaiting when its root's limit passes: when
 * it settles late — while the NEXT owner is in the middle of its own
 * transaction — it restores no scope and releases no savepoint (on
 * PostgreSQL one stray failing statement would abort that owner's
 * transaction). The next owner commits both of its writes.
 * @param {any} store
 */
async function nestedOutlivesItsRoot(store) {
  const docs = store.collection('docs');
  const held = store.transaction(async (/** @type {any} */ tx) => {
    await tx.transaction(async (/** @type {any} */ inner) => {
      await inner.collection('docs').put({ id: 'nested' }, 'nested');
      await sleep(400);
    });
  }, { holdTimeoutMs: 100 });
  const outcome = held.then(() => null, (/** @type {any} */ error) => error);
  await sleep(150);
  await store.transaction(async (/** @type {any} */ tx) => {
    await tx.collection('docs').put({ id: 'o1' }, 'o1');
    await sleep(400);
    await tx.collection('docs').put({ id: 'o2' }, 'o2');
  });
  const error = await outcome;
  assert.equal(error?.code, 'JD2098');
  assert.deepEqual(await docs.get('o1'), { id: 'o1' });
  assert.deepEqual(await docs.get('o2'), { id: 'o2' });
  assert.equal(await docs.get('nested'), undefined);
  // the store is whole afterwards
  await store.transaction(async (/** @type {any} */ tx) => { await tx.collection('docs').put({ id: 'after' }, 'after'); });
  assert.deepEqual(await docs.get('after'), { id: 'after' });
}

describe('holdTimeoutMs', () => {
  it('counts the synchronous extent and checks the deadline before settling a body', async (t) => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const store = await openStore(MODEL, { driver: nodeDriver() });
    try {
      for (const asynchronous of [false, true]) {
        const body = (tx) => {
          tx.sync.collection('docs').put({ id: 'overdue' }, 'overdue');
          now += 1001;
          return 'too late';
        };
        await assert.rejects(store.transaction(asynchronous ? async (tx) => body(tx) : body,
          { holdTimeoutMs: 1000 }), (error) => {
          assert.equal(error.code, 'JD2098');
          assert.equal(error.elapsedMs, 1001);
          return true;
        });
        assert.equal(await store.collection('docs').get('overdue'), undefined);
      }
    }
    finally { await store.close(); }
  });

  it('fences overdue handles and rolls back capture even when microtasks keep the timer from firing', async (t) => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    for (const mode of ['session', 'journal']) {
      const store = await openStore(MODEL, { driver: nodeDriver(), capture: { mode } });
      const recorded = [];
      store.observe((record) => { for (const op of record.patch) recorded.push(`${op.op} ${op.path}`); });
      let expired;
      try {
        await assert.rejects(store.transaction(async (tx) => {
          expired = tx;
          await tx.collection('docs').put({ id: 'before' }, 'before');
          now += 1001;
          await Promise.resolve();
          await assert.rejects(tx.collection('docs').put({ id: 'after' }, 'after'), coded('JD2098'));
          // Catching the handle's timeout cannot turn the body into a commit.
          return 'caught';
        }, { holdTimeoutMs: 1000 }), coded('JD2098'));
        assert.equal(await store.collection('docs').get('before'), undefined);
        assert.equal(await store.collection('docs').get('after'), undefined);
        await assert.rejects(expired.collection('docs').get('before'), coded('JD2098'));
        let completed;
        await store.transaction(async (tx) => {
          completed = tx;
          await tx.collection('docs').put({ id: 'next' }, 'next');
        }, { holdTimeoutMs: 1000 });
        now += 1001;
        await assert.rejects(completed.collection('docs').get('next'), coded('JD2070'));
        assert.deepEqual(recorded, ['add /docs/next'], mode);
      }
      finally { await store.close(); }
    }
  });

  it('in-thread SQLite: rolled back at the limit, the connection handed on, the handle fenced', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    try { await heldTooLong(store); }
    finally { await store.close(); }
  });

  it('node-worker: the same', async () => {
    const { dbPath, cleanup } = tempDbPath();
    const store = await openStore(MODEL, { driver: nodeWorkerDriver(), path: dbPath });
    try { await heldTooLong(store); }
    finally {
      await store.close();
      cleanup();
    }
  });

  it('node-worker: a statement in flight at the limit completes, and is then rolled back with the rest', async () => {
    const { dbPath, cleanup } = tempDbPath();
    const store = await openStore(MODEL, { driver: nodeWorkerDriver(), path: dbPath });
    try {
      /** @type {unknown} */
      let slow;
      /** @type {unknown} */
      let after;
      const held = store.transaction(async (/** @type {any} */ tx) => {
        await tx.collection('docs').put({ id: 'before' }, 'before');
        // ~500 ms of work on the worker, in flight when the 100 ms limit passes
        slow = await tx.sql.prepare('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000000) '
          + 'SELECT count(*) AS n FROM c', { access: 'read' }).get([]);
        try { await tx.collection('docs').put({ id: 'after' }, 'after'); }
        catch (error) { after = error; }
      }, { holdTimeoutMs: 100 });
      await assert.rejects(held, coded('JD2098'));
      assert.deepEqual(slow, { n: 3000000 }, 'the operation under way finished and answered');
      assert.equal(/** @type {any} */ (after)?.code, 'JD2098');
      assert.equal(await store.collection('docs').get('before'), undefined, 'rolled back after the in-flight statement');
      assert.equal(await store.collection('docs').get('after'), undefined);
    }
    finally {
      await store.close();
      cleanup();
    }
  });

  it('in-thread SQLite: a nested transaction that outlives its root settles into nothing', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    try { await nestedOutlivesItsRoot(store); }
    finally { await store.close(); }
  });

  it('the store default applies, a call overrides it, and a body inside the limit commits', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), holdTimeoutMs: 100 });
    await assert.rejects(store.transaction(async (tx) => { await sleep(300); await tx.collection('docs').put({ id: 'x' }, 'x'); }),
      (/** @type {any} */ error) => error.code === 'JD2098' && error.holdTimeoutMs === 100);
    await store.transaction(async (tx) => { await sleep(300); await tx.collection('docs').put({ id: 'y' }, 'y'); }, { holdTimeoutMs: 2000 });
    assert.deepEqual(await store.collection('docs').get('y'), { id: 'y' });
    assert.equal(await store.collection('docs').get('x'), undefined);
    await store.close();
  });

  it('with change capture: the expired transaction records nothing, and the next one records as usual', async () => {
    for (const mode of ['session', 'journal']) {
      const store = await openStore(MODEL, { driver: nodeDriver(), capture: { mode } });
      /** @type {string[]} */
      const recorded = [];
      store.observe((record) => { for (const op of record.patch) recorded.push(`${op.op} ${op.path}`); });
      await assert.rejects(store.transaction(async (tx) => {
        await tx.collection('docs').put({ id: 'held' }, 'held');
        await sleep(300);
      }, { holdTimeoutMs: 100 }), coded('JD2098'));
      await store.transaction(async (tx) => { await tx.collection('docs').put({ id: 'next' }, 'next'); });
      assert.deepEqual(recorded, ['add /docs/next'], `${mode}: only the committed transaction was recorded`);
      await store.close();
    }
  });

  it('holdTimeoutMs cannot act on the synchronous twin or a nested transaction (JD0014); a malformed one is refused', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    assert.throws(() => store.sync?.transaction(() => {}, /** @type {any} */ ({ holdTimeoutMs: 100 })), coded('JD0014'));
    await store.transaction(async (tx) => {
      await assert.rejects(tx.transaction(async () => {}, /** @type {any} */ ({ holdTimeoutMs: 100 })), coded('JD0014'));
    });
    for (const holdTimeoutMs of [0, -1, 1.5, 2 ** 31, '100']) {
      await assert.rejects(store.transaction(async () => {}, /** @type {any} */ ({ holdTimeoutMs })), coded('JD0013'), String(holdTimeoutMs));
    }
    await store.close();
    await assert.rejects(openStore(MODEL, { driver: nodeDriver(), holdTimeoutMs: 0 }), coded('JD0009'));
  });
});

const url = process.env.JAREN_PG_URL;
describe('holdTimeoutMs on PostgreSQL', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let pg;
  /** @type {any} */
  let admin;
  const schema = `jaren_hold_${process.pid}`;
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

  it('the same: rolled back at the limit, the session handed on, the handle fenced', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    const store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }) });
    try { await heldTooLong(store); }
    finally {
      await store.close();
      await pool.end();
    }
  });

  it('a nested transaction that outlives its root settles into nothing — no stray statement aborts the next owner', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    const store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }) });
    try {
      await store.collection('docs').delete('o1');
      await store.collection('docs').delete('o2');
      await store.collection('docs').delete('after');
      await nestedOutlivesItsRoot(store);
    }
    finally {
      await store.close();
      await pool.end();
    }
  });
});
