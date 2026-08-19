//@ts-check
/**
 * @file The two dependency-free adapters over a real wire: `toNodeHandler`
 * behind `node:http` on 127.0.0.1:0 driven by `fetch` (and `http.request`
 * for the streaming cases), and `toFetchHandler` fed `new Request(...)`
 * directly — the same request produces the same body through both; 413
 * by declared content-length (never read) and by stream overflow (the
 * read stops, the socket is closed); opaque bytes round-trip byte-equal;
 * repeated header lines reach the dispatcher as arrays; HEAD, 304 and
 * 204 carry no body; the abort signal fires when the client goes away.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { once } from 'node:events';

import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { toNodeHandler } from '@jarenjs/contract/node';
import { toFetchHandler } from '@jarenjs/contract/fetch';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { load, shopHandlers } from './helpers.js';

const shop = compileContract(load('./fixtures/shop.contract.json'));
const SAVE = { revision: 1, product: { id: 1, name: 'x', price: 1 } };

/** @type {ReturnType<typeof serveHttp>} */
let dispatcher;
/** @type {http.Server} */
let server;
/** @type {string} */
let origin;
/** @type {(request: Request) => Promise<Response>} */
let fetchHandler;
/** @type {AbortSignal | null} */
let lastSignal = null;
/** @type {Promise<void> | null} */
let slowGate = null;

before(async () => {
  dispatcher = serveHttp(shop, {
    ...shopHandlers(),
    'catalog.load': async (input, ctx) => {
      lastSignal = ctx.signal;
      if (slowGate !== null) await slowGate;
      ctx.etag('cat-1');
      return { revision: 1, products: [{ id: 1, name: 'a', price: 1 }] };
    },
    'image.bytes': (input) => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(Array.from({ length: 300 }, (_, i) => (i * 7 + input.id) & 255)) }),
    'product.remove': (input, ctx) => { ctx.status(204); return true; },
  }, { ledger: createMemoryLedger(), trace: () => 'fixed-trace' });
  server = http.createServer(toNodeHandler(dispatcher));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  origin = `http://127.0.0.1:${address.port}`;
  fetchHandler = toFetchHandler(dispatcher);
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
});

/**
 * The same request through both adapters: `fetch` against the real
 * server and `toFetchHandler` on a `Request` — returns both responses.
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function both(path, init) {
  const viaNode = await fetch(origin + path, init);
  const viaFetch = await fetchHandler(new Request('http://contract.local' + path, init));
  return { viaNode, viaFetch };
}

describe('adapters — the same request through node:http and toFetchHandler', () => {
  it('a JSON read: identical status, body and content-type; the trace rides x-jaren-trace', async () => {
    const { viaNode, viaFetch } = await both('/api/catalog');
    assert.strictEqual(viaNode.status, 200);
    assert.strictEqual(viaFetch.status, 200);
    const a = await viaNode.text();
    const b = await viaFetch.text();
    assert.strictEqual(a, b);
    assert.deepStrictEqual(JSON.parse(a), { revision: 1, products: [{ id: 1, name: 'a', price: 1 }] });
    assert.strictEqual(viaNode.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.strictEqual(viaFetch.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.strictEqual(viaNode.headers.get('x-jaren-trace'), 'fixed-trace');
    assert.strictEqual(viaFetch.headers.get('x-jaren-trace'), 'fixed-trace');
    assert.strictEqual(viaNode.headers.get('etag'), 'W/"cat-1"');
    assert.strictEqual(viaNode.headers.get('content-length'), String(a.length));
  });

  it('a JSON command with a body: path + body assembled, idempotency replayed on the second call through either adapter', async () => {
    const init = { method: 'PUT', headers: { 'content-type': 'application/json', 'idempotency-key': 'adapters-1' }, body: JSON.stringify(SAVE) };
    const first = await fetch(origin + '/api/products/1/master', init);
    assert.strictEqual(first.status, 200);
    assert.deepStrictEqual(await first.json(), { id: 1, name: 'x', price: 1 });
    const replay = await fetchHandler(new Request('http://contract.local/api/products/1/master', init));
    assert.strictEqual(replay.status, 200);
    assert.strictEqual(replay.headers.get('idempotent-replayed'), 'true');
    assert.deepStrictEqual(await replay.json(), { id: 1, name: 'x', price: 1 });
  });

  it('errors are the same JSON through both: 404, 405 with Allow, 415, 400', async () => {
    for (const [path, init, status] of /** @type {[string, RequestInit | undefined, number][]} */ ([
      ['/nope', undefined, 404],
      ['/api/catalog', { method: 'DELETE' }, 405],
      ['/product.remove', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }, 415],
      ['/product.remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' }, 400],
    ])) {
      const { viaNode, viaFetch } = await both(path, init);
      assert.strictEqual(viaNode.status, status, path);
      assert.strictEqual(viaFetch.status, status, path);
      const a = await viaNode.json();
      const b = await viaFetch.json();
      assert.deepStrictEqual(a, b);
      assert.strictEqual(a.requestId, 'fixed-trace');
      if (status === 405) {
        assert.strictEqual(viaNode.headers.get('allow'), 'GET, HEAD');
        assert.strictEqual(viaFetch.headers.get('allow'), 'GET, HEAD');
      }
    }
  });

  it('opaque bytes round-trip byte-equal through both, with the raw content-type', async () => {
    const { viaNode, viaFetch } = await both('/api/images/5');
    assert.strictEqual(viaNode.headers.get('content-type'), 'application/octet-stream');
    const a = new Uint8Array(await viaNode.arrayBuffer());
    const b = new Uint8Array(await viaFetch.arrayBuffer());
    assert.strictEqual(a.length, 300);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(a[0], 5);
    assert.strictEqual(a[1], 12);
  });

  it('HEAD, 304 and 204 carry no body through both', async () => {
    const head = await both('/api/catalog', { method: 'HEAD' });
    assert.strictEqual(head.viaNode.status, 200);
    assert.strictEqual(await head.viaNode.text(), '');
    assert.strictEqual(head.viaFetch.status, 200);
    assert.strictEqual(await head.viaFetch.text(), '');
    assert.ok(Number(head.viaNode.headers.get('content-length')) > 0);
    const notModified = await both('/api/catalog', { headers: { 'if-none-match': 'W/"cat-1"' } });
    assert.strictEqual(notModified.viaNode.status, 304);
    assert.strictEqual(notModified.viaFetch.status, 304);
    assert.strictEqual(await notModified.viaNode.text(), '');
    const noContent = await both('/product.remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":1}' });
    assert.strictEqual(noContent.viaNode.status, 204);
    assert.strictEqual(noContent.viaFetch.status, 204);
    assert.strictEqual(await noContent.viaFetch.text(), '');
  });

  it('the well-known description is served through both', async () => {
    const { viaNode, viaFetch } = await both('/.well-known/jaren-contract');
    const described = await viaNode.json();
    assert.deepStrictEqual(described, await viaFetch.json());
    assert.strictEqual(described.revision, null);
  });

  it('a body on a GET is never read: the request still answers', async () => {
    const r = await fetch(origin + '/api/catalog', { method: 'GET', headers: { 'content-type': 'application/json' }, body: undefined });
    assert.strictEqual(r.status, 200);
  });
});

