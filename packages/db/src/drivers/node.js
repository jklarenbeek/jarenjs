//@ts-check
/**
 * @file The Node binding: `node:sqlite` behind the driver contract.
 * The builtin is imported lazily inside `open()` — never at module
 * scope — so this module itself loads under any runtime; on a runtime
 * without `node:sqlite` the open fails with the coded `JD0003`.
 */

import { lazyOpen, openConnection } from '../driver.js';
import { sqliteDialect } from '../dialects/sqlite.js';
import { PRAGMA_NAMES } from '../pragmas.js';

/**
 * Adapt an already-constructed `node:sqlite` `DatabaseSync` (or any
 * object with its shape) into a probed connection. Exported so the
 * adapter is exercisable without the builtin.
 * @param {any} db - A `DatabaseSync`-shaped database
 * @param {{ queueTimeout?: number,
 *   backup?: { copy: Function, rename: Function, remove: Function } }} [options]
 *   - `backup` is the online-backup primitive triple (the module-level
 *   `backup()` over this database, plus a rename and a removal); the
 *   connection declares the capability exactly when it is given
 * @returns {any} a Connection, or a promise of one
 */
export function adaptNodeDatabase(db, options) {
  const raw = {
    ...(options?.backup !== undefined ? { backup: options.backup } : undefined),
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
    transactionState: () => typeof db.isTransaction === 'boolean' ? db.isTransaction : null,
    // each optional primitive is exposed only when the HANDLE has it, so
    // a substitute that carries less than `node:sqlite` reports less —
    // a declared capability the handle cannot honour is a TypeError at
    // the first call instead of a `false` the planner can read
    ...(typeof db.function === 'function'
      ? { registerFunction: (name, options, fn) => db.function(name, options, fn) } : undefined),
    ...(typeof db.aggregate === 'function'
      ? { registerAggregate: (name, spec) => db.aggregate(name, spec) } : undefined),
    ...(typeof db.createSession === 'function'
      ? { session: (table) => (table === undefined
        ? db.createSession() : db.createSession({ table })) } : undefined),
  };
  return openConnection(raw, {
    dialect: sqliteDialect,
    synchronous: true,
    queueTimeout: options?.queueTimeout,
    declared: {
      sessions: true,
      userFunctions: true,
      deterministicIndexableFunctions: true,
      aggregateFunctions: true,
      // every configuration pragma of the closed set: a core SQLite
      // library applies them all, and the read-back catches a build
      // that compiled one out
      pragmas: PRAGMA_NAMES,
      backup: options?.backup !== undefined,
    },
  });
}

/**
 * Construct and adapt the database from a loaded `node:sqlite` module.
 * The seam {@link nodeDriver} feeds through `lazyOpen`; exported so the
 * whole open path runs under any runtime with a substitute module.
 * @param {any} mod - The `node:sqlite` module (or a substitute)
 * @param {string} path
 * @param {{ timeout?: number, readOnly?: boolean,
 *   queueTimeout?: number }} [options]
 * @returns {any}
 */
export function fromNodeModule(mod, path, options) {
  /** @type {any} */
  const open = {};
  if (options?.timeout !== undefined) open.timeout = options.timeout;
  if (options?.readOnly === true) open.readOnly = true;
  const db = Object.keys(open).length > 0
    ? new mod.DatabaseSync(path, open)
    : new mod.DatabaseSync(path);
  // the online-backup primitives: the module's own `backup()` over this
  // database, and the file system's rename and removal — imported
  // lazily on first use, never at module scope, for the same reason the
  // builtin itself is
  const backup = typeof mod.backup === 'function'
    ? {
      copy: (target, backupOptions) => mod.backup(db, target, backupOptions),
      rename: (from, to) => import('node:fs/promises').then((fs) => fs.rename(from, to)),
      remove: (target) => import('node:fs/promises').then((fs) => fs.rm(target, { force: true })),
    }
    : undefined;
  return adaptNodeDatabase(db, backup === undefined ? options : { ...options, backup });
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
     * @param {{ timeout?: number, readOnly?: boolean,
     *   queueTimeout?: number }} [options]
     * @returns {Promise<any>}
     */
    open: (path, options) => lazyOpen('node:sqlite',
      "the Node SQLite binding ('node:sqlite') is unavailable on this runtime",
      fromNodeModule, [path, options]),
  });
}

export { snapshotDatabase } from './snapshot.js';

export {
  readDocuments, readJsonDocuments, readJsonlDocuments, readCollectionBundle,
  openAtomicTarget, openStreamTarget, openNullTarget,
  formatOf, DOCUMENT_FORMATS,
} from '../document-files.js';
