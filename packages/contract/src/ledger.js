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

/**
 * The record a ledger keeps per `(op, scope, key)`; the schema of
 * `idempotencyLedgerModel`'s collection.
 * @typedef {Object} LedgerRecord
 * @property {string} id - `"<op>|<scope>|<key>"`
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
 * The claim result: `new` hands back a `ref` to commit or fail; `replay`
 * carries the stored response; `in-progress` and `mismatch` are the two
 * 409 answers.
 * @typedef {{ state: 'new', ref: unknown }
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
 * a claim is the binding's clock (epoch ms) a ledger may prefer to its
 * own.
 * @typedef {Object} Ledger
 * @property {(claim: { op: string, scope: string, key: string, hash: string, now?: number }) => ClaimResult | Promise<ClaimResult>} claim
 * @property {(ref: unknown, response: any) => void | Promise<void>} commit
 * @property {(ref: unknown, retryable: boolean, response?: any) => void | Promise<void>} fail
 * @property {(key: { op: string, scope: string, key: string }) => LedgerRecord | null | Promise<LedgerRecord | null>} lookup
 */

/** One day, the default retention of a key. */
const DEFAULT_TTL_MS = 86_400_000;

/**
 * @param {string} op
 * @param {string} scope
 * @param {string} key
 * @returns {string}
 */
function idOf(op, scope, key) {
  return `${op}|${scope}|${key}`;
}

/**
 * The reference ledger over a `Map`: synchronous, single-process,
 * expiring on `claim` (a record past `expiresAt` is dropped and the key
 * is `new` again). `sweep()` drops every expired record — a host may
 * call it on a timer.
 * @param {{ ttlMs?: number, now?: () => number }} [options]
 * @returns {Ledger & { sweep(): number, size: number }}
 */
export function createMemoryLedger(options = {}) {
  const ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('createMemoryLedger: ttlMs must be a positive number');
  const clock = options.now === undefined ? Date.now : options.now;
  if (typeof clock !== 'function') throw new TypeError('createMemoryLedger: now must be a function');
  /** @type {Map<string, LedgerRecord>} */
  const records = new Map();

  return {
    claim({ op, scope, key, hash, now }) {
      const at = typeof now === 'number' ? now : clock();
      const id = idOf(op, scope, key);
      const existing = records.get(id);
      if (existing !== undefined) {
        if (existing.expiresAt <= at) records.delete(id);
        else if (existing.hash !== hash) return { state: 'mismatch' };
        else if (existing.status === 'started') return { state: 'in-progress' };
        else if (existing.status === 'committed') return { state: 'replay', response: existing.response };
        else if (existing.retryable !== true && existing.response !== null) return { state: 'replay', response: existing.response };
        else records.delete(id);
      }
      /** @type {LedgerRecord} */
      const record = {
        id, op, scope, key, hash, status: 'started', response: null, retryable: null,
        createdAt: at, updatedAt: at, expiresAt: at + ttlMs,
      };
      records.set(id, record);
      return { state: 'new', ref: record };
    },
    commit(ref, response) {
      const record = /** @type {LedgerRecord} */ (ref);
      if (records.get(record.id) !== record) return;
      record.status = 'committed';
      record.response = response;
      record.retryable = null;
      record.updatedAt = clock();
    },
    fail(ref, retryable, response) {
      const record = /** @type {LedgerRecord} */ (ref);
      if (records.get(record.id) !== record) return;
      record.status = 'failed';
      record.retryable = retryable === true;
      record.response = response === undefined ? null : response;
      record.updatedAt = clock();
    },
    lookup({ op, scope, key }) {
      const record = records.get(idOf(op, scope, key));
      if (record === undefined) return null;
      if (record.expiresAt <= clock()) {
        records.delete(record.id);
        return null;
      }
      return record;
    },
    sweep() {
      const at = clock();
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
 * `ledger`, keyed by `/id` (`"<op>|<scope>|<key>"`), indexed on
 * `expiresAt` (the sweep) and `status` (the in-flight scan). A host
 * opens it with `@jarenjs/db`'s `openStore` and implements the `Ledger`
 * interface over the collection; the record shape is exactly what
 * `createMemoryLedger` keeps.
 */
export const idempotencyLedgerModel = Object.freeze({
  $model: '0.1',
  collections: {
    ledger: {
      schema: {
        type: 'object',
        required: ['id', 'op', 'scope', 'key', 'hash', 'status', 'response', 'retryable', 'createdAt', 'updatedAt', 'expiresAt'],
        properties: {
          id: { type: 'string', minLength: 1 },
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
