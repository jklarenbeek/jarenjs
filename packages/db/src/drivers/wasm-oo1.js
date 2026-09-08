//@ts-check
import { sqliteResultError } from '../errors.js';
import { wasmSessions } from './wasm-session.js';

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
  const capture = wasmSessions(sqlite3, db);
  return {
    ...(capture.session === undefined ? {} : { session: capture.session }),
    sessionReason: capture.reason,
    /** @param {string} sql */
    exec: (sql) => {
      db.exec(sql);
    },
    /** @param {string} sql */
    prepare: (sql) => {
      const statement = db.prepare(sql);
      const bind = (params) => {
        statement.reset(true);
        for (let i = 0; i < params.length; i++) {
          const value = params[i];
          // oo1 selects int64 for every integral Number, even beyond its
          // range. JSON numbers retain their IEEE-754 double semantics.
          if (typeof value === 'number' && !Number.isSafeInteger(value)) {
            const rc = sqlite3.capi.sqlite3_bind_double(statement.pointer, i + 1, value);
            if (rc !== 0) throw sqliteResultError(rc, 'wasm number binding');
          }
          else statement.bind(i + 1, value);
        }
      };
      const resetAfter = (fn) => {
        let result;
        try { result = fn(); }
        catch (error) { try { statement.reset(); } catch { /* retain the initiating SQLite failure */ } throw error; }
        statement.reset();
        return result;
      };
      return {
        readOnly: sqlite3.capi.sqlite3_stmt_readonly?.(statement.pointer) === 1,
        run: (params = []) => resetAfter(() => {
          bind(params);
          statement.step();
          return {
            changes: db.changes(),
            lastInsertRowid: Number(
              sqlite3.capi.sqlite3_last_insert_rowid(db)),
          };
        }),
        get: (params = []) => resetAfter(() => {
          bind(params);
          const row = statement.step() ? statement.get({}) : undefined;
          return row;
        }),
        all: (params = []) => resetAfter(() => {
          bind(params);
          const rows = [];
          while (statement.step()) rows.push(statement.get({}));
          return rows;
        }),
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
    close: () => { capture.close(); db.close(); },
    registerFunction: (name, options, fn) => db.createFunction(name,
      (_context, ...args) => fn(...args),
      { deterministic: options?.deterministic === true, arity: -1 }),
  };
}
