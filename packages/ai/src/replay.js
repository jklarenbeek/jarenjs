//@ts-check
/**
 * The replay seam behind both wire clients: what a remembered reply is
 * keyed by, and what a remembered entry must look like before it is
 * served. This module owns the two decisions a host must not be left
 * to make twice —
 *
 *  - **the key is the effective wire request, canonicalized.** It is
 *    built by the client after endpoint resolution and default
 *    application, from `{ wire, provider, base, request }` where
 *    `request` is the body the client would POST (minus `stream`, which
 *    does not change an answer). Never the headers (they carry the
 *    credential), never the signal, never a callback. Because the key
 *    is the body rather than an allow-list of request members, an
 *    option added to the body later enters the key by construction — it
 *    cannot alias an older key. The serialization is `semanticKey`:
 *    injective over plain data, so two requests share a key exactly when
 *    they are the same request, and a request that cannot be keyed
 *    injectively (a function inside `tools`, a cycle) is refused up
 *    front rather than folded onto someone else's entry;
 *
 *  - **a stored entry is verified, not trusted.** A chat entry must carry
 *    a normalized result and the wall time of the purchase; an embedding
 *    entry must carry a vector of finite numbers at the settled width.
 *    Anything else is `AI0003`, never served — a cache that answers
 *    garbage is worse than a cache that is down.
 *
 * The client hands the adapter the complete canonical string. It is
 * long (a whole conversation is in it) and that is the point: it is
 * collision-free. An adapter that needs a fixed-width storage id hashes
 * it — with a cryptographic hash, because a 32-bit hash over prompts
 * that differ by one token would sooner or later serve one prompt's
 * answer for another's.
 *
 * The adapter contract is two members, each sync or async:
 * `get(key) → value | undefined` and `set(key, value)`. The seam FAILS
 * CLOSED: an adapter that throws fails the call. An adapter that wants
 * to fail open — keep buying while its storage is broken — catches its
 * own errors and answers `undefined`; the client will not guess which
 * it wanted.
 */

import { semanticKey } from '@jarenjs/core/object';

import { AiError } from './errors.js';
import { verifyEmbeddingComponents } from './embedding-vector.js';

/**
 * The replay cache seam a host implements.
 * @typedef {Object} ReplayCache
 * @property {(key: string) => any} get - the stored value, or `undefined`
 *   for a miss; may answer a promise
 * @property {(key: string, value: any) => any} set - remember a value
 *   under a key; may answer a promise. The value is JSON-only.
 */

/**
 * The `cache` option, checked once at client construction: absent means
 * no cache; present means both members are functions, or `AI0001`.
 * @param {unknown} cache
 * @returns {ReplayCache | null}
 */
export function normalizeCache(cache) {
  if (cache === undefined || cache === null) return null;
  const candidate = /** @type {any} */ (cache);
  if (typeof candidate.get !== 'function' || typeof candidate.set !== 'function')
    throw new AiError('AI0001', 'cache needs { get(key), set(key, value) } — both functions, sync or async');
  return candidate;
}

/**
 * The key one request has under one endpoint: the canonical
 * serialization of the wire, the credential-free endpoint identity and
 * the effective request. The same request keys the same string on
 * every host.
 * @param {'chat' | 'embeddings'} wire
 * @param {{ provider: string, base: string }} endpoint
 * @param {any} request - the body the client would POST, `stream` removed
 * @returns {string}
 * @throws {AiError} `AI0001` when the request cannot be keyed injectively
 */
export function replayKey(wire, endpoint, request) {
  try {
    return semanticKey({ wire, provider: endpoint.provider, base: endpoint.base, request });
  }
  catch (err) {
    throw new AiError('AI0001',
      `the ${wire} request is not cacheable: ${/** @type {Error} */ (err).message}`);
  }
}

/** @param {any} value */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A stored chat entry, verified: `{ value, ms }` with `value` a
 * normalized result carrying a `message` object and `ms` a finite
 * number — or `AI0003`.
 * @param {any} entry
 * @returns {{ value: any, ms: number }}
 */
export function verifyChatEntry(entry) {
  if (!isRecord(entry) || !isRecord(entry.value) || !isRecord(entry.value.message)
    || typeof entry.ms !== 'number' || !Number.isFinite(entry.ms))
    throw new AiError('AI0003', 'malformed replay entry for the chat wire: expected { value: { message, … }, ms }');
  return entry;
}

/**
 * A stored embedding entry, verified into a fresh vector: `{ vector,
 * ms }` with `vector` a non-empty array of finite numbers at the settled
 * width (any positive width when none is settled yet — the first replay
 * settles it exactly as a first wire reply would) — or `AI0003`.
 * @param {any} entry
 * @param {number | undefined} dims - the settled width, if any
 * @returns {Float32Array}
 */
export function verifyEmbeddingEntry(entry, dims) {
  const vector = isRecord(entry) ? entry.vector : undefined;
  if (!Array.isArray(vector) || vector.length === 0)
    throw new AiError('AI0003', 'malformed replay entry for the embeddings wire: expected { vector: number[], ms }');
  if (dims !== undefined && vector.length !== dims)
    throw new AiError('AI0003', `replay entry carries ${vector.length} dimensions, expected ${dims}`);
  return verifyEmbeddingComponents(vector, 'replay entry carries');
}

/**
 * A JSON-only copy: what is stored, and what a replay answers, so that a
 * caller mutating its result never mutates the adapter's entry.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Milliseconds now, for the wall time of a purchase. */
export function now() {
  return globalThis.performance.now();
}
