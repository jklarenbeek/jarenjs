//@ts-check
import { nodeWorkerDriver, workerEndpoint } from './node-worker.js';
import { workerPoolDriver } from './worker-pool.js';

/** One writer and bounded read-only WAL workers behind the Connection contract.
 * `endpoint` names every worker's endpoint module, as `nodeWorkerDriver`'s does.
 * @param {{readers?:number, queueCapacity?:number, graceMs?:number, worker?:any,
 *   endpoint?: URL | string}} [options]
 * @returns {any}
 */
export function nodeWorkerPoolDriver(options = {}) {
  // refused here, at construction, as the worker driver refuses it
  if (options.endpoint !== undefined) workerEndpoint(options.endpoint);
  return workerPoolDriver(options, (worker = {}) => nodeWorkerDriver(options.endpoint === undefined
    ? worker : { ...worker, endpoint: options.endpoint }));
}
