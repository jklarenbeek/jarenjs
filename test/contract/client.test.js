//@ts-check
/**
 * @file `openHttpClient` against a real `serveHttp` dispatcher through
 * `toFetchHandler` (no socket): the happy read with query coercion
 * round-tripping, the happy command (path + body + key), each failure
 * kind, `AbortError` → cancelled, the timeout → network, the opaque
 * `url()`, the identity trinity (attempt never read from a header, trace
 * from `x-jaren-trace`), headers, `close()`, and the host errors
 * (`JC1005`, `JC1008`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import http from 'node:http';
import { once } from 'node:events';

import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { toFetchHandler } from '@jarenjs/contract/fetch';
import { toNodeHandler } from '@jarenjs/contract/node';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { openHttpClient } from '@jarenjs/contract/client';
import { load, shopHandlers } from './helpers.js';

const shop = compileContract(load('./fixtures/shop.contract.json'));
const PRODUCT = { id: 1, name: 'x', price: 1 };

/**
 * A client over an in-process server: `fetch` is the fetch adapter, and
 * every request/response is recorded.
 * @param {Record<string, any>} [handlers]
 * @param {any} [serveOptions]
 * @param {any} [clientOptions]
 */
function pair(handlers = {}, serveOptions = {}, clientOptions = {}) {
  const server = serveHttp(shop, { ...shopHandlers(), ...handlers }, { ledger: createMemoryLedger(), ...serveOptions });
  const handler = toFetchHandler(server);
  /** @type {{ url: string, init: any }[]} */
  const sent = [];
  /** @type {Response[]} */
  const received = [];
  const client = openHttpClient(shop, {
    baseUrl: 'http://shop.test',
    fetch: async (url, init) => {
      sent.push({ url, init });
      const response = await handler(new Request(url, init));
      received.push(response);
      return response;
    },
    ...clientOptions,
  });
  return { server, client, sent, received };
}

