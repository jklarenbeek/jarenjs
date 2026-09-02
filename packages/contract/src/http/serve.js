//@ts-check
/**
 * @file `serveHttp(contract, handlers, options)`: the HTTP server binding
 * of a compiled contract — a driver in the `@jarenjs/db` sense: a
 * `name`, a frozen `capabilities` table that says what this binding
 * cannot carry (never a silent downgrade), and the one method a host
 * calls per request, `dispatch(request) → Promise<response>` over plain
 * request/response objects (docs/CONTRACT-FORMAT.md §7). The adapters
 * (`@jarenjs/contract/fetch`, `/node`) put that function behind the
 * platform's request and response types.
 *
 * Construction refuses host mistakes with thrown `ContractHostError`s
 * (`JC1001–JC1003`): a handler table that names no operation, a missing
 * handler on a non-partial server, a declared idempotency policy with no
 * ledger to carry it. Everything the pipeline reads per request is
 * decided here, once, into a `Route` per operation.
 */

import { compileMessageCatalog } from '@jarenjs/core/message';
import { resolveRuntime } from '@jarenjs/core/runtime';

import { ContractHostError } from '../errors.js';
import { dispatch } from './dispatch.js';
import { HTTP_ERRORS, WELL_KNOWN_PATH } from './wire.js';

export { HTTP_ERRORS, WELL_KNOWN_PATH };

/**
 * @typedef {import('./wire.js').HttpRequest} HttpRequest
 * @typedef {import('./wire.js').HttpResponse} HttpResponse
 * @typedef {import('./wire.js').WireErrorBody} WireErrorBody
 * @typedef {import('./dispatch.js').RequestContext} RequestContext
 * @typedef {import('./dispatch.js').Handler} Handler
 * @typedef {import('./dispatch.js').RawResponse} RawResponse
 * @typedef {import('./dispatch.js').Route} Route
 * @typedef {import('./dispatch.js').Server} Server
 * @typedef {import('../ledger.js').Ledger} Ledger
 * @typedef {import('../compile.js').Contract} Contract
 * @typedef {import('../compile.js').CompiledOperation} CompiledOperation
 */

/**
 * The options of `serveHttp`; every one has a default.
 * @typedef {Object} ServeHttpOptions
 * @property {() => string} [trace] - the server trace generator; default `crypto.randomUUID`
 * @property {Ledger | null} [ledger] - the idempotency ledger; `null` refuses
 *   (`JC1003`) any operation whose `policy.idempotency` is not `none`
 * @property {(ctx: RequestContext) => string} [scope] - the idempotency scope
 *   of a request (an installation, a principal — never a rotating token);
 *   default `''`; called before `ctx.idempotency` is set
 * @property {boolean} [partial] - allow missing handlers; a missing one answers 501 `JC2013`
 * @property {boolean} [head] - answer HEAD for GET operations by running the handler and dropping the body; default true
 * @property {'always' | 'never'} [validateOutput] - `'never'` is a declared downgrade, reported in `capabilities.validatedOutput`
 * @property {Record<string, import('./dispatch.js').TagResolver>} [preconditions]
 *   - operation id → the CURRENT entity-tag resolver, making `If-Match`/
 *   `If-None-Match` a PRE-handler decision for that operation: a stale
 *   precondition refuses `JC2014` with zero handler invocations, a
 *   matching `If-None-Match` read answers 304 without computing the
 *   representation (docs/CONTRACT-FORMAT.md §7.5); refused on a
 *   `subscribe` or opaque operation
 * @property {string | false} [wellKnown] - the path answering `describe()`; default `/.well-known/jaren-contract`; `false` disables
 * @property {(wire: WireErrorBody & { status: number }, ctx: RequestContext | null) => unknown} [errorBody]
 *   - projects the wire error record into the response body (a legacy
 *   shape, an extra `error` string); a throw or a non-JSON result falls
 *   back to the D7 shape
 * @property {(error: unknown, ctx: RequestContext | null) => void} [onError]
 *   - observes `JC2008`/`JC2010` causes and ledger faults; the response never carries them
 * @property {Record<string, string | ((params: object) => string)>} [catalog]
 *   - a message catalog (templates or compiled renderers) consulted before the English one
 * @property {() => number} [now] - the clock stamped into ledger claims; default `Date.now`
 * @property {Partial<import('@jarenjs/core/runtime').Runtime>} [runtime]
 *   - the host's runtime record: its `uuid` generates the server trace
 *   and its `now` is the clock, each only where `trace` / `now` is absent
 */

/**
 * The frozen capabilities table of the http binding.
 * @typedef {Object} HttpCapabilities
 * @property {'http'} name
 * @property {true} status - statuses are carried
 * @property {true} headers - headers are carried
 * @property {true} media - non-JSON media is carried (opaque operations)
 * @property {boolean} head - HEAD is answered for GET operations
 * @property {true} etag - entity tags and conditionals are honored
 * @property {boolean} idempotency - a ledger is present
 * @property {boolean} validatedOutput - the output validator runs
 * @property {true} stream - subscribe operations stream as SSE (docs/CONTRACT-FORMAT.md §18.1)
 * @property {'signal'} cancel - cancellation reaches the handler as `ctx.signal`
 */

