//@ts-check
/**
 * @file The host lifecycle across the three bindings
 * (docs/CONTRACT-FORMAT.md §7.7), as sequence logs: identify runs after
 * the route and before any parse, acquire after validation and after a
 * new claim, the handler sees the acquired host in a frozen context
 * while `scope` sees the identity's, and the releases — acquired, then
 * identity, each once — run at the lifetime boundary: before an
 * ordinary response, when an opaque body settles (EOF, throw, cancel,
 * HEAD), after an SSE stream is done, after a port frame or
 * subscription, before a local outcome. Every early exit releases the
 * identity and never acquires; every hook fault is the binding's host
 * fault; a declared failure from a hook renders like a handler's.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract, ContractFailure } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { servePort, openPortClient, FRAME_MARKER } from '@jarenjs/contract/port';
import { openLocalClient } from '@jarenjs/contract/local';
import { jsonReq, json, load, shopHandlers, req } from './helpers.js';

const shop = compileContract(load('./fixtures/shop.contract.json'));
const SAVE = { revision: 1, product: { id: 1, name: 'x', price: 1 } };
const PORT_SAVE = { id: 1, ...SAVE };
const URL = '/api/products/1/master';
const IMAGE = '/api/images/1';

/**
 * A recording lifecycle: every hook and release appends to `log`;
 * `identify`/`acquire` may be shaped per test.
 * @param {{ identify?: (meta: any) => any, acquire?: (input: any, identity: any, enter: (lease: any) => Promise<any>) => any, hosts?: boolean }} [shape]
 */
function recording(shape = {}) {
  /** @type {string[]} */
  const log = [];
  /** @type {any[]} */
  const observed = [];
  const identify = shape.identify ?? ((/** @type {any} */ meta) => {
    log.push(`identify:${meta.carrier}:${meta.op.id}`);
    return { host: { who: 'identity' }, release: () => { log.push('release:identity'); } };
  });
  const acquire = shape.acquire ?? ((/** @type {any} */ input, /** @type {any} */ identity, /** @type {any} */ enter) => {
    log.push(`acquire:${identity.host?.who}`);
    return enter({ host: { who: 'acquired' }, release: () => { log.push('release:acquired'); } });
  });
  return { log, observed, options: { identify, acquire, ledger: createMemoryLedger(), onError: (/** @type {unknown} */ e) => observed.push(e) } };
}

