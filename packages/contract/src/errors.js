//@ts-check
/**
 * @file Error types for @jarenjs/contract, built on `@jarenjs/core`'s
 * coded contract: every failure carries a stable `code`, a bare
 * `reason`, a composed `message`, and — for compile errors — the
 * `docPath` of the offending member of the contract document. The
 * normative table lives in docs/CONTRACT-FORMAT.md §6, proven in sync
 * with `CONTRACT_CODES` below by a test.
 *
 * The `JC` code space is partitioned by range so the layers of this
 * package never collide:
 *
 *  - `JC0001–JC0049` document compile (`ContractCompileError`)
 *  - `JC0050–JC0069` binding declaration and projection compile
 *    (`JC0060`: the OpenAPI keyword policy)
 *  - `JC1001–JC1049` host programming errors (thrown `TypeError`s)
 *  - `JC2001–JC2049` http request-time (`ContractRuntimeError`)
 *  - `JC2050–JC2069` client-side
 *  - `JC2070–JC2089` port/local bindings
 *  - `JC2090–JC2109` stream binding
 *
 * The document-compile range, the projection code, the host range, the
 * http request-time range, the client range and the port/local range are
 * populated; stream is reserved for its binding and is listed here so a
 * later addition lands in its range rather than at the next free number.
 */

import { CodedError } from '@jarenjs/core/errors';

/**
 * The runtime code table: one entry per code this package can raise,
 * proven in sync with CONTRACT-FORMAT.md §6's normative table by a test.
 */
