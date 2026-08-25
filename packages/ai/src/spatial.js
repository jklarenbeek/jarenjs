//@ts-check
/**
 * The SPATIAL authoring profile: a constrained decoder writing correct
 * §8.14 queries, on the pattern `stylesheet.js` measured into shape.
 *
 * It is that author — the narrowed response format, the operator crib,
 * the path digest, the compile and run gates, the bounded request — with
 * three things added, each answering a rule a model gets wrong BY
 * DEFAULT and each checkable:
 *
 *  1. **Geodesic, not planar.** Asked for "points within 5 km", a model
 *     reaches for Pythagoras on raw degrees. A degree of longitude is
 *     68 km at 52°N, so that answer is wrong by two thirds over a
 *     kilometre at Dutch latitudes. The profile teaches `$distance` in
 *     metres, and {@link planarArithmeticGate} refuses arithmetic over a
 *     coordinate member (`AI0231`).
 *
 *  2. **Representative position.** `$within` and `$distance` measure a
 *     non-point value by its centroid, stated rather than inferred: a
 *     model assuming minimum-distance-between-shapes writes a query that
 *     is subtly wrong and never errors. The crib says it in one line.
 *
 *  3. **A geohash prefix is bucketing; proximity is nine cells.** The one
 *     a model gets wrong because the internet taught it the wrong thing:
 *     two points ten metres apart can differ in the FIRST character of
 *     their cell, so a single-prefix "near here" fails at every cell
 *     boundary. The profile teaches `$geohash-neighbours`, and
 *     {@link prefixProximityGate} refuses a `$starts-with` over a
 *     `$geohash` when the question asked for proximity (`AI0230`),
 *     naming the nine-cell probe as the fix. The same document asked
 *     for bucketing ("group by cell") passes — a prefix is exactly right
 *     for that.
 *
 * A third gate, {@link spatialOperatorGate}, refuses a spatial question
 * answered with no §8.14 operator at all (`AI0232`) — the lat/lon box of
 * comparisons that "means" within and measures nothing.
 *
 * Codes are `AI0230`–`AI0232`, beside the stylesheet author's
 * `AI0220`–`AI0225`. Every engine is INJECTED, as in the precedent; the
 * one kernel import is `isPosition`, so the grounding can say which
 * members hold a position — no arithmetic lives here.
 */

import { isPosition } from '@jarenjs/core/geo';
import {
  createStylesheetAuthor, describePaths, operatorCrib, stylesheetSystemMessage,
} from './stylesheet.js';

/**
 * The refusal shape the gate seam speaks (see `stylesheet.js`):
 *
 *   AI0230 — a geohash prefix test offered as proximity
 *   AI0231 — planar arithmetic over raw coordinate members
 *   AI0232 — a spatial question answered with no spatial operator
 */
const refuse = (code, reason, docPath) => ({
  valid: false, errors: [{ code, docPath, message: reason }],
});

//#region the vocabulary the profile teaches

/**
 * The §8.14 operators, with the one-line definition each carries in
 * `QUERY-FORMAT.md`. A test holds this table to that section's own
 * table, so the profile teaches exactly what the format publishes —
 * neither an operator that does not exist nor one it forgot.
 */
export const SPATIAL_OPERATORS = Object.freeze({
  '$bbox': 'any value → [west, south, east, north]; a value with no positions → empty',
  '$area': 'square METRES of the value\'s polygons (exterior rings less holes); no surface → 0',
  '$length': 'METRES of the value\'s lines and ring perimeters; a point → 0',
  '$centroid': 'the mean of the value\'s positions, as a position (not the area-weighted centre)',
  '$distance': '[a, b] → geodesic METRES between the two representative positions',
  '$within': '[a, b] → is a\'s representative position inside b\'s surface? Only a polygon has an inside',
  '$bbox-intersects': '[a, b] → do the two bounding boxes overlap? Boxes only — not a real intersection',
  '$geohash': '[value] or [value, precision 1..12 (default 9)] → the base-32 CELL string',
  '$geo-parse': 'a Well-Known Text string → the geometry it denotes; malformed text → empty',
  '$geo-text': 'any value → its Well-Known Text string',
  '$geohash-bounds': 'a cell string → the Polygon covering that cell',
  '$geohash-neighbours': 'a cell string → the cell and its neighbours, up to nine strings — the PROXIMITY probe',
  '$geo-simplify': '[value, tolerance in DEGREES] → the same value with vertices dropped, for storage',
});

