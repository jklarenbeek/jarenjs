//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';

describe('a count bound that contradicts its lower bound', () => {
  const compile = (/** @type {any} */ schema) => new JarenValidator().compile(schema);

  it('compiles and never validates, like a contradictory range', () => {
    const items = compile({ minItems: 3, maxItems: 2 });
    for (const data of [[], [1], [1, 2], [1, 2, 3], [1, 2, 3, 4]]) assert.equal(items(data), false);
    assert.equal(items('text'), true);
    const props = compile({ minProperties: 3, maxProperties: 2 });
    for (const data of [{}, { a: 1 }, { a: 1, b: 2 }, { a: 1, b: 2, c: 3 }]) assert.equal(props(data), false);
    assert.equal(props(1), true);
  });

  it('is satisfiable where a branch negates or alternates it', () => {
    assert.equal(compile({ not: { minItems: 3, maxItems: 1 } })([1, 2]), true);
    assert.equal(compile({ not: { minProperties: 3, maxProperties: 1 } })({ a: 1 }), true);
    const either = compile({ anyOf: [{ minItems: 3, maxItems: 1 }, { type: 'string' }] });
    assert.equal(either('x'), true);
    assert.equal(either([1, 2]), false);
  });

  it('accepts equal bounds', () => {
    assert.equal(compile({ minItems: 2, maxItems: 2 })([1, 2]), true);
    assert.equal(compile({ minItems: 2, maxItems: 2 })([1]), false);
    assert.equal(compile({ minProperties: 1, maxProperties: 1 })({ a: 1 }), true);
    assert.equal(compile({ minProperties: 1, maxProperties: 1 })({}), false);
  });
});
