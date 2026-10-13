//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';

/** @param {any} schema @param {any} data */
function failures(schema, data) {
  const validate = new JarenValidator({ collectErrors: true, draftVersion: 2020 }).compile(schema);
  const result = validate(data);
  assert.equal(result.valid, false);
  return result.errors
    .filter((/** @type {any} */ e) => e.keyword.startsWith('unevaluated'))
    .map((/** @type {any} */ e) => ({ keyword: e.keyword, params: e.params }));
}

describe('the member an unevaluated failure names', () => {
  it('unevaluatedProperties: false names each leftover member', () => {
    assert.deepEqual(
      failures({ properties: { a: {} }, unevaluatedProperties: false }, { a: 1, x: 2, 'y/z': 3 }),
      [
        { keyword: 'unevaluatedProperties', params: { unevaluatedProperty: 'x' } },
        { keyword: 'unevaluatedProperties', params: { unevaluatedProperty: 'y/z' } },
      ]);
  });

  it('the schema form names the leftover member that failed it', () => {
    assert.deepEqual(
      failures({ unevaluatedProperties: { type: 'string' } }, { p: 1, q: 'a', r: 2 }),
      [
        { keyword: 'unevaluatedProperties', params: { unevaluatedProperty: 'p' } },
        { keyword: 'unevaluatedProperties', params: { unevaluatedProperty: 'r' } },
      ]);
  });

  it('unevaluatedItems names the index of the item', () => {
    assert.deepEqual(
      failures({ prefixItems: [{}], unevaluatedItems: false }, [1, 2, 3]),
      [{ keyword: 'unevaluatedItems', params: { unevaluatedItem: 1 } }]);
    assert.deepEqual(
      failures({ prefixItems: [{}], unevaluatedItems: { type: 'string' } }, [0, 1, 'x', 2]),
      [
        { keyword: 'unevaluatedItems', params: { unevaluatedItem: 1 } },
        { keyword: 'unevaluatedItems', params: { unevaluatedItem: 3 } },
      ]);
  });

  it('keeps the error at the object or array that holds the member', () => {
    const validate = new JarenValidator({ collectErrors: true, draftVersion: 2020 })
      .compile({ properties: { o: { unevaluatedProperties: false } } });
    const result = validate({ o: { k: 1 } });
    assert.deepEqual(result.errors.map((/** @type {any} */ e) => [e.keyword, e.instancePath]), [['unevaluatedProperties', '/o']]);
  });

  it('keeps the error of an array at the array, and a schema form at the member beside it', () => {
    const where = (/** @type {any} */ schema, /** @type {any} */ data) => new JarenValidator({ collectErrors: true, draftVersion: 2020 })
      .compile(schema)(data).errors.map((/** @type {any} */ e) => [e.keyword, e.instancePath]);
    assert.deepEqual(
      where({ properties: { l: { prefixItems: [{}], unevaluatedItems: false } } }, { l: [1, 2] }),
      [['unevaluatedItems', '/l']]);
    // The keyword's own failure is the holder's; what the schema form found
    // wrong in the member is the member's, as for every subschema.
    assert.deepEqual(
      where({ unevaluatedProperties: { type: 'string' } }, { q: 1 }),
      [['type', '/q'], ['unevaluatedProperties', '']]);
    assert.deepEqual(
      where({ prefixItems: [{}], unevaluatedItems: { type: 'string' } }, [0, 1]),
      [['type', '/1'], ['unevaluatedItems', '']]);
  });
});
