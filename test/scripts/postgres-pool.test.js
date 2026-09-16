import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ownPostgresPool } from '../../scripts/lib/postgres-pool.js';

test('operator cleanup waits for physical clients after pool bookkeeping ends', async () => {
  const pool = new EventEmitter();
  const events = [];
  pool.end = async () => { events.push('pool ended'); };
  const close = ownPostgresPool(pool);
  const first = new EventEmitter(), second = new EventEmitter();
  pool.emit('connect', first); pool.emit('connect', second);
  // A client removed from the pool can still have an open socket.
  pool.emit('remove', first);
  const closing = close().then(() => events.push('database can be removed'));
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(events, ['pool ended']);
  first.emit('end');
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(events, ['pool ended']);
  second.emit('end');
  await closing;
  assert.deepEqual(events, ['pool ended', 'database can be removed']);
  assert.equal(pool.listenerCount('connect'), 0);
  assert.equal(first.listenerCount('end'), 0);
  assert.equal(second.listenerCount('end'), 0);
  await close();
  assert.equal(events.filter(value => value === 'pool ended').length, 1);
});

test('operator cleanup handles empty pools and clients that already ended', async () => {
  for (const hadClient of [false, true]) {
    const pool = new EventEmitter(); pool.end = async () => {};
    const close = ownPostgresPool(pool);
    if (hadClient) {
      const client = new EventEmitter(); pool.emit('connect', client); client.emit('end');
    }
    await close();
    assert.equal(pool.listenerCount('connect'), 0);
  }
});

test('operator cleanup tracks a connection admitted before pool.end settles', async () => {
  const pool = new EventEmitter(), client = new EventEmitter();
  pool.end = async () => { pool.emit('connect', client); };
  const close = ownPostgresPool(pool);
  let settled = false;
  const closing = close().then(() => { settled = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false);
  client.emit('end'); await closing;
});

test('operator cleanup preserves close failures and refuses unclosed clients on deadline', async () => {
  const failed = new EventEmitter(), failure = new Error('pool close failed');
  failed.end = async () => { throw failure; };
  await assert.rejects(ownPostgresPool(failed)(), error => error === failure);
  assert.equal(failed.listenerCount('connect'), 0);
  const pool = new EventEmitter(), client = new EventEmitter();
  pool.end = async () => {};
  const close = ownPostgresPool(pool, 10);
  pool.emit('connect', client);
  await assert.rejects(close(), /clients did not close within the fixture deadline/);
  client.emit('end');
  assert.equal(pool.listenerCount('connect'), 0);
  assert.equal(client.listenerCount('end'), 0);
});
