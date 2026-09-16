//@ts-check
/** Listener ownership fault oracles; actual wire behavior lives in the native suite. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { postgresNotifications, postgresDriver, postgresDialect } from '@jarenjs/db/postgres';
import { createPostgresNotifications } from '../../packages/db/src/drivers/postgres-notifications.js';
import { createCaptureEngine } from '../../packages/db/src/capture.js';

function fixture(overrides = {}) {
  const clients = [], calls = [], returned = [];
  let active = 0;
  const source = { connect: async () => {
    if (overrides.connect) return overrides.connect();
    const client = new EventEmitter();
    Object.assign(client, {
      getTransactionStatus: () => 'I',
      query: (sql) => { calls.push(sql); return { rows: [] }; },
      release: async (error) => { returned.push(error); active--; },
    });
    clients.push(client); return client;
  } };
  const factory = (wrapped, options) => {
    assert.equal(options.maxConnections, 1);
    return {
      metrics: () => ({ active }),
      open: async () => {
        const client = await wrapped.connect(); active++;
        let closing;
        assert.equal(client.getTransactionStatus?.(), 'I');
        return {
          prepare: () => ({ all: () => overrides.channels ?? [] }),
          exec: async (sql) => {
            await client.query(sql);
            if (overrides.exec) await overrides.exec(sql);
          },
          close: () => (closing ??= client.release()),
        };
      },
    };
  };
  const listener = createPostgresNotifications(factory, source, {
    channel: 'synthetic', maxReconnects: 1, retryBaseMs: 1, retryMaxMs: 1,
    ...overrides.options,
  });
  return { listener, clients, calls, returned };
}

it('coalesces hints, admits one pull, ignores other channels and drains only after owned UNLISTEN', async () => {
  const { listener, clients, calls, returned } = fixture();
  await listener.ready;
  assert.equal(listener[Symbol.asyncIterator](), listener);
  await listener.next();
  const first = listener.next();
  await assert.rejects(listener.next(), (e) => e.code === 'JD2091');
  clients[0].emit('notification', { channel: 'elsewhere', payload: 'ignored' });
  assert.equal(listener.metrics().pending, 1);
  clients[0].emit('notification', { channel: 'synthetic', payload: 'private data ignored' });
  assert.deepEqual(await first, { done: false, value: null });
  for (let i = 0; i < 100; i++) clients[0].emit('notification', { channel: 'synthetic', payload: String(i) });
  assert.equal(listener.metrics().coalesced, 1);
  await listener.next();
  const pending = listener.next();
  assert.deepEqual(await listener.return(), { done: true, value: undefined });
  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.deepEqual(calls, ['LISTEN "synthetic"', 'UNLISTEN "synthetic"']);
  assert.deepEqual(returned, [undefined]);
  assert.deepEqual(clients[0].eventNames(), []);
  assert.equal(listener.metrics().active, 0);
});

it('reconnects finitely, fences retired callbacks and surfaces exhaustion to the pending reader', async () => {
  const { listener, clients, returned } = fixture();
  try {
    await listener.ready; await listener.next();
    const late = clients[0].listeners('notification')[0];
    const reconnect = listener.next();
    clients[0].emit('end');
    assert.deepEqual(await reconnect, { done: false, value: null });
    assert.equal(listener.metrics().attempts, 2);
    assert.equal(returned[0].code, 'JD2087');
    const pending = listener.next();
    const exhausted = assert.rejects(pending, (e) => e.code === 'JD2087');
    late({ channel: 'synthetic' });
    assert.equal(listener.metrics().pending, 1);
    clients[1].emit('error', Object.assign(new Error('connection gone'), { code: '08006' }));
    await exhausted;
    await assert.rejects(listener.next(), (e) => e.code === 'JD2087');
  }
  finally { await listener.close(); }
});

it('refuses unsupported sources/options and prior listener ownership', async () => {
  for (const options of [{}, { channel: '' }, { channel: 'a;LISTEN b' }, { channel: 'x'.repeat(64) },
    { channel: 'ok', maxReconnects: Infinity }, { channel: 'ok', retryBaseMs: 0 }, { channel: 'ok', retryMaxMs: 0 }])
    assert.throws(() => postgresNotifications({ connect() {} }, options), (e) => e.code === 'JD0003');
  assert.throws(() => postgresNotifications(null, { channel: 'ok' }), (e) => e.code === 'JD0003');
  for (const notifyChannel of ['', 'x y', 'x'.repeat(64), 123])
    assert.throws(() => postgresDriver({ connect() {} }, { notifyChannel }), (e) => e.code === 'JD0003');
  const prior = fixture({ channels: [{ channel: 'synthetic' }] });
  await assert.rejects(prior.listener.ready, (e) => e.code === 'JD0003');
  await prior.listener.close();
  assert.deepEqual(prior.calls, []);
  assert.deepEqual(prior.returned, [undefined]);
  let releases = 0;
  const unsupported = fixture({ connect: () => ({ release: () => { releases++; } }) });
  await assert.rejects(unsupported.listener.ready, (e) => e.code === 'JD0003');
  await unsupported.listener.close();
  assert.equal(releases, 1);
});

it('cleans up a failed LISTEN and reports/discards a failed UNLISTEN', async () => {
  for (const verb of ['LISTEN', 'UNLISTEN']) {
    const { listener, returned } = fixture({ options: { maxReconnects: 0 }, exec: (sql) => {
      if (sql.startsWith(`${verb} `)) throw new Error(`${verb} failed`);
    } });
    if (verb === 'LISTEN') await assert.rejects(listener.ready, /LISTEN failed/);
    else await listener.ready;
    if (verb === 'UNLISTEN') {
      await assert.rejects(listener.close(), /UNLISTEN failed/);
      assert.equal(returned[0].code, 'JD2090');
    }
    else {
      await listener.close();
      assert.deepEqual(returned, [undefined]);
    }
  }
});

it('closing during acquisition retires the late generation without publishing readiness or a token', async () => {
  const arriving = Promise.withResolvers();
  const client = new EventEmitter();
  let returned = 0;
  Object.assign(client, { query: () => ({ rows: [] }), release: () => { returned++; }, getTransactionStatus: () => 'I' });
  const { listener } = fixture({ connect: () => arriving.promise });
  const next = listener.next();
  const closing = listener.close();
  arriving.resolve(client);
  await closing;
  await assert.rejects(listener.ready, (e) => e.code === 'JD2063');
  assert.deepEqual(await next, { done: true, value: undefined });
  assert.equal(returned, 1);
  assert.deepEqual(client.eventNames(), []);
});

it('brackets native journal lock and empty notification inside the shared commit owner', async () => {
  const calls = [];
  let inTransaction = false;
  const connection = {
    dialect: postgresDialect({ searchPath: 'synthetic', notifyChannel: 'synthetic' }),
    exec: async (sql) => {
      if (sql.includes('pg_advisory_xact_lock') || sql.includes('pg_notify')) assert.equal(inTransaction, true);
      calls.push(sql);
    },
    prepare: (sql) => ({
      get: () => sql.includes('RETURNING') ? { seq: 1 } : { present: 1 },
      run: () => { calls.push(sql); },
    }),
    transaction: async (fn) => {
      inTransaction = true;
      try { const value = await fn(); calls.push('COMMIT'); return value; }
      finally { inTransaction = false; }
    },
  };
  const options = { connection, shapes: new Map(), mode: 'journal', log: true, retention: 3 };
  assert.throws(() => createCaptureEngine({ ...options, log: false }), (e) => e.code === 'JD0051');
  const capture = createCaptureEngine(options);
  await capture.ready;
  capture.observe(() => { assert.equal(inTransaction, false); calls.push('DELIVER'); });
  await capture.wrap(() => { calls.push('WRITE'); capture.record('notes', ['one'], null, { id: 'one' }); });
  const lock = calls.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
  const log = calls.findIndex((sql) => sql.startsWith('INSERT INTO "_jaren_changes"'));
  const notify = calls.findIndex((sql) => sql.includes('pg_notify'));
  assert.ok(lock < calls.indexOf('WRITE') && calls.indexOf('WRITE') < log && log < notify);
  assert.deepEqual(calls.slice(-3), ["SELECT pg_catalog.pg_notify('synthetic', '')", 'COMMIT', 'DELIVER']);
});
