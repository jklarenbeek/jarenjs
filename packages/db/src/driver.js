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

import { isThenable, chain, toPromise } from '@jarenjs/core/function';

import { DbCompileError, DbRuntimeError } from './errors.js';

/** The minimum SQLite the store accepts, asserted at open. */
export const SQLITE_FLOOR = '3.45.0';

/**
 * How long work may wait for an open transaction to settle before it is
 * rejected with `JD0012`. Matches the store's default busy timeout: the
 * question "has this waited unreasonably long?" has one answer per
 * connection whether the contention is another process (SQLite's own
 * busy timeout) or another transaction on this one.
 */
export const DEFAULT_QUEUE_TIMEOUT = 5000;

// the sync-capable-async helpers are `@jarenjs/core/function`'s (one
// implementation in the suite); re-exported here because every store
// module and the public `@jarenjs/db` surface reach them through this seam
export { isThenable, chain, toPromise };

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
export function wrapStatement(statement, guard = undefined) {
  const before = guard ?? (() => {});
  return {
    run: (params = []) => { before(); return statement.run(params); },
    get: (params = []) => { before(); return statement.get(params); },
    all: (params = []) => { before(); return statement.all(params); },
    iterate: typeof statement.iterate === 'function'
      ? (params = []) => { before(); return /** @type {Function} */ (statement.iterate)(params); }
      : (params = []) => { before(); return chain(statement.all(params),
        (rows) => rows[Symbol.iterator]()); },
  };
}

/**
 * Run a driver call and map its failure — thrown OR rejected — through
 * `wrap`. A `try/catch` around a value-or-promise call saw only the
 * synchronous throw: on an asynchronous driver the failure arrived as a
 * rejection nothing handled, so a rejected write resolved as a success
 * and surfaced later as an unhandled rejection.
 * @template T
 * @param {() => T | Promise<T>} call
 * @param {(error: any) => Error} wrap
 * @returns {T | Promise<T>}
 */
export function attempt(call, wrap) {
  let out;
  try {
    out = call();
  }
  catch (error) {
    throw wrap(error);
  }
  return isThenable(out)
    ? /** @type {Promise<T>} */ (out).then(undefined, (error) => { throw wrap(error); })
    : out;
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
 * @param {{ dialect: any, synchronous?: boolean, queueTimeout?: number,
 *   declared?: { sessions?: boolean, userFunctions?: boolean,
 *     deterministicIndexableFunctions?: boolean,
 *     aggregateFunctions?: boolean } }} options
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
            // aggregate UDFs (`db.aggregate` step/final) — node has them,
            // bun does not; a registry's `pushable:'aggregate'` subset is
            // gated on this (Ring 3). The binding must expose the
            // method AND declare it.
            aggregateFunctions: declared.aggregateFunctions === true
              && typeof raw.registerAggregate === 'function',
            // structural SQLite limits — stated, not worked around
            alterTableFull: false,
            // the slots every SQLite driver leaves EMPTY (no
            // interrupt, no progress handler, no estimate API)
            statementTimeout: false,
            rowEstimates: false,
          });
          return finishConnection(raw, dialect, synchronous, capabilities,
            options.queueTimeout ?? DEFAULT_QUEUE_TIMEOUT);
        }));
    }));
}

/**
 * Assemble the frozen connection object around a probed raw binding.
 *
 * Transaction OWNERSHIP is the load-bearing part. A SQLite connection
 * holds ONE savepoint stack, so two transactions that overlap in time on
 * one connection cannot both be correct: whichever released first would
 * release the other's savepoint with it (`RELEASE` discards everything
 * opened after its target), leaving the second to fail with "no such
 * savepoint" over rows it had already committed. Unique names do not help
 * — the stack is a stack.
 *
 * So a top-level transaction OWNS the connection until it settles, and
 * everything else — another top-level transaction, an ordinary read or
 * write — waits in a FIFO. Work that genuinely belongs INSIDE the
 * transaction says so explicitly: the callback receives a scope, and
 * `scope.transaction()` nests through a savepoint while `scope.exec`/
 * `scope.prepare` run immediately as the owner. That explicitness is
 * what separates "nest me inside the open transaction" from "I am an
 * unrelated caller, hold my work until it commits", which no implicit
 * implicit counter can tell apart once a callback awaits.
 * @param {any} raw
 * @param {any} dialect
 * @param {boolean} synchronous
 * @param {Readonly<Record<string, any>>} capabilities
 * @returns {any}
 */
