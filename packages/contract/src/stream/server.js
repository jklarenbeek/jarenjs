//@ts-check
/**
 * @file The server half of the stream binding, carrier-neutral
 * (docs/CONTRACT-FORMAT.md §17–§18): take the subscription a handler
 * settled (the duck-typed LIVE shape — `result`/`snapshot()`,
 * `subscribe(cb) → stop`, `close()`, optional `replay(after, options)`),
 * decide resumption, read and validate the snapshot, forward each
 * emission, and guarantee `stop()` then `close()` run **exactly once**
 * however the stream ends — peer disconnect, unsubscribe, server
 * shutdown, an error emission, an invalid snapshot, a slow consumer.
 * The HTTP dispatcher renders the intents this module raises as SSE
 * events; the port server renders them as push frames — the sequencing
 * is decided here once so the two carriers can never disagree.
 *
 * The carrier encodes, the runner decides. A hook answers the WIRE
 * FRAME of one event (an SSE text, a port frame object) or `null` to
 * skip it; the runner measures it through the carrier's `size`, charges
 * it to ONE bounded queue, and writes it through the carrier's `write`
 * one frame at a time, each behind the previous one's settlement (the
 * suite's awaited-sink primitive): an emission that arrives while a
 * write is pending — or while a replay page is loading — waits its turn
 * in order, never overlapped, never dropped. A frame's count and bytes
 * stay charged until its write settled, so a blocked write cannot hide
 * memory outside the bound; when the next frame would cross either
 * bound the stream ends with `JC2096` and the carrier is told to tear
 * its sink down. A write that rejects means the carrier is gone (the
 * peer dropped the socket, the consumer cancelled the stream): the
 * runner releases silently.
 *
 * Replay is paged, never an array (§18.1): `replay(after, { limit,
 * maxBytes, signal })` answers one `changes.page()`-shaped page —
 * `{ items, next?, earliestAvailable, highWatermark, hasMore,
 * resetRequired }` — validated defensively; the first page's
 * `highWatermark` is the target, and paging stops there however busy
 * the writer is. A page with `resetRequired` delivers no suffix: the
 * runner reads a fresh snapshot and emits it with `reset: true`, both
 * watermarks, and an event id no lower than any live emission already
 * buffered, so a patch the snapshot already reflects is never replayed.
 *
 * A source's `stop()` and `close()` may answer promises; the runner's
 * `done` settles only after stop, then close, then the carrier's `done`
 * hook have all settled, once — the completion signal a host's
 * finalizers wait on.
 *
 * Total for everything a handler's subscription can do: a throwing
 * `snapshot()`/`result` accessor, a `subscribe` that throws, a hostile
 * emission, a malformed or rejecting page, a throwing `stop`/`close` —
 * every one settles into the `error` intent (the cause for the
 * binding's `onError`, never the wire) or is swallowed at close, and
 * the stream still terminates.
 */

import { toPromise, isThenable } from '@jarenjs/core/function';
import { createAwaitedSink } from '@jarenjs/core/async';
import { isJsonValue } from '@jarenjs/core/object';
import { utf8ByteLength } from '@jarenjs/core/string';

import { verdict } from '../http/wire.js';

/**
 * @typedef {import('../pipeline.js').PipelineRoute} PipelineRoute
 */

/**
 * The options of one replay page call (§18.1): at most `limit`
 * emissions and `maxBytes` serialized patch bytes, and the runner's
 * signal, aborted when the stream stops while the page is loading.
 * @typedef {{ limit: number, maxBytes: number, signal: AbortSignal }} ReplayOptions
 */

/**
 * One replay page, in the shape `@jarenjs/db`'s `changes.page()`
 * answers: the emissions after `after` in seq order, `next` the seq to
 * continue from, the log's two watermarks, whether more remain, and
 * the total refusal `resetRequired` — under which `items` is empty and
 * `next` absent.
 * @typedef {{ items: { patch: unknown[], seq: number }[], next?: number,
 *   earliestAvailable: number | null, highWatermark: number, hasMore: boolean,
 *   resetRequired: boolean }} ReplayPage
 */

