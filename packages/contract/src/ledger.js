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
 * @property {any} response - the stored `{ status, headers, body }`, or null
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
 */

/** One day, the default retention of a key. */
const DEFAULT_TTL_MS = 86_400_000;

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
 * @param {{ ttlMs?: number, now?: () => number,
 *   runtime?: Partial<import('@jarenjs/core/runtime').Runtime> }} [options]
 * @returns {Ledger & { sweep(now?: number): number, size: number }}
 */
export function createMemoryLedger(options = {}) {
  const ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('createMemoryLedger: ttlMs must be a positive number');
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
        createdAt: at, updatedAt: at, expiresAt: at + ttlMs,
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
    },
    fail(ref, retryable, response, now = undefined) {
      const at = instant(now);
      const record = settling(ref, at);
      record.status = 'failed';
      record.retryable = retryable === true;
      record.response = response === undefined ? null : response;
      record.updatedAt = at;
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
                  headers: { type: 'object', additionalProperties: { type: 'string' } },
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
