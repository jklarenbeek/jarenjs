//@ts-check
/**
 * The geo toolbox: a small, CLOSED set of tools that lets a model answer
 * spatial questions about data it was given, guarded by the GeoJSON
 * meta-schema and delegating every measurement to `@jarenjs/core/geo`.
 *
 * Two rules shape it, and both are structural rather than advisory:
 *
 *  - **No arithmetic lives here.** A distance, a box, a containment test,
 *    a cell and its neighbourhood, a WKT parse or print — each is one
 *    call into the kernel that already has exactly one implementation of
 *    it. This module holds argument plumbing and result shaping, nothing
 *    that could drift from the engine's answer.
 *  - **The input schema is the shipped GeoJSON meta-schema, by
 *    reference.** Every tool's `inputSchema` `$ref`s the artifact the
 *    caller injects (`@jarenjs/json/schemas/geojson.schema.json`, `$id`
 *    `https://jarenjs.dev/schemas/geojson`) rather than restating a
 *    geometry shape, so a malformed geometry is refused by the validator
 *    the suite already ships — with its `instancePath`'d errors and the
 *    schema to re-read — before any tool runs. A bare `[lon, lat]`
 *    position is accepted where §8.14 accepts one, through the same
 *    artifact's `position` definition.
 *
 * What is deliberately absent: overlay. There is no union, intersection,
 * difference or buffer, and `$within` never grew into a general
 * intersects — a model asking for one is answered with a refusal that
 * names why, never an approximation. JSTS exists for that work.
 */

import {
  bboxOf, centroidOf, containsPosition, geoDistance, geoJsonToWkt, geohashEncode,
  geohashNeighbours, isPosition, isValidGeohash, wktToGeoJson,
} from '@jarenjs/core/geo';
import { JarenValidator } from '@jarenjs/validate';
import { createToolbox } from './toolbox.js';

/** The `$id` the shipped GeoJSON meta-schema declares. */
export const GEOJSON_SCHEMA_ID = 'https://jarenjs.dev/schemas/geojson';

/** The seven tools, in the order they are registered. */
export const GEO_TOOL_NAMES = Object.freeze([
  'geo_distance', 'geo_within', 'geo_bbox', 'geo_geohash', 'geo_neighbours',
  'geo_parse_wkt', 'geo_to_wkt',
]);

/**
 * The names a model reaches for when it wants overlay work. Each is
 * answered with the refusal below rather than `unknown tool`, because
 * "unknown" invites a retry under another spelling and the honest
 * answer is that the operation is not offered at all.
 */
export const OVERLAY_TOOL_NAMES = Object.freeze([
  'geo_union', 'geo_intersection', 'geo_intersects', 'geo_difference', 'geo_buffer',
  'geo_clip', 'geo_overlay',
]);

/**
 * A GeoJSON value as the tools take it: any RFC 7946 object, or a bare
 * `[longitude, latitude]` position — both by reference into the injected
 * meta-schema, so the shape is validated by the artifact and not by a
 * hand-written twin of it.
 * @param {string} description
 */
const geoValue = (description) => ({
  description,
  anyOf: [
    { $ref: GEOJSON_SCHEMA_ID },
    { $ref: `${GEOJSON_SCHEMA_ID}#/$defs/position` },
  ],
});

/** The one-object argument shape every tool takes. */
const args = (properties, required) => ({
  type: 'object', properties, required, additionalProperties: false,
});

/** The geohash alphabet, as the cell arguments are declared. */
const CELL_PATTERN = '^[0-9b-hjkmnp-z]{1,12}$';

/**
 * The representative position §8.14 measures a value by: a bare
 * position is itself, anything else is its centroid. Null for a value
 * with no positions (an empty collection).
 * @param {any} value
 * @returns {[number, number] | null}
 */
const representative = (value) => (isPosition(value) ? value : centroidOf(value));

/** A tool's content-level refusal: the shape the toolbox already answers
 * for everything a model can read and recover from. */
const refuse = (reason) => ({ error: reason });

/**
 * Why an overlay request is refused, in one sentence a model can act on.
 * @param {string} name
 */
export function overlayRefusal(name) {
  return `'${name}' is not offered: union, intersection, difference and buffer are overlay`
    + ' operations, and this toolbox computes none of them — a half-correct clipper is worse'
    + ' than none, and JSTS or Turf do this work. Use geo_within for containment and'
    + ' geo_bbox for a bounding box; nothing here approximates an overlay.';
}

/**
 * The seven tool definitions, each a call into `@jarenjs/core/geo`.
 * @returns {import('./toolbox.js').ToolDef[]}
 */
