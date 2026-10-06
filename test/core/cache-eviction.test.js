//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedCache, createSemanticCache } from '@jarenjs/core/cache';
import { semanticKey } from '@jarenjs/core/object';

it('semantic capacity eviction reports the complete identity after removal, before insertion', () => {
  const first = { dialect: 'sqlite', document: { a: 1, b: 2 } };
  const second = { document: 'second' };
  const entry = { result: 'first' };
  const events = [];
  const cache = createSemanticCache(1, (identity, value) => {
    events.push([identity, value, cache.get(first), cache.get(second), cache.size()]);
  });
  cache.set(first, entry);
  cache.getOrCreate(second, () => ({ result: 'second' }));
  assert.deepEqual(events, [[semanticKey(first), entry, undefined, undefined, 0]]);
  assert.equal(events[0][1], entry, 'the owner receives its actual entry');
  assert.equal(cache.size(), 1);
});

it('semantic hits, replacements, unkeyable values and clear do not call the eviction hook', () => {
  const events = [];
  const cache = createSemanticCache(1, (identity, value) => events.push([identity, value]));
  cache.set({ a: 1, b: 2 }, 'first');
  assert.equal(cache.getOrCreate({ b: 2, a: 1 }, () => assert.fail('equal tuple rebuilt')), 'first');
  cache.set({ b: 2, a: 1 }, 'replacement');
  assert.equal(cache.set(new Date(0), 'unretained'), false);
  assert.equal(cache.getOrCreate(new Date(0), () => 'temporary'), 'temporary');
  cache.clear();
  assert.deepEqual(events, []);
  assert.equal(cache.size(), 0);
});

it('semantic eviction follows refreshed LRU order on both insertion surfaces', () => {
  const events = [];
  const cache = createSemanticCache(2, (identity, value) => events.push([identity, value]));
  cache.set(['a'], 1);
  cache.getOrCreate(['b'], () => 2);
  assert.equal(cache.get(['a']), 1);
  cache.set(['c'], 3);
  cache.getOrCreate(['d'], () => 4);
  assert.deepEqual(events, [[semanticKey(['b']), 2], [semanticKey(['a']), 1]]);
});

it('bounded replacement, explicit delete and clear retain their no-callback contract', () => {
  let calls = 0;
  const cache = createBoundedCache(1, () => { calls++; });
  cache.set('key', 1);
  cache.set('key', 2);
  assert.equal(cache.delete('key'), true);
  cache.set('key', 3);
  cache.clear();
  assert.equal(calls, 0);
});
