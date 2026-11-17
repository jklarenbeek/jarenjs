//@ts-check
/**
 * @file The closed query: `serveHttp`'s `closedQuery` option.
 *
 * By default a query key no operation declares is ignored and a repeated
 * scalar member is last-wins (docs/CONTRACT-FORMAT.md §4.1). A host that
 * guards the raw request target — a signature over the URL, parameter
 * smuggling hardening — reads both as a wrong answer: `?admin=1` passed
 * the signer and then vanished, `?id=1&id=2` was read as `2` while a
 * proxy in front read `1`. `closedQuery` refuses both as the binding's
 * invalid-input refusal (`JC2006`), for every operation (`true`) or for
 * the operations it names; the default answers exactly as before.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, request as httpRequest } from 'node:http';
import { createHash, createHmac } from 'node:crypto';

import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { toFetchHandler } from '@jarenjs/contract/fetch';
import { toNodeHandler } from '@jarenjs/contract/node';
import { openHttpClient } from '@jarenjs/contract/client';
import { req, json } from './helpers.js';

const search = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    limit: { type: 'integer' },
    flag: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    filter: { type: ['object', 'null'], properties: { n: { type: 'integer' } } },
    note: { type: ['string', 'null'] },
    who: { type: 'string' },
  },
};

const DOC = {
  $contract: '0.1',
  operations: {
    'item.search': {
      kind: 'read', input: search, output: true,
      http: { method: 'GET', path: '/items', in: { id: 'query', limit: 'query', flag: 'query', tags: 'query', filter: 'query', note: 'query', who: 'header' } },
    },
    'item.get': {
      kind: 'read', input: { type: 'object', properties: { key: { type: 'string' }, view: { type: 'string' } }, required: ['key'] }, output: true,
      http: { method: 'GET', path: '/items/{key}', in: { view: 'query' } },
    },
    'item.save': {
      kind: 'command', input: { type: 'object', properties: { key: { type: 'string' }, name: { type: 'string' } } }, output: true,
      http: { method: 'POST', path: '/items/{key}' },
    },
    'item.ping': { kind: 'read', output: true, http: { method: 'GET', path: '/ping' } },
    'item.quiet': {
      kind: 'read', input: { type: 'object', properties: { id: { type: 'string' } } }, output: true,
      policy: { errors: { details: 'none' } },
      http: { method: 'GET', path: '/quiet', in: { id: 'query' } },
    },
    'item.loud': {
      kind: 'read', input: { type: 'object', properties: { id: { type: 'string' } } }, output: true,
      policy: { errors: { details: 'full' } },
      http: { method: 'GET', path: '/loud', in: { id: 'query' } },
    },
    'item.raw': {
      kind: 'command', input: { type: 'object', properties: { id: { type: 'string' } } }, output: true,
      http: { method: 'PUT', path: '/raw', in: { id: 'query' }, media: 'application/octet-stream' },
    },
    'item.feed': {
      kind: 'subscribe', input: search, output: true,
      http: { method: 'GET', path: '/feed', in: { id: 'query', limit: 'query', flag: 'query', tags: 'query', filter: 'query', note: 'query', who: 'header' } },
    },
  },
};

const contract = compileContract(DOC);

/** @type {any[]} */
let seen = [];
const echo = (/** @type {any} */ input) => { seen.push(input); return input ?? {}; };
const HANDLERS = {
  'item.search': echo, 'item.get': echo, 'item.save': echo, 'item.ping': echo, 'item.quiet': echo, 'item.loud': echo,
  'item.raw': (/** @type {any} */ input) => { seen.push(input); return new Uint8Array(0); },
  'item.feed': (/** @type {any} */ input) => { seen.push(input); return { result: input, subscribe: () => () => {}, close: () => {} }; },
};

/** @param {any} [options] */
const serve = (options) => serveHttp(contract, HANDLERS, options);

/** @param {any} response */
const code = (response) => json(response).code;

describe('closedQuery: absent or false, the documented default answers as before', () => {
  for (const options of [undefined, {}, { closedQuery: false }]) {
    it(`${JSON.stringify(options)}: an undeclared key is ignored and a repeated scalar is last-wins`, async () => {
      const server = serve(options);
      seen = [];
      const ignored = await server.dispatch(req('GET', '/items?admin=1&id=a'));
      const lastWins = await server.dispatch(req('GET', '/items?id=1&id=2'));
      assert.equal(ignored.status, 200);
      assert.equal(ignored.body, '{"id":"a"}');
      assert.equal(lastWins.status, 200);
      assert.equal(lastWins.body, '{"id":"2"}');
      assert.deepEqual(seen, [{ id: 'a' }, { id: '2' }]);
      server.close();
    });
  }
});

