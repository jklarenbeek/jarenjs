//@ts-check
/**
 * @file The local binding: client and server in one object over the
 * same pipeline as HTTP, with no wire. Outcomes carry the fixed D6
 * members — a declared failure is `kind: "failure"` with `status: null`
 * PRESENT (this binding carries no statuses and never omits the
 * member), a handler fault of any class is `kind: "contract"` `JC2070`
 * with the cause reported to `onError`, an aborted signal or a closed
 * client is `kind: "cancelled"`, an invalid input is the pre-send
 * `JC2050` — and every `error`/`meta` holds exactly the
 * `OUTCOME_ERROR_MEMBERS`/`OUTCOME_META_MEMBERS`, none `undefined`.
 * Construction refuses host mistakes; what the binding cannot carry it
 * refuses (`invoke` of an opaque operation) or ignores loudly (a
 * declared idempotency policy — the same contract must serve over http
 * and locally).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract, ContractRuntimeError } from '@jarenjs/contract';
import { openLocalClient, serveLocal, PORT_LOCAL_ERRORS } from '@jarenjs/contract/local';
import { OUTCOME_ERROR_MEMBERS, OUTCOME_META_MEMBERS } from '@jarenjs/contract/client';
import { load, shopHandlers } from './helpers.js';

const shop = compileContract(load('./fixtures/shop.contract.json'));
const PRODUCT = { id: 1, name: 'x', price: 1 };
const SAVE = { id: 1, revision: 2, product: PRODUCT };

/**
 * Every outcome's error and meta carry exactly the D6 members, none
 * `undefined` — the 03A invariant every later binding inherits.
 * @param {any} outcome
 */
function assertShape(outcome) {
  assert.deepStrictEqual(Object.keys(outcome.meta), [...OUTCOME_META_MEMBERS]);
  for (const m of OUTCOME_META_MEMBERS) assert.notStrictEqual(outcome.meta[m], undefined, `meta.${m}`);
  if (!outcome.ok) {
    assert.deepStrictEqual(Object.keys(outcome.error), [...OUTCOME_ERROR_MEMBERS]);
    for (const m of OUTCOME_ERROR_MEMBERS) assert.notStrictEqual(outcome.error[m], undefined, `error.${m}`);
  }
  return outcome;
}

/** @param {Record<string, any>} [handlers] @param {any} [options] */
function open(handlers = {}, options = {}) {
  return openLocalClient(shop, { ...shopHandlers(), ...handlers }, options);
}

describe('openLocalClient — construction', () => {
  it('serveLocal IS openLocalClient; capabilities are the frozen no-wire table; describe answers the contract', () => {
    assert.strictEqual(serveLocal, openLocalClient);
    const client = open();
    assert.deepStrictEqual(client.capabilities, {
      name: 'local', status: false, headers: false, media: false, etag: false,
      idempotency: false, validatedOutput: true, stream: false, cancel: 'signal',
    });
    assert.strictEqual(Object.isFrozen(client.capabilities), true);
    assert.strictEqual(client.contract, shop);
    assert.strictEqual(client.describe().id, 'shop');
    assert.strictEqual(open({}, { validateOutput: 'never' }).capabilities.validatedOutput, false);
  });

  it('refuses host mistakes: JC1001 arguments and options, JC1002 missing handler — with opaque operations exempt', () => {
    assert.throws(() => openLocalClient(/** @type {any} */ ({}), {}), (/** @type {any} */ e) => e.code === 'JC1001' && e instanceof TypeError);
    assert.throws(() => openLocalClient(shop, /** @type {any} */ (null)), (/** @type {any} */ e) => e.code === 'JC1001');
    assert.throws(() => openLocalClient(shop, { nope: () => 1 }), (/** @type {any} */ e) => e.code === 'JC1001' && /'nope'/.test(e.message));
    assert.throws(() => openLocalClient(shop, { 'catalog.load': /** @type {any} */ (1) }), (/** @type {any} */ e) => e.code === 'JC1001');
    assert.throws(() => open({}, { validateOutput: 'sometimes' }), (/** @type {any} */ e) => e.code === 'JC1001');
    assert.throws(() => open({}, { trace: /** @type {any} */ ('x') }), (/** @type {any} */ e) => e.code === 'JC1001');
    assert.throws(() => open({}, { catalog: /** @type {any} */ (null) }), (/** @type {any} */ e) => e.code === 'JC1001');
    const { 'catalog.load': _dropped, ...missing } = shopHandlers();
    assert.throws(() => openLocalClient(shop, missing), (/** @type {any} */ e) => e.code === 'JC1002' && /'catalog\.load'/.test(e.message));
    // the opaque image.bytes needs NO handler here (it cannot be invoked) —
    // and a handler table that carries one (an http table reused verbatim) is accepted
    const { 'image.bytes': _raw, ...noRaw } = shopHandlers();
    assert.doesNotThrow(() => openLocalClient(shop, noRaw));
    assert.doesNotThrow(() => openLocalClient(shop, shopHandlers()));
    // a declared idempotency policy (product.save: required) is allowed and inert — no ledger exists here
    assert.strictEqual(open().capabilities.idempotency, false);
  });
});

