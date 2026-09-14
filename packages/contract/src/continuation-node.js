//@ts-check
/** Bounded, authenticated continuations. Keys, clock and authority belong to the host. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { ContractHostError, ContractRuntimeError } from './errors.js';

/** @typedef {import('./index.js').Continuation} Continuation */
/**
 * @typedef {Object} ContinuationContext
 * @property {unknown} scope - Host authority/scope identity, as JSON data.
 * @property {string} query - Host query fingerprint, 1–256 characters.
 * @property {readonly unknown[]} order - Host ordering identity, as JSON data.
 * @property {number | (() => number)} now - Epoch milliseconds; no implicit clock.
 * @property {number} [maxBytes=16384] - Wire ceiling, 256–16384 ASCII bytes.
 */
/**
 * @typedef {ContinuationContext & {keyId: string, key: Uint8Array, expiresAt: number}} SealContinuationOptions
 * @typedef {ContinuationContext & {getKey: (keyId: string) => Uint8Array | null | undefined}} OpenContinuationOptions
 */

const MAX_BYTES = 16384;
const MAX_VALUES = 2048;
const MAX_DEPTH = 32;
const INVALID_KEY_ID = /[^A-Za-z0-9_-]/;
const DOMAIN = 'jaren-continuation\0';
const FIELDS = ['v', 'alg', 'kid', 'iat', 'exp', 'scope', 'query', 'order', 'cursor'];

function refuse(code) {
  if (code === 'JC1014') throw new ContractHostError(code, 'invalid continuation host options or JSON data');
  throw new ContractRuntimeError(code, 'continuation refused', {
    msgid: 'contract/invalid-input', params: { op: 'continuation' },
    status: code === 'JC2121' ? 413 : 400, retryable: false,
  });
}

function hostCall(body) {
  try { return body(); }
  catch (error) {
    if (error instanceof ContractHostError || error instanceof ContractRuntimeError) throw error;
    return refuse('JC1014');
  }
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [null, Object.prototype].includes(Object.getPrototypeOf(value));
}

/** Snapshot ordinary JSON before canonicalization, with finite depth, values and string data. */
function boundedJson(value, maxBytes, malformed = 'JC1014') {
  let values = 0, characters = 0;
  const ancestors = new Set();
  function stringSize(text) {
    characters += text.length;
    if (characters > maxBytes) refuse('JC2121');
  }
  function copy(input, depth) {
    if (++values > MAX_VALUES || depth > MAX_DEPTH) refuse('JC2121');
    if (typeof input === 'string') { stringSize(input); return input; }
    if (input === null || typeof input === 'boolean' || typeof input === 'number') return input;
    if (typeof input !== 'object' || ancestors.has(input)) return refuse(malformed);
    const array = Array.isArray(input);
    if (!array && !record(input)) refuse(malformed);
    if (array && input.length > MAX_VALUES) refuse('JC2121');
    ancestors.add(input);
    const result = array ? [] : Object.create(null);
    function member(key) {
      if (++values > MAX_VALUES) refuse('JC2121');
      stringSize(key);
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) refuse(malformed);
      result[key] = copy(descriptor.value, depth + 1);
    }
    if (array) for (let i = 0; i < input.length; i++) member(String(i));
    else for (const key in input) if (Object.hasOwn(input, key)) member(key);
    ancestors.delete(input);
    return result;
  }
  try {
    const text = canonicalizeJson(copy(value, 0));
    if (Buffer.byteLength(text, 'utf8') > maxBytes) refuse('JC2121');
    return text;
  } catch (error) {
    if (error instanceof ContractRuntimeError || error instanceof ContractHostError) throw error;
    return refuse(malformed);
  }
}

const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const keyId = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !INVALID_KEY_ID.test(value);
function checkKey(value) {
  if (!(value instanceof Uint8Array) || value.byteLength < 32 || value.byteLength > 1024) refuse('JC1014');
  return value;
}

