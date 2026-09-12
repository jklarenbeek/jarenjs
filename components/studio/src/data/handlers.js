//@ts-check
/**
 * @file The data studio's handler table, apart from the browser that
 * hosts it.
 *
 * `db-worker.js` is the OWNER context: it loads the SQLite wasm build,
 * claims the OPFS access-handle pool and serves two transports. None of
 * that is testable outside a browser, and none of it is where the
 * studio's behaviour lives — so the behaviour is here, over an injected
 * host, and the worker supplies the real one. The same table then runs
 * under a Node driver in the test suite, which is how the store rules
 * below are held to anything at all.
 *
 * What the table owns, and the worker deliberately does not:
 *
 *  - **The live registry.** Every `data.live` registration is held in a
 *    set, and `data.lives` reports its SIZE. A count kept as a number
 *    beside the registrations drifts the moment a reopen zeroes it while
 *    subscriptions are still held — under-reporting forever, and going
 *    negative on the next release, at which point the count fails its own
 *    output schema and freezes at its last good value. A frozen count
 *    reads exactly like a healthy one, which is why this is a set.
 *  - **Reopening releases.** Closing the store releases every registration
 *    it fed, so the count comes back to zero because the subscriptions
 *    ended, not because someone assigned zero.
 *  - **A refused migration does not advance the model.** `state.model`
 *    moves only when `migrate()` returned; a store reopened after a
 *    refusal is reopened on the model it still has, and the refusal
 *    crosses as the declared `db` failure.
 *  - **Peers are told.** Any reopen — open, recreate, migrate — drops the
 *    live registrations of every tab, so the worker announces it and the
 *    boundaries resubscribe. Silence would leave every live pane showing
 *    its last rows forever while looking live.
 *  - **Recreating is owner-only.** `reset` unlinks the database the owner
 *    holds; a client tab asking for it is refused rather than served, so
 *    the control that is honest in the owning tab cannot be destructive
 *    from another one.
 *  - **The oracle's store is throwaway.** `data.oracle` opens a fresh
 *    in-memory store on the model it is handed, answers one query over
 *    the documents it is handed (with its plan, when asked), and closes
 *    it — the store this context holds, its registrations and its peers
 *    are untouched. That is what
 *    lets the committed spatial corpus hold SQLite-in-wasm to the
 *    JavaScript engine from any tab, including one with no OPFS at all.
 */

import { openStore, migrate, planModelMigration } from '@jarenjs/db';
import { ContractFailure } from '@jarenjs/contract';

/**
 * The host the table runs over: everything that differs between a
 * browser worker holding an OPFS pool and a test holding a file.
 * @typedef {Object} DataHost
 * @property {() => Promise<any>} init - Decide the topology and prepare
 *   this context; resolves to the `data.init` answer.
 * @property {() => any} makeDriver - A fresh driver over a fresh handle.
 * @property {() => any} makeScratchDriver - A driver over a throwaway
 *   in-memory handle: the oracle's store, opened and closed per call,
 *   never the database this context holds.
 * @property {() => string} path - The database path for this context.
 * @property {() => string} vfs - The VFS this context settled on.
 * @property {() => boolean} durable - Whether a migration can be applied
 *   here at all; a memory store recreates instead.
 * @property {() => void} unlink - Drop the persistent database.
 * @property {(notice: any) => void} announce - Tell every peer the store
 *   was reopened under them.
 * @property {any} operators - The operator registry the store mounts.
 */

/**
 * The details of the declared `db` failure: the store's own coded refusal
 * and its message.
 *
 * The contract carries string codes, including numeric DOMException
 * codes converted to strings. The host's message survives unchanged.
 * @param {unknown} error
 * @returns {{ code: string | null, message: string }}
 */
export function wireError(error) {
  const raised = /** @type {any} */ (error);
  const code = raised?.code;
  const message = String(raised?.message ?? error);
  return { code: code === undefined || code === null ? null : String(code), message };
}

/**
 * A refusal only the owning context can answer.
 * @param {string} message
 * @returns {Error}
 */
function ownerOnly(message) {
  const error = new Error(message);
  /** @type {any} */ (error).code = 'JD2061';
  return error;
}

/**
 * The studio's handler table over an injected host.
 * @param {DataHost} host
 * @returns {{ handlers: Record<string, any>, clientHandlers: Record<string, any>, state: any, dispose: () => Promise<void> }}
 */
