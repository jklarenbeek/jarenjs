//@ts-check
/**
 * @file Derived index columns: the one place a declared
 * `indexes[].derive` becomes a value. A spatial member is an array of
 * numbers or an object, and a generated column must be a scalar, so a
 * geohash cell or a bounding-box edge is what actually gets indexed.
 *
 * Every cell and every box comes from `@jarenjs/core/geo`; nothing
 * here computes spatial arithmetic of its own. The same functions
 * serve BOTH physical mappings — registered as deterministic SQL
 * functions inside a virtual generated column's expression where the
 * driver can index them, and called directly on the write path where
 * it cannot — so the two branches cannot drift into different answers.
 *
 * It is also this package's ONLY seam onto `@jarenjs/core/geo` (D1 —
 * one home for spatial arithmetic, grep-proven by test): the planner's
 * probe geometry — the box of a literal or bound region, the box of a
 * bounded-distance circle, a cell's neighbourhood — is computed by the
 * helpers below rather than by an import of its own.
 *
 * Determinism is the contract, not a convenience: a value here is a
 * pure function of the document bytes. Nothing reads the clock, a
 * random source or store state, because an INDEX over a function that
 * did would make the database unreadable from a connection whose
 * function answered differently — and unreadable, not merely wrong:
 * a connection that has not registered the function at all cannot even
 * SELECT the table (probed). That hazard is why the mapping is
 * capability-gated rather than always-on.
 */

import {
  bboxOf, centroidOf, circleBounds, geohashEncode, geohashNeighbours,
} from '@jarenjs/core/geo';

import { chain } from './driver.js';

/** The closed set of derive kinds. */
export const DERIVE_KINDS = new Set(['geohash', 'bbox']);

/**
 * The closed set of PHYSICAL realizations a `derive: 'bbox'` index may
 * ask for. `'columns'` is the default and what an absent member means:
 * four generated columns under one B-tree. `'rtree'` is the same four
 * columns (they stay the box's one definition) beside a SQLite R\*Tree
 * virtual table kept in sync by declared triggers, with no B-tree over
 * them. The LOGICAL meaning of `derive: 'bbox'` is identical either
 * way — same rows, same answers — which is the whole point of naming
 * the shape separately from the derivation.
 */
export const PHYSICAL_KINDS = new Set(['columns', 'rtree']);

/** A bbox index's four columns, in the order they are declared —
 * `[west, south, east, north]`, the order the kernel's boxes carry. */
export const BBOX_COMPONENTS = Object.freeze(['w', 's', 'e', 'n']);

/**
 * The order a bbox index COVERS its four columns, which is not the
 * order they are declared in: an intersection test reads
 * `w <= ? AND e >= ? AND s <= ? AND n >= ?`, so the two longitude
 * bounds sit together at the front of the index where a leading-column
 * range can use them. `(a,b)` and `(b,a)` are different indexes.
 */
export const BBOX_INDEX_ORDER = Object.freeze(['w', 'e', 's', 'n']);

/** Where each component sits in `[west, south, east, north]`. */
const BBOX_AT = { w: 0, s: 1, e: 2, n: 3 };

/** The declared geohash precision range (characters). */
export const PRECISION_MIN = 1;
export const PRECISION_MAX = 12;

/**
 * The representative position of any GeoJSON value: the position
 * itself for a bare `[lon, lat]` or a Point, the mean vertex
 * otherwise. Null when there is no position, and null when any
 * position is non-finite — `centroidOf` propagates a NaN through the
 * mean, so the finiteness of the result is the whole-value test.
 * @param {any} value
 * @returns {number[] | null}
 */
function representativePosition(value) {
  const centre = centroidOf(value);
  if (centre === null) return null;
  return Number.isFinite(centre[0]) && Number.isFinite(centre[1]) ? centre : null;
}

/**
 * The geohash cell of a value at a precision, or null when the value
 * carries no bounded position.
 * @param {any} value
 * @param {number} precision
 * @returns {string | null}
 */
export function deriveGeohash(value, precision) {
  const position = representativePosition(value);
  return position === null ? null : geohashEncode(position[0], position[1], precision);
}

/**
 * One edge of a value's bounding box, or null when it has none —
 * including the D6 case where a non-finite coordinate refuses the box
 * rather than producing one that does not bound its input.
 * @param {any} value
 * @param {string} component - `'w'`, `'s'`, `'e'` or `'n'`
 * @returns {number | null}
 */
export function deriveBboxEdge(value, component) {
  const box = bboxOf(value);
  return box === null ? null : box[BBOX_AT[component]];
}

/**
 * A member as the database will hold it. A derived value must be a
 * function of the STORED document, not of the object handed to the
 * write: JSON has no `NaN` and no `Infinity`, so a non-finite
 * coordinate becomes `null` on the way in and is no longer a position
 * at all. Computing from the in-memory value would make the two
 * physical mappings answer differently for the same document, which is
 * the one thing they may never do.
 *
 * Only the indexed MEMBER round-trips, not the whole document — it is
 * the only part a derived column reads.
 * @param {any} member
 * @returns {any} the member as stored, or `undefined` when there is none
 */
export function storedMemberForm(member) {
  if (member === undefined) return undefined;
  const text = JSON.stringify(member);
  return text === undefined ? undefined : JSON.parse(text);
}

/**
 * The value of one derived column for a document member.
 * @param {{ derive: string, precision?: number, component?: string }} column
 * @param {any} member - the value at the index path, or `undefined`
 * @returns {string | number | null}
 */