describe('openHttpClient — happy paths through the fetch adapter', () => {
  it('a read: query members travel as strings, the server coerces them, the output validates, meta carries the trace and the etag', async () => {
    /** @type {any} */
    let seen;
    const { client, sent, received } = pair({ 'product.search': (input, ctx) => { seen = { input, params: ctx.params }; ctx.etag('s1'); return [PRODUCT]; } });
    const o = await client.invoke('product.search', { q: 'a b', limit: 5, tag: ['x', 'y'], flag: true }, { attempt: 3 });
    assert.strictEqual(sent[0].url, 'http://shop.test/api/products?q=a+b&limit=5&tag=x&tag=y&flag=true');
    assert.strictEqual(sent[0].init.method, 'GET');
    assert.strictEqual(sent[0].init.body, undefined, 'a read sends no body');
    assert.strictEqual(sent[0].init.headers['content-type'], undefined);
    assert.deepStrictEqual(seen.input, { q: 'a b', limit: 5, tag: ['x', 'y'], flag: true }, 'the server saw typed values after coercion');
    assert.deepStrictEqual(o, {
      ok: true, value: [PRODUCT],
      meta: { op: 'product.search', attempt: 3, trace: received[0].headers.get('x-jaren-trace'), revision: null, etag: 'W/"s1"', notModified: false },
    });
    // an input-less read and a null input
    const { client: c2 } = pair();
    assert.strictEqual((await c2.invoke('catalog.load')).ok, true);
    assert.strictEqual((await c2.invoke('catalog.load', null)).ok, true);
    // null/undefined query members are omitted, a date-time string round-trips as a string
    const { client: c3, sent: s3 } = pair({ 'catalog.load': (input) => ({ revision: 1, products: [], since: input.since }) });
    const r3 = await c3.invoke('catalog.load', { since: '2026-01-02T03:04:05Z' });
    assert.strictEqual(s3[0].url, 'http://shop.test/api/catalog?since=2026-01-02T03%3A04%3A05Z');
    assert.strictEqual(r3.ok, true);
    if (r3.ok) assert.strictEqual(/** @type {any} */ (r3.value).since, '2026-01-02T03:04:05Z', 'the validator saw a string; the server returned it');
  });

  it('a command: path variable encoded into the template, the body members as a JSON object, an Idempotency-Key generated, 2xx validated', async () => {
    /** @type {any} */
    let seen;
    const { client, sent } = pair({ 'product.save': (input, ctx) => { seen = { input, key: ctx.idempotency?.key }; return { id: input.id, name: input.product.name, price: 2 }; } },
      {}, { keys: () => 'key-1' });
    const o = await client.invoke('product.save', { id: 12, revision: 4, product: PRODUCT });
    assert.strictEqual(sent[0].url, 'http://shop.test/api/products/12/master');
    assert.strictEqual(sent[0].init.method, 'PUT');
    assert.strictEqual(sent[0].init.headers['content-type'], 'application/json');
    assert.strictEqual(sent[0].init.headers['idempotency-key'], 'key-1');
    assert.deepStrictEqual(JSON.parse(sent[0].init.body), { revision: 4, product: PRODUCT }, 'the body is the object of body-located members only');
    assert.deepStrictEqual(seen, { input: { id: 12, revision: 4, product: PRODUCT }, key: 'key-1' });
    assert.strictEqual(o.ok, true);
    if (o.ok) assert.deepStrictEqual(o.value, { id: 12, name: 'x', price: 2 });
    // a path variable with reserved characters is percent-encoded per segment
    const { client: c2, sent: s2 } = pair();
    await c2.invoke('image.bytes', { id: 1 }).catch(() => null);
    assert.strictEqual(s2.length, 0, 'an opaque op is never invoked');
    assert.strictEqual(c2.url('product.save', { id: 7 }), 'http://shop.test/api/products/7/master');
    // the canonical POST /<id> binding with a whole-object body; a 204 with output true is a null value
    const { client: c3, sent: s3 } = pair({ 'product.remove': (i, ctx) => { ctx.status(204); return true; } });
    const r3 = await c3.invoke('product.remove', { id: 5 });
    assert.strictEqual(s3[0].url, 'http://shop.test/product.remove');
    assert.strictEqual(s3[0].init.method, 'POST');
    assert.deepStrictEqual(r3.ok ? r3.value : r3, null);
    // a whole-body member (http.body) and a header member
    const contract = compileContract({
      $contract: '0.1',
      operations: { 'doc.put': {
        kind: 'command', output: true,
        input: { type: 'object', required: ['id', 'doc'], properties: { id: { type: 'string' }, doc: { type: 'array', items: { type: 'object' } }, dry: { type: 'boolean' }, 'x-tenant': { type: 'string' }, 'x-tags': { type: 'array', items: { type: 'string' } } } },
        http: { method: 'PUT', path: '/docs/{id}', body: 'doc', in: { dry: 'query', 'x-tenant': 'header', 'x-tags': 'header' } },
      } },
    });
    /** @type {any} */
    let got;
    const server = serveHttp(contract, { 'doc.put': (input, ctx) => { got = { input, headers: ctx.headers }; return null; } });
    const h = toFetchHandler(server);
    /** @type {any[]} */
    const sent4 = [];
    const c4 = openHttpClient(contract, { fetch: (url, init) => { sent4.push({ url, init }); return h(new Request('http://x' + url, init)); } });
    const r4 = await c4.invoke('doc.put', { id: 'a b', doc: [{ x: 1 }], dry: true, 'x-tenant': 't1', 'x-tags': ['p', 'q'] });
    assert.strictEqual(r4.ok, true, JSON.stringify(r4));
    assert.strictEqual(sent4[0].url, '/docs/a%20b?dry=true', 'a relative URL when baseUrl is empty');
    assert.strictEqual(sent4[0].init.body, '[{"x":1}]', 'http.body: the member value IS the body');
    assert.strictEqual(sent4[0].init.headers['x-tenant'], 't1');
    assert.strictEqual(sent4[0].init.headers['x-tags'], 'p, q');
    assert.deepStrictEqual(got.input, { id: 'a b', doc: [{ x: 1 }], dry: true, 'x-tenant': 't1', 'x-tags': ['p', 'q'] });
  });

  it('304 through If-None-Match is ok null with notModified; If-Match reaches the server', async () => {
    const { client } = pair({ 'catalog.load': (input, ctx) => { ctx.etag('r9'); return { revision: 9, products: [] }; } });
    const first = await client.invoke('catalog.load');
    assert.strictEqual(first.ok && first.meta.etag, 'W/"r9"');
    const again = await client.invoke('catalog.load', {}, { ifNoneMatch: 'W/"r9"' });
    assert.deepStrictEqual(again.ok ? [again.value, again.meta.notModified, again.meta.etag] : again, [null, true, 'W/"r9"']);
    // If-Match mismatch on a command is a 412 JC2014 → failure
    const { client: c2 } = pair({ 'product.save': (input, ctx) => { ctx.etag('v1', { strong: true }); return PRODUCT; } });
    const r = await c2.invoke('product.save', { id: 1, revision: 1, product: PRODUCT }, { ifMatch: '"v0"' });
    assert.strictEqual(r.ok, false);
    if (!r.ok) assert.deepStrictEqual([r.kind, r.error.code, r.error.status], ['failure', 'JC2014', 412]);
  });

  it('url() builds the URL of any operation, opaque included, validating only path/query members', () => {
    const { client } = pair();
    assert.strictEqual(client.url('image.bytes', { id: 3 }), 'http://shop.test/api/images/3');
    assert.strictEqual(client.url('product.search', { q: 'x y', tag: ['a'] }), 'http://shop.test/api/products?q=x+y&tag=a');
    assert.strictEqual(client.url('product.search'), 'http://shop.test/api/products');
    assert.strictEqual(client.url('catalog.load', null), 'http://shop.test/api/catalog');
    assert.strictEqual(client.url('product.save', { id: 2 }), 'http://shop.test/api/products/2/master', 'body members are not required by url()');
    assert.throws(() => client.url('image.bytes', { id: 'x' }), (/** @type {any} */ e) => e.code === 'JC1008' && /fail their schema/.test(e.message));
    assert.throws(() => client.url('image.bytes', {}), (/** @type {any} */ e) => e.code === 'JC1008', 'a required path member is required');
    assert.throws(() => client.url('image.bytes', 'nope'), (/** @type {any} */ e) => e.code === 'JC1008');
    assert.throws(() => client.url('nope', {}), (/** @type {any} */ e) => e.code === 'JC1005');
    // a member $ref resolves against the document for the url() check too
    const contract = compileContract({ $contract: '0.1', $defs: { Id: { type: 'integer', minimum: 1 } }, operations: {
      a: { kind: 'read', output: true, input: { type: 'object', required: ['id'], properties: { id: { $ref: '#/$defs/Id' } } }, http: { method: 'GET', path: '/a/{id}' } } } });
    const c = openHttpClient(contract);
    assert.strictEqual(c.url('a', { id: 4 }), '/a/4');
    assert.throws(() => c.url('a', { id: 0 }), (/** @type {any} */ e) => e.code === 'JC1008');
  });
});

