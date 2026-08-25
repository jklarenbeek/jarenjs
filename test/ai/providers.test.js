//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { PROVIDERS, resolveEndpoint, probeProvider, AiError } from '@jarenjs/ai';

describe('ai — provider endpoint resolution', function () {
  it('resolves the three presets to their chat URLs', function () {
    assert.strictEqual(resolveEndpoint({ provider: 'openrouter' }).url,
      'https://openrouter.ai/api/v1/chat/completions');
    assert.strictEqual(resolveEndpoint({ provider: 'ollama' }).url,
      'http://localhost:11434/v1/chat/completions');
    assert.strictEqual(resolveEndpoint({ provider: 'lmstudio' }).url,
      'http://localhost:1234/v1/chat/completions');
  });

  it('a bare local origin gets /v1; an explicit path is respected', function () {
    assert.strictEqual(
      resolveEndpoint({ provider: 'ollama', baseUrl: 'http://192.168.1.7:11434' }).url,
      'http://192.168.1.7:11434/v1/chat/completions');
    assert.strictEqual(
      resolveEndpoint({ provider: 'ollama', baseUrl: 'http://box:11434/v1/' }).url,
      'http://box:11434/v1/chat/completions');
  });

  it('forgives pasted /chat/completions suffixes and trailing slashes', function () {
    assert.strictEqual(
      resolveEndpoint({ baseUrl: 'https://api.example.com/v1/chat/completions' }).url,
      'https://api.example.com/v1/chat/completions');
    assert.strictEqual(
      resolveEndpoint({ baseUrl: 'https://api.example.com/v1///' }).url,
      'https://api.example.com/v1/chat/completions');
    // a local runtime pasted WITH the full path still normalizes
    assert.strictEqual(
      resolveEndpoint({ provider: 'lmstudio', baseUrl: 'http://localhost:1234/chat/completions' }).url,
      'http://localhost:1234/v1/chat/completions');
  });

  it('refuses a baseUrl carrying a query string or fragment with AI0001', function () {
    // this wire family composes endpoints by appending a path; a query
    // string has nowhere to go but into the middle of every URL
    for (const baseUrl of ['https://x.test/v1?api-version=1', 'https://x.test/v1#frag']) {
      assert.throws(() => resolveEndpoint({ baseUrl }),
        (err) => err instanceof AiError && err.code === 'AI0001' && /query|fragment/.test(err.message),
        baseUrl);
    }
  });

  it('resolves the base once and exposes it beside the chat URL', function () {
    const endpoint = resolveEndpoint({ baseUrl: 'https://api.example.com/v1/' });
    assert.strictEqual(endpoint.base, 'https://api.example.com/v1');
    assert.strictEqual(endpoint.url, `${endpoint.base}/chat/completions`);
    // the pasted-suffix strip is case-insensitive
    assert.strictEqual(resolveEndpoint({ baseUrl: 'https://api.example.com/v1/CHAT/Completions' }).base,
      'https://api.example.com/v1');
  });

  it('a baseUrl without a provider means custom; custom demands a baseUrl', function () {
    assert.strictEqual(resolveEndpoint({ baseUrl: 'https://x.test/api' }).provider, 'custom');
    assert.throws(() => resolveEndpoint({ provider: 'custom' }),
      (err) => err instanceof AiError && err.code === 'AI0001');
  });

  it('rejects unknown providers and unparseable URLs with AI0001', function () {
    assert.throws(() => resolveEndpoint({ provider: 'skynet' }),
      (err) => err instanceof AiError && err.code === 'AI0001' && /skynet/.test(err.message));
    assert.throws(() => resolveEndpoint({ baseUrl: 'not a url' }),
      (err) => err instanceof AiError && err.code === 'AI0001');
  });

  it('builds headers: json content type, bearer key, caller overrides win', function () {
    const bare = resolveEndpoint({ provider: 'ollama' });
    assert.strictEqual(bare.headers['content-type'], 'application/json');
    assert.strictEqual(bare.headers.authorization, undefined, 'no key, no auth header');

    const keyed = resolveEndpoint({ provider: 'openrouter', apiKey: ' sk-or-abc ' });
    assert.strictEqual(keyed.headers.authorization, 'Bearer sk-or-abc', 'key is trimmed');

    const custom = resolveEndpoint({
      provider: 'openrouter', apiKey: 'k',
      headers: { 'x-title': 'Jaren playground' },
    });
    assert.strictEqual(custom.headers['x-title'], 'Jaren playground');
  });

  it('carries the configured model through (empty by default)', function () {
    assert.strictEqual(resolveEndpoint({ provider: 'ollama' }).model, '');
    assert.strictEqual(resolveEndpoint({ provider: 'ollama', model: 'qwen3:4b' }).model, 'qwen3:4b');
  });

  it('every preset in PROVIDERS resolves (the labels are UI-ready)', function () {
    for (const [key, preset] of Object.entries(PROVIDERS)) {
      assert.strictEqual(typeof preset.label, 'string');
      if (preset.baseUrl !== null) {
        assert.match(resolveEndpoint({ provider: key }).url, /\/chat\/completions$/);
      }
    }
  });
});

