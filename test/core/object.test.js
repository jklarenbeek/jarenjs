import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  equalsDeep, equalsJson, mergeMap, mergeSet, stableStringify,
  isJsonObject, isJsonValue, setObjectMember, deepFreeze,
} from '@jarenjs/core/object';

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

describe('equalsJson', () => {

  // primitives compare by ===
  assert.isTrue(equalsJson(42, 42),
    'should return true when comparing two identical primitive values');

  assert.isTrue(equalsJson(1, 1.0),
    'should return true for 1 and 1.0 (JSON numbers are doubles)');

  assert.isFalse(equalsJson(42, 43),
    'should return false when comparing two different primitive values');

  assert.isFalse(equalsJson(1, '1'),
    'should return false when comparing values of different JSON types');

  // null handling
  assert.isTrue(equalsJson(null, null),
    'should return true when comparing null with null');

  assert.isFalse(equalsJson(null, {}),
    'should return false when comparing null with an object');

  assert.isFalse(equalsJson({}, null),
    'should return false when comparing an object with null');

  // deep object equality, key order independent
  assert.isTrue(equalsJson(
    { a: 1, b: { c: [1, 2] } },
    { b: { c: [1, 2] }, a: 1 }
  ), 'should return true for deeply equal objects regardless of key order');

  assert.isFalse(equalsJson(
    { a: { b: 1 } },
    { a: { b: 2 } }
  ), 'should return false for nested objects with different values');

  // deep array equality, order dependent
  assert.isTrue(equalsJson([1, [2, { a: 3 }]], [1, [2, { a: 3 }]]),
    'should return true for deeply equal arrays');

  assert.isFalse(equalsJson([1, 2], [2, 1]),
    'should return false for arrays with the same items in a different order');

  assert.isFalse(equalsJson([1, 2, 3], [1, 2]),
    'should return false for arrays with different lengths');

  // array vs object mismatch
  assert.isFalse(equalsJson([], {}),
    'should return false when comparing an array with an object');

  assert.isFalse(equalsJson({ 0: 'a' }, ['a']),
    'should return false when comparing an array-like object with an array');

  // extra-key mismatch, both directions
  assert.isFalse(equalsJson({ a: 1 }, { a: 1, b: 2 }),
    'should return false when the second object has an extra key');

  assert.isFalse(equalsJson({ a: 1, b: 2 }, { a: 1 }),
    'should return false when the first object has an extra key');

  // contrast with equalsDeep: equalsJson only sees own enumerable keys,
  // so two functions with identical source disagree between the two
  const fnA = function () { return 'same'; };
  const fnB = function () { return 'same'; };
  assert.isTrue(equalsDeep(fnA, fnB),
    'equalsDeep should compare functions by source');
  assert.isFalse(equalsJson(fnA, fnB),
    'equalsJson should compare functions by identity only');

  // contrast with equalsDeep: equalsJson ignores constructors,
  // equalsDeep requires them to match
  class ShallowJson { constructor(value) { this.key = value; } }
  assert.isFalse(equalsDeep({ key: 'value' }, new ShallowJson('value')),
    'equalsDeep should return false for different constructors');
  assert.isTrue(equalsJson({ key: 'value' }, new ShallowJson('value')),
    'equalsJson should return true for equal own enumerable keys');

  // contrast with equalsDeep: Map entries are not own enumerable keys,
  // so equalsJson cannot tell two different Maps apart
  assert.isFalse(equalsDeep(new Map([[1, 'a']]), new Map([[2, 'b']])),
    'equalsDeep should compare Map entries');
  assert.isTrue(equalsJson(new Map([[1, 'a']]), new Map([[2, 'b']])),
    'equalsJson should not look at Map entries (JSON-only semantics)');

});

