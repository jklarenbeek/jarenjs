//@ts-check
/**
 * @file The owner lease (MODEL-FORMAT §5.1): a Store opened with
 * `owner: { id, leaseMs }` is its database's single writable owner, and a
 * second Store that asks for ownership is refused by name (`JD2061`)
 * instead of writing beside it.
 *
 * SQLite keeps the lease in one row of an engine table — the owner's id,
 * the holding Store's random token, the expiry — taken in an immediate
 * bracket at open, renewed every third of the lease as a write of the
 * store's own that takes the gate's next turn and waits for the holder
 * however long it holds, and deleted at close; a
 * holder that crashed leaves the row to expire. A renewal that finds
 * another holder's token marks the lease lost, and every later call of the
 * Store refuses. A lease that lapsed on the holder's own clock (a suspended
 * process, a starved event loop) is renewed before the next call runs, and
 * that call is refused only when the renewal cannot confirm the lease is
 * still this Store's. A call is checked again once the gate admits it: one
 * that waited in the queue past the lease's expiry refuses rather than
 * write beside the next owner.
 *
 * PostgreSQL holds a session advisory lock of its own class instead: no
 * table, and no expiry — it is held for exactly as long as the Store's
 * session, so it is released at close (explicitly: a pooled session
 * outlives the Store) or when the session ends; a session whose release
 * could not run is destroyed rather than pooled.
 *
 * The lease is cooperative: only an open that asks for `owner` takes or
 * checks it. A read-only open never does.
 */

import { chain, isThenable } from '@jarenjs/core/function';

import { DbCompileError, DbRuntimeError } from './errors.js';

/** The lease's default length, in milliseconds. */
export const OWNER_LEASE_DEFAULT_MS = 30_000;
/** The shortest lease: a renewal every third of it must be able to run. */
export const OWNER_LEASE_MIN_MS = 1_000;

/**
 * How an expiry reads in a refusal.
 * @param {number | null} at
 */
const printed = (at) => (at === null || !Number.isFinite(at) ? 'an unknown time' : new Date(at).toISOString());

/**
 * The refusal of a Store that is not, or is no longer, the owner.
 * @param {string} reason
 * @param {{ owner: string | null, expiresAt: number | null }} holder
 * @param {boolean} retryable
 * @param {unknown} [cause]
 */
function notOwner(reason, holder, retryable, cause = undefined) {
  const error = new DbRuntimeError('JD2061', reason, cause === undefined ? undefined : { cause });
  Object.assign(error, { owner: holder.owner, expiresAt: holder.expiresAt, class: 'busy', retryable });
  return error;
}

/** Answer `undefined` whatever `fn` does: a release is best effort.
 * @param {() => any} fn @returns {any} */
const quietly = (fn) => {
  try {
    const out = fn();
    return isThenable(out) ? out.then(() => undefined, () => undefined) : undefined;
  }
  catch {
    return undefined;
  }
};

/**
 * The lease of one Store. `acquire()` runs in the open sequence, before
 * any table of the model is created or verified; `guard()` runs at every
 * admission — a store-level call, a transaction's begin — and answers
 * `undefined` (value-or-promise) or throws the refusal; `admitted()` runs
 * once the gate has admitted the call, and only throws; `release()` never
 * fails, and `holds()` says whether a session lock outlived it.
 * @param {{
 *   dialect: any,
 *   owner: { id: string, leaseMs: number },
 *   adopt: boolean,
 *   now: () => number,
 *   bracket: (fn: () => any) => any,
 *   exclusively: (fn: (scope: any) => any, what: string,
 *     options?: { first?: boolean, unbounded?: boolean, signal?: AbortSignal }) => any,
 *   renewsInline: () => boolean,
 *   connection: any,
 * }} context - `bracket` is the open path's immediate bracket; `exclusively`
 *   holds the connection for one call (the store gate, never refusing to
 *   wait; `first` takes the gate's next turn, `unbounded` waits past
 *   `queueTimeout` until `signal` takes it off the queue); `renewsInline`
 *   says whether a renewal may run from the caller's own extent — never from
 *   inside a transaction's synchronous body, whose rollback would take the
 *   renewal with it
 * @returns {{ mode: 'lease' | 'session', acquire: () => any, guard: (synchronous: boolean) => any,
 *   admitted: () => void, release: () => any, holds: () => boolean }}
 */
export function createOwnerLease(context) {
  const { dialect, owner, now, connection } = context;
  const strategy = dialect.owner;
  if (strategy === undefined || strategy === null) {
    throw new DbCompileError('JD0003',
      `this driver's ${dialect.name} dialect has no owner strategy, so a store on it cannot be opened with { owner }`);
  }
  return strategy.kind === 'session'
    ? sessionLock(strategy, context, owner, connection)
    : tableLease(strategy, context, owner, now);
}