/** The arithmetic operators a planar distance is spelled with. */
const ARITHMETIC = new Set(['$add', '$sub', '$mul', '$div', '$idiv', '$mod', '$neg', '$pow', '$sqrt', '$abs', '$hypot']);

/** The member names the world spells a coordinate component with. */
const COORDINATE_NAMES = ['lat', 'lon', 'lng', 'latitude', 'longitude', 'coordinates'];

/**
 * The prose the profile adds to the stylesheet author's message: every
 * §8.14 operator with its definition, and the three rules.
 * @returns {string}
 */
export function spatialCrib() {
  const table = Object.entries(SPATIAL_OPERATORS).map(([name, definition]) => `  ${name}: ${definition}`).join('\n');
  return 'GEOGRAPHY. Operands are GeoJSON as the document holds it — a bare [longitude, latitude]'
    + ' position, a geometry, a Feature or a FeatureCollection. Longitude first. The spatial'
    + ' operators, and nothing outside this list is spatial:\n'
    + table
    + '\n\nThree rules:'
    + '\n1. MEASUREMENTS ARE GEODESIC, NEVER PLANAR. $distance answers metres on the WGS 84 sphere.'
    + ' Never subtract, multiply or square coordinate members ($c.at[0], $.here[1], .lat, .lon):'
    + ' a degree of longitude is 68 km at 52°N, so Pythagoras over degrees is wrong by two thirds'
    + ' over a kilometre. Kilometres are {"$idiv": [{"$distance": [a, b]}, 1000]}.'
    + '\n2. REPRESENTATIVE POSITION. $distance and $within measure a value by ONE position: a bare'
    + ' position or Point is itself, anything else is its centroid. There is no'
    + ' minimum-distance-between-shapes; "how far from a region" is $within first, then $distance'
    + ' to its $centroid.'
    + '\n3. A GEOHASH PREFIX IS BUCKETING, NOT PROXIMITY. Two points ten metres apart can differ in'
    + ' the FIRST character of their cell, so {"$starts-with": [{"$geohash": …}, prefix]} misses a'
    + ' neighbour at every cell boundary. Use a prefix to GROUP or TILE. For "near", test the nine'
    + ' cells: {"$let": {"cells": {"$geohash-neighbours": {"$geohash": ["$.here", 6]}}},'
    + ' "$return": {"$for": {"c": "$.places[*]"}, "$where": {"$exists": {"$index-of": ["$cells",'
    + ' {"$geohash": ["$c.at", 6]}]}}, "$return": "$c"}} — and narrow with $distance when a'
    + ' radius matters. Never a single prefix described as "near".';
}

/**
 * What a question asks for, read off its words: `proximity` (near,
 * within N km, closest, radius…) decides whether a prefix test is a
 * refusal or a legitimate bucketing; `spatial` (any geographic ask)
 * decides whether a document with no §8.14 operator can be an answer.
 * @param {string} question
 * @returns {{ proximity: boolean, spatial: boolean }}
 */
export function spatialIntent(question) {
  const text = String(question ?? '');
  const proximity = /\b(near(by|est)?|clos(e|est)(\s+to)?|within\s+\d|distance|radius|around|proximit\w*|kilomet\w*|\bkm\b|metres?|meters?|miles?|far(thest)?)\b/i.test(text);
  const containment = /\b(within|inside|in the (region|area|polygon|box|bounds)|contain\w*|intersect\w*|overlap\w*|bounding|bbox)\b/i.test(text);
  const geographic = /\b(geo\w*|map|location\w*|coordinates?|polygon|point|latitude|longitude|\blat\b|\blon\b|region|area|cell|wkt|gps|route|place\w*|cit(y|ies))\b/i.test(text);
  return { proximity, spatial: proximity || containment || geographic };
}

