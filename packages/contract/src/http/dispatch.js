//@ts-check
/**
 * @file The request pipeline of the HTTP server binding: one plain
 * request object in, one plain response object out — route, decode,
 * assemble, normalize, validate, claim idempotency, decide a declared
 * precondition (the `preconditions` option: `If-Match`/`If-None-Match`
 * against the resolver's CURRENT tag, before the handler), call the
 * handler through one uniform promise boundary, validate the output,
 * apply the post-handler entity-tag conditionals, serialize, commit. Every failure a request
 * can cause is a coded response (docs/CONTRACT-FORMAT.md §7); the
 * function rejects only for a malformed request OBJECT (`JC1004`, an
 * adapter author's mistake) — never for request content and never for
 * what a handler returns or throws (the `tasks.js` posture: a hostile
 * value settles into `JC2008`/`JC2010`, it does not escape).
 *
 * The trust boundary: the contract, the handlers and the ledger are the
 * host's; the request is hostile. Only declared header members and the
 * protocol headers the binding itself needs are read; the input object
 * is assembled through `setObjectMember` from declared names only; a
 * body member that names a path/query/header member is ignored; nothing
 * a request sent is echoed into a message.
 */

import { isJsonObject, setObjectMember } from '@jarenjs/core/object';
import { toPromise, isThenable } from '@jarenjs/core/function';
import { canonicalSha256, JsonCanonicalizeError } from '@jarenjs/json/canonical';

import { ContractHostError, ContractFailure } from '../errors.js';
import { validateOperationInput, settleOperation, safeTrace } from '../pipeline.js';
import {
  isSubscriptionLike, runSubscription, STREAM_ERRORS, STREAM_MEDIA, HEARTBEAT_LINE, encodeStreamEvent,
} from '../stream/server.js';
import {
  HTTP_ERRORS, JSON_CONTENT_TYPE, JSON_MEDIA,
  renderMessage, declaredMessage, headerValue, contentLength, mediaMatches, exceedsBytes,
  entityTagMatches, formatEntityTag, decodeQuery, projectValidationDetails, errorResponse, verdict,
} from './wire.js';

/**
 * @typedef {import('./wire.js').HttpRequest} HttpRequest
 * @typedef {import('./wire.js').HttpResponse} HttpResponse
 * @typedef {import('./wire.js').Catalog} Catalog
 * @typedef {import('../compile.js').CompiledOperation} CompiledOperation
 * @typedef {import('../compile.js').CompiledErrorDecl} CompiledErrorDecl
 * @typedef {import('../errors.js').ContractFailureValue} ContractFailureValue
 * @typedef {import('../pipeline.js').OperationResult} OperationResult
 * @typedef {import('../ledger.js').Ledger} Ledger
 */

/**
 * The per-request context a handler receives — frozen. `params` are the
 * raw decoded path strings; `headers` carries the declared header members
 * (by header name) plus `if-match`/`if-none-match` when present; `body`
 * is the raw request body for an OPAQUE operation and `null` for a JSON
 * one (whose body was decoded into the input). `fail` makes a declared
 * failure by code; `etag` arms the entity-tag path; `status` overrides
 * the success status (2xx only — `JC1006` otherwise, a host error the
 * handler boundary settles into `JC2008` and reports through `onError`).
 * @typedef {Object} RequestContext
 * @property {CompiledOperation} op
 * @property {string} trace
 * @property {string} method
 * @property {string} path
 * @property {Readonly<Record<string, string>>} params
 * @property {Readonly<Record<string, string>>} headers
 * @property {string | Uint8Array | null} body
 * @property {AbortSignal | null} signal
 * @property {Readonly<{ key: string, scope: string }> | null} idempotency
 * @property {(code: string, params?: Record<string, unknown>, details?: unknown, options?: { retryable?: boolean }) => ContractFailureValue} fail
 * @property {(tag: string, options?: { strong?: boolean }) => void} etag
 * @property {(status: number) => void} status
 */

/**
 * A handler of a JSON operation: the reassembled, validated input (or
 * `null` when the operation declares none) and the context; returns the
 * output value, a promise of it, or a declared failure. An opaque
 * operation's handler is raw: it returns `{ status, headers?, body? }`
 * and reads the bytes from `ctx.body`; its `input` is the decoded,
 * validated transport members — they are always its whole input, since
 * the compiler refuses a body-located member on an opaque operation
 * (`JC0017`).
 * @typedef {(input: any, ctx: RequestContext) => unknown} Handler
 */

/**
 * The raw response of an opaque operation's handler.
 * @typedef {{ status: number, headers?: Record<string, string>, body?: string | Uint8Array | null }} RawResponse
 */

/**
 * The CURRENT entity-tag resolver of the `preconditions` option
 * (docs/CONTRACT-FORMAT.md §7.5): called with the operation's validated
 * input and the frozen context BEFORE the handler, it answers the tag of
 * the current representation — a plain string is a STRONG tag (the
 * asymmetry with `ctx.etag`, whose bare form is weak, is deliberate:
 * `If-Match` needs strong comparison to mean anything), `{ tag, strong }`
 * spells it out, `null` means "no current representation" (`If-Match`,
 * `*` included, fails on it; `If-None-Match`, `*` included, passes — the
 * create-guard). A throw, a rejection or any other shape is the host's
 * fault (`JC2008`).
 * @typedef {(input: any, ctx: RequestContext) => string | { tag: string, strong?: boolean } | null | Promise<string | { tag: string, strong?: boolean } | null>} TagResolver
 */

