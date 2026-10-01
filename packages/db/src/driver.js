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
 * Bun, and a runtime may lack a builtin some binding needs: Node cannot
 * resolve `bun:` specifiers, and a runtime without `node:sqlite` cannot
 * load the Node binding. (Bun ships `node:sqlite`, so the in-thread Node
 * binding, the worker host and the pool host all open there; the
 * supervised process host runs on Node only.) `open()` is where "this
 * driver does not exist here" becomes the coded `JD0003` instead of a
 * module-load crash.
 *
 * `capabilities` is read once at open by a PROBE — the SQLite one by
 * default, another engine's through `options.probe` — and is the single
 * source of truth for feature gating; never a `typeof` sniff at a call
 * site. {@link baseCapabilities} gives every slot the conservative
 * answer, so a probe that says nothing about a feature says `false`
 * rather than `undefined`. `statementTimeout` reports an effective
 * server timeout, independently of the Store's AbortSignal; SQLite
 * has no interrupt or progress handler to build one on. `rowEstimates`
 * remains false (SQLite's query plan is prose, not numbers).
 * These slots let a driver that has the facts fill
 * them without a contract change; pretending SQLite has them is the
 * silent degradation this suite refuses. A third, `lazyIteration`, is
 * probed rather than declared: whether the binding's statements carry
 * a native row iterator, which is what lets a cursor classify itself
 * honestly — a binding without one gets `iterate` composed over `all()`
 * here, and the cursor over it says it buffers.
 */

import { isThenable, chain, toPromise } from '@jarenjs/core/function';

import { DbCompileError, DbRuntimeError, TransactionFailure } from './errors.js';

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

/**
 * Why a queued caller gave up. It is always a coded refusal — a caller
 * has to be able to tell "you were cancelled before you ran" from every
 * other failure — and the host's own `reason` rides along as the cause,
 * so a cancellation that meant something specific still says it.
 * @param {AbortSignal} [signal]
 */
export function abortReason(signal) {
  return new DbRuntimeError('JD2064',
    'the call was aborted while it waited for the open transaction to settle; '
    + 'it ran no statement', { cause: signal?.reason });
}

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
export function wrapStatement(statement, guard = undefined, active = undefined) {
  const before = guard ?? (() => {});
  const track = (source) => {
    if (active === undefined) return source;
    let done = false;
    const iterator = {
      next: () => {
        before();
        if (done) return { done: true, value: undefined };
        return chain(source.next(), (step) => {
          if (step.done) { done = true; active.delete(iterator); }
          return step;
        });
      },
      return: (value) => {
        if (done) return { done: true, value };
        done = true;
        active.delete(iterator);
        return source.return?.(value) ?? { done: true, value };
      },
      [Symbol.iterator]: () => iterator,
      [Symbol.asyncIterator]: () => iterator,
    };
    active.add(iterator);
    return iterator;
  };
  return {
    run: (params = []) => { before(); return statement.run(params); },
    get: (params = []) => { before(); return statement.get(params); },
    all: (params = []) => { before(); return statement.all(params); },
    iterate: typeof statement.iterate === 'function'
      ? (params = []) => { before(); return chain(/** @type {Function} */ (statement.iterate)(params), track); }
      : (params = []) => { before(); return chain(statement.all(params),
        (rows) => track(rows[Symbol.iterator]())); },
    // release what the binding keeps for the statement (a worker's slot);
    // a binding that keeps nothing answers nothing
    finalize: () => (typeof statement.finalize === 'function' ? statement.finalize() : undefined),
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
 * Prepare `sql` for one use and release it once that use ends, however it
 * ends: a worker keeps every statement it prepared until it is finalized, so
 * a statement prepared per call and never released filled its capacity.
 * @template T
 * @param {any} connection
 * @param {string} sql
 * @param {(statement: any) => T | Promise<T>} use
 * @param {{ readOnly?: boolean }} [options]
 * @returns {T | Promise<T>}
 */
export function useStatementOnce(connection, sql, use, options = undefined) {
  return chain(options === undefined ? connection.prepare(sql) : connection.prepare(sql, options), (statement) => {
    const release = () => {
      try {
        void Promise.resolve(statement.finalize?.()).catch(() => {});
      }
      catch {
        // a statement its connection already discarded
      }
    };
    let out;
    try {
      out = use(statement);
    }
    catch (error) {
      release();
      throw error;
    }
    if (!isThenable(out)) {
      release();
      return out;
    }
    return /** @type {Promise<T>} */ (out).then((value) => { release(); return value; },
      (error) => { release(); throw error; });
  });
}

/**
 * Settle a transaction only after its commit succeeds. Deferred constraints
 * can refuse COMMIT or RELEASE after the body returned successfully; that
 * failure owes the same rollback as a failing body.
 * @param {() => any} body
 * @param {() => any} commit
 * @param {() => any} rollback
 * @returns {any}
 */
function settleTransaction(body, commit, rollback) {
  const fail = (error) => chain(attempt(rollback, (cleanupError) =>
    // Losing one remote generation also loses its rollback channel, and a
    // lost session (JD2087) refuses the ROLLBACK for the same reason — the
    // server rolls back an open transaction whose session ends. Either is
    // one failure, not two independent transaction defects.
    error === cleanupError || error?.code === 'JD2090' && cleanupError?.code === 'JD2090'
      && error.generation === cleanupError.generation
      || error?.code === 'JD2087' && cleanupError?.code === 'JD2087'
      ? error : new TransactionFailure(error, cleanupError)), () => { throw error; });
  const succeed = (value) => {
    let committed;
    try {
      committed = commit();
    }
    catch (error) {
      return fail(error);
    }
    return isThenable(committed) ? committed.then(() => value, fail) : value;
  };
  let out;
  try {
    out = body();
  }
  catch (error) {
    return fail(error);
  }
  return isThenable(out) ? out.then(succeed, fail) : succeed(out);
}

/**
 * Finish a raw binding into the connection contract: probe the library
 * once, assert the version floor, freeze the capability table, and
 * attach the savepoint-nested `transaction`.
 *
 * The raw shape a binding supplies:
 * `{ exec(sql), prepare(sql) -> { run, get, all, iterate? }, close(),
 *   registerFunction?, registerAggregate?, session?, backup? }` — every
 * method value-or-promise. `backup` is the online-backup primitive
 * triple `{ copy(path, { rate, progress }), rename(from, to),
 * remove(path) }` a binding with a platform backup API and a file
 * system supplies; the store's `backupTo` is built on it and never
 * touches a builtin itself.
 *
 * @param {any} raw
 * @param {{ dialect: any, synchronous?: boolean, queueTimeout?: number,
 *   probe?: (raw: any, dialect: any, declared: any) => any,
 *   declared?: { sessions?: boolean, userFunctions?: boolean,
 *     deterministicIndexableFunctions?: boolean,
 *     aggregateFunctions?: boolean,
 *     pragmas?: readonly string[],
 *     maintenance?: Record<string, boolean>,
 *     backup?: boolean } }} options - `declared.pragmas`
 *   names the configuration pragmas the binding can apply (the store's
 *   closed set, by option name); the store refuses a request outside it
 *   and reads every declared one back after open. `declared.maintenance`
 *   narrows the maintenance operations (`checkpoint`, `integrityCheck`,
 *   `foreignKeyCheck`, `optimize`): every SQLite library runs them, so
 *   an operation is available unless the binding declares it `false`
 * @returns {any} a Connection, or a promise of one
 */
export function openConnection(raw, options) {
  const { dialect } = options;
  const synchronous = options.synchronous === true;
  const probe = options.probe ?? sqliteProbe;
  // The binding has already acquired its handle. A failed probe must
  // release it here, before a store can take ownership of the connection.
  /** @param {any} failure */
  const failClosed = (failure) => {
    /** @param {any} closeError */
    const both = (closeError) => new AggregateError([failure, closeError],
      'the connection failed to open, and closing its handle failed too');
    const closed = attempt(() => raw.close(), both);
    return chain(closed, () => { throw failure; });
  };
  let opened;
  try {
    opened = chain(probe(raw, dialect, options.declared ?? {}), (capabilities) =>
      finishConnection(raw, dialect, synchronous, capabilities,
        options.queueTimeout ?? DEFAULT_QUEUE_TIMEOUT));
  }
  catch (failure) {
    return failClosed(failure);
  }
  return isThenable(opened) ? opened.then(undefined, failClosed) : opened;
}

/**
 * The capability answers every connection carries, each defaulted to
 * the conservative one. A probe fills in what its engine and binding
 * actually supply; a slot it says nothing about reads `false` rather
 * than `undefined`, so a feature gate is never a `typeof` sniff at a
 * call site.
 * @returns {Record<string, any>}
 */
export function baseCapabilities() {
  return {
    version: '',
    jsonb: false,
    generatedColumns: false,
    returning: false,
    upsert: false,
    savepoints: false,
    rtree: false,
    fts: false,
    sessions: false,
    sessionReason: null,
    worker: false,
    process: false,
    ownerTermination: false,
    pooling: false,
    poolReaders: 0,
    poolWriters: 0,
    userFunctions: false,
    deterministicIndexableFunctions: false,
    aggregateFunctions: false,
    configurablePragmas: Object.freeze([]),
    backup: false,
    maintenance: Object.freeze({
      checkpoint: false, integrityCheck: false, foreignKeyCheck: false, optimize: false,
    }),
    alterTableFull: false,
    statementTimeout: false,
    rowEstimates: false,
    lazyIteration: false,
    // the job queue, the change ledger and the live registry are built
    // on SQLite's own spellings; a store on another engine reports them
    // absent by name rather than failing at the first statement
    jobs: false,
    changeCapture: false,
  };
}

/**
 * The SQLite probe: the library's version report and compile options,
 * plus what the binding declares it can do. It is the DEFAULT probe
 * because every binding this package ships is a SQLite one; a driver
 * for another engine passes its own through `options.probe`, and the
 * version floor asserted here goes with it.
 * @param {any} raw
 * @param {any} dialect
 * @param {Record<string, any>} declared
 * @returns {any} value-or-promise of the frozen capability table
 */
export function sqliteProbe(raw, dialect, declared) {
  return chain(raw.prepare(dialect.introspect.version()), (versionStatement) =>
    chain(versionStatement.get([]), (versionRow) => {
      const version = String(versionRow.version);
      // the binding's statements either carry a lazy iterator or they
      // do not; the probe statement is one of them
      const lazyIteration = typeof versionStatement.iterate === 'function';
      if (compareVersions(version, SQLITE_FLOOR) < 0) {
        throw new DbCompileError('JD0001',
          `the SQLite library is ${version}, below the supported floor ${SQLITE_FLOOR}`);
      }
      return chain(raw.prepare(dialect.introspect.compileOptions()), (optionsStatement) =>
        chain(optionsStatement.all([]), (rows) => {
          const compiled = new Set(rows.map((row) => String(row.name)));
          return Object.freeze({
            ...baseCapabilities(),
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
            sessionReason: raw.sessionReason ?? null,
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
            // the configuration pragmas the binding applies, by the
            // store's option name — a request outside this list is a
            // coded refusal at open, never a silently skipped member
            configurablePragmas: Object.freeze([...(declared.pragmas ?? [])]),
            // the online backup: the binding must supply the primitive
            // triple AND declare it — the platform API and the file
            // system it needs are the binding's, not the library's
            backup: declared.backup === true && raw.backup !== null && typeof raw.backup === 'object'
              && typeof raw.backup.copy === 'function' && typeof raw.backup.rename === 'function'
              && typeof raw.backup.remove === 'function',
            // the maintenance pragmas are the library's, not the
            // binding's: available unless declared absent, and the
            // store's report says so per operation
            maintenance: Object.freeze({
              checkpoint: declared.maintenance?.checkpoint !== false,
              integrityCheck: declared.maintenance?.integrityCheck !== false,
              foreignKeyCheck: declared.maintenance?.foreignKeyCheck !== false,
              optimize: declared.maintenance?.optimize !== false,
            }),
            // structural SQLite limits — stated, not worked around
            alterTableFull: false,
            // the slots every SQLite driver leaves EMPTY (no
            // interrupt, no progress handler, no estimate API)
            statementTimeout: false,
            rowEstimates: false,
            // whether a cursor can pull one row at a time, or the driver
            // materialises the result on the first pull (declared, so
            // the cursor's own report is honest about it)
            lazyIteration,
            // the job queue and the change ledger are SQLite spellings,
            // and every SQLite binding runs them
            jobs: true,
            changeCapture: true,
          });
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
 * @param {number} queueTimeout
 * @returns {any}
 */
export function finishConnection(raw, dialect, synchronous, capabilities, queueTimeout = DEFAULT_QUEUE_TIMEOUT) {
  const activeIterators = new Set();
  /** Savepoint names are never reused, so a stale name can never be
   * mistaken for a live one in an error or a log. */
  let savepointSeq = 0;
  /** Whether a top-level transaction currently owns the connection. */
  let owned = false;
  /**
   * Whether a transaction BLOCK is open on this connection right now.
   *
   * Only an engine whose `SAVEPOINT` does not start a transaction needs
   * the answer, and it needs it for one decision: a checkpoint asked
   * for outside a block has to open the block first, because there is
   * nothing for it to be a checkpoint OF. On SQLite a bare `SAVEPOINT`
   * IS the block, and the flag is never read.
   */
  let inBlock = false;
  /** The structured savepoints open right now: on SQLite the first one
   * starts the transaction, so a scope that finds one is inside it. */
  let structured = 0;
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
  let closeResult;
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
   * A caller that gives up while queued — an aborted signal — is taken
   * off the queue and rejected with its own reason, and `work` never
   * runs at all. That is the difference between cancelling a request
   * and cancelling its effect.
   * @param {() => any} work
   * @param {string} what - what is waiting, for the timeout message
   * @param {AbortSignal} [signal] - abandons the wait when it aborts
   * @param {boolean} [first] - take the next turn rather than the last: the
   *   store's own upkeep (an owner lease renewal) waits for the holder
   *   only, never behind every caller queued after it
   * @param {boolean} [unbounded] - wait without `queueTimeout`, for as long
   *   as the holder holds: only for the store's own upkeep, which its
   *   `signal` takes off the queue when the store closes
   * @returns {any} value-or-promise
   */
  const whenFree = (work, what, signal, first = false, unbounded = false) => {
    if (signal?.aborted === true) return Promise.reject(abortReason(signal));
    if (!owned) return work();
    if (waiting.length >= (raw.queueCapacity ?? Infinity))
      return Promise.reject(new DbRuntimeError('JD2091', 'the connection admission queue is full'));
    return new Promise((resolve, reject) => {
      let done = false;
      /** Leave the queue without running: the turn passes to the next
       * waiter when the owner releases, exactly as a timeout's does. */
      const abandon = (error) => {
        done = true;
        const index = waiting.indexOf(run);
        if (index >= 0) waiting.splice(index, 1);
        // a wait that ends by timeout owes the signal its listener back
        signal?.removeEventListener('abort', cancelled);
        reject(error);
      };
      const timer = unbounded ? undefined : setTimeout(() => abandon(new DbCompileError('JD0012',
        `${what} waited ${queueTimeout}ms for the open transaction to settle. `
        + 'A transaction owns its connection until it commits; work that belongs '
        + 'INSIDE it must go through the store or client the callback received '
        + '(tx.collection / tx.entity / tx.entities / tx.transaction), not the '
        + 'outer one — that request waits for itself.')),
      queueTimeout);
      const cancelled = () => {
        clearTimeout(timer);
        abandon(abortReason(signal));
      };
      signal?.addEventListener('abort', cancelled, { once: true });
      const run = () => {
        if (done) { release(); return; } // already rejected: pass the turn on
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancelled);
        done = true;
        let out;
        try {
          requireOpen();
          out = work();
        }
        catch (error) {
          reject(error);
          return;
        }
        toPromise(out).then(resolve, reject);
      };
      if (first) waiting.unshift(run);
      else waiting.push(run);
    });
  };

  /**
   * Hold the connection for `fn`'s whole extent without opening a
   * savepoint: what an UNRELATED caller needs so its statements cannot
   * fall inside a transaction it is not part of. A store-level read or
   * write is exactly that caller — it waits for the owner, owns the
   * connection while it runs, and hands it on.
   *
   * `fn` receives a scope for the same reason a transaction callback
   * does: work that must nest inside this one (a membership attach, a
   * unit of work's own transaction) says so through the scope rather
   * than queueing behind the caller it is part of.
   * @param {(scope: any) => any} fn
   * @param {string} [what] - what is waiting, for the timeout message
   * @param {AbortSignal} [signal]
   * @param {boolean} [first] - take the next turn (see `whenFree`)
   * @param {boolean} [unbounded] - wait without `queueTimeout` (see `whenFree`)
   */
  const exclusively = (fn, what, signal, first = false, unbounded = false) => {
    requireOpen();
    // a synchronous extent inside an owning callback cannot interleave
    // with anything, so there is nothing to wait for
    if (onStack) return fn(scopeFor(ALWAYS_LIVE));
    return whenFree(() => {
      owned = true;
      const life = { alive: true };
      const end = () => { life.alive = false; release(); };
      const wasOnStack = onStack;
      onStack = true;
      let out;
      try {
        out = fn(scopeFor(life));
      }
      catch (error) {
        onStack = wasOnStack;
        end();
        throw error;
      }
      onStack = wasOnStack;
      if (!isThenable(out)) {
        end();
        return out;
      }
      return out.then(
        (value) => { end(); return value; },
        (error) => { end(); throw error; });
    }, what ?? 'a store-level call', signal, first, unbounded);
  };

  /**
   * Run one PARALLEL read: what a Store opened with `reads: 'parallel'`
   * takes for a classified root read on a host that has readers. It takes
   * no part in the ownership above — it never waits for an owner and no
   * owner waits for it — because the host runs it on a reader of its own,
   * in a read transaction of its own: a committed snapshot that an open
   * transaction's rows never reach. Its statements go through the
   * connection's own `prepare`/`exec`, which the host routes to that
   * reader while the read's async context is current; `fn` receives
   * `enter`, which re-enters the read from a later context (a cursor's
   * next pull). Waiting for a reader is bounded by `queueTimeout` and
   * abandoned by `signal`; a read that is over when `fn` settles may run
   * on a free writer while every reader is held, one HELD across a
   * cursor's pulls never does. `null` on a host without readers.
   * @param {(enter: (next: () => any) => any) => any} fn
   * @param {string} [_what]
   * @param {AbortSignal} [signal]
   * @param {boolean} [held] - the read outlives `fn`'s first answer (a cursor's)
   */
  const shared = typeof raw.parallelRead !== 'function' ? null : (fn, _what, signal, held = false) => {
    requireOpen();
    if (signal?.aborted === true) return Promise.reject(abortReason(signal));
    return raw.parallelRead((/** @type {any} */ enter) => { requireOpen(); return fn(enter); },
      { signal, timeoutMs: queueTimeout, borrow: !held });
  };

  /**
   * The ONE checkpoint primitive both savepoint kinds are built on: a
   * structured `transaction()` nesting opens one and settles it around
   * its callback, and a scope's manual `savepoint()` opens one the
   * caller settles by name. Every checkpoint wears a generated
   * monotonic identifier from the same sequence, so the two kinds share
   * one engine stack and no caller-supplied label ever reaches SQL.
   * The handle is opaque: the store's label bookkeeping lives above it.
   * @returns {any} value-or-promise of `{ name }`
   */
  const openCheckpoint = () => {
    const name = `jaren_sp_${savepointSeq++}`;
    return chain(raw.exec(dialect.tx.savepoint(name)),
      () => Object.freeze({ name }));
  };
  /** `ROLLBACK TO` a checkpoint: the engine keeps the target active and
   * discards every savepoint opened after it.
   * @param {{ name: string }} checkpoint */
  const rollbackToCheckpoint = (checkpoint) =>
    raw.exec(dialect.tx.rollbackTo(checkpoint.name));
  /** `RELEASE` a checkpoint: the engine removes the target and every
   * savepoint opened after it, keeping their rows.
   * @param {{ name: string }} checkpoint */
  const releaseCheckpoint = (checkpoint) =>
    raw.exec(dialect.tx.release(checkpoint.name));

  /**
   * A transaction's rollback, unless the connection was closed under it:
   * closing already discarded the uncommitted work (SQLite rolls back on
   * close; a remote host's close does the same), so a ROLLBACK then
   * could only fail — and that raw "not open" error used to ride beside
   * the holder's own coded `JD2063` in a `TransactionFailure`.
   * @param {() => any} rollback
   * @returns {() => any}
   */
  const rollbackUnlessClosed = (rollback) => () => (closed ? undefined : rollback());

  /** The life of scopes no settlement can outlive (a synchronous extent
   * inside an owning callback). */
  const ALWAYS_LIVE = Object.freeze({ alive: true });
  /**
   * Refuse a statement through a scope whose transaction (or exclusive
   * extent) has settled. A body can outlive its transaction — a hold
   * limit rolls the transaction back and hands the connection on while
   * the body still awaits — and nothing it issues afterwards may reach a
   * connection that belongs to the next owner (on PostgreSQL one stray
   * failing statement aborts THAT owner's transaction).
   * @param {{ alive: boolean }} life
   */
  const requireLive = (life) => {
    if (!life.alive) {
      throw new DbRuntimeError('JD2070',
        'this transaction scope has settled — a statement from a body that outlived its transaction '
        + 'never reaches the connection');
    }
  };

  /** Only the synchronous extent of the callback may implicitly nest.
   * @param {(scope: any) => any} fn
   * @param {{ alive: boolean }} life */
  const callBody = (fn, life) => {
    const wasOnStack = onStack;
    onStack = true;
    try {
      return fn(scopeFor(life));
    }
    finally {
      onStack = wasOnStack;
    }
  };

  /**
   * Own the connection inside a transaction BLOCK: `BEGIN` (or `BEGIN
   * IMMEDIATE`) around `fn`, committed or rolled back as a whole.
   *
   * The `immediate` mode takes the write lock up front. A body
   * that reads before it writes — a claim: read the record, decide,
   * insert — otherwise meets the read→write upgrade `SQLITE_BUSY` the
   * busy handler cannot retry when another connection commits in
   * between; taking the lock first makes that wait an ordinary busy
   * wait the timeout covers. Nesting inside it is savepoints, as always.
   *
   * `begin` is what the store's own transaction asks of the block: an
   * `isolation` level (spelled into the `BEGIN` where the dialect runs
   * more than one), and `writerLock` — the store's writer lock where it
   * is a statement of its own after `BEGIN` (PostgreSQL's advisory lock).
   * That statement runs inside the block, before the body: a lock wait
   * that fails (a lock timeout) rolls the block back, and the body — and
   * with it any hold clock — starts only once the lock is held.
   * @param {(scope: any) => any} fn
   * @param {'deferred' | 'immediate'} mode
   * @param {{ alive: boolean }} life
   * @param {{ isolation?: string, writerLock?: boolean }} [begin]
   */
  const blockAround = (fn, mode, life, begin = undefined) => {
    const statement = begin?.isolation !== undefined && dialect.tx.beginAt !== undefined
      ? dialect.tx.beginAt(begin.isolation)
      : mode === 'immediate' ? dialect.tx.beginImmediate : dialect.tx.begin;
    const lock = begin?.writerLock === true ? dialect.tx.writerLock : undefined;
    return chain(raw.exec(statement), () => {
      let out;
      const wasInBlock = inBlock;
      inBlock = true;
      const restore = (value) => { inBlock = wasInBlock; return value; };
      try {
        out = settleTransaction(() => (lock === undefined ? callBody(fn, life)
          : chain(raw.exec(lock), () => callBody(fn, life))),
        // a connection closed under the body took its work with it: the
        // commit refuses by name (JD2063) rather than the binding's error
        () => { requireOpen(); return raw.exec(dialect.tx.commit); },
        rollbackUnlessClosed(() => raw.exec(dialect.tx.rollback)));
      }
      catch (error) {
        restore(undefined);
        throw error;
      }
      return isThenable(out)
        ? out.then(restore, (error) => { restore(undefined); throw error; })
        : restore(out);
    });
  };

  /** Open one savepoint around `fn`, at whatever depth we are. `fn`
   * receives the scope so nested work can name itself.
   * @param {(scope: any) => any} fn
   */
  const savepointAround = (fn, life) => {
    // an engine that refuses a savepoint outside a transaction gets the
    // block it needs; on every other one this is the same statement it
    // always was
    if (!inBlock && dialect.capabilities.savepointStartsTransaction !== true)
      return blockAround(fn, 'deferred', life);
    // a savepoint whose transaction settled under it (a hold limit rolled
    // the whole block back while this body still ran) neither RELEASEs
    // nor rolls back to anything: the block took it with it, and the
    // connection may already belong to the next owner
    return chain(openCheckpoint(), (checkpoint) => {
      structured += 1;
      const done = () => { structured -= 1; };
      let out;
      try {
        out = settleTransaction(() => callBody(fn, life),
          () => { requireOpen(); requireLive(life); return releaseCheckpoint(checkpoint); },
          rollbackUnlessClosed(() => (life.alive
            ? chain(rollbackToCheckpoint(checkpoint), () => releaseCheckpoint(checkpoint))
            : undefined)));
      }
      catch (error) {
        done();
        throw error;
      }
      if (!isThenable(out)) {
        done();
        return out;
      }
      return out.then((value) => { done(); return value; }, (error) => { done(); throw error; });
    });
  };

  /** The scope handed to a transaction callback: the owner's direct
   * access to the connection, plus nesting. Deliberately narrow —
   * registering a function or opening a change session belongs to store
   * setup, not to a transaction body. */
  const scopeFor = (/** @type {{ alive: boolean }} */ life) => Object.freeze({
    synchronous,
    capabilities,
    dialect,
    /** @param {string} sql */
    exec: (sql) => { requireOpen(); requireLive(life); return raw.exec(sql); },
    /** @param {string} sql */
    prepare: (sql, metadata) => { requireOpen(); requireLive(life); return chain(raw.prepare(sql, metadata), (s) => wrapStatement(s, requireOpen, activeIterators)); },
    /** A nested savepoint inside this transaction — or, inside a scope
     * that opened none yet (a gated call), a transaction of its own:
     * `'immediate'` then takes the writer lock before the first statement.
     * @param {(scope: any) => any} fn @param {'immediate'} [mode] */
    transaction: (fn, mode) => {
      requireLive(life);
      // nothing open yet — no block, no savepoint (one starts a transaction
      // on SQLite) — so this call begins the transaction itself
      return mode === 'immediate' && !inBlock && structured === 0
        ? blockAround(fn, 'immediate', life) : savepointAround(fn, life);
    },
    /** A MANUAL checkpoint at the current depth, settled by the caller
     * through {@link rollbackTo}/{@link release} rather than around a
     * callback. It is the same primitive structured nesting uses — one
     * generated-identifier stack — so the two kinds cannot cross-release
     * each other by name, and no caller-supplied label reaches SQL. */
    savepoint: () => { requireOpen(); requireLive(life); return openCheckpoint(); },
    /** `ROLLBACK TO` a manual checkpoint: the target stays active; every
     * savepoint opened after it is discarded with its rows.
     * @param {{ name: string }} checkpoint */
    rollbackTo: (checkpoint) => { requireOpen(); requireLive(life); return rollbackToCheckpoint(checkpoint); },
    /** `RELEASE` a manual checkpoint: the target and every savepoint
     * opened after it are removed; their rows remain.
     * @param {{ name: string }} checkpoint */
    release: (checkpoint) => { requireOpen(); requireLive(life); return releaseCheckpoint(checkpoint); },
  });

  return Object.freeze({
    synchronous,
    capabilities,
    dialect,
    /** @param {string} sql */
    // NOT gated, because a SQLite connection has no per-statement
    // transaction scope: a statement issued here joins whatever is open.
    // That is right for work INSIDE the transaction, which is why the
    // scope exposes the same two methods. An unrelated caller must not
    // reach them — it takes `exclusively` instead, which holds the
    // connection for its own extent, and the store's handles do exactly
    // that (MODEL-FORMAT §5.1). What the gate guarantees on top is that
    // two TRANSACTIONS never interleave, which is what made commits
    // report failure.
    exec: (sql) => { requireOpen(); return raw.exec(sql); },
    /** @param {string} sql */
    prepare: (sql, metadata) => { requireOpen(); return chain(raw.prepare(sql, metadata), (s) => wrapStatement(s, requireOpen, activeIterators)); },
    /** Whether a transaction issued NOW would have to queue: an owner
     * holds the connection and no owning callback is on the stack (a
     * synchronous call from inside the callback nests instead). What a
     * synchronous surface must know before it would hand back a Promise. */
    get mustQueue() { return owned && !onStack; },
    /** The admission bounds above: how long a caller waits for the owner,
     * and how many may wait — a router over several connections keeps the
     * same ones (sessions.js). */
    queueTimeout,
    queueCapacity: raw.queueCapacity ?? Infinity,
    /** Whether the binding lost its session: every later call on it refuses. */
    lost: () => raw.lost?.() === true,
    /**
     * A transaction. `fn`'s value is returned; a throw rolls back exactly
     * this level and rethrows. A refused COMMIT or RELEASE also rolls
     * back before the next owner runs. Retry is explicit only — the
     * store's `retry` re-runs a whole transaction; nothing here does.
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
     * @param {AbortSignal} [signal] - abandons a QUEUED transaction; a
     *   transaction that has already taken the connection runs on
     * @param {'deferred' | 'immediate'} [mode] - `'immediate'` takes the
     *   write lock up front (a top-level transaction only; a nested call
     *   is a savepoint whichever mode the root chose)
     * @param {{ isolation?: string, writerLock?: boolean }} [begin] - the
     *   store transaction's isolation level and writer lock (see
     *   `blockAround`); a nested call ignores it, as it ignores `mode`
     */
    transaction(fn, signal, mode = 'deferred', begin = undefined) {
      requireOpen();
      if (onStack) return savepointAround(fn, ALWAYS_LIVE);
      return whenFree(() => {
        owned = true;
        // the transaction's scope objects live exactly as long as it:
        // settled, they refuse every statement (see requireLive)
        const life = { alive: true };
        const end = () => { life.alive = false; release(); };
        let out;
        try {
          // A top-level transaction is one CHECKPOINT where a savepoint
          // opens a transaction of its own, and a BLOCK where it does
          // not: an engine that refuses `SAVEPOINT` outside a
          // transaction has to be told one is starting.
          out = mode === 'immediate' || dialect.capabilities.savepointStartsTransaction !== true
            || (begin?.isolation !== undefined && dialect.tx.beginAt !== undefined)
            ? blockAround(fn, mode, life, begin)
            : savepointAround(fn, life);
        }
        catch (error) {
          end();
          throw error;
        }
        if (!isThenable(out)) {
          end();
          return out;
        }
        return out.then(
          (value) => { end(); return value; },
          (error) => { end(); throw error; });
      }, 'a transaction', signal);
    },
    /** Hold the connection for one unrelated caller's whole extent,
     * without a savepoint: what a store-level read or write takes so it
     * cannot fall inside a transaction it is not part of. */
    exclusively,
    /** A parallel read on a reader of its own, or `null` (see `shared`). */
    shared,
    /** Whether the calling async context is inside a parallel read. */
    inShared: () => raw.inParallelRead?.() === true,
    // idempotent: the second close is a no-op on every driver, not a
    // raw error on one and a resolved promise on another. `discard` asks a
    // pooled session's driver to destroy the session rather than return it
    // (it still holds a session lock the store could not release)
    close: (/** @type {{ discard?: boolean } | undefined} */ closeOptions = undefined) => {
      if (closed) return closeResult;
      closed = true;
      for (const waitingCall of waiting.splice(0)) waitingCall();
      // Remote hosts own cursor cleanup within their bounded shutdown.
      // Waiting for a row here would postpone that deadline indefinitely.
      if (raw.closeDrainsIterators === true) {
        activeIterators.clear();
        return closeResult = raw.close(closeOptions);
      }
      const pending = [];
      for (const iterator of activeIterators) {
        try { pending.push(iterator.return()); }
        catch (error) { pending.push(Promise.reject(error)); }
      }
      if (pending.some(isThenable)) return closeResult = Promise.allSettled(pending).then(() => raw.close(closeOptions));
      return closeResult = raw.close(closeOptions);
    },
    transactionState: () => raw.transactionState?.() ?? null,
    registerFunction: typeof raw.registerFunction === 'function'
      ? (name, functionOptions, fn) => { requireOpen(); return raw.registerFunction(name, functionOptions, fn); }
      : null,
    registerAggregate: typeof raw.registerAggregate === 'function'
      ? (name, spec) => { requireOpen(); return raw.registerAggregate(name, spec); }
      : null,
    session: typeof raw.session === 'function'
      ? (table) => { requireOpen(); return raw.session(table); }
      : null,
    // the backup primitives, each refused by name once the store is
    // closed exactly as a statement is
    backup: capabilities.backup === true
      ? Object.freeze({
        snapshot: raw.backup.snapshot === true,
        copy: (path, options) => { requireOpen(); return raw.backup.copy(path, options); },
        rename: (from, to) => { requireOpen(); return raw.backup.rename(from, to); },
        remove: (path) => { requireOpen(); return raw.backup.remove(path); },
      })
      : null,
  });
}
