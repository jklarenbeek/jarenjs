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
 *
 * What it DOES expose is a native lazy row iterator, forwarded below.
 * Without it the driver's generic fallback composes a cursor over
 * `all()`, which materialises every row first — so a query that streams
 * on Node would spike memory in a compiled Bun binary, on the same code
 * and the same data. A cursor that is not lazy is not a cursor.
 */

import { lazyOpen, openConnection } from '../driver.js';
import { sqliteDialect } from '../dialects/sqlite.js';
import { PRAGMA_NAMES } from '../pragmas.js';

/**
 * Adapt an already-constructed `bun:sqlite` `Database` (or any object
 * with its shape) into a probed connection. Exported so the adapter is
 * exercisable without the builtin.
 * @param {any} db - A Bun `Database`-shaped database
 * @param {{ queueTimeout?: number }} [options]
 * @returns {any} a Connection, or a promise of one
 */
export function adaptBunDatabase(db, options) {
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
        // the native lazy iterator when this build has one; the
        // driver-level wrapper composes one over `all` when it does not,
        // and `iterate` stays absent here so that fallback is reached
        ...(typeof statement.iterate === 'function'
          ? { iterate: (params = []) => statement.iterate(...params) }
          : undefined),
      };
    },
    close: () => db.close(),
  };
  return openConnection(raw, {
    dialect: sqliteDialect,
    synchronous: true,
    queueTimeout: options?.queueTimeout,
    declared: {
      sessions: false,
      userFunctions: false,
      deterministicIndexableFunctions: false,
      aggregateFunctions: false,
      // the configuration pragmas are the library's, not the binding's:
      // bun:sqlite applies every one of the closed set
      pragmas: PRAGMA_NAMES,
    },
  });
}

/**
 * Construct and adapt the database from a loaded `bun:sqlite` module.
 * Exported so the whole open path runs under any runtime with a
 * substitute module.
 * @param {any} mod - The `bun:sqlite` module (or a substitute)
 * @param {string} path
 * @param {{ readOnly?: boolean, queueTimeout?: number }} [options]
 * @returns {any}
 */
export function fromBunModule(mod, path, options) {
  return adaptBunDatabase(options?.readOnly === true
    ? new mod.Database(path, { readonly: true })
    : new mod.Database(path), options);
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
     * @param {{ readOnly?: boolean, queueTimeout?: number }} [options]
     * @returns {Promise<any>}
     */
    open: (path, options) => lazyOpen('bun:sqlite',
      "the Bun SQLite binding ('bun:sqlite') is unavailable on this runtime",
      fromBunModule, [path, options]),
  });
}
