//@ts-check
/**
 * @file The two content keys, and the line between them.
 *
 * `contentKey` is the memo-grade FINGERPRINT: structurally equal values
 * produce the same key regardless of property insertion order, which is
 * what a vnode key, a DOM id or a bucket index needs. Its three
 * documented caveats (distinct values DO collide, `undefined` members
 * are dropped, no cycle guard) are pinned here so nobody mistakes it for
 * an identity or a checksum.
 *
 * `semanticKey` is the collision-free IDENTITY for caches whose entries
 * decide a result. The collision below is the real one: two ordinary
 * query documents differing only in a return literal that share a
 * `contentKey`. When that key was a compiled query's identity, the
 * second query returned the first query's rows.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { contentKey, semanticKey, stableStringify } from '@jarenjs/core/object';
import { hashContent } from '@jarenjs/core/string';
import { createSemanticCache } from '@jarenjs/core/cache';

/** Two documents that collide under the 32-bit fingerprint. */
const COLLIDING = [
  { $for: { it: '$[*]' }, $return: '5ln9p' },
  { $for: { it: '$[*]' }, $return: 'nbe0a' },
];

describe('contentKey', () => {
  it('is insensitive to property insertion order at every depth', () => {
    assert.strictEqual(
      contentKey({ a: 1, b: { x: [1, 2], y: 'z' } }),
      contentKey({ b: { y: 'z', x: [1, 2] }, a: 1 }));
  });

  it('distinguishes structurally different values', () => {
    assert.notStrictEqual(contentKey({ a: 1 }), contentKey({ a: 2 }));
    assert.notStrictEqual(contentKey([1, 2]), contentKey([2, 1]));
  });

  it('is exactly the documented composition', () => {
    const value = { config: ['bar', { stacked: true }] };
    assert.strictEqual(contentKey(value), hashContent(stableStringify(value) ?? ''));
    assert.strictEqual(contentKey(undefined), hashContent(''));
  });

  it('drops undefined members (memo-grade, NOT checksum-grade)', () => {
    assert.strictEqual(contentKey({ a: 1, b: undefined }), contentKey({ a: 1 }));
  });

  it('COLLIDES on distinct values — a fingerprint, never an identity', () => {
    assert.strictEqual(contentKey(COLLIDING[0]), contentKey(COLLIDING[1]));
  });
});

