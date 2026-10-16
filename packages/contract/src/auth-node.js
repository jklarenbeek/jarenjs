//@ts-check
/**
 * @file Server-side credential checks at a Node host: an HS256 bearer
 * token (a compact JWS whose payload is JWT claims, RFC 7515/7519) and
 * a request signature over bytes the host assembled — the raw request
 * body `identify` receives under `serveHttp`'s `identifyBody` among
 * them. Synchronous, `node:crypto` only; keys, clock and policy are the
 * host's, and nothing is retained between calls. The browser root never
 * imports this module.
 */
import { ContractHostError, ContractRuntimeError } from './errors.js';
import { bytesMatch, decodeBase64url, hmacSha256, isKeyBytes } from './node-hmac.js';

/**
 * @typedef {Object} VerifyHs256Options
 * @property {Uint8Array} key - the shared secret, 32–1024 bytes
 * @property {number | (() => number)} now - epoch milliseconds, or a clock answering them; no implicit clock
 * @property {number} [leewayMs=0] - clock skew tolerated on `exp` and `nbf`, a non-negative safe integer
 * @property {string} [audience] - when given, `aud` (a string, or an array of strings) must name it
 * @property {string} [issuer] - when given, `iss` must equal it
 */

/** The longest token read, in characters; checked before anything is decoded. */
const MAX_TOKEN = 16384;
const OPTIONS = new Set(['key', 'now', 'leewayMs', 'audience', 'issuer']);
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** @param {string} reason @returns {never} */
function hostError(reason) {
  throw new ContractHostError('JC1016', reason);
}

/** @param {string} code @param {string} reason @returns {never} */
function refuse(code, reason) {
  throw new ContractRuntimeError(code, reason, {
    msgid: 'contract/invalid-input', params: { op: 'token' }, status: 401, retryable: false,
  });
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A base64url segment holding a JSON object, or the refusal. @param {string} text @returns {Record<string, unknown>} */
function jsonSegment(text) {
  const bytes = decodeBase64url(text) ?? refuse('JC2140', 'a token segment is not canonical base64url');
  let value;
  try {
    value = JSON.parse(utf8.decode(bytes));
  }
  catch {
    return refuse('JC2140', 'a token segment is not a UTF-8 JSON text');
  }
  return record(value) ? value : refuse('JC2140', 'a token segment is not a JSON object');
}

/** @param {unknown} options */
function admit(options) {
  if (!record(options)) hostError('options must be an object { key, now, leewayMs?, audience?, issuer? }');
  for (const name of Object.keys(options)) if (!OPTIONS.has(name)) hostError(`option '${name}' is not one verifyHs256Token reads`);
  if (!isKeyBytes(options.key)) hostError('key must be a Uint8Array of 32–1024 bytes (RFC 7518 §3.2: no shorter than the MAC)');
  let now;
  try {
    now = typeof options.now === 'function' ? options.now() : options.now;
  }
  catch {
    hostError('the clock threw');
  }
  if (!Number.isSafeInteger(now) || /** @type {number} */ (now) < 0) hostError('now must be epoch milliseconds, or a clock answering them');
  const leeway = options.leewayMs === undefined ? 0 : options.leewayMs;
  if (!Number.isSafeInteger(leeway) || /** @type {number} */ (leeway) < 0) hostError('leewayMs must be a non-negative safe integer');
  for (const name of ['audience', 'issuer']) {
    const v = options[name];
    if (v !== undefined && (typeof v !== 'string' || v.length === 0)) hostError(`${name} must be a non-empty string`);
  }
  return {
    key: /** @type {Uint8Array} */ (options.key), now: /** @type {number} */ (now), leeway: /** @type {number} */ (leeway),
    audience: /** @type {string | undefined} */ (options.audience), issuer: /** @type {string | undefined} */ (options.issuer),
  };
}

/**
 * Verify an HS256 bearer token and answer its claims. The algorithm is
 * fixed: a header whose `alg` is anything but `"HS256"` (`none`, another
 * HMAC, an asymmetric one, a different spelling), or that names `crit`
 * extensions, is refused — the header never chooses the verification.
 * The signature is HMAC-SHA256 over the signing input, compared in
 * constant time. `exp` is required (a NumericDate, seconds): the token
 * is expired once `now >= exp + leeway`; when `nbf` is present it is not
 * yet valid while `now < nbf - leeway`. `aud` and `iss` are checked when
 * the host names them. Each refusal is a `ContractRuntimeError` with
 * `status: 401` and `retryable: false`; malformed options or key
 * material are a `ContractHostError` (`JC1016`). Inside `identify`,
 * answer a refusal as the operation's declared failure — a hook that
 * throws is the host's fault.
 * @param {string} token - the compact serialization, without the `Bearer ` scheme
 * @param {VerifyHs256Options} options
 * @returns {Record<string, unknown>} the payload's claims
 * @throws {ContractRuntimeError} `JC2140` malformed, `JC2141` algorithm, `JC2142` signature,
 *   `JC2143` expired, `JC2144` not yet valid, `JC2145` audience or issuer, `JC2146` too long
 */
export function verifyHs256Token(token, options) {
  const { key, now, leeway, audience, issuer } = admit(options);
  if (typeof token !== 'string') refuse('JC2140', 'the token is not a string');
  if (token.length > MAX_TOKEN) refuse('JC2146', `the token is longer than ${MAX_TOKEN} characters`);
  const parts = token.split('.');
  if (parts.length !== 3) refuse('JC2140', 'the token is not three dot-separated segments');
  const header = jsonSegment(parts[0]);
  if (header.alg !== 'HS256' || Object.hasOwn(header, 'crit')) refuse('JC2141', 'the token is not plain HS256');
  if (decodeBase64url(parts[1]) === null) refuse('JC2140', 'the payload segment is not canonical base64url');
  const tag = parts[2].length === 0 ? null : decodeBase64url(parts[2]);
  if (tag === null && parts[2].length > 0) refuse('JC2140', 'the signature segment is not canonical base64url');
  if (tag === null || !bytesMatch(hmacSha256(key, [`${parts[0]}.${parts[1]}`]), tag)) refuse('JC2142', 'the token signature does not match');
  const claims = jsonSegment(parts[1]);
  const exp = claims.exp, nbf = claims.nbf;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) refuse('JC2140', 'exp is not a NumericDate');
  if (nbf !== undefined && (typeof nbf !== 'number' || !Number.isFinite(nbf))) refuse('JC2140', 'nbf is not a NumericDate');
  if (now >= exp * 1000 + leeway) refuse('JC2143', 'the token has expired');
  if (typeof nbf === 'number' && now < nbf * 1000 - leeway) refuse('JC2144', 'the token is not yet valid');
  if (audience !== undefined) {
    const aud = claims.aud;
    if (!(aud === audience || (Array.isArray(aud) && aud.includes(audience)))) refuse('JC2145', 'the token is not for this audience');
  }
  if (issuer !== undefined && claims.iss !== issuer) refuse('JC2145', 'the token is not from this issuer');
  return claims;
}

