//@ts-check
/**
 * @file `createDbLedger(client, options)`: the contract ledger
 * (`@jarenjs/contract` docs/CONTRACT-FORMAT.md §8) over a declared
 * collection of the client's store — every claim state, the persisted
 * generation fence, expiry, `sweep` — through the client's collection
 * and transaction surface alone. Nothing here imports the contract
 * package or a driver: the ledger SHAPE is structural (the
 * `claim`/`commit`/`fail`/`lookup` the http binding calls), the record
 * is exactly `idempotencyLedgerModel`'s, and the id is the same
 * versioned JSON tuple the memory ledger spells. A root client claims
 * inside `transaction(…, { mode: 'immediate' })` — one writer, so two
 * processes never both hold `new`; a transaction client claims and
 * settles inside the transaction it was handed, which is the ledger a
 * lifecycle settlement lease carries: a domain write and the settlement
 * then commit together or not at all.
 */

import { resolveRuntime } from '@jarenjs/core/runtime';

import { LinqRuntimeError } from '../errors.js';

/** One day, the default retention of a key — the memory ledger's. */
const DEFAULT_TTL_MS = 86_400_000;

/** The collection `idempotencyLedgerModel` declares. */
const DEFAULT_COLLECTION = 'ledger';

/**
 * The id of one `(op, scope, key)` tuple — the version `1`, a colon, the
 * JSON array of the three: the spelling `@jarenjs/contract/ledger`'s
 * `ledgerId` writes, so a store's records and a memory ledger's agree.
 * A record written under the legacy `"<op>|<scope>|<key>"` spelling is
 * matched by no claim again; it expires by its own `expiresAt` (`sweep`)
 * or a host rewrites it once (DB-CLIENT.md §2.6).
 * @param {string} op
 * @param {string} scope
 * @param {string} key
 * @returns {string}
 */
function ledgerId(op, scope, key) {
  return `1:${JSON.stringify([op, scope, key])}`;
}

/**
 * @typedef {Object} DbLedgerOptions
 * @property {string} [collection] - the declared collection, `'ledger'` by default
 * @property {number} [ttlMs] - the retention of a key, 86,400,000 ms by default
 * @property {Partial<import('@jarenjs/core/runtime').Runtime>} [runtime] -
 *   the host's runtime record: its `now` is the clock, its `uuid` mints
 *   every generation
 * @property {() => number} [now] - the clock; wins over the runtime's
 */

/**
 * @param {unknown} ref
 * @param {string} reason
 * @returns {LinqRuntimeError}
 */
function stale(ref, reason) {
  const r = /** @type {any} */ (ref);
  const named = r !== null && typeof r === 'object' && typeof r.id === 'string' ? r.id : 'a ref this ledger did not issue';
  return new LinqRuntimeError('JL2007', `${named} settles no started record: ${reason}`);
}

/**
 * The durable ledger over a client's declared collection.
 * @param {any} client - a `@jarenjs/linq/db` client: the root one, or
 *   the one a transaction callback received
 * @param {DbLedgerOptions} [options]
 * @returns {{ claim: (claim: { op: string, scope: string, key: string, hash: string, now?: number }) => Promise<any>,
 *   commit: (ref: unknown, response: unknown, now?: number) => Promise<void>,
 *   fail: (ref: unknown, retryable: boolean, response?: unknown, now?: number) => Promise<void>,
 *   lookup: (key: { op: string, scope: string, key: string, now?: number }) => Promise<any>,
 *   sweep: (now?: number) => Promise<number> }}
 */