/**
 * One operation as `serveHttp` prepared it: everything the pipeline
 * reads per request, decided once.
 * @typedef {Object} Route
 * @property {CompiledOperation} op
 * @property {Handler | null} handler - `null` on a partial server
 * @property {TagResolver | null} tag - the pre-handler resolver of the
 *   `preconditions` option; `null` = conditionals stay post-handler
 * @property {boolean} raw - opaque: the handler is raw
 * @property {boolean} stream - a subscribe operation: the handler answers a subscription
 * @property {number} maxBody
 * @property {string} media
 * @property {boolean} hasBody - any body-located member, or a whole-body member
 * @property {string | null} wholeBody
 * @property {ReadonlySet<string>} nonBody - path/query/header member names, never taken from the body
 * @property {readonly string[]} pathMembers
 * @property {ReadonlySet<string>} queryMembers
 * @property {ReadonlySet<string>} repeated - array-typed query members
 * @property {readonly string[]} headerMembers - member names
 * @property {readonly string[]} headerNames - the lowercase header of each
 * @property {readonly boolean[]} headerArray - array-typed, per header member
 * @property {((value: any) => any) | null} normalize
 * @property {((value: unknown) => any) | null} validateInput
 * @property {(value: unknown) => any} validateOutput
 * @property {'none' | 'paths' | 'full'} details
 * @property {'none' | 'optional' | 'required'} idempotency
 * @property {ReadonlySet<string>} retryOn
 * @property {Readonly<Record<string, CompiledErrorDecl>>} errors
 * @property {number} status
 */

/**
 * The server as `serveHttp` built it — the pipeline's configuration.
 * @typedef {Object} Server
 * @property {import('../compile.js').Contract} contract
 * @property {ReadonlyMap<string, Route>} routes
 * @property {() => string} trace
 * @property {Ledger | null} ledger
 * @property {(ctx: RequestContext) => string} scope
 * @property {boolean} head
 * @property {boolean} validateOutput
 * @property {string | false} wellKnown
 * @property {((wire: any, ctx: RequestContext | null) => unknown) | null} errorBody
 * @property {((error: unknown, ctx: RequestContext | null) => void) | null} onError
 * @property {Catalog | null} catalog
 * @property {() => number} now
 * @property {{ text: string | null }} described - the memoized well-known body
 * @property {Set<(reason: string | null) => void>} streams - the live SSE
 *   streams' stoppers; the dispatcher's `close()` ends them all
 */

/** The strict decoder of a JSON body given as bytes. */
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The frozen empty header table of a request without declared headers. */
const NO_HEADERS = Object.freeze({});

/** The valid shape of a request object — `JC1004` otherwise. */
const REQUEST_SHAPE = 'a request is { method: string, url: string, headers: object, body: string | Uint8Array | null }';

//#region the boundary

/**
 * The one entry point. Validates the request object (a malformed one is
 * `JC1004`, rejected — the adapter's mistake), then runs the pipeline and
 * lifts its result into a promise. Total for request content: every
 * request-caused failure resolves to a response.
 * @param {Server} server
 * @param {HttpRequest} request
 * @returns {Promise<HttpResponse>}
 */
export function dispatch(server, request) {
  const shapeError = requestShapeError(request);
  if (shapeError !== null) return Promise.reject(shapeError);
  let result;
  try {
    result = run(server, request);
  }
  catch (err) {
    return Promise.resolve(lastResort(server, err));
  }
  // every request-caused failure has already become a response; what
  // reaches this catch is a defect of the binding itself, and even that
  // must not surface as a rejection on a server
  return toPromise(result).then(undefined, (err) => lastResort(server, err));
}

/**
 * The binding's own defect as a `JC2008` with a fresh trace — reported to
 * the host observer, never a rejection.
 * @param {Server} server
 * @param {unknown} err
 * @returns {HttpResponse}
 */
function lastResort(server, err) {
  observe(server, err, null);
  return refuse(server, 'JC2008', makeTrace(server), { op: '' }, undefined, null, null);
}

/**
 * @param {unknown} request
 * @returns {ContractHostError | null}
 */
function requestShapeError(request) {
  if (request === null || typeof request !== 'object') {
    return new ContractHostError('JC1004', `dispatch: ${REQUEST_SHAPE}; got ${request === null ? 'null' : typeof request}`);
  }
  const r = /** @type {any} */ (request);
  if (typeof r.method !== 'string') return new ContractHostError('JC1004', `dispatch: request.method must be a string; ${REQUEST_SHAPE}`);
  if (typeof r.url !== 'string') return new ContractHostError('JC1004', `dispatch: request.url must be a string; ${REQUEST_SHAPE}`);
  if (r.headers === null || typeof r.headers !== 'object') {
    return new ContractHostError('JC1004', `dispatch: request.headers must be an object of lowercase names; ${REQUEST_SHAPE}`);
  }
  if (!(r.body === null || r.body === undefined || typeof r.body === 'string' || r.body instanceof Uint8Array)) {
    return new ContractHostError('JC1004', `dispatch: request.body must be a string, a Uint8Array or null; ${REQUEST_SHAPE}`);
  }
  return null;
}

//#endregion

//#region helpers

/**
 * A server trace id.
 * @param {Server} server
 * @returns {string}
 */
function makeTrace(server) {
  return safeTrace(server.trace);
}

/**
 * Report a server-side fault to the host observer. TOTAL.
 * @param {Server} server
 * @param {unknown} error
 * @param {RequestContext | null} ctx
 */
function observe(server, error, ctx) {
  if (server.onError === null) return;
  try {
    server.onError(error, ctx);
  }
  catch {
    // an observer that throws never reaches the response
  }
}

/**
 * A taxonomy response: status/msgid/retryable from the row, message from
 * the catalog. `params` are trusted (op ids, limits, method lists).
 * @param {Server} server
 * @param {keyof typeof HTTP_ERRORS} code
 * @param {string} trace
 * @param {Record<string, unknown>} params
 * @param {unknown} details
 * @param {Readonly<Record<string, string>> | null} extraHeaders
 * @param {RequestContext | null} ctx
 * @param {boolean} [retryable] - overrides the row
 * @returns {HttpResponse}
 */
function refuse(server, code, trace, params, details, extraHeaders, ctx, retryable) {
  const row = HTTP_ERRORS[code];
  return errorResponse(row.status, code, renderMessage(server.catalog, row.msgid, params), trace,
    details, retryable === undefined ? row.retryable : retryable, extraHeaders, server.errorBody, ctx);
}

/**
 * Whether a path decodes at all — the miss classifier: a `null` match
 * with an undecodable path is `JC2011`, not a 404.
 * @param {string} path
 * @returns {boolean}
 */
function decodable(path) {
  try {
    decodeURIComponent(path);
    return true;
  }
  catch {
    return false;
  }
}

/**
 * Whether the request carried a non-empty body.
 * @param {string | Uint8Array | null} body
 * @returns {boolean}
 */
