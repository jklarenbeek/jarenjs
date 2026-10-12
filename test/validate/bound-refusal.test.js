//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';

describe('a count bound that contradicts its lower bound', () => {
  const compile = (/** @type {any} */ schema) => new JarenValidator().compile(schema);

  it('is refused with a message that says what is allowed', () => {
    assert.throws(() => compile({ minItems: 3, maxItems: 2 }), { message: 'maxItems must not be smaller than minItems' });
    assert.throws(() => compile({ minProperties: 3, maxProperties: 2 }),
      { message: 'maxProperties must not be smaller than minProperties' });
  });

  it('accepts equal bounds', () => {
    assert.equal(compile({ minItems: 2, maxItems: 2 })([1, 2]), true);
    assert.equal(compile({ minItems: 2, maxItems: 2 })([1]), false);
    assert.equal(compile({ minProperties: 1, maxProperties: 1 })({ a: 1 }), true);
    assert.equal(compile({ minProperties: 1, maxProperties: 1 })({}), false);
  });
});
