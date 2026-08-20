//@ts-check
/**
 * @file `openHttpClient(contract, options)`: the HTTP client binding of a
 * compiled contract (docs/CONTRACT-FORMAT.md §10) — the `open(contract,
 * options) → Client` half of the driver pair whose server half is
 * `serveHttp`. `invoke(op, input, ctx)` validates the input with the
 * SAME compiled validator the server will run, splits it by the declared
 * locations (path, query, header, body), sends it through an injectable
 * `fetch`, and resolves a D6 outcome for every possible result — success,
 * declared failure, network failure, contract violation, cancellation —
 * keeping the three identities apart: the caller's `attempt` (carried
 * in `meta`, never sent), the server's `trace` (read from
 * `x-jaren-trace`, never generated here) and the idempotency `key`
 * (generated here per command, sent as `Idempotency-Key`, optionally
 * recorded in a durable `storage` WITHOUT the input).
 *
 * `invoke` NEVER rejects for anything a server or a network can do; it
 * throws only for the host's own mistakes (`JC1005`: an unknown or
 * opaque operation). `url(op, input)` builds the URL of any operation —
 * what an `<img src>` uses for an opaque one. `negotiate()` asks the
 * server's well-known description whether the two ends speak compatible
 * versions. Everything per operation is decided once at `open`.
 */

import { isJsonObject, setObjectMember } from '@jarenjs/core/object';
import { compileMessageCatalog } from '@jarenjs/core/message';
import { canonicalSha256 } from '@jarenjs/json/canonical';
import { JarenValidator } from '@jarenjs/validate';

import { createSseEventDecoder } from '@jarenjs/core/text/sse';

import { ContractHostError } from '../errors.js';
import { compatReason } from '../compat.js';
import { WELL_KNOWN_PATH, verdict, projectValidationDetails, renderMessage } from '../http/wire.js';
import { createStreamConsumer, STREAM_ERRORS } from '../stream/client.js';
import { STREAM_MEDIA } from '../stream/sse.js';
import {
  CLIENT_ERRORS, prepareOutcomeRoute, assembleOutcome, makeMeta, failedOutcome, clientError, outcomeError,
} from './outcome.js';

export { CLIENT_ERRORS };

/**
 * @typedef {import('../compile.js').Contract} Contract
 * @typedef {import('../compile.js').CompiledOperation} CompiledOperation
 * @typedef {import('../http/wire.js').Catalog} Catalog
 * @typedef {import('./outcome.js').Outcome} Outcome
 * @typedef {import('./outcome.js').OutcomeMeta} OutcomeMeta
 * @typedef {import('./outcome.js').OutcomeError} OutcomeError
 * @typedef {import('./outcome.js').OutcomeRoute} OutcomeRoute
 */

/**
 * The durable idempotency-key storage: the `createDocStore` adapter shape
 * of `@jarenjs/app` — `read()` returns the whole stored value (or
 * `undefined`), `write(value)` replaces it. Either may return a promise.
 * The client keeps its records under the member `jaren-contract`, keyed
 * by contract id, operation and key; a record is `{ op, key, hash, at }`
 * and never carries the input.
 * @typedef {{ read: () => any, write: (value: any) => any }} KeyStorage
 */

/**
 * @typedef {Object} HttpClientOptions
 * @property {(url: string, init: RequestInit) => Promise<any>} [fetch] - default `globalThis.fetch`
 * @property {string} [baseUrl] - prefixed to every path; default `''` (relative URLs)
 * @property {Record<string, string>} [headers] - static headers, merged under per-call ones
 * @property {() => string} [keys] - the idempotency key generator; default `crypto.randomUUID`
 * @property {KeyStorage | null} [storage] - durable key records; default `null`
 * @property {number} [timeoutMs] - per request; `0` (default) means none; composed with `ctx.signal`
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} [sleep] - the retry backoff sleeper (injectable for tests)
 * @property {Record<string, string | ((params: object) => string)>} [catalog] - a message catalog consulted before the English one
 * @property {string} [wellKnown] - the server's description path; default `/.well-known/jaren-contract`
 * @property {() => number} [now] - the clock stamped into key records; default `Date.now`
 * @property {JarenValidator<any>} [validator] - the validator `url()` compiles its path/query check with
 */

/**
 * Per-call context of `invoke`.
 * @typedef {Object} InvokeContext
 * @property {AbortSignal} [signal] - cancels the request (`kind: "cancelled"`)
 * @property {unknown} [attempt] - the caller's attempt id, echoed in `meta.attempt`, never sent
 * @property {string} [idempotencyKey] - the key to send instead of a generated one
 * @property {Record<string, string>} [headers] - per-call headers (over the static ones)
 * @property {string} [ifNoneMatch] - sent as `If-None-Match`
 * @property {string} [ifMatch] - sent as `If-Match`
 */

/**
 * The negotiation result.
 * @typedef {Object} Negotiation
 * @property {boolean} compatible
 * @property {'same-version' | 'server-accepts' | 'client-accepts' | 'version-mismatch' | 'unreachable' | 'not-a-contract'} reason
 * @property {{ id: string | null, version: string | null, compat: string[], revision: string | null } | null} server
 * @property {{ code: string, message: string } | null} error - `null` when compatible
 */

