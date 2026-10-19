//@ts-check
/**
 * The Radiant OS service worker, proven in Node: `os/public/sw.js` runs
 * in a vm sandbox against a fake cache and fetch. An OS installed once
 * must boot with no network at all, so everything the build emitted is
 * precached and served; nothing that failed is ever cached; and the
 * worker retires only its own old caches — the classic site's worker
 * shares the origin.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SW_SOURCE = readFileSync(new URL('../../packages/website/os/public/sw.js', import.meta.url), 'utf8');
const SCOPE = 'https://host/jarenjs/os/';
const BUILT = ['assets/index-abc.js', 'assets/index-abc.css', 'assets/db-worker-def.js', 'assets/sqlite3-123.wasm'];

const keyUrl = (/** @type {any} */ k) => (typeof k === 'string' ? k : k.url);
const response = (/** @type {any} */ body, /** @type {boolean} */ ok) => ({
  ok, status: ok ? 200 : 404, body, clone() { return { ...this }; }, json: () => Promise.resolve(body),
});

/**
 * Evaluate the worker in a sandbox.
 * @param {(request: any) => Promise<any>} fetchImpl
 * @param {string[]} [cacheKeys]
 */
function bootSw(fetchImpl, cacheKeys = []) {
  /** @type {Map<string, Function>} */
  const listeners = new Map();
  /** @type {Map<string, any>} */
  const store = new Map();
  /** @type {string[]} */
  const puts = [];
  /** @type {string[]} */
  const deleted = [];
  const cache = {
    addAll: (/** @type {string[]} */ urls) => {
      for (const u of urls) store.set(u, response(`precached:${u}`, true));
      return Promise.resolve();
    },
    put: (/** @type {any} */ key, /** @type {any} */ res) => {
      puts.push(keyUrl(key));
      store.set(keyUrl(key), res);
      return Promise.resolve();
    },
  };
  const context = {
    self: {
      registration: { scope: SCOPE },
      addEventListener: (/** @type {string} */ type, /** @type {Function} */ fn) => listeners.set(type, fn),
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve() },
    },
    caches: {
      open: () => Promise.resolve(cache),
      match: (/** @type {any} */ k) => Promise.resolve(store.get(keyUrl(k))),
      keys: () => Promise.resolve(cacheKeys),
      delete: (/** @type {string} */ key) => { deleted.push(key); return Promise.resolve(true); },
    },
    fetch: fetchImpl,
    URL,
  };
  vm.createContext(context);
  new vm.Script(SW_SOURCE, { filename: 'os/sw.js' }).runInContext(context);
  return { listeners, store, puts, deleted };
}

/** @param {Map<string, Function>} listeners @param {string} type */
async function lifecycle(listeners, type) {
  /** @type {any} */
  let settled;
  listeners.get(type)?.({ waitUntil: (/** @type {Promise<any>} */ p) => { settled = p; } });
  await settled;
}

/** One fetch event; the response, or null when no branch answered.
 * @param {Map<string, Function>} listeners @param {string} url @param {string} [mode] @param {string} [method] */
async function dispatchFetch(listeners, url, mode = 'no-cors', method = 'GET') {
  /** @type {any} */
  let responded = null;
  listeners.get('fetch')?.({
    request: { method, url, mode },
    respondWith: (/** @type {any} */ p) => { responded = Promise.resolve(p); },
  });
  const out = responded === null ? null : await responded;
  await new Promise((resolve) => setTimeout(resolve, 0));
  return out;
}

/** A network that serves the build's file list, then goes away. */
function network() {
  const net = { online: true };
  const fetchImpl = (/** @type {any} */ request) => {
    if (!net.online) return Promise.reject(new Error('offline'));
    const url = keyUrl(request);
    if (url === `${SCOPE}precache.json`) return Promise.resolve(response({ files: BUILT }, true));
    return Promise.resolve(response(`network:${url}`, true));
  };
  return { net, fetchImpl };
}

describe('the Radiant OS service worker', () => {
  it('precaches the shell and everything the build emitted, and serves all of it offline', async () => {
    const { net, fetchImpl } = network();
    const sw = bootSw(fetchImpl);
    await lifecycle(sw.listeners, 'install');
    const precached = [...sw.store.keys()];
    for (const file of BUILT) assert.ok(precached.includes(`${SCOPE}${file}`), file);
    assert.ok(precached.includes(SCOPE));
    assert.ok(precached.includes(`${SCOPE}manifest.webmanifest`));
    net.online = false;
    for (const url of precached) {
      const res = await dispatchFetch(sw.listeners, url, url === SCOPE ? 'navigate' : 'no-cors');
      assert.equal(res?.body, `precached:${url}`, `${url} is served offline`);
    }
  });

  it('still installs the shell when the build list cannot be read', async () => {
    for (const listing of [
      () => Promise.reject(new Error('offline')),
      () => Promise.resolve(response('missing', false)),
      () => Promise.resolve(response({ files: 'nope' }, true)),
    ]) {
      const sw = bootSw((request) => (keyUrl(request).endsWith('precache.json') ? listing() : Promise.resolve(response('x', true))));
      await lifecycle(sw.listeners, 'install');
      assert.deepEqual([...sw.store.keys()].filter((u) => u.includes('/assets/')), []);
      assert.ok(sw.store.has(SCOPE));
    }
  });

  it('never caches a failed response, and only the shell refreshes the shell', async () => {
    const bad = bootSw(() => Promise.resolve(response('bad', false)));
    await dispatchFetch(bad.listeners, SCOPE, 'navigate');
    await dispatchFetch(bad.listeners, `${SCOPE}assets/index-new.js`);
    assert.deepEqual(bad.puts, []);

    const { net, fetchImpl } = network();
    const sw = bootSw(fetchImpl);
    await lifecycle(sw.listeners, 'install');
    await dispatchFetch(sw.listeners, `${SCOPE}manifest.webmanifest`, 'navigate');
    assert.equal(sw.store.get(SCOPE).body, `precached:${SCOPE}`, 'a raw file opened in a tab is not the shell');
    await dispatchFetch(sw.listeners, SCOPE, 'navigate');
    assert.equal(sw.store.get(SCOPE).body, `network:${SCOPE}`);
    await dispatchFetch(sw.listeners, `${SCOPE}assets/index-new.js`);
    assert.ok(sw.puts.includes(`${SCOPE}assets/index-new.js`), 'a new hashed chunk is kept once fetched');
    net.online = false;
    assert.equal((await dispatchFetch(sw.listeners, `${SCOPE}assets/index-new.js`))?.body, `network:${SCOPE}assets/index-new.js`);
  });

  it('answers only its own scope, and only reads', async () => {
    const { fetchImpl } = network();
    const sw = bootSw(fetchImpl);
    assert.equal(await dispatchFetch(sw.listeners, 'https://host/jarenjs/', 'navigate'), null, 'the classic site is not the OS');
    assert.equal(await dispatchFetch(sw.listeners, `${SCOPE}assets/x.js`, 'no-cors', 'POST'), null);
    assert.equal(await dispatchFetch(sw.listeners, `${SCOPE}precache.json`), null, 'the build list is always fetched fresh');
  });

  it('retires only its own old caches', async () => {
    const sw = bootSw(() => Promise.reject(new Error('offline')), ['radiant-os-v0', 'radiant-os-v1', 'jaren-website-v29', 'other']);
    await lifecycle(sw.listeners, 'activate');
    assert.deepEqual(sw.deleted, ['radiant-os-v0']);
  });
});
