//@ts-check
/**
 * @file `describe()`: golden-compared against `fixtures/shop.describe.json`
 * (regenerate deliberately when the description shape changes and review
 * the diff), pure JSON, stable member order, and `inferred` telling the
 * declared from the defaulted.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract } from '@jarenjs/contract';
import { load } from './helpers.js';

const shop = load('./fixtures/shop.contract.json');
const golden = load('./fixtures/shop.describe.json');

describe('contract describe()', () => {
  it('deep-equals the golden for the shop example', () => {
    assert.deepStrictEqual(compileContract(shop).describe(), golden);
  });

  it('round-trips through JSON unchanged', () => {
    const d = compileContract(shop).describe();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(d)), d);
  });

  it('keeps a stable member order at every level', () => {
    const d = compileContract(shop).describe();
    assert.deepStrictEqual(Object.keys(d), ['$contract', 'id', 'version', 'compat', 'revision', 'operations']);
    for (const op of d.operations) {
      assert.deepStrictEqual(Object.keys(op),
        ['id', 'kind', 'method', 'path', 'status', 'media', 'opaque', 'in', 'body', 'task', 'idempotency', 'cache', 'inferred']);
      assert.deepStrictEqual(Object.keys(op.inferred), ['http', 'status', 'media', 'in', 'task', 'idempotency', 'cache']);
    }
  });

  it('marks the canonical binding and every defaulted policy member as inferred', () => {
    const d = compileContract(shop).describe();
    const remove = d.operations.find((o) => o.id === 'product.remove');
    assert.ok(remove);
    assert.strictEqual(remove.method, 'POST');
    assert.strictEqual(remove.path, '/product.remove');
    assert.deepStrictEqual(remove.inferred, { http: true, status: true, media: true, in: ['id'], task: true, idempotency: false, cache: true });
    const save = d.operations.find((o) => o.id === 'product.save');
    assert.ok(save);
    assert.deepStrictEqual(save.inferred.in, [], 'a path variable and the two declared body members are all declared');
    assert.strictEqual(save.inferred.task, false);
    assert.strictEqual(save.inferred.cache, true);
    const image = d.operations.find((o) => o.id === 'image.bytes');
    assert.ok(image);
    assert.strictEqual(image.opaque, true);
    assert.strictEqual(image.inferred.media, false);
  });

  it('shows the whole-body member and canonical {name} templates', () => {
    const d = compileContract({
      $contract: '0.1',
      operations: {
        'doc.put': {
          kind: 'command',
          input: { type: 'object', properties: { id: { type: 'string' }, doc: { type: 'array' }, dry: { type: 'boolean' } } },
          output: true,
          http: { method: 'PUT', path: '/docs/:id', body: 'doc', in: { dry: 'query' } },
        },
      },
    }).describe();
    assert.strictEqual(d.operations[0].path, '/docs/{id}');
    assert.strictEqual(d.operations[0].body, 'doc');
    assert.deepStrictEqual(d.operations[0].in, { id: 'path', doc: 'body', dry: 'query' });
    assert.deepStrictEqual(d.operations[0].inferred.in, []);
    assert.strictEqual(d.id, null);
    assert.deepStrictEqual(d.compat, []);
  });
});
