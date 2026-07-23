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
 * Accumulates OpenAI streaming chunks (`choices[0].delta`) into one
 * normalized assistant message. Tool-call fragments merge by `index`;
 * argument strings concatenate across chunks.
 * @returns {{ push: (chunk: any) => string, result: () => any }}
 *   `push` returns the text delta this chunk contributed (may be '').
 */
export function createStreamAccumulator() {
  let role = 'assistant';
  let content = '';
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
        message: { role, content, toolCalls: calls.length > 0 ? calls : null },
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
  return {
    message: {
      role: message.role ?? 'assistant',
      content: typeof message.content === 'string' ? message.content : '',
      toolCalls: calls.length > 0 ? calls : null,
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

/**
 * @typedef {Object} ChatRequest
 * @property {any[]} messages - OpenAI wire-shape messages
 * @property {any[]} [tools] - OpenAI function-tool definitions
 * @property {any} [toolChoice] - `tool_choice` passthrough
 * @property {string} [model] - overrides the client's configured model
 * @property {number} [temperature]
 * @property {boolean} [stream] - default true
 * @property {AbortSignal} [signal]
 * @property {(text: string) => void} [onDelta] - streamed text callback
 */

/**
 * @param {{ provider?: string, baseUrl?: string, apiKey?: string,
 *   model?: string, headers?: Record<string, string>,
 *   fetch?: typeof fetch }} [options]
 * @returns {{ endpoint: { provider: string, url: string,
 *   headers: Record<string, string>, model: string },
 *   complete: (request: ChatRequest) => Promise<any> }}
 */
export function createChatClient(options = {}) {
  const endpoint = resolveEndpoint(options);
  const fetchFn = options.fetch ?? ((url, init) => globalThis.fetch(url, init));

  /** @param {ChatRequest} request */
  async function complete(request) {
    const { messages, tools, toolChoice, signal, onDelta } = request ?? {};
    if (!Array.isArray(messages) || messages.length === 0)
      throw new AiError('AI0001', 'complete() needs a non-empty messages array');
    const model = request.model ?? endpoint.model;
    if (model === '' || model == null)
      throw new AiError('AI0001', 'no model configured — set one in the client options or the request');

    const stream = request.stream ?? true;
    /** @type {any} */
    const body = { model, messages, stream };
    if (Array.isArray(tools) && tools.length > 0) body.tools = tools;
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
    if (typeof request.temperature === 'number') body.temperature = request.temperature;

    const response = await fetchFn(endpoint.url, {
      method: 'POST',
      headers: endpoint.headers,
      body: JSON.stringify(body),
      signal,
    });
    if (response.ok !== true) {
      const excerpt = await readErrorExcerpt(response);
      throw new AiError('AI0002',
        `HTTP ${response.status} from ${endpoint.url}${excerpt === '' ? '' : `: ${excerpt}`}`);
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
      const text = accumulator.push(chunk);
      if (text !== '' && onDelta !== undefined) onDelta(text);
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

  return { endpoint, complete };
}