function context(options) {
  if (!record(options)) refuse('JC1014');
  const maxBytes = options.maxBytes === undefined ? MAX_BYTES : options.maxBytes;
  if (!Number.isInteger(maxBytes) || maxBytes < 256 || maxBytes > MAX_BYTES) refuse('JC1014');
  const now = typeof options.now === 'function' ? options.now() : options.now;
  if (!timestamp(now) || typeof options.query !== 'string' || !options.query.length
    || options.query.length > 256 || !Array.isArray(options.order)) refuse('JC1014');
  const identity = JSON.parse(boundedJson({ scope: options.scope, query: options.query, order: options.order }, maxBytes));
  return { maxBytes, now, identity };
}

function signature(payload, key) {
  return createHmac('sha256', key).update(DOMAIN).update(`jc1.${payload}`, 'ascii').digest();
}

/**
 * Seal a JSON cursor without changing its structural meaning. Authentication
 * does not encrypt it, authorize a request, or establish a database snapshot.
 * @param {object} cursor - An ordinary JSON object; the Store still validates its shape.
 * @param {SealContinuationOptions} options
 * @returns {Continuation}
 */
export function sealContinuation(cursor, options) {
  return hostCall(() => {
    const { maxBytes, now, identity } = context(options);
    if (!record(cursor) || !keyId(options.keyId) || !timestamp(options.expiresAt) || options.expiresAt <= now) refuse('JC1014');
    const key = checkKey(options.key);
    const json = boundedJson({ v: 1, alg: 'HS256', kid: options.keyId, iat: now, exp: options.expiresAt, ...identity, cursor }, maxBytes);
    const payload = Buffer.from(json, 'utf8').toString('base64url');
    if (4 + payload.length + 1 + 43 > maxBytes) refuse('JC2121');
    return `jc1.${payload}.${signature(payload, key).toString('base64url')}`;
  });
}

/** Decode only the canonical, unpadded base64url spelling. */
function decode(text) {
  if (!text.length || /[^A-Za-z0-9_-]/.test(text)) refuse('JC2120');
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) refuse('JC2120');
  return bytes;
}

/**
 * Authenticate and open a cursor for the host's expected context. At now >= exp
 * (or now < iat) it refuses. Keep previous lookup keys only for the desired
 * rotation overlap. The result is unknown until the consumer validates its
 * structural cursor; Store's normal ordering/shape checks still apply.
 * @param {Continuation} token
 * @param {OpenContinuationOptions} options
 * @returns {unknown}
 */
export function openContinuation(token, options) {
  return hostCall(() => {
    const { maxBytes, now, identity } = context(options);
    if (typeof options.getKey !== 'function') refuse('JC1014');
    if (typeof token !== 'string') refuse('JC2120');
    if (token.length > maxBytes) refuse('JC2121');
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'jc1' || parts[2].length !== 43) refuse('JC2120');
    const bytes = decode(parts[1]), tag = decode(parts[2]);
    let json, body;
    try { json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); body = JSON.parse(json); }
    catch { return refuse('JC2120'); }
    if (!record(body) || Object.keys(body).length !== FIELDS.length || FIELDS.some(field => !Object.hasOwn(body, field))
      || body.v !== 1 || body.alg !== 'HS256' || !keyId(body.kid)) refuse('JC2120');
    const key = options.getKey(body.kid);
    if (key === null || key === undefined) refuse('JC2122');
    if (!timingSafeEqual(signature(parts[1], checkKey(key)), tag)) refuse('JC2122');
    if (boundedJson(body, maxBytes, 'JC2120') !== json || !record(body.cursor) || !Array.isArray(body.order)
      || typeof body.query !== 'string' || !body.query.length || body.query.length > 256
      || !timestamp(body.iat) || !timestamp(body.exp) || body.exp <= body.iat) refuse('JC2120');
    if (now < body.iat || now >= body.exp) refuse('JC2123');
    if (canonicalizeJson({ scope: body.scope, query: body.query, order: body.order }) !== canonicalizeJson(identity)) refuse('JC2124');
    return body.cursor;
  });
}