export const CONTRACT_CODES = Object.freeze({
  JC0001: 'the document is not a well-formed contract object: not an object, $contract is not "0.1", $defs is not a map of schemas, a member is not a JSON value, or a member threw when read',
  JC0002: 'operations is not an object with at least one member',
  JC0003: 'an operation id is not a dotted lowercase identifier',
  JC0004: 'kind is none of read, command, subscribe',
  JC0005: 'input is not a schema whose effective type is object',
  JC0006: 'output is absent or not a schema',
  JC0007: 'a $ref resolves neither within the document nor against the registered schemas',
  JC0008: 'http.path is not a valid path template',
  JC0009: 'a path variable, http.in key or http.body names no input member, or a member is mapped to a location it cannot travel in',
  JC0010: 'two operations share method and canonical path shape',
  JC0011: 'errors is malformed: not an object, a code is not a lowercase hyphenated word, a status is not a 100–599 integer, or a schema is not a schema',
  JC0012: 'http.method is not an uppercase token of the supported set, http.status is not a 200–299 integer, or http.media is not a media type',
  JC0013: 'an unknown member in a closed object (the document root, an operation, policy, http, limits, retry, or an error declaration)',
  JC0014: 'a policy member is mistyped or outside its declared set',
  JC0015: 'id, version, compat or an operation doc is mistyped',
  JC0016: 'an operation bound to GET or HEAD carries a body-located member (a GET body)',
  JC0017: 'an opaque operation (a non-JSON http.media) declares a body-located member — its body is bytes the contract never decodes, so the member could never be validated',
  JC0018: 'a subscribe operation declares a policy.task other than switch — a subscription slot is replaced, never queued',
  JC0019: 'a subscribe operation is bound to a method other than GET — a stream is fetched, not sent',
  JC0020: 'a subscribe operation declares a policy.idempotency other than none — a subscription registers, it does not commit',
  // ——— projection compile (ContractCompileError, docPath into the contract document) ———
  JC0060: 'the OpenAPI projection met a schema keyword it cannot map honestly: a boolean required (draft-04 style) or a same-document $ref that lands outside $defs (both dropped and reported under lenient), or a components member inside a schema',
  JC0061: 'the public projection is not canonicalizable, so no revision exists — a string with an unpaired surrogate, say; docPath points at the offending value inside the projection',
  // ——— host programming errors (thrown ContractHostError, a TypeError) ———
  JC1001: 'serveHttp, serveLocal or servePort: handlers is not an object, a key names no operation of the contract, a value is not a function, or an option (a channel without postMessage, say) is malformed',
  JC1002: 'serveHttp, serveLocal or servePort: an operation has no handler (and, on serveHttp, options.partial is not set; an opaque operation needs none on the status-less bindings)',
  JC1003: 'a binding cannot carry a declared feature: an operation declares idempotency and serveHttp was given no ledger',
  JC1004: 'dispatch received a malformed request object (method or url not a string, headers not an object, body not a string, Uint8Array or null)',
  JC1005: 'a client or the contract effect was asked for an operation the contract does not declare, or invoke was asked for an opaque operation (use client.url on http; the status-less bindings cannot carry it at all)',
  JC1006: 'ctx.status(n) was called with a status that is not an integer in 200–299',
  JC1007: 'contractAppBinding: ops names an operation the contract does not declare, or namespace/statePath is malformed',
  JC1008: 'openHttpClient, openPortClient, client.url, createContractEffect, createContractSubscription or a projection (publicProjection, toOpenApi, toTypeScript, toMarkdown, contractTools): an argument or option is malformed (not a compiled contract, fetch/keys/sleep/createTaskEffect/projectError not a function, storage without read/write, a non-object input to url, an ops entry naming no or an opaque operation, a tool name outside ^[a-zA-Z0-9_-]{1,64}$ or shared by two operations)',
  JC1009: 'encodeSseEvent (the stream wire): an event, id or data string the SSE frame cannot carry — a bare carriage return inside data, a line terminator inside event or id',
  JC1010: 'client.subscribe was asked for an operation that is not a subscribe operation (invoke carries reads and commands; subscribe carries streams)',
  // ——— http request-time (ContractRuntimeError, mapped onto the wire) ———
  JC2001: 'no operation matches the request method and path (404)',
  JC2002: 'the path shape is served under other methods (405, Allow lists them)',
  JC2003: 'the request body exceeds policy.limits.maxBodyBytes, by content-length or by read length (413)',
  JC2004: 'a body-carrying operation received a content-type that is not its declared media (415)',
  JC2005: 'the request body is present and is not valid JSON, or its bytes are not valid UTF-8 (400)',
  JC2006: 'the reassembled input fails the operation\'s input validator (400)',
  JC2007: 'the operation requires an Idempotency-Key header and none was sent (400)',
  JC2008: 'the handler threw a non-declared error, rejected, or returned a hostile value (500; onError sees it)',
  JC2009: 'the idempotency ledger reports the key in progress (retryable) or bound to a different request (mismatch) (409)',
  JC2010: 'the handler value fails the output validator or a declared error\'s details fail its schema — the server broke the contract (500)',
  JC2011: 'the request path carries a malformed percent-escape (400)',
  JC2012: 'the query string is not decodable (400)',
  JC2013: 'the operation has no handler on this partial server (501)',
  JC2014: 'the If-Match precondition does not match the entity tag the handler armed (412)',
  JC2015: 'a declared header member is repeated when its schema is scalar, or fails transport decoding (400)',
  // ——— client-side (outcomes of invoke; never thrown) ———
  JC2050: 'the input fails the operation\'s input validator before anything was sent (kind contract)',
  JC2051: 'the request did not complete: the transport rejected or timed out (kind network, retryable)',
  JC2052: 'the request was cancelled through the caller\'s signal or client.close() (kind cancelled)',
  JC2053: 'a success response is not JSON or fails the operation\'s output validator (kind contract)',
  JC2054: 'the durable idempotency-key storage threw before the request was sent (kind contract)',
  JC2055: 'the server answered a status with a body that is neither a declared error nor a taxonomy error (kind contract; retryable for 5xx and 429)',
  JC2056: 'negotiation: the server does not answer a jaren-contract description at the well-known path, or describes another contract id',
  JC2057: 'negotiation: the server speaks a version neither end declares compatible',
  JC2058: 'the host threw while invoking an operation through the contract effect — projected into an outcome, never a string',
  // ——— port/local bindings (outcomes of invoke or wire error frames; never thrown) ———
  JC2070: 'the handler failed on a local or port serving host: it threw a non-declared error, rejected, answered an undeclared code, or broke its output or error-details schema (kind contract; onError sees the cause)',
  JC2071: 'a request frame names no operation this channel serves (unknown, or opaque — a port carries JSON only)',
  JC2072: 'a port request got no answer within timeoutMs (kind network, retryable)',
  JC2073: 'a response frame addressed to this client does not match the frame grammar (kind contract)',
  JC2074: 'the channel refused the request frame — closed or detached (kind network)',
  // ——— stream binding (outcomes of subscribe, or wire error events; never thrown) ———
  JC2090: 'the server answered a subscribe request with a non-stream response (kind contract)',
  JC2091: 'a snapshot fails the operation\'s output validator — the server broke the contract; the stream ends with an error event carrying this code',
  JC2092: 'a stream event\'s seq is not strictly greater than the last one delivered (kind contract, client-side)',
  JC2093: 'the stream ended with a server error event whose code the operation does not declare (kind contract; a declared code is a failure outcome under its own code)',
  JC2094: 'the stream went silent for twice policy.stream.heartbeatMs (kind network, client-side)',
  JC2095: 'a requested resume was refused — informational, carried as resumed:false in the fresh snapshot\'s event data, never an outcome',
});

/**
 * A defect in the contract document itself, raised while
 * `compileContract` compiles it. Every instance carries the JSON
 * Pointer of the offending member as `docPath` (`''` is the document
 * root; an operation id is one reference token, so a dotted id such as
 * `product.save` appears unescaped and only `~` and `/` are escaped per
 * RFC 6901). The codes are `JC0001–JC0049` (docs/CONTRACT-FORMAT.md §6).
 */
