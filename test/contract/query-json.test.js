//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { openHttpClient } from '@jarenjs/contract/client';
import { toFetchHandler } from '@jarenjs/contract/fetch';
import { toOpenApi } from '@jarenjs/contract/project';

const input = { type: 'object', properties: {
  filter: { $ref: '#/$defs/filter' },
  rows: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' } } } },
  tags: { type: 'array', items: { type: ['string', 'null'] } },
  union: { type: ['object', 'array', 'string', 'number', 'null'] },
  text: { type: 'string' }, count: { type: 'integer' },
} };
const contract = compileContract({ $contract: '0.1', $defs: {
  filter: { type: ['object', 'null'], properties: { n: { type: 'integer' } } },
}, operations: {
  echo: { kind: 'read', input, output: true, http: { method: 'GET', path: '/echo' } },
  feed: { kind: 'subscribe', input, output: true, http: { method: 'GET', path: '/feed' } },
} });

describe('schema-directed JSON query members', () => {
  it('round-trips structures, nulls, empty arrays and string-looking JSON through the HTTP client and Fetch adapter', async () => {
    const server = serveHttp(contract, { echo: (value) => value }, { partial: true });
    const fetch = toFetchHandler(server);
    const client = openHttpClient(contract, { baseUrl: 'http://contract.test', fetch: (url, init) => fetch(new Request(url, init)) });
    try {
      for (const value of [
        { filter: { n: 2 }, rows: [{ n: 3 }], tags: ['[1]', '', null, 'a&b+%'], text: '{"n":2}', count: 4 },
        { filter: null, rows: [], tags: [], union: null },
        ...['[]', 5, [], {}, { a: [null] }].map((union) => ({ union })),
        JSON.parse('{"filter":{"__proto__":{"polluted":true}}}'),
        {},
      ]) {
        const result = await client.invoke('echo', value);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.deepEqual(result.value, value);
      }
      assert.equal(Object.prototype['polluted'], undefined);
    }
    finally { client.close(); server.close(); }
  });

  it('refuses malformed or repeated JSON, validates nested types without coercion, and ignores undeclared keys', async () => {
    let calls = 0;
    const server = serveHttp(contract, { echo: (value) => { calls++; return value; } }, { partial: true });
    const request = (query) => server.dispatch({ method: 'GET', url: '/echo?' + query, headers: {} });
    for (const query of ['filter=%7B', 'tags=a&tags=b', 'tags=%5B%5D&tags=%5B%5D', 'filter=%FF']) {
      const result = await request(query);
      assert.equal(result.status, 400);
      assert.equal(JSON.parse(result.body).code, 'JC2012');
    }
    const wrong = await request(new URLSearchParams({ rows: JSON.stringify([{ n: '2' }]) }).toString());
    assert.equal(wrong.status, 400);
    assert.equal(JSON.parse(wrong.body).code, 'JC2006');
    assert.equal(calls, 0);
    const ok = await request('text=%7B&unknown=%7B');
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { text: '{' });
    server.close();
  });

  it('uses the same codec for subscription URLs and describes it in OpenAPI', () => {
    const client = openHttpClient(contract, { baseUrl: 'http://contract.test' });
    const url = new URL(client.url('feed', { filter: { n: 5 }, rows: [], tags: [] }));
    assert.deepEqual(JSON.parse(url.searchParams.get('filter')), { n: 5 });
    assert.deepEqual(JSON.parse(url.searchParams.get('rows')), []);
    const api = toOpenApi(contract).document;
    const params = api.paths['/echo'].get.parameters;
    assert.ok(params.find((p) => p.name === 'filter').content['application/json']);
    assert.deepEqual(params.find((p) => p.name === 'text').schema, { type: 'string' });
    client.close();
  });

  it('carries structured subscription input through an actual SSE connection', async () => {
    const expected = { filter: { n: 8 }, rows: [{ n: 9 }], tags: [] };
    let received;
    const server = serveHttp(contract, { feed: (value) => {
      received = value;
      return { result: value, subscribe: () => () => {}, close: () => {} };
    } }, { partial: true });
    const fetch = toFetchHandler(server);
    const client = openHttpClient(contract, { baseUrl: 'http://contract.test', fetch: (url, init) => fetch(new Request(url, init)) });
    let sub;
    try {
      const snapshot = await new Promise((resolve, reject) => {
        sub = client.subscribe('feed', expected, { onSnapshot: resolve, onError: reject });
      });
      assert.deepEqual(received, expected);
      assert.deepEqual(snapshot, expected);
    }
    finally { sub?.stop(); client.close(); server.close(); }
  });
});