describe('adapters — the body limit', () => {
  it('413 by declared content-length: the node adapter never reads, the fetch adapter never reads', async () => {
    const big = JSON.stringify({ id: 1, pad: 'x'.repeat(5000) });
    const { viaNode, viaFetch } = await both('/product.remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: big });
    assert.strictEqual(viaNode.status, 413);
    assert.strictEqual(viaFetch.status, 413);
    assert.strictEqual((await viaNode.json()).code, 'JC2003');
    assert.strictEqual((await viaFetch.json()).code, 'JC2003');
  });

  it('413 by stream overflow (chunked, no content-length): the node adapter stops reading and closes the connection', async () => {
    const req = http.request(origin + '/product.remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
    });
    const errors = [];
    req.on('error', (err) => { errors.push(err); });
    const response = new Promise((resolve) => { req.on('response', resolve); });
    // 10 MiB against the operation's 4 KiB limit
    const chunk = Buffer.alloc(64 * 1024, 0x78);
    let written = 0;
    const pump = () => {
      while (written < 10 * 1024 * 1024) {
        written += chunk.length;
        if (!req.write(chunk)) {
          req.once('drain', pump);
          return;
        }
      }
      req.end();
    };
    pump();
    const res = /** @type {http.IncomingMessage} */ (await response);
    assert.strictEqual(res.statusCode, 413);
    assert.strictEqual(res.headers.connection, 'close');
    let text = '';
    for await (const c of res) text += c;
    assert.strictEqual(JSON.parse(text).code, 'JC2003');
    // whatever the socket did to the tail of the upload is not an unhandled error
    req.destroy();
  });

  it('a chunked body within the limit is collected and dispatched; bytes reach the strict decoder (invalid UTF-8 is JC2005)', async () => {
    const ok = await fetch(origin + '/product.remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":7}' });
    assert.strictEqual(ok.status, 204);
    const bad = await fetch(origin + '/product.remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: new Uint8Array([0x7b, 0xff, 0x7d]) });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await bad.json()).code, 'JC2005');
  });
});

