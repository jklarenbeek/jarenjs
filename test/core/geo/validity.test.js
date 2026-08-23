/**
 * The geo validity testers: the geohash alphabet, the WKT grammar, and
 * the one-call GeoJSON structural judgment. These are what the
 * `geohash` / `wkt` / `geojson` formats in @jarenjs/formats bind to,
 * so their edges (ring closure, dimension consistency, WGS 84 bounds)
 * are pinned here rather than in the format layer.
 *
 * The WKT round trip is pinned here too, because its correctness claim
 * IS a validity claim: `isValidWkt` and `wktToGeoJson` run one grammar
 * walk with and without a builder, and the corpus below is what proves
 * they accept the same language.
 */
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import * as assert from '../../assert.node.js';

import {
  isValidGeohash,
  isValidWkt,
  isValidGeoJson,
  geohashEncode,
  wktToGeoJson,
  geoJsonToWkt,
  positionsOf,
} from '@jarenjs/core/geo';

const readFixture = (name) => JSON.parse(
  readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

/** Every WKT string the grammar's decision points are pinned by. */
const CORPUS = readFixture('wkt-corpus');
/** The committed judgment on each, index-aligned: the language itself. */
const CORPUS_VALID = readFixture('wkt-corpus-valid');

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

  it('should refuse a tag outside the seven, EMPTY body and all', () => {
    // the tag is judged before the body, so `EMPTY` is not a way past it
    assert.isFalse(isValidWkt('CIRCLE EMPTY'));
    assert.isFalse(isValidWkt('TRIANGLE EMPTY'));
    assert.isFalse(isValidWkt('POLYHEDRALSURFACE EMPTY'));
    assert.isFalse(isValidWkt('CURVEPOLYGON EMPTY'));
    assert.isFalse(isValidWkt('GEOMETRYCOLLECTION (CIRCLE EMPTY)'));
    assert.isFalse(isValidWkt('EMPTY'), 'EMPTY is a body, never a geometry');
  });

  it('should judge every corpus entry the way the committed language says', () => {
    assert.strictEqual(CORPUS.length, CORPUS_VALID.length,
      'the corpus and its judgment are index-aligned');
    const moved = CORPUS.filter((text, i) => isValidWkt(text) !== CORPUS_VALID[i]);
    assert.deepStrictEqual(moved, [], 'the WKT language moved');
  });
});

describe('wktToGeoJson', () => {
  it('should map each tag to its GeoJSON type', () => {
    assert.deepStrictEqual(wktToGeoJson('POINT (4.9041 52.3676)'),
      { type: 'Point', coordinates: [4.9041, 52.3676] });
    assert.deepStrictEqual(wktToGeoJson('LINESTRING (0 0, 1 1)'),
      { type: 'LineString', coordinates: [[0, 0], [1, 1]] });
    assert.deepStrictEqual(wktToGeoJson('POLYGON ((0 0, 4 0, 4 4, 0 0))'),
      { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 0]]] });
    assert.deepStrictEqual(wktToGeoJson('MULTIPOINT ((0 0), 1 1)'),
      { type: 'MultiPoint', coordinates: [[0, 0], [1, 1]] },
      'both MULTIPOINT spellings build the same positions');
    assert.deepStrictEqual(wktToGeoJson('MULTILINESTRING ((0 0, 1 1), (2 2, 3 3))'),
      { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] });
    assert.deepStrictEqual(wktToGeoJson('MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)))'),
      { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] });
    assert.deepStrictEqual(wktToGeoJson('GEOMETRYCOLLECTION (POINT (1 2))'),
      { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [1, 2] }] },
      'a collection carries geometries, not coordinates');
  });

  it('should map EMPTY to an empty coordinate array, not to null', () => {
    assert.deepStrictEqual(wktToGeoJson('POINT EMPTY'), { type: 'Point', coordinates: [] });
    assert.deepStrictEqual(wktToGeoJson('POLYGON EMPTY'), { type: 'Polygon', coordinates: [] });
    assert.deepStrictEqual(wktToGeoJson('GEOMETRYCOLLECTION EMPTY'),
      { type: 'GeometryCollection', geometries: [] });
    assert.deepStrictEqual(wktToGeoJson('MULTIPOINT ZM EMPTY'),
      { type: 'MultiPoint', coordinates: [] },
      'a modifier does not change what EMPTY means');
  });

  it('should keep Z as an altitude and drop the M measure', () => {
    // RFC 7946 3.1.1 defines a third element as altitude; a measure is
    // not one, so writing it there would be a lie
    assert.deepStrictEqual(wktToGeoJson('POINT Z (1 2 3)').coordinates, [1, 2, 3]);
    assert.deepStrictEqual(wktToGeoJson('POINT ZM (1 2 3 4)').coordinates, [1, 2, 3]);
    assert.deepStrictEqual(wktToGeoJson('POINT M (1 2 3)').coordinates, [1, 2]);
    assert.deepStrictEqual(wktToGeoJson('POINT (1 2 3)').coordinates, [1, 2, 3],
      'an unmodified third coordinate is an altitude, as the field reads it');
    assert.deepStrictEqual(wktToGeoJson('LINESTRING M (0 0 9, 1 1 9)').coordinates,
      [[0, 0], [1, 1]]);
  });

  it('should answer what the text says and leave the range to isValidGeoJson', () => {
    const geometry = wktToGeoJson('POINT (999 999)');
    assert.deepStrictEqual(geometry, { type: 'Point', coordinates: [999, 999] });
    assert.isFalse(isValidGeoJson(geometry),
      'the parser reads, the value gate judges — two jobs, one each');
  });

  it('should answer null for anything that is not one WKT geometry', () => {
    assert.strictEqual(wktToGeoJson('POLYGON ((0 0, 4 0, 4 4, 1 1))'), null);
    assert.strictEqual(wktToGeoJson('CIRCLE EMPTY'), null);
    assert.strictEqual(wktToGeoJson('POINT (1 2) extra'), null);
    assert.strictEqual(wktToGeoJson(''), null);
    assert.strictEqual(wktToGeoJson(null), null);
    assert.strictEqual(wktToGeoJson(42), null);
  });
});