/**
 * The server binding.
 * @typedef {Object} HttpDispatcher
 * @property {(request: HttpRequest) => Promise<HttpResponse>} dispatch
 * @property {HttpCapabilities} capabilities
 * @property {Contract} contract
 * @property {() => any} describe
 * @property {() => void} close - ends every live SSE stream with an `end`
 *   event (`server-shutdown`) and releases its subscription; requests in
 *   flight are unaffected
 */

/**
 * @param {string} code
 * @param {string} reason
 * @returns {ContractHostError}
 */
function host(code, reason) {
  return new ContractHostError(code, `serveHttp: ${reason}`);
}

/**
 * The header name of a header-located member: its name, lowercased.
 * @param {string} member
 * @returns {string}
 */
function headerNameOf(member) {
  return member.toLowerCase();
}

/**
 * Prepare one operation for the pipeline.
 * @param {CompiledOperation} op
 * @param {Handler | null} handler
 * @param {import('./dispatch.js').TagResolver | null} tag
 * @returns {Route}
 */
function prepare(op, handler, tag) {
  const http = op.http;
  const input = op.input;
  const transport = input === null ? null : input.transport;
  /** @type {string[]} */
  const pathMembers = [];
  /** @type {Set<string>} */
  const queryMembers = new Set();
  /** @type {Set<string>} */
  const repeated = new Set();
  /** @type {string[]} */
  const headerMembers = [];
  /** @type {string[]} */
  const headerNames = [];
  /** @type {boolean[]} */
  const headerArray = [];
  /** @type {Set<string>} */
  const nonBody = new Set();
  let hasBody = http.body !== null;
  if (transport !== null) {
    for (let i = 0; i < transport.members.path.length; i++) pathMembers.push(transport.members.path[i]);
    for (let i = 0; i < transport.members.query.length; i++) queryMembers.add(transport.members.query[i]);
    for (let i = 0; i < transport.members.header.length; i++) {
      const m = transport.members.header[i];
      headerMembers.push(m);
      headerNames.push(headerNameOf(m));
      headerArray.push(transport.members.repeated.includes(m));
    }
    for (let i = 0; i < transport.members.repeated.length; i++) {
      const m = transport.members.repeated[i];
      if (queryMembers.has(m)) repeated.add(m);
    }
  }
  const members = Object.keys(http.in);
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    if (http.in[m] === 'body') hasBody = true;
    else nonBody.add(m);
  }
  const retryOn = new Set(op.policy.retry === null ? [] : op.policy.retry.on);
  return Object.freeze({
    op,
    handler,
    tag,
    raw: http.opaque,
    stream: op.kind === 'subscribe',
    maxBody: op.policy.limits.maxBodyBytes,
    media: http.media,
    hasBody,
    wholeBody: http.body,
    nonBody,
    pathMembers,
    queryMembers,
    repeated,
    headerMembers,
    headerNames,
    headerArray,
    normalize: transport === null ? null : transport.normalize,
    validateInput: input === null ? null : input.validate,
    validateOutput: op.output.validate,
    details: op.policy.errors.details,
    idempotency: op.policy.idempotency,
    retryOn,
    errors: op.errors,
    status: http.status,
  });
}

/**
 * Serve a compiled contract over HTTP: a dispatcher whose `dispatch`
 * routes, decodes, normalizes, validates, calls the handler, validates
 * the output, applies idempotency and entity-tag policy and answers with
 * the declared statuses and the D7 error body — a pure function over
 * plain request/response objects. Refuses host mistakes at construction
 * (`JC1001` handler table, `JC1002` missing handler, `JC1003` idempotency
 * without a ledger).
 *
 * @param {Contract} contract
 * @param {Record<string, Handler>} handlers - operation id → handler
 * @param {ServeHttpOptions} [options]
 * @returns {HttpDispatcher}
 * @example
 * const server = serveHttp(contract, {
 *   'catalog.load': async (input, ctx) => { ctx.etag('r42'); return catalog; },
 *   'product.save': (input, ctx) => saved ? product : ctx.fail('conflict', {}, { current }),
 * }, { ledger: createMemoryLedger() });
 * const response = await server.dispatch({ method: 'GET', url: '/api/catalog', headers: {}, body: null });
 */
