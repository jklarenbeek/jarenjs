//@ts-check
/**
 * @file The client half of idempotency and the retry policy: a key is
 * generated (or taken from `ctx.idempotencyKey`) and sent for every
 * `optional`/`required` command; with a `storage` the record
 * `{ op, key, hash, at }` — never the input — is written before the
 * send, cleared on a terminal outcome, left on `network`/`cancelled` for
 * `pending()`; a throwing store is `JC2054` and nothing is sent; retry
 * runs only under a declared policy, on `network` and on `retry.on`
 * codes, at most `max` times, through the injected `sleep`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { toFetchHandler } from '@jarenjs/contract/fetch';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { canonicalSha256 } from '@jarenjs/json/canonical';
import { openHttpClient } from '@jarenjs/contract/client';
import { load, shopHandlers } from './helpers.js';

const shop = compileContract(load('./fixtures/shop.contract.json'));
const PRODUCT = { id: 1, name: 'x', price: 1 };
const SAVE = { id: 1, revision: 1, product: PRODUCT };

/** An in-memory docstore-shaped storage that records every call. */
function memoryStorage() {
  /** @type {any} */
  let value;
  const calls = { read: 0, write: 0 };
  return {
    calls,
    storage: { read: () => { calls.read++; return value; }, write: (/** @type {any} */ v) => { calls.write++; value = JSON.parse(JSON.stringify(v)); } },
    snapshot: () => value,
  };
}

/**
 * @param {Record<string, any>} [handlers]
 * @param {any} [clientOptions]
 */
function pair(handlers = {}, clientOptions = {}) {
  const ledger = createMemoryLedger();
  const server = serveHttp(shop, { ...shopHandlers(), ...handlers }, { ledger });
  const handler = toFetchHandler(server);
  /** @type {{ url: string, init: any }[]} */
  const sent = [];
  const client = openHttpClient(shop, {
    fetch: async (url, init) => { sent.push({ url, init }); return handler(new Request('http://x' + url, init)); },
    ...clientOptions,
  });
  return { ledger, client, sent };
}