export class ContractCompileError extends CodedError {
  /**
   * @param {string} code
   * @param {string} reason - The bare reason; `message` is composed per
   *   the coded contract.
   * @param {string} [docPath] - JSON Pointer into the contract document;
   *   `''` is the document root, `undefined` means no location.
   * @param {Error} [cause]
   */
  constructor(code, reason, docPath, cause) {
    super('ContractCompileError', code, reason, docPath,
      cause !== undefined ? { cause } : undefined);
  }
}

/**
 * A request-time failure (`JC2xxx`) as it exists in-process before a
 * binding maps it onto its wire: a stable `code`, a `msgid`
 * (`contract/<slug>`) with `params` for the locale catalogs, and the
 * transport hints a binding may carry (`status`, `retryable`). It has no
 * document location — a request is not a document — so `docPath` is
 * always `undefined`. Never thrown across a binding: a binding settles
 * it into a wire error.
 */
export class ContractRuntimeError extends CodedError {
  /**
   * @param {string} code
   * @param {string} reason - The bare English reason; `message` is
   *   composed per the coded contract.
   * @param {{ msgid: string, params?: Record<string, unknown>, status?: number, retryable?: boolean, cause?: unknown }} options
   *   `msgid` is the catalog key; `cause` is installed as an own property
   *   exactly when the key is present (`hasOwn` form).
   */
  constructor(code, reason, options) {
    super('ContractRuntimeError', code, reason, undefined,
      options !== undefined && Object.hasOwn(options, 'cause') ? { cause: options.cause } : undefined);
    /** @type {string} */
    this.msgid = options.msgid;
    /** @type {Record<string, unknown>} */
    this.params = options.params ?? {};
    /** @type {number | undefined} */
    this.status = options.status;
    /** @type {boolean | undefined} */
    this.retryable = options.retryable;
  }
}

/**
 * A host programming error at a binding's construction or use — a
 * handler table that names no operation, a missing ledger for a declared
 * idempotency policy, a malformed request object handed to `dispatch`, a
 * `ctx.status` outside 2xx. `TypeError`, thrown, never a wire response:
 * the mistake is the host's, not the request's. The codes are
 * `JC1001–JC1049` (docs/CONTRACT-FORMAT.md §7).
 */
export class ContractHostError extends TypeError {
  /**
   * @param {string} code
   * @param {string} reason - The bare reason; `message` is `${code}: ${reason}`.
   */
  constructor(code, reason) {
    super(`${code}: ${reason}`);
    this.name = 'ContractHostError';
    /** @type {string} */
    this.code = code;
    /** @type {string} */
    this.reason = reason;
  }
}

/**
 * A declared operation failure as a handler returns it: pure JSON — the
 * declared error `code`, the catalog `params` for its message, the wire
 * `details` (validated against the declaration's schema when it has
 * one) and whether the caller may retry. Made by `ContractFailure` and
 * recognized by identity, never by shape: a hostile handler value cannot
 * forge one and classifying it reads no property.
 * @typedef {Object} ContractFailureValue
 * @property {string} code
 * @property {Readonly<Record<string, unknown>>} params
 * @property {unknown} details - `undefined` when the failure carries none
 * @property {boolean | null} retryable - `null` defers to the operation's retry policy
 */

/** The identity brand of every value `ContractFailure` produced. */
const failures = new WeakSet();

/**
 * Make a declared failure value: what a handler returns (or `ctx.fail`
 * returns for it) to answer with one of the operation's declared error
 * codes. A branded plain-object factory, not a class: the value crosses
 * no binding as an `Error` and carries only JSON.
 * @param {string} code - A code the operation declares in `errors`
 * @param {Record<string, unknown>} [params] - Message parameters for the catalog
 * @param {unknown} [details] - The wire `details` member
 * @param {{ retryable?: boolean }} [options] - `retryable` overrides the
 *   default taken from the operation's `policy.retry.on`
 * @returns {ContractFailureValue}
 */
export function ContractFailure(code, params, details, options) {
  const value = Object.freeze({
    code,
    params: Object.freeze(params === undefined || params === null ? {} : { ...params }),
    details,
    retryable: options !== undefined && options !== null && typeof options.retryable === 'boolean' ? options.retryable : null,
  });
  failures.add(value);
  return value;
}

/**
 * True exactly for a value `ContractFailure` produced. Reads nothing
 * from the value, so it is total for a hostile object.
 * @param {unknown} value
 * @returns {value is ContractFailureValue}
 */
export function isContractFailure(value) {
  return (typeof value === 'object' && value !== null) && failures.has(value);
}
