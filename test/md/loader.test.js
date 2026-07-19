//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { loadMarkdown, streamMarkdown, createMdCache } from '@jarenjs/md';

/**
 * A fetch stub serving from a routes map, counting calls, and speaking
 * just enough Response for the loader: ok/status/headers/body/text.
 * @param {Record<string, { text: string, etag?: string, stream?: boolean }>} routes
 */
function fakeFetch(routes) {
  const calls = [];
  /** @type {any} */
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers });
    if (init.signal !== undefined && init.signal !== null && init.signal.aborted) {
      throw init.signal.reason ?? new Error('aborted');
    }
    const route = routes[String(url)];
    if (route === undefined) {
      return { ok: false, status: 404, statusText: 'Not Found', headers: { get: () => null }, body: null, text: async () => '' };
    }
    if (route.etag !== undefined && init.headers !== undefined
      && init.headers['if-none-match'] === route.etag) {
      return { ok: false, status: 304, statusText: 'Not Modified', headers: { get: () => null }, body: null, text: async () => '' };
    }
    const body = route.stream === true
      ? (async function* () {
        const mid = Math.floor(route.text.length / 2);
        yield route.text.slice(0, mid);
        yield route.text.slice(mid);
      })()
      : null;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: (name) => (name === 'etag' ? route.etag ?? null : null) },
      body,
      text: async () => route.text,
    };
  };
  fetchFn.calls = calls;
  return fetchFn;
}

describe('loadMarkdown', function () {
  it('loads, compiles and records the source URL', async function () {
    const fetchFn = fakeFetch({ 'https://x.test/a.md': { text: '# A\n\ntext\n' } });
    const md = await loadMarkdown('https://x.test/a.md', { fetch: fetchFn, cache: false });
    assert.equal(md.doc.meta.sourceUrl, 'https://x.test/a.md');
    assert.equal(md.ast[0].type, 'heading');
    assert.equal(md.source, '# A\n\ntext\n');
  });

  it('parses progressively from a streaming body', async function () {
    const fetchFn = fakeFetch({ 'https://x.test/s.md': { text: '# S\n\np1\n\np2\n', stream: true } });
    const md = await loadMarkdown('https://x.test/s.md', { fetch: fetchFn, cache: false });
    assert.deepEqual(md.ast.map((n) => n.type), ['heading', 'paragraph', 'paragraph']);
    assert.equal(md.source, '# S\n\np1\n\np2\n');
  });

  it('resolves relative URLs against base', async function () {
    const fetchFn = fakeFetch({ 'https://x.test/docs/a.md': { text: 'x\n' } });
    const md = await loadMarkdown('a.md', { base: 'https://x.test/docs/', fetch: fetchFn, cache: false });
    assert.equal(md.doc.meta.sourceUrl, 'https://x.test/docs/a.md');
  });

  it('caches by URL and shares in-flight fetches', async function () {
    const fetchFn = fakeFetch({ 'https://x.test/c.md': { text: '# C\n' } });
    const cache = createMdCache();
    const [a, b] = await Promise.all([
      loadMarkdown('https://x.test/c.md', { fetch: fetchFn, cache }),
      loadMarkdown('https://x.test/c.md', { fetch: fetchFn, cache }),
    ]);
    assert.equal(a, b);
    assert.equal(fetchFn.calls.length, 1);
    const c = await loadMarkdown('https://x.test/c.md', { fetch: fetchFn, cache });
    assert.equal(c, a);
    assert.equal(fetchFn.calls.length, 1); // no validators → no revalidation
  });

  it('revalidates entries that carry an ETag', async function () {
    const routes = { 'https://x.test/e.md': { text: '# E1\n', etag: '"v1"' } };
    const fetchFn = fakeFetch(routes);
    const cache = createMdCache();
    const first = await loadMarkdown('https://x.test/e.md', { fetch: fetchFn, cache });
    assert.equal(fetchFn.calls.length, 1);
    // Hit: served immediately, 304 revalidation in the background.
    const second = await loadMarkdown('https://x.test/e.md', { fetch: fetchFn, cache });
    assert.equal(second, first);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fetchFn.calls.length, 2);
    assert.equal(fetchFn.calls[1].headers['if-none-match'], '"v1"');
    // Content changed at the origin: the next revalidation replaces it.
    routes['https://x.test/e.md'] = { text: '# E2\n', etag: '"v2"' };
    await loadMarkdown('https://x.test/e.md', { fetch: fetchFn, cache });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const third = await loadMarkdown('https://x.test/e.md', { fetch: fetchFn, cache });
    assert.equal(third.ast[0].children[0].value, 'E2');
  });

  it('keys the cache on the plugin set', async function () {
    const fetchFn = fakeFetch({ 'https://x.test/p.md': { text: '```x\nv\n```\n' } });
    const cache = createMdCache();
    const plain = await loadMarkdown('https://x.test/p.md', { fetch: fetchFn, cache });
    const claiming = [{ name: 'x-claim', fences: ['x'], node: 'x-node' }];
    const claimed = await loadMarkdown('https://x.test/p.md', { fetch: fetchFn, cache, plugins: claiming });
    assert.equal(plain.ast[0].type, 'code');
    assert.equal(claimed.ast[0].type, 'x-node');
    assert.equal(fetchFn.calls.length, 2);
  });

  it('rejects on HTTP errors and evicts failed entries', async function () {
    const fetchFn = fakeFetch({});
    const cache = createMdCache();
    await assert.rejects(
      loadMarkdown('https://x.test/missing.md', { fetch: fetchFn, cache }),
      /404/);
    // The failure is not cached.
    await assert.rejects(
      loadMarkdown('https://x.test/missing.md', { fetch: fetchFn, cache }),
      /404/);
    assert.equal(fetchFn.calls.length, 2);
  });

  it('rejects with the abort reason', async function () {
    const controller = new AbortController();
    controller.abort(new Error('user cancelled'));
    const fetchFn = fakeFetch({ 'https://x.test/a.md': { text: 'x' } });
    await assert.rejects(
      loadMarkdown('https://x.test/a.md', { fetch: fetchFn, cache: false, signal: controller.signal }),
      /user cancelled/);
  });

  it('streamMarkdown drives the same fetch path', async function () {
    const fetchFn = fakeFetch({ 'https://x.test/s.md': { text: '# S\n\nbody\n', stream: true } });
    const seen = [];
    const iterator = streamMarkdown('https://x.test/s.md', { fetch: fetchFn });
    let step = await iterator.next();
    while (!step.done) {
      seen.push(step.value.type);
      step = await iterator.next();
    }
    assert.deepEqual(seen, ['heading', 'paragraph']);
    assert.equal(step.value.meta.sourceUrl, 'https://x.test/s.md');
  });
});

describe('createMdCache', function () {
  it('evicts least-recently-used entries at the limit', function () {
    const cache = createMdCache(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');       // refresh a
    cache.set('c', 3);    // evicts b
    assert.equal(cache.get('a'), 1);
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('c'), 3);
    cache.clear();
    assert.equal(cache.get('a'), undefined);
  });
});
