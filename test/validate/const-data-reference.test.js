//@ts-check
/**
 * @file A `const` is a `$data` reference only when its `$data` is a string
 * (a pointer: empty for the root, relative or absolute). Any other `$data`
 * member makes the object a literal value the instance must equal; it used
 * to drop the keyword, so the schema accepted every value. The empty pointer
 * is read as the reference alone: it used to be read twice, as a reference
 * and as the literal `{ "$data": "" }`, and refused every value.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JarenValidator } from '@jarenjs/validate';

/**
 * The boolean answers of a schema for each instance.
 * @param {object} schema @param {unknown[]} instances
 */
function answers(schema, instances) {
  const validate = new JarenValidator().compile(schema);
  return instances.map((x) => validate(x));
}

const VALUES = [5, 'x', { $data: 5 }, { $data: true }, { a: 1 }, null];

describe('a const whose $data is not a string is the literal value', () => {
  it('admits only an equal object for a number $data', () => {
    assert.deepEqual(answers({ const: { $data: 5 } }, VALUES), [false, false, true, false, false, false]);
  });

  it('admits only an equal object for a boolean $data', () => {
    assert.deepEqual(answers({ const: { $data: true } }, VALUES), [false, false, false, true, false, false]);
  });

  it('reports the literal as the allowed value', () => {
    const result = /** @type {any} */ (new JarenValidator({ collectErrors: true }).compile({ const: { $data: 5 } })(5));
    assert.deepEqual(result.errors.map((/** @type {any} */ e) => [e.keyword, e.params.allowedValue]), [['const', { $data: 5 }]]);
  });

  it('keeps the literal readings that were right: a null and a zero $data', () => {
    assert.deepEqual(answers({ const: { $data: null } }, [{ $data: null }, null, 1]), [true, false, false]);
    assert.deepEqual(answers({ const: { $data: 0 } }, [{ $data: 0 }, 0, 1]), [true, false, false]);
  });
});

describe('a const whose $data is a string resolves it and compares any JSON value', () => {
  it('reads the empty pointer as the root once: every value equals itself', () => {
    assert.deepEqual(answers({ const: { $data: '' } }, VALUES), [true, true, true, true, true, true]);
  });

  it('reads the empty pointer below the root as the whole instance', () => {
    assert.deepEqual(answers({ properties: { b: { const: { $data: '' } } } }, [{ b: 1 }, {}]), [false, true]);
  });

  it('keeps comparing a relative pointer against a value of every type', () => {
    const schema = { properties: { a: {}, b: { const: { $data: '1/a' } } } };
    assert.deepEqual(answers(schema, [
      { a: 5, b: 5 }, { a: 5, b: 6 }, { a: [1], b: [1] }, { a: [1], b: [2] },
      { a: { x: 1 }, b: { x: 1 } }, { a: null, b: null }, { a: null, b: 0 }, { a: 'q', b: 'q' }, { b: 1 },
    ]), [true, false, true, false, true, true, false, true, true]);
  });
});

describe('a pattern whose $data is the empty pointer', () => {
  it('reads the root as the pattern, where it used to throw an uncoded error', () => {
    assert.deepEqual(answers({ pattern: { $data: '' } }, ['a', 'b', 5]), [true, true, true]);
  });
});