/**
 * The duck-typed subscription of docs/CONTRACT-FORMAT.md §17.1. `stop`
 * (what `subscribe` answers) and `close` may answer a promise; the
 * runner awaits each before it reports completion. `replay` answers one
 * page per call, value or promise.
 * @typedef {{ result?: unknown, snapshot?: () => unknown,
 *   subscribe: (cb: (emission: any) => void) => (() => unknown),
 *   close: () => unknown,
 *   replay?: (after: number, options: ReplayOptions) => ReplayPage | null | undefined | Promise<ReplayPage | null | undefined>,
 *   mode?: unknown }} SubscriptionLike
 */

/**
 * The data of a snapshot event (§18.1): the validated document, whether
 * the stream resumed (never, today: a resumed stream starts with
 * patches), whether this snapshot re-seeds a consumer whose cursor fell
 * behind the log's retention (`reset`), and the log's watermarks as the
 * replay source reported them (`null` on a fresh stream).
 * @typedef {{ value: unknown, resumed: boolean, reset: boolean,
 *   earliestAvailable: number | null, highWatermark: number | null }} SnapshotData
 */

/**
 * The reasons a stream ends with an `error` event: `'invalid-snapshot'`
 * (send `JC2091`), `'source'` (the subscription emitted `{ error }`
 * with no declared code, or a page/subscribe/snapshot fault — send the
 * host fault code), `'slow-consumer'` (the bounded queue would overflow
 * — send `JC2096`), `'declared'` (the subscription emitted `{ error }`
 * whose `code` the operation declares — send that code as the declared
 * failure it is, with the {@link DeclaredStreamFailure} the runner
 * classified).
 * @typedef {'invalid-snapshot' | 'source' | 'slow-consumer' | 'declared'} ErrorIntent
 */

/**
 * A source error the operation declares (§17.1): the declared `code`,
 * JSON-safe `details` when the error carried some (`undefined`
 * otherwise), and `retryable` — the error's own boolean, else whether
 * `policy.retry.on` names the code. Nothing of the error's message or
 * stack is here: the carrier renders the operation's declared message.
 * @typedef {{ code: string, details: unknown, retryable: boolean }} DeclaredStreamFailure
 */

/**
 * What the carrier renders, as FRAMES. Each event hook answers the wire
 * frame of one event — the SSE text, the port frame — or `null` to skip
 * it (a frame the wire cannot carry, observed by the carrier). The
 * runner measures a frame with `size` (its bytes on the wire), charges
 * it to the bounded queue, and writes it with `write`, one at a time,
 * each behind the previous write's settlement; `write` may answer a
 * promise. After the `error` or `end` frame no further frame is
 * written. A `write` that throws or rejects is read as "the carrier can
 * no longer deliver": the subscription is released silently. `done`
 * fires exactly once after the stream terminated for any reason, with
 * `'slow-consumer'` when the queue overflowed — the carrier tears its
 * sink down instead of ending it — else `null`; the carrier releases
 * its resources (timers, registries, the sink) there.
 * @template [F=unknown]
 * @typedef {Object} StreamHooks
 * @property {(seq: number, data: SnapshotData) => F | null} snapshot
 * @property {(seq: number, emission: { patch: unknown[], seq: number }) => F | null} patch
 * @property {(intent: ErrorIntent, cause: unknown, lastSeq: number, declared: DeclaredStreamFailure | null) => F | null} error
 * @property {(reason: string, lastSeq: number) => F | null} end
 * @property {(frame: F) => number} size
 * @property {(frame: F) => unknown} write
 * @property {(reason: 'slow-consumer' | null) => unknown} done
 */

/**
 * The bounds of one stream (§18.1): a replay page asks for at most
 * `replay.limit` emissions and `replay.maxBytes` serialized patch
 * bytes; the queue holds at most `queue.events` undelivered frames and
 * `queue.bytes` of their wire bytes.
 * @typedef {{ replay: { limit: number, maxBytes: number }, queue: { events: number, bytes: number } }} StreamLimits
 */

