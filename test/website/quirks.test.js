//@ts-check
/**
 * The service worker, proven in Node (TODO_SITE_01 Q7): sw.js runs in a
 * vm sandbox against a fake cache + fetch, so the two repaired contracts
 * hold without a browser —
 *  (a) every URL the install handler precaches is served by a fetch
 *      branch (the old worker precached fonts and root statics no branch
 *      ever matched, so they died offline), and
 *  (b) every cache.put is gated on `response.ok` (a 404/502 must never
 *      be cached forever, and a bad navigation response must never
 *      replace the shell).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SW_SOURCE = readFileSync(
  new URL('../../packages/website/public/sw.js', import.meta.url), 'utf8');
const SCOPE = 'https://host/jarenjs/';

const keyUrl = (k) => (typeof k === 'string' ? k : k.url);
const response = (body, ok) => ({ ok, status: ok ? 200 : 404, body, clone() { return { ...this }; } });

/** Evaluate sw.js in a sandbox; returns its listeners and the cache spies. */
function bootSw(fetchImpl) {
  /** @type {Map<string, Function>} */
  const listeners = new Map();
  /** @type {Map<string, any>} */
  const store = new Map();
  /** @type {{ key: string, ok: boolean }[]} */
  const puts = [];
  const cache = {
    addAll: (urls) => {
      for (const u of urls) store.set(u, response(`precached:${u}`, true));
      return Promise.resolve();
    },
    put: (key, res) => {
      puts.push({ key: keyUrl(key), ok: res.ok });
      store.set(keyUrl(key), res);
      return Promise.resolve();
    },
  };
  const context = {
    self: {
      registration: { scope: SCOPE },
      addEventListener: (type, fn) => listeners.set(type, fn),
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve() },
    },
    caches: {
      open: () => Promise.resolve(cache),
      match: (k) => Promise.resolve(store.get(keyUrl(k))),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(true),
    },
    fetch: fetchImpl,
    URL,
  };
  vm.createContext(context);
  new vm.Script(SW_SOURCE, { filename: 'sw.js' }).runInContext(context);
  return { listeners, store, puts };
}

const runInstall = async (listeners) => {
  let settled;
  listeners.get('install')({ waitUntil: (p) => { settled = p; } });
  await settled;
};

/** Dispatch one fetch event; resolves the response, or null if no branch responded. */
const dispatchFetch = async (listeners, url, mode = 'no-cors') => {
  /** @type {any} */
  let responded = null;
  listeners.get('fetch')({
    request: { method: 'GET', url, mode },
    respondWith: (p) => { responded = Promise.resolve(p); },
  });
  const out = responded === null ? null : await responded;
  await new Promise((resolve) => setTimeout(resolve, 0)); // drain the cache.put microtasks
  return out;
};

describe('website — the service worker (Node vm harness)', function () {
  it('every precached URL is served by a fetch branch — the precache is reachable offline', async function () {
    const { listeners, store } = bootSw(() => Promise.reject(new Error('offline')));
    await runInstall(listeners);
    const precached = [...store.keys()];
    assert.ok(precached.length >= 10, 'shell + manifest + svg + 2 icons + 5 fonts precached');
    assert.ok(precached.some((u) => u.includes('/fonts/')), 'the built-CSS font URLs are among them');
    for (const url of precached) {
      const res = await dispatchFetch(listeners, url, url === SCOPE ? 'navigate' : 'no-cors');
      assert.ok(res !== null, `${url}: a fetch branch responded (offline)`);
      assert.strictEqual(res.body, `precached:${url}`, `${url}: served from the precache`);
    }
  });

  it('no cache.put on a non-ok response — a 404 is never cached, the shell never replaced', async function () {
    const bad = bootSw(() => Promise.resolve(response('bad', false)));
    await runInstall(bad.listeners);
    await dispatchFetch(bad.listeners, SCOPE, 'navigate');
    await dispatchFetch(bad.listeners, `${SCOPE}assets/index-abc123.js`);
    await dispatchFetch(bad.listeners, `${SCOPE}benchmarks/meta.json`);
    assert.deepStrictEqual(bad.puts, [], 'all three put sites are gated on response.ok');
    assert.strictEqual(bad.store.get(SCOPE).body, `precached:${SCOPE}`,
      'the cached shell survived the bad navigation response');

    const good = bootSw(() => Promise.resolve(response('fresh', true)));
    await runInstall(good.listeners);
    await dispatchFetch(good.listeners, SCOPE, 'navigate');
    await dispatchFetch(good.listeners, `${SCOPE}assets/index-abc123.js`);
    await dispatchFetch(good.listeners, `${SCOPE}benchmarks/meta.json`);
    assert.deepStrictEqual(good.puts.map((p) => p.key), [
      SCOPE, `${SCOPE}assets/index-abc123.js`, `${SCOPE}benchmarks/meta.json`,
    ], 'ok responses cache at all three sites');
  });
});
