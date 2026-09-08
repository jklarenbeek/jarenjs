//@ts-check
/**
 * @file The replay seam on both wire clients, over a `Map`. The proof
 * that matters is transport calls: a second identical request makes
 * ZERO, a one-field change makes one more. Around it: what enters the
 * key and what never does, the replay marker, the callbacks on a replay,
 * fail-closed both ways, a malformed entry refused, an unkeyable request
 * refused before the wire, and partial embedding hits reconstructed in
 * input order with only the misses travelling.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createChatClient, createEmbeddingClient, probeEmbeddings, AiError } from '@jarenjs/ai';

/** Build an SSE body from chat chunks (objects) plus the [DONE] marker. */
function sseBody(chunks) {
  return chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('')
    + 'data: [DONE]\n\n';
}

/** A Map-backed adapter; `async: true` answers promises, as a store would. */
function mapCache({ async = false } = {}) {
  const map = new Map();
  return {
    map,
    get: (key) => (async ? Promise.resolve(map.get(key)) : map.get(key)),
    set: (key, value) => { map.set(key, value); return async ? Promise.resolve() : undefined; },
  };
}

/** A chat client over a counting fetch that streams one fixed reply. */
function chatClient(cache, options = {}) {
  const calls = [];
  const client = createChatClient({
    provider: 'ollama', model: 'qwen3:4b',
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(sseBody([
        { model: 'm1', choices: [{ delta: { role: 'assistant', reasoning: 'thinking…', content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }], usage: { total_tokens: 7 } },
      ]), { status: 200 }));
    },
    cache,
    ...options,
  });
  return { client, calls };
}

const ASK = { messages: [{ role: 'user', content: 'hi' }] };

