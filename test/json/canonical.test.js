import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';
import { match as assertMatch, rejects as assertRejects } from 'node:assert';

import {
  canonicalizeJson,
  canonicalSha256,
  cloneJson,
  JsonCanonicalizeError,
} from '@jarenjs/json';

describe('canonicalizeJson (RFC 8785 / JCS)', () => {
  it('should sort members by UTF-16 code unit', () => {
    // The property-sorting example of RFC 8785 section 3.2.3. Every
    // non-ASCII key is written as an escape because the point of the
    // example is the exact code units: a literal would leave the
    // composed/decomposed form of U+FB33 to whatever last normalized
    // this file, and the expected order would silently change with it.
    const input = {
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '\ud83d\ude00': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    };
    // the emoji (D83D DE00) sorts BEFORE U+FB33: the comparison is on
    // UTF-16 code units, not on code points
    assert.deepEqual(canonicalizeJson(input),
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control",'
      + '"\u00f6":"Latin Small Letter O With Diaeresis",'
      + '"\u20ac":"Euro Sign",'
      + '"\ud83d\ude00":"Emoji: Grinning Face",'
      + '"\ufb33":"Hebrew Letter Dalet With Dagesh"}');
  });

  it('should be insensitive to member insertion order', () => {
    assert.deepEqual(canonicalizeJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.deepEqual(canonicalizeJson({ a: 2, b: 1 }), canonicalizeJson({ b: 1, a: 2 }));
    assert.deepEqual(
      canonicalizeJson({ x: { d: 4, c: 3 }, a: 1 }),
      canonicalizeJson({ a: 1, x: { c: 3, d: 4 } }));
  });

  it('should serialize numbers per ECMAScript Number::toString', () => {
    assert.deepEqual(canonicalizeJson(0), '0');
    assert.deepEqual(canonicalizeJson(-0), '0');
    assert.deepEqual(canonicalizeJson(1e21), '1e+21');
    assert.deepEqual(canonicalizeJson(1e-6), '0.000001');
    assert.deepEqual(canonicalizeJson(1e-7), '1e-7');
    assert.deepEqual(canonicalizeJson(9007199254740992), '9007199254740992');
    assert.deepEqual(canonicalizeJson(5e-324), '5e-324');
    assert.deepEqual(canonicalizeJson(1.7976931348623157e308), '1.7976931348623157e+308');
  });

  it('should escape strings minimally and leave non-ASCII raw', () => {
    assert.deepEqual(canonicalizeJson('\0\x1f"\\'), '"\\u0000\\u001f\\"\\\\"');
    assert.deepEqual(canonicalizeJson('\b\t\n\f\r'), '"\\b\\t\\n\\f\\r"');
    assert.deepEqual(canonicalizeJson('é😀'), '"é😀"');
    assert.deepEqual(canonicalizeJson({ 'a\\b': 1 }), '{"a\\\\b":1}');
  });

  it('should serialize the remaining JSON shapes', () => {
    assert.deepEqual(canonicalizeJson(null), 'null');
    assert.deepEqual(canonicalizeJson(true), 'true');
    assert.deepEqual(canonicalizeJson(false), 'false');
    assert.deepEqual(canonicalizeJson([]), '[]');
    assert.deepEqual(canonicalizeJson({}), '{}');
    assert.deepEqual(canonicalizeJson({ '': 1 }), '{"":1}');
    assert.deepEqual(canonicalizeJson({ a: [1, { d: 4, c: 3 }], b: null }),
      '{"a":[1,{"c":3,"d":4}],"b":null}');
    // a null-prototype object is still a JSON object
    assert.deepEqual(canonicalizeJson(Object.assign(Object.create(null), { b: 1, a: 2 })),
      '{"a":2,"b":1}');
    // sharing a subtree is not a cycle
    const shared = { x: 1 };
    assert.deepEqual(canonicalizeJson({ b: shared, a: shared }), '{"a":{"x":1},"b":{"x":1}}');
  });

  it('should reject values that are not JSON, instead of coercing them', () => {
    // JSON.stringify drops or coerces each of these; a signature over a
    // rewritten document is a signature over something nobody sent
    for (const value of [undefined, NaN, Infinity, -Infinity, 1n, () => 1, Symbol('x')])
      assert.throws(() => canonicalizeJson(value), JsonCanonicalizeError);
    assert.throws(() => canonicalizeJson({ a: undefined }), JsonCanonicalizeError);
    assert.throws(() => canonicalizeJson([1, undefined]), JsonCanonicalizeError);
    // eslint-disable-next-line no-sparse-arrays
    assert.throws(() => canonicalizeJson([1, , 3]), JsonCanonicalizeError);
  });

  it('should reject unpaired surrogates', () => {
    assert.throws(() => canonicalizeJson('\ud800'), JsonCanonicalizeError);
    assert.throws(() => canonicalizeJson('a\udc00b'), JsonCanonicalizeError);
    assert.throws(() => canonicalizeJson({ '\ud800': 1 }), JsonCanonicalizeError);
    // a well-formed pair is one code point and passes
    assert.deepEqual(canonicalizeJson('😀'), '"😀"');
  });

  it('should reject non-plain objects rather than walk them as {}', () => {
    assert.throws(() => canonicalizeJson(new Date(0)), JsonCanonicalizeError);
    assert.throws(() => canonicalizeJson(new Map()), JsonCanonicalizeError);
    assert.throws(() => canonicalizeJson(new Set()), JsonCanonicalizeError);
    assert.throws(() => canonicalizeJson(new (class Foo { })()), JsonCanonicalizeError);
    // toJSON is deliberately not consulted: what is signed is what was passed
    assert.throws(() => canonicalizeJson({ a: new Date(0) }), JsonCanonicalizeError);
  });

  it('should reject a circular reference', () => {
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    assert.throws(() => canonicalizeJson(cyclic), JsonCanonicalizeError);
    const arr = [1];
    arr.push(arr);
    assert.throws(() => canonicalizeJson(arr), JsonCanonicalizeError);
  });

  it('should point at the offending value with a JSON Pointer', () => {
    try {
      canonicalizeJson({ a: { b: [1, NaN] } });
      assert.fail('expected a JsonCanonicalizeError');
    }
    catch (error) {
      assert.isTrue(error instanceof JsonCanonicalizeError);
      assert.deepEqual(error.dataPath, '/a/b/1');
      // a programming error, the class JSON.stringify raises too
      assert.isTrue(error instanceof TypeError);
    }
    try {
      canonicalizeJson({ 'a/b~c': undefined });
      assert.fail('expected a JsonCanonicalizeError');
    }
    catch (error) {
      assert.deepEqual(error.dataPath, '/a~1b~0c');
    }
    try {
      canonicalizeJson(undefined);
      assert.fail('expected a JsonCanonicalizeError');
    }
    catch (error) {
      assert.deepEqual(error.dataPath, '');
      assert.isTrue(error.message.includes('the document root'));
    }
  });

  it('should round-trip through JSON.parse unchanged', () => {
    for (const value of [
      { b: 1, a: [2, 3] },
      { 'ü': { z: null, 'a b': true } },
      [1e21, 1e-7, 0.1, -0],
      'plain',
    ]) {
      const text = canonicalizeJson(value);
      assert.deepEqual(canonicalizeJson(JSON.parse(text)), text);
    }
  });
});

describe('canonicalSha256', () => {
  it('is the lowercase hex SHA-256 over the canonical bytes, so member order does not matter', async () => {
    const a = await canonicalSha256({ b: 1, a: [2, 3] });
    const b = await canonicalSha256({ a: [2, 3], b: 1 });
    assert.strictEqual(a, b);
    assertMatch(a, /^[0-9a-f]{64}$/);
    // the RFC 8785 text of the value, hashed by the platform primitive
    const bytes = new TextEncoder().encode(canonicalizeJson({ b: 1, a: [2, 3] }));
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    assert.strictEqual(a, Array.from(digest, (x) => x.toString(16).padStart(2, '0')).join(''));
  });

  it('distinguishes values that differ and refuses non-JSON as a rejection', async () => {
    assert.notStrictEqual(await canonicalSha256({ a: 1 }), await canonicalSha256({ a: 2 }));
    await assertRejects(() => canonicalSha256({ a: () => 1 }), JsonCanonicalizeError);
  });
});

describe('cloneJson', () => {
  it('copies through the canonical text: unshared, member order canonical, an own __proto__ kept', () => {
    const inner = { z: [1, { y: 2 }] };
    const original = JSON.parse('{"b":1,"a":{"z":[1,{"y":2}]},"__proto__":{"k":3}}');
    original.shared = inner;
    original.again = inner;
    const copy = cloneJson(original);
    assert.deepStrictEqual(Object.keys(copy), ['__proto__', 'a', 'again', 'b', 'shared']);
    assert.deepStrictEqual(copy.a, { z: [1, { y: 2 }] });
    assert.notStrictEqual(copy.shared, copy.again);
    assert.notStrictEqual(copy.shared, inner);
    assert.strictEqual(Object.getPrototypeOf(copy), Object.prototype);
    assert.deepStrictEqual(Object.getOwnPropertyDescriptor(copy, '__proto__')?.value, { k: 3 });
    copy.shared.z.push(9);
    assert.deepStrictEqual(inner.z, [1, { y: 2 }]);
  });

  it('refuses what is not JSON data before copying, as canonicalizeJson does', () => {
    for (const bad of [undefined, () => 1, NaN, 1n, { a: undefined }, new Date(0)]) {
      assert.throws(() => cloneJson(bad), JsonCanonicalizeError);
    }
    const cycle = {};
    cycle.self = cycle;
    assert.throws(() => cloneJson(cycle), JsonCanonicalizeError);
  });
});
