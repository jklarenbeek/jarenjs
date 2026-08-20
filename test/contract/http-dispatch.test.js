//@ts-check
/**
 * @file The HTTP server binding's happy paths and construction rules:
 * `serveHttp` refuses host mistakes (`JC1001–JC1003`) and reports its
 * capabilities; `dispatch` routes the shop fixture (query coercion on
 * `catalog.load`/`product.search`, path + body on `product.save`, the
 * canonical binding on `product.remove`), answers HEAD for GET, arms
 * ETags (304, If-Match/412), honors `ctx.status`, passes opaque bytes
 * through, serves the well-known description, and rejects only a
 * malformed request object (`JC1004`); the catalog renders every
 * taxonomy msgid.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileMessageCatalog } from '@jarenjs/core/message';
import {
  compileContract, ContractHostError, ContractRuntimeError, ContractFailure, isContractFailure,
  contractMessagesEn, contractCatalogEn,
} from '@jarenjs/contract';
import { serveHttp, HTTP_ERRORS, WELL_KNOWN_PATH } from '@jarenjs/contract/http';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { CLIENT_ERRORS } from '@jarenjs/contract/client';
import { PORT_LOCAL_ERRORS } from '@jarenjs/contract/port';
import { load, shopHandlers, req, jsonReq, json } from './helpers.js';

const shop = compileContract(load('./fixtures/shop.contract.json'));
const TRACES = /^[0-9a-f-]{36}$/;

/**
 * @param {Record<string, any>} [overrides]
 * @param {any} [options]
 */
function serve(overrides = {}, options = {}) {
  return serveHttp(shop, { ...shopHandlers(), ...overrides }, { ledger: createMemoryLedger(), ...options });
}

describe('serveHttp — construction', () => {
  it('returns a frozen dispatcher with the capabilities table, the contract and describe()', () => {
    const server = serve();
    assert.strictEqual(Object.isFrozen(server), true);
    assert.strictEqual(Object.isFrozen(server.capabilities), true);
    assert.deepStrictEqual(server.capabilities, {
      name: 'http', status: true, headers: true, media: true, head: true, etag: true,
      idempotency: true, validatedOutput: true, stream: false, cancel: 'signal',
    });
    assert.strictEqual(server.contract, shop);
    assert.deepStrictEqual(server.describe(), shop.describe());
  });

  it('reports the declared downgrades: no ledger, no HEAD, no output validation', () => {
    const noIdempotency = compileContract({ $contract: '0.1', operations: { a: { kind: 'read', output: true, http: { method: 'GET', path: '/a' } } } });
    const server = serveHttp(noIdempotency, { a: () => 1 }, { head: false, validateOutput: 'never' });
    assert.strictEqual(server.capabilities.idempotency, false);
    assert.strictEqual(server.capabilities.head, false);
    assert.strictEqual(server.capabilities.validatedOutput, false);
  });

  it('JC1001: handlers must be an object of operation id → function, over a compiled contract', () => {
    for (const bad of [null, 5, 'x', [], undefined]) {
      assert.throws(() => serveHttp(shop, /** @type {any} */ (bad)), (err) => err instanceof ContractHostError && err.code === 'JC1001');
    }
    assert.throws(() => serveHttp(shop, { ...shopHandlers(), 'nope.op': () => 1 }),
      (err) => err instanceof ContractHostError && err.code === 'JC1001' && /nope\.op/.test(err.message));
    assert.throws(() => serveHttp(shop, { ...shopHandlers(), 'catalog.load': /** @type {any} */ (5) }),
      (err) => err instanceof ContractHostError && err.code === 'JC1001');
    assert.throws(() => serveHttp(/** @type {any} */ ({}), {}), (err) => err instanceof ContractHostError && err.code === 'JC1001');
    assert.throws(() => serve({}, { validateOutput: 'sometimes' }), (err) => err instanceof ContractHostError && err.code === 'JC1001');
    assert.throws(() => serve({}, { wellKnown: 'relative' }), (err) => err instanceof ContractHostError && err.code === 'JC1001');
    assert.throws(() => serve({}, { trace: 'x' }), (err) => err instanceof ContractHostError && err.code === 'JC1001');
    assert.throws(() => serve({}, { catalog: 5 }), (err) => err instanceof ContractHostError && err.code === 'JC1001');
    assert.throws(() => serve({}, { ledger: { claim() {} } }), (err) => err instanceof ContractHostError && err.code === 'JC1001');
    const err = /** @type {any} */ (assert.throws(() => serveHttp(shop, /** @type {any} */ (null))) ?? null);
    void err;
    const host = new ContractHostError('JC1001', 'why');
    assert.ok(host instanceof TypeError);
    assert.strictEqual(host.name, 'ContractHostError');
    assert.strictEqual(host.message, 'JC1001: why');
    assert.strictEqual(host.reason, 'why');
  });

  it('JC1002: a missing handler is refused unless partial', () => {
    const handlers = shopHandlers();
    delete handlers['product.search'];
    assert.throws(() => serveHttp(shop, handlers, { ledger: createMemoryLedger() }),
      (err) => err instanceof ContractHostError && err.code === 'JC1002' && /product\.search/.test(err.message));
    const partial = serveHttp(shop, handlers, { ledger: createMemoryLedger(), partial: true });
    assert.strictEqual(typeof partial.dispatch, 'function');
  });

  it('JC1003: a declared idempotency policy without a ledger is refused at construction (say so, never degrade)', () => {
    assert.throws(() => serveHttp(shop, shopHandlers()),
      (err) => err instanceof ContractHostError && err.code === 'JC1003' && /product\.save/.test(err.message));
  });

  it('exports the taxonomy as data', () => {
    assert.strictEqual(Object.isFrozen(HTTP_ERRORS), true);
    assert.deepStrictEqual(HTTP_ERRORS.JC2003, { status: 413, msgid: 'contract/body-too-large', retryable: false });
    assert.strictEqual(WELL_KNOWN_PATH, '/.well-known/jaren-contract');
  });
});