function hasContent(body) {
  return body !== null && (typeof body === 'string' ? body.length > 0 : body.byteLength > 0);
}

/**
 * The AbortSignal of a request, when the adapter supplied one.
 * @param {HttpRequest} request
 * @returns {AbortSignal | null}
 */
function signalOf(request) {
  const s = /** @type {any} */ (request).signal;
  return s !== null && typeof s === 'object' && typeof s.aborted === 'boolean' && typeof s.addEventListener === 'function'
    ? /** @type {AbortSignal} */ (s)
    : null;
}

//#endregion

//#region the pipeline

/**
 * Per-request mutable state: what the context's `etag`/`status` armed,
 * and how the settlement classified — `outcome` 0 success, 1 declared
 * failure (with `retryable`), 2 server fault (a pre-handler `JC2014`
 * among them: nothing ran, the claim is released retryable), 3 a
 * POST-handler precondition failure (the handler already ran and may
 * have mutated: the claim is recorded non-retryable with its 412) —
 * which is what the ledger needs to commit, record or release the
 * claim. `decided` is set by a `preconditions` resolver that already
 * evaluated the conditionals; the post-handler comparison then stands
 * down.
 * @typedef {{ etag: string | null, strong: boolean, status: number, outcome: number, retryable: boolean, decided: boolean }} Armed
 */

/**
 * The pipeline up to the handler: synchronous; returns a response for
 * every early refusal, otherwise the promise the handler boundary opens.
 * @param {Server} server
 * @param {HttpRequest} request
 * @returns {HttpResponse | Promise<HttpResponse>}
 */
function run(server, request) {
  const trace = makeTrace(server);
  const method = request.method;
  const url = request.url;
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const query = q === -1 ? '' : url.slice(q + 1);
  const headers = request.headers;
  const body = request.body === undefined ? null : request.body;

  // ——— 2. route ———
  let hit = server.contract.match(method, path);
  let isHead = false;
  if (hit === null && method === 'HEAD' && server.head) {
    hit = server.contract.match('GET', path);
    isHead = hit !== null;
  }
  if (hit === null) {
    if (path.indexOf('%') !== -1 && !decodable(path)) return refuse(server, 'JC2011', trace, {}, undefined, null, null);
    if (server.wellKnown !== false && path === server.wellKnown) return wellKnown(server, method, trace);
    const allowed = server.contract.allowed(path);
    if (allowed.length > 0) {
      if (server.head && allowed.includes('GET') && !allowed.includes('HEAD')) {
        allowed.push('HEAD');
        allowed.sort();
      }
      const allow = allowed.join(', ');
      return refuse(server, 'JC2002', trace, { allow }, undefined, { allow }, null);
    }
    return refuse(server, 'JC2001', trace, {}, undefined, null, null);
  }
  const route = /** @type {Route} */ (server.routes.get(hit.op.id));
  const op = route.op;
  if (route.handler === null) return refuse(server, 'JC2013', trace, { op: op.id }, undefined, null, null);

  // ——— 4. the body limit: by declaration before the read, by length after ———
  const declared = contentLength(headers);
  if (declared > route.maxBody) return refuse(server, 'JC2003', trace, { op: op.id, limit: route.maxBody }, undefined, null, null);
  const content = hasContent(body);
  if (content && exceedsBytes(/** @type {string | Uint8Array} */ (body), route.maxBody)) {
    return refuse(server, 'JC2003', trace, { op: op.id, limit: route.maxBody }, undefined, null, null);
  }

  // ——— 7a. the transport members: path, query, header ———
  const params = Object.freeze(hit.params);
  /** @type {Record<string, unknown>} */
  const input = {};
  for (let i = 0; i < route.pathMembers.length; i++) {
    const m = route.pathMembers[i];
    setObjectMember(input, m, params[m]);
  }
  if (!decodeQuery(query, route.queryMembers, route.repeated, input)) {
    return refuse(server, 'JC2012', trace, {}, undefined, null, null);
  }
  /** @type {Record<string, string>} */
  let ctxHeaders = NO_HEADERS;
  if (route.headerMembers.length > 0) {
    ctxHeaders = {};
    for (let i = 0; i < route.headerMembers.length; i++) {
      const name = route.headerNames[i];
      const raw = headers[name];
      if (raw === undefined) continue;
      const m = route.headerMembers[i];
      if (route.headerArray[i]) {
        /** @type {string[]} */
        const list = [];
        if (typeof raw === 'string') {
          const parts = raw.split(',');
          for (let j = 0; j < parts.length; j++) {
            const part = parts[j].trim();
            if (part.length > 0) list.push(part);
          }
        }
        else if (Array.isArray(raw)) {
          for (let j = 0; j < raw.length; j++) {
            if (typeof raw[j] !== 'string') return refuse(server, 'JC2015', trace, { op: op.id, header: m }, undefined, null, null);
            list.push(raw[j]);
          }
        }
        else return refuse(server, 'JC2015', trace, { op: op.id, header: m }, undefined, null, null);
        setObjectMember(input, m, list);
        setObjectMember(ctxHeaders, name, list.join(', '));
      }
      else {
        let value;
        if (typeof raw === 'string') value = raw;
        else if (Array.isArray(raw) && raw.length === 1 && typeof raw[0] === 'string') value = raw[0];
        else return refuse(server, 'JC2015', trace, { op: op.id, header: m }, undefined, null, null);
        setObjectMember(input, m, value);
        setObjectMember(ctxHeaders, name, value);
      }
    }
  }
  const ifMatch = headerValue(headers, 'if-match');
  const ifNoneMatch = headerValue(headers, 'if-none-match');
  if (ifMatch !== undefined || ifNoneMatch !== undefined) {
    if (ctxHeaders === NO_HEADERS) ctxHeaders = {};
    if (ifMatch !== undefined) ctxHeaders['if-match'] = ifMatch;
    if (ifNoneMatch !== undefined) ctxHeaders['if-none-match'] = ifNoneMatch;
  }
  Object.freeze(ctxHeaders);
  const transported = route.normalize === null ? input : route.normalize(input);

  /** @type {Armed} */
  const armed = { etag: null, strong: false, status: 0, outcome: 0, retryable: false, decided: false };
  /** @type {RequestContext} */
  const ctx = {
    op, trace, method, path, params, headers: ctxHeaders,
    body: route.raw ? body : null,
    signal: signalOf(request),
    idempotency: null,
    fail: ContractFailure,
    etag: (tag, options) => {
      if (typeof tag !== 'string' || tag.length === 0 || tag.indexOf('"') !== -1) {
        throw new TypeError('ctx.etag: the tag must be a non-empty string without double quotes');
      }
      armed.etag = tag;
      armed.strong = options !== undefined && options !== null && options.strong === true;
    },
    status: (status) => {
      if (!Number.isInteger(status) || status < 200 || status > 299) {
        throw new ContractHostError('JC1006', `ctx.status: the success status must be an integer in 200–299, got ${String(status)}`);
      }
      armed.status = status;
    },
  };

  // ——— 3. opaque: the raw handler. The transport members ARE the whole
  // input (an opaque operation has no body-located member — JC0017), so
  // they are validated like any other input; the bytes go to the handler
  // untouched in ctx.body ———
  if (route.raw) {
    const invalid = validateOperationInput(route, transported);
    if (invalid !== null && invalid.kind === 'contract') {
      if (invalid.cause !== undefined) observe(server, invalid.cause, null);
      return refuse(server, 'JC2006', trace, { op: op.id }, invalid.details, null, null);
    }
    Object.freeze(ctx);
    return boundary(server, route, ctx, op.input === null ? null : transported, trace, armed, isHead, ifMatch, ifNoneMatch, true);
  }

  // ——— 5. media, 6. parse ———
  let parsed;
  if (route.hasBody && content) {
    if (!mediaMatches(headerValue(headers, 'content-type'), route.media)) {
      return refuse(server, 'JC2004', trace, { op: op.id, media: route.media }, undefined, null, null);
    }
    let text;
    if (typeof body === 'string') text = body;
    else {
      try {
        text = utf8.decode(/** @type {Uint8Array} */ (body));
      }
      catch {
        return refuse(server, 'JC2005', trace, { op: op.id }, undefined, null, null);
      }
    }
    try {
      parsed = JSON.parse(text);
    }
    catch {
      return refuse(server, 'JC2005', trace, { op: op.id }, undefined, null, null);
    }
  }

  // ——— 7b. the body members, never coerced ———
  /** @type {any} */
  let assembled = op.input === null ? null : transported;
  if (parsed !== undefined) {
    if (route.wholeBody !== null) setObjectMember(assembled, route.wholeBody, parsed);
    else if (!isJsonObject(parsed)) {
      return refuse(server, 'JC2006', trace, { op: op.id },
        projectValidationDetails(route.details, [{ instancePath: '', keyword: 'type' }]), null, null);
    }
    else {
      const names = Object.keys(parsed);
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (route.nonBody.has(name)) continue;
        setObjectMember(assembled, name, parsed[name]);
      }
    }
  }

  // ——— 8. validate (the pipeline's half) ———
  const invalid = validateOperationInput(route, assembled);
  if (invalid !== null && invalid.kind === 'contract') {
    if (invalid.cause !== undefined) observe(server, invalid.cause, null);
    return refuse(server, 'JC2006', trace, { op: op.id }, invalid.details, null, null);
  }

  // ——— subscribe: the stream branch (§17–§18), or the one-shot read ———
  if (route.stream) {
    Object.freeze(ctx);
    return subscribeBranch(server, route, ctx, assembled, trace, headers, armed, isHead, ifMatch, ifNoneMatch);
  }

  // ——— 9. idempotency ———
  if (route.idempotency !== 'none') {
    const key = headerValue(headers, 'idempotency-key');
    if (key === undefined || key.length === 0) {
      if (route.idempotency === 'required') return refuse(server, 'JC2007', trace, { op: op.id }, undefined, null, null);
    }
    else return idempotent(server, route, ctx, assembled, trace, armed, isHead, ifMatch, ifNoneMatch, key);
  }

  Object.freeze(ctx);
  if (route.tag !== null) return preconditionedBoundary(server, route, ctx, assembled, trace, armed, isHead, ifMatch, ifNoneMatch);
  return boundary(server, route, ctx, assembled, trace, armed, isHead, ifMatch, ifNoneMatch, false);
}

