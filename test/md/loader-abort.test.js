//@ts-check
/**
 * Concurrent loads of one document share a single fetch, and each caller
 * keeps its own cancellation. The first caller's abort used to reject
 * every caller that had joined its in-flight load, and a joiner's own
 * abort was ignored once it had joined.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { loadMarkdown, createMdCache, frontmatterExternals, parseMarkdown } from '@jarenjs/md';

/**
 * A fetch that answers once `release()` is called and honours the signal
 * it was given, as a real one does.
 * @param {string} body
 */
function gatedFetch(body) {
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => { release = () => resolve(undefined); });
  let calls = 0;
  /** @type {any} */
  const fetch = async (/** @type {string} */ _url, /** @type {any} */ init) => {
    calls++;
    await gate;
    if (init?.signal?.aborted) throw init.signal.reason;
    return { ok: true, status: 200, statusText: 'OK', headers: { get: () => null }, text: async () => body };
  };
  return { fetch, release, calls: () => calls };
}

describe('loadMarkdown — shared in-flight loads keep per-caller cancellation', function () {
  it('callers that do not abort share one fetch', async () => {
    const f = gatedFetch('# one');
    const cache = createMdCache(4);
    const a = loadMarkdown('http://x.test/a.md', { fetch: f.fetch, cache });
    const b = loadMarkdown('http://x.test/a.md', { fetch: f.fetch, cache });
    f.release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra, rb);
    assert.equal(f.calls(), 1);
  });

  it('the first caller aborting does not fail a caller that is still waiting', async () => {
    const f = gatedFetch('# kept');
    const cache = createMdCache(4);
    const leader = new AbortController();
    const first = loadMarkdown('http://x.test/b.md', { fetch: f.fetch, cache, signal: leader.signal });
    const second = loadMarkdown('http://x.test/b.md', { fetch: f.fetch, cache });
    leader.abort(new Error('first caller left'));
    f.release();
    const [a, b] = await Promise.allSettled([first, second]);
    assert.equal(a.status, 'rejected');
    assert.equal(/** @type {any} */ (a).reason.message, 'first caller left');
    assert.equal(b.status, 'fulfilled');
    assert.equal(/** @type {any} */ (b).value.source, '# kept');
    assert.equal(f.calls(), 2);
  });

  it('a caller that joined and then aborts is rejected with its own reason', async () => {
    const f = gatedFetch('# done');
    const cache = createMdCache(4);
    const first = loadMarkdown('http://x.test/c.md', { fetch: f.fetch, cache });
    const joiner = new AbortController();
    const second = loadMarkdown('http://x.test/c.md', { fetch: f.fetch, cache, signal: joiner.signal });
    joiner.abort(new Error('joiner left'));
    f.release();
    const [a, b] = await Promise.allSettled([first, second]);
    assert.equal(a.status, 'fulfilled');
    assert.equal(b.status, 'rejected');
    assert.equal(/** @type {any} */ (b).reason.message, 'joiner left');
    assert.equal(f.calls(), 1);
  });

  it('a joiner whose signal is already aborted is refused before it joins', async () => {
    const f = gatedFetch('# done');
    const cache = createMdCache(4);
    const first = loadMarkdown('http://x.test/d.md', { fetch: f.fetch, cache });
    const gone = new AbortController();
    gone.abort(new Error('already gone'));
    await assert.rejects(loadMarkdown('http://x.test/d.md', { fetch: f.fetch, cache, signal: gone.signal }),
      /already gone/);
    f.release();
    await first;
  });
});

describe('frontmatterExternals — a prototype-named key is data', function () {
  it('keeps __proto__ as an own member instead of re-parenting the externals', () => {
    const doc = parseMarkdown('---\n__proto__:\n  injected: 1\ntitle: t\n---\nx');
    const externals = frontmatterExternals(doc.frontmatter);
    assert.deepEqual(Object.keys(externals).sort(), ['__proto__', 'title']);
    assert.deepEqual(Object.getOwnPropertyDescriptor(externals, '__proto__')?.value, { injected: 1 });
    assert.equal(Object.getPrototypeOf(externals), Object.prototype);
    assert.equal(/** @type {any} */ (externals).injected, undefined);
  });

  it('keeps a scalar __proto__ too', () => {
    const doc = parseMarkdown('---\n__proto__: 5\n---\nx');
    const externals = frontmatterExternals(doc.frontmatter);
    assert.equal(Object.getOwnPropertyDescriptor(externals, '__proto__')?.value, 5);
  });
});
