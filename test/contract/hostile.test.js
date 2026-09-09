//@ts-check
/**
 * @file The trust boundary under attack: `dispatch()` never rejects for
 * request content, `Object.prototype` is never polluted, and a hostile
 * handler value settles into a coded response. Every case is asserted
 * with `assert.doesNotReject`, and every response still carries a
 * trace and a JSON error body.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { load, shopHandlers, req, jsonReq, json } from './helpers.js';

const shop = compileContract(load('./fixtures/shop.contract.json'));
const SAVE = { revision: 1, product: { id: 1, name: 'x', price: 1 } };

/**
 * @param {Record<string, any>} [overrides]
 * @param {any} [options]
 */
function serve(overrides = {}, options = {}) {
  return serveHttp(shop, { ...shopHandlers(), ...overrides }, { ledger: createMemoryLedger(), ...options });
}

/**
 * Dispatch and assert the total posture: no rejection, a trace, and a
 * JSON body with the expected code (or a 2xx).
 * @param {ReturnType<typeof serve>} server
 * @param {any} request
 * @param {number} status
 * @param {string | null} code
 */
async function settles(server, request, status, code) {
  /** @type {any} */
  let response;
  await assert.doesNotReject(async () => { response = await server.dispatch(request); });
  assert.strictEqual(response.status, status, `${request.method} ${request.url}: ${response.body}`);
  assert.match(response.headers['x-jaren-trace'], /^[0-9a-f-]{36}$/);
  if (code !== null) assert.strictEqual(json(response).code, code);
  return response;
}