function finishConnection(raw, dialect, synchronous, capabilities, queueTimeout) {
  /** Savepoint names are never reused, so a stale name can never be
   * mistaken for a live one in an error or a log. */
  let savepointSeq = 0;
  /** Whether a top-level transaction currently owns the connection. */
  let owned = false;
  /**
   * Whether an owning callback is on the stack RIGHT NOW — set around the
   * synchronous extent of every transaction body, cleared the moment it
   * returns or awaits. It is the one discriminator a connection has: while
   * a callback is still running synchronously nothing else can possibly be
   * interleaved, so a `transaction()` arriving then is a nested call. Once
   * the callback has awaited, the same request could be an unrelated
   * caller, and only the scope it was handed can say otherwise.
   */
  let onStack = false;
  /** @type {Array<() => void>} FIFO of work waiting for the owner. */
  const waiting = [];
  /** Set by `close()`: every later call is refused by name rather than
   * leaking the binding's own error (or, on a build that tolerates it,
   * running against a closed handle). */
  let closed = false;
  const requireOpen = () => {
    if (closed) {
      throw new DbRuntimeError('JD2063',
        'the store is closed — a call after close() has no connection to run on');
    }
  };

  /** Hand the connection to the next waiter, in arrival order. */
  const release = () => {
    owned = false;
    const next = waiting.shift();
    if (next !== undefined) next();
  };

  /**
   * Run `work` now if the connection is free, else when it becomes free.
   *
   * A wait that outlives `queueTimeout` is rejected rather than left
   * pending, because the two ways to get here look identical from inside
   * and only one of them can ever resolve: an unrelated caller waiting
   * out a long transaction (fine, it proceeds when the commit lands), or
   * a transaction callback that reached back through the OUTER connection
   * instead of the scope it was handed (never — it is waiting for itself).
   * The bound turns the second case from a silent hang into a coded error
   * that names the fix, the same trade SQLite's own busy timeout makes.
   * @param {() => any} work
   * @param {string} what - what is waiting, for the timeout message
   * @returns {any} value-or-promise
   */
  const whenFree = (work, what) => {
    if (!owned) return work();
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        done = true;
        const index = waiting.indexOf(run);
        if (index >= 0) waiting.splice(index, 1);
        reject(new DbCompileError('JD0012',
          `${what} waited ${queueTimeout}ms for the open transaction to settle. `
          + 'A transaction owns its connection until it commits; work that belongs '
          + 'INSIDE it must go through the scope the callback received '
          + '(scope.transaction / the store passed to your callback), not the '
          + 'outer connection — that request waits for itself.'));
      }, queueTimeout);
      const run = () => {
        if (done) { release(); return; } // already rejected: pass the turn on
        clearTimeout(timer);
        done = true;
        let out;
        try {
          out = work();
        }
        catch (error) {
          reject(error);
          return;
        }
        toPromise(out).then(resolve, reject);
      };
      waiting.push(run);
    });
  };

  /** Open one savepoint around `fn`, at whatever depth we are. `fn`
   * receives the scope so nested work can name itself.
   * @param {(scope: any) => any} fn
   */
  const savepointAround = (fn) => {
    const name = `jaren_sp_${savepointSeq++}`;
    const succeed = (result) => chain(raw.exec(dialect.tx.release(name)), () => result);
    const fail = (error) => chain(raw.exec(dialect.tx.rollbackTo(name)), () =>
      chain(raw.exec(dialect.tx.release(name)), () => {
        throw error;
      }));
    return chain(raw.exec(dialect.tx.savepoint(name)), () => {
      let out;
      const wasOnStack = onStack;
      onStack = true;
      try {
        out = fn(scopeFor());
      }
      catch (error) {
        onStack = wasOnStack;
        return fail(error);
      }
      onStack = wasOnStack; // the body has returned or awaited
      return isThenable(out) ? out.then(succeed, fail) : succeed(out);
    });
  };

  /** The scope handed to a transaction callback: the owner's direct
   * access to the connection, plus nesting. Deliberately narrow —
   * registering a function or opening a change session belongs to store
   * setup, not to a transaction body. */
  const scopeFor = () => Object.freeze({
    synchronous,
    capabilities,
    dialect,
    /** @param {string} sql */
    exec: (sql) => { requireOpen(); return raw.exec(sql); },
    /** @param {string} sql */
    prepare: (sql) => { requireOpen(); return chain(raw.prepare(sql), (s) => wrapStatement(s, requireOpen)); },
    /** A nested savepoint inside this transaction.
     * @param {(scope: any) => any} fn */
    transaction: (fn) => savepointAround(fn),
  });

  return Object.freeze({
    synchronous,
    capabilities,
    dialect,
    /** @param {string} sql */
    // NOT gated. A statement issued while a transaction is open joins it,
    // because a SQLite connection has no per-statement transaction scope
    // and every caller inside a transaction reaches the connection this
    // way. Two consequences, both documented in MODEL-FORMAT §Transactions:
    // work inside a callback runs immediately as the owner (right), and an
    // UNRELATED caller's bare write on a shared store joins that
    // transaction and shares its fate (a single connection cannot tell the
    // two apart — give each concurrent writer its own store to separate
    // them). What the gate below does guarantee is that two TRANSACTIONS
    // never interleave, which is what made commits report failure.
    exec: (sql) => { requireOpen(); return raw.exec(sql); },
    /** @param {string} sql */
    prepare: (sql) => { requireOpen(); return chain(raw.prepare(sql), (s) => wrapStatement(s, requireOpen)); },
    /** Whether a transaction issued NOW would have to queue: an owner
     * holds the connection and no owning callback is on the stack (a
     * synchronous call from inside the callback nests instead). What a
     * synchronous surface must know before it would hand back a Promise. */
    get mustQueue() { return owned && !onStack; },
    /**
     * A transaction. `fn`'s value is returned; a throw rolls back exactly
     * this level and rethrows. No implicit retry.
     *
     * Two shapes, decided here rather than by the caller:
     *
     *  - **Nested**, when an owning callback is on the stack: a savepoint
     *    inside it, synchronously, exactly as before. This is the only
     *    thing it can be — synchronous code cannot interleave.
     *  - **Top level** otherwise: it takes the connection and holds it
     *    until it settles, so two transactions never share a savepoint
     *    stack. An overlapping one waits its turn instead of nesting into
     *    a stranger's rollback.
     *
     * An ASYNC callback that wants to nest cannot rely on the stack — it
     * has already awaited — so it nests through the scope it was handed
     * (`fn` receives it). Reaching back through the connection instead
     * queues behind the transaction the caller is part of, and
     * {@link DEFAULT_QUEUE_TIMEOUT} turns that into `JD0012`.
     * @param {(scope: any) => any} fn
     */
    transaction(fn) {
      requireOpen();
      if (onStack) return savepointAround(fn);
      return whenFree(() => {
        owned = true;
        let out;
        try {
          out = savepointAround(fn);
        }
        catch (error) {
          release();
          throw error;
        }
        if (!isThenable(out)) {
          release();
          return out;
        }
        return out.then(
          (value) => { release(); return value; },
          (error) => { release(); throw error; });
      }, 'a transaction');
    },
    // idempotent: the second close is a no-op on every driver, not a
    // raw error on one and a resolved promise on another
    close: () => {
      if (closed) return undefined;
      closed = true;
      return raw.close();
    },
    registerFunction: typeof raw.registerFunction === 'function'
      ? (name, functionOptions, fn) => { requireOpen(); return raw.registerFunction(name, functionOptions, fn); }
      : null,
    registerAggregate: typeof raw.registerAggregate === 'function'
      ? (name, spec) => { requireOpen(); return raw.registerAggregate(name, spec); }
      : null,
    session: typeof raw.session === 'function'
      ? (table) => { requireOpen(); return raw.session(table); }
      : null,
  });
}
