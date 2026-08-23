import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  haversineDistance, equirectDistance, initialBearing, destinationPoint, lineLength,
  circleBounds, EARTH_RADIUS,
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

  // A non-finite coordinate compares false against everything, so the
  // narrowing loop leaves it out of the box entirely: the answer is a
  // plausible, finite box that does not bound the input it was given.
  // A box index and a conservative pre-filter are both built on this,
  // and a pre-filter whose box is too small drops matching rows.
  it('should refuse a box rather than return one that does not bound its input', () => {
    assert.strictEqual(bboxOfPositions([[NaN, 0]]), null, 'a lone non-finite position has no box');
    assert.strictEqual(bboxOfPositions([[NaN, 0], [5, 5]]), null,
      'the dangerous case: [5,0,5,5] is finite, plausible, and does not contain [NaN,0]');
    assert.strictEqual(bboxOfPositions([[0, Infinity]]), null, 'infinite is non-finite too');
    assert.strictEqual(bboxOfPositions([[1, 2], [-Infinity, 3]]), null);
    assert.deepStrictEqual(bboxOfPositions([[1, 2], [5, 0], [3, 9]]), [1, 0, 5, 9],
      'every finite case is unchanged');
  });

  it('should union boxes', () => {
    assert.deepStrictEqual(bboxUnion([0, 0, 1, 1], [2, 2, 3, 3]), [0, 0, 3, 3]);
    assert.deepStrictEqual(bboxUnion([0, 0, 5, 5], [1, 1, 2, 2]), [0, 0, 5, 5]);
  });
});

describe('the bounding box of a geodesic circle', () => {
  // The property that matters, and the one a pushdown pre-filter rests
  // on: every position the exact distance test would KEEP lies inside
  // the box. The oracle is `haversineDistance` — the same function
  // `$distance` answers with — never a second bearing walk, because two
  // roundings of the same real number disagree in the last bits and it
  // is the distance test, not the walk, that decides a row's fate.
  const noFalseNegatives = (lon, lat, metres) => {
    const box = circleBounds(lon, lat, metres);
    assert.ok(box !== null, `no box for ${lon},${lat} r=${metres}`);
    let kept = 0;
    const check = (plon, plat) => {
      if (haversineDistance(lon, lat, plon, plat) > metres) return;
      kept++;
      assert.ok(plon >= box[0] && plon <= box[2] && plat >= box[1] && plat <= box[3],
        `[${plon}, ${plat}] is within ${metres} m but outside [${box.join(', ')}]`);
    };
    // the boundary, where a too-small box would show first
    for (let bearing = 0; bearing < 360; bearing += 0.05) {
      const [plon, plat] = destinationPoint(lon, lat, bearing, metres);
      check(plon, plat);
    }
    // and the interior, on a grid a little wider than the box
    const padLon = (box[2] - box[0]) * 0.1;
    const padLat = (box[3] - box[1]) * 0.1;
    for (let i = 0; i <= 40; i++) {
      for (let j = 0; j <= 40; j++) {
        check(box[0] - padLon + ((box[2] - box[0] + 2 * padLon) * i) / 40,
          box[1] - padLat + ((box[3] - box[1] + 2 * padLat) * j) / 40);
      }
    }
    assert.ok(kept > 1000, `only ${kept} sampled positions were inside the circle`);
  };

  it('should contain every position the exact distance test keeps', () => {
    noFalseNegatives(5, 52, 1000);
    noFalseNegatives(5, 52, 100_000);
    noFalseNegatives(0, 0, 100_000);
    noFalseNegatives(5, 80, 100_000);
    noFalseNegatives(0, -45, 500_000);
    noFalseNegatives(123.4, -33.8, 25_000);
  });

  // the reason this function exists rather than four destinationPoint
  // calls: the circle's extreme meridian is NOT its due-east point
  it('should be wider than the four-bearing box a caller would write by hand', () => {
    const box = circleBounds(5, 80, 100_000);
    const east = destinationPoint(5, 80, 90, 100_000)[0];
    assert.ok(box[2] > east,
      `the tangent meridian ${box[2]} must lie east of the 90°-bearing point ${east}`);
    // and the latitude bounds ARE the two bearings, exactly
    assert.strictEqual(box[3], 80 + (100_000 / EARTH_RADIUS) * (180 / Math.PI));
  });

  it('should refuse a box when the circle reaches a pole', () => {
    assert.strictEqual(circleBounds(0, 89, 200_000), null, 'over the north pole');
    assert.strictEqual(circleBounds(0, -89, 200_000), null, 'over the south pole');
    assert.strictEqual(circleBounds(0, 0, 20_000_000), null, 'larger than the sphere');
  });

  it('should report an antimeridian span unwrapped, so a caller can see it', () => {
    const box = circleBounds(179.9, 0, 50_000);
    assert.ok(box !== null);
    assert.ok(box[2] > 180, `east ${box[2]} stays above 180 rather than wrapping`);
    const west = circleBounds(-179.9, 0, 50_000);
    assert.ok(west !== null && west[0] < -180, 'and below -180 on the other side');
  });

  it('should refuse a non-finite or negative input', () => {
    assert.strictEqual(circleBounds(NaN, 52, 1000), null);
    assert.strictEqual(circleBounds(5, Infinity, 1000), null);
    assert.strictEqual(circleBounds(5, 52, NaN), null);
    assert.strictEqual(circleBounds(5, 52, -1), null);
    assert.deepStrictEqual(circleBounds(5, 52, 0), [5, 52, 5, 52], 'a zero radius is the point');
  });
});
