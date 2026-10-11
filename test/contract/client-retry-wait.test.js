//@ts-check
/**
 * @file The client's retry wait is the bounded backoff and nothing a server
 * says: a `retry-after` of years, a date at the end of time, a negative or
 * an unreadable value all leave every wait at `min(1000 · 2^n, 8000)` ms plus
 * under 250 ms of jitter, because the client never reads the header.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract } from '@jarenjs/contract';
import { openHttpClient } from '@jarenjs/contract/client';
import { load } from './helpers.js';

const shop = compileContract(load('./fixtures/shop.contract.json'));
const SAVE = { id: 1, revision: 1, product: { id: 1, name: 'a', price: 1 } };

describe('the retry wait under a hostile retry-after', () => {
  for (const hint of ['99999999999', '1e308', 'Fri, 31 Dec 9999 23:59:59 GMT', '-5', '0', 'abc']) {
    it(`retry-after: ${hint} leaves the waits at the capped backoff`, async () => {
      /** @type {number[]} */
      const sleeps = [];
      let calls = 0;
      const client = openHttpClient(shop, {
        baseUrl: 'http://shop.local',
        sleep: async (ms) => { sleeps.push(ms); },
        fetch: async () => {
          calls++;
          return new Response(JSON.stringify({ code: 'not-found', message: 'gone' }), {
            status: 404, headers: { 'content-type': 'application/json', 'retry-after': hint },
          });
        },
      });
      const outcome = await client.invoke('product.save', SAVE, {});
      assert.strictEqual(outcome.ok, false);
      assert.strictEqual(calls, 3, 'the declared policy retries twice');
      assert.strictEqual(sleeps.length, 2);
      sleeps.forEach((ms, n) => {
        const base = Math.min(1000 * 2 ** n, 8000);
        assert.ok(ms >= base && ms < base + 250, `wait ${n} was ${ms} ms, expected ${base}..${base + 249}`);
      });
    });
  }
});
