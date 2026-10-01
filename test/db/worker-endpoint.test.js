//@ts-check
/**
 * @file The worker endpoint as a bundlable module (HOSTS.md, "Bundled and
 * compiled executables"): `@jarenjs/db/worker-endpoint` serves when it is
 * loaded as a worker and does nothing when imported anywhere else; both
 * worker drivers take an `endpoint` URL; a worker that stops before its
 * ready frame fails the OPEN with `JD0003` naming the endpoint and not
 * retryable, instead of a lost generation that invites a reopen. Runs
 * under Node and under `bun test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { openStore } from '@jarenjs/db';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';
import { tempDbPath } from './helpers.js';

const MISSING = new URL('file:///nonexistent/jaren/worker-endpoint.js');
const MODEL = { $model: '0.1', collections: { notes: { key: '/id', schema: { type: 'object' } } } };
const unstarted = (/** @type {any} */ error) => error.code === 'JD0003' && error.retryable === false
  && error.endpoint === MISSING.href && error.message.includes(MISSING.href);

describe('the worker endpoint', () => {
  it('a missing endpoint fails the open by name, not as a generation to retry', { timeout: 30000 }, async () => {
    await assert.rejects(nodeWorkerDriver({ endpoint: MISSING }).open(':memory:'), unstarted);
    await assert.rejects(nodeWorkerDriver({ endpoint: MISSING.href }).open(':memory:'), unstarted);
    const { dbPath, cleanup } = tempDbPath();
    try {
      await assert.rejects(openStore(MODEL, { driver: nodeWorkerPoolDriver({ readers: 1, endpoint: MISSING }), path: dbPath }),
        unstarted);
      await assert.rejects(openStore(MODEL, { driver: nodeWorkerDriver({ endpoint: MISSING }), path: dbPath }), unstarted);
    }
    finally { cleanup(); }
  });

  it('serves from the URL the endpoint option names', { timeout: 30000 }, async () => {
    const endpoint = new URL(import.meta.resolve('@jarenjs/db/worker-endpoint'));
    const { dbPath, cleanup } = tempDbPath();
    try {
      for (const driver of [nodeWorkerDriver({ endpoint }), nodeWorkerPoolDriver({ readers: 1, endpoint })]) {
        const store = await openStore(MODEL, { driver, path: dbPath });
        try {
          await store.collection('notes').put({ id: 'a', n: 1 });
          await store.transaction(async (tx) => { await tx.collection('notes').put({ id: 'b', n: 2 }); });
          const ids = [];
          for await (const note of store.collection('notes').query('$[*]')) ids.push(note.id);
          assert.deepEqual(ids, ['a', 'b']);
        }
        finally { await store.close(); }
      }
    }
    finally { cleanup(); }
  });

  it('refuses a malformed endpoint when the driver is made', () => {
    // a relative path, a Windows path (it parses as a URL of scheme c:), a
    // remote URL, and values that are no URL at all
    for (const endpoint of ['./worker-endpoint.js', 'C:\\app\\worker-endpoint.js', 'https://example.com/worker-endpoint.js',
      new URL('https://example.com/worker-endpoint.js'), 7, {}]) {
      assert.throws(() => nodeWorkerDriver({ endpoint: /** @type {any} */ (endpoint) }), /file: \(or data:\) URL/);
      assert.throws(() => nodeWorkerPoolDriver({ endpoint: /** @type {any} */ (endpoint) }), /file: \(or data:\) URL/);
    }
    assert.doesNotThrow(() => nodeWorkerDriver({ endpoint: 'data:text/javascript,export%20%7B%7D%3B' }));
  });

  it('the process host forks its own endpoint and refuses one by name', () => {
    assert.throws(() => nodeProcessDriver({ endpoint: /** @type {any} */ (MISSING) }),
      (error) => error instanceof TypeError && /nodeWorkerDriver and nodeWorkerPoolDriver/.test(error.message));
  });

  it('a start that outlives its deadline names the endpoint and the deadline, and may be retried', { timeout: 30000 }, async () => {
    // a module that keeps its thread alive and never says it is ready
    const endpoint = 'data:text/javascript,setInterval(()%3D%3E%7B%7D%2C1000)%3B';
    await assert.rejects(nodeWorkerDriver({ endpoint, startupTimeoutMs: 300 }).open(':memory:'),
      (error) => error.code === 'JD2090' && error.retryable === true && error.endpoint === endpoint
        && error.message.includes(endpoint) && /within 300 ms/.test(error.message));
  });

  it("serves only a worker its driver started, never another library's thread that imports it", { timeout: 30000 }, async () => {
    const endpoint = new URL(import.meta.resolve('@jarenjs/db/worker-endpoint'));
    /** @param {any} workerData */
    const run = (workerData) => new Promise((resolve) => {
      const worker = new Worker(endpoint, { workerData });
      const messages = [];
      let error;
      worker.on('message', (message) => messages.push(message));
      worker.on('error', (e) => { error = e; });
      worker.on('exit', (code) => resolve({ code, messages, error }));
    });
    for (const workerData of [undefined, { pool: 'another-library' }]) {
      const ran = /** @type {any} */ (await run(workerData));
      assert.deepEqual([ran.code, ran.messages, ran.error], [0, [], undefined], 'it answered nothing and left the thread alone');
    }
    // a driver of another protocol version: the endpoint stops at once, by name
    const skewed = /** @type {any} */ (await run({ endpoint: 'jarenjs-sqlite-endpoint/0' }));
    assert.match(String(skewed.error?.message), /speaks jarenjs-sqlite-endpoint\/1, and the driver that started it jarenjs-sqlite-endpoint\/0/);
  });

  it('does nothing when imported outside a worker', async () => {
    const module = await import('@jarenjs/db/worker-endpoint');
    assert.deepEqual(Object.keys(module), []);
  });

  it('the process host names the runtime it needs where it does not run', { skip: process.versions.bun === undefined }, async () => {
    await assert.rejects(nodeProcessDriver().open(':memory:'), (error) => error.code === 'JD0003'
      && error.message.includes(`Bun ${process.versions.bun}`) && /Node\.js 24 or newer/.test(error.message)
      && /@jarenjs\/db\/node-pool/.test(error.message));
  });
});
