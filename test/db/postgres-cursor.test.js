//@ts-check
/** Resource limits and settlement, over synthetic faults and actual servers. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { openStore, classifyDriverError } from '@jarenjs/db';
import { postgresDriver, adaptPostgresClient, postgresDialect, POSTGRES_DEFAULTS } from '@jarenjs/db/postgres';
import { workerQueue } from '../../packages/db/src/drivers/worker-queue.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const code = (value) => (error) => error.code === value;
const model = { $model: '0.1', collections: { notes: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' } } } } } };
const document = { $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it.id' };

describe('bounded PostgreSQL host protocol', () => {
  it('validates finite limits and refuses transaction poolers before acquisition', () => {
    const source = { connect: () => { throw new Error('must not acquire'); } };
    for (const key of Object.keys(POSTGRES_DEFAULTS)) {
      for (const value of [0, -1, Infinity, NaN, 1.5])
        assert.throws(() => postgresDriver(source, { [key]: value }), TypeError);
    }
    assert.throws(() => postgresDriver(source, { closeTimeoutMs: 2147483648 }), /timer range/);
    assert.throws(() => postgresDriver(source, { poolMode: 'transaction' }), code('JD0003'));
    assert.throws(() => postgresDriver(source, { prepared: 'automatic' }), /prepared/);
    assert.throws(() => postgresDriver(source, { cursorMode: 'automatic' }), /cursorMode/);
    const dialect = postgresDialect();
    assert.equal(dialect.isCreateRace({ code: '42710', routine: 'TypeCreate' }), true);
    assert.equal(dialect.isCreateRace({ code: '42710', routine: 'user_function' }), false);
    assert.equal(dialect.isCreateRace({ code: '23505', table: 'users', constraint: 'users_pkey' }), false);
  });
  it('removes aborted and expired queue entries without consuming the next credit', async () => {
    const queue = workerQueue([{ active: false, healthy: true, readOnly: false }], 2, () => 0);
    const first = await queue.acquire(false);
    const controller = new AbortController();
    const aborted = assert.rejects(queue.acquire(false, { signal: controller.signal }), code('JD2064'));
    controller.abort();
    await aborted;
    await assert.rejects(queue.acquire(false, { timeoutMs: 10 }), code('JD2091'));
    assert.equal(queue.metrics().queued, 0);
    first.release();
    const next = await queue.acquire(false);
    next.release();
    assert.equal(queue.metrics().active, 0);
    await assert.rejects(queue.acquire(false, { signal: controller.signal }), code('JD2064'));
  });
  it('quarantines an acquisition credit until the late source has actually released', async () => {
    const opening = deferred(), releasing = deferred();
    let releases = 0;
    const driver = postgresDriver({ connect: () => opening.promise }, {
      maxConnections: 1, acquisitionTimeoutMs: 10, queueCapacity: 1,
    });
    await assert.rejects(driver.open(), code('JD2091'));
    assert.equal(driver.metrics().active, 1);
    opening.resolve({ query: () => {}, release: () => { releases++; return releasing.promise; } });
    await delay(0);
    assert.equal(driver.metrics().active, 1);
    releasing.resolve();
    await delay(0);
    assert.equal(driver.metrics().active, 0);
    assert.equal(releases, 1);
  });
  it('discards on bounded close, never running late cleanup against a new lease', async () => {
    const pending = deferred(), entered = deferred();
    const trace = [], releases = [];
    const raw = adaptPostgresClient({ query: (sql) => {
      trace.push(sql); entered.resolve(); return pending.promise;
    }, release: (error) => releases.push(error) }, { closeTimeoutMs: 10 });
    const run = raw.exec('SELECT blocked');
    await entered.promise;
    const closing = raw.close();
    assert.equal(raw.close(), closing);
    await assert.rejects(closing, code('JD2090'));
    assert.equal(releases.length, 1);
    pending.resolve({ rows: [], command: 'SELECT' });
    await run;
    await delay(0);
    assert.deepEqual(trace, ['SELECT blocked']);
    assert.equal(releases.length, 1);
    await assert.rejects(raw.exec('SELECT next'), code('JD2063'));
  });
  it('an abort during source acquisition retains capacity until the late client settles', async () => {
    const opening = deferred(), entered = deferred();
    const controller = new AbortController();
    let releases = 0;
    const driver = postgresDriver({ connect: () => { entered.resolve(); return opening.promise; } }, { maxConnections: 1 });
    const pending = assert.rejects(driver.open(undefined, { signal: controller.signal }), code('JD2064'));
    await entered.promise;
    controller.abort();
    await pending;
    assert.equal(driver.metrics().active, 1);
    opening.resolve({ query: () => {}, release: () => { releases++; } });
    await delay(0);
    assert.equal(driver.metrics().active, 0);
    assert.equal(releases, 1);
  });
  it('includes session setup in the acquisition deadline and stops late initialization SQL', async () => {
    const response = deferred();
    const trace = [], releases = [];
    const driver = postgresDriver({ connect: () => ({
      query: (sql) => { trace.push(sql); return response.promise; },
      release: (error) => { releases.push(error); },
    }) }, { acquisitionTimeoutMs: 15, closeTimeoutMs: 15 });
    await assert.rejects(driver.open(), (error) => error instanceof AggregateError
      && error.errors[0].code === 'JD2091' && error.errors[1].code === 'JD2090');
    assert.equal(releases.length, 1);
    assert.equal(driver.metrics().active, 0);
    response.resolve({ rows: [{ statement_timeout: '0' }] });
    await delay(0);
    assert.deepEqual(trace, ['SHOW statement_timeout']);
  });
  it('close during cursor declaration never revives a settled cursor or its expiry timer', async () => {
    const entered = deferred(), declaring = deferred();
    const raw = adaptPostgresClient({ query: (query) => {
      const sql = typeof query === 'string' ? query : query.text;
      if (sql.startsWith('DECLARE')) { entered.resolve(); return declaring.promise; }
      return Promise.resolve({ rows: [], command: sql });
    } }, { nativeCursor: true, cursorLifetimeMs: 10 });
    const opening = raw.prepare('SELECT 1').iterate();
    await entered.promise;
    const closing = raw.close();
    declaring.resolve({ rows: [], command: 'DECLARE' });
    const cursor = await opening;
    await closing;
    await delay(20);
    assert.equal((await cursor.next()).done, true);
    assert.equal(raw.metrics().cursors, 0);
  });
});

const url = process.env.JAREN_PG_URL;
describe('PostgreSQL native cursor and deadline execution', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  let pg, pool, admin;
  const schema = `jaren_cursor_${process.pid}`;
  before(async () => {
    pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: url, max: 2 });
  });
  after(async () => {
    await pool?.end();
    if (admin) {
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });
  it('fetches one bounded frame before first row, and get fetches exactly one row', async () => {
    const connection = await postgresDriver(pool, { schema, windowRows: 7 }).open();
    try {
      const statement = await connection.prepare("SELECT n::int, repeat('x', 64) AS body FROM generate_series(1,100000) n");
      const before = connection.metrics().fetchedRows;
      const cursor = await statement.iterate();
      assert.equal((await cursor.next()).value.n, 1);
      assert.equal(connection.metrics().fetchedRows - before, 7);
      assert.equal(connection.metrics().peakRows, 7);
      await cursor.return();
      assert.equal(connection.metrics().cursors, 0);
      const beforeGet = connection.metrics().fetchedRows;
      assert.equal((await statement.get()).n, 1);
      assert.equal(connection.metrics().fetchedRows - beforeGet, 1);
      assert.equal(connection.metrics().transaction, 'committed');
    }
    finally { await connection.close(); }
    assert.equal(pool.totalCount, pool.idleCount);
  });
  it('refuses oversized frames and bounded all results, then reuses the settled session', async () => {
    const connection = await postgresDriver(pool, { schema, windowRows: 2, windowBytes: 128,
      allMaxRows: 3, allMaxBytes: 128 }).open();
    try {
      await assert.rejects((await connection.prepare("SELECT repeat('x',1024) AS body")).all(), code('JD2092'));
      await assert.rejects((await connection.prepare('SELECT n::int FROM generate_series(1,5) n')).all(), code('JD2092'));
      assert.equal(connection.metrics().cursors, 0);
      assert.deepEqual(await (await connection.prepare('SELECT 3 AS n')).get(), { n: 3 });
    }
    finally { await connection.close(); }
  });
  it('closes an abandoned Store cursor and drains or discards an active fetch within the close deadline', async () => {
    const store = await openStore(model, { driver: postgresDriver(pool, { schema }) });
    await store.collection('notes').put({ id: 'one' });
    const held = store.collection('notes').query(document);
    await held.next();
    await store.close();
    assert.equal((await held.next()).done, true);
    const fetching = deferred();
    const source = { connect: async () => {
      const client = await pool.connect();
      return { query: (query, values) => {
        if (typeof query === 'string' && query.startsWith('FETCH')) fetching.resolve();
        return client.query(query, values);
      }, getTransactionStatus: () => client.getTransactionStatus(), release: (e) => client.release(e) };
    } };
    const driver = postgresDriver(source, { schema, closeTimeoutMs: 40, statementTimeoutMs: 3000 });
    const connection = await driver.open();
    const cursor = await (await connection.prepare('SELECT pg_sleep(2)')).iterate();
    const pulling = assert.rejects(cursor.next());
    await fetching.promise;
    await assert.rejects(connection.close(), code('JD2090'));
    await pulling;
    assert.equal(driver.metrics().active, 0);
  });
  it('bounds direct cursor identities and never lets an earlier failed block poison later read effects', async () => {
    const connection = await postgresDriver(pool, { schema, maxCursors: 1 }).open();
    try {
      const statement = await connection.prepare('SELECT 1 AS n');
      const held = await statement.iterate();
      await assert.rejects(statement.iterate(), code('JD2091'));
      await held.return();
      await assert.rejects(connection.transaction(async (tx) => {
        await (await tx.prepare('SELECT 1 / 0')).get();
      }), code('22012'));
      await connection.exec('CREATE TABLE read_effect(n integer)');
      await connection.exec(`CREATE FUNCTION write_effect() RETURNS integer LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO read_effect VALUES (1); RETURN 1; END $$`);
      assert.equal((await (await connection.prepare('SELECT write_effect() AS n')).get()).n, 1);
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM "${schema}".read_effect`)).rows[0].n, 1);
      assert.deepEqual(await (await connection.prepare('WITH input AS (SELECT 2 AS n) SELECT n FROM input')).all(), [{ n: 2 }]);
      assert.deepEqual(await (await connection.prepare('WITH inserted AS (INSERT INTO read_effect VALUES(2) RETURNING n) SELECT n FROM inserted')).get(), { n: 2 });
      assert.deepEqual(await (await connection.prepare('WITH input AS (SELECT 3 AS n) INSERT INTO read_effect SELECT n FROM input RETURNING n')).all(), [{ n: 3 }]);
    }
    finally { await connection.close(); }
  });
  it('holds root admission through break, abort and consumer exceptions without joining a competing write', async () => {
    const store = await openStore(model, { driver: postgresDriver(pool, { schema }) });
    try {
      await store.collection('notes').put({ id: 'one' });
      const cursor = store.collection('notes').query(document);
      assert.equal(cursor.streaming, 'row');
      await cursor.next();
      let wrote = false;
      const writing = store.transaction(async (tx) => {
        await tx.collection('notes').put({ id: 'two' }); wrote = true;
      });
      await delay(15);
      assert.equal(wrote, false);
      await cursor.return();
      await writing;
      const controller = new AbortController();
      const aborted = store.collection('notes').query(document, { signal: controller.signal });
      await aborted.next();
      controller.abort();
      await aborted.return();
      await assert.rejects(aborted.next(), code('JD2072'));
      await assert.rejects((async () => {
        for await (const item of store.collection('notes').query(document)) {
          assert.ok(item); throw new Error('consumer failed');
        }
      })(), /consumer failed/);
      await store.collection('notes').put({ id: 'three' });
    }
    finally { await store.close(); }
    assert.equal(pool.totalCount, pool.idleCount);
  });
  it('expires abandoned root and direct cursors and refuses queued aborts without opening them', async () => {
    const store = await openStore(model, { driver: postgresDriver(pool, { schema, cursorLifetimeMs: 40 }) });
    try {
      const held = store.collection('notes').query(document);
      await held.next();
      const controller = new AbortController();
      const queued = store.collection('notes').query(document, { signal: controller.signal });
      const rejected = assert.rejects(queued.next(), (e) => ['JD2064', 'JD2072'].includes(e.code));
      controller.abort();
      await rejected;
      await delay(65);
      await assert.rejects(held.next(), code('JD2075'));
      assert.deepEqual(await store.collection('notes').get('one'), { id: 'one' });
    }
    finally { await store.close(); }
    const connection = await postgresDriver(pool, { schema, cursorLifetimeMs: 20 }).open();
    try {
      const cursor = await (await connection.prepare('SELECT n FROM generate_series(1,3) n')).iterate();
      await cursor.next();
      await delay(40);
      await assert.rejects(cursor.next(), code('JD2075'));
      assert.equal(connection.metrics().cursors, 0);
    }
    finally { await connection.close(); }
  });
  it('bounds acquired clients and FIFO admission and releases one credit per close', async () => {
    const driver = postgresDriver(pool, { schema, maxConnections: 1, queueCapacity: 1 });
    const first = await driver.open();
    let second;
    try {
      const pending = driver.open();
      await assert.rejects(driver.open(), code('JD2091'));
      assert.equal(driver.metrics().active, 1);
      assert.equal(driver.metrics().queued, 1);
      await first.close();
      second = await pending;
      assert.equal(driver.metrics().active, 1);
      assert.equal(driver.metrics().queued, 0);
    }
    finally { await first.close(); await second?.close(); }
    assert.equal(driver.metrics().active, 0);
  });
  it('reads effective timeouts, observes server cancellation and restores prior settings', async () => {
    const dedicated = new pg.Pool({ connectionString: url, max: 1 });
    try {
      await dedicated.query("SET statement_timeout='7s'");
      await dedicated.query("SET lock_timeout='3s'");
      const connection = await postgresDriver(dedicated, { schema, statementTimeoutMs: 40, lockTimeoutMs: 20 }).open();
      try {
        assert.equal(connection.capabilities.statementTimeout, true);
        assert.equal(connection.capabilities.postgres.statementTimeoutMs, 40);
        await assert.rejects((await connection.prepare('SELECT pg_sleep(1)')).get(),
          (e) => e.code === '57014' && classifyDriverError(e).class === 'cancelled');
        assert.equal(connection.metrics().transaction, 'rolled-back');
        assert.deepEqual(await (await connection.prepare('SELECT 7 AS n')).get(), { n: 7 });
      }
      finally { await connection.close(); }
      assert.equal((await dedicated.query('SHOW statement_timeout')).rows[0].statement_timeout, '7s');
      assert.equal((await dedicated.query('SHOW lock_timeout')).rows[0].lock_timeout, '3s');
    }
    finally { await dedicated.end(); }
  });
  it('a lock timeout rolls back the owner and leaves the next transaction usable', async () => {
    await admin.query(`CREATE TABLE "${schema}".locked(id integer PRIMARY KEY, n integer)`);
    await admin.query(`INSERT INTO "${schema}".locked VALUES(1,0)`);
    const connection = await postgresDriver(pool, { schema, lockTimeoutMs: 20 }).open();
    await admin.query('BEGIN');
    try {
      await admin.query(`UPDATE "${schema}".locked SET n=1 WHERE id=1`);
      await assert.rejects(connection.transaction((tx) => tx.exec('UPDATE locked SET n=2 WHERE id=1')),
        (e) => e.code === '55P03' && classifyDriverError(e).class === 'busy');
      assert.equal(connection.metrics().transaction, 'rolled-back');
    }
    finally { await admin.query('ROLLBACK'); }
    try {
      await connection.transaction((tx) => tx.exec('UPDATE locked SET n=3 WHERE id=1'));
      assert.equal((await (await connection.prepare('SELECT n FROM locked')).get()).n, 3);
    }
    finally { await connection.close(); }
  });
  it('waits for cancellation acknowledgement before issuing the next query', async () => {
    const fetched = deferred(), acknowledged = deferred(), releaseCancel = deferred();
    const source = { connect: async () => {
      const client = await pool.connect();
      return { query: (query, values) => {
        if (typeof query === 'string' && query.startsWith('FETCH')) fetched.resolve();
        return client.query(query, values);
      }, getTransactionStatus: () => client.getTransactionStatus(), release: (e) => client.release(e),
      pid: client.processID };
    } };
    const driver = postgresDriver(source, { schema, maxConnections: 1, cancel: async (client) => {
      await admin.query('SELECT pg_cancel_backend($1)', [client.pid]);
      acknowledged.resolve();
      await releaseCancel.promise;
    } });
    const connection = await driver.open();
    try {
      const cursor = await (await connection.prepare('SELECT pg_sleep(1)')).iterate();
      const pulling = assert.rejects(cursor.next(), code('57014'));
      await fetched.promise;
      // The FETCH has reached the server before the injected cancel request.
      await delay(15);
      const returning = cursor.return();
      await acknowledged.promise;
      const closing = connection.close();
      let nextDone = false;
      const next = driver.open().then((value) => { nextDone = true; return value; });
      await delay(15);
      assert.equal(nextDone, false);
      releaseCancel.resolve();
      await returning;
      await pulling;
      await closing;
      const nextConnection = await next;
      try { assert.equal((await (await nextConnection.prepare('SELECT 1 AS n')).get()).n, 1); }
      finally { await nextConnection.close(); }
      assert.equal(connection.metrics().cursors, 0);
    }
    finally { releaseCancel.resolve(); await connection.close(); }
  });
  it('retains its admission credit after destruction while cancellation delivery is pending', async () => {
    const fetching = deferred(), cancelling = deferred(), delivered = deferred();
    const source = { connect: async () => {
      const client = await pool.connect();
      return { getTransactionStatus: () => client.getTransactionStatus(), release: (e) => client.release(e),
        query: (query, values) => {
          if (typeof query === 'string' && query.startsWith('FETCH')) fetching.resolve();
          return client.query(query, values);
        } };
    } };
    const driver = postgresDriver(source, { schema, maxConnections: 1, closeTimeoutMs: 30,
      cancel: () => { cancelling.resolve(); return delivered.promise; } });
    const connection = await driver.open();
    const cursor = await (await connection.prepare('SELECT pg_sleep(2)')).iterate();
    const pulling = assert.rejects(cursor.next());
    await fetching.promise;
    const returning = assert.rejects(cursor.return());
    await cancelling.promise;
    await assert.rejects(connection.close(), code('JD2090'));
    let acquired = false;
    const next = driver.open().then((value) => { acquired = true; return value; });
    await delay(10);
    assert.equal(acquired, false);
    assert.equal(driver.metrics().active, 1);
    assert.equal(driver.metrics().queued, 1);
    delivered.resolve();
    await returning;
    await pulling;
    const nextConnection = await next;
    try { assert.deepEqual(await (await nextConnection.prepare('SELECT 9 AS n')).get(), { n: 9 }); }
    finally { await nextConnection.close(); }
    assert.equal(driver.metrics().active, 0);
  });
  it('bounds named client cache lifetime across pool reuse and offers an unnamed policy', async () => {
    const dedicated = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const driver = postgresDriver(dedicated, { schema, cursorMode: 'buffered', maxStatements: 3 });
      const first = await driver.open();
      const pid = (await (await first.prepare('SELECT pg_backend_pid() AS pid')).get()).pid;
      await first.close();
      const second = await driver.open();
      await (await second.prepare('SELECT 1')).get();
      await second.close();
      assert.notEqual((await dedicated.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, pid);
      const unnamed = await postgresDriver(dedicated, { schema, prepared: 'unnamed', cursorMode: 'buffered' }).open();
      try {
        await (await unnamed.prepare('SELECT 2')).get();
        assert.equal(unnamed.metrics().statements, 0);
      }
      finally { await unnamed.close(); }
    }
    finally { await dedicated.end(); }
  });
  it('keeps ambiguous commit unknown while a durable receipt proves its committed effect', async () => {
    await admin.query(`CREATE TABLE "${schema}".receipts(id text PRIMARY KEY)`);
    const source = { connect: async () => {
      const client = await pool.connect();
      return { getTransactionStatus: () => client.getTransactionStatus(), release: (e) => client.release(e),
        query: async (query, values) => {
          const result = await client.query(query, values);
          if (query === 'COMMIT') throw Object.assign(new Error('acknowledgement lost'), { code: '08006' });
          return result;
        } };
    } };
    const connection = await postgresDriver(source, { schema }).open();
    try {
      await assert.rejects(connection.transaction((tx) => tx.exec("INSERT INTO receipts VALUES ('request-one')")));
      assert.equal(connection.transactionState(), 'unknown');
      assert.deepEqual((await admin.query(`SELECT id FROM "${schema}".receipts`)).rows, [{ id: 'request-one' }]);
    }
    finally { await connection.close(); }
  });
});
