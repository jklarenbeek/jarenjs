//@ts-check
/** A worker transport behind the ordinary Connection contract. */
import { lazyOpen } from '../driver.js';
import { sqliteDialect } from '../dialects/sqlite.js';
import { createWorkerConnection } from './worker-client.js';
import { workerSettings } from './worker-protocol.js';

/** Dedicated SQLite worker per connection. No function serialization or write replay.
 * @param {{ windowRows?: number, windowBytes?: number, maxPending?: number,
 *   maxStatements?: number, maxCursors?: number, allMaxRows?: number,
 *   allMaxBytes?: number, closeTimeoutMs?: number, startupTimeoutMs?: number }} [configuration]
 * @returns {any} a Driver
 */
export function nodeWorkerDriver(configuration = {}) {
  const { limits, maxPending, allRows, allBytes, closeMs, startupMs } = workerSettings(configuration);
  let generation = 0;
  const driver = {
    name: 'node-worker-sqlite', dialect: sqliteDialect,
    open: (path = ':memory:', options = {}) => lazyOpen('node:worker_threads',
      'Node worker threads are unavailable on this runtime', async ({ Worker }) => {
        const epoch = ++generation;
        const worker = new Worker(new URL('./node-worker-endpoint.js', import.meta.url), {
          workerData: { path, options: { timeout: options.timeout, readOnly: options.readOnly }, generation: epoch, limits },
          // Parent --test/--input-type/preloads do not describe the endpoint.
          execArgv: ['--no-warnings=ExperimentalWarning'],
        });
        return createWorkerConnection(worker, { epoch, options, limits, maxPending, allRows, allBytes,
          closeMs, startupMs, reopen: () => driver.open(path, options) });
      }, []),
  };
  return Object.freeze(driver);
}