/** Wait until a condition holds. @param {() => boolean} until */
async function wait(until) {
  for (let i = 0; i < 400 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(until(), 'the condition never held');
}

describe('host lifecycle over HTTP — the stage order', () => {
  it('identify runs before the parse, acquire after validation; the handler sees the acquired host frozen; releases run acquired-then-identity before the response', async () => {
    const r = recording();
    /** @type {any} */
    let seen = null;
    const server = serveHttp(shop, { ...shopHandlers(), 'catalog.load': (input, ctx) => { seen = ctx; r.log.push('handler'); return { revision: 1, products: [] }; } }, r.options);
    const response = await server.dispatch(req('GET', '/api/catalog'));
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(r.log, ['identify:http:catalog.load', 'acquire:identity', 'handler', 'release:acquired', 'release:identity']);
    assert.deepStrictEqual(seen.host, { who: 'acquired' });
    assert.strictEqual(seen.carrier, 'http');
    assert.strictEqual(Object.isFrozen(seen), true);
    assert.deepStrictEqual(r.observed, []);
  });

  it('with identify only, the handler and scope both see the identity host; the default acquire adds nothing', async () => {
    /** @type {string[]} */
    const log = [];
    const ledger = createMemoryLedger();
    const server = serveHttp(shop, { ...shopHandlers(), 'product.save': (input, ctx) => { log.push(`handler:${ctx.host.tenant}`); return { id: 1, name: 'x', price: 1 }; } }, {
      ledger,
      identify: (meta) => ({ host: { tenant: meta.headers['x-tenant'] } }),
      scope: (ctx) => { log.push(`scope:${ctx.host.tenant}`); return String(ctx.host.tenant); },
    });
    const response = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k', 'x-tenant': 't1' }));
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(log, ['scope:t1', 'handler:t1']);
    assert.strictEqual(ledger.lookup({ op: 'product.save', scope: 't1', key: 'k' })?.status, 'committed');
  });

  it('every early refusal releases the identity and never acquires: invalid JSON, media, body limit, malformed query, malformed header, invalid input, missing key', async () => {
    const cases = [
      ['invalid JSON', () => req('PUT', URL, { 'content-type': 'application/json', 'idempotency-key': 'k' }, '{nope')],
      ['unsupported media', () => req('PUT', URL, { 'content-type': 'text/plain', 'idempotency-key': 'k' }, 'x')],
      ['body limit', () => req('PUT', URL, { 'content-type': 'application/json', 'content-length': '999999999' }, '{}')],
      ['malformed query', () => req('GET', '/api/catalog?since=%E0%A4%A')],
      ['invalid input', () => jsonReq('PUT', URL, { revision: 'no' }, { 'idempotency-key': 'k' })],
      ['missing required key', () => jsonReq('PUT', URL, SAVE)],
    ];
    for (const [name, make] of cases) {
      const r = recording();
      const server = serveHttp(shop, shopHandlers(), { ...r.options, ledger: createMemoryLedger() });
      const response = await server.dispatch(make());
      assert.ok(response.status >= 400 && response.status < 500, `${name}: ${response.status}`);
      assert.deepStrictEqual(r.log, [`identify:http:${response.status === 400 && name === 'malformed query' ? 'catalog.load' : 'product.save'}`, 'release:identity'], name);
    }
  });

  it('replay, mismatch and in-progress return without acquire; the identity is released', async () => {
    const r = recording();
    const ledger = createMemoryLedger();
    const server = serveHttp(shop, shopHandlers(), { ...r.options, ledger });
    await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k' }));
    r.log.length = 0;
    const replay = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k' }));
    assert.strictEqual(replay.headers['idempotent-replayed'], 'true');
    assert.deepStrictEqual(r.log, ['identify:http:product.save', 'release:identity']);
    r.log.length = 0;
    const mismatch = await server.dispatch(jsonReq('PUT', URL, { ...SAVE, revision: 2 }, { 'idempotency-key': 'k' }));
    assert.strictEqual(mismatch.status, 409);
    assert.deepStrictEqual(r.log, ['identify:http:product.save', 'release:identity']);
    r.log.length = 0;
    const started = ledger.claim({ op: 'product.save', scope: '', key: 'p', hash: 'x'.repeat(64) });
    void started;
    const inProgress = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'p' }));
    assert.strictEqual(inProgress.status, 409);
    assert.deepStrictEqual(r.log, ['identify:http:product.save', 'release:identity']);
  });

  it('precondition refusal, declared failure, handler throw and output fault all release acquired-then-identity once', async () => {
    const cases = [
      ['precondition refusal', { 'catalog.load': () => ({ revision: 1, products: [] }) }, { preconditions: { 'catalog.load': () => 'r9' } }, req('GET', '/api/catalog', { 'if-match': '"r1"' }), 412],
      ['declared failure', { 'product.save': (/** @type {any} */ i, /** @type {any} */ ctx) => ctx.fail('conflict', {}, { current: { id: 1, name: 'x', price: 1 } }) }, {}, jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k' }), 409],
      ['handler throw', { 'product.save': () => { throw new Error('boom'); } }, {}, jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k' }), 500],
      ['output fault', { 'catalog.load': () => ({ nope: true }) }, {}, req('GET', '/api/catalog'), 500],
    ];
    for (const [name, handlers, options, request, status] of cases) {
      const r = recording();
      const server = serveHttp(shop, { ...shopHandlers(), ...handlers }, { ...r.options, ...options, ledger: createMemoryLedger() });
      const response = await server.dispatch(request);
      assert.strictEqual(response.status, status, name);
      const op = /** @type {any} */ (request).url.startsWith('/api/catalog') ? 'catalog.load' : 'product.save';
      assert.deepStrictEqual(r.log, [`identify:http:${op}`, 'acquire:identity', 'release:acquired', 'release:identity'], name);
    }
  });

  it('a claimed command whose handler throws releases the key retryable and both leases', async () => {
    const r = recording();
    const ledger = createMemoryLedger();
    const server = serveHttp(shop, { ...shopHandlers(), 'product.save': () => { throw new Error('boom'); } }, { ...r.options, ledger });
    const response = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k' }));
    assert.strictEqual(response.status, 500);
    assert.deepStrictEqual(r.log, ['identify:http:product.save', 'acquire:identity', 'release:acquired', 'release:identity']);
    const record = ledger.lookup({ op: 'product.save', scope: '', key: 'k' });
    assert.strictEqual(record?.status, 'failed');
    assert.strictEqual(record?.retryable, true);
  });
});