export function createDbLedger(client, options = {}) {
  if (client === null || typeof client !== 'object' || client.collections === null
    || typeof client.collections !== 'object' || typeof client.transaction !== 'function') {
    throw new TypeError('createDbLedger: client must be a @jarenjs/linq/db client — the root client, or the one a transaction callback received');
  }
  const name = options.collection === undefined ? DEFAULT_COLLECTION : options.collection;
  if (typeof name !== 'string' || name === '') throw new TypeError('createDbLedger: collection must be a non-empty collection name');
  if (!Object.hasOwn(client.collections, name)) {
    throw new TypeError(`createDbLedger: the client declares no collection '${name}' — open the store with idempotencyLedgerModel, or a model that declares it`);
  }
  const ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('createDbLedger: ttlMs must be a positive number');
  let runtime;
  try {
    runtime = resolveRuntime(options.runtime);
  }
  catch (error) {
    throw new TypeError(`createDbLedger: runtime: ${error instanceof Error ? error.message : String(error)}`);
  }
  const clock = options.now === undefined ? runtime.now : options.now;
  if (typeof clock !== 'function') throw new TypeError('createDbLedger: now must be a function');
  // the memory ledger's clock discipline: one clock judges a record from
  // claim to expiry — its own when given, else the binding's instants
  const ownClock = options.now !== undefined || options.runtime !== undefined;
  /** @type {number | null} */
  let latest = null;
  /** @param {number | undefined} given */
  const instant = (given) => {
    if (typeof given === 'number') {
      if (!ownClock) latest = latest === null ? given : Math.max(latest, given);
      return given;
    }
    return ownClock || latest === null ? clock() : latest;
  };
  // a root client owns a connection and takes the write lock up front; a
  // transaction client is inside one already and nests a savepoint, so
  // the settlement commits with the host's own writes
  const root = typeof client.close === 'function';
  /** @param {(tx: any) => Promise<any>} fn */
  const inside = (fn) => (root ? client.transaction(fn, { mode: 'immediate' }) : client.transaction(fn));
  /** @param {any} tx */
  const rows = (tx) => tx.collections[name];

  /**
   * Settle the started record a ref names, or refuse (`JL2007`).
   * @param {unknown} ref
   * @param {{ status: 'committed' | 'failed', response: unknown, retryable: boolean | null }} changes
   * @param {number | undefined} now
   */
  function settle(ref, changes, now) {
    const r = /** @type {any} */ (ref);
    if (r === null || typeof r !== 'object' || typeof r.id !== 'string' || typeof r.generation !== 'string') {
      return Promise.reject(stale(ref, 'a ref is { id, generation } as this ledger issued it'));
    }
    const at = instant(now);
    return inside(async (tx) => {
      const c = rows(tx);
      const record = await c.get(r.id);
      if (record === undefined || record.generation !== r.generation || record.status !== 'started'
        || record.expiresAt <= at) {
        throw stale(ref, 'the key expired, was reclaimed under a newer generation, or was settled already');
      }
      await c.put({ ...record, ...changes, updatedAt: at }, r.id);
    });
  }

  return Object.freeze({
    claim({ op, scope, key, hash, now }) {
      const at = instant(now);
      const id = ledgerId(op, scope, key);
      return inside(async (tx) => {
        const c = rows(tx);
        const existing = await c.get(id);
        if (existing !== undefined) {
          if (existing.expiresAt <= at) await c.delete(id);
          else if (existing.hash !== hash) return { state: 'mismatch' };
          else if (existing.status === 'started') return { state: 'in-progress' };
          else if (existing.status === 'committed') return { state: 'replay', response: existing.response };
          else if (existing.retryable !== true && existing.response !== null) return { state: 'replay', response: existing.response };
          else await c.delete(id); // a retryable failure: the key runs again
        }
        const generation = runtime.uuid();
        await c.insert({
          id, generation, op, scope, key, hash, status: 'started', response: null, retryable: null,
          createdAt: at, updatedAt: at, expiresAt: at + ttlMs,
        });
        return { state: 'new', ref: Object.freeze({ id, generation }) };
      });
    },
    commit(ref, response, now = undefined) {
      return settle(ref, { status: 'committed', response, retryable: null }, now);
    },
    fail(ref, retryable, response = undefined, now = undefined) {
      return settle(ref, { status: 'failed', response: response === undefined ? null : response, retryable: retryable === true }, now);
    },
    lookup({ op, scope, key, now = undefined }) {
      const at = instant(now);
      const id = ledgerId(op, scope, key);
      return inside(async (tx) => {
        const c = rows(tx);
        const record = await c.get(id);
        if (record === undefined) return null;
        if (record.expiresAt <= at) {
          await c.delete(id);
          return null;
        }
        return record; // the store's fresh document: nothing of the ledger's own
      });
    },
    sweep(now = undefined) {
      const at = instant(now);
      return inside(async (tx) => {
        const c = rows(tx);
        const expired = await c.where((/** @type {any} */ r) => r.expiresAt.le(at)).select((/** @type {any} */ r) => r.id).toArray();
        for (const id of expired) await c.delete(id);
        return expired.length;
      });
    },
  });
}
