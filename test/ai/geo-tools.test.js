//@ts-check
/**
 * @file The geo toolbox: seven tools, each one call into
 * `@jarenjs/core/geo`, each guarded by the shipped GeoJSON meta-schema
 * by reference — and a closed set, so an overlay request is refused with
 * its reason rather than approximated.
 *
 * Three claims are asserted that reading the code cannot settle:
 *
 *  - **A malformed geometry never reaches a tool.** The refusal is the
 *    validator's — `instancePath`'d into the geometry, with the schema
 *    to re-read — and the module has no `try`/`catch` to have caught
 *    anything itself.
 *  - **No arithmetic lives in the package.** The module's imports from
 *    the kernel are the whole of its geometry; a grep for the formulas
 *    a second implementation would need finds nothing.
 *  - **The answers are the kernel's.** Each tool is checked against the
 *    kernel function it delegates to, on the same input.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';

import {
  createGeoToolbox, geoToolDefs, overlayRefusal, GEO_TOOL_NAMES, OVERLAY_TOOL_NAMES,
  GEOJSON_SCHEMA_ID, registerModelContext,
} from '@jarenjs/ai';
import {
  bboxOf, geoDistance, geohashEncode, geohashNeighbours, geoJsonToWkt, wktToGeoJson,
} from '@jarenjs/core/geo';
import geojson from '@jarenjs/json/schemas/geojson.schema.json' with { type: 'json' };

const AMSTERDAM = [4.9041, 52.3676];
const PARIS = { type: 'Point', coordinates: [2.3522, 48.8566] };
const REGION = {
  type: 'Polygon',
  coordinates: [[[3.3, 50.7], [7.3, 50.7], [7.3, 53.6], [3.3, 53.6], [3.3, 50.7]]],
};
const FEATURE = { type: 'Feature', properties: { name: 'Utrecht' }, geometry: { type: 'Point', coordinates: [5.1214, 52.0907] } };

const toolbox = () => createGeoToolbox({ geojson });

describe('ai — the geo toolbox is exactly the seven tools of the design table', function () {
  it('registers the seven, in order, and nothing else', function () {
    assert.deepStrictEqual(toolbox().list().map((t) => t.name), [...GEO_TOOL_NAMES]);
    assert.strictEqual(GEO_TOOL_NAMES.length, 7);
    assert.deepStrictEqual(geoToolDefs().map((d) => d.name), [...GEO_TOOL_NAMES]);
  });

  it('every inputSchema references the shipped meta-schema rather than restating a shape', function () {
    for (const { name, inputSchema } of toolbox().list()) {
      const text = JSON.stringify(inputSchema);
      const geometric = !['geo_neighbours', 'geo_parse_wkt'].includes(name);
      assert.strictEqual(text.includes(`"$ref":"${GEOJSON_SCHEMA_ID}"`), geometric,
        `${name} ${geometric ? 'refers to' : 'takes no geometry, so does not refer to'} the artifact`);
      assert.ok(!text.includes('"coordinates"'),
        `${name} restates no geometry member — the artifact owns the shape`);
    }
  });

  it('refuses an artifact that is not the meta-schema', function () {
    assert.throws(() => createGeoToolbox({ geojson: { $id: 'https://example.test/other' } }), TypeError);
    assert.throws(() => createGeoToolbox(/** @type {any} */ ({})), TypeError);
  });

  it('publishes the same seven over WebMCP', function () {
    /** @type {any[]} */
    let registered = [];
    assert.strictEqual(registerModelContext(toolbox(), {
      provideContext: ({ tools }) => { registered = tools; },
    }), true);
    assert.deepStrictEqual(registered.map((t) => t.name), [...GEO_TOOL_NAMES]);
  });
});

