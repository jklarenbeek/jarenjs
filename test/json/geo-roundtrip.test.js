//@ts-check
/**
 * @file The whole spatial round trip, in one file: a CSV of
 * coordinates becomes a `FeatureCollection`, is judged by the GeoJSON
 * meta-schema, is queried spatially, and leaves as the text a spatial
 * database reads.
 *
 * This is the end-state test the geospatial work is measured by, and
 * every step of it is a claim the suite makes on its own README. The
 * transform is a **stylesheet**, not code: getting a CSV into GeoJSON
 * needs no feature at all, which is the point worth proving rather
 * than asserting.
 *
 * The second half runs the same collection through the store: kept
 * under derived spatial indexes, queried with a `$within` written
 * through `@jarenjs/linq` that seeks the box index and refines exactly,
 * answering what the in-memory chain answers, watched as a geofence,
 * and handed back out as WKT from a stored row. The third executor —
 * the same corpus in a browser tab — is `packages/website/e2e/
 * spatial-agreement.spec.js`, which no Node test can host.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsv } from '@jarenjs/josl';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { queryJson } from '@jarenjs/json/query';
import { JarenValidator } from '@jarenjs/validate';
import { isValidGeoJson } from '@jarenjs/core/geo';
import { from } from '@jarenjs/linq';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV = fs.readFileSync(path.join(__dirname, 'fixtures', 'places.csv'), 'utf8');
const GEOJSON_SCHEMA = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', 'packages', 'json', 'schemas', 'geojson.schema.json'), 'utf8'));

/**
 * CSV rows → a `FeatureCollection`, as a JSLT stylesheet.
 *
 * The trap every reader of this recipe hits, and the reason it is
 * spelled out rather than assumed: `coordinates` and `features` need
 * the **array constructor** (`[…]`, QUERY-FORMAT §3.4). A two-item
 * sequence in member position is `JQ2001` — a sequence is not an
 * array, and the brackets are what make one.
 */
const TO_GEOJSON = [{
  match: '$',
  body: {
    type: 'FeatureCollection',
    features: [{
      $for: { r: '$[*]' },
      $return: {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: ['$r.lon', '$r.lat'] },
        properties: { name: '$r.name', pop: '$r.pop' },
      },
    }],
  },
}];

const REGION = {
  type: 'Polygon',
  coordinates: [[[3.3, 50.7], [7.3, 50.7], [7.3, 53.6], [3.3, 53.6], [3.3, 50.7]]],
};

describe('CSV to GeoJSON to a spatial query and back out as text', () => {
  const rows = parseCsv(CSV, { headers: true, typed: true });
  const collection = compileJsltStylesheet(TO_GEOJSON)(rows);

  it('reads the CSV as typed rows', () => {
    assert.strictEqual(rows.length, 5);
    assert.deepStrictEqual(rows[0], { name: 'Amsterdam', lon: 4.9041, lat: 52.3676, pop: 921402 });
    assert.strictEqual(typeof rows[0].lon, 'number', 'typed:true is what makes a coordinate a number');
  });

  it('transforms to a FeatureCollection with a stylesheet and no code', () => {
    assert.strictEqual(collection.type, 'FeatureCollection');
    assert.strictEqual(collection.features.length, 5);
    assert.deepStrictEqual(collection.features[0], {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [4.9041, 52.3676] },
      properties: { name: 'Amsterdam', pop: 921402 },
    });
  });

  it('refuses the $seq spelling the array constructor replaces', () => {
    // stated as a test rather than a comment because it is the mistake
    // the recipe exists to prevent
    const wrong = [{
      match: '$',
      body: { type: 'Point', coordinates: { $seq: ['$.lon', '$.lat'] } },
    }];
    assert.throws(() => compileJsltStylesheet(wrong)({ lon: 1, lat: 2 }),
      (e) => /JQ2001/.test(e.message));
  });

  it('passes the one-call judgment and the meta-schema alike', () => {
    assert.strictEqual(isValidGeoJson(collection), true);
    const validate = new JarenValidator().compile(GEOJSON_SCHEMA);
    assert.strictEqual(validate(collection), true,
      'the portable GeoJSON meta-schema accepts it');
  });

  it('answers a spatial query over the result', () => {
    const inside = queryJson({
      $for: { f: '$.features[*]' },
      $where: { $within: ['$f.geometry', { $const: REGION }] },
      $orderby: ['$f.properties.name'],
      $return: '$f.properties.name',
    }, collection);
    assert.deepStrictEqual(inside, ['Amsterdam', 'Rotterdam', 'Utrecht'],
      'the three Dutch cities, and not Paris or Berlin');
  });

  it('measures and buckets the result', () => {
    assert.deepStrictEqual(queryJson({ $bbox: '$' }, collection),
      [2.3522, 48.8566, 13.405, 52.52]);
    assert.deepStrictEqual(queryJson({
      $for: { f: '$.features[*]' },
      $groupby: { cell: { $geohash: ['$f.geometry', 2] } },
      $orderby: ['$cell'],
      $return: { cell: '$cell', n: { $count: '$f' } },
    }, collection), [
      { cell: 'u0', n: 1 },
      { cell: 'u1', n: 3 },
      { cell: 'u3', n: 1 },
    ]);
  });

  it('hands one feature back out as the text a database reads', () => {
    assert.strictEqual(
      queryJson({ '$geo-text': '$.features[0].geometry' }, collection),
      'POINT (4.9041 52.3676)');
    // and the whole collection, as one GEOMETRYCOLLECTION
    const text = queryJson({ '$geo-text': '$' }, collection);
    assert.ok(text.startsWith('GEOMETRYCOLLECTION (POINT (4.9041 52.3676), '), text.slice(0, 60));
    // the round trip closes: what went out comes back the same
    assert.deepStrictEqual(
      queryJson({ '$geo-parse': { '$geo-text': '$.features[0].geometry' } }, collection),
      { type: 'Point', coordinates: [4.9041, 52.3676] });
  });

  it('reduces a FeatureCollection for storage, and it is still valid', () => {
    // the need $geo-simplify was admitted for: a value a developer KEEPS
    // — reduced, still structurally whole, still storable
    const routes = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { name: 'the tour', legs: 4 },
        geometry: {
          type: 'LineString',
          coordinates: collection.features.map((f) => f.geometry.coordinates),
        },
      }],
    };
    const positions = { $count: '$.g.features[0].geometry.coordinates[*]' };
    const before = queryJson(positions, { g: routes });
    const after = queryJson({
      $let: { s: { '$geo-simplify': ['$.g', 1] } },
      $return: { $count: '$s.features[0].geometry.coordinates[*]' },
    }, { g: routes });
    assert.strictEqual(before, 5);
    assert.ok(after < before, `${after} positions after, ${before} before`);

    const reduced = queryJson({ '$geo-simplify': ['$.g', 1] }, { g: routes });
    assert.strictEqual(isValidGeoJson(reduced), true);
    assert.strictEqual(new JarenValidator().compile(GEOJSON_SCHEMA)(reduced), true,
      'the meta-schema accepts what came back, so it can be stored as it is');
    assert.deepStrictEqual(reduced.features[0].properties, { name: 'the tour', legs: 4 },
      'the properties ride along — this is the value that went in, with fewer positions');
  });
});

