//@ts-check
/**
 * @file The wire-error taxonomy: every `JC2001–JC2015` row answers its
 * status and code with `requestId === x-jaren-trace`, `cache-control:
 * no-store` and the row's `retryable`; `details` follows
 * `policy.errors.details` (`none` / `paths` / `full`); and the four
 * sets agree — CONTRACT-FORMAT.md §7's taxonomy, `CONTRACT_CODES` +
 * `HTTP_ERRORS`, the English catalog's keys, and the 11
 * `@jarenjs/locales` packs (a test-side import; the packs themselves
 * import nothing from this package — key parity is what binds them).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { compileContract, CONTRACT_CODES, contractMessagesEn } from '@jarenjs/contract';
import { serveHttp, HTTP_ERRORS } from '@jarenjs/contract/http';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { CLIENT_ERRORS } from '@jarenjs/contract/client';
import { PORT_LOCAL_ERRORS } from '@jarenjs/contract/port';
import { STREAM_ERRORS } from '@jarenjs/contract/stream';
import { nl, fr, es, pt, de, ja, ko, zhTW, ru, tr, ar } from '@jarenjs/locales';
import { load, shopHandlers, req, jsonReq, json } from './helpers.js';

const shop = compileContract(load('./fixtures/shop.contract.json'));
const FORMAT_DOC = new URL('../../packages/contract/docs/CONTRACT-FORMAT.md', import.meta.url);

/**
 * @param {Record<string, any>} [overrides]
 * @param {any} [options]
 */
function serve(overrides = {}, options = {}) {
  return serveHttp(shop, { ...shopHandlers(), ...overrides }, { ledger: createMemoryLedger(), ...options });
}

/**
 * Assert the invariants of every wire error.
 * @param {import('@jarenjs/contract/http').HttpResponse} r
 * @param {string} code
 * @param {number} status
 * @param {boolean} retryable
 */
function wireError(r, code, status, retryable) {
  assert.strictEqual(r.status, status, `${code}: ${r.body}`);
  const body = json(r);
  assert.strictEqual(body.code, code);
  assert.strictEqual(typeof body.message, 'string');
  assert.strictEqual(body.requestId, r.headers['x-jaren-trace']);
  assert.match(body.requestId, /^[0-9a-f-]{36}$/);
  assert.strictEqual(body.retryable, retryable);
  assert.strictEqual(r.headers['cache-control'], 'no-store');
  assert.strictEqual(r.headers['content-type'], 'application/json; charset=utf-8');
  return body;
}

const SAVE = { revision: 1, product: { id: 1, name: 'x', price: 1 } };

