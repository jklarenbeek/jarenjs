import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JarenValidator } from '@jarenjs/validate';
import {
  deriveGeoJsonInvariants,
  downlevelDraft07,
  draftNeutralSubsetViolations,
} from './schema-artifact-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.join(__dirname, '..', '..', 'packages', 'json', 'schemas');
const load = (name) => JSON.parse(fs.readFileSync(path.join(schemasDir, name), 'utf8'));

const canonical = load('geojson.schema.json');
const jaren = load('geojson.jaren.schema.json');
const draft07 = load('geojson.draft-07.schema.json');

const compile = (schema) => new JarenValidator().compile(schema);
const portable = compile(canonical);
const strict = compile(jaren);

// Polygons that are structurally perfect and geometrically wrong. Each is
// a defect JSON Schema provably cannot describe.
const RING_DEFECTS = {
  'an unclosed exterior ring': {
    type: 'Polygon',
    coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]],
  },
  'an exterior ring wound clockwise': {
    type: 'Polygon',
    coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
  },
  'a hole wound counter-clockwise': {
    type: 'Polygon',
    coordinates: [
      [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
      [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]],
    ],
  },
  'an unclosed hole': {
    type: 'Polygon',
    coordinates: [
      [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
      [[1, 1], [1, 3], [3, 3], [3, 1]],
    ],
  },
  'a backwards MultiPolygon member': {
    type: 'MultiPolygon',
    coordinates: [[[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]],
  },
  'a defective polygon inside a FeatureCollection': {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] },
    }],
  },
};

const WELL_FORMED = {
  'a point': { type: 'Point', coordinates: [4.9041, 52.3676] },
  'a point with altitude': { type: 'Point', coordinates: [4.9041, 52.3676, 12] },
  'a line': { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
  'a polygon': { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
  'a polygon with a hole': {
    type: 'Polygon',
    coordinates: [
      [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
      [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]],
    ],
  },
  'a multipolygon': { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]] },
  'a geometry collection': {
    type: 'GeometryCollection',
    geometries: [{ type: 'Point', coordinates: [0, 0] }],
  },
  'a feature with a null geometry': { type: 'Feature', geometry: null, properties: null },
  'a feature collection': {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }],
  },
};

describe('the GeoJSON artifacts', () => {
  it('should keep the portable artifact inside the draft-neutral subset', () => {
    assert.deepStrictEqual(draftNeutralSubsetViolations(canonical), []);
  });

  it('should derive the Jaren artifact mechanically from the portable one', () => {
    assert.deepStrictEqual(jaren, deriveGeoJsonInvariants(canonical),
      'geojson.jaren.schema.json must equal deriveGeoJsonInvariants(canonical)');
  });

  it('should derive the draft-07 twin mechanically', () => {
    assert.deepStrictEqual(draft07, downlevelDraft07(canonical),
      'geojson.draft-07.schema.json must equal downlevelDraft07(canonical)');
  });

  it('should fail loudly when the pinned derivation contract changes', () => {
    assert.throws(() => deriveGeoJsonInvariants({}), /missing object \$defs/);
    assert.throws(() => deriveGeoJsonInvariants({ $defs: {} }), /missing \$defs\.polygon/);
    assert.throws(
      () => deriveGeoJsonInvariants({ $defs: { polygon: { $query: true }, multiPolygon: {} } }),
      /polygon\.\$query already exists/);
  });

  it('should differ from the portable artifact only in the two $query members', () => {
    // structural drift between the two would be a bug: the Jaren artifact
    // is a pure restriction, not a fork
    const stripped = structuredClone(jaren);
    delete stripped.$defs.polygon.$query;
    delete stripped.$defs.multiPolygon.$query;
    stripped.$id = canonical.$id;
    stripped.title = canonical.title;
    stripped.description = canonical.description;
    assert.deepStrictEqual(stripped, canonical);
  });
});

describe('GeoJSON structural validation (portable)', () => {
  it('should accept every well-formed shape', () => {
    for (const [name, doc] of Object.entries(WELL_FORMED))
      assert.strictEqual(portable(doc), true, name);
  });

  it('should reject structural errors', () => {
    const bad = {
      'an unknown geometry type': { type: 'Circle', coordinates: [0, 0] },
      'a stray member': { type: 'Point', coordinates: [0, 0], crs: 'EPSG:4326' },
      'a one-position line': { type: 'LineString', coordinates: [[0, 0]] },
      'a three-position ring': { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] },
      'a feature without properties': { type: 'Feature', geometry: null },
      'a position with one number': { type: 'Point', coordinates: [0] },
    };
    for (const [name, doc] of Object.entries(bad))
      assert.strictEqual(portable(doc), false, name);
  });

  it('should bound coordinates to the fixed WGS 84 reference system', () => {
    assert.strictEqual(portable({ type: 'Point', coordinates: [181, 0] }), false, 'longitude');
    assert.strictEqual(portable({ type: 'Point', coordinates: [0, 91] }), false, 'latitude');
    assert.strictEqual(portable({ type: 'Point', coordinates: [-180, -90] }), true, 'the corners');
  });
});

describe('the invariants JSON Schema cannot express', () => {
  it('should be invisible to the portable artifact — this is the gap', () => {
    // Not a shortcoming of this schema: the official GeoJSON JSON Schema
    // states the same limitation. Ring closure and winding are not
    // structural properties, so no amount of plain JSON Schema reaches
    // them, and every validator in the ecosystem bolts on custom code.
    for (const [name, doc] of Object.entries(RING_DEFECTS)) {
      assert.strictEqual(portable(doc), true,
        `${name} should slip past structural validation, or this test is not testing the gap`);
    }
  });

  it('should be caught by the Jaren artifact — this is the wedge', () => {
    for (const [name, doc] of Object.entries(RING_DEFECTS))
      assert.strictEqual(strict(doc), false, name);
  });

  it('should not cost a well-formed document its validity', () => {
    for (const [name, doc] of Object.entries(WELL_FORMED))
      assert.strictEqual(strict(doc), true, name);
  });

  it('should accept a polygon with several correctly wound holes', () => {
    assert.strictEqual(strict({
      type: 'Polygon',
      coordinates: [
        [[0, 0], [9, 0], [9, 9], [0, 9], [0, 0]],
        [[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]],
        [[5, 5], [5, 6], [6, 6], [6, 5], [5, 5]],
      ],
    }), true);
  });

  it('should report where the failure is', () => {
    const collecting = new JarenValidator({ skipErrors: false, collectErrors: true });
    const validate = collecting.compile(jaren);
    const result = validate(RING_DEFECTS['an unclosed exterior ring']);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length > 0, 'a failure must carry at least one error');
  });
});
