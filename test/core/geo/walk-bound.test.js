//@ts-check
/**
 * @file The GeoJSON traversal walks a deep value without the host stack,
 * to 100000 levels — past every nest its recursive walk answered on a
 * default host stack: past them it refuses with `JO2001`, and on a cycle
 * it follows with `JO2002` at the member that closes it, the pointer
 * `locateCycle` answers. A value it answered before answers the same.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { locateCycle } from '@jarenjs/core/object';
import {
  bboxOf, centroidOf, containsPosition, eachPosition, geoDistance, geoJsonToWkt, geometryArea,
  geometryLength, geometryOf, positionsOf, ringsClosed, simplifyGeometry,
} from '@jarenjs/core/geo';

const square = (x, y, w) => ({ type: 'Polygon', coordinates: [[[x, y], [x + w, y], [x + w, y + w], [x, y + w], [x, y]]] });
/** `n` arrays around the position [1, 2]. @param {number} n */
const nestCoordinates = (n) => {
  /** @type {any} */
  let v = [1, 2];
  for (let i = 0; i < n; i++) v = [v];
  return v;
};
/** `n` GeometryCollections around `inner`. @param {number} n @param {any} inner */
const nestCollections = (n, inner) => {
  let g = inner;
  for (let i = 0; i < n; i++) g = { type: 'GeometryCollection', geometries: [g] };
  return g;
};
/** `n` Features around `inner`. @param {number} n @param {any} inner */
const nestFeatures = (n, inner) => {
  let g = inner;
  for (let i = 0; i < n; i++) g = { type: 'Feature', properties: null, geometry: g };
  return g;
};
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
    const g = { type: 'GeometryCollection', geometries: [square(0, 0, 1)] };
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
/** @param {string} verb @param {string} at */
const circular = (verb, at) => ({
  name: 'JsonCycleError', code: 'JO2002', docPath: at,
  message: `JO2002: a circular reference cannot be ${verb} at ${at}`,
});
/** @param {string} verb */
const tooDeep = (verb) => ({
  name: 'JsonDepthError', code: 'JO2001',
  message: `JO2001: a value nested deeper than 100000 levels cannot be ${verb}`,
});
const walked = 'walked as GeoJSON';
// every walk over positions, by name
const positionWalks = {
  eachPosition: (v) => eachPosition(v, () => {}),
  bboxOf, positionsOf, centroidOf,
  geoDistance: (v) => geoDistance(v, [0, 0]),
};
// every walk over the geometries a value holds, by name
const geometryWalks = {
  geometryArea, geometryLength, ringsClosed,
  // a position outside every surface here, so the walk reads them all
  containsPosition: (v) => containsPosition(v, 50, 50),
};

describe('a cycle the GeoJSON walk follows is refused at the member that closes it', () => {
  it('refuses coordinates that hold themselves in every walk over positions', () => {
    const g = cycles.coordinates();
    assert.equal(locateCycle(g), '/coordinates/0');
    for (const [name, walk] of Object.entries(positionWalks))
      assert.throws(() => walk(g), circular(walked, '/coordinates/0'), name);
  });

  it('refuses a Feature, a GeometryCollection and a FeatureCollection that hold themselves in every walk', () => {
    for (const [shape, at] of [['feature', '/geometry'], ['collection', '/geometries/1'], ['features', '/features/0']]) {
      const value = cycles[shape]();
      assert.equal(locateCycle(value), at);
      for (const [name, walk] of Object.entries({ ...positionWalks, ...geometryWalks }))
        assert.throws(() => walk(value), circular(walked, at), `${name} over ${shape}`);
      assert.throws(() => simplifyGeometry(value, 0.1), circular('simplified', at), `simplifyGeometry over ${shape}`);
    }
    assert.throws(() => geometryOf(cycles.feature()), circular(walked, '/geometry'));
    assert.throws(() => geoJsonToWkt(cycles.feature()), circular(walked, '/geometry'));
  });

  it('answers what does not walk the cycle, as before', () => {
    const g = cycles.coordinates();
    // a line has no area, and one position no length: neither walks the nest
    assert.equal(geometryArea(g), 0);
    assert.equal(geometryLength(g), 0);
    assert.equal(ringsClosed(g), true);
    assert.equal(containsPosition(g, 0, 0), false);
    assert.equal(geoJsonToWkt(g), null);
    assert.deepEqual(Object.keys(simplifyGeometry(g, 0.1)), ['type', 'coordinates']);
    // the writer answers no text for collections nested past eight, a cycle among them
    assert.equal(geoJsonToWkt(cycles.collection()), null);
    // a surface that contains the position decides before the cycle is reached
    assert.equal(containsPosition(cycles.collection(), 0.5, 0.5), true);
    // a member no walk reads may hold a cycle
    /** @type {any} */
    const properties = { name: 'a' };
    properties.self = properties;
    const feature = { type: 'Feature', properties, geometry: square(0, 0, 1) };
    assert.deepEqual(bboxOf(feature), [0, 0, 1, 1]);
    assert.equal(geometryArea(feature), geometryArea(square(0, 0, 1)));
    assert.equal(geoJsonToWkt(feature), 'POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))');
    assert.equal(simplifyGeometry(feature, 0.1).properties, properties);
  });
});

