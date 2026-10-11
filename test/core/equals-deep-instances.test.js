//@ts-check
/**
 * @file `equalsDeep` over values whose state is not in their members: a Date
 * keeps its instant in an internal slot, so every pair used to compare equal;
 * and a null-prototype object (or an own `__proto__` member) made
 * `isTypedArray` read through a missing accessor and throw.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isTypedArray } from '@jarenjs/core';
import { equalsDeep, isUniqueDeepArray } from '@jarenjs/core/object';

describe('equalsDeep — Date', () => {
  it('compares two Dates by instant', () => {
    assert.strictEqual(equalsDeep(new Date(1), new Date(1)), true);
    assert.strictEqual(equalsDeep(new Date(1), new Date(2)), false);
  });

  it('compares Dates nested in plain data', () => {
    assert.strictEqual(equalsDeep({ at: new Date(5) }, { at: new Date(5) }), true);
    assert.strictEqual(equalsDeep({ at: new Date(5) }, { at: new Date(6) }), false);
    assert.strictEqual(equalsDeep([new Date(5)], [new Date(6)]), false);
  });

  it('treats two invalid Dates as the same value and an invalid one as unlike a valid one', () => {
    assert.strictEqual(equalsDeep(new Date(NaN), new Date(NaN)), true);
    assert.strictEqual(equalsDeep(new Date(NaN), new Date(0)), false);
  });

  it('feeds the unique-items check: distinct Dates are unique, equal ones are not', () => {
    assert.strictEqual(isUniqueDeepArray([new Date(1), new Date(2)]), true);
    assert.strictEqual(isUniqueDeepArray([new Date(1), new Date(1)]), false);
  });
});

describe('equalsDeep — null-prototype objects and functions', () => {
  it('compares null-prototype objects by members', () => {
    const a = Object.assign(Object.create(null), { x: 1, y: [1, 2] });
    const b = Object.assign(Object.create(null), { x: 1, y: [1, 2] });
    const c = Object.assign(Object.create(null), { x: 1, y: [1, 3] });
    assert.strictEqual(equalsDeep(a, b), true);
    assert.strictEqual(equalsDeep(a, c), false);
    assert.strictEqual(equalsDeep(Object.create(null), Object.create(null)), true);
  });

  it('compares an object holding an own __proto__ member', () => {
    const a = JSON.parse('{"__proto__":null,"k":1}');
    const b = JSON.parse('{"__proto__":null,"k":1}');
    assert.strictEqual(equalsDeep(a, b), true);
  });

  it('answers false for a function against a value that is not one', () => {
    assert.strictEqual(equalsDeep(() => 1, Object.create(null)), false);
    assert.strictEqual(equalsDeep(() => 1, {}), false);
    assert.strictEqual(equalsDeep(() => 1, () => 1), true);
  });
});

describe('isTypedArray', () => {
  it('is false for a null-prototype object and for an own __proto__ member', () => {
    assert.strictEqual(isTypedArray(Object.create(null)), false);
    assert.strictEqual(isTypedArray(JSON.parse('{"__proto__":null}')), false);
    assert.strictEqual(isTypedArray(JSON.parse('{"__proto__":{"__proto__":null}}')), false);
  });

  it('keeps answering for the real thing', () => {
    assert.strictEqual(isTypedArray(new Uint8Array(2)), true);
    assert.strictEqual(isTypedArray(new Float64Array(1)), true);
    assert.strictEqual(isTypedArray([]), false);
    assert.strictEqual(isTypedArray({}), false);
    assert.strictEqual(isTypedArray(1), false);
    assert.strictEqual(isTypedArray(null), false);
  });
});