/**
 * The member names that hold a `[longitude, latitude]` position anywhere
 * in a sample — how the arithmetic gate knows `$c.at[0]` is a
 * coordinate and `$c.scores[0]` is not. `coordinates` and the common
 * component names are always in.
 * @param {any} sample
 * @returns {Set<string>}
 */
export function coordinateMembers(sample) {
  const names = new Set(COORDINATE_NAMES);
  /** @param {any} node */
  function walk(node) {
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (isPosition(value)) names.add(key);
      walk(value);
    }
  }
  walk(sample);
  return names;
}

/**
 * The grounding the spatial author sends: the path digest, then which
 * of those paths hold a position — a digest alone shows `at[*]  number`
 * and leaves the model to guess that two numbers are a coordinate.
 * @param {any} sample
 * @returns {string}
 */
export function describeSpatialPaths(sample) {
  const digest = describePaths(sample);
  /** @type {string[]} */
  const positions = [];
  /** @param {any} node @param {string} path */
  function walk(node, path) {
    if (isPosition(node)) { positions.push(path); return; }
    if (Array.isArray(node)) { for (const item of node) walk(item, `${path}[*]`); return; }
    if (node === null || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      // a geometry's vertices are positions too, but the value to pass
      // whole is the geometry — naming its ring members would invite
      // exactly the indexing the note forbids
      if (key === 'coordinates') continue;
      const step = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
      walk(node[key], `${path}${step}`);
    }
  }
  walk(sample, '$');
  const unique = [...new Set(positions)];
  return unique.length === 0
    ? digest
    : `${digest}\n\nThese paths hold a [longitude, latitude] POSITION — pass them whole to the`
      + ` spatial operators, never index into them: ${unique.join(', ')}`;
}

//#endregion

//#region the gates a schema and a compiler both miss

/** Walk every rule body of a stylesheet document (either accepted shape). */
function rulesOf(doc) {
  const rules = Array.isArray(doc) ? doc : doc?.rules;
  if (!Array.isArray(rules)) return [];
  const base = Array.isArray(doc) ? '' : '/rules';
  return rules.map((rule, i) => ({ body: rule?.body, docPath: `${base}/${i}/body` }));
}

/** Whether a node is an operator phrase of the given name. */
const isPhrase = (node, name) => node !== null && typeof node === 'object' && !Array.isArray(node)
  && Object.hasOwn(node, name);

/**
 * Whether a path string addresses one component of a coordinate: an
 * index into a member that holds a position (`$c.at[0]`, `$.here[1]`,
 * `$f.geometry.coordinates[0]`) or a member named as one (`$c.lat`).
 * @param {string} path
 * @param {Set<string>} members
 */
function isCoordinateComponent(path, members) {
  if (typeof path !== 'string' || !path.startsWith('$')) return false;
  const indexed = /(?:\.([A-Za-z_][A-Za-z0-9_]*)|\["([^"]+)"\])((?:\[\d+\])+)$/.exec(path);
  if (indexed !== null) return members.has(indexed[1] ?? indexed[2]);
  const named = /(?:\.([A-Za-z_][A-Za-z0-9_]*)|\["([^"]+)"\])$/.exec(path);
  return named !== null && COORDINATE_NAMES.includes((named[1] ?? named[2]).toLowerCase())
    && (named[1] ?? named[2]).toLowerCase() !== 'coordinates';
}