export function createDataHandlers(host) {
  let disposed = false;
  function active() {
    if (disposed) throw Object.assign(new Error('the data host is disposed'), { code: 'JD2005' });
  }
  /** An asynchronous open must release its handle if the host left meanwhile. */
  async function acceptStore(next) {
    if (disposed) { await next.close(); active(); }
    state.store = next;
  }
  const state = {
    /** @type {any} */ store: null,
    /** @type {any} */ model: null,
    /** Live registrations, held rather than counted (see the file note). */
    /** @type {Set<any>} */ lives: new Set(),
  };

  /** Release one registration exactly once, whichever side asks. */
  const releaser = (/** @type {any} */ entry) => () => {
    if (!state.lives.delete(entry)) return;
    entry.live.close();
  };

  /** The open store, or the coded refusal that says why there is none.
   * An open that failed leaves this context with no store at all, and
   * every later operation reading through a null one reported a host
   * TypeError — a defect message for a state the studio can explain. */
  function store() {
    active();
    if (state.store === null) {
      const error = new Error('the store is not open: the last open was refused,'
        + ' so recreate it from the model pane');
      /** @type {any} */ (error).code = 'JD2005';
      throw error;
    }
    return state.store;
  }

  /** Close the store, ending every subscription it was feeding. */
  const closeStore = async () => {
    if (state.store === null) return;
    for (const entry of [...state.lives]) entry.stop();
    const store = state.store;
    state.store = null;
    await store.close();
  };

  /**
   * Open (or recreate) the store on a model. Everything that reopens goes
   * through here, so nothing can reopen without releasing first.
   * @param {any} args
   */
  async function open(args) {
    await closeStore();
    active();
    if (args.reset === true) await host.unlink();
    active();
    state.model = args.model;
    await acceptStore(await openStore(args.model, {
      driver: host.makeDriver(), path: host.path(), capture: true, operators: host.operators,
    }));
    const opened = storeInfo();
    host.announce({ store: 'opened', reset: args.reset === true, ...opened });
    return opened;
  }

  /** The model and capabilities every attached tab must follow. */
  function storeInfo() {
    const capabilities = store().capabilities;
    const collection = Object.keys(state.model.collections)[0];
    return {
      vfs: host.vfs(),
      model: state.model,
      collection,
      keyPointer: state.model.collections[collection].key ?? '/id',
      capabilities: {
        version: capabilities.version,
        capture: capabilities.capture,
        live: capabilities.live,
        userFunctions: capabilities.userFunctions,
        operators: capabilities.operators,
        pushableOperators: capabilities.pushableOperators,
      },
    };
  }

  /**
   * Plan a migration, apply it, and reopen. The store is reopened either
   * way — on the new model when the migration returned, on the model it
   * still has when it did not — and a refusal is re-thrown so it reaches
   * the caller as the declared failure rather than as a report of work
   * that never happened.
   * @param {any} args
   */
  async function migrateTo(args) {
    const baseline = state.model;
    const { migration, report } = planModelMigration(baseline, args.to,
      { dialect: store().dialect, id: args.id ?? 'studio-migration' });
    const rendered = migration.steps.map((/** @type {any} */ step) => step.sql ?? step.kind);
    await closeStore();
    active();
    const driver = host.makeDriver();
    const path = host.path();
    /** @type {any} */
    let applied = null;
    /** @type {unknown} */
    let refused = null;
    try {
      applied = host.durable()
        ? await migrate({ driver, path }, [migration],
          { baseline, model: args.to, shadow: true })
        : { applied: [], note: 'memory stores recreate instead of migrating' };
    }
    catch (error) {
      refused = error;
    }
    active();
    state.model = refused === null ? args.to : baseline;
    await acceptStore(await openStore(state.model,
      { driver, path, capture: true, operators: host.operators }));
    host.announce({ store: 'migrated', applied: refused === null, ...storeInfo() });
    if (refused !== null) throw refused;
    const note = applied.note;
    return {
      planned: rendered,
      losses: report?.losses ?? [],
      // the runner answers the ids it applied, as strings — reading an
      // `id` member off them published a list of nulls under a
      // declaration of strings, and the page counted them as successes
      applied: applied.applied ?? [],
      ...(note !== undefined ? { note } : {}),
    };
  }

  /**
   * Subscribe a live query, as the stream binding's duck-typed
   * subscription. The registration is held so the count is its size and
   * so a reopen can end it.
   * @param {any} input
   */
  async function live(input) {
    const query = await store().collection(input.collection)
      .live(input.document, { externals: input.externals ?? {} });
    if (disposed) { query.close(); active(); }
    /** @type {any} */
    const entry = { live: query };
    entry.stop = releaser(entry);
    state.lives.add(entry);
    return {
      snapshot: () => query.result,
      subscribe: (/** @type {(emission: any) => void} */ cb) => query.subscribe(cb),
      close: () => entry.stop(),
    };
  }

  /**
   * Run one query over a throwaway store: a fresh in-memory store on
   * the given model, the documents inserted, the query executed, and
   * the store closed whatever happened. Nothing here reads or writes
   * the store this context holds, which is what lets a second executor
   * be held to the engine's recorded answers from any tab — the corpus
   * needs execution, not persistence.
   *
   * The empty sequence is `undefined`, which JSON cannot carry and
   * `null` must not stand in for (null is an answer the engine can
   * record). It crosses as a flag beside a null answer.
   * @param {any} input
   */
  async function oracle(input) {
    const scratch = await openStore(input.model,
      { driver: host.makeScratchDriver(), path: ':memory:', operators: host.operators });
    try {
      const rows = scratch.collection(input.collection);
      for (const document of input.documents) await rows.insert(document);
      const options = { externals: input.externals ?? {} };
      const answer = await rows.execute(input.query, options);
      /** @type {any} */
      const out = { answer: answer === undefined ? null : answer, empty: answer === undefined };
      // the plan beside the answer, when asked: the same record
      // `data.explain` gives over the studio's store, so a reader can
      // see the pushdown a throwaway store ran, not only what it said
      if (input.explain === true) out.explain = await rows.explain(input.query, options);
      return out;
    }
    finally {
      await scratch.close();
    }
  }

  /** Every store rejection crosses as the declared `db` failure, so a
   * genuine host bug is the only thing that answers the binding's JC2070.
   * @param {(input: any) => any} fn */
  const guard = (fn) => async (/** @type {any} */ input) => {
    try {
      active();
      return await fn(input);
    }
    catch (error) {
      return ContractFailure('db', {}, wireError(error));
    }
  };

  const collection = (/** @type {any} */ input) => store().collection(input.collection);

  /** The operations, before either transport's policy is applied. */
  const operations = {
    'data.init': () => host.init(),
    'data.open': (/** @type {any} */ input) => open(input),
    'data.insert': (/** @type {any} */ input) => collection(input).insert(input.doc),
    'data.delete': (/** @type {any} */ input) => collection(input).delete(input.key),
    'data.rows': (/** @type {any} */ input) => collection(input)
      .execute([{ $for: { it: '$[*]' }, $return: '$it' }]),
    'data.execute': (/** @type {any} */ input) => collection(input)
      .execute(input.document, { externals: input.externals ?? {} }),
    'data.explain': (/** @type {any} */ input) => collection(input)
      .explain(input.document, { externals: input.externals ?? {} }),
    'data.oracle': (/** @type {any} */ input) => oracle(input),
    'data.live': (/** @type {any} */ input) => live(input),
    'data.lives': () => ({ count: state.lives.size }),
    'data.migrate': (/** @type {any} */ input) => migrateTo(input),
  };

  const handlers = Object.fromEntries(
    Object.entries(operations).map(([id, fn]) => [id, guard(fn)]));

  return {
    handlers,
    // Refuse new calls immediately; an in-flight open closes its own late handle.
    dispose: () => { disposed = true; return closeStore(); },
    // The channel a CLIENT tab reaches the owner on serves the same store
    // through the same table. A client open only attaches: it reads the
    // current model without closing the owner's connection or live feeds.
    clientHandlers: {
      ...handlers,
      'data.open': guard((/** @type {any} */ input) => {
        if (input.reset === true) {
          throw ownerOnly('recreating the store unlinks the database the owning tab holds:'
            + ' run it in that tab, not from a client');
        }
        return storeInfo();
      }),
      'data.migrate': guard(() => {
        throw ownerOnly('only the owning tab can migrate the store; run the migration in that tab');
      }),
    },
    state,
  };
}