/**
 * Whether `signature` is the HMAC-SHA256 of `message` under `key`,
 * compared in constant time — a request signature over the bytes a
 * scheme names (a method, a target, a timestamp, the raw body or its
 * digest), assembled by the host. The parts are MACed in order and
 * concatenated as given, so put a delimiter that cannot occur inside
 * them between fields (a newline between method, target and timestamp,
 * a hex digest for the body): without one, two requests whose fields
 * split the same bytes differently share a signature. Each part is MACed, a
 * string as its UTF-8 bytes; a signature of another length is `false`,
 * never a throw. Decode a hex or base64 signature header first.
 * Malformed key material or arguments are a `ContractHostError`
 * (`JC1016`).
 * @param {Uint8Array} key - the shared secret, 32–1024 bytes
 * @param {string | Uint8Array | readonly (string | Uint8Array)[]} message
 * @param {Uint8Array} signature - the presented MAC, as bytes
 * @returns {boolean}
 */
export function hmacSha256Matches(key, message, signature) {
  if (!isKeyBytes(key)) hostError('key must be a Uint8Array of 32–1024 bytes');
  if (!(signature instanceof Uint8Array)) hostError('signature must be a Uint8Array (decode the presented header first)');
  const parts = typeof message === 'string' || message instanceof Uint8Array ? [message] : message;
  if (!Array.isArray(parts) || !parts.every(part => typeof part === 'string' || part instanceof Uint8Array)) {
    hostError('message must be a string, a Uint8Array, or an array of them');
  }
  return bytesMatch(hmacSha256(key, parts), signature);
}
