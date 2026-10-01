//@ts-check
/** A worker transport behind the ordinary Connection contract. */
import { lazyOpen } from '../driver.js';
import { sqliteDialect } from '../dialects/sqlite.js';
import { createWorkerConnection } from './worker-client.js';
import { workerSettings } from './worker-protocol.js';

/**
 * The worker endpoint a driver starts: by default the module beside this
 * one; a bundled or compiled application names its own copy of
 * `@jarenjs/db/worker-endpoint` (HOSTS.md, "Bundled and compiled
 * executables"). A URL, or the text of an absolute one.
 * @param {URL | string | undefined} endpoint
 * @returns {URL}
 */
export function workerEndpoint(endpoint) {
  if (endpoint === undefined) return new URL('./node-worker-endpoint.js', import.meta.url);
  if (endpoint instanceof URL) return endpoint;
  if (typeof endpoint === 'string' && URL.canParse(endpoint)) return new URL(endpoint);
  throw new TypeError("endpoint must be a URL, such as new URL('./worker-endpoint.js', import.meta.url)");
}

/** Dedicated SQLite worker per connection. No function serialization or write replay.
 * @param {{ windowRows?: number, windowBytes?: number, maxPending?: number,
 *   maxStatements?: number, maxCursors?: number, allMaxRows?: number,
 *   allMaxBytes?: number, closeTimeoutMs?: number, startupTimeoutMs?: number,
 *   endpoint?: URL | string }} [configuration]
 * @returns {any} a Driver
 */
export function nodeWorkerDriver(configuration = {}) {
  const { limits, maxPending, allRows, allBytes, closeMs, startupMs } = workerSettings(configuration);
  const endpoint = workerEndpoint(configuration.endpoint);
  let generation = 0;
  const driver = {
    name: 'node-worker-sqlite', dialect: sqliteDialect,
    open: (path = ':memory:', options = {}) => lazyOpen('node:worker_threads',
      'Node worker threads are unavailable on this runtime', async ({ Worker }) => {
        const epoch = ++generation;
        const worker = new Worker(endpoint, {
          workerData: { path, options: { timeout: options.timeout, readOnly: options.readOnly }, generation: epoch, limits },
          // Parent --test/--input-type/preloads do not describe the endpoint.
          execArgv: ['--no-warnings=ExperimentalWarning'],
        });
        return createWorkerConnection(worker, { epoch, options, limits, maxPending, allRows, allBytes,
          closeMs, startupMs, endpoint: endpoint.href, reopen: () => driver.open(path, options) });
      }, []),
  };
  return Object.freeze(driver);
}
