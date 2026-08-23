import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  geometryOf, isPosition, eachPosition, positionsOf, bboxOf,
  geometryArea, geometryLength, centroidOf, containsPosition, geoDistance,
  ringsClosed,
} from '@jarenjs/core/geo';

const POLY = { type: 'Polygon', coordinates: [[[4, 52], [5, 52], [5, 53], [4, 53], [4, 52]]] };
const FEATURE = { type: 'Feature', properties: { name: 'box' }, geometry: POLY };
const POINT = { type: 'Point', coordinates: [4.9041, 52.3676] };
const COLLECTION = {
  type: 'FeatureCollection',
  features: [FEATURE, { type: 'Feature', properties: {}, geometry: POINT }],
};

describe('GeoJSON traversal', () => {
  it('should recognise a bare position', () => {
    assert.strictEqual(isPosition([4.9, 52.4]), true);
    assert.strictEqual(isPosition([4.9, 52.4, 12]), true, 'altitude is allowed');
    assert.strictEqual(isPosition([4.9]), false);
    assert.strictEqual(isPosition(['4.9', '52.4']), false);
    assert.strictEqual(isPosition(POINT), false, 'a Point is a geometry, not a position');
  });

  it('should unwrap to a geometry, or refuse', () => {
    assert.strictEqual(geometryOf(POLY), POLY);
    assert.strictEqual(geometryOf(FEATURE), POLY, 'a Feature unwraps');
    assert.strictEqual(geometryOf({ type: 'Feature', geometry: null }), null);
    assert.strictEqual(geometryOf(COLLECTION), null, 'a collection has no single geometry');
    assert.strictEqual(geometryOf([4, 52]), null);
    assert.strictEqual(geometryOf(null), null);
  });

  it('should visit every position in document order', () => {
    const seen = [];
    eachPosition(COLLECTION, (p) => seen.push(p));
    assert.strictEqual(seen.length, 6, 'five ring positions plus the point');
    assert.deepStrictEqual(seen[0], [4, 52]);
    assert.deepStrictEqual(seen[5], [4.9041, 52.3676]);
    // positionsOf is the collected form of the same walk
    assert.deepStrictEqual(positionsOf(COLLECTION), seen);
    assert.deepStrictEqual(positionsOf([4, 52]), [[4, 52]], 'a bare position is one position');
    assert.deepStrictEqual(positionsOf(null), []);
    assert.deepStrictEqual(positionsOf({ type: 'Feature', geometry: null }), []);
  });

  it('should walk a GeometryCollection', () => {
    const gc = { type: 'GeometryCollection', geometries: [POINT, POLY] };
    assert.strictEqual(positionsOf(gc).length, 6);
    assert.deepStrictEqual(bboxOf(gc), [4, 52, 5, 53]);
    assert.ok(geometryArea(gc) > 0, 'the polygon inside contributes area');
    assert.strictEqual(containsPosition(gc, 4.5, 52.5), true);
  });

  it('should compute a bounding box, ignoring any bbox member present', () => {
    assert.deepStrictEqual(bboxOf(POLY), [4, 52, 5, 53]);
    assert.deepStrictEqual(bboxOf(FEATURE), [4, 52, 5, 53]);
    assert.deepStrictEqual(bboxOf(COLLECTION), [4, 52, 5, 53]);
    // a producer's own bbox may be wrong, so it is recomputed
    const lying = { ...POLY, bbox: [-99, -99, 99, 99] };
    assert.deepStrictEqual(bboxOf(lying), [4, 52, 5, 53]);
    assert.strictEqual(bboxOf({ type: 'Feature', geometry: null }), null);
  });

  // The walk is over a whole value, so one bad vertex anywhere in a
  // feature poisons the box: answering with a box over the rest would
  // be a box that does not bound the feature.
  it('should refuse a box for a value carrying a non-finite coordinate', () => {
    const broken = {
      type: 'Feature',
      properties: { name: 'broken' },
      geometry: { type: 'LineString', coordinates: [[4, 52], [NaN, 53], [5, 54]] },
    };
    assert.strictEqual(bboxOf(broken), null);
    assert.strictEqual(bboxOf({ type: 'Point', coordinates: [4, Infinity] }), null);
    assert.strictEqual(
      bboxOf({ type: 'FeatureCollection', features: [FEATURE, broken] }), null,
      'one broken member refuses the collection\'s box');
  });

  it('should measure area, subtracting holes', () => {
    const solid = geometryArea(POLY);
    const holed = geometryArea({
      type: 'Polygon',
      coordinates: [POLY.coordinates[0], [[4.4, 52.4], [4.4, 52.6], [4.6, 52.6], [4.6, 52.4], [4.4, 52.4]]],
    });
    assert.ok(holed < solid, 'a hole removes area');
    assert.ok(holed > 0);
    assert.strictEqual(geometryArea(POINT), 0, 'a point has no surface');
    assert.strictEqual(geometryArea(null), 0);
    // a collection sums its members
    assert.strictEqual(geometryArea(COLLECTION), solid);
  });

  it('should measure length over lines and ring perimeters', () => {
    const line = { type: 'LineString', coordinates: [[4, 52], [5, 52]] };
    assert.ok(geometryLength(line) > 0);
    assert.ok(geometryLength(POLY) > geometryLength(line), 'a perimeter is four sides');
    assert.strictEqual(geometryLength(POINT), 0);
    const multi = { type: 'MultiLineString', coordinates: [line.coordinates, line.coordinates] };
    assert.ok(Math.abs(geometryLength(multi) - 2 * geometryLength(line)) < 1e-6);
    const mp = { type: 'MultiPolygon', coordinates: [POLY.coordinates] };
    assert.ok(Math.abs(geometryLength(mp) - geometryLength(POLY)) < 1e-6);
  });

  it('should average positions for the centroid', () => {
    assert.deepStrictEqual(centroidOf(POLY), [4.4, 52.4]);
    assert.deepStrictEqual(centroidOf([4, 52]), [4, 52]);
    assert.strictEqual(centroidOf({ type: 'Feature', geometry: null }), null);
  });

  it('should test containment through every wrapper', () => {
    assert.strictEqual(containsPosition(POLY, 4.5, 52.5), true);
    assert.strictEqual(containsPosition(FEATURE, 4.5, 52.5), true);
    assert.strictEqual(containsPosition(COLLECTION, 4.5, 52.5), true);
    assert.strictEqual(containsPosition(POLY, 9, 9), false);
    assert.strictEqual(containsPosition(POINT, 4.9041, 52.3676), false, 'a point has no inside');
    assert.strictEqual(containsPosition(null, 0, 0), false);
    const mp = { type: 'MultiPolygon', coordinates: [POLY.coordinates] };
    assert.strictEqual(containsPosition(mp, 4.5, 52.5), true);
  });

  it('should measure between representative positions', () => {
    assert.strictEqual(geoDistance([4, 52], [4, 52]), 0);
    // a shape is represented by its centroid, which is stated behaviour
    const viaCentroid = geoDistance([4.4, 52.4], POLY);
    assert.strictEqual(viaCentroid, 0);
    assert.strictEqual(geoDistance([0, 0], { type: 'Feature', geometry: null }), null);
  });

  it('should report ring closure across a whole document', () => {
    assert.strictEqual(ringsClosed(POLY), true);
    assert.strictEqual(ringsClosed(FEATURE), true);
    assert.strictEqual(ringsClosed(COLLECTION), true);
    assert.strictEqual(ringsClosed(POINT), true, 'no rings is vacuously closed');
    const open = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1]]] };
    assert.strictEqual(ringsClosed(open), false);
    assert.strictEqual(ringsClosed({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: open }] }), false);
    assert.strictEqual(ringsClosed({ type: 'MultiPolygon', coordinates: [open.coordinates] }), false);
    assert.strictEqual(ringsClosed({ type: 'GeometryCollection', geometries: [open] }), false);
  });
});