/**
 * @typedef {Object} StreamOptions
 * @property {number | null} lastSeq - the peer's `Last-Event-ID` / `lastSeq`, or `null`
 * @property {boolean} validate - whether snapshots run the output validator
 * @property {StreamLimits} [limits] - the bounds; the defaults when absent
 */

/**
 * What `runSubscription` answers: the stopper, and the completion
 * signal. `stop(reason)` with a string renders the `end` event with
 * that reason first (a server shutdown) and then releases; `stop(null)`
 * is silent (the peer is gone, or asked) and does not wait for a
 * carrier write still pending — a late settlement is ignored. `done`
 * settles (it never rejects) once the source's `stop()` and `close()`
 * and the carrier's `done` hook have all run, in that order, once.
 * @typedef {{ stop: (reason: string | null) => void, done: Promise<void> }} StreamRunner
 */

/** The bounds every stream runs under unless the server says otherwise. */
export const STREAM_LIMITS_DEFAULT = Object.freeze({
  replay: Object.freeze({ limit: 256, maxBytes: 1024 * 1024 }),
  queue: Object.freeze({ events: 256, bytes: 1024 * 1024 }),
});

/**
 * Resolve and validate a server's `streamLimits` option against the
 * defaults: every member a positive integer (`Infinity` allowed), else
 * the binding's host error.
 * @param {unknown} option - the server's `streamLimits`, or `undefined`
 * @param {(reason: string) => Error} refuse - the binding's host-error factory
 * @returns {StreamLimits}
 */
export function resolveStreamLimits(option, refuse) {
  if (option === undefined) return STREAM_LIMITS_DEFAULT;
  if (option === null || typeof option !== 'object') {
    throw refuse('options.streamLimits must be an object { replay?: { limit?, maxBytes? }, queue?: { events?, bytes? } }');
  }
  const o = /** @type {any} */ (option);
  /**
   * @param {string} group @param {string} name @param {number} fallback
   * @returns {number}
   */
  const bound = (group, name, fallback) => {
    const g = o[group];
    if (g === undefined) return fallback;
    if (g === null || typeof g !== 'object') throw refuse(`options.streamLimits.${group} must be an object`);
    const v = g[name];
    if (v === undefined) return fallback;
    if (v === Infinity) return Infinity;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      throw refuse(`options.streamLimits.${group}.${name} must be a positive integer or Infinity`);
    }
    return v;
  };
  return Object.freeze({
    replay: Object.freeze({
      limit: bound('replay', 'limit', STREAM_LIMITS_DEFAULT.replay.limit),
      maxBytes: bound('replay', 'maxBytes', STREAM_LIMITS_DEFAULT.replay.maxBytes),
    }),
    queue: Object.freeze({
      events: bound('queue', 'events', STREAM_LIMITS_DEFAULT.queue.events),
      bytes: bound('queue', 'bytes', STREAM_LIMITS_DEFAULT.queue.bytes),
    }),
  });
}

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
 * Classify a source error against the operation's declared errors:
 * declared exactly when guarded reads find a string `code` that is an
 * own member of `route.errors`. `details` cross only when JSON-safe;
 * `retryable` is the error's own boolean, else the retry policy's
 * verdict. A hostile error whose members throw is not declared.
 * @param {unknown} error
 * @param {PipelineRoute} route
 * @returns {DeclaredStreamFailure | null}
 */
function declaredFailureOf(error, route) {
  try {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return null;
    const e = /** @type {any} */ (error);
    const code = e.code;
    if (typeof code !== 'string' || !Object.hasOwn(route.errors, code)) return null;
    const details = e.details;
    const retryable = typeof e.retryable === 'boolean' ? e.retryable : route.retryOn.has(code);
    return { code, details: details !== undefined && isJsonValue(details) ? details : undefined, retryable };
  }
  catch {
    return null;
  }
}