export function geoToolDefs() {
  return [
    {
      name: 'geo_distance',
      description: 'The geodesic distance in METRES between two GeoJSON values on the WGS 84'
        + ' sphere, measured between their representative positions (a position or Point is'
        + ' itself, anything else its centroid). Never planar: a Euclidean answer over raw'
        + ' degrees is wrong by two thirds over a kilometre at Dutch latitudes.',
      inputSchema: args({ a: geoValue('the first value'), b: geoValue('the second value') }, ['a', 'b']),
      execute: ({ a, b }) => {
        const metres = geoDistance(a, b);
        return metres === null ? refuse('a value with no positions has no distance') : { metres };
      },
    },
    {
      name: 'geo_within',
      description: 'Whether the representative position of `value` lies inside the surface'
        + ' of `area`. Only a Polygon or MultiPolygon (or a Feature/collection of them) has an'
        + ' inside, so a line or point as the area answers false. Containment, not overlay:'
        + ' this does not test whether two shapes intersect.',
      inputSchema: args({ value: geoValue('the value to test'), area: geoValue('the area') }, ['value', 'area']),
      execute: ({ value, area }) => {
        const at = representative(value);
        return at === null
          ? refuse('a value with no positions is inside nothing')
          : { within: containsPosition(area, at[0], at[1]) };
      },
    },
    {
      name: 'geo_bbox',
      description: 'The bounding box of a GeoJSON value as [west, south, east, north] in'
        + ' degrees. Boxes never cross the antimeridian (RFC 7946 §3.1.9: cut the geometry at'
        + ' ±180° first).',
      inputSchema: args({ value: geoValue('the value to bound') }, ['value']),
      execute: ({ value }) => {
        const bbox = bboxOf(value);
        return bbox === null ? refuse('a value with no positions has no bounding box') : { bbox };
      },
    },
    {
      name: 'geo_geohash',
      description: 'The base-32 geohash CELL of a value\'s representative position at a'
        + ' precision from 1 to 12 (default 9). A cell is a bucket, not a neighbourhood: two'
        + ' points ten metres apart can differ in the first character. For proximity, take'
        + ' geo_neighbours of this cell.',
      inputSchema: args({
        value: geoValue('the value to encode'),
        precision: { type: 'integer', minimum: 1, maximum: 12, default: 9,
          description: 'cell length in characters, 1..12' },
      }, ['value']),
      execute: ({ value, precision }) => {
        const at = representative(value);
        return at === null
          ? refuse('a value with no positions has no cell')
          : { cell: geohashEncode(at[0], at[1], precision ?? 9) };
      },
    },
    {
      name: 'geo_neighbours',
      description: 'The nine-cell neighbourhood of a geohash cell — the cell and its eight'
        + ' neighbours, in reading order (north-west first, the cell itself in the middle),'
        + ' fewer past a pole. This is the CORRECT proximity probe: a single-prefix test misses'
        + ' a neighbour at every cell boundary, so "things near here" tests membership in'
        + ' these cells and then refines with geo_distance.',
      inputSchema: args({
        cell: { type: 'string', pattern: CELL_PATTERN, description: 'a geohash cell' },
      }, ['cell']),
      execute: ({ cell }) => (isValidGeohash(cell)
        ? { cells: geohashNeighbours(cell) }
        : refuse(`'${cell}' is not a geohash cell`)),
    },
    {
      name: 'geo_parse_wkt',
      description: 'Well-Known Text (what PostGIS, SpatiaLite, GEOS and every ST_AsText'
        + ' emit) to the GeoJSON geometry it denotes. A geometry, never a Feature: WKT'
        + ' carries no properties.',
      inputSchema: args({
        text: { type: 'string', minLength: 1, description: 'the WKT, e.g. POINT (4.9 52.4)' },
      }, ['text']),
      execute: ({ text }) => {
        const value = wktToGeoJson(text);
        return value === null ? refuse('the text is not well-formed Well-Known Text') : { value };
      },
    },
    {
      name: 'geo_to_wkt',
      description: 'A GeoJSON value as Well-Known Text, the form a spatial database reads.'
        + ' A value with no WKT spelling (no positions, a non-finite coordinate) is refused'
        + ' rather than written approximately.',
      inputSchema: args({ value: geoValue('the value to write') }, ['value']),
      execute: ({ value }) => {
        const text = geoJsonToWkt(value);
        return text === null ? refuse('the value has no Well-Known Text spelling') : { text };
      },
    },
  ];
}

/**
 * Create a toolbox holding exactly the seven geo tools, guarded by the
 * injected GeoJSON meta-schema.
 *
 * The artifact is INJECTED, never imported: this package depends on
 * `@jarenjs/core` and `@jarenjs/validate` only, and the meta-schema is
 * `@jarenjs/json`'s. Pass
 * `import geojson from '@jarenjs/json/schemas/geojson.schema.json' with { type: 'json' }`.
 *
 * @param {{ geojson: any, validator?: any }} options - `geojson` is the
 *   meta-schema artifact (its `$id` must be {@link GEOJSON_SCHEMA_ID});
 *   `validator` is a shared JarenValidator the artifact is registered
 *   on, when the host already has one.
 * @returns {ReturnType<typeof createToolbox>} a toolbox whose `execute`
 *   additionally answers every {@link OVERLAY_TOOL_NAMES} request with
 *   {@link overlayRefusal}.
 */
export function createGeoToolbox(options) {
  const geojson = options?.geojson;
  if (geojson === null || typeof geojson !== 'object' || geojson.$id !== GEOJSON_SCHEMA_ID) {
    throw new TypeError(`createGeoToolbox needs the GeoJSON meta-schema artifact ($id ${GEOJSON_SCHEMA_ID})`);
  }
  const validator = options.validator ?? new JarenValidator({ skipErrors: false, collectErrors: true });
  validator.addSchema(geojson);
  const toolbox = createToolbox({ validator });
  for (const def of geoToolDefs()) toolbox.add(def);
  const overlay = new Set(OVERLAY_TOOL_NAMES);
  return {
    ...toolbox,
    /**
     * @param {string} name
     * @param {any} input
     */
    execute: (name, input) => (overlay.has(name)
      ? refuse(overlayRefusal(name))
      : toolbox.execute(name, input)),
  };
}
