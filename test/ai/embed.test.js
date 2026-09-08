//@ts-check
/**
 * @file `@jarenjs/ai/embed` — the embeddings wire and the seam behind
 * it. The heart is the reply verification: vectors reassembled by
 * `data[].index` into INPUT order, and refused — naming the input —
 * unless exactly one non-empty, finite vector of the expected width
 * arrived per input. Around it: retry parity with the chat client, the
 * probe's never-throw contract, and the deterministic reference
 * embedder every offline test runs on.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createEmbeddingClient, probeEmbeddings, createHashEmbedder, AiError } from '@jarenjs/ai';
import * as embedSubpath from '@jarenjs/ai/embed';
import { cosineSimilarity, dotProduct, isVector } from '@jarenjs/core/vector';

/**
 * An OpenAI-shaped `/embeddings` reply. `items` are `[index, embedding]`
 * pairs in the order the provider lists them — so a test can shuffle,
 * duplicate or drop an index deliberately.
 * @param {Array<[number, any]>} items
 */
function reply(items, status = 200) {
  return new Response(JSON.stringify({
    object: 'list',
    data: items.map(([index, embedding]) => ({ object: 'embedding', index, embedding })),
    model: 'text-embedding-x', usage: { prompt_tokens: 3, total_tokens: 3 },
  }), { status });
}

/** A client over a scripted sequence of fetch outcomes (the chat test's shape). */
function scripted(outcomes, options = {}) {
  /** @type {number[]} */
  const delays = [];
  /** @type {any[]} */
  const calls = [];
  const { retry, ...rest } = options;
  const client = createEmbeddingClient({
    provider: 'ollama', model: 'nomic-embed-text',
    retry: { random: () => 1, sleep: (ms) => { delays.push(ms); return Promise.resolve(); }, ...retry },
    fetch: (url, init) => {
      calls.push({ url, init });
      const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
      if (typeof outcome === 'function') return outcome(url, init);
      if (outcome instanceof Error) return Promise.reject(outcome);
      return Promise.resolve(outcome);
    },
    ...rest,
  });
  return { client, delays, calls };
}

const V0 = [1, 0, 0, 0];
const V1 = [0, 1, 0, 0];
const V2 = [0, 0, 1, 0];