describe('ai — provider capability probes', function () {
  it('a healthy provider answers with its model ids', async function () {
    /** @type {any} */
    let seen = null;
    const result = await probeProvider({
      provider: 'openrouter', apiKey: 'sk-x',
      fetch: (url, init) => {
        seen = { url, init };
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ id: 'qwen/qwen3-4b' }, { id: 'meta/llama-3' }, { broken: true }],
        }), { status: 200 }));
      },
    });
    assert.deepStrictEqual(result, { ok: true, models: ['qwen/qwen3-4b', 'meta/llama-3'] });
    assert.strictEqual(seen.url, 'https://openrouter.ai/api/v1/models');
    assert.strictEqual(seen.url, `${resolveEndpoint({ provider: 'openrouter' }).base}/models`,
      'the probe is the resolved base plus /models — one resolution, not a second');
    assert.strictEqual(seen.init.method, 'GET');
    assert.strictEqual(seen.init.headers.authorization, 'Bearer sk-x',
      'the probe authenticates exactly like a chat turn');
  });

  it('a rejected key reports the status without throwing', async function () {
    const result = await probeProvider({
      provider: 'openrouter', apiKey: 'bad',
      fetch: () => Promise.resolve(new Response('denied', { status: 401 })),
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(/** @type {any} */ (result).status, 401);
    assert.match(/** @type {any} */ (result).error, /401/);
  });

  it('a network failure and an invalid configuration both come back as { ok: false }', async function () {
    const down = await probeProvider({
      provider: 'ollama',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    assert.strictEqual(down.ok, false);
    assert.match(/** @type {any} */ (down).error, /fetch failed/);

    const misconfigured = await probeProvider({ provider: 'custom' });
    assert.strictEqual(misconfigured.ok, false);
    assert.match(/** @type {any} */ (misconfigured).error, /baseUrl/);

    // a base with a query string is refused before any request is made
    const queried = await probeProvider({
      baseUrl: 'https://x.test/v1?api-version=1',
      fetch: () => { throw new Error('must not reach fetch'); },
    });
    assert.strictEqual(queried.ok, false);
    assert.match(/** @type {any} */ (queried).error, /query/);
  });

  it('falls back to the global fetch when none is injected', async function () {
    const original = globalThis.fetch;
    globalThis.fetch = /** @type {any} */ (() => Promise.resolve(new Response(
      JSON.stringify({ data: [{ id: 'global-model' }] }), { status: 200 })));
    try {
      const result = await probeProvider({ provider: 'ollama' });
      assert.deepStrictEqual(result, { ok: true, models: ['global-model'] });
    }
    finally {
      globalThis.fetch = original;
    }
  });

  it('a hung server times out through the probe signal', async function () {
    const result = await probeProvider({
      provider: 'ollama', timeoutMs: 20,
      fetch: (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    });
    assert.strictEqual(result.ok, false);
    assert.match(/** @type {any} */ (result).error, /within 20 ms/);
  });
});