describe('dispatch — the request object', () => {
  it('rejects a malformed request object with JC1004 (the adapter author\'s mistake, never a response)', async () => {
    const server = serve();
    for (const bad of [null, 5, {}, { method: 'GET' }, { method: 'GET', url: '/x' }, { method: 5, url: '/x', headers: {} },
      { method: 'GET', url: '/x', headers: null }, { method: 'GET', url: '/x', headers: {}, body: 5 }, { method: 'GET', url: '/x', headers: {}, body: {} }]) {
      await assert.rejects(() => server.dispatch(/** @type {any} */ (bad)),
        (err) => err instanceof ContractHostError && err.code === 'JC1004');
    }
  });

  it('accepts an absent body as none', async () => {
    const server = serve();
    const r = await server.dispatch(/** @type {any} */ ({ method: 'GET', url: '/api/catalog', headers: {} }));
    assert.strictEqual(r.status, 200);
  });
});

describe('dispatch — happy paths over the shop fixture', () => {
  it('catalog.load: a read with a query member, coerced through the transport normalizer', async () => {
    /** @type {any} */
    let seen;
    const server = serve({ 'catalog.load': (input, ctx) => { seen = { input, ctx }; return { revision: 3, products: [] }; } });
    const r = await server.dispatch(req('GET', '/api/catalog?since=2026-01-01T00:00:00Z'));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-type'], 'application/json; charset=utf-8');
    assert.match(r.headers['x-jaren-trace'], TRACES);
    assert.deepStrictEqual(json(r), { revision: 3, products: [] });
    assert.deepStrictEqual(seen.input, { since: '2026-01-01T00:00:00Z' });
    assert.strictEqual(seen.ctx.op.id, 'catalog.load');
    assert.strictEqual(seen.ctx.method, 'GET');
    assert.strictEqual(seen.ctx.path, '/api/catalog');
    assert.strictEqual(seen.ctx.trace, r.headers['x-jaren-trace']);
    assert.deepStrictEqual(seen.ctx.params, {});
    assert.deepStrictEqual(seen.ctx.headers, {});
    assert.strictEqual(seen.ctx.body, null);
    assert.strictEqual(seen.ctx.signal, null);
    assert.strictEqual(seen.ctx.idempotency, null);
    assert.strictEqual(Object.isFrozen(seen.ctx), true);
    assert.strictEqual(Object.isFrozen(seen.ctx.params), true);
    assert.strictEqual(seen.ctx.fail, ContractFailure);
  });

  it('product.search: query coercion — integer, boolean, and a repeated array member; undeclared keys are ignored, last wins otherwise', async () => {
    /** @type {any} */
    let seen;
    const server = serve({ 'product.search': (input) => { seen = input; return []; } });
    const r = await server.dispatch(req('GET', '/api/products?q=first&q=last&limit=20&flag=true&tag=a&tag=b&nope=1&limit=5'));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(seen, { q: 'last', limit: 5, flag: true, tag: ['a', 'b'] });
    assert.strictEqual(Object.hasOwn(seen, 'nope'), false);
    // no query at all: an empty input that still validates
    const empty = await server.dispatch(req('GET', '/api/products'));
    assert.strictEqual(empty.status, 200);
    assert.deepStrictEqual(seen, {});
    // a plus is a space, an escape decodes
    await server.dispatch(req('GET', '/api/products?q=a+b%20c'));
    assert.deepStrictEqual(seen, { q: 'a b c' });
    // a single repeated-member occurrence is still an array
    await server.dispatch(req('GET', '/api/products?tag=solo'));
    assert.deepStrictEqual(seen, { tag: ['solo'] });
  });

  it('product.save: path + body members assembled, path coerced, body never coerced, output validated', async () => {
    /** @type {any} */
    let seen;
    const server = serve({ 'product.save': (input, ctx) => { seen = { input, ctx }; return { id: input.id, name: 'saved', price: 2 }; } });
    const r = await server.dispatch(jsonReq('PUT', '/api/products/12/master',
      { revision: 4, product: { id: 12, name: 'x', price: 1.5, tags: ['t'] } }, { 'idempotency-key': 'k-1' }));
    assert.strictEqual(r.status, 200, r.body);
    assert.deepStrictEqual(json(r), { id: 12, name: 'saved', price: 2 });
    assert.deepStrictEqual(seen.input, { id: 12, revision: 4, product: { id: 12, name: 'x', price: 1.5, tags: ['t'] } });
    assert.deepStrictEqual(seen.ctx.params, { id: '12' });
    assert.deepStrictEqual(seen.ctx.idempotency, { key: 'k-1', scope: '' });
    // a body member that names a path member is ignored — the path wins
    await server.dispatch(jsonReq('PUT', '/api/products/12/master',
      { id: 999, revision: 4, product: { id: 12, name: 'x', price: 1 } }, { 'idempotency-key': 'k-2' }));
    assert.strictEqual(seen.input.id, 12);
    // an undeclared body member is left to the validator (the schema allows it here)
    await server.dispatch(jsonReq('PUT', '/api/products/12/master',
      { revision: 4, product: { id: 12, name: 'x', price: 1 }, extra: true }, { 'idempotency-key': 'k-3' }));
    assert.strictEqual(seen.input.extra, true);
    // a +json media suffix and parameters are accepted
    const suffixed = await server.dispatch(req('PUT', '/api/products/12/master',
      { 'content-type': 'application/vnd.shop+json; charset=utf-8', 'idempotency-key': 'k-4' },
      JSON.stringify({ revision: 4, product: { id: 12, name: 'x', price: 1 } })));
    assert.strictEqual(suffixed.status, 200);
    // bytes are decoded as UTF-8
    const bytes = await server.dispatch(req('PUT', '/api/products/12/master',
      { 'content-type': 'application/json', 'idempotency-key': 'k-5' },
      new TextEncoder().encode(JSON.stringify({ revision: 4, product: { id: 12, name: 'ü', price: 1 } }))));
    assert.strictEqual(bytes.status, 200);
    assert.strictEqual(seen.input.product.name, 'ü');
  });

  it('product.remove: the canonical POST /<id> binding, optional idempotency without a key runs plainly', async () => {
    /** @type {any} */
    let seen;
    const server = serve({ 'product.remove': (input, ctx) => { seen = ctx; return true; } });
    const r = await server.dispatch(jsonReq('POST', '/product.remove', { id: 5 }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(json(r), true);
    assert.strictEqual(seen.idempotency, null);
  });

  it('a whole-body member (http.body) takes the parsed body verbatim; a header member travels by its lowercased name; a body-less op ignores a body', async () => {
    const contract = compileContract({
      $contract: '0.1',
      operations: {
        'doc.put': {
          kind: 'command',
          input: { type: 'object', required: ['id', 'doc'], properties: {
            id: { type: 'string' }, doc: { type: 'array', items: { type: 'object' } }, dry: { type: 'boolean' },
            'x-tenant': { type: 'string' }, 'x-tags': { type: 'array', items: { type: 'string' } } } },
          output: true,
          http: { method: 'PUT', path: '/docs/{id}', body: 'doc', in: { dry: 'query', 'x-tenant': 'header', 'x-tags': 'header' }, status: 204 },
        },
        'ping': { kind: 'command', output: true, http: { method: 'POST', path: '/ping' } },
      },
    });
    /** @type {any} */
    let seen;
    const server = serveHttp(contract, { 'doc.put': (input, ctx) => { seen = { input, ctx }; return undefined; }, ping: (input) => { seen = input; return 'pong'; } });
    const r = await server.dispatch(jsonReq('PUT', '/docs/a1?dry=true', [{ a: 1 }], { 'x-tenant': 'acme', 'x-tags': 'red, blue' }));
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.body, null);
    assert.deepStrictEqual(seen.input, { id: 'a1', dry: true, 'x-tenant': 'acme', 'x-tags': ['red', 'blue'], doc: [{ a: 1 }] });
    assert.deepStrictEqual(seen.ctx.headers, { 'x-tenant': 'acme', 'x-tags': 'red, blue' });
    // repeated header lines for the array member arrive as an array
    await server.dispatch(jsonReq('PUT', '/docs/a1', [], { 'x-tags': ['red', 'blue'] }));
    assert.deepStrictEqual(seen.input['x-tags'], ['red', 'blue']);
    // a body-less command with a body: the body is ignored, no input
    const p = await server.dispatch(req('POST', '/ping', { 'content-type': 'text/plain' }, 'ignored'));
    assert.strictEqual(p.status, 200);
    assert.strictEqual(json(p), 'pong');
    assert.strictEqual(seen, null);
    // an undefined handler value answers no body and no content-type
    const none = await server.dispatch(jsonReq('PUT', '/docs/a1', []));
    assert.strictEqual(none.status, 204);
    assert.strictEqual(none.headers['content-type'], undefined);
  });

  it('a static route beats a variable one under the binding too', async () => {
    const contract = compileContract({
      $contract: '0.1',
      operations: {
        'run.get': { kind: 'read', input: { type: 'object', properties: { id: { type: 'integer' } } }, output: true, http: { method: 'GET', path: '/runs/{id}' } },
        'run.prefill': { kind: 'read', output: true, http: { method: 'GET', path: '/runs/prefill' } },
      },
    });
    const server = serveHttp(contract, { 'run.get': (input) => ({ id: input.id }), 'run.prefill': () => 'prefill' });
    assert.strictEqual(json(await server.dispatch(req('GET', '/runs/prefill'))), 'prefill');
    assert.deepStrictEqual(json(await server.dispatch(req('GET', '/runs/42'))), { id: 42 });
  });
});

describe('dispatch — HEAD, entity tags, status override, opaque, well-known', () => {
  it('answers HEAD for a GET operation by running the handler and dropping the body, with content-length', async () => {
    let calls = 0;
    const server = serve({ 'catalog.load': () => { calls++; return { revision: 1, products: [] }; } });
    const r = await server.dispatch(req('HEAD', '/api/catalog'));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body, null);
    assert.strictEqual(r.headers['content-type'], 'application/json; charset=utf-8');
    assert.strictEqual(r.headers['content-length'], String(JSON.stringify({ revision: 1, products: [] }).length));
    assert.strictEqual(calls, 1);
    // head off: HEAD is a 405 listing GET
    const off = serve({}, { head: false });
    const r2 = await off.dispatch(req('HEAD', '/api/catalog'));
    assert.strictEqual(r2.status, 405);
    assert.strictEqual(r2.headers.allow, 'GET');
    // a declared HEAD operation wins over the GET fallback
    const declared = compileContract({ $contract: '0.1', operations: {
      'a.get': { kind: 'read', output: true, http: { method: 'GET', path: '/a' } },
      'a.head': { kind: 'read', output: true, http: { method: 'HEAD', path: '/a' } },
    } });
    /** @type {string[]} */
    const ran = [];
    const s = serveHttp(declared, { 'a.get': () => { ran.push('get'); return 1; }, 'a.head': () => { ran.push('head'); return 1; } });
    await s.dispatch(req('HEAD', '/a'));
    assert.deepStrictEqual(ran, ['head']);
  });

  it('ctx.etag arms a weak tag: 304 on a matching If-None-Match (weak comparison), the etag header otherwise', async () => {
    const server = serve({ 'catalog.load': (input, ctx) => { ctx.etag('r42'); return { revision: 42, products: [] }; } });
    const fresh = await server.dispatch(req('GET', '/api/catalog'));
    assert.strictEqual(fresh.status, 200);
    assert.strictEqual(fresh.headers.etag, 'W/"r42"');
    for (const inm of ['W/"r42"', '"r42"', '"other", W/"r42"', '*']) {
      const r = await server.dispatch(req('GET', '/api/catalog', { 'if-none-match': inm }));
      assert.strictEqual(r.status, 304, inm);
      assert.strictEqual(r.body, null);
      assert.strictEqual(r.headers.etag, 'W/"r42"');
      assert.match(r.headers['x-jaren-trace'], TRACES);
    }
    const miss = await server.dispatch(req('GET', '/api/catalog', { 'if-none-match': '"r41"' }));
    assert.strictEqual(miss.status, 200);
    // HEAD rides the same path
    const head = await server.dispatch(req('HEAD', '/api/catalog', { 'if-none-match': 'W/"r42"' }));
    assert.strictEqual(head.status, 304);
  });

  it('a strong tag: If-Match compares strongly (412 JC2014 on a mismatch or a weak candidate), If-None-Match on a non-GET is 412', async () => {
    const server = serve({
      'catalog.load': (input, ctx) => { ctx.etag('s1', { strong: true }); return { revision: 1, products: [] }; },
      'product.save': (input, ctx) => { ctx.etag('p9', { strong: true }); return { id: 1, name: 'x', price: 1 }; },
    });
    const ok = await server.dispatch(req('GET', '/api/catalog', { 'if-match': '"s1"' }));
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.headers.etag, '"s1"');
    const weakCandidate = await server.dispatch(req('GET', '/api/catalog', { 'if-match': 'W/"s1"' }));
    assert.strictEqual(weakCandidate.status, 412);
    assert.strictEqual(json(weakCandidate).code, 'JC2014');
    const miss = await server.dispatch(req('GET', '/api/catalog', { 'if-match': '"s0"' }));
    assert.strictEqual(miss.status, 412);
    const any = await server.dispatch(req('GET', '/api/catalog', { 'if-match': '*' }));
    assert.strictEqual(any.status, 200);
    // a weak armed tag never satisfies a strong If-Match
    const weakServer = serve({ 'catalog.load': (input, ctx) => { ctx.etag('w'); return { revision: 1, products: [] }; } });
    assert.strictEqual((await weakServer.dispatch(req('GET', '/api/catalog', { 'if-match': '"w"' }))).status, 412);
    // If-None-Match matching on a PUT is 412 (RFC 9110 §13.1.2), with the tag
    const put = await server.dispatch(jsonReq('PUT', '/api/products/1/master',
      { revision: 1, product: { id: 1, name: 'x', price: 1 } }, { 'idempotency-key': 'e1', 'if-none-match': '"p9"' }));
    assert.strictEqual(put.status, 412);
    assert.strictEqual(put.headers.etag, '"p9"');
    // without a tag armed, the conditionals are the handler's business: nothing fires
    const plain = serve();
    assert.strictEqual((await plain.dispatch(req('GET', '/api/catalog', { 'if-match': '"nope"', 'if-none-match': '*' }))).status, 200);
  });

  it('ctx.headers carries the conditionals so a handler may check them itself; ctx.etag refuses a malformed tag', async () => {
    /** @type {any} */
    let seen;
    const server = serve({ 'catalog.load': (input, ctx) => { seen = ctx.headers; return { revision: 1, products: [] }; } });
    await server.dispatch(req('GET', '/api/catalog', { 'if-match': '"a"', 'if-none-match': '"b"', 'x-ignored': '1' }));
    assert.deepStrictEqual(seen, { 'if-match': '"a"', 'if-none-match': '"b"' });
    const bad = serve({ 'catalog.load': (input, ctx) => { ctx.etag('has"quote'); return {}; } });
    const r = await bad.dispatch(req('GET', '/api/catalog'));
    assert.strictEqual(r.status, 500);
    assert.strictEqual(json(r).code, 'JC2008');
  });

  it('ctx.status overrides the success status within 2xx; outside it is JC1006, settled as JC2008 and seen by onError', async () => {
    /** @type {unknown[]} */
    const seen = [];
    const server = serve({
      'product.remove': (input, ctx) => { ctx.status(202); return true; },
      'catalog.load': (input, ctx) => { ctx.status(302); return {}; },
    }, { onError: (err) => { seen.push(err); } });
    const r = await server.dispatch(jsonReq('POST', '/product.remove', { id: 1 }));
    assert.strictEqual(r.status, 202);
    const bad = await server.dispatch(req('GET', '/api/catalog'));
    assert.strictEqual(bad.status, 500);
    assert.strictEqual(json(bad).code, 'JC2008');
    assert.strictEqual(seen.length, 1);
    assert.ok(seen[0] instanceof ContractHostError);
    assert.strictEqual(/** @type {any} */ (seen[0]).code, 'JC1006');
    // a 204 override drops the body
    const noContent = serve({ 'product.remove': (input, ctx) => { ctx.status(204); return true; } });
    const r2 = await noContent.dispatch(jsonReq('POST', '/product.remove', { id: 1 }));
    assert.strictEqual(r2.status, 204);
    assert.strictEqual(r2.body, null);
  });

  it('an opaque operation passes the raw handler\'s response through verbatim plus the trace; HEAD drops the body; a bad raw shape is JC2010', async () => {
    /** @type {any} */
    let seen;
    const server = serve({ 'image.bytes': (input, ctx) => { seen = { input, ctx }; return { status: 206, headers: { 'Content-Type': 'image/png', 'x-extra': 'y' }, body: new Uint8Array([9, 8]) }; } });
    const r = await server.dispatch(req('GET', '/api/images/7'));
    assert.strictEqual(r.status, 206);
    assert.deepStrictEqual(r.headers, { 'content-type': 'image/png', 'x-extra': 'y', 'x-jaren-trace': r.headers['x-jaren-trace'] });
    assert.deepStrictEqual(Array.from(/** @type {Uint8Array} */ (r.body)), [9, 8]);
    assert.deepStrictEqual(seen.input, { id: 7 }, 'path/query still decoded and coerced');
    assert.strictEqual(seen.ctx.body, null, 'a GET carried no body');
    const head = await server.dispatch(req('HEAD', '/api/images/7'));
    assert.strictEqual(head.status, 206);
    assert.strictEqual(head.body, null);
    // the transport members are ALWAYS the whole input of an opaque operation, so they are validated: JC2006, the raw handler never runs
    seen = undefined;
    const invalid = await server.dispatch(req('GET', '/api/images/not-a-number'));
    assert.strictEqual(invalid.status, 400);
    assert.deepStrictEqual(json(invalid).details, [{ path: '/id', keyword: 'type' }]);
    assert.strictEqual(seen, undefined);
    // (an opaque operation with a body-located member does not exist: the compiler refuses it with JC0017 — compile.test.js)
    // no input declared: the raw handler receives null, like a JSON handler
    const noInput = compileContract({ $contract: '0.1', operations: { 'ping.raw': { kind: 'read', output: true, http: { method: 'GET', path: '/raw', media: 'text/plain' } } } });
    /** @type {any} */
    let rawNone = 'unset';
    await serveHttp(noInput, { 'ping.raw': (input) => { rawNone = input; return { status: 200, body: 'pong' }; } }).dispatch(req('GET', '/raw'));
    assert.strictEqual(rawNone, null);
    // the raw body of an opaque upload reaches the handler untouched
    const upload = compileContract({ $contract: '0.1', operations: {
      'blob.put': { kind: 'command', input: { type: 'object', properties: { id: { type: 'string' } } }, output: true,
        http: { method: 'PUT', path: '/blobs/{id}', media: 'application/octet-stream' } },
    } });
    /** @type {any} */
    let raw;
    const up = serveHttp(upload, { 'blob.put': (input, ctx) => { raw = { input, body: ctx.body }; return { status: 201 }; } });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const put = await up.dispatch(req('PUT', '/blobs/b1', { 'content-type': 'application/octet-stream' }, bytes));
    assert.strictEqual(put.status, 201);
    assert.strictEqual(put.body, null);
    assert.deepStrictEqual(raw, { input: { id: 'b1' }, body: bytes });
    // a raw handler answering a non-response is the server breaking the contract
    for (const bad of [null, 5, { status: 99 }, { status: 200, headers: 5 }, { status: 200, body: {} }]) {
      const s = serve({ 'image.bytes': () => bad });
      const rr = await s.dispatch(req('GET', '/api/images/1'));
      assert.strictEqual(rr.status, 500);
      assert.strictEqual(json(rr).code, 'JC2010');
    }
    // a raw handler may fail with a declared code
    const decl = compileContract({ $contract: '0.1', operations: {
      'img.get': { kind: 'read', output: true, errors: { gone: { status: 410 } }, http: { method: 'GET', path: '/img', media: 'image/png' } },
    } });
    const s2 = serveHttp(decl, { 'img.get': (input, ctx) => ctx.fail('gone') });
    const gone = await s2.dispatch(req('GET', '/img'));
    assert.strictEqual(gone.status, 410);
    assert.strictEqual(json(gone).code, 'gone');
  });

  it('serves the well-known description under GET/HEAD, 405 under other methods, and can be moved or disabled', async () => {
    const server = serve();
    const r = await server.dispatch(req('GET', WELL_KNOWN_PATH));
    assert.strictEqual(r.status, 200);
    const body = json(r);
    assert.strictEqual(body.revision, await shop.revision());
    assert.deepStrictEqual(body.compat, ['4']);
    assert.deepStrictEqual(body, shop.describe());
    const head = await server.dispatch(req('HEAD', WELL_KNOWN_PATH));
    assert.strictEqual(head.status, 200);
    assert.strictEqual(head.body, null);
    const post = await server.dispatch(req('POST', WELL_KNOWN_PATH));
    assert.strictEqual(post.status, 405);
    assert.strictEqual(post.headers.allow, 'GET, HEAD');
    const moved = serve({}, { wellKnown: '/contract.json' });
    assert.strictEqual((await moved.dispatch(req('GET', '/contract.json'))).status, 200);
    assert.strictEqual((await moved.dispatch(req('GET', WELL_KNOWN_PATH))).status, 404);
    const off = serve({}, { wellKnown: false });
    assert.strictEqual((await off.dispatch(req('GET', WELL_KNOWN_PATH))).status, 404);
  });

  it('a host trace generator names the trace; a broken one falls back to a UUID; a spoofed x-jaren-trace header is ignored', async () => {
    let n = 0;
    const server = serve({}, { trace: () => `t-${++n}` });
    const a = await server.dispatch(req('GET', '/api/catalog', { 'x-jaren-trace': 'spoofed' }));
    assert.strictEqual(a.headers['x-jaren-trace'], 't-1');
    const b = await server.dispatch(req('GET', '/nope', { 'x-jaren-trace': 'spoofed' }));
    assert.strictEqual(b.headers['x-jaren-trace'], 't-2');
    assert.strictEqual(json(b).requestId, 't-2');
    const broken = serve({}, { trace: () => { throw new Error('no'); } });
    assert.match((await broken.dispatch(req('GET', '/api/catalog'))).headers['x-jaren-trace'], TRACES);
    const empty = serve({}, { trace: () => /** @type {any} */ (5) });
    assert.match((await empty.dispatch(req('GET', '/api/catalog'))).headers['x-jaren-trace'], TRACES);
  });

  it('a request signal reaches the handler as ctx.signal', async () => {
    /** @type {any} */
    let seen;
    const server = serve({ 'catalog.load': (input, ctx) => { seen = ctx.signal; return { revision: 1, products: [] }; } });
    const controller = new AbortController();
    await server.dispatch({ ...req('GET', '/api/catalog'), signal: controller.signal });
    assert.strictEqual(seen, controller.signal);
    await server.dispatch({ ...req('GET', '/api/catalog'), signal: /** @type {any} */ ('nope') });
    assert.strictEqual(seen, null);
  });
});