describe('ai — the embeddings client', function () {
  it('posts { model, input } to the resolved base plus /embeddings and answers Float32Arrays in input order', async function () {
    const { client, calls } = scripted([reply([[0, V0], [1, V1], [2, V2]])]);
    const vectors = await client.embed(['a', 'b', 'c']);
    assert.strictEqual(calls[0].url, 'http://localhost:11434/v1/embeddings');
    assert.strictEqual(calls[0].init.method, 'POST');
    assert.strictEqual(calls[0].init.headers['content-type'], 'application/json');
    const sent = JSON.parse(calls[0].init.body);
    assert.deepStrictEqual(sent, { model: 'nomic-embed-text', input: ['a', 'b', 'c'] }, 'nothing but model and input — no stream key');
    assert.strictEqual(vectors.length, 3);
    for (const v of vectors) assert.ok(v instanceof Float32Array);
    assert.deepStrictEqual(vectors.map((v) => Array.from(v)), [V0, V1, V2]);
    assert.strictEqual(client.model, 'nomic-embed-text');
    assert.strictEqual(client.provider, 'ollama');
    assert.strictEqual(client.dims, 4, 'the first reply settled the width');
  });

  it('authenticates exactly like a chat turn, from the same resolved base', async function () {
    /** @type {any} */
    let seen = null;
    const client = createEmbeddingClient({
      provider: 'openrouter', apiKey: ' sk-or-x ', model: 'openai/text-embedding-3-small',
      headers: { 'x-title': 'Jaren' },
      fetch: (url, init) => { seen = { url, init }; return Promise.resolve(reply([[0, V0]])); },
    });
    await client.embed(['hello']);
    assert.strictEqual(seen.url, 'https://openrouter.ai/api/v1/embeddings');
    assert.strictEqual(seen.init.headers.authorization, 'Bearer sk-or-x');
    assert.strictEqual(seen.init.headers['x-title'], 'Jaren');
    // a pasted chat URL still lands on the sibling endpoint
    const pasted = createEmbeddingClient({
      baseUrl: 'https://api.example.com/v1/chat/completions', model: 'm',
      fetch: (url) => { seen = { url }; return Promise.resolve(reply([[0, V0]])); },
    });
    await pasted.embed(['x']);
    assert.strictEqual(seen.url, 'https://api.example.com/v1/embeddings');
  });

  it('reassembles a reply whose items arrive out of order by their index, never by position', async function () {
    // the provider lists the third input first: a positional read would
    // hand input "a" the vector of input "c" — the one wrong answer this
    // client exists to make impossible
    const { client } = scripted([reply([[2, V2], [0, V0], [1, V1]])]);
    const vectors = await client.embed(['a', 'b', 'c']);
    assert.deepStrictEqual(Array.from(vectors[0]), V0, 'input 0 got its own vector');
    assert.deepStrictEqual(Array.from(vectors[1]), V1);
    assert.deepStrictEqual(Array.from(vectors[2]), V2);
  });

  it('refuses a reply that does not carry one vector per input, naming the input', async function () {
    const attempt = async (items, pattern) => {
      const { client } = scripted([reply(items)], { retry: { attempts: 1 } });
      await assert.rejects(client.embed(['a', 'b', 'c']),
        (err) => err instanceof AiError && err.code === 'AI0003' && pattern.test(err.message),
        `${JSON.stringify(items.map(([i]) => i))} → ${pattern}`);
    };
    // fewer items than inputs
    await attempt([[0, V0], [1, V1]], /2 items for 3 inputs/);
    // more items than inputs
    await attempt([[0, V0], [1, V1], [2, V2], [2, V2]], /4 items for 3 inputs/);
    // the right count, but one input answered twice and one never
    await attempt([[0, V0], [1, V1], [1, V2]], /input 1 received two embeddings/);
    // an index that is not an input position, or missing altogether
    await attempt([[0, V0], [1, V1], [3, V2]], /item 2 carries no usable index for 3 inputs \(got 3\)/);
    await attempt([[0, V0], [/** @type {any} */ (undefined), V1], [2, V2]], /item 1 carries no usable index/);
    // no data[] at all
    const { client } = scripted([new Response('{"object":"list"}', { status: 200 })], { retry: { attempts: 1 } });
    await assert.rejects(client.embed(['a']), (err) => err instanceof AiError && err.code === 'AI0003' && /no data\[\]/.test(err.message));
  });

  it('refuses an empty vector and a non-finite component, naming the input and the component', async function () {
    const { client: empty } = scripted([reply([[0, V0], [1, []], [2, V2]])], { retry: { attempts: 1 } });
    await assert.rejects(empty.embed(['a', 'b', 'c']),
      (err) => err instanceof AiError && err.code === 'AI0003' && /input 1 received an empty embedding/.test(err.message));
    const { client: missing } = scripted([reply([[0, V0], [1, /** @type {any} */ (null)]])], { retry: { attempts: 1 } });
    await assert.rejects(missing.embed(['a', 'b']),
      (err) => err instanceof AiError && err.code === 'AI0003' && /input 1 received an empty embedding/.test(err.message));
    // JSON cannot spell NaN, but `1e999` parses to Infinity and `null` is not a number
    const { client: infinite } = scripted([new Response(
      '{"data":[{"index":0,"embedding":[1,0,0,0]},{"index":1,"embedding":[0,1e999,0,0]}]}', { status: 200 })],
    { retry: { attempts: 1 } });
    await assert.rejects(infinite.embed(['a', 'b']),
      (err) => err instanceof AiError && err.code === 'AI0003' && /input 1 received a component that is not a finite number at 1/.test(err.message));
    const { client: nulled } = scripted([reply([[0, [0, 0, null, 0]]])], { retry: { attempts: 1 } });
    await assert.rejects(nulled.embed(['a']),
      (err) => err instanceof AiError && err.code === 'AI0003' && /input 0 .* at 2/.test(err.message));
  });

  it('refuses finite numbers that overflow Float32 without settling dims or caching them', async function () {
    for (const component of [1e39, -1e39]) {
      const writes = [];
      const { client } = scripted([reply([[0, [0, component]]])], {
        retry: { attempts: 1 },
        cache: { get: () => undefined, set: (...args) => { writes.push(args); } },
      });
      await assert.rejects(client.embed(['a']),
        (err) => err instanceof AiError && err.code === 'AI0003'
          && /input 0 received a component outside the finite Float32 range at 1/.test(err.message));
      assert.strictEqual(client.dims, undefined);
      assert.deepStrictEqual(writes, []);
    }
    const largest = 3.4028234663852886e38;
    const { client } = scripted([reply([[0, [largest, -largest]]])]);
    assert.deepStrictEqual(Array.from((await client.embed(['a']))[0]), [largest, -largest]);
  });

  it('holds every vector to one width: configured up front, or settled by the first reply', async function () {
    // configured: the reply must match, from the first vector on
    const { client: pinned } = scripted([reply([[0, V0], [1, [0, 1, 0]]])], { dims: 4, retry: { attempts: 1 } });
    assert.strictEqual(pinned.dims, 4, 'known before any call');
    await assert.rejects(pinned.embed(['a', 'b']),
      (err) => err instanceof AiError && err.code === 'AI0003' && /input 1 received 3 dimensions, expected 4/.test(err.message));
    const { client: wrong } = scripted([reply([[0, [1, 0, 0]]])], { dims: 4, retry: { attempts: 1 } });
    await assert.rejects(wrong.embed(['a']),
      (err) => err instanceof AiError && err.code === 'AI0003' && /input 0 received 3 dimensions, expected 4/.test(err.message));

    // unconfigured: the first reply fixes it for the client, and the next
    // reply is held to it — a model that changed width under a fixed name
    // is refused, never mixed
    const { client: settled } = scripted([reply([[0, V0]]), reply([[0, [1, 0, 0]]])], { retry: { attempts: 1 } });
    assert.strictEqual(settled.dims, undefined, 'unknown until the first reply');
    await settled.embed(['a']);
    assert.strictEqual(settled.dims, 4);
    await assert.rejects(settled.embed(['b']),
      (err) => err instanceof AiError && err.code === 'AI0003' && /input 0 received 3 dimensions, expected 4/.test(err.message));
    assert.strictEqual(settled.dims, 4, 'a refused reply does not move the settled width');

    // and within one reply, input 0 settles what inputs 1.. must match
    const { client: mixed } = scripted([reply([[0, V0], [1, [1, 0]]])], { retry: { attempts: 1 } });
    await assert.rejects(mixed.embed(['a', 'b']),
      (err) => err instanceof AiError && err.code === 'AI0003' && /input 1 received 2 dimensions, expected 4/.test(err.message));
    assert.strictEqual(mixed.dims, undefined, 'nothing settled by a refused reply');
  });

  it('refuses caller errors with AI0001 before any request: texts, model, dims, timeout, provider', async function () {
    const client = createEmbeddingClient({
      provider: 'ollama', model: 'm',
      fetch: () => { throw new Error('must not reach fetch'); },
    });
    for (const bad of [[], 'text', [1], ['a', null], undefined]) {
      await assert.rejects(client.embed(/** @type {any} */ (bad)),
        (err) => err instanceof AiError && err.code === 'AI0001' && /non-empty array of strings/.test(err.message),
        JSON.stringify(bad));
    }
    assert.throws(() => createEmbeddingClient({ provider: 'ollama' }),
      (err) => err instanceof AiError && err.code === 'AI0001' && /model/.test(err.message));
    assert.throws(() => createEmbeddingClient({ provider: 'ollama', model: 'm', dims: 0 }),
      (err) => err instanceof AiError && err.code === 'AI0001' && /dims/.test(err.message));
    assert.throws(() => createEmbeddingClient({ provider: 'ollama', model: 'm', dims: 1.5 }),
      (err) => err instanceof AiError && err.code === 'AI0001' && /dims/.test(err.message));
    assert.throws(() => createEmbeddingClient({ provider: 'ollama', model: 'm', timeoutMs: -1 }),
      (err) => err instanceof AiError && err.code === 'AI0001' && /timeoutMs/.test(err.message));
    assert.throws(() => createEmbeddingClient({ provider: 'skynet', model: 'm' }),
      (err) => err instanceof AiError && err.code === 'AI0001' && /skynet/.test(err.message));
    assert.throws(() => createEmbeddingClient({ baseUrl: 'https://x.test/v1?api-version=1', model: 'm' }),
      (err) => err instanceof AiError && err.code === 'AI0001' && /query/.test(err.message));
  });

  it('falls back to the global fetch when none is injected', async function () {
    const original = globalThis.fetch;
    /** @type {any} */
    let seen = null;
    globalThis.fetch = /** @type {any} */ ((url, init) => {
      seen = { url, init };
      return Promise.resolve(reply([[0, V0]]));
    });
    try {
      const client = createEmbeddingClient({ provider: 'lmstudio', model: 'm' });
      const [vector] = await client.embed(['x']);
      assert.deepStrictEqual(Array.from(vector), V0);
      assert.strictEqual(seen.url, 'http://localhost:1234/v1/embeddings');
    }
    finally {
      globalThis.fetch = original;
    }
  });

  it('is reachable as its own subpath with the same three exports', function () {
    assert.strictEqual(embedSubpath.createEmbeddingClient, createEmbeddingClient);
    assert.strictEqual(embedSubpath.probeEmbeddings, probeEmbeddings);
    assert.strictEqual(embedSubpath.createHashEmbedder, createHashEmbedder);
  });
});

