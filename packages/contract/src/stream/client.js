//@ts-check
/**
 * @file The client half of the stream binding, carrier-neutral
 * (docs/CONTRACT-FORMAT.md §19): one consumer state machine that both
 * `client.subscribe` implementations feed — the HTTP client with
 * decoded SSE events, the port client with push frames. It validates
 * every snapshot against the operation's output schema, enforces the
 * strictly-increasing seq (`JC2092`), classifies a server `error` event
 * (a declared code is a `failure` outcome under its own code; anything
 * else is `contract` `JC2093` with the server's record in `details`),
 * and delivers each `on*` callback totally — a callback that throws
 * never breaks the machine. After the first terminal event (`error`,
 * `end`, a local failure) the machine is finished: the carrier's
 * `finish` hook has run and every later event is dropped.
 */

import { renderMessage, verdict, projectValidationDetails } from '../http/wire.js';
import { failedOutcome, outcomeError, clientError } from '../client/outcome.js';
import { STREAM_ERRORS } from './sse.js';

/**
 * @typedef {import('../client/outcome.js').OutcomeRoute} OutcomeRoute
 * @typedef {import('../client/outcome.js').OutcomeMeta} OutcomeMeta
 * @typedef {import('../client/outcome.js').Outcome} Outcome
 * @typedef {import('../http/wire.js').Catalog} Catalog
 */

/**
 * The callbacks of one `client.subscribe` call; every one optional.
 * `onSnapshot`'s `info` is stable in shape: `reset` says the snapshot
 * re-seeds a consumer whose cursor fell behind the server's retention
 * (its `seq` is then the cursor to resume from), and the two watermarks
 * are the server log's when it reported them (`null` on a fresh stream).
 * @typedef {Object} StreamCallbacks
 * @property {(value: unknown, info: { seq: number, resumed: boolean, reset: boolean, earliestAvailable: number | null, highWatermark: number | null }) => void} [onSnapshot]
 * @property {(emission: { patch: unknown[], seq: number }) => void} [onPatch]
 * @property {(outcome: Outcome) => void} [onError]
 * @property {(info: { reason: string }) => void} [onEnd]
 */

/**
 * @typedef {Object} StreamConsumerOptions
 * @property {OutcomeRoute & { details: 'none' | 'paths' | 'full' }} route
 * @property {Catalog | null} catalog
 * @property {OutcomeMeta} meta - mutated: `trace` is refreshed from error records
 * @property {StreamCallbacks} callbacks
 * @property {() => void} finish - the carrier's cleanup (remove the entry,
 *   cancel readers and timers); called exactly once, before the terminal callback
 * @property {number | null} lastSeq - the resume seq the caller passed (the
 *   regression baseline until a snapshot or patch moves it)
 */

/**
 * The consumer the carriers feed. `snapshot`/`patch` take the seq the
 * wire carried (the SSE id, the frame's `seq`) — `null` falls back to
 * the data's own `seq`; `error`/`end` take the event data; `fail` takes
 * a ready outcome (a transport failure the carrier classified). All are
 * no-ops once finished. `lastSeq` reads the cursor: the resume seq the
 * caller passed until a snapshot or patch moves it — what a further
 * attempt resumes from.
 * @param {StreamConsumerOptions} options
 * @returns {{ snapshot: (seq: number | null, data: unknown) => void,
 *   patch: (seq: number | null, data: unknown) => void,
 *   error: (data: unknown) => void,
 *   end: (data: unknown) => void,
 *   fail: (outcome: Outcome) => void,
 *   cancel: () => void,
 *   finished: () => boolean,
 *   lastSeq: () => number | null }}
 */
