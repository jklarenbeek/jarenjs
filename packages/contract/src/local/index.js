//@ts-check
/**
 * @file `openLocalClient(contract, handlers, options)`: the in-process
 * binding of a compiled contract (docs/CONTRACT-FORMAT.md §15) — the
 * same operation pipeline the HTTP server runs, with no wire: the test
 * seam, SSR, a CLI. The client and the server are one object;
 * `serveLocal` is the same factory under the serve name, for symmetry
 * with the other bindings.
 *
 * `invoke(op, input, ctx)` validates the input with the operation's
 * compiled validator (a refusal is the `JC2050` outcome — nothing ran),
 * runs the neutral pipeline against the handler with a frozen context
 * `{ op, trace, signal, params: null, headers: {}, fail, idempotency:
 * null }`, and resolves a D6 outcome: a declared failure is `kind:
 * "failure"` with `status: null` (the member present, never omitted —
 * this binding carries no statuses and `capabilities` says so); a
 * handler fault of any class — a throw, an undeclared code, a broken
 * output or error-details schema — is `kind: "contract"` `JC2070`, its
 * cause reported to `onError`, so a host bug is never mistaken for a
 * declared failure; an aborted `ctx.signal` (or `close()`) is `kind:
 * "cancelled"`, and a handler still running then settles into nothing.
 *
 * What this binding cannot carry, it refuses or ignores loudly:
 * statuses, headers, entity tags and non-JSON media do not exist here
 * (`invoke` of an opaque operation throws `JC1005`; a handler given for
 * one is accepted so an HTTP handler table can be reused verbatim, and
 * never called); a declared `policy.idempotency` is ALLOWED and ignored
 * — the same contract must serve over http and locally, and re-running
 * a command in one process is the caller's own hand — with
 * `capabilities.idempotency: false` saying so.
 */

import { compileMessageCatalog } from '@jarenjs/core/message';

import { ContractHostError, ContractFailure } from '../errors.js';
import { validateOperationInput, settleOperation, safeTrace, PORT_LOCAL_ERRORS } from '../pipeline.js';
import { renderMessage, declaredMessage } from '../http/wire.js';
import {
  prepareOutcomeRoute, assembleOutcome, makeMeta, failedOutcome, outcomeError, clientError,
} from '../client/outcome.js';

export { PORT_LOCAL_ERRORS };

/**
 * @typedef {import('../compile.js').Contract} Contract
 * @typedef {import('../compile.js').CompiledOperation} CompiledOperation
 * @typedef {import('../http/wire.js').Catalog} Catalog
 * @typedef {import('../http/dispatch.js').Handler} Handler
 * @typedef {import('../client/outcome.js').Outcome} Outcome
 * @typedef {import('../client/outcome.js').OutcomeMeta} OutcomeMeta
 * @typedef {import('../pipeline.js').PipelineRoute} PipelineRoute
 */

/**
 * @typedef {Object} LocalOptions
 * @property {() => string} [trace] - the trace generator; default `crypto.randomUUID`
 * @property {'always' | 'never'} [validateOutput] - `'never'` is a declared
 *   downgrade, reported in `capabilities.validatedOutput`
 * @property {Record<string, string | ((params: object) => string)>} [catalog]
 *   - a message catalog consulted before the English one
 * @property {(error: unknown, ctx: { op: string, trace: string } | null) => void} [onError]
 *   - observes the cause behind every `JC2070` outcome and validator throw
 */

/**
 * Per-call context of `invoke` — the client half's, not the handler's.
 * @typedef {Object} LocalInvokeContext
 * @property {AbortSignal} [signal] - resolves the outcome `cancelled`
 * @property {unknown} [attempt] - the caller's attempt id, echoed in `meta.attempt`
 */

/**
 * The frozen capabilities table of the local binding: no wire, so no
 * statuses, headers, media, entity tags or idempotency carriage — a
 * contract declaring them still serves (the declarations describe its
 * HTTP life), and this table is how a consumer knows they are inert here.
 * @typedef {Object} LocalCapabilities
 * @property {'local'} name
 * @property {false} status
 * @property {false} headers
 * @property {false} media
 * @property {false} etag
 * @property {false} idempotency
 * @property {boolean} validatedOutput - the output validator runs
 * @property {false} stream
 * @property {'signal'} cancel
 */