/**
 * The well-known negotiation document: `describe()` (with `revision` and
 * `compat`) under GET/HEAD, memoized as text. The revision is computed
 * lazily on the FIRST well-known request — construction stays synchronous
 * and a server nobody negotiates with never pays the digest. A projection
 * that cannot be canonicalized (`JC0061`) is reported to `onError` once
 * and the document honestly answers `revision: null`.
 * @param {Server} server
 * @param {string} method
 * @param {string} trace
 * @returns {HttpResponse | Promise<HttpResponse>}
 */
function wellKnown(server, method, trace) {
  if (method !== 'GET' && method !== 'HEAD') {
    return refuse(server, 'JC2002', trace, { allow: 'GET, HEAD' }, undefined, { allow: 'GET, HEAD' }, null);
  }
  const respond = () => {
    if (server.described.text === null) server.described.text = JSON.stringify(server.contract.describe());
    return {
      status: 200,
      headers: { 'content-type': JSON_CONTENT_TYPE, 'x-jaren-trace': trace },
      body: method === 'HEAD' ? null : server.described.text,
    };
  };
  if (server.described.text !== null) return respond();
  return server.contract.revision().then(respond, (err) => {
    observe(server, err, null);
    return respond();
  });
}

//#endregion

//#region the stream branch

/**
 * A subscribe operation, settled: the handler answers the duck-typed
 * subscription (§17.1); a declared failure or a host fault is an
 * ordinary §7.3 response BEFORE any stream starts. With `accept:
 * text/event-stream` the response streams SSE; without it (or under
 * HEAD) the snapshot answers as plain JSON — the one-shot read.
 * @param {Server} server
 * @param {Route} route
 * @param {RequestContext} ctx - frozen
 * @param {any} input
 * @param {string} trace
 * @param {Readonly<Record<string, string | readonly string[]>>} headers
 * @param {Armed} armed
 * @param {boolean} isHead
 * @param {string | undefined} ifMatch
 * @param {string | undefined} ifNoneMatch
 * @returns {Promise<HttpResponse>}
 */
