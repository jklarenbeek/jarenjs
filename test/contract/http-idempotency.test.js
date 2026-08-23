//@ts-check
/**
 * @file Idempotency through the http binding and the memory ledger:
 * new / replay / in-progress / mismatch / retryable re-run / expiry, the
 * ledger's own contract (`claim`/`commit`/`fail`/`lookup`, `sweep`), an
 * asynchronous ledger, the host `scope`, the precondition interplay
 * (claim first, resolver second — a committed key replays before the
 * resolver runs; a POST-handler 412 is recorded non-retryable so a blind
 * retry replays it instead of re-running a handler that already
 * mutated), and the identity trinity — a spoofed `x-jaren-trace` is
 * ignored, an `x-attempt` header is never read, the key comes only from
 * `idempotency-key`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { canonicalSha256 } from '@jarenjs/json/canonical';
import { load, shopHandlers, req, jsonReq, json } from './helpers.js';

const shop = compileContract(load('./fixtures/shop.contract.json'));
const SAVE = { revision: 1, product: { id: 1, name: 'x', price: 1 } };
const URL = '/api/products/1/master';

/**
 * @param {Record<string, any>} [overrides]
 * @param {any} [options]
 */
function serve(overrides = {}, options = {}) {
  const ledger = options.ledger ?? createMemoryLedger();
  return { server: serveHttp(shop, { ...shopHandlers(), ...overrides }, { ledger, ...options }), ledger };
}