describe('openLocalClient — outcomes', () => {
  it('a success validates the output once and lands with value, trace and the D6 meta', async () => {
    const client = open({}, { trace: () => 'trace-1' });
    const outcome = /** @type {any} */ (assertShape(await client.invoke('catalog.load', { since: '2026-01-01T00:00:00Z' }, { attempt: 7 })));
    assert.strictEqual(outcome.ok, true);
    assert.deepStrictEqual(outcome.value, { revision: 1, products: [{ id: 1, name: 'a', price: 1 }] });
    assert.deepStrictEqual(outcome.meta, { op: 'catalog.load', attempt: 7, trace: 'trace-1', revision: null, etag: null, notModified: false });
  });

  it('a declared error → kind failure with status null (present, never omitted), the rendered message, details and retryability', async () => {
    const client = open({ 'product.save': (/** @type {any} */ _i, /** @type {any} */ ctx) => ctx.fail('conflict', {}, { current: PRODUCT }) });
    const outcome = /** @type {any} */ (assertShape(await client.invoke('product.save', SAVE)));
    assert.deepStrictEqual([outcome.ok, outcome.kind], [false, 'failure']);
    assert.deepStrictEqual(outcome.error, {
      code: 'conflict', message: 'operation product.save failed with conflict',
      status: null, details: { current: PRODUCT }, retryable: false,
    });
    assert.strictEqual(Object.hasOwn(outcome.error, 'status'), true, 'the member is present');
    // a thrown declared ContractRuntimeError lands the same way; retry policy decides retryable
    const thrown = open({ 'product.save': () => { throw new ContractRuntimeError('not-found', 'gone', { msgid: 'contract/handler-error' }); } });
    const nf = /** @type {any} */ (assertShape(await thrown.invoke('product.save', SAVE)));
    assert.deepStrictEqual([nf.kind, nf.error.code, nf.error.status, nf.error.retryable, nf.error.details], ['failure', 'not-found', null, true, null]);
    // the host catalog's contract/error/<code> template wins over the generic one
    const own = open(
      { 'product.save': (/** @type {any} */ _i, /** @type {any} */ ctx) => ctx.fail('conflict', {}, { current: PRODUCT }) },
      { catalog: { 'contract/error/conflict': 'someone else saved {op} first' } });
    assert.strictEqual(/** @type {any} */ (await own.invoke('product.save', SAVE)).error.message, 'someone else saved product.save first');
  });

  it('every handler fault is kind contract JC2070 — a throw, an undeclared code, a broken output, broken details — and onError sees the distinguishing cause', async () => {
    /** @type {any[]} */
    const seen = [];
    const options = { onError: (/** @type {any} */ e, /** @type {any} */ ctx) => seen.push([e, ctx]) };
    const cases = /** @type {[string, any][]} */ ([
      ['throw', () => { throw new Error('secret bug text'); }],
      ['undeclared code', (/** @type {any} */ _i, /** @type {any} */ ctx) => ctx.fail('nope')],
      ['broken output', () => ({ wrong: true })],
      ['broken details', (/** @type {any} */ _i, /** @type {any} */ ctx) => ctx.fail('conflict', {}, { wrong: true })],
    ]);
    for (const [what, handler] of cases) {
      const client = open({ 'product.save': handler }, options);
      const outcome = /** @type {any} */ (assertShape(await client.invoke('product.save', SAVE)));
      assert.deepStrictEqual([outcome.kind, outcome.error.code, outcome.error.status, outcome.error.retryable], ['contract', 'JC2070', null, false], what);
      assert.strictEqual(outcome.error.message, 'operation product.save failed in the serving host', what);
      assert.doesNotMatch(JSON.stringify(outcome), /secret bug text|wrong/, `${what}: nothing of the fault crosses`);
    }
    assert.strictEqual(seen.length, 4, 'every cause reached onError');
    assert.match(String(seen[0][0]), /secret bug text/);
    assert.deepStrictEqual(seen[0][1].op, 'product.save');
    // an onError that throws never reaches the outcome
    const hostileObserver = open({ 'product.save': () => { throw new Error('x'); } }, { onError: () => { throw new Error('observer'); } });
    assert.strictEqual(/** @type {any} */ (await hostileObserver.invoke('product.save', SAVE)).error.code, 'JC2070');
  });

  it('invalid input is the pre-send JC2050 (kind contract, details by policy); nothing ran', async () => {
    let ran = 0;
    const client = open({ 'product.save': () => { ran++; return PRODUCT; } });
    const outcome = /** @type {any} */ (assertShape(await client.invoke('product.save', { id: 'x' })));
    assert.deepStrictEqual([outcome.kind, outcome.error.code, outcome.error.status], ['contract', 'JC2050', null]);
    assert.ok(Array.isArray(outcome.error.details));
    assert.strictEqual(ran, 0);
    // an input-less operation refuses a non-null input the same way
    const bare = compileContract({ $contract: '0.1', operations: { ping: { kind: 'read', output: true } } });
    const b = openLocalClient(bare, { ping: () => 'pong' });
    assert.strictEqual(/** @type {any} */ (await b.invoke('ping', { x: 1 })).error.code, 'JC2050');
    assert.strictEqual(/** @type {any} */ (await b.invoke('ping')).value, 'pong');
    // null and undefined input mean {} for an operation with all-optional input
    assert.strictEqual(/** @type {any} */ (await open().invoke('catalog.load')).ok, true);
  });

  it('cancellation: an aborted signal before or during the run → kind cancelled; the late settlement changes nothing; close() cancels later invokes', async () => {
    const pre = new AbortController();
    pre.abort();
    const client = open();
    assert.strictEqual(/** @type {any} */ (assertShape(await client.invoke('catalog.load', null, { signal: pre.signal }))).kind, 'cancelled');
    // abort mid-run: the handler sees ctx.signal abort; the outcome is cancelled
    const during = new AbortController();
    /** @type {any} */
    let handlerSignal = null;
    /** @type {(v: any) => void} */
    let release = () => {};
    const parked = open({
      'catalog.load': (/** @type {any} */ _i, /** @type {any} */ ctx) => {
        handlerSignal = ctx.signal;
        return new Promise((resolve) => { release = resolve; });
      },
    });
    const pending = parked.invoke('catalog.load', null, { signal: during.signal });
    await Promise.resolve();
    during.abort();
    const outcome = /** @type {any} */ (assertShape(await pending));
    assert.strictEqual(outcome.kind, 'cancelled');
    assert.strictEqual(outcome.error.code, 'JC2052');
    assert.strictEqual(handlerSignal.aborted, true, 'the handler was told to stop');
    release({ revision: 1, products: [] });
    await new Promise((r) => setTimeout(r, 5));
    // close(): later invokes resolve cancelled without running
    let ran = 0;
    const closing = open({ 'catalog.load': () => { ran++; return { revision: 1, products: [] }; } });
    closing.close();
    assert.strictEqual(/** @type {any} */ (await closing.invoke('catalog.load')).kind, 'cancelled');
    assert.strictEqual(ran, 0);
  });

  it('host mistakes reject: an unknown operation and an opaque operation are JC1005; a malformed ctx is JC1001', async () => {
    const client = open();
    await assert.rejects(() => client.invoke('nope'), (/** @type {any} */ e) => e.code === 'JC1005' && e instanceof TypeError);
    await assert.rejects(() => client.invoke('image.bytes', { id: 1 }), (/** @type {any} */ e) => e.code === 'JC1005' && /opaque/.test(e.message));
    await assert.rejects(() => client.invoke('catalog.load', null, /** @type {any} */ (null)), (/** @type {any} */ e) => e.code === 'JC1001');
  });

  it('validateOutput "never" is the declared downgrade: the invalid output crosses, capabilities say so', async () => {
    const client = open({ 'product.save': () => ({ wrong: true }) }, { validateOutput: 'never' });
    const outcome = /** @type {any} */ (await client.invoke('product.save', SAVE));
    assert.deepStrictEqual([outcome.ok, outcome.value], [true, { wrong: true }]);
  });

  it('the port/local code table rides the subpath for consumers', () => {
    assert.deepStrictEqual(Object.keys(PORT_LOCAL_ERRORS), ['JC2070', 'JC2071', 'JC2072', 'JC2073', 'JC2074']);
  });
});