describe('the client half of idempotency', () => {
  it('a key is generated per command and sent as Idempotency-Key; ctx.idempotencyKey replaces it; reads carry none', async () => {
    let n = 0;
    const { client, sent, ledger } = pair({}, { keys: () => `k-${++n}` });
    await client.invoke('product.save', SAVE);
    await client.invoke('product.save', SAVE);
    assert.deepStrictEqual(sent.map((s) => s.init.headers['idempotency-key']), ['k-1', 'k-2']);
    await client.invoke('product.save', SAVE, { idempotencyKey: 'mine' });
    assert.strictEqual(sent[2].init.headers['idempotency-key'], 'mine');
    assert.strictEqual(ledger.lookup({ op: 'product.save', scope: '', key: 'mine' })?.status, 'committed');
    // optional idempotency also gets a key
    await client.invoke('product.remove', { id: 1 });
    assert.strictEqual(sent[3].init.headers['idempotency-key'], 'k-3');
    await client.invoke('catalog.load');
    assert.strictEqual(sent[4].init.headers['idempotency-key'], undefined, 'a read carries no key');
    // the same key twice replays server-side: the same outcome, the replay header is not an outcome member
    let runs = 0;
    const { client: c2 } = pair({ 'product.save': () => { runs++; return PRODUCT; } });
    const a = await c2.invoke('product.save', SAVE, { idempotencyKey: 'same' });
    const b = await c2.invoke('product.save', SAVE, { idempotencyKey: 'same' });
    assert.deepStrictEqual([runs, a.ok, b.ok], [1, true, true]);
    if (a.ok && b.ok) assert.notStrictEqual(a.meta.trace, b.meta.trace, 'a replay carries a fresh trace');
  });

  it('a throwing key store is JC2054 and nothing is sent', async () => {
    const { client, sent } = pair({}, { storage: { read: () => { throw new Error('quota'); }, write: () => {} } });
    const o = await client.invoke('product.save', SAVE);
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(o.ok, false);
    if (!o.ok) assert.deepStrictEqual([o.kind, o.error.code, o.error.retryable], ['contract', 'JC2054', false]);
    // a store that rejects asynchronously on write is the same
    const { client: c2, sent: s2 } = pair({}, { storage: { read: async () => undefined, write: async () => { throw new Error('disk'); } } });
    const r2 = await c2.invoke('product.save', SAVE);
    assert.deepStrictEqual([s2.length, !r2.ok && r2.error.code], [0, 'JC2054']);
    // a read never touches the store
    const r3 = await c2.invoke('catalog.load');
    assert.strictEqual(r3.ok, true);
  });

  it('with storage: the record is written before the send, cleared on ok/failure, kept on network; pending() lists it; no input is stored', async () => {
    const mem = memoryStorage();
    let offline = false;
    const handler = toFetchHandler(serveHttp(shop, { ...shopHandlers(), 'product.save': (input, ctx) => (input.id === 2 ? ctx.fail('conflict', {}, { current: PRODUCT }) : PRODUCT) }, { ledger: createMemoryLedger() }));
    /** @type {any[]} */
    const sent = [];
    const client = openHttpClient(shop, {
      storage: mem.storage, keys: () => 'k-1', now: () => 1700000000000, sleep: async () => {},
      fetch: async (/** @type {string} */ url, /** @type {any} */ init) => {
        if (offline) throw new TypeError('offline');
        sent.push({ url, init });
        return handler(new Request('http://x' + url, init));
      },
    });
    assert.strictEqual(client.capabilities.durableKeys, true);
    assert.deepStrictEqual(await client.pending(), []);
    // ok → written then cleared
    const ok = await client.invoke('product.save', SAVE);
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual(await client.pending(), []);
    assert.deepStrictEqual(mem.snapshot(), { 'jaren-contract': { shop: {} } }, 'the record was dropped');
    assert.strictEqual(mem.calls.write, 2, 'one write before the send, one to drop');
    // network → kept, pending() names it, the record carries no member of the input
    offline = true;
    const net = await client.invoke('product.save', { id: 77, revision: 3, product: { id: 77, name: 'secret-name', price: 9 } }, { idempotencyKey: 'k-net' });
    assert.strictEqual(!net.ok && net.kind, 'network');
    assert.deepStrictEqual(await client.pending(), [{ op: 'product.save', key: 'k-net' }]);
    const record = mem.snapshot()['jaren-contract'].shop['product.save']['k-net'];
    assert.deepStrictEqual(Object.keys(record).sort(), ['at', 'hash', 'key', 'op']);
    assert.strictEqual(record.at, 1700000000000);
    assert.strictEqual(record.hash, await canonicalSha256({ id: 77, revision: 3, product: { id: 77, name: 'secret-name', price: 9 } }), 'the request hash of §8');
    assert.doesNotMatch(JSON.stringify(mem.snapshot()), /secret-name|77/, 'no member of the input is stored');
    // a later invoke with the same key that reaches the server clears it
    offline = false;
    const again = await client.invoke('product.save', { id: 77, revision: 3, product: { id: 77, name: 'secret-name', price: 9 } }, { idempotencyKey: 'k-net' });
    assert.strictEqual(again.ok, true);
    assert.deepStrictEqual(await client.pending(), []);
    // a declared failure is terminal: cleared
    const fail = await client.invoke('product.save', { id: 2, revision: 1, product: PRODUCT }, { idempotencyKey: 'k-fail' });
    assert.strictEqual(!fail.ok && fail.kind, 'failure');
    assert.deepStrictEqual(await client.pending(), []);
    // cancelled → kept
    const ctl = new AbortController();
    ctl.abort();
    const cancelled = await client.invoke('product.save', SAVE, { idempotencyKey: 'k-cancel', signal: ctl.signal });
    assert.strictEqual(!cancelled.ok && cancelled.kind, 'cancelled');
    assert.deepStrictEqual(await client.pending(), [{ op: 'product.save', key: 'k-cancel' }]);
    // a second client over the same storage sees the same pending list (a restart)
    const restarted = openHttpClient(shop, { storage: mem.storage });
    assert.deepStrictEqual(await restarted.pending(), [{ op: 'product.save', key: 'k-cancel' }]);
    // a contract outcome that is retryable (JC2055 5xx) keeps the record; a non-retryable one drops it
    const bad = openHttpClient(shop, { storage: mem.storage, keys: () => 'k-502', fetch: async () => new Response('gateway', { status: 502 }) });
    assert.strictEqual(!(await bad.invoke('product.save', SAVE)).ok, true);
    assert.ok((await bad.pending()).some((p) => p.key === 'k-502'), 'a retryable contract outcome keeps the record');
    const bad2 = openHttpClient(shop, { storage: mem.storage, keys: () => 'k-400', fetch: async () => new Response('nope', { status: 400 }) });
    await bad2.invoke('product.save', SAVE);
    assert.ok(!(await bad2.pending()).some((p) => p.key === 'k-400'), 'a non-retryable contract outcome drops it');
    // a store that throws on the drop leaves the record and the outcome stands
    let writes = 0;
    const flaky = { read: mem.storage.read, write: (/** @type {any} */ v) => { if (++writes === 2) throw new Error('late'); mem.storage.write(v); } };
    const c3 = openHttpClient(shop, { storage: flaky, keys: () => 'k-late', fetch: async () => new Response(JSON.stringify(PRODUCT), { status: 200 }) });
    const r3 = await c3.invoke('product.save', SAVE);
    assert.strictEqual(r3.ok, true);
    assert.ok((await c3.pending()).some((p) => p.key === 'k-late'));
  });

  it('a lone surrogate in the input is JC2050 (keyword canonical) when a hash is needed', async () => {
    const mem = memoryStorage();
    const { client, sent } = pair({}, { storage: mem.storage });
    const o = await client.invoke('product.save', { id: 1, revision: 1, product: { id: 1, name: '\uD800', price: 1 } });
    assert.strictEqual(sent.length, 0);
    if (!o.ok) assert.deepStrictEqual([o.error.code, /** @type {any} */ (o.error.details)[0].keyword], ['JC2050', 'canonical']);
  });

  it('serializes concurrent durable records across clients sharing one storage adapter', async () => {
    for (const shared of [false, true]) {
      const mem = memoryStorage();
      const firstRead = Promise.withResolvers();
      let reads = 0;
      let clocks = 0;
      const storage = { ...mem.storage, read: () => {
        const previous = mem.storage.read();
        return ++reads === 1 ? firstRead.promise.then(() => previous) : previous;
      } };
      const options = {
        storage, sleep: async () => {},
        now: () => {
          if (++clocks === 2) firstRead.resolve(undefined);
          return 1;
        },
        fetch: async () => { throw new TypeError('offline'); },
      };
      const first = openHttpClient(shop, options);
      const second = shared ? openHttpClient(shop, options) : first;
      try {
        const outcomes = await Promise.all([
          first.invoke('product.save', SAVE, { idempotencyKey: 'a' }),
          second.invoke('product.save', SAVE, { idempotencyKey: 'b' }),
        ]);
        assert.deepStrictEqual(outcomes.map((outcome) => outcome.kind), ['network', 'network']);
        assert.deepStrictEqual(await first.pending(),
          [{ op: 'product.save', key: 'a' }, { op: 'product.save', key: 'b' }]);
      }
      finally { first.close(); second.close(); }
    }
  });

  it('keeps a new durable record when it overlaps a settled key release', async () => {
    const mem = memoryStorage();
    const fetched = Promise.withResolvers();
    const response = Promise.withResolvers();
    const releaseRead = Promise.withResolvers();
    const continueRelease = Promise.withResolvers();
    let holdRead = false;
    let clocks = 0;
    const storage = { ...mem.storage, read: () => {
      const previous = mem.storage.read();
      if (!holdRead) return previous;
      holdRead = false;
      releaseRead.resolve(undefined);
      return continueRelease.promise.then(() => previous);
    } };
    const client = openHttpClient(shop, {
      storage, sleep: async () => {},
      now: () => {
        if (++clocks === 2) continueRelease.resolve(undefined);
        return 1;
      },
      fetch: async (_url, init) => {
        if (init.headers['idempotency-key'] === 'b') throw new TypeError('offline');
        fetched.resolve(undefined);
        return response.promise;
      },
    });
    try {
      const first = client.invoke('product.save', SAVE, { idempotencyKey: 'a' });
      await fetched.promise;
      holdRead = true;
      response.resolve(new Response(JSON.stringify(PRODUCT), { status: 200 }));
      await releaseRead.promise;
      const second = client.invoke('product.save', SAVE, { idempotencyKey: 'b' });
      assert.strictEqual((await first).ok, true);
      assert.strictEqual((await second).kind, 'network');
      assert.deepStrictEqual(await client.pending(), [{ op: 'product.save', key: 'b' }]);
    }
    finally { client.close(); }
  });

  it('continues durable writes after a failed queued update', async () => {
    const mem = memoryStorage();
    let writes = 0;
    const client = openHttpClient(shop, {
      storage: { ...mem.storage, write: (value) => {
        if (++writes === 1) throw new Error('disk');
        mem.storage.write(value);
      } },
      sleep: async () => {}, fetch: async () => { throw new TypeError('offline'); },
    });
    try {
      const failed = await client.invoke('product.save', SAVE, { idempotencyKey: 'a' });
      assert.strictEqual(failed.ok, false);
      if (!failed.ok) assert.strictEqual(failed.error.code, 'JC2054');
      assert.strictEqual((await client.invoke('product.save', SAVE, { idempotencyKey: 'b' })).kind, 'network');
      assert.deepStrictEqual(await client.pending(), [{ op: 'product.save', key: 'b' }]);
    }
    finally { client.close(); }
  });
});

