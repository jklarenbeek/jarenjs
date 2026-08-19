//@ts-check
/**
 * @file The wire shapes of the HTTP server binding: the request-time
 * error taxonomy as data (code → status, msgid, retryable), the error
 * body every non-2xx JSON response carries, header reading, media
 * matching, entity-tag comparison and the query decoder. Nothing here
 * calls a handler or touches a ledger; `dispatch.js` composes these.
 *
 * Every response header name is lowercase; every error response carries
 * `x-jaren-trace` (the server trace, `requestId` in the body) and
 * `cache-control: no-store`. A message is rendered from the msgid
 * through the catalog and never interpolates a request value — the
 * parameters are the operation id, a declared limit, a media type, a
 * method list, a declared header name or a declared error code
 * (docs/CONTRACT-FORMAT.md §7).
 */

import { isJsonValue, setObjectMember } from '@jarenjs/core/object';

import { contractCatalogEn } from '../messages.js';

/**
 * A request as the binding sees it — what an adapter builds and what a
 * test hands to `dispatch` directly. `url` is origin-less: the path plus
 * an optional `?query`; header names are lowercase; a header value is a
 * string, or an array of strings when the adapter can see repeated field
 * lines; `body` is the bytes/text as received (`null` for none);
 * `signal` is the request's abort signal when the host has one.
 * @typedef {Object} HttpRequest
 * @property {string} method
 * @property {string} url
 * @property {Readonly<Record<string, string | readonly string[]>>} headers
 * @property {string | Uint8Array | null} body
 * @property {AbortSignal | null} [signal]
 */

/**
 * A response as the binding answers it: a status, lowercase header names,
 * and a body that is a string (JSON text), bytes (an opaque operation) or
 * `null` (HEAD, 204, 304).
 * @typedef {Object} HttpResponse
 * @property {number} status
 * @property {Readonly<Record<string, string>>} headers
 * @property {string | Uint8Array | null} body
 */

/**
 * The D7 error body of every non-2xx JSON response.
 * @typedef {Object} WireErrorBody
 * @property {string} code - a `JC2xxx` code, or the declared error code
 * @property {string} message
 * @property {string} requestId - the server trace (`x-jaren-trace`)
 * @property {unknown} [details]
 * @property {boolean} retryable
 */

/**
 * The taxonomy row of one request-time code.
 * @typedef {{ status: number, msgid: string, retryable: boolean }} WireErrorRow
 */

/**
 * The request-time taxonomy as data: code → `{ status, msgid, retryable }`.
 * The normative table is docs/CONTRACT-FORMAT.md §7; a test holds the
 * two equal, and equal to `CONTRACT_CODES` and the English catalog. The
 * client binding assembles outcomes from exactly these statuses.
 */
export const HTTP_ERRORS = Object.freeze({
  JC2001: Object.freeze({ status: 404, msgid: 'contract/not-found', retryable: false }),
  JC2002: Object.freeze({ status: 405, msgid: 'contract/method-not-allowed', retryable: false }),
  JC2003: Object.freeze({ status: 413, msgid: 'contract/body-too-large', retryable: false }),
  JC2004: Object.freeze({ status: 415, msgid: 'contract/unsupported-media', retryable: false }),
  JC2005: Object.freeze({ status: 400, msgid: 'contract/malformed-json', retryable: false }),
  JC2006: Object.freeze({ status: 400, msgid: 'contract/invalid-input', retryable: false }),
  JC2007: Object.freeze({ status: 400, msgid: 'contract/idempotency-key-required', retryable: false }),
  JC2008: Object.freeze({ status: 500, msgid: 'contract/handler-failed', retryable: false }),
  JC2009: Object.freeze({ status: 409, msgid: 'contract/idempotency-conflict', retryable: false }),
  JC2010: Object.freeze({ status: 500, msgid: 'contract/invalid-output', retryable: false }),
  JC2011: Object.freeze({ status: 400, msgid: 'contract/malformed-path', retryable: false }),
  JC2012: Object.freeze({ status: 400, msgid: 'contract/malformed-query', retryable: false }),
  JC2013: Object.freeze({ status: 501, msgid: 'contract/not-implemented', retryable: false }),
  JC2014: Object.freeze({ status: 412, msgid: 'contract/precondition-failed', retryable: false }),
  JC2015: Object.freeze({ status: 400, msgid: 'contract/invalid-header', retryable: false }),
});

/** The msgid of a declared operation error that has no message of its own. */
export const HANDLER_ERROR_MSGID = 'contract/handler-error';

/** The default JSON media of the binding. */
export const JSON_MEDIA = 'application/json';

/** The response `content-type` of a JSON body. */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** The catalog fallback for a code that renders in no catalog. */
const NO_MESSAGE = 'request failed';

//#region messages

/**
 * A compiled catalog: msgid → render.
 * @typedef {Readonly<Record<string, (params: object, error?: object) => string>>} Catalog
 */

/**
 * Render a message: the host catalog first, the English catalog second,
 * a fixed fallback last. TOTAL: a rendering closure that throws yields
 * the fallback rather than escaping into the response path.
 * @param {Catalog | null} catalog - the host catalog, or null for English only
 * @param {string} msgid
 * @param {Record<string, unknown>} params
 * @returns {string}
 */