describe('openHttpClient — every failure kind, and the assembly rows that need a transport', () => {
  it('invalid input is JC2050 and nothing is sent', async () => {
    const { client, sent } = pair();
    const o = await client.invoke('product.save', { id: 'x' }, { attempt: 'a1' });
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(o.ok, false);
    if (o.ok) return;
    assert.deepStrictEqual([o.kind, o.error.code, o.error.status, o.error.retryable], ['contract', 'JC2050', null, false]);
    assert.ok(Array.isArray(o.error.details) && o.error.details.some((/** @type {any} */ d) => d.path === '/id' && d.keyword === 'type'));
    assert.deepStrictEqual(o.meta, { op: 'product.save', attempt: 'a1', trace: null, revision: null, etag: null, notModified: false });
    // an input-less operation refuses a non-null input
    const contract = compileContract({ $contract: '0.1', operations: { ping: { kind: 'read', output: true } } });
    const c = openHttpClient(contract, { fetch: async () => new Response('true', { status: 200 }) });
    const refused = await c.invoke('ping', { x: 1 });
    if (!refused.ok) assert.deepStrictEqual([refused.error.code, refused.error.details], ['JC2050', [{ path: '', keyword: 'input' }]]);
    assert.strictEqual((await c.invoke('ping')).ok, true);
    // a value the URL cannot carry (a lone surrogate in a path member) is JC2050 with keyword encoding
    // (a query member's lone surrogate is replaced by URLSearchParams and travels as U+FFFD)
    const byName = compileContract({ $contract: '0.1', operations: { a: { kind: 'read', output: true,
      input: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } }, http: { method: 'GET', path: '/a/{name}' } } } });
    let calls = 0;
    const c2 = openHttpClient(byName, { fetch: async () => { calls++; return new Response('true'); } });
    const enc = await c2.invoke('a', { name: '\uD800' });
    assert.strictEqual(calls, 0);
    if (!enc.ok) assert.deepStrictEqual([enc.error.code, enc.error.details], ['JC2050', [{ path: '', keyword: 'encoding' }]]);
  });

  it('a declared failure from the server is kind failure with status, details and message from the wire', async () => {
    const { client, received } = pair({ 'product.save': (input, ctx) => ctx.fail('conflict', {}, { current: PRODUCT }) });
    const o = await client.invoke('product.save', { id: 1, revision: 1, product: PRODUCT });
    assert.strictEqual(o.ok, false);
    if (o.ok) return;
    assert.strictEqual(o.kind, 'failure');
    assert.deepStrictEqual(o.error, { code: 'conflict', message: 'operation product.save failed with conflict', status: 409, details: { current: PRODUCT }, retryable: false });
    assert.strictEqual(o.meta.trace, received[0].headers.get('x-jaren-trace'));
    // a taxonomy error (the server's 404 for a wrong path shape is not reachable through invoke; a 500 is)
    const { client: c2 } = pair({ 'catalog.load': () => { throw new Error('boom'); } }, { onError: () => {} });
    const r2 = await c2.invoke('catalog.load');
    if (!r2.ok) assert.deepStrictEqual([r2.kind, r2.error.code, r2.error.status, r2.error.retryable], ['failure', 'JC2008', 500, false]);
    // the server's output violation (JC2010) is a failure too — the server told us so in the contract's own words
    const { client: c3 } = pair({ 'catalog.load': () => ({ nope: true }) }, { onError: () => {} });
    const r3 = await c3.invoke('catalog.load');
    if (!r3.ok) assert.deepStrictEqual([r3.kind, r3.error.code, r3.error.status], ['failure', 'JC2010', 500]);
  });

  it('an invalid success body is JC2053 (the server skipped output validation)', async () => {
    const { client } = pair({ 'catalog.load': () => ({ nope: true }) }, { validateOutput: 'never' });
    const o = await client.invoke('catalog.load');
    assert.strictEqual(o.ok, false);
    if (!o.ok) assert.deepStrictEqual([o.kind, o.error.code, o.error.status], ['contract', 'JC2053', 200]);
  });

  it('an undeclared response is JC2055 with the status kept', async () => {
    const { client } = pair({}, { errorBody: (wire) => ({ error: wire.message }) });
    const o = await client.invoke('product.save', { id: 1, revision: 1, product: PRODUCT }, { headers: { 'content-type': 'text/plain' } });
    // the per-call header is overridden by the client's own content-type, so the request is well-formed; force an error through a legacy body shape instead
    assert.strictEqual(o.ok, true, 'protocol headers the client owns win over per-call ones');
    const { client: c2 } = pair({ 'product.save': (input, ctx) => ctx.fail('conflict') }, { errorBody: (wire) => ({ error: wire.code }) });
    const r2 = await c2.invoke('product.save', { id: 1, revision: 1, product: PRODUCT });
    assert.strictEqual(r2.ok, false);
    if (!r2.ok) assert.deepStrictEqual([r2.kind, r2.error.code, r2.error.status, r2.error.retryable], ['contract', 'JC2055', 409, false]);
    // a non-JSON 502 from something in front of the server
    const c3 = openHttpClient(shop, { fetch: async () => new Response('<html>bad gateway</html>', { status: 502 }) });
    const r3 = await c3.invoke('catalog.load');
    if (!r3.ok) assert.deepStrictEqual([r3.kind, r3.error.code, r3.error.status, r3.error.retryable], ['contract', 'JC2055', 502, true]);
  });

  it('a transport rejection is a network outcome named by the error name only', async () => {
    const client = openHttpClient(shop, { fetch: async () => { throw new TypeError('fetch failed: https://user:secret@host/path'); } });
    const o = await client.invoke('catalog.load', {}, { attempt: 9 });
    assert.strictEqual(o.ok, false);
    if (o.ok) return;
    assert.strictEqual(o.kind, 'network');
    assert.deepStrictEqual(o.error, { code: 'JC2051', message: 'the request of catalog.load did not complete (TypeError)', status: null, details: null, retryable: true });
    assert.doesNotMatch(o.error.message, /secret/);
    assert.deepStrictEqual(o.meta, { op: 'catalog.load', attempt: 9, trace: null, revision: null, etag: null, notModified: false });
    // a rejection value without a name
    const c2 = openHttpClient(shop, { fetch: async () => { throw 'down'; } });
    const r2 = await c2.invoke('catalog.load');
    if (!r2.ok) assert.match(r2.error.message, /\(string\)$/);
    // a body that cannot be read is a network outcome too
    const c3 = openHttpClient(shop, { fetch: async () => ({ status: 200, headers: new Headers(), text: async () => { throw new Error('socket hang up'); } }) });
    const r3 = await c3.invoke('catalog.load');
    if (!r3.ok) assert.deepStrictEqual([r3.kind, r3.error.code], ['network', 'JC2051']);
    // the per-request timeout is a network outcome, not a cancellation
    const c4 = openHttpClient(shop, { timeoutMs: 5, fetch: (url, init) => new Promise((resolve, reject) => { init.signal?.addEventListener('abort', () => reject(init.signal.reason)); }) });
    const r4 = await c4.invoke('catalog.load');
    if (!r4.ok) assert.deepStrictEqual([r4.kind, r4.error.code, r4.error.retryable], ['network', 'JC2051', true]);
    if (!r4.ok) assert.match(r4.error.message, /TimeoutError/);
  });

  it('an abort is a cancelled outcome', async () => {
    const controller = new AbortController();
    let aborted = false;
    const client = openHttpClient(shop, { fetch: (url, init) => new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => { aborted = true; reject(init.signal.reason); });
    }) });
    const pending = client.invoke('catalog.load', {}, { signal: controller.signal, attempt: 2 });
    controller.abort();
    const o = await pending;
    assert.strictEqual(aborted, true, 'the composed signal reached fetch');
    assert.strictEqual(o.ok, false);
    if (o.ok) return;
    assert.strictEqual(o.kind, 'cancelled');
    assert.deepStrictEqual(o.error, { code: 'JC2052', message: 'the request of operation catalog.load was cancelled', status: null, details: null, retryable: false });
    assert.strictEqual(o.meta.attempt, 2);
    // an already-aborted signal never reaches fetch
    let calls = 0;
    const c2 = openHttpClient(shop, { fetch: async () => { calls++; return new Response('{}'); } });
    const pre = new AbortController();
    pre.abort();
    const r2 = await c2.invoke('catalog.load', {}, { signal: pre.signal });
    assert.deepStrictEqual([calls, r2.ok, !r2.ok && r2.kind], [0, false, 'cancelled']);
    // a fetch that rejects with an AbortError-named value without our signal aborting is cancelled too
    const c3 = openHttpClient(shop, { fetch: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); } });
    const r3 = await c3.invoke('catalog.load');
    assert.strictEqual(!r3.ok && r3.kind, 'cancelled');
    // a custom abort reason (not an AbortError) with the caller's signal aborted is still a cancellation
    const c4 = openHttpClient(shop, { fetch: (url, init) => new Promise((resolve, reject) => { init.signal?.addEventListener('abort', () => reject(init.signal.reason)); }) });
    const ctl = new AbortController();
    const p4 = c4.invoke('catalog.load', {}, { signal: ctl.signal });
    ctl.abort('user navigated away');
    assert.strictEqual(!(await p4).ok && /** @type {any} */ (await p4).kind, 'cancelled');
    // close(): in-flight requests are cancelled and later invokes resolve cancelled without a fetch
    let n = 0;
    const c5 = openHttpClient(shop, { fetch: (url, init) => new Promise((resolve, reject) => { n++; init.signal?.addEventListener('abort', () => reject(init.signal.reason)); }) });
    const inflight = c5.invoke('catalog.load');
    c5.close();
    assert.strictEqual(!(await inflight).ok && /** @type {any} */ (await inflight).kind, 'cancelled');
    const after = await c5.invoke('catalog.load');
    assert.deepStrictEqual([n, !after.ok && after.kind], [1, 'cancelled']);
  });
});

