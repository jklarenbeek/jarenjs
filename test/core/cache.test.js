//@ts-check
/**
 * @file The bounded-cache primitive's contract: LRU with recency
 * refresh, eviction at `size >= limit` before inserting a new key
 * (never above `limit`), `undefined` as the miss sentinel, and the
 * weak identity axis. These semantics replaced five FIFO copies and a
 * flush-all variant — the policy is pinned here so the next cache is a
 * caller, not a seventh implementation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createBoundedCache, createWeakCache } from '@jarenjs/core/cache';

describe('createBoundedCache', () => {
  it('holds at most `limit` entries', () => {
    const cache = createBoundedCache(3);
    for (const k of ['a', 'b', 'c', 'd']) cache.set(k, k.toUpperCase());
    assert.strictEqual(cache.size(), 3);
    assert.strictEqual(cache.get('a'), undefined);
    assert.strictEqual(cache.get('d'), 'D');
  });

  it('evicts the least recently USED, not the oldest inserted', () => {
    const cache = createBoundedCache(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.get('a');       // refresh: 'b' is now the coldest
    cache.set('d', 4);
    assert.strictEqual(cache.get('b'), undefined);
    assert.strictEqual(cache.get('a'), 1);
  });

  it('re-setting an existing key refreshes without evicting', () => {
    const cache = createBoundedCache(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10);   // refresh, not a new entry
    assert.strictEqual(cache.size(), 2);
    assert.strictEqual(cache.get('b'), 2);
    assert.strictEqual(cache.get('a'), 10);
  });

  it('getOrCreate computes once and caches negative (null) results', () => {
    const cache = createBoundedCache(4);
    let calls = 0;
    const create = () => { calls++; return null; };
    assert.strictEqual(cache.getOrCreate('k', create), null);
    assert.strictEqual(cache.getOrCreate('k', create), null);
    assert.strictEqual(calls, 1, 'null is a real entry, not a miss');
  });

  it('clear drops everything', () => {
    const cache = createBoundedCache(2);
    cache.set('a', 1);
    cache.clear();
    assert.strictEqual(cache.size(), 0);
    assert.strictEqual(cache.get('a'), undefined);
  });
});

describe('createWeakCache', () => {
  it('caches by identity and computes once per key', () => {
    const cache = createWeakCache();
    const key = {};
    let calls = 0;
    const value = cache.getOrCreate(key, () => { calls++; return { v: 1 }; });
    assert.strictEqual(cache.getOrCreate(key, () => { calls++; return { v: 2 }; }), value);
    assert.strictEqual(calls, 1);
    assert.strictEqual(cache.get({}), undefined);
  });

  it('set installs and overwrites by identity', () => {
    const cache = createWeakCache();
    const key = {};
    cache.set(key, 'a');
    assert.strictEqual(cache.get(key), 'a');
    cache.set(key, 'b');
    assert.strictEqual(cache.get(key), 'b');
  });
});