describe('the GeoJSON walk holds its bound of 100000 levels', () => {
  it('walks positions 100000 levels down and refuses the 100001st', () => {
    // the line is level 1, its coordinates 2, the position 2 + n
    const line = (n) => ({ type: 'LineString', coordinates: nestCoordinates(n) });
    assert.deepEqual(bboxOf(line(99998)), [1, 2, 1, 2]);
    assert.deepEqual(centroidOf(line(99998)), [1, 2]);
    assert.deepEqual(positionsOf(line(8000)), [[1, 2]]);
    // past the 10000 levels equalsJson compares, which refuses this line
    assert.deepEqual(bboxOf(line(9999)), [1, 2, 1, 2]);
    for (const [name, walk] of Object.entries(positionWalks)) {
      assert.throws(() => walk(line(99999)), tooDeep(walked), name);
      assert.throws(() => walk(line(200000)), tooDeep(walked), name);
    }
  });

  it('walks collections 100000 levels down and refuses the 100001st', () => {
    // each collection is two levels: itself and its geometries
    const inner = square(0, 0, 1);
    const area = geometryArea(inner);
    assert.equal(geometryArea(nestCollections(49999, inner)), area);
    assert.equal(geometryLength(nestCollections(49999, inner)), geometryLength(inner));
    assert.equal(containsPosition(nestCollections(49999, inner), 0.5, 0.5), true);
    assert.equal(ringsClosed(nestCollections(49999, inner)), true);
    // a walk over positions reads two levels more: the ring and the position
    assert.deepEqual(bboxOf(nestCollections(49998, inner)), [0, 0, 1, 1]);
    assert.throws(() => bboxOf(nestCollections(49999, inner)), tooDeep(walked));
    for (const [name, walk] of Object.entries({ ...positionWalks, ...geometryWalks }))
      assert.throws(() => walk(nestCollections(50000, inner)), tooDeep(walked), name);
    assert.throws(() => simplifyGeometry(nestCollections(50000, inner), 0.1), tooDeep('simplified'));
    /** @type {any} */
    let simplified = simplifyGeometry(nestCollections(49999, inner), 0.1);
    for (let i = 0; i < 49999; i++) simplified = simplified.geometries[0];
    assert.deepEqual(simplified, inner);
    assert.notEqual(simplified, inner);
  });

  it('walks FeatureCollections 100000 levels down and refuses the 100001st', () => {
    // each collection is two levels: itself and its features
    const chain = (n) => {
      /** @type {any} */
      let fc = { type: 'Point', coordinates: [1, 2] };
      for (let i = 0; i < n; i++) fc = { type: 'FeatureCollection', features: [fc] };
      return fc;
    };
    assert.deepEqual(bboxOf(chain(49999)), [1, 2, 1, 2]);
    assert.throws(() => bboxOf(chain(50000)), tooDeep(walked));
    assert.equal(geometryArea(chain(49999)), 0);
    assert.throws(() => geometryArea(chain(50000)), tooDeep(walked));
    assert.throws(() => simplifyGeometry(chain(50000), 0.1), tooDeep('simplified'));
  });

  it('follows a Feature in Features 100000 levels down and refuses the 100001st', () => {
    const point = { type: 'Point', coordinates: [1, 2] };
    assert.equal(geometryOf(nestFeatures(99999, point)), point);
    assert.equal(geometryArea(nestFeatures(99999, square(0, 0, 1))), geometryArea(square(0, 0, 1)));
    assert.equal(geoJsonToWkt(nestFeatures(99999, point)), 'POINT (1 2)');
    assert.throws(() => geometryOf(nestFeatures(100000, point)), tooDeep(walked));
    assert.throws(() => geometryArea(nestFeatures(100000, point)), tooDeep(walked));
    assert.throws(() => geoJsonToWkt(nestFeatures(100000, point)), tooDeep(walked));
    assert.throws(() => simplifyGeometry(nestFeatures(100000, point), 0.1), tooDeep('simplified'));
  });

  it('writes no text for FeatureCollections nested past the writer bound, however deep', () => {
    assert.equal(geoJsonToWkt(cycles.features()), null);
    let fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: null, geometry: { type: 'Point', coordinates: [1, 2] } }] };
    for (let i = 0; i < 100000; i++) fc = { type: 'FeatureCollection', features: [fc] };
    assert.equal(geoJsonToWkt(fc), null);
  });
});

