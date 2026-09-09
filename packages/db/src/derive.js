//@ts-check
/**
 * @file Derived index columns: the one place a declared
 * `indexes[].derive` becomes a value. A spatial member is an array of
 * numbers or an object, and a generated column must be a scalar, so a
 * geohash cell or a bounding-box edge is what actually gets indexed;
 * an embedding is an array of hundreds of numbers, and what gets
 * stored is its packed, l2-normalized Float32 form.
 *
 * Every cell and every box comes from `@jarenjs/core/geo`, and every
 * normalization and packing from `@jarenjs/core/vector`; nothing here
 * computes arithmetic of its own. The spatial functions serve BOTH
 * physical mappings — registered as deterministic SQL functions inside
 * a virtual generated column's expression where the driver can index
 * them, and called directly on the write path where it cannot — so
 * the two branches cannot drift into different answers. The vector
 * kind has ONE mapping, stored everywhere (`DERIVE_MAPPING`), and
 * registers no function at all: a whole array re-derived per row as a
 * host call is the cost the spatial work measured at 150×, a stored
 * column is readable without any registration, and bun has no
 * function API — one mapping is the only way every driver agrees.
 *
 * It is also this package's ONLY seam onto `@jarenjs/core/geo` (D1 —
 * one home for spatial arithmetic, grep-proven by test) and onto
 * `@jarenjs/core/vector` (the same rule, one home for vector
 * arithmetic): the planner's probe geometry — the box of a literal or
 * bound region, the box of a bounded-distance circle, a cell's
 * neighbourhood — and the k-nearest plan's probe vector and column
 * score are computed by the helpers below rather than by an import of
 * their own.
 *
 * The switches over the kind are EXHAUSTIVE: a kind with no rule
 * throws, here and in the dialect, so that adding a kind without
 * teaching both is a failure at the first call rather than a bbox
 * edge of the first two floats and `jaren_bbox_undefined(...)` SQL.
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
import {
  isVector, l2Normalize, packVector, unpackVector, dotProduct,
} from '@jarenjs/core/vector';

import { chain } from './driver.js';

/** The closed set of derive kinds. */
export const DERIVE_KINDS = new Set(['geohash', 'bbox', 'vector']);

/**
 * The per-kind PHYSICAL MAPPING override. A spatial kind takes the
 * mapping the driver's capability selects (`null` here); the vector
 * kind is `'stored'` on every driver, for the three reasons in the
 * file header, and never joins `registerDeriveFunctions`.
 * @type {Readonly<Record<string, 'stored' | null>>}
 */
export const DERIVE_MAPPING = Object.freeze({ geohash: null, bbox: null, vector: 'stored' });

/**
 * The physical mapping one derived column takes: the kind's override
 * where it has one, the driver's mapping otherwise.
 * @param {string} kind
 * @param {'virtual' | 'stored'} driverMapping
 * @returns {'virtual' | 'stored'}
 */
export function derivedMappingFor(kind, driverMapping) {
  if (!DERIVE_KINDS.has(kind)) throw new TypeError(`derive: unknown derive kind '${kind}'`);
  return DERIVE_MAPPING[kind] ?? driverMapping;
}

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

/** The declared vector width range (components). */
export const DIMS_MIN = 1;
export const DIMS_MAX = 8192;

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
 * The packed column value of a member ALREADY in its stored form (see
 * {@link storedMemberForm}): the l2-normalized vector as little-endian
 * binary32 bytes, or `null` when the member is not a vector of exactly
 * `dims` finite numbers — absent, the wrong width, a non-finite
 * component (which JSON turned into `null`), not an array at all. An
 * unrankable document is INVISIBLE to the column, never a stored-but-
 * wrong one; the document itself stores fine.
 *
 * Normalized because the stored form is what a fetch-and-rank plan
 * sweeps, and over unit vectors the dot product IS the cosine — the
 * agreement invariant between this column and an engine computing
 * cosine over the raw member. A zero vector normalizes to itself and
 * is stored (it scores 0 against everything; the kernel documents it
 * and the query format publishes it), not refused.
 * @param {any} stored - the member as the database holds it
 * @param {number} dims
 * @returns {Uint8Array | null}
 */
