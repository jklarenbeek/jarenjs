//@ts-check
/**
 * @file The lifted transport-neutral pipeline, directly: input
 * validation projects details by policy, the uniform boundary settles a
 * synchronous throw, a rejection and a plain return alike, declared
 * failures validate their details and derive retryability from the
 * failure or the retry policy, undeclared codes and hostile values
 * classify as `JC2008`-class contract results with the cause kept for
 * the observer, and output validation is `JC2010`-class — the same
 * classification the HTTP binding projects onto statuses (proven by its
 * own suite passing unchanged over this core) and the local/port
 * bindings project onto outcomes and frames.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract, ContractFailure, ContractRuntimeError } from '@jarenjs/contract';
import {
  validateOperationInput, settleOperation, runOperation, safeTrace, PORT_LOCAL_ERRORS,
} from '../../packages/contract/src/pipeline.js';
import { load } from './helpers.js';

const shop = compileContract(load('./fixtures/shop.contract.json'));

/**
 * The pipeline route of one shop operation over a handler.
 * @param {string} id
 * @param {any} handler
 */
function routeOf(id, handler) {
  const op = shop.operations[id];
  return {
    op,
    handler,
    raw: op.http.opaque,
    validateInput: op.input === null ? null : op.input.validate,
    validateOutput: op.output.validate,
    details: op.policy.errors.details,
    errors: op.errors,
    retryOn: new Set(op.policy.retry === null ? [] : op.policy.retry.on),
  };
}

const PRODUCT = { id: 1, name: 'x', price: 1 };
const SAVE = { id: 1, revision: 2, product: PRODUCT };
const CTX = Object.freeze({ trace: 't', signal: null, params: null, headers: {}, fail: ContractFailure, idempotency: null });

describe('validateOperationInput', () => {
  it('null when valid or when the operation validates nothing; a JC2006 contract result with projected details otherwise', () => {
    const route = routeOf('product.save', () => PRODUCT);
    assert.strictEqual(validateOperationInput(route, SAVE), null);
    const invalid = /** @type {any} */ (validateOperationInput(route, { id: 'x' }));
    assert.strictEqual(invalid.kind, 'contract');
    assert.strictEqual(invalid.code, 'JC2006');
    assert.strictEqual(invalid.cause, undefined);
    assert.ok(Array.isArray(invalid.details) && invalid.details.length > 0);
    assert.deepStrictEqual(Object.keys(invalid.details[0]), ['path', 'keyword'], 'details "paths" by default policy');
    // details: "full" (product.remove) carries the validator records
    const full = /** @type {any} */ (validateOperationInput(routeOf('product.remove', () => true), { id: 'x' }));
    assert.strictEqual(full.code, 'JC2006');
    assert.notDeepStrictEqual(Object.keys(full.details[0]), ['path', 'keyword']);
    assert.strictEqual(validateOperationInput({ ...routeOf('product.save', () => 1), validateInput: null }, 'anything'), null);
    // a validator that throws is a failed verdict carrying the throw
    const thrown = new Error('validator bug');
    const hostile = /** @type {any} */ (validateOperationInput({ ...routeOf('product.save', () => 1), validateInput: () => { throw thrown; } }, SAVE));
    assert.strictEqual(hostile.code, 'JC2006');
    assert.strictEqual(hostile.cause, thrown);
  });
});