describe('mergeMap', () => {
  it('should merge multiple maps into the target map', () => {
    const target = new Map([['a', 1]]);
    const source1 = new Map([['b', 2]]);
    const source2 = new Map([['c', 3]]);
    
    mergeMap(target, source1, source2);
    
    assert.isTrue(equalsDeep(target, new Map([['a', 1], ['b', 2], ['c', 3]])));
  });

  it('should overwrite existing keys with values from later maps', () => {
    const target = new Map([['a', 1]]);
    const source = new Map([['a', 2]]);
    
    mergeMap(target, source);
    
    assert.isTrue(equalsDeep(target, new Map([['a', 2]])));
  });

  it('should handle merging an empty map', () => {
    const target = new Map([['a', 1]]);
    const empty = new Map();
    
    mergeMap(target, empty);
    
    assert.isTrue(equalsDeep(target, new Map([['a', 1]])));
  });

  it('should handle merging into an empty map', () => {
    const target = new Map();
    const source = new Map([['a', 1], ['b', 2]]);
    
    mergeMap(target, source);
    
    assert.isTrue(equalsDeep(target, new Map([['a', 1], ['b', 2]])));
  });

  it('should handle merging with no source maps', () => {
    const target = new Map([['a', 1]]);
    
    mergeMap(target);
    
    assert.isTrue(equalsDeep(target, new Map([['a', 1]])));
  });

  it('should handle complex values in maps', () => {
    const target = new Map([['obj', { x: 1 }]]);
    const source = new Map([['arr', [1, 2, 3]]]);
    
    mergeMap(target, source);
    
    assert.isTrue(target.has('obj'));
    assert.isTrue(target.has('arr'));
    assert.isTrue(equalsDeep(target.get('arr'), [1, 2, 3]));
  });
});

describe('mergeSet', () => {
  it('should merge multiple sets into the target set', () => {
    const target = new Set([1, 2]);
    const source1 = new Set([3, 4]);
    const source2 = new Set([5, 6]);
    
    mergeSet(target, source1, source2);
    
    assert.isTrue(equalsDeep(target, new Set([1, 2, 3, 4, 5, 6])));
  });

  it('should not add duplicate values', () => {
    const target = new Set([1, 2]);
    const source = new Set([2, 3]);
    
    mergeSet(target, source);
    
    assert.isTrue(equalsDeep(target, new Set([1, 2, 3])));
  });

  it('should handle merging an empty set', () => {
    const target = new Set([1, 2]);
    const empty = new Set();
    
    mergeSet(target, empty);
    
    assert.isTrue(equalsDeep(target, new Set([1, 2])));
  });

  it('should handle merging into an empty set', () => {
    const target = new Set();
    const source = new Set([1, 2, 3]);
    
    mergeSet(target, source);
    
    assert.isTrue(equalsDeep(target, new Set([1, 2, 3])));
  });

  it('should handle merging with no source sets', () => {
    const target = new Set([1, 2]);
    
    mergeSet(target);
    
    assert.isTrue(equalsDeep(target, new Set([1, 2])));
  });

  it('should handle complex values in sets', () => {
    const target = new Set([{ a: 1 }]);
    const source = new Set([[1, 2, 3]]);
    
    mergeSet(target, source);
    
    assert.isTrue(target.size === 2);
  });
});

