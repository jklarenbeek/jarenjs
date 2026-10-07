//@ts-check
/**
 * @file The planner's one index comparison: an index is rebuilt when its
 * uniqueness or its column list changes, the columns compared element by
 * element — a column name containing a comma never equals a split of it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { indexChanged } from '../../packages/db/src/migrate.js';

describe('indexChanged', () => {
  it('compares uniqueness and the column list element-wise', () => {
    const index = (/** @type {string[]} */ columns, unique = false) => ({ unique, columns });
    assert.equal(indexChanged(index(['a', 'b']), index(['a', 'b'])), false);
    assert.equal(indexChanged(index(['a,b']), index(['a', 'b'])), true);
    assert.equal(indexChanged(index(['a', 'b']), index(['a,b'])), true);
    assert.equal(indexChanged(index(['b', 'a']), index(['a', 'b'])), true);
    assert.equal(indexChanged(index(['a']), index(['a', 'b'])), true);
    assert.equal(indexChanged(index(['a'], true), index(['a'])), true);
    assert.equal(indexChanged(index([]), index([])), false);
  });
});
