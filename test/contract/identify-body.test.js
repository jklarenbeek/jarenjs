//@ts-check
/**
 * @file The exact request bytes reach `identify` when the host asks
 * (`serveHttp`'s `identifyBody`), so a server-to-server signature over
 * the raw body is verified where the caller is identified: the bytes
 * are read once, under the operation's body limit, before `identify`,
 * and the pipeline parses those same bytes; a host that does not ask
 * reads nothing before `identify` (a source is never pulled first). A
 * signature mismatch answers the operation's own declared 401. The
 * request target (`meta.url`) carries the query a signature covers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { compileContract, ContractRuntimeError } from '@jarenjs/contract';
import { serveHttp, readBody } from '@jarenjs/contract/http';
import { servePort, openPortClient } from '@jarenjs/contract/port';
import { openLocalClient } from '@jarenjs/contract/local';
import { hmacSha256Matches } from '@jarenjs/contract/auth-node';
import { json, req } from './helpers.js';

const signed = compileContract({
  $contract: '0.1', id: 'signed', version: '1',
  operations: {
    'event.ingest': {
      kind: 'command',
      input: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' } } },
      output: { type: 'object', required: ['accepted'], properties: { accepted: { type: 'string' }, by: { type: 'string' } } },
      errors: { unauthorized: { status: 401 } },
      policy: { limits: { maxBodyBytes: 64 } },
      http: { method: 'POST', path: '/hooks/events' },
    },
    'blob.put': {
      kind: 'command',
      input: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      output: true,
      errors: { unauthorized: { status: 401 } },
      policy: { limits: { maxBodyBytes: 64 } },
      http: { method: 'PUT', path: '/blobs/{id}', media: 'application/octet-stream' },
    },
  },
});

const KEY = new TextEncoder().encode('0123456789abcdef0123456789abcdef');
const BODY = '{ "kind" : "paid" }\n';

/** The scheme the tests sign with: HMAC over method, target, timestamp and the body's SHA-256. */
function sign(method, url, stamp, body) {
  const digest = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', KEY).update(`${method}\n${url}\n${stamp}\n${digest}`).digest('hex');
}

/** A source that records when it is first pulled. @param {Uint8Array[]} chunks @param {string[]} log */
function source(chunks, log) {
  return {
    async *[Symbol.asyncIterator]() {
      log.push('pull');
      for (const chunk of chunks) yield chunk;
    },
  };
}

const handlers = {
  'event.ingest': (/** @type {any} */ input, /** @type {any} */ ctx) => ({ accepted: input.kind, by: ctx.host.caller }),
  'blob.put': async (/** @type {any} */ input, /** @type {any} */ ctx) => {
    const bytes = await readBody(ctx.body);
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: `${input.id}:${ctx.body instanceof Uint8Array}:${bytes.byteLength}` };
  },
};

/** The verifying identify of the README recipe. @param {string[]} [log] */
function verifying(log = []) {
  return (/** @type {any} */ meta) => {
    log.push('identify');
    const stamp = meta.headers['x-timestamp'];
    const signature = meta.headers['x-signature'];
    if (typeof stamp !== 'string' || typeof signature !== 'string') return meta.fail('unauthorized');
    const digest = createHash('sha256').update(meta.body).digest('hex');
    const parts = [meta.method, '\n', meta.url, '\n', stamp, '\n', digest];
    if (!hmacSha256Matches(KEY, parts, Buffer.from(signature, 'hex'))) return meta.fail('unauthorized');
    return { host: { caller: 'billing' } };
  };
}

/** @param {string} url @param {string | Uint8Array | null | AsyncIterable<Uint8Array>} body @param {Record<string, string>} [extra] @param {string} [signedBody] */
function signedReq(method, url, body, extra = {}, signedBody = typeof body === 'string' ? body : '') {
  const stamp = '1700000000000';
  return req(method, url, { 'content-type': 'application/json', 'x-timestamp': stamp, 'x-signature': sign(method, url, stamp, signedBody), ...extra }, body);
}