export function renderMessage(catalog, msgid, params) {
  let render = catalog !== null ? catalog[msgid] : undefined;
  if (render === undefined) render = contractCatalogEn[msgid];
  if (render === undefined) return NO_MESSAGE;
  try {
    const text = render(params);
    return typeof text === 'string' ? text : NO_MESSAGE;
  }
  catch {
    return NO_MESSAGE;
  }
}

//#endregion

//#region headers

/**
 * The single string value of a header: a repeated field is combined with
 * `, ` (RFC 9110 §5.3), an absent one is `undefined`. For the protocol
 * headers the binding itself reads (`content-type`, `content-length`,
 * `idempotency-key`, `if-match`, `if-none-match`).
 * @param {Readonly<Record<string, string | readonly string[]>>} headers
 * @param {string} name - lowercase
 * @returns {string | undefined}
 */
export function headerValue(headers, name) {
  const v = headers[name];
  if (v === undefined || typeof v === 'string') return v;
  if (Array.isArray(v)) {
    if (v.length === 0) return undefined;
    if (v.length === 1) return typeof v[0] === 'string' ? v[0] : undefined;
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (typeof v[i] !== 'string') return undefined;
      out += i === 0 ? v[i] : ', ' + v[i];
    }
    return out;
  }
  return undefined;
}

/**
 * The declared `content-length` as a non-negative integer, or `-1` when
 * absent or not a plain decimal number (a malformed value never blocks
 * the read-length check that follows).
 * @param {Readonly<Record<string, string | readonly string[]>>} headers
 * @returns {number}
 */
export function contentLength(headers) {
  const raw = headerValue(headers, 'content-length');
  if (raw === undefined || raw.length === 0 || raw.length > 15) return -1;
  let n = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i) - 48;
    if (c < 0 || c > 9) return -1;
    n = n * 10 + c;
  }
  return n;
}

/**
 * Whether a request `content-type` names the operation's media:
 * type/subtype compared case-insensitively, parameters ignored, and a
 * `+json` structured-syntax suffix accepted for `application/json`.
 * @param {string | undefined} contentType
 * @param {string} media - the operation's declared media
 * @returns {boolean}
 */
export function mediaMatches(contentType, media) {
  if (contentType === undefined) return false;
  const bare = bareMedia(contentType);
  const want = bareMedia(media);
  if (bare === want) return true;
  return want === JSON_MEDIA && bare.endsWith('+json') && bare.indexOf('/') !== -1;
}

/**
 * `type/subtype` of a media type, lowercased, parameters and whitespace
 * dropped.
 * @param {string} value
 * @returns {string}
 */
function bareMedia(value) {
  const semi = value.indexOf(';');
  return (semi === -1 ? value : value.slice(0, semi)).trim().toLowerCase();
}

/**
 * The byte length of a body — text measured as UTF-8. Cheap on the
 * common path: a string shorter than the limit in code units cannot
 * exceed it, and one longer than a third of the limit in code units is
 * measured exactly only when it could.
 * @param {string | Uint8Array} body
 * @param {number} limit
 * @returns {boolean} true when the body exceeds `limit` bytes
 */
export function exceedsBytes(body, limit) {
  if (typeof body !== 'string') return body.byteLength > limit;
  const units = body.length;
  if (units * 3 <= limit) return false;
  if (units > limit) return true;
  return new TextEncoder().encode(body).byteLength > limit;
}

//#endregion

//#region entity tags

/**
 * Parse an `If-Match`/`If-None-Match` field into its opaque tags. `*` is
 * reported as `null` in the list; a weak indicator is dropped
 * (`W/"x"` → `x`) — the caller decides weak/strong comparison because a
 * strong comparison must reject weak tags, which `weak[i]` records.
 * @param {string} value
 * @returns {{ any: boolean, tags: string[], weak: boolean[] }}
 */
export function parseEntityTags(value) {
  /** @type {string[]} */
  const tags = [];
  /** @type {boolean[]} */
  const weak = [];
  let any = false;
  const parts = value.split(',');
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i].trim();
    if (part === '*') {
      any = true;
      continue;
    }
    let isWeak = false;
    if (part.startsWith('W/') || part.startsWith('w/')) {
      isWeak = true;
      part = part.slice(2);
    }
    if (part.length >= 2 && part.charCodeAt(0) === 0x22 && part.charCodeAt(part.length - 1) === 0x22) {
      part = part.slice(1, -1);
    }
    else if (part.length === 0) continue;
    tags.push(part);
    weak.push(isWeak);
  }
  return { any, tags, weak };
}

/**
 * Whether a conditional header matches the tag the handler armed.
 * Weak comparison ignores the weak indicators (RFC 9110 §8.8.3.2);
 * strong comparison requires both tags strong.
 * @param {string} header - the raw `if-match`/`if-none-match` value
 * @param {string} tag - the armed opaque tag
 * @param {boolean} tagStrong - whether the armed tag is strong
 * @param {boolean} strong - strong comparison
 * @returns {boolean}
 */
