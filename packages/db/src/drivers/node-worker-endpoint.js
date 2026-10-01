//@ts-check
/**
 * A thread owns one SQLite endpoint and its bounded protocol frames.
 * Published as `@jarenjs/db/worker-endpoint` so a bundled or compiled
 * application can ship it beside itself and name it with the driver's
 * `endpoint` option. It serves a worker the driver started — the driver
 * marks its `workerData` — and does nothing anywhere else: the main
 * thread, a bundler's side-effect import, an export probe, or another
 * library's worker thread that happens to import it. A worker marked by
 * a different protocol version stops at once, so the open names it.
 */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { serveSqliteEndpoint } from './sqlite-endpoint.js';
import { WORKER_ENDPOINT_MARK } from './worker-protocol.js';

const mark = isMainThread || parentPort === null ? undefined : workerData?.endpoint;
if (typeof mark === 'string' && mark.startsWith('jarenjs-sqlite-endpoint/') && mark !== WORKER_ENDPOINT_MARK)
  throw new Error(`this endpoint speaks ${WORKER_ENDPOINT_MARK}, and the driver that started it ${mark}`);
if (mark === WORKER_ENDPOINT_MARK) await serveSqliteEndpoint(parentPort, workerData);