/**
 * The frozen capabilities table of the http client.
 * @typedef {Object} HttpClientCapabilities
 * @property {'http'} name
 * @property {true} status
 * @property {true} headers
 * @property {true} media
 * @property {true} etag
 * @property {true} idempotency
 * @property {boolean} durableKeys - a `storage` was given
 * @property {true} stream - `subscribe` carries SSE streams (docs/CONTRACT-FORMAT.md §19)
 * @property {'signal'} cancel
 */

/**
 * The options of one `subscribe` call (docs/CONTRACT-FORMAT.md §19).
 * @typedef {Object} SubscribeOptions
 * @property {(value: unknown, info: { seq: number, resumed: boolean }) => void} [onSnapshot]
 * @property {(emission: { patch: unknown[], seq: number }) => void} [onPatch]
 * @property {(outcome: Outcome) => void} [onError]
 * @property {(info: { reason: string }) => void} [onEnd]
 * @property {AbortSignal} [signal] - stops the subscription silently
 * @property {number} [lastSeq] - the resume seq (what a reconnect passes)
 */

/**
 * The client — the binding-agnostic shape every client binding exposes.
 * @typedef {Object} HttpClient
 * @property {(op: string, input?: unknown, ctx?: InvokeContext) => Promise<Outcome>} invoke
 * @property {(op: string, input?: unknown, options?: SubscribeOptions) => { stop: () => void }} subscribe
 * @property {(op: string, input?: unknown) => string} url
 * @property {(options?: { signal?: AbortSignal }) => Promise<Negotiation>} negotiate
 * @property {() => Promise<{ op: string, key: string }[]>} pending - the key records a restart must reconcile
 * @property {HttpClientCapabilities} capabilities
 * @property {Contract} contract
 * @property {() => any} describe
 * @property {() => void} close - aborts every in-flight request; later invokes resolve `cancelled`
 */

/** The storage member every record lives under. */
const STORAGE_MEMBER = 'jaren-contract';

/** The backoff ceiling of a retry, in ms. */
const BACKOFF_MAX = 8000;

/** The jitter added to a backoff, in ms (upper bound, exclusive). */
const BACKOFF_JITTER = 250;

/**
 * @param {string} code
 * @param {string} reason
 * @returns {ContractHostError}
 */
function host(code, reason) {
  return new ContractHostError(code, `openHttpClient: ${reason}`);
}

/**
 * An `AbortError`-named error, the platform's when a signal carries one.
 * @param {AbortSignal | null} signal
 * @returns {unknown}
 */
function abortReason(signal) {
  if (signal !== null && signal.reason !== undefined) return signal.reason;
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/**
 * Abortable delay; rejects with the abort reason.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal !== undefined && signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal ?? null));
    };
    const timer = setTimeout(() => {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A rejection value's `name`, read guardedly; `null` when it has none.
 * @param {unknown} err
 * @returns {string | null}
 */
function safeName(err) {
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return null;
  try {
    const name = /** @type {any} */ (err).name;
    return typeof name === 'string' && name.length > 0 ? name : null;
  }
  catch {
    return null;
  }
}

/**
 * The transport string of a value: scalars verbatim, everything else as
 * JSON (a shape the server's normalizer cannot decode, but deterministic).
 * @param {unknown} v
 * @returns {string}
 */
function transportString(v) {
  return typeof v === 'string' ? v : (typeof v === 'object' ? JSON.stringify(v) : String(v));
}

/**
 * The cached JSON-schema check of an operation's path/query members, for
 * `url()`: the input schema restricted to those members, rooted on the
 * contract document so `$ref`s resolve as they do for the validator.
 * @typedef {{ validate: ((value: unknown) => any) | null }} TransportCheck
 */

/**
 * One operation as the client prepared it: everything `invoke`/`url`
 * read per call, decided once.
 * @typedef {Object} ClientRoute
 * @property {CompiledOperation} op
 * @property {string} id
 * @property {string} method
 * @property {readonly import('../path.js').PathSegment[]} segments
 * @property {readonly string[]} queryMembers
 * @property {ReadonlySet<string>} queryRepeated
 * @property {readonly string[]} headerMembers
 * @property {readonly string[]} headerNames
 * @property {readonly string[]} bodyMembers - body-located members when the body is their object
 * @property {string | null} wholeBody - the member whose value IS the body
 * @property {boolean} hasBody
 * @property {string} media
 * @property {boolean} opaque
 * @property {boolean} hasInput
 * @property {((value: unknown) => any) | null} validateInput
 * @property {'none' | 'paths' | 'full'} details
 * @property {'none' | 'optional' | 'required'} idempotency
 * @property {{ max: number, on: readonly string[] } | null} retry
 * @property {ReadonlySet<string>} retryOn
 * @property {OutcomeRoute} outcome
 * @property {TransportCheck} transport - lazily compiled for `url()`
 */

/**
 * @param {CompiledOperation} op
 * @returns {ClientRoute}
 */
function prepare(op) {
  const http = op.http;
  /** @type {string[]} */
  const queryMembers = [];
  /** @type {Set<string>} */
  const queryRepeated = new Set();
  /** @type {string[]} */
  const headerMembers = [];
  /** @type {string[]} */
  const headerNames = [];
  /** @type {string[]} */
  const bodyMembers = [];
  const transport = op.input === null ? null : op.input.transport;
  const repeated = new Set(transport === null ? [] : transport.members.repeated);
  const members = Object.keys(http.in);
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const loc = http.in[m];
    if (loc === 'query') {
      queryMembers.push(m);
      if (repeated.has(m)) queryRepeated.add(m);
    }
    else if (loc === 'header') {
      headerMembers.push(m);
      headerNames.push(m.toLowerCase());
    }
    else if (loc === 'body' && http.body === null) bodyMembers.push(m);
  }
  return {
    op,
    id: op.id,
    method: http.method,
    segments: http.template.segments,
    queryMembers,
    queryRepeated,
    headerMembers,
    headerNames,
    bodyMembers,
    wholeBody: http.body,
    hasBody: http.body !== null || bodyMembers.length > 0,
    media: http.media,
    opaque: http.opaque,
    hasInput: op.input !== null,
    validateInput: op.input === null ? null : op.input.validate,
    details: op.policy.errors.details,
    idempotency: op.policy.idempotency,
    retry: op.policy.retry,
    retryOn: new Set(op.policy.retry === null ? [] : op.policy.retry.on),
    outcome: prepareOutcomeRoute(op),
    transport: { validate: null },
  };
}