describe('the wire-error taxonomy — one test per row', () => {
  it('JC2001 404 no operation matches', async () => {
    const body = wireError(await serve().dispatch(req('GET', '/api/nothing/here')), 'JC2001', 404, false);
    assert.strictEqual(body.details, undefined);
    wireError(await serve().dispatch(req('GET', '/api/catalog/')), 'JC2001', 404, false);
    // a lowercase method token is not the method: the shape exists under GET, so it is a 405
    wireError(await serve().dispatch(req('get', '/api/catalog')), 'JC2002', 405, false);
  });

  it('JC2002 405 the shape is served under other methods, Allow lists them', async () => {
    const r = await serve().dispatch(req('DELETE', '/api/catalog'));
    wireError(r, 'JC2002', 405, false);
    assert.strictEqual(r.headers.allow, 'GET, HEAD');
    const r2 = await serve().dispatch(req('POST', '/api/products/1/master'));
    assert.strictEqual(r2.headers.allow, 'PUT');
    assert.match(json(r2).message, /PUT/);
  });

  it('JC2003 413 the body exceeds the limit — by content-length before reading, by length after', async () => {
    const byHeader = await serve().dispatch(req('POST', '/product.remove', { 'content-type': 'application/json', 'content-length': '5000' }, '{}'));
    wireError(byHeader, 'JC2003', 413, false);
    const byLength = await serve().dispatch(jsonReq('POST', '/product.remove', { id: 1, pad: 'x'.repeat(5000) }));
    wireError(byLength, 'JC2003', 413, false);
    assert.match(json(byLength).message, /4096/);
    const bytes = await serve().dispatch(req('POST', '/product.remove', { 'content-type': 'application/json' }, new Uint8Array(4097)));
    wireError(bytes, 'JC2003', 413, false);
    // a body-less operation still refuses an oversize declared body
    const bodyless = await serve().dispatch(req('GET', '/api/catalog', { 'content-length': '99999999' }));
    wireError(bodyless, 'JC2003', 413, false);
    // exactly at the limit passes the limit
    const atLimit = await serve().dispatch(req('POST', '/product.remove', { 'content-type': 'application/json' }, `{"id":1,"pad":"${'x'.repeat(4096 - 18)}"}`));
    assert.strictEqual(atLimit.status, 200, atLimit.body);
  });

  it('JC2004 415 unsupported media on a body-carrying operation', async () => {
    wireError(await serve().dispatch(req('POST', '/product.remove', { 'content-type': 'text/plain' }, '{"id":1}')), 'JC2004', 415, false);
    wireError(await serve().dispatch(req('POST', '/product.remove', {}, '{"id":1}')), 'JC2004', 415, false);
    // an empty body needs no media
    assert.strictEqual((await serve().dispatch(req('POST', '/product.remove', {}, ''))).status, 400);
    assert.strictEqual(json(await serve().dispatch(req('POST', '/product.remove', {}, ''))).code, 'JC2006');
  });

  it('JC2005 400 malformed JSON, including invalid UTF-8 bytes', async () => {
    wireError(await serve().dispatch(req('POST', '/product.remove', { 'content-type': 'application/json' }, '{"id":')), 'JC2005', 400, false);
    wireError(await serve().dispatch(req('POST', '/product.remove', { 'content-type': 'application/json' }, new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))), 'JC2005', 400, false);
  });

  it('JC2006 400 invalid input, details by policy', async () => {
    const paths = wireError(await serve().dispatch(jsonReq('PUT', '/api/products/1/master', { revision: 'x' }, { 'idempotency-key': 'k' })), 'JC2006', 400, false);
    assert.deepStrictEqual(paths.details, [{ path: '', keyword: 'required' }, { path: '/revision', keyword: 'type' }]);
    // a non-object body under body:"*" is a type failure at the root
    const root = wireError(await serve().dispatch(jsonReq('PUT', '/api/products/1/master', [1], { 'idempotency-key': 'k' })), 'JC2006', 400, false);
    assert.deepStrictEqual(root.details, [{ path: '', keyword: 'type' }]);
    // a path member that fails coercion — on a JSON operation and on an opaque one alike
    wireError(await serve().dispatch(jsonReq('PUT', '/api/products/abc/master', SAVE, { 'idempotency-key': 'k' })), 'JC2006', 400, false);
    wireError(await serve().dispatch(req('GET', '/api/images/abc')), 'JC2006', 400, false);
    // full: the validator's own records with params
    const full = wireError(await serve().dispatch(jsonReq('POST', '/product.remove', { id: 'x' })), 'JC2006', 400, false);
    assert.strictEqual(full.details.length, 1);
    assert.strictEqual(full.details[0].keyword, 'type');
    assert.strictEqual(full.details[0].instancePath, '/id');
    assert.ok(Object.hasOwn(full.details[0], 'params'));
    // none: absent
    const quiet = compileContract({ $contract: '0.1', operations: { a: { kind: 'read', input: { type: 'object', properties: { n: { type: 'integer' } } }, output: true,
      policy: { errors: { details: 'none' } }, http: { method: 'GET', path: '/a' } } } });
    const s = serveHttp(quiet, { a: () => 1 });
    const none = wireError(await s.dispatch(req('GET', '/a?n=x')), 'JC2006', 400, false);
    assert.strictEqual(none.details, undefined);
    assert.strictEqual(Object.hasOwn(none, 'details'), false);
  });

  it('JC2007 400 idempotency key required', async () => {
    wireError(await serve().dispatch(jsonReq('PUT', '/api/products/1/master', SAVE)), 'JC2007', 400, false);
    wireError(await serve().dispatch(jsonReq('PUT', '/api/products/1/master', SAVE, { 'idempotency-key': '' })), 'JC2007', 400, false);
  });

  it('JC2008 500 the handler failed', async () => {
    wireError(await serve({ 'catalog.load': () => { throw new Error('boom'); } }).dispatch(req('GET', '/api/catalog')), 'JC2008', 500, false);
    wireError(await serve({ 'catalog.load': async () => { throw new Error('boom'); } }).dispatch(req('GET', '/api/catalog')), 'JC2008', 500, false);
    wireError(await serve({ 'catalog.load': (i, ctx) => ctx.fail('undeclared') }).dispatch(req('GET', '/api/catalog')), 'JC2008', 500, false);
  });

  it('JC2009 409 idempotency conflict: in-progress (retryable, retry-after) and mismatch (details kind)', async () => {
    let release = () => {};
    const gate = new Promise((resolve) => { release = () => resolve(undefined); });
    const server = serve({ 'product.save': async () => { await gate; return { id: 1, name: 'x', price: 1 }; } });
    const first = server.dispatch(jsonReq('PUT', '/api/products/1/master', SAVE, { 'idempotency-key': 'same' }));
    const second = await server.dispatch(jsonReq('PUT', '/api/products/1/master', SAVE, { 'idempotency-key': 'same' }));
    wireError(second, 'JC2009', 409, true);
    assert.strictEqual(second.headers['retry-after'], '1');
    release();
    assert.strictEqual((await first).status, 200);
    const mismatch = await server.dispatch(jsonReq('PUT', '/api/products/1/master', { ...SAVE, revision: 2 }, { 'idempotency-key': 'same' }));
    const body = wireError(mismatch, 'JC2009', 409, false);
    assert.deepStrictEqual(body.details, [{ kind: 'mismatch' }]);
  });

  it('JC2010 500 invalid output', async () => {
    wireError(await serve({ 'catalog.load': () => ({ revision: 'x' }) }).dispatch(req('GET', '/api/catalog')), 'JC2010', 500, false);
    wireError(await serve({ 'catalog.load': () => ({ get revision() { throw new Error('hostile getter'); } }) }).dispatch(req('GET', '/api/catalog')), 'JC2010', 500, false);
  });

  it('JC2011 400 malformed path escape', async () => {
    wireError(await serve().dispatch(req('GET', '/api/products/%ZZ')), 'JC2011', 400, false);
    wireError(await serve().dispatch(req('GET', '/api/%E0%A4%A')), 'JC2011', 400, false);
    // a decodable escape in a variable is fine
    assert.strictEqual((await serve().dispatch(req('GET', '/api/images/%37'))).status, 200);
  });

  it('JC2012 400 malformed query', async () => {
    wireError(await serve().dispatch(req('GET', '/api/products?q=%E0%A4%A')), 'JC2012', 400, false);
    wireError(await serve().dispatch(req('GET', '/api/catalog?x=%ZZ')), 'JC2012', 400, false);
  });

  it('JC2013 501 not implemented on a partial server', async () => {
    const handlers = shopHandlers();
    delete handlers['product.search'];
    const server = serveHttp(shop, handlers, { ledger: createMemoryLedger(), partial: true });
    wireError(await server.dispatch(req('GET', '/api/products')), 'JC2013', 501, false);
    assert.strictEqual((await server.dispatch(req('GET', '/api/catalog'))).status, 200);
  });

  it('JC2014 412 precondition failed', async () => {
    const server = serve({ 'catalog.load': (i, ctx) => { ctx.etag('v1', { strong: true }); return { revision: 1, products: [] }; } });
    wireError(await server.dispatch(req('GET', '/api/catalog', { 'if-match': '"v0"' })), 'JC2014', 412, false);
  });

  it('JC2015 400 a declared scalar header member repeated', async () => {
    const contract = compileContract({ $contract: '0.1', operations: { a: {
      kind: 'read', input: { type: 'object', properties: { 'x-rev': { type: 'integer' }, 'x-list': { type: 'array', items: { type: 'string' } } } },
      output: true, http: { method: 'GET', path: '/a', in: { 'x-rev': 'header', 'x-list': 'header' } } } } });
    const server = serveHttp(contract, { a: (input) => input });
    wireError(await server.dispatch(req('GET', '/a', { 'x-rev': ['1', '2'] })), 'JC2015', 400, false);
    wireError(await server.dispatch(req('GET', '/a', { 'x-list': /** @type {any} */ ([1]) })), 'JC2015', 400, false);
    wireError(await server.dispatch(req('GET', '/a', { 'x-rev': /** @type {any} */ (5) })), 'JC2015', 400, false);
    assert.deepStrictEqual(json(await server.dispatch(req('GET', '/a', { 'x-rev': ['7'], 'x-list': ['a', 'b'] }))), { 'x-rev': 7, 'x-list': ['a', 'b'] });
    // a scalar header that fails coercion is a validation failure, not JC2015
    assert.strictEqual(json(await server.dispatch(req('GET', '/a', { 'x-rev': 'seven' }))).code, 'JC2006');
  });
});