describe('ai — the embeddings client retries like the chat client', function () {
  it('retries a 429 honoring Retry-After up to the cap, then succeeds', async function () {
    const { client, delays, calls } = scripted([
      new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }),
      reply([[0, V0]]),
    ]);
    const [vector] = await client.embed(['x']);
    assert.deepStrictEqual(Array.from(vector), V0);
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(delays, [2000], 'the provider\'s ask wins over the computed 500');

    // a provider asking for a minute gets the documented cap (8 000 ms by default)
    const capped = scripted([
      new Response('later', { status: 429, headers: { 'retry-after': '60' } }),
      reply([[0, V0]]),
    ]);
    await capped.client.embed(['x']);
    assert.deepStrictEqual(capped.delays, [8000]);

    // and a lower maxMs caps lower
    const lower = scripted([
      new Response('later', { status: 429, headers: { 'retry-after': '60' } }),
      reply([[0, V0]]),
    ], { retry: { maxMs: 4000 } });
    await lower.client.embed(['x']);
    assert.deepStrictEqual(lower.delays, [4000]);
  });

  it('backs off exponentially through persistent 5xx and reports attempts on AI0002; never retries a 401', async function () {
    // a fresh Response per attempt: a body reads once, and the excerpt must be on the FINAL error
    const { client, delays, calls } = scripted([() => Promise.resolve(new Response('boom', { status: 500 }))]);
    await assert.rejects(client.embed(['x']),
      (err) => err instanceof AiError && err.code === 'AI0002' && err.status === 500 && err.attempts === 3
        && /HTTP 500 from http:\/\/localhost:11434\/v1\/embeddings: boom/.test(err.message));
    assert.strictEqual(calls.length, 3);
    assert.deepStrictEqual(delays, [500, 1000]);

    const denied = scripted([new Response('{"error":"invalid key"}', { status: 401 })]);
    await assert.rejects(denied.client.embed(['x']),
      (err) => err instanceof AiError && err.code === 'AI0002' && err.status === 401 && err.attempts === 1
        && /invalid key/.test(err.message));
    assert.strictEqual(denied.calls.length, 1, '401 is not retried');
  });

  it('retries a thrown network error and a malformed 200, and reports the tries', async function () {
    const recovered = scripted([new TypeError('fetch failed'), reply([[0, V0]])]);
    await recovered.client.embed(['x']);
    assert.strictEqual(recovered.calls.length, 2);

    // a 200 that is not the wire — an HTML gateway page — is AI0003 and,
    // as in the chat client, retried as a provider hiccup
    const garbage = scripted([() => Promise.resolve(new Response('<html>gateway</html>', { status: 200 }))]);
    await assert.rejects(garbage.client.embed(['x']),
      (err) => err instanceof AiError && err.code === 'AI0003' && err.attempts === 3 && /malformed embeddings reply/.test(err.message));
    assert.strictEqual(garbage.calls.length, 3);

    // so is a structurally wrong reply: a wrong width costs `attempts` tries before it surfaces
    const wrongWidth = scripted([() => Promise.resolve(reply([[0, [1, 0]]]))], { dims: 4 });
    await assert.rejects(wrongWidth.client.embed(['x']),
      (err) => err instanceof AiError && err.code === 'AI0003' && err.attempts === 3);
    assert.strictEqual(wrongWidth.calls.length, 3);

    // retry: { attempts: 1 } disables retrying entirely
    const once = scripted([new Response('x', { status: 503 })], { retry: { attempts: 1 } });
    await assert.rejects(once.client.embed(['x']), (err) => err instanceof AiError && err.attempts === 1);
    assert.strictEqual(once.calls.length, 1);
  });

  it('an abort during backoff rejects promptly with the abort reason, and nothing is retried past an abort', async function () {
    const controller = new AbortController();
    const { client, calls } = scripted([new Response('busy', { status: 503 }), reply([[0, V0]])], {
      retry: {
        sleep: (ms, signal) => {
          controller.abort();
          return signal?.aborted
            ? Promise.reject(new Error('aborted-during-backoff'))
            : Promise.resolve();
        },
      },
    });
    await assert.rejects(client.embed(['x'], { signal: controller.signal }), /aborted-during-backoff/);
    assert.strictEqual(calls.length, 1);

    // the caller's own abort during the request comes back as itself — never rewrapped, never retried
    const aborting = new AbortController();
    const { client: aborted, calls: abortedCalls } = scripted([
      (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
        aborting.abort();
      }),
    ]);
    await assert.rejects(aborted.embed(['x'], { signal: aborting.signal }),
      (err) => /** @type {any} */ (err)?.name === 'AbortError');
    assert.strictEqual(abortedCalls.length, 1);

    // the default sleep honors an already-aborted signal instead of waiting
    const settled = new AbortController();
    settled.abort();
    const defaults = createEmbeddingClient({
      provider: 'ollama', model: 'm', retry: { baseMs: 1 },
      fetch: () => Promise.resolve(new Response('busy', { status: 503 })),
    });
    await assert.rejects(defaults.embed(['x'], { signal: settled.signal }),
      (err) => /** @type {any} */ (err)?.name === 'AbortError');
  });

  it('a timeoutMs bounds each attempt and a timed-out attempt retries like a network failure', async function () {
    /** @type {any[]} */
    const seen = [];
    const client = createEmbeddingClient({
      provider: 'ollama', model: 'm', timeoutMs: 20,
      retry: { random: () => 0, sleep: () => Promise.resolve() },
      fetch: (url, init) => new Promise((resolve, reject) => {
        seen.push(init.signal);
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      }),
    });
    await assert.rejects(client.embed(['x']),
      (err) => err instanceof AiError && err.code === 'AI0002' && err.status === 0 && err.attempts === 3
        && /within 20 ms/.test(err.message));
    assert.strictEqual(seen.length, 3, 'each attempt got its own deadline');

    // with a caller signal beside the deadline, the caller's abort is still its own
    const controller = new AbortController();
    const both = createEmbeddingClient({
      provider: 'ollama', model: 'm', timeoutMs: 60_000,
      fetch: (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
        controller.abort();
      }),
    });
    await assert.rejects(both.embed(['x'], { signal: controller.signal }),
      (err) => /** @type {any} */ (err)?.name === 'AbortError');

    // and a reply inside the deadline is a reply
    const quick = createEmbeddingClient({
      provider: 'ollama', model: 'm', timeoutMs: 5000,
      fetch: () => Promise.resolve(reply([[0, V0]])),
    });
    assert.deepStrictEqual(Array.from((await quick.embed(['x']))[0]), V0);
  });
});