describe('a collection measures as its nested loops added', () => {
  // each case twice: as written, measured on the host's stack, and inside
  // 300 collections, measured on the walk's own
  const bothDepths = (value) => [value, nestCollections(300, value)];

  it('measures a Feature whose geometry is a FeatureCollection as no geometry, and walks its positions', () => {
    const feature = { type: 'Feature', properties: null, geometry: { type: 'FeatureCollection', features: [square(0, 0, 1)] } };
    for (const value of bothDepths(feature)) {
      assert.equal(geometryArea(value), 0);
      assert.equal(geometryLength(value), 0);
      assert.equal(containsPosition(value, 0.5, 0.5), false);
      assert.deepEqual(bboxOf(value), [0, 0, 1, 1]);
    }
  });

  it('rebuilds a Feature, a FeatureCollection and a GeometryCollection around their simplified members', () => {
    const line = { type: 'LineString', coordinates: [[0, 0], [1, 0.001], [2, 0]] };
    const simple = { type: 'LineString', coordinates: [[0, 0], [2, 0]] };
    const value = { type: 'FeatureCollection', id: 7, features: [
      { type: 'Feature', properties: { a: 1 }, geometry: { type: 'GeometryCollection', geometries: [line, [1, 2]] } },
    ] };
    assert.deepEqual(simplifyGeometry(value, 0.01), { type: 'FeatureCollection', id: 7, features: [
      { type: 'Feature', properties: { a: 1 }, geometry: { type: 'GeometryCollection', geometries: [simple, [1, 2]] } },
    ] });
    assert.equal(line.coordinates.length, 3);
  });

  it('adds each collection before the one around it', () => {
    const [a, b, c] = [square(0, 0, 1), square(10, 10, 3 / 7), square(-20, 5, 3 / 13)].map((g) => geometryArea(g));
    // the two groupings differ in the last place, so the test can tell them apart
    assert.notEqual(a + (b + c), (a + b) + c);
    const inner = { type: 'GeometryCollection', geometries: [square(10, 10, 3 / 7), square(-20, 5, 3 / 13)] };
    const features = { type: 'FeatureCollection', features: [
      { type: 'Feature', properties: null, geometry: square(0, 0, 1) },
      { type: 'Feature', properties: null, geometry: inner },
    ] };
    for (const value of [...bothDepths({ type: 'GeometryCollection', geometries: [square(0, 0, 1), inner] }), ...bothDepths(features)])
      assert.equal(geometryArea(value), a + (b + c));
  });

  it('stops at the first surface that contains the position and the first open ring', () => {
    const open = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] };
    for (const value of bothDepths({ type: 'GeometryCollection', geometries: [square(5, 5, 1), square(0, 0, 1), cycles.collection()] }))
      assert.equal(containsPosition(value, 0.5, 0.5), true);
    for (const value of bothDepths({ type: 'GeometryCollection', geometries: [square(0, 0, 1), { type: 'GeometryCollection', geometries: [open] }, cycles.collection()] }))
      assert.equal(ringsClosed(value), false);
    for (const value of bothDepths({ type: 'FeatureCollection', features: [square(0, 0, 1)] }))
      assert.equal(ringsClosed(value), true);
  });

  it('reads a collection\'s members as for...of reads them', () => {
    // a string's characters are no geometry each
    for (const value of bothDepths({ type: 'FeatureCollection', features: 'ab' }))
      assert.equal(geometryArea(value), 0);
    const members = new Set([square(0, 0, 1)]);
    for (const value of bothDepths({ type: 'GeometryCollection', geometries: members }))
      assert.equal(geometryArea(value), geometryArea(square(0, 0, 1)));
  });
});