describe('ai — every geo tool delegates to @jarenjs/core/geo (D1)', function () {
  it('geo_distance is the kernel\'s geodesic metres between representative positions', function () {
    const { metres } = toolbox().execute('geo_distance', { a: AMSTERDAM, b: PARIS });
    assert.strictEqual(metres, geoDistance(AMSTERDAM, PARIS));
    assert.ok(metres > 429_000 && metres < 431_000, `Amsterdam–Paris is ~430 km, got ${metres}`);
    // a Feature measures by its geometry's position, like §8.14
    assert.strictEqual(toolbox().execute('geo_distance', { a: FEATURE, b: AMSTERDAM }).metres,
      geoDistance(FEATURE, AMSTERDAM));
  });

  it('geo_within is the kernel\'s containment of the representative position', function () {
    assert.deepStrictEqual(toolbox().execute('geo_within', { value: AMSTERDAM, area: REGION }), { within: true });
    assert.deepStrictEqual(toolbox().execute('geo_within', { value: PARIS, area: REGION }), { within: false });
    // only a surface has an inside: a point as the area is false, not an error
    assert.deepStrictEqual(toolbox().execute('geo_within', { value: AMSTERDAM, area: PARIS }), { within: false });
  });

  it('geo_bbox is the kernel\'s box, [west, south, east, north]', function () {
    assert.deepStrictEqual(toolbox().execute('geo_bbox', { value: REGION }), { bbox: bboxOf(REGION) });
    assert.deepStrictEqual(toolbox().execute('geo_bbox', { value: REGION }).bbox, [3.3, 50.7, 7.3, 53.6]);
  });

  it('geo_geohash is the kernel\'s cell at the asked precision, 9 by default', function () {
    assert.deepStrictEqual(toolbox().execute('geo_geohash', { value: AMSTERDAM, precision: 6 }),
      { cell: geohashEncode(AMSTERDAM[0], AMSTERDAM[1], 6) });
    assert.deepStrictEqual(toolbox().execute('geo_geohash', { value: AMSTERDAM }),
      { cell: geohashEncode(AMSTERDAM[0], AMSTERDAM[1], 9) });
    assert.match(toolbox().execute('geo_geohash', { value: AMSTERDAM, precision: 13 }).error, /invalid input/);
  });

  it('geo_neighbours is the kernel\'s nine cells, the probe D7 requires', function () {
    const cell = geohashEncode(AMSTERDAM[0], AMSTERDAM[1], 6);
    const { cells } = toolbox().execute('geo_neighbours', { cell });
    assert.deepStrictEqual(cells, geohashNeighbours(cell));
    assert.strictEqual(cells.length, 9, 'nine cells away from a pole');
    assert.strictEqual(cells[4], cell, 'the cell itself in the middle, reading order');
    assert.match(toolbox().list().find((t) => t.name === 'geo_neighbours').description, /proximity/,
      'the description says this is the proximity probe');
    assert.match(toolbox().list().find((t) => t.name === 'geo_geohash').description, /bucket/,
      'and the cell tool says a cell is a bucket');
  });

  it('geo_parse_wkt and geo_to_wkt are the kernel\'s one grammar walk, both ways', function () {
    const text = 'POLYGON ((3.3 50.7, 7.3 50.7, 7.3 53.6, 3.3 53.6, 3.3 50.7))';
    assert.deepStrictEqual(toolbox().execute('geo_parse_wkt', { text }), { value: wktToGeoJson(text) });
    assert.deepStrictEqual(toolbox().execute('geo_parse_wkt', { text }).value, REGION);
    assert.deepStrictEqual(toolbox().execute('geo_to_wkt', { value: REGION }), { text: geoJsonToWkt(REGION) });
    assert.deepStrictEqual(toolbox().execute('geo_to_wkt', { value: AMSTERDAM }), { text: 'POINT (4.9041 52.3676)' });
    // text that is not WKT is a content refusal the model can read
    assert.match(toolbox().execute('geo_parse_wkt', { text: 'CIRCLE (1 2 3)' }).error, /not well-formed/);
  });

  it('a value with no positions is refused by the tool with a reason, never a throw', function () {
    const empty = { type: 'FeatureCollection', features: [] };
    assert.match(toolbox().execute('geo_distance', { a: empty, b: AMSTERDAM }).error, /no positions/);
    assert.match(toolbox().execute('geo_within', { value: empty, area: REGION }).error, /inside nothing/);
    assert.match(toolbox().execute('geo_bbox', { value: empty }).error, /no bounding box/);
    assert.match(toolbox().execute('geo_geohash', { value: empty }).error, /no cell/);
  });

  it('has no arithmetic of its own: the kernel imports are the whole of its geometry', function () {
    const source = readFileSync(new URL('../../packages/ai/src/geo-tools.js', import.meta.url), 'utf8');
    for (const formula of ['Math.sin', 'Math.cos', 'Math.atan', 'Math.sqrt', 'Math.hypot', 'Math.PI', '6371', 'Math.pow'])
      assert.ok(!source.includes(formula), `${formula} would be a second implementation`);
    // and the same holds for every file of the package
    const dir = new URL('../../packages/ai/src/', import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      const text = readFileSync(new URL(file, dir), 'utf8');
      for (const formula of ['Math.sin', 'Math.cos', 'Math.atan2', 'haversine', 'toRadians'])
        assert.ok(!text.includes(formula), `${file} carries ${formula}`);
    }
  });
});

