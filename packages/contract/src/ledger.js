//@ts-check
/**
 * @file Idempotency as data: the ledger INTERFACE the http server
 * binding calls when an operation declares `policy.idempotency`, a
 * `createMemoryLedger` reference implementation for tests and
 * single-process hosts, and the two documents a durable host opens with
 * the rest of the suite — `idempotencyLedgerModel` (a `$model` 0.1
 * document for `@jarenjs/db`) and `commandLifecycleFsm` (a `$fsm` 0.1
 * document for `@jarenjs/flow`). Both are JSON only: this package never
 * imports db or flow (docs/CONTRACT-FORMAT.md §8).
 *
 * The three identities stay apart here as everywhere: the idempotency
 * KEY is the caller's (sent as `Idempotency-Key`, scoped by the host's
 * `scope`), the request HASH is the binding's (SHA-256 over the RFC 8785
 * canonical input), and the TRACE is never stored — a replay carries a
 * fresh one.
 */

import { resolveRuntime } from '@jarenjs/core/runtime';
import { refuseUnknownMembers } from '@jarenjs/core/object';
import { compareCodePoints } from '@jarenjs/core/string';

import { ContractHostError } from './errors.js';

/**
 * The record a ledger keeps per `(op, scope, key)`; the schema of
 * `idempotencyLedgerModel`'s collection.
 * @typedef {Object} LedgerRecord
 * @property {string} id - {@link ledgerId} of the tuple
 * @property {string} generation - the identity of the claim that started
 *   this record: minted per `started` record, carried by the `ref`, and
 *   verified by `commit`/`fail` — a ref of an earlier generation settles
 *   nothing (`JC1011`)
 * @property {string} op
 * @property {string} scope
 * @property {string} key
 * @property {string} hash - lowercase hex SHA-256 over the canonical input
 * @property {'started' | 'committed' | 'failed'} status
 * @property {any} response - the stored `{ status, headers, body }`, or null;
 *   a header's value is a list when the field repeats on the wire
 *   (`set-cookie`), so a replay re-issues the credential the first answer
 *   carried
 * @property {boolean | null} retryable - of a failed record; null otherwise
 * @property {number} createdAt - epoch ms
 * @property {number} updatedAt - epoch ms
 * @property {number} expiresAt - epoch ms
 */

/**
 * The ref a `new` claim hands back and a settlement names: the record's
 * `id` and the `generation` the claim minted — portable across
 * processes, and stale the moment the key expires or is reclaimed.
 * @typedef {{ readonly id: string, readonly generation: string }} LedgerRef
 */

/**
 * The claim result: `new` hands back a `ref` to commit or fail; `replay`
 * carries the stored response; `in-progress` and `mismatch` are the two
 * 409 answers.
 * @typedef {{ state: 'new', ref: LedgerRef }
 *   | { state: 'replay', response: any }
 *   | { state: 'in-progress' }
 *   | { state: 'mismatch' }} ClaimResult
 */

/**
 * The ledger interface the http binding calls. Every method may return
 * its value or a promise of it — the binding composes with `chain`, so a
 * synchronous ledger costs no promise. Semantics the binding relies on:
 * same key + same hash → `replay` of the stored response; same key +
 * different hash → `mismatch`; `started` and unexpired → `in-progress`;
 * `failed` with `retryable: true` → `new` (the key may be retried);
 * `failed` and not retryable → `replay` of the stored failure. `now` on
 * a claim, a commit, a failure and a lookup is the binding's clock
 * (epoch ms): ONE clock must judge a record from claim to expiry, so a
 * ledger that has no clock of its own follows the binding's, and a
 * ledger with its own clock is given the same record as the binding
 * (`runtime`) rather than a second one. A `commit`/`fail` whose ref
 * settles no `started` record — expired, reclaimed under a newer
 * generation, or settled already — throws (or rejects) `JC1011`; the
 * binding reports it to `onError` and the response still goes out.
 * @typedef {Object} Ledger
 * @property {(claim: { op: string, scope: string, key: string, hash: string, now?: number }) => ClaimResult | Promise<ClaimResult>} claim
 * @property {(ref: unknown, response: any, now?: number) => void | Promise<void>} commit
 * @property {(ref: unknown, retryable: boolean, response?: any, now?: number) => void | Promise<void>} fail
 * @property {(key: { op: string, scope: string, key: string, now?: number }) => LedgerRecord | null | Promise<LedgerRecord | null>} lookup
 * @property {(now?: number) => number | Promise<number>} [sweep] - drop every
 *   expired record and answer how many; optional — the binding never calls
 *   it (retention is the host's schedule), and both suite ledgers carry it
 * @property {(query?: InFlightQuery) => InFlightClaim[] | Promise<InFlightClaim[]>} [inFlight] -
 *   the claims still `started` and blocking their key, oldest first;
 *   optional — the binding never calls it, and both suite ledgers carry it
 * @property {(claim: { op: string, scope: string, key: string, generation?: string, now?: number }) => boolean | Promise<boolean>} [release] -
 *   free one `started` claim as a server fault leaves it (failed,
 *   retryable, no response), so the next claim of the key is `new`;
 *   `false` when there is nothing to release. Optional, as `inFlight`
 *
 * A `fail(ref, false)` carries the response it replays: without one the
 * failure could replay nothing, and a ledger that freed the key instead
 * re-ran a command that had failed for good — it is refused (`JC1015` on
 * the memory ledger), and the claim stays `started`.
 */

