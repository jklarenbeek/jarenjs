//@ts-check
/**
 * @file The contract revision (CONTRACT-FORMAT.md §14): 64 lowercase hex
 * over the canonical bytes of the public projection — deterministic
 * across compiles, memoized per contract, moved by every client-visible
 * change and by nothing a client cannot observe (a `server`-audience
 * operation, a `policy.limits` value), equal for two documents that
 * differ only in spelled-out defaults, `null` in `describe()` until
 * computed, `JC0061` with the projection `dataPath` when the projection
 * is not canonicalizable — and carried end to end: the well-known
 * document serves it, `negotiate()` learns it, and every subsequent
 * outcome's `meta.revision` repeats it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract, ContractCompileError } from '@jarenjs/contract';
import { serveHttp, WELL_KNOWN_PATH } from '@jarenjs/contract/http';
import { toFetchHandler } from '@jarenjs/contract/fetch';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { openHttpClient } from '@jarenjs/contract/client';
import { load } from './helpers.js';

const shop = load('./fixtures/shop.contract.json');

/** @param {any} doc @param {(d: any) => void} [edit] */
function reviseDoc(doc, edit) {
  const copy = JSON.parse(JSON.stringify(doc));
  if (edit !== undefined) edit(copy);
  return copy;
}

describe('contract.revision() — the digest', () => {
  it('is 64 lowercase hex, memoized, and two compiles of the same document agree', async () => {
    const first = compileContract(shop);
    const hex = await first.revision();
    assert.match(hex, /^[0-9a-f]{64}$/);
    assert.strictEqual(await first.revision(), hex, 'memoized: the same promise resolution');
    assert.strictEqual(await compileContract(reviseDoc(shop)).revision(), hex, 'a second compile agrees');
  });

  it("changes when a public operation's output changes", async () => {
    const base = await compileContract(shop).revision();
    const edited = reviseDoc(shop, (d) => { d.operations['catalog.load'].output = { type: 'object' }; });
    assert.notStrictEqual(await compileContract(edited).revision(), base);
  });

  it('does NOT change for a server-audience operation or a policy.limits value', async () => {
    const base = await compileContract(shop).revision();
    const withServerOp = reviseDoc(shop, (d) => {
      d.operations['ops.sweep'] = {
        kind: 'command', output: true, policy: { audience: 'server' },
        http: { method: 'POST', path: '/internal/sweep' },
      };
    });
    assert.strictEqual(await compileContract(withServerOp).revision(), base,
      'a server-audience operation never reaches the projection');
    const withLimits = reviseDoc(shop, (d) => {
      d.operations['product.save'].policy.limits = { maxBodyBytes: 4096 };
    });
    assert.strictEqual(await compileContract(withLimits).revision(), base,
      'policy.limits is a server-side knob outside the projection');
  });

  it('hashes behavior, not spelling: a canonical binding written out equals the inferred one', async () => {
    const inferred = compileContract({
      $contract: '0.1', operations: { 'ping.run': { kind: 'command', output: true } },
    });
    const declared = compileContract({
      $contract: '0.1',
      operations: {
        'ping.run': {
          kind: 'command', output: true,
          http: { method: 'POST', path: '/ping.run', status: 200, media: 'application/json' },
        },
      },
    });
    assert.strictEqual(await inferred.revision(), await declared.revision());
  });

  it('describe() carries null before the digest and the hex after — never computing it itself', async () => {
    const contract = compileContract(reviseDoc(shop));
    assert.strictEqual(contract.describe().revision, null);
    assert.strictEqual(contract.describe().revision, null, 'describe() never triggers the digest');
    const hex = await contract.revision();
    assert.strictEqual(contract.describe().revision, hex);
  });

  it('JC0061: a projection that is not canonicalizable rejects with the dataPath into the projection', async () => {
    const contract = compileContract({
      $contract: '0.1',
      operations: { 'bad.op': { kind: 'read', output: { const: '\uD800' }, http: { method: 'GET', path: '/bad' } } },
    });
    await assert.rejects(contract.revision(), (err) => {
      assert.ok(err instanceof ContractCompileError);
      assert.strictEqual(err.code, 'JC0061');
      assert.strictEqual(err.docPath, '/operations/bad.op/output/const');
      return true;
    });
    // deterministic refusal: it recurs, it is not cached as a revision
    await assert.rejects(contract.revision(), (/** @type {any} */ err) => err.code === 'JC0061');
    assert.strictEqual(contract.describe().revision, null);
  });
});

describe('the revision end to end — well-known, negotiate, meta.revision', () => {
  it('the well-known request computes it once, negotiate() learns it, every later outcome carries it', async () => {
    const serverContract = compileContract(reviseDoc(shop, (d) => { d.compat = []; }));
    const handler = toFetchHandler(serveHttp(serverContract, {
      'catalog.load': () => ({ revision: 1, products: [] }),
      'product.save': (/** @type {any} */ input) => ({ id: input.id, name: 'n', price: 1 }),
      'image.bytes': () => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array([1]) }),
      'product.search': () => [],
      'product.remove': () => true,
    }, { ledger: createMemoryLedger() }));
    const client = openHttpClient(compileContract(reviseDoc(shop, (d) => { d.compat = []; })), {
      fetch: (url, init) => handler(new Request('http://x' + url, init)),
    });

    const before = await client.invoke('catalog.load', {});
    assert.strictEqual(before.meta.revision, null, 'nothing negotiated yet');

    const n = await client.negotiate();
    const hex = await serverContract.revision();
    assert.strictEqual(n.server?.revision, hex, 'the well-known document carries the computed revision');

    const after = await client.invoke('catalog.load', {});
    assert.strictEqual(after.ok, true);
    assert.strictEqual(after.meta.revision, hex, 'meta.revision repeats the negotiated revision');
    const failed = await client.invoke('catalog.load', 5);
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.meta.revision, hex, 'a pre-send refusal carries it too');
  });

  it('a server whose projection cannot be canonicalized observes JC0061 once and serves revision: null', async () => {
    /** @type {unknown[]} */
    const observed = [];
    const server = serveHttp(compileContract({
      $contract: '0.1',
      operations: { 'bad.op': { kind: 'read', output: { const: '\uD800' }, http: { method: 'GET', path: '/bad' } } },
    }), { 'bad.op': () => 'x' }, { onError: (err) => { observed.push(err); } });
    const first = await server.dispatch({ method: 'GET', url: WELL_KNOWN_PATH, headers: {}, body: null });
    assert.strictEqual(first.status, 200);
    assert.strictEqual(JSON.parse(/** @type {string} */ (first.body)).revision, null);
    assert.strictEqual(observed.length, 1);
    assert.strictEqual(/** @type {any} */ (observed[0]).code, 'JC0061');
    const second = await server.dispatch({ method: 'GET', url: WELL_KNOWN_PATH, headers: {}, body: null });
    assert.strictEqual(second.status, 200);
    assert.strictEqual(observed.length, 1, 'the memoized description never recomputes');
  });
});