describe('ai — a malformed geometry is refused by the validator, not caught', function () {
  it('names the offending position, with the schema to re-read', function () {
    const rejected = toolbox().execute('geo_distance', {
      a: { type: 'Point', coordinates: [200, 0] }, b: AMSTERDAM,
    });
    assert.strictEqual(rejected.error, 'invalid input for geo_distance');
    assert.ok(rejected.errors.some((e) => e.instancePath === '/a/coordinates/0' && e.keyword === 'maximum'),
      `the validator points into the geometry: ${JSON.stringify(rejected.errors)}`);
    assert.ok(rejected.inputSchema !== undefined, 'the schema rides along');
  });

  it('refuses a ring that is too short, a wrong type, a bare number', function () {
    const short = { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] };
    assert.match(toolbox().execute('geo_bbox', { value: short }).error, /invalid input/);
    assert.match(toolbox().execute('geo_bbox', { value: { type: 'Circle', coordinates: [0, 0] } }).error, /invalid input/);
    assert.match(toolbox().execute('geo_bbox', { value: 12 }).error, /invalid input/);
    assert.match(toolbox().execute('geo_neighbours', { cell: 'u17a' }).error, /invalid input/,
      "'a' is not in the base-32 alphabet");
  });

  it('the module catches nothing itself', function () {
    const source = readFileSync(new URL('../../packages/ai/src/geo-tools.js', import.meta.url), 'utf8');
    assert.ok(!/\btry\s*\{/.test(source), 'no try/catch: the validator is the boundary');
  });
});

describe('ai — no overlay, by refusal (D11)', function () {
  it('answers every overlay name with the reason, not "unknown tool"', function () {
    for (const name of OVERLAY_TOOL_NAMES) {
      const answer = toolbox().execute(name, { a: REGION, b: REGION });
      assert.strictEqual(answer.error, overlayRefusal(name));
      assert.match(answer.error, /not offered/);
      assert.match(answer.error, /JSTS/);
      assert.ok(!GEO_TOOL_NAMES.includes(name));
    }
  });

  it('computes no union, intersection, difference or buffer under any name', function () {
    const names = toolbox().list().map((t) => t.name);
    for (const word of ['union', 'intersect', 'difference', 'buffer', 'clip'])
      assert.ok(!names.some((n) => n.includes(word)), `no tool named for ${word}`);
    assert.deepStrictEqual(toolbox().execute('geo_simplify', {}), { error: "unknown tool 'geo_simplify'" },
      'a name outside both sets is still unknown');
  });
});
