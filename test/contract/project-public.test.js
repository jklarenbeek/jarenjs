//@ts-check
/**
 * @file `publicProjection`: the browser-safe subset is itself a valid
 * `$contract` document (it compiles, and validates against the grammar),
 * is byte-stable and idempotent (the projection of the projection is the
 * projection), keeps operations in document order and `$defs` in
 * first-reference order, drops `server` operations and unreachable
 * `$defs`, leaves the server-side policy knobs out, materializes the
 * resolved binding and policy, and refuses a malformed argument (`JC1008`).
 * `policy.audience` itself — the grammar member this projection adds —
 * is pinned here beside the compiler's `JC0014` rule.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';
import { jsonFormats } from '@jarenjs/formats';
import { compileContract, ContractCompileError, ContractHostError } from '@jarenjs/contract';
import { publicProjection, reachableDefs, bundleSameDocument } from '@jarenjs/contract/project';

import { load } from './helpers.js';

const shop = load('./fixtures/shop.contract.json');
const grammar = new JarenValidator().addFormats(jsonFormats).compile(load('../../packages/contract/schemas/jaren-contract.schema.json'));

/** A document with one public and one server operation sharing a def, plus an unreachable def. */
const MIXED = {
  $contract: '0.1',
  id: 'mixed',
  $defs: {
    Unused: { type: 'string' },
    Thing: { type: 'object', properties: { id: { type: 'integer' }, tag: { $ref: '#/$defs/Tag' } } },
    Tag: { type: 'string' },
    Secret: { type: 'object', properties: { key: { type: 'string' } } },
  },
  operations: {
    'thing.get': {
      kind: 'read',
      input: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      output: { $ref: '#/$defs/Thing' },
      http: { method: 'GET', path: '/things/{id}' },
    },
    'admin.rotate': {
      kind: 'command',
      input: { type: 'object', properties: { secret: { $ref: '#/$defs/Secret' } } },
      output: true,
      policy: { audience: 'server', idempotency: 'required', limits: { maxBodyBytes: 512 }, errors: { details: 'full' } },
    },
    'thing.put': {
      kind: 'command',
      input: { type: 'object', required: ['id', 'thing'], properties: { id: { type: 'integer' }, thing: { $ref: '#/$defs/Thing' }, dry: { type: 'boolean' } } },
      output: true,
      errors: { gone: { status: 410 } },
      policy: { idempotency: 'optional', limits: { maxBodyBytes: 2048 }, errors: { details: 'none' } },
      http: { method: 'PUT', path: '/things/{id}', body: 'thing', in: { dry: 'query' } },
    },
  },
};

describe('publicProjection — a valid contract, byte-stable and idempotent', () => {
  it('compiles, validates against the grammar, and projects to itself', () => {
    const contract = compileContract(shop);
    const once = publicProjection(contract);
    assert.strictEqual(grammar(once), true);
    const again = compileContract(once);
    assert.deepStrictEqual(again.ids, contract.ids);
    const twice = publicProjection(again);
    assert.strictEqual(JSON.stringify(twice), JSON.stringify(once), 'the projection of the projection is the projection, byte for byte');
    assert.strictEqual(JSON.stringify(publicProjection(contract)), JSON.stringify(once), 'rendering twice is byte-identical');
  });

  it('keeps the fixed member order the revision hashes', () => {
    const pub = /** @type {any} */ (publicProjection(compileContract(shop)));
    assert.deepStrictEqual(Object.keys(pub), ['$contract', 'id', 'version', 'compat', '$defs', 'operations']);
    assert.deepStrictEqual(Object.keys(pub.operations), ['catalog.load', 'product.save', 'image.bytes', 'product.search', 'product.remove'], 'document order');
    assert.deepStrictEqual(Object.keys(pub.operations['product.save']), ['kind', 'input', 'output', 'errors', 'policy', 'http']);
    assert.deepStrictEqual(Object.keys(pub.operations['catalog.load']), ['kind', 'input', 'output', 'errors', 'policy', 'http', 'doc']);
    assert.deepStrictEqual(Object.keys(pub.operations['product.save'].policy), ['task', 'idempotency', 'revision', 'cache', 'retry', 'audience']);
    assert.deepStrictEqual(Object.keys(pub.operations['product.save'].http), ['method', 'path', 'in', 'status', 'media']);
    assert.deepStrictEqual(Object.keys(pub.operations['product.save'].errors.conflict), ['status', 'schema']);
    assert.deepStrictEqual(Object.keys(pub.operations['product.save'].errors['not-found']), ['status']);
  });

  it('orders $defs by first reference and materializes the resolved binding and policy', () => {
    const pub = /** @type {any} */ (publicProjection(compileContract(shop)));
    // catalog.load's output reaches Catalog, which reaches Product; product.save's conflict reaches Conflict
    assert.deepStrictEqual(Object.keys(pub.$defs), ['Catalog', 'Product', 'Conflict']);
    assert.deepStrictEqual(pub.operations['product.remove'].http, {
      method: 'POST', path: '/product.remove', in: { id: 'body' }, status: 200, media: 'application/json',
    }, 'the canonical binding is written out');
    assert.deepStrictEqual(pub.operations['product.remove'].policy, {
      task: 'exhaust', idempotency: 'optional', cache: 'none', audience: 'public',
    }, 'defaults materialized; limits and errors.details left out');
    assert.deepStrictEqual(pub.operations['product.save'].policy.retry, { max: 2, on: ['not-found'] });
    assert.strictEqual(pub.operations['product.save'].policy.revision, 'input:/revision');
    assert.strictEqual(pub.operations['image.bytes'].http.media, 'application/octet-stream', 'opaque operations are public (a URL builder)');
  });
});

