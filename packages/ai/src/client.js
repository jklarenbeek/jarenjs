//@ts-check
/**
 * The chat client: one `complete()` call against any OpenAI-compatible
 * `/chat/completions` endpoint, streaming by default. The host injects
 * `fetch` exactly like every other jarenjs boundary injects its
 * environment, so the client runs identically in the browser, in Node
 * and in tests against a scripted stub.
 *
 * The reply is normalized to `{ message: { role, content, toolCalls },
 * finishReason, usage, model }` whether the server streamed deltas or
 * answered in one JSON document.
 */

import { AiError } from './errors.js';
import { resolveEndpoint } from './providers.js';
import { createSseDecoder } from './sse.js';

/**
 * The reasoning text one streamed chunk carries: the OpenRouter/`o`-
 * family `delta.reasoning` string, or the `reasoning_details` text
 * entries some providers emit instead.
 * @param {any} delta
 * @returns {string}
 */
export function reasoningOf(delta) {
  if (typeof delta?.reasoning === 'string') return delta.reasoning;
  if (Array.isArray(delta?.reasoning_details)) {
    let text = '';
    for (const detail of delta.reasoning_details) {
      if (typeof detail?.text === 'string') text += detail.text;
    }
    return text;
  }
  return '';
}

/**
 * Accumulates OpenAI streaming chunks (`choices[0].delta`) into one
 * normalized assistant message. Tool-call fragments merge by `index`;
 * argument strings concatenate across chunks; reasoning deltas
 * accumulate into `message.reasoning` (absent when the model emitted
 * none) so a reasoning-only turn is distinguishable from an empty one.
 * @returns {{ push: (chunk: any) => string, result: () => any }}
 *   `push` returns the text delta this chunk contributed (may be '').
 */
export function createStreamAccumulator() {
  let role = 'assistant';
  let content = '';
  let reasoning = '';
  /** @type {any[]} */
  const toolCalls = [];
  let finishReason = null;
  let usage = null;
  let model = null;

  return {
    push(chunk) {
      if (chunk === null || typeof chunk !== 'object') return '';
      if (typeof chunk.model === 'string') model = chunk.model;
      if (chunk.usage != null) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (choice == null) return '';
      if (choice.finish_reason != null) finishReason = choice.finish_reason;
      const delta = choice.delta ?? choice.message ?? {};
      if (typeof delta.role === 'string') role = delta.role;
      reasoning += reasoningOf(delta);
      let text = '';
      if (typeof delta.content === 'string') {
        content += delta.content;
        text = delta.content;
      }
      for (const fragment of delta.tool_calls ?? []) {
        const at = fragment.index ?? toolCalls.length;
        const slot = toolCalls[at] ?? (toolCalls[at] = { id: '', name: '', arguments: '' });
        if (typeof fragment.id === 'string' && fragment.id !== '') slot.id = fragment.id;
        if (typeof fragment.function?.name === 'string' && slot.name === '')
          slot.name = fragment.function.name;
        if (typeof fragment.function?.arguments === 'string')
          slot.arguments += fragment.function.arguments;
      }
      return text;
    },
    result() {
      const calls = toolCalls
        .filter((call) => call != null)
        .map((call, i) => ({ ...call, id: call.id === '' ? `call_${i}` : call.id }));
      return {
        message: {
          role,
          content,
          toolCalls: calls.length > 0 ? calls : null,
          ...(reasoning === '' ? {} : { reasoning }),
        },
        finishReason,
        usage,
        model,
      };
    },
  };
}

/**
 * @param {any} payload - a complete (non-streamed) chat completion
 * @returns {any} the normalized result
 */
