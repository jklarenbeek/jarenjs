//@ts-check
/**
 * @file `isUniqueDeepArray` compares the primitives of an array by `===`
 * (NaN unlike itself, `-0` like `0`) before any pair of containers, and
 * each pair of containers by `equalsDeep`, the earlier item first. An array
 * of up to 8 items is compared pairwise, with no Set and no list of its
 * containers; past 8 the primitives go through a Set.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isUniqueDeepArray } from '@jarenjs/core/object';

/**
 * The answer for `array` and how many times a Set gained a member meanwhile.
 * @param {any[]} array
 */
function uniqueAndAdds(array) {
  const add = Set.prototype.add;
  let adds = 0;
  Set.prototype.add = function countedAdd(value) {
    adds++;
    return add.call(this, value);
  };
  try {
    return { unique: isUniqueDeepArray(array), adds };
  }
  finally {
    Set.prototype.add = add;
  }
}

describe('isUniqueDeepArray on a short array', () => {
  it('compares up to 8 items, containers among them, without a Set', () => {
    assert.deepEqual(uniqueAndAdds([{}, [1], true, null, 1, '{}']), { unique: true, adds: 0 });
    assert.deepEqual(uniqueAndAdds([{}, 1, [1], 1]), { unique: false, adds: 0 });
    assert.deepEqual(uniqueAndAdds([{ a: 1 }, 'a', { a: 1 }]), { unique: false, adds: 0 });
    assert.deepEqual(uniqueAndAdds([{}, 1, 2, 3, 4, 5, 6, []]), { unique: true, adds: 0 });
  });

  it('dedupes the primitives of a longer array through a Set', () => {
    assert.deepEqual(uniqueAndAdds([1, 2, 3, 4, 5, 6, 7, 8, 9]), { unique: true, adds: 9 });
    assert.deepEqual(uniqueAndAdds([{}, 1, 2, 3, 4, 5, 6, 7, []]), { unique: true, adds: 7 });
  });
});

describe('isUniqueDeepArray answers values a JSON parse never makes', () => {
  class Point {
    /** @param {number} x */
    constructor(x) { this.x = x; }
  }
  // the same answers on both sides of the 8-item boundary (concat keeps holes)
  const both = (/** @type {any[]} */ items, /** @type {boolean} */ unique) => {
    assert.equal(isUniqueDeepArray(items), unique, 'short');
    assert.equal(isUniqueDeepArray(items.concat(['pad 1', 'pad 2', 'pad 3', 'pad 4', 'pad 5', 'pad 6', 'pad 7'])), unique, 'long');
  };
  // `count` holes, then `after`
  const holes = (/** @type {number} */ count, /** @type {any[]} */ after) => {
    const array = new Array(count);
    array.push(...after);
    return array;
  };

  it('reads NaN as unlike itself, -0 as 0, and holes as undefined', () => {
    both([NaN, NaN], true);
    both([0, -0], false);
    both([0, false], true);
    both([undefined, undefined], false);
    both(holes(2, [1]), false);
    both(holes(1, [1]), true);
    both(holes(1, [undefined]), false);
    both([1n, 1n], false);
    both([Symbol('a'), Symbol('a')], true);
  });

  it('compares containers by their kind and content', () => {
    both([new Date(1), new Date(1)], false);
    both([new Date(1), new Date(2)], true);
    both([/a/g, /a/g], false);
    both([new Map([[1, 2]]), new Map([[1, 2]])], false);
    both([new Map([[1, 2]]), new Map([[1, 3]])], true);
    both([new Set([1]), new Set([1])], false);
    both([Object.create(null), Object.create(null)], false);
    both([new Point(1), new Point(1)], false);
    both([new Point(1), { x: 1 }], true);
    both([new Uint8Array([1]), new Uint8Array([1])], false);
    both([new Uint8Array([1]), new Uint8Array([2])], true);
    both([{ a: NaN }, { a: NaN }], true);
    both([{ get a() { return 1; } }, { a: 1 }], false);
    both([function f() { return 1; }, function f() { return 1; }], false);
    both([function f() { return 1; }, function f() { return 2; }], true);
  });

  it('never compares a primitive with a container', () => {
    both([new String('a'), 'a'], true);
    both(['a', new String('a')], true);
    both([new Number(1), 1], true);
  });

  it('compares each pair of containers the earlier item first', () => {
    for (const pad of [[], ['pad 1', 'pad 2', 'pad 3', 'pad 4', 'pad 5', 'pad 6', 'pad 7']]) {
      /** @type {string[]} */
      const log = [];
      const item = (/** @type {string} */ name) => ({ get x() { log.push(name); return 1; } });
      assert.equal(isUniqueDeepArray([item('first'), ...pad, item('second')]), false);
      assert.deepEqual(log, ['first', 'second']);
    }
  });

  it('finds a repeated primitive before reading any container', () => {
    const reads = () => ({ get a() { throw new Error('read'); } });
    both([reads(), reads(), 1, 1], false);
    assert.throws(() => isUniqueDeepArray([reads(), reads()]), /read/);
  });
});
