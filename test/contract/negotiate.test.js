//@ts-check
/**
 * @file `client.negotiate()`: the compatibility matrix against a real
 * server's well-known description — same-version, server-accepts,
 * client-accepts, version-mismatch — and the two non-answers,
 * unreachable and not-a-contract (no description, another document,
 * another contract id). Nothing else is inferred.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract } from '@jarenjs/contract';
import { serveHttp, WELL_KNOWN_PATH } from '@jarenjs/contract/http';
import { toFetchHandler } from '@jarenjs/contract/fetch';
import { openHttpClient } from '@jarenjs/contract/client';

/**
 * @param {{ id?: string, version?: string, compat?: string[] }} root
 */
function contractOf(root) {
  return compileContract({ $contract: '0.1', ...root, operations: { ping: { kind: 'read', output: true, http: { method: 'GET', path: '/ping' } } } });
}

/**
 * A client over a server of another contract.
 * @param {import('@jarenjs/contract').Contract} clientContract
 * @param {import('@jarenjs/contract').Contract} serverContract
 * @param {any} [serveOptions]
 */
function pair(clientContract, serverContract, serveOptions = {}) {
  const handler = toFetchHandler(serveHttp(serverContract, { ping: () => true }, serveOptions));
  /** @type {string[]} */
  const urls = [];
  const client = openHttpClient(clientContract, { fetch: (url, init) => { urls.push(url); return handler(new Request('http://x' + url, init)); } });
  return { client, urls };
}

describe('negotiate — the compatibility matrix', () => {
  it('same-version: equal versions, and two unversioned contracts; the server revision rides along', async () => {
    const serverContract = contractOf({ id: 'shop', version: '5', compat: ['4'] });
    const { client, urls } = pair(contractOf({ id: 'shop', version: '5' }), serverContract);
    const n = await client.negotiate();
    assert.deepStrictEqual(n, {
      compatible: true, reason: 'same-version',
      server: { id: 'shop', version: '5', compat: ['4'], revision: await serverContract.revision() }, error: null,
    });
    assert.deepStrictEqual(urls, [WELL_KNOWN_PATH]);
    const bareServer = contractOf({});
    const bare = await pair(contractOf({}), bareServer).client.negotiate();
    assert.deepStrictEqual([bare.compatible, bare.reason, bare.server],
      [true, 'same-version', { id: null, version: null, compat: [], revision: await bareServer.revision() }]);
  });

  it('server-accepts: the client\'s version is in the server\'s compat', async () => {
    const n = await pair(contractOf({ id: 'shop', version: '4' }), contractOf({ id: 'shop', version: '5', compat: ['4', '3'] })).client.negotiate();
    assert.deepStrictEqual([n.compatible, n.reason, n.error], [true, 'server-accepts', null]);
  });

  it('client-accepts: the server\'s version is in the client\'s compat', async () => {
    const n = await pair(contractOf({ id: 'shop', version: '6', compat: ['5'] }), contractOf({ id: 'shop', version: '5' })).client.negotiate();
    assert.deepStrictEqual([n.compatible, n.reason, n.error], [true, 'client-accepts', null]);
  });

  it('version-mismatch: none of the rules hold — JC2057 names both versions', async () => {
    const serverContract = contractOf({ id: 'shop', version: '5', compat: ['3'] });
    const n = await pair(contractOf({ id: 'shop', version: '6', compat: ['4'] }), serverContract).client.negotiate();
    assert.deepStrictEqual([n.compatible, n.reason, n.error?.code], [false, 'version-mismatch', 'JC2057']);
    assert.match(/** @type {string} */ (n.error?.message), /version 5 of contract shop; this client speaks 6/);
    assert.deepStrictEqual(n.server, { id: 'shop', version: '5', compat: ['3'], revision: await serverContract.revision() });
    // a versioned server against an unversioned client is a mismatch too (null ≠ '5', neither compat names the other)
    const n2 = await pair(contractOf({ id: 'shop' }), contractOf({ id: 'shop', version: '5' })).client.negotiate();
    assert.deepStrictEqual([n2.compatible, n2.reason], [false, 'version-mismatch']);
  });

  it('not-a-contract: another contract id, no description, another document, a non-200 — JC2056', async () => {
    // another id: the partner's "unrelated service on the port" case
    const other = await pair(contractOf({ id: 'shop', version: '5' }), contractOf({ id: 'billing', version: '5' })).client.negotiate();
    assert.deepStrictEqual([other.compatible, other.reason, other.error?.code], [false, 'not-a-contract', 'JC2056']);
    assert.deepStrictEqual(other.server?.id, 'billing', 'the server as it described itself is still reported');
    // the well-known path disabled server-side → 404
    const off = await pair(contractOf({ id: 'shop' }), contractOf({ id: 'shop' }), { wellKnown: false }).client.negotiate();
    assert.deepStrictEqual([off.compatible, off.reason, off.server], [false, 'not-a-contract', null]);
    // another well-known path on the server than the client asks
    const moved = await pair(contractOf({ id: 'shop' }), contractOf({ id: 'shop' }), { wellKnown: '/elsewhere' }).client.negotiate();
    assert.strictEqual(moved.reason, 'not-a-contract');
    const there = openHttpClient(contractOf({ id: 'shop' }), { wellKnown: '/elsewhere',
      fetch: (url, init) => toFetchHandler(serveHttp(contractOf({ id: 'shop' }), { ping: () => true }, { wellKnown: '/elsewhere' }))(new Request('http://x' + url, init)) });
    assert.strictEqual((await there.negotiate()).reason, 'same-version');
    // a 200 that is not a contract description
    for (const body of ['<html>', '{"hello":"world"}', '{"$contract":"0.2","operations":[]}', '{"$contract":"0.1","operations":{}}', 'null']) {
      const c = openHttpClient(contractOf({ id: 'shop' }), { fetch: async () => new Response(body, { status: 200 }) });
      const n = await c.negotiate();
      assert.deepStrictEqual([n.compatible, n.reason, n.error?.code], [false, 'not-a-contract', 'JC2056'], body);
    }
    // a client without an id accepts any server id (nothing else is inferred)
    const anon = await pair(contractOf({ version: '1' }), contractOf({ id: 'whatever', version: '1' })).client.negotiate();
    assert.deepStrictEqual([anon.compatible, anon.reason], [true, 'same-version']);
  });

  it('unreachable: the transport rejected — JC2051 with the error name only; an abort is unreachable too', async () => {
    const down = openHttpClient(contractOf({ id: 'shop' }), { fetch: async () => { throw new TypeError('fetch failed https://user:pw@host'); } });
    const n = await down.negotiate();
    assert.deepStrictEqual(n, { compatible: false, reason: 'unreachable', server: null, error: { code: 'JC2051', message: 'the request of the negotiation did not complete (TypeError)' } });
    const ctl = new AbortController();
    ctl.abort();
    const aborted = openHttpClient(contractOf({ id: 'shop' }), { fetch: (url, init) => Promise.reject(init.signal?.reason) });
    assert.strictEqual((await aborted.negotiate({ signal: ctl.signal })).reason, 'unreachable');
    // static headers ride along (an authenticated well-known path)
    /** @type {any} */
    let seen;
    const withAuth = openHttpClient(contractOf({ id: 'shop' }), { headers: { authorization: 'Bearer t' }, fetch: async (url, init) => { seen = init; return new Response('{}', { status: 500 }); } });
    await withAuth.negotiate();
    assert.strictEqual(seen.headers.authorization, 'Bearer t');
    assert.strictEqual(seen.method, 'GET');
  });
});
