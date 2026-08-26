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
    for (const value of [new Date(0), new Map(), new Set(), /x/, cyclic,
      () => {}, Symbol('s'), class {}, Object.assign([], { extra: 1 })]) {
      assert.throws(() => semanticKey(value), TypeError,
        `${String(value)} must be refused`);
    }
    // ...while genuinely plain data, including a null prototype, is fine
    assert.strictEqual(semanticKey(Object.assign(Object.create(null), { a: 1 })),
      semanticKey({ a: 1 }));
  });
});

describe('createSemanticCache', () => {
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
});
