//@ts-check
/** A worker transport behind the ordinary Connection contract. */
import { lazyOpen } from '../driver.js';
import { sqliteDialect } from '../dialects/sqlite.js';
import { createWorkerConnection } from './worker-client.js';
import { WORKER_ENDPOINT_MARK, WORKER_OPTIONS, refuseUnknownDriverOptions, workerSettings } from './worker-protocol.js';

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
  // a worker loads only file: and data: modules, and the text of a Windows
  // path parses as a URL of scheme `c:`: both refused here, by name
  const url = endpoint instanceof URL ? endpoint
    : typeof endpoint === 'string' && URL.canParse(endpoint) ? new URL(endpoint) : undefined;
  if (url === undefined || (url.protocol !== 'file:' && url.protocol !== 'data:')) {
    throw new TypeError("endpoint must be a file: (or data:) URL, such as new URL('./worker-endpoint.js', "
      + 'import.meta.url) or pathToFileURL(path)');
  }
  return url;
}

/** Dedicated SQLite worker per connection. No function serialization or write replay.
 * The options are a closed set: a member it does not read is `JD0003`.
 * @param {{ windowRows?: number, windowBytes?: number, maxPending?: number,
 *   maxStatements?: number, maxCursors?: number, allMaxRows?: number,
 *   allMaxBytes?: number, closeTimeoutMs?: number, startupTimeoutMs?: number,
 *   endpoint?: URL | string }} [configuration]
 * @returns {any} a Driver
 */
export function nodeWorkerDriver(configuration = {}) {
  refuseUnknownDriverOptions(configuration, WORKER_OPTIONS, 'nodeWorkerDriver');
  const { limits, maxPending, allRows, allBytes, closeMs, startupMs } = workerSettings(configuration);
  const endpoint = workerEndpoint(configuration.endpoint);
  let generation = 0;
  const driver = {
    name: 'node-worker-sqlite', dialect: sqliteDialect,
    open: (path = ':memory:', options = {}) => lazyOpen('node:worker_threads',
      'Node worker threads are unavailable on this runtime', async ({ Worker }) => {
        const epoch = ++generation;
        const worker = new Worker(endpoint, {
          workerData: { endpoint: WORKER_ENDPOINT_MARK, path,
            options: { timeout: options.timeout, readOnly: options.readOnly }, generation: epoch, limits },
          // Parent --test/--input-type/preloads do not describe the endpoint.
          execArgv: ['--no-warnings=ExperimentalWarning'],
        });
        return createWorkerConnection(worker, { epoch, options, limits, maxPending, allRows, allBytes,
          closeMs, startupMs, endpoint: endpoint.href, reopen: () => driver.open(path, options) });
      }, []),
  };
  return Object.freeze(driver);
}