describe('idempotency — the binding over the memory ledger', () => {
  it('same key + same body → the stored status and body verbatim, a fresh trace, idempotent-replayed; the handler ran once', async () => {
    let calls = 0;
    const { server, ledger } = serve({ 'product.save': (input) => { calls++; return { id: input.id, name: `call-${calls}`, price: 1 }; } });
    const a = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k1' }));
    const b = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k1' }));
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);
    assert.strictEqual(b.body, a.body);
    assert.deepStrictEqual(json(b), { id: 1, name: 'call-1', price: 1 });
    assert.notStrictEqual(b.headers['x-jaren-trace'], a.headers['x-jaren-trace']);
    assert.strictEqual(a.headers['idempotent-replayed'], undefined);
    assert.strictEqual(b.headers['idempotent-replayed'], 'true');
    assert.strictEqual(calls, 1);
    const record = ledger.lookup({ op: 'product.save', scope: '', key: 'k1' });
    assert.ok(record !== null);
    assert.strictEqual(record.status, 'committed');
    assert.strictEqual(record.hash, await canonicalSha256({ id: 1, revision: 1, product: { id: 1, name: 'x', price: 1 } }));
    assert.strictEqual(record.response.body, a.body);
    // the same body with members in another order is the same request (RFC 8785)
    const c = await server.dispatch(jsonReq('PUT', URL, { product: { price: 1, name: 'x', id: 1 }, revision: 1 }, { 'idempotency-key': 'k1' }));
    assert.strictEqual(c.headers['idempotent-replayed'], 'true');
    assert.strictEqual(calls, 1);
  });

  it('same key + different body → 409 mismatch; a different key runs again', async () => {
    let calls = 0;
    const { server } = serve({ 'product.save': () => { calls++; return { id: 1, name: 'x', price: 1 }; } });
    await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k' }));
    const mismatch = await server.dispatch(jsonReq('PUT', URL, { ...SAVE, revision: 9 }, { 'idempotency-key': 'k' }));
    assert.strictEqual(mismatch.status, 409);
    assert.deepStrictEqual(json(mismatch).details, [{ kind: 'mismatch' }]);
    assert.strictEqual(json(mismatch).retryable, false);
    await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'other' }));
    assert.strictEqual(calls, 2);
  });

  it('a concurrent second request while the first is in flight → 409 in-progress with retry-after; afterwards it replays', async () => {
    let release = () => {};
    const gate = new Promise((resolve) => { release = () => resolve(undefined); });
    const { server } = serve({ 'product.save': async () => { await gate; return { id: 1, name: 'x', price: 1 }; } });
    const first = server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k' }));
    const second = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k' }));
    assert.strictEqual(second.status, 409);
    assert.strictEqual(json(second).retryable, true);
    assert.strictEqual(second.headers['retry-after'], '1');
    release();
    const done = await first;
    assert.strictEqual(done.status, 200);
    const third = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k' }));
    assert.strictEqual(third.headers['idempotent-replayed'], 'true');
    assert.strictEqual(third.body, done.body);
  });

  it('a declared failure is stored: non-retryable replays, retryable re-runs', async () => {
    let calls = 0;
    const { server, ledger } = serve({ 'product.save': (i, ctx) => { calls++; return ctx.fail('conflict', {}, { current: { id: 1, name: 'y', price: 2 } }); } });
    const a = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'c' }));
    assert.strictEqual(a.status, 409);
    const b = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'c' }));
    assert.strictEqual(b.status, 409);
    assert.strictEqual(b.headers['idempotent-replayed'], 'true');
    assert.strictEqual(b.body, a.body);
    assert.strictEqual(calls, 1);
    const record = ledger.lookup({ op: 'product.save', scope: '', key: 'c' });
    assert.strictEqual(record?.status, 'failed');
    assert.strictEqual(record?.retryable, false);
    // retryable: the key may be retried, the handler runs again
    let runs = 0;
    const retry = serve({ 'product.save': (i, ctx) => { runs++; return runs === 1 ? ctx.fail('not-found', {}, undefined, { retryable: true }) : { id: 1, name: 'x', price: 1 }; } });
    const r1 = await retry.server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'r' }));
    assert.strictEqual(r1.status, 404);
    assert.strictEqual(json(r1).retryable, true);
    const r2 = await retry.server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'r' }));
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r2.headers['idempotent-replayed'], undefined);
    assert.strictEqual(runs, 2);
    assert.strictEqual(retry.ledger.lookup({ op: 'product.save', scope: '', key: 'r' })?.status, 'committed');
  });

  it('a server fault (JC2008/JC2010) releases the key: the next attempt runs again', async () => {
    let runs = 0;
    const { server, ledger } = serve({ 'product.save': () => { runs++; if (runs === 1) throw new Error('transient'); return { id: 1, name: 'x', price: 1 }; } });
    assert.strictEqual((await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'f' }))).status, 500);
    const rec = ledger.lookup({ op: 'product.save', scope: '', key: 'f' });
    assert.strictEqual(rec?.status, 'failed');
    assert.strictEqual(rec?.retryable, true);
    assert.strictEqual(rec?.response, null);
    assert.strictEqual((await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'f' }))).status, 200);
    assert.strictEqual(runs, 2);
    const invalid = serve({ 'product.save': () => { runs++; return runs === 3 ? { id: 'bad' } : { id: 1, name: 'x', price: 1 }; } });
    assert.strictEqual((await invalid.server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'g' }))).status, 500);
    assert.strictEqual((await invalid.server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'g' }))).status, 200);
  });

  it('expiry: a record past its TTL is dropped on claim (the binding\'s clock reaches the ledger), and sweep() drops the rest', async () => {
    let t = 1_000_000;
    const ledger = createMemoryLedger({ ttlMs: 100 });
    let calls = 0;
    const { server } = serve({ 'product.save': () => { calls++; return { id: 1, name: 'x', price: 1 }; } }, { ledger, now: () => t });
    await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'e' }));
    t += 50;
    assert.strictEqual((await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'e' }))).headers['idempotent-replayed'], 'true');
    t += 100;
    assert.strictEqual((await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'e' }))).headers['idempotent-replayed'], undefined);
    assert.strictEqual(calls, 2);
    // the ledger's own clock decides lookup and sweep
    let own = 0;
    const timed = createMemoryLedger({ ttlMs: 10, now: () => own });
    const claimed = timed.claim({ op: 'a', scope: '', key: 'k', hash: 'h' });
    assert.strictEqual(claimed.state, 'new');
    timed.commit(claimed.ref, { status: 200, headers: {}, body: '1' });
    assert.strictEqual(timed.size, 1);
    assert.strictEqual(timed.lookup({ op: 'a', scope: '', key: 'k' })?.status, 'committed');
    own = 11;
    assert.strictEqual(timed.lookup({ op: 'a', scope: '', key: 'k' }), null);
    assert.strictEqual(timed.size, 0);
    timed.claim({ op: 'a', scope: '', key: 'k2', hash: 'h' });
    timed.claim({ op: 'a', scope: '', key: 'k3', hash: 'h' });
    own = 30;
    assert.strictEqual(timed.sweep(), 2);
    assert.strictEqual(timed.size, 0);
  });

  it('the memory ledger\'s own contract: states, stale refs, options', () => {
    const ledger = createMemoryLedger();
    const first = ledger.claim({ op: 'o', scope: 's', key: 'k', hash: 'h1' });
    assert.strictEqual(first.state, 'new');
    assert.deepStrictEqual(ledger.claim({ op: 'o', scope: 's', key: 'k', hash: 'h1' }), { state: 'in-progress' });
    assert.deepStrictEqual(ledger.claim({ op: 'o', scope: 's', key: 'k', hash: 'h2' }), { state: 'mismatch' });
    // a different scope is a different key
    assert.strictEqual(ledger.claim({ op: 'o', scope: 'other', key: 'k', hash: 'h1' }).state, 'new');
    // a different op is a different key
    assert.strictEqual(ledger.claim({ op: 'p', scope: 's', key: 'k', hash: 'h1' }).state, 'new');
    ledger.commit(first.ref, { status: 200, headers: {}, body: 'ok' });
    assert.deepStrictEqual(ledger.claim({ op: 'o', scope: 's', key: 'k', hash: 'h1' }), { state: 'replay', response: { status: 200, headers: {}, body: 'ok' } });
    // a stale ref (the record was replaced) is ignored
    const failed = ledger.claim({ op: 'o', scope: 's', key: 'f', hash: 'h' });
    ledger.fail(failed.ref, true);
    const again = ledger.claim({ op: 'o', scope: 's', key: 'f', hash: 'h' });
    assert.strictEqual(again.state, 'new');
    ledger.commit(failed.ref, { status: 200, headers: {}, body: 'stale' });
    assert.strictEqual(ledger.lookup({ op: 'o', scope: 's', key: 'f' })?.status, 'started');
    ledger.fail(failed.ref, false, { status: 400, headers: {}, body: 'stale' });
    assert.strictEqual(ledger.lookup({ op: 'o', scope: 's', key: 'f' })?.status, 'started');
    // a non-retryable failure without a stored response cannot replay: the key is new again
    const nores = ledger.claim({ op: 'o', scope: 's', key: 'n', hash: 'h' });
    ledger.fail(nores.ref, false);
    assert.strictEqual(ledger.claim({ op: 'o', scope: 's', key: 'n', hash: 'h' }).state, 'new');
    assert.strictEqual(ledger.lookup({ op: 'o', scope: 's', key: 'missing' }), null);
    assert.throws(() => createMemoryLedger({ ttlMs: 0 }), TypeError);
    assert.throws(() => createMemoryLedger({ now: /** @type {any} */ (5) }), TypeError);
  });

  it('an asynchronous ledger composes: every method may return a promise; a ledger that throws on commit is observed and the response still goes out', async () => {
    const memory = createMemoryLedger();
    const asyncLedger = {
      claim: (/** @type {any} */ c) => Promise.resolve(memory.claim(c)),
      commit: (/** @type {any} */ ref, /** @type {any} */ response) => Promise.resolve(memory.commit(ref, response)),
      fail: (/** @type {any} */ ref, /** @type {any} */ retryable, /** @type {any} */ response) => Promise.resolve(memory.fail(ref, retryable, response)),
      lookup: (/** @type {any} */ k) => Promise.resolve(memory.lookup(k)),
    };
    const { server } = serve({}, { ledger: asyncLedger });
    const a = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'a' }));
    assert.strictEqual(a.status, 200);
    const b = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'a' }));
    assert.strictEqual(b.headers['idempotent-replayed'], 'true');
    assert.strictEqual((await asyncLedger.lookup({ op: 'product.save', scope: '', key: 'a' }))?.status, 'committed');
    /** @type {unknown[]} */
    const seen = [];
    const throwing = { ...asyncLedger, commit: () => { throw new Error('disk'); } };
    const t = serve({}, { ledger: throwing, onError: (err) => { seen.push(err); } });
    assert.strictEqual((await t.server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'b' }))).status, 200);
    assert.strictEqual(seen.length, 1);
    const rejecting = { ...asyncLedger, commit: () => Promise.reject(new Error('disk')) };
    const r = serve({}, { ledger: rejecting, onError: (err) => { seen.push(err); } });
    assert.strictEqual((await r.server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'c' }))).status, 200);
    assert.strictEqual(seen.length, 2);
    // a ledger answering an unknown state, or replaying a non-response, is a server fault
    const weird = { ...asyncLedger, claim: () => ({ state: 'weird' }) };
    assert.strictEqual(json(await serve({}, { ledger: weird }).server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'w' }))).code, 'JC2008');
    const badReplay = { ...asyncLedger, claim: () => ({ state: 'replay', response: 5 }) };
    assert.strictEqual(json(await serve({}, { ledger: badReplay }).server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'w' }))).code, 'JC2008');
  });

  it('scope separates installations: the same key under two scopes is two claims; a broken scope function is a server fault', async () => {
    let calls = 0;
    const { server } = serve({ 'product.save': () => { calls++; return { id: 1, name: 'x', price: 1 }; } },
      { scope: (ctx) => ctx.headers['x-tenant'] ?? '' });
    // x-tenant is not a declared header member, so it is not in ctx.headers — scope reads only what the contract declares
    await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k', 'x-tenant': 'a' }));
    await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'k', 'x-tenant': 'b' }));
    assert.strictEqual(calls, 1, 'undeclared headers never reach the scope function');
    const scoped = compileContract({ $contract: '0.1', operations: { 'cmd': {
      kind: 'command', input: { type: 'object', required: ['tenant'], properties: { tenant: { type: 'string' }, n: { type: 'integer' } } }, output: true,
      policy: { idempotency: 'required' }, http: { method: 'POST', path: '/cmd', in: { tenant: 'header' } } } } });
    let runs = 0;
    /** @type {any[]} */
    const seenScopes = [];
    const s = serveHttp(scoped, { cmd: (input, ctx) => { runs++; seenScopes.push(ctx.idempotency); return true; } },
      { ledger: createMemoryLedger(), scope: (ctx) => ctx.headers.tenant });
    await s.dispatch(jsonReq('POST', '/cmd', { n: 1 }, { 'idempotency-key': 'k', tenant: 'a' }));
    await s.dispatch(jsonReq('POST', '/cmd', { n: 1 }, { 'idempotency-key': 'k', tenant: 'b' }));
    await s.dispatch(jsonReq('POST', '/cmd', { n: 1 }, { 'idempotency-key': 'k', tenant: 'a' }));
    assert.strictEqual(runs, 2);
    assert.deepStrictEqual(seenScopes, [{ key: 'k', scope: 'a' }, { key: 'k', scope: 'b' }]);
    const broken = serveHttp(scoped, { cmd: () => true }, { ledger: createMemoryLedger(), scope: () => { throw new Error('no'); } });
    assert.strictEqual(json(await broken.dispatch(jsonReq('POST', '/cmd', { n: 1 }, { 'idempotency-key': 'k', tenant: 'a' }))).code, 'JC2008');
    const nonString = serveHttp(scoped, { cmd: () => true }, { ledger: createMemoryLedger(), scope: () => /** @type {any} */ (5) });
    assert.strictEqual(json(await nonString.dispatch(jsonReq('POST', '/cmd', { n: 1 }, { 'idempotency-key': 'k', tenant: 'a' }))).code, 'JC2008');
  });

  it('a body the canonicalizer refuses (a lone surrogate) is invalid input, not a rejection', async () => {
    const { server } = serve();
    const r = await server.dispatch(req('PUT', URL, { 'content-type': 'application/json', 'idempotency-key': 'k' },
      JSON.stringify({ revision: 1, product: { id: 1, name: 'x', price: 1 } }).replace('"x"', '"\\ud800"')));
    assert.strictEqual(r.status, 400);
    assert.strictEqual(json(r).code, 'JC2006');
    assert.deepStrictEqual(json(r).details, [{ path: '/product/name', keyword: 'canonical' }]);
  });

  it('opaque operations bypass the ledger; reads never carry a key', async () => {
    const { server, ledger } = serve();
    await server.dispatch(req('GET', '/api/images/1', { 'idempotency-key': 'k' }));
    await server.dispatch(req('GET', '/api/catalog', { 'idempotency-key': 'k' }));
    assert.strictEqual(ledger.size, 0);
  });

  it('claim first, precondition second: a committed key replays before the resolver runs', async () => {
    let resolves = 0;
    let calls = 0;
    const { server } = serve(
      { 'product.save': () => { calls += 1; return { id: 1, name: 'x', price: 1 }; } },
      { preconditions: { 'product.save': () => { resolves += 1; return 'r1'; } } });
    const a = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'pc1', 'if-match': '"r1"' }));
    assert.strictEqual(a.status, 200);
    assert.strictEqual(resolves, 1);
    // the retry arrives with a STALE If-Match — the committed outcome
    // still wins: the stored response replays and the resolver never runs
    const b = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'pc1', 'if-match': '"r0"' }));
    assert.strictEqual(b.status, 200);
    assert.strictEqual(b.headers['idempotent-replayed'], 'true');
    assert.strictEqual(resolves, 1, 'the resolver never ran on the replay');
    assert.strictEqual(calls, 1);
  });

  it('a POST-handler 412 (no resolver, the handler armed the tag late) is recorded non-retryable: the same key replays the 412, the handler does not run again', async () => {
    let calls = 0;
    const { server, ledger } = serve({
      'product.save': (/** @type {any} */ input, /** @type {any} */ ctx) => { calls += 1; ctx.etag('r9', { strong: true }); return { id: 1, name: 'x', price: 1 }; },
    });
    // the stale If-Match is compared only AFTER the handler ran — the
    // mutation happened and the wire still says 412; what the ledger must
    // never do is hand that key back for a blind re-run
    const first = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'ph1', 'if-match': '"r8"' }));
    assert.strictEqual(first.status, 412);
    assert.strictEqual(json(first).code, 'JC2014');
    assert.strictEqual(calls, 1, 'the handler already ran — the post-handler comparison is not a write guard');
    const record = ledger.lookup({ op: 'product.save', scope: '', key: 'ph1' });
    assert.strictEqual(record?.status, 'failed');
    assert.strictEqual(record?.retryable, false);
    const retry = await server.dispatch(jsonReq('PUT', URL, SAVE, { 'idempotency-key': 'ph1', 'if-match': '"r8"' }));
    assert.strictEqual(retry.status, 412);
    assert.strictEqual(retry.headers['idempotent-replayed'], 'true');
    assert.strictEqual(calls, 1, 'the recorded 412 replays; the handler never runs twice under one key');
  });
});