describe('openHttpClient — the identity trinity and the headers', () => {
  it('meta.attempt is the caller\'s and never a response header; meta.trace is x-jaren-trace; the key is the client\'s', async () => {
    const client = openHttpClient(shop, { fetch: async () => new Response(JSON.stringify({ revision: 1, products: [] }), {
      status: 200, headers: { 'x-jaren-trace': 'server-trace', 'x-jaren-attempt': '999', 'x-attempt': '999', 'idempotency-key': 'server-key' } }) });
    const o = await client.invoke('catalog.load', {}, { attempt: 1 });
    assert.strictEqual(o.ok, true);
    if (o.ok) assert.deepStrictEqual([o.meta.attempt, o.meta.trace], [1, 'server-trace']);
    const none = await client.invoke('catalog.load');
    if (none.ok) assert.strictEqual(none.meta.attempt, null, 'no attempt given → null, never the header');
    // the client never sends a trace or an attempt; the server's trace is per request
    const { client: c2, sent, received } = pair({}, {}, { headers: { 'x-jaren-trace': 'spoofed', authorization: 'Bearer t' } });
    const a = await c2.invoke('catalog.load', {}, { attempt: 5 });
    const b = await c2.invoke('catalog.load', {}, { attempt: 5 });
    assert.strictEqual(sent[0].init.headers.authorization, 'Bearer t', 'static headers are sent');
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) {
      assert.notStrictEqual(a.meta.trace, b.meta.trace, 'the trace is the server\'s, per request — a spoofed x-jaren-trace is ignored server-side');
      assert.strictEqual(a.meta.trace, received[0].headers.get('x-jaren-trace'));
    }
    // a duplicated attempt id does not cross-settle: each outcome carries its own server trace
    assert.notStrictEqual(received[0].headers.get('x-jaren-trace'), received[1].headers.get('x-jaren-trace'));
  });

  it('static headers merge under per-call ones; the client\'s protocol headers win; the catalog option renders client messages', async () => {
    const { client, sent } = pair({}, {}, { headers: { 'X-Static': 's', 'x-both': 'static' }, catalog: { 'contract/client-invalid-input': 'nope: {op}' } });
    await client.invoke('catalog.load', {}, { headers: { 'X-Both': 'call', 'x-call': 'c' } });
    assert.deepStrictEqual([sent[0].init.headers['x-static'], sent[0].init.headers['x-both'], sent[0].init.headers['x-call']], ['s', 'call', 'c']);
    const bad = await client.invoke('product.save', {});
    if (!bad.ok) assert.strictEqual(bad.error.message, 'nope: product.save');
    // capabilities and the rest of the surface
    assert.deepStrictEqual(client.capabilities, { name: 'http', status: true, headers: true, media: true, etag: true, idempotency: true, durableKeys: false, stream: true, cancel: 'signal' });
    assert.strictEqual(Object.isFrozen(client.capabilities), true);
    assert.strictEqual(client.contract, shop);
    assert.strictEqual(client.describe().operations.length, 5);
    assert.deepStrictEqual(await client.pending(), []);
  });

  it('host mistakes throw JC1008 at open and JC1005/JC1008 per call', () => {
    assert.throws(() => openHttpClient(/** @type {any} */ ({}), {}), (/** @type {any} */ e) => e.code === 'JC1008' && e instanceof TypeError);
    assert.throws(() => openHttpClient(shop, { fetch: /** @type {any} */ ('x') }), (/** @type {any} */ e) => e.code === 'JC1008');
    assert.throws(() => openHttpClient(shop, { timeoutMs: -1 }), (/** @type {any} */ e) => e.code === 'JC1008');
    assert.throws(() => openHttpClient(shop, { baseUrl: /** @type {any} */ (1) }), (/** @type {any} */ e) => e.code === 'JC1008');
    assert.throws(() => openHttpClient(shop, { storage: /** @type {any} */ ({ read() {} }) }), (/** @type {any} */ e) => e.code === 'JC1008');
    assert.throws(() => openHttpClient(shop, { headers: { a: /** @type {any} */ (1) } }), (/** @type {any} */ e) => e.code === 'JC1008');
    assert.throws(() => openHttpClient(shop, { wellKnown: 'no-slash' }), (/** @type {any} */ e) => e.code === 'JC1008');
    assert.throws(() => openHttpClient(shop, { catalog: /** @type {any} */ (null) }), (/** @type {any} */ e) => e.code === 'JC1008');
    assert.throws(() => openHttpClient(shop, /** @type {any} */ (null)), (/** @type {any} */ e) => e.code === 'JC1008');
    const client = openHttpClient(shop);
    assert.rejects(client.invoke('catalog.load', {}, /** @type {any} */ (null)), (/** @type {any} */ e) => e.code === 'JC1008');
  });
});

