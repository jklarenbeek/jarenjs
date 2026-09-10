//@ts-check
/** One project model, one private in-memory SQLite connection. No OPFS,
 * broadcast channel or shared data-studio database is acquired here. */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { wasmDriver, sqlite3Handle } from '@jarenjs/db/wasm';
import { compileContract } from '@jarenjs/contract';
import { servePort } from '@jarenjs/contract/port';
import { createJsltRegistry, mathPack, financePack, statsPack } from '@jarenjs/json/jslt';
import contractDoc from './contracts/data.contract.json' with { type: 'json' };
import { createDataHandlers } from './db-handlers.js';

let sqlite3;
const ready = sqlite3InitModule({ print: () => {}, printErr: () => {} });
const { handlers } = createDataHandlers({
  init: async () => {
    sqlite3 = await ready;
    return { topology: 'memory', vfs: 'memory', version: sqlite3.version.libVersion };
  },
  makeDriver: () => wasmDriver(sqlite3Handle(sqlite3)),
  makeScratchDriver: () => wasmDriver(sqlite3Handle(sqlite3)),
  path: () => ':memory:', vfs: () => 'memory', durable: () => false,
  unlink: () => {}, announce: () => {},
  operators: createJsltRegistry().use(mathPack).use(financePack).use(statsPack),
});
servePort(compileContract(contractDoc), handlers, { channel: /** @type {any} */ (globalThis) });