describe('ai — the replay seam on the chat client', function () {
  it('a second identical request makes zero transport calls and comes back marked replayed', async function () {
    const cache = mapCache();
    const { client, calls } = chatClient(cache);
    const deltas = [];
    const first = await client.complete({ ...ASK, onDelta: (t) => deltas.push(t) });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(first.replayed, undefined, 'a purchase carries no replay marker');
    assert.deepStrictEqual(deltas, ['Hel', 'lo']);
    assert.strictEqual(cache.map.size, 1);

    const reasoning = [];
    const second = await client.complete({
      ...ASK, onDelta: (t) => deltas.push(t), onReasoning: (t) => reasoning.push(t),
    });
    assert.strictEqual(calls.length, 1, 'the replay touched no transport');
    assert.strictEqual(second.message.content, 'Hello');
    assert.strictEqual(second.usage.total_tokens, 7, 'the purchase\'s usage travels with the replay');
    assert.ok(typeof second.replayed?.ms === 'number' && Number.isFinite(second.replayed.ms),
      'the replay names the purchase\'s wall time');
    assert.deepStrictEqual(deltas, ['Hel', 'lo', 'Hello'], 'a replay fires onDelta once with the whole text');
    assert.deepStrictEqual(reasoning, ['thinking…'], 'and onReasoning once with the whole reasoning');
  });

  it('works over an asynchronous adapter too', async function () {
    const cache = mapCache({ async: true });
    const { client, calls } = chatClient(cache);
    await client.complete(ASK);
    const again = await client.complete(ASK);
    assert.strictEqual(calls.length, 1);
    assert.ok(again.replayed);
  });

  it('a one-field change misses: temperature, and a client-level default (reasoning)', async function () {
    const cache = mapCache();
    const { client, calls } = chatClient(cache);
    await client.complete({ ...ASK, temperature: 0 });
    await client.complete({ ...ASK, temperature: 0.1 });
    assert.strictEqual(calls.length, 2);
    const quiet = chatClient(cache, { reasoning: { effort: 'none' } });
    await quiet.client.complete({ ...ASK, temperature: 0 });
    assert.strictEqual(quiet.calls.length, 1, 'a different client default is a different request');
    await client.complete({ ...ASK, temperature: 0 });
    assert.strictEqual(calls.length, 2, 'and the original still replays');
  });

  it('`stream` never enters the key: streamed and whole answers share one entry', async function () {
    const cache = mapCache();
    const { client, calls } = chatClient(cache);
    await client.complete({ ...ASK, stream: true });
    const whole = await client.complete({ ...ASK, stream: false });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(whole.message.content, 'Hello');
  });

  it('credentials and headers never enter the key; a different base does', async function () {
    const cache = mapCache();
    const a = chatClient(cache, { apiKey: 'sk-one', headers: { 'x-trace': '1' } });
    const b = chatClient(cache, { apiKey: 'sk-two' });
    await a.client.complete(ASK);
    await b.client.complete(ASK);
    assert.strictEqual(a.calls.length + b.calls.length, 1, 'same provider, base, model and request: one purchase');
    const [key] = cache.map.keys();
    assert.ok(!key.includes('sk-one') && !key.includes('x-trace'), 'nothing of the credential is in the key');
    const elsewhere = chatClient(cache, { provider: 'custom', baseUrl: 'http://localhost:1234' });
    await elsewhere.client.complete(ASK);
    assert.strictEqual(elsewhere.calls.length, 1, 'a different base is a different request');
  });

  it('fails closed: a throwing get rejects before any transport call, a throwing set after exactly one', async function () {
    const boom = new Error('storage down');
    const broken = chatClient({ get: () => { throw boom; }, set: () => {} });
    await assert.rejects(() => broken.client.complete(ASK), (err) => err === boom);
    assert.strictEqual(broken.calls.length, 0);
    const halfBroken = chatClient({ get: () => undefined, set: () => Promise.reject(boom) });
    await assert.rejects(() => halfBroken.client.complete(ASK), (err) => err === boom);
    assert.strictEqual(halfBroken.calls.length, 1);
  });

  it('an adapter that fails open is the adapter\'s own decision', async function () {
    const failing = mapCache();
    const open = {
      get: () => { try { throw new Error('down'); } catch { return undefined; } },
      set: (key, value) => { failing.map.set(key, value); },
    };
    const { client, calls } = chatClient(open);
    await client.complete(ASK);
    await client.complete(ASK);
    assert.strictEqual(calls.length, 2, 'it kept buying, as it chose to');
  });

  it('a malformed stored entry is AI0003, never served', async function () {
    const cache = mapCache();
    const { client } = chatClient(cache);
    await client.complete(ASK);
    const [key] = cache.map.keys();
    cache.map.set(key, { nope: true });
    await assert.rejects(() => client.complete(ASK), (err) => err instanceof AiError && err.code === 'AI0003');
  });

  it('a request that cannot be keyed is AI0001 before any transport call', async function () {
    const { client, calls } = chatClient(mapCache());
    await assert.rejects(() => client.complete({
      ...ASK, tools: [{ type: 'function', function: { name: 'f', parameters: {}, run: () => 1 } }],
    }), (err) => err instanceof AiError && err.code === 'AI0001' && /not cacheable/.test(err.message));
    assert.strictEqual(calls.length, 0);
  });

  it('a mutated result never mutates the store', async function () {
    const cache = mapCache();
    const { client } = chatClient(cache);
    const bought = await client.complete(ASK);
    bought.message.content = 'tampered';
    const replay = await client.complete(ASK);
    assert.strictEqual(replay.message.content, 'Hello');
    replay.message.content = 'tampered again';
    assert.strictEqual((await client.complete(ASK)).message.content, 'Hello');
  });

  it('refuses a cache that is not the seam at construction', function () {
    assert.throws(() => createChatClient({ provider: 'ollama', model: 'm', cache: /** @type {any} */ ({ get: 1 }) }),
      (err) => err instanceof AiError && err.code === 'AI0001');
  });
});

const VECTORS = { a: [1, 0, 0, 0], b: [0, 1, 0, 0], c: [0, 0, 1, 0], d: [0, 0, 0, 1] };

/** An embedding client over a fetch that answers each input by name, out of order. */
function embedClient(cache, options = {}) {
  const calls = [];
  const client = createEmbeddingClient({
    provider: 'ollama', model: 'nomic-embed-text',
    fetch: (url, init) => {
      const input = JSON.parse(init.body).input;
      calls.push(input);
      const data = input.map((text, index) => ({ object: 'embedding', index, embedding: VECTORS[text] })).reverse();
      return Promise.resolve(new Response(JSON.stringify({ object: 'list', data }), { status: 200 }));
    },
    cache,
    ...options,
  });
  return { client, calls };
}