function fromCompletion(payload) {
  const choice = payload?.choices?.[0];
  if (choice == null || typeof choice !== 'object')
    throw new AiError('AI0003', 'malformed completion: no choices in the response');
  const message = choice.message ?? {};
  const calls = (message.tool_calls ?? []).map((call, i) => ({
    id: typeof call.id === 'string' && call.id !== '' ? call.id : `call_${i}`,
    name: call.function?.name ?? '',
    arguments: call.function?.arguments ?? '',
  }));
  const reasoning = reasoningOf(message);
  return {
    message: {
      role: message.role ?? 'assistant',
      content: typeof message.content === 'string' ? message.content : '',
      toolCalls: calls.length > 0 ? calls : null,
      ...(reasoning === '' ? {} : { reasoning }),
    },
    finishReason: choice.finish_reason ?? null,
    usage: payload.usage ?? null,
    model: payload.model ?? null,
  };
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

//#region retry policy

/** Statuses worth a retry: timeout, rate limit, server-side failure. */
function isRetryableStatus(status) {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/**
 * Parse a `Retry-After` header (delta-seconds or HTTP-date) into ms.
 * @param {any} response
 * @returns {number | undefined}
 */
function retryAfterMs(response) {
  const raw = response?.headers?.get?.('retry-after');
  if (raw == null || raw === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
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

/** The abort reason, or a platform-shaped AbortError. */
function abortError(signal) {
  if (signal?.reason !== undefined) return signal.reason;
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/**
 * @param {{ attempts?: number, baseMs?: number, maxMs?: number,
 *   random?: () => number,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } | undefined} retry
 */
function normalizeRetry(retry) {
  return {
    attempts: Math.max(1, retry?.attempts ?? 3),
    baseMs: retry?.baseMs ?? 500,
    maxMs: retry?.maxMs ?? 8000,
    random: retry?.random ?? Math.random,
    sleep: retry?.sleep ?? defaultSleep,
  };
}

//#endregion

/**
 * @typedef {Object} ChatRequest
 * @property {any[]} messages - OpenAI wire-shape messages
 * @property {any[]} [tools] - OpenAI function-tool definitions
 * @property {any} [toolChoice] - `tool_choice` passthrough
 * @property {string} [model] - overrides the client's configured model
 * @property {number} [temperature]
 * @property {boolean} [stream] - default true
 * @property {{ name?: string, schema?: any, strict?: boolean, type?: 'json' }} [responseFormat]
 *   - structured output: `{ name, schema, strict? }` emits the OpenAI
 *   `response_format: { type: "json_schema", … }` wire shape (strict
 *   defaults to true); `{ type: 'json' }` emits `json_object` mode
 * @property {AbortSignal} [signal]
 * @property {(text: string) => void} [onDelta] - streamed text callback
 * @property {(text: string) => void} [onReasoning] - streamed reasoning
 *   callback (reasoning models emit thinking before/instead of content)
 */

/**
 * @param {{ provider?: string, baseUrl?: string, apiKey?: string,
 *   model?: string, headers?: Record<string, string>,
 *   fetch?: typeof fetch,
 *   retry?: { attempts?: number, baseMs?: number, maxMs?: number,
 *     random?: () => number,
 *     sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } }} [options]
 *   - `retry.attempts` is the TOTAL number of tries (default 3; 1
 *     disables retrying); backoff is exponential with full jitter,
 *     capped at `maxMs`, and a provider `Retry-After` wins over the
 *     computed delay. `random` and `sleep` exist for deterministic
 *     tests.
 * @returns {{ endpoint: { provider: string, url: string,
 *   headers: Record<string, string>, model: string },
 *   complete: (request: ChatRequest) => Promise<any> }}
 */
export function createChatClient(options = {}) {
  const endpoint = resolveEndpoint(options);
  const fetchFn = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const retry = normalizeRetry(options.retry);

  /**
   * One request/response cycle. `state.delivered` flips as soon as a
   * streamed delta reaches the caller's `onDelta` — the point of no
   * return for the retry loop (the caller has observed output).
   * @param {ChatRequest} request
   * @param {{ delivered: boolean }} state
   */
  async function attemptOnce(request, state) {
    const { messages, tools, toolChoice, signal, onDelta, onReasoning } = request;
    const model = request.model ?? endpoint.model;
    const stream = request.stream ?? true;
    /** @type {any} */
    const body = { model, messages, stream };
    if (Array.isArray(tools) && tools.length > 0) body.tools = tools;
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
    if (typeof request.temperature === 'number') body.temperature = request.temperature;
    const format = request.responseFormat;
    if (format !== undefined) {
      body.response_format = format.type === 'json'
        ? { type: 'json_object' }
        : {
          type: 'json_schema',
          json_schema: {
            name: format.name ?? 'result',
            schema: format.schema,
            strict: format.strict ?? true,
          },
        };
    }

    /** @type {any} */
    let response;
    try {
      response = await fetchFn(endpoint.url, {
        method: 'POST',
        headers: endpoint.headers,
        body: JSON.stringify(body),
        signal,
      });
    }
    catch (err) {
      if (/** @type {any} */ (err)?.name === 'AbortError') throw err;
      throw new AiError('AI0002',
        `network error calling ${endpoint.url}: ${/** @type {any} */ (err)?.message ?? err}`,
        { status: 0, cause: err });
    }
    if (response.ok !== true) {
      const excerpt = await readErrorExcerpt(response);
      throw new AiError('AI0002',
        `HTTP ${response.status} from ${endpoint.url}${excerpt === '' ? '' : `: ${excerpt}`}`,
        { status: response.status, retryAfterMs: retryAfterMs(response) });
    }
    if (!stream) return fromCompletion(await response.json());

    const decoder = createSseDecoder();
    const accumulator = createStreamAccumulator();
    /** @param {string} payload */
    const handle = (payload) => {
      if (payload === '[DONE]') return;
      /** @type {any} */
      let chunk;
      try {
        chunk = JSON.parse(payload);
      }
      catch {
        throw new AiError('AI0003', `malformed stream chunk: ${payload.slice(0, 120)}`);
      }
      if (onReasoning !== undefined) {
        const thinking = reasoningOf(chunk?.choices?.[0]?.delta ?? {});
        if (thinking !== '') onReasoning(thinking);
      }
      const text = accumulator.push(chunk);
      if (text !== '' && onDelta !== undefined) {
        state.delivered = true;
        onDelta(text);
      }
    };

    if (typeof response.body?.getReader === 'function') {
      const reader = response.body.getReader();
      const textDecoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const payload of decoder.feed(textDecoder.decode(value, { stream: true })))
          handle(payload);
      }
      for (const payload of decoder.end()) handle(payload);
    }
    else {
      // a host without a readable body (test stubs, exotic fetch
      // shims): the text is either one JSON document or a full SSE log
      const text = await response.text();
      if (/^\s*\{/.test(text)) return fromCompletion(JSON.parse(text));
      for (const payload of decoder.feed(text)) handle(payload);
      for (const payload of decoder.end()) handle(payload);
    }
    return accumulator.result();
  }

  /** @param {ChatRequest} request */
  async function complete(request) {
    const { messages, signal } = request ?? {};
    if (!Array.isArray(messages) || messages.length === 0)
      throw new AiError('AI0001', 'complete() needs a non-empty messages array');
    const model = request.model ?? endpoint.model;
    if (model === '' || model == null)
      throw new AiError('AI0001', 'no model configured — set one in the client options or the request');

    // the retry loop: transient transport failures (network, 408, 429,
    // 5xx) back off and try again — but never after the caller has
    // observed streamed output, and never past an abort
    const state = { delivered: false };
    for (let attempt = 1; ; attempt++) {
      try {
        return await attemptOnce(request, state);
      }
      catch (err) {
        const failure = /** @type {any} */ (err);
        const retryable = failure instanceof AiError && failure.code === 'AI0002'
          && isRetryableStatus(failure.status ?? -1)
          && !state.delivered
          && attempt < retry.attempts;
        if (!retryable) {
          if (failure instanceof AiError && failure.code === 'AI0002')
            failure.attempts = attempt;
          throw err;
        }
        const backoff = Math.min(retry.maxMs, retry.baseMs * 2 ** (attempt - 1));
        const delay = failure.retryAfterMs !== undefined
          ? Math.min(retry.maxMs, failure.retryAfterMs)
          : backoff * (0.5 + 0.5 * retry.random());
        await retry.sleep(delay, signal);
      }
    }
  }

  return { endpoint, complete };
}
