//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileJsonQuery } from '@jarenjs/json/query';

// `$from-entries` assembles its object member by member, so a pair named
// like an object's prototype slot is a member, not a prototype change.

describe('$from-entries member names', function () {
  const run = compileJsonQuery({ '$from-entries': '$[*]' });

  it('keeps a __proto__ pair as an own member and leaves the prototype alone', function () {
    const pairs = JSON.parse('[{"key":"__proto__","value":{"x":1}},{"key":"a","value":1}]');
    const out = run(pairs);
    assert.deepStrictEqual(Object.keys(out), ['__proto__', 'a']);
    assert.strictEqual(Object.getPrototypeOf(out), Object.prototype);
    assert.strictEqual(/** @type {any} */ (out).x, undefined);
    assert.strictEqual(JSON.stringify(out), '{"__proto__":{"x":1},"a":1}');
  });

  it('keeps a null __proto__ value as a member', function () {
    const out = run(JSON.parse('[{"key":"__proto__","value":null}]'));
    assert.strictEqual(Object.getPrototypeOf(out), Object.prototype);
    assert.strictEqual(JSON.stringify(out), '{"__proto__":null}');
  });

  it('still lets a later pair win on a duplicate key', function () {
    const out = run(JSON.parse('[{"key":"a","value":1},{"key":"__proto__","value":1},{"key":"a","value":2},{"key":"__proto__","value":3}]'));
    assert.strictEqual(JSON.stringify(out), '{"a":2,"__proto__":3}');
  });
});
