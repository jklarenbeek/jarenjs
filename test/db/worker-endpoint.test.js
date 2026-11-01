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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore } from '@jarenjs/db';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';
import { tempDbPath } from './helpers.js';

// a path on every platform (on Windows, on the working directory's drive), with no file behind it
const MISSING = pathToFileURL('/nonexistent/jaren/worker-endpoint.js');
const MODEL = { $model: '0.1', collections: { notes: { key: '/id', schema: { type: 'object' } } } };
const unstartedAt = (/** @type {URL} */ url) => (/** @type {any} */ error) => error.code === 'JD0003'
  && error.retryable === false && error.endpoint === url.href && error.message.includes(url.href);
const unstarted = unstartedAt(MISSING);
/** The refusal of a `file:` URL this platform cannot turn into a path, quoting the platform's reason. */
const unconvertible = (/** @type {string} */ href, /** @type {string} */ code, /** @type {RegExp} */ reason) =>
  (/** @type {any} */ error) => error instanceof TypeError && error.cause?.code === code && reason.test(error.message)
    && error.message.startsWith(`endpoint ${href} is a file: URL this platform cannot turn into a path (`)
    && error.message.endsWith('so no worker could start it: name the module with pathToFileURL(path)');

describe('the worker endpoint', () => {
  it('a missing endpoint fails the open by name, not as a generation to retry', { timeout: 30000 }, async () => {
    await assert.rejects(nodeWorkerDriver({ endpoint: MISSING }).open(':memory:'), unstarted);
    await assert.rejects(nodeWorkerDriver({ endpoint: MISSING.href }).open(':memory:'), unstarted);
    // other spellings of a path: an encoded space, and a localhost authority, which the URL parser drops
    for (const endpoint of [new URL(`${MISSING.href.slice(0, -'.js'.length)}%20copy.js`),
      new URL(MISSING.href.replace('file:///', 'file://localhost/'))]) {
      await assert.rejects(nodeWorkerDriver({ endpoint }).open(':memory:'), unstartedAt(endpoint));
    }
    const { dbPath, cleanup } = tempDbPath();
    try {
      await assert.rejects(openStore(MODEL, { driver: nodeWorkerPoolDriver({ readers: 1, endpoint: MISSING }), path: dbPath }),
        unstarted);
      await assert.rejects(openStore(MODEL, { driver: nodeWorkerDriver({ endpoint: MISSING }), path: dbPath }), unstarted);
    }
    finally { cleanup(); }
  });

  it('refuses a host or an encoded slash in a file: URL when the driver is made, naming why', { timeout: 30000 }, async () => {
    const slash = 'file:///tmp/a%2Fb.js';
    for (const endpoint of [slash, new URL(slash)]) {
      for (const make of [nodeWorkerDriver, nodeWorkerPoolDriver]) {
        assert.throws(() => make({ endpoint }), unconvertible(slash, 'ERR_INVALID_FILE_URL_PATH', /\(File URL path must not include encoded /));
      }
    }
    // a host names a UNC path on Windows, which a worker starts; on POSIX it names none
    const host = 'file://example.com/worker-endpoint.js';
    const named = unconvertible(host, 'ERR_INVALID_FILE_URL_HOST', /\(File URL host must be "localhost" or empty on /);
    for (const make of [nodeWorkerDriver, nodeWorkerPoolDriver]) {
      if (process.platform === 'win32') assert.doesNotThrow(() => make({ endpoint: host }));
      else assert.throws(() => make({ endpoint: host }), named);
    }
    // the pool's worker member names the endpoint too: refused when the pool opens its first worker
    if (process.platform !== 'win32') {
      await assert.rejects(nodeWorkerPoolDriver({ readers: 1, worker: { endpoint: host } }).open(':memory:'), named);
    }
  });

  it('refuses a file: URL exactly where this platform cannot turn it into a path, as a worker start would', () => {
    // the predicate is the platform's own fileURLToPath: a host is a UNC path on
    // Windows and no path on POSIX, a drive-less path is none on Windows, and an
    // encoded slash (on Windows an encoded backslash too) is none anywhere
    for (const text of ['file://example.com/w.js', 'file://server/share/w.js', 'file:///tmp/a%2Fb.js', 'file:///tmp/a%5Cb.js',
      'file:///nonexistent/w.js', 'file:///C:/app/w.js', 'file://localhost/tmp/w.js', 'file:///tmp/a%20b.js']) {
      const url = new URL(text);
      /** @type {any} */
      let reason = null;
      try {
        fileURLToPath(url);
      }
      catch (error) {
        reason = error;
      }
      for (const make of [() => nodeWorkerDriver({ endpoint: url }), () => nodeWorkerPoolDriver({ endpoint: text })]) {
        if (reason === null) assert.doesNotThrow(make, text);
        else {
          assert.throws(make, (/** @type {any} */ error) => error instanceof TypeError && error.cause?.code === reason.code
            && error.message.includes(`endpoint ${url.href} `) && error.message.includes(`(${reason.message})`), text);
        }
      }
    }
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
