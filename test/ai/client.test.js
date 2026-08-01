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

describe('ai — reasoning streams', function () {
  it('streams reasoning through onReasoning and onto message.reasoning', async function () {
    const body = sseBody([
      delta({ reasoning: 'Let me think. ' }),
      delta({ reasoning_details: [{ type: 'reasoning.text', text: 'Two steps.' }] }),
      delta({ content: 'Answer.' }, 'stop'),
    ]);
    const client = createChatClient({
      provider: 'ollama', model: 'm',
      fetch: () => Promise.resolve(new Response(body, { status: 200 })),
    });
    const thinking = [];
    const deltas = [];
    const result = await client.complete({
      messages: [{ role: 'user', content: 'q' }],
      onReasoning: (t) => thinking.push(t),
      onDelta: (t) => deltas.push(t),
    });
    assert.deepStrictEqual(thinking, ['Let me think. ', 'Two steps.']);
    assert.deepStrictEqual(deltas, ['Answer.']);
    assert.strictEqual(result.message.content, 'Answer.');
    assert.strictEqual(result.message.reasoning, 'Let me think. Two steps.');
  });

  it('a reasoning-only turn keeps content empty but exposes the reasoning', async function () {
    const body = sseBody([delta({ reasoning: 'thought a lot' }, 'stop')]);
    const client = createChatClient({
      provider: 'ollama', model: 'm',
      fetch: () => Promise.resolve(new Response(body, { status: 200 })),
    });
    const result = await client.complete({ messages: [{ role: 'user', content: 'q' }] });
    assert.strictEqual(result.message.content, '');
    assert.strictEqual(result.message.reasoning, 'thought a lot');
  });

  it('a plain turn carries no reasoning member at all', async function () {
    const client = createChatClient({
      provider: 'ollama', model: 'm',
      fetch: () => Promise.resolve(new Response(
        JSON.stringify({ choices: [{ message: { content: 'plain' } }] }), { status: 200 })),
    });
    const result = await client.complete({ messages: [{ role: 'user', content: 'q' }], stream: false });
    assert.strictEqual('reasoning' in result.message, false);
  });
});