describe('semanticKey', () => {
  it('refuses numeric-looking extra array members that are not element indices', () => {
    for (const key of ['01', '1.0', '1e0', '+1', '-0', '0x1', ' 1', '']) {
      const value = Object.assign([1, 2], { [key]: 'extra' });
      assert.throws(() => semanticKey(value), TypeError, JSON.stringify(key));
    }
    assert.strictEqual(semanticKey([1, 2]), '[1,2]');
  });

  it('separates the documents contentKey collides', () => {
    assert.notStrictEqual(semanticKey(COLLIDING[0]), semanticKey(COLLIDING[1]));
  });

  it('is insensitive to property insertion order at every depth', () => {
    assert.strictEqual(
      semanticKey({ a: 1, b: { x: [1, 2], y: 'z' } }),
      semanticKey({ b: { y: 'z', x: [1, 2] }, a: 1 }));
  });

  it('gives 200k trivially different documents 200k identities', () => {
    const seen = new Set();
    for (let i = 0; i < 200_000; i++)
      seen.add(semanticKey({ $for: { it: '$[*]' }, $return: i.toString(36) }));
    assert.strictEqual(seen.size, 200_000);
  });

  it('keeps apart every value JSON text folds together', () => {
    const distinct = (a, b) => assert.notStrictEqual(semanticKey(a), semanticKey(b),
      `${stableStringify(a)} and ${stableStringify(b)} must not share an identity`);
    distinct(-0, 0);                              // 1/-0 is -Infinity
    distinct(NaN, null);
    distinct(Infinity, null);
    distinct(Infinity, -Infinity);
    distinct({ a: 1, b: undefined }, { a: 1 });   // present-undefined vs absent
    distinct([1], [1, undefined]);
    distinct({ a: '1' }, { a: 1 });               // a string never forges a number
  });

  it('no string can forge a raw token', () => {
    // the ACTUAL token texts, not lookalikes: a test that compares a
    // near-miss passes whatever the tokens are, which is no test at all.
    // `JSON.stringify` quotes and escapes every string, so a raw token can
    // never be what a string serializes to.
    const tokens = ['\u0000undef', '\u0000nan', '\u0000+inf', '\u0000-inf',
      '\u0000big1', '-0', 'null', 'true'];
    for (const token of tokens) {
      assert.notStrictEqual(semanticKey(token), semanticKey(undefined));
      assert.notStrictEqual(semanticKey({ v: token }), semanticKey({ v: undefined }));
      assert.strictEqual(semanticKey(token), JSON.stringify(token),
        'a string always keys as quoted JSON text');
    }
    assert.notStrictEqual(semanticKey('\u0000nan'), semanticKey(NaN));
    assert.notStrictEqual(semanticKey('-0'), semanticKey(-0));
    assert.notStrictEqual(semanticKey('\u0000big1'), semanticKey(1n));
    assert.notStrictEqual(semanticKey('null'), semanticKey(null));
  });

  it('carries no literal control character into a source file', async () => {
    // the tokens are written as \\u0000 escapes: a raw NUL byte in source is
    // invisible in every editor and diff, and makes tooling treat the file
    // as binary
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../../packages/core/src/object.js', import.meta.url), 'utf8');
    assert.strictEqual(source.includes('\u0000'), false);
  });

  it('refuses what it cannot key injectively instead of folding it to {}', () => {
    const cyclic = /** @type {any} */ ({ a: 1 });
    cyclic.self = cyclic;
    for (const value of [new Date(0), new Map(), new Set(), /x/,
      () => {}, Symbol('s'), class {}, Object.assign([], { extra: 1 })]) {
      assert.throws(() => semanticKey(value), TypeError,
        `${String(value)} must be refused`);
    }
    // a cycle is refused as the circular reference it is, located
    assert.throws(() => semanticKey(cyclic), { code: 'JO2002', docPath: '/self' });
    // ...while genuinely plain data, including a null prototype, is fine
    assert.strictEqual(semanticKey(Object.assign(Object.create(null), { a: 1 })),
      semanticKey({ a: 1 }));
  });
});