describe('retry under the declared policy', () => {
  /** A recording sleeper that never waits. */
  function sleeper() {
    /** @type {number[]} */
    const delays = [];
    return { delays, sleep: async (/** @type {number} */ ms) => { delays.push(ms); } };
  }

  it('a network outcome is retried up to retry.max with exponential backoff through sleep; the key stays the same', async () => {
    let calls = 0;
    /** @type {string[]} */
    const keys = [];
    const { delays, sleep } = sleeper();
    const client = openHttpClient(shop, { sleep, keys: () => 'fixed', fetch: async (url, init) => {
      calls++;
      keys.push(init.headers['idempotency-key']);
      if (calls < 3) throw new TypeError('offline');
      return new Response(JSON.stringify(PRODUCT), { status: 200, headers: { 'x-jaren-trace': `t${calls}` } });
    } });
    const o = await client.invoke('product.save', SAVE, { attempt: 1 });   // product.save: retry { max: 2, on: ['not-found'] }
    assert.strictEqual(o.ok, true);
    if (o.ok) assert.deepStrictEqual([o.meta.trace, o.meta.attempt], ['t3', 1], 'the last response\'s trace; the caller\'s attempt');
    assert.strictEqual(calls, 3);
    assert.deepStrictEqual(keys, ['fixed', 'fixed', 'fixed']);
    assert.strictEqual(delays.length, 2);
    assert.ok(delays[0] >= 1000 && delays[0] < 1250, `first backoff ${delays[0]}`);
    assert.ok(delays[1] >= 2000 && delays[1] < 2250, `second backoff ${delays[1]}`);
    // exhausted: max attempts then the last network outcome
    let n = 0;
    const dead = openHttpClient(shop, { sleep, fetch: async () => { n++; throw new TypeError('offline'); } });
    const r = await dead.invoke('product.save', SAVE);
    assert.deepStrictEqual([n, !r.ok && r.kind], [3, 'network']);
    // the backoff ceiling: 1000·2^n capped at 8000
    const many = compileContract({ $contract: '0.1', operations: { a: { kind: 'read', output: true, policy: { retry: { max: 6, on: [] } } } } });
    const { delays: d2, sleep: s2 } = sleeper();
    const c2 = openHttpClient(many, { sleep: s2, fetch: async () => { throw new TypeError('x'); } });
    await c2.invoke('a');
    assert.deepStrictEqual(d2.map((d) => Math.floor(d / 1000) * 1000), [1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it('a failure whose code is in retry.on is retried; other failures and contract outcomes are not; no policy → no retry', async () => {
    let calls = 0;
    const { sleep, delays } = sleeper();
    const client = openHttpClient(shop, { sleep, fetch: async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ code: 'not-found', message: 'm', requestId: 'r', retryable: true }), { status: 404 });
      return new Response(JSON.stringify(PRODUCT), { status: 200 });
    } });
    const o = await client.invoke('product.save', SAVE);
    assert.deepStrictEqual([o.ok, calls, delays.length], [true, 2, 1]);
    // conflict is declared but not in retry.on
    let n = 0;
    const c2 = openHttpClient(shop, { sleep, fetch: async () => { n++; return new Response(JSON.stringify({ code: 'conflict' }), { status: 409 }); } });
    const r2 = await c2.invoke('product.save', SAVE);
    assert.deepStrictEqual([n, !r2.ok && r2.error.code], [1, 'conflict']);
    // a contract outcome (JC2055 5xx, retryable by status) is NOT retried — only network and retry.on failures are
    let m = 0;
    const c3 = openHttpClient(shop, { sleep, fetch: async () => { m++; return new Response('x', { status: 503 }); } });
    const r3 = await c3.invoke('product.save', SAVE);
    assert.deepStrictEqual([m, !r3.ok && r3.error.code], [1, 'JC2055']);
    // no retry policy: catalog.load is never retried
    let k = 0;
    const c4 = openHttpClient(shop, { sleep, fetch: async () => { k++; throw new TypeError('x'); } });
    const r4 = await c4.invoke('catalog.load');
    assert.deepStrictEqual([k, !r4.ok && r4.kind], [1, 'network']);
    // a taxonomy code in retry.on (JC2009 in-progress) is retried
    const withTax = compileContract({ $contract: '0.1', operations: { a: { kind: 'read', output: true, policy: { retry: { max: 1, on: ['JC2009'] } } } } });
    let j = 0;
    const c5 = openHttpClient(withTax, { sleep, fetch: async () => (++j === 1
      ? new Response(JSON.stringify({ code: 'JC2009', retryable: true }), { status: 409 })
      : new Response('true', { status: 200 })) });
    assert.deepStrictEqual([(await c5.invoke('a')).ok, j], [true, 2]);
  });

  it('an abort during the backoff resolves cancelled; the default sleeper honors the signal', async () => {
    const ctl = new AbortController();
    let calls = 0;
    const client = openHttpClient(shop, { fetch: async () => { calls++; throw new TypeError('offline'); } });
    const pending = client.invoke('product.save', SAVE, { signal: ctl.signal });
    // the first attempt rejects on a microtask; abort while the default sleep (≥ 1 s) is pending
    await new Promise((r) => setTimeout(r, 20));
    ctl.abort();
    const o = await pending;
    assert.deepStrictEqual([calls, !o.ok && o.kind, !o.ok && o.error.code], [1, 'cancelled', 'JC2052']);
    // an injected sleep that rejects is a cancellation too
    const c2 = openHttpClient(shop, { sleep: async () => { throw new Error('no'); }, fetch: async () => { throw new TypeError('offline'); } });
    const r2 = await c2.invoke('product.save', SAVE);
    assert.strictEqual(!r2.ok && r2.kind, 'cancelled');
  });
});
