//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createChatClient, createStreamAccumulator, AiError } from '@jarenjs/ai';

/** Build an SSE body from chat chunks (objects) plus the [DONE] marker. */
function sseBody(chunks) {
  return chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('')
    + 'data: [DONE]\n\n';
}

const delta = (d, finish = null) => ({ choices: [{ delta: d, finish_reason: finish }] });

describe('ai — the chat client', function () {
  it('streams: SSE deltas accumulate, onDelta fires per text fragment', async function () {
    /** @type {any[]} */
    const calls = [];
    const body = sseBody([
      { model: 'm1', choices: [{ delta: { role: 'assistant', content: 'Hel' } }] },
      delta({ content: 'lo' }),
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 7 } },
    ]);
    const client = createChatClient({
      provider: 'ollama', model: 'qwen3:4b',
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(new Response(body, { status: 200 }));
      },
    });
    const deltas = [];
    const result = await client.complete({
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (text) => deltas.push(text),
    });
    assert.deepStrictEqual(deltas, ['Hel', 'lo']);
    assert.strictEqual(result.message.content, 'Hello');
    assert.strictEqual(result.message.toolCalls, null);
    assert.strictEqual(result.finishReason, 'stop');
    assert.strictEqual(result.usage.total_tokens, 7);
    assert.strictEqual(result.model, 'm1');

    assert.strictEqual(calls[0].url, 'http://localhost:11434/v1/chat/completions');
    const sent = JSON.parse(calls[0].init.body);
    assert.strictEqual(sent.model, 'qwen3:4b');
    assert.strictEqual(sent.stream, true);
    assert.strictEqual(sent.tools, undefined, 'no tools key when none are given');
  });

  it('streams fragmented tool calls into complete calls', async function () {
    const body = sseBody([
      delta({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'run', arguments: '{"en' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'gine":"path"}' } }] }),
      delta({}, 'tool_calls'),
    ]);
    const client = createChatClient({
      provider: 'lmstudio', model: 'local',
      fetch: () => Promise.resolve(new Response(body, { status: 200 })),
    });
    const result = await client.complete({
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ type: 'function', function: { name: 'run', parameters: {} } }],
    });
    assert.deepStrictEqual(result.message.toolCalls,
      [{ id: 'call_a', name: 'run', arguments: '{"engine":"path"}' }]);
    assert.strictEqual(result.finishReason, 'tool_calls');
  });

  it('non-streaming: one JSON completion normalizes the same way', async function () {
    const payload = {
      model: 'm2',
      choices: [{
        message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: '', function: { name: 'f', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { total_tokens: 3 },
    };
    const client = createChatClient({
      provider: 'ollama', model: 'x',
      fetch: () => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
    });
    const result = await client.complete({
      messages: [{ role: 'user', content: 'hi' }], stream: false,
    });
    assert.strictEqual(result.message.content, '', 'null content normalizes to the empty string');
    assert.deepStrictEqual(result.message.toolCalls, [{ id: 'call_0', name: 'f', arguments: '{}' }]);
    assert.strictEqual(result.model, 'm2');
  });

  it('a bodyless response still works: JSON or a full SSE log as text', async function () {
    const jsonClient = createChatClient({
      provider: 'ollama', model: 'x',
      fetch: () => Promise.resolve(/** @type {any} */ ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'plain' } }] }),
      })),
    });
    const fromJson = await jsonClient.complete({ messages: [{ role: 'user', content: 'q' }] });
    assert.strictEqual(fromJson.message.content, 'plain');

    const sseClient = createChatClient({
      provider: 'ollama', model: 'x',
      fetch: () => Promise.resolve(/** @type {any} */ ({
        ok: true, status: 200,
        text: async () => sseBody([delta({ content: 'streamed-as-text' }, 'stop')]),
      })),
    });
    const fromSse = await sseClient.complete({ messages: [{ role: 'user', content: 'q' }] });
    assert.strictEqual(fromSse.message.content, 'streamed-as-text');
  });

  it('HTTP errors throw AI0002 with a body excerpt', async function () {
    const client = createChatClient({
      provider: 'openrouter', apiKey: 'bad', model: 'm',
      fetch: () => Promise.resolve(new Response('{"error":"invalid key"}', { status: 401 })),
    });
    await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (err) => err instanceof AiError && err.code === 'AI0002'
        && /401/.test(err.message) && /invalid key/.test(err.message));
  });

  it('malformed payloads throw AI0003', async function () {
    const streamClient = createChatClient({
      provider: 'ollama', model: 'x',
      fetch: () => Promise.resolve(new Response('data: {not json}\n\n', { status: 200 })),
    });
    await assert.rejects(streamClient.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (err) => err instanceof AiError && err.code === 'AI0003');

    const emptyClient = createChatClient({
      provider: 'ollama', model: 'x',
      fetch: () => Promise.resolve(new Response('{"choices":[]}', { status: 200 })),
    });
    await assert.rejects(
      emptyClient.complete({ messages: [{ role: 'user', content: 'x' }], stream: false }),
      (err) => err instanceof AiError && err.code === 'AI0003');
  });

  it('caller errors throw AI0001: empty messages, missing model', async function () {
    const client = createChatClient({
      provider: 'ollama', model: 'x',
      fetch: () => { throw new Error('must not reach fetch'); },
    });
    await assert.rejects(client.complete({ messages: [] }),
      (err) => err instanceof AiError && err.code === 'AI0001');

    const modelless = createChatClient({
      provider: 'ollama',
      fetch: () => { throw new Error('must not reach fetch'); },
    });
    await assert.rejects(modelless.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (err) => err instanceof AiError && err.code === 'AI0001' && /model/.test(err.message));
  });

  it('falls back to the global fetch when none is injected', async function () {
    const original = globalThis.fetch;
    /** @type {any} */
    let seen = null;
    globalThis.fetch = /** @type {any} */ ((url, init) => {
      seen = { url, init };
      return Promise.resolve(new Response(
        JSON.stringify({ choices: [{ message: { content: 'via global' } }] }), { status: 200 }));
    });
    try {
      const client = createChatClient({ provider: 'ollama', model: 'm' });
      const result = await client.complete({
        messages: [{ role: 'user', content: 'x' }], stream: false,
      });
      assert.strictEqual(result.message.content, 'via global');
      assert.strictEqual(seen.url, 'http://localhost:11434/v1/chat/completions');
    }
    finally {
      globalThis.fetch = original;
    }
  });

  it('passes through tool_choice and temperature, and request model wins', async function () {
    /** @type {any} */
    let sent = null;
    const client = createChatClient({
      provider: 'ollama', model: 'default-model',
      fetch: (url, init) => {
        sent = JSON.parse(init.body);
        return Promise.resolve(new Response(
          JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
      },
    });
    await client.complete({
      messages: [{ role: 'user', content: 'x' }],
      stream: false, model: 'override', temperature: 0.2, toolChoice: 'none',
    });
    assert.strictEqual(sent.model, 'override');
    assert.strictEqual(sent.temperature, 0.2);
    assert.strictEqual(sent.tool_choice, 'none');
  });
});

describe('ai — the stream accumulator', function () {
  it('tolerates garbage chunks and missing pieces', function () {
    const acc = createStreamAccumulator();
    assert.strictEqual(acc.push(null), '');
    assert.strictEqual(acc.push('nope'), '');
    assert.strictEqual(acc.push({}), '');
    assert.strictEqual(acc.push({ choices: [] }), '');
    const result = acc.result();
    assert.strictEqual(result.message.content, '');
    assert.strictEqual(result.message.toolCalls, null);
    assert.strictEqual(result.finishReason, null);
  });

  it('generates ids for tool calls the provider left unidentified', function () {
    const acc = createStreamAccumulator();
    acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'f', arguments: '{}' } }] } }] });
    assert.deepStrictEqual(acc.result().message.toolCalls,
      [{ id: 'call_0', name: 'f', arguments: '{}' }]);
  });

  it('accepts full-message chunks (servers that skip the delta shape)', function () {
    const acc = createStreamAccumulator();
    acc.push({ choices: [{ message: { role: 'assistant', content: 'whole' }, finish_reason: 'stop' }] });
    const result = acc.result();
    assert.strictEqual(result.message.content, 'whole');
    assert.strictEqual(result.finishReason, 'stop');
  });
});
