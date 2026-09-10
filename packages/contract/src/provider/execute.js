//@ts-check
/** One bounded, single-attempt transport seam with explicit replay safety. */
import { createScheduler } from '@jarenjs/core/schedule';
import { backoffDelay, createAttemptBudget, parseRetryAfter, sleep as defaultSleep } from '@jarenjs/core/retry';
import { ContractHostError } from '../errors.js';

/** @param {string} reason @returns {ContractHostError} */
export const providerHostError = (reason) => new ContractHostError('JC1012', reason);

/**
 * @typedef {Object} ProviderRequest
 * @property {string} url
 * @property {string} [method]
 * @property {Record<string, string>} [headers] - public headers only; credentials belong to host transport
 * @property {string} [body]
 * @property {'safe-read' | 'provider-idempotent' | 'single-send'} safety
 * @property {string} [idempotencyKey] - required evidence for provider-idempotent
 * @property {string} [account] - opaque scheduler scope, never credentials
 */

/**
 * @typedef {Object} ProviderExecutorOptions
 * @property {(request: ProviderRequest, context: { signal: AbortSignal, attempt: number, maxAttempts: 1 }) => Promise<Response>} [transport]
 * @property {number} [attempts]
 * @property {number} [overallMs]
 * @property {number} [attemptMs]
 * @property {number} [maxBytes] - response bytes across all attempts
 * @property {number} [maxRequestBytes]
 * @property {number} [baseMs]
 * @property {number} [maxMs]
 * @property {'http' | 'milliseconds' | 'none'} [retryAfter]
 * @property {string} [retryAfterHeader]
 * @property {number} [concurrency]
 * @property {number} [maxQueue]
 * @property {number} [maxScopes]
 * @property {number} [spacingMs]
 * @property {() => number} [now]
 * @property {() => number} [random]
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} [sleep]
 */

/**
 * Injected transports must issue exactly one request and honor the supplied
 * signal; SDK retry loops must be disabled. Shutdown awaits transport and body
 * settlement even when a transport ignores its signal. JSON outcomes never
 * contain exceptions, request headers, controllers or live response handles.
 * @param {ProviderExecutorOptions} [options]
 */
