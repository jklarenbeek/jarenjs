//@ts-check
/** Host-owned starting documents and worked spatial example. */
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { parseCsv } from '@jarenjs/josl';
import { JarenValidator } from '@jarenjs/validate';
import { from } from '@jarenjs/linq';
import { compileChart } from '@jarenjs/charts';
import { getFormatInfo } from '@jarenjs/forms';
import { OUR_SCHEMA_OPTIONS } from '../lib/schema-options.js';
import geojsonSchema from '@jarenjs/json/schemas/geojson.schema.json' with { type: 'json' };

/** The seed model the page boots with (editable in the left pane). */
export const DATA_MODEL = {
  $model: '0.1',
  collections: {
    notes: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          points: { type: 'integer' },
        },
      },
      key: '/id',
      indexes: [{ name: 'by_points', path: '$.points' }],
    },
  },
};

/** The seed query (editable in the middle pane). The bare FLWOR
 * (not an array pack) plans natively, so `explain()` shows the
 * by_points index the pushdown chose — the whole point of the pane. */
export const DATA_QUERY = {
  $for: { it: '$[*]' },
  $where: { $gt: ['$it.points', 10] },
  $return: '$it',
};

export const SEEDS = [
  { id: 'n1', title: 'first note', points: 5 },
  { id: 'n2', title: 'important', points: 40 },
  { id: 'n3', title: 'urgent', points: 25 },
];

//#region the spatial round trip — CSV to a map, in this tab

/**
 * The CSV the round trip starts from: five cities, three of them inside
 * the region below. The same rows the repository's own round-trip test
 * reads, so what the page shows is what the suite proves.
 */
export const TRIP_CSV = [
  'name,lon,lat,pop',
  'Amsterdam,4.9041,52.3676,921402',
  'Utrecht,5.1214,52.0907,361699',
  'Rotterdam,4.4777,51.9244,651446',
  'Paris,2.3522,48.8566,2102650',
  'Berlin,13.4050,52.5200,3677472',
].join('\n');

/**
 * CSV rows → a `FeatureCollection`, as a JSLT stylesheet and no code.
 * `coordinates` and `features` need the ARRAY CONSTRUCTOR (`[…]`): a
 * two-item sequence in member position is `JQ2001`, and the brackets
 * are what make an array of it.
 */
export const TRIP_STYLESHEET = [{
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

/** The region the query asks about: a box over the Netherlands. */
export const TRIP_REGION = {
  type: 'Polygon',
  coordinates: [[[3.3, 50.7], [7.3, 50.7], [7.3, 53.6], [3.3, 53.6], [3.3, 50.7]]],
};

/** The collection the features are stored in. */
export const TRIP_COLLECTION = 'places';

/**
 * The model the throwaway store opens on: one collection of Features,
 * keyed by rowid, with BOTH derived spatial index kinds over the
 * geometry. The geohash cell is what a cell probe seeks; the bounding
 * box is what `$within` pushes — the planner promotes a containment
 * predicate onto the box columns and refines exactly in the engine.
 */
export const TRIP_MODEL = {
  $model: '0.1',
  collections: {
    [TRIP_COLLECTION]: {
      schema: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          geometry: { type: 'object' },
          properties: { type: 'object' },
        },
      },
      key: null,
      identity: 'integer',
      indexes: [
        { name: 'by_cell', path: '$.geometry', derive: 'geohash', precision: 5 },
        { name: 'by_box', path: '$.geometry', derive: 'bbox' },
      ],
    },
  },
};

/**
 * The query, written through `@jarenjs/linq`: the features whose
 * geometry lies within the region, the region bound at call time so the
 * one compiled document serves any region — the shape a spatial index
 * is probed with.
 * @param {any} source
 */
export const tripChain = (source) => from(source)
  .params({ region: TRIP_REGION })
  .where((f, q) => f.geometry.within(q.region));

/** The chain, as the page shows it beside the document it emits. */
export const TRIP_CHAIN_TEXT = [
  'from(places)',
  '  .params({ region })',
  '  .where((f, q) => f.geometry.within(q.region))',
].join('\n');

/** The stylesheet, compiled once. */
const toGeoJson = compileJsltStylesheet(TRIP_STYLESHEET);

/** The portable GeoJSON meta-schema, compiled once. */
const validateGeoJson = new JarenValidator(OUR_SCHEMA_OPTIONS).compile(geojsonSchema);

/**
 * The round trip's pure half: CSV text → typed rows → a
 * `FeatureCollection` through the stylesheet → the meta-schema's
 * verdict → the documents, the model, the query document and its
 * externals a store executes. Nothing here touches a store; the effect
 * posts the result to `data.oracle` and the Node suite runs the same
 * output through the handler table.
 * @param {string} csvText
 * @returns {{ rows: any[], collection: any, valid: boolean, errors: any[],
 *   documents: any[], model: any, collectionName: string, query: any, externals: any }}
 */