/**
 * The §7 taxonomy table of the format doc: code → { status, msgid, retryable }.
 * @returns {Record<string, { status: number, msgid: string, retryable: string }>}
 */
function docTaxonomy() {
  const md = readFileSync(FORMAT_DOC, 'utf8');
  /** @type {Record<string, { status: number, msgid: string, retryable: string }>} */
  const rows = {};
  for (const m of md.matchAll(/^\|\s*`(JC2\d{3})`\s*\|\s*(\d{3})\s*\|\s*`(contract\/[a-z-]+)`\s*\|\s*([^|]+?)\s*\|/gm)) {
    rows[m[1]] = { status: Number(m[2]), msgid: m[3], retryable: m[4] };
  }
  return rows;
}

describe('the four sets agree', () => {
  it('CONTRACT-FORMAT.md §7 taxonomy ⇔ HTTP_ERRORS ⇔ CONTRACT_CODES ⇔ contractMessagesEn keys', () => {
    const doc = docTaxonomy();
    assert.deepStrictEqual(Object.keys(doc).sort(), Object.keys(HTTP_ERRORS).sort(), 'the doc lists exactly the http codes');
    for (const [code, row] of Object.entries(HTTP_ERRORS)) {
      assert.strictEqual(doc[code].status, row.status, code);
      assert.strictEqual(doc[code].msgid, row.msgid, code);
      if (doc[code].retryable === 'yes' || doc[code].retryable === 'no') {
        assert.strictEqual(row.retryable, doc[code].retryable === 'yes', code);
      }
      assert.ok(Object.hasOwn(CONTRACT_CODES, code), `${code} in CONTRACT_CODES`);
      assert.ok(Object.hasOwn(contractMessagesEn, row.msgid), `${row.msgid} in the English catalog`);
    }
    const msgids = new Set(Object.values(HTTP_ERRORS).map((r) => r.msgid));
    msgids.add('contract/handler-error');
    for (const row of Object.values(CLIENT_ERRORS)) msgids.add(row.msgid);
    for (const row of Object.values(PORT_LOCAL_ERRORS)) msgids.add(row.msgid);
    for (const row of Object.values(STREAM_ERRORS)) msgids.add(row.msgid);
    assert.deepStrictEqual(Object.keys(contractMessagesEn).sort(), [...msgids].sort(), 'the catalog has exactly the taxonomy msgids + handler-error + the client, port/local and stream msgids');
    const httpCodes = Object.keys(CONTRACT_CODES).filter((c) => /^JC20[0-4]\d$/.test(c));
    assert.deepStrictEqual(httpCodes.sort(), Object.keys(HTTP_ERRORS).sort(), 'every JC2001–JC2049 of the code table is a taxonomy row');
  });

  it('every contract/* msgid of the English catalog is in all 11 locale packs', () => {
    const packs = { nl, fr, es, pt, de, ja, ko, 'zh-tw': zhTW, ru, tr, ar };
    for (const [code, pack] of Object.entries(packs)) {
      for (const msgid of Object.keys(contractMessagesEn)) {
        assert.ok(Object.hasOwn(pack, msgid), `${code} is missing '${msgid}'`);
      }
    }
  });
});
