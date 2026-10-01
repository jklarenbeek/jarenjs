//@ts-check
/**
 * @file The binding never runs an operation the caller did not name,
 * never executes or settles a command from a HEAD, carries every declared
 * member on every client method, keeps the host's transaction open until
 * the handler is done, and refuses — at compile, at construction or
 * before sending — every declaration or value it cannot honour. Each
 * block is a reproduced defect:
 *
 * 1. `invoke('user.delete', { id: '..' })` built `/api/users/../sessions`,
 *    which fetch folds to `/api/sessions` — ANOTHER operation ran, and the
 *    client reported `ok: true`. A raw adapter bound `..` as the id.
 * 2. HEAD on a GET-bound command ran it and settled its idempotency claim
 *    bodyless; the next GET replayed headers without a body (and hung
 *    over the node adapter).
 * 3. `subscribe` sent no header-located member (JC2006 server-side).
 * 4. The local binding resolved `enter` at the caller's abort: the host
 *    transaction committed while the handler was still writing.
 * 5. An opaque command's `idempotency: 'required'` compiled, was
 *    advertised, demanded a ledger — and was never enforced.
 * 6. The well-known path listed server-audience operations to anyone.
 * 7. Values and declarations the transport cannot carry were accepted and
 *    then failed as `network` (retried), were split wrongly, or dropped.
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
import { serveLocal } from '@jarenjs/contract/local';
import { servePort, openPortClient } from '@jarenjs/contract/port';
import { toOpenApi } from '@jarenjs/contract/project';
import { req, json } from './helpers.js';

const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

const SAFETY = compileContract({
  $contract: '0.1',
  id: 'safety',
  version: '1.0.0',
  operations: {
    'user.delete': { kind: 'command', input: ID, output: true, http: { method: 'DELETE', path: '/api/users/{id}/sessions' } },
    'api.sessions': { kind: 'command', output: true, http: { method: 'DELETE', path: '/api/sessions' } },
    'invite.redeem': {
      kind: 'command',
      input: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } },
      output: { type: 'object', required: ['redeemed'], properties: { redeemed: { type: 'string' } } },
      policy: { idempotency: 'required' },
      http: { method: 'GET', path: '/invites/{code}/redeem' },
    },
    'catalog.read': { kind: 'read', output: { type: 'object' }, http: { method: 'GET', path: '/catalog' } },
    'feed.watch': {
      kind: 'subscribe',
      input: { type: 'object', required: ['tenant'], properties: { tenant: { type: 'string' } } },
      output: { type: 'object' },
      http: { method: 'GET', path: '/feed', in: { tenant: 'header' } },
    },
    'doc.tag': {
      kind: 'command',
      input: { type: 'object', properties: { tenant: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } },
      output: true,
      policy: { idempotency: 'optional' },
      http: { method: 'POST', path: '/tag', in: { tenant: 'header', tags: 'header' } },
    },
    'admin.purge': { kind: 'command', output: true, policy: { audience: 'server' }, http: { method: 'POST', path: '/internal/purge-all' } },
  },
});

/** @param {string[]} ran */
function handlers(ran) {
  return {
    'user.delete': (/** @type {any} */ input) => { ran.push(`user.delete:${input.id}`); return null; },
    'api.sessions': () => { ran.push('api.sessions'); return null; },
    'invite.redeem': (/** @type {any} */ input) => { ran.push(`invite.redeem:${input.code}`); return { redeemed: input.code }; },
    'catalog.read': () => ({ items: 3 }),
    'feed.watch': () => ({ get result() { return { live: true }; }, subscribe: () => () => {}, close: () => {} }),
    'doc.tag': (/** @type {any} */ input) => { ran.push(`doc.tag:${JSON.stringify(input)}`); return null; },
    'admin.purge': () => { ran.push('admin.purge'); return null; },
  };
}

/** A client whose fetch reaches the server through the fetch adapter, recording what it sent. */
function fetchPair(options = {}) {
  /** @type {string[]} */
  const ran = [];
  const server = serveHttp(SAFETY, handlers(ran), { ledger: createMemoryLedger(), ...options });
  const handler = toFetchHandler(server);
  /** @type {{ url: string, init: any }[]} */
  const sent = [];
  const client = openHttpClient(SAFETY, {
    fetch: async (url, init) => { sent.push({ url, init }); return handler(new Request(`http://x${url}`, init)); },
  });
  return { server, client, sent, ran };
}

