//@ts-check
/**
 * @file The contract binding's quiet defects, each reproduced before it
 * was fixed:
 *
 * 1. `ctx.status(204)` over an output that never admits null: the value
 *    was dropped after the handler committed, and the client reported the
 *    missing value as a contract violation (JC2053).
 * 2. A header value holding a control character or DEL passed the
 *    client's check, then undici refused it as it sent: a retryable
 *    network error, retried, with a stored key left behind.
 * 3. An empty item of an array header member vanished (a header list
 *    drops empty elements).
 * 4. A header member named after a field the transport or the binding
 *    writes itself compiled, then failed every call or was replaced.
 * 5. HEAD on a GET-bound command answered `Allow: GET` although the path
 *    serves other methods.
 * 6. A refused raw 204 left its pull source open.
 * 7. A handler fault after the local caller's abort was never observed.
 * 8. A command could be bound to HEAD, and a HEAD then executed it and
 *    settled its idempotency claim; a declared HEAD answered a body.
 * 9. A handler header Node cannot write crashed the process through an
 *    unhandled rejection, and hung the request.
 * 10. `bytes()` sent a body on GET (a network error) and OPTIONS
 *    (silently dropped).
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
import { openLocalClient } from '@jarenjs/contract/local';
import { req } from './helpers.js';

const coded = (/** @type {string} */ code) => (/** @type {any} */ e) => e?.code === code;
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A client whose fetch counts calls and never reaches a network. */
function counted(/** @type {any} */ contract) {
  const calls = { n: 0 };
  const client = openHttpClient(contract, { fetch: async () => { calls.n++; return new Response('true', { status: 200 }); }, sleep: async () => {} });
  return { client, calls };
}