describe('idempotency — the identity trinity', () => {
  it('a spoofed x-jaren-trace is ignored (fresh trace), x-attempt is never read, the key comes only from idempotency-key', async () => {
    /** @type {any[]} */
    const seen = [];
    const { server, ledger } = serve({ 'product.save': (input, ctx) => { seen.push(ctx); return { id: 1, name: 'x', price: 1 }; } });
    const spoofed = { 'idempotency-key': 'real', 'x-jaren-trace': 'spoofed-trace', 'x-attempt': 'a-1', 'x-idempotency-key': 'wrong', 'idempotency_key': 'wrong' };
    const a = await server.dispatch(jsonReq('PUT', URL, SAVE, spoofed));
    assert.notStrictEqual(a.headers['x-jaren-trace'], 'spoofed-trace');
    assert.match(a.headers['x-jaren-trace'], /^[0-9a-f-]{36}$/);
    assert.deepStrictEqual(seen[0].idempotency, { key: 'real', scope: '' });
    assert.deepStrictEqual(seen[0].headers, {}, 'no attempt id, no spoofed trace reaches the handler');
    assert.notStrictEqual(ledger.lookup({ op: 'product.save', scope: '', key: 'a-1' }), undefined);
    assert.strictEqual(ledger.lookup({ op: 'product.save', scope: '', key: 'a-1' }), null);
    assert.strictEqual(ledger.lookup({ op: 'product.save', scope: '', key: 'wrong' }), null);
    assert.ok(ledger.lookup({ op: 'product.save', scope: '', key: 'real' }) !== null);
    // a second attempt with a different x-attempt but the same key replays; a different key runs
    const b = await server.dispatch(jsonReq('PUT', URL, SAVE, { ...spoofed, 'x-attempt': 'a-2' }));
    assert.strictEqual(b.headers['idempotent-replayed'], 'true');
    assert.notStrictEqual(b.headers['x-jaren-trace'], a.headers['x-jaren-trace']);
    const c = await server.dispatch(jsonReq('PUT', URL, SAVE, { ...spoofed, 'idempotency-key': 'real-2' }));
    assert.strictEqual(c.headers['idempotent-replayed'], undefined);
    assert.strictEqual(seen.length, 2);
    // the trace is never persisted: the replayed record carries no trace of the first request
    const record = ledger.lookup({ op: 'product.save', scope: '', key: 'real' });
    assert.strictEqual(record?.response.headers['x-jaren-trace'], a.headers['x-jaren-trace'], 'the stored response is verbatim');
    assert.strictEqual(b.headers['x-jaren-trace'] === record?.response.headers['x-jaren-trace'], false, 'but the replay never re-uses it');
  });
});