export function createStreamConsumer(options) {
  const { route, catalog, meta, callbacks, finish } = options;
  let lastSeq = options.lastSeq;
  let delivered = false;
  let done = false;

  /**
   * Run one callback totally.
   * @param {((arg: any, extra?: any) => void) | undefined} cb
   * @param {any} arg
   * @param {any} [extra]
   */
  function call(cb, arg, extra) {
    if (cb === undefined) return;
    try {
      cb(arg, extra);
    }
    catch {
      // a consumer callback that throws never breaks the stream machine
    }
  }

  /** Terminate: cleanup first, then the terminal callback. */
  function terminate() {
    if (done) return false;
    done = true;
    try {
      finish();
    }
    catch {
      // the carrier's cleanup must not eat the terminal callback
    }
    return true;
  }

  /**
   * A stream-code outcome (`JC2090`/`JC2092`/`JC2094`), rendered here.
   * @param {'JC2090' | 'JC2092' | 'JC2094'} code
   * @param {Record<string, unknown>} params
   * @returns {Outcome}
   */
  function streamOutcome(code, params) {
    const row = STREAM_ERRORS[code];
    return failedOutcome(row.kind === 'network' ? 'network' : 'contract',
      outcomeError(code, renderMessage(catalog, row.msgid, { op: route.id, ...params }), null, null, row.retryable), meta);
  }

  /**
   * The seq of one event: the wire's, or the data's own.
   * @param {number | null} seq
   * @param {any} data
   * @returns {number | null}
   */
  function seqOf(seq, data) {
    if (typeof seq === 'number' && Number.isFinite(seq)) return seq;
    const own = data !== null && typeof data === 'object' ? data.seq : undefined;
    return typeof own === 'number' && Number.isFinite(own) ? own : null;
  }

  return {
    snapshot(seq, data) {
      if (done) return;
      const envelope = /** @type {any} */ (data);
      if (envelope === null || typeof envelope !== 'object' || !Object.hasOwn(envelope, 'value')) {
        if (terminate()) call(callbacks.onError, failedOutcome('contract',
          clientError(catalog, 'JC2053', { op: route.id }, null, [{ path: '', keyword: 'snapshot' }]), meta));
        return;
      }
      const at = seqOf(seq, envelope);
      const v = verdict(route.validateOutput, envelope.value);
      if (!v.valid) {
        if (terminate()) call(callbacks.onError, failedOutcome('contract',
          clientError(catalog, 'JC2053', { op: route.id }, null, projectValidationDetails(route.details, v.errors)), meta));
        return;
      }
      const reset = envelope.reset === true;
      // a mid-stream snapshot (a maxPatchBytes replacement) must still
      // advance; a reset snapshot may land AT the resume cursor — the
      // server's watermark had not moved past what the consumer held.
      // A zero seed may replace the resume cursor only before this
      // attempt delivers anything, when replay falls back to a fresh source.
      const initialSeed = !delivered && at === 0;
      if (at !== null && lastSeq !== null && !initialSeed && (reset ? at < lastSeq : at <= lastSeq)) {
        if (terminate()) call(callbacks.onError, streamOutcome('JC2092', {}));
        return;
      }
      if (at !== null) lastSeq = at;
      delivered = true;
      const watermark = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      call(callbacks.onSnapshot, envelope.value, {
        seq: at === null ? 0 : at,
        resumed: envelope.resumed === true,
        reset,
        earliestAvailable: watermark(envelope.earliestAvailable),
        highWatermark: watermark(envelope.highWatermark),
      });
    },
    patch(seq, data) {
      if (done) return;
      const emission = /** @type {any} */ (data);
      const patch = emission !== null && typeof emission === 'object' ? emission.patch : undefined;
      const at = seqOf(seq, emission);
      if (!Array.isArray(patch) || at === null) {
        if (terminate()) call(callbacks.onError, failedOutcome('contract',
          clientError(catalog, 'JC2053', { op: route.id }, null, [{ path: '', keyword: 'patch' }]), meta));
        return;
      }
      if (lastSeq !== null && at <= lastSeq) {
        if (terminate()) call(callbacks.onError, streamOutcome('JC2092', {}));
        return;
      }
      lastSeq = at;
      delivered = true;
      call(callbacks.onPatch, { patch, seq: at });
    },
    error(data) {
      if (!terminate()) return;
      const record = /** @type {any} */ (data);
      const code = record !== null && typeof record === 'object' && typeof record.code === 'string' ? record.code : null;
      if (record !== null && typeof record === 'object' && typeof record.requestId === 'string' && record.requestId.length > 0) {
        meta.trace = record.requestId;
      }
      if (code !== null && Object.hasOwn(route.errors, code)) {
        const message = typeof record.message === 'string'
          ? record.message
          : renderMessage(catalog, 'contract/handler-error', { op: route.id, code });
        const retryable = typeof record.retryable === 'boolean' ? record.retryable : route.retryOn.has(code);
        call(callbacks.onError, failedOutcome('failure', outcomeError(code, message, null, record.details, retryable), meta));
        return;
      }
      // a stream code the server ends with that is a NETWORK verdict (the
      // consumer fell behind, JC2096) is a network outcome under its own
      // code — retryable, and what a reconnect policy keys on
      if (code !== null && Object.hasOwn(STREAM_ERRORS, code)
        && STREAM_ERRORS[/** @type {keyof typeof STREAM_ERRORS} */ (code)].kind === 'network') {
        const row = STREAM_ERRORS[/** @type {keyof typeof STREAM_ERRORS} */ (code)];
        const message = typeof record.message === 'string' ? record.message : renderMessage(catalog, row.msgid, { op: route.id });
        call(callbacks.onError, failedOutcome('network', outcomeError(code, message, null, record.details, row.retryable), meta));
        return;
      }
      // an undeclared server error ends the stream as a contract violation;
      // the server's record rides in details so a JC2091 stays visible
      const details = code === null ? null : {
        code,
        message: record !== null && typeof record === 'object' && typeof record.message === 'string' ? record.message : null,
      };
      call(callbacks.onError, failedOutcome('contract',
        outcomeError('JC2093', renderMessage(catalog, STREAM_ERRORS.JC2093.msgid, { op: route.id, code: code === null ? 'none' : code }),
          null, details, false), meta));
    },
    end(data) {
      if (!terminate()) return;
      const record = /** @type {any} */ (data);
      const reason = record !== null && typeof record === 'object' && typeof record.reason === 'string' ? record.reason : 'closed';
      call(callbacks.onEnd, { reason });
    },
    fail(outcome) {
      if (!terminate()) return;
      call(callbacks.onError, outcome);
    },
    cancel() {
      if (done) return;
      done = true;
      try {
        finish();
      }
      catch {
        // a cancel is silent either way
      }
    },
    finished: () => done,
    lastSeq: () => lastSeq,
  };
}

export { STREAM_ERRORS };
