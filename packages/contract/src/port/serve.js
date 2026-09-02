//@ts-check
/**
 * @file `servePort(contract, handlers, options)`: the server half of the
 * port binding (docs/CONTRACT-FORMAT.md §16) — request/response over a
 * `MessagePort`, a `Worker`, a `BroadcastChannel` or a worker's own
 * `self`. Requests run through the same neutral pipeline as every other
 * server binding, under one `AbortController` per request id; a cancel
 * frame aborts it (an optimization — the client's id scoping is the
 * guarantee), and the response is posted back on the same channel.
 *
 * The listener touches nothing without the frame marker — other traffic
 * may share the channel and is never answered — and never answers a
 * RESPONSE frame either, so two ends on one broadcast channel cannot
 * echo at each other. A request naming an operation this channel does
 * not serve (unknown, or opaque — a port carries JSON only) is answered
 * `JC2071` without echoing what it asked for; an invalid input is
 * `JC2006` with details by the operation's policy; a handler fault of
 * any class is `JC2070` with the cause reported to `onError`, never
 * onto the wire. Exactly ONE server should serve a shared channel — two
 * would both answer every request.
 */

import { compileMessageCatalog } from '@jarenjs/core/message';

import { ContractHostError, ContractFailure } from '../errors.js';
import { validateOperationInput, settleOperation, safeTrace, PORT_LOCAL_ERRORS, classifyDeclared } from '../pipeline.js';
import { resolveLifecycle, identify as identifyHost, acquire as acquireHost, once, RollbackCarrier } from '../host.js';
import { resolveHostRuntime } from '../runtime.js';
import { isSubscriptionLike, runSubscription, resolveStreamLimits, STREAM_ERRORS } from '../stream/server.js';
import { HTTP_ERRORS, renderMessage, declaredMessage } from '../http/wire.js';
import { isContractFrame, valueFrame, errorFrame, pushFrame, attach, isChannel } from './frame.js';

export { openPortClient } from './client.js';
export { FRAME_MARKER, isContractFrame } from './frame.js';
export { PORT_LOCAL_ERRORS };

/**
 * @typedef {import('../compile.js').Contract} Contract
 * @typedef {import('../compile.js').CompiledOperation} CompiledOperation
 * @typedef {import('../http/wire.js').Catalog} Catalog
 * @typedef {import('../http/dispatch.js').Handler} Handler
 * @typedef {import('../pipeline.js').PipelineRoute} PipelineRoute
 * @typedef {import('./frame.js').ChannelLike} ChannelLike
 */

/**
 * @typedef {Object} ServePortOptions
 * @property {ChannelLike} channel - the channel to serve (required)
 * @property {() => string} [trace] - the server trace generator; default
 *   the runtime record's `uuid`, itself `crypto.randomUUID` by default
 * @property {'always' | 'never'} [validateOutput] - `'never'` is a declared
 *   downgrade, reported in `capabilities.validatedOutput`
 * @property {Record<string, string | ((params: object) => string)>} [catalog]
 *   - a message catalog consulted before the English one
 * @property {(error: unknown, ctx: { op: string, trace: string } | null) => void} [onError]
 * @property {(meta: import('../host.js').IdentifyMeta) => unknown} [identify]
 *   - the host lifecycle's first hook (docs/CONTRACT-FORMAT.md §7.7), run
 *   after the operation resolved and before the input is validated;
 *   `meta.carrier` is `'port'` and the request-line members are `null`
 * @property {(input: unknown, identity: unknown, enter: (lease: unknown) => Promise<unknown>) => unknown} [acquire]
 *   - the second hook, run after the input validated; a `settlement` on
 *   its lease is accepted and unused — this binding carries no
 *   idempotency
 *   - observes the cause behind every `JC2070` frame, validator throws
 *   and a channel whose `postMessage` throws
 * @property {Partial<import('@jarenjs/core/runtime').Runtime>} [runtime]
 *   - the host's runtime record: its `uuid` generates the server trace
 *   where `trace` is absent
 * @property {{ replay?: { limit?: number, maxBytes?: number }, queue?: { events?: number, bytes?: number } }} [streamLimits]
 *   - the bounds of every push-frame stream (docs/CONTRACT-FORMAT.md
 *   §18.1): a replay page asks for at most `replay.limit` emissions /
 *   `replay.maxBytes` patch bytes (default 256 / 1 MiB); the undelivered
 *   queue holds at most `queue.events` frames / `queue.bytes` frame
 *   bytes (default 256 / 1 MiB) before the stream ends with `JC2096`
 */

