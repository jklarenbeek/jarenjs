//@ts-check
/**
 * @file A position on a ring's boundary is inside it, on every edge and
 * every vertex. The containment test used a half-open bounding box for the
 * "within this edge" check, so the left and bottom edges counted and the
 * right and top edges, and three of the four corners of a square, did not.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pointInRing, pointInPolygon } from '@jarenjs/core/geo';

const SQUARE = [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]];

describe('pointInRing - the whole boundary is inside', () => {
  it('counts the middle of every edge of a square', () => {
    assert.strictEqual(pointInRing(1, 0, SQUARE), true, 'bottom');
    assert.strictEqual(pointInRing(2, 1, SQUARE), true, 'right');
    assert.strictEqual(pointInRing(1, 2, SQUARE), true, 'top');
    assert.strictEqual(pointInRing(0, 1, SQUARE), true, 'left');
  });

  it('counts every vertex of a square', () => {
    for (const [x, y] of [[0, 0], [2, 0], [2, 2], [0, 2]])
      assert.strictEqual(pointInRing(x, y, SQUARE), true, `corner ${x},${y}`);
  });

  it('counts a point on a slanted edge and on a reversed ring alike', () => {
    const triangle = [[0, 0], [4, 0], [0, 4], [0, 0]];
    assert.strictEqual(pointInRing(2, 2, triangle), true, 'on the hypotenuse');
    assert.strictEqual(pointInRing(4, 0, triangle), true, 'at the far vertex');
    assert.strictEqual(pointInRing(2, 1, [...SQUARE].reverse()), true);
    assert.strictEqual(pointInRing(2, 1, [...triangle].reverse()), true);
  });

  it('still excludes what lies off the boundary, collinear points included', () => {
    assert.strictEqual(pointInRing(3, 1, SQUARE), false);
    assert.strictEqual(pointInRing(3, 0, SQUARE), false, 'on the line of the bottom edge');
    assert.strictEqual(pointInRing(2, 3, SQUARE), false, 'on the line of the right edge');
    assert.strictEqual(pointInRing(-1, 2, SQUARE), false, 'on the line of the top edge');
    assert.strictEqual(pointInRing(1, 1, SQUARE), true);
  });

  it('keeps a polygon with a hole away from its outer edge', () => {
    const donut = [SQUARE, [[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5], [0.5, 0.5]]];
    assert.strictEqual(pointInPolygon(2, 1, donut), true);
    assert.strictEqual(pointInPolygon(1, 1, donut), false, 'in the hole');
  });

  it('counts the whole boundary of a hole as inside the polygon, its interior as outside', () => {
    const hole = [[3, 3], [6, 3], [6, 6], [3, 6], [3, 3]];
    const polygon = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], hole];
    for (const [x, y] of [[4, 3], [6, 4], [4, 6], [3, 4], [3, 3], [6, 3], [6, 6], [3, 6]])
      assert.strictEqual(pointInPolygon(x, y, polygon), true, `hole boundary ${x},${y}`);
    assert.strictEqual(pointInPolygon(4, 4, polygon), false, 'strictly inside the hole');
    assert.strictEqual(pointInPolygon(7, 7, polygon), true);
    assert.strictEqual(pointInPolygon(10, 5, polygon), true, 'outer right edge');
    assert.strictEqual(pointInPolygon(11, 5, polygon), false);
  });
});
