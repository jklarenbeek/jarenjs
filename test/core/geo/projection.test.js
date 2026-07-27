import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  projectMercator, unprojectMercator, fitMercator, MERCATOR_MAX_LAT,
  simplifyLine, simplifyRing,
} from '@jarenjs/core/geo';

const AMS = [4.9041, 52.3676];

// The EPSG:3857 half-extent in metres: the unit square's width. Used to
// check the projection against published projected coordinates rather
// than against itself.
const HALF_EXTENT = 20037508.342789244;

const near = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) <= tol,
    `${what}: ${actual} is not within ${tol} of ${expected}`);

describe('Web Mercator', () => {
  it('should put null island at the centre and the limits at the corners', () => {
    assert.deepStrictEqual(projectMercator(0, 0), [0.5, 0.5]);
    assert.deepStrictEqual(projectMercator(-180, MERCATOR_MAX_LAT), [0, 0]);
    assert.deepStrictEqual(projectMercator(180, -MERCATOR_MAX_LAT), [1, 1]);
  });

  it('should match published EPSG:3857 coordinates', () => {
    // Amsterdam in EPSG:3857 is (545921.91, 6866867.12) — the value a
    // tile server, PostGIS ST_Transform or proj4 all agree on.
    const [x, y] = projectMercator(...AMS);
    near((x - 0.5) * 2 * HALF_EXTENT, 545921.91, 0.01, 'easting');
    near((0.5 - y) * 2 * HALF_EXTENT, 6866867.12, 0.01, 'northing');
  });

  it('should agree with the independent tangent formulation', () => {
    // y = 0.5 - ln(tan(pi/4 + lat/2)) / 2pi is the same projection
    // written a different way; agreeing to a rounding error is evidence
    // the log-of-a-ratio spelling did not introduce an error of its own.
    for (const lat of [-80, -45, -1e-9, 0, 12.5, 52.3676, 79.9]) {
      const [, y] = projectMercator(0, lat);
      const viaTan = 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) / (2 * Math.PI);
      near(y, viaTan, 1e-15, `lat ${lat}`);
    }
  });

  it('should round-trip through unprojectMercator', () => {
    for (const position of [AMS, [0, 0], [-179.5, -60], [151.2093, -33.8688], [180, 85]]) {
      const [lon, lat] = unprojectMercator(...projectMercator(...position));
      near(lon, position[0], 1e-9, 'longitude');
      near(lat, position[1], 1e-9, 'latitude');
    }
  });

  it('should grow y southward, monotonically', () => {
    let previous = -1;
    for (let lat = 84; lat >= -84; lat -= 4) {
      const [, y] = projectMercator(0, lat);
      assert.ok(y > previous, `y should increase as latitude falls (at ${lat})`);
      previous = y;
    }
  });

  it('should clamp beyond the Mercator limit rather than run to infinity', () => {
    assert.deepStrictEqual(projectMercator(0, 89), projectMercator(0, MERCATOR_MAX_LAT));
    assert.deepStrictEqual(projectMercator(0, -90), projectMercator(0, -MERCATOR_MAX_LAT));
    for (const lat of [90, -90, 1e6]) {
      const [, y] = projectMercator(0, lat);
      assert.ok(Number.isFinite(y), `y should stay finite at latitude ${lat}`);
    }
  });
});