describe('ai — the replay seam on the embeddings client', function () {
  it('partial hits: only the misses travel, in one call, and the result is in input order', async function () {
    const cache = mapCache();
    const { client, calls } = embedClient(cache);
    const bought = await client.embed(['a', 'b', 'c']);
    assert.deepStrictEqual(calls, [['a', 'b', 'c']]);
    assert.strictEqual(cache.map.size, 3, 'one entry per text');
    assert.deepStrictEqual(Array.from(bought[1]), VECTORS.b);

    const mixed = await client.embed(['b', 'd', 'a']);
    assert.deepStrictEqual(calls, [['a', 'b', 'c'], ['d']], 'only the miss travelled');
    assert.deepStrictEqual(mixed.map((v) => Array.from(v)), [VECTORS.b, VECTORS.d, VECTORS.a]);
    assert.ok(mixed[0] instanceof Float32Array);

    await client.embed(['a', 'b']);
    assert.strictEqual(calls.length, 2, 'every text remembered: zero transport calls');
  });

  it('a fresh client over the same store settles dims from its first replay', async function () {
    const cache = mapCache({ async: true });
    await embedClient(cache).client.embed(['a']);
    const { client, calls } = embedClient(cache);
    assert.strictEqual(client.dims, undefined);
    await client.embed(['a']);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(client.dims, 4);
  });

  it('a stored vector of the wrong width is AI0003', async function () {
    const cache = mapCache();
    const { client } = embedClient(cache, { dims: 4 });
    await client.embed(['a']);
    const [key] = cache.map.keys();
    assert.ok(key.includes('"input":"a"'), 'the key names the text');
    cache.map.set(key, { vector: [1, 2, 3], ms: 1 });
    await assert.rejects(() => client.embed(['a']), (err) => err instanceof AiError && err.code === 'AI0003');
    cache.map.set(key, { vector: [1, 2, 3, 'x'], ms: 1 });
    await assert.rejects(() => client.embed(['a']), (err) => err instanceof AiError && err.code === 'AI0003');
  });

  it('refuses a replay that overflows Float32 before settling dims or making a wire call', async function () {
    for (const component of [1e39, -1e39]) {
      const { client, calls } = embedClient({
        get: () => ({ vector: [0, component], ms: 1 }),
        set: () => { throw new Error('a refused replay must not write'); },
      });
      await assert.rejects(client.embed(['a']),
        (err) => err instanceof AiError && err.code === 'AI0003'
          && /replay entry carries a component outside the finite Float32 range at 1/.test(err.message));
      assert.strictEqual(client.dims, undefined);
      assert.deepStrictEqual(calls, []);
    }
  });

  it('the model is in every key: two models never share a vector', async function () {
    const cache = mapCache();
    const one = embedClient(cache);
    const two = embedClient(cache, { model: 'other-model' });
    await one.client.embed(['a']);
    await two.client.embed(['a']);
    assert.strictEqual(one.calls.length + two.calls.length, 2);
  });

  it('a stored entry is JSON-only: the vector is a plain array of numbers', async function () {
    const cache = mapCache();
    await embedClient(cache).client.embed(['c']);
    const [entry] = cache.map.values();
    assert.ok(Array.isArray(entry.vector) && entry.vector.every((x) => typeof x === 'number'));
    assert.strictEqual(typeof entry.ms, 'number');
    assert.strictEqual(JSON.parse(JSON.stringify(entry)).vector.length, 4);
  });

  it('probeEmbeddings never consults a cache', async function () {
    const probe = await probeEmbeddings({
      provider: 'ollama', model: 'nomic-embed-text',
      fetch: () => Promise.resolve(new Response(JSON.stringify({
        data: [{ index: 0, embedding: VECTORS.a }],
      }), { status: 200 })),
      .../** @type {any} */ ({ cache: { get: () => { throw new Error('must not be asked'); }, set: () => {} } }),
    });
    assert.deepStrictEqual(probe, { ok: true, model: 'nomic-embed-text', dims: 4 });
  });
});
