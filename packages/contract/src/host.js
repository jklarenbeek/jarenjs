//@ts-check
/**
 * @file The host lifecycle (docs/CONTRACT-FORMAT.md §7.7): one
 * carrier-neutral coordinator every server binding runs a request
 * through. A host names two hooks at construction — `identify(meta)`,
 * before anything of the request is parsed, and `acquire(input,
 * identity, enter)`, after the input validated and (on HTTP) the
 * idempotency claim answered `new` — each answering a LEASE `{ host,
 * release? }` the handler sees as `ctx.host`, or a declared failure the
 * binding renders like the handler's own. `acquire` hands its lease to
 * `enter`, the binding's continuation that runs the handler, validates
 * the output, serializes the response and — when the lease carries
 * `settlement: { ledger, required: true }` — settles the idempotency
 * claim through that ledger BEFORE `enter` resolves, so a host that
 * opened a transaction around `enter` commits the domain write and the
 * receipt together or not at all. Releases run once each, acquired
 * before identity, at the boundary the binding declares (the response
 * exposed, the opaque body settled, the stream done).
 *
 * The defaults are exactly `identify → { host: null }` and `acquire →
 * enter({ host: identity.host })`: a host that names only `identify`
 * sees its host in `scope(ctx)` and in the handler; one that names
 * `acquire` owns the handler's host. Every returned lease is validated
 * by shape (an object with an own `host`); a hook that throws, answers
 * a malformed lease, never calls `enter` or calls it twice is the host's
 * fault — observed through the binding's observer and rendered as the
 * binding's host-fault code (`JC2008` on HTTP, `JC2070` on port and
 * local); a declared failure is recognized by the `ContractFailure`
 * brand, never by shape, and validated against the operation like a
 * handler's. No policy data of the hooks reaches a wire.
 */

import { isThenable, toPromise } from '@jarenjs/core/function';

import { ContractFailure, isContractFailure } from './errors.js';

/**
 * What `identify` sees: the matched operation, the trace, the request
 * signal, the carrier, and the transport facts the carrier has — never
 * a parsed input, never an auth vocabulary of the binding's own.
 * @typedef {Object} IdentifyMeta
 * @property {import('./compile.js').CompiledOperation} op
 * @property {string} trace
 * @property {AbortSignal | null} signal
 * @property {'http' | 'port' | 'local'} carrier
 * @property {string | null} method - the request line on HTTP; `null` elsewhere
 * @property {string | null} path
 * @property {Readonly<Record<string, string | readonly string[]>> | null} headers - the raw request headers on HTTP; `null` elsewhere
 * @property {typeof ContractFailure} fail - the declared-failure factory
 */

/**
 * A lease: the host value the handler sees as `ctx.host`, an optional
 * release, and — from `acquire` only — an optional required settlement.
 * @typedef {Object} Lease
 * @property {unknown} host
 * @property {(() => unknown) | undefined} release
 * @property {{ ledger: import('./ledger.js').Ledger, required: true } | null} settlement
 */

/**
 * The hooks as a binding validated them at construction.
 * @typedef {Object} Lifecycle
 * @property {(meta: IdentifyMeta) => unknown} identify
 * @property {(input: unknown, identity: { host: unknown }, enter: (lease: unknown) => unknown) => unknown} acquire
 */

/** The default identity: no host. */
const DEFAULT_IDENTIFY = () => ({ host: null });

/**
 * The default acquisition: the identity's host, as is.
 * @param {unknown} input
 * @param {{ host: unknown }} identity
 * @param {(lease: unknown) => unknown} enter
 */
const DEFAULT_ACQUIRE = (input, identity, enter) => enter({ host: identity.host });

/**
 * A host fault of the lifecycle: what the binding observes and renders
 * as its host-fault code.
 */
export class HostLifecycleError extends Error {
  /**
   * @param {string} message
   * @param {unknown} [cause]
   */
  constructor(message, cause = undefined) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HostLifecycleError';
  }
}

/**
 * Validate the hooks a binding was given; each defaults. Rejections are
 * the binding's `JC1001` through `host`.
 * @param {{ identify?: unknown, acquire?: unknown }} options
 * @param {(reason: string) => Error} host - the binding's construction refusal
 * @returns {Lifecycle}
 */