describe('createSemanticCache', () => {
  it('never reuses an entry for an array with a numeric-looking extra member', () => {
    const cache = createSemanticCache(2);
    const value = Object.assign([1, 2], { '01': 'extra' });
    assert.strictEqual(cache.getOrCreate([1, 2], () => 'plain'), 'plain');
    assert.strictEqual(cache.getOrCreate(value, () => 'extra'), 'extra');
    assert.strictEqual(cache.getOrCreate(value, () => 'recomputed'), 'recomputed');
    assert.strictEqual(cache.size(), 1);
  });

  it('shares an entry across structurally equal values only', () => {
    const cache = createSemanticCache(8);
    let built = 0;
    const build = () => { built += 1; return built; };
    assert.strictEqual(cache.getOrCreate({ a: 1, b: 2 }, build), 1);
    assert.strictEqual(cache.getOrCreate({ b: 2, a: 1 }, build), 1, 'key order is not identity');
    assert.strictEqual(cache.getOrCreate(COLLIDING[0], build), 2);
    assert.strictEqual(cache.getOrCreate(COLLIDING[1], build), 3,
      'the colliding document gets its own entry');
    assert.strictEqual(cache.size(), 3);
  });

  it('treats an unkeyable value as a permanent miss, never a wrong hit', () => {
    const cache = createSemanticCache(8);
    let built = 0;
    const build = () => { built += 1; return built; };
    assert.strictEqual(cache.getOrCreate(new Date(0), build), 1);
    assert.strictEqual(cache.getOrCreate(new Date(0), build), 2, 'computed afresh');
    assert.strictEqual(cache.get(new Date(0)), undefined);
    assert.strictEqual(cache.set(new Date(0), 'x'), false, 'and never retained');
    assert.strictEqual(cache.size(), 0);
  });

  it('bounds itself and clears', () => {
    const cache = createSemanticCache(2);
    cache.set({ n: 1 }, 'a');
    cache.set({ n: 2 }, 'b');
    cache.set({ n: 3 }, 'c');
    assert.strictEqual(cache.size(), 2, 'never above the limit');
    assert.strictEqual(cache.get({ n: 1 }), undefined, 'the least recently used went');
    cache.clear();
    assert.strictEqual(cache.size(), 0);
    assert.strictEqual(cache.get({ n: 3 }), undefined);
  });

  it('keys by member order when built { ordered: true }', () => {
    const cache = createSemanticCache(8, undefined, { ordered: true });
    let built = 0;
    const build = () => { built += 1; return built; };
    assert.strictEqual(cache.getOrCreate({ $for: { m: '$.a[*]', b: '$.b[*]' } }, build), 1);
    assert.strictEqual(cache.getOrCreate({ $for: { b: '$.b[*]', m: '$.a[*]' } }, build), 2,
      'a reordered binding object is its own entry');
    assert.strictEqual(cache.getOrCreate({ $for: { m: '$.a[*]', b: '$.b[*]' } }, build), 1,
      'the same order still hits');
    assert.strictEqual(cache.get({ $for: { b: '$.b[*]', m: '$.a[*]' } }), 2);
    assert.strictEqual(cache.size(), 2);
    // and an unkeyable value is still a permanent miss
    assert.strictEqual(cache.getOrCreate(new Date(0), build), 3);
    assert.strictEqual(cache.set(new Date(0), 4), false);
  });

  it('hands an ordered cache\'s eviction hook the ordered identity', () => {
    /** @type {string[]} */
    const evicted = [];
    const cache = createSemanticCache(1, (identity) => { evicted.push(identity); }, { ordered: true });
    cache.set({ b: 1, a: 2 }, 'first');
    cache.set({ a: 2, b: 1 }, 'second');
    assert.deepStrictEqual(evicted, ['{"b":1,"a":2}']);
  });

  it('refuses a malformed option at construction, not as a silent miss per lookup', () => {
    for (const options of [{ ordered: 'yes' }, { orderd: true }, null, 'ordered', [true]]) {
      assert.throws(() => createSemanticCache(2, undefined, /** @type {any} */ (options)), TypeError,
        JSON.stringify(options));
    }
    // absent and false both mean the order-insensitive key
    for (const options of [undefined, {}, { ordered: false }]) {
      const cache = createSemanticCache(2, undefined, options);
      cache.set({ a: 1, b: 2 }, 'x');
      assert.strictEqual(cache.get({ b: 2, a: 1 }), 'x', JSON.stringify(options));
    }
  });
});

