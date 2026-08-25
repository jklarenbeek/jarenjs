//@ts-check
/**
 * The transport policy every client in this package shares: which
 * failures are transient, how long to wait before trying again, what a
 * provider's `Retry-After` is worth, and how an abort cuts a wait
 * short. The chat wire and the embeddings wire fail alike at the
 * transport — a network error, a 408, a 429, a 5xx, a 200 whose body is
 * not what the wire promised — and differ only in what a good reply
 * must carry. So the loop lives here, once, and each client keeps its
 * own reading of a reply: one implementation of retry, two wire shapes.
 *
 * Everything here is internal to the package; the public surface is
 * the `retry` option each client documents.
 */

import { AiError } from './errors.js';

/**
 * The `retry` option of every client.
 * @typedef {Object} RetryOptions
 * @property {number} [attempts] - the TOTAL number of tries (default 3;
 *   1 disables retrying)
 * @property {number} [baseMs] - the first backoff (default 500); each
 *   later one doubles, with full jitter
 * @property {number} [maxMs] - the ceiling on any single wait (default
 *   8 000) — a provider `Retry-After` included: a provider asking for a
 *   minute gets the cap, and the value it asked for rides the final
 *   error as `retryAfterMs` for the caller to honour
 * @property {() => number} [random] - the jitter source, for
 *   deterministic tests
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} [sleep]
 *   - the wait itself, for deterministic tests; the default is a timer
 *   that rejects with the abort reason the moment `signal` aborts
 */

/**
 * The option with its defaults filled in.
 * @typedef {Object} RetryPolicy
 * @property {number} attempts
 * @property {number} baseMs
 * @property {number} maxMs
 * @property {() => number} random
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} sleep
 */

/**
 * @param {RetryOptions | undefined} retry
 * @returns {RetryPolicy}
 */
export function normalizeRetry(retry) {
  return {
    attempts: Math.max(1, retry?.attempts ?? 3),
    baseMs: retry?.baseMs ?? 500,
    maxMs: retry?.maxMs ?? 8000,
    random: retry?.random ?? Math.random,
    sleep: retry?.sleep ?? defaultSleep,
  };
}

/** Statuses worth a retry: timeout, rate limit, server-side failure. */
function isRetryableStatus(status) {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/**
 * Whether a failure is the transient kind. A transport error with a
 * retryable status is (a network failure before any response counts
 * as status 0); so is a malformed 200 — a reply that carried none of
 * what the wire promised is a provider hiccup, common on busy cheap
 * tiers, and safe to retry precisely because nothing was delivered.
 * Anything else — a caller error, a 401, a 404 — is final on the first
 * try.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransientFailure(err) {
  if (!(err instanceof AiError)) return false;
  return err.code === 'AI0003'
    || (err.code === 'AI0002' && isRetryableStatus(err.status ?? -1));
}

/**
 * The wait before the next try: exponential backoff with full jitter,
 * capped at `maxMs` — unless the provider named a `Retry-After`, which
 * wins up to the same cap.
 * @param {RetryPolicy} policy
 * @param {number} attempt - the try that just failed, counted from 1
 * @param {number | undefined} retryAfter - the provider's ask, in ms
 * @returns {number} milliseconds
 */
export function retryDelay(policy, attempt, retryAfter) {
  const backoff = Math.min(policy.maxMs, policy.baseMs * 2 ** (attempt - 1));
  return retryAfter !== undefined
    ? Math.min(policy.maxMs, retryAfter)
    : backoff * (0.5 + 0.5 * policy.random());
}

/**
 * Run `once` until it settles. A failure `retryable` accepts backs off
 * and tries again while tries remain; anything else is thrown as it
 * came, and a coded transport failure (`AI0002`, `AI0003`) carries the
 * number of tries as `attempts`. The wait honours `signal`: an abort
 * during backoff rejects with the abort reason, exactly like an abort
 * during the request — nothing is ever retried past an abort.
 * @template T
 * @param {RetryPolicy} policy
 * @param {() => Promise<T>} once - one request/response cycle
 * @param {{ signal?: AbortSignal, retryable: (failure: AiError) => boolean }} options
 *   - `retryable` is the wire's own judgment over a coded failure (the
 *   chat client, for one, stops retrying once a streamed delta has
 *   reached the caller); it is never asked about an uncoded error
 * @returns {Promise<T>}
 */
export async function withRetry(policy, once, options) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await once();
    }
    catch (err) {
      const failure = /** @type {any} */ (err);
      const coded = failure instanceof AiError;
      if (!(coded && options.retryable(failure) && attempt < policy.attempts)) {
        if (coded && (failure.code === 'AI0002' || failure.code === 'AI0003'))
          failure.attempts = attempt;
        throw err;
      }
      await policy.sleep(retryDelay(policy, attempt, failure.retryAfterMs), options.signal);
    }
  }
}

/**
 * The `AI0002` for a response that is not ok: the status, a short
 * excerpt of the body, and the provider's `Retry-After` in ms.
 * @param {any} response
 * @param {string} url
 * @returns {Promise<AiError>}
 */
export async function httpFailure(response, url) {
  const excerpt = await readErrorExcerpt(response);
  return new AiError('AI0002',
    `HTTP ${response.status} from ${url}${excerpt === '' ? '' : `: ${excerpt}`}`,
    { status: response.status, retryAfterMs: retryAfterMs(response) });
}

/**
 * What to throw when `fetch` itself threw: an abort exactly as it came
 * (the caller's own signal, never retried, never rewrapped); anything
 * else the `AI0002` of a failure before any response, status 0.
 * @param {any} err
 * @param {string} url
 * @returns {any}
 */
export function transportFailure(err, url) {
  if (err?.name === 'AbortError') return err;
  return new AiError('AI0002',
    `network error calling ${url}: ${err?.message ?? err}`,
    { status: 0, cause: err });
}

/**
 * Parse a `Retry-After` header (delta-seconds or HTTP-date) into ms.
 * @param {any} response
 * @returns {number | undefined}
 */
export function retryAfterMs(response) {
  const raw = response?.headers?.get?.('retry-after');
  if (raw == null || raw === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * @param {any} response
 * @returns {Promise<string>} a short excerpt of the error body
 */
async function readErrorExcerpt(response) {
  try {
    const text = await response.text();
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  }
  catch {
    return '';
  }
}

/**
 * Abortable delay. Rejects with the abort reason so an abort during
 * backoff surfaces exactly like an abort during the request.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError(signal));
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * The abort reason, or a platform-shaped AbortError.
 * @param {AbortSignal | undefined} signal
 * @returns {any}
 */
export function abortError(signal) {
  if (signal?.reason !== undefined) return signal.reason;
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}
