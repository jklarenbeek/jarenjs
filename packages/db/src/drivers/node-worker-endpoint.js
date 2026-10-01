//@ts-check
/**
 * A thread owns one SQLite endpoint and its bounded protocol frames.
 * Published as `@jarenjs/db/worker-endpoint` so a bundled or compiled
 * application can ship it beside itself and name it with the driver's
 * `endpoint` option. It serves when it is loaded as a worker; imported
 * anywhere else (a bundler's side-effect import, an export probe) it
 * does nothing.
 */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { serveSqliteEndpoint } from './sqlite-endpoint.js';
if (!isMainThread && parentPort !== null) await serveSqliteEndpoint(parentPort, workerData);
