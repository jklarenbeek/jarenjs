//@ts-check
/**
 * @file `contractTools` over a `local` client: the projection is
 * binding-agnostic (it reads `client.invoke` and nothing else), so the
 * tools execute in-process — the wiring an AI host uses when its
 * operations and its model live in one runtime. Tool execution resolves
 * D6 outcomes exactly as over HTTP, with `status: null` where a status
 * cannot exist; the default set excludes the opaque operation the
 * binding could not carry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract } from '@jarenjs/contract';
import { openLocalClient } from '@jarenjs/contract/local';
import { contractTools } from '@jarenjs/contract/project';
import { load, shopHandlers } from './helpers.js';

const shop = compileContract(load('./fixtures/shop.contract.json'));
const PRODUCT = { id: 1, name: 'x', price: 1 };

describe('contractTools over a local client', () => {
  it('projects the invokable operations, executes them in-process, and resolves outcomes', async () => {
    const client = openLocalClient(shop, {
      ...shopHandlers(),
      'product.save': (/** @type {any} */ input, /** @type {any} */ ctx) => (input.id === 9 ? ctx.fail('conflict', {}, { current: PRODUCT }) : { ...PRODUCT, id: input.id }),
    });
    const tools = contractTools(shop, client);
    assert.deepStrictEqual(tools.map((t) => t.name), ['catalog_load', 'product_save', 'product_search', 'product_remove'],
      'the opaque image.bytes is excluded by default');
    const byName = new Map(tools.map((t) => [t.name, t]));
    const loaded = /** @type {any} */ (await byName.get('catalog_load')?.execute({}));
    assert.strictEqual(loaded.ok, true);
    assert.deepStrictEqual(loaded.value.products.length, 1);
    const saved = /** @type {any} */ (await byName.get('product_save')?.execute({ id: 3, revision: 1, product: PRODUCT }));
    assert.deepStrictEqual([saved.ok, saved.value.id], [true, 3]);
    // a declared failure crosses as an outcome the model can read — status null on this binding
    const conflicted = /** @type {any} */ (await byName.get('product_save')?.execute({ id: 9, revision: 1, product: PRODUCT }));
    assert.deepStrictEqual([conflicted.ok, conflicted.kind, conflicted.error.code, conflicted.error.status, conflicted.error.details],
      [false, 'failure', 'conflict', null, { current: PRODUCT }]);
    // an invalid model argument is the pre-send refusal, not a throw
    const refused = /** @type {any} */ (await byName.get('product_save')?.execute({ id: 'x' }));
    assert.deepStrictEqual([refused.ok, refused.kind, refused.error.code], [false, 'contract', 'JC2050']);
    // naming the opaque operation explicitly is refused at projection time, as over http
    assert.throws(() => contractTools(shop, client, { ops: ['image.bytes'] }), (/** @type {any} */ e) => e.code === 'JC1008');
  });
});
