//@ts-check
/** A thread owns one SQLite endpoint and its bounded protocol frames. */
import { parentPort, workerData } from 'node:worker_threads';
import { serveSqliteEndpoint } from './sqlite-endpoint.js';
await serveSqliteEndpoint(parentPort, workerData);
