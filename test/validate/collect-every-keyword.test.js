//@ts-check
/**
 * @file Collecting errors reports what every keyword finds: a failed
 * sibling does not silence `unevaluatedProperties`/`unevaluatedItems`, a
 * failing `$data`/`data` keyword does not silence the next one, and the item
 * walk does not stop at `maxItems`. The answer (`valid`) is the same as in
 * boolean mode in every case.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JarenValidator } from '@jarenjs/validate';
import { basicOutput } from '@jarenjs/validate/output';

/**
 * The collected errors as [keyword, instancePath, params] triples, after
 * checking that collect mode and boolean mode give the same answer.
 * @param {object} schema
 * @param {unknown} data
 */
function collected(schema, data) {
  const result = new JarenValidator({ collectErrors: true }).compile(schema)(data);
  assert.equal(result.valid, new JarenValidator().compile(schema)(data), 'the answer is the boolean mode answer');
  return result.errors.map((e) => [e.keyword, e.instancePath, e.params]);
}

describe('unevaluatedProperties and unevaluatedItems beside a failed sibling', () => {
  it('report the member nothing evaluated, and only that one', () => {
    assert.deepEqual(collected({ properties: { a: { type: 'string' } }, unevaluatedProperties: false }, { a: 1, x: 1 }), [
      ['type', '/a', { type: 'string' }],
      ['unevaluatedProperties', '', { unevaluatedProperty: 'x' }],
    ]);
    assert.deepEqual(collected({ patternProperties: { '^a': { type: 'string' } }, unevaluatedProperties: false }, { ab: 1, x: 1 }), [
      ['type', '/ab', { type: 'string' }],
      ['unevaluatedProperties', '', { unevaluatedProperty: 'x' }],
    ]);
    assert.deepEqual(collected({ required: ['q'], properties: { a: true }, unevaluatedProperties: false }, { a: 1, x: 1 }), [
      ['required', '', { missingProperty: 'q' }],
      ['unevaluatedProperties', '', { unevaluatedProperty: 'x' }],
    ]);
    assert.deepEqual(collected({ required: ['q'], unevaluatedProperties: { type: 'string' } }, { x: 1, y: 'a' }), [
      ['required', '', { missingProperty: 'q' }],
      ['type', '/x', { type: 'string' }],
      ['unevaluatedProperties', '', { unevaluatedProperty: 'x' }],
    ]);
  });

  it('do not name again a member the sibling matched and reported', () => {
    assert.deepEqual(collected({ additionalProperties: false, unevaluatedProperties: false }, { x: 1 }), [
      ['additionalProperties', '/x', { additionalProperty: 'x' }],
    ]);
    assert.deepEqual(collected({ additionalProperties: { type: 'string' }, unevaluatedProperties: false }, { x: 1 }), [
      ['type', '/x', { type: 'string' }],
    ]);
    assert.deepEqual(collected({ allOf: [{ properties: { x: { type: 'string' } } }], unevaluatedProperties: false }, { x: 1 }), [
      ['type', '/x', { type: 'string' }],
      ['allOf', '', {}],
    ]);
    assert.deepEqual(collected({ items: false, unevaluatedItems: false }, [1]), [['items', '', {}]]);
    assert.deepEqual(collected({ items: { type: 'string' }, unevaluatedItems: false }, [1, 'a']), [
      ['type', '/0', { type: 'string' }],
      ['items', '', {}],
    ]);
  });

  it('read no annotation from a failed anyOf branch', () => {
    const schema = { anyOf: [{ properties: { x: { type: 'string' } } }, { required: ['q'] }], unevaluatedProperties: false };
    assert.deepEqual(collected(schema, { x: 1 }), [
      ['type', '/x', { type: 'string' }],
      ['required', '', { missingProperty: 'q' }],
      ['anyOf', '', {}],
      ['unevaluatedProperties', '', { unevaluatedProperty: 'x' }],
    ]);
  });

  it('report the items nothing evaluated', () => {
    assert.deepEqual(collected({ prefixItems: [{ type: 'string' }], unevaluatedItems: false }, [1, 2]), [
      ['type', '/0', { type: 'string' }],
      ['items', '', {}],
      ['unevaluatedItems', '', { unevaluatedItem: 1 }],
    ]);
    assert.deepEqual(collected({ minItems: 3, unevaluatedItems: false }, [1]), [
      ['minItems', '', { limit: 3 }],
      ['unevaluatedItems', '', { unevaluatedItem: 0 }],
    ]);
  });

  it('keep a not over them answering as before', () => {
    const schema = { not: { properties: { a: { type: 'string' } }, unevaluatedProperties: false } };
    assert.deepEqual(collected(schema, { a: 1, x: 1 }), []);
  });
});

describe('$data and data keywords', () => {
  it('each report their own failure', () => {
    const data = { n: 1, w: 2, m: 5 };
    assert.deepEqual(collected({ properties: { n: { const: { $data: '1/w' }, minimum: { $data: '1/m' } } } }, data), [
      ['minimum', '/n', { limit: 5, comparison: '>=' }],
      ['const', '/n', { allowedValue: 2 }],
    ]);
    assert.deepEqual(collected({ properties: { n: { data: { const: '1/w', minimum: '1/m' } } } }, data), [
      ['const', '/n', { allowedValue: 2 }],
      ['minimum', '/n', { limit: 5, comparison: '>=' }],
    ]);
  });

  it('still judge only the instance types they apply to', () => {
    const schema = { properties: { n: { minimum: { $data: '1/m' }, minLength: { $data: '1/l' } } } };
    assert.deepEqual(collected(schema, { n: 'abc', m: 5, l: 2 }), []);
    assert.deepEqual(collected(schema, { n: 'a', m: 5, l: 2 }), [['minLength', '/n', { limit: 2 }]]);
  });
});

describe('the item walk past maxItems', () => {
  it('reports every failing item beside the length', () => {
    assert.deepEqual(collected({ maxItems: 1, items: { type: 'string' } }, ['a', 5]), [
      ['maxItems', '', { limit: 1 }],
      ['type', '/1', { type: 'string' }],
      ['items', '', {}],
    ]);
  });

  it('counts contains matches over every item', () => {
    assert.deepEqual(collected({ maxItems: 1, contains: { const: 5 } }, [1, 5]), [['maxItems', '', { limit: 1 }]]);
  });
});

describe('a recording output format', () => {
  /**
   * The `basic` output's error units as [keywordLocation, instanceLocation].
   * @param {object} schema
   * @param {unknown} data
   */
  const basic = (schema, data) => {
    const result = new JarenValidator(/** @type {any} */ ({ outputFormat: basicOutput })).compile(schema)(data);
    return [result.valid, result.errors.map((e) => [e.keywordLocation, e.instanceLocation])];
  };

  it('records the same keywords collect mode reports', () => {
    assert.deepEqual(basic({ properties: { a: { type: 'string' } }, unevaluatedProperties: false }, { a: 1, x: 1 }),
      [false, [['', ''], ['/properties/a/type', '/a'], ['/unevaluatedProperties', '']]]);
    assert.deepEqual(basic({ properties: { n: { const: { $data: '1/w' }, minimum: { $data: '1/m' } } } }, { n: 1, w: 2, m: 5 }),
      [false, [['/properties/n', '/n'], ['/properties/n/const', '/n'], ['/properties/n/minimum', '/n']]]);
    assert.deepEqual(basic({ maxItems: 1, contains: { const: 5 } }, [1, 5]), [false, [['/maxItems', '']]]);
  });
});

