//@ts-check
/**
 * @file `geoJsonToWkt` never writes text `isValidWkt` refuses. It wrote a
 * polygon ring of two positions, a ring whose ends differ, a line of one
 * position and collections nested past the reader's bound, and answered
 * the string where it now answers `null`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { geoJsonToWkt, isValidWkt, wktToGeoJson } from '@jarenjs/core/geo';

describe('geoJsonToWkt - the writer and the reader are one grammar', () => {
  it('refuses a ring of fewer than four positions or one that does not close', () => {
    assert.strictEqual(geoJsonToWkt({ type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] }), null);
    assert.strictEqual(geoJsonToWkt({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] }), null);
    assert.strictEqual(geoJsonToWkt({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }), null);
    assert.strictEqual(geoJsonToWkt({ type: 'MultiPolygon',
      coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[0, 0], [1, 0], [1, 1]]]] }), null);
  });

  it('refuses a ring whose ends differ in altitude only', () => {
    const ring = [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 0, 2]];
    assert.strictEqual(geoJsonToWkt({ type: 'Polygon', coordinates: [ring] }, { dim: 3 }), null);
    assert.strictEqual(geoJsonToWkt({ type: 'Polygon', coordinates: [ring] }),
      'POLYGON ((0 0, 1 0, 1 1, 0 0))', 'written flat, the ends are the same position');
  });

  it('refuses a line of one position', () => {
    assert.strictEqual(geoJsonToWkt({ type: 'LineString', coordinates: [[0, 0]] }), null);
    assert.strictEqual(geoJsonToWkt({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2]]] }), null);
    assert.strictEqual(geoJsonToWkt({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }), 'LINESTRING (0 0, 1 1)');
  });

  it('writes a collection nested eight deep and refuses a ninth level', () => {
    /** @param {number} depth */
    const nested = (depth) => {
      /** @type {any} */
      let geometry = { type: 'Point', coordinates: [1, 2] };
      for (let i = 0; i < depth; i++) geometry = { type: 'GeometryCollection', geometries: [geometry] };
      return geometry;
    };
    const eight = geoJsonToWkt(nested(8));
    assert.ok(eight !== null && isValidWkt(eight));
    assert.deepStrictEqual(wktToGeoJson(eight), nested(8));
    assert.strictEqual(geoJsonToWkt(nested(9)), null);
    assert.strictEqual(geoJsonToWkt(nested(100000)), null, 'no RangeError at any depth');
  });

  it('keeps writing every shape a reader accepts', () => {
    assert.strictEqual(geoJsonToWkt({ type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 0]]] }),
      'POLYGON ((0 0, 4 0, 4 4, 0 0))');
    assert.strictEqual(geoJsonToWkt({ type: 'GeometryCollection', geometries: [] }), 'GEOMETRYCOLLECTION EMPTY');
    assert.strictEqual(geoJsonToWkt({ type: 'MultiPoint', coordinates: [[0, 0], [1, 1]] }), 'MULTIPOINT ((0 0), (1 1))');
  });
});