describe('adapters — headers and the signal', () => {
  it('repeated header lines reach the dispatcher as arrays through node:http (JC2015 for a scalar member; an array member collects them)', async () => {
    const contract = compileContract({ $contract: '0.1', operations: { a: {
      kind: 'read', input: { type: 'object', properties: { 'x-rev': { type: 'integer' }, 'x-tags': { type: 'array', items: { type: 'string' } } } },
      output: true, http: { method: 'GET', path: '/a', in: { 'x-rev': 'header', 'x-tags': 'header' } } } } });
    const s = http.createServer(toNodeHandler(serveHttp(contract, { a: (input) => input })));
    s.listen(0, '127.0.0.1');
    await once(s, 'listening');
    const port = /** @type {import('node:net').AddressInfo} */ (s.address()).port;
    try {
      const repeated = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/a', headers: { 'x-rev': ['1', '2'] } }, resolve).on('error', reject);
      });
      let text = '';
      for await (const c of /** @type {any} */ (repeated)) text += c;
      assert.strictEqual(/** @type {any} */ (repeated).statusCode, 400);
      assert.strictEqual(JSON.parse(text).code, 'JC2015');
      const collected = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/a', headers: { 'x-tags': ['red', 'blue'], 'x-rev': '3' } }, resolve).on('error', reject);
      });
      text = '';
      for await (const c of /** @type {any} */ (collected)) text += c;
      assert.deepStrictEqual(JSON.parse(text), { 'x-rev': 3, 'x-tags': ['red', 'blue'] });
      // through the fetch adapter the platform combines lines: the array member still collects
      const combined = await toFetchHandler(serveHttp(contract, { a: (input) => input }))(new Request('http://x/a', { headers: [['x-tags', 'red'], ['x-tags', 'blue']] }));
      assert.deepStrictEqual(await combined.json(), { 'x-tags': ['red', 'blue'] });
    }
    finally {
      s.closeAllConnections();
      s.close();
      await once(s, 'close');
    }
  });

  it('a client that goes away aborts ctx.signal', async () => {
    let release = () => {};
    slowGate = new Promise((resolve) => { release = () => resolve(undefined); });
    lastSignal = null;
    try {
      const controller = new AbortController();
      const pending = fetch(origin + '/api/catalog', { signal: controller.signal }).catch((err) => err);
      // wait until the handler holds the signal, then drop the client
      for (let i = 0; i < 200 && lastSignal === null; i++) await new Promise((r) => setTimeout(r, 5));
      assert.ok(lastSignal !== null, 'the handler received a signal');
      const signal = /** @type {AbortSignal} */ (lastSignal);
      assert.strictEqual(signal.aborted, false);
      controller.abort();
      await pending;
      for (let i = 0; i < 200 && !signal.aborted; i++) await new Promise((r) => setTimeout(r, 5));
      assert.strictEqual(signal.aborted, true);
    }
    finally {
      release();
      slowGate = null;
    }
    lastSignal = null;
    // a completed request never aborts its signal
    await fetch(origin + '/api/catalog');
    assert.strictEqual(/** @type {AbortSignal} */ (lastSignal).aborted, false);
  });

  it('the fetch adapter forwards the request signal and refuses a non-dispatcher; so does the node adapter', async () => {
    const controller = new AbortController();
    await fetchHandler(new Request('http://x/api/catalog', { signal: controller.signal }));
    // a Request's signal is a dependent signal of the one given, so identity is not the test: abortion follows
    assert.ok(lastSignal !== null && lastSignal.aborted === false);
    controller.abort();
    assert.strictEqual(/** @type {AbortSignal} */ (lastSignal).aborted, true);
    assert.throws(() => toFetchHandler(/** @type {any} */ ({})), TypeError);
    assert.throws(() => toNodeHandler(/** @type {any} */ (null)), TypeError);
  });

  it('a hand-built minimal request/response pair satisfies the node adapter\'s structural types (headers without headersDistinct)', async () => {
    const handler = toNodeHandler(dispatcher);
    /** @type {any} */
    let written = null;
    /** @type {Record<string, Function>} */
    const listeners = {};
    const req = { method: 'GET', url: '/api/catalog', headers: { host: 'x' }, on: (/** @type {string} */ e, /** @type {Function} */ f) => { listeners[e] = f; } };
    const done = new Promise((resolve) => {
      const res = {
        writeHead: (/** @type {number} */ status, /** @type {any} */ headers) => { written = { status, headers }; },
        end: (/** @type {any} */ body) => { written.body = body; resolve(undefined); },
        on: () => {},
      };
      handler(/** @type {any} */ (req), /** @type {any} */ (res));
    });
    await done;
    assert.strictEqual(written.status, 200);
    assert.strictEqual(written.headers['x-jaren-trace'], 'fixed-trace');
    assert.deepStrictEqual(JSON.parse(written.body), { revision: 1, products: [{ id: 1, name: 'a', price: 1 }] });
  });
});