/**
 * The local client — client and server in one object.
 * @typedef {Object} LocalClient
 * @property {(op: string, input?: unknown, ctx?: LocalInvokeContext) => Promise<Outcome>} invoke
 * @property {LocalCapabilities} capabilities
 * @property {Contract} contract
 * @property {() => any} describe
 * @property {() => void} close - later invokes resolve `cancelled`; running handlers see their signal abort
 */

/** The frozen empty header table every local handler context carries. */
const NO_HEADERS = Object.freeze({});

/** The sentinel `race` resolves when the signal wins. */
const ABORTED = Symbol('aborted');

/**
 * @param {string} code
 * @param {string} reason
 * @returns {ContractHostError}
 */
function host(code, reason) {
  return new ContractHostError(code, `serveLocal: ${reason}`);
}

/**
 * One operation as this binding prepared it: the pipeline's subset plus
 * the outcome assembly. The outcome route's output validator is a
 * pass-through — the pipeline already validated (or the host declared
 * `validateOutput: 'never'`), and one validation per invoke is the point
 * of having no wire.
 * @typedef {PipelineRoute & { hasInput: boolean, outcome: import('../client/outcome.js').OutcomeRoute }} LocalRoute
 */

/**
 * @param {CompiledOperation} op
 * @param {Handler | null} handler
 * @returns {LocalRoute}
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
    hasInput: op.input !== null,
    outcome: Object.freeze({ ...prepareOutcomeRoute(op), validateOutput: () => true }),
  });
}

/**
 * Race the pipeline's settlement against the abort signal: the first
 * one wins, and a handler that settles after the abort settles into
 * nothing (the state-side id guard is the caller's guarantee; this is
 * the honest local reading of "the request was cancelled").
 * @param {Promise<import('../pipeline.js').OperationResult>} settled
 * @param {AbortSignal} signal
 * @returns {Promise<import('../pipeline.js').OperationResult | typeof ABORTED>}
 */
function race(settled, signal) {
  return new Promise((resolve) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    settled.then((result) => {
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    });
  });
}

/**
 * Serve a compiled contract in-process and call it through the same
 * object: the `open(contract) → Client` half and the `serve(contract,
 * handlers)` half of the driver pair are one here. Construction refuses
 * host mistakes (`JC1001` handler table or option, `JC1002` missing
 * handler — an opaque operation is exempt: this binding cannot invoke
 * it, and an HTTP handler table that carries one may be reused verbatim).
 *
 * @param {Contract} contract
 * @param {Record<string, Handler>} handlers - operation id → handler
 * @param {LocalOptions} [options]
 * @returns {LocalClient}
 * @throws {ContractHostError}
 * @example
 * const client = openLocalClient(contract, {
 *   'catalog.load': () => catalog,
 *   'product.save': (input, ctx) => saved ? product : ctx.fail('conflict', {}, { current }),
 * });
 * const outcome = await client.invoke('catalog.load', { since: '2026-01-01T00:00:00Z' });
 * if (!outcome.ok && outcome.kind === 'failure') show(outcome.error.code);   // status is null here
 */
