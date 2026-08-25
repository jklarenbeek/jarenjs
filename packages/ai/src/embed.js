//@ts-check
/**
 * Embeddings: the `/embeddings` wire of the same OpenAI-compatible
 * provider family the chat client speaks, and the seam every consumer
 * of an embedding in this package is written against —
 *
 *   { embed(texts, { signal }) → Promise<Float32Array[]>, model, dims }
 *
 * — one vector per input, in input order, from a named model at a
 * fixed width. `model` and `dims` are a vector's identity: vectors from
 * different models are pairwise meaningless and compare into plausible
 * garbage, so the identity travels with every embedding and a consumer
 * refuses to mix two. Two implementations ship here.
 * `createEmbeddingClient` is the wire — OpenRouter, Ollama, LM Studio or
 * any OpenAI-compatible base, resolved exactly as the chat client
 * resolves it. `createHashEmbedder` is the deterministic reference:
 * hashed character trigrams, dependency-free and network-free — what
 * the tests and the offline demos run on, and demo-grade by design.
 * Anything heavier (a local transformer runtime, a native embedding
 * library) is the host's, wired through the same three members. This
 * package ships no model weights, no tokenizer, no download and no
 * opinion on which embedding model is good.
 *
 * The one invariant the wire client exists to own: a reply is
 * reassembled by each item's `index`, and refused unless exactly one
 * non-empty, finite vector of the expected width arrives per input. An
 * embedding attached to the wrong text is worse than an error, and a
 * client that trusts reply order gets exactly that from a provider
 * that answers a batch out of order.
 */

import { fnv1a } from '@jarenjs/core/string';
import { l2Normalize } from '@jarenjs/core/vector';

import { AiError } from './errors.js';
import { resolveEndpoint } from './providers.js';
import {
  normalizeRetry, withRetry, isTransientFailure, httpFailure, transportFailure, abortError,
} from './retry.js';

/**
 * The embedder seam: what every consumer of embeddings in this package
 * takes, and what a host implements to bring its own.
 * @typedef {Object} Embedder
 * @property {(texts: string[], options?: { signal?: AbortSignal }) => Promise<Float32Array[]>} embed
 *   - one vector per input, in input order; rejects `AI0001` for
 *   anything but a non-empty array of strings
 * @property {string} model - the name half of a vector's identity
 * @property {number | undefined} dims - the width half; the wire client
 *   leaves it undefined until its first reply settles it, unless the
 *   caller configured it
 */

/**
 * @param {unknown} texts
 * @returns {asserts texts is string[]}
 */
function assertTexts(texts) {
  if (!Array.isArray(texts) || texts.length === 0 || !texts.every((text) => typeof text === 'string'))
    throw new AiError('AI0001', 'embed() needs a non-empty array of strings');
}

/**
 * The OpenAI-compatible `/embeddings` client over the existing provider
 * set. The endpoint is `${base}/embeddings` from the same resolved base
 * the chat client uses, with the same auth and headers; the request is
 * one non-streaming POST of `{ model, input }`.
 *
 * Retries follow the chat client exactly: transient transport failures
 * (network, 408, 429, 5xx) and a malformed 200 back off with full
 * jitter and try again, `Retry-After` wins up to `maxMs`, an abort ends
 * everything at once. A structurally wrong reply — the wrong width for
 * a fixed model — is therefore reported after `attempts` tries; a probe
 * that wants a fast answer sets `retry: { attempts: 1 }`.
 *
 * @param {{ provider?: string, baseUrl?: string, apiKey?: string,
 *   model?: string, dims?: number, headers?: Record<string, string>,
 *   fetch?: typeof fetch, timeoutMs?: number,
 *   retry?: import('./retry.js').RetryOptions }} [options]
 *   - `model` is required: it is half of every vector's identity.
 *   - `dims` pins the other half up front; left out, the width of the
 *     first reply becomes the client's, and every later reply must
 *     match it. Give it when the identity must be known before the
 *     first call.
 *   - `timeoutMs` bounds each attempt, and a timed-out attempt retries
 *     like a network failure. Unset means no timeout, as `complete()`
 *     has none — a batch of long texts on a local runtime legitimately
 *     takes a while; `probeEmbeddings` sets 5 000 ms, as `probeProvider`
 *     does.
 *   - `retry` is the chat client's option, unchanged (see
 *     `createChatClient`).
 * @returns {Embedder & { provider: string }} the seam, plus the
 *   resolved provider name; `dims` is the settled width
 */