/**
 * Classify one emission: a `{ patch, seq }` record, a source error, or
 * a hostile value. Reads guardedly.
 * @param {unknown} emission
 * @returns {{ kind: 'patch', patch: unknown[], seq: number } | { kind: 'error', cause: unknown }}
 */
function classifyEmission(emission) {
  try {
    if (emission === null || typeof emission !== 'object') {
      return { kind: 'error', cause: new TypeError('the subscription emitted a non-object') };
    }
    const e = /** @type {any} */ (emission);
    if (e.error !== undefined) return { kind: 'error', cause: e.error };
    const patch = e.patch;
    const seq = e.seq;
    if (!Array.isArray(patch) || typeof seq !== 'number' || !Number.isFinite(seq)) {
      return { kind: 'error', cause: new TypeError('the subscription emitted a value that is not { patch, seq }') };
    }
    return { kind: 'patch', patch, seq };
  }
  catch (err) {
    return { kind: 'error', cause: err };
  }
}

/**
 * Validate one replay page defensively against the shape and the
 * bounds it was asked for; a page the source got wrong is the host's
 * fault. Answers the fault's message, or `null` when the page is valid.
 * @param {unknown} page
 * @param {number} after
 * @param {{ limit: number, maxBytes: number }} bounds
 * @returns {string | null}
 */
function pageFault(page, after, bounds) {
  try {
    if (page === null || typeof page !== 'object') return 'a replay page must be an object';
    const p = /** @type {any} */ (page);
    if (typeof p.resetRequired !== 'boolean') return 'a replay page must carry a boolean resetRequired';
    if (typeof p.hasMore !== 'boolean') return 'a replay page must carry a boolean hasMore';
    if (!(p.earliestAvailable === null || (typeof p.earliestAvailable === 'number' && Number.isFinite(p.earliestAvailable)))) {
      return 'a replay page must carry earliestAvailable as a number or null';
    }
    if (typeof p.highWatermark !== 'number' || !Number.isFinite(p.highWatermark)) return 'a replay page must carry a numeric highWatermark';
    if (!Array.isArray(p.items)) return 'a replay page must carry an items array';
    if (p.resetRequired) {
      if (p.items.length !== 0 || p.next !== undefined) return 'a replay page with resetRequired must carry no items and no next';
      return null;
    }
    if (p.items.length > bounds.limit) return `a replay page holds ${p.items.length} items over the ${bounds.limit} asked for`;
    if (p.next !== undefined && (typeof p.next !== 'number' || !Number.isFinite(p.next) || p.next < after)) {
      return 'a replay page must carry next as a number no lower than after';
    }
    let last = after;
    let bytes = 0;
    for (let i = 0; i < p.items.length; i++) {
      const item = classifyEmission(p.items[i]);
      if (item.kind !== 'patch') return `replay item ${i} is not { patch, seq }`;
      if (item.seq <= last) return `replay item ${i} does not advance the seq (${item.seq} after ${last})`;
      last = item.seq;
      bytes += utf8ByteLength(JSON.stringify(item.patch));
      if (bytes > bounds.maxBytes) return `a replay page holds ${bytes} patch bytes over the ${bounds.maxBytes} asked for`;
    }
    if (p.next !== undefined && p.items.length > 0 && p.next < last) return 'a replay page\'s next is below its last item';
    return null;
  }
  catch (err) {
    return `a replay page could not be read (${err instanceof Error ? err.message : String(err)})`;
  }
}

/**
 * Run one subscription over a carrier. Emissions are forwarded
 * verbatim (a patch is never mutated); an emission whose serialized
 * patch exceeds `policy.stream.maxPatchBytes` is replaced by a fresh
 * snapshot at that emission's seq (§18.1); an `{ error }` emission —
 * and a hostile one — raises the `error` intent and ends the stream.
 *
 * Returns the stopper and the completion signal ({@link StreamRunner}).
 * The stopper is idempotent; the subscription's own `stop()` and
 * `close()` run exactly once either way.
 *
 * @template F
 * @param {PipelineRoute} route
 * @param {SubscriptionLike} sub
 * @param {StreamHooks<F>} hooks
 * @param {StreamOptions} options
 * @returns {StreamRunner}
 */