export function createProviderExecutor(options = {}) {
  const { attempts = 3, overallMs = 30000, attemptMs = 10000, maxBytes = 262144,
    maxRequestBytes = 262144, baseMs = 500, maxMs = 8000, now = Date.now,
    random = Math.random, sleep = defaultSleep, retryAfter = 'http', retryAfterHeader = 'retry-after' } = options;
  for (const [key, value] of Object.entries({ attempts, overallMs, attemptMs, maxBytes, maxRequestBytes })) {
    if (!Number.isSafeInteger(value) || value < 1) throw providerHostError(`${key} must be a positive finite integer`);
  }
  if (![baseMs, maxMs].every((value) => Number.isFinite(value) && value >= 0)
    || typeof now !== 'function' || typeof random !== 'function' || typeof sleep !== 'function'
    || !['http', 'milliseconds', 'none'].includes(retryAfter) || typeof retryAfterHeader !== 'string')
    throw providerHostError('invalid retry policy');
  const transport = options.transport ?? ((request, context) => fetch(request.url, {
    method: request.method, headers: request.headers, body: request.body, signal: context.signal, redirect: 'manual',
  }));
  if (typeof transport !== 'function') throw providerHostError('transport must be a single-attempt function');
  const scheduler = createScheduler({ ...options, now, sleep });
  const closer = new AbortController();
  /** @type {Set<Promise<any>>} */
  const running = new Set();
  const encoder = new TextEncoder();

  /** @param {ProviderRequest} request @param {any} context */
  async function execute(request, context) {
    if (!request || !['safe-read', 'provider-idempotent', 'single-send'].includes(request.safety))
      throw providerHostError('request must declare replay safety');
    if (request.safety === 'provider-idempotent' && (typeof request.idempotencyKey !== 'string' || !request.idempotencyKey))
      throw providerHostError('provider-idempotent requires the provider key');
    let url;
    try { url = new URL(request.url); }
    catch { throw providerHostError('request URL must be absolute HTTP(S)'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw providerHostError('request URL must be absolute HTTP(S) without credentials');
    if (request.body !== undefined && typeof request.body !== 'string') throw providerHostError('only bounded text requests are supported');
    const budget = context.budget ?? createAttemptBudget(attempts, request.safety);
    if (budget.safety !== request.safety || typeof budget.take !== 'function') throw providerHostError('attempt budget safety must match the request');
    const signal = AbortSignal.any([closer.signal, ...(context.signal ? [context.signal] : [])]);
    if (context.deadline !== undefined && (typeof context.deadline !== 'number' || Number.isNaN(context.deadline)))
      throw providerHostError('deadline must be a numeric instant');
    const deadline = Math.min(now() + overallMs, context.deadline ?? Infinity);
    const byteLimit = Math.min(maxBytes, context.maxBytes ?? maxBytes);
    if (!Number.isSafeInteger(byteLimit) || byteLimit < 0) throw providerHostError('per-request byte credit must be a nonnegative finite integer');
    const scope = JSON.stringify([url.origin, request.account ?? '']);
    let count = 0;
    let bytes = 0;
    /** @param {string} state @param {string} reason @param {any} [extra] */
    const outcome = (state, reason, extra = {}) => ({ state, reason, attempts: count, bytes, ...extra });
    if (request.safety === 'provider-idempotent' && options.transport === undefined)
      return outcome('refused', 'idempotency-transport-required');
    if (encoder.encode(request.body ?? '').byteLength > maxRequestBytes) return outcome('refused', 'request-byte-limit');
    for (;;) {
      if (signal.aborted) return outcome('cancelled', 'cancelled');
      if (now() >= deadline) return outcome('refused', 'deadline');
      let result;
      try {
        result = await scheduler.run(async () => {
          const controller = new AbortController();
          const attemptSignal = AbortSignal.any([signal, controller.signal]);
          const timerStop = new AbortController();
          const until = Math.min(deadline, now() + attemptMs);
          const timer = sleep(Math.max(0, until - now()), timerStop.signal).then(() => controller.abort(), () => {});
          try {
            if (context.beforeDispatch && await context.beforeDispatch(request) !== true) return outcome('refused', 'authority-changed');
            if (attemptSignal.aborted || now() >= until) return outcome(signal.aborted ? 'cancelled' : 'refused', signal.aborted ? 'cancelled' : 'deadline');
            if (count >= attempts || !budget.take()) return outcome('refused', 'attempt-budget');
            count++;
            let response;
            try { response = await transport(request, { signal: attemptSignal, attempt: budget.used, maxAttempts: 1 }); }
            catch { return outcome(request.safety === 'single-send' ? 'unresolved' : 'failed', 'transport', { retryable: true }); }
            if (!response || typeof response.status !== 'number' || typeof response.headers?.get !== 'function')
              return outcome('failed', 'transport-shape');
            const rate = parseRetryAfter(response.headers.get(retryAfterHeader), { dialect: retryAfter, now: now() });
            if (rate !== undefined) scheduler.observe(scope, rate);
            const reader = response.body?.getReader();
            let text = '';
            let readFailure = false;
            if (reader) {
              const cancel = () => { reader.cancel().catch(() => {}); };
              attemptSignal.addEventListener('abort', cancel, { once: true });
              const decoder = new TextDecoder('utf-8', { fatal: true });
              try {
                for (;;) {
                  if (attemptSignal.aborted) { await reader.cancel(); break; }
                  const part = await reader.read();
                  if (part.done) { text += decoder.decode(); break; }
                  bytes += part.value.byteLength;
                  if (bytes > byteLimit) { await reader.cancel(); return outcome('refused', 'byte-limit'); }
                  text += decoder.decode(part.value, { stream: true });
                }
              }
              catch { readFailure = true; await reader.cancel().catch(() => {}); }
              finally { attemptSignal.removeEventListener('abort', cancel); reader.releaseLock(); }
            }
            if (signal.aborted) return outcome('cancelled', 'cancelled');
            if (attemptSignal.aborted || now() >= until)
              return outcome(request.safety === 'single-send' ? 'unresolved' : 'failed', 'deadline', { retryable: true });
            if (readFailure) return outcome(request.safety === 'single-send' ? 'unresolved' : 'failed', 'body', { retryable: true });
            const status = response.status;
            const ok = status >= 200 && status < 300;
            return outcome(ok ? 'ok' : 'failed', ok ? 'response' : 'http', {
              status, text, retryAfterMs: rate ?? null,
              retryable: status === 408 || status === 429 || status >= 500,
            });
          }
          finally { timerStop.abort(); await timer; }
        }, { scope, deadline, signal });
      }
      catch (error) {
        const message = error instanceof Error ? error.message : '';
        const reason = ['closed', 'cancelled', 'deadline', 'queue-full', 'scope-limit'].includes(message) ? message : 'host-fault';
        return outcome(signal.aborted ? 'cancelled' : 'refused', signal.aborted ? 'cancelled' : reason);
      }
      if (signal.aborted) return outcome('cancelled', 'cancelled');
      if (!result.retryable || request.safety === 'single-send' || !budget.remaining || count >= attempts) return result;
      const delay = backoffDelay({ baseMs, maxMs, random }, count, result.retryAfterMs ?? undefined);
      if (delay >= deadline - now()) return outcome('refused', 'deadline', { retryAfterMs: result.retryAfterMs ?? null });
      try { await sleep(delay, signal); }
      catch { return outcome('cancelled', 'cancelled'); }
    }
  }

  return Object.freeze({
    /** @param {ProviderRequest} request
     * @param {{ signal?: AbortSignal, deadline?: number, maxBytes?: number, budget?: ReturnType<typeof createAttemptBudget>, beforeDispatch?: (request: ProviderRequest) => boolean | Promise<boolean> }} [context]
     * @returns {Promise<any>} */
    execute(request, context = {}) {
      // Admission and dispatch use one immutable request, even if its caller
      // changes the original object while queued or refreshing authority.
      const captured = request && Object.freeze({ ...request,
        ...(request.headers === undefined ? {} : { headers: Object.freeze({ ...request.headers }) }) });
      const promise = execute(captured, context);
      running.add(promise);
      promise.then(() => running.delete(promise), () => running.delete(promise));
      return promise;
    },
    /** Stop new work and drain requests, body readers and retry waits. */
    async close() {
      closer.abort();
      await scheduler.close();
      await Promise.allSettled([...running]);
    },
    stats: scheduler.stats,
  });
}