/** The first coordinate-component path under a node, or null. */
function coordinateOperand(node, members) {
  if (typeof node === 'string') return isCoordinateComponent(node, members) ? node : null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = coordinateOperand(item, members);
      if (found !== null) return found;
    }
    return null;
  }
  if (node !== null && typeof node === 'object') {
    for (const value of Object.values(node)) {
      const found = coordinateOperand(value, members);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Refuse arithmetic over a raw coordinate member (D5): `$sub`, `$mul`
 * and their kin with an operand that indexes into a position or names a
 * coordinate component. That expression is a planar distance in
 * degrees, whatever it is presented as, and the schema and the engine
 * both accept it because it is arithmetic over numbers.
 *
 * @param {{ members?: Set<string> | Iterable<string> }} [options] - the
 *   member names that hold a position ({@link coordinateMembers} of the
 *   sample); the common component names are always in.
 * @returns {(doc: any) => true | { valid: false, errors: any[] }}
 */
export function planarArithmeticGate(options = {}) {
  const members = new Set([...COORDINATE_NAMES, ...(options.members ?? [])]);
  return function gate(doc) {
    /** @type {{ operator: string, operand: string, at: string } | null} */
    let found = null;
    /** @param {any} node @param {string} at */
    function walk(node, at) {
      if (found !== null) return;
      if (Array.isArray(node)) { node.forEach((item, i) => walk(item, `${at}/${i}`)); return; }
      if (node === null || typeof node !== 'object') return;
      for (const key of Object.keys(node)) {
        if (ARITHMETIC.has(key)) {
          const operand = coordinateOperand(node[key], members);
          if (operand !== null) { found = { operator: key, operand, at: `${at}/${key}` }; return; }
        }
        walk(node[key], `${at}/${key}`);
      }
    }
    for (const { body, docPath } of rulesOf(doc)) walk(body, docPath);
    if (found === null) return true;
    return refuse('AI0231',
      `'${found.operator}' over '${found.operand}' is arithmetic on a raw coordinate: a PLANAR `
      + 'distance in degrees, and a degree of longitude is 68 km at 52°N, so it is wrong by two '
      + 'thirds over a kilometre. Measure geodesically: {"$distance": [a, b]} answers metres '
      + 'between two positions passed WHOLE (the member itself, not [0]/[1]); kilometres are '
      + '{"$idiv": [{"$distance": [a, b]}, 1000]}. Order by distance with {"$orderby": '
      + '[{"$key": {"$distance": [a, b]}}]}.',
      found.at);
  };
}

/**
 * Refuse a geohash prefix test offered as proximity (D7): a
 * `$starts-with` with a `$geohash` operand, or an `$eq`/`$ne` between
 * two `$geohash` phrases ("same cell"), when the question asked for
 * nearness. The same document asked for bucketing passes — a prefix is
 * exactly the right spelling for "group by cell" or "tile".
 *
 * @param {{ proximity: boolean }} options - whether the question asked
 *   for proximity ({@link spatialIntent})
 * @returns {(doc: any) => true | { valid: false, errors: any[] }}
 */
export function prefixProximityGate(options) {
  const proximity = options?.proximity === true;
  return function gate(doc) {
    if (!proximity) return true;
    /** @type {{ operator: string, at: string } | null} */
    let found = null;
    /** @param {any} node @param {string} at */
    function walk(node, at) {
      if (found !== null) return;
      if (Array.isArray(node)) { node.forEach((item, i) => walk(item, `${at}/${i}`)); return; }
      if (node === null || typeof node !== 'object') return;
      for (const key of Object.keys(node)) {
        const operands = node[key];
        if (key === '$starts-with' && Array.isArray(operands)
          && operands.some((operand) => isPhrase(operand, '$geohash'))) {
          found = { operator: key, at: `${at}/${key}` };
          return;
        }
        if ((key === '$eq' || key === '$ne') && Array.isArray(operands)
          && operands.length === 2 && operands.every((operand) => isPhrase(operand, '$geohash'))) {
          found = { operator: key, at: `${at}/${key}` };
          return;
        }
        walk(operands, `${at}/${key}`);
      }
    }
    for (const { body, docPath } of rulesOf(doc)) walk(body, docPath);
    if (found === null) return true;
    return refuse('AI0230',
      `'${found.operator}' over a $geohash is a PREFIX test, which is bucketing, not proximity: `
      + 'two points ten metres apart can differ in the first character of their cell, so this '
      + 'misses a neighbour at every cell boundary. For "near", test the nine-cell neighbourhood: '
      + '{"$let": {"cells": {"$geohash-neighbours": {"$geohash": [here, 6]}}}, "$return": {"$for": '
      + '…, "$where": {"$exists": {"$index-of": ["$cells", {"$geohash": [candidate, 6]}]}}, …}} — '
      + 'then narrow with {"$distance": [candidate, here]} when a radius matters.',
      found.at);
  };
}

/**
 * Refuse a spatial question answered with no spatial operator at all:
 * a box of `$gt`/`$lt` over latitude and longitude that "means" within
 * and measures nothing, or a plain projection that ignores the ask.
 * Passes any document when the question was not spatial.
 *
 * @param {{ spatial: boolean }} options - whether the question was a
 *   geographic ask ({@link spatialIntent})
 * @returns {(doc: any) => true | { valid: false, errors: any[] }}
 */
export function spatialOperatorGate(options) {
  const spatial = options?.spatial === true;
  return function gate(doc) {
    if (!spatial) return true;
    let seen = false;
    /** @param {any} node */
    function walk(node) {
      if (seen) return;
      if (Array.isArray(node)) { for (const item of node) walk(item); return; }
      if (node === null || typeof node !== 'object') return;
      for (const key of Object.keys(node)) {
        if (Object.hasOwn(SPATIAL_OPERATORS, key)) { seen = true; return; }
        walk(node[key]);
      }
    }
    for (const { body } of rulesOf(doc)) walk(body);
    if (seen) return true;
    return refuse('AI0232',
      'the question is geographic and this document uses no spatial operator. Comparing '
      + 'coordinate members is not a spatial test: containment is {"$within": [position, area]}, '
      + 'nearness is {"$distance": [a, b]} in metres, a cell is {"$geohash": [position, precision]}. '
      + 'Rewrite the filter with one of the spatial operators listed in the instructions.',
      Array.isArray(doc) ? '' : '/rules');
  };
}

/**
 * The spatial gates for one authoring call, from the question and the
 * sample: the prefix refusal when proximity was asked, the arithmetic
 * refusal over the sample's position members, and the no-operator
 * refusal when the ask was geographic at all.
 * @param {{ question: string, sample?: any }} call
 * @returns {Array<(doc: any) => any>}
 */
export function spatialGates(call) {
  const intent = spatialIntent(call.question);
  return [
    prefixProximityGate({ proximity: intent.proximity }),
    planarArithmeticGate({ members: coordinateMembers(call.sample) }),
    spatialOperatorGate({ spatial: intent.spatial }),
  ];
}

//#endregion

//#region the author

/**
 * The worked example: a containment filter, a distance ordering and a
 * kilometre projection — every rule the crib states, in the shape a
 * model copies. It compiles and runs (the test asserts both), and it is
 * the neighbour of the common ask rather than the ask itself.
 */
export const SPATIAL_EXAMPLE = {
  $jslt: '0.1',
  rules: [{
    match: '$',
    body: {
      $for: { c: '$.places[*]' },
      $where: { $within: ['$c.at', '$.region'] },
      $orderby: [{ $key: { $distance: ['$c.at', '$.centre'] } }],
      $return: { name: '$c.name', km: { $idiv: [{ $distance: ['$c.at', '$.centre'] }, 1000] } },
    },
  }],
};

/**
 * The spatial system message: the stylesheet author's, with the spatial
 * crib in front of a spatial example.
 * @param {string} crib - the operator crib read off the grammar
 * @returns {string}
 */
export function spatialSystemMessage(crib) {
  return stylesheetSystemMessage(crib, {
    extra: spatialCrib(),
    example: SPATIAL_EXAMPLE,
    exampleIntro: 'Here is a stylesheet in the right shape: the places INSIDE a region, nearest'
      + ' to a point first, with the distance in kilometres:',
  });
}

/**
 * Author a spatial stylesheet with a model, gated on the engine and on
 * the three rules above.
 *
 * Same options as `createStylesheetAuthor` — the engine injected, the
 * authoring profile as `schema`, the canonical grammar and the query
 * grammar — and the same result shape. What differs is the message
 * (the spatial crib and example) and the gates (`AI0230`–`AI0232`,
 * per call, from the question and the sample).
 * @param {Parameters<typeof createStylesheetAuthor>[0]} options
 * @returns {ReturnType<typeof createStylesheetAuthor>}
 */
export function createSpatialAuthor(options) {
  const operators = options.operators ?? [];
  return createStylesheetAuthor({
    ...options,
    system: options.system ?? spatialSystemMessage(operatorCrib(options.grammar, operators)),
    describe: options.describe ?? describeSpatialPaths,
    gates: options.gates ?? spatialGates,
  });
}

//#endregion