export function createEmbeddingClient(options = {}) {
  const endpoint = resolveEndpoint(options);
  const model = endpoint.model;
  if (typeof model !== 'string' || model === '')
    throw new AiError('AI0001', 'createEmbeddingClient needs a model — it is half of every vector\'s identity');
  if (options.dims !== undefined && !(Number.isInteger(options.dims) && options.dims > 0))
    throw new AiError('AI0001', `dims must be a positive integer, got ${String(options.dims)}`);
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0))
    throw new AiError('AI0001', `timeoutMs must be a positive number, got ${String(timeoutMs)}`);
  const url = `${endpoint.base}/embeddings`;
  const fetchFn = options.fetch ?? ((u, init) => globalThis.fetch(u, init));
  const retry = normalizeRetry(options.retry);
  /** @type {number | undefined} */
  let dims = options.dims;

  /**
   * One request/response cycle.
   * @param {string[]} texts
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<Float32Array[]>}
   */
  async function attemptOnce(texts, signal) {
    // the attempt's own deadline rides beside the caller's signal; which
    // of the two fired decides whether the failure is a retryable
    // timeout or the caller's abort
    /** @type {AbortController | null} */
    let deadline = null;
    /** @type {any} */
    let timer;
    let requestSignal = signal;
    if (timeoutMs !== undefined) {
      deadline = new AbortController();
      timer = setTimeout(() => /** @type {AbortController} */ (deadline).abort(), timeoutMs);
      requestSignal = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);
    }
    /** @type {string} */
    let text;
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: endpoint.headers,
        body: JSON.stringify({ model, input: texts }),
        signal: requestSignal,
      });
      if (response.ok !== true) throw await httpFailure(response, url);
      text = await response.text();
    }
    catch (err) {
      if (err instanceof AiError) throw err;
      if (deadline !== null && deadline.signal.aborted && signal?.aborted !== true)
        throw new AiError('AI0002', `no answer from ${url} within ${timeoutMs} ms`, { status: 0, cause: err });
      throw transportFailure(err, url);
    }
    finally {
      clearTimeout(timer);
    }
    /** @type {any} */
    let payload;
    try {
      payload = JSON.parse(text);
    }
    catch {
      throw new AiError('AI0003', `malformed embeddings reply: ${text.slice(0, 120)}`);
    }
    const vectors = reassemble(payload, texts.length, dims);
    // the first reply settles the width; from here every reply must match
    if (dims === undefined) dims = vectors[0].length;
    return vectors;
  }

  /**
   * @param {string[]} texts
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<Float32Array[]>}
   */
  async function embed(texts, options = {}) {
    assertTexts(texts);
    const { signal } = options;
    return withRetry(retry, () => attemptOnce(texts, signal), { signal, retryable: isTransientFailure });
  }

  return {
    embed,
    model,
    provider: endpoint.provider,
    get dims() {
      return dims;
    },
  };
}

/**
 * The verification: `data[]` reassembled by each item's `index`, every
 * input filled exactly once, every vector a non-empty array of finite
 * numbers, every width the expected one — or `AI0003` naming the input
 * that failed. Nothing is guessed: an item without a usable index is
 * refused rather than placed by position, and a vector of the wrong
 * width is refused rather than cut or padded.
 * @param {any} payload
 * @param {number} count - the number of inputs sent
 * @param {number | undefined} dims - the width every vector must have,
 *   or undefined to let input 0's vector settle it for this reply
 * @returns {Float32Array[]}
 */
