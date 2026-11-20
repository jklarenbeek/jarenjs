//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JarenValidator } from '@jarenjs/validate';

/**
 * The answer of the default validator and the collecting one's answer
 * with its messages.
 * @param {object} schema
 * @param {unknown} instance
 */
function answers(schema, instance) {
  const first = new JarenValidator().compile(schema)(instance);
  const collected = /** @type {any} */ (new JarenValidator({ collectErrors: true }).compile(schema)(instance));
  return { first, valid: collected.valid, messages: collected.errors.map((/** @type {any} */ e) => e.message) };
}

describe('a const or enum value the message quotes', function () {
  const cyclic = /** @type {any} */ ({ a: 1 });
  cyclic.self = cyclic;
  let deep = /** @type {any} */ (1);
  for (let i = 0; i < 20_000; ++i)
    deep = [deep];
  const cases = [
    ['a BigInt object', Object(1n), '1'],
    ['a BigInt object inside a value', [Object(2n)], '["2"]'],
    ['a circular reference', cyclic, '[object Object]'],
    ['a value nested 20,000 levels', deep, '[object Array]'],
  ];

  for (const [name, value, text] of cases) {
    it(`is refused with a message when errors are collected, as without: ${name}`, function () {
      const forms = [
        [{ const: value }, 5, `must be equal to constant ${text}`],
        [{ enum: [value] }, 5, `must be equal to one of the allowed values: ${text}`],
        [{ properties: { d: { const: { $data: '1/r' } } } }, { r: value, d: 5 }, `must be equal to constant ${text}`],
        [{ properties: { d: { enum: { $data: '1/r' } } } }, { r: [value], d: 5 },
          `must be equal to one of the allowed values: ${text}`],
        [{ properties: { d: { data: { const: '1/r' } } } }, { r: value, d: 5 }, `must be equal to constant ${text}`],
      ];
      for (const [schema, instance, message] of forms)
        assert.deepEqual(answers(schema, instance), { first: false, valid: false, messages: [message] });
    });
  }
});

describe('an errorMessage template that names the value', function () {
  it('renders a BigInt object and a circular reference', function () {
    const cyclic = /** @type {any} */ ({ a: 1 });
    cyclic.self = cyclic;
    for (const [value, text] of [[Object(1n), 'must be 1'], [cyclic, 'must be [object Object]']]) {
      const schema = { const: value, errorMessage: { const: 'must be {allowedValue}' } };
      assert.deepEqual(answers(schema, 5), { first: false, valid: false, messages: [text] });
    }
  });
});

describe('a $data uniqueItems', function () {
  const schemaAt = (/** @type {string} */ ref) => ({ properties: { d: { uniqueItems: { $data: ref } } } });
  const items = { properties: { d: { items: { uniqueItems: { $data: '2/r' } } } } };

  it('asserts uniqueness where it finds true', function () {
    assert.deepEqual(answers(schemaAt('1/r'), { r: true, d: [1, 1] }).valid, false);
    assert.deepEqual(answers(schemaAt('1/r'), { r: true, d: [1, 1] }).first, false);
    assert.deepEqual(answers(schemaAt('1/r'), { r: true, d: [1, 2] }), { first: true, valid: true, messages: [] });
    assert.equal(answers(items, { r: true, d: [[1, 1]] }).first, false);
    assert.equal(answers(items, { r: true, d: [[1, 1]] }).valid, false);
  });

  it('asserts nothing where it finds false, no value or a value that is no boolean', function () {
    const found = ['yes', 'true', 1, 0, -1, 1.5, NaN, Infinity, 1n, {}, [], [true], null, false, Object(true), undefined];
    for (const r of found) {
      assert.deepEqual(answers(schemaAt('1/r'), { r, d: [1, 1] }), { first: true, valid: true, messages: [] }, String(r));
      assert.deepEqual(answers(items, { r, d: [[1, 1]] }), { first: true, valid: true, messages: [] }, String(r));
    }
    assert.deepEqual(answers(schemaAt('1/missing'), { d: [1, 1] }), { first: true, valid: true, messages: [] });
  });
});
