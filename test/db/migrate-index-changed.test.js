//@ts-check
/**
 * @file The planner's one index comparison: an index is rebuilt when its
 * uniqueness, its column list or its condition changes, the columns compared
 * element by element — a column name containing a comma never equals a split
 * of it — and the condition as the plan renders it.
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

  it('compares the rendered condition: added, removed and changed are rebuilds', () => {
    const index = (/** @type {string | undefined} */ where) => ({ unique: true, columns: ['a', 'b'], ...(where === undefined ? {} : { where }) });
    assert.equal(indexChanged(index(`"s" IN ('x', 'y')`), index(`"s" IN ('x', 'y')`)), false);
    assert.equal(indexChanged(index(undefined), index(`"s" = 'x'`)), true);
    assert.equal(indexChanged(index(`"s" = 'x'`), index(undefined)), true);
    assert.equal(indexChanged(index(`"s" = 'x'`), index(`"s" = 'y'`)), true);
    assert.equal(indexChanged(index(undefined), index(undefined)), false);
  });
});
