import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import { orient2d, orient2dFast } from '@jarenjs/core/geo';

describe('orient2d', () => {
  it('should report the side of the line a point falls on', () => {
    assert.ok(orient2d(0, 0, 1, 0, 0, 1) > 0, 'left of the +x axis is counter-clockwise');
    assert.ok(orient2d(0, 0, 1, 0, 0, -1) < 0, 'right of it is clockwise');
    assert.strictEqual(orient2d(0, 0, 2, 2, 1, 1), 0, 'exactly collinear is exactly zero');
    assert.strictEqual(orient2d(0, 0, 2, 0, 5, 0), 0, 'beyond the segment is still collinear');
  });

  it('should be antisymmetric under a swap', () => {
    // a valid orientation predicate flips sign when two points swap;
    // this needs no oracle, so a failure is proof of brokenness
    const pts = [
      [0, 0, 1, 0, 0, 1],
      [4.9041, 52.3676, 2.3522, 48.8566, 13.405, 52.52],
      [-122.4194, 37.7749, -118.2437, 34.0522, -120, 36],
    ];
    for (const [ax, ay, bx, by, cx, cy] of pts) {
      assert.strictEqual(
        Math.sign(orient2d(ax, ay, bx, by, cx, cy)),
        -Math.sign(orient2d(ax, ay, cx, cy, bx, by)),
        `${ax},${ay} ${bx},${by} ${cx},${cy}`);
    }
  });

  it('should agree under rotation of the triple', () => {
    // orient(a,b,c) == orient(b,c,a) == orient(c,a,b)
    const a = [4.9041, 52.3676], b = [2.3522, 48.8566], c = [13.405, 52.52];
    const s1 = Math.sign(orient2d(a[0], a[1], b[0], b[1], c[0], c[1]));
    const s2 = Math.sign(orient2d(b[0], b[1], c[0], c[1], a[0], a[1]));
    const s3 = Math.sign(orient2d(c[0], c[1], a[0], a[1], b[0], b[1]));
    assert.strictEqual(s1, s2);
    assert.strictEqual(s2, s3);
    assert.notStrictEqual(s1, 0);
  });

  it('should get the sign right where the naive form does not', () => {
    // These are real longitude/latitude coordinates on the San Francisco
    // to Los Angeles line, found by scanning near-collinear points at ULP
    // spacing. The naive determinant cancels to exactly 0 — reporting
    // "collinear" — where the true answer is definitively one side.
    // A hull would drop the vertex and a containment test would sit on a
    // boundary it is not on.
    const ax = -122.4194, ay = 37.7749, bx = -118.2437, by = 34.0522;
    const cases = [
      [-122.00182999999981, 37.40262999999984, 1],
      [-121.27108250000003, 36.75115750000003, -1],
      [-120.95790500000011, 36.4719550000001, 1],
      [-120.85351249999985, 36.37888749999987, -1],
      [-120.54033499999993, 36.09968499999994, 1],
    ];
    let naiveWrong = 0;
    for (const [cx, cy, expected] of cases) {
      assert.strictEqual(Math.sign(orient2d(ax, ay, bx, by, cx, cy)), expected,
        `exact orientation at ${cx},${cy}`);
      if (Math.sign(orient2dFast(ax, ay, bx, by, cx, cy)) !== expected)
        naiveWrong++;
    }
    assert.strictEqual(naiveWrong, cases.length,
      'every fixture must be a case the naive form actually gets wrong, '
      + 'or it is not testing the exact path');
  });

  it('should stay exact across magnitudes', () => {
    // the same shape at wildly different scales must give the same sign
    for (const s of [1e-8, 1, 1e3, 1e7]) {
      assert.ok(orient2d(0, 0, s, 0, 0, s) > 0, `scale ${s}`);
      assert.ok(orient2d(0, 0, s, 0, 0, -s) < 0, `scale ${s}`);
      assert.strictEqual(orient2d(0, 0, s, s, s / 2, s / 2), 0, `scale ${s}`);
    }
  });

  it('should reach the exact expansion path and still answer 0', () => {
    // Collinear triples built from inexact decimals: the coordinate
    // differences carry non-zero tails, so the cheap stages cannot
    // settle the sign and the full expansion arithmetic runs. These are
    // the inputs that exercise it — without them the exact path is
    // dead code that has never been proven to work.
    const cases = [
      [[0.3, 0.3], [0.6, 0.6], [0.8999999999999999, 0.8999999999999999]],
      [[0.1, 0.1], [0.30000000000000004, 0.30000000000000004], [0.4, 0.4]],
      [[0.1, 0.1], [0.4, 0.4], [0.5, 0.5]],
    ];
    for (const [a, b, c] of cases) {
      assert.strictEqual(orient2d(a[0], a[1], b[0], b[1], c[0], c[1]), 0,
        `${JSON.stringify(a)} ${JSON.stringify(b)} ${JSON.stringify(c)} lie on y = x`);
      // and the sign stays antisymmetric even at the deepest stage
      assert.strictEqual(orient2d(a[0], a[1], c[0], c[1], b[0], b[1]), 0);
    }
  });

  it('should keep the fast form available but honest', () => {
    // it agrees on well-conditioned input, which is all it is for
    assert.ok(orient2dFast(0, 0, 1, 0, 0, 1) > 0);
    assert.ok(orient2dFast(0, 0, 1, 0, 0, -1) < 0);
    assert.strictEqual(Math.sign(orient2dFast(0, 0, 1, 0, 2, 2)),
      Math.sign(orient2d(0, 0, 1, 0, 2, 2)));
  });
});