describe('settleOperation — the uniform boundary and its classification', () => {
  it('a valid value settles kind value; an invalid output is JC2010-class with the cause for the observer', async () => {
    const ok = await settleOperation(routeOf('product.save', () => PRODUCT), SAVE, CTX, true);
    assert.deepStrictEqual(ok, { kind: 'value', value: PRODUCT });
    const bad = /** @type {any} */ (await settleOperation(routeOf('product.save', () => ({ nope: 1 })), SAVE, CTX, true));
    assert.deepStrictEqual([bad.kind, bad.code], ['contract', 'JC2010']);
    assert.ok(bad.cause instanceof ContractRuntimeError && bad.cause.code === 'JC2010');
    // validateOutput false: the invalid value passes through
    const skipped = await settleOperation(routeOf('product.save', () => ({ nope: 1 })), SAVE, CTX, false);
    assert.deepStrictEqual(skipped, { kind: 'value', value: { nope: 1 } });
    // a raw route never output-validates (the binding checks the raw shape)
    const raw = await settleOperation(routeOf('image.bytes', () => ({ status: 200 })), { id: 1 }, CTX, true);
    assert.strictEqual(raw.kind, 'value');
  });

  it('a synchronous throw, a rejection and a thrown declared ContractRuntimeError settle alike', async () => {
    const boom = new Error('boom');
    const threw = /** @type {any} */ (await settleOperation(routeOf('product.save', () => { throw boom; }), SAVE, CTX, true));
    assert.deepStrictEqual([threw.kind, threw.code, threw.cause], ['contract', 'JC2008', boom]);
    const rejected = /** @type {any} */ (await settleOperation(routeOf('product.save', () => Promise.reject(boom)), SAVE, CTX, true));
    assert.deepStrictEqual([rejected.kind, rejected.code, rejected.cause], ['contract', 'JC2008', boom]);
    // a thrown CRE whose code the operation declares is a declared failure
    const declared = /** @type {any} */ (await settleOperation(routeOf('product.save', () => {
      throw new ContractRuntimeError('not-found', 'gone', { msgid: 'contract/handler-error', retryable: false });
    }), SAVE, CTX, true));
    assert.deepStrictEqual([declared.kind, declared.code, declared.status, declared.retryable, declared.details], ['failure', 'not-found', 404, false, undefined]);
    // without its own retryable, the retry policy decides (product.save retries on not-found)
    const policy = /** @type {any} */ (await settleOperation(routeOf('product.save', () => {
      throw new ContractRuntimeError('not-found', 'gone', { msgid: 'contract/handler-error' });
    }), SAVE, CTX, true));
    assert.strictEqual(policy.retryable, true);
    // a thrown CRE with an undeclared code is JC2008-class
    const undeclared = /** @type {any} */ (await settleOperation(routeOf('product.save', () => {
      throw new ContractRuntimeError('JC2001', 'x', { msgid: 'contract/not-found' });
    }), SAVE, CTX, true));
    assert.deepStrictEqual([undeclared.kind, undeclared.code], ['contract', 'JC2008']);
  });

  it('a returned ContractFailure is a declared failure with validated details; broken details are JC2010-class; an undeclared code is JC2008-class', async () => {
    const conflict = /** @type {any} */ (await settleOperation(
      routeOf('product.save', (/** @type {any} */ _i, /** @type {any} */ ctx) => ctx.fail('conflict', { who: 'me' }, { current: PRODUCT })), SAVE, CTX, true));
    assert.deepStrictEqual(
      [conflict.kind, conflict.code, conflict.status, conflict.retryable, conflict.details, conflict.params],
      ['failure', 'conflict', 409, false, { current: PRODUCT }, { who: 'me' }]);
    // details failing the declaration's schema
    const broken = /** @type {any} */ (await settleOperation(
      routeOf('product.save', (/** @type {any} */ _i, /** @type {any} */ ctx) => ctx.fail('conflict', {}, { wrong: true })), SAVE, CTX, true));
    assert.deepStrictEqual([broken.kind, broken.code], ['contract', 'JC2010']);
    // a declaration without a schema still requires JSON details
    const nonJson = /** @type {any} */ (await settleOperation(
      routeOf('product.save', (/** @type {any} */ _i, /** @type {any} */ ctx) => ctx.fail('not-found', {}, () => {})), SAVE, CTX, true));
    assert.deepStrictEqual([nonJson.kind, nonJson.code], ['contract', 'JC2010']);
    const undeclared = /** @type {any} */ (await settleOperation(
      routeOf('product.save', (/** @type {any} */ _i, /** @type {any} */ ctx) => ctx.fail('nope')), SAVE, CTX, true));
    assert.deepStrictEqual([undeclared.kind, undeclared.code], ['contract', 'JC2008']);
    assert.match(undeclared.cause.message, /undeclared error code "nope"/);
  });

  it('is total for hostile values: a throwing then accessor is a JC2008-class rejection; other throwing members die in output validation', async () => {
    const hostileThen = /** @type {any} */ (await settleOperation(routeOf('product.save', () => ({
      get then() { throw new Error('trap'); },
    })), SAVE, CTX, true));
    assert.deepStrictEqual([hostileThen.kind, hostileThen.code], ['contract', 'JC2008']);
    const hostileMember = /** @type {any} */ (await settleOperation(routeOf('product.save', () => ({
      get id() { throw new Error('trap'); }, name: 'x', price: 1,
    })), SAVE, CTX, true));
    assert.deepStrictEqual([hostileMember.kind, hostileMember.code], ['contract', 'JC2010']);
  });
});

describe('runOperation, safeTrace, PORT_LOCAL_ERRORS', () => {
  it('runOperation composes the two halves; validateOutput defaults on', async () => {
    const good = await runOperation(routeOf('product.save', () => PRODUCT), SAVE, CTX);
    assert.deepStrictEqual(good, { kind: 'value', value: PRODUCT });
    const invalid = /** @type {any} */ (await runOperation(routeOf('product.save', () => PRODUCT), { id: 'x' }, CTX));
    assert.strictEqual(invalid.code, 'JC2006');
    const bad = /** @type {any} */ (await runOperation(routeOf('product.save', () => 42), SAVE, CTX));
    assert.strictEqual(bad.code, 'JC2010');
    const off = await runOperation(routeOf('product.save', () => 42), SAVE, CTX, { validateOutput: false });
    assert.deepStrictEqual(off, { kind: 'value', value: 42 });
  });

  it('safeTrace is total: a throwing or non-string generator falls back to a UUID', () => {
    assert.strictEqual(safeTrace(() => 'mine'), 'mine');
    assert.match(safeTrace(() => { throw new Error('x'); }), /^[0-9a-f-]{36}$/);
    assert.match(safeTrace(() => /** @type {any} */ (7)), /^[0-9a-f-]{36}$/);
    assert.match(safeTrace(() => ''), /^[0-9a-f-]{36}$/);
  });

  it('the port/local code table is frozen data with msgids the English catalog renders', async () => {
    const { contractCatalogEn } = await import('@jarenjs/contract');
    assert.deepStrictEqual(Object.keys(PORT_LOCAL_ERRORS), ['JC2070', 'JC2071', 'JC2072', 'JC2073', 'JC2074']);
    assert.strictEqual(Object.isFrozen(PORT_LOCAL_ERRORS), true);
    for (const row of Object.values(PORT_LOCAL_ERRORS)) {
      assert.strictEqual(typeof contractCatalogEn[row.msgid], 'function', row.msgid);
      assert.strictEqual(typeof row.retryable, 'boolean');
    }
  });
});
