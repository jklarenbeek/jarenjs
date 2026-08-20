//@ts-check
/**
 * @file The server half of the stream binding, carrier-neutral
 * (docs/CONTRACT-FORMAT.md §17–§18): take the subscription a handler
 * settled (the duck-typed LIVE shape — `result`/`snapshot()`,
 * `subscribe(cb) → stop`, `close()`, optional `replay(seq)`), decide
 * resumption, read and validate the snapshot, forward each emission,
 * and guarantee `stop()` then `close()` run **exactly once** however
 * the stream ends — peer disconnect, unsubscribe, server shutdown, an
 * error emission, an invalid snapshot. The HTTP dispatcher renders the
 * intents this module raises as SSE events; the port server renders
 * them as push frames — the sequencing is decided here once so the two
 * carriers can never disagree.
 *
 * Total for everything a handler's subscription can do: a throwing
 * `snapshot()`/`result` accessor, a `subscribe` that throws, a hostile
 * emission, a throwing `stop`/`close` — every one settles into the
 * `fault` intent (the cause for the binding's `onError`, never the
 * wire) or is swallowed at close, and the stream still terminates.
 */

import { toPromise, isThenable } from '@jarenjs/core/function';

import { verdict } from '../http/wire.js';

/**
 * @typedef {import('../pipeline.js').PipelineRoute} PipelineRoute
 */

/**
 * The duck-typed subscription of docs/CONTRACT-FORMAT.md §17.1.
 * @typedef {{ result?: unknown, snapshot?: () => unknown,
 *   subscribe: (cb: (emission: any) => void) => (() => void),
 *   close: () => void, replay?: (seq: number) => unknown, mode?: unknown }} SubscriptionLike
 */

/**
 * What the carrier renders. Every hook is called at most once per
 * event, in wire order; after `error` or `end` no further hook fires.
 * `error` carries the intent (`'invalid-snapshot'` — send `JC2091`;
 * `'source'` — the subscription emitted `{ error }`, send the host
 * fault code) and the cause for the observer. `done` fires exactly once
 * after the stream terminated for any reason — the carrier releases
 * its resources (timers, registries) there.
 * @typedef {Object} StreamHooks
 * @property {(seq: number, value: unknown, resumed: boolean) => void} snapshot
 * @property {(seq: number, emission: { patch: unknown[], seq: number }) => void} patch
 * @property {(intent: 'invalid-snapshot' | 'source', cause: unknown, lastSeq: number) => void} error
 * @property {(reason: string, lastSeq: number) => void} end
 * @property {() => void} done
 */

/**
 * @typedef {Object} StreamOptions
 * @property {number | null} lastSeq - the peer's `Last-Event-ID` / `lastSeq`, or `null`
 * @property {boolean} validate - whether snapshots run the output validator
 */

/**
 * Whether a settled handler value is a usable subscription.
 * Reads guardedly; a hostile value classifies as "not a subscription".
 * @param {unknown} value
 * @returns {value is SubscriptionLike}
 */
export function isSubscriptionLike(value) {
  try {
    if (value === null || typeof value !== 'object') return false;
    const s = /** @type {any} */ (value);
    return typeof s.subscribe === 'function' && typeof s.close === 'function'
      && (typeof s.snapshot === 'function' || s.result !== undefined);
  }
  catch {
    return false;
  }
}

/**
 * A guarded read of the current snapshot document.
 * @param {SubscriptionLike} sub
 * @returns {{ ok: true, value: unknown } | { ok: false, cause: unknown }}
 */
function readSnapshot(sub) {
  try {
    return { ok: true, value: typeof sub.snapshot === 'function' ? sub.snapshot() : sub.result };
  }
  catch (err) {
    return { ok: false, cause: err };
  }
}

/**
 * Run one subscription over a carrier. Emissions are forwarded
 * verbatim (a patch is never mutated); an emission whose serialized
 * patch exceeds `policy.stream.maxPatchBytes` is replaced by a fresh
 * snapshot at that emission's seq (§18.1); an `{ error }` emission —
 * and a hostile one — raises the `error` intent and ends the stream.
 *
 * Returns the stopper: `stop(reason)` with a string emits the `end`
 * event with that reason first (a server shutdown); `stop(null)` is
 * silent (the peer is gone, or asked). Idempotent; the subscription's
 * own `stop()` and `close()` run exactly once either way.
 *
 * @param {PipelineRoute} route
 * @param {SubscriptionLike} sub
 * @param {StreamHooks} hooks
 * @param {StreamOptions} options
 * @returns {{ stop: (reason: string | null) => void }}
 */