function subscribeBranch(server, route, ctx, input, trace, headers, armed, isHead, ifMatch, ifNoneMatch) {
  const accept = headerValue(headers, 'accept');
  const wantsStream = !isHead && accept !== undefined && accept.toLowerCase().indexOf(STREAM_MEDIA) !== -1;
  return settleOperation(route, input, ctx, false).then((result) => {
    if (result.kind === 'failure') return declaredFailure(server, route, ctx, result, trace, armed);
    if (result.kind === 'contract') {
      if (result.cause !== undefined) observe(server, result.cause, ctx);
      armed.outcome = 2;
      return refuse(server, result.code, trace, { op: route.op.id }, result.details, null, ctx);
    }
    const sub = result.value;
    if (!isSubscriptionLike(sub)) {
      observe(server, new TypeError(`the handler of subscribe operation '${route.op.id}' did not answer a subscription ({ result | snapshot(), subscribe, close })`), ctx);
      armed.outcome = 2;
      return refuse(server, 'JC2010', trace, { op: route.op.id }, undefined, null, ctx);
    }
    if (!wantsStream) return oneShotSnapshot(server, route, ctx, sub, trace, armed, isHead, ifMatch, ifNoneMatch);
    return sseResponse(server, route, ctx, sub, trace, headers);
  });
}

/**
 * The one-shot read of a subscribe operation: the snapshot, validated,
 * released, answered through the ordinary §7 serializer.
 * @param {Server} server
 * @param {Route} route
 * @param {RequestContext} ctx
 * @param {import('../stream/server.js').SubscriptionLike} sub
 * @param {string} trace
 * @param {Armed} armed
 * @param {boolean} isHead
 * @param {string | undefined} ifMatch
 * @param {string | undefined} ifNoneMatch
 * @returns {HttpResponse}
 */
function oneShotSnapshot(server, route, ctx, sub, trace, armed, isHead, ifMatch, ifNoneMatch) {
  let value;
  let thrown;
  try {
    value = typeof sub.snapshot === 'function' ? sub.snapshot() : sub.result;
  }
  catch (err) {
    thrown = err === undefined ? new Error('the snapshot accessor threw') : err;
  }
  try {
    sub.close();
  }
  catch (err) {
    observe(server, err, ctx);
  }
  if (thrown !== undefined) {
    observe(server, thrown, ctx);
    armed.outcome = 2;
    return refuse(server, 'JC2008', trace, { op: route.op.id }, undefined, null, ctx);
  }
  if (server.validateOutput) {
    const v = verdict(route.validateOutput, value);
    if (!v.valid) {
      observe(server, v.thrown !== undefined ? v.thrown : v.errors, ctx);
      armed.outcome = 2;
      return refuse(server, 'JC2010', trace, { op: route.op.id }, undefined, null, ctx);
    }
  }
  // the one-shot answer is plain JSON — the operation's media names the
  // stream envelope, which this response is not
  return finishValue(server, { ...route, media: JSON_MEDIA }, ctx, value, trace, armed, isHead, ifMatch, ifNoneMatch);
}

/**
 * The SSE response of a live subscription: `200 text/event-stream` with
 * the pump behind `stream`. The pump runs the carrier-neutral
 * subscription runner — snapshot/patch/error/end land as SSE events, a
 * heartbeat comment line goes out every `policy.stream.heartbeatMs`,
 * the peer's abort (`ctx.signal`) stops silently, and the dispatcher's
 * `close()` ends with `server-shutdown`.
 * @param {Server} server
 * @param {Route} route
 * @param {RequestContext} ctx
 * @param {import('../stream/server.js').SubscriptionLike} sub
 * @param {string} trace
 * @param {Readonly<Record<string, string | readonly string[]>>} headers
 * @returns {HttpResponse}
 */
function sseResponse(server, route, ctx, sub, trace, headers) {
  const lastRaw = headerValue(headers, 'last-event-id');
  let lastSeq = null;
  if (lastRaw !== undefined) {
    const n = Number.parseInt(lastRaw, 10);
    if (Number.isFinite(n) && n >= 0) lastSeq = n;
  }
  const streamPolicy = route.op.policy.stream;
  const heartbeatMs = streamPolicy === null ? 15000 : streamPolicy.heartbeatMs;

  /** @type {NonNullable<HttpResponse['stream']>} */
  const stream = (sink) => {
    const timer = setInterval(() => {
      try {
        sink.write(HEARTBEAT_LINE);
      }
      catch {
        // a dead sink is ended by the abort path
      }
    }, heartbeatMs);
    if (timer !== null && typeof (/** @type {any} */ (timer)).unref === 'function') /** @type {any} */ (timer).unref();

    /** @param {string} event @param {number | null} seq @param {unknown} data */
    const write = (event, seq, data) => {
      try {
        sink.write(encodeStreamEvent(event, seq, data));
      }
      catch (err) {
        observe(server, err, ctx);
      }
    };
    // registered BEFORE the runner starts, so a stream that fails during
    // construction removes itself and never lingers in the set
    /** @type {{ stop: (reason: string | null) => void } | null} */
    let runner = null;
    /** @type {(reason: string | null) => void} */
    const stopper = (reason) => {
      if (runner !== null) runner.stop(reason);
    };
    server.streams.add(stopper);
    runner = runSubscription(route, sub, {
      snapshot: (seq, value, resumed) => write('snapshot', seq, { value, resumed }),
      patch: (seq, emission) => write('patch', seq, emission),
      error: (intent, cause) => {
        observe(server, cause, ctx);
        const code = intent === 'invalid-snapshot' ? 'JC2091' : 'JC2008';
        const msgid = intent === 'invalid-snapshot' ? STREAM_ERRORS.JC2091.msgid : HTTP_ERRORS.JC2008.msgid;
        write('error', null, { code, message: renderMessage(server.catalog, msgid, { op: route.op.id }), requestId: trace, retryable: false });
      },
      end: (reason) => write('end', null, { reason }),
      done: () => {
        clearInterval(timer);
        server.streams.delete(stopper);
        try {
          sink.end();
        }
        catch {
          // the sink may already be gone
        }
      },
    }, { lastSeq, validate: server.validateOutput });
    if (ctx.signal !== null) {
      if (ctx.signal.aborted) stopper(null);
      else ctx.signal.addEventListener('abort', () => stopper(null), { once: true });
    }
    return () => stopper(null);
  };

  return {
    status: 200,
    headers: { 'content-type': STREAM_MEDIA, 'cache-control': 'no-store', 'x-jaren-trace': trace },
    body: null,
    stream,
  };
}

