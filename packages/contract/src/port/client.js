//@ts-check
/**
 * @file `openPortClient(contract, options)`: the client half of the port
 * binding (docs/CONTRACT-FORMAT.md §16). `invoke(op, input, ctx)`
 * validates the input with the operation's compiled validator (a refusal
 * is the `JC2050` outcome — nothing is posted), posts one request frame,
 * and resolves a D6 outcome for every way a channel can answer: the
 * matching response (success validated against the output schema,
 * `JC2053`; a declared or taxonomy error a `failure` with `status:
 * null`; a served-host fault `kind: "contract"` with the server's
 * `JC2070`/`JC2071` code kept), no answer within `timeoutMs` (`JC2072`,
 * network), a malformed response frame (`JC2073`, contract), a channel
 * whose `postMessage` throws (`JC2074`, network), and a caller abort
 * (`cancelled` — a cancel frame is also posted so the server can stop
 * work; the id scoping is the guarantee, so a late response for a
 * cancelled or timed-out id is dropped silently).
 *
 * Request ids are `"<clientId>:<seq>"` with a UUID client id, and every
 * incoming frame is prefix-tested against `clientId + ":"` BEFORE any
 * map lookup — two clients on one shared channel can never cross-settle,
 * whatever the other one sends. `close()` rejects nothing: pending
 * invokes resolve `cancelled` and the listener is removed (the channel
 * itself is the host's to close).
 */

import { compileMessageCatalog } from '@jarenjs/core/message';
import { resolveHostRuntime } from '../runtime.js';

import { ContractHostError } from '../errors.js';
import { validateOperationInput, PORT_LOCAL_ERRORS } from '../pipeline.js';
import { renderMessage, projectValidationDetails, verdict } from '../http/wire.js';
import { createStreamConsumer } from '../stream/client.js';
import {
  prepareOutcomeRoute, assembleOutcome, makeMeta, failedOutcome, outcomeError, clientError,
} from '../client/outcome.js';
import { requestFrame, cancelFrame, subscribeFrame, unsubscribeFrame, isContractFrame, attach, isChannel } from './frame.js';

export { PORT_LOCAL_ERRORS };

/**
 * @typedef {import('../compile.js').Contract} Contract
 * @typedef {import('../compile.js').CompiledOperation} CompiledOperation
 * @typedef {import('../http/wire.js').Catalog} Catalog
 * @typedef {import('../client/outcome.js').Outcome} Outcome
 * @typedef {import('../client/outcome.js').OutcomeMeta} OutcomeMeta
 * @typedef {import('../client/outcome.js').OutcomeRoute} OutcomeRoute
 * @typedef {import('./frame.js').ChannelLike} ChannelLike
 */

/**
 * @typedef {Object} PortClientOptions
 * @property {ChannelLike} channel - the channel to talk over (required)
 * @property {number} [timeoutMs] - per request; default 15000; `0` disables
 * @property {Record<string, string | ((params: object) => string)>} [catalog]
 *   - a message catalog consulted before the English one
 * @property {Partial<import('@jarenjs/core/runtime').Runtime>} [runtime]
 *   - the host's runtime record: its `uuid` mints the client id every
 *   request id of this client is prefixed with; `crypto.randomUUID` by
 *   default
 */

/**
 * Per-call context of `invoke`.
 * @typedef {Object} PortInvokeContext
 * @property {AbortSignal} [signal] - resolves the outcome `cancelled` and posts a cancel frame
 * @property {unknown} [attempt] - the caller's attempt id, echoed in `meta.attempt`, never sent
 */

/**
 * The frozen capabilities table of the port client.
 * @typedef {Object} PortClientCapabilities
 * @property {'port'} name
 * @property {false} status
 * @property {false} headers
 * @property {false} media
 * @property {false} etag
 * @property {false} idempotency
 * @property {true} stream - `subscribe` carries push-frame streams (docs/CONTRACT-FORMAT.md §18.2)
 * @property {'message'} cancel
 */