/**
 * The frozen capabilities table of the port server: JSON frames only —
 * no statuses, headers, media or entity tags, no idempotency carriage
 * (a declared policy is inert here, like on `local`), and cancellation
 * arrives as a message.
 * @typedef {Object} PortServerCapabilities
 * @property {'port'} name
 * @property {false} status
 * @property {false} headers
 * @property {false} media
 * @property {false} etag
 * @property {false} idempotency
 * @property {boolean} validatedOutput
 * @property {true} stream - subscribe operations stream as push frames (docs/CONTRACT-FORMAT.md §18.2)
 * @property {'message'} cancel
 */

/**
 * The server binding.
 * @typedef {Object} PortServer
 * @property {PortServerCapabilities} capabilities
 * @property {Contract} contract
 * @property {() => any} describe
 * @property {() => void} close - ends every live stream with `end`
 *   (`server-shutdown`), detaches the listener and aborts every in-flight request
 */

/** The frozen empty header table every port handler context carries. */
const NO_HEADERS = Object.freeze({});

/**
 * @param {string} code
 * @param {string} reason
 * @returns {ContractHostError}
 */
function host(code, reason) {
  return new ContractHostError(code, `servePort: ${reason}`);
}

/**
 * One served operation: the neutral pipeline route plus whether it is a
 * subscribe operation (a stream, never a request/response).
 * @typedef {PipelineRoute & { stream: boolean }} PortRoute
 */

/**
 * The pipeline route of one served operation.
 * @param {CompiledOperation} op
 * @param {Handler | null} handler
 * @returns {PortRoute}
 */
function prepare(op, handler) {
  return Object.freeze({
    op,
    handler,
    raw: op.http.opaque,
    stream: op.kind === 'subscribe',
    validateInput: op.input === null ? null : op.input.validate,
    validateOutput: op.output.validate,
    details: op.policy.errors.details,
    errors: op.errors,
    retryOn: new Set(op.policy.retry === null ? [] : op.policy.retry.on),
  });
}

/**
 * Serve a compiled contract over a message channel. Construction refuses
 * host mistakes (`JC1001` handler table, channel or option, `JC1002`
 * missing handler — an opaque operation is exempt, it is answered
 * `JC2071` instead of served).
 *
 * @param {Contract} contract
 * @param {Record<string, Handler>} handlers - operation id → handler
 * @param {ServePortOptions} options
 * @returns {PortServer}
 * @throws {ContractHostError}
 * @example
 * // inside a worker: serve the worker's own channel
 * servePort(contract, handlers, { channel: self });
 * // and the same handlers to every tab on a BroadcastChannel
 * servePort(contract, handlers, { channel: new BroadcastChannel('app') });
 */
