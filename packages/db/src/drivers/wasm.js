//@ts-check
/**
 * @file The wasm binding: an INJECTED handle behind the driver
 * contract. This module imports no runtime builtin at all — the host
 * (a browser, a worker) supplies the SQLite build, and this driver
 * only adapts it. Every handle method may return a value or a promise;
 * a main-thread OPFS-backed build is asynchronous and that is exactly
 * why the public store surface is.
 *
 * The injected contract:
 *
 *   handle = {
 *     open(path, options) -> raw | Promise<raw>,
 *     synchronous?: boolean,           // default false
 *     declares?: { userFunctions?, deterministicIndexableFunctions?,
 *                  sessions? }         // default all false
 *   }
 *   raw = { exec(sql), prepare(sql) -> { run, get, all, iterate? },
 *           close(), registerFunction?, registerAggregate?, session? }
 *
 * Capability truth still comes from the probe: whatever the handle
 * declares is intersected with what the loaded library actually
 * compiled in.
 */

import { chain, openConnection } from '../driver.js';
import { sqliteDialect } from '../dialects/sqlite.js';
import { DbCompileError } from '../errors.js';

/**
 * The wasm driver over an injected handle.
 * @param {any} handle - The host-supplied SQLite handle (see the file
 *   header for the contract)
 * @returns {any}
 */
export function wasmDriver(handle) {
  if (handle === null || typeof handle !== 'object'
    || typeof handle.open !== 'function') {
    throw new DbCompileError('JD0003',
      'wasmDriver needs an injected handle exposing open(path, options)');
  }
  return Object.freeze({
    name: 'wasm-sqlite',
    dialect: sqliteDialect,
    /**
     * @param {string} path
     * @param {any} [options]
     * @returns {any}
     */
    open: (path, options) => chain(handle.open(path, options), (raw) =>
      openConnection(raw, {
        dialect: sqliteDialect,
        synchronous: handle.synchronous === true,
        declared: {
          sessions: handle.declares?.sessions === true,
          userFunctions: handle.declares?.userFunctions === true,
          deterministicIndexableFunctions:
            handle.declares?.deterministicIndexableFunctions === true,
        },
      })),
  });
}
