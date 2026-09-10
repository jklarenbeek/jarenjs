//@ts-check
/** Shared backoff arithmetic, abortable waits and an explicit dispatch budget. */

/**
 * Calculate a delay; strict never shortens the server's minimum wait.
 * Compatibility policies retain the published clients' distinct jitter shapes.
 * @param {{ policy?: 'strict' | 'ai-compat' | 'contract-compat', baseMs?: number, maxMs?: number, random?: () => number }} options
 * @param {number} attempt - failed attempt, counted from one
 * @param {number} [retryAfterMs]
 * @returns {number}
 */
export function backoffDelay(options, attempt, retryAfterMs = undefined) {
  const { policy = 'strict', baseMs = 500, maxMs = 8000, random = Math.random } = options;
  const cap = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  if (retryAfterMs !== undefined)
    return policy === 'ai-compat' ? Math.min(maxMs, retryAfterMs) : Math.max(0, retryAfterMs);
  if (policy === 'contract-compat') return cap + Math.floor(random() * 250);
  return cap * (policy === 'ai-compat' ? 0.5 + 0.5 * random() : random());
}

/**
 * Parse only the selected header dialect. HTTP accepts seconds or HTTP-date;
 * milliseconds accepts nonnegative numbers only; none ignores the header.
 * @param {string | null | undefined} raw
 * @param {{ dialect?: 'http' | 'milliseconds' | 'none', now?: number }} [options]
 * @returns {number | undefined}
 */
export function parseRetryAfter(raw, { dialect = 'http', now = Date.now() } = {}) {
  if (raw == null || raw === '' || dialect === 'none') return undefined;
  const number = Number(raw);
  if (Number.isFinite(number) && number >= 0) return number * (dialect === 'milliseconds' ? 1 : 1000);
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

/** Abortable timer with listener cleanup on either settlement.
 * @param {number} ms @param {AbortSignal} [signal] @returns {Promise<void>} */
export function sleep(ms, signal = undefined) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
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