describe('dispatch — declared failures and the handler boundary', () => {
  it('ctx.fail answers the declared status and code, validates details against the declared schema, renders the generic message', async () => {
    const server = serve({ 'product.save': (input, ctx) => ctx.fail('conflict', {}, { current: { id: 1, name: 'y', price: 2 } }) });
    const r = await server.dispatch(jsonReq('PUT', '/api/products/1/master', { revision: 1, product: { id: 1, name: 'x', price: 1 } }, { 'idempotency-key': 'f1' }));
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.headers['cache-control'], 'no-store');
    assert.deepStrictEqual(json(r), {
      code: 'conflict', message: 'operation product.save failed with conflict', requestId: r.headers['x-jaren-trace'],
      details: { current: { id: 1, name: 'y', price: 2 } }, retryable: false,
    });
    // a declared code without a schema and without details
    const nf = serve({ 'product.save': (input, ctx) => ctx.fail('not-found') });
    const r2 = await nf.dispatch(jsonReq('PUT', '/api/products/1/master', { revision: 1, product: { id: 1, name: 'x', price: 1 } }, { 'idempotency-key': 'f2' }));
    assert.strictEqual(r2.status, 404);
    // retryable: product.save declares retry.on ['not-found']
    assert.deepStrictEqual(json(r2), { code: 'not-found', message: 'operation product.save failed with not-found', requestId: r2.headers['x-jaren-trace'], retryable: true });
    // details that break the declared error schema: JC2010, the handler broke its own error contract
    const broken = serve({ 'product.save': (input, ctx) => ctx.fail('conflict', {}, { current: 'nope' }) });
    const r3 = await broken.dispatch(jsonReq('PUT', '/api/products/1/master', { revision: 1, product: { id: 1, name: 'x', price: 1 } }, { 'idempotency-key': 'f3' }));
    assert.strictEqual(r3.status, 500);
    assert.strictEqual(json(r3).code, 'JC2010');
    // non-JSON details on a schema-less error: JC2010 as well
    const nonJson = serve({ 'product.save': (input, ctx) => ctx.fail('not-found', {}, () => 1) });
    const r4 = await nonJson.dispatch(jsonReq('PUT', '/api/products/1/master', { revision: 1, product: { id: 1, name: 'x', price: 1 } }, { 'idempotency-key': 'f4' }));
    assert.strictEqual(json(r4).code, 'JC2010');
    // an undeclared code is JC2008
    const undeclared = serve({ 'product.save': (input, ctx) => ctx.fail('teapot') });
    const r5 = await undeclared.dispatch(jsonReq('PUT', '/api/products/1/master', { revision: 1, product: { id: 1, name: 'x', price: 1 } }, { 'idempotency-key': 'f5' }));
    assert.strictEqual(r5.status, 500);
    assert.strictEqual(json(r5).code, 'JC2008');
  });

  it('retryable comes from the operation\'s retry policy by default and from ctx.fail(..., { retryable }) explicitly', async () => {
    const SAVE = { revision: 1, product: { id: 1, name: 'x', price: 1 } };
    const byPolicy = serve({ 'product.save': (input, ctx) => ctx.fail('not-found') });
    assert.strictEqual(json(await byPolicy.dispatch(jsonReq('PUT', '/api/products/1/master', SAVE, { 'idempotency-key': 'rp-1' }))).retryable, true, 'retry.on names not-found');
    const explicit = serve({ 'product.save': (input, ctx) => ctx.fail('not-found', {}, undefined, { retryable: false }) });
    assert.strictEqual(json(await explicit.dispatch(jsonReq('PUT', '/api/products/1/master', SAVE, { 'idempotency-key': 'rp-2' }))).retryable, false);
    // retry.on on the other command is not declared: not retryable by default
    const other = serve({ 'product.remove': (input, ctx) => ctx.fail('not-found') });
    assert.strictEqual(json(await other.dispatch(jsonReq('POST', '/product.remove', { id: 1 }))).retryable, false);
    const failure = ContractFailure('x', { a: 1 }, [1], { retryable: true });
    assert.deepStrictEqual(failure, { code: 'x', params: { a: 1 }, details: [1], retryable: true });
    assert.strictEqual(Object.isFrozen(failure), true);
    assert.strictEqual(isContractFailure(failure), true);
    assert.strictEqual(isContractFailure({ code: 'x', params: {}, details: undefined, retryable: null }), false, 'shape is not identity');
    assert.strictEqual(isContractFailure(null), false);
    assert.strictEqual(ContractFailure('y').retryable, null);
  });

  it('a thrown ContractRuntimeError with a declared code is a declared failure; any other throw or rejection is JC2008 seen by onError, never by the wire', async () => {
    /** @type {unknown[]} */
    const seen = [];
    const server = serve({
      'product.remove': () => { throw new ContractRuntimeError('not-found', 'gone', { msgid: 'contract/error/not-found', retryable: false }); },
      'catalog.load': () => { throw new Error('secret database detail'); },
      'product.search': () => Promise.reject(new TypeError('secret rejection')),
    }, { onError: (err, ctx) => { seen.push([err, ctx === null ? null : ctx.op.id]); } });
    const declared = await server.dispatch(jsonReq('POST', '/product.remove', { id: 1 }));
    assert.strictEqual(declared.status, 404);
    assert.strictEqual(json(declared).code, 'not-found');
    assert.strictEqual(json(declared).retryable, false);
    const thrown = await server.dispatch(req('GET', '/api/catalog'));
    assert.strictEqual(thrown.status, 500);
    assert.deepStrictEqual(json(thrown), { code: 'JC2008', message: 'operation catalog.load failed', requestId: thrown.headers['x-jaren-trace'], retryable: false });
    assert.doesNotMatch(/** @type {string} */ (thrown.body), /secret/);
    const rejected = await server.dispatch(req('GET', '/api/products'));
    assert.strictEqual(rejected.status, 500);
    assert.doesNotMatch(/** @type {string} */ (rejected.body), /secret/);
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(/** @type {any} */ (seen[0][0]).message, 'secret database detail');
    assert.strictEqual(seen[0][1], 'catalog.load');
    assert.strictEqual(seen[1][1], 'product.search');
    // an observer that throws never reaches the response
    const loud = serve({ 'catalog.load': () => { throw new Error('x'); } }, { onError: () => { throw new Error('observer'); } });
    assert.strictEqual((await loud.dispatch(req('GET', '/api/catalog'))).status, 500);
  });

  it('a value that fails the output schema is JC2010 (the server broke the contract); validateOutput: never lets it through', async () => {
    /** @type {unknown[]} */
    const seen = [];
    const server = serve({ 'catalog.load': () => ({ revision: 'not-an-integer' }) }, { onError: (err) => { seen.push(err); } });
    const r = await server.dispatch(req('GET', '/api/catalog'));
    assert.strictEqual(r.status, 500);
    assert.deepStrictEqual(json(r), { code: 'JC2010', message: 'operation catalog.load produced a response that violates its contract', requestId: r.headers['x-jaren-trace'], retryable: false });
    assert.strictEqual(seen.length, 1);
    assert.ok(seen[0] instanceof ContractRuntimeError);
    assert.strictEqual(/** @type {any} */ (seen[0]).code, 'JC2010');
    assert.ok(Array.isArray(/** @type {any} */ (seen[0]).cause), 'the validator errors ride the cause for the observer');
    const unchecked = serve({ 'catalog.load': () => ({ revision: 'not-an-integer' }) }, { validateOutput: 'never' });
    assert.strictEqual((await unchecked.dispatch(req('GET', '/api/catalog'))).status, 200);
    // a value JSON cannot carry is JC2010 too
    const cyclic = serve({ 'catalog.load': () => { const v = /** @type {any} */ ({ revision: 1, products: [] }); v.self = v; return v; } }, { validateOutput: 'never' });
    assert.strictEqual(json(await cyclic.dispatch(req('GET', '/api/catalog'))).code, 'JC2010');
  });

  it('a host-injected boolean validator is honored', async () => {
    const { JarenValidator } = await import('@jarenjs/validate');
    const contract = compileContract(load('./fixtures/shop.contract.json'), { validator: new JarenValidator() });
    const server = serveHttp(contract, shopHandlers(), { ledger: createMemoryLedger() });
    assert.strictEqual((await server.dispatch(req('GET', '/api/products?limit=nope'))).status, 400);
    assert.strictEqual((await server.dispatch(req('GET', '/api/products?limit=5'))).status, 200);
    const bad = serveHttp(contract, { ...shopHandlers(), 'catalog.load': () => 5 }, { ledger: createMemoryLedger() });
    assert.strictEqual(json(await bad.dispatch(req('GET', '/api/catalog'))).code, 'JC2010');
  });

  it('errorBody projects the wire record (legacy shapes); a projector that throws or returns non-JSON falls back to the D7 body', async () => {
    const legacy = serve({}, { errorBody: (wire, ctx) => ({ error: `${wire.status} ${wire.code}`, op: ctx === null ? null : ctx.op.id, requestId: wire.requestId }) });
    const r = await legacy.dispatch(req('GET', '/nope'));
    assert.deepStrictEqual(json(r), { error: '404 JC2001', op: null, requestId: r.headers['x-jaren-trace'] });
    const inOp = serve({ 'catalog.load': () => { throw new Error('x'); } }, { errorBody: (wire, ctx) => ({ error: wire.code, op: ctx === null ? null : ctx.op.id }) });
    assert.deepStrictEqual(json(await inOp.dispatch(req('GET', '/api/catalog'))), { error: 'JC2008', op: 'catalog.load' });
    const throwing = serve({}, { errorBody: () => { throw new Error('projector'); } });
    assert.strictEqual(json(await throwing.dispatch(req('GET', '/nope'))).code, 'JC2001');
    const nonJson = serve({}, { errorBody: () => () => 1 });
    assert.strictEqual(json(await nonJson.dispatch(req('GET', '/nope'))).code, 'JC2001');
  });

  it('a host catalog renders the taxonomy and a declared code\'s own message (contract/error/<code>) before the English text', async () => {
    const catalog = {
      'contract/not-found': 'geen bewerking voor deze aanvraag',
      'contract/error/conflict': (/** @type {any} */ p) => `conflict on ${p.op}: revision ${p.revision}`,
    };
    const server = serve({ 'product.save': (input, ctx) => ctx.fail('conflict', { revision: input.revision }, { current: { id: 1, name: 'y', price: 2 } }) }, { catalog });
    assert.strictEqual(json(await server.dispatch(req('GET', '/nope'))).message, 'geen bewerking voor deze aanvraag');
    const r = await server.dispatch(jsonReq('PUT', '/api/products/1/master', { revision: 7, product: { id: 1, name: 'x', price: 1 } }, { 'idempotency-key': 'c1' }));
    assert.strictEqual(json(r).message, 'conflict on product.save: revision 7');
    // an already-compiled catalog is accepted as is; a renderer that throws falls back to the fixed text
    const compiled = compileMessageCatalog({ 'contract/not-found': () => { throw new Error('render'); } });
    const s2 = serve({}, { catalog: compiled });
    assert.strictEqual(json(await s2.dispatch(req('GET', '/nope'))).message, 'request failed');
  });
});