describe('fitMercator', () => {
  it('should fill the longer axis and centre the shorter', () => {
    // A box wider than it is tall, fitted to a square frame: the
    // horizontal axis fills it and the vertical is centred, so the two
    // halves of the padding must be equal and the shape undistorted.
    const fit = fitMercator([-20, -10, 20, 10], 1);
    const [wx, wy] = fit(-20, 0);
    const [ex] = fit(20, 0);
    const [, ny] = fit(0, 10);
    const [, sy] = fit(0, -10);
    near(wx, 0, 1e-12, 'west edge');
    near(ex, 1, 1e-12, 'east edge');
    near(wy, 0.5, 1e-12, 'the centre latitude sits mid-frame');
    near(ny, 1 - sy, 1e-12, 'padding is equal top and bottom');
    assert.ok(ny > 0, 'the shorter axis should be inset, not stretched');
  });

  it('should preserve the projected aspect ratio in any frame', () => {
    // The contract that makes a map look right: whatever the frame's
    // shape, the drawn width:height must equal the *projected*
    // width:height. Note that is not the width:height in degrees —
    // Mercator stretches latitude, so a 40 x 20 degree box is not 2:1.
    const bbox = [-20, -10, 20, 10];
    const [px0, py1] = projectMercator(bbox[0], bbox[1]);
    const [px1, py0] = projectMercator(bbox[2], bbox[3]);
    const projected = (px1 - px0) / (py1 - py0);

    for (const aspect of [0.5, 1, 1.6, 2, 4]) {
      const fit = fitMercator(bbox, aspect);
      const [wx, sy] = fit(bbox[0], bbox[1]);
      const [ex, ny] = fit(bbox[2], bbox[3]);
      // u was divided by the aspect to reach [0,1], so multiply it back
      // to compare shapes in frame units
      near(((ex - wx) * aspect) / (sy - ny), projected, 1e-12, `aspect ${aspect}`);
      near(wx, 1 - ex, 1e-12, `aspect ${aspect}: centred horizontally`);
      near(ny, 1 - sy, 1e-12, `aspect ${aspect}: centred vertically`);
      assert.ok(Math.min(wx, ny) < 1e-12,
        `aspect ${aspect}: one axis should fill the frame, not both be inset`);
    }
  });

  it('should keep everything inside the unit square', () => {
    const bbox = [3, 50, 7, 54];
    const fit = fitMercator(bbox, 1.6);
    for (const [lon, lat] of [[3, 50], [7, 54], [5, 52], [3, 54], [7, 50]]) {
      const [u, v] = fit(lon, lat);
      assert.ok(u >= 0 && u <= 1, `u ${u} out of range`);
      assert.ok(v >= 0 && v <= 1, `v ${v} out of range`);
    }
  });

  it('should centre a degenerate box instead of dividing by zero', () => {
    for (const bbox of [[5, 52, 5, 52], [0, 0, 0, 0]]) {
      const fit = fitMercator(bbox, 1.6);
      assert.deepStrictEqual(fit(5, 52), [0.5, 0.5]);
    }
    // a box with extent in one axis only still scales by that axis
    const line = fitMercator([0, 52, 10, 52], 1);
    const [u, v] = line(10, 52);
    assert.ok(Number.isFinite(u) && Number.isFinite(v), 'a zero-height box should still project');
    near(u, 1, 1e-12, 'the extent axis fills the frame');
  });
});

describe('line simplification', () => {
  it('should collapse a near-straight run to its endpoints', () => {
    const line = [[0, 0], [1, 0.001], [2, -0.001], [3, 0]];
    assert.deepStrictEqual(simplifyLine(line, 0.01), [[0, 0], [3, 0]]);
  });

  it('should keep the vertices that carry the shape', () => {
    const line = [[0, 0], [1, 1], [2, 0]];
    assert.strictEqual(simplifyLine(line, 0.01).length, 3);
    // the same corner, below the tolerance, goes
    assert.strictEqual(simplifyLine([[0, 0], [1, 0.005], [2, 0]], 0.01).length, 2);
  });

  it('should never move a vertex it keeps', () => {
    const line = [[0, 0], [1, 2], [2, 0], [3, 5], [4, 0]];
    for (const kept of simplifyLine(line, 0.5))
      assert.ok(line.includes(kept), 'a kept vertex should be the original object');
  });

  it('should pass a short line or a non-positive tolerance straight through', () => {
    const line = [[0, 0], [1, 0.0001], [2, 0]];
    assert.deepStrictEqual(simplifyLine(line, 0), line);
    assert.deepStrictEqual(simplifyLine(line, -1), line);
    assert.deepStrictEqual(simplifyLine([[0, 0], [1, 1]], 10), [[0, 0], [1, 1]]);
    assert.notStrictEqual(simplifyLine(line, 0), line, 'the result is a copy, not the input');
  });

  it('should survive an input long enough to overflow a recursive one', () => {
    // A monotone staircase is the worst case: every split takes one
    // vertex off the end, so a recursive Douglas-Peucker recurses once
    // per vertex. 200k is well past the ~10k JS stack limit.
    const line = [];
    for (let i = 0; i < 200_000; i++)
      line.push([i, Math.sqrt(i)]);
    const simplified = simplifyLine(line, 0.5);
    assert.ok(simplified.length < line.length, 'a smooth curve should lose vertices');
    assert.ok(simplified.length > 2, 'a curve is not a straight line');
    assert.deepStrictEqual(simplified[0], line[0]);
    assert.deepStrictEqual(simplified[simplified.length - 1], line[line.length - 1]);
  });
});

describe('ring simplification', () => {
  it('should keep a ring closed', () => {
    const ring = [[0, 0], [1, 0.0001], [2, 0], [2, 2], [0, 2], [0, 0]];
    const simplified = simplifyRing(ring, 0.01);
    assert.ok(simplified.length < ring.length, 'the collinear vertex should go');
    assert.deepStrictEqual(simplified[0], simplified[simplified.length - 1],
      'first and last must still match');
  });

  it('should refuse to reduce a ring below four positions', () => {
    // a tolerance that would flatten this triangle entirely
    const ring = [[0, 0], [1, 0.001], [2, 0], [0, 0]];
    assert.deepStrictEqual(simplifyRing(ring, 10), ring);
    // and a ring too short to simplify comes back untouched
    const tiny = [[0, 0], [1, 0], [0, 0]];
    assert.deepStrictEqual(simplifyRing(tiny, 0.5), tiny);
  });
});