describe('closedQuery: true refuses what the open query read as something else', () => {
  it('an undeclared key is JC2006 naming it; the handler never runs', async () => {
    const server = serve({ closedQuery: true });
    seen = [];
    const r = await server.dispatch(req('GET', '/items?id=a&admin=1'));
    assert.equal(r.status, 400);
    assert.deepEqual([code(r), json(r).details], ['JC2006', [{ path: '/admin', keyword: 'undeclared' }]]);
    assert.deepEqual(seen, []);
    server.close();
  });

  it('a member repeated with another value is JC2006 naming it, once per member', async () => {
    const server = serve({ closedQuery: true });
    seen = [];
    for (const query of ['id=1&id=2', 'limit=1&id=a&limit=2&limit=3', 'id=1&id=1&id=2', 'limit=1&limit=01', 'id=a&id=a+', 'id=&id=x']) {
      const r = await server.dispatch(req('GET', '/items?' + query));
      assert.equal(r.status, 400, query);
      assert.equal(code(r), 'JC2006');
      assert.deepEqual(json(r).details, [{ path: query.startsWith('limit') ? '/limit' : '/id', keyword: 'repeated' }], query);
    }
    assert.deepEqual(seen, []);
    server.close();
  });

  it('a member repeated with the same decoded value reads as the open query reads it', async () => {
    const server = serve({ closedQuery: true });
    for (const [query, input] of [['id=1&id=1', { id: '1' }], ['id=1&id=%31', { id: '1' }], ['id=a+b&id=a%20b', { id: 'a b' }], ['limit=5&flag=true&limit=5', { limit: 5, flag: true }]]) {
      const r = await server.dispatch(req('GET', '/items?' + query));
      assert.deepEqual([r.status, json(r)], [200, input], query);
    }
    server.close();
  });

  it('every violation is listed in query order, an undeclared key once however often it repeats', async () => {
    const server = serve({ closedQuery: true });
    const r = await server.dispatch(req('GET', '/items?x=1&id=1&x=2&id=1&id=2&a~b/c=3&id=3'));
    assert.deepEqual(json(r).details, [
      { path: '/x', keyword: 'undeclared' },
      { path: '/id', keyword: 'repeated' },
      { path: '/a~0b~1c', keyword: 'undeclared' },
    ]);
    server.close();
  });

  it('a key naming a path, header or body member is undeclared as a query key', async () => {
    const server = serve({ closedQuery: true });
    const header = await server.dispatch(req('GET', '/items?who=me'));
    const path = await server.dispatch(req('GET', '/items/k1?key=k2'));
    const body = await server.dispatch(req('POST', '/items/k1?name=n', { 'content-type': 'application/json' }, '{"name":"b"}'));
    for (const [r, member] of [[header, '/who'], [path, '/key'], [body, '/name']]) {
      assert.equal(r.status, 400);
      assert.deepEqual([code(r), json(r).details], ['JC2006', [{ path: member, keyword: 'undeclared' }]]);
    }
    server.close();
  });

  it('an empty key is undeclared; an empty pair, a bare name and an encoded name read as the open query reads them', async () => {
    const server = serve({ closedQuery: true });
    seen = [];
    const empty = await server.dispatch(req('GET', '/items?=x'));
    assert.deepEqual([empty.status, json(empty).details], [400, [{ path: '/', keyword: 'undeclared' }]]);
    for (const [query, input] of [['id=a&', { id: 'a' }], ['&&id=a', { id: 'a' }], ['id', { id: '' }], ['%69d=a', { id: 'a' }], ['', {}]]) {
      const r = await server.dispatch(req('GET', '/items?' + query));
      assert.equal(r.status, 200, query);
      assert.deepEqual(json(r), input, query);
    }
    const encoded = await server.dispatch(req('GET', '/items?%61dmin=1'));
    assert.deepEqual(json(encoded).details, [{ path: '/admin', keyword: 'undeclared' }]);
    server.close();
  });

  it('a JSON or array member is one value as before: once it reads, repeated it stays JC2012, and a malformed query is JC2012 before any closed check', async () => {
    const server = serve({ closedQuery: true });
    const once = await server.dispatch(req('GET', '/items?tags=%5B%22a%22%2C%22b%22%5D'));
    assert.deepEqual([once.status, json(once)], [200, { tags: ['a', 'b'] }]);
    for (const query of ['tags=%5B%5D&tags=%5B%5D', 'admin=1&tags=%5B%5D&tags=%5B%5D', 'admin=1&id=%FF', 'id=1&id=2&filter=%7B']) {
      const r = await server.dispatch(req('GET', '/items?' + query));
      assert.equal(code(r), 'JC2012', query);
    }
    server.close();
  });

  it('an operation with no input, or with no query member, refuses every key and answers without one', async () => {
    const server = serve({ closedQuery: true });
    const noInput = await server.dispatch(req('GET', '/ping?x=1'));
    const noQuery = await server.dispatch(req('POST', '/items/k?x=1', { 'content-type': 'application/json' }, '{}'));
    for (const r of [noInput, noQuery]) assert.deepEqual([code(r), json(r).details], ['JC2006', [{ path: '/x', keyword: 'undeclared' }]]);
    assert.equal((await server.dispatch(req('GET', '/ping'))).status, 200);
    assert.equal((await server.dispatch(req('GET', '/ping?'))).status, 200);
    assert.equal((await server.dispatch(req('POST', '/items/k', { 'content-type': 'application/json' }, '{}'))).status, 200);
    server.close();
  });

  it('honours the operation\'s errors.details: nothing under none, the raw records under full', async () => {
    const server = serve({ closedQuery: true });
    const quiet = await server.dispatch(req('GET', '/quiet?id=1&id=2'));
    const loud = await server.dispatch(req('GET', '/loud?id=1&x=2'));
    assert.equal(code(quiet), 'JC2006');
    assert.equal(Object.hasOwn(json(quiet), 'details'), false);
    assert.deepEqual([code(loud), json(loud).details], ['JC2006', [{ instancePath: '/x', keyword: 'undeclared' }]]);
    server.close();
  });

  it('HEAD on a GET read, an opaque operation and a subscribe refuse alike', async () => {
    const server = serve({ closedQuery: true });
    seen = [];
    const head = await server.dispatch(req('HEAD', '/items?admin=1'));
    assert.equal(head.status, 400);
    const raw = await server.dispatch(req('PUT', '/raw?id=1&id=2', { 'content-type': 'application/octet-stream' }, new Uint8Array([1])));
    assert.deepEqual([raw.status, code(raw)], [400, 'JC2006']);
    const feed = await server.dispatch(req('GET', '/feed?admin=1', { accept: 'text/event-stream' }));
    assert.deepEqual([feed.status, code(feed)], [400, 'JC2006']);
    assert.deepEqual(seen, []);
    server.close();
  });

  it('identify reads the target the client sent before the refusal', async () => {
    /** @type {any[]} */
    const targets = [];
    const server = serveHttp(contract, HANDLERS, { closedQuery: true, identify: (/** @type {any} */ meta) => { targets.push(meta.url); return { host: null }; } });
    const r = await server.dispatch(req('GET', '/items?id=a&admin=1'));
    assert.equal(code(r), 'JC2006');
    assert.deepEqual(targets, ['/items?id=a&admin=1']);
    server.close();
  });
});