export function entityTagMatches(header, tag, tagStrong, strong) {
  const parsed = parseEntityTags(header);
  if (parsed.any) return true;
  for (let i = 0; i < parsed.tags.length; i++) {
    if (parsed.tags[i] !== tag) continue;
    if (!strong || (tagStrong && !parsed.weak[i])) return true;
  }
  return false;
}

/**
 * The `etag` header value of an armed tag.
 * @param {string} tag
 * @param {boolean} strong
 * @returns {string}
 */
export function formatEntityTag(tag, strong) {
  return (strong ? '"' : 'W/"') + tag + '"';
}

//#endregion

//#region query

/**
 * Decode a query string into the declared members of an input object:
 * only declared names are set (an undeclared key is never merged, so no
 * request can smuggle a member); a `repeated` member collects every
 * occurrence into an array, every other member is last-wins; a `+` is a
 * space and escapes decode as `application/x-www-form-urlencoded`
 * (`URLSearchParams`). Returns `false` when the query is not decodable
 * (a malformed percent-escape or invalid UTF-8) — the `JC2012` case.
 * @param {string} query - the part after `?`, possibly empty
 * @param {ReadonlySet<string>} declared - the query member names
 * @param {ReadonlySet<string>} repeated - the array-typed ones
 * @param {Record<string, unknown>} out - the input object under assembly
 * @returns {boolean} false when not decodable
 */
export function decodeQuery(query, declared, repeated, out) {
  if (query.length === 0) return true;
  // URLSearchParams never throws: it keeps a malformed escape as its
  // literal text and replaces invalid UTF-8; both are "not decodable"
  // for a contract, so they are detected first (only when an escape is
  // present) with the strict decoder
  if (query.indexOf('%') !== -1) {
    try {
      decodeURIComponent(query);
    }
    catch {
      return false;
    }
  }
  const params = new URLSearchParams(query);
  for (const [name, value] of params) {
    if (!declared.has(name)) continue;
    if (repeated.has(name)) {
      const list = out[name];
      if (Array.isArray(list)) list.push(value);
      else setObjectMember(out, name, [value]);
    }
    else setObjectMember(out, name, value);
  }
  return true;
}

//#endregion

//#region the error response

/**
 * The details member of a validation failure by policy: `none` → absent,
 * `paths` → `[{ path, keyword }]`, `full` → the validator's own error
 * records (`toJSON()` when it has one) with their `params`.
 * @param {'none' | 'paths' | 'full'} policy
 * @param {any[]} errors - the validator's error list
 * @returns {unknown}
 */
export function projectValidationDetails(policy, errors) {
  if (policy === 'none' || !Array.isArray(errors)) return undefined;
  const out = new Array(errors.length);
  for (let i = 0; i < errors.length; i++) {
    const e = errors[i];
    if (policy === 'paths') {
      out[i] = {
        path: e !== null && typeof e === 'object' && typeof e.instancePath === 'string' ? e.instancePath : '',
        keyword: e !== null && typeof e === 'object' && typeof e.keyword === 'string' ? e.keyword : 'unknown',
      };
    }
    else {
      out[i] = e !== null && typeof e === 'object' && typeof e.toJSON === 'function' ? e.toJSON() : e;
    }
  }
  return out;
}

/**
 * Build the D7 error body and the response around it. `override` is the
 * host's `errorBody` option: called with the wire record (the body plus
 * `status`) and the request context; TOTAL — a projector that throws or
 * returns a non-JSON value falls back to the D7 shape.
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {string} trace
 * @param {unknown} details - `undefined` for none
 * @param {boolean} retryable
 * @param {Readonly<Record<string, string>> | null} extraHeaders - `allow`, `retry-after`, `etag`
 * @param {((wire: WireErrorBody & { status: number }, ctx: any) => unknown) | null} override
 * @param {any} ctx - the request context, or null before an operation matched
 * @returns {HttpResponse}
 */
export function errorResponse(status, code, message, trace, details, retryable, extraHeaders, override, ctx) {
  /** @type {WireErrorBody & { status: number }} */
  const wire = details === undefined
    ? { code, message, requestId: trace, retryable, status }
    : { code, message, requestId: trace, details, retryable, status };
  let body;
  if (override !== null) {
    try {
      const projected = override(wire, ctx);
      body = projected !== undefined && isJsonValue(projected) ? projected : null;
    }
    catch {
      body = null;
    }
  }
  else body = null;
  if (body === null) {
    body = details === undefined
      ? { code, message, requestId: trace, retryable }
      : { code, message, requestId: trace, details, retryable };
  }
  /** @type {Record<string, string>} */
  const headers = {
    'content-type': JSON_CONTENT_TYPE,
    'x-jaren-trace': trace,
    'cache-control': 'no-store',
  };
  if (extraHeaders !== null) {
    const names = Object.keys(extraHeaders);
    for (let i = 0; i < names.length; i++) headers[names[i]] = extraHeaders[names[i]];
  }
  return { status, headers, body: JSON.stringify(body) };
}

//#endregion