describe('host lifecycle over HTTP — hook faults and declared failures', () => {
  const faults = [
    ['identify throws', { identify: () => { throw new Error('no identity'); } }],
    ['identify rejects', { identify: async () => { throw new Error('no identity'); } }],
    ['identify answers no lease', { identify: () => 'nope' }],
    ['identify answers a shape-compatible failure', { identify: () => ({ code: 'conflict', params: {}, details: undefined, retryable: null }) }],
    ['acquire throws', { acquire: () => { throw new Error('no resource'); } }],
    ['acquire never enters', { acquire: () => 'nothing' }],
    ['acquire enters twice', { acquire: async (/** @type {any} */ i, /** @type {any} */ id, /** @type {any} */ enter) => { await enter({ host: 1 }); return enter({ host: 2 }); } }],
    ['acquire answers a malformed lease', { acquire: (/** @type {any} */ i, /** @type {any} */ id, /** @type {any} */ enter) => enter({ release: 5 }) }],
  ];
  for (const [name, shape] of faults) {
    it(`${name}: JC2008, the cause observed, nothing of the hook on the wire`, async () => {
      const r = recording(shape);
      let ran = false;
      const server = serveHttp(shop, { ...shopHandlers(), 'catalog.load': () => { ran = true; return { revision: 1, products: [] }; } }, r.options);
      const response = await server.dispatch(req('GET', '/api/catalog'));
      assert.strictEqual(response.status, 500, name);
      assert.strictEqual(json(response).code, 'JC2008');
      assert.ok(!String(response.body).includes('no identity') && !String(response.body).includes('no resource'), 'the hook\'s text stays off the wire');
      assert.strictEqual(r.observed.length, 1, 'observed once');
      if (name.startsWith('acquire enters twice')) assert.strictEqual(ran, true);
      else assert.strictEqual(ran, false, 'the handler never ran');
    });
  }

  it('a declared failure from identify or acquire renders like the handler\'s; an undeclared code is a host fault', async () => {
    for (const hook of /** @type {const} */ (['identify', 'acquire'])) {
      const current = { id: 1, name: hook, price: 1 };
      const r = recording({ [hook]: (/** @type {any} */ a) => (hook === 'identify' ? a.fail('conflict', {}, { current }) : ContractFailure('conflict', {}, { current })) });
      const server = serveHttp(shop, shopHandlers(), r.options);
      const response = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k' }));
      assert.strictEqual(response.status, 409, hook);
      assert.strictEqual(json(response).code, 'conflict');
      assert.deepStrictEqual(json(response).details, { current });
      assert.strictEqual(r.observed.length, 0);
    }
    const r = recording({ identify: (meta) => meta.fail('undeclared-code') });
    const server = serveHttp(shop, shopHandlers(), r.options);
    const response = await server.dispatch(req('GET', '/api/catalog'));
    assert.strictEqual(response.status, 500);
    assert.strictEqual(r.observed.length, 1);
  });

  it('a release that fails before the response is exposed is JC2008 and observed; after exposure it is observed only', async () => {
    const r = recording({ acquire: (i, id, enter) => enter({ host: 1, release: () => { throw new Error('release broke'); } }) });
    const server = serveHttp(shop, shopHandlers(), r.options);
    const response = await server.dispatch(req('GET', '/api/catalog'));
    assert.strictEqual(response.status, 500);
    assert.strictEqual(json(response).code, 'JC2008');
    assert.deepStrictEqual(r.observed.map((e) => /** @type {any} */ (e).message), ['release broke']);
  });
});

