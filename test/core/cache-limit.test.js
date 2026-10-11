//@ts-check
/**
 * @file The bounded cache's limit edges: a limit under 1 retains nothing
 * (every entry goes straight to `onEvict`) instead of throwing "undefined is
 * not iterable" on the first `set`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createBoundedCache, createSemanticCache } from '@jarenjs/core/cache';

describe('createBoundedCache — limit under 1', () => {
  it('retains nothing and hands each entry to onEvict', () => {
    const released = [];
    const cache = createBoundedCache(0, (key, value) => released.push([key, value]));
    cache.set('a', 1);
    cache.set('b', 2);
    assert.strictEqual(cache.size(), 0);
    assert.strictEqual(cache.get('a'), undefined);
    assert.deepStrictEqual(released, [['a', 1], ['b', 2]]);
  });

  it('answers getOrCreate with the value it built each time', () => {
    const cache = createBoundedCache(-3);
    let built = 0;
    assert.strictEqual(cache.getOrCreate('k', () => ++built), 1);
    assert.strictEqual(cache.getOrCreate('k', () => ++built), 2);
    assert.strictEqual(cache.size(), 0);
  });

  it('works for a semantic cache too', () => {
    const cache = createSemanticCache(0);
    assert.strictEqual(cache.getOrCreate({ a: 1 }, () => 'x'), 'x');
    assert.strictEqual(cache.size(), 0);
  });
});

describe('createBoundedCache — limit kinds', () => {
  it('keeps an Infinity limit unbounded and a positive limit bounded', () => {
    const open = createBoundedCache(Infinity);
    for (let i = 0; i < 1000; i++) open.set(i, i);
    assert.strictEqual(open.size(), 1000);
    const bounded = createBoundedCache(2);
    for (let i = 0; i < 5; i++) bounded.set(i, i);
    assert.strictEqual(bounded.size(), 2);
  });
});
