//@ts-check
/**
 * @file A lost connection is one coded failure, and it never crashes the
 * process. Before: terminating an idle PostgreSQL Store's backend raised
 * two UNCAUGHT exceptions (`57P01` and "Connection terminated
 * unexpectedly" — Node exits without a handler) and the next call failed
 * uncoded; a COMMIT that lost its connection reported `retryable: true`;
 * `ECONNRESET` classified as JD2005 class `error`; and `close()` under a
 * live transaction handed the holder a `TransactionFailure` carrying a
 * raw `ERR_INVALID_STATE` from a ROLLBACK the closed connection could not
 * run. Now one rule (`errors.js`) makes every loss `JD2087`, class
 * `connection`, retryable only when no transaction outcome is at stake.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, classifyDriverError, wrapDriverError } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';

const MODEL = {
  $model: '0.1',
  collections: {
    docs: { schema: { type: 'object', properties: { id: { type: 'string' } } }, key: '/id', indexes: [] },
  },
};

describe('one connection-loss rule', () => {
  it('every loss shape classifies JD2087, class connection — SQLSTATE, errno and node-postgres\'s uncoded sentence', () => {
    for (const error of [
      Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }),
      Object.assign(new Error('the server is shutting down'), { code: '57P02' }),
      Object.assign(new Error('connection failure'), { code: '08006' }),
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      new Error('Connection terminated unexpectedly'),
      new Error('Client has encountered a connection error and is not queryable'),
    ]) {
      const classified = classifyDriverError(error);
      assert.deepEqual([classified.code, classified.class], ['JD2087', 'connection'], error.message);
      const wrapped = /** @type {any} */ (wrapDriverError(error));
      assert.equal(wrapped.code, 'JD2087', `${error.message} is wrapped, never raw`);
      assert.equal(wrapped.class, 'connection');
    }
    // a busy failure and an unrelated error keep their own classes
    assert.equal(classifyDriverError(Object.assign(new Error('serialization failure'), { code: '40001' })).class, 'busy');
    assert.equal(wrapDriverError(new Error('Connection is fine, thanks')).code, undefined);
  });

  it('close() under a live transaction hands the holder JD2063 — no TransactionFailure, no raw state error', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    /** @type {(v?: any) => void} */
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const running = store.transaction(async (tx) => {
      await tx.collection('docs').put({ id: 'a' });
      await gate;
      await tx.collection('docs').put({ id: 'b' });
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const closing = store.close();
    release();
    await assert.rejects(running, (/** @type {any} */ error) => {
      assert.equal(error instanceof AggregateError, false, 'not a TransactionFailure');
      assert.equal(error.code, 'JD2063');
      return true;
    });
    await closing;
  });
});

const url = process.env.JAREN_PG_URL;
describe('a lost PostgreSQL session', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let pg;
  /** @type {any} */
  let admin;
  const schema = `jaren_loss_${process.pid}`;
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

  /** Terminate every backend of this pool but the admin's own. */
  const terminate = async (/** @type {string} */ application) => {
    const { rows } = await admin.query(
      'SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()', [application]);
    for (const row of rows) await admin.query('SELECT pg_terminate_backend($1)', [row.pid]);
    return rows.length;
  };

  /** Run `fn` with uncaught exceptions recorded instead of fatal. */
  const recordingUncaught = async (/** @type {(uncaught: unknown[]) => Promise<void>} */ fn) => {
    /** @type {unknown[]} */
    const uncaught = [];
    const listener = (/** @type {unknown} */ error) => { uncaught.push(error); };
    process.on('uncaughtException', listener);
    try { await fn(uncaught); }
    finally { process.off('uncaughtException', listener); }
  };

  it('terminating an idle Store\'s backend raises nothing uncaught; the next call is JD2087, retryable', async () => {
    await recordingUncaught(async (uncaught) => {
      const application = `jaren-loss-idle-${process.pid}`;
      const pool = new pg.Pool({ connectionString: url, max: 2, application_name: application });
      const store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }) });
      try {
        await store.collection('docs').put({ id: 'a' });
        assert.ok(await terminate(application) >= 1);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await assert.rejects(store.collection('docs').get('a'), (/** @type {any} */ error) =>
          error.code === 'JD2087' && error.class === 'connection' && error.retryable === true);
        assert.deepEqual(uncaught, []);
      }
      finally {
        await store.close().catch(() => {});
        await pool.end().catch(() => {});
      }
    });
  });

  it('a transaction whose session is lost before COMMIT rejects JD2087 with retryable: false', async () => {
    await recordingUncaught(async (uncaught) => {
      const application = `jaren-loss-tx-${process.pid}`;
      const pool = new pg.Pool({ connectionString: url, max: 2, application_name: application });
      const store = await openStore(MODEL, { driver: postgresDriver(pool, { schema }) });
      try {
        await assert.rejects(store.transaction(async (tx) => {
          await tx.collection('docs').put({ id: 'in-flight' });
          await terminate(application);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }), (/** @type {any} */ error) => {
          const primary = error instanceof AggregateError ? error.errors[0] : error;
          assert.equal(primary.code, 'JD2087');
          assert.equal(primary.retryable, false, 'the transaction outcome was at stake');
          return true;
        });
        assert.deepEqual(uncaught, []);
      }
      finally {
        await store.close().catch(() => {});
        await pool.end().catch(() => {});
      }
    });
  });
});
