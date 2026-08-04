//@ts-check
/**
 * @file The driver seam: the contract every binding satisfies, the
 * capability probe that runs once at open, and the sync-capable-async
 * helpers the store composes with.
 *
 * A driver is `{ name, dialect, open(path, options) }`; `open` returns
 * a `Connection` or a promise of one. Every connection method may
 * return a value or a promise — the store never assumes either, and
 * composes through {@link chain}, which does not allocate a promise
 * when the driver answered with a value. That is what keeps the public
 * asynchronous surface from paying twice while the synchronous fast
 * path stays exact.
 *
 * The runtime builtin behind a binding is imported LAZILY inside
 * `open()` via {@link lazyOpen} — never at module scope — because the
 * packed-consumer gate imports every export subpath under Node *and*
 * Bun, Bun ships no `node:sqlite`, and Node cannot resolve `bun:`
 * specifiers. `open()` is where "this driver does not exist here"
 * becomes the coded `JD0003` instead of a module-load crash.
 *
 * `capabilities` is read once at open — from the library's version
 * report, its compile options and the binding's declaration — and is
 * the single source of truth for feature gating; never a `typeof`
 * sniff at a call site. Two slots are deliberately EMPTY on every
 * SQLite driver: `statementTimeout` (no interrupt or progress handler
 * exists to build one on) and `rowEstimates` (the query plan is prose,
 * not numbers). They exist so a driver that has the facts can fill
 * them without a contract change; pretending SQLite has them is the
 * silent degradation this suite refuses.
 */

import { DbCompileError } from './errors.js';

/** The minimum SQLite the store accepts, asserted at open. */
export const SQLITE_FLOOR = '3.45.0';

/**
 * @param {any} value
 * @returns {boolean} true when the value is a thenable
 */
export function isThenable(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function';
}

/**
 * Sync-capable-async composition: apply `next` to a driver result
 * without allocating a promise when the result is already a value.
 * @param {any} value - A driver return: a value or a promise
 * @param {(value: any) => any} next
 * @returns {any} `next`'s result, promise-wrapped only if the input was
 */
export function chain(value, next) {
  return isThenable(value) ? value.then(next) : next(value);
}

/**
 * Lift a driver result into a promise — the ONE allocation the public
 * asynchronous surface pays per call.
 * @param {any} value
 * @returns {Promise<any>}
 */
export function toPromise(value) {
  return isThenable(value) ? value : Promise.resolve(value);
}

/**
 * Compare two dotted version strings numerically.
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when a < b, zero when equal
 */