function reassemble(payload, count, dims) {
  const data = payload?.data;
  if (!Array.isArray(data))
    throw new AiError('AI0003', 'malformed embeddings reply: no data[] in the response');
  if (data.length !== count)
    throw new AiError('AI0003', `embeddings reply carried ${data.length} items for ${count} inputs`);
  /** @type {any[]} */
  const slots = new Array(count);
  for (let i = 0; i < count; i++) {
    const item = data[i];
    const index = item?.index;
    if (!Number.isInteger(index) || index < 0 || index >= count)
      throw new AiError('AI0003',
        `embeddings reply item ${i} carries no usable index for ${count} inputs (got ${JSON.stringify(index)})`);
    if (slots[index] !== undefined)
      throw new AiError('AI0003', `input ${index} received two embeddings`);
    slots[index] = item.embedding;
  }
  // `count` items over `count` distinct indices: every slot is filled
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const embedding = slots[i];
    if (!Array.isArray(embedding) || embedding.length === 0)
      throw new AiError('AI0003', `input ${i} received an empty embedding`);
    if (dims === undefined) dims = embedding.length;
    if (embedding.length !== dims)
      throw new AiError('AI0003', `input ${i} received ${embedding.length} dimensions, expected ${dims}`);
    const vector = new Float32Array(dims);
    for (let j = 0; j < dims; j++) {
      const x = embedding[j];
      if (typeof x !== 'number' || !Number.isFinite(x))
        throw new AiError('AI0003', `input ${i} received a component that is not a finite number at ${j}`);
      vector[j] = x;
    }
    out[i] = vector;
  }
  return out;
}

/**
 * Probe the embeddings wire before relying on it: can this key/URL/model
 * embed at all, and at what width? Embeds one word with exactly the
 * auth an `embed()` call would use, in one attempt, within `timeoutMs`
 * (default 5 000, as `probeProvider`). Never throws — the result object
 * is the settings-UI contract, and the live proof that a provider
 * really serves `/embeddings` beside `/chat/completions`.
 * @param {{ provider?: string, baseUrl?: string, apiKey?: string,
 *   model?: string, dims?: number, headers?: Record<string, string>,
 *   fetch?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: true, model: string, dims: number } |
 *   { ok: false, status?: number, error: string }>}
 */
export async function probeEmbeddings(options = {}) {
  /** @type {ReturnType<typeof createEmbeddingClient>} */
  let client;
  try {
    client = createEmbeddingClient({
      ...options,
      retry: { attempts: 1 },
      timeoutMs: options.timeoutMs ?? 5000,
    });
  }
  catch (err) {
    return { ok: false, error: /** @type {Error} */ (err).message };
  }
  try {
    const [vector] = await client.embed(['probe']);
    return { ok: true, model: client.model, dims: vector.length };
  }
  catch (err) {
    const status = err instanceof AiError && typeof err.status === 'number' && err.status > 0
      ? err.status
      : undefined;
    return {
      ok: false,
      ...(status === undefined ? {} : { status }),
      error: /** @type {any} */ (err)?.message ?? String(err),
    };
  }
}

/**
 * The deterministic reference embedder — demo-grade, for tests and
 * offline demos. Each text becomes the bag of its case-folded character
 * trigrams (the text padded with one space on each side), hashed with
 * the suite's FNV-1a into `dims` buckets and l2-normalized: the same
 * text yields the same vector on every host, forever, with no network,
 * no weights and no dependency. It is LEXICAL, not semantic — two texts
 * score high when they share letters, not when they mean the same
 * thing — so it exercises retrieval mechanics (does the right memory
 * reach the prompt?) without saying anything about embedding quality,
 * which belongs to a real model behind the same seam.
 * @param {{ dims?: number }} [options] - the width (default 64); the
 *   identity is `hash-trigram-<dims>`, so two widths never mix
 * @returns {Embedder & { dims: number }}
 */
export function createHashEmbedder(options = {}) {
  const dims = options.dims ?? 64;
  if (!(Number.isInteger(dims) && dims > 0))
    throw new AiError('AI0001', `createHashEmbedder needs a positive integer dims, got ${String(dims)}`);
  const model = `hash-trigram-${dims}`;

  /**
   * @param {string} text
   * @returns {Float32Array}
   */
  function trigramVector(text) {
    const counts = new Float32Array(dims);
    const padded = ` ${text.toLowerCase()} `;
    for (let i = 0; i + 3 <= padded.length; i++)
      counts[fnv1a(padded.slice(i, i + 3)) % dims] += 1;
    // counts is finite and non-empty, so this is never null; a text
    // without a single trigram stays the zero vector, which scores 0
    // against everything rather than NaN
    return /** @type {Float32Array} */ (l2Normalize(counts));
  }

  return {
    model,
    dims,
    async embed(texts, options = {}) {
      assertTexts(texts);
      if (options.signal?.aborted) throw abortError(options.signal);
      return texts.map(trigramVector);
    },
  };
}