describe('openHttpClient — the platform fetch over a real socket', () => {
  it('with no fetch option the client calls globalThis.fetch: a read, a command with a key, a 304 and negotiate over node:http', async () => {
    const dispatcher = serveHttp(shop, { ...shopHandlers(), 'catalog.load': (input, ctx) => { ctx.etag('sock'); return { revision: 2, products: [PRODUCT] }; } }, { ledger: createMemoryLedger() });
    const server = http.createServer(toNodeHandler(dispatcher));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    const client = openHttpClient(shop, { baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 5000 });
    try {
      const read = await client.invoke('catalog.load', {}, { attempt: 1 });
      assert.strictEqual(read.ok, true, JSON.stringify(read));
      if (read.ok) assert.deepStrictEqual([read.value, read.meta.etag, typeof read.meta.trace], [{ revision: 2, products: [PRODUCT] }, 'W/"sock"', 'string']);
      const again = await client.invoke('catalog.load', {}, { ifNoneMatch: 'W/"sock"' });
      assert.deepStrictEqual(again.ok ? [again.value, again.meta.notModified] : again, [null, true]);
      const saved = await client.invoke('product.save', { id: 4, revision: 1, product: PRODUCT });
      assert.strictEqual(saved.ok, true, JSON.stringify(saved));
      const conflict = await client.invoke('product.save', { id: 4, revision: 1, product: { ...PRODUCT, name: '' } });
      assert.deepStrictEqual(!conflict.ok && [conflict.kind, conflict.error.code], ['contract', 'JC2050'], 'refused before the wire');
      const n = await client.negotiate();
      assert.deepStrictEqual([n.compatible, n.reason, n.server?.id], [true, 'same-version', 'shop']);
      // a closed port is a network outcome through the real transport
      const down = openHttpClient(shop, { baseUrl: 'http://127.0.0.1:1', timeoutMs: 5000 });
      const r = await down.invoke('catalog.load');
      assert.deepStrictEqual(!r.ok && [r.kind, r.error.code], ['network', 'JC2051']);
    }
    finally {
      server.close();
      await once(server, 'close');
    }
  });
});