export function runSubscription(route, sub, hooks, options) {
  const policy = /** @type {NonNullable<import('../compile.js').CompiledPolicy['stream']>} */ (
    route.op.policy.stream ?? { resume: 'snapshot', heartbeatMs: 15000, maxPatchBytes: null });
  const maxPatchBytes = policy.maxPatchBytes;
  const limits = options.limits ?? STREAM_LIMITS_DEFAULT;
  let finished = false;
  let ready = false;
  /** @type {any[]} live emissions that arrived before the initial events were decided */
  const early = [];
  /** @type {(() => unknown) | null} */
  let stopSub = null;
  let lastSeq = 0;
  /** @type {{ promise: Promise<void>, resolve: (value?: void) => void }} */
  const completion = Promise.withResolvers();
  const done = completion.promise;
  let releasing = false;
  /** @type {'slow-consumer' | null} */
  let terminalReason = null;
  const abort = new AbortController();

  /**
   * The ordered frame queue: one carrier write at a time, each behind
   * the previous one's settlement. A write that throws or rejects fails
   * the queue — the carrier can no longer deliver — and the runner
   * releases silently; nothing queued behind the failure runs.
   * @type {import('@jarenjs/core/async').AwaitedSink<F>}
   */
  const queue = createAwaitedSink({ write: (frame) => hooks.write(frame) });
  /** the frames charged to the queue: queued or in flight, not yet settled */
  let queuedEvents = 0;
  let queuedBytes = 0;

  /**
   * Whether one more frame of `bytes` fits the bound; the terminal
   * frame that reports an overflow is always admitted, so the peer that
   * can still read hears why.
   * @param {number} bytes
   * @returns {boolean}
   */
  function fits(bytes) {
    return queuedEvents + 1 <= limits.queue.events && queuedBytes + bytes <= limits.queue.bytes;
  }

  /**
   * Charge and queue one frame. Its count and bytes stay charged until
   * the write settled.
   * @param {F} frame
   * @param {number} bytes
   */
  function send(frame, bytes) {
    queuedEvents++;
    queuedBytes += bytes;
    const settle = () => {
      queuedEvents--;
      queuedBytes -= bytes;
    };
    const answer = queue.write(frame);
    if (answer === undefined) settle();
    else answer.then(settle, () => { settle(); release(false); });
  }

  /**
   * Render one event through its hook and queue the frame within the
   * bounds; an overflow ends the stream with the slow-consumer intent.
   * @param {() => F | null} render
   * @returns {boolean} false when the stream ended instead
   */
  function emit(render) {
    if (finished) return false;
    let frame;
    try {
      frame = render();
    }
    catch (err) {
      fail('source', err);
      return false;
    }
    if (frame === null) return true;
    let bytes = 0;
    try {
      bytes = Math.max(0, Number(hooks.size(frame)) || 0);
    }
    catch {
      bytes = 0;
    }
    if (!fits(bytes)) {
      overflow(bytes);
      return false;
    }
    send(frame, bytes);
    return true;
  }

  /**
   * The bounded queue would overflow: end with `JC2096`. The terminal
   * frame is admitted past the bound, and the carrier is told to tear
   * the sink down rather than wait for a consumer that stopped reading.
   * @param {number} bytes - the bytes of the frame that did not fit
   */
  function overflow(bytes) {
    if (finished) return;
    terminalReason = 'slow-consumer';
    const cause = new Error(`the stream's bounded queue would exceed ${limits.queue.events} events or ${limits.queue.bytes} bytes `
      + `(${queuedEvents} queued, ${queuedBytes} bytes, ${bytes} more)`);
    let frame = null;
    try {
      frame = hooks.error('slow-consumer', cause, lastSeq, null);
    }
    catch {
      frame = null;
    }
    if (frame !== null) {
      let size = 0;
      try {
        size = Math.max(0, Number(hooks.size(frame)) || 0);
      }
      catch {
        size = 0;
      }
      send(frame, size);
    }
    release(false);
  }

  /**
   * Release the subscription exactly once: the source's `stop()`, then
   * its `close()`, then — after the queued frames settled (or, on a
   * silent stop, without waiting for one still pending) — the carrier's
   * `done` hook. A throwing stop/close/done is swallowed; termination is
   * unconditional.
   * @param {boolean} drain - wait for the frames already queued (an `end`
   *   or `error` event the peer should still receive) before `done`
   * @returns {Promise<void>}
   */
  function release(drain) {
    if (releasing) return done;
    releasing = true;
    finished = true;
    abort.abort();
    (async () => {
      const stop = stopSub;
      stopSub = null;
      if (stop !== null) {
        try {
          await stop();
        }
        catch {
          // a throwing stop never blocks the close
        }
      }
      try {
        await sub.close();
      }
      catch {
        // a throwing close never blocks termination
      }
      try {
        await (drain ? queue.end() : queue.abort(new Error('the stream was stopped')));
      }
      catch {
        // a failed carrier queue is exactly what a silent release expects
      }
      try {
        await hooks.done(terminalReason);
      }
      catch {
        // the carrier's cleanup must not break termination
      }
    })().then(() => completion.resolve(), () => completion.resolve());
    return done;
  }

  /** @type {StreamRunner} */
  const runner = {
    stop: (reason) => {
      if (finished) return;
      if (reason !== null) {
        emit(() => hooks.end(reason, lastSeq));
        release(true);
      }
      else release(false);
    },
    done,
  };

  /**
   * End with an error intent: the carrier renders the event (behind the
   * frames still queued), then the subscription is released.
   * @param {ErrorIntent} intent
   * @param {unknown} cause
   * @param {DeclaredStreamFailure | null} [declared]
   */
  function fail(intent, cause, declared = null) {
    if (finished) return;
    emit(() => hooks.error(intent, cause, lastSeq, declared));
    release(true);
  }

  /**
   * Read, validate and queue a fresh snapshot at `seq`.
   * @param {number} seq
   * @param {{ reset: boolean, earliestAvailable: number | null, highWatermark: number | null }} info
   * @returns {boolean} false when the stream ended instead
   */
  function emitSnapshot(seq, info) {
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
    const value = snap.value;
    return emit(() => hooks.snapshot(seq, {
      value, resumed: false, reset: info.reset, earliestAvailable: info.earliestAvailable, highWatermark: info.highWatermark,
    }));
  }

  /**
   * One emission from the subscription, delivered or held until the
   * initial events are decided.
   * @param {any} emission
   */
  function deliver(emission) {
    if (finished) return;
    if (!ready) {
      // held until replay decided the stream's start; the bound applies
      // here too — a source that outruns a page load is a slow consumer
      // of its own log
      if (early.length + 1 > limits.queue.events) {
        overflow(0);
        return;
      }
      early.push(emission);
      return;
    }
    const item = classifyEmission(emission);
    if (item.kind === 'error') {
      // a source error whose code the operation declares crosses as
      // that declared failure; anything else is the host fault
      const declared = declaredFailureOf(item.cause, route);
      fail(declared === null ? 'source' : 'declared', item.cause, declared);
      return;
    }
    if (item.seq <= lastSeq && lastSeq !== 0) return; // already delivered, or reflected by a snapshot
    if (maxPatchBytes !== null && utf8ByteLength(JSON.stringify(item.patch)) > maxPatchBytes) {
      // the consumer swaps its document instead of patching it (§18.1)
      emitSnapshot(item.seq, { reset: false, earliestAvailable: null, highWatermark: null });
      return;
    }
    lastSeq = item.seq;
    const at = item.seq;
    const patch = item.patch;
    emit(() => hooks.patch(at, { patch, seq: at }));
  }

  // subscribe FIRST so nothing between the subscription and the initial
  // events is lost; emissions are held until the initial events are out
  try {
    stopSub = sub.subscribe(deliver);
  }
  catch (err) {
    fail('source', err);
    return runner;
  }
  if (typeof stopSub !== 'function') stopSub = null;

  /** Flush what was held while the initial events were decided. */
  function flush() {
    ready = true;
    while (early.length > 0 && !finished) deliver(early.shift());
  }

  /** The highest valid seq among the emissions held so far. */
  function heldSeq() {
    let top = 0;
    for (let i = 0; i < early.length; i++) {
      const item = classifyEmission(early[i]);
      if (item.kind === 'patch' && item.seq > top) top = item.seq;
    }
    return top;
  }

  const wantsReplay = options.lastSeq !== null && policy.resume === 'replay' && typeof sub.replay === 'function';
  if (!wantsReplay) {
    // a fresh stream, or a resume the policy answers with a snapshot
    if (emitSnapshot(0, { reset: false, earliestAvailable: null, highWatermark: null })) flush();
    return runner;
  }

  /**
   * The page loop: one page per call from `after`, patches delivered in
   * order, until the FIRST page's high watermark is reached or the log
   * says there is no more; a `resetRequired` page discards the replay
   * and re-seeds with a snapshot whose id covers every emission already
   * held.
   * @param {number} after
   * @param {number | null} target
   */
  function page(after, target) {
    if (finished) return;
    let answer;
    try {
      answer = /** @type {NonNullable<SubscriptionLike['replay']>} */ (sub.replay)(after,
        { limit: limits.replay.limit, maxBytes: limits.replay.maxBytes, signal: abort.signal });
    }
    catch (err) {
      fail('source', err);
      return;
    }
    /** @param {unknown} result */
    const settle = (result) => {
      if (finished) return; // stopped while the page loaded: a late page is ignored
      if (result === null || result === undefined) {
        // the source cannot replay this cursor at all: a fresh snapshot,
        // resume refused (JC2095) — informational, never a fault
        if (emitSnapshot(0, { reset: false, earliestAvailable: null, highWatermark: null })) flush();
        return;
      }
      const fault = pageFault(result, after, limits.replay);
      if (fault !== null) {
        fail('source', new TypeError(`the replay of '${route.op.id}' answered an invalid page: ${fault}`));
        return;
      }
      const p = /** @type {ReplayPage} */ (result);
      if (p.resetRequired) {
        // a total refusal: no suffix, a fresh snapshot instead. Its id
        // is the higher of the log's watermark and anything the live
        // source already delivered into the hold, because the snapshot
        // read now reflects every one of those emissions (§17.1)
        const effective = Math.max(p.highWatermark, heldSeq());
        if (emitSnapshot(effective, { reset: true, earliestAvailable: p.earliestAvailable, highWatermark: effective })) flush();
        return;
      }
      const goal = target === null ? p.highWatermark : target;
      lastSeq = after;
      ready = true;
      for (let i = 0; i < p.items.length && !finished; i++) {
        const item = /** @type {{ patch: unknown[], seq: number }} */ (p.items[i]);
        if (item.seq <= lastSeq) continue;
        lastSeq = item.seq;
        const at = item.seq;
        const patch = item.patch;
        if (!emit(() => hooks.patch(at, { patch, seq: at }))) return;
      }
      ready = false;
      const next = p.next === undefined ? lastSeq : Math.max(p.next, lastSeq);
      if (!p.hasMore || next >= goal || p.items.length === 0) {
        // caught up to the target: what the live source delivered
        // meanwhile follows, minus what the pages already covered
        flush();
        return;
      }
      page(next, goal);
    };
    if (isThenable(answer)) {
      toPromise(answer).then(settle, (/** @type {unknown} */ err) => {
        if (!finished) fail('source', err);
      });
    }
    else settle(answer);
  }
  page(/** @type {number} */ (options.lastSeq), null);
  return runner;
}

export { STREAM_ERRORS, STREAM_EVENTS, STREAM_MEDIA, HEARTBEAT_LINE, encodeStreamEvent } from './sse.js';