describe('geoJsonToWkt', () => {
  it('should write each geometry type', () => {
    assert.strictEqual(geoJsonToWkt({ type: 'Point', coordinates: [4.9041, 52.3676] }),
      'POINT (4.9041 52.3676)');
    assert.strictEqual(geoJsonToWkt({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }),
      'LINESTRING (0 0, 1 1)');
    assert.strictEqual(geoJsonToWkt({ type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 0]]] }),
      'POLYGON ((0 0, 4 0, 4 4, 0 0))');
    assert.strictEqual(geoJsonToWkt({ type: 'MultiPoint', coordinates: [[0, 0], [1, 1]] }),
      'MULTIPOINT ((0 0), (1 1))',
      'ISO 19125 parenthesizes a point text; both spellings parse back');
    assert.strictEqual(geoJsonToWkt({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] }),
      'MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)))');
    assert.strictEqual(geoJsonToWkt({ type: 'Point', coordinates: [] }), 'POINT EMPTY');
    assert.strictEqual(geoJsonToWkt({ type: 'GeometryCollection', geometries: [] }),
      'GEOMETRYCOLLECTION EMPTY');
  });

  it('should unwrap a Feature, a FeatureCollection and a bare position', () => {
    const point = { type: 'Point', coordinates: [1, 2] };
    assert.strictEqual(geoJsonToWkt({ type: 'Feature', properties: null, geometry: point }),
      'POINT (1 2)');
    assert.strictEqual(geoJsonToWkt({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: null, geometry: point },
        { type: 'Feature', properties: null, geometry: null },
        { type: 'Feature', properties: null, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
      ],
    }), 'GEOMETRYCOLLECTION (POINT (1 2), LINESTRING (0 0, 1 1))',
    'a Feature located nowhere contributes nothing WKT can spell');
    assert.strictEqual(geoJsonToWkt([4.9041, 52.3676]), 'POINT (4.9041 52.3676)');
    assert.strictEqual(geoJsonToWkt({ type: 'FeatureCollection', features: [] }),
      'GEOMETRYCOLLECTION EMPTY');
  });

  it('should write Z only at dim 3, and only where every position carries one', () => {
    const flat = { type: 'LineString', coordinates: [[0, 0], [1, 1]] };
    const raised = { type: 'LineString', coordinates: [[0, 0, 5], [1, 1, 6]] };
    const mixed = { type: 'LineString', coordinates: [[0, 0, 5], [1, 1]] };
    assert.strictEqual(geoJsonToWkt(raised), 'LINESTRING (0 0, 1 1)', 'dim 2 is the default');
    assert.strictEqual(geoJsonToWkt(raised, { dim: 3 }), 'LINESTRING Z (0 0 5, 1 1 6)');
    assert.strictEqual(geoJsonToWkt(flat, { dim: 3 }), 'LINESTRING (0 0, 1 1)');
    assert.strictEqual(geoJsonToWkt(mixed, { dim: 3 }), 'LINESTRING (0 0, 1 1)',
      'one geometry carries one modifier, so a mixed one falls back to 2D');
  });

  it('should let each collection member carry its own modifier', () => {
    // the only place WKT lets the dimension change inside one value
    assert.strictEqual(geoJsonToWkt({
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [1, 2, 3] },
        { type: 'Point', coordinates: [4, 5] },
      ],
    }, { dim: 3 }), 'GEOMETRYCOLLECTION (POINT Z (1 2 3), POINT (4 5))');
  });

  it('should write the shortest round-tripping number spelling', () => {
    const geometry = { type: 'Point', coordinates: [0.1 + 0.2, 1e21] };
    const text = geoJsonToWkt(geometry);
    assert.strictEqual(text, 'POINT (0.30000000000000004 1e+21)');
    assert.deepStrictEqual(wktToGeoJson(text), geometry, 'a fixed precision would move the point');
  });

  it('should answer null for a value with no geometry to write', () => {
    assert.strictEqual(geoJsonToWkt(null), null);
    assert.strictEqual(geoJsonToWkt('POINT (1 2)'), null);
    assert.strictEqual(geoJsonToWkt({ type: 'Circle', coordinates: [0, 0] }), null);
    assert.strictEqual(geoJsonToWkt({ type: 'Feature', properties: null, geometry: null }), null);
    assert.strictEqual(geoJsonToWkt({ type: 'Point', coordinates: [1] }), null);
    assert.strictEqual(geoJsonToWkt({ type: 'Polygon', coordinates: [[]] }), null);
  });

  it('should refuse a non-finite coordinate rather than approximate it', () => {
    assert.strictEqual(geoJsonToWkt({ type: 'Point', coordinates: [NaN, 2] }), null);
    assert.strictEqual(geoJsonToWkt({ type: 'LineString', coordinates: [[0, 0], [Infinity, 1]] }), null);
    assert.strictEqual(geoJsonToWkt({ type: 'Point', coordinates: [1, 2, NaN] }, { dim: 3 }), null);
  });
});

