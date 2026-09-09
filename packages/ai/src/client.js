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
import {
  normalizeRetry, withRetry, isTransientFailure, httpFailure, transportFailure,
} from './retry.js';
import { createSseDecoder } from './sse.js';
import { normalizeCache, replayKey, verifyChatEntry, cloneJson, now } from './replay.js';

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
 * A reply that arrived as text rather than as a stream of events: one
 * JSON completion document — a provider or proxy that ignores `stream`
 * — or nothing this client can read. One implementation for every place
 * that can happen (a nonstreaming request, a fetch without a readable
 * body, and a stream that closed without a single event), so all answer
 * the same way: the message, or `AI0003`. Never a silent empty message.
 * @param {string} text
 * @returns {any} the normalized result
 */
function completionFromText(text) {
  if (!/^\s*\{/.test(text))
    throw new AiError('AI0003', `expected an SSE stream or a JSON completion, got: ${text.slice(0, 120)}`);
  /** @type {any} */
  let payload;
  try {
    payload = JSON.parse(text);
  }
  catch {
    throw new AiError('AI0003', `malformed completion: ${text.slice(0, 120)}`);
  }
  return fromCompletion(payload);
}

/**
 * @typedef {Object} ChatRequest
 * @property {any[]} messages - OpenAI wire-shape messages
 * @property {any[]} [tools] - OpenAI function-tool definitions
 * @property {any} [toolChoice] - `tool_choice` passthrough
 * @property {string} [model] - overrides the client's configured model
 * @property {number} [temperature]
 * @property {number} [maxTokens] - token ceiling for this reply, sent under
 *   the client's `maxTokensField`. Overrides the client default; when
 *   both are unset, the provider chooses the limit. With
 *   `max_completion_tokens`, reasoning tokens share this budget with
 *   visible output tokens.
 * @property {boolean} [stream] - default true
 * @property {{ name?: string, schema?: any, strict?: boolean, type?: 'json' }} [responseFormat]
 *   - structured output: `{ name, schema, strict? }` emits the OpenAI
 *   `response_format: { type: "json_schema", … }` wire shape (strict
 *   defaults to true); `{ type: 'json' }` emits `json_object` mode
 * @property {{ effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high',
 *   enabled?: boolean, exclude?: boolean, max_tokens?: number }} [reasoning]
 *   - the provider-normalized thinking control, forwarded verbatim.
 *   `{ effort: 'none' }` (or `{ enabled: false }`) turns a hybrid
 *   thinking model OFF: it answers directly, which on a short task is
 *   dramatically cheaper and faster. `{ exclude: true }` only HIDES the
 *   thinking — the model still thinks and you still pay for it.
 *   Overrides the client-level default.
 * @property {AbortSignal} [signal]
 * @property {(text: string) => void} [onDelta] - streamed text callback
 * @property {(text: string) => void} [onReasoning] - streamed reasoning
 *   callback (reasoning models emit thinking before/instead of content)
 */

/**
 * @param {{ provider?: string, baseUrl?: string, apiKey?: string,
 *   model?: string, headers?: Record<string, string>,
 *   fetch?: typeof fetch, maxTokens?: number,
 *   maxTokensField?: 'max_tokens' | 'max_completion_tokens',
 *   reasoning?: { effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high',
 *     enabled?: boolean, exclude?: boolean, max_tokens?: number },
 *   retry?: import('./retry.js').RetryOptions,
 *   cache?: import('./replay.js').ReplayCache }} [options]
 *   - `maxTokensField` selects the wire field for client and request
 *     `maxTokens` budgets (default `'max_tokens'`). Select
 *     `'max_completion_tokens'` for OpenAI Chat Completions, including
 *     reasoning models. The selection is explicit, not inferred from
 *     the URL or model; exactly one field is sent when a budget is set.
 *   - `reasoning` is the default thinking control for every request (see
 *     `ChatRequest.reasoning`); a per-request value overrides it.
 *   - `cache` is the replay seam: `{ get(key), set(key, value) }`, each
 *     sync or async. The client keys every request by its effective
 *     credential-free wire body after endpoint resolution and default
 *     application (`stream`, the signal and the callbacks never enter
 *     the key), answers a remembered reply with ZERO transport calls,
 *     marked `replayed: { ms }` — the wall time of the purchase — with
 *     `onDelta`/`onReasoning` fired once each with the whole text, and
 *     remembers a bought reply as `{ value, ms }`. The seam fails closed:
 *     an adapter that throws fails the call; a stored entry that does not
 *     verify is `AI0003`; a request that cannot be keyed (a function
 *     inside `tools`) is `AI0001` before any wire call. The key is the
 *     complete canonical request — an adapter wanting a fixed-width id
 *     hashes it cryptographically, never with a 32-bit hash.
 *   - `retry.attempts` is the TOTAL number of tries (default 3; 1
 *     disables retrying); backoff is exponential with full jitter,
 *     capped at `maxMs`. A provider `Retry-After` (seconds or HTTP-date)
 *     wins over the computed delay, capped at `maxMs` too: a provider
 *     asking for a minute gets the cap (8 000 ms by default), and the
 *     value it asked for rides the final error as `retryAfterMs` for
 *     the caller to honour. `random` and `sleep` exist for deterministic
 *     tests.
 * @returns {{ endpoint: { provider: string, base: string, url: string,
 *   headers: Record<string, string>, model: string },
 *   complete: (request: ChatRequest) => Promise<any> }}
 */
export function createChatClient(options = {}) {
  const endpoint = resolveEndpoint(options);
  const maxTokensField = options.maxTokensField ?? 'max_tokens';
  if (maxTokensField !== 'max_tokens' && maxTokensField !== 'max_completion_tokens')
    throw new AiError('AI0001', "maxTokensField must be 'max_tokens' or 'max_completion_tokens'");
  const fetchFn = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const retry = normalizeRetry(options.retry);
  const cache = normalizeCache(options.cache);

  /**
   * The body one request POSTs, defaults applied. One construction for
   * the wire and for the replay key, so the two cannot drift: what is
   * keyed is exactly what would be sent.
   * @param {ChatRequest} request
   * @returns {any}
   */
  function requestBody(request) {
    const { messages, tools, toolChoice } = request;
    const model = request.model ?? endpoint.model;
    const stream = request.stream ?? true;
    /** @type {any} */
    const body = { model, messages, stream };
    if (Array.isArray(tools) && tools.length > 0) body.tools = tools;
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
    if (typeof request.temperature === 'number') body.temperature = request.temperature;
    // an unset ceiling is not "no ceiling": a provider substitutes the
    // model's whole context window, and an aggregator that bills against
    // a balance REFUSES the request when it cannot afford that worst case
    // (OpenRouter answers 402 naming the number it wanted). A caller that
    // knows its answer is a few thousand tokens should be able to say so.
    const maxTokens = request.maxTokens ?? options.maxTokens;
    if (typeof maxTokens === 'number') body[maxTokensField] = maxTokens;
    // the thinking control rides through untouched — a hybrid model needs
    // it to answer WITHOUT reasoning first, and a body that silently drops
    // it is indistinguishable from a provider that ignores it
    const reasoning = request.reasoning ?? options.reasoning;
    if (reasoning !== undefined) body.reasoning = reasoning;
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
    return body;
  }

  /**
   * One request/response cycle. `state.delivered` flips as soon as a
   * streamed delta reaches `onDelta` or `onReasoning` — the point of no
   * return for the retry loop (the caller has observed output).
   * @param {ChatRequest} request
   * @param {{ delivered: boolean }} state
   */
  async function attemptOnce(request, state) {
    const { signal, onDelta, onReasoning } = request;
    const body = requestBody(request);
    const stream = body.stream;

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
      throw transportFailure(err, endpoint.url);
    }
    if (response.ok !== true) throw await httpFailure(response, endpoint.url);
    if (!stream) return completionFromText(await response.text());

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
        if (thinking !== '') {
          state.delivered = true;
          onReasoning(thinking);
        }
      }
      const text = accumulator.push(chunk);
      if (text !== '' && onDelta !== undefined) {
        state.delivered = true;
        onDelta(text);
      }
    };

    // the body's text is kept only until the first event arrives: a
    // reply that closes without one was never a stream (see below), and
    // must then be read whole as a document
    let events = 0;
    let raw = '';
    /** @param {string} text */
    const feed = (text) => {
      if (events === 0) raw += text;
      for (const payload of decoder.feed(text)) {
        events += 1;
        handle(payload);
      }
      if (events > 0) raw = '';
    };
    if (typeof response.body?.getReader === 'function') {
      const reader = response.body.getReader();
      const textDecoder = new TextDecoder();
      let finished = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) { finished = true; break; }
          feed(textDecoder.decode(value, { stream: true }));
        }
      }
      finally {
        if (!finished) {
          try { await reader.cancel(); }
          catch { /* Preserve the read, decoding or callback failure. */ }
        }
        reader.releaseLock();
      }
    }
    else {
      // a host without a readable body (test stubs, exotic fetch shims)
      // hands over the whole text at once
      feed(await response.text());
    }
    for (const payload of decoder.end()) {
      events += 1;
      handle(payload);
    }
    // zero events means the reply was never a stream: a provider or proxy
    // that ignores `stream` answers one JSON document, and anything else
    // is malformed — either way a coded answer, never an empty message
    if (events === 0) return completionFromText(raw);
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

    // transient transport failures (network, 408, 429, 5xx) and a
    // malformed 200 — no choices, a bad chunk — back off and try again
    // through the shared policy; the one judgment that is this wire's
    // own is the `!state.delivered` guard, which keeps a retry from ever
    // re-sending after the caller has observed streamed output
    const state = { delivered: false };
    const buy = () => withRetry(retry, () => attemptOnce(request, state), {
      signal,
      retryable: (failure) => isTransientFailure(failure) && !state.delivered,
    });
    if (cache === null) return buy();

    // the key is the body the wire would see, minus `stream`: a reply
    // streamed or answered whole is the same reply, and the callbacks
    // are fired on a replay so a streaming caller sees one path
    const { stream: _stream, ...keyed } = requestBody(request);
    const key = replayKey('chat', endpoint, keyed);
    const hit = await cache.get(key);
    if (hit !== undefined) {
      const { value, ms } = verifyChatEntry(hit);
      const result = cloneJson(value);
      const reasoning = result.message.reasoning;
      if (typeof reasoning === 'string' && reasoning !== '' && request.onReasoning !== undefined)
        request.onReasoning(reasoning);
      const content = result.message.content;
      if (typeof content === 'string' && content !== '' && request.onDelta !== undefined)
        request.onDelta(content);
      return { ...result, replayed: { ms } };
    }
    const started = now();
    const result = await buy();
    // a `set` that throws fails the call AFTER the purchase — the reply
    // was bought and is lost, which is the loud failure a broken cache
    // deserves (fail closed; an adapter that wants otherwise catches)
    await cache.set(key, { value: cloneJson(result), ms: now() - started });
    return result;
  }

  return { endpoint, complete };
}
