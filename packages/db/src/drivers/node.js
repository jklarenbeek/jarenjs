//@ts-check
/**
 * @file The Node binding: `node:sqlite` behind the driver contract.
 * The builtin is imported lazily inside `open()` — never at module
 * scope — so this module itself loads under any runtime; on a runtime
 * without `node:sqlite` the open fails with the coded `JD0003`.
 */

import { lazyOpen, openConnection } from '../driver.js';
import { sqliteDialect } from '../dialects/sqlite.js';

/**
 * Adapt an already-constructed `node:sqlite` `DatabaseSync` (or any
 * object with its shape) into a probed connection. Exported so the
 * adapter is exercisable without the builtin.
 * @param {any} db - A `DatabaseSync`-shaped database
 * @returns {any} a Connection, or a promise of one
 */
export function adaptNodeDatabase(db) {
  const raw = {
    /** @param {string} sql */
    exec: (sql) => db.exec(sql),
    /** @param {string} sql */
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return {
        run: (params = []) => statement.run(...params),
        get: (params = []) => statement.get(...params),
        all: (params = []) => statement.all(...params),
        iterate: (params = []) => statement.iterate(...params),
      };
    },
    close: () => db.close(),
    registerFunction: (name, options, fn) => db.function(name, options, fn),
    registerAggregate: (name, spec) => db.aggregate(name, spec),
    session: (table) => db.createSession(table === undefined ? undefined : { table }),
  };
  return openConnection(raw, {
    dialect: sqliteDialect,
    synchronous: true,
    declared: {
      sessions: true,
      userFunctions: true,
      deterministicIndexableFunctions: true,
    },
  });
}

/**
 * Construct and adapt the database from a loaded `node:sqlite` module.
 * The seam {@link nodeDriver} feeds through `lazyOpen`; exported so the
 * whole open path runs under any runtime with a substitute module.
 * @param {any} mod - The `node:sqlite` module (or a substitute)
 * @param {string} path
 * @param {{ timeout?: number }} [options]
 * @returns {any}
 */
export function fromNodeModule(mod, path, options) {
  const db = options?.timeout !== undefined
    ? new mod.DatabaseSync(path, { timeout: options.timeout })
    : new mod.DatabaseSync(path);
  return adaptNodeDatabase(db);
}

/**
 * The Node driver: `{ name, dialect, open }` over `node:sqlite`.
 * @returns {any}
 */
export function nodeDriver() {
  return Object.freeze({
    name: 'node-sqlite',
    dialect: sqliteDialect,
    /**
     * @param {string} path
     * @param {{ timeout?: number }} [options]
     * @returns {Promise<any>}
     */
    open: (path, options) => lazyOpen('node:sqlite',
      "the Node SQLite binding ('node:sqlite') is unavailable on this runtime",
      fromNodeModule, [path, options]),
  });
}