describe('identifyBody: the exact request bytes reach identify', () => {
  it('a signed JSON body verifies over the bytes as sent (whitespace included) and the handler gets its parsed input', async () => {
    const server = serveHttp(signed, handlers, { identifyBody: true, identify: verifying() });
    const r = await server.dispatch(signedReq('POST', '/hooks/events?attempt=2', BODY));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(json(r), { accepted: 'paid', by: 'billing' });
  });

  it('a body that differs by one byte from the signed one answers the declared 401, the handler never runs', async () => {
    let ran = 0;
    const server = serveHttp(signed, { ...handlers, 'event.ingest': () => { ran++; return { accepted: 'x' }; } }, { identifyBody: true, identify: verifying() });
    const r = await server.dispatch(signedReq('POST', '/hooks/events', '{ "kind" : "paid" } \n', {}, BODY));
    assert.strictEqual(r.status, 401);
    assert.strictEqual(json(r).code, 'unauthorized');
    assert.strictEqual(ran, 0);
  });

  it('the signature covers the query: a replay against another query answers 401', async () => {
    const server = serveHttp(signed, handlers, { identifyBody: true, identify: verifying() });
    const good = signedReq('POST', '/hooks/events?attempt=2', BODY);
    const r = await server.dispatch({ ...good, url: '/hooks/events?attempt=3' });
    assert.strictEqual(r.status, 401);
  });

  it('a streamed body is collected once before identify; identify sees exactly its bytes and the parse reuses them', async () => {
    const log = /** @type {string[]} */ ([]);
    const bytes = new TextEncoder().encode(BODY);
    const server = serveHttp(signed, handlers, { identifyBody: true, identify: verifying(log) });
    const r = await server.dispatch(signedReq('POST', '/hooks/events', source([bytes.subarray(0, 5), bytes.subarray(5)], log), {}, BODY));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(log, ['pull', 'identify']);
  });

  it('meta.body is a Uint8Array: the UTF-8 bytes of a string body, empty for no body', async () => {
    /** @type {any[]} */
    const seen = [];
    const server = serveHttp(signed, handlers, { identifyBody: true, identify: (meta) => { seen.push(meta.body); return { host: { caller: 'c' } }; } });
    await server.dispatch(req('POST', '/hooks/events', { 'content-type': 'application/json' }, '{"kind":"é"}'));
    await server.dispatch(req('POST', '/hooks/events', {}, null));
    assert.ok(seen[0] instanceof Uint8Array);
    assert.deepStrictEqual([...seen[0]], [...Buffer.from('{"kind":"é"}', 'utf8')]);
    assert.ok(seen[1] instanceof Uint8Array);
    assert.strictEqual(seen[1].byteLength, 0);
  });

  it('a body over the limit answers 413 JC2003 before identify — by content-length, by a string, and by a source read past it', async () => {
    let calls = 0;
    const server = serveHttp(signed, handlers, { identifyBody: true, identify: () => { calls++; return { host: null }; } });
    const big = 'x'.repeat(65);
    const pulls = /** @type {string[]} */ ([]);
    const declared = await server.dispatch(req('POST', '/hooks/events', { 'content-length': '65' }, source([new Uint8Array(65)], pulls)));
    const text = await server.dispatch(req('POST', '/hooks/events', {}, big));
    const pulled = await server.dispatch(req('POST', '/hooks/events', {}, source([new Uint8Array(40), new Uint8Array(40)], [])));
    for (const r of [declared, text, pulled]) {
      assert.strictEqual(r.status, 413);
      assert.strictEqual(json(r).code, 'JC2003');
    }
    assert.strictEqual(calls, 0);
    assert.deepStrictEqual(pulls, [], 'a declared length over the limit is refused before anything is pulled');
  });

  it('a source that fails mid-read answers 400 JC2005 before identify', async () => {
    let calls = 0;
    const server = serveHttp(signed, handlers, { identifyBody: true, identify: () => { calls++; return { host: null }; } });
    const failing = { async *[Symbol.asyncIterator]() { yield new Uint8Array(3); throw new Error('reset'); } };
    const r = await server.dispatch(req('POST', '/hooks/events', {}, failing));
    assert.strictEqual(r.status, 400);
    assert.strictEqual(json(r).code, 'JC2005');
    assert.strictEqual(calls, 0);
  });

  it('an opaque upload is buffered under its limit: the raw handler reads the same bytes as ctx.body', async () => {
    const server = serveHttp(signed, handlers, { identifyBody: true, identify: verifying() });
    const payload = new Uint8Array([0, 1, 2, 255]);
    const r = await server.dispatch(req('PUT', '/blobs/a7', {
      'content-type': 'application/octet-stream', 'x-timestamp': '1', 'x-signature': sign('PUT', '/blobs/a7', '1', payload),
    }, source([payload], [])));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body, 'a7:true:4');
  });

  it('without identifyBody nothing is read before identify: meta.body is null and the source is pulled after it', async () => {
    const log = /** @type {string[]} */ ([]);
    /** @type {any[]} */
    const metas = [];
    const server = serveHttp(signed, handlers, { identify: (meta) => { log.push('identify'); metas.push(meta); return { host: { caller: 'c' } }; } });
    const r = await server.dispatch(req('POST', '/hooks/events?x=1', { 'content-type': 'application/json' }, source([new TextEncoder().encode(BODY)], log)));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(log, ['identify', 'pull']);
    assert.strictEqual(metas[0].body, null);
    assert.strictEqual(metas[0].url, '/hooks/events?x=1');
    assert.strictEqual(metas[0].path, '/hooks/events');
  });

  it('without identifyBody an opaque upload still streams to the raw handler', async () => {
    const server = serveHttp(signed, handlers, { identify: () => ({ host: null }) });
    const r = await server.dispatch(req('PUT', '/blobs/a7', { 'content-type': 'application/octet-stream' }, source([new Uint8Array(3)], [])));
    assert.strictEqual(r.body, 'a7:false:3');
  });

  it('identifyBody is a boolean option (JC1001 otherwise)', () => {
    assert.strictEqual(serveHttp(signed, handlers, { identifyBody: true }).capabilities.name, 'http');
    assert.strictEqual(serveHttp(signed, handlers, { identifyBody: false }).capabilities.name, 'http');
    assert.throws(() => serveHttp(signed, handlers, { identifyBody: 'yes' }), (/** @type {any} */ e) => e.code === 'JC1001' && /identifyBody/.test(e.message));
  });

  it('a refusal thrown from identify is the host fault (500 JC2008), and an undeclared failure code too: the 401 is the operation\'s declared one', async () => {
    const thrown = serveHttp(signed, handlers, { identifyBody: true, onError: () => {}, identify: () => { throw new ContractRuntimeError('JC2142', 'mismatch', { status: 401 }); } });
    const undeclared = serveHttp(signed, handlers, { identifyBody: true, onError: () => {}, identify: (meta) => meta.fail('forbidden') });
    for (const server of [thrown, undeclared]) {
      const r = await server.dispatch(req('POST', '/hooks/events', { 'content-type': 'application/json' }, BODY));
      assert.strictEqual(r.status, 500);
      assert.strictEqual(json(r).code, 'JC2008');
    }
  });

  it('port and local carry no request line: meta.url and meta.body are null', async () => {
    /** @type {any[]} */
    const metas = [];
    const identify = (/** @type {any} */ meta) => { metas.push(meta); return { host: { caller: 'c' } }; };
    const only = { 'event.ingest': handlers['event.ingest'] };
    const local = openLocalClient(signed, only, { identify });
    await local.invoke('event.ingest', { kind: 'a' });
    const { port1, port2 } = new MessageChannel();
    const server = servePort(signed, only, { channel: port1, identify });
    const client = openPortClient(signed, { channel: port2 });
    try {
      await client.invoke('event.ingest', { kind: 'b' });
    }
    finally {
      client.close();
      server.close();
      port1.close();
      port2.close();
    }
    assert.strictEqual(metas.length, 2);
    for (const meta of metas) {
      assert.strictEqual(meta.url, null);
      assert.strictEqual(meta.body, null);
    }
  });
});