describe('closedQuery: a list of operation ids closes those operations only', () => {
  it('a named operation refuses, every other keeps the open query', async () => {
    const server = serve({ closedQuery: ['item.get'] });
    const closed = await server.dispatch(req('GET', '/items/k?admin=1'));
    const open = await server.dispatch(req('GET', '/items?admin=1&id=1&id=2'));
    assert.equal(code(closed), 'JC2006');
    assert.deepEqual([open.status, json(open)], [200, { id: '2' }]);
    assert.equal((await serve({ closedQuery: [] }).dispatch(req('GET', '/items/k?admin=1'))).status, 200);
  });

  it('refuses a host mistake at construction (JC1001): an unknown id, a non-string, any other shape', () => {
    for (const closedQuery of [['item.nope'], [1], 'item.get', 1, null, { 'item.get': true }, ['item.get', 'item.get']]) {
      assert.throws(() => serve({ closedQuery }), (/** @type {any} */ e) => e.code === 'JC1001', JSON.stringify(closedQuery));
    }
  });
});

describe('closedQuery: what the client writes, a closed server reads', () => {
  const values = [
    { id: 'a&b=c', limit: 3, flag: false, tags: ['x', 'y'], filter: { n: 1 }, note: 'n', who: 'w' },
    { tags: [], filter: null, note: null },
    { id: '' },
    {},
  ];

  it('every read the HTTP client sends answers 200 over the fetch adapter', async () => {
    const server = serve({ closedQuery: true });
    const fetch = toFetchHandler(server);
    const client = openHttpClient(contract, { baseUrl: 'http://contract.test', fetch: (url, init) => fetch(new Request(url, init)) });
    try {
      for (const value of values) {
        const result = await client.invoke('item.search', value);
        assert.equal(result.ok, true, JSON.stringify(result));
        const sent = { ...value };
        // a null scalar is omitted by the client and the header member is not echoed back as a query member
        if (sent.note === null) delete sent.note;
        assert.deepEqual(result.value, sent);
      }
      const got = await client.invoke('item.get', { key: 'k', view: 'v' });
      assert.equal(got.ok, true);
      const saved = await client.invoke('item.save', { key: 'k', name: 'n' });
      assert.equal(saved.ok, true);
    }
    finally { client.close(); server.close(); }
  });

  it('a subscription the client opens is admitted by a closed server', async () => {
    const server = serve({ closedQuery: true });
    const fetch = toFetchHandler(server);
    const client = openHttpClient(contract, { baseUrl: 'http://contract.test', fetch: (url, init) => fetch(new Request(url, init)) });
    let sub;
    try {
      const snapshot = await new Promise((resolve, reject) => {
        sub = client.subscribe('item.feed', values[0], { onSnapshot: resolve, onError: reject });
      });
      assert.deepEqual(snapshot, values[0]);
    }
    finally { sub?.stop(); client.close(); server.close(); }
  });

  it('client.url() writes each declared member once and no other key', () => {
    const client = openHttpClient(contract, { baseUrl: 'http://contract.test' });
    for (const value of values) {
      const url = new URL(client.url('item.search', value));
      const keys = [...url.searchParams.keys()];
      assert.deepEqual(keys, [...new Set(keys)]);
      for (const key of keys) assert.ok(['id', 'limit', 'flag', 'tags', 'filter', 'note'].includes(key), key);
    }
    client.close();
  });
});

