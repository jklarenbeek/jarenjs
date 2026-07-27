/**
 * The geo validity testers: the geohash alphabet, the WKT grammar, and
 * the one-call GeoJSON structural judgment. These are what the
 * `geohash` / `wkt` / `geojson` formats in @jarenjs/formats bind to,
 * so their edges (ring closure, dimension consistency, WGS 84 bounds)
 * are pinned here rather than in the format layer.
 */
import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  isValidGeohash,
  isValidWkt,
  isValidGeoJson,
  geohashEncode,
} from '@jarenjs/core/geo';

describe('isValidGeohash', () => {
  it('should accept well-formed hashes of any length', () => {
    assert.isTrue(isValidGeohash('u'));
    assert.isTrue(isValidGeohash('u173zqmrfe4'));
    assert.isTrue(isValidGeohash(geohashEncode(4.9041, 52.3676, 12)));
  });

  it('should reject the empty string and non-strings', () => {
    assert.isFalse(isValidGeohash(''));
    assert.isFalse(isValidGeohash(null));
    assert.isFalse(isValidGeohash(42));
  });

  it('should reject characters outside the base-32 alphabet', () => {
    // a, i, l and o are deliberately absent from the alphabet
    assert.isFalse(isValidGeohash('u17a'));
    assert.isFalse(isValidGeohash('io'));
    assert.isFalse(isValidGeohash('U173Z'), 'the alphabet is lowercase');
    assert.isFalse(isValidGeohash('u173 z'));
  });
});

describe('isValidWkt', () => {
  it('should accept the seven geometry types', () => {
    assert.isTrue(isValidWkt('POINT (4.9041 52.3676)'));
    assert.isTrue(isValidWkt('LINESTRING (0 0, 1 1, 2 0)'));
    assert.isTrue(isValidWkt('POLYGON ((0 0, 4 0, 4 4, 0 0))'));
    assert.isTrue(isValidWkt('MULTIPOINT (0 0, 1 1)'));
    assert.isTrue(isValidWkt('MULTIPOINT ((0 0), (1 1))'), 'both MULTIPOINT spellings are legal');
    assert.isTrue(isValidWkt('MULTILINESTRING ((0 0, 1 1), (2 2, 3 3))'));
    assert.isTrue(isValidWkt('MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((5 5, 6 5, 6 6, 5 5)))'));
    assert.isTrue(isValidWkt('GEOMETRYCOLLECTION (POINT (1 2), LINESTRING (0 0, 1 1))'));
  });

  it('should accept EMPTY, case-insensitive tags and exponent numbers', () => {
    assert.isTrue(isValidWkt('POINT EMPTY'));
    assert.isTrue(isValidWkt('MULTIPOLYGON EMPTY'));
    assert.isTrue(isValidWkt('point(1 2)'));
    assert.isTrue(isValidWkt('Point (1.5e2 -0.5E-1)'));
    assert.isTrue(isValidWkt('GEOMETRYCOLLECTION (POINT EMPTY)'));
  });

  it('should hold the dimension modifiers to their counts', () => {
    assert.isTrue(isValidWkt('POINT Z (1 2 3)'));
    assert.isTrue(isValidWkt('POINT M (1 2 3)'));
    assert.isTrue(isValidWkt('POINT ZM (1 2 3 4)'));
    assert.isTrue(isValidWkt('POINT (1 2 3)'), 'an unmodified tag accepts 3D, as the field does');
    assert.isFalse(isValidWkt('POINT Z (1 2)'), 'Z requires three coordinates');
    assert.isFalse(isValidWkt('POINT ZM (1 2 3)'), 'ZM requires four');
    assert.isFalse(isValidWkt('LINESTRING (0 0, 1 1 1)'), 'mixed dimensions in one geometry');
  });

  it('should require closed rings of at least four points', () => {
    assert.isFalse(isValidWkt('POLYGON ((0 0, 4 0, 4 4, 1 1))'), 'open ring');
    assert.isFalse(isValidWkt('POLYGON ((0 0, 4 0, 0 0))'), 'three points close nothing');
    assert.isTrue(isValidWkt('POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0), (1 1, 2 1, 2 2, 1 1))'));
  });

  it('should reject malformed text outright', () => {
    assert.isFalse(isValidWkt(''));
    assert.isFalse(isValidWkt('CIRCLE (1 2, 3)'));
    assert.isFalse(isValidWkt('POINT'));
    assert.isFalse(isValidWkt('POINT ()'));
    assert.isFalse(isValidWkt('POINT (1)'));
    assert.isFalse(isValidWkt('POINT (1 2'));
    assert.isFalse(isValidWkt('POINT (1 2) extra'));
    assert.isFalse(isValidWkt(' POINT (1 2)'), 'no leading whitespace');
    assert.isFalse(isValidWkt('POINT (1 2) '), 'no trailing whitespace');
    assert.isFalse(isValidWkt('LINESTRING (0 0)'), 'a line needs two points');
    assert.isFalse(isValidWkt('POINT (1, 2)'), 'coordinates are space-separated');
  });
});

