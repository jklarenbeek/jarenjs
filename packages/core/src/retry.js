//@ts-check
/** Shared backoff arithmetic, abortable waits and an explicit dispatch budget. */
import { isPlainOptions, refuseUnknownMembers } from './object.js';

const BACKOFF_OPTIONS = ['policy', 'baseMs', 'maxMs', 'random'];

/**
 * Calculate a delay; strict never shortens the server's minimum wait.
 * `strict` is full jitter (`cap × random`); `equal` is equal jitter
 * (`cap × (½ + ½·random)` — never under half the cap), the durable job
 * queue's retry policy. Compatibility policies retain the published
 * clients' distinct jitter shapes (`ai-compat` is equal jitter too, and
 * caps a server's wait at `maxMs`).
 * @param {{ policy?: 'strict' | 'equal' | 'ai-compat' | 'contract-compat', baseMs?: number, maxMs?: number, random?: () => number }} options
 * @param {number} attempt - failed attempt, counted from one
 * @param {number} [retryAfterMs]
 * @returns {number}
 */
export function backoffDelay(options, attempt, retryAfterMs = undefined) {
  if (!isPlainOptions(options)) throw new TypeError('backoffDelay options must be a plain object');
  refuseUnknownMembers(options, BACKOFF_OPTIONS,
    (key, hint) => new TypeError(`backoffDelay: unknown option '${key}'${hint}`));
  const { policy = 'strict', baseMs = 500, maxMs = 8000, random = Math.random } = options;
  if (!['strict', 'equal', 'ai-compat', 'contract-compat'].includes(policy))
    throw new TypeError('backoffDelay policy must be strict, equal, ai-compat or contract-compat');
  if (!Number.isFinite(baseMs) || baseMs < 0 || !Number.isFinite(maxMs) || maxMs < 0)
    throw new TypeError('backoffDelay baseMs and maxMs must be finite nonnegative numbers');
  if (typeof random !== 'function') throw new TypeError('backoffDelay random must be a function');
  // a zero base stays zero however large the doubling grows
  const cap = baseMs === 0 ? 0 : Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  if (retryAfterMs !== undefined)
    return policy === 'ai-compat' ? Math.min(maxMs, retryAfterMs) : Math.max(0, retryAfterMs);
  if (policy === 'contract-compat') return cap + Math.floor(random() * 250);
  return cap * (policy === 'ai-compat' || policy === 'equal' ? 0.5 + 0.5 * random() : random());
}

/**
 * Parse only the selected header dialect. HTTP accepts seconds or HTTP-date;
 * milliseconds accepts nonnegative numbers only; none ignores the header.
 * A negative number, or one too large to be a finite wait, is no hint.
 * @param {string | null | undefined} raw
 * @param {{ dialect?: 'http' | 'milliseconds' | 'none', now?: number }} [options]
 * @returns {number | undefined}
 */
export function parseRetryAfter(raw, { dialect = 'http', now = Date.now() } = {}) {
  if (raw == null || raw === '' || dialect === 'none') return undefined;
  const number = Number(raw);
  if (Number.isFinite(number)) {
    const wait = number * (dialect === 'milliseconds' ? 1 : 1000);
    return number >= 0 && Number.isFinite(wait) ? wait : undefined;
  }
  if (dialect !== 'http') return undefined;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** @param {AbortSignal | null | undefined} signal @returns {any} */
export function abortError(signal) {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/** The longest wait one timer holds: a larger delay would fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Abortable timer with listener cleanup on either settlement. A wait past
 * the longest single timer is slept in turns, never cut short.
 * @param {number} ms @param {AbortSignal} [signal] @returns {Promise<void>} */
export function sleep(ms, signal = undefined) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const wait = (left) => {
      timer = setTimeout(() => {
        if (left > MAX_TIMER_MS) {
          wait(left - MAX_TIMER_MS);
          return;
        }
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, Math.min(left, MAX_TIMER_MS));
    };
    wait(ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A host-private total budget reused across SDK, workflow and job callbacks.
 * The single-attempt transport takes a credit immediately before dispatch.
 * @param {number} attempts
 * @param {'safe-read' | 'provider-idempotent' | 'single-send'} [safety]
 */
export function createAttemptBudget(attempts, safety = 'safe-read') {
  if (!Number.isSafeInteger(attempts) || attempts < 1
    || !['safe-read', 'provider-idempotent', 'single-send'].includes(safety))
    throw new TypeError('attempt budget needs positive total attempts and an explicit safety category');
  const limit = safety === 'single-send' ? 1 : attempts;
  let used = 0;
  return Object.freeze({
    safety,
    get used() { return used; },
    get remaining() { return limit - used; },
    take() { if (used >= limit) return false; used++; return true; },
  });
}