export function openLocalClient(contract, handlers, options = {}) {
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
  if (options === null || typeof options !== 'object') throw host('JC1001', 'options must be an object');
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
  const trace = options.trace === undefined ? () => globalThis.crypto.randomUUID() : options.trace;
  const onError = options.onError === undefined ? null : options.onError;
  /** @type {Catalog | null} */
  const catalog = options.catalog === undefined ? null : compileMessageCatalog(options.catalog);
  const validate = validateOutput === 'always';

  /** @type {Map<string, LocalRoute>} */
  const routes = new Map();
  for (let i = 0; i < contract.ids.length; i++) {
    const id = contract.ids[i];
    const op = contract.operations[id];
    const handler = Object.hasOwn(handlers, id) ? handlers[id] : null;
    // an opaque operation cannot be invoked here, and a subscribe
    // operation cannot be streamed here (capabilities.stream is false) —
    // neither demands a handler, so an HTTP handler table reuses verbatim
    if (handler === null && !op.http.opaque && op.kind !== 'subscribe') {
      throw host('JC1002', `operation '${id}' has no handler`);
    }
    routes.set(id, prepare(op, handler));
  }

  const closer = new AbortController();
  let closed = false;

  /**
   * Report a fault to the host observer. TOTAL.
   * @param {unknown} error
   * @param {{ op: string, trace: string } | null} ctx
   */
  function observe(error, ctx) {
    if (onError === null) return;
    try {
      onError(error, ctx);
    }
    catch {
      // an observer that throws never reaches the outcome
    }
  }

  /**
   * @param {LocalRoute} route
   * @param {OutcomeMeta} meta
   * @returns {Outcome}
   */
  function cancelled(route, meta) {
    return failedOutcome('cancelled', clientError(catalog, 'JC2052', { op: route.outcome.id }, null, undefined), meta);
  }

  /**
   * @param {string} op
   * @param {unknown} [input]
   * @param {LocalInvokeContext} [ctx]
   * @returns {Promise<Outcome>}
   */
  async function invoke(op, input, ctx = {}) {
    const route = routes.get(op);
    if (route === undefined) {
      throw new ContractHostError('JC1005', `client: '${String(op)}' is not an operation of the contract`);
    }
    if (route.raw) {
      throw new ContractHostError('JC1005', `client: '${route.outcome.id}' is an opaque operation (media ${route.op.http.media}); the local binding carries JSON only (capabilities.media is false)`);
    }
    if (route.op.kind === 'subscribe') {
      throw new ContractHostError('JC1005', `client: '${route.outcome.id}' is a subscribe operation; the local binding cannot carry a stream (capabilities.stream is false)`);
    }
    if (ctx === null || typeof ctx !== 'object') throw host('JC1001', 'ctx must be an object');
    const meta = makeMeta(route.outcome.id, ctx.attempt, null);
    const caller = ctx.signal === undefined || ctx.signal === null ? null : ctx.signal;
    if ((caller !== null && caller.aborted) || closed) return cancelled(route, meta);

    // 1. validate — the same verdict the pipeline would reach, once
    let value;
    if (!route.hasInput) {
      if (input !== undefined && input !== null) {
        return failedOutcome('contract', clientError(catalog, 'JC2050', { op: route.outcome.id }, null,
          [{ path: '', keyword: 'input' }]), meta);
      }
      value = null;
    }
    else {
      value = input === undefined || input === null ? {} : input;
      const invalid = validateOperationInput(route, value);
      if (invalid !== null && invalid.kind === 'contract') {
        if (invalid.cause !== undefined) observe(invalid.cause, null);
        return failedOutcome('contract', clientError(catalog, 'JC2050', { op: route.outcome.id }, null, invalid.details), meta);
      }
    }

    // 2. run the neutral pipeline under the composed signal
    const signal = caller === null ? closer.signal : AbortSignal.any([closer.signal, caller]);
    const id = safeTrace(trace);
    meta.trace = id;
    const handlerCtx = Object.freeze({
      op: route.op, trace: id, signal, params: null, headers: NO_HEADERS,
      fail: ContractFailure, idempotency: null,
    });
    const result = await race(settleOperation(route, value, handlerCtx, validate), signal);
    if (result === ABORTED) return cancelled(route, meta);

    // 3. assemble the D6 outcome
    if (result.kind === 'contract') {
      if (result.cause !== undefined) observe(result.cause, { op: route.outcome.id, trace: id });
      return failedOutcome('contract', outcomeError('JC2070',
        renderMessage(catalog, PORT_LOCAL_ERRORS.JC2070.msgid, { op: route.outcome.id }), null, null, false), meta);
    }
    if (result.kind === 'failure') {
      return assembleOutcome(route.outcome, {
        status: null,
        headers: null,
        error: {
          code: result.code,
          message: declaredMessage(catalog, route.outcome.id, result.code, result.params),
          details: result.details,
          retryable: result.retryable,
        },
      }, meta, catalog);
    }
    return assembleOutcome(route.outcome, { status: null, headers: null, value: result.value }, meta, catalog);
  }

  /** @type {LocalCapabilities} */
  const capabilities = Object.freeze({
    name: 'local',
    status: false,
    headers: false,
    media: false,
    etag: false,
    idempotency: false,
    validatedOutput: validate,
    stream: false,
    cancel: 'signal',
  });

  return Object.freeze({
    invoke,
    capabilities,
    contract,
    describe: () => contract.describe(),
    close: () => {
      closed = true;
      closer.abort();
    },
  });
}

/**
 * The serve name of the same factory: the server half IS the client half
 * here — one object, both names, for symmetry with `serveHttp`/
 * `openHttpClient` and `servePort`/`openPortClient`.
 */
export const serveLocal = openLocalClient;