export function tripPipeline(csvText) {
  const rows = parseCsv(csvText, { headers: true, typed: true });
  const collection = toGeoJson(rows);
  const outcome = /** @type {any} */ (validateGeoJson(collection));
  const valid = typeof outcome === 'object' && outcome !== null ? outcome.valid === true : outcome === true;
  const errors = valid ? [] : (outcome?.errors ?? []).slice(0, 8).map((/** @type {any} */ e) =>
    ({ instancePath: e.instancePath ?? '', message: e.message ?? 'invalid' }));
  const documents = valid ? collection.features : [];
  return {
    rows,
    collection,
    valid,
    errors,
    documents,
    model: TRIP_MODEL,
    collectionName: TRIP_COLLECTION,
    query: tripChain(documents).toDocument(),
    externals: { region: TRIP_REGION },
  };
}

/**
 * The preview renderers THIS host has, by the `kind` a format's preview
 * hint names (`@jarenjs/forms`' `getFormatInfo('geojson').preview` is
 * `{ kind: 'map' }`). The hint is data; the renderer is the host's —
 * here `@jarenjs/charts`' map type, which `@jarenjs/forms` may not
 * import. A kind this host has no renderer for draws nothing.
 * @type {Record<string, (features: any, title: string) => any>}
 */
const PREVIEW_RENDERERS = {
  map: (features, title) => compileChart(
    { type: 'map', title, aspect: 1.6, label: 'name' }, { features }, { theme: 'host' }).toVnode(),
};

/**
 * Render a format's preview hint, or nothing: the "host that understands
 * `preview`" half of the forms contract. `null` for no hint and for a
 * kind this host cannot draw.
 * @param {{ kind: string } | null | undefined} preview
 * @param {any} features - a `FeatureCollection`, `Feature` or geometry
 * @param {string} title
 */
export function previewVnode(preview, features, title) {
  const render = preview === null || preview === undefined ? undefined : PREVIEW_RENDERERS[preview.kind];
  return render === undefined ? null : render(features, title);
}

/** One map per report: the view model is rebuilt on every render. */
const tripMaps = new WeakMap();

/**
 * The map of a finished round trip: the region as a ring, the matched
 * features as dots — drawn through the `geojson` format's preview hint.
 * @param {any} report
 */
export function tripMap(report) {
  if (report === null || report.status !== 'done') return null;
  let vnode = tripMaps.get(report);
  if (vnode === undefined) {
    const features = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { name: 'the region' }, geometry: TRIP_REGION },
        ...report.results,
      ],
    };
    vnode = previewVnode(getFormatInfo('geojson')?.preview, features, 'Inside the region');
    tripMaps.set(report, vnode);
  }
  return vnode;
}

/**
 * The round trip's verdict, as one line.
 * @param {any} report
 */
export function tripSummary(report) {
  if (report === null || report === undefined) return '';
  if (report.status === 'running') return `${report.rows} CSV rows \u2192 ${report.features} features, valid GeoJSON \u2014 running the query in a throwaway store\u2026`;
  if (report.status === 'error') return `the round trip stopped: ${report.message}`;
  return `${report.rows} CSV rows \u2192 ${report.features} features (valid GeoJSON) \u2192 stored with derived spatial indexes \u2192 ${report.results.length} inside the region`;
}

//#endregion

/** The round trip's constant documents, as the page prints them. */
export const TRIP_TEXTS = Object.freeze({
  stylesheet: JSON.stringify(TRIP_STYLESHEET, null, 2),
  model: JSON.stringify(TRIP_MODEL, null, 2),
  query: JSON.stringify(tripChain([]).toDocument(), null, 1),
  region: JSON.stringify(TRIP_REGION),
});

export const DATA_EXAMPLE = {
  model: DATA_MODEL, query: DATA_QUERY, seeds: SEEDS, features: { oracle: true }, executor: 'sqlite-wasm',
  trip: { csv: TRIP_CSV, pipeline: tripPipeline, texts: TRIP_TEXTS, chainText: TRIP_CHAIN_TEXT, map: tripMap, summary: tripSummary },
  createRow: title => ({ id: `n${Math.random().toString(36).slice(2, 8)}`, title, points: Math.floor(Math.random() * 50) }),
  migration: (model, collection) => {
    const to = structuredClone(model), indexes = to.collections[collection].indexes ??= [];
    if (!indexes.some(index => index.name === 'by_title')) indexes.push({ name: 'by_title', path: '$.title' });
    return { to, id: 'add-title-index' };
  },
};
