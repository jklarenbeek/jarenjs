import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  haversineDistance, equirectDistance, initialBearing, destinationPoint, lineLength,
  EARTH_RADIUS,
  isRingClosed, ringWinding, ringSignedArea, sphericalRingArea,
  pointInRing, pointInPolygon,
  bboxOfPositions, bboxIntersects, bboxContains, bboxUnion,
} from '@jarenjs/core/geo';

const AMS = [4.9041, 52.3676];
const PAR = [2.3522, 48.8566];
const SYD = [151.2093, -33.8688];

// within a relative tolerance, for values with a published reference
const near = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) / expected < tol,
    `${what}: ${actual} is not within ${tol * 100}% of ${expected}`);

describe('geodesic distance', () => {
  it('should match published great-circle distances', () => {
    near(haversineDistance(...AMS, ...PAR), 430000, 0.01, 'Amsterdam-Paris');
    near(haversineDistance(...AMS, ...SYD), 16650000, 0.01, 'Amsterdam-Sydney');
    assert.strictEqual(haversineDistance(...AMS, ...AMS), 0, 'a point is zero from itself');
  });

  it('should be symmetric and scale with the radius', () => {
    assert.strictEqual(haversineDistance(...AMS, ...PAR), haversineDistance(...PAR, ...AMS));
    // asking in kilometres is the same answer divided through
    const m = haversineDistance(...AMS, ...PAR);
    const km = haversineDistance(...AMS, ...PAR, EARTH_RADIUS / 1000);
    near(km, m / 1000, 1e-12, 'radius scaling');
  });

  it('should place the equirectangular form as a screening test only', () => {
    // close in: indistinguishable, and that is the point — it screens
    const short = haversineDistance(4.9041, 52.3676, 4.9187, 52.3676);
    near(equirectDistance(4.9041, 52.3676, 4.9187, 52.3676), short, 0.001, '1 km');
    // far out: visibly wrong, which is why it must not be reported
    const far = haversineDistance(...AMS, ...SYD);
    assert.ok(Math.abs(equirectDistance(...AMS, ...SYD) - far) / far > 0.05,
      'the approximation should be visibly wrong at hemisphere scale');
  });

  it('should refuse the planar mistake it exists to prevent', () => {
    // a degree of longitude is not a fixed distance: at 52°N the naive
    // planar norm on raw degrees is wrong by more than half
    const real = haversineDistance(4.9041, 52.3676, 4.9187, 52.3676);
    const planar = Math.hypot(4.9187 - 4.9041, 0) * 111320;
    assert.ok(planar / real > 1.5,
      `planar degrees overstate this 1 km by ${(planar / real).toFixed(2)}x`);
  });

  it('should compute bearings and travel along them', () => {
    assert.strictEqual(Math.round(initialBearing(0, 0, 0, 10)), 0, 'due north');
    assert.strictEqual(Math.round(initialBearing(0, 0, 10, 0)), 90, 'due east');
    assert.strictEqual(Math.round(initialBearing(0, 10, 0, 0)), 180, 'due south');
    assert.strictEqual(Math.round(initialBearing(10, 0, 0, 0)), 270, 'due west');
    // travelling a distance along a bearing lands that distance away
    const dest = destinationPoint(4.9041, 52.3676, 135, 250000);
    near(haversineDistance(4.9041, 52.3676, ...dest), 250000, 1e-6, 'round trip');
    near(initialBearing(4.9041, 52.3676, ...dest), 135, 1e-6, 'round-trip bearing');
  });

  it('should sum a line and handle degenerate ones', () => {
    near(lineLength([AMS, PAR]), haversineDistance(...AMS, ...PAR), 1e-12, 'two points');
    near(lineLength([AMS, PAR, AMS]), 2 * haversineDistance(...AMS, ...PAR), 1e-12, 'there and back');
    assert.strictEqual(lineLength([]), 0);
    assert.strictEqual(lineLength([AMS]), 0);
  });
});

