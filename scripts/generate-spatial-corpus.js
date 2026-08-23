#!/usr/bin/env node
//@ts-check
/**
 * The spatial corpus: one committed list of `{ name, data, query }` cases
 * with the answer the JavaScript engine gives, written into
 * `test/json/fixtures/spatial-corpus.json`.
 *
 * Why generated rather than typed: the fixture's job is to be an ORACLE.
 * A second executor — a spatial predicate pushed to SQLite, the same
 * query in a browser tab through the wasm driver — asserts it returns
 * exactly what this file records, so a divergence names which executor
 * moved. Hand-typing the answers would make the file a second engine to
 * maintain, and the first typo would be indistinguishable from a bug.
 *
 * The runner (`test/json/query/spatial-corpus.test.js`) re-runs every
 * entry in `npm test` and fails on any disagreement, so regenerating is
 * a deliberate act with a visible diff, never a silent refresh.
 *
 *   node scripts/generate-spatial-corpus.js           # check, exit 1 on drift
 *   node scripts/generate-spatial-corpus.js --write   # rewrite the fixture
 *
 * An entry carries `expected` OR `empty: true` — JSON cannot spell the
 * empty sequence, and `null` is a legitimate answer that must stay
 * distinguishable from "no answer". An entry whose answer no second
 * executor could produce (a WKT string is text this engine writes)
 * carries `executors: ["engine"]`, so a later order skips it explicitly
 * rather than by accident.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { queryJson } from '@jarenjs/json/query';

const OUT = fileURLToPath(new URL('../test/json/fixtures/spatial-corpus.json', import.meta.url));

//#region shared geography

/** A 1-degree box over the western Netherlands, with a square hole. */
const REGION = {
  type: 'Polygon',
  coordinates: [
    [[4, 52], [5, 52], [5, 53], [4, 53], [4, 52]],
    [[4.4, 52.4], [4.6, 52.4], [4.6, 52.6], [4.4, 52.6], [4.4, 52.4]],
  ],
};
const SIMPLE = { type: 'Polygon', coordinates: [[[4, 52], [5, 52], [5, 53], [4, 53], [4, 52]]] };
const FAR = { type: 'Polygon', coordinates: [[[10, 40], [11, 40], [11, 41], [10, 41], [10, 40]]] };
const MULTI = {
  type: 'MultiPolygon',
  coordinates: [
    [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
    [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]],
  ],
};
const LINE = { type: 'LineString', coordinates: [[4, 52], [5, 52], [5, 53]] };
const AMS = [4.9041, 52.3676];
const PAR = [2.3522, 48.8566];
const UTR = [5.1214, 52.0907];
const FEATURE = { type: 'Feature', properties: { name: 'region' }, geometry: SIMPLE };
const COLLECTION = { type: 'FeatureCollection', features: [FEATURE] };
const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] };
const CITIES = [
  { name: 'Amsterdam', at: AMS },
  { name: 'Paris', at: PAR },
  { name: 'Utrecht', at: UTR },
];
/** NaN is not a JSON number, so a non-finite coordinate is COMPUTED. */
const NAN = { $div: [0, 0] };

//#endregion