export function resolveLifecycle(options, host) {
  for (const name of /** @type {const} */ (['identify', 'acquire'])) {
    const value = options[name];
    if (value !== undefined && typeof value !== 'function') throw host(`options.${name} must be a function`);
  }
  const identify = options.identify === undefined ? DEFAULT_IDENTIFY : /** @type {Lifecycle['identify']} */ (options.identify);
  const acquire = options.acquire === undefined ? DEFAULT_ACQUIRE : /** @type {Lifecycle['acquire']} */ (options.acquire);
  return Object.freeze({ identify, acquire });
}

/**
 * Read a hook's answer as a lease: an object with an own `host`, an
 * optional function `release`, and (when `acquired`) an optional
 * `settlement` whose `ledger` has `commit`/`fail` and whose `required`
 * is `true`. Anything else is the host's fault.
 * @param {unknown} value
 * @param {'identify' | 'acquire'} hook
 * @returns {Lease}
 * @throws {HostLifecycleError}
 */
export function leaseOf(value, hook) {
  const v = /** @type {any} */ (value);
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, 'host')) {
    throw new HostLifecycleError(`${hook} must answer a lease { host, release? } — an object with an own host member`);
  }
  const release = v.release;
  if (release !== undefined && typeof release !== 'function') {
    throw new HostLifecycleError(`${hook}: a lease's release must be a function`);
  }
  let settlement = null;
  if (hook === 'acquire' && v.settlement !== undefined && v.settlement !== null) {
    const s = v.settlement;
    if (typeof s !== 'object' || s.required !== true || s.ledger === null || typeof s.ledger !== 'object'
      || typeof s.ledger.commit !== 'function' || typeof s.ledger.fail !== 'function') {
      throw new HostLifecycleError('acquire: a lease\'s settlement must be { ledger, required: true } with a ledger that commits and fails');
    }
    settlement = { ledger: s.ledger, required: true };
  }
  else if (hook === 'identify' && v.settlement !== undefined) {
    throw new HostLifecycleError('identify: a settlement belongs to the acquired lease, not the identity');
  }
  return { host: v.host, release, settlement };
}

/**
 * A release that runs at most once, whatever the number of exits that
 * reach it; its own failure is handed to `observed` and swallowed, and
 * the answer says whether the release was clean (`true`) — a later
 * call answers `true` without running anything again.
 * @param {(() => unknown) | undefined} release
 * @param {(error: unknown) => void} observed
 * @returns {() => Promise<boolean>}
 */
export function once(release, observed) {
  let done = false;
  return () => {
    if (done || release === undefined) return Promise.resolve(true);
    done = true;
    let out;
    try {
      out = release();
    }
    catch (err) {
      observed(err);
      return Promise.resolve(false);
    }
    return isThenable(out) ? toPromise(out).then(() => true, (err) => { observed(err); return false; }) : Promise.resolve(true);
  };
}

/**
 * Classify a hook's settled answer: a lease, a declared failure, or a
 * host fault. Total for hostile values.
 * @param {unknown} value
 * @param {'identify' | 'acquire'} hook
 * @returns {{ kind: 'lease', lease: Lease } | { kind: 'failure', failure: import('./errors.js').ContractFailureValue } | { kind: 'fault', cause: unknown }}
 */
export function classifyAnswer(value, hook) {
  if (isContractFailure(value)) return { kind: 'failure', failure: value };
  try {
    return { kind: 'lease', lease: leaseOf(value, hook) };
  }
  catch (err) {
    return { kind: 'fault', cause: err };
  }
}

/**
 * Run `identify`: the hook's answer (sync or async) classified.
 * @param {Lifecycle} lifecycle
 * @param {IdentifyMeta} meta
 * @returns {Promise<ReturnType<typeof classifyAnswer>> | ReturnType<typeof classifyAnswer>}
 */
export function identify(lifecycle, meta) {
  let answer;
  try {
    answer = lifecycle.identify(meta);
  }
  catch (err) {
    return { kind: 'fault', cause: err };
  }
  return isThenable(answer)
    ? toPromise(answer).then((value) => classifyAnswer(value, 'identify'), (err) => ({ kind: 'fault', cause: err }))
    : classifyAnswer(answer, 'identify');
}