describe('… and through a store with derived spatial indexes, fluently, live, and back out', () => {
  const MODEL = {
    $model: '0.1',
    collections: {
      places: {
        schema: {
          type: 'object',
          properties: {
            type: { type: 'string' }, geometry: { type: 'object' }, properties: { type: 'object' },
          },
        },
        // a live query tracks rows by their document key, so the
        // collection is keyed by the feature's name rather than by rowid
        key: '/properties/name',
        indexes: [
          { name: 'by_box', path: '$.geometry', derive: 'bbox' },
          { name: 'by_cell', path: '$.geometry', derive: 'geohash', precision: 5 },
        ],
      },
    },
  };
  const rows = parseCsv(CSV, { headers: true, typed: true });
  const collection = compileJsltStylesheet(TO_GEOJSON)(rows);
  /** The query, written once through the fluent surface, for any source. */
  const inside = (source) => from(source)
    .params({ region: REGION })
    .where((f, q) => f.geometry.within(q.region))
    .select((f) => f.properties.name);

  const seeded = async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
    const places = store.collection('places');
    for (const feature of collection.features) await places.insert(feature);
    return { store, places };
  };

  it('stores the features, and the linq $within seeks the derived box and refines exactly', async () => {
    const { store, places } = await seeded();
    try {
      const document = inside(places).toDocument();
      assert.deepStrictEqual(document, {
        $for: { it: '$[*]' },
        $where: { $within: ['$it.geometry', '$region'] },
        $return: '$it.properties.name',
      }, 'the chain is data: one query document, the region bound at call time');
      const explained = await places.explain(document, { externals: { region: REGION } });
      assert.deepStrictEqual(explained.prefilters.map((p) => [p.construct, p.exact]), [['$within', false]],
        'the box is pushed as a pre-filter and containment refines in the engine');
      assert.match(explained.scanNarrative, /SEARCH places USING INDEX places_by_box/,
        'the database\'s own plan seeks the derived index');
      const answer = await places.execute(document, { externals: { region: REGION } });
      assert.deepStrictEqual(answer, ['Amsterdam', 'Utrecht', 'Rotterdam']);
      assert.deepStrictEqual(answer, inside(collection.features).toArray(),
        'the store answers what the in-memory chain answers');
    }
    finally {
      await store.close();
    }
  });

  it('watches the region as a geofence: a city inserted inside arrives, one outside does not', async () => {
    const { store, places } = await seeded();
    try {
      const live = await places.live([inside(places).toDocument()], { externals: { region: REGION } });
      const events = [];
      live.subscribe((event) => events.push(event));
      assert.deepStrictEqual(live.result.rows, ['Amsterdam', 'Utrecht', 'Rotterdam']);
      assert.strictEqual(live.mode.strategy, 'rows', 'a refined spatial predicate is maintained per row');
      await places.insert({
        type: 'Feature', geometry: { type: 'Point', coordinates: [5.4697, 51.4416] },
        properties: { name: 'Eindhoven', pop: 238326 },
      });
      await places.insert({
        type: 'Feature', geometry: { type: 'Point', coordinates: [-0.1276, 51.5074] },
        properties: { name: 'London', pop: 8799800 },
      });
      assert.strictEqual(events.length, 1, 'inside emits, outside is silent');
      assert.deepStrictEqual(events[0].patch.map((op) => [op.op, op.value]), [['add', 'Eindhoven']]);
      live.close();
    }
    finally {
      await store.close();
    }
  });

  it('hands a stored feature back out as the text a database reads', async () => {
    const { store, places } = await seeded();
    try {
      const text = await places.execute({
        $for: { it: '$[*]' },
        $where: { $eq: ['$it.properties.name', 'Amsterdam'] },
        $return: { '$geo-text': '$it.geometry' },
      });
      assert.strictEqual(text, 'POINT (4.9041 52.3676)');
    }
    finally {
      await store.close();
    }
  });
});