export function runSubscription(route, sub, hooks, options) {
  const policy = /** @type {NonNullable<import('../compile.js').CompiledPolicy['stream']>} */ (
    route.op.policy.stream ?? { resume: 'snapshot', heartbeatMs: 15000, maxPatchBytes: null });
  const maxPatchBytes = policy.maxPatchBytes;
  let finished = false;
  let ready = false;
  /** @type {any[]} */
  const buffered = [];
  /** @type {(() => void) | null} */
  let stopSub = null;
  let lastSeq = 0;

  /**
   * The one stopper every path returns: on a finished stream it is a
   * no-op, so an early-failed stream hands back the same shape.
   * @type {{ stop: (reason: string | null) => void }}
   */
  const stopper = {
    stop: (reason) => {
      if (finished) return;
      if (reason !== null) {
        try {
          hooks.end(reason, lastSeq);
        }
        catch {
          // the end event is best-effort on a dying carrier
        }
      }
      release();
    },
  };

  /** Release the subscription exactly once; a throwing stop/close is swallowed. */
  function release() {
    if (finished) return;
    finished = true;
    if (stopSub !== null) {
      try {
        stopSub();
      }
      catch {
        // a throwing stop never blocks the close
      }
      stopSub = null;
    }
    try {
      sub.close();
    }
    catch {
      // a throwing close never blocks termination
    }
    try {
      hooks.done();
    }
    catch {
      // the carrier's cleanup must not break termination
    }
  }

  /**
   * End with an error intent: the carrier renders the event, then the
   * subscription is released.
   * @param {'invalid-snapshot' | 'source'} intent
   * @param {unknown} cause
   */
  function fail(intent, cause) {
    if (finished) return;
    try {
      hooks.error(intent, cause, lastSeq);
    }
    catch {
      // a carrier that cannot render still releases
    }
    release();
  }

  /**
   * Read, validate and emit a fresh snapshot at `seq`.
   * @param {number} seq
   * @param {boolean} resumed
   * @returns {boolean} false when the stream ended instead
   */
  function emitSnapshot(seq, resumed) {
    const snap = readSnapshot(sub);
    if (!snap.ok) {
      fail('source', snap.cause);
      return false;
    }
    if (options.validate) {
      const v = verdict(route.validateOutput, snap.value);
      if (!v.valid) {
        fail('invalid-snapshot', v.thrown !== undefined ? v.thrown : v.errors);
        return false;
      }
    }
    lastSeq = seq;
    hooks.snapshot(seq, snap.value, resumed);
    return true;
  }

  /**
   * One emission from the subscription, delivered or buffered.
   * @param {any} emission
   */
  function deliver(emission) {
    if (finished) return;
    if (!ready) {
      buffered.push(emission);
      return;
    }
    let patch;
    let seq;
    let sourceError;
    try {
      sourceError = emission === null || typeof emission !== 'object' ? new TypeError('the subscription emitted a non-object') : undefined;
      if (sourceError === undefined && emission.error !== undefined) sourceError = emission.error;
      if (sourceError === undefined) {
        patch = emission.patch;
        seq = emission.seq;
      }
    }
    catch (err) {
      sourceError = err;
    }
    if (sourceError !== undefined) {
      fail('source', sourceError);
      return;
    }
    if (!Array.isArray(patch) || !Number.isFinite(seq)) {
      fail('source', new TypeError('the subscription emitted a value that is not { patch, seq }'));
      return;
    }
    if (seq <= lastSeq && lastSeq !== 0) return; // an already-delivered record (a replay overlap)
    if (maxPatchBytes !== null && JSON.stringify(patch).length > maxPatchBytes) {
      // the consumer swaps its document instead of patching it (§18.1)
      emitSnapshot(seq, false);
      return;
    }
    lastSeq = seq;
    hooks.patch(seq, { patch, seq });
  }

  // subscribe FIRST so nothing between the subscription and the initial
  // events is lost; emissions buffer until the initial events are out.
  // In the synchronous snapshot path nothing can land in between — the
  // buffer exists for the (possibly asynchronous) replay path.
  try {
    stopSub = sub.subscribe(deliver);
  }
  catch (err) {
    fail('source', err);
    return stopper;
  }
  if (typeof stopSub !== 'function') stopSub = null;

  /** Flush what buffered while the initial events were decided. */
  function flush() {
    ready = true;
    while (buffered.length > 0 && !finished) deliver(buffered.shift());
  }

  const wantsReplay = options.lastSeq !== null && policy.resume === 'replay' && typeof sub.replay === 'function';
  if (wantsReplay) {
    let replayed;
    try {
      replayed = /** @type {NonNullable<SubscriptionLike['replay']>} */ (sub.replay)(/** @type {number} */ (options.lastSeq));
    }
    catch (err) {
      fail('source', err);
      return stopper;
    }
    const settle = (/** @type {unknown} */ entries) => {
      if (finished) return;
      if (Array.isArray(entries)) {
        lastSeq = /** @type {number} */ (options.lastSeq);
        ready = true;
        for (let i = 0; i < entries.length && !finished; i++) deliver(entries[i]);
        flush();
      }
      else {
        // the handler cannot replay: a fresh snapshot, resume refused (JC2095)
        if (emitSnapshot(0, false)) flush();
      }
    };
    if (isThenable(replayed)) {
      toPromise(replayed).then(settle, (/** @type {unknown} */ err) => fail('source', err));
    }
    else settle(replayed);
  }
  else {
    // a fresh stream, or a resume the policy answers with a snapshot
    if (emitSnapshot(0, false)) flush();
  }

  return stopper;
}

export { STREAM_ERRORS, STREAM_EVENTS, STREAM_MEDIA, HEARTBEAT_LINE, encodeStreamEvent } from './sse.js';
