//@ts-check
/**
 * @file A nullable member on the transport, each defect reproduced before
 * it was fixed:
 *
 * 1. A nullable query, header or path member — `type: [T, 'null']` or the
 *    `anyOf` spelling — was decoded through the unsplit schema. The
 *    normalizer coerces neither spelling, so `?n=5` from the suite's own
 *    client answered JC2006, and an `anyOf: [array, null]` header list
 *    failed where its type-array twin decoded.
 * 2. A `null` path value was sent as the text "null": the handler received
 *    the string, and `url()` built the same URL.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract, ContractHostError } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { toFetchHandler } from '@jarenjs/contract/fetch';
import { openHttpClient } from '@jarenjs/contract/client';

/** Both spellings of one nullable schema. @param {Record<string, any>} branch */
const spellings = (branch) => [
  { ...branch, type: [branch.type, 'null'] },
  { anyOf: [branch, { type: 'null' }] },
];

/**
 * A client wired straight into a dispatcher that records what its handler saw.
 * @param {Record<string, any>} doc
 */
function wire(doc) {
  const contract = compileContract(doc);
  /** @type {unknown[]} */
  const seen = [];
  const handlers = Object.fromEntries(contract.ids.map((id) => [id, (/** @type {unknown} */ input) => { seen.push(input); return true; }]));
  const handler = toFetchHandler(serveHttp(contract, handlers));
  const client = openHttpClient(contract, { baseUrl: 'http://x.test', fetch: (/** @type {any} */ url, /** @type {any} */ init) => handler(new Request(url, init)) });
  return { client, seen };
}

describe('a nullable member on the transport', () => {
  it('1. decodes by its non-null branch in either spelling: a query scalar, a header scalar, a header list, a path', async () => {
    for (const [n, flag, ids, id] of /** @type {any[][]} */ ([0, 1].map((i) => [
      spellings({ type: 'integer' })[i], spellings({ type: 'boolean' })[i],
      spellings({ type: 'array', items: { type: 'integer' } })[i], spellings({ type: 'integer' })[i],
    ]))) {
      const { client, seen } = wire({ $contract: '0.1', operations: {
        'a.find': { kind: 'read', output: true,
          input: { type: 'object', properties: { n, flag, ids, id } },
          http: { method: 'GET', path: '/find/{id}', in: { flag: 'header', ids: 'header' } } },
      } });
      const outcome = await client.invoke('a.find', { n: 5, flag: true, ids: [1, 2], id: 7 });
      assert.strictEqual(outcome.ok, true, JSON.stringify(outcome));
      assert.deepStrictEqual(seen, [{ n: 5, flag: true, ids: [1, 2], id: 7 }]);
      client.close();
    }
  });

  it('2. a null path value is refused before sending (JC2050), and url() refuses it (JC1008)', async () => {
    for (const id of spellings({ type: 'string' })) {
      const { client, seen } = wire({ $contract: '0.1', operations: {
        'user.get': { kind: 'read', output: true, input: { type: 'object', properties: { id } }, http: { method: 'GET', path: '/users/{id}' } },
      } });
      const outcome = /** @type {any} */ (await client.invoke('user.get', { id: null }));
      assert.deepStrictEqual([outcome.ok, outcome.error.code], [false, 'JC2050']);
      assert.deepStrictEqual(seen, [], 'nothing reached the server');
      assert.throws(() => client.url('user.get', { id: null }), (/** @type {any} */ err) => err instanceof ContractHostError && err.code === 'JC1008');
      client.close();
    }
  });
});