//#endregion

//#region the handler boundary

/**
 * The pre-handler conditionals of a declared tag resolver
 * (docs/CONTRACT-FORMAT.md §7.5): resolve the CURRENT entity tag, decide
 * `If-Match` (strong comparison, first — RFC 9110 §13.2.2) and
 * `If-None-Match` (weak) BEFORE the handler, and only then run it. A
 * stale precondition refuses `JC2014` with ZERO handler invocations —
 * the write guard the post-handler comparison cannot be; a matching
 * `If-None-Match` on a safe method answers 304 without computing the
 * representation. A command consults its resolver only under a
 * conditional header; a safe method always resolves, so its response
 * carries the tag (the handler's own `ctx.etag` re-arms the RESPONSE
 * tag only — the conditionals are already decided). On pass, an unsafe
 * method arms nothing: a mutated representation must not echo its
 * pre-state tag (RFC 9110 §8.8.3).
 * @param {Server} server
 * @param {Route} route
 * @param {RequestContext} ctx - frozen
 * @param {any} input
 * @param {string} trace
 * @param {Armed} armed
 * @param {boolean} isHead
 * @param {string | undefined} ifMatch
 * @param {string | undefined} ifNoneMatch
 * @returns {HttpResponse | Promise<HttpResponse>}
 */
function preconditionedBoundary(server, route, ctx, input, trace, armed, isHead, ifMatch, ifNoneMatch) {
  const safe = ctx.method === 'GET' || ctx.method === 'HEAD';
  if (!safe && ifMatch === undefined && ifNoneMatch === undefined) {
    return boundary(server, route, ctx, input, trace, armed, isHead, ifMatch, ifNoneMatch, false);
  }
  /** @param {unknown} err @returns {HttpResponse} */
  const fault = (err) => {
    observe(server, err === undefined ? new TypeError(`the tag resolver of '${route.op.id}' rejected with undefined`) : err, ctx);
    armed.outcome = 2;
    return refuse(server, 'JC2008', trace, { op: route.op.id }, undefined, null, ctx);
  };
  /** @param {unknown} resolution @returns {HttpResponse | Promise<HttpResponse>} */
  const decide = (resolution) => {
    /** @type {{ tag: string, strong: boolean } | null} */
    let resolved;
    if (resolution === null) resolved = null;
    else if (typeof resolution === 'string') resolved = { tag: resolution, strong: true };
    else if (typeof resolution === 'object' && typeof (/** @type {any} */ (resolution).tag) === 'string') {
      resolved = { tag: /** @type {any} */ (resolution).tag, strong: /** @type {any} */ (resolution).strong !== false };
    }
    else return fault(new TypeError(`the tag resolver of '${route.op.id}' must answer a string, { tag, strong? } or null`));
    if (resolved !== null && (resolved.tag.length === 0 || resolved.tag.indexOf('"') !== -1)) {
      return fault(new TypeError(`the tag resolver of '${route.op.id}' answered a tag that is empty or carries a double quote`));
    }
    if (ifMatch !== undefined && (resolved === null || !entityTagMatches(ifMatch, resolved.tag, resolved.strong, true))) {
      armed.outcome = 2; // nothing ran: on a claimed command the key is released retryable
      const extra = resolved === null ? null : { etag: formatEntityTag(resolved.tag, resolved.strong) };
      return refuse(server, 'JC2014', trace, { op: route.op.id }, undefined, extra, ctx);
    }
    if (ifNoneMatch !== undefined && resolved !== null && entityTagMatches(ifNoneMatch, resolved.tag, resolved.strong, false)) {
      const etag = formatEntityTag(resolved.tag, resolved.strong);
      if (safe) return { status: 304, headers: { etag, 'x-jaren-trace': trace }, body: null };
      armed.outcome = 2;
      return refuse(server, 'JC2014', trace, { op: route.op.id }, undefined, { etag }, ctx);
    }
    armed.decided = true;
    if (safe && resolved !== null) {
      armed.etag = resolved.tag;
      armed.strong = resolved.strong;
    }
    return boundary(server, route, ctx, input, trace, armed, isHead, ifMatch, ifNoneMatch, false);
  };
  let resolution;
  try {
    resolution = /** @type {NonNullable<Route['tag']>} */ (route.tag)(input, ctx);
  }
  catch (err) {
    return fault(err);
  }
  return isThenable(resolution) ? toPromise(resolution).then(decide, fault) : decide(resolution);
}

/**
 * Call the handler through the pipeline's uniform promise boundary and
 * project the classified result onto the HTTP wire.
 * @param {Server} server
 * @param {Route} route
 * @param {RequestContext} ctx - frozen
 * @param {any} input
 * @param {string} trace
 * @param {Armed} armed
 * @param {boolean} isHead
 * @param {string | undefined} ifMatch
 * @param {string | undefined} ifNoneMatch
 * @param {boolean} raw
 * @returns {Promise<HttpResponse>}
 */
function boundary(server, route, ctx, input, trace, armed, isHead, ifMatch, ifNoneMatch, raw) {
  return settleOperation(route, input, ctx, server.validateOutput).then(
    (result) => project(server, route, ctx, result, trace, armed, isHead, ifMatch, ifNoneMatch, raw));
}

/**
 * One classified settlement onto the wire: a declared failure renders
 * its message and answers the declared status; a contract result
 * (`JC2008`/`JC2010`) is a server fault — its cause goes to `onError`,
 * never onto the wire; a value is serialized under the entity-tag and
 * HEAD/204 rules (or passed through verbatim for a raw handler).
 * @param {Server} server
 * @param {Route} route
 * @param {RequestContext} ctx
 * @param {OperationResult} result
 * @param {string} trace
 * @param {Armed} armed
 * @param {boolean} isHead
 * @param {string | undefined} ifMatch
 * @param {string | undefined} ifNoneMatch
 * @param {boolean} raw
 * @returns {HttpResponse}
 */
