//@ts-check
/**
 * @file The Bun binding: `bun:sqlite` behind the driver contract. The
 * builtin is imported lazily inside `open()` — never at module scope —
 * so this module itself loads under any runtime; on a runtime that
 * cannot resolve `bun:` specifiers the open fails with the coded
 * `JD0003`.
 *
 * Probed reality this binding declares rather than papers over:
 * `bun:sqlite`'s `Database` exposes no `function`, no `aggregate` and
 * no `createSession` — on Bun the UDF hatch does not exist and there
 * is no session-based change capture. The capability table says so.
 */

import { lazyOpen, openConnection } from '../driver.js';
import { sqliteDialect } from '../dialects/sqlite.js';

/**
 * Adapt an already-constructed `bun:sqlite` `Database` (or any object
 * with its shape) into a probed connection. Exported so the adapter is
 * exercisable without the builtin.
 * @param {any} db - A Bun `Database`-shaped database
 * @returns {any} a Connection, or a promise of one
 */
export function adaptBunDatabase(db) {
  const raw = {
    /** @param {string} sql */
    exec: (sql) => db.run(sql),
    /** @param {string} sql */
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return {
        run: (params = []) => statement.run(...params),
        // the driver contract says a missing row reads UNDEFINED;
        // bun:sqlite answers null — normalize at the seam, or every
        // create-or-verify and absence check misfires
        get: (params = []) => statement.get(...params) ?? undefined,
        all: (params = []) => statement.all(...params),
        // no native lazy row iterator is assumed; the driver-level
        // wrapper composes one over `all`
      };
    },
    close: () => db.close(),
  };
  return openConnection(raw, {
    dialect: sqliteDialect,
    synchronous: true,
    declared: {
      sessions: false,
      userFunctions: false,
      deterministicIndexableFunctions: false,
      aggregateFunctions: false,
    },
  });
}

/**
 * Construct and adapt the database from a loaded `bun:sqlite` module.
 * Exported so the whole open path runs under any runtime with a
 * substitute module.
 * @param {any} mod - The `bun:sqlite` module (or a substitute)
 * @param {string} path
 * @param {{ readOnly?: boolean }} [options]
 * @returns {any}
 */
export function fromBunModule(mod, path, options) {
  return adaptBunDatabase(options?.readOnly === true
    ? new mod.Database(path, { readonly: true })
    : new mod.Database(path));
}

/**
 * The Bun driver: `{ name, dialect, open }` over `bun:sqlite`.
 * @returns {any}
 */
export function bunDriver() {
  return Object.freeze({
    name: 'bun-sqlite',
    dialect: sqliteDialect,
    /**
     * @param {string} path
     * @returns {Promise<any>}
     */
    open: (path, options) => lazyOpen('bun:sqlite',
      "the Bun SQLite binding ('bun:sqlite') is unavailable on this runtime",
      fromBunModule, [path, options]),
  });
}