/**
 * What `inFlight` reads — a closed set: `op` and `scope` narrow to one
 * operation or scope, `olderThan` (epoch ms, an instant like every
 * ledger `now`) keeps the claims made before it, `limit` (default 1,000)
 * bounds the answer.
 * @typedef {{ op?: string, scope?: string, olderThan?: number, limit?: number, now?: number }} InFlightQuery
 */

/**
 * One claim `inFlight` reports: the tuple, the generation that started
 * it (what `release` may name), and when it was claimed.
 * @typedef {{ op: string, scope: string, key: string, generation: string, claimedAt: number }} InFlightClaim
 */

/** One day, the default retention of a key. */
const DEFAULT_TTL_MS = 86_400_000;

/** The most claims one `inFlight` answers by default. */
const IN_FLIGHT_LIMIT = 1_000;

/**
 * Read `inFlight`'s query (a closed set, refused by name before anything
 * is read).
 * @param {unknown} query
 * @param {string} spelling
 * @returns {{ op?: string, scope?: string, olderThan?: number, limit: number, now?: number }}
 */
function readInFlightQuery(query, spelling) {
  if (query === undefined) return { limit: IN_FLIGHT_LIMIT };
  if (query === null || typeof query !== 'object' || Array.isArray(query))
    throw new TypeError(`${spelling}: the query is { op?, scope?, olderThan?, limit?, now? }`);
  refuseUnknownMembers(query, ['op', 'scope', 'olderThan', 'limit', 'now'], (key, hint) =>
    new TypeError(`${spelling}: '${key}' is not a member the query reads${hint}`));
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
 * Read `release`'s argument (a closed set): the tuple, and optionally the
 * `generation` the release is fenced to.
 * @param {unknown} claim
 * @param {string} spelling
 * @returns {{ op: string, scope: string, key: string, generation?: string, now?: number }}
 */
function readReleaseClaim(claim, spelling) {
  if (claim === null || typeof claim !== 'object' || Array.isArray(claim))
    throw new TypeError(`${spelling}: the claim is { op, scope, key, generation?, now? }`);
  // a claim exactly as `inFlight` answers it is accepted, `claimedAt` and all
  refuseUnknownMembers(claim, ['op', 'scope', 'key', 'generation', 'claimedAt', 'now'], (key, hint) =>
    new TypeError(`${spelling}: '${key}' is not a member a release reads${hint}`));
  const { op, scope, key, generation, claimedAt, now } = /** @type {any} */ (claim);
  if (claimedAt !== undefined && !Number.isFinite(claimedAt)) throw new TypeError(`${spelling}: claimedAt is an instant in epoch milliseconds`);
  for (const [name, value] of [['op', op], ['scope', scope], ['key', key]]) {
    if (typeof value !== 'string') throw new TypeError(`${spelling}: ${name} is a string`);
  }
  if (generation !== undefined && typeof generation !== 'string') throw new TypeError(`${spelling}: generation is a string`);
  if (now !== undefined && !Number.isFinite(now)) throw new TypeError(`${spelling}: now is an instant in epoch milliseconds`);
  return { op, scope, key, generation, now };
}

/** The members `createMemoryLedger` reads. */
const MEMORY_LEDGER_OPTIONS = Object.freeze(['ttlMs', 'startedTtlMs', 'now', 'runtime']);

/**
 * The id of one `(op, scope, key)` tuple: the version `1`, a colon, the
 * JSON array of the three. Injective — a `|`, a control character or
 * any Unicode inside a member cannot spell another tuple — and readable
 * in a store. A record written under the legacy `"<op>|<scope>|<key>"`
 * spelling is matched by no claim again: it expires by its own
 * `expiresAt` (`sweep`), or a host rewrites its `id` once
 * (docs/CONTRACT-FORMAT.md §8).
 * @param {string} op
 * @param {string} scope
 * @param {string} key
 * @returns {string}
 */
export function ledgerId(op, scope, key) {
  return `1:${JSON.stringify([op, scope, key])}`;
}

/**
 * The `JC1011` refusal of a settlement whose ref settles no started record.
 * @param {unknown} ref
 * @returns {ContractHostError}
 */
function staleSettlement(ref) {
  const r = /** @type {any} */ (ref);
  const named = r !== null && typeof r === 'object' && typeof r.id === 'string' ? r.id : 'a ref this ledger did not issue';
  return new ContractHostError('JC1011', `ledger: ${named} settles no started record — the key expired, was reclaimed under a newer generation, or was settled already`);
}

/**
 * The reference ledger over a `Map`: synchronous, single-process,
 * expiring on `claim` (a record past `expiresAt` is dropped and the key
 * is `new` again). `sweep()` drops every expired record — a host may
 * call it on a timer.
 * ONE clock judges a record from claim to expiry. The ledger's own clock
 * is `now`, else the runtime record's `now` (`@jarenjs/core/runtime`);
 * given neither, the ledger has no clock of its own and FOLLOWS the
 * binding: every stamp and every expiry decision uses the instant the
 * binding passed with the call, and a host-side `lookup`/`sweep` that
 * passes none uses the latest instant a binding reported. (A record
 * stamped by an injected server clock and judged by the platform's was
 * dropped as expired the moment `sweep()` ran, and the command ran
 * twice.) A ledger WITH its own clock uses it for everything and is
 * given the same record as the binding, never a second one. The runtime
 * record's `uuid` mints each record's `generation`; `lookup` answers a
 * copy, never the ledger's own record.
 *
 * `ttlMs` is a key's retention; `startedTtlMs` (default `ttlMs`, at most
 * it) is how long a `started` claim blocks its key — a claim its request
 * never settled is reclaimed after it, under a new generation, and the
 * generation fence refuses the old ref. A started record's `expiresAt` is
 * that lease; a settled one's is `createdAt + ttlMs`.
 * @param {{ ttlMs?: number, startedTtlMs?: number, now?: () => number,
 *   runtime?: Partial<import('@jarenjs/core/runtime').Runtime> }} [options]
 * @returns {Ledger & { sweep(now?: number): number, size: number,
 *   inFlight(query?: InFlightQuery): InFlightClaim[],
 *   release(claim: { op: string, scope: string, key: string, generation?: string, now?: number }): boolean }}
 */
export function createMemoryLedger(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('createMemoryLedger: options is { ttlMs?, startedTtlMs?, now?, runtime? }');
  refuseUnknownMembers(options, MEMORY_LEDGER_OPTIONS, (key, hint) =>
    new TypeError(`createMemoryLedger: '${key}' is not an option it reads${hint}`));
  // whole milliseconds, as the db ledger stores an expiry: a fraction is
  // refused on both rather than run by one and refused at the first claim
  // by the other
  const ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)
    throw new TypeError('createMemoryLedger: ttlMs must be a positive whole number of milliseconds');
  const startedTtlMs = options.startedTtlMs === undefined ? ttlMs : options.startedTtlMs;
  if (!Number.isSafeInteger(startedTtlMs) || startedTtlMs <= 0 || startedTtlMs > ttlMs)
    throw new TypeError('createMemoryLedger: startedTtlMs must be a positive whole number of milliseconds no greater than ttlMs');
  let runtime;
  try {
    runtime = resolveRuntime(options.runtime);
  }
  catch (error) {
    throw new TypeError(`createMemoryLedger: runtime: ${error instanceof Error ? error.message : String(error)}`);
  }
  const clock = options.now === undefined ? runtime.now : options.now;
  if (typeof clock !== 'function') throw new TypeError('createMemoryLedger: now must be a function');
  const ownClock = options.now !== undefined || options.runtime !== undefined;
  /** The latest instant a binding reported, for a ledger without a clock. */
  let latest = null;
  /** The instant a call is judged and stamped at. */
  const instant = (/** @type {number | undefined} */ given) => {
    if (typeof given === 'number') {
      if (!ownClock) latest = latest === null ? given : Math.max(latest, given);
      return given;
    }
    return ownClock || latest === null ? clock() : latest;
  };
  /** @type {Map<string, LedgerRecord>} */
  const records = new Map();

  /**
   * The started record a ref settles, or the `JC1011` refusal.
   * @param {unknown} ref
   * @param {number} at - The settlement instant, also used for updatedAt
   * @returns {LedgerRecord}
   */
  function settling(ref, at) {
    const r = /** @type {any} */ (ref);
    const record = r !== null && typeof r === 'object' && typeof r.id === 'string' ? records.get(r.id) : undefined;
    if (record === undefined || record.generation !== r.generation || record.status !== 'started'
      || record.expiresAt <= at) throw staleSettlement(ref);
    return record;
  }

  return {
    claim({ op, scope, key, hash, now }) {
      const at = instant(now);
      const id = ledgerId(op, scope, key);
      const existing = records.get(id);
      if (existing !== undefined) {
        if (existing.expiresAt <= at) records.delete(id);
        else if (existing.hash !== hash) return { state: 'mismatch' };
        else if (existing.status === 'started') return { state: 'in-progress' };
        else if (existing.status === 'committed') return { state: 'replay', response: existing.response };
        else if (existing.retryable !== true && existing.response !== null) return { state: 'replay', response: existing.response };
        else records.delete(id);
      }
      const generation = runtime.uuid();
      /** @type {LedgerRecord} */
      const record = {
        id, generation, op, scope, key, hash, status: 'started', response: null, retryable: null,
        // a started record expires at its lease; settled, at its retention
        createdAt: at, updatedAt: at, expiresAt: at + startedTtlMs,
      };
      records.set(id, record);
      return { state: 'new', ref: Object.freeze({ id, generation }) };
    },
    commit(ref, response, now = undefined) {
      const at = instant(now);
      const record = settling(ref, at);
      record.status = 'committed';
      record.response = response;
      record.retryable = null;
      record.updatedAt = at;
      record.expiresAt = record.createdAt + ttlMs;
    },
    fail(ref, retryable, response, now = undefined) {
      // a failure for good replays its response: it must carry one
      if (retryable !== true && (response === undefined || response === null)) {
        const r = /** @type {any} */ (ref);
        throw new ContractHostError('JC1015', `ledger: fail(${r !== null && typeof r === 'object' && typeof r.id === 'string' ? r.id : 'ref'}, false) `
          + 'carried no response — a failure that is not retryable replays its stored response, so pass the one '
          + 'the caller was sent; the claim stays started');
      }
      const at = instant(now);
      const record = settling(ref, at);
      record.status = 'failed';
      record.retryable = retryable === true;
      record.response = response === undefined ? null : response;
      record.updatedAt = at;
      record.expiresAt = record.createdAt + ttlMs;
    },
    lookup({ op, scope, key, now = undefined }) {
      const record = records.get(ledgerId(op, scope, key));
      if (record === undefined) return null;
      if (record.expiresAt <= instant(now)) {
        records.delete(record.id);
        return null;
      }
      return { ...record };
    },
    sweep(now = undefined) {
      const at = instant(now);
      let dropped = 0;
      for (const [id, record] of records) {
        if (record.expiresAt <= at) {
          records.delete(id);
          dropped++;
        }
      }
      return dropped;
    },
    inFlight(query = undefined) {
      const { op, scope, olderThan, limit, now } = readInFlightQuery(query, 'ledger.inFlight');
      const at = instant(now);
      /** @type {InFlightClaim[]} */
      const claims = [];
      for (const record of records.values()) {
        if (record.status !== 'started' || record.expiresAt <= at) continue;
        if ((op !== undefined && record.op !== op) || (scope !== undefined && record.scope !== scope)
          || (olderThan !== undefined && !(record.createdAt < olderThan))) continue;
        claims.push({ op: record.op, scope: record.scope, key: record.key, generation: record.generation,
          claimedAt: record.createdAt });
      }
      // oldest first; the id breaks a tie in code-point order — the order a
      // database compares text by — so two ledgers answer alike
      claims.sort((a, b) => a.claimedAt - b.claimedAt
        || compareCodePoints(ledgerId(a.op, a.scope, a.key), ledgerId(b.op, b.scope, b.key)));
      return claims.slice(0, limit);
    },
    release(claim) {
      const { op, scope, key, generation, now } = readReleaseClaim(claim, 'ledger.release');
      const at = instant(now);
      const record = records.get(ledgerId(op, scope, key));
      if (record === undefined || record.status !== 'started' || record.expiresAt <= at
        || (generation !== undefined && record.generation !== generation)) return false;
      // exactly what a server fault leaves: the next claim is `new`
      record.status = 'failed';
      record.retryable = true;
      record.response = null;
      record.updatedAt = at;
      record.expiresAt = record.createdAt + ttlMs;
      return true;
    },
    get size() {
      return records.size;
    },
  };
}

