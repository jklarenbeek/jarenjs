//@ts-check
/**
 * @file The HTTP server surface's quiet defects, each reproduced before it
 * was fixed:
 *
 * 1. A raw header NAME that is not an HTTP field token passed the binding
 *    (only values were checked). Node then refused it: the adapter answered
 *    an uncoded 500, and the streamed body and the request's leases were
 *    never released.
 * 2. A declared failure `identify` or `acquire` answered lost its
 *    `retryAfterMs`: no `retry-after`, where the handler's own failure
 *    sends one.
 * 3. A declared failure raised mid-stream dropped ALL its params when one
 *    member was not JSON (`hint: undefined`), rendering the generic
 *    message where a request renders the handler's.
 * 4. A server fault on an opaque operation resolved `enter`, so a host
 *    transaction around it committed the work the 500 disowned.
 * 5. A client gone mid-upload made `readBody` reject with the socket's
 *    error rather than the signal's reason, and a handler propagating the
 *    cancellation was observed as a host fault. An aborted signal did not
 *    reject a string, bytes or null body at all.
 * 6. `ctx.fail`'s closed options took a `retryable` that is not a boolean
 *    (`'true'`, `1`) silently, as "defer to the policy".
 * 7. An opaque answer that is not a success carried the armed tag, and the
 *    post-handler conditionals rewrote it: a raw 404 became a 304 (a
 *    cacheable "not modified" for a missing resource) or a 412.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { once } from 'node:events';

import { compileContract, ContractFailure } from '@jarenjs/contract';
import { serveHttp, readBody } from '@jarenjs/contract/http';
import { toNodeHandler, writeNodeResponse } from '@jarenjs/contract/node';
import { toFetchHandler } from '@jarenjs/contract/fetch';
import { req, json } from './helpers.js';

/**
 * A pull source of two chunks that counts its cancels.
 * @param {{ returned: number }} counts
 * @returns {AsyncIterable<Uint8Array>}
 */
function counted(counts) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          return i++ < 2 ? { done: false, value: new Uint8Array([1, 2]) } : { done: true, value: undefined };
        },
        async return() {
          counts.returned += 1;
          return { done: true, value: undefined };
        },
      };
    },
  };
}