function packedVector(stored, dims) {
  if (!isVector(stored, dims)) return null;
  return packVector(l2Normalize(stored));
}

/**
 * The value of a `derive: 'vector'` column for a document member — the
 * ONE seam from this package onto `@jarenjs/core/vector`. The member
 * round-trips through its stored form first, exactly as the spatial
 * kinds do: a `Float32Array` in the document is held as an object and
 * a `NaN` as `null`, and the column must be a function of what is
 * held, so that a write, a migration backfill and a second open can
 * never disagree about one row.
 * @param {any} member - the value at the index path, or `undefined`
 * @param {number} dims - the declared width
 * @returns {Uint8Array | null} `4·dims` bytes, or `null` when the
 *   member is not a vector of that width
 */
export function deriveVector(member, dims) {
  return packedVector(storedMemberForm(member), dims);
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
 * The value of one derived column for a document member, which the
 * caller hands over in its STORED form (`storedMemberForm`): the write
 * path round-trips it, and a migration backfill reads it from the row.
 * Exhaustive over the kind — see the file header.
 * @param {{ derive: string, precision?: number, component?: string,
 *   dims?: number }} column
 * @param {any} member - the stored value at the index path, or `undefined`
 * @returns {string | number | Uint8Array | null}
 */
export function derivedValue(column, member) {
  if (member === undefined || member === null) return null;
  switch (column.derive) {
    case 'geohash':
      return deriveGeohash(member, /** @type {number} */ (column.precision));
    case 'bbox':
      return deriveBboxEdge(member, /** @type {string} */ (column.component));
    case 'vector':
      return packedVector(member, /** @type {number} */ (column.dims));
    default:
      throw new TypeError(`derive: no value rule for derive kind '${column.derive}'`);
  }
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
 * the JSON-valued extraction preserves the member's encoding otherwise,
 * including quotes around strings and the spelling of booleans.
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
 * @param {any} derived
 * @param {any} value - the bound external for bboxAxis; all externals for circleAxis
 * @returns {number | null}
 */
export function derivedSlotValue(derived, value) {
  let box;
  if (derived.kind === 'bboxAxis') box = bboxOf(value);
  else if (derived.kind === 'circleAxis') {
    const read = (input) => 'external' in input ? value[input.external] : input.literal;
    const at = probePosition(read(derived.centre));
    const radius = read(derived.radius);
    if (at === null || typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0)
      return null;
    box = probeCircleBox(at, radius);
    if (box !== null && (box[0] < -180 || box[2] > 180)) return null;
  }
  else throw new TypeError(`unknown derived parameter kind '${derived.kind}'`);
  return box === null ? null : box[BBOX_AT[derived.axis]];
}

/**
 * The probe a k-nearest plan scores the column against: a literal or
 * bound vector, l2-normalized once, so that its dot product with the
 * column's normalized form IS the cosine of the raw vectors. `null`
 * when the value is not a vector of exactly `dims` finite numbers —
 * the binder's signal to divert the call to the residual, where the
 * engine answers what it answers everywhere for such a probe (empty
 * keys for another width, its own refusal for a non-array).
 * @param {unknown} value
 * @param {number} dims - the column's declared width
 * @returns {Float32Array | null}
 */
export function probeVector(value, dims) {
  return isVector(value, dims) ? l2Normalize(value) : null;
}

/**
 * One row's column score against a prepared probe: the packed column
 * unpacked at the declared width and dotted with the probe. `null` for
 * a row whose column holds no vector — SQL `NULL`, or bytes of another
 * length — because such a row is unrankable and 0 is a real score.
 * @param {unknown} bytes - the column value as the driver returns it
 * @param {number} dims
 * @param {Float32Array} probe - from {@link probeVector}
 * @returns {number | null}
 */
export function columnScore(bytes, dims, probe) {
  const vector = unpackVector(/** @type {any} */ (bytes), dims);
  return vector === null ? null : dotProduct(vector, probe);
}