/**
 * The private carrier a required settlement's failure travels in: the
 * wire fault the dispatcher intends is preserved while the host's
 * transaction around `enter` rolls back on the rejection.
 */
export class RollbackCarrier extends Error {
  /**
   * @param {unknown} response - the response the binding will answer
   * @param {unknown} cause - what failed inside `enter`
   */
  constructor(response, cause) {
    super('the required settlement did not commit; the host transaction rolls back', { cause });
    this.name = 'RollbackCarrier';
    this.response = response;
  }
}

/**
 * Run `acquire` around `enter`. `enter` receives the validated lease and
 * answers the binding's result (a response, an outcome) or a promise of
 * it; what the hook itself answers is the value of `enter` — a hook
 * that resolves before `enter` settled, or to something else, is a
 * fault. The result: `{ kind: 'entered', lease, result }` when `enter`
 * ran and settled (its rejection, when it is not a RollbackCarrier of
 * ours, is a fault of the binding's continuation); `{ kind: 'failure' }`
 * for a declared failure answered instead of entering; `{ kind:
 * 'fault' }` for everything else — `enter` never called, called twice,
 * a malformed lease, a throw.
 * @param {Lifecycle} lifecycle
 * @param {unknown} input
 * @param {{ host: unknown }} identity
 * @param {(lease: Lease) => unknown} enter
 * @returns {Promise<{ kind: 'entered', lease: Lease, result: unknown, rolledBack: RollbackCarrier | null, afterFault?: unknown }
 *   | { kind: 'failure', failure: import('./errors.js').ContractFailureValue }
 *   | { kind: 'fault', cause: unknown }>}
 */
export function acquire(lifecycle, input, identity, enter) {
  /** @type {Lease | null} */
  let lease = null;
  /** @type {{ settled: boolean, value: unknown } | null} */
  let entered = null;
  let calls = 0;
  /** @type {RollbackCarrier | null} */
  let rolledBack = null;
  const gate = (/** @type {unknown} */ candidate) => {
    calls += 1;
    if (calls > 1) throw new HostLifecycleError('acquire called enter more than once');
    lease = leaseOf(candidate, 'acquire');
    let out;
    try {
      out = enter(lease);
    }
    catch (err) {
      out = Promise.reject(err);
    }
    const settled = toPromise(out).then(
      (value) => {
        entered = { settled: true, value };
        return value;
      },
      (err) => {
        if (err instanceof RollbackCarrier) {
          rolledBack = err;
          entered = { settled: true, value: err.response };
        }
        throw err;
      });
    return settled;
  };
  let answer;
  try {
    answer = lifecycle.acquire(input, identity, gate);
  }
  catch (err) {
    return Promise.resolve(finish(err, true));
  }
  return toPromise(answer).then((value) => finish(value, false), (err) => finish(err, true));

  /**
   * @param {unknown} value - the hook's settled value or rejection
   * @param {boolean} rejected
   */
  function finish(value, rejected) {
    if (rejected) {
      // our own refusal — enter called twice, a malformed lease — is the
      // host's fault whatever else settled
      if (value instanceof HostLifecycleError) return { kind: 'fault', cause: value };
      if (value instanceof RollbackCarrier && entered !== null && lease !== null) {
        // the host transaction rolled back on our carrier: the intended fault is the answer
        return { kind: 'entered', lease, result: value.response, rolledBack: value };
      }
      if (rolledBack !== null && lease !== null) {
        // the host wrapped our carrier in a rejection of its own (a transaction that rethrows): the intent stands
        return { kind: 'entered', lease, result: rolledBack.response, rolledBack };
      }
      if (entered !== null && lease !== null) {
        // the hook rejected after enter settled: the settled result stands, the rejection is the host's fault to observe
        return { kind: 'entered', lease, result: entered.value, rolledBack: null, afterFault: value };
      }
      return { kind: 'fault', cause: value };
    }
    if (calls === 0) {
      if (isContractFailure(value)) return { kind: 'failure', failure: value };
      return { kind: 'fault', cause: new HostLifecycleError('acquire answered without calling enter and without a declared failure') };
    }
    if (entered === null || lease === null) {
      return { kind: 'fault', cause: new HostLifecycleError('acquire resolved before enter settled') };
    }
    return { kind: 'entered', lease, result: entered.value, rolledBack };
  }
}

export { ContractFailure };
