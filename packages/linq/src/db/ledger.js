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

/** The most claims one `inFlight` answers by default — the memory ledger's. */
const IN_FLIGHT_LIMIT = 1_000;

/** The members `createDbLedger` reads. */
const DB_LEDGER_OPTIONS = Object.freeze(['collection', 'ttlMs', 'startedTtlMs', 'runtime', 'now']);

/**
 * Refuse a member outside a closed set, naming it and the set (a
 * `TypeError`, as every other refusal of this ledger's arguments).
 * @param {Record<string, unknown>} value
 * @param {readonly string[]} known
 * @param {(key: string, list: string) => string} message
 */
function refuseUnknown(value, known, message) {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) throw new TypeError(message(key, known.map((name) => `'${name}'`).join(', ')));
  }
}

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
 * @property {number} [startedTtlMs] - how long a `started` claim blocks its
 *   key (default `ttlMs`, at most it): past it the next claim reclaims the
 *   key under a new generation, and the old ref is refused (`JL2007`)
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
 * The same closed set the memory ledger reads for `inFlight` — a
 * `TypeError` names an unknown member or a malformed value.
 * @param {unknown} query
 * @returns {{ op?: string, scope?: string, olderThan?: number, limit: number, now?: number }}
 */
function readInFlightQuery(query) {
  const spelling = 'ledger.inFlight';
  if (query === undefined) return { limit: IN_FLIGHT_LIMIT };
  if (query === null || typeof query !== 'object' || Array.isArray(query))
    throw new TypeError(`${spelling}: the query is { op?, scope?, olderThan?, limit?, now? }`);
  refuseUnknown(query, ['op', 'scope', 'olderThan', 'limit', 'now'], (key, list) =>
    `${spelling}: '${key}' is not a member the query reads; it reads ${list}`);
  const { op, scope, olderThan, limit = IN_FLIGHT_LIMIT, now } = /** @type {any} */ (query);
  for (const [name, value] of [['op', op], ['scope', scope]]) {
    if (value !== undefined && typeof value !== 'string') throw new TypeError(`${spelling}: ${name} is a string`);
  }
  for (const [name, value] of [['olderThan', olderThan], ['now', now]]) {
    if (value !== undefined && !Number.isFinite(value)) throw new TypeError(`${spelling}: ${name} is an instant in epoch milliseconds`);
  }
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError(`${spelling}: limit is a whole number from 1`);
  return { op, scope, olderThan, limit, now };
}

/**
 * The same closed set the memory ledger reads for `release`.
 * @param {unknown} claim
 * @returns {{ op: string, scope: string, key: string, generation?: string, now?: number }}
 */
function readReleaseClaim(claim) {
  const spelling = 'ledger.release';
  if (claim === null || typeof claim !== 'object' || Array.isArray(claim))
    throw new TypeError(`${spelling}: the claim is { op, scope, key, generation?, now? }`);
  // a claim exactly as `inFlight` answers it is accepted, `claimedAt` and all
  refuseUnknown(claim, ['op', 'scope', 'key', 'generation', 'claimedAt', 'now'], (key, list) =>
    `${spelling}: '${key}' is not a member a release reads; it reads ${list}`);
  const { op, scope, key, generation, claimedAt, now } = /** @type {any} */ (claim);
  if (claimedAt !== undefined && !Number.isFinite(claimedAt)) throw new TypeError(`${spelling}: claimedAt is an instant in epoch milliseconds`);
  for (const [name, value] of [['op', op], ['scope', scope], ['key', key]]) {
    if (typeof value !== 'string') throw new TypeError(`${spelling}: ${name} is a string`);
  }
  if (generation !== undefined && typeof generation !== 'string') throw new TypeError(`${spelling}: generation is a string`);
  if (now !== undefined && !Number.isFinite(now)) throw new TypeError(`${spelling}: now is an instant in epoch milliseconds`);
  return { op, scope, key, generation, now };
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
 *   sweep: (now?: number) => Promise<number>,
 *   inFlight: (query?: { op?: string, scope?: string, olderThan?: number, limit?: number, now?: number }) =>
 *     Promise<{ op: string, scope: string, key: string, generation: string, claimedAt: number }[]>,
 *   release: (claim: { op: string, scope: string, key: string, generation?: string, now?: number }) => Promise<boolean> }}
 */