/** Wait until a condition holds (bounded). @param {() => boolean} until */
async function wait(until) {
  for (let i = 0; i < 400 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(until(), 'the condition never held');
}

const BLOB = compileContract({ $contract: '0.1', operations: {
  'blob.get': { kind: 'read', output: true, http: { method: 'GET', path: '/blob', media: 'application/octet-stream' } },
  'blob.put': { kind: 'command', output: true, http: { method: 'PUT', path: '/blob', media: 'application/octet-stream' } },
  'note.add': { kind: 'command', input: { type: 'object' }, output: true, http: { method: 'POST', path: '/note' } },
} });

describe('the HTTP server surface — the quiet defects, fixed', () => {
  it('1. a raw header name that is not a field token is JC2010, observed, and the body and both leases are released', async () => {
    const counts = { returned: 0, acquired: 0, identity: 0 };
    /** @type {unknown[]} */
    const seen = [];
    const server = serveHttp(BLOB, {
      'blob.get': () => ({ status: 200, headers: { 'content-type': 'application/octet-stream', 'x bad': 'v' }, body: counted(counts) }),
    }, {
      identify: () => ({ host: null, release: () => { counts.identity += 1; } }),
      acquire: (input, identity, enter) => enter({ host: null, release: () => { counts.acquired += 1; } }),
      onError: (err) => { seen.push(err); },
      partial: true,
    });
    const direct = await server.dispatch(req('GET', '/blob'));
    assert.strictEqual(direct.status, 500);
    assert.strictEqual(json(direct).code, 'JC2010');
    assert.deepStrictEqual(counts, { returned: 1, acquired: 1, identity: 1 });
    assert.match(String(/** @type {Error} */ (seen[0]).message), /"x bad" is not an HTTP field token/);
    // over both adapters the coded answer arrives, with its trace
    const fetched = await toFetchHandler(server)(new Request('http://contract.local/blob'));
    assert.strictEqual(fetched.status, 500);
    assert.strictEqual((await fetched.json()).code, 'JC2010');
    const listener = http.createServer(toNodeHandler(server));
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    try {
      const r = await fetch(`http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (listener.address()).port}/blob`);
      assert.strictEqual(r.status, 500);
      assert.strictEqual((await r.json()).code, 'JC2010');
      assert.match(String(r.headers.get('x-jaren-trace')), /^[0-9a-f-]{36}$/);
    }
    finally {
      listener.closeAllConnections();
      listener.close();
      await once(listener, 'close');
    }
  });

  it('1b. an answer Node refuses to write releases its streamed body before the plain 500', async () => {
    const counts = { returned: 0 };
    const listener = http.createServer((request, response) => {
      writeNodeResponse(response, { status: 200, headers: { 'x bad': 'v' }, body: counted(counts) });
    });
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    try {
      const r = await fetch(`http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (listener.address()).port}/`);
      assert.strictEqual(r.status, 500);
      assert.strictEqual(await r.text(), 'the response could not be written');
      await wait(() => counts.returned === 1);
    }
    finally {
      listener.closeAllConnections();
      listener.close();
      await once(listener, 'close');
    }
  });

  it('2. a retryable declared failure from identify or acquire carries retry-after, as the handler\'s does', async () => {
    const contract = compileContract({ $contract: '0.1', operations: {
      'note.get': { kind: 'read', output: true, errors: { 'rate-limited': { status: 429 } }, http: { method: 'GET', path: '/note' } },
    } });
    const fail = (/** @type {any} */ make) => make('rate-limited', {}, undefined, { retryable: true, retryAfterMs: 30_000 });
    const byIdentify = serveHttp(contract, { 'note.get': () => true }, { identify: (meta) => fail(meta.fail) });
    const byAcquire = serveHttp(contract, { 'note.get': () => true }, { acquire: () => fail(ContractFailure) });
    const byHandler = serveHttp(contract, { 'note.get': (input, ctx) => fail(ctx.fail) });
    for (const server of [byIdentify, byAcquire, byHandler]) {
      const r = await server.dispatch(req('GET', '/note'));
      assert.strictEqual(r.status, 429);
      assert.strictEqual(r.headers['retry-after'], '30');
      assert.strictEqual(json(r).retryable, true);
    }
  });

  it('3. a mid-stream declared failure renders its params though a member is not JSON, exactly as on a request', async () => {
    const feed = compileContract({ $contract: '0.1', operations: {
      'room.feed': { kind: 'subscribe', output: { type: 'object', required: ['rows'], properties: { rows: { type: 'array' } } },
        errors: { stale: { status: 409 } }, http: { method: 'GET', path: '/feed' } },
    } });
    /** @type {Set<(emission: any) => void>} */
    const cbs = new Set();
    const sub = { result: { rows: [] }, subscribe: (/** @type {any} */ cb) => { cbs.add(cb); return () => cbs.delete(cb); }, close() {} };
    const server = serveHttp(feed, { 'room.feed': () => sub },
      { catalog: { 'contract/handler-error': (/** @type {any} */ p) => p.message ?? `operation ${p.op} failed with ${p.code}` } });
    const response = await toFetchHandler(server)(new Request('http://contract.local/feed', { headers: { accept: 'text/event-stream' } }));
    const reader = /** @type {NonNullable<typeof response.body>} */ (response.body).getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: snapshot')) text += decoder.decode((await reader.read()).value, { stream: true });
    for (const cb of [...cbs]) cb({ error: ContractFailure('stale', { message: 'the catalog moved on', hint: undefined, at: new Date(0) }) });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    const match = /event: error\ndata: (.*)\n\n/.exec(text);
    assert.ok(match !== null, text);
    assert.strictEqual(JSON.parse(match[1]).message, 'the catalog moved on');
  });

  it('4. a server fault on an opaque operation rolls the host transaction back, as on a JSON one; a success commits', async () => {
    /** @type {string[]} */
    let log = [];
    const acquire = (/** @type {unknown} */ input, /** @type {unknown} */ identity, /** @type {(lease: any) => any} */ enter) => {
      /** @type {{ writes: string[] }} */
      const tx = { writes: [] };
      return Promise.resolve(enter({ host: tx })).then(
        (v) => { log.push(`commit ${tx.writes.join(',')}`); return v; },
        (e) => { log.push(`rollback ${tx.writes.join(',')}`); throw e; });
    };
    let mode = 'throw';
    const server = serveHttp(BLOB, {
      'blob.put': (i, ctx) => { /** @type {any} */ (ctx.host).writes.push('raw-row'); if (mode === 'throw') throw new Error('after the write'); return { status: 204 }; },
      'blob.get': (i, ctx) => { /** @type {any} */ (ctx.host).writes.push('raw-read'); return { status: 200, headers: { etag: '"other"' }, body: new Uint8Array([1]) }; },
      'note.add': (i, ctx) => { /** @type {any} */ (ctx.host).writes.push('json-row'); throw new Error('after the write'); },
    }, { acquire, preconditions: { 'blob.get': () => 'v1' }, onError: () => {} });
    const cases = /** @type {[any, string][]} */ ([
      [req('POST', '/note', { 'content-type': 'application/json' }, '{}'), 'rollback json-row'],
      [req('PUT', '/blob', { 'content-type': 'application/octet-stream' }, new Uint8Array([1])), 'rollback raw-row'],
      [req('GET', '/blob'), 'rollback raw-read'],
    ]);
    for (const [request, expected] of cases) {
      log = [];
      const r = await server.dispatch(request);
      assert.strictEqual(r.status, 500, expected);
      assert.strictEqual(json(r).code, 'JC2008');
      assert.deepStrictEqual(log, [expected]);
    }
    mode = 'ok';
    log = [];
    const ok = await server.dispatch(req('PUT', '/blob', { 'content-type': 'application/octet-stream' }, new Uint8Array([1])));
    assert.strictEqual(ok.status, 204);
    assert.deepStrictEqual(log, ['commit raw-row']);
  });

  it('5. readBody rejects with the signal\'s reason when the peer went away, and the propagated cancellation is not observed', async () => {
    const controller = new AbortController();
    const why = new Error('client gone');
    /** @type {AsyncIterable<Uint8Array>} */
    const dropping = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            controller.abort(why);
            throw new Error('ECONNRESET');
          },
        };
      },
    };
    await assert.rejects(readBody(dropping, { signal: controller.signal }), (err) => err === why);
    // an already-aborted signal rejects every body shape with its reason
    for (const body of ['text', new Uint8Array([1]), null]) {
      await assert.rejects(readBody(body, { as: 'text', signal: controller.signal }), (err) => err === why);
    }
    // through the dispatcher: the peer's cancellation answers, unobserved;
    // an unrelated fault under an aborted signal is still observed
    /** @type {unknown[]} */
    const seen = [];
    let mode = 'read';
    const server = serveHttp(BLOB, {
      'blob.put': async (i, ctx) => {
        if (mode === 'read') await readBody(/** @type {any} */ (ctx).body, { signal: ctx.signal });
        else throw new Error('a bug of the handler');
        return { status: 204 };
      },
      'note.add': (i, ctx) => { throw /** @type {AbortSignal} */ (ctx.signal).reason; },
    }, { onError: (err) => { seen.push(err); }, partial: true });
    /** @param {any} body */
    const drop = (body) => {
      const peer = new AbortController();
      peer.abort(new Error('the peer went away'));
      return { method: 'PUT', url: '/blob', headers: { 'content-type': 'application/octet-stream' }, body, signal: peer.signal };
    };
    const cancelled = await server.dispatch(drop(new Uint8Array([1])));
    assert.strictEqual(cancelled.status, 500);
    assert.deepStrictEqual(seen, [], 'the peer\'s cancellation is not a host fault');
    const peer = new AbortController();
    peer.abort(new Error('gone'));
    await server.dispatch({ ...req('POST', '/note', { 'content-type': 'application/json' }, '{}'), signal: peer.signal });
    assert.deepStrictEqual(seen, [], 'a JSON handler propagating the cancellation is not observed either');
    mode = 'bug';
    await server.dispatch(drop(new Uint8Array([1])));
    assert.strictEqual(seen.length, 1, 'a fault that is not the cancellation is observed');
  });

  it('6. ctx.fail\'s retryable is a boolean: a string or a number is a TypeError; null defers to the policy', () => {
    for (const retryable of ['true', 1, {}]) {
      assert.throws(() => ContractFailure('busy', {}, undefined, /** @type {any} */ ({ retryable })), TypeError);
    }
    assert.strictEqual(ContractFailure('busy', {}, undefined, /** @type {any} */ ({ retryable: null })).retryable, null);
    assert.strictEqual(ContractFailure('busy', {}, undefined, { retryable: false }).retryable, false);
  });

  it('7. an opaque answer that is not a success carries no armed tag, and the conditionals never rewrite it', async () => {
    const contract = compileContract({ $contract: '0.1', operations: {
      'img.get': { kind: 'read', output: true, http: { method: 'GET', path: '/img/{id}', media: 'image/png' },
        input: { type: 'object', properties: { id: { type: 'string' } } } },
    } });
    /** @param {number} status */
    const answer = (status) => ({ status, headers: { 'content-type': 'text/plain' }, body: status === 304 ? null : 'answer' });
    let status = 404;
    const resolved = serveHttp(contract, { 'img.get': () => answer(status) }, { preconditions: { 'img.get': () => 'v7' } });
    for (const s of [404, 500, 302]) {
      status = s;
      const r = await resolved.dispatch(req('GET', '/img/a'));
      assert.strictEqual(r.status, s);
      assert.strictEqual(r.headers.etag, undefined, `a raw ${s} describes no representation`);
    }
    status = 304;
    assert.strictEqual((await resolved.dispatch(req('GET', '/img/a'))).headers.etag, '"v7"', 'a 304 the handler answered carries the tag');
    const armed = serveHttp(contract, { 'img.get': (i, ctx) => { ctx.etag('v7', { strong: true }); return answer(404); } });
    for (const conditional of [{ 'if-none-match': '"v7"' }, { 'if-match': '"v6"' }]) {
      const r = await armed.dispatch(req('GET', '/img/a', conditional));
      assert.strictEqual(r.status, 404, JSON.stringify(conditional));
      assert.strictEqual(r.body, 'answer');
    }
  });
});