/**
 * The options of one `subscribe` call (docs/CONTRACT-FORMAT.md §19).
 * There is no heartbeat on a port — delivery is in-process — so no
 * silence watchdog runs here.
 * @typedef {Object} PortSubscribeOptions
 * @property {(value: unknown, info: { seq: number, resumed: boolean, reset: boolean, earliestAvailable: number | null, highWatermark: number | null }) => void} [onSnapshot]
 * @property {(emission: { patch: unknown[], seq: number }) => void} [onPatch]
 * @property {(outcome: Outcome) => void} [onError]
 * @property {(info: { reason: string }) => void} [onEnd]
 * @property {AbortSignal} [signal] - stops the subscription silently
 * @property {number} [lastSeq] - the resume seq (what a re-entered subscribe passes)
 * @property {{ max: number }} [reconnect] - validated as on the HTTP client, then
 *   nothing: a channel has no network loss to reconnect from (a closed channel is
 *   `JC2074`, final), so the same options object serves both clients
 */

/**
 * The port client — the binding-agnostic client shape over a channel.
 * @typedef {Object} PortClient
 * @property {(op: string, input?: unknown, ctx?: PortInvokeContext) => Promise<Outcome>} invoke
 * @property {(op: string, input?: unknown, options?: PortSubscribeOptions) => { stop: () => void }} subscribe
 * @property {PortClientCapabilities} capabilities
 * @property {Contract} contract
 * @property {() => any} describe
 * @property {() => void} close
 */

/** The default answer window of one request, in ms. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * @param {string} code
 * @param {string} reason
 * @returns {ContractHostError}
 */
function host(code, reason) {
  return new ContractHostError(code, `openPortClient: ${reason}`);
}

/**
 * One operation as the client prepared it.
 * @typedef {Object} PortRoute
 * @property {CompiledOperation} op
 * @property {boolean} raw
 * @property {boolean} hasInput
 * @property {((value: unknown) => any) | null} validateInput
 * @property {'none' | 'paths' | 'full'} details
 * @property {OutcomeRoute} outcome
 */

/**
 * @param {CompiledOperation} op
 * @returns {PortRoute}
 */
function prepare(op) {
  return Object.freeze({
    op,
    raw: op.http.opaque,
    hasInput: op.input !== null,
    validateInput: op.input === null ? null : op.input.validate,
    details: op.policy.errors.details,
    outcome: prepareOutcomeRoute(op),
  });
}

/**
 * One pending request: what the listener needs to settle it.
 * @typedef {Object} Pending
 * @property {(outcome: Outcome) => void} resolve
 * @property {PortRoute} route
 * @property {OutcomeMeta} meta
 * @property {ReturnType<typeof setTimeout> | 0} timer
 * @property {() => void} cleanup - removes the abort listener
 */

/**
 * Open a port client over a compiled contract.
 *
 * @param {Contract} contract
 * @param {PortClientOptions} options
 * @returns {PortClient}
 * @throws {ContractHostError} `JC1008` for a malformed argument or option
 * @example
 * const worker = new Worker(new URL('./owner.js', import.meta.url), { type: 'module' });
 * const client = openPortClient(contract, { channel: worker });
 * const outcome = await client.invoke('data.rows', { collection: 'notes' });
 * if (outcome.ok) render(outcome.value);          // outcome.error.status is null on this binding
 */
