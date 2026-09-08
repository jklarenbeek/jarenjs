//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { faultHost } from './fault-host.js';
import { createCursor } from '../../packages/db/src/cursor.js';

describe('faulting host lifecycle oracle', () => {
  it('delivers a paused row only when the scheduler spends its credit', async () => {
    const host = faultHost();
    const connection = host.driver.open();
    const statement = connection.prepare('SELECT 1 AS n UNION ALL SELECT 2');
    const iterator = statement.iterate();
    assert.equal(iterator[Symbol.iterator](), iterator);
    host.pause();
    const row = iterator.next();
    assert.equal(host.credits, 1);
    host.step();
    assert.equal((await row).value.n, 1);
    iterator.return();
    iterator.return();
    connection.close();
    connection.close();
    assert.equal(host.events.filter((e) => e.event === 'finalize').length, 1);
    assert.equal(host.events.filter((e) => e.event === 'close').length, 1);
  });

  it('fences statements and partial cursors after a crash and restart', async () => {
    const host = faultHost();
    const connection = host.driver.open();
    const statement = connection.prepare('SELECT 1 AS n UNION ALL SELECT 2');
    const cursor = statement.iterate();
    assert.equal(cursor.next().value.n, 1);
    host.pause();
    const pending = cursor.next();
    const failed = assert.rejects(pending, { code: 'JD2090', retryable: true });
    host.crash();
    await failed;
    host.resume();
    const next = host.driver.open();
    assert.throws(() => statement.get(), { code: 'JD2090' });
    assert.throws(() => cursor.next(), { code: 'JD2090' });
    assert.equal(next.prepare('SELECT 3 AS n').get().n, 3);
    next.close();
    assert.equal(host.events.filter((e) => e.event === 'finalize').length, 1);
  });

  it('abort releases the partial cursor once and never pulls another row', async () => {
    const host = faultHost();
    const connection = host.driver.open();
    const controller = new AbortController();
    const cursor = createCursor({ streaming: 'row', signal: controller.signal,
      open: () => connection.prepare('SELECT 1 AS n UNION ALL SELECT 2').iterate(),
      items: (row) => [row.n] });
    assert.equal((await cursor.next()).value, 1);
    controller.abort();
    await assert.rejects(cursor.next(), { code: 'JD2072' });
    await cursor.return();
    connection.close();
    assert.equal(host.events.filter((e) => e.event === 'next').length, 1);
    assert.equal(host.events.filter((e) => e.event === 'finalize').length, 1);
  });

  it('transaction loss is a failure and never a replay', async () => {
    const host = faultHost();
    const connection = host.driver.open();
    let bodies = 0;
    await assert.rejects(connection.transaction(async (scope) => {
      bodies++;
      scope.exec('CREATE TABLE t (n INTEGER)');
      host.pause();
      const pending = scope.exec('INSERT INTO t VALUES (1)');
      host.crash();
      await pending;
    }));
    assert.equal(bodies, 1);
    assert.equal(host.events.filter((e) => e.event === 'run').length, 0);
  });
});