describe('the binding refuses what it cannot answer or carry', () => {
  it('1. ctx.status(204|205) is refused over an output that never admits null, and allowed over one that does', async () => {
    const contract = compileContract({ $contract: '0.1', operations: {
      'thing.save': { kind: 'command', output: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } }, http: { method: 'POST', path: '/things' } },
      'thing.drop': { kind: 'command', output: true, http: { method: 'POST', path: '/drop' } },
    } });
    /** @type {string[]} */
    const seen = [];
    const server = serveHttp(contract, {
      'thing.save': (_i, ctx) => {
        for (const status of [204, 205]) {
          try { ctx.status(status); seen.push(`${status} allowed`); } catch (e) { seen.push(`${status} ${/** @type {any} */ (e).code}`); }
        }
        return { id: 7 };
      },
      'thing.drop': (_i, ctx) => { ctx.status(204); return null; },
    });
    const saved = await server.dispatch(req('POST', '/things', { 'content-type': 'application/json' }, '{}'));
    assert.deepStrictEqual(seen, ['204 JC1006', '205 JC1006']);
    assert.strictEqual(saved.status, 200, 'the value is answered, not dropped');
    const dropped = await server.dispatch(req('POST', '/drop', { 'content-type': 'application/json' }, '{}'));
    assert.strictEqual(dropped.status, 204);
  });

  it('2–3. a header value with a control character or DEL, and an empty list item, are JC2050 before anything is sent', async () => {
    const contract = compileContract({ $contract: '0.1', operations: { 'doc.tag': { kind: 'command',
      input: { type: 'object', properties: { tenant: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } },
      output: true, policy: { idempotency: 'required', retry: { max: 2, on: [] } },
      http: { method: 'POST', path: '/tag', in: { tenant: 'header', tags: 'header' } } } } });
    const { client, calls } = counted(contract);
    for (const tenant of ['a\u0001b', 'a\u001bb', 'a\u007fb']) {
      const out = await client.invoke('doc.tag', { tenant });
      assert.ok(!out.ok && out.error.code === 'JC2050', JSON.stringify(tenant));
      if (!out.ok) assert.deepStrictEqual(out.error.details, [{ path: '/tenant', keyword: 'encoding' }]);
    }
    for (const tags of [['a', '', 'b'], ['']]) {
      const out = await client.invoke('doc.tag', { tags });
      assert.ok(!out.ok && out.error.code === 'JC2050', JSON.stringify(tags));
      if (!out.ok) assert.deepStrictEqual(out.error.details, [{ path: '/tags', keyword: 'encoding' }]);
    }
    assert.strictEqual(calls.n, 0, 'nothing reached fetch');
    assert.strictEqual((await client.invoke('doc.tag', { tenant: 'tab\there é', tags: ['a', 'b'] })).ok, true, 'tab and Latin-1 travel');
  });

  it('4. a header member named after a field the transport or the binding writes is refused at compile (JC0009)', () => {
    for (const name of ['upgrade', 'Expect', 'keep-alive', 'transfer-encoding', 'content-length', 'connection', 'host',
      'accept', 'Content-Type', 'idempotency-key', 'if-match', 'if-none-match', 'last-event-id']) {
      assert.throws(() => compileContract({ $contract: '0.1', operations: { op: { kind: 'command',
        input: { type: 'object', properties: { [name]: { type: 'string' } } }, output: true,
        http: { method: 'POST', path: '/op', in: { [name]: 'header' } } } } }),
      (/** @type {any} */ e) => e.code === 'JC0009' && e.docPath === `/operations/op/http/in/${name}`, name);
    }
  });

  it('5. HEAD on a GET-bound command answers 405 whose Allow lists the methods the path serves', async () => {
    const contract = compileContract({ $contract: '0.1', operations: {
      'links.get': { kind: 'command', input: { type: 'object', required: ['t'], properties: { t: { type: 'string' } } }, output: true, http: { method: 'GET', path: '/links/{t}' } },
      'links.del': { kind: 'command', input: { type: 'object', required: ['t'], properties: { t: { type: 'string' } } }, output: true, http: { method: 'DELETE', path: '/links/{t}' } },
    } });
    /** @type {string[]} */
    const ran = [];
    const server = serveHttp(contract, { 'links.get': () => { ran.push('get'); return true; }, 'links.del': () => { ran.push('del'); return true; } });
    const head = await server.dispatch(req('HEAD', '/links/abc'));
    assert.strictEqual(head.status, 405);
    assert.strictEqual(head.headers.allow, 'DELETE, GET');
    assert.deepStrictEqual(ran, []);
  });

  it('6. a raw 204 answering a pull source is JC2010 and the source is released', async () => {
    const contract = compileContract({ $contract: '0.1', operations: { 'blob.put': { kind: 'command', output: true, http: { method: 'PUT', path: '/blob', media: 'application/octet-stream' } } } });
    let released = false;
    const empty = { [Symbol.asyncIterator]() { return { next: async () => ({ done: true, value: undefined }), return: async () => { released = true; return { done: true, value: undefined }; } }; } };
    const server = serveHttp(contract, { 'blob.put': () => ({ status: 204, body: empty }) }, { onError: () => {} });
    const out = await server.dispatch(req('PUT', '/blob'));
    assert.strictEqual(out.status, 500);
    assert.strictEqual(JSON.parse(/** @type {string} */ (out.body)).code, 'JC2010');
    await sleep(0);
    assert.strictEqual(released, true, 'the refused source was released');
  });

  it('7. a local handler fault after the caller aborted still reaches onError', async () => {
    const contract = compileContract({ $contract: '0.1', operations: { 'slow.write': { kind: 'command', output: true } } });
    /** @type {string[]} */
    const errors = [];
    const client = openLocalClient(contract, { 'slow.write': async () => { await sleep(40); throw new Error('late fault'); } },
      { onError: (/** @type {any} */ e) => errors.push(e?.message) });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const out = await client.invoke('slow.write', undefined, { signal: controller.signal });
    assert.strictEqual(out.ok, false);
    await sleep(80);
    assert.deepStrictEqual(errors, ['late fault']);
  });

  it('8. a command cannot be bound to HEAD (JC0012); a declared HEAD read answers without a body', async () => {
    assert.throws(() => compileContract({ $contract: '0.1', operations: { 'mark.head': { kind: 'command', output: true,
      http: { method: 'HEAD', path: '/mark' } } } }), (/** @type {any} */ e) => e.code === 'JC0012' && e.docPath === '/operations/mark.head/http/method');
    const contract = compileContract({ $contract: '0.1', operations: { 'a.head': { kind: 'read', output: true, http: { method: 'HEAD', path: '/a' } } } });
    const server = serveHttp(contract, { 'a.head': () => ({ big: 'x' }) });
    const head = await server.dispatch(req('HEAD', '/a'));
    assert.strictEqual(head.status, 200);
    assert.strictEqual(head.body, null);
  });

  it('9. a handler header Node cannot write is JC1006 and a 500, on every adapter, and never an unhandled rejection', async () => {
    const contract = compileContract({ $contract: '0.1', operations: {
      'note.read': { kind: 'read', output: true, http: { method: 'GET', path: '/note' } },
      'blob.get': { kind: 'read', output: true, http: { method: 'GET', path: '/blob', media: 'application/octet-stream' } },
    } });
    /** @type {string[]} */
    const codes = [];
    const server = serveHttp(contract, {
      'note.read': (_i, ctx) => {
        try { ctx.header('x-note', 'café €'); } catch (e) { codes.push(/** @type {any} */ (e).code); throw e; }
        return true;
      },
      'blob.get': () => ({ status: 200, headers: { 'x-note': 'line\u0001' }, body: 'b' }),
    }, { onError: () => {} });
    /** @type {unknown[]} */
    const unhandled = [];
    const onUnhandled = (/** @type {unknown} */ e) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    const node = http.createServer(toNodeHandler(server));
    node.listen(0, '127.0.0.1');
    await once(node, 'listening');
    try {
      const port = /** @type {import('node:net').AddressInfo} */ (node.address()).port;
      for (const path of ['/note', '/blob']) {
        assert.strictEqual((await server.dispatch(req('GET', path))).status, 500, path);
        assert.strictEqual((await toFetchHandler(server)(new Request(`http://x${path}`))).status, 500, path);
        const status = await new Promise((resolve) => {
          const rq = http.request({ host: '127.0.0.1', port, method: 'GET', path }, (res) => { res.resume(); resolve(res.statusCode); });
          rq.on('error', (e) => resolve(e.message));
          rq.end();
        });
        assert.strictEqual(status, 500, path);
      }
      assert.deepStrictEqual(codes, ['JC1006', 'JC1006', 'JC1006']);
      await sleep(10);
      assert.deepStrictEqual(unhandled, []);
    }
    finally {
      process.off('unhandledRejection', onUnhandled);
      node.closeAllConnections();
      node.close();
    }
  });

  it('10. bytes() refuses a body on an operation bound to GET, HEAD or OPTIONS (JC1008) and sends nothing', async () => {
    const contract = compileContract({ $contract: '0.1', operations: {
      'blob.get': { kind: 'read', output: true, http: { method: 'GET', path: '/g', media: 'application/octet-stream' } },
      'blob.opt': { kind: 'command', output: true, http: { method: 'OPTIONS', path: '/o', media: 'application/octet-stream' } },
      'blob.put': { kind: 'command', output: true, http: { method: 'PUT', path: '/p', media: 'application/octet-stream' } },
    } });
    const { client, calls } = counted(contract);
    for (const op of ['blob.get', 'blob.opt']) {
      await assert.rejects(client.bytes(op, undefined, { body: new Uint8Array([1]) }), coded('JC1008'), op);
    }
    assert.strictEqual(calls.n, 0);
    assert.strictEqual((await client.bytes('blob.get', undefined, {})).ok, true, 'a bodiless GET still goes');
    assert.strictEqual((await client.bytes('blob.put', undefined, { body: new Uint8Array([1]) })).ok, true, 'a PUT carries its body');
  });
});

describe('the ledger is untouched by a refused answer', () => {
  it('a ctx.status refusal fails the command before anything is recorded as done', async () => {
    const contract = compileContract({ $contract: '0.1', operations: { 'thing.save': { kind: 'command',
      output: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } }, policy: { idempotency: 'required' },
      http: { method: 'POST', path: '/things' } } } });
    let runs = 0;
    const server = serveHttp(contract, { 'thing.save': (_i, ctx) => { runs++; ctx.status(204); return { id: 7 }; } }, { ledger: createMemoryLedger(), onError: () => {} });
    const first = await server.dispatch(req('POST', '/things', { 'content-type': 'application/json', 'idempotency-key': 'k1' }, '{}'));
    assert.strictEqual(first.status, 500);
    assert.strictEqual(runs, 1);
  });
});