describe('publicProjection — what is left out', () => {
  it('drops server operations, unreachable $defs and the server-side knobs, keeps http.body', () => {
    const contract = compileContract(MIXED);
    const pub = /** @type {any} */ (publicProjection(contract));
    assert.deepStrictEqual(Object.keys(pub.operations), ['thing.get', 'thing.put']);
    assert.deepStrictEqual(Object.keys(pub.$defs), ['Thing', 'Tag'], 'Unused is unreachable, Secret only through the server operation');
    assert.strictEqual(pub.operations['thing.put'].policy.limits, undefined);
    assert.strictEqual(pub.operations['thing.put'].policy.errors, undefined);
    assert.strictEqual(pub.operations['thing.put'].http.body, 'thing', 'the whole-body member survives — without it the wire shape changes');
    assert.deepStrictEqual(pub.operations['thing.put'].http.in, { id: 'path', thing: 'body', dry: 'query' });
    assert.strictEqual(pub.id, 'mixed');
    assert.strictEqual('version' in pub, false);
    assert.strictEqual('compat' in pub, false);
    // and it compiles back with the same public shape
    const again = compileContract(pub);
    assert.deepStrictEqual(again.ids, ['thing.get', 'thing.put']);
    assert.strictEqual(again.operations['thing.put'].http.body, 'thing');
    assert.strictEqual(JSON.stringify(publicProjection(again)), JSON.stringify(pub));
  });

  it('narrows by ops (never widening to a server operation) and refuses a malformed argument', () => {
    const contract = compileContract(MIXED);
    const narrowed = /** @type {any} */ (publicProjection(contract, { ops: ['thing.put', 'admin.rotate'] }));
    assert.deepStrictEqual(Object.keys(narrowed.operations), ['thing.put'], 'a listed server operation is still not kept');
    assert.deepStrictEqual(Object.keys(narrowed.$defs), ['Thing', 'Tag']);
    assert.throws(() => publicProjection(contract, { ops: ['nope'] }), (/** @type {any} */ e) => e instanceof ContractHostError && e.code === 'JC1008' && /nope/.test(e.message));
    assert.throws(() => publicProjection(contract, { ops: /** @type {any} */ ('thing.get') }), (/** @type {any} */ e) => e.code === 'JC1008');
    assert.throws(() => publicProjection(/** @type {any} */ (MIXED)), (/** @type {any} */ e) => e instanceof ContractHostError && e.code === 'JC1008' && /compiled contract/.test(e.message));
    assert.throws(() => publicProjection(/** @type {any} */ (null)), (/** @type {any} */ e) => e.code === 'JC1008');
  });
});

describe('policy.audience — the grammar member this projection adds', () => {
  it('defaults to public, accepts server, refuses anything else with JC0014', () => {
    const one = (/** @type {any} */ policy) => ({ $contract: '0.1', operations: { a: { kind: 'read', output: true, policy, http: { method: 'GET', path: '/a' } } } });
    assert.strictEqual(compileContract(one(undefined)).operations.a.policy.audience, 'public');
    assert.strictEqual(compileContract(one({ audience: 'public' })).operations.a.policy.audience, 'public');
    assert.strictEqual(compileContract(one({ audience: 'server' })).operations.a.policy.audience, 'server');
    for (const bad of ['internal', 1, null, true]) {
      assert.throws(() => compileContract(one({ audience: bad })),
        (/** @type {any} */ e) => e instanceof ContractCompileError && e.code === 'JC0014' && e.docPath === '/operations/a/policy/audience',
        `audience ${JSON.stringify(bad)}`);
      assert.strictEqual(grammar(one({ audience: bad })), false, 'the grammar refuses it too');
    }
  });
});

describe('the same-document bundler', () => {
  it('reaches $defs transitively in first-reference order, through anchors and boolean entries, and inlines them', () => {
    const doc = {
      $defs: {
        T: true,
        A: { $anchor: 'anc', type: 'object', properties: { b: { $ref: '#/$defs/B/properties/x' } } },
        B: { type: 'object', properties: { x: { type: 'string' } } },
        C: { type: 'string' },
      },
    };
    assert.deepStrictEqual(reachableDefs([{ properties: { t: { $ref: '#/$defs/T' }, a: { $ref: '#anc' } } }], doc), ['T', 'A', 'B']);
    assert.deepStrictEqual(reachableDefs([{ enum: [{ $ref: '#/$defs/C' }] }], doc), [], 'data keywords are not walked');
    assert.deepStrictEqual(reachableDefs([{ $ref: '#/$defs/Nope' }, { $ref: '#' }, true], doc), []);
    const bundled = bundleSameDocument({ type: 'object', $defs: { Own: {} }, properties: { a: { $ref: '#/$defs/A' } } }, doc);
    assert.deepStrictEqual(Object.keys(bundled), ['type', 'properties', '$defs']);
    assert.deepStrictEqual(Object.keys(bundled.$defs), ['A', 'B']);
    assert.strictEqual(bundled.$defs.A, doc.$defs.A, 'the subtrees are shared, the top level is fresh');
    assert.strictEqual(bundleSameDocument(true, doc), true);
    assert.deepStrictEqual(bundleSameDocument({ type: 'string' }, doc), { type: 'string' });
  });
});