describe('the English catalog', () => {
  it('renders every taxonomy msgid plus contract/handler-error, never interpolating a request value', () => {
    const rows = Object.values(HTTP_ERRORS);
    for (const row of rows) {
      const render = contractCatalogEn[row.msgid];
      assert.strictEqual(typeof render, 'function', row.msgid);
      const text = render({ op: 'x.y', limit: 1, media: 'application/json', allow: 'GET', kind: 'mismatch', header: 'h', code: 'c' });
      assert.ok(text.length > 0 && !text.includes('{'), `${row.msgid} renders: ${text}`);
    }
    assert.strictEqual(contractCatalogEn['contract/handler-error']({ op: 'a.b', code: 'conflict' }), 'operation a.b failed with conflict');
    const clientMsgids = Object.values(CLIENT_ERRORS).map((r) => r.msgid);
    const portLocalMsgids = Object.values(PORT_LOCAL_ERRORS).map((r) => r.msgid);
    assert.deepStrictEqual(Object.keys(contractMessagesEn).sort(), [...rows.map((r) => r.msgid), 'contract/handler-error', ...clientMsgids, ...portLocalMsgids].sort());
    assert.strictEqual(Object.isFrozen(contractMessagesEn), true);
    assert.strictEqual(Object.isFrozen(contractCatalogEn), true);
    // the parameters are trusted artifacts or protocol facts only: op ids, limits, media, method lists,
    // header names, codes, statuses, a platform error's name, contract ids, versions and a declared timeout
    const placeholders = new Set();
    for (const template of Object.values(contractMessagesEn)) {
      for (const m of template.matchAll(/\{([a-z]+)\}/g)) placeholders.add(m[1]);
    }
    assert.deepStrictEqual([...placeholders].sort(), ['allow', 'client', 'code', 'header', 'id', 'kind', 'limit', 'media', 'ms', 'name', 'op', 'server', 'status']);
  });
});
