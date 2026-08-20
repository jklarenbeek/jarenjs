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
import { validateOperationInput, settleOperation, safeTrace, PORT_LOCAL_ERRORS } from '../pipeline.js';
import { HTTP_ERRORS, renderMessage, declaredMessage } from '../http/wire.js';
import { isContractFrame, valueFrame, errorFrame, attach, isChannel } from './frame.js';

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
 * @property {() => string} [trace] - the server trace generator; default `crypto.randomUUID`
 * @property {'always' | 'never'} [validateOutput] - `'never'` is a declared
 *   downgrade, reported in `capabilities.validatedOutput`
 * @property {Record<string, string | ((params: object) => string)>} [catalog]
 *   - a message catalog consulted before the English one
 * @property {(error: unknown, ctx: { op: string, trace: string } | null) => void} [onError]
 *   - observes the cause behind every `JC2070` frame, validator throws
 *   and a channel whose `postMessage` throws
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
 * @property {false} stream
 * @property {'message'} cancel
 */

/**
 * The server binding.
 * @typedef {Object} PortServer
 * @property {PortServerCapabilities} capabilities
 * @property {Contract} contract
 * @property {() => any} describe
 * @property {() => void} close - detaches the listener and aborts every in-flight request
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
 * The pipeline route of one served operation.
 * @param {CompiledOperation} op
 * @param {Handler | null} handler
 * @returns {PipelineRoute}
 */
function prepare(op, handler) {
  return Object.freeze({
    op,
    handler,
    raw: op.http.opaque,
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
  const traceGen = options.trace === undefined ? () => globalThis.crypto.randomUUID() : options.trace;
  const onError = options.onError === undefined ? null : options.onError;
  /** @type {Catalog | null} */
  const catalog = options.catalog === undefined ? null : compileMessageCatalog(options.catalog);
  const validate = validateOutput === 'always';

  /** @type {Map<string, PipelineRoute>} */
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
    if (route === undefined || route.raw) {
      // never echo what the frame asked for — it is the request's own value
      post(errorFrame(id, 'JC2071', renderMessage(catalog, PORT_LOCAL_ERRORS.JC2071.msgid, {}), undefined, false, trace), null);
      return;
    }
    const opId = route.op.id;
    const value = route.validateInput === null ? null : input === undefined ? null : input;
    const invalid = validateOperationInput(route, value);
    if (invalid !== null && invalid.kind === 'contract') {
      if (invalid.cause !== undefined) observe(invalid.cause, { op: opId, trace });
      post(errorFrame(id, 'JC2006', renderMessage(catalog, HTTP_ERRORS.JC2006.msgid, { op: opId }),
        invalid.details, false, trace), { op: opId, trace });
      return;
    }
    const controller = new AbortController();
    active.set(id, controller);
    const ctx = Object.freeze({
      op: route.op, trace, signal: controller.signal, params: null, headers: NO_HEADERS,
      fail: ContractFailure, idempotency: null,
    });
    settleOperation(route, value, ctx, validate).then((result) => {
      if (active.get(id) === controller) active.delete(id);
      // a cancelled request's client is gone and drops late responses
      // anyway; not answering just keeps the channel quiet
      if (controller.signal.aborted || closed) return;
      if (result.kind === 'value') {
        post(valueFrame(id, result.value, trace), { op: opId, trace });
      }
      else if (result.kind === 'failure') {
        post(errorFrame(id, result.code, declaredMessage(catalog, opId, result.code, result.params),
          result.details, result.retryable, trace), { op: opId, trace });
      }
      else {
        if (result.cause !== undefined) observe(result.cause, { op: opId, trace });
        post(errorFrame(id, 'JC2070', renderMessage(catalog, PORT_LOCAL_ERRORS.JC2070.msgid, { op: opId }),
          undefined, false, trace), { op: opId, trace });
      }
    });
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
    // a response frame on a shared channel is another server's answer
    if (Object.hasOwn(f, 'ok')) return;
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
    stream: false,
    cancel: 'message',
  });

  return Object.freeze({
    capabilities,
    contract,
    describe: () => contract.describe(),
    close: () => {
      if (closed) return;
      closed = true;
      detach();
      for (const controller of active.values()) controller.abort();
      active.clear();
    },
  });
}
