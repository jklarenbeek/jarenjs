//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@jarenjs/db';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';

const MODEL = { $model: '0.1', collections: { items: { key: '/id', schema: {
  type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' } },
} } } };

it('a malformed first worker frame refuses the endpoint without inviting a generation retry', async () => {
  for (const frame of ['hello', { v: 999, generation: 1, kind: 'ready', capabilities: {} }]) {
    const endpoint = new URL(`data:text/javascript,${encodeURIComponent(
      `import { parentPort } from 'node:worker_threads'; parentPort.postMessage(${JSON.stringify(frame)}); setInterval(() => {}, 1000);`)}`);
    await assert.rejects(nodeWorkerDriver({ endpoint }).open(':memory:'),
      error => error.code === 'JD0003' && error.retryable === false && error.endpoint === endpoint.href);
  }
});

it('close drains a parallel read already admitted to a free reader', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'jaren-admitted-read-'));
  let store;
  try {
    store = await openStore(MODEL, { path: join(folder, 'data.sqlite'),
      driver: nodeWorkerPoolDriver({ readers: 1 }), reads: 'parallel' });
    await store.collection('items').put({ id: 'a', n: 1 });
    const expression = { $for: { item: '$[*]' }, $return: '$item.id' };
    assert.equal(await store.collection('items').execute(expression), 'a');
    const reading = store.collection('items').execute(expression);
    const closing = store.close();
    const [read, closed] = await Promise.allSettled([reading, closing]);
    assert.deepEqual(read, { status: 'fulfilled', value: 'a' });
    assert.deepEqual(closed, { status: 'fulfilled', value: undefined });
    await assert.rejects(store.collection('items').get('a'), { code: 'JD2063' });
  }
  finally { await store?.close(); rmSync(folder, { recursive: true, force: true }); }
});

it('every root write and transaction reached inside a parallel read refuses its own transaction boundary', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'jaren-nested-read-'));
  try {
    for (const method of ['put', 'insert', 'delete', 'patch', 'transaction']) {
      let store, attempted;
      const nested = value => {
        if (attempted === undefined) {
          const items = store.collection('items');
          const write = () => method === 'transaction' ? store.transaction(tx => tx.collection('items').put({ id: 'a', n: 2 }))
            : method === 'patch' ? items.patch('a', [{ op: 'replace', path: '/n', value: 2 }])
              : method === 'delete' ? items.delete('a') : items[method]({ id: 'b', n: 2 });
          try { attempted = Promise.resolve(write()).then(() => 'written', error => error.code); }
          catch (error) { attempted = Promise.resolve(error.code); }
        }
        return value;
      };
      store = await openStore(MODEL, { path: join(folder, `${method}.sqlite`),
        driver: nodeWorkerPoolDriver({ readers: 1 }), reads: 'parallel', functions: { nested } });
      try {
        await store.collection('items').put({ id: 'a', n: 1 });
        await store.collection('items').execute({ $for: { item: '$[*]' }, $return: { $call: ['nested', '$item.n'] } });
        assert.equal(await attempted, 'JD0014', method);
        assert.deepEqual(await store.collection('items').all(), [{ id: 'a', n: 1 }]);
      }
      finally { await store.close(); }
    }
  }
  finally { rmSync(folder, { recursive: true, force: true }); }
});

it('draining a granted reader never reopens admission or an ended read context', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'jaren-read-drain-'));
  let connection;
  try {
    connection = await nodeWorkerPoolDriver({ readers: 1 }).open(join(folder, 'data.sqlite'));
    let entered, resume, enterLater;
    const started = new Promise(resolve => { entered = resolve; });
    const continuation = new Promise(resolve => { resume = resolve; });
    const reading = connection.shared(async enter => {
      enterLater = enter; entered(); await continuation;
      assert.deepEqual(await (await connection.prepare('SELECT 42 AS answer')).get(), { answer: 42 });
      assert.throws(() => connection.exclusively(() => assert.fail('new admission')), { code: 'JD2063' });
      assert.throws(() => connection.transaction(() => assert.fail('new transaction')), { code: 'JD2063' });
      assert.throws(() => connection.shared(() => assert.fail('new read')), { code: 'JD2063' });
    });
    await started;
    const closing = connection.close();
    assert.throws(() => connection.prepare('SELECT 43'), { code: 'JD2063' });
    resume(); await reading; await closing;
    enterLater(() => {
      assert.throws(() => connection.prepare('SELECT 44'), { code: 'JD2063' });
      assert.throws(() => connection.exclusively(() => assert.fail('escaped admission')), { code: 'JD2063' });
    });
  }
  finally { await connection?.close(); rmSync(folder, { recursive: true, force: true }); }
});