describe('hostile requests', () => {
  it('prototype pollution through the query, the path and the body never lands', async () => {
    /** @type {any} */
    let seen;
    const server = serve({ 'product.search': (input) => { seen = input; return []; }, 'product.save': (input) => { seen = input; return { id: 1, name: 'x', price: 1 }; } });
    await settles(server, req('GET', '/api/products?__proto__[polluted]=1&__proto__=2&constructor[prototype][polluted]=3'), 200, null);
    assert.strictEqual(/** @type {any} */ ({}).polluted, undefined);
    assert.strictEqual(Object.hasOwn(seen, '__proto__'), false);
    await settles(server, jsonReq('PUT', '/api/products/1/master', { revision: 1, product: { id: 1, name: 'x', price: 1 }, constructor: { prototype: { polluted: 2 } } }, { 'idempotency-key': 'p' }), 200, null);
    assert.strictEqual(/** @type {any} */ ({}).polluted, undefined);
    assert.strictEqual(Object.getPrototypeOf(seen), Object.prototype);
    // a body under body:"*" whose text is exactly {"__proto__":{"x":1},...}
    await settles(server, req('PUT', '/api/products/1/master', { 'content-type': 'application/json', 'idempotency-key': 'p2' }, '{"__proto__":{"x":1},"revision":1,"product":{"id":1,"name":"x","price":1}}'), 200, null);
    assert.strictEqual(/** @type {any} */ ({}).x, undefined);
    assert.strictEqual(Object.getPrototypeOf(seen), Object.prototype);
    assert.strictEqual(Object.hasOwn(seen, '__proto__'), true, 'the body member is an own data property, judged by the schema, never the prototype');
    assert.deepStrictEqual(seen.__proto__, { x: 1 });
    // a path template variable named like a prototype member (a trusted document may declare it) is still safe
    const proto = compileContract({ $contract: '0.1', operations: { a: { kind: 'read', input: { type: 'object', properties: JSON.parse('{"__proto__":{"type":"string"}}') }, output: true, http: { method: 'GET', path: '/a/{__proto__}' } } } });
    const s = serveHttp(proto, { a: (input) => Object.hasOwn(input, '__proto__') });
    assert.strictEqual(json(await s.dispatch(req('GET', '/a/polluted'))), true);
    assert.strictEqual(/** @type {any} */ ({}).polluted, undefined);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
  });

  it('a 10 MiB body against a 1 MiB limit is 413 without parsing; a lying content-length too', async () => {
    const server = serve();
    const big = 'x'.repeat(10 * 1024 * 1024);
    await settles(server, req('PUT', '/api/products/1/master', { 'content-type': 'application/json', 'idempotency-key': 'k' }, big), 413, 'JC2003');
    await settles(server, req('PUT', '/api/products/1/master', { 'content-type': 'application/json', 'idempotency-key': 'k' }, new Uint8Array(1024 * 1024 + 1)), 413, 'JC2003');
    await settles(server, req('PUT', '/api/products/1/master', { 'content-type': 'application/json', 'idempotency-key': 'k', 'content-length': '10485760' }, '{}'), 413, 'JC2003');
    await settles(server, req('PUT', '/api/products/1/master', { 'content-type': 'application/json', 'idempotency-key': 'k', 'content-length': ['5', '10485760'] }, '{}'), 400, 'JC2006');
    // a multi-byte body just over the limit in bytes but under it in code units
    const contract = compileContract({ $contract: '0.1', operations: { a: { kind: 'command', input: { type: 'object', properties: { s: { type: 'string' } } }, output: true, policy: { limits: { maxBodyBytes: 32 } }, http: { method: 'POST', path: '/a' } } } });
    const s = serveHttp(contract, { a: () => true });
    await settles(s, jsonReq('POST', '/a', { s: 'ü'.repeat(13) }), 413, 'JC2003');
    await settles(s, jsonReq('POST', '/a', { s: 'u'.repeat(24) }), 200, null);
  });

  it('invalid UTF-8 bytes, malformed JSON, a lone surrogate, deep nesting and a scalar body all settle', async () => {
    const server = serve();
    const H = { 'content-type': 'application/json', 'idempotency-key': 'k' };
    await settles(server, req('PUT', '/api/products/1/master', H, new Uint8Array([0xc3, 0x28])), 400, 'JC2005');
    // a UTF-8 BOM is stripped by the decoder: the body is `{}`, valid JSON that fails validation
    await settles(server, req('PUT', '/api/products/1/master', H, new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), 400, 'JC2006');
    await settles(server, req('PUT', '/api/products/1/master', H, '{"revision": 1, "product": }'), 400, 'JC2005');
    await settles(server, req('PUT', '/api/products/1/master', H, '"\\ud800"'), 400, 'JC2006');
    await settles(server, req('PUT', '/api/products/1/master', H, '['.repeat(5000) + ']'.repeat(5000)), 400, 'JC2006');
    await settles(server, req('PUT', '/api/products/1/master', H, '42'), 400, 'JC2006');
    await settles(server, req('PUT', '/api/products/1/master', H, 'null'), 400, 'JC2006');
    await settles(server, req('POST', '/product.remove', { 'content-type': 'application/json' }, '{"id":1,"id":2}'), 200, null);
  });

  it('hostile paths and queries: control characters, overlong segments, encoded slashes, malformed escapes, huge queries', async () => {
    /** @type {any} */
    let rawInput;
    const server = serve({ 'image.bytes': (input) => { rawInput = input; return { status: 200 }; } });
    // the shape /api/products/{}/master exists under PUT and binds "\0": a 405, not a 404
    await settles(server, req('GET', '/api/products/%00/master'), 405, 'JC2002');
    // an opaque operation validates its transport members like any other (they are always its whole input — JC0017 refuses a body-located member):
    // a traversal string where the schema says integer never reaches the raw handler; a decoded `/` never re-splits
    await settles(server, req('GET', '/api/images/%2F..%2F..%2Fetc%2Fpasswd'), 400, 'JC2006');
    await settles(server, req('GET', '/api/images/' + 'a'.repeat(100000)), 400, 'JC2006');
    assert.strictEqual(rawInput, undefined);
    await settles(server, req('GET', '/api/images/7'), 200, null);
    assert.deepStrictEqual(rawInput, { id: 7 });
    await settles(server, req('GET', '/api/images/%E0%A4%A'), 400, 'JC2011');
    await settles(server, req('GET', '/api/images/7%'), 400, 'JC2011');
    await settles(server, req('GET', '/api/products?' + 'q=x&'.repeat(50000)), 200, null);
    await settles(server, req('GET', '/api/products?limit=%ZZ'), 400, 'JC2012');
    await settles(server, req('GET', '/api/products?limit=1e400'), 400, 'JC2006');
    await settles(server, req('GET', '/api/products?limit=1&limit=2&limit=3&limit=101'), 400, 'JC2006');
    await settles(server, req('GET', '/api/products?tag=' + encodeURIComponent(JSON.stringify(['x'.repeat(10000)]))), 200, null);
    await settles(server, req('GET', '/api/products?flag=TRUE'), 400, 'JC2006');
    await settles(server, req('GET', '/api/products?flag=true&flag=maybe'), 400, 'JC2006');
    await settles(server, req('GET', '/api/catalog#fragment'), 404, 'JC2001');
    await settles(server, req('GET', ''), 404, 'JC2001');
    await settles(server, req('GET', 'api/catalog'), 404, 'JC2001');
    await settles(server, req('GET', '//api/catalog'), 404, 'JC2001');
    await settles(server, req('GET', '/api/catalog?'), 200, null);
    await settles(server, req('TRACE', '/api/catalog'), 405, 'JC2002');
    await settles(server, req('', '/api/catalog'), 405, 'JC2002');
    await settles(server, req('GET', '/API/CATALOG'), 404, 'JC2001');
  });

  it('hostile headers: repeated members, non-string values, giant values, undeclared headers never read', async () => {
    const contract = compileContract({ $contract: '0.1', operations: { a: {
      kind: 'read', input: { type: 'object', properties: { 'x-rev': { type: 'integer' } } }, output: true, http: { method: 'GET', path: '/a', in: { 'x-rev': 'header' } } } } });
    /** @type {any} */
    let seen;
    const s = serveHttp(contract, { a: (input, ctx) => { seen = ctx.headers; return input; } });
    await settles(s, req('GET', '/a', { 'x-rev': ['1', '1'] }), 400, 'JC2015');
    await settles(s, req('GET', '/a', { 'x-rev': /** @type {any} */ ({ toString: () => '1' }) }), 400, 'JC2015');
    await settles(s, req('GET', '/a', { 'x-rev': /** @type {any} */ ([]) }), 400, 'JC2015');
    await settles(s, req('GET', '/a', { 'x-rev': '9'.repeat(100000) }), 400, 'JC2006');
    await settles(s, req('GET', '/a', { 'x-rev': '3', 'x-secret': 'never', 'if-match': /** @type {any} */ (['"a"', '"b"']), 'content-length': /** @type {any} */ (null) }), 200, null);
    assert.deepStrictEqual(seen, { 'x-rev': '3', 'if-match': '"a", "b"' });
    await settles(s, req('GET', '/a', { 'content-length': 'NaN', 'x-rev': '3' }), 200, null);
    await settles(s, req('GET', '/a', { 'content-length': '-5', 'x-rev': '3' }), 200, null);
    await settles(s, req('GET', '/a', { 'content-length': '99999999999999999999', 'x-rev': '3' }), 200, null);
    await settles(s, req('GET', '/a', /** @type {any} */ (Object.create(null))), 200, null);
  });

  it('a hostile handler value never escapes: throwing getters, throwing prototype walks, hostile thenables, rejections with hostile objects', async () => {
    /** @type {unknown[]} */
    const seen = [];
    const onError = (/** @type {unknown} */ err) => { seen.push(err); };
    const throwingGetter = { get revision() { throw new Error('getter'); }, products: [] };
    await settles(serve({ 'catalog.load': () => throwingGetter }, { onError }), req('GET', '/api/catalog'), 500, 'JC2010');
    const throwingProxy = new Proxy({}, { get() { throw new Error('trap'); }, getPrototypeOf() { throw new Error('proto trap'); }, ownKeys() { throw new Error('keys trap'); } });
    // a value whose `then` read throws is a REJECTION at the promise boundary: the hostile-value case of JC2008
    await settles(serve({ 'catalog.load': () => throwingProxy }, { onError }), req('GET', '/api/catalog'), 500, 'JC2008');
    // a value whose then is honest but whose members throw survives the boundary and dies in validation: JC2010
    const throwingMembers = new Proxy({}, { get(t, k) { if (k === 'then') return undefined; throw new Error('trap'); }, ownKeys() { throw new Error('keys trap'); } });
    await settles(serve({ 'catalog.load': () => throwingMembers }, { onError }), req('GET', '/api/catalog'), 500, 'JC2010');
    await settles(serve({ 'catalog.load': () => { throw throwingProxy; } }, { onError }), req('GET', '/api/catalog'), 500, 'JC2008');
    await settles(serve({ 'catalog.load': () => Promise.reject(throwingProxy) }, { onError }), req('GET', '/api/catalog'), 500, 'JC2008');
    await settles(serve({ 'catalog.load': () => Promise.reject({ get name() { throw new Error('name'); }, get message() { throw new Error('message'); } }) }, { onError }), req('GET', '/api/catalog'), 500, 'JC2008');
    await settles(serve({ 'catalog.load': () => Promise.reject(undefined) }, { onError }), req('GET', '/api/catalog'), 500, 'JC2008');
    await settles(serve({ 'catalog.load': () => Promise.reject(null) }, { onError }), req('GET', '/api/catalog'), 500, 'JC2008');
    await settles(serve({ 'catalog.load': () => { throw 'string'; } }, { onError }), req('GET', '/api/catalog'), 500, 'JC2008');
    await settles(serve({ 'catalog.load': () => ({ get then() { throw new Error('then getter'); } }) }, { onError }), req('GET', '/api/catalog'), 500, 'JC2008');
    await settles(serve({ 'catalog.load': () => ({ then: (/** @type {any} */ _, /** @type {any} */ reject) => reject(new Error('rejecting thenable')) }) }, { onError }), req('GET', '/api/catalog'), 500, 'JC2008');
    await settles(serve({ 'catalog.load': () => 5n }, { onError, validateOutput: 'never' }), req('GET', '/api/catalog'), 500, 'JC2010');
    await settles(serve({ 'catalog.load': () => Symbol('s') }, { onError, validateOutput: 'never' }), req('GET', '/api/catalog'), 200, null);
    // a raw handler answering a hostile object
    await settles(serve({ 'image.bytes': () => throwingMembers }, { onError }), req('GET', '/api/images/1'), 500, 'JC2010');
    await settles(serve({ 'image.bytes': () => ({ status: 200, headers: throwingMembers }) }, { onError }), req('GET', '/api/images/1'), 500, 'JC2010');
    await settles(serve({ 'image.bytes': () => ({ status: 200, headers: throwingProxy }) }, { onError }), req('GET', '/api/images/1'), 500, 'JC2010');
    // a failure with hostile details
    await settles(serve({ 'product.remove': (i, ctx) => ctx.fail('not-found', {}, throwingProxy) }, { onError }), jsonReq('POST', '/product.remove', { id: 1 }), 500, 'JC2010');
    // a hostile params bag on a failure never breaks the message
    await settles(serve({ 'product.remove': (i, ctx) => ctx.fail('not-found', /** @type {any} */ ({ get op() { throw new Error('op'); } })) }, { onError }), jsonReq('POST', '/product.remove', { id: 1 }), 500, 'JC2008');
    assert.ok(seen.length >= 14, `onError saw ${seen.length} faults`);
  });

  it('a hostile ledger settles too', async () => {
    const hostileLedger = { claim: () => { throw new Error('claim'); }, commit: () => {}, fail: () => {}, lookup: () => null };
    await settles(serve({}, { ledger: hostileLedger }), jsonReq('PUT', '/api/products/1/master', SAVE, { 'idempotency-key': 'k' }), 500, 'JC2008');
    const rejecting = { claim: () => Promise.reject(new Error('claim')), commit: () => {}, fail: () => {}, lookup: () => null };
    await settles(serve({}, { ledger: rejecting }), jsonReq('PUT', '/api/products/1/master', SAVE, { 'idempotency-key': 'k' }), 500, 'JC2008');
    const proxyClaim = { claim: () => new Proxy({}, { get() { throw new Error('trap'); } }), commit: () => {}, fail: () => {}, lookup: () => null };
    await settles(serve({}, { ledger: proxyClaim }), jsonReq('PUT', '/api/products/1/master', SAVE, { 'idempotency-key': 'k' }), 500, 'JC2008');
  });

  it('after everything above, Object.prototype is untouched', () => {
    assert.strictEqual(Object.prototype.polluted, undefined);
    assert.strictEqual(Object.prototype.x, undefined);
    assert.deepStrictEqual(Object.getOwnPropertyNames(Object.prototype).filter((n) => /pollut|^x$/.test(n)), []);
  });
});