describe('ai — probeEmbeddings', function () {
  it('a healthy provider answers with the model and the width, through one authenticated attempt', async function () {
    /** @type {any} */
    let seen = null;
    let n = 0;
    const result = await probeEmbeddings({
      provider: 'openrouter', apiKey: 'sk-x', model: 'openai/text-embedding-3-small',
      fetch: (url, init) => {
        n++;
        seen = { url, init };
        return Promise.resolve(reply([[0, [0.1, 0.2, 0.3]]]));
      },
    });
    assert.deepStrictEqual(result, { ok: true, model: 'openai/text-embedding-3-small', dims: 3 });
    assert.strictEqual(seen.url, 'https://openrouter.ai/api/v1/embeddings');
    assert.strictEqual(seen.init.headers.authorization, 'Bearer sk-x');
    assert.deepStrictEqual(JSON.parse(seen.init.body).input, ['probe'], 'one word');
    assert.strictEqual(n, 1);
  });

  it('never throws: a rejected key, a hung server, a bad URL, a dead network and a malformed reply all come back { ok: false }', async function () {
    const denied = await probeEmbeddings({
      provider: 'openrouter', apiKey: 'bad', model: 'm',
      fetch: () => Promise.resolve(new Response('denied', { status: 401 })),
    });
    assert.deepStrictEqual(denied, { ok: false, status: 401, error: 'AI0002: HTTP 401 from https://openrouter.ai/api/v1/embeddings: denied' });

    let n = 0;
    const hung = await probeEmbeddings({
      provider: 'ollama', model: 'm', timeoutMs: 20,
      fetch: (url, init) => new Promise((resolve, reject) => {
        n++;
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    });
    assert.strictEqual(hung.ok, false);
    assert.match(/** @type {any} */ (hung).error, /within 20 ms/);
    assert.strictEqual('status' in hung, false, 'no HTTP status was ever received');
    assert.strictEqual(n, 1, 'a probe makes one attempt');

    const misconfigured = await probeEmbeddings({ provider: 'custom', model: 'm' });
    assert.strictEqual(misconfigured.ok, false);
    assert.match(/** @type {any} */ (misconfigured).error, /baseUrl/);

    const modelless = await probeEmbeddings({ provider: 'ollama', fetch: () => { throw new Error('must not reach fetch'); } });
    assert.strictEqual(modelless.ok, false);
    assert.match(/** @type {any} */ (modelless).error, /model/);

    const down = await probeEmbeddings({
      provider: 'ollama', model: 'm',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    assert.strictEqual(down.ok, false);
    assert.match(/** @type {any} */ (down).error, /fetch failed/);
    assert.strictEqual('status' in down, false);

    const malformed = await probeEmbeddings({
      provider: 'ollama', model: 'm',
      fetch: () => Promise.resolve(reply([[0, []]])),
    });
    assert.strictEqual(malformed.ok, false);
    assert.match(/** @type {any} */ (malformed).error, /input 0 received an empty embedding/);
  });

  it('falls back to the global fetch when none is injected', async function () {
    const original = globalThis.fetch;
    globalThis.fetch = /** @type {any} */ (() => Promise.resolve(reply([[0, [1, 0]]])));
    try {
      const result = await probeEmbeddings({ provider: 'ollama', model: 'm' });
      assert.deepStrictEqual(result, { ok: true, model: 'm', dims: 2 });
    }
    finally {
      globalThis.fetch = original;
    }
  });
});

describe('ai — the hash reference embedder', function () {
  it('is deterministic: the same text is the same vector, on this embedder and on a fresh one', async function () {
    const a = createHashEmbedder();
    const b = createHashEmbedder();
    const [first] = await a.embed(['The quick brown fox']);
    const [second] = await a.embed(['The quick brown fox']);
    const [third] = await b.embed(['The quick brown fox']);
    assert.ok(first instanceof Float32Array);
    assert.deepStrictEqual(first, second);
    assert.deepStrictEqual(first, third);
    assert.strictEqual(first.length, 64);
    // the identity: name and width
    assert.strictEqual(a.model, 'hash-trigram-64');
    assert.strictEqual(a.dims, 64);
    // and a pinned expectation, so a change to the hashing is a visible change
    assert.deepStrictEqual(Array.from(first).map((x) => Math.round(x * 1000) / 1000).filter((x) => x !== 0).length > 0, true);
  });

  it('is l2-normalized and lexical: shared letters score high, different letters low', async function () {
    const embedder = createHashEmbedder({ dims: 128 });
    const [cat, cats, revenue] = await embedder.embed([
      'the cat sat on the mat', 'the cats sat on the mats', 'quarterly revenue projections',
    ]);
    for (const v of [cat, cats, revenue]) {
      assert.ok(isVector(v, 128));
      assert.ok(Math.abs(Math.sqrt(dotProduct(v, v)) - 1) < 1e-6, 'unit length');
      assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-6, 'cosine(v, v) ≈ 1');
    }
    assert.ok(cosineSimilarity(cat, cats) > 0.8, `near-duplicates score high: ${cosineSimilarity(cat, cats)}`);
    assert.ok(cosineSimilarity(cat, revenue) < 0.3, `unrelated letters score low: ${cosineSimilarity(cat, revenue)}`);
    assert.ok(cosineSimilarity(cat, cats) > cosineSimilarity(cat, revenue));
    // case-folded: the same words in another case are the same vector
    const [upper] = await embedder.embed(['THE CAT SAT ON THE MAT']);
    assert.deepStrictEqual(upper, cat);
  });

  it('a different width is a different identity, and a text without a trigram is the zero vector, not NaN', async function () {
    const wide = createHashEmbedder({ dims: 256 });
    assert.strictEqual(wide.model, 'hash-trigram-256');
    assert.strictEqual(wide.dims, 256);
    const [v] = await wide.embed(['x']);
    assert.strictEqual(v.length, 256);
    assert.notStrictEqual(wide.model, createHashEmbedder().model);
    const [empty] = await wide.embed(['']);
    assert.ok(empty.every((x) => x === 0));
    assert.strictEqual(cosineSimilarity(empty, v), 0, 'no direction scores 0 against everything');
  });

  it('keeps the seam\'s contract: AI0001 on bad input, an aborted signal rejects, a bad dims refuses up front', async function () {
    const embedder = createHashEmbedder();
    for (const bad of [[], 'text', [1], ['a', 2]]) {
      await assert.rejects(embedder.embed(/** @type {any} */ (bad)),
        (err) => err instanceof AiError && err.code === 'AI0001', JSON.stringify(bad));
    }
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await assert.rejects(embedder.embed(['x'], { signal: controller.signal }), /stop/);
    assert.throws(() => createHashEmbedder({ dims: 0 }), (err) => err instanceof AiError && err.code === 'AI0001');
    assert.throws(() => createHashEmbedder({ dims: 2.5 }), (err) => err instanceof AiError && err.code === 'AI0001');
  });
});
