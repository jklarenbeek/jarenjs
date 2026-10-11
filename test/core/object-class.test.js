import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { isObjectClass, isObjectOfClass, isObjectType, isMapClass } from '@jarenjs/core';

// A member named `constructor` is data. Parsed JSON can carry one, and it
// must not change which class the object is.

describe('isObjectClass with a member named constructor', function () {
  it('still recognizes a plain object that carries the member', function () {
    for (const text of ['{"constructor":1}', '{"constructor":"x","a":2}', '{"constructor":null}', '{"constructor":{"constructor":[]}}']) {
      const value = JSON.parse(text);
      assert.strictEqual(isObjectClass(value), true, text);
      assert.strictEqual(isObjectOfClass(value, Object), true, text);
      assert.strictEqual(isObjectOfClass(value, Map), false, text);
      assert.strictEqual(isObjectType(value), true, text);
    }
  });

  it('keeps answering for everything else as before', function () {
    assert.strictEqual(isObjectClass({}), true);
    assert.strictEqual(isObjectClass([]), false);
    assert.strictEqual(isObjectClass(new Map()), false);
    assert.strictEqual(isObjectClass(Object.create(null)), false);
    assert.strictEqual(isObjectClass(null), false);
    assert.strictEqual(isObjectClass(undefined), false);
    assert.strictEqual(isObjectClass('a'), false);
    assert.strictEqual(isObjectClass(class Point {}), false);
    assert.strictEqual(isObjectClass(new (class Point {})()), false);
    assert.strictEqual(isMapClass(new Map()), true);
    assert.strictEqual(isObjectOfClass('a', String), true);
    assert.strictEqual(isObjectOfClass(1, Number), true);
  });
});