export function serveHttp(contract, handlers, options = {}) {
  if (contract === null || typeof contract !== 'object' || typeof contract.match !== 'function'
    || contract.operations === null || typeof contract.operations !== 'object') {
    throw host('JC1001', 'the first argument must be a compiled contract (compileContract)');
  }
  if (handlers === null || typeof handlers !== 'object' || Array.isArray(handlers)) {
    throw host('JC1001', 'handlers must be an object of operation id → function');
  }
  const partial = options.partial === true;
  const ledger = options.ledger === undefined ? null : options.ledger;
  if (ledger !== null && (typeof ledger !== 'object' || typeof ledger.claim !== 'function'
    || typeof ledger.commit !== 'function' || typeof ledger.fail !== 'function' || typeof ledger.lookup !== 'function')) {
    throw host('JC1001', 'options.ledger must implement { claim, commit, fail, lookup }');
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
  const preconditions = options.preconditions === undefined ? null : options.preconditions;
  if (preconditions !== null && (typeof preconditions !== 'object' || Array.isArray(preconditions))) {
    throw host('JC1001', 'options.preconditions must be an object of operation id → tag resolver');
  }
  if (preconditions !== null) {
    const ids = Object.keys(preconditions);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!Object.hasOwn(contract.operations, id)) {
        throw host('JC1001', `preconditions names '${id}', which is not an operation of the contract`);
      }
      if (typeof preconditions[id] !== 'function') {
        throw host('JC1001', `the tag resolver of '${id}' must be a function, got ${typeof preconditions[id]}`);
      }
      const op = contract.operations[id];
      if (op.kind === 'subscribe') {
        throw host('JC1001', `operation '${id}' is a subscribe — a stream has no single representation for a precondition to guard`);
      }
      if (op.http.opaque) {
        throw host('JC1001', `operation '${id}' is opaque — its raw handler owns the bytes and the headers; preconditions cannot apply`);
      }
    }
  }
  /** @type {Map<string, Route>} */
  const routes = new Map();
  for (let i = 0; i < contract.ids.length; i++) {
    const id = contract.ids[i];
    const op = contract.operations[id];
    const handler = Object.hasOwn(handlers, id) ? handlers[id] : null;
    if (handler === null && !partial) {
      throw host('JC1002', `operation '${id}' has no handler (pass { partial: true } to answer 501 for it)`);
    }
    if (op.policy.idempotency !== 'none' && ledger === null) {
      throw host('JC1003', `operation '${id}' declares policy.idempotency '${op.policy.idempotency}' and no ledger was given — this binding cannot carry idempotency without one`);
    }
    routes.set(id, prepare(op, handler, preconditions !== null && Object.hasOwn(preconditions, id) ? preconditions[id] : null));
  }

  const validateOutput = options.validateOutput === undefined ? 'always' : options.validateOutput;
  if (validateOutput !== 'always' && validateOutput !== 'never') {
    throw host('JC1001', "options.validateOutput must be 'always' or 'never'");
  }
  const head = options.head === undefined ? true : options.head === true;
  const wellKnown = options.wellKnown === undefined ? WELL_KNOWN_PATH : options.wellKnown;
  if (wellKnown !== false && (typeof wellKnown !== 'string' || wellKnown.charCodeAt(0) !== 0x2F)) {
    throw host('JC1001', 'options.wellKnown must be an absolute path or false');
  }
  for (const [name, value] of [['trace', options.trace], ['scope', options.scope], ['errorBody', options.errorBody],
    ['onError', options.onError], ['now', options.now]]) {
    if (value !== undefined && typeof value !== 'function') throw host('JC1001', `options.${name} must be a function`);
  }
  if (options.catalog !== undefined && (options.catalog === null || typeof options.catalog !== 'object')) {
    throw host('JC1001', 'options.catalog must be a message catalog object');
  }
  let runtime;
  try {
    runtime = resolveRuntime(options.runtime);
  }
  catch (error) {
    throw host('JC1001', `options.runtime: ${error instanceof Error ? error.message : String(error)}`);
  }

  /** @type {Server} */
  const server = {
    contract,
    routes,
    trace: options.trace === undefined ? runtime.uuid : options.trace,
    ledger,
    scope: options.scope === undefined ? () => '' : options.scope,
    head,
    validateOutput: validateOutput === 'always',
    wellKnown,
    errorBody: options.errorBody === undefined ? null : options.errorBody,
    onError: options.onError === undefined ? null : options.onError,
    catalog: options.catalog === undefined ? null : compileMessageCatalog(options.catalog),
    now: options.now === undefined ? runtime.now : options.now,
    described: { text: null },
    streams: new Set(),
  };

  /** @type {HttpCapabilities} */
  const capabilities = Object.freeze({
    name: 'http',
    status: true,
    headers: true,
    media: true,
    head,
    etag: true,
    idempotency: ledger !== null,
    validatedOutput: server.validateOutput,
    stream: true,
    cancel: 'signal',
  });

  return Object.freeze({
    dispatch: (request) => dispatch(server, request),
    capabilities,
    contract,
    describe: () => contract.describe(),
    close: () => {
      // each stopper removes itself from the set as it ends
      for (const stop of [...server.streams]) stop('server-shutdown');
    },
  });
}