/**
 * A real node server over the node adapter; `request` sends a RAW path
 * (node's http client never normalizes dot segments).
 * @param {any} server
 */
async function nodeServer(server) {
  const listener = http.createServer(toNodeHandler(server));
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = /** @type {any} */ (listener.address());
  /** @param {string} method @param {string} path @param {Record<string, string>} [headers] */
  const request = (method, path, headers = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.setTimeout(2000, () => r.destroy(new Error('timed out')));
    r.on('error', reject);
    r.end();
  });
  return { request, close: () => new Promise((resolve) => listener.close(resolve)) };
}

/** @param {string} code */
const coded = (code) => (/** @type {any} */ error) => error?.code === code;

describe('1. a path variable never becomes a dot segment', () => {
  it('the client refuses an empty, `.` or `..` value before sending, on invoke and url()', async () => {
    const { client, sent, ran } = fetchPair();
    for (const id of ['..', '.', '']) {
      const outcome = await client.invoke('user.delete', { id });
      assert.strictEqual(outcome.ok, false);
      assert.strictEqual(/** @type {any} */ (outcome).kind, 'contract', `id ${JSON.stringify(id)}`);
      assert.strictEqual(/** @type {any} */ (outcome).error.code, 'JC2050');
      assert.throws(() => client.url('user.delete', { id }), coded('JC1008'));
    }
    assert.deepStrictEqual(sent, [], 'nothing was sent');
    assert.deepStrictEqual(ran, [], 'no operation ran — api.sessions least of all');
    // an ordinary value still travels, dots and all
    assert.strictEqual((await client.invoke('user.delete', { id: 'a.b' })).ok, true);
    assert.deepStrictEqual(ran, ['user.delete:a.b']);
  });

  it('the router refuses a routed segment that decodes to `.` or `..` (400 JC2011) — raw through the node adapter, and encoded', async () => {
    /** @type {string[]} */
    const ran = [];
    const server = serveHttp(SAFETY, handlers(ran), { ledger: createMemoryLedger() });
    for (const path of ['/api/users/../sessions', '/api/users/%2e%2e/sessions', '/api/users/./sessions', '/api/users/.%2E/sessions']) {
      const response = await server.dispatch(req('DELETE', path));
      assert.strictEqual(response.status, 400, path);
      assert.strictEqual(json(response).code, 'JC2011', path);
    }
    const node = await nodeServer(server);
    try {
      const raw = /** @type {any} */ (await node.request('DELETE', '/api/users/../sessions'));
      assert.strictEqual(raw.status, 400);
      assert.strictEqual(JSON.parse(raw.body).code, 'JC2011');
    }
    finally { await node.close(); }
    assert.deepStrictEqual(ran, []);
  });
});

describe('2. HEAD never executes or settles a command', () => {
  it('HEAD on a GET-bound command is 405 allow GET and runs nothing; the GET with the same key then executes', async () => {
    const { server, ran } = fetchPair();
    const head = await server.dispatch(req('HEAD', '/invites/abc/redeem', { 'idempotency-key': 'k1' }));
    assert.strictEqual(head.status, 405);
    assert.strictEqual(head.headers.allow, 'GET');
    assert.deepStrictEqual(ran, []);
    const get = await server.dispatch(req('GET', '/invites/abc/redeem', { 'idempotency-key': 'k1' }));
    assert.strictEqual(get.status, 200);
    assert.strictEqual(get.headers['idempotent-replayed'], undefined);
    assert.deepStrictEqual(json(get), { redeemed: 'abc' });
    assert.deepStrictEqual(ran, ['invite.redeem:abc']);
    // a read still answers HEAD, bodyless; another method's 405 lists HEAD only beside a read
    const headRead = await server.dispatch(req('HEAD', '/catalog'));
    assert.strictEqual(headRead.status, 200);
    assert.strictEqual(headRead.body, null);
    assert.strictEqual((await server.dispatch(req('POST', '/invites/abc/redeem'))).headers.allow, 'GET');
    assert.strictEqual((await server.dispatch(req('POST', '/catalog'))).headers.allow, 'GET, HEAD');
  });

  it('over the node and fetch adapters: HEAD refused, the GET after it answers its body', async () => {
    const { server, ran } = fetchPair();
    const node = await nodeServer(server);
    try {
      const head = /** @type {any} */ (await node.request('HEAD', '/invites/n1/redeem', { 'idempotency-key': 'k2' }));
      assert.strictEqual(head.status, 405);
      const get = /** @type {any} */ (await node.request('GET', '/invites/n1/redeem', { 'idempotency-key': 'k2' }));
      assert.strictEqual(get.status, 200);
      assert.deepStrictEqual(JSON.parse(get.body), { redeemed: 'n1' });
    }
    finally { await node.close(); }
    const fetchHandler = toFetchHandler(server);
    const head = await fetchHandler(new Request('http://x/invites/f1/redeem', { method: 'HEAD', headers: { 'idempotency-key': 'k3' } }));
    assert.strictEqual(head.status, 405);
    const get = await fetchHandler(new Request('http://x/invites/f1/redeem', { headers: { 'idempotency-key': 'k3' } }));
    assert.deepStrictEqual(await get.json(), { redeemed: 'f1' });
    assert.deepStrictEqual(ran, ['invite.redeem:n1', 'invite.redeem:f1']);
  });
});