/**
 * The `$model` 0.1 document of a durable ledger: one collection,
 * `ledger`, keyed by `/id` ({@link ledgerId}), indexed on `expiresAt`
 * (the sweep) and `status` (the in-flight scan). A host opens it with
 * `@jarenjs/db`'s `openStore` and implements the `Ledger` interface over
 * the collection — `createDbLedger` in `@jarenjs/linq/db` is that
 * implementation over the typed client; the record shape is exactly
 * what `createMemoryLedger` keeps, the `generation` included.
 */
export const idempotencyLedgerModel = Object.freeze({
  $model: '0.1',
  collections: {
    ledger: {
      schema: {
        type: 'object',
        required: ['id', 'generation', 'op', 'scope', 'key', 'hash', 'status', 'response', 'retryable', 'createdAt', 'updatedAt', 'expiresAt'],
        properties: {
          id: { type: 'string', minLength: 1 },
          generation: { type: 'string', minLength: 1 },
          op: { type: 'string', minLength: 1 },
          scope: { type: 'string' },
          key: { type: 'string', minLength: 1 },
          hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          status: { type: 'string', enum: ['started', 'committed', 'failed'] },
          response: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                required: ['status', 'headers', 'body'],
                properties: {
                  status: { type: 'integer', minimum: 100, maximum: 599 },
                  headers: { type: 'object', additionalProperties: {
                    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                  } },
                  body: { type: ['string', 'null'] },
                },
              },
            ],
          },
          retryable: { type: ['boolean', 'null'] },
          createdAt: { type: 'integer' },
          updatedAt: { type: 'integer' },
          expiresAt: { type: 'integer' },
        },
        additionalProperties: false,
      },
      key: '/id',
      indexes: [
        { name: 'by_expires', path: '$.expiresAt' },
        { name: 'by_status', path: '$.status' },
      ],
    },
  },
});

/**
 * The `$fsm` 0.1 document of one command's lifecycle under an
 * idempotency key: `idle → started` on `claim`, `started → committed` on
 * `commit`, `started → failed` on `fail`, and `failed → started` on
 * `claim` only when the failure was retryable (`$.context.retryable`).
 * A host compiles it with `@jarenjs/flow` to drive or audit a durable
 * ledger; the memory ledger walks exactly these transitions.
 */
export const commandLifecycleFsm = Object.freeze({
  $fsm: '0.1',
  initial: 'idle',
  states: ['idle', 'started', { id: 'committed', final: true }, 'failed'],
  transitions: [
    { from: 'idle', event: 'claim', to: 'started' },
    { from: 'started', event: 'commit', to: 'committed' },
    { from: 'started', event: 'fail', to: 'failed' },
    { from: 'failed', event: 'claim', guard: '$.context.retryable', to: 'started' },
  ],
});