export function openPortClient(contract, options) {
  if (contract === null || typeof contract !== 'object' || typeof contract.match !== 'function'
    || contract.operations === null || typeof contract.operations !== 'object' || !Array.isArray(contract.ids)) {
    throw host('JC1008', 'the first argument must be a compiled contract (compileContract)');
  }
  if (options === null || typeof options !== 'object') throw host('JC1008', 'options must be an object with the channel');
  const channel = options.channel;
  if (!isChannel(channel)) {
    throw host('JC1008', 'options.channel must expose postMessage and a message listener surface (a MessagePort, Worker, BroadcastChannel, or the shape)');
  }
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  if (typeof timeoutMs !== 'number' || !(timeoutMs >= 0) || !Number.isFinite(timeoutMs)) {
    throw host('JC1008', 'options.timeoutMs must be a non-negative finite number');
  }
  if (options.catalog !== undefined && (options.catalog === null || typeof options.catalog !== 'object')) {
    throw host('JC1008', 'options.catalog must be a message catalog object');
  }
  /** @type {Catalog | null} */
  const catalog = options.catalog === undefined ? null : compileMessageCatalog(options.catalog);

  /** @type {Map<string, PortRoute>} */
  const routes = new Map();
  for (let i = 0; i < contract.ids.length; i++) {
    const id = contract.ids[i];
    routes.set(id, prepare(contract.operations[id]));
  }

  const runtime = resolveHostRuntime(options.runtime, host, 'JC1008');
  // the record's generator is the host's; one that throws or answers no
  // string is the host's own mistake, refused where it was passed
  let clientId;
  try {
    clientId = runtime.uuid();
  }
  catch (error) {
    throw host('JC1008', `options.runtime: uuid() threw (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw host('JC1008', 'options.runtime: uuid() must answer a non-empty string, the client id every request is prefixed with');
  }
  const prefix = clientId + ':';
  let seq = 0;
  /** @type {Map<string, Pending>} */
  const pending = new Map();
  /** @type {Map<string, ReturnType<typeof createStreamConsumer>>} */
  const streams = new Map();
  let closed = false;

  /**
   * @param {PortRoute} route
   * @param {OutcomeMeta} meta
   * @returns {Outcome}
   */
  function cancelled(route, meta) {
    return failedOutcome('cancelled', clientError(catalog, 'JC2052', { op: route.op.id }, null, undefined), meta);
  }

  /**
   * A binding-code outcome (`JC2072`/`JC2073`/`JC2074`), rendered here.
   * @param {'network' | 'contract'} kind
   * @param {keyof typeof PORT_LOCAL_ERRORS} code
   * @param {Record<string, unknown>} params
   * @param {OutcomeMeta} meta
   * @returns {Outcome}
   */
  function bindingOutcome(kind, code, params, meta) {
    const row = PORT_LOCAL_ERRORS[code];
    return failedOutcome(kind, outcomeError(code, renderMessage(catalog, row.msgid, params), null, null, row.retryable), meta);
  }

  /**
   * Settle one pending entry: remove it first, so a second frame with
   * the same id — or a late one after cancel/timeout — finds nothing and
   * is dropped silently.
   * @param {string} id
   * @returns {Pending | undefined}
   */
  function take(id) {
    const entry = pending.get(id);
    if (entry === undefined) return undefined;
    pending.delete(id);
    if (entry.timer !== 0) clearTimeout(entry.timer);
    entry.cleanup();
    return entry;
  }

  /** @param {any} event */
  function listener(event) {
    const frame = event === null || typeof event !== 'object' ? undefined : event.data;
    if (!isContractFrame(frame)) return;
    const f = /** @type {any} */ (frame);
    // the cheap prefix test — before any map lookup, so a foreign id
    // (another client's response, any request) costs one string check
    if (typeof f.id !== 'string' || !f.id.startsWith(prefix)) return;
    // our own request frame, echoed by a loopback channel: not a response
    if (typeof f.op === 'string') return;
    // a push frame: one stream event for a subscription this client holds
    if (typeof f.event === 'string') {
      const consumer = streams.get(f.id);
      if (consumer === undefined) return;
      const at = typeof f.seq === 'number' && Number.isFinite(f.seq) ? f.seq : null;
      switch (f.event) {
        case 'snapshot':
          consumer.snapshot(at, f.data);
          break;
        case 'patch':
          consumer.patch(at, f.data);
          break;
        case 'error':
          consumer.error(f.data);
          break;
        case 'end':
          consumer.end(f.data);
          break;
        // an unknown event name is ignored — the wire's forward compatibility
      }
      return;
    }
    const entry = take(f.id);
    if (entry === undefined) return;
    const { route, meta } = entry;
    meta.trace = typeof f.trace === 'string' && f.trace.length > 0 ? f.trace : null;
    if (f.ok === true) {
      if (!Object.hasOwn(f, 'value')) {
        entry.resolve(bindingOutcome('contract', 'JC2073', { op: route.op.id }, meta));
        return;
      }
      entry.resolve(assembleOutcome(route.outcome, { status: null, headers: null, value: f.value }, meta, catalog));
      return;
    }
    if (f.ok !== false) {
      entry.resolve(bindingOutcome('contract', 'JC2073', { op: route.op.id }, meta));
      return;
    }
    const error = f.error;
    if (error === null || typeof error !== 'object' || typeof error.code !== 'string') {
      entry.resolve(bindingOutcome('contract', 'JC2073', { op: route.op.id }, meta));
      return;
    }
    // the serving host's own faults keep their code but classify as a
    // contract violation — a peer's host bug is not a declared failure
    if (error.code === 'JC2070' || error.code === 'JC2071') {
      const message = typeof error.message === 'string'
        ? error.message
        : renderMessage(catalog, PORT_LOCAL_ERRORS[/** @type {'JC2070' | 'JC2071'} */ (error.code)].msgid, { op: route.op.id });
      entry.resolve(failedOutcome('contract', outcomeError(error.code, message, null, error.details, false), meta));
      return;
    }
    entry.resolve(assembleOutcome(route.outcome, { status: null, headers: null, error }, meta, catalog));
  }

  const detach = attach(channel, listener);

  /**
   * @param {string} op
   * @param {unknown} [input]
   * @param {PortInvokeContext} [ctx]
   * @returns {Promise<Outcome>}
   */
  function invoke(op, input, ctx = {}) {
    const route = routes.get(op);
    if (route === undefined) {
      throw new ContractHostError('JC1005', `client: '${String(op)}' is not an operation of the contract`);
    }
    if (route.raw) {
      throw new ContractHostError('JC1005', `client: '${route.op.id}' is an opaque operation (media ${route.op.http.media}); the port binding carries JSON only (capabilities.media is false)`);
    }
    if (route.op.kind === 'subscribe') {
      throw new ContractHostError('JC1005', `client: '${route.op.id}' is a subscribe operation — a port carries it as a stream; use client.subscribe`);
    }
    if (ctx === null || typeof ctx !== 'object') throw host('JC1008', 'ctx must be an object');
    const meta = makeMeta(route.op.id, ctx.attempt, null);
    const signal = ctx.signal === undefined || ctx.signal === null ? null : ctx.signal;
    if ((signal !== null && signal.aborted) || closed) return Promise.resolve(cancelled(route, meta));

    // validate before anything is posted — the same verdict the server
    // will reach, and the pre-send refusal every client binding shares
    let value;
    if (!route.hasInput) {
      if (input !== undefined && input !== null) {
        return Promise.resolve(failedOutcome('contract',
          clientError(catalog, 'JC2050', { op: route.op.id }, null, [{ path: '', keyword: 'input' }]), meta));
      }
      value = null;
    }
    else {
      value = input === undefined || input === null ? {} : input;
      const invalid = validateOperationInput(route, value);
      if (invalid !== null && invalid.kind === 'contract') {
        return Promise.resolve(failedOutcome('contract',
          clientError(catalog, 'JC2050', { op: route.op.id }, null, invalid.details), meta));
      }
    }

    const id = prefix + (++seq);
    return new Promise((resolve) => {
      /** @type {() => void} */
      let cleanup = () => {};
      const onAbort = () => {
        const entry = take(id);
        if (entry === undefined) return;
        // tell the server to stop working — an optimization; the id
        // scoping already guarantees nothing late can settle here
        try {
          channel.postMessage(cancelFrame(id));
        }
        catch {
          // a channel that cannot carry the cancel changes nothing
        }
        resolve(cancelled(route, meta));
      };
      if (signal !== null) {
        signal.addEventListener('abort', onAbort, { once: true });
        cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      const timer = timeoutMs === 0 ? 0 : setTimeout(() => {
        const entry = pending.get(id);
        if (entry === undefined) return;
        pending.delete(id);
        entry.cleanup();
        resolve(bindingOutcome('network', 'JC2072', { op: route.op.id, ms: timeoutMs }, meta));
      }, timeoutMs);
      pending.set(id, { resolve, route, meta, timer, cleanup });
      try {
        channel.postMessage(requestFrame(id, route.op.id, value));
      }
      catch {
        const entry = take(id);
        if (entry !== undefined) resolve(bindingOutcome('network', 'JC2074', { op: route.op.id }, meta));
      }
    });
  }

  /**
   * Subscribe to a subscribe operation's stream (docs/CONTRACT-FORMAT.md
   * §19): one subscribe frame, the push frames delivered through the
   * callbacks; snapshots validated against the output schema, `seq`
   * strictly increasing (`JC2092`). `stop()` posts the unsubscribe
   * frame; there is no heartbeat on a port. Reconnection is the
   * caller's: pass the last delivered seq as `lastSeq`.
   * @param {string} op
   * @param {unknown} [input]
   * @param {PortSubscribeOptions} [options]
   * @returns {{ stop: () => void }}
   * @throws {ContractHostError} `JC1010` for a non-subscribe operation, `JC1008` for a malformed option
   */
  function subscribe(op, input, options = {}) {
    const route = routes.get(op);
    if (route === undefined) {
      throw new ContractHostError('JC1005', `client: '${String(op)}' is not an operation of the contract`);
    }
    if (route.op.kind !== 'subscribe') {
      throw new ContractHostError('JC1010', `client: '${route.op.id}' is a ${route.op.kind} operation — subscribe carries streams; use invoke`);
    }
    if (options === null || typeof options !== 'object') throw host('JC1008', 'subscribe options must be an object');
    for (const name of ['onSnapshot', 'onPatch', 'onError', 'onEnd']) {
      const cb = /** @type {any} */ (options)[name];
      if (cb !== undefined && typeof cb !== 'function') throw host('JC1008', `options.${name} must be a function`);
    }
    /** @type {number | null} */
    let lastSeq = null;
    if (options.lastSeq !== undefined && options.lastSeq !== null) {
      if (!Number.isInteger(options.lastSeq) || options.lastSeq < 0) throw host('JC1008', 'options.lastSeq must be a non-negative integer');
      lastSeq = options.lastSeq;
    }
    if (options.reconnect !== undefined && options.reconnect !== null) {
      const r = /** @type {any} */ (options.reconnect);
      if (typeof r !== 'object' || !Number.isInteger(r.max) || r.max < 0) {
        throw host('JC1008', 'options.reconnect must be { max } with a non-negative integer number of further attempts');
      }
    }
    const signal = options.signal === undefined || options.signal === null ? null : options.signal;
    const meta = makeMeta(route.op.id, null, null);
    const id = prefix + (++seq);

    /** @type {() => void} */
    let removeAbort = () => {};
    const consumer = createStreamConsumer({
      route: route.outcome,
      catalog,
      meta,
      callbacks: { onSnapshot: options.onSnapshot, onPatch: options.onPatch, onError: options.onError, onEnd: options.onEnd },
      finish: () => {
        streams.delete(id);
        removeAbort();
      },
      lastSeq,
    });

    const stop = () => {
      const held = streams.has(id);
      consumer.cancel();
      if (held) {
        try {
          channel.postMessage(unsubscribeFrame(id));
        }
        catch {
          // a channel that cannot carry the unsubscribe changes nothing
        }
      }
    };
    /** @type {Subscription} */
    const subscription = Object.freeze({
      stop,
      get lastSeq() {
        return consumer.lastSeq();
      },
    });

    if (closed || (signal !== null && signal.aborted)) {
      queueMicrotask(() => consumer.cancel());
      return subscription;
    }

    // validate before anything is posted — the shared pre-send refusal
    let value;
    let refusal = null;
    if (!route.hasInput) {
      if (input !== undefined && input !== null) refusal = [{ path: '', keyword: 'input' }];
      value = null;
    }
    else {
      value = input === undefined || input === null ? {} : input;
      const v = verdict(/** @type {(value: unknown) => any} */ (route.validateInput), value);
      if (!v.valid) refusal = projectValidationDetails(route.details, v.errors);
    }
    if (refusal !== null) {
      const outcome = failedOutcome('contract', clientError(catalog, 'JC2050', { op: route.op.id }, null, refusal), meta);
      queueMicrotask(() => consumer.fail(outcome));
      return subscription;
    }

    streams.set(id, consumer);
    if (signal !== null) {
      const onAbort = () => stop();
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbort = () => signal.removeEventListener('abort', onAbort);
    }
    try {
      channel.postMessage(subscribeFrame(id, route.op.id, value, lastSeq));
    }
    catch {
      const outcome = bindingOutcome('network', 'JC2074', { op: route.op.id }, meta);
      queueMicrotask(() => consumer.fail(outcome));
    }
    return subscription;
  }

  /** @type {PortClientCapabilities} */
  const capabilities = Object.freeze({
    name: 'port',
    status: false,
    headers: false,
    media: false,
    etag: false,
    idempotency: false,
    stream: true,
    cancel: 'message',
  });

  return Object.freeze({
    invoke,
    subscribe,
    capabilities,
    contract,
    describe: () => contract.describe(),
    close: () => {
      if (closed) return;
      closed = true;
      detach();
      const entries = [...pending.values()];
      pending.clear();
      for (const entry of entries) {
        if (entry.timer !== 0) clearTimeout(entry.timer);
        entry.cleanup();
        entry.resolve(cancelled(entry.route, entry.meta));
      }
      for (const consumer of [...streams.values()]) consumer.cancel();
      streams.clear();
    },
  });
}
