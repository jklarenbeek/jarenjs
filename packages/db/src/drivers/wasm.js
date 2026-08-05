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
 * Adapt an already-constructed `sqlite3.oo1` database (the official
 * SQLite wasm build's object API) into the raw contract. The oo1 API
 * is SYNCHRONOUS — wasm SQLite computes in place and the SAH-pool
 * OPFS VFS does synchronous I/O inside a dedicated worker — which is
 * exactly what keeps journal capture, live queries and the job queue
 * working unchanged in a browser.
 *
 * Statements are REUSED by the store's prepared caches: every
 * operation ends in `reset()`, never `finalize()`. oo1 user functions
 * receive a context pointer first — stripped here — and register
 * variadic (`arity: -1`), matching the engine's fragment shapes.
 * @param {any} sqlite3 - the loaded sqlite3 module (for `capi`)
 * @param {any} db - an `sqlite3.oo1.DB`-shaped database
 * @returns {any} the raw binding for {@link openConnection}
 */
export function adaptOo1Database(sqlite3, db) {
  return {
    /** @param {string} sql */
    exec: (sql) => {
      db.exec(sql);
    },
    /** @param {string} sql */
    prepare: (sql) => {
      const statement = db.prepare(sql);
      const bind = (params) => {
        statement.reset();
        if (params.length > 0) statement.bind(params);
      };
      return {
        run: (params = []) => {
          bind(params);
          statement.step();
          statement.reset();
          return {
            changes: db.changes(),
            lastInsertRowid: Number(
              sqlite3.capi.sqlite3_last_insert_rowid(db)),
          };
        },
        get: (params = []) => {
          bind(params);
          const row = statement.step() ? statement.get({}) : undefined;
          statement.reset();
          return row;
        },
        all: (params = []) => {
          bind(params);
          const rows = [];
          while (statement.step()) rows.push(statement.get({}));
          statement.reset();
          return rows;
        },
        iterate: (params = []) => {
          bind(params);
          return {
            next() {
              if (statement.step()) return { done: false, value: statement.get({}) };
              statement.reset();
              return { done: true, value: undefined };
            },
            return(value) {
              statement.reset();
              return { done: true, value };
            },
            [Symbol.iterator]() { return this; },
          };
        },
      };
    },
    close: () => db.close(),
    registerFunction: (name, options, fn) => db.createFunction(name,
      (_context, ...args) => fn(...args),
      { deterministic: options?.deterministic === true, arity: -1 }),
  };
}

/**
 * Build the injected HANDLE from a loaded sqlite3 module — the D6
 * recipe: the host loads the wasm build and picks the database class
 * (`sqlite3.oo1.DB` for `:memory:`, the SAH-pool util's `OpfsSAHPoolDb`
 * for OPFS persistence), and this package only adapts it.
 *
 * `sessions` is deliberately NOT declared even though the canonical
 * wasm build compiles `ENABLE_SESSION`: this adapter does not yet map
 * the session C API, so capture runs in the journal mode — stated in
 * the capability matrix, adapting it is a roadmap item.
 * @param {any} sqlite3 - the loaded sqlite3 module
 * @param {{ DbClass?: any }} [handleOptions] - the database class to
 *   construct (default `sqlite3.oo1.DB`)
 * @returns {any} a handle for {@link wasmDriver}
 */
export function sqlite3Handle(sqlite3, handleOptions) {
  if (sqlite3 === null || typeof sqlite3 !== 'object'
    || typeof sqlite3?.oo1?.DB !== 'function') {
    throw new DbCompileError('JD0003',
      'sqlite3Handle needs a loaded sqlite3 module exposing oo1.DB');
  }
  const DbClass = handleOptions?.DbClass ?? sqlite3.oo1.DB;
  return {
    synchronous: true,
    declares: {
      userFunctions: true,
      deterministicIndexableFunctions: true,
      sessions: false,
    },
    /**
     * @param {string} path
     * @param {{ readOnly?: boolean }} [options]
     */
    open: (path, options) => adaptOo1Database(sqlite3,
      new DbClass(path ?? ':memory:', options?.readOnly === true ? 'r' : 'c')),
  };
}

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
