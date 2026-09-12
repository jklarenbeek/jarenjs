//@ts-check
/** A project model's private memory store over the same public Data contract. */
import { wasmDriver, sqlite3Handle } from '@jarenjs/db/wasm';
import { servePort } from '@jarenjs/contract/port';
import { createDataHandlers } from './handlers.js';
import { dataContract } from './contract.js';
/** @param {{ initialize: () => Promise<any>, scope: any, operators?: any }} env */
export function createProjectDataWorker(env) {
let sqlite3;
let disposed = false;
const ready = env.initialize();
const table = createDataHandlers({
  init: async () => {
    sqlite3 = await ready;
    if (disposed) throw new Error('The project Data worker is disposed.');
    return { topology: 'memory', vfs: 'memory', version: sqlite3.version.libVersion };
  },
  makeDriver: () => wasmDriver(sqlite3Handle(sqlite3)),
  makeScratchDriver: () => wasmDriver(sqlite3Handle(sqlite3)),
  path: () => ':memory:', vfs: () => 'memory', durable: () => false,
  unlink: () => {}, announce: () => {},
  operators: env.operators,
});
const server = servePort(dataContract, table.handlers, { channel: env.scope });
return { dispose() { disposed = true; server.close(); return table.dispose(); } };
}
