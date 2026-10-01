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
    for (const endpoint of ['./worker-endpoint.js', 7, {}]) {
      assert.throws(() => nodeWorkerDriver({ endpoint: /** @type {any} */ (endpoint) }), TypeError);
      assert.throws(() => nodeWorkerPoolDriver({ endpoint: /** @type {any} */ (endpoint) }), TypeError);
    }
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