export function derivedValue(column, member) {
  if (member === undefined || member === null) return null;
  return column.derive === 'geohash'
    ? deriveGeohash(member, /** @type {number} */ (column.precision))
    : deriveBboxEdge(member, /** @type {string} */ (column.component));
}

/**
 * Read the member one derived column is computed from, walking the
 * same typed segments the physical mapping was planned over.
 * @param {any} doc
 * @param {import('./dialect.js').JsonPathSegment[]} segments
 * @returns {any} the member, or `undefined`
 */
export function memberAt(doc, segments) {
  let node = doc;
  for (const segment of segments) {
    if (node === null || typeof node !== 'object') return undefined;
    node = 'name' in segment ? node[segment.name] : node[segment.index];
  }
  return node;
}

/**
 * Parse the JSON text a derived column's expression hands the function.
 * SQLite passes SQL NULL for a member the document does not have, and
 * `json()` of an extracted member is unambiguous JSON text otherwise.
 * @param {any} text
 * @returns {any} the value, or `undefined` when there is none
 */
function parseMember(text) {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  }
  catch {
    return undefined;
  }
}

/**
 * Register the deterministic functions the virtual generated columns
 * call. Idempotent per connection by SQLite's own semantics (a second
 * registration replaces the first with the identical implementation),
 * and a no-op where the driver cannot index a registered function —
 * that branch stores the columns instead.
 *
 * The four bbox edges share a one-entry memo of the last text they
 * were asked about, because they are called back to back with the same
 * argument for one row and the box costs a full walk of the geometry.
 * The memo is keyed on the argument itself, so it changes no answer.
 * @param {any} connection
 * @returns {any} value-or-promise
 */
export function registerDeriveFunctions(connection) {
  if (connection.capabilities?.deterministicIndexableFunctions !== true
    || typeof connection.registerFunction !== 'function') return null;
  /** @type {any} */
  let memoText = null;
  /** @type {number[] | null} */
  let memoBox = null;
  const boxOf = (/** @type {any} */ text) => {
    if (text === memoText) return memoBox;
    const value = parseMember(text);
    memoBox = value === undefined ? null : bboxOf(value);
    memoText = text;
    return memoBox;
  };
  /** @type {[string, Function][]} */
  const registrations = [
    ['jaren_geohash', (/** @type {any} */ text, /** @type {any} */ precision) => {
      const value = parseMember(text);
      return value === undefined ? null : deriveGeohash(value, Number(precision));
    }],
  ];
  for (const component of BBOX_COMPONENTS) {
    registrations.push([`jaren_bbox_${component}`, (/** @type {any} */ text) => {
      const box = boxOf(text);
      return box === null ? null : box[BBOX_AT[component]];
    }]);
  }
  const step = (i) => (i >= registrations.length
    ? null
    : chain(connection.registerFunction(registrations[i][0],
      { deterministic: true }, registrations[i][1]), () => step(i + 1)));
  return step(0);
}

// ————— Probe geometry: what a PUSHED predicate compares against —————
//
// A promoted spatial predicate narrows through the derived columns by
// comparing them with a box (or a cell) computed from the query's own
// operand. That operand is known either at plan time (a literal region)
// or at bind time (an external one), and both go through here so the
// two answer identically and neither reaches past this file for its
// arithmetic.

/**
 * The bounding box of a probe value, or `null` when it has none — the
 * D6 refusal included, which is what makes an unbounded probe divert to
 * the full scan instead of narrowing with a box that does not bound it.
 * @param {any} value - a GeoJSON value or a `[lon, lat]` position
 * @returns {number[] | null} `[west, south, east, north]`
 */
export function probeBox(value) {
  return bboxOf(value);
}

/**
 * The representative position §8.14 measures a probe value by — the
 * same rule the derived columns use, so the pushed filter and the
 * engine cannot disagree about where a value IS. `null` when it has no
 * bounded position.
 * @param {any} value
 * @returns {number[] | null}
 */
export function probePosition(value) {
  return representativePosition(value);
}

/**
 * The bounding box of the circle of `metres` around a position — the
 * box a `$distance <= r` predicate narrows with, on the same sphere and
 * the same radius constant the engine measures with. `null` when the
 * radius is not a finite non-negative number, or when the circle
 * reaches a pole, where there is no longitude bound to give.
 * @param {number[]} position
 * @param {number} metres
 * @returns {number[] | null} `[west, south, east, north]`, NOT wrapped
 *   into `[-180, 180]`: a circle spanning the antimeridian answers a
 *   west below -180, which is how the planner detects it
 */
export function probeCircleBox(position, metres) {
  return circleBounds(position[0], position[1], metres);
}

/**
 * A cell and its neighbours, the nine-cell probe D7 requires — a single
 * prefix is bucketing, never proximity.
 * @param {string} cell
 * @returns {string[]} up to nine cells (fewer past a pole)
 */
export function cellNeighbourhood(cell) {
  return geohashNeighbours(cell);
}

/**
 * The value one DERIVED parameter slot binds: an axis of a bound
 * external's bounding box, computed at bind time because a GeoJSON
 * object is not a value any database can bind. `null` when the value
 * has no box, which is what tells the caller to divert.
 * @param {{ kind: string, external: string, axis: string }} derived
 * @param {any} value - the bound external
 * @returns {number | null}
 */
export function derivedSlotValue(derived, value) {
  const box = bboxOf(value);
  return box === null ? null : box[BBOX_AT[derived.axis]];
}