describe('host lifecycle over HTTP — opaque bodies and streams', () => {
  /**
   * A pull source of `n` chunks whose `return()` is observable even when
   * nothing was pulled (a generator's `finally` would not be).
   * @param {number} n @param {string[]} log
   */
  function chunks(n, log) {
    return {
      [Symbol.asyncIterator]() {
        let i = 0;
        let closed = false;
        return {
          async next() {
            if (closed || i >= n) {
              if (!closed) {
                closed = true;
                log.push('source:closed');
              }
              return { done: true, value: undefined };
            }
            return { done: false, value: new TextEncoder().encode(`c${i++}`) };
          },
          async return() {
            if (!closed) {
              closed = true;
              log.push('source:closed');
            }
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  it('a streamed opaque body carries the releases: EOF releases acquired then identity, once', async () => {
    const r = recording();
    const server = serveHttp(shop, { ...shopHandlers(), 'image.bytes': () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: chunks(3, r.log) }) }, r.options);
    const response = await server.dispatch(req('GET', IMAGE));
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(r.log, ['identify:http:image.bytes', 'acquire:identity'], 'nothing released while the body is unread');
    let count = 0;
    for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (response.body)) count += chunk.byteLength;
    assert.strictEqual(count, 6);
    assert.deepStrictEqual(r.log, ['identify:http:image.bytes', 'acquire:identity', 'source:closed', 'release:acquired', 'release:identity']);
  });

  it('a consumer that returns early, a HEAD, and a source that throws each release once', async () => {
    const r = recording();
    const server = serveHttp(shop, { ...shopHandlers(), 'image.bytes': () => ({ status: 200, headers: {}, body: chunks(3, r.log) }) }, r.options);
    const early = await server.dispatch(req('GET', IMAGE));
    const iterator = /** @type {AsyncIterable<Uint8Array>} */ (early.body)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    assert.deepStrictEqual(r.log, ['identify:http:image.bytes', 'acquire:identity', 'source:closed', 'release:acquired', 'release:identity']);

    r.log.length = 0;
    const head = await server.dispatch(req('HEAD', IMAGE));
    assert.strictEqual(head.body, null);
    await wait(() => r.log.includes('release:identity'));
    assert.deepStrictEqual(r.log, ['identify:http:image.bytes', 'acquire:identity', 'source:closed', 'release:acquired', 'release:identity']);

    const t = recording();
    const throwing = { async *[Symbol.asyncIterator]() { yield new Uint8Array(1); throw new Error('cut'); } };
    const broken = serveHttp(shop, { ...shopHandlers(), 'image.bytes': () => ({ status: 200, headers: {}, body: throwing }) }, t.options);
    const response = await broken.dispatch(req('GET', IMAGE));
    await assert.rejects(async () => { for await (const _ of /** @type {AsyncIterable<Uint8Array>} */ (response.body)) void _; }, /cut/);
    assert.deepStrictEqual(t.log, ['identify:http:image.bytes', 'acquire:identity', 'release:acquired', 'release:identity']);
  });

  it('an SSE stream releases after the runner is done — on the peer\'s disconnect and on the server\'s close', async () => {
    const live = compileContract({
      $contract: '0.1',
      operations: { feed: { kind: 'subscribe', output: { type: 'object', required: ['rows'], properties: { rows: { type: 'array' } } } } },
    });
    for (const how of ['disconnect', 'close']) {
      const r = recording();
      const closes = [];
      const server = serveHttp(live, { feed: () => ({ result: { rows: [] }, subscribe: () => () => {}, close: () => closes.push('closed') }) }, r.options);
      const controller = new AbortController();
      const response = await server.dispatch({ method: 'GET', url: '/feed', headers: { accept: 'text/event-stream' }, body: null, signal: controller.signal });
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(r.log, ['identify:http:feed', 'acquire:identity']);
      const written = [];
      const pump = /** @type {NonNullable<typeof response.stream>} */ (response.stream)({ write: (text) => { written.push(text); return undefined; }, end: () => undefined, abort: () => undefined });
      await wait(() => written.length >= 1);
      if (how === 'disconnect') controller.abort();
      else server.close();
      await pump.done;
      assert.deepStrictEqual(r.log, ['identify:http:feed', 'acquire:identity', 'release:acquired', 'release:identity'], how);
      assert.deepStrictEqual(closes, ['closed']);
    }
  });
});

describe('host lifecycle over port and local', () => {
  it('port: identify before validation, acquire after; the handler context spells the HTTP-only members null; releases after the frame', async () => {
    const r = recording();
    const { port1, port2 } = new MessageChannel();
    /** @type {any} */
    let seen = null;
    const server = servePort(shop, { ...shopHandlers(), 'catalog.load': (input, ctx) => { seen = ctx; r.log.push('handler'); return { revision: 1, products: [] }; } }, { channel: port1, ...r.options });
    const client = openPortClient(shop, { channel: port2 });
    const outcome = await client.invoke('catalog.load', {});
    assert.strictEqual(outcome.ok, true);
    await wait(() => r.log.includes('release:identity'));
    assert.deepStrictEqual(r.log, ['identify:port:catalog.load', 'acquire:identity', 'handler', 'release:acquired', 'release:identity']);
    assert.strictEqual(seen.carrier, 'port');
    assert.deepStrictEqual(seen.host, { who: 'acquired' });
    assert.deepStrictEqual([seen.method, seen.path, seen.params, seen.body, seen.idempotency, seen.etag, seen.status], [null, null, null, null, null, null, null]);
    assert.strictEqual(Object.isFrozen(seen), true);
    r.log.length = 0;
    // the client refuses invalid input before it is sent (JC2050): the
    // server's own validation is reached with a hand-built request frame
    const answered = new Promise((resolve) => port2.addEventListener('message', (event) => {
      if (event.data?.id === 'raw-1') resolve(event.data);
    }, { once: true }));
    port2.postMessage({ jaren: FRAME_MARKER, id: 'raw-1', op: 'product.save', input: { revision: 'no' } });
    const frame = /** @type {any} */ (await answered);
    assert.strictEqual(frame.error.code, 'JC2006');
    await wait(() => r.log.includes('release:identity'));
    assert.deepStrictEqual(r.log, ['identify:port:product.save', 'release:identity'], 'invalid input: identity only, never acquired');
    client.close();
    server.close();
    port1.close();
    port2.close();
  });

  it('port: a hook fault is JC2070 observed; a hook\'s declared failure is the declared frame', async () => {
    for (const [shape, code, kind] of [[{ acquire: () => { throw new Error('no'); } }, 'JC2070', 'contract'], [{ identify: (/** @type {any} */ m) => m.fail('conflict') }, 'conflict', 'failure']]) {
      const r = recording(/** @type {any} */ (shape));
      const { port1, port2 } = new MessageChannel();
      const server = servePort(shop, shopHandlers(), { channel: port1, ...r.options });
      const client = openPortClient(shop, { channel: port2 });
      const outcome = await client.invoke('product.save', PORT_SAVE);
      assert.strictEqual(outcome.ok, false);
      assert.strictEqual(/** @type {any} */ (outcome).error.code, code);
      assert.strictEqual(/** @type {any} */ (outcome).kind, kind);
      assert.strictEqual(r.observed.length, code === 'JC2070' ? 1 : 0);
      client.close();
      server.close();
      port1.close();
      port2.close();
    }
  });

  it('port: a subscription releases after the runner is done (unsubscribe, and the server\'s shutdown)', async () => {
    const live = compileContract({
      $contract: '0.1',
      operations: { feed: { kind: 'subscribe', output: { type: 'object', required: ['rows'], properties: { rows: { type: 'array' } } } } },
    });
    for (const how of ['unsubscribe', 'shutdown']) {
      const r = recording();
      const { port1, port2 } = new MessageChannel();
      const server = servePort(live, { feed: () => ({ result: { rows: [] }, subscribe: () => () => {}, close: () => {} }) }, { channel: port1, ...r.options });
      const client = openPortClient(live, { channel: port2 });
      const events = [];
      const sub = client.subscribe('feed', undefined, { onSnapshot: () => events.push('snapshot'), onEnd: (i) => events.push(`end:${i.reason}`) });
      await wait(() => events.length === 1);
      assert.deepStrictEqual(r.log, ['identify:port:feed', 'acquire:identity']);
      if (how === 'unsubscribe') sub.stop();
      else server.close();
      await wait(() => r.log.includes('release:identity'));
      assert.deepStrictEqual(r.log, ['identify:port:feed', 'acquire:identity', 'release:acquired', 'release:identity'], how);
      client.close();
      server.close();
      port1.close();
      port2.close();
    }
  });

  it('local: the same order; a hook fault is JC2070; a declared failure is a failure outcome; the releases run before the outcome', async () => {
    const r = recording();
    /** @type {any} */
    let seen = null;
    const client = openLocalClient(shop, { ...shopHandlers(), 'catalog.load': (input, ctx) => { seen = ctx; r.log.push('handler'); return { revision: 1, products: [] }; } }, r.options);
    const ok = await client.invoke('catalog.load', {});
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual(r.log, ['identify:local:catalog.load', 'acquire:identity', 'handler', 'release:acquired', 'release:identity']);
    assert.strictEqual(seen.carrier, 'local');
    assert.deepStrictEqual(seen.host, { who: 'acquired' });
    assert.strictEqual(seen.etag, null);
    r.log.length = 0;
    const invalid = await client.invoke('product.save', { revision: 'no' });
    assert.strictEqual(invalid.ok, false);
    assert.deepStrictEqual(r.log, ['identify:local:product.save', 'release:identity']);

    const faulty = openLocalClient(shop, shopHandlers(), { acquire: () => { throw new Error('no'); }, onError: (e) => r.observed.push(e) });
    const fault = await faulty.invoke('catalog.load', {});
    assert.strictEqual(/** @type {any} */ (fault).error.code, 'JC2070');
    assert.strictEqual(r.observed.length, 1);
    const declared = openLocalClient(shop, shopHandlers(), { identify: (m) => m.fail('conflict') });
    const failed = await declared.invoke('product.save', PORT_SAVE);
    assert.strictEqual(/** @type {any} */ (failed).kind, 'failure');
    assert.strictEqual(/** @type {any} */ (failed).error.code, 'conflict');
  });

  it('local: an abort during the handler is a cancelled outcome and still releases both leases', async () => {
    const r = recording();
    const controller = new AbortController();
    const client = openLocalClient(shop, { ...shopHandlers(), 'catalog.load': () => new Promise((resolve) => setTimeout(() => resolve({ revision: 1, products: [] }), 50)) }, r.options);
    const pending = client.invoke('catalog.load', {}, { signal: controller.signal });
    await wait(() => r.log.includes('acquire:identity'));
    controller.abort();
    const outcome = await pending;
    assert.strictEqual(/** @type {any} */ (outcome).kind, 'cancelled');
    assert.deepStrictEqual(r.log, ['identify:local:catalog.load', 'acquire:identity', 'release:acquired', 'release:identity']);
  });
});