describe('the WKT round trip', () => {
  const parsed = CORPUS.filter((text) => isValidWkt(text)).map((text) => wktToGeoJson(text));
  const finite = (geometry) => positionsOf(geometry)
    .every((position) => position.every((n) => Number.isFinite(n)));
  const writable = parsed.filter(finite);

  it('should parse exactly the language isValidWkt accepts', () => {
    // one walk, two entry points: a string either parses to a geometry
    // or is not WKT, and there is no third answer. A divergence here is
    // a grammar that forked.
    const diverged = CORPUS.filter((text) => isValidWkt(text) !== (wktToGeoJson(text) !== null));
    assert.deepStrictEqual(diverged, []);
  });

  it('should return the same geometry after a write and a re-read', () => {
    assert.ok(writable.length >= 80, `only ${writable.length} geometries under test`);
    for (const geometry of writable) {
      const text = geoJsonToWkt(geometry, { dim: 3 });
      assert.deepStrictEqual(wktToGeoJson(text), geometry, text);
    }
  });

  it('should round-trip a two-dimensional geometry at the default dim', () => {
    const flat = writable.filter((geometry) => positionsOf(geometry)
      .every((position) => position.length === 2));
    assert.ok(flat.length >= 60, `only ${flat.length} flat geometries under test`);
    for (const geometry of flat)
      assert.deepStrictEqual(wktToGeoJson(geoJsonToWkt(geometry)), geometry);
  });

  it('should refuse to write a geometry no WKT number can spell', () => {
    // the parser reads what the text says, so an overflowing exponent
    // parses to Infinity; the writer will not approximate it
    const unwritable = parsed.filter((geometry) => !finite(geometry));
    assert.ok(unwritable.length > 0, 'the corpus carries the overflow case');
    for (const geometry of unwritable)
      assert.strictEqual(geoJsonToWkt(geometry, { dim: 3 }), null);
  });

  it('should not preserve the text, which is the direction that is false', () => {
    // geoJsonToWkt(wktToGeoJson(s)) === s does NOT hold in general:
    // whitespace, the M measure and number spelling are all normalized.
    // Asserting it would be asserting something untrue.
    assert.strictEqual(geoJsonToWkt(wktToGeoJson('point( 1.0  2.0 )')), 'POINT (1 2)');
    assert.strictEqual(geoJsonToWkt(wktToGeoJson('POINT M (1 2 3)')), 'POINT (1 2)');
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
