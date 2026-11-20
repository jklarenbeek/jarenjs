//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JarenValidator } from '@jarenjs/validate';

/**
 * Each form a reference keyword takes, in both modes: `$data` on a member,
 * the `data` keyword (no `required` there), and `$data` in an item schema.
 * @param {string} keyword
 * @param {unknown} resolved - The value the reference finds
 * @param {unknown} instance - The value the keyword applies to
 * @returns {boolean[]} One answer per form and mode
 */
function answers(keyword, resolved, instance) {
  const forms = [
    [{ properties: { d: { [keyword]: { $data: '1/r' } } } }, { r: resolved, d: instance }],
    [{ properties: { d: { items: { [keyword]: { $data: '2/r' } } } } }, { r: resolved, d: [instance] }],
  ];
  if (keyword !== 'required')
    forms.push([{ properties: { d: { data: { [keyword]: '1/r' } } } }, { r: resolved, d: instance }]);
  const out = [];
  for (const [schema, data] of forms) {
    out.push(/** @type {boolean} */ (new JarenValidator().compile(schema)(data)));
    out.push(/** @type {any} */ (new JarenValidator({ collectErrors: true }).compile(schema)(data)).valid);
  }
  return out;
}

// keyword, the instance a right value refuses, that right value, values it
// does not assert by
const TABLE = [
  ['minimum', 1, 3, [NaN]],
  ['maximum', 5, 3, [NaN]],
  ['exclusiveMinimum', 3, 3, [NaN]],
  ['exclusiveMaximum', 3, 3, [NaN]],
  ['multipleOf', 5, 3, [NaN, 0, -0, -3, -Infinity]],
  ['minLength', 'ab', 3, [NaN, 1.5, -1, Infinity, -Infinity]],
  ['maxLength', 'abcd', 3, [NaN, 1.5, -1, Infinity, -Infinity]],
  ['minItems', [1, 2], 3, [NaN, 1.5, -1, Infinity, -Infinity]],
  ['maxItems', [1, 2, 3, 4], 3, [NaN, 1.5, -1, Infinity, -Infinity]],
  ['minProperties', { a: 1 }, 3, [NaN, 1.5, -1, Infinity, -Infinity]],
  ['maxProperties', { a: 1, b: 2, c: 3, d: 4 }, 3, [NaN, 1.5, -1, Infinity, -Infinity]],
  ['pattern', 'ab', '^c', ['(', '[', 'a{2,1}', '\\']],
  ['required', {}, ['a'], [['a', 1], [1], [null], [['a']]]],
];

describe('a reference keyword that finds a value it does not assert by', function () {
  for (const [keyword, instance, right, wrong] of TABLE) {
    it(`${keyword}: a right value asserts, ${wrong.map(String).join(', ')} assert nothing`, function () {
      const forms = keyword === 'required' ? 4 : 6;
      assert.deepEqual(answers(keyword, right, instance), Array(forms).fill(false), 'the right value refuses');
      for (const value of /** @type {unknown[]} */ (wrong))
        assert.deepEqual(answers(keyword, value, instance), Array(forms).fill(true), String(value));
    });
  }

  it('keeps the readings of an infinite bound, an infinite step and a count of 0', function () {
    assert.deepEqual(answers('minimum', Infinity, 5), Array(6).fill(false));
    assert.deepEqual(answers('maximum', -Infinity, 5), Array(6).fill(false));
    // `{ "multipleOf": Infinity }` takes every number, as the static keyword does
    assert.deepEqual(answers('multipleOf', Infinity, 5), Array(6).fill(true));
    assert.equal(new JarenValidator().compile({ multipleOf: Infinity })(5), true);
    assert.deepEqual(answers('maxLength', 0, 'a'), Array(6).fill(false));
    assert.deepEqual(answers('maxLength', -0, ''), Array(6).fill(true));
    assert.deepEqual(answers('required', [], {}), Array(4).fill(true));
  });
});