export function servePort(contract, handlers, options) {
  if (contract === null || typeof contract !== 'object' || typeof contract.match !== 'function'
    || contract.operations === null || typeof contract.operations !== 'object' || !Array.isArray(contract.ids)) {
    throw host('JC1001', 'the first argument must be a compiled contract (compileContract)');
  }
  if (handlers === null || typeof handlers !== 'object' || Array.isArray(handlers)) {
    throw host('JC1001', 'handlers must be an object of operation id → function');
  }
  const names = Object.keys(handlers);
  for (let i = 0; i < names.length; i++) {
    const id = names[i];
    if (!Object.hasOwn(contract.operations, id)) {
      throw host('JC1001', `handlers names '${id}', which is not an operation of the contract`);
    }
    if (typeof handlers[id] !== 'function') {
      throw host('JC1001', `the handler of '${id}' must be a function, got ${typeof handlers[id]}`);
    }
  }
  if (options === null || typeof options !== 'object') throw host('JC1001', 'options must be an object with the channel');
  const channel = options.channel;
  if (!isChannel(channel)) {
    throw host('JC1001', 'options.channel must expose postMessage and a message listener surface (a MessagePort, Worker, BroadcastChannel, a worker\'s self, or the shape)');
  }
  const validateOutput = options.validateOutput === undefined ? 'always' : options.validateOutput;
  if (validateOutput !== 'always' && validateOutput !== 'never') {
    throw host('JC1001', "options.validateOutput must be 'always' or 'never'");
  }
  for (const [name, value] of [['trace', options.trace], ['onError', options.onError]]) {
    if (value !== undefined && typeof value !== 'function') throw host('JC1001', `options.${name} must be a function`);
  }
  if (options.catalog !== undefined && (options.catalog === null || typeof options.catalog !== 'object')) {
    throw host('JC1001', 'options.catalog must be a message catalog object');
  }
  const runtime = resolveHostRuntime(options.runtime, host, 'JC1001');
  const streamLimits = resolveStreamLimits(options.streamLimits, (reason) => host('JC1001', reason));
  const lifecycle = resolveLifecycle(options, (reason) => host('JC1001', reason));
  const traceGen = options.trace === undefined ? runtime.uuid : options.trace;
  const onError = options.onError === undefined ? null : options.onError;
  /** @type {Catalog | null} */
  const catalog = options.catalog === undefined ? null : compileMessageCatalog(options.catalog);
  const validate = validateOutput === 'always';

  /** @type {Map<string, PortRoute>} */
  const routes = new Map();
  for (let i = 0; i < contract.ids.length; i++) {
    const id = contract.ids[i];
    const op = contract.operations[id];
    const handler = Object.hasOwn(handlers, id) ? handlers[id] : null;
    if (handler === null && !op.http.opaque) {
      throw host('JC1002', `operation '${id}' has no handler`);
    }
    routes.set(id, prepare(op, handler));
  }

  /** @type {Map<string, AbortController>} */
  const active = new Map();
  let closed = false;

  /**
   * The frozen context of one request or subscription on this carrier:
   * the request-line members are `null` here, `etag`/`status` are not
   * callable, and `host` is the identity's until `acquire` entered.
   * @param {PortRoute} route
   * @param {string} trace
   * @param {AbortSignal} signal
   * @param {unknown} hostValue
   */
  const contextOf = (route, trace, signal, hostValue) => Object.freeze({
    op: route.op, trace, carrier: /** @type {const} */ ('port'), host: hostValue, signal,
    method: null, path: null, params: null, headers: NO_HEADERS, body: null,
    fail: ContractFailure, idempotency: null, etag: null, status: null,
  });

  /**
   * Run the host lifecycle around a served request or subscription:
   * identify before validation, the validation itself (`validate`),
   * acquire after it, then `enter` with the handler's context. Every
   * fault of a hook is the binding's host fault (`JC2070`); a declared
   * failure is classified like a handler's. The answer is what `enter`
   * (or a refusal) produced, plus the releases the caller runs at its
   * own boundary.
   * @param {PortRoute} route
   * @param {string} trace
   * @param {AbortSignal} signal
   * @param {unknown} value - the input as the frame carried it
   * @param {(error: unknown) => void} observed
   * @param {(code: 'JC2006' | 'JC2070', details: unknown, cause: unknown) => void} refuse - a pre-handler refusal
   * @param {(result: import('../pipeline.js').OperationResult) => void} failed - a declared failure of a hook
   * @param {(hctx: any) => Promise<unknown>} enter
   * @returns {Promise<{ entered: boolean, value: unknown, release: () => Promise<boolean> }>}
   */
  async function lifecycleAround(route, trace, signal, value, observed, refuse, failed, enter) {
    const meta = Object.freeze({ op: route.op, trace, signal, carrier: /** @type {const} */ ('port'), method: null, path: null, headers: null, fail: ContractFailure });
    const identified = await identifyHost(lifecycle, meta);
    const none = () => Promise.resolve(true);
    if (identified.kind === 'fault') {
      refuse('JC2070', undefined, identified.cause);
      return { entered: false, value: undefined, release: none };
    }
    if (identified.kind === 'failure') {
      failed(classifyDeclared(route, identified.failure));
      return { entered: false, value: undefined, release: none };
    }
    const identity = once(identified.lease.release, observed);
    /** @type {(() => Promise<boolean>) | null} */
    let acquired = null;
    const release = () => (acquired === null ? identity() : acquired().then((a) => identity().then((b) => a && b)));
    const invalid = validateOperationInput(route, value);
    if (invalid !== null && invalid.kind === 'contract') {
      refuse('JC2006', invalid.details, invalid.cause);
      return { entered: false, value: undefined, release };
    }
    const ictx = contextOf(route, trace, signal, identified.lease.host);
    const out = await acquireHost(lifecycle, value, ictx, (lease) => {
      acquired = once(lease.release, observed);
      return enter(Object.freeze({ ...ictx, host: lease.host }));
    });
    if (out.kind === 'fault') {
      refuse('JC2070', undefined, out.cause);
      return { entered: false, value: undefined, release };
    }
    if (out.kind === 'failure') {
      failed(classifyDeclared(route, out.failure));
      return { entered: false, value: undefined, release };
    }
    if (out.afterFault !== undefined) observed(out.afterFault);
    return { entered: true, value: out.result, release };
  }

  /**
   * @param {unknown} error
   * @param {{ op: string, trace: string } | null} ctx
   */
  function observe(error, ctx) {
    if (onError === null) return;
    try {
      onError(error, ctx);
    }
    catch {
      // an observer that throws never reaches the response
    }
  }

  /**
   * Post a frame. TOTAL: a channel that throws (closed, detached) is
   * reported, never a crash on the serving side.
   * @param {unknown} frame
   * @param {{ op: string, trace: string } | null} ctx
   */
  function post(frame, ctx) {
    try {
      channel.postMessage(frame);
    }
    catch (err) {
      observe(err, ctx);
    }
  }

  /**
   * One request frame through the pipeline and back onto the channel.
   * @param {string} id
   * @param {unknown} op
   * @param {unknown} input
   */
  function serveRequest(id, op, input) {
    const trace = safeTrace(traceGen);
    const route = typeof op === 'string' ? routes.get(op) : undefined;
    // a subscribe operation is a stream, never a request/response —
    // asked as one, it is "not served on this channel" like an opaque
    if (route === undefined || route.raw || route.stream) {
      // never echo what the frame asked for — it is the request's own value
      post(errorFrame(id, 'JC2071', renderMessage(catalog, PORT_LOCAL_ERRORS.JC2071.msgid, {}), undefined, false, trace), null);
      return;
    }
    const opId = route.op.id;
    const value = route.validateInput === null ? null : input === undefined ? null : input;
    const controller = new AbortController();
    active.set(id, controller);
    const pushCtx = { op: opId, trace };
    /** @param {import('../pipeline.js').OperationResult} result */
    const answer = (result) => {
      if (result.kind === 'value') {
        post(valueFrame(id, result.value, trace), pushCtx);
      }
      else if (result.kind === 'failure') {
        post(errorFrame(id, result.code, declaredMessage(catalog, opId, result.code, result.params),
          result.details, result.retryable, trace), pushCtx);
      }
      else {
        if (result.cause !== undefined) observe(result.cause, pushCtx);
        post(errorFrame(id, 'JC2070', renderMessage(catalog, PORT_LOCAL_ERRORS.JC2070.msgid, { op: opId }),
          undefined, false, trace), pushCtx);
      }
    };
    lifecycleAround(route, trace, controller.signal, value,
      (error) => observe(error, pushCtx),
      (code, details, cause) => {
        if (cause !== undefined) observe(cause, pushCtx);
        post(errorFrame(id, code, renderMessage(catalog, code === 'JC2006' ? HTTP_ERRORS.JC2006.msgid : PORT_LOCAL_ERRORS.JC2070.msgid, { op: opId }),
          details, false, trace), pushCtx);
      },
      answer,
      // inside enter: the handler through the neutral pipeline; a host
      // fault rejects enter with the rollback carrier so a transaction
      // around it rolls back, the fault still the answer
      (hctx) => settleOperation(route, value, hctx, validate).then((result) => {
        if (result.kind === 'contract') throw new RollbackCarrier(result, result.cause);
        return result;
      }))
      .then((run) => {
        if (active.get(id) === controller) active.delete(id);
        // a cancelled request's client is gone and drops late responses
        // anyway; not answering just keeps the channel quiet
        if (run.entered && !controller.signal.aborted && !closed) answer(/** @type {any} */ (run.value));
        return run.release();
      });
  }

  /**
   * The live streams by id. An entry exists from the subscribe frame
   * on, so an unsubscribe that races the handler's settlement still
   * lands: `stop` is re-pointed at the runner once it exists.
   * @type {Map<string, { stopped: boolean, stop: (reason: string | null) => void }>}
   */
  const streams = new Map();

  /**
   * An error push frame's data: the wire error record (§7.3's body
   * without a status; `details` only when present).
   * @param {string} code
   * @param {string} message
   * @param {string} trace
   * @param {unknown} details
   * @param {boolean} retryable
   */
  function wireError(code, message, trace, details, retryable) {
    return details === undefined
      ? { code, message, requestId: trace, retryable }
      : { code, message, requestId: trace, details, retryable };
  }

  /**
   * One subscribe frame: open the stream (docs/CONTRACT-FORMAT.md
   * §18.2). Pre-stream failures — unknown or non-subscribe op, invalid
   * input, a handler fault, an invalid snapshot — arrive as `error`
   * push frames; then the carrier-neutral runner forwards the
   * subscription's events as push frames until the stream ends.
   * @param {string} id
   * @param {unknown} op
   * @param {unknown} input
   * @param {unknown} lastSeqRaw
   */
  function serveSubscribe(id, op, input, lastSeqRaw) {
    const trace = safeTrace(traceGen);
    const route = typeof op === 'string' ? routes.get(op) : undefined;
    if (route === undefined || !route.stream) {
      post(pushFrame(id, 'error', 0, wireError('JC2071', renderMessage(catalog, PORT_LOCAL_ERRORS.JC2071.msgid, {}), trace, undefined, false)), null);
      return;
    }
    const opId = route.op.id;
    const value = route.validateInput === null ? null : input === undefined ? null : input;
    const lastSeq = Number.isInteger(lastSeqRaw) && /** @type {number} */ (lastSeqRaw) >= 0 ? /** @type {number} */ (lastSeqRaw) : null;
    const entry = { stopped: false, stop: /** @type {(reason: string | null) => void} */ (() => { entry.stopped = true; }) };
    streams.set(id, entry);
    const controller = new AbortController();
    const pushCtx = { op: opId, trace };
    /** @param {import('../pipeline.js').OperationResult} result */
    const preStream = (result) => {
      streams.delete(id);
      if (result.kind === 'failure') {
        post(pushFrame(id, 'error', 0, wireError(result.code, declaredMessage(catalog, opId, result.code, result.params), trace, result.details, result.retryable)), pushCtx);
        return;
      }
      if (result.kind === 'contract') {
        if (result.cause !== undefined) observe(result.cause, pushCtx);
        post(pushFrame(id, 'error', 0, wireError('JC2070', renderMessage(catalog, PORT_LOCAL_ERRORS.JC2070.msgid, { op: opId }), trace, undefined, false)), pushCtx);
      }
    };
    lifecycleAround(route, trace, controller.signal, value,
      (error) => observe(error, pushCtx),
      (code, details, cause) => {
        streams.delete(id);
        if (cause !== undefined) observe(cause, pushCtx);
        post(pushFrame(id, 'error', 0, wireError(code, renderMessage(catalog, code === 'JC2006' ? HTTP_ERRORS.JC2006.msgid : PORT_LOCAL_ERRORS.JC2070.msgid, { op: opId }), trace, details, false)), pushCtx);
      },
      preStream,
      (hctx) => settleOperation(route, value, hctx, false))
      .then((run) => {
        if (!run.entered) return run.release();
        const result = /** @type {import('../pipeline.js').OperationResult} */ (run.value);
        if (closed || entry.stopped) {
          streams.delete(id);
          // the settlement may still hold a live subscription — release it
          if (result.kind === 'value' && isSubscriptionLike(result.value)) {
            try {
              result.value.close();
            }
            catch {
              // a throwing close changes nothing for a gone client
            }
          }
          return run.release();
        }
        if (result.kind !== 'value') {
          preStream(result);
          return run.release();
        }
        const sub = result.value;
        if (!isSubscriptionLike(sub)) {
          streams.delete(id);
          observe(new TypeError(`the handler of subscribe operation '${opId}' did not answer a subscription ({ result | snapshot(), subscribe, close })`), pushCtx);
          post(pushFrame(id, 'error', 0, wireError('JC2070', renderMessage(catalog, PORT_LOCAL_ERRORS.JC2070.msgid, { op: opId }), trace, undefined, false)), pushCtx);
          return run.release();
        }
        return streamSubscription(id, route, sub, lastSeq, trace, pushCtx, entry, run.release);
      });
  }

  /**
   * The runner over a live subscription on this channel; the leases are
   * released after the runner's stop/close/done sequence.
   * @param {string} id
   * @param {PortRoute} route
   * @param {any} sub
   * @param {number | null} lastSeq
   * @param {string} trace
   * @param {{ op: string, trace: string }} pushCtx
   * @param {{ stopped: boolean, stop: (reason: string | null) => void }} entry
   * @param {() => Promise<boolean>} release
   */
  function streamSubscription(id, route, sub, lastSeq, trace, pushCtx, entry, release) {
    const opId = route.op.id;
    {
      const runner = runSubscription(route, sub, {
        snapshot: (seq, data) => pushFrame(id, 'snapshot', seq, data),
        patch: (seq, emission) => pushFrame(id, 'patch', seq, emission),
        error: (intent, cause, seq, declared) => {
          if (intent !== 'slow-consumer') observe(cause, pushCtx);
          if (intent === 'declared' && declared !== null) {
            return pushFrame(id, 'error', seq, wireError(declared.code, declaredMessage(catalog, opId, declared.code, {}), trace, declared.details, declared.retryable));
          }
          const code = intent === 'invalid-snapshot' ? 'JC2091' : intent === 'slow-consumer' ? 'JC2096' : 'JC2070';
          const row = intent === 'invalid-snapshot' ? STREAM_ERRORS.JC2091
            : intent === 'slow-consumer' ? STREAM_ERRORS.JC2096 : PORT_LOCAL_ERRORS.JC2070;
          return pushFrame(id, 'error', seq, wireError(code, renderMessage(catalog, row.msgid, { op: opId }), trace, undefined, row.retryable));
        },
        end: (reason, seq) => pushFrame(id, 'end', seq, { reason }),
        // the byte account is the frame as posted: its JSON text
        size: (frame) => JSON.stringify(frame).length,
        write: (frame) => post(frame, pushCtx),
        done: () => {
          streams.delete(id);
          return release().then(() => undefined);
        },
      }, { lastSeq, validate, limits: streamLimits });
      entry.stop = (reason) => runner.stop(reason);
    }
  }

  /** @param {any} event */
  function listener(event) {
    const frame = event === null || typeof event !== 'object' ? undefined : event.data;
    if (closed || !isContractFrame(frame)) return;
    const f = /** @type {any} */ (frame);
    if (Object.hasOwn(f, 'cancel')) {
      const controller = typeof f.cancel === 'string' ? active.get(f.cancel) : undefined;
      if (controller !== undefined) controller.abort();
      return;
    }
    if (Object.hasOwn(f, 'subscribe')) {
      if (typeof f.subscribe === 'string' && f.subscribe.length > 0 && !streams.has(f.subscribe)) {
        serveSubscribe(f.subscribe, f.op, f.input, f.lastSeq);
      }
      return;
    }
    if (Object.hasOwn(f, 'unsubscribe')) {
      const entry = typeof f.unsubscribe === 'string' ? streams.get(f.unsubscribe) : undefined;
      if (entry !== undefined) {
        streams.delete(f.unsubscribe);
        entry.stop(null);
      }
      return;
    }
    // a response or push frame on a shared channel is another server's answer
    if (Object.hasOwn(f, 'ok') || Object.hasOwn(f, 'event')) return;
    // without a string id there is nothing to address an answer to
    if (typeof f.id !== 'string' || f.id.length === 0) return;
    serveRequest(f.id, f.op, f.input);
  }

  const detach = attach(channel, listener);

  /** @type {PortServerCapabilities} */
  const capabilities = Object.freeze({
    name: 'port',
    status: false,
    headers: false,
    media: false,
    etag: false,
    idempotency: false,
    validatedOutput: validate,
    stream: true,
    cancel: 'message',
  });

  return Object.freeze({
    capabilities,
    contract,
    describe: () => contract.describe(),
    close: () => {
      if (closed) return;
      // every live stream ends with server-shutdown BEFORE the channel
      // detaches, so the clients hear it
      for (const entry of [...streams.values()]) entry.stop('server-shutdown');
      streams.clear();
      closed = true;
      detach();
      for (const controller of active.values()) controller.abort();
      active.clear();
    },
  });
}