export function createDbLedger(client, options = {}) {
  if (client === null || typeof client !== 'object' || client.collections === null
    || typeof client.collections !== 'object' || typeof client.transaction !== 'function') {
    throw new TypeError('createDbLedger: client must be a @jarenjs/linq/db client — the root client, or the one a transaction callback received');
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('createDbLedger: options is { collection?, ttlMs?, startedTtlMs?, runtime?, now? }');
  refuseUnknown(options, DB_LEDGER_OPTIONS, (key, list) =>
    `createDbLedger: '${key}' is not an option it reads; it reads ${list}`);
  const name = options.collection === undefined ? DEFAULT_COLLECTION : options.collection;
  if (typeof name !== 'string' || name === '') throw new TypeError('createDbLedger: collection must be a non-empty collection name');
  if (!Object.hasOwn(client.collections, name)) {
    throw new TypeError(`createDbLedger: the client declares no collection '${name}' — open the store with idempotencyLedgerModel, or a model that declares it`);
  }
  // whole milliseconds: the record's expiry is an integer member, so a
  // fraction would pass here and be refused at the first claim
  const ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)
    throw new TypeError('createDbLedger: ttlMs must be a positive whole number of milliseconds');
  const startedTtlMs = options.startedTtlMs === undefined ? ttlMs : options.startedTtlMs;
  if (!Number.isSafeInteger(startedTtlMs) || startedTtlMs <= 0 || startedTtlMs > ttlMs)
    throw new TypeError('createDbLedger: startedTtlMs must be a positive whole number of milliseconds no greater than ttlMs');
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
      // settled, a record expires at its retention
      await c.put({ ...record, ...changes, updatedAt: at, expiresAt: record.createdAt + ttlMs }, r.id);
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
          // a started record expires at its lease; settled, at its retention
          createdAt: at, updatedAt: at, expiresAt: at + startedTtlMs,
        });
        return { state: 'new', ref: Object.freeze({ id, generation }) };
      });
    },
    commit(ref, response, now = undefined) {
      return settle(ref, { status: 'committed', response, retryable: null }, now);
    },
    fail(ref, retryable, response = undefined, now = undefined) {
      // a failure for good replays its response: it must carry one
      if (retryable !== true && (response === undefined || response === null)) {
        const r = /** @type {any} */ (ref);
        return Promise.reject(new LinqRuntimeError('JL2010', `fail(${r !== null && typeof r === 'object' && typeof r.id === 'string' ? r.id : 'ref'}, false) `
          + 'carried no response — a failure that is not retryable replays its stored response, so pass the one '
          + 'the caller was sent; the claim stays started'));
      }
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
    async inFlight(query = undefined) {
      const { op, scope, olderThan, limit, now } = readInFlightQuery(query);
      const at = instant(now);
      // one read through the status index: no transaction, no lock
      /** @type {any} */
      let chain = rows(client).where((/** @type {any} */ r) => r.status.eq('started'))
        .where((/** @type {any} */ r) => r.expiresAt.gt(at));
      if (op !== undefined) chain = chain.where((/** @type {any} */ r) => r.op.eq(op));
      if (scope !== undefined) chain = chain.where((/** @type {any} */ r) => r.scope.eq(scope));
      if (olderThan !== undefined) chain = chain.where((/** @type {any} */ r) => r.createdAt.lt(olderThan));
      // oldest first; the id breaks a tie, as the memory ledger's does
      const found = await chain.orderBy((/** @type {any} */ r) => r.createdAt).thenBy((/** @type {any} */ r) => r.id)
        .take(limit).toArray();
      return found.map((/** @type {any} */ r) => ({
        op: r.op, scope: r.scope, key: r.key, generation: r.generation, claimedAt: r.createdAt,
      }));
    },
    async release(claim) {
      const { op, scope, key, generation, now } = readReleaseClaim(claim);
      const at = instant(now);
      const id = ledgerId(op, scope, key);
      return inside(async (tx) => {
        const c = rows(tx);
        const record = await c.get(id);
        if (record === undefined || record.status !== 'started' || record.expiresAt <= at
          || (generation !== undefined && record.generation !== generation)) return false;
        // exactly what a server fault leaves: the next claim is `new`
        await c.put({ ...record, status: 'failed', retryable: true, response: null, updatedAt: at,
          expiresAt: record.createdAt + ttlMs }, id);
        return true;
      });
    },
  });
}