describe('semanticKey { ordered: true }', () => {
  const ordered = { ordered: true };

  it('keeps object members in enumeration order, at every depth', () => {
    const value = { a: 1, b: { x: [1, 2], y: 'z' } };
    assert.strictEqual(semanticKey(value, ordered), '{"a":1,"b":{"x":[1,2],"y":"z"}}');
    assert.strictEqual(semanticKey({ b: { y: 'z', x: [1, 2] }, a: 1 }, ordered), '{"b":{"y":"z","x":[1,2]},"a":1}');
    assert.notStrictEqual(semanticKey({ o: { x: 1, y: 2 } }, ordered), semanticKey({ o: { y: 2, x: 1 } }, ordered),
      'a nested reorder alone is a new identity');
    assert.strictEqual(semanticKey(value, ordered), semanticKey({ a: 1, b: { x: [1, 2], y: 'z' } }, ordered),
      'a fresh value in the same order is the same identity');
  });

  it('separates the binding orders the default key folds together', () => {
    const MB = { $for: { m: '$.Author[*]', b: '$.Book[*]' }, $return: { id: '$b.id', name: '$m.name' } };
    const BM = { $for: { b: '$.Book[*]', m: '$.Author[*]' }, $return: { id: '$b.id', name: '$m.name' } };
    const NI = { $for: { m: '$.Author[*]', b: '$.Book[*]' }, $return: { name: '$m.name', id: '$b.id' } };
    assert.strictEqual(semanticKey(MB), semanticKey(BM), 'the default key is order-insensitive');
    assert.strictEqual(semanticKey(MB), semanticKey(NI));
    assert.notStrictEqual(semanticKey(MB, ordered), semanticKey(BM, ordered));
    assert.notStrictEqual(semanticKey(MB, ordered), semanticKey(NI, ordered));
  });

  it('reads the order the engine reads: array-index names first, ascending', () => {
    // `Object.keys` lists index-like names before every other name, so these
    // two literals are ONE member order to every consumer of the value
    assert.strictEqual(semanticKey({ b: 1, 2: 'x', 1: 'y', a: 0 }, ordered), semanticKey({ 1: 'y', 2: 'x', b: 1, a: 0 }, ordered));
    assert.strictEqual(semanticKey({ b: 1, 2: 'x', 1: 'y', a: 0 }, ordered), '{"1":"y","2":"x","b":1,"a":0}');
  });

  it('keeps every strict distinction of the default key', () => {
    const distinct = (a, b) => assert.notStrictEqual(semanticKey(a, ordered), semanticKey(b, ordered),
      `${stableStringify(a)} and ${stableStringify(b)} must not share an ordered identity`);
    distinct(-0, 0);
    distinct(NaN, null);
    distinct(Infinity, -Infinity);
    distinct({ a: 1, b: undefined }, { a: 1 });
    distinct([1], [1, undefined]);
    distinct({ a: '1' }, { a: 1 });
    distinct(COLLIDING[0], COLLIDING[1]);
    distinct({ a: 1, b: undefined }, { b: undefined, a: 1 });
    for (const token of ['\u0000undef', '\u0000nan', '-0', 'null'])
      assert.strictEqual(semanticKey({ v: token }, ordered), `{"v":${JSON.stringify(token)}}`);
    // a value without object members keys exactly as the default does
    for (const value of [null, 1, -0, NaN, 'text', [1, [2, 'x']], 3n, undefined])
      assert.strictEqual(semanticKey(value, ordered), semanticKey(value), String(value));
  });

  it('gives 100k trivially different documents, in two member orders, 200k identities', () => {
    const seen = new Set();
    for (let i = 0; i < 100_000; i++) {
      const literal = i.toString(36);
      seen.add(semanticKey({ $for: { it: '$[*]' }, $return: literal }, ordered));
      seen.add(semanticKey({ $return: literal, $for: { it: '$[*]' } }, ordered));
    }
    assert.strictEqual(seen.size, 200_000);
  });

  it('refuses exactly what the default key refuses', () => {
    const cyclic = /** @type {any} */ ({ a: 1 });
    cyclic.self = cyclic;
    for (const value of [new Date(0), new Map(), /x/, () => {}, Symbol('s'),
      Object.assign([], { extra: 1 }), { [Symbol('k')]: 1 }, { nested: [new Set()] }]) {
      assert.throws(() => semanticKey(value, ordered), TypeError, `${String(value)} must be refused`);
    }
    assert.throws(() => semanticKey(cyclic, ordered), { code: 'JO2002', docPath: '/self' });
    assert.strictEqual(semanticKey(Object.assign(Object.create(null), { b: 1, a: 2 }), ordered), '{"b":1,"a":2}');
  });

  it('is the order-insensitive key unless asked, and refuses a malformed option', () => {
    const value = { b: { y: 1, x: 2 }, a: 1 };
    for (const options of [undefined, {}, { ordered: false }])
      assert.strictEqual(semanticKey(value, options), semanticKey(value));
    for (const options of [{ ordered: 1 }, { orderd: true }, null, 'ordered', []])
      assert.throws(() => semanticKey(value, /** @type {any} */ (options)), TypeError, JSON.stringify(options));
  });
});