function project(server, route, ctx, result, trace, armed, isHead, ifMatch, ifNoneMatch, raw) {
  if (result.kind === 'failure') return declaredFailure(server, route, ctx, result, trace, armed);
  if (result.kind === 'contract') {
    if (result.cause !== undefined) observe(server, result.cause, ctx);
    armed.outcome = 2;
    return refuse(server, result.code, trace, { op: route.op.id }, result.details, null, ctx);
  }
  return raw
    ? finishRaw(server, route, ctx, result.value, trace, armed, isHead)
    : finishValue(server, route, ctx, result.value, trace, armed, isHead, ifMatch, ifNoneMatch);
}

/**
 * The validated value of a JSON handler: serialized (`JC2010` when JSON
 * cannot carry it), then the entity-tag conditionals and the HEAD/204
 * body rules.
 * @param {Server} server
 * @param {Route} route
 * @param {RequestContext} ctx
 * @param {unknown} value
 * @param {string} trace
 * @param {Armed} armed
 * @param {boolean} isHead
 * @param {string | undefined} ifMatch
 * @param {string | undefined} ifNoneMatch
 * @returns {HttpResponse}
 */
function finishValue(server, route, ctx, value, trace, armed, isHead, ifMatch, ifNoneMatch) {
  let text;
  try {
    text = JSON.stringify(value);
  }
  catch (err) {
    observe(server, err, ctx);
    armed.outcome = 2;
    return refuse(server, 'JC2010', trace, { op: route.op.id }, undefined, null, ctx);
  }
  const status = armed.status !== 0 ? armed.status : route.status;
  /** @type {Record<string, string>} */
  const headers = { 'x-jaren-trace': trace };
  if (armed.etag !== null) {
    const etag = formatEntityTag(armed.etag, armed.strong);
    if (!armed.decided) {
      // the POST-handler conditionals — a cache device, never a write
      // guard: the handler has already run when they are compared, so a
      // 412 here does not mean the work did not happen. Outcome 3
      // records that on a claimed command (non-retryable, the 412
      // replays). If-Match first (RFC 9110 §13.2.2), strong comparison;
      // then If-None-Match, weak: 304 for GET/HEAD, 412 otherwise. A
      // `preconditions` resolver (§7.5) decides these BEFORE the
      // handler instead and stands this block down (`armed.decided`).
      if (ifMatch !== undefined && !entityTagMatches(ifMatch, armed.etag, armed.strong, true)) {
        armed.outcome = 3;
        return refuse(server, 'JC2014', trace, { op: route.op.id }, undefined, null, ctx);
      }
      if (ifNoneMatch !== undefined && entityTagMatches(ifNoneMatch, armed.etag, armed.strong, false)) {
        if (ctx.method === 'GET' || ctx.method === 'HEAD') {
          headers.etag = etag;
          return { status: 304, headers, body: null };
        }
        armed.outcome = 3;
        return refuse(server, 'JC2014', trace, { op: route.op.id }, undefined, { etag }, ctx);
      }
    }
    headers.etag = etag;
  }
  if (text === undefined || status === 204) return { status, headers, body: null };
  headers['content-type'] = route.media.indexOf(';') === -1 ? `${route.media}; charset=utf-8` : route.media;
  if (isHead) {
    headers['content-length'] = String(new TextEncoder().encode(text).byteLength);
    return { status, headers, body: null };
  }
  return { status, headers, body: text };
}

/**
 * The value of a raw (opaque) handler: passed through verbatim plus the
 * trace header; anything that is not `{ status, headers?, body? }` is
 * `JC2010`.
 * @param {Server} server
 * @param {Route} route
 * @param {RequestContext} ctx
 * @param {unknown} value
 * @param {string} trace
 * @param {Armed} armed
 * @param {boolean} isHead
 * @returns {HttpResponse}
 */
function finishRaw(server, route, ctx, value, trace, armed, isHead) {
  let status;
  let body;
  /** @type {Record<string, string>} */
  const headers = {};
  try {
    const r = /** @type {any} */ (value);
    if (r === null || typeof r !== 'object') throw new TypeError('a raw handler must return { status, headers?, body? }');
    status = r.status;
    const rawHeaders = r.headers;
    body = r.body;
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new TypeError('raw status');
    if (rawHeaders !== undefined && (rawHeaders === null || typeof rawHeaders !== 'object')) throw new TypeError('raw headers');
    if (!(body === undefined || body === null || typeof body === 'string' || body instanceof Uint8Array)) throw new TypeError('raw body');
    if (rawHeaders !== undefined) {
      const names = Object.keys(rawHeaders);
      for (let i = 0; i < names.length; i++) {
        const v = rawHeaders[names[i]];
        if (typeof v === 'string') headers[names[i].toLowerCase()] = v;
      }
    }
  }
  catch (err) {
    observe(server, err, ctx);
    armed.outcome = 2;
    return refuse(server, 'JC2010', trace, { op: route.op.id }, undefined, null, ctx);
  }
  headers['x-jaren-trace'] = trace;
  return { status, headers, body: isHead || body === undefined ? null : body };
}

/**
 * A declared operation error, already validated by the pipeline: the
 * declared status and code on the wire, the message from
 * `contract/error/<code>` in the host catalog when it has one, else the
 * generic `contract/handler-error`.
 * @param {Server} server
 * @param {Route} route
 * @param {RequestContext} ctx
 * @param {Extract<OperationResult, { kind: 'failure' }>} result
 * @param {string} trace
 * @param {Armed} armed
 * @returns {HttpResponse}
 */
function declaredFailure(server, route, ctx, result, trace, armed) {
  const message = declaredMessage(server.catalog, route.op.id, result.code, result.params);
  armed.outcome = 1;
  armed.retryable = result.retryable;
  return errorResponse(result.status, result.code, message, trace, result.details, result.retryable, null, server.errorBody, ctx);
}

//#endregion

//#region idempotency