/**
 * Open an HTTP client over a compiled contract.
 *
 * @param {Contract} contract
 * @param {HttpClientOptions} [options]
 * @returns {HttpClient}
 * @throws {ContractHostError} `JC1008` for a malformed argument or option
 * @example
 * const client = openHttpClient(contract, { baseUrl: 'https://api.example', timeoutMs: 5000 });
 * const outcome = await client.invoke('catalog.load', { since: '2026-01-01T00:00:00Z' });
 * if (outcome.ok) render(outcome.value);
 * else if (outcome.kind === 'failure') show(outcome.error.code);   // a declared error, e.g. 'stale'
 * else if (outcome.kind === 'network') retryLater();
 */
export function openHttpClient(contract, options = {}) {
  if (contract === null || typeof contract !== 'object' || typeof contract.match !== 'function'
    || contract.operations === null || typeof contract.operations !== 'object' || !Array.isArray(contract.ids)) {
    throw host('JC1008', 'the first argument must be a compiled contract (compileContract)');
  }
  if (options === null || typeof options !== 'object') throw host('JC1008', 'options must be an object');
  const fetchFn = options.fetch === undefined
    ? (/** @type {string} */ url, /** @type {RequestInit} */ init) => globalThis.fetch(url, init)
    : options.fetch;
  for (const [name, value] of [['fetch', fetchFn], ['keys', options.keys], ['sleep', options.sleep], ['now', options.now]]) {
    if (value !== undefined && typeof value !== 'function') throw host('JC1008', `options.${name} must be a function`);
  }
  const baseUrl = options.baseUrl === undefined ? '' : options.baseUrl;
  if (typeof baseUrl !== 'string') throw host('JC1008', 'options.baseUrl must be a string');
  const wellKnown = options.wellKnown === undefined ? WELL_KNOWN_PATH : options.wellKnown;
  if (typeof wellKnown !== 'string' || wellKnown.charCodeAt(0) !== 0x2F) throw host('JC1008', 'options.wellKnown must be an absolute path');
  const timeoutMs = options.timeoutMs === undefined ? 0 : options.timeoutMs;
  if (typeof timeoutMs !== 'number' || !(timeoutMs >= 0) || !Number.isFinite(timeoutMs)) {
    throw host('JC1008', 'options.timeoutMs must be a non-negative finite number');
  }
  const storage = options.storage === undefined ? null : options.storage;
  if (storage !== null && (typeof storage !== 'object' || typeof storage.read !== 'function' || typeof storage.write !== 'function')) {
    throw host('JC1008', 'options.storage must be { read, write } or null');
  }
  if (options.catalog !== undefined && (options.catalog === null || typeof options.catalog !== 'object')) {
    throw host('JC1008', 'options.catalog must be a message catalog object');
  }
  /** @type {Record<string, string>} */
  const staticHeaders = {};
  if (options.headers !== undefined) {
    if (options.headers === null || typeof options.headers !== 'object') throw host('JC1008', 'options.headers must be an object of strings');
    const names = Object.keys(options.headers);
    for (let i = 0; i < names.length; i++) {
      const v = options.headers[names[i]];
      if (typeof v !== 'string') throw host('JC1008', `options.headers['${names[i]}'] must be a string`);
      setObjectMember(staticHeaders, names[i].toLowerCase(), v);
    }
  }
  Object.freeze(staticHeaders);
  const keys = options.keys === undefined ? () => globalThis.crypto.randomUUID() : options.keys;
  const sleep = options.sleep === undefined ? defaultSleep : options.sleep;
  const now = options.now === undefined ? Date.now : options.now;
  /** @type {Catalog | null} */
  const catalog = options.catalog === undefined ? null : compileMessageCatalog(options.catalog);
  const contractId = contract.id === null ? '' : contract.id;

  /** @type {Map<string, ClientRoute>} */
  const routes = new Map();
  for (let i = 0; i < contract.ids.length; i++) {
    const id = contract.ids[i];
    routes.set(id, prepare(contract.operations[id]));
  }

  /** @type {JarenValidator<any> | null} */
  let validator = options.validator === undefined ? null : options.validator;
  const closer = new AbortController();
  let closed = false;
  /**
   * The server's contract revision, learned from the well-known document
   * by `negotiate()` (docs/CONTRACT-FORMAT.md §14) and carried in
   * `meta.revision` of every subsequent outcome; `null` until negotiated.
   * @type {string | null}
   */
  let serverRevision = null;

  /**
   * A meta in its fixed member order, with the negotiated revision.
   * @param {string} op
   * @param {unknown} attempt
   * @returns {OutcomeMeta}
   */
  function newMeta(op, attempt) {
    const meta = makeMeta(op, attempt, null);
    meta.revision = serverRevision;
    return meta;
  }

  //#region helpers

  /**
   * @param {string} op
   * @returns {ClientRoute}
   */
  function routeOf(op) {
    const route = routes.get(op);
    if (route === undefined) {
      throw new ContractHostError('JC1005', `client: '${String(op)}' is not an operation of the contract`);
    }
    return route;
  }

  /**
   * Compose the caller's signal, the per-request timeout and the
   * client's closer into the signal `fetch` receives.
   * @param {AbortSignal | null} signal
   * @returns {AbortSignal}
   */
  function composeSignal(signal) {
    if (signal === null && timeoutMs === 0) return closer.signal;
    /** @type {AbortSignal[]} */
    const list = [closer.signal];
    if (signal !== null) list.push(signal);
    if (timeoutMs > 0) list.push(AbortSignal.timeout(timeoutMs));
    return AbortSignal.any(list);
  }

  /**
   * The path + query of an operation for a value whose transport members
   * are valid. Throws `URIError` for a lone surrogate — the caller maps it.
   * @param {ClientRoute} route
   * @param {any} value
   * @returns {string}
   */
  function pathOf(route, value) {
    let path = '';
    const segments = route.segments;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      path += '/' + (s.variable ? encodeURIComponent(transportString(value[s.text])) : s.text);
    }
    if (segments.length === 0) path = '/';
    if (route.queryMembers.length === 0) return path;
    const params = new URLSearchParams();
    for (let i = 0; i < route.queryMembers.length; i++) {
      const m = route.queryMembers[i];
      const v = value[m];
      if (v === undefined || v === null) continue;
      if (route.queryRepeated.has(m) && Array.isArray(v)) {
        for (let j = 0; j < v.length; j++) {
          if (v[j] !== undefined && v[j] !== null) params.append(m, transportString(v[j]));
        }
      }
      else params.append(m, transportString(v));
    }
    const query = params.toString();
    return query.length === 0 ? path : path + '?' + query;
  }

  /**
   * The input as the validator sees it: `null`/`undefined` is `{}` for an
   * operation with input; a non-null input for an input-less operation
   * is refused by the caller.
   * @param {unknown} input
   * @returns {any}
   */
  function inputValue(input) {
    return input === undefined || input === null ? {} : input;
  }

  /**
   * The request headers of an invoke: static, per-call, declared header
   * members, then the protocol headers the client owns.
   * @param {ClientRoute} route
   * @param {any} value
   * @param {InvokeContext} ctx
   * @returns {Record<string, string>}
   */
  function headersOf(route, value, ctx) {
    /** @type {Record<string, string>} */
    const headers = { ...staticHeaders };
    if (ctx.headers !== undefined && ctx.headers !== null && typeof ctx.headers === 'object') {
      const names = Object.keys(ctx.headers);
      for (let i = 0; i < names.length; i++) setObjectMember(headers, names[i].toLowerCase(), String(ctx.headers[names[i]]));
    }
    for (let i = 0; i < route.headerMembers.length; i++) {
      const v = value[route.headerMembers[i]];
      if (v === undefined || v === null) continue;
      setObjectMember(headers, route.headerNames[i], Array.isArray(v) ? v.map(transportString).join(', ') : transportString(v));
    }
    if (typeof ctx.ifNoneMatch === 'string') headers['if-none-match'] = ctx.ifNoneMatch;
    if (typeof ctx.ifMatch === 'string') headers['if-match'] = ctx.ifMatch;
    return headers;
  }

  /**
   * The JSON body of an invoke, or `null` when the operation carries none.
   * Throws when JSON cannot carry the value — the caller maps it.
   * @param {ClientRoute} route
   * @param {any} value
   * @returns {string | null}
   */
  function bodyOf(route, value) {
    if (!route.hasBody) return null;
    if (route.wholeBody !== null) {
      const v = value[route.wholeBody];
      return v === undefined ? null : JSON.stringify(v);
    }
    /** @type {Record<string, unknown>} */
    const body = {};
    for (let i = 0; i < route.bodyMembers.length; i++) {
      const m = route.bodyMembers[i];
      if (value[m] !== undefined) setObjectMember(body, m, value[m]);
    }
    return JSON.stringify(body);
  }

  /**
   * A pre-send refusal: `JC2050` with validation details by policy.
   * @param {ClientRoute} route
   * @param {OutcomeMeta} meta
   * @param {unknown} details
   * @returns {Outcome}
   */
  function invalidInput(route, meta, details) {
    return failedOutcome('contract', clientError(catalog, 'JC2050', { op: route.id }, null, details), meta);
  }

  /**
   * @param {ClientRoute} route
   * @param {OutcomeMeta} meta
   * @returns {Outcome}
   */
  function cancelled(route, meta) {
    return failedOutcome('cancelled', clientError(catalog, 'JC2052', { op: route.id }, null, undefined), meta);
  }

  /**
   * Classify a transport rejection: the caller's (or the client's) abort
   * is `cancelled`; anything else — including the per-request timeout —
   * is `network`, with the error's NAME only (its text may embed the URL
   * and credentials).
   * @param {ClientRoute} route
   * @param {unknown} err
   * @param {AbortSignal | null} signal
   * @param {OutcomeMeta} meta
   * @returns {Outcome}
   */
  function rejected(route, err, signal, meta) {
    if ((signal !== null && signal.aborted) || closer.signal.aborted || safeName(err) === 'AbortError') return cancelled(route, meta);
    return failedOutcome('network', clientError(catalog, 'JC2051', { op: route.id, name: safeName(err) ?? typeof err }, null, undefined), meta);
  }

  /**
   * One request/response cycle → one outcome. Never throws.
   * @param {ClientRoute} route
   * @param {string} url
   * @param {Record<string, string>} headers
   * @param {string | null} body
   * @param {InvokeContext} ctx
   * @param {AbortSignal | null} signal
   * @returns {Promise<Outcome>}
   */
  async function send(route, url, headers, body, ctx, signal) {
    const meta = newMeta(route.id, ctx.attempt);
    if ((signal !== null && signal.aborted) || closed) return cancelled(route, meta);
    /** @type {RequestInit} */
    const init = { method: route.method, headers, signal: composeSignal(signal) };
    if (body !== null) init.body = body;
    let response;
    try {
      response = await fetchFn(url, init);
    }
    catch (err) {
      return rejected(route, err, signal, meta);
    }
    let status;
    let trace = null;
    let etag = null;
    let text;
    try {
      status = response.status;
      const h = response.headers;
      if (h !== null && typeof h === 'object' && typeof h.get === 'function') {
        const t = h.get('x-jaren-trace');
        if (typeof t === 'string' && t.length > 0) trace = t;
        const e = h.get('etag');
        if (typeof e === 'string' && e.length > 0) etag = e;
      }
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        return failedOutcome('contract', clientError(catalog, 'JC2053', { op: route.id }, null, [{ path: '', keyword: 'status' }]), meta);
      }
      text = status === 204 || status === 304 ? '' : await response.text();
    }
    catch (err) {
      return rejected(route, err, signal, meta);
    }
    meta.trace = trace;
    return assembleOutcome(route.outcome, { status, headers: etag === null ? null : { etag }, text }, meta, catalog);
  }

  /**
   * Whether an outcome is worth another attempt under the route's policy.
   * @param {ClientRoute} route
   * @param {Outcome} outcome
   * @returns {boolean}
   */
  function retryable(route, outcome) {
    if (outcome.ok) return false;
    if (outcome.kind === 'network') return true;
    return outcome.kind === 'failure' && route.retryOn.has(outcome.error.code);
  }

  /**
   * Whether a durable key record may be dropped: the peer gave a
   * definite answer (or the client refused for good).
   * @param {Outcome} outcome
   * @returns {boolean}
   */
  function terminal(outcome) {
    return outcome.ok || outcome.kind === 'failure' || (outcome.kind === 'contract' && !outcome.error.retryable);
  }

  //#endregion

  //#region durable keys

  /**
   * The record table of this contract inside the stored value, as a
   * copy-on-write path: nothing the adapter handed out is mutated, so a
   * `write` that throws leaves the stored value exactly as it was
   * whether the adapter returns live references or fresh parses.
   * @param {(table: Record<string, any>) => boolean} update - mutates the
   *   copied table; returns false when nothing changed (no write then)
   * @returns {Promise<void>}
   */
  async function updateTable(update) {
    const raw = await storage?.read();
    /** @type {Record<string, any>} */
    const store = isJsonObject(raw) ? { ...raw } : {};
    /** @type {Record<string, any>} */
    const root = isJsonObject(store[STORAGE_MEMBER]) ? { ...store[STORAGE_MEMBER] } : {};
    /** @type {Record<string, any>} */
    const table = isJsonObject(root[contractId]) ? { ...root[contractId] } : {};
    if (!update(table)) return;
    setObjectMember(root, contractId, table);
    setObjectMember(store, STORAGE_MEMBER, root);
    await storage?.write(store);
  }

  /**
   * @param {string} op
   * @param {string} key
   * @param {string} hash
   */
  function recordKey(op, key, hash) {
    return updateTable((table) => {
      const records = isJsonObject(table[op]) ? { ...table[op] } : {};
      setObjectMember(records, key, { op, key, hash, at: now() });
      setObjectMember(table, op, records);
      return true;
    });
  }

  /**
   * @param {string} op
   * @param {string} key
   */
  function releaseKey(op, key) {
    return updateTable((table) => {
      if (!isJsonObject(table[op]) || !Object.hasOwn(table[op], key)) return false;
      const records = { ...table[op] };
      delete records[key];
      if (Object.keys(records).length === 0) delete table[op];
      else setObjectMember(table, op, records);
      return true;
    });
  }

  /**
   * The records of this contract, read-only.
   * @returns {Promise<Record<string, any>>}
   */
  async function readTable() {
    const raw = await storage?.read();
    const root = isJsonObject(raw) ? raw[STORAGE_MEMBER] : undefined;
    const table = isJsonObject(root) ? root[contractId] : undefined;
    return isJsonObject(table) ? table : {};
  }

  //#endregion

  //#region the client

  /**
   * @param {string} op
   * @param {unknown} [input]
   * @param {InvokeContext} [ctx]
   * @returns {Promise<Outcome>}
   */
  async function invoke(op, input, ctx = {}) {
    const route = routeOf(op);
    if (route.opaque) {
      throw new ContractHostError('JC1005', `client: '${route.id}' is an opaque operation (media ${route.media}); invoke carries JSON only — use client.url(op, input) and fetch the bytes yourself`);
    }
    if (ctx === null || typeof ctx !== 'object') throw host('JC1008', 'ctx must be an object');
    const meta = newMeta(route.id, ctx.attempt);
    const signal = ctx.signal === undefined || ctx.signal === null ? null : ctx.signal;

    // 1. validate — nothing leaves before the same verdict the server would reach
    let value;
    if (!route.hasInput) {
      if (input !== undefined && input !== null) return invalidInput(route, meta, [{ path: '', keyword: 'input' }]);
      value = null;
    }
    else {
      value = inputValue(input);
      const v = verdict(/** @type {(value: unknown) => any} */ (route.validateInput), value);
      if (!v.valid) return invalidInput(route, meta, projectValidationDetails(route.details, v.errors));
    }

    // 2. split by location
    let url;
    let body;
    let headers;
    try {
      url = baseUrl + pathOf(route, value);
      body = bodyOf(route, value);
      headers = headersOf(route, value, ctx);
    }
    catch {
      return invalidInput(route, meta, [{ path: '', keyword: 'encoding' }]);
    }
    if (body !== null) headers['content-type'] = route.media;

    // 3. the idempotency key — generated here, never by the server
    let key = null;
    if (route.idempotency !== 'none') {
      key = typeof ctx.idempotencyKey === 'string' && ctx.idempotencyKey.length > 0 ? ctx.idempotencyKey : String(keys());
      headers['idempotency-key'] = key;
      if (storage !== null) {
        let hash;
        try {
          hash = await canonicalSha256(value);
        }
        catch (err) {
          return invalidInput(route, meta, [{ path: /** @type {any} */ (err)?.dataPath ?? '', keyword: 'canonical' }]);
        }
        try {
          await recordKey(route.id, key, hash);
        }
        catch {
          return failedOutcome('contract', clientError(catalog, 'JC2054', { op: route.id }, null, undefined), meta);
        }
      }
    }

    // 4. send, retrying under the declared policy only
    let outcome;
    let n = 0;
    for (;;) {
      outcome = await send(route, url, headers, body, ctx, signal);
      if (route.retry === null || n >= route.retry.max || !retryable(route, outcome)) break;
      const delay = Math.min(1000 * 2 ** n, BACKOFF_MAX) + Math.floor(Math.random() * BACKOFF_JITTER);
      n++;
      try {
        await sleep(delay, signal === null ? undefined : signal);
      }
      catch {
        outcome = cancelled(route, newMeta(route.id, ctx.attempt));
        break;
      }
    }

    // 5. settle the durable record: a definite answer drops it; a
    // network/cancelled outcome leaves it for `pending()`
    if (key !== null && storage !== null && terminal(outcome)) {
      try {
        await releaseKey(route.id, key);
      }
      catch {
        // a record that cannot be dropped stays pending — the
        // conservative side; the outcome itself is unaffected
      }
    }
    return outcome;
  }

  /**
   * Subscribe to a subscribe operation's stream (docs/CONTRACT-FORMAT.md
   * §19): one `GET` with `accept: text/event-stream`, the SSE events
   * decoded and delivered through the callbacks; snapshots validated
   * against the output schema, `seq` strictly increasing (`JC2092`),
   * silence beyond `2 × heartbeatMs` a `JC2094` network outcome.
   * Reconnection is the caller's: pass the last delivered seq as
   * `lastSeq`.
   * @param {string} op
   * @param {unknown} [input]
   * @param {SubscribeOptions} [options]
   * @returns {{ stop: () => void }}
   * @throws {ContractHostError} `JC1010` for a non-subscribe operation, `JC1008` for a malformed option
   */
  function subscribe(op, input, options = {}) {
    const route = routeOf(op);
    if (route.op.kind !== 'subscribe') {
      throw new ContractHostError('JC1010', `client: '${route.id}' is a ${route.op.kind} operation — subscribe carries streams; use invoke`);
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
    const signal = options.signal === undefined || options.signal === null ? null : options.signal;
    const meta = newMeta(route.id, null);
    const streamPolicy = route.op.policy.stream;
    const heartbeatMs = streamPolicy === null ? 15000 : streamPolicy.heartbeatMs;

    const controller = new AbortController();
    const composed = signal === null
      ? AbortSignal.any([closer.signal, controller.signal])
      : AbortSignal.any([closer.signal, controller.signal, signal]);
    /** @type {ReadableStreamDefaultReader<Uint8Array> | null} */
    let reader = null;
    /** @type {ReturnType<typeof setTimeout> | 0} */
    let watchdog = 0;

    const consumer = createStreamConsumer({
      route: route.outcome,
      catalog,
      meta,
      callbacks: { onSnapshot: options.onSnapshot, onPatch: options.onPatch, onError: options.onError, onEnd: options.onEnd },
      finish: () => {
        if (watchdog !== 0) clearTimeout(watchdog);
        watchdog = 0;
        if (reader !== null) reader.cancel().catch(() => {});
      },
      lastSeq,
    });

    /** Push the silence watchdog forward: any bytes count as life. */
    function resetWatchdog() {
      if (watchdog !== 0) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        consumer.fail(failedOutcome('network',
          outcomeError('JC2094', renderMessage(catalog, STREAM_ERRORS.JC2094.msgid, { op: route.id, ms: 2 * heartbeatMs }), null, null, true), meta));
        controller.abort();
      }, 2 * heartbeatMs);
      /** @type {any} */ (watchdog).unref?.();
    }

    /** @param {import('@jarenjs/core/text/sse').SseEvent} ev */
    function deliver(ev) {
      const parsed = ev.id === null ? NaN : Number.parseInt(ev.id, 10);
      const seq = Number.isFinite(parsed) ? parsed : null;
      let data;
      try {
        data = JSON.parse(ev.data);
      }
      catch {
        data = undefined;
      }
      switch (ev.event) {
        case 'snapshot':
          consumer.snapshot(seq, data);
          break;
        case 'patch':
          consumer.patch(seq, data);
          break;
        case 'error':
          consumer.error(data);
          break;
        case 'end':
          consumer.end(data);
          break;
        // an unknown event name is ignored — SSE's forward compatibility
      }
    }

    (async () => {
      if (closed || (signal !== null && signal.aborted)) {
        consumer.cancel();
        return;
      }
      // 1. validate before anything is sent — the shared pre-send refusal
      let value;
      if (!route.hasInput) {
        if (input !== undefined && input !== null) {
          consumer.fail(invalidInput(route, meta, [{ path: '', keyword: 'input' }]));
          return;
        }
        value = {};
      }
      else {
        value = inputValue(input);
        const v = verdict(/** @type {(value: unknown) => any} */ (route.validateInput), value);
        if (!v.valid) {
          consumer.fail(invalidInput(route, meta, projectValidationDetails(route.details, v.errors)));
          return;
        }
      }
      // 2. the request
      let requestUrl;
      try {
        requestUrl = baseUrl + pathOf(route, value);
      }
      catch {
        consumer.fail(invalidInput(route, meta, [{ path: '', keyword: 'encoding' }]));
        return;
      }
      /** @type {Record<string, string>} */
      const requestHeaders = { ...staticHeaders, accept: STREAM_MEDIA };
      if (lastSeq !== null) requestHeaders['last-event-id'] = String(lastSeq);
      let response;
      try {
        response = await fetchFn(requestUrl, { method: 'GET', headers: requestHeaders, signal: composed });
      }
      catch (err) {
        if (consumer.finished()) return;
        if (composed.aborted || safeName(err) === 'AbortError') consumer.cancel();
        else consumer.fail(failedOutcome('network', clientError(catalog, 'JC2051', { op: route.id, name: safeName(err) ?? typeof err }, null, undefined), meta));
        return;
      }
      // 3. the answer must be a 200 event stream — anything else classifies
      let status;
      let contentType = null;
      try {
        status = response.status;
        const h = response.headers;
        if (h !== null && typeof h === 'object' && typeof h.get === 'function') {
          contentType = h.get('content-type');
          const t = h.get('x-jaren-trace');
          if (typeof t === 'string' && t.length > 0) meta.trace = t;
        }
      }
      catch (err) {
        if (!consumer.finished()) consumer.fail(failedOutcome('network', clientError(catalog, 'JC2051', { op: route.id, name: safeName(err) ?? typeof err }, null, undefined), meta));
        return;
      }
      if (!Number.isInteger(status) || status < 200 || status > 299) {
        let text = null;
        try {
          text = await response.text();
        }
        catch {
          text = null;
        }
        consumer.fail(assembleOutcome(route.outcome, { status, headers: null, text }, meta, catalog));
        return;
      }
      const body = /** @type {any} */ (response).body;
      if (typeof contentType !== 'string' || contentType.toLowerCase().indexOf(STREAM_MEDIA) === -1
        || body === null || body === undefined || typeof body.getReader !== 'function') {
        consumer.fail(failedOutcome('contract',
          outcomeError('JC2090', renderMessage(catalog, STREAM_ERRORS.JC2090.msgid, { op: route.id }), status, null, false), meta));
        return;
      }
      // 4. the event loop under the silence watchdog
      reader = body.getReader();
      const textDecoder = new TextDecoder();
      const sse = createSseEventDecoder();
      resetWatchdog();
      try {
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          if (consumer.finished()) return;
          resetWatchdog();
          for (const ev of sse.feed(textDecoder.decode(chunk, { stream: true }))) {
            deliver(ev);
            if (consumer.finished()) return;
          }
        }
        for (const ev of sse.end()) {
          deliver(ev);
          if (consumer.finished()) return;
        }
        // a stream that ends without an end event is reported as closed
        consumer.end(undefined);
      }
      catch (err) {
        if (consumer.finished()) return;
        if (composed.aborted || safeName(err) === 'AbortError') consumer.cancel();
        else consumer.fail(failedOutcome('network', clientError(catalog, 'JC2051', { op: route.id, name: safeName(err) ?? typeof err }, null, undefined), meta));
      }
      finally {
        if (watchdog !== 0) clearTimeout(watchdog);
        watchdog = 0;
      }
    })();

    return {
      stop: () => {
        consumer.cancel();
        controller.abort();
      },
    };
  }

  /**
   * @param {string} op
   * @param {unknown} [input]
   * @returns {string}
   */
  function url(op, input) {
    const route = routeOf(op);
    const value = inputValue(input);
    if (!isJsonObject(value)) throw host('JC1008', 'url(): input must be an object (or null)');
    if (route.transport.validate === null && route.hasInput) {
      const transport = /** @type {import('../compile.js').CompiledInput} */ (route.op.input).transport;
      if (transport !== null && transport.members.path.length + transport.members.query.length > 0) {
        // the path/query members only, rooted on the contract document so
        // their `$ref`s resolve as they do for the validator; compiled on
        // first use because only a URL builder needs it
        const names = [...transport.members.path, ...transport.members.query];
        /** @type {Record<string, unknown>} */
        const pick = {};
        for (let i = 0; i < names.length; i++) setObjectMember(pick, names[i], transport.schemas[names[i]]);
        if (validator === null) validator = new JarenValidator({ collectErrors: true, skipErrors: false });
        route.transport.validate = validator.compile({
          ...contract.doc, type: 'object', properties: pick, required: transport.required.filter((r) => names.includes(r)),
        });
      }
    }
    if (route.transport.validate !== null) {
      const v = verdict(route.transport.validate, value);
      if (!v.valid) throw host('JC1008', `url(): the path/query members of operation '${route.id}' fail their schema`);
    }
    try {
      return baseUrl + pathOf(route, value);
    }
    catch {
      throw host('JC1008', `url(): a path/query member of operation '${route.id}' cannot be encoded`);
    }
  }

  /**
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<Negotiation>}
   */
  async function negotiate(options = {}) {
    const signal = options.signal === undefined || options.signal === null ? null : options.signal;
    /**
     * @param {Negotiation['reason']} reason
     * @param {Negotiation['server']} server
     * @param {string | null} code
     * @param {Record<string, unknown>} params
     * @returns {Negotiation}
     */
    const result = (reason, server, code, params) => ({
      compatible: code === null,
      reason,
      server,
      error: code === null ? null : { code, message: renderMessage(catalog, CLIENT_ERRORS[/** @type {keyof typeof CLIENT_ERRORS} */ (code)].msgid, params) },
    });
    let response;
    try {
      response = await fetchFn(baseUrl + wellKnown, { method: 'GET', headers: { ...staticHeaders }, signal: composeSignal(signal) });
    }
    catch (err) {
      return result('unreachable', null, 'JC2051', { op: 'the negotiation', name: safeName(err) ?? typeof err });
    }
    let doc;
    try {
      if (response.status !== 200) throw new Error('status');
      doc = JSON.parse(await response.text());
    }
    catch {
      return result('not-a-contract', null, 'JC2056', { id: contractId });
    }
    if (!isJsonObject(doc) || doc.$contract !== '0.1' || !Array.isArray(doc.operations)) {
      return result('not-a-contract', null, 'JC2056', { id: contractId });
    }
    const server = {
      id: typeof doc.id === 'string' ? doc.id : null,
      version: typeof doc.version === 'string' ? doc.version : null,
      compat: Array.isArray(doc.compat) ? doc.compat.filter((/** @type {unknown} */ v) => typeof v === 'string') : [],
      revision: typeof doc.revision === 'string' ? doc.revision : null,
    };
    if (server.id !== null && contract.id !== null && server.id !== contract.id) {
      return result('not-a-contract', server, 'JC2056', { id: contractId });
    }
    // the same contract on the other end: its revision rides in
    // meta.revision of every subsequent outcome, compatible or not —
    // correlation data, never the compatibility decision (that is the
    // version rule below)
    serverRevision = server.revision;
    const reason = compatReason(contract, server);
    if (reason !== null) return result(reason, server, null, {});
    return result('version-mismatch', server, 'JC2057', { id: contractId, server: server.version, client: contract.version });
  }

  /**
   * @returns {Promise<{ op: string, key: string }[]>}
   */
  async function pending() {
    if (storage === null) return [];
    const table = await readTable();
    /** @type {{ op: string, key: string }[]} */
    const out = [];
    const ops = Object.keys(table);
    for (let i = 0; i < ops.length; i++) {
      const records = table[ops[i]];
      if (!isJsonObject(records)) continue;
      const ks = Object.keys(records);
      for (let j = 0; j < ks.length; j++) out.push({ op: ops[i], key: ks[j] });
    }
    return out;
  }

  /** @type {HttpClientCapabilities} */
  const capabilities = Object.freeze({
    name: 'http',
    status: true,
    headers: true,
    media: true,
    etag: true,
    idempotency: true,
    durableKeys: storage !== null,
    stream: true,
    cancel: 'signal',
  });

  return Object.freeze({
    invoke,
    subscribe,
    url,
    negotiate,
    pending,
    capabilities,
    contract,
    describe: () => contract.describe(),
    close: () => {
      closed = true;
      closer.abort();
    },
  });

  //#endregion
}

export {
  okOutcome, failedOutcome, makeMeta, outcomeError, isOutcome, assembleOutcome, prepareOutcomeRoute, hostFailureOutcome,
  OUTCOME_ERROR_MEMBERS, OUTCOME_META_MEMBERS,
} from './outcome.js';