describe('3. subscribe carries header-located members', () => {
  it('a required header member reaches the server and the stream starts (no JC2006)', async () => {
    const { client, sent } = fetchPair();
    /** @type {any[]} */
    const snapshots = [];
    /** @type {any[]} */
    const errors = [];
    const sub = client.subscribe('feed.watch', { tenant: 'acme' },
      { onSnapshot: (value) => snapshots.push(value), onError: (error) => errors.push(error) });
    for (let i = 0; i < 200 && snapshots.length === 0 && errors.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    sub.stop();
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(snapshots[0], { live: true });
    assert.strictEqual(sent[0].init.headers.tenant, 'acme');
    assert.strictEqual(sent[0].init.headers.accept, 'text/event-stream');
  });
});

describe('4. the local binding keeps the host transaction open until the handler settles', () => {
  const contract = compileContract({ $contract: '0.1', operations: { 'slow.write': { kind: 'command', output: true } } });
  /** @param {() => Promise<any>} body */
  const hosted = (body) => {
    /** @type {string[]} */
    const events = [];
    const client = serveLocal(contract, { 'slow.write': async () => body().then((v) => { events.push('handler settled'); return v; }, (e) => { events.push('handler faulted'); throw e; }) }, {
      acquire: (_input, _identity, enter) => {
        events.push('begin');
        return enter({ host: {} }).then((v) => { events.push('commit'); return v; }, (e) => { events.push('rollback'); throw e; });
      },
    });
    return { client, events };
  };
  const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

  it('a caller abort answers JC2052 at once, and the commit waits for the handler', async () => {
    const { client, events } = hosted(async () => { await sleep(60); return null; });
    const controller = new AbortController();
    const running = client.invoke('slow.write', undefined, { signal: controller.signal });
    setTimeout(() => controller.abort(), 15);
    const outcome = /** @type {any} */ (await running);
    assert.strictEqual(outcome.kind, 'cancelled');
    assert.strictEqual(outcome.error.code, 'JC2052');
    assert.deepStrictEqual(events, ['begin'], 'nothing committed at the abort');
    for (let i = 0; i < 100 && !events.includes('commit'); i++) await sleep(5);
    assert.deepStrictEqual(events, ['begin', 'handler settled', 'commit']);
  });

  it('a handler fault after the abort still rolls the host transaction back', async () => {
    const { client, events } = hosted(async () => { await sleep(40); throw new Error('late fault'); });
    const controller = new AbortController();
    const running = client.invoke('slow.write', undefined, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    assert.strictEqual(/** @type {any} */ (await running).kind, 'cancelled');
    for (let i = 0; i < 100 && !events.includes('rollback'); i++) await sleep(5);
    assert.deepStrictEqual(events, ['begin', 'handler faulted', 'rollback']);
  });
});

describe('5. an opaque operation owns its own idempotency and retry (JC0022)', () => {
  const opaque = (/** @type {any} */ policy, kind = 'command') => ({
    $contract: '0.1',
    operations: { 'file.put': { kind, output: true, policy, http: { method: kind === 'read' ? 'GET' : 'PUT', path: '/files', media: 'application/octet-stream' } } },
  });
  it('compile refuses idempotency other than none, and any retry, on an opaque operation', () => {
    assert.throws(() => compileContract(opaque({ idempotency: 'required' })),
      (/** @type {any} */ e) => e.code === 'JC0022' && e.docPath === '/operations/file.put/policy/idempotency');
    assert.throws(() => compileContract(opaque({ idempotency: 'optional' })), coded('JC0022'));
    assert.throws(() => compileContract(opaque({ retry: { max: 1, on: [] } }, 'read')),
      (/** @type {any} */ e) => e.code === 'JC0022' && e.docPath === '/operations/file.put/policy/retry');
    const plain = compileContract(opaque({ idempotency: 'none' }));
    const operation = /** @type {any} */ (toOpenApi(plain)).document.paths['/files'].put;
    assert.ok(!(operation.parameters ?? []).some((/** @type {any} */ p) => /idempotency-key/i.test(p.name)),
      'OpenAPI advertises no key for an opaque operation');
    assert.strictEqual(operation.responses['409'], undefined, 'nor the 409 a key would answer');
  });
});

describe('6. the well-known path serves the public description', () => {
  it('lists no server-audience operation, and negotiation still succeeds', async () => {
    const { server, client } = fetchPair();
    const response = await server.dispatch(req('GET', '/.well-known/jaren-contract'));
    const ids = json(response).operations.map((/** @type {any} */ op) => op.id);
    assert.ok(!ids.includes('admin.purge'));
    assert.ok(ids.includes('user.delete'));
    const negotiated = await client.negotiate();
    assert.strictEqual(negotiated.compatible, true);
  });
});

describe('7. what the transport cannot carry is refused before it is sent or compiled', () => {
  it('a header value fetch cannot carry, or an array item with a comma or edge whitespace, is JC2050 with no attempt and no pending key', async () => {
    /** @type {any} */
    let stored;
    const storage = { read: () => stored, write: (/** @type {any} */ v) => { stored = JSON.parse(JSON.stringify(v)); } };
    const { client, sent, ran } = fetchPair();
    const durable = openHttpClient(SAFETY, { storage, fetch: async () => { throw new Error('never reached'); } });
    for (const input of [{ tenant: '€uro' }, { tenant: 'a\r\nb' }, { tags: ['Doe, John'] }, { tags: [' padded '] }]) {
      const outcome = /** @type {any} */ (await client.invoke('doc.tag', input));
      assert.strictEqual(outcome.kind, 'contract', JSON.stringify(input));
      assert.strictEqual(outcome.error.code, 'JC2050');
      assert.strictEqual((/** @type {any} */ (await durable.invoke('doc.tag', input))).error.code, 'JC2050');
    }
    assert.deepStrictEqual(sent, []);
    assert.deepStrictEqual(await durable.pending(), [], 'no durable key was written for a refused call');
    // what does travel, travels intact
    assert.strictEqual((await client.invoke('doc.tag', { tenant: 'acme', tags: ['a', 'b'] })).ok, true);
    assert.deepStrictEqual(ran, ['doc.tag:{"tenant":"acme","tags":["a","b"]}']);
  });

  it('a ctx.idempotencyKey, ctx.ifMatch or ctx.ifNoneMatch a header cannot carry, and a key with edge whitespace, are JC2050 before any key is stored', async () => {
    /** @type {any} */
    let stored;
    const storage = { read: () => stored, write: (/** @type {any} */ v) => { stored = JSON.parse(JSON.stringify(v)); } };
    /** @type {unknown[]} */
    const attempts = [];
    const durable = openHttpClient(SAFETY, { storage, fetch: async (url) => { attempts.push(url); throw new Error('never reached'); } });
    for (const ctx of [
      { idempotencyKey: 'clé-🔑' },
      { idempotencyKey: 'k\r\nx-evil: 1' },
      { idempotencyKey: ' k1' },
      { idempotencyKey: 'k1\t' },
      { idempotencyKey: 'k2', ifMatch: '"a"\r\nx-evil: 1' },
      { idempotencyKey: 'k3', ifNoneMatch: '"ü€"' },
    ]) {
      const outcome = /** @type {any} */ (await durable.invoke('doc.tag', { tenant: 'acme' }, ctx));
      assert.deepStrictEqual([outcome.kind, outcome.error.code, outcome.error.retryable, outcome.error.details],
        ['contract', 'JC2050', false, [{ path: '', keyword: 'encoding' }]], JSON.stringify(ctx));
    }
    assert.deepStrictEqual(attempts, [], 'nothing was sent');
    assert.deepStrictEqual(await durable.pending(), [], 'no key was recorded for a refused call');
    // what a header carries travels: an inner space, a Latin-1 tag
    const { client, ran } = fetchPair();
    const ok = await client.invoke('doc.tag', { tenant: 'acme' }, { idempotencyKey: 'cart 5', ifNoneMatch: '"ü"', ifMatch: '*' });
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    assert.deepStrictEqual(ran, ['doc.tag:{"tenant":"acme"}']);
  });

  it('compile refuses a header member whose name is not a token (JC0009), an OPTIONS body member (JC0016), and 204/205 over an output that cannot be null (JC0012)', () => {
    const one = (/** @type {any} */ op) => ({ $contract: '0.1', operations: { a: op } });
    assert.throws(() => compileContract(one({ kind: 'command', output: true,
      input: { type: 'object', properties: { 'x tenant': { type: 'string' } } }, http: { method: 'POST', path: '/a', in: { 'x tenant': 'header' } } })),
    (/** @type {any} */ e) => e.code === 'JC0009' && /token/.test(e.message));
    assert.throws(() => compileContract(one({ kind: 'command', output: true,
      input: { type: 'object', properties: { note: { type: 'string' } } }, http: { method: 'OPTIONS', path: '/a', in: { note: 'body' } } })),
    coded('JC0016'));
    assert.throws(() => compileContract(one({ kind: 'command', output: { type: 'object' }, http: { method: 'POST', path: '/a', status: 204 } })),
      (/** @type {any} */ e) => e.code === 'JC0012' && e.docPath === '/operations/a/http/status');
    assert.throws(() => compileContract(one({ kind: 'command', output: { const: 1 }, http: { method: 'POST', path: '/a', status: 205 } })), coded('JC0012'));
    // an output that admits null keeps 204/205
    compileContract(one({ kind: 'command', output: true, http: { method: 'POST', path: '/a', status: 205 } }));
    compileContract(one({ kind: 'command', output: { type: ['object', 'null'] }, http: { method: 'POST', path: '/a', status: 204 } }));
  });

  it('a 205 answers no body; a raw 204 with a body is JC2010; neither adapter sends a 204/205/304 body', async () => {
    const contract = compileContract({ $contract: '0.1', operations: {
      reset: { kind: 'command', output: true, http: { method: 'POST', path: '/reset', status: 205 } },
      blob: { kind: 'command', output: true, http: { method: 'POST', path: '/blob', media: 'application/octet-stream' } },
    } });
    let rawStatus = 204;
    const server = serveHttp(contract, { reset: () => ({ ignored: true }), blob: () => ({ status: rawStatus, body: 'not empty' }) });
    const reset = await server.dispatch(req('POST', '/reset'));
    assert.strictEqual(reset.status, 205);
    assert.strictEqual(reset.body, null);
    const raw = await server.dispatch(req('POST', '/blob'));
    assert.strictEqual(raw.status, 500);
    assert.strictEqual(json(raw).code, 'JC2010');
    rawStatus = 205;
    assert.strictEqual(json(await server.dispatch(req('POST', '/blob'))).code, 'JC2010');
    const fetchHandler = toFetchHandler(server);
    const viaFetch = await fetchHandler(new Request('http://x/reset', { method: 'POST' }));
    assert.strictEqual(viaFetch.status, 205);
    assert.strictEqual(await viaFetch.text(), '');
    const node = await nodeServer(server);
    try {
      const viaNode = /** @type {any} */ (await node.request('POST', '/reset'));
      assert.strictEqual(viaNode.status, 205);
      assert.strictEqual(viaNode.body, '');
    }
    finally { await node.close(); }
  });

  it('a raw answer below 200 is JC2010, observed: dispatch and both adapters answer a final 500, never an informational head', async () => {
    const contract = compileContract({ $contract: '0.1', operations: {
      'file.get': { kind: 'read', output: true, http: { method: 'GET', path: '/file', media: 'application/octet-stream' } },
    } });
    /** @type {unknown[]} */
    const observed = [];
    let status = 103;
    const server = serveHttp(contract, { 'file.get': () => ({ status, headers: { link: '</a.css>; rel=preload' }, body: 'hello' }) },
      { onError: (err) => { observed.push(err); } });
    for (const informational of [100, 103, 199]) {
      status = informational;
      const r = await server.dispatch(req('GET', '/file'));
      assert.strictEqual(r.status, 500, String(informational));
      assert.strictEqual(json(r).code, 'JC2010');
    }
    assert.strictEqual(observed.length, 3, 'each refusal reached onError');
    status = 103;
    const viaFetch = await toFetchHandler(server)(new Request('http://x/file'));
    assert.strictEqual(viaFetch.status, 500);
    assert.strictEqual((await viaFetch.json()).code, 'JC2010');
    const node = await nodeServer(server);
    try {
      const viaNode = /** @type {any} */ (await node.request('GET', '/file'));
      assert.strictEqual(viaNode.status, 500);
      assert.strictEqual(JSON.parse(viaNode.body).code, 'JC2010');
    }
    finally { await node.close(); }
    // the lowest final status still passes through
    status = 200;
    const ok = await server.dispatch(req('GET', '/file'));
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body, 'hello');
  });

  it('serveHttp, serveLocal and servePort refuse an option they do not read, naming the nearest one (JC1001)', () => {
    /** @type {string[]} */
    const ran = [];
    assert.throws(() => serveHttp(SAFETY, handlers(ran), /** @type {any} */ ({ ledger: createMemoryLedger(), precondition: {} })),
      (/** @type {any} */ e) => e.code === 'JC1001' && /'precondition'/.test(e.message) && /did you mean 'preconditions'\?/.test(e.message));
    assert.throws(() => serveLocal(SAFETY, handlers(ran), /** @type {any} */ ({ validateOuput: 'never' })),
      (/** @type {any} */ e) => e.code === 'JC1001' && /did you mean 'validateOutput'\?/.test(e.message));
    const { port1 } = new MessageChannel();
    try {
      assert.throws(() => servePort(SAFETY, handlers(ran), /** @type {any} */ ({ channel: port1, onErorr: () => {} })),
        (/** @type {any} */ e) => e.code === 'JC1001' && /did you mean 'onError'\?/.test(e.message));
    }
    finally { port1.close(); }
  });

  it("a port client's timeout cancels the server call: its signal aborts and the handler runs once", async () => {
    const contract = compileContract({ $contract: '0.1', operations: { 'slow.op': { kind: 'command', output: true } } });
    let calls = 0;
    let aborted = false;
    const { port1, port2 } = new MessageChannel();
    const server = servePort(contract, { 'slow.op': (_input, ctx) => new Promise((resolve) => {
      calls += 1;
      ctx.signal.addEventListener('abort', () => { aborted = true; resolve(null); }, { once: true });
    }) }, { channel: port1 });
    const client = openPortClient(contract, { channel: port2, timeoutMs: 30 });
    try {
      const outcome = /** @type {any} */ (await client.invoke('slow.op'));
      assert.strictEqual(outcome.error.code, 'JC2072');
      for (let i = 0; i < 100 && !aborted; i++) await new Promise((r) => setTimeout(r, 5));
      assert.strictEqual(aborted, true, 'the server-side signal aborted');
      assert.strictEqual(calls, 1);
    }
    finally {
      client.close();
      server.close();
      port1.close();
      port2.close();
    }
  });

  it('a malformed invoke ctx is JC1008 on the http, port and local clients alike', async () => {
    const contract = compileContract({ $contract: '0.1', operations: { ping: { kind: 'command', output: true } } });
    const local = serveLocal(contract, { ping: () => null });
    await assert.rejects(async () => local.invoke('ping', undefined, /** @type {any} */ (null)), coded('JC1008'));
    const httpClient = openHttpClient(contract, { fetch: async () => { throw new Error('unreached'); } });
    await assert.rejects(async () => httpClient.invoke('ping', undefined, /** @type {any} */ (7)), coded('JC1008'));
    const { port1, port2 } = new MessageChannel();
    const portClient = openPortClient(contract, { channel: port2 });
    try {
      assert.throws(() => portClient.invoke('ping', undefined, /** @type {any} */ ('nope')), coded('JC1008'));
    }
    finally {
      portClient.close();
      port1.close();
      port2.close();
    }
  });
});
