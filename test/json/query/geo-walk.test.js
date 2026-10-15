//@ts-check
/**
 * @file The spatial operators refuse with `$eq`'s codes: a cycle the walk
 * follows is refused `JO2002` at the member that closes it, the pointer
 * `$eq` names for the same value, and a nest past the traversal's 100000
 * levels `JO2001`, never an uncoded error. A screened spatial join raises or answers
 * exactly as the scan it replaces.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileJsonQuery } from '@jarenjs/json/query';

const square = (x, y, w) => ({ type: 'Polygon', coordinates: [[[x, y], [x + w, y], [x + w, y + w], [x, y + w], [x, y]]] });
const cycles = {
  coordinates: () => {
    /** @type {any} */
    const g = { type: 'LineString', coordinates: [] };
    g.coordinates.push(g.coordinates);
    return g;
  },
  feature: () => {
    /** @type {any} */
    const f = { type: 'Feature', properties: null, geometry: null };
    f.geometry = f;
    return f;
  },
  collection: () => {
    /** @type {any} */
    const g = { type: 'GeometryCollection', geometries: [] };
    g.geometries.push(g);
    return g;
  },
  features: () => {
    /** @type {any} */
    const fc = { type: 'FeatureCollection', features: [] };
    fc.features.push(fc);
    return fc;
  },
};
/** `n` arrays around the position [1, 2], as a line's coordinates. @param {number} n */
const deepLine = (n) => {
  /** @type {any} */
  let v = [1, 2];
  for (let i = 0; i < n; i++) v = [v];
  return { type: 'LineString', coordinates: v };
};
// every spatial operator that walks its operand, over `$.g`
const walking = {
  $bbox: { $bbox: '$.g' },
  $area: { $area: '$.g' },
  $length: { $length: '$.g' },
  $centroid: { $centroid: '$.g' },
  $distance: { $distance: ['$.g', [0, 0]] },
  '$within (point)': { $within: ['$.g', square(0, 0, 1)] },
  '$within (surface)': { $within: [[50, 50], '$.g'] },
  '$bbox-intersects': { '$bbox-intersects': [[0, 0], '$.g'] },
  $geohash: { $geohash: ['$.g'] },
};
const outcome = (doc, data) => {
  try {
    return { value: compileJsonQuery(doc)(data) };
  }
  catch (error) {
    return { name: error.name, code: error.code ?? 'uncoded', docPath: error.docPath, reason: error.reason };
  }
};

describe('a spatial operator refuses what $eq refuses', () => {
  it('refuses a cycle it follows with $eq\'s code, at $eq\'s member', () => {
    for (const [shape, make] of Object.entries(cycles)) {
      const eq = outcome({ $eq: ['$.g', '$.h'] }, { g: make(), h: make() });
      assert.equal(eq.code, 'JO2002', shape);
      for (const [name, doc] of Object.entries(walking)) {
        assert.deepEqual(outcome(doc, { g: make() }), {
          name: 'JsonCycleError', code: 'JO2002', docPath: eq.docPath,
          reason: 'a circular reference cannot be walked as GeoJSON',
        }, `${name} over ${shape}`);
      }
    }
  });

  it('refuses a nest past 100000 levels with $eq\'s code, and walks one within', () => {
    for (const [name, doc] of Object.entries(walking)) {
      for (const n of [99999, 200000]) {
        assert.deepEqual(outcome(doc, { g: deepLine(n) }), {
          name: 'JsonDepthError', code: 'JO2001', docPath: undefined,
          reason: 'a value nested deeper than 100000 levels cannot be walked as GeoJSON',
        }, `${name} over ${n} levels`);
      }
    }
    // $eq compares to 10000 levels; the walk answers what it answered before, past them
    assert.equal(outcome({ $eq: ['$.g', '$.h'] }, { g: deepLine(9999), h: deepLine(9999) }).code, 'JO2001');
    assert.deepEqual(outcome(walking.$bbox, { g: deepLine(9999) }), { value: [1, 2, 1, 2] });
    const within = { g: deepLine(99998) };
    assert.deepEqual(outcome(walking.$bbox, within), { value: [1, 2, 1, 2] });
    assert.deepEqual(outcome(walking.$centroid, within), { value: [1, 2] });
    assert.deepEqual(outcome(walking.$geohash, within), outcome(walking.$geohash, { g: [1, 2] }));
    assert.deepEqual(outcome(walking.$area, within), { value: 0 });
  });

  it('answers what does not walk the cycle, as before', () => {
    // the writer's collection bound and a line's coordinate shape answer no text
    for (const shape of ['coordinates', 'collection'])
      assert.deepEqual(outcome({ '$geo-text': '$.g' }, { g: cycles[shape]() }), { value: undefined }, shape);
    // simplifying keeps a line's coordinates it has no run to drop from
    const g = cycles.coordinates();
    const simplified = outcome({ '$geo-simplify': ['$.g', 0.1] }, { g }).value;
    assert.equal(simplified.coordinates[0], g.coordinates[0]);
    assert.notEqual(simplified, g);
  });

  it('writes no text for a FeatureCollection that holds itself, and refuses what the writer and the simplifier walk', () => {
    assert.deepEqual(outcome({ '$geo-text': '$.g' }, { g: cycles.features() }), { value: undefined });
    for (const doc of [{ '$geo-text': '$.g' }, { '$geo-simplify': ['$.g', 0.1] }])
      assert.equal(outcome(doc, { g: cycles.feature() }).code, 'JO2002');
    assert.equal(outcome({ '$geo-simplify': ['$.g', 0.1] }, { g: cycles.features() }).code, 'JO2002');
  });
});

describe('a screened spatial join over a value the walk refuses answers as the scan', () => {
  // the scan is the same phrase with a $let, which the planner never screens
  const bothWays = (doc, data) => {
    const screened = outcome(doc, data);
    assert.deepStrictEqual(screened, outcome({ ...doc, $let: { _z: 1 } }, data), 'the screen must agree with the scan');
    return screened;
  };
  const join = (where) => ({ $for: { p: '$.points[*]', r: '$.regions[*]' }, $where: where, $return: '$r.id' });
  const within = join({ $within: ['$p.at', '$r.geom'] });
  const intersects = join({ '$bbox-intersects': ['$p.at', '$r.geom'] });
  const regions = [{ id: 'a', geom: square(0, 0, 2) }, { id: 'z', geom: cycles.coordinates() }];

  it('answers where the scan never walks the refused region', () => {
    // a point with no finite position is inside nothing, so no surface is walked
    assert.deepStrictEqual(bothWays(within, { points: [{ at: [NaN, 1] }], regions }), { value: undefined });
  });

  it('raises what the scan raises first', () => {
    const expected = 'JQ2001';
    assert.equal(bothWays(intersects, { points: [{ at: 'x' }], regions }).code, expected);
    assert.equal(bothWays(intersects, { points: [{ at: 'x' }], regions: [{ id: 'd', geom: deepLine(100000) }] }).code, expected);
    assert.equal(bothWays(within, { points: [{ at: [1, 1] }], regions }).code, 'JO2002');
    assert.equal(bothWays(within, { points: [{ at: cycles.coordinates() }], regions }).code, 'JO2002');
  });
});