/**
 * PostgreSQL: one session lock per schema.
 * @param {any} strategy @param {any} context
 * @param {{ id: string }} owner @param {any} connection
 */
function sessionLock(strategy, context, owner, connection) {
  let held = false;
  /** @param {any} on @param {string} sql */
  const one = (on, sql) => chain(on.prepare(sql, { buffered: true }), (statement) => statement.get([]));
  return {
    mode: /** @type {const} */ ('session'),
    acquire: () => (held ? undefined : chain(one(connection, strategy.acquire), (row) => {
      // the driver reads a boolean as 1 or 0, as SQLite spells one
      if (row?.held === true || row?.held === 1) {
        held = true;
        return undefined;
      }
      // a strict function of a NULL key answers NULL: the session has no
      // current schema to own
      if (row?.held !== false && row?.held !== 0) {
        throw new DbCompileError('JD0003',
          'the PostgreSQL session has no current schema, so there is nothing for { owner } to hold');
      }
      throw notOwner(`another session owns schema "${row.schema}": it holds the store's owner lock until its `
        + `store closes or its session ends (this store asked as '${owner.id}')`, { owner: null, expiresAt: null }, true);
    })),
    // the lock cannot be lost without the session, and a lost session is
    // refused by every call already (JD2087)
    guard: () => undefined,
    admitted: () => undefined,
    // under the store gate, so it follows whatever the session is still
    // doing, and before the driver restores the session's search path —
    // the key is the current schema. `held` clears only once the server
    // says the lock is released: a release that failed, or outwaited the
    // gate behind a body that never settled, leaves it held, and the
    // store's close then destroys the session rather than pool it
    release: () => {
      if (!held) return undefined;
      return quietly(() => chain(context.exclusively((/** @type {any} */ scope) => one(scope, strategy.release),
        'the owner lock release'), (/** @type {any} */ row) => {
        if (row?.released === true || row?.released === 1) held = false;
      }));
    },
    holds: () => held,
  };
}

/**
 * SQLite: one engine-table row.
 * @param {any} strategy @param {any} context
 * @param {{ id: string, leaseMs: number }} owner @param {() => number} now
 */