describe('stableStringify', () => {
  it('emits sorted keys at every depth', () => {
    assert.isTrue(
      stableStringify({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })
      === '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });

  it('is insertion-order independent', () => {
    assert.isTrue(
      stableStringify({ x: 1, y: [true, null] })
      === stableStringify({ y: [true, null], x: 1 }));
  });

  it('follows JSON.stringify for undefined and primitives', () => {
    assert.isTrue(stableStringify(undefined) === undefined);
    assert.isTrue(stableStringify({ u: undefined }) === '{}');
    assert.isTrue(stableStringify([undefined]) === '[null]');
    assert.isTrue(stableStringify('x') === '"x"');
    assert.isTrue(stableStringify(1.5) === '1.5');
    assert.isTrue(stableStringify(null) === 'null');
  });
});

describe('isJsonObject', () => {
  it('separates objects from arrays and null', () => {
    assert.isTrue(isJsonObject({}));
    assert.isTrue(isJsonObject({ a: 1 }));
    assert.isTrue(isJsonObject(Object.create(null)));
    assert.isFalse(isJsonObject([]));
    assert.isFalse(isJsonObject(null));
    assert.isFalse(isJsonObject('x'));
    assert.isFalse(isJsonObject(undefined));
  });
});

describe('isJsonValue', () => {
  it('accepts every JSON scalar and container shape', () => {
    assert.isTrue(isJsonValue(null));
    assert.isTrue(isJsonValue(true));
    assert.isTrue(isJsonValue(0));
    assert.isTrue(isJsonValue(-1.5));
    assert.isTrue(isJsonValue(''));
    assert.isTrue(isJsonValue([]));
    assert.isTrue(isJsonValue({}));
    assert.isTrue(isJsonValue(Object.create(null)));
    assert.isTrue(isJsonValue({ a: [1, { b: 'c', d: null }], e: { f: [] } }));
  });

  it('rejects what JSON cannot carry', () => {
    assert.isFalse(isJsonValue(undefined));
    assert.isFalse(isJsonValue(NaN));
    assert.isFalse(isJsonValue(Infinity));
    assert.isFalse(isJsonValue(-Infinity));
    assert.isFalse(isJsonValue(10n));
    assert.isFalse(isJsonValue(Symbol('s')));
    assert.isFalse(isJsonValue(() => 1));
    assert.isFalse(isJsonValue([undefined]));
    assert.isFalse(isJsonValue({ a: () => 1 }));
    assert.isFalse(isJsonValue({ a: { b: NaN } }));
  });

  it('rejects host objects at any depth', () => {
    assert.isFalse(isJsonValue(new Error('x')));
    assert.isFalse(isJsonValue(new Date(0)));
    assert.isFalse(isJsonValue(new Map()));
    assert.isFalse(isJsonValue(new Uint8Array(1)));
    class Thing {}
    assert.isFalse(isJsonValue(new Thing()));
    assert.isFalse(isJsonValue({ status: 404, cause: new Error('deep') }));
    assert.isFalse(isJsonValue([[[new Date(0)]]]));
  });

  it('rejects a cycle but accepts a shared subtree', () => {
    /** @type {any} */
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    assert.isFalse(isJsonValue(cyclic));
    const ring = [1];
    ring.push(/** @type {any} */ (ring));
    assert.isFalse(isJsonValue(ring));
    const shared = { x: 1 };
    assert.isTrue(isJsonValue({ a: shared, b: shared, c: [shared, shared] }));
  });

  it('is total: a throwing accessor makes the value not-JSON', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'boom', {
      enumerable: true, get() { throw new Error('trap'); },
    });
    assert.isFalse(isJsonValue(hostile));
    assert.isFalse(isJsonValue({ ok: 1, nested: hostile }));
  });
});

describe('setObjectMember', () => {
  it('assigns an ordinary member', () => {
    const out = {};
    setObjectMember(out, 'a', 1);
    assert.isTrue(out.a === 1);
  });

  it('makes __proto__ an own data property instead of a prototype write', () => {
    const out = {};
    const payload = { polluted: true };
    setObjectMember(out, '__proto__', payload);
    assert.isTrue(Object.hasOwn(out, '__proto__'));
    assert.isTrue(out['__proto__'] === payload);
    assert.isTrue(Object.getPrototypeOf(out) === Object.prototype);
    assert.isTrue({}.polluted === undefined);
  });
});

describe('deepFreeze', () => {
  it('freezes every reachable container and returns the value', () => {
    const value = { a: { b: [1, { c: 2 }] } };
    assert.isTrue(deepFreeze(value) === value);
    assert.isTrue(Object.isFrozen(value));
    assert.isTrue(Object.isFrozen(value.a));
    assert.isTrue(Object.isFrozen(value.a.b));
    assert.isTrue(Object.isFrozen(value.a.b[1]));
  });

  it('passes scalars through untouched', () => {
    assert.isTrue(deepFreeze(1) === 1);
    assert.isTrue(deepFreeze(null) === null);
    assert.isTrue(deepFreeze('s') === 's');
  });
});