describe('ai — the retry policy', function () {
  /** A client over a scripted sequence of fetch outcomes. */
  function scriptedClient(outcomes, retryOptions = {}) {
    /** @type {number[]} */
    const delays = [];
    let call = 0;
    const client = createChatClient({
      provider: 'ollama', model: 'm',
      retry: { random: () => 1, sleep: (ms) => { delays.push(ms); return Promise.resolve(); }, ...retryOptions },
      fetch: () => {
        const outcome = outcomes[Math.min(call++, outcomes.length - 1)];
        if (outcome instanceof Error) return Promise.reject(outcome);
        return Promise.resolve(outcome);
      },
    });
    return { client, delays, calls: () => call };
  }

  const ok = () => new Response(
    JSON.stringify({ choices: [{ message: { content: 'recovered' } }] }), { status: 200 });

  it('retries 429 then succeeds, recording the attempt count', async function () {
    const { client, delays, calls } = scriptedClient([
      new Response('slow down', { status: 429 }),
      ok(),
    ]);
    const result = await client.complete({ messages: [{ role: 'user', content: 'x' }], stream: false });
    assert.strictEqual(result.message.content, 'recovered');
    assert.strictEqual(calls(), 2);
    assert.deepStrictEqual(delays, [500], 'first backoff = baseMs · 2⁰ · full jitter(random=1)');
  });

  it('retries a transient no-choices completion (AI0003) then succeeds', async function () {
    // a 200 that carried no choices is a transient provider hiccup — common
    // on busy cheap models — and must be retried, or one bad response kills
    // a whole autonomous run
    const { client, delays, calls } = scriptedClient([
      new Response('{"choices":[]}', { status: 200 }),
      ok(),
    ]);
    const result = await client.complete({ messages: [{ role: 'user', content: 'x' }], stream: false });
    assert.strictEqual(result.message.content, 'recovered');
    assert.strictEqual(calls(), 2);
    assert.deepStrictEqual(delays, [500]);
  });

  it('exhausts attempts on persistent AI0003 and reports the count', async function () {
    // a fresh Response per attempt (a Response body reads only once)
    let n = 0;
    const client = createChatClient({
      provider: 'ollama', model: 'm',
      retry: { random: () => 1, sleep: () => Promise.resolve() },
      fetch: () => { n++; return Promise.resolve(new Response('{"choices":[]}', { status: 200 })); },
    });
    await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'x' }], stream: false }),
      (err) => err instanceof AiError && err.code === 'AI0003' && err.attempts === 3);
    assert.strictEqual(n, 3);
  });

  it('exhausts attempts on persistent 500s and reports them on AI0002', async function () {
    const { client, delays, calls } = scriptedClient([
      new Response('boom', { status: 500 }),
    ]);
    await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (err) => err instanceof AiError && err.code === 'AI0002'
        && err.status === 500 && err.attempts === 3);
    assert.strictEqual(calls(), 3);
    assert.deepStrictEqual(delays, [500, 1000], 'exponential backoff between the three tries');
  });

  it('honors Retry-After seconds over the computed backoff, capped by maxMs', async function () {
    const { client, delays } = scriptedClient([
      new Response('later', { status: 429, headers: { 'retry-after': '2' } }),
      ok(),
    ]);
    await client.complete({ messages: [{ role: 'user', content: 'x' }], stream: false });
    assert.deepStrictEqual(delays, [2000]);

    const capped = scriptedClient([
      new Response('later', { status: 429, headers: { 'retry-after': '60' } }),
      ok(),
    ], { maxMs: 4000 });
    await capped.client.complete({ messages: [{ role: 'user', content: 'x' }], stream: false });
    assert.deepStrictEqual(capped.delays, [4000], 'Retry-After capped at maxMs');
  });

  it('honors a Retry-After HTTP-date, capped by maxMs when the date is far off', async function () {
    const { client, delays } = scriptedClient([
      new Response('later', {
        status: 429,
        headers: { 'retry-after': new Date(Date.now() + 3000).toUTCString() },
      }),
      ok(),
    ]);
    await client.complete({ messages: [{ role: 'user', content: 'x' }], stream: false });
    assert.strictEqual(delays.length, 1);
    // HTTP-date resolution is one second and the clock moves between
    // header construction and parsing; the floor still proves the date
    // was used — the jitterless computed backoff would be 500
    assert.ok(delays[0] >= 1500 && delays[0] <= 3000,
      `delay ${delays[0]} must derive from the date, in [1500, 3000]`);

    const capped = scriptedClient([
      new Response('later', {
        status: 429,
        headers: { 'retry-after': new Date(Date.now() + 60000).toUTCString() },
      }),
      ok(),
    ], { maxMs: 4000 });
    await capped.client.complete({ messages: [{ role: 'user', content: 'x' }], stream: false });
    assert.deepStrictEqual(capped.delays, [4000], 'a far-future date is capped at maxMs');
  });

  it('retries a thrown network error, never a 401', async function () {
    const { client, calls } = scriptedClient([
      new TypeError('fetch failed'),
      ok(),
    ]);
    const result = await client.complete({ messages: [{ role: 'user', content: 'x' }], stream: false });
    assert.strictEqual(result.message.content, 'recovered');
    assert.strictEqual(calls(), 2);

    const denied = scriptedClient([new Response('no', { status: 401 })]);
    await assert.rejects(denied.client.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (err) => err instanceof AiError && err.status === 401 && err.attempts === 1);
    assert.strictEqual(denied.calls(), 1, '401 is not retried');
  });

  it('never retries after the first streamed delta reached the caller', async function () {
    // attempt 1 streams one delta, then the connection dies mid-read
    let call = 0;
    const client = createChatClient({
      provider: 'ollama', model: 'm',
      retry: { sleep: () => Promise.resolve() },
      fetch: () => {
        call++;
        let pulls = 0;
        const stream = new ReadableStream({
          pull(controller) {
            pulls++;
            if (pulls === 1) {
              controller.enqueue(new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
            }
            else {
              controller.error(new Error('connection reset'));
            }
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      },
    });
    const deltas = [];
    await assert.rejects(client.complete({
      messages: [{ role: 'user', content: 'x' }],
      onDelta: (t) => deltas.push(t),
    }), /connection reset/);
    assert.deepStrictEqual(deltas, ['partial']);
    assert.strictEqual(call, 1, 'the failed stream was not replayed');
  });

  it('an abort during backoff rejects promptly with the abort reason', async function () {
    const controller = new AbortController();
    const { client } = scriptedClient([
      new Response('busy', { status: 503 }),
      ok(),
    ], {
      sleep: (ms, signal) => {
        // the default sleep contract: reject on abort — simulate the
        // abort arriving while waiting
        controller.abort();
        return signal?.aborted
          ? Promise.reject(new Error('aborted-during-backoff'))
          : Promise.resolve();
      },
    });
    await assert.rejects(client.complete({
      messages: [{ role: 'user', content: 'x' }],
      signal: controller.signal,
      stream: false,
    }), /aborted-during-backoff/);
  });

  it('the default sleep really waits between attempts and honors an abort', async function () {
    // no injected sleep: the built-in timer-based backoff runs (tiny
    // baseMs keeps the test fast)
    let call = 0;
    const client = createChatClient({
      provider: 'ollama', model: 'm',
      retry: { baseMs: 1, maxMs: 2, random: () => 0 },
      fetch: () => {
        call++;
        return Promise.resolve(call === 1
          ? new Response('busy', { status: 503 })
          : new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
      },
    });
    const result = await client.complete({ messages: [{ role: 'user', content: 'x' }], stream: false });
    assert.strictEqual(result.message.content, 'ok');
    assert.strictEqual(call, 2);

    // an already-aborted signal makes the default sleep reject with
    // the abort reason instead of waiting out the backoff
    const controller = new AbortController();
    controller.abort();
    const aborted = createChatClient({
      provider: 'ollama', model: 'm',
      retry: { baseMs: 1 },
      fetch: () => Promise.resolve(new Response('busy', { status: 503 })),
    });
    await assert.rejects(aborted.complete({
      messages: [{ role: 'user', content: 'x' }],
      signal: controller.signal,
      stream: false,
    }), (err) => /** @type {any} */ (err)?.name === 'AbortError');

    // an abort ARRIVING mid-backoff cancels the pending timer promptly
    // (a long baseMs proves the sleep was cut short, not waited out)
    const midway = new AbortController();
    const slow = createChatClient({
      provider: 'ollama', model: 'm',
      retry: { baseMs: 60_000, random: () => 1 },
      fetch: () => Promise.resolve(new Response('busy', { status: 503 })),
    });
    const pending = assert.rejects(slow.complete({
      messages: [{ role: 'user', content: 'x' }],
      signal: midway.signal,
      stream: false,
    }), (err) => /** @type {any} */ (err)?.name === 'AbortError');
    setTimeout(() => midway.abort(), 5);
    await pending;
  });

  it('retry: { attempts: 1 } disables retrying entirely', async function () {
    const { client, calls } = scriptedClient([new Response('x', { status: 503 })],
      { attempts: 1 });
    await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (err) => err instanceof AiError && err.attempts === 1);
    assert.strictEqual(calls(), 1);
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
