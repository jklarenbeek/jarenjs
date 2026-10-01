//@ts-check
/**
 * @file `mode: 'immediate'` and `isolation` on PostgreSQL, against a real
 * server (MODEL-FORMAT §5.1, POSTGRESQL.md).
 *
 * `immediate` takes the store's writer lock before the body runs — a
 * transaction-scoped advisory lock of its own class, keyed by the store's
 * schema — so two read-then-write bodies on two stores cannot lose an
 * update: at the default `read committed` the second waits, then reads the
 * first one's commit. The lock orders immediate transactions among
 * themselves only; a plain write takes row locks and never waits for it.
 * A lock wait is bounded by the session's `lock_timeout` (55P03, busy and
 * retryable) and is not counted against the hold limit.
 *
 * `isolation` is a floor: the level asked for or the session's stronger
 * default runs, and `tx.isolation` reports the level that ran. Under
 * `serializable` two concurrent read-then-write transactions produce one
 * commit and one retryable busy refusal, which `retry` absorbs.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { openStore } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';
import { POSTGRES_LOCK_CLASSES } from '../../packages/db/src/dialects/postgres-locks.js';

const url = process.env.JAREN_PG_URL;
const MODEL = {
  $model: '0.1',
  collections: {
    docs: {
      schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' } }, required: ['id'] },
      key: '/id',
      indexes: [],
    },
  },
};

/** A promise plus its resolver. */
const defer = () => {
  /** @type {(v?: any) => void} */
  let resolve = () => {};
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

describe('PostgreSQL: the writer lock and the isolation floor', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let pg;
  /** @type {any} */
  let admin;
  const schema = `jaren_isolation_${process.pid}`;
  /** @type {any[]} */
  const pools = [];
  /** @type {any[]} */
  const stores = [];

  before(async () => {
    pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
  });
  after(async () => {
    for (const store of stores.splice(0)) await store.close().catch(() => {});
    for (const pool of pools.splice(0)) await pool.end().catch(() => {});
    if (admin) {
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });

  /** A store on a pool of its own (one session), closed after the file.
   * @param {Record<string, any>} [driverOptions] @param {Record<string, any>} [storeOptions]
   * @param {string} [sessionOptions] */
  const storeOn = async (driverOptions = {}, storeOptions = {}, sessionOptions = undefined) => {
    const pool = new pg.Pool({ connectionString: url, max: 1, ...(sessionOptions === undefined ? {} : { options: sessionOptions }) });
    pools.push(pool);
    const store = await openStore(MODEL, { driver: postgresDriver(pool, { schema, ...driverOptions }), ...storeOptions });
    stores.push(store);
    return store;
  };
  /** Wait until some session waits for the writer lock. */
  const writerLockWaited = async () => {
    for (let i = 0; i < 500; i++) {
      // this schema's writer lock only: other files take their own meanwhile
      // (the writer lock's second key is the schema's OID, shifted into int4)
      const { rows } = await admin.query("SELECT count(*)::int AS n FROM pg_catalog.pg_locks WHERE locktype = 'advisory' "
        + 'AND NOT granted AND classid = $1::oid AND objid = (((SELECT n.oid FROM pg_catalog.pg_namespace n '
        + 'WHERE n.nspname = $2)::int8 - 2147483648) & 4294967295)::oid',
      [POSTGRES_LOCK_CLASSES.writer, schema]);
      if (rows[0].n > 0) return;
      await delay(10);
    }
    throw new Error('no session waited for the writer lock');
  };
  /** @param {any} store @param {string} key */
  const valueOf = async (store, key) => (await store.collection('docs').get(key))?.n;

  it('capabilities: immediate takes the writer lock, and the three levels are listed', async () => {
    const store = await storeOn();
    assert.equal(store.capabilities.immediateTransactions, true);
    assert.deepEqual([...store.capabilities.isolation], ['read committed', 'repeatable read', 'serializable']);
  });

  it('two immediate read-then-write transactions on two stores both commit, and the final value is 2', async () => {
    const a = await storeOn();
    const b = await storeOn();
    await a.collection('docs').put({ id: 'lost', n: 0 }, 'lost');
    const aRead = defer();
    const aProceed = defer();
    /** @type {{ store: string, read: number, attempt: number }[]} */
    const bodies = [];
    const first = a.transaction(async (tx) => {
      const doc = await tx.collection('docs').get('lost');
      aRead.resolve();
      await aProceed.promise;
      await tx.collection('docs').put({ id: 'lost', n: doc.n + 1 }, 'lost');
      bodies.push({ store: 'a', read: doc.n, attempt: tx.attempt });
    }, { mode: 'immediate' });
    await aRead.promise;
    const second = b.transaction(async (tx) => {
      const doc = await tx.collection('docs').get('lost');
      await tx.collection('docs').put({ id: 'lost', n: doc.n + 1 }, 'lost');
      bodies.push({ store: 'b', read: doc.n, attempt: tx.attempt });
    }, { mode: 'immediate' });
    // b's body cannot start while a holds the writer lock
    await writerLockWaited();
    assert.equal(bodies.length, 0);
    aProceed.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(bodies, [{ store: 'a', read: 0, attempt: 1 }, { store: 'b', read: 1, attempt: 1 }]);
    assert.equal(await valueOf(a, 'lost'), 2, 'no lost update, no retry');
  });

  it('the writer lock orders immediate transactions only: a plain write and a deferred transaction never wait for it', async () => {
    const a = await storeOn();
    const b = await storeOn();
    const held = defer();
    const release = defer();
    const holder = a.transaction(async (tx) => {
      await tx.collection('docs').put({ id: 'held', n: 1 }, 'held');
      held.resolve();
      await release.promise;
    }, { mode: 'immediate' });
    await held.promise;
    await b.collection('docs').put({ id: 'plain', n: 1 }, 'plain');
    await b.transaction(async (tx) => { await tx.collection('docs').put({ id: 'deferred', n: 1 }, 'deferred'); });
    release.resolve();
    await holder;
    assert.equal(await valueOf(a, 'plain'), 1);
    assert.equal(await valueOf(a, 'deferred'), 1);
  });

  it('under serializable, two concurrent read-then-write transactions: one commits, one is refused busy and retryable; with retry both commit', async () => {
    const a = await storeOn();
    const b = await storeOn();
    for (const withRetry of [false, true]) {
      const key = withRetry ? 'ssi-retry' : 'ssi';
      await a.collection('docs').put({ id: key, n: 0 }, key);
      let reads = 0;
      const bothRead = defer();
      /** @param {any} store */
      const body = (store) => store.transaction(async (/** @type {any} */ tx) => {
        const doc = await tx.collection('docs').get(key);
        if (++reads === 2) bothRead.resolve();
        await bothRead.promise;
        await tx.collection('docs').put({ id: key, n: doc.n + 1 }, key);
        return tx.isolation;
      }, { isolation: 'serializable', ...(withRetry ? { retry: { attempts: 5, baseMs: 1, maxMs: 5 } } : {}) });
      const settled = await Promise.allSettled([body(a), body(b)]);
      if (!withRetry) {
        const fulfilled = settled.filter((s) => s.status === 'fulfilled');
        const rejected = /** @type {PromiseRejectedResult[]} */ (settled.filter((s) => s.status === 'rejected'));
        assert.equal(fulfilled.length, 1, 'one commits');
        assert.equal(/** @type {any} */ (fulfilled[0]).value, 'serializable');
        assert.equal(rejected.length, 1, 'one is refused');
        const error = rejected[0].reason;
        assert.equal(error.code, 'JD2005');
        assert.equal(error.class, 'busy');
        assert.equal(error.retryable, true);
        assert.equal(error.cause?.code, '40001');
        assert.equal(await valueOf(a, key), 1);
      }
      else {
        assert.deepEqual(settled.map((s) => s.status), ['fulfilled', 'fulfilled']);
        assert.equal(await valueOf(a, key), 2, 'retry absorbed the conflict');
      }
    }
  });

  it('a writer-lock wait past lock_timeout is JD2005 busy and retryable (55P03), the body never ran, and the session stays usable', async () => {
    const a = await storeOn();
    const b = await storeOn({ lockTimeoutMs: 200 });
    const held = defer();
    const release = defer();
    const holder = a.transaction(async () => {
      held.resolve();
      await release.promise;
    }, { mode: 'immediate' });
    await held.promise;
    let ran = false;
    const started = performance.now();
    await assert.rejects(b.transaction(async () => { ran = true; }, { mode: 'immediate' }),
      (/** @type {any} */ error) => error.code === 'JD2005' && error.class === 'busy' && error.retryable === true
        && error.cause?.code === '55P03');
    assert.ok(performance.now() - started >= 150, 'it waited for the lock timeout');
    assert.equal(ran, false);
    release.resolve();
    await holder;
    // the refused BEGIN was rolled back: the next transaction runs
    assert.equal(await b.transaction(async (tx) => {
      await tx.collection('docs').put({ id: 'after-timeout', n: 1 }, 'after-timeout');
      return tx.attempt;
    }, { mode: 'immediate' }), 1);
    assert.equal(await valueOf(a, 'after-timeout'), 1);
  });

  it('the hold limit counts from the body: a 1 s writer-lock wait under holdTimeoutMs 500 commits', async () => {
    const a = await storeOn();
    const b = await storeOn();
    const held = defer();
    const holder = a.transaction(async () => {
      held.resolve();
      await delay(1000);
    }, { mode: 'immediate' });
    await held.promise;
    const started = performance.now();
    await b.transaction(async (tx) => {
      await tx.collection('docs').put({ id: 'held-wait', n: 1 }, 'held-wait');
    }, { mode: 'immediate', holdTimeoutMs: 500 });
    assert.ok(performance.now() - started >= 800, 'it waited for the holder');
    await holder;
    assert.equal(await valueOf(a, 'held-wait'), 1);
  });

  it('tx.isolation reports the level that ran; a call overrides the store default', async () => {
    const levelInside = (/** @type {any} */ tx) => tx.sql.prepare("SELECT current_setting('transaction_isolation') AS level",
      { access: 'read' }).get().then((/** @type {any} */ row) => row.level);
    const plain = await storeOn();
    assert.deepEqual(await plain.transaction(async (tx) => [tx.isolation, await levelInside(tx)]),
      ['read committed', 'read committed']);
    for (const isolation of /** @type {const} */ (['read committed', 'repeatable read', 'serializable'])) {
      for (const mode of /** @type {const} */ (['deferred', 'immediate'])) {
        assert.deepEqual(await plain.transaction(async (tx) => [tx.isolation, await levelInside(tx),
          await tx.transaction(async (inner) => inner.isolation)], { isolation, mode }), [isolation, isolation, isolation],
        `${isolation} ${mode}`);
      }
    }
    const strict = await storeOn({}, { isolation: 'serializable' });
    assert.deepEqual(await strict.transaction(async (tx) => [tx.isolation, await levelInside(tx)]),
      ['serializable', 'serializable']);
    assert.deepEqual(await strict.transaction(async (tx) => [tx.isolation, await levelInside(tx)], { isolation: 'repeatable read' }),
      ['repeatable read', 'repeatable read'], "the call's own level wins over the store default");
  });

  it("a floor never weakens the session's own default: a stronger default runs and is reported", async () => {
    const store = await storeOn({}, {}, '-c default_transaction_isolation=repeatable\\ read');
    const levelInside = (/** @type {any} */ tx) => tx.sql.prepare("SELECT current_setting('transaction_isolation') AS level",
      { access: 'read' }).get().then((/** @type {any} */ row) => row.level);
    assert.deepEqual(await store.transaction(async (tx) => [tx.isolation, await levelInside(tx)]),
      ['repeatable read', 'repeatable read']);
    assert.deepEqual(await store.transaction(async (tx) => [tx.isolation, await levelInside(tx)], { isolation: 'read committed' }),
      ['repeatable read', 'repeatable read'], 'read committed is below the floor the session already runs');
    assert.deepEqual(await store.transaction(async (tx) => [tx.isolation, await levelInside(tx)], { isolation: 'serializable' }),
      ['serializable', 'serializable']);
  });
});