export function compareVersions(a, b) {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  for (let i = 0; i < 3; i++) {
    const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Load a runtime builtin lazily and hand it to the binding's adapter.
 * A failed import — the specifier does not exist on this runtime —
 * becomes `JD0003` carrying the loader's error as `cause`.
 * @param {string} specifier - The builtin module specifier
 * @param {string} reason - The `JD0003` reason for this binding
 * @param {(mod: any, ...args: any[]) => any} use - The binding's
 *   module-to-connection adapter (a named export so the suite can
 *   exercise it with a substitute module on any runtime)
 * @param {any[]} args - Extra arguments forwarded to `use`
 * @returns {Promise<any>}
 */
export function lazyOpen(specifier, reason, use, args) {
  return import(specifier).then(
    (mod) => use(mod, ...args),
    (cause) => {
      throw new DbCompileError('JD0003', reason, undefined, cause);
    });
}

/**
 * Normalize a raw statement to the contract shape. A binding without a
 * native `iterate` gets one composed over `all` — eager, but the same
 * rows in the same order.
 * @param {{ run: Function, get: Function, all: Function,
 *   iterate?: Function }} statement
 * @returns {{ run: Function, get: Function, all: Function,
 *   iterate: Function }}
 */
export function wrapStatement(statement) {
  return {
    run: (params = []) => statement.run(params),
    get: (params = []) => statement.get(params),
    all: (params = []) => statement.all(params),
    iterate: typeof statement.iterate === 'function'
      ? (params = []) => /** @type {Function} */ (statement.iterate)(params)
      : (params = []) => chain(statement.all(params),
        (rows) => rows[Symbol.iterator]()),
  };
}

/**
 * Finish a raw binding into the connection contract: probe the library
 * once, assert the version floor, freeze the capability table, and
 * attach the savepoint-nested `transaction`.
 *
 * The raw shape a binding supplies:
 * `{ exec(sql), prepare(sql) -> { run, get, all, iterate? }, close(),
 *   registerFunction?, registerAggregate?, session? }` — every method
 * value-or-promise.
 *
 * @param {any} raw
 * @param {{ dialect: any, synchronous?: boolean,
 *   declared?: { sessions?: boolean, userFunctions?: boolean,
 *     deterministicIndexableFunctions?: boolean } }} options
 * @returns {any} a Connection, or a promise of one
 */
export function openConnection(raw, options) {
  const { dialect } = options;
  const synchronous = options.synchronous === true;
  const declared = options.declared ?? {};
  return chain(raw.prepare(dialect.introspect.version()), (versionStatement) =>
    chain(versionStatement.get([]), (versionRow) => {
      const version = String(versionRow.version);
      if (compareVersions(version, SQLITE_FLOOR) < 0) {
        throw new DbCompileError('JD0001',
          `the SQLite library is ${version}, below the supported floor ${SQLITE_FLOOR}`);
      }
      return chain(raw.prepare(dialect.introspect.compileOptions()), (optionsStatement) =>
        chain(optionsStatement.all([]), (rows) => {
          const compiled = new Set(rows.map((row) => String(row.name)));
          const capabilities = Object.freeze({
            version,
            // guaranteed by the version floor
            jsonb: true,
            generatedColumns: true,
            returning: true,
            upsert: true,
            savepoints: true,
            // read from the library's compile options
            rtree: compiled.has('ENABLE_RTREE'),
            fts: compiled.has('ENABLE_FTS5'),
            // the binding must expose the API AND the library must
            // carry the extension — either alone is not the capability
            sessions: declared.sessions === true
              && typeof raw.session === 'function'
              && compiled.has('ENABLE_SESSION'),
            userFunctions: declared.userFunctions === true
              && typeof raw.registerFunction === 'function',
            deterministicIndexableFunctions:
              declared.deterministicIndexableFunctions === true
              && typeof raw.registerFunction === 'function',
            // structural SQLite limits — stated, not worked around
            alterTableFull: false,
            // the slots every SQLite driver leaves EMPTY (no
            // interrupt, no progress handler, no estimate API)
            statementTimeout: false,
            rowEstimates: false,
          });
          return finishConnection(raw, dialect, synchronous, capabilities);
        }));
    }));
}

/**
 * Assemble the frozen connection object around a probed raw binding.
 * @param {any} raw
 * @param {any} dialect
 * @param {boolean} synchronous
 * @param {Readonly<Record<string, any>>} capabilities
 * @returns {any}
 */
function finishConnection(raw, dialect, synchronous, capabilities) {
  let savepointDepth = 0;
  return Object.freeze({
    synchronous,
    capabilities,
    dialect,
    /** @param {string} sql */
    exec: (sql) => raw.exec(sql),
    /** @param {string} sql */
    prepare: (sql) => chain(raw.prepare(sql), wrapStatement),
    /**
     * Savepoint-nested transaction: `fn`'s value is returned, a throw
     * rolls back exactly this level and rethrows. No implicit retry.
     * @param {() => any} fn
     */
    transaction(fn) {
      const name = `jaren_sp_${savepointDepth}`;
      savepointDepth++;
      const succeed = (result) => chain(raw.exec(dialect.tx.release(name)), () => {
        savepointDepth--;
        return result;
      });
      const fail = (error) => chain(raw.exec(dialect.tx.rollbackTo(name)), () =>
        chain(raw.exec(dialect.tx.release(name)), () => {
          savepointDepth--;
          throw error;
        }));
      return chain(raw.exec(dialect.tx.savepoint(name)), () => {
        let out;
        try {
          out = fn();
        }
        catch (error) {
          return fail(error);
        }
        return isThenable(out) ? out.then(succeed, fail) : succeed(out);
      });
    },
    close: () => raw.close(),
    registerFunction: typeof raw.registerFunction === 'function'
      ? (name, functionOptions, fn) => raw.registerFunction(name, functionOptions, fn)
      : null,
    registerAggregate: typeof raw.registerAggregate === 'function'
      ? (name, spec) => raw.registerAggregate(name, spec)
      : null,
    session: typeof raw.session === 'function'
      ? (table) => raw.session(table)
      : null,
  });
}
