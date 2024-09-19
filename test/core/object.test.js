import { describe, it } from 'node:test';
import * as assert from '@jarenjs/tools/assert';

import { equalsDeep } from '@jarenjs/core/object';

describe('equalsDeep', () => {

  // correctly identifies two identical primitive values as equal
  assert.isTrue(equalsDeep(42, 42),
    'should return true when comparing two identical primitive values');

  // correctly identifies two different primitive values as not equal
  assert.isFalse(equalsDeep(42, 43),
    'should return false when comparing two different primitive values');

  // correctly identifies two identical objects as equal
  assert.isTrue(equalsDeep(
    { a: 1, b: 'hello' },
    { a: 1, b: 'hello' }
  ), 'should return true when comparing two identical objects');

  // correctly identifies two identical arrays as equal
  assert.isTrue(equalsDeep(
    [1, 2, 3],
    [1, 2, 3]
  ), 'should return true when comparing two identical arrays');

  // correctly identifies two identical maps as equal
  assert.isTrue(equalsDeep(
    new Map([[1, 'a'], [2, 'b']]),
    new Map([[1, 'a'], [2, 'b']])
  ), 'should return true when comparing two identical maps');

  // correctly identifies two identical sets as equal
  assert.isTrue(equalsDeep(
    new Set([1, 2, 3]),
    new Set([1, 2, 3])
  ), 'should return true when comparing two identical sets');

  // correctly identifies two identical regular expressions as equal
  assert.isTrue(equalsDeep(/test/g, /test/g),
    'should return true when comparing two identical regular expressions');

  // correctly identifies two identical typed arrays as equal
  assert.isTrue(equalsDeep(
    new Int8Array([1, 2, 3]),
    new Int8Array([1, 2, 3])
  ), 'should return true when comparing two identical typed arrays');

  // correctly identifies two objects with different keys as not equal
  assert.isFalse(equalsDeep(
    { a: 1, b: 2 },
    { a: 1, c: 3 }
  ), 'should return false when comparing two objects with different keys');

  // correctly identifies two objects with different values as not equal
  assert.isFalse(equalsDeep(
    { a: 1, b: 2 },
    { a: 1, b: 3 }
  ), 'should return false when comparing two objects with different values');

  // correctly identifies two arrays with different lengths as not equal
  assert.isFalse(equalsDeep(
    [1, 2, 3],
    [1, 2]
  ), 'should identify two arrays with different lengths as not equal');

  // correctly identifies two maps with different sizes as not equal
  assert.isFalse(equalsDeep(
    new Map([[1, 'a'], [2, 'b']]),
    new Map([[1, 'a']])
  ), 'should return false when comparing two maps with different sizes');

  // correctly identifies two sets with different sizes as not equal
  assert.isFalse(equalsDeep(
    new Set([1, 2, 3]),
    new Set([1, 2])
  ), 'should return false when comparing two sets with different sizes');

  // correctly identifies two regular expressions with different patterns as not equal
  assert.isFalse(equalsDeep(
    /hello/, 
    /world/
  ), 'should return false when comparing two regular expressions with different patterns');

  // correctly identifies two typed arrays with different lengths as not equal
  assert.isFalse(equalsDeep(
    new Int8Array([1, 2, 3]),
    new Int8Array([1, 2])
  ), 'should return false when comparing two typed arrays with different lengths');
  
  // correctly identifies two functions with different implementations as not equal
  assert.isFalse(equalsDeep(
    function () { return 'Hello'; },
    function () { return 'World'; }
  ), 'should return false when comparing two different functions');

  // correctly identifies null and undefined values as not equal to any other value
  assert.isFalse(equalsDeep(null, 42),
    'should return false when comparing null and a value');

  // correctly identifies boolean types as not equal to any other value
  assert.isFalse(equalsDeep(true, 42),
    'should return false when comparing a boolean with another value');

  // correctly identifies nested structures with different values as not equal
  assert.isFalse(equalsDeep(
    { a: { b: 1 } },
    { a: { b: 2 } }
  ), 'should return false when comparing two nested structures with different values');

  // correctly identifies classes
  class ShallowTest { constructor(value) { this.key = value } }
  assert.isFalse(equalsDeep(
    { key: 'value' },
    new ShallowTest('value')
  ), 'should return false when comparing objects with different constructors');

  assert.isFalse(equalsDeep(
    new ShallowTest('value1'),
    new ShallowTest('value2')
  ), 'should return false when comparing objects with different values');

  assert.isTrue(equalsDeep(
    new ShallowTest('value'),
    new ShallowTest('value')
  ), 'should return true when comparing objects with different constructors');

  //class DeepTest { constructor(value1, value2) { this.a = value1, this.b = { c: value2 } } }
  
});
