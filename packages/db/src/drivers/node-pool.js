//@ts-check
import { nodeWorkerDriver } from './node-worker.js';
import { workerPoolDriver } from './worker-pool.js';

/** One writer and bounded read-only WAL workers behind the Connection contract.
 * @param {{readers?:number, queueCapacity?:number, graceMs?:number, worker?:any}} [options]
 * @returns {any}
 */
export function nodeWorkerPoolDriver(options = {}) {
  return workerPoolDriver(options, nodeWorkerDriver);
}