describe('CONTRACT-FORMAT.md: the signed request, worked', () => {
  it('the example runs as printed and exports the JSON after it; behind node, repeated header lines are the array it refuses', async () => {
    const doc = readFileSync(new URL('../../packages/contract/docs/CONTRACT-FORMAT.md', import.meta.url), 'utf8');
    const at = doc.indexOf('**A signed request, worked.**');
    assert.ok(at !== -1, 'the example is in CONTRACT-FORMAT.md');
    const open = doc.indexOf('```js\n', at) + '```js\n'.length;
    const close = doc.indexOf('\n```\n', open);
    let code = doc.slice(open, close);
    // an answer, not a contract document: `jsonc`, so the format's json examples stay contracts
    const jsonOpen = doc.indexOf('```jsonc\n', close);
    assert.equal(jsonOpen, close + '\n```\n\n'.length, 'the JSON fence follows the example');
    const expected = JSON.parse(doc.slice(jsonOpen + '```jsonc\n'.length, doc.indexOf('\n```\n', jsonOpen)));
    // the fence imports the package by name; a scratch module resolves it from here
    for (const specifier of ['@jarenjs/contract/http', '@jarenjs/contract/auth-node', '@jarenjs/contract']) {
      code = code.replaceAll(`'${specifier}'`, `'${import.meta.resolve(specifier)}'`);
    }
    const dir = mkdtempSync(join(tmpdir(), 'contract-signed-'));
    try {
      const file = join(dir, 'example.mjs');
      // the server and the sender are reached once more below, behind node
      writeFileSync(file, `${code}\nexport { server as __server, send as __send };\n`);
      const mod = await import(pathToFileURL(file).href);
      const own = Object.keys(mod).filter((name) => !name.startsWith('__'));
      assert.deepEqual(own, ['signedRequests'], 'the example exports one value');
      assert.deepEqual(JSON.parse(JSON.stringify(mod.signedRequests)), expected);
      const server = mod.__server;
      assert.equal((await mod.__send('/accounts/acc-1/entries?dry=true')).status, 200);
      /** @type {unknown[]} */
      const lines = [];
      const node = createServer(toNodeHandler({ ...server, dispatch: (/** @type {any} */ r) => { lines.push(r.headers['x-signature']); return server.dispatch(r); } }));
      await new Promise((resolve) => node.listen(0, '127.0.0.1', () => resolve(undefined)));
      try {
        const { port } = /** @type {import('node:net').AddressInfo} */ (node.address());
        const body = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('{"amount":250}')]);
        /** @param {Record<string, string | string[]>} headers @returns {Promise<number>} */
        const over = (headers) => new Promise((resolve, reject) => {
          const rq = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/accounts/acc-1/entries?dry=true', headers }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          });
          rq.on('error', reject);
          rq.end(body);
        });
        const stamp = '1767225600000';
        const digest = createHash('sha256').update(body).digest('hex');
        const signature = createHmac('sha256', Buffer.from('a shared secret of 32 bytes or more'))
          .update(['POST', '/accounts/acc-1/entries?dry=true', stamp, digest].join('\n')).digest('hex');
        const base = { 'content-type': 'application/json', 'x-caller': 'shop', 'x-timestamp': stamp };
        assert.equal(await over({ ...base, 'x-signature': signature }), 200);
        assert.equal(await over({ ...base, 'x-signature': [signature, signature] }), 401);
        assert.deepEqual(lines, [signature, [signature, signature]]);
      }
      finally {
        await new Promise((resolve) => node.close(() => resolve(undefined)));
      }
      server.close();
    }
    finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
