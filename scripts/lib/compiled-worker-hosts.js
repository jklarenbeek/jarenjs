//@ts-check
/**
 * The worker and pool hosts inside a `bun build --compile` executable,
 * built with the recipe HOSTS.md documents ("Bundled and compiled
 * executables"): the application names its endpoint with the driver's
 * `endpoint` option, and a second entrypoint — a module that imports
 * `@jarenjs/db/worker-endpoint` for its side effect — ships the endpoint
 * inside the executable. Each built binary runs with every source and
 * module lookup path removed. The full build opens both hosts, writes,
 * commits a transaction, streams a read, and records the event-loop delay
 * during a long read (five whole-collection reads) against the 50 ms bound,
 * beside the in-thread binding on the same read, which holds the loop for
 * as long as each read takes; the build without the second entrypoint must refuse
 * the open with `JD0003` naming the endpoint, not retryable.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/** The acceptance bound on the main thread's event-loop delay during a long read. */
export const EVENT_LOOP_BOUND_MS = 50;
/** Rows the application writes in its transaction and streams back. */
const ROWS = 20000;
/** How many whole-collection reads make up the long read. */
const SCANS = 5;

const APPLICATION = `import { monitorEventLoopDelay } from 'node:perf_hooks';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';

const endpoint = new URL('./worker-endpoint.js', import.meta.url);
const model = { $model: '0.1', collections: { rows: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' } } } } } };
const hosts = [];
for (const [host, driver] of [['worker', nodeWorkerDriver({ endpoint })],
  ['pool', nodeWorkerPoolDriver({ readers: 2, endpoint })], ['in-thread', nodeDriver()]]) {
  let store;
  try { store = await openStore(model, { driver, path: 'compiled-' + host + '.sqlite' }); }
  catch (error) {
    hosts.push({ host, refused: { code: error.code, retryable: error.retryable, endpoint: error.endpoint ?? null } });
    continue;
  }
  try {
    const rows = store.collection('rows');
    await rows.put({ id: 'first', n: -1 });
    await store.transaction(async (tx) => {
      const inside = tx.collection('rows');
      for (let n = 0; n < ${ROWS}; n++) await inside.put({ id: 'r' + n, n });
    });
    let streamed = 0;
    for await (const row of rows.query('$[*]')) if (row.id !== undefined) streamed++;
    // the histogram samples from its first tick on: let it start before the read
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const start = performance.now();
    for (let i = 0; i < ${SCANS}; i++) if ((await rows.all()).length !== 1 + ${ROWS}) throw new Error('short read');
    const longReadMs = performance.now() - start;
    await new Promise((resolve) => setTimeout(resolve, 5));
    histogram.disable();
    hosts.push({ host, written: 1 + ${ROWS}, streamed, longReadMs,
      eventLoopDelayMs: { p50: histogram.percentile(50) / 1e6, p99: histogram.percentile(99) / 1e6, max: histogram.max / 1e6 } });
  }
  finally { await store.close(); }
}
console.log(JSON.stringify({ runtime: process.versions.bun, hosts }));
`;

/**
 * Build both executables in `directory` (which resolves `@jarenjs/*`), into
 * `isolated`; run them only after `removeSources` took every source and
 * module path away.
 * @param {string} directory @param {string} isolated
 * @returns {{ run: () => any }}
 */
export function buildCompiledWorkerHosts(directory, isolated) {
  writeFileSync(join(directory, 'worker-app.js'), APPLICATION);
  writeFileSync(join(directory, 'worker-endpoint.js'), "import '@jarenjs/db/worker-endpoint';\n");
  const bundled = join(isolated, 'worker-hosts-bun');
  const missing = join(isolated, 'worker-hosts-bun-without-endpoint');
  const compile = (/** @type {string[]} */ entries, /** @type {string} */ outfile) => execFileSync('bun',
    ['build', '--compile', ...entries, '--outfile', outfile], { cwd: directory, stdio: 'pipe', timeout: 120000 });
  compile(['./worker-app.js', './worker-endpoint.js'], bundled);
  compile(['./worker-app.js'], missing);
  const execute = (/** @type {string} */ binary) => {
    const result = spawnSync(binary, [], { cwd: isolated, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, `${binary} failed: ${result.stderr}`);
    return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '');
  };
  return {
    run: () => {
      const full = execute(bundled);
      for (const host of ['worker', 'pool']) {
        const row = full.hosts.find((/** @type {any} */ entry) => entry.host === host);
        assert.ok(row !== undefined && row.refused === undefined, `the compiled ${host} host did not open: ${JSON.stringify(row)}`);
        assert.equal(row.written, 1 + ROWS);
        assert.equal(row.streamed, 1 + ROWS, `the compiled ${host} host streamed every row`);
        assert.ok(row.eventLoopDelayMs.max < EVENT_LOOP_BOUND_MS,
          `the compiled ${host} host held the event loop ${row.eventLoopDelayMs.max} ms during a long read`);
      }
      const without = execute(missing);
      for (const host of ['worker', 'pool']) {
        const row = without.hosts.find((/** @type {any} */ entry) => entry.host === host);
        assert.equal(row?.refused?.code, 'JD0003', `without the endpoint the ${host} host refuses by name`);
        assert.equal(row.refused.retryable, false);
        assert.match(row.refused.endpoint, /worker-endpoint\.js$/);
      }
      return { recipe: 'bun build --compile ./worker-app.js ./worker-endpoint.js --outfile worker-hosts-bun',
        runtime: full.runtime, rows: ROWS, scans: SCANS, eventLoopBoundMs: EVENT_LOOP_BOUND_MS,
        hosts: full.hosts, withoutEndpoint: without.hosts.filter((/** @type {any} */ row) => row.refused !== undefined) };
    },
  };
}