describe('README: signed requests and bearer tokens', () => {
  it('the recipe runs as written: a signed call 200, a forged body 401, a bearer token 200, an alg none token 401', async () => {
    const readme = readFileSync(new URL('../../packages/contract/README.md', import.meta.url), 'utf8');
    const at = readme.indexOf('**Signed requests and bearer tokens.**');
    assert.ok(at !== -1, 'the recipe is in the README');
    const open = readme.indexOf('```js\n', at) + '```js\n'.length;
    let code = readme.slice(open, readme.indexOf('\n```\n', open));
    // the fence imports the package by name; a scratch module resolves it from here
    for (const specifier of ['@jarenjs/contract/http', '@jarenjs/contract/auth-node', '@jarenjs/contract']) {
      code = code.replaceAll(`'${specifier}'`, `'${import.meta.resolve(specifier)}'`);
    }
    const dir = mkdtempSync(join(tmpdir(), 'contract-readme-'));
    try {
      const file = join(dir, 'recipe.mjs');
      writeFileSync(file, `${code}\nexport { paid, forged, me, refused };\n`);
      const { paid, forged, me, refused } = await import(pathToFileURL(file).href);
      assert.strictEqual(paid.status, 200);
      assert.strictEqual(paid.body, '{"by":"shop"}');
      assert.strictEqual(forged.status, 401);
      assert.strictEqual(JSON.parse(forged.body).code, 'unauthorized');
      assert.strictEqual(me.status, 200);
      assert.strictEqual(me.body, '{"user":"u-7"}');
      assert.strictEqual(refused.status, 401);
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