describe('isValidGeoJson', () => {
  const ring = [[0, 0], [4, 0], [4, 4], [0, 0]];

  it('should accept the geometry types with their nesting', () => {
    assert.isTrue(isValidGeoJson({ type: 'Point', coordinates: [4.9, 52.4] }));
    assert.isTrue(isValidGeoJson({ type: 'Point', coordinates: [4.9, 52.4, 12.5] }));
    assert.isTrue(isValidGeoJson({ type: 'MultiPoint', coordinates: [[0, 0], [1, 1]] }));
    assert.isTrue(isValidGeoJson({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }));
    assert.isTrue(isValidGeoJson({ type: 'Polygon', coordinates: [ring] }));
    assert.isTrue(isValidGeoJson({ type: 'MultiPolygon', coordinates: [[ring], [ring]] }));
    assert.isTrue(isValidGeoJson({
      type: 'GeometryCollection',
      geometries: [{ type: 'Point', coordinates: [1, 2] }],
    }));
  });

  it('should accept Features and FeatureCollections', () => {
    const feature = {
      type: 'Feature',
      properties: { name: 'x' },
      geometry: { type: 'Point', coordinates: [1, 2] },
    };
    assert.isTrue(isValidGeoJson(feature));
    assert.isTrue(isValidGeoJson({ type: 'Feature', properties: null, geometry: null }),
      'both members may be null, but must be present');
    assert.isTrue(isValidGeoJson({ type: 'FeatureCollection', features: [feature] }));
    assert.isTrue(isValidGeoJson({ type: 'FeatureCollection', features: [] }));
  });

  it('should reject open rings — the invariant a schema cannot state', () => {
    assert.isFalse(isValidGeoJson({
      type: 'Polygon',
      coordinates: [[[0, 0], [4, 0], [4, 4], [1, 1]]],
    }));
    assert.isFalse(isValidGeoJson({
      type: 'Polygon',
      coordinates: [[[0, 0], [4, 0], [0, 0]]],
    }), 'three positions close nothing');
  });

  it('should hold positions to WGS 84 bounds and 2-3 axes', () => {
    assert.isFalse(isValidGeoJson({ type: 'Point', coordinates: [181, 0] }));
    assert.isFalse(isValidGeoJson({ type: 'Point', coordinates: [0, -91] }));
    assert.isFalse(isValidGeoJson({ type: 'Point', coordinates: [1, 2, 3, 4] }));
    assert.isFalse(isValidGeoJson({ type: 'Point', coordinates: [1] }));
    assert.isFalse(isValidGeoJson({ type: 'Point', coordinates: ['1', '2'] }));
  });

  it('should reject structural nonsense', () => {
    assert.isFalse(isValidGeoJson(null));
    assert.isFalse(isValidGeoJson([1, 2]));
    assert.isFalse(isValidGeoJson({ type: 'Circle', coordinates: [0, 0] }));
    assert.isFalse(isValidGeoJson({ type: 'Feature', geometry: null }),
      'a Feature without a properties member');
    assert.isFalse(isValidGeoJson({ type: 'FeatureCollection', features: [{ type: 'Point', coordinates: [0, 0] }] }),
      'a collection holds Features, not bare geometries');
  });
});