function tableLease(strategy, context, owner, now) {
  const { connection, bracket, exclusively, renewsInline, adopt } = context;
  // A token of this Store alone: two Stores of one process are two owners,
  // under one id or not. The platform's own generator, never an injected
  // one — a deterministic identifier can repeat across processes.
  const holder = globalThis.crypto.randomUUID();
  const renewEvery = Math.max(1, Math.floor(owner.leaseMs / 3));
  /** This holder's expiry, as last written. */
  let expiresAt = 0;
  /** Who holds the lease once another holder took it, or `null`. @type {{ owner: string | null, expiresAt: number | null } | null} */
  let lost = null;
  /** @type {any} */
  let timer = null;
  let stopped = false;
  /** The timer's renewal in flight, or `null`. @type {Promise<void> | null} */
  let renewing = null;
  /** Takes the timer's renewal off the gate's queue when the store closes. */
  const closing = new AbortController();

  /** @param {any} scope @param {string} sql @param {any[]} params */
  const run = (scope, sql, params) => chain(scope.prepare(sql), (statement) => statement.run(params));
  /** @param {any} scope */
  const read = (scope) => chain(scope.prepare(strategy.read), (statement) => statement.get([]));
  /** @param {any} row */
  const holderOf = (row) => (row === undefined || row === null
    ? { owner: null, expiresAt: null }
    : { owner: String(row.owner), expiresAt: Number(row.expiresAt) });

  const lostRefusal = () => {
    const current = /** @type {{ owner: string | null, expiresAt: number | null }} */ (lost);
    return notOwner(current.owner === null
      ? `this store's lease was taken over, and the database no longer names an owner; this store is not `
        + `its owner any more ('${owner.id}') — close it and open again`
      : `this store's lease was taken over: '${current.owner}' holds it until ${printed(current.expiresAt)}; `
        + `this store is not the database's owner any more ('${owner.id}') — close it`, current, false);
  };

  /**
   * One renewal, on the scope that holds the connection: extend this
   * holder's row, or find that another holder's replaced it.
   * @param {any} scope
   */
  const renewOn = (scope) => {
    const until = now() + owner.leaseMs;
    return chain(run(scope, strategy.renew, [until, holder]), (result) => {
      if (Number(result?.changes ?? 0) > 0) {
        expiresAt = until;
        return undefined;
      }
      return chain(read(scope), (row) => { lost = holderOf(row); });
    });
  };

  /**
   * One renewal under the store gate, at its next turn — it waits for the
   * call that holds the connection, never behind every caller queued after
   * it. A failure leaves the lease to lapse (the next renewal, or the next
   * call, tries again).
   * @param {{ unbounded?: boolean, signal?: AbortSignal }} [options]
   * @returns {any} value-or-promise
   */
  const renewOnce = (options = undefined) => {
    if (stopped || lost !== null) return undefined;
    let out;
    try {
      out = exclusively((scope) => renewOn(scope), 'the owner lease renewal', { ...options, first: true });
    }
    catch {
      return undefined;
    }
    return isThenable(out) ? Promise.resolve(out).then(() => undefined, () => undefined) : undefined;
  };

  /** The timer's renewal: it waits for the holder however long the holder
   * holds, not `queueTimeout` — a renewal that gave up behind a transaction
   * still running would come back a third of the lease later, past the
   * expiry `leaseMs` above 1.5 × `holdTimeoutMs` keeps it clear of. Closing
   * the store takes it off the queue. @returns {any} value-or-promise */
  const renewInBackground = () => {
    if (renewing !== null) return renewing;
    const out = renewOnce({ unbounded: true, signal: closing.signal });
    if (!isThenable(out)) return undefined;
    renewing = out.finally(() => { renewing = null; });
    return renewing;
  };

  const arm = () => {
    if (stopped || lost !== null) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const out = renewInBackground();
      if (isThenable(out)) void out.then(arm);
      else arm();
    }, renewEvery);
    // a Store never kept its process alive: a lease left behind expires
    timer.unref?.();
  };

  /** The refusal of a lease that lapsed and could not be renewed. */
  const lapsed = () => notOwner(`this store's lease lapsed: its clock passed the lease's expiry `
    + `(${printed(expiresAt)}) before a renewal, and renewing it did not succeed yet; nothing ran — try again`,
  { owner: owner.id, expiresAt }, true);

  return {
    mode: /** @type {const} */ ('lease'),
    acquire: () => chain(bracket(() => chain(adopt
      ? chain(connection.prepare(connection.dialect.introspect.tableExists()), (statement) =>
        chain(statement.get([strategy.table]), (row) => {
          if (row === undefined) {
            throw new DbCompileError('JD0015',
              `an adopted store creates no table, and this database has no owner table for { owner } — `
              + `create it once (${strategy.create}), or open once without adopt, which creates it`);
          }
          return undefined;
        }))
      : connection.exec(strategy.ensure), () =>
      chain(connection.prepare(strategy.read), (statement) => chain(statement.get([]), (row) => {
        const at = now();
        if (row !== undefined && String(row.holder) !== holder && Number(row.expiresAt) > at) {
          const current = holderOf(row);
          throw notOwner(`another owner holds this database: '${current.owner}' holds the lease until `
            + `${printed(current.expiresAt)} — wait for it to expire or for that store to close, or open read-only`,
          current, true);
        }
        const until = at + owner.leaseMs;
        return chain(connection.prepare(strategy.take), (take) => chain(take.run([owner.id, holder, until]), () => {
          expiresAt = until;
        }));
      })))), () => { arm(); }),
    /** @param {boolean} synchronous - the caller cannot wait for a renewal */
    guard: (synchronous) => {
      if (lost !== null) throw lostRefusal();
      if (now() < expiresAt) return undefined;
      // lapsed on this holder's own clock: confirm and extend before
      // anything runs — unless the call is inside a transaction's own
      // synchronous body, whose rollback would undo the renewal
      if (!renewsInline()) throw lapsed();
      // the call's own renewal asks once, as long as the call would queue
      const renewal = renewOnce();
      // a caller that answers values cannot wait for a renewal that queued
      if (synchronous && isThenable(renewal)) throw lapsed();
      return chain(renewal, () => {
        if (lost !== null) throw lostRefusal();
        if (now() >= expiresAt) throw lapsed();
        return undefined;
      });
    },
    // the call the gate admitted, checked again: it may have waited in
    // the queue past the lease's expiry, and another holder may own the
    // database by now. It never renews — the renewal is a write of its
    // own, and this call holds the connection it would wait for
    admitted: () => {
      if (lost !== null) throw lostRefusal();
      if (now() >= expiresAt) throw lapsed();
    },
    // after the calls already queued, which were admitted under the lease;
    // a body that never settles holds the gate, and a release that
    // outwaits it leaves the row to expire
    release: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      closing.abort();
      if (lost !== null || expiresAt === 0) return undefined;
      return quietly(() => chain(renewing, () =>
        exclusively((scope) => run(scope, strategy.release, [holder]), 'the owner lease release')));
    },
    holds: () => false,
  };
}