describe('rings', () => {
  const CCW = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
  const CW = [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]];

  it('should detect closure, the invariant JSON Schema cannot express', () => {
    assert.strictEqual(isRingClosed(CCW), true);
    assert.strictEqual(isRingClosed([[0, 0], [1, 0], [1, 1], [0, 1]]), false);
    assert.strictEqual(isRingClosed([[0, 0]]), false);
    // a third element (altitude) need not match for the ring to close
    assert.strictEqual(isRingClosed([[0, 0, 5], [1, 0, 5], [0, 0, 9]]), true);
  });

  it('should report winding, the other invariant', () => {
    assert.strictEqual(ringWinding(CCW), 1, 'RFC 7946 exterior rings');
    assert.strictEqual(ringWinding(CW), -1, 'RFC 7946 holes');
    assert.strictEqual(ringWinding([[0, 0], [1, 1], [2, 2], [0, 0]]), 0, 'degenerate');
    assert.strictEqual(ringSignedArea(CCW), 2, 'twice the unit square');
    assert.strictEqual(ringSignedArea(CW), -2, 'sign follows the winding');
  });

  it('should measure real area on the sphere', () => {
    // one degree square at the equator is about 12,360 km2
    near(sphericalRingArea(CCW) / 1e6, 12360, 0.01, '1 degree square at the equator');
    // the same square of degrees is much smaller at high latitude
    const north = [[0, 60], [1, 60], [1, 61], [0, 61], [0, 60]];
    assert.ok(sphericalRingArea(north) < sphericalRingArea(CCW) * 0.6,
      'a degree square shrinks towards the pole');
    // and it never reports a negative area, whichever way the ring winds
    assert.strictEqual(sphericalRingArea(CCW), sphericalRingArea(CW));
    assert.strictEqual(sphericalRingArea([[0, 0], [1, 1]]), 0, 'too few positions');
  });

  it('should test containment, counting the boundary as inside', () => {
    assert.strictEqual(pointInRing(0.5, 0.5, CCW), true);
    assert.strictEqual(pointInRing(2, 2, CCW), false);
    assert.strictEqual(pointInRing(0, 0.5, CCW), true, 'on an edge');
    assert.strictEqual(pointInRing(0, 0, CCW), true, 'on a vertex');
    // winding must not change the answer
    assert.strictEqual(pointInRing(0.5, 0.5, CW), true);
    assert.strictEqual(pointInRing(-0.5, 0.5, CW), false);
  });

  it('should exclude holes', () => {
    const donut = [
      [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
      [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]],
    ];
    assert.strictEqual(pointInPolygon(0.5, 0.5, donut), true, 'in the ring');
    assert.strictEqual(pointInPolygon(2, 2, donut), false, 'in the hole');
    assert.strictEqual(pointInPolygon(5, 5, donut), false, 'outside');
    assert.strictEqual(pointInPolygon(0, 0, []), false, 'no rings contains nothing');
  });

  it('should handle a concave ring, where a convex test would fail', () => {
    // an L shape: the bounding box contains the notch, the ring does not
    const ell = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3], [0, 0]];
    assert.strictEqual(pointInRing(0.5, 2.5, ell), true, 'in the tall arm');
    assert.strictEqual(pointInRing(2.5, 0.5, ell), true, 'in the wide arm');
    assert.strictEqual(pointInRing(2.5, 2.5, ell), false, 'in the notch');
  });
});

describe('bounding boxes', () => {
  it('should bound positions in GeoJSON bbox order', () => {
    assert.deepStrictEqual(bboxOfPositions([[1, 2], [5, 0], [3, 9]]), [1, 0, 5, 9]);
    assert.deepStrictEqual(bboxOfPositions([[1, 2]]), [1, 2, 1, 2], 'a point is a degenerate box');
    assert.strictEqual(bboxOfPositions([]), null, 'nothing has no bounding box');
  });

  it('should test overlap and containment with the boundary included', () => {
    assert.strictEqual(bboxIntersects([0, 0, 2, 2], [1, 1, 3, 3]), true);
    assert.strictEqual(bboxIntersects([0, 0, 1, 1], [2, 2, 3, 3]), false);
    assert.strictEqual(bboxIntersects([0, 0, 1, 1], [1, 1, 2, 2]), true, 'touching corners');
    assert.strictEqual(bboxContains([0, 0, 2, 2], 1, 1), true);
    assert.strictEqual(bboxContains([0, 0, 2, 2], 0, 2), true, 'on the edge');
    assert.strictEqual(bboxContains([0, 0, 2, 2], 3, 1), false);
  });

  it('should union boxes', () => {
    assert.deepStrictEqual(bboxUnion([0, 0, 1, 1], [2, 2, 3, 3]), [0, 0, 3, 3]);
    assert.deepStrictEqual(bboxUnion([0, 0, 5, 5], [1, 1, 2, 2]), [0, 0, 5, 5]);
  });
});