/**
 * The idempotency step: hash the validated input, claim the key, then
 * replay / refuse / run — and settle the claim with the response.
 * @param {Server} server
 * @param {Route} route
 * @param {RequestContext} ctx - not yet frozen: `idempotency` is set here
 * @param {any} input
 * @param {string} trace
 * @param {Armed} armed
 * @param {boolean} isHead
 * @param {string | undefined} ifMatch
 * @param {string | undefined} ifNoneMatch
 * @param {string} key
 * @returns {Promise<HttpResponse>}
 */
function idempotent(server, route, ctx, input, trace, armed, isHead, ifMatch, ifNoneMatch, key) {
  const ledger = /** @type {Ledger} */ (server.ledger);
  let scope;
  try {
    scope = server.scope(ctx);
    if (typeof scope !== 'string') throw new TypeError(`serveHttp: the scope function must return a string, got ${typeof scope}`);
  }
  catch (err) {
    observe(server, err, ctx);
    Object.freeze(ctx);
    return Promise.resolve(refuse(server, 'JC2008', trace, { op: route.op.id }, undefined, null, ctx));
  }
  /** @type {any} */ (ctx).idempotency = Object.freeze({ key, scope });
  Object.freeze(ctx);
  const op = route.op.id;
  /** @param {unknown} err */
  const fault = (err) => {
    observe(server, err, ctx);
    return refuse(server, 'JC2008', trace, { op }, undefined, null, ctx);
  };
  /** @param {unknown} claimed */
  const onClaim = (claimed) => {
    let state;
    let ref;
    let stored;
    try {
      const c = /** @type {any} */ (claimed);
      state = c === null || typeof c !== 'object' ? undefined : c.state;
      ref = state === 'new' ? c.ref : undefined;
      stored = state === 'replay' ? c.response : undefined;
    }
    catch (err) {
      return fault(err);
    }
    if (state === 'new') {
      // claim first, precondition second: a committed key replays its
      // stored response before the resolver runs (a retried command
      // that already succeeded must not answer 412)
      const ran = route.tag !== null
        ? preconditionedBoundary(server, route, ctx, input, trace, armed, isHead, ifMatch, ifNoneMatch)
        : boundary(server, route, ctx, input, trace, armed, isHead, ifMatch, ifNoneMatch, false);
      return toPromise(ran).then((response) => settleClaim(server, ledger, ref, response, ctx, armed));
    }
    if (state === 'replay') return replay(server, route, stored, trace, ctx);
    if (state === 'in-progress') {
      return refuse(server, 'JC2009', trace, { op, kind: 'in-progress' }, undefined, { 'retry-after': '1' }, ctx, true);
    }
    if (state === 'mismatch') {
      return refuse(server, 'JC2009', trace, { op, kind: 'mismatch' }, [{ kind: 'mismatch' }], null, ctx, false);
    }
    return fault(new TypeError(`serveHttp: the ledger answered an unknown claim state ${JSON.stringify(state)}`));
  };
  /** @param {string} hash */
  const afterHash = (hash) => {
    let claimed;
    try {
      claimed = ledger.claim({ op, scope, key, hash, now: server.now() });
    }
    catch (err) {
      return fault(err);
    }
    return isThenable(claimed) ? /** @type {Promise<any>} */ (claimed).then(onClaim, fault) : onClaim(claimed);
  };
  return canonicalSha256(input).then(afterHash, (err) => {
    if (err instanceof JsonCanonicalizeError) {
      return refuse(server, 'JC2006', trace, { op },
        projectValidationDetails(route.details, [{ instancePath: err.dataPath, keyword: 'canonical' }]), null, ctx);
    }
    return fault(err);
  });
}

/**
 * Settle a `new` claim with the response the handler produced: a
 * success commits (replayed verbatim later); a declared failure is
 * recorded as failed with its response and retryability; a server fault
 * (`JC2008`/`JC2010`, and a PRE-handler `JC2014` — nothing ran)
 * releases the key as retryable; a POST-handler `JC2014` (outcome 3) is
 * recorded NON-retryable with its 412 — the handler already ran and may
 * have mutated, so a blind retry with the same key replays the 412
 * instead of running it again. TOTAL: a ledger that throws or rejects
 * is reported, and the response still goes out.
 * @param {Server} server
 * @param {Ledger} ledger
 * @param {unknown} ref
 * @param {HttpResponse} response
 * @param {RequestContext} ctx
 * @param {Armed} armed
 * @returns {HttpResponse | Promise<HttpResponse>}
 */
function settleClaim(server, ledger, ref, response, ctx, armed) {
  let settlement;
  // the settlement carries the binding's clock, as the claim did: one
  // clock judges the record from claim to expiry
  try {
    const now = server.now();
    if (armed.outcome === 0) settlement = ledger.commit(ref, response, now);
    else if (armed.outcome === 1) settlement = ledger.fail(ref, armed.retryable, response, now);
    else if (armed.outcome === 3) settlement = ledger.fail(ref, false, response, now);
    else settlement = ledger.fail(ref, true, undefined, now);
  }
  catch (err) {
    observe(server, err, ctx);
    return response;
  }
  if (isThenable(settlement)) {
    return /** @type {Promise<void>} */ (settlement).then(() => response, (/** @type {unknown} */ err) => {
      observe(server, err, ctx);
      return response;
    });
  }
  return response;
}

/**
 * A replayed response: the stored status, headers and body verbatim,
 * with a fresh trace and `idempotent-replayed: true`.
 * @param {Server} server
 * @param {Route} route
 * @param {unknown} stored
 * @param {string} trace
 * @param {RequestContext} ctx
 * @returns {HttpResponse}
 */
function replay(server, route, stored, trace, ctx) {
  try {
    const s = /** @type {any} */ (stored);
    if (s === null || typeof s !== 'object' || !Number.isInteger(s.status) || s.headers === null || typeof s.headers !== 'object') {
      throw new TypeError('serveHttp: the ledger replayed a value that is not a response');
    }
    return {
      status: s.status,
      headers: { ...s.headers, 'x-jaren-trace': trace, 'idempotent-replayed': 'true' },
      body: s.body === undefined ? null : s.body,
    };
  }
  catch (err) {
    observe(server, err, ctx);
    return refuse(server, 'JC2008', trace, { op: route.op.id }, undefined, null, ctx);
  }
}

//#endregion