/** @type {Array<{name: string, data: any, query: any, note: string, executors?: string[]}>} */
const ENTRIES = [
  // -- containment -----------------------------------------------------
  { name: 'within/inside', data: { at: AMS, region: SIMPLE }, query: { $within: ['$.at', '$.region'] },
    note: 'the ordinary case: a point inside a polygon' },
  { name: 'within/outside', data: { at: PAR, region: SIMPLE }, query: { $within: ['$.at', '$.region'] },
    note: 'a point outside it' },
  { name: 'within/on-an-edge', data: { at: [4.5, 52], region: SIMPLE }, query: { $within: ['$.at', '$.region'] },
    note: 'the boundary counts as inside — stated so the answer is not an accident of the crossing count' },
  { name: 'within/on-a-vertex', data: { at: [4, 52], region: SIMPLE }, query: { $within: ['$.at', '$.region'] },
    note: 'a corner is on the boundary too' },
  { name: 'within/in-a-hole', data: { at: [4.5, 52.5], region: REGION }, query: { $within: ['$.at', '$.region'] },
    note: 'inside the exterior ring but inside a hole: not in the surface' },
  { name: 'within/in-the-ring-body', data: { at: [4.2, 52.2], region: REGION }, query: { $within: ['$.at', '$.region'] },
    note: 'the same polygon, outside the hole' },
  { name: 'within/multipolygon-second-part', data: { at: [10.5, 10.5], region: MULTI }, query: { $within: ['$.at', '$.region'] },
    note: 'containment is over every part, not the first' },
  { name: 'within/a-point-has-no-inside', data: { a: AMS, b: AMS }, query: { $within: ['$.a', '$.b'] },
    note: 'only a surface has an inside; a point against itself is false, not true' },
  { name: 'within/a-line-has-no-inside', data: { at: [4.5, 52], line: LINE }, query: { $within: ['$.at', '$.line'] },
    note: 'the same rule for a line' },
  { name: 'within/a-collection-surface', data: { at: AMS, region: COLLECTION }, query: { $within: ['$.at', '$.region'] },
    note: 'a FeatureCollection is unwrapped, and its features supply the surfaces' },
  { name: 'within/an-unclosed-ring-still-answers', data: { at: [1, 1], region: { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4]]] } },
    query: { $within: ['$.at', '$.region'] },
    note: 'the division of labour: traversal treats a ring as implicitly closed and isValidGeoJson is what refuses it' },

  // -- boxes -----------------------------------------------------------
  { name: 'bbox/polygon', data: { g: SIMPLE }, query: { $bbox: '$.g' }, note: 'west, south, east, north' },
  { name: 'bbox/point', data: { g: AMS }, query: { $bbox: '$.g' }, note: 'a position bounds itself' },
  { name: 'bbox/linestring', data: { g: LINE }, query: { $bbox: '$.g' }, note: '' },
  { name: 'bbox/feature', data: { g: FEATURE }, query: { $bbox: '$.g' }, note: 'the wrapper is unwrapped' },
  { name: 'bbox/collection', data: { g: COLLECTION }, query: { $bbox: '$.g' }, note: '' },
  { name: 'bbox/empty-collection', data: { g: EMPTY_COLLECTION }, query: { $bbox: '$.g' },
    note: 'no positions, no box — empty rather than a null-member array' },
  { name: 'bbox/antimeridian-uncut', data: { g: { type: 'LineString', coordinates: [[179, 0], [-179, 0]] } },
    query: { $bbox: '$.g' },
    note: 'RFC 7946 tells producers to CUT at the antimeridian; an uncut geometry gets a box spanning the globe the wrong way, and this pins that posture' },
  { name: 'bbox-intersects/overlapping', data: { a: SIMPLE, b: { type: 'Polygon', coordinates: [[[4.5, 52.5], [6, 52.5], [6, 54], [4.5, 54], [4.5, 52.5]]] } },
    query: { '$bbox-intersects': ['$.a', '$.b'] }, note: '' },
  { name: 'bbox-intersects/touching-edges', data: { a: SIMPLE, b: { type: 'Polygon', coordinates: [[[5, 52], [6, 52], [6, 53], [5, 53], [5, 52]]] } },
    query: { '$bbox-intersects': ['$.a', '$.b'] }, note: 'touching counts as overlap' },
  { name: 'bbox-intersects/disjoint', data: { a: SIMPLE, b: FAR },
    query: { '$bbox-intersects': ['$.a', '$.b'] }, note: '' },
  { name: 'bbox-intersects/one-inside-another', data: { a: { type: 'Polygon', coordinates: [[[4.2, 52.2], [4.3, 52.2], [4.3, 52.3], [4.2, 52.2]]] }, b: SIMPLE },
    query: { '$bbox-intersects': ['$.a', '$.b'] }, note: '' },
  { name: 'bbox-intersects/boxes-overlap-but-shapes-do-not', data: {
    a: { type: 'Polygon', coordinates: [[[0, 0], [3, 0], [3, 1], [0, 1], [0, 0]]] },
    b: { type: 'Polygon', coordinates: [[[0, 2], [3, 2], [3, 3], [0, 3], [0, 2]]] } },
    query: { '$bbox-intersects': ['$.a', '$.b'] },
    note: 'these boxes do NOT overlap; the operator is named for the box precisely so this can never be read as real intersection' },

  // -- measurement -----------------------------------------------------
  { name: 'distance/amsterdam-paris', data: { a: AMS, b: PAR }, query: { $distance: ['$.a', '$.b'] },
    note: 'metres on the WGS 84 sphere' },
  { name: 'distance/a-point-to-itself', data: { a: AMS }, query: { $distance: ['$.a', '$.a'] }, note: '' },
  { name: 'distance/point-to-polygon-centroid', data: { a: AMS, b: SIMPLE }, query: { $distance: ['$.a', '$.b'] },
    note: 'a non-position is measured by its representative position, which is its centroid' },
  { name: 'distance/in-kilometres', data: { a: AMS, b: PAR }, query: { $idiv: [{ $distance: ['$.a', '$.b'] }, 1000] },
    note: 'conversion is ordinary arithmetic, not an option' },
  { name: 'area/polygon', data: { g: SIMPLE }, query: { $area: '$.g' }, note: 'square metres' },
  { name: 'area/exterior-less-holes', data: { g: REGION }, query: { $area: '$.g' },
    note: 'the hole is subtracted, so this is smaller than the simple box' },
  { name: 'area/multipolygon-sums-parts', data: { g: MULTI }, query: { $area: '$.g' }, note: '' },
  { name: 'area/a-line-has-no-surface', data: { g: LINE }, query: { $area: '$.g' },
    note: 'zero, not empty and not an error' },
  { name: 'area/empty-collection', data: { g: EMPTY_COLLECTION }, query: { $area: '$.g' },
    note: 'no positions is not the same as a non-finite one: this still measures' },
  { name: 'area/collection-ignores-its-points', data: { g: { type: 'FeatureCollection', features: [FEATURE, { type: 'Feature', properties: null, geometry: { type: 'Point', coordinates: AMS } }] } },
    query: { $area: '$.g' }, note: 'the sum over the surfaces only' },
  { name: 'length/linestring', data: { g: LINE }, query: { $length: '$.g' }, note: 'metres' },
  { name: 'length/ring-perimeter', data: { g: SIMPLE }, query: { $length: '$.g' }, note: '' },
  { name: 'length/a-point-has-no-length', data: { g: AMS }, query: { $length: '$.g' }, note: '' },
  { name: 'centroid/polygon', data: { g: SIMPLE }, query: { $centroid: '$.g' },
    note: 'the mean of the positions, NOT the area-weighted centre of mass' },
  { name: 'centroid/multipoint', data: { g: { type: 'MultiPoint', coordinates: [[0, 0], [2, 0], [1, 3]] } },
    query: { $centroid: '$.g' }, note: '' },
  { name: 'centroid/empty-collection', data: { g: EMPTY_COLLECTION }, query: { $centroid: '$.g' },
    note: 'no positions, no mean' },

  // -- filtering, ordering, grouping: the shapes this exists for -------
  { name: 'filter/cities-within-a-region', data: { cities: CITIES, region: SIMPLE },
    query: { $for: { c: '$.cities[*]' }, $where: { $within: ['$c.at', '$.region'] }, $return: '$c.name' },
    note: 'a spatial filter in the language own clause' },
  { name: 'order/by-distance-from-a-point', data: { cities: CITIES, here: AMS },
    query: { $for: { c: '$.cities[*]' }, $orderby: [{ $key: { $distance: ['$c.at', '$.here'] } }], $return: '$c.name' },
    note: 'a spatial sort' },
  { name: 'group/by-geohash-cell', data: { cities: CITIES },
    query: { $for: { c: '$.cities[*]' }, $groupby: { cell: { $geohash: ['$c.at', 3] } }, $orderby: ['$cell'],
      $return: { cell: '$cell', names: { '$string-join': ['$c.name', '+'] } } },
    note: 'bucketing on a prefix: what a geohash IS for' },
  { name: 'join/nested-within', data: { cities: CITIES, regions: [{ id: 'nl', shape: SIMPLE }, { id: 'far', shape: FAR }] },
    query: { $for: { r: '$.regions[*]' }, $return: { id: '$r.id',
      inside: [{ $for: { c: '$.cities[*]' }, $where: { $within: ['$c.at', '$r.shape'] }, $return: '$c.name' }] } },
    note: 'the spatial-join shape the planner probes a box index for' },

  // -- geohash ---------------------------------------------------------
  { name: 'geohash/encode-default-precision', data: { at: AMS }, query: { $geohash: ['$.at'] },
    note: 'precision 9 unless asked otherwise' },
  { name: 'geohash/encode-precision-5', data: { at: AMS }, query: { $geohash: ['$.at', 5] }, note: '' },
  { name: 'geohash/a-shape-is-its-centroid', data: { g: SIMPLE }, query: { $geohash: ['$.g', 3] }, note: '' },
  { name: 'geohash/at-the-pole', data: { at: [0, 90] }, query: { $geohash: ['$.at', 12] },
    note: 'the top-edge cell, not an error' },
  { name: 'geohash-bounds/a-cell-becomes-a-polygon', data: { c: 'u173z' }, query: { '$geohash-bounds': '$.c' },
    note: 'the crossing back: a cell string becomes a value the rest of the family measures' },
  { name: 'geohash-bounds/round-trips-through-its-own-centre', data: { c: 'u173z' },
    query: { $geohash: [{ '$geohash-bounds': '$.c' }, 5] },
    note: 'encode(bounds(c)) === c — the round trip $geohash alone could not close' },
  { name: 'geohash-bounds/contains-the-point-it-came-from', data: { at: AMS },
    query: { $within: ['$.at', { '$geohash-bounds': { $geohash: ['$.at', 7] } }] }, note: '' },
  { name: 'geohash-bounds/outside-the-alphabet', data: { c: 'u17a' }, query: { '$geohash-bounds': '$.c' },
    note: 'a, i, l and o are not in the base-32 alphabet' },
  { name: 'geohash-neighbours/nine-cells-in-reading-order', data: { c: 'u173z' }, query: { '$geohash-neighbours': '$.c' },
    note: 'north-west first, the cell itself in the middle' },
  { name: 'geohash-neighbours/across-a-level-1-boundary', data: { here: [-0.00007, 51.4779], there: [0.00007, 51.4779] },
    query: { $exists: { '$index-of': [{ '$geohash-neighbours': { $geohash: ['$.here', 6] } }, { $geohash: ['$.there', 6] }] } },
    note: 'Greenwich: two points 9.7 m apart whose cells differ in the FIRST character, and the neighbourhood still finds them' },
  { name: 'geohash-neighbours/a-single-prefix-misses-it', data: { here: [-0.00007, 51.4779], there: [0.00007, 51.4779] },
    query: { '$starts-with': [{ $geohash: ['$.there', 9] }, { $geohash: ['$.here', 6] }] },
    note: 'the same pair through a prefix test: false. This is why a prefix is bucketing and never proximity' },
  { name: 'geohash-neighbours/across-the-antimeridian', data: { at: [179.999, 0] },
    query: { '$geohash-neighbours': { $geohash: ['$.at', 5] } },
    note: 'longitude wraps, so the neighbourhood spans the date line' },
  { name: 'geohash-neighbours/at-the-pole-there-are-fewer', data: { at: [0, 90] },
    query: { $count: { '$geohash-neighbours': { $geohash: ['$.at', 5] } } },
    note: 'cells past a pole do not exist, so the sequence is shorter than nine' },
  { name: 'geohash-neighbours/outside-the-alphabet', data: { c: 'u17a' }, query: { '$geohash-neighbours': '$.c' },
    note: '' },

  // -- conversion ------------------------------------------------------
  { name: 'geo-parse/point', data: { w: 'POINT (4.9041 52.3676)' }, query: { '$geo-parse': '$.w' }, note: '' },
  { name: 'geo-parse/polygon', data: { w: 'POLYGON ((4 52, 5 52, 5 53, 4 53, 4 52))' }, query: { '$geo-parse': '$.w' },
    note: 'the shape every ST_AsText emits' },
  { name: 'geo-parse/multipolygon', data: { w: 'MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((5 5, 6 5, 6 6, 5 5)))' },
    query: { '$geo-parse': '$.w' }, note: '' },
  { name: 'geo-parse/geometrycollection', data: { w: 'GEOMETRYCOLLECTION (POINT (1 2), LINESTRING (0 0, 1 1))' },
    query: { '$geo-parse': '$.w' }, note: 'geometries, not coordinates' },
  { name: 'geo-parse/empty-is-not-null', data: { w: 'POINT EMPTY' }, query: { '$geo-parse': '$.w' },
    note: 'an empty coordinate array: unparseable and validly empty are different answers' },
  { name: 'geo-parse/the-measure-dimension-is-dropped', data: { w: 'POINT ZM (1 2 3 4)' }, query: { '$geo-parse': '$.w' },
    note: 'Z is an altitude and is kept; M is a measure and has no place in a GeoJSON position' },
  { name: 'geo-parse/malformed', data: { w: 'POLYGON ((0 0, 4 0, 4 4, 1 1))' }, query: { '$geo-parse': '$.w' },
    note: 'an open ring is not WKT — empty, not an error' },
  { name: 'geo-parse/not-one-of-the-seven-tags', data: { w: 'CIRCLE EMPTY' }, query: { '$geo-parse': '$.w' }, note: '' },
  { name: 'geo-parse/then-measure-it', data: { w: 'POLYGON ((4 52, 5 52, 5 53, 4 53, 4 52))' },
    query: { $bbox: { '$geo-parse': '$.w' } },
    note: 'the point of the operator: a database string becomes measurable in one expression' },
  { name: 'geo-parse/then-test-containment', data: { w: 'POLYGON ((4 52, 5 52, 5 53, 4 53, 4 52))', at: AMS },
    query: { $within: ['$.at', { '$geo-parse': '$.w' }] }, note: '' },
  { name: 'geo-text/point', data: { g: AMS }, query: { '$geo-text': '$.g' }, note: '', executors: ['engine'] },
  { name: 'geo-text/polygon', data: { g: SIMPLE }, query: { '$geo-text': '$.g' }, note: '', executors: ['engine'] },
  { name: 'geo-text/a-feature-writes-its-geometry', data: { g: FEATURE }, query: { '$geo-text': '$.g' },
    note: 'the unwrapping posture, in the writing direction', executors: ['engine'] },
  { name: 'geo-text/a-collection-writes-a-geometrycollection', data: { g: COLLECTION }, query: { '$geo-text': '$.g' },
    note: '', executors: ['engine'] },
  { name: 'geo-text/round-trip-through-the-language', data: { w: 'POLYGON ((4 52, 5 52, 5 53, 4 53, 4 52))' },
    query: { '$geo-text': { '$geo-parse': '$.w' } },
    note: 'parse then write: the text direction that DOES hold for a normalized string', executors: ['engine'] },
  { name: 'geo-text/a-non-finite-coordinate-has-no-spelling', data: {},
    query: { '$geo-text': [NAN, 0] },
    note: 'a value that cannot be written is not written approximately', executors: ['engine'] },

  // -- simplification --------------------------------------------------
  { name: 'geo-simplify/a-line-keeps-both-endpoints', data: { g: { type: 'LineString', coordinates: [[0, 0], [1, 0.0001], [2, 0], [2, 2]] } },
    query: { '$geo-simplify': ['$.g', 0.01] }, note: 'the middle vertex is on the run and goes; the ends never do' },
  { name: 'geo-simplify/a-ring-stays-closed', data: { g: { type: 'Polygon', coordinates: [[[0, 0], [1, 0.0001], [2, 0], [2, 2], [0, 2], [0, 0]]] } },
    query: { '$geo-simplify': ['$.g', 0.01] }, note: 'simplification can never turn a valid polygon into an invalid one' },
  { name: 'geo-simplify/a-ring-too-small-to-reduce-is-returned-whole', data: { g: { type: 'Polygon', coordinates: [[[0, 0], [1, 0.0001], [2, 0], [0, 0]]] } },
    query: { '$geo-simplify': ['$.g', 5] }, note: 'a ring needs four positions to bound a surface, so it is kept rather than made degenerate' },
  { name: 'geo-simplify/a-collection-keeps-its-properties', data: { g: { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { name: 'route', id: 7 }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 0.0001], [2, 0]] } }] } },
    query: { '$geo-simplify': ['$.g', 0.01] }, note: 'the value that comes back is the value that went in, with fewer positions — so it can be stored or sent as-is' },
  { name: 'geo-simplify/a-point-has-nothing-to-drop', data: { g: AMS }, query: { '$geo-simplify': ['$.g', 1] }, note: '' },
  { name: 'geo-simplify/a-zero-tolerance-changes-nothing', data: { g: LINE }, query: { '$geo-simplify': ['$.g', 0] }, note: '' },
  { name: 'geo-simplify/the-vertex-count-drops', data: { g: { type: 'LineString', coordinates: [[0, 0], [1, 0.0001], [2, 0], [3, 0.0001], [4, 0]] } },
    query: { $let: { s: { '$geo-simplify': ['$.g', 0.01] } }, $return: { $count: '$s.coordinates[*]' } },
    note: 'five positions in, two out — the reduction a developer stores, counted through the language rather than asserted' },
  { name: 'geo-simplify/the-vertex-count-before', data: { g: { type: 'LineString', coordinates: [[0, 0], [1, 0.0001], [2, 0], [3, 0.0001], [4, 0]] } },
    query: { $count: '$.g.coordinates[*]' }, note: 'the same value unsimplified, for the comparison the entry above is half of' },

  // -- the non-finite rule ---------------------------------------------
  { name: 'non-finite/bbox-is-empty', data: {}, query: { $bbox: [NAN, 0] },
    note: 'a box that does not bound its input is worse than no box' },
  { name: 'non-finite/distance-is-empty', data: { b: AMS }, query: { $distance: [[NAN, 0], '$.b'] },
    note: 'a great-circle distance from NaN comes back as the antipodal distance, so the operator answers empty instead' },
  { name: 'non-finite/centroid-is-empty', data: {}, query: { $centroid: [NAN, 0] }, note: '' },
  { name: 'non-finite/geohash-is-empty', data: {}, query: { $geohash: [[NAN, 0]] },
    note: 'without this the cell string is plausible and wrong' },
  { name: 'non-finite/within-is-false', data: { region: SIMPLE }, query: { $within: [[NAN, 0], '$.region'] },
    note: 'a predicate answers its own missing-operand value, not empty' },
  { name: 'non-finite/bbox-intersects-is-false', data: { region: SIMPLE }, query: { '$bbox-intersects': [[NAN, 0], '$.region'] },
    note: '' },
];

function build() {
  const seen = new Set();
  return ENTRIES.map((entry) => {
    if (seen.has(entry.name))
      throw new Error(`duplicate corpus entry name '${entry.name}'`);
    seen.add(entry.name);
    const answer = queryJson(entry.query, entry.data);
    /** @type {any} */
    const out = { name: entry.name, note: entry.note, data: entry.data, query: entry.query };
    if (entry.executors !== undefined)
      out.executors = entry.executors;
    if (answer === undefined)
      out.empty = true;
    else
      out.expected = answer;
    return out;
  });
}

const corpus = build();
const text = `${JSON.stringify(corpus, null, 2)}\n`;
if (process.argv.includes('--write')) {
  writeFileSync(OUT, text);
  console.log(`spatial corpus: ${corpus.length} entries written to ${OUT}`);
}
else {
  const current = readFileSync(OUT, 'utf8');
  if (current === text) {
    console.log(`spatial corpus: ${corpus.length} entries, the committed fixture agrees.`);
  }
  else {
    console.error('spatial corpus: the committed fixture does not match what the engine answers now.');
    console.error('Run `node scripts/generate-spatial-corpus.js --write` and read the diff before keeping it.');
    process.exitCode = 1;
  }
}
