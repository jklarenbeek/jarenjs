//@ts-check
/**
 * @file AST → Plan. The planner walks the engine's PUBLISHED normalized
 * AST (never the raw document), dispatches EXHAUSTIVELY on node kind —
 * an unrecognised kind is an internal error naming the kind and the
 * `AST_VERSION`, never a silent residual — and promotes constructs to
 * native form strictly residual-by-default: everything starts as a
 * residual and earns native status only where the equivalence proof
 * exists (the truth table in ARCHITECTURE.md, pinned by the
 * differential tests).
 *
 * The outcome of planning one document:
 *
 *   { plan, mode: 'native' | 'row' | 'set' | 'knn', reasons, rowReturn,
 *     prefilters }
 *
 * - `native` — everything translated; the plan alone answers.
 * - `row`    — predicates, ordering and window pushed; only the
 *   projection runs in the engine, per fetched row (streams).
 *   `rowReturn` is the COMPLETE one-row document to run, binding
 *   included — the collection binding is named by the document, so a
 *   wrapper built anywhere else would have to guess it.
 * - `set`    — the pushed conjuncts narrow candidates; the WHOLE
 *   compiled document runs over the materialized candidates.
 * - `knn`    — the pushed conjuncts narrow, the vector column CUTS the
 *   candidates of a k-nearest window (`plan.rank`), and the whole
 *   compiled document runs over the cut — a set residual whose
 *   candidate set an ordering, not a predicate, chose (see "The
 *   k-nearest promotion" below).
 *
 * `reasons` names every construct that forced work off the database,
 * with reason text drawn from the deliberate-residual table.
 * `prefilters` names the IMPLIED conjuncts — predicates the planner
 * ADDED because a spatial one provably implies them (see "Spatial
 * promotions" below) — with the columns each reads and whether it
 * decided or merely narrowed.
 */

import { analyzeQuery, AST_VERSION, NODE_KINDS } from '@jarenjs/json/query';

import {
  getEpochOfDateTimeRFC3339, getEpochOfDateOnlyRFC3339,
} from '@jarenjs/core/dates/rfc3339';
import { compileBuckets, resampleSeries, toEpoch } from '@jarenjs/core/series';

import { selectPlan, conjoin, PLAN_VERSION } from './algebra.js';
import { typeOfPath, isNumericType } from './types.js';
import { schemaNodeAt } from './ddl.js';
import {
  BBOX_COMPONENTS, BBOX_INDEX_ORDER, PRECISION_MIN, PRECISION_MAX,
  probeBox, probePosition, probeCircleBox, cellNeighbourhood, probeVector,
} from './derive.js';
import { KNN_MARGIN } from './knn.js';
import {
  SERIES_ROOT_OPS, NATIVE_AGGREGATES, seriesReason,
  instantIndexesOver, seekingIndexFor, filterFacts, fixedLadder, instantRefusal,
  valueRefusal, seriesRecord, singularSelector,
} from './series.js';

/** Comparison operator names → plan ops. */
const COMPARISONS = new Map([
  ['$eq', 'eq'], ['$ne', 'ne'],
  ['$lt', 'lt'], ['$le', 'le'], ['$gt', 'gt'], ['$ge', 'ge'],
]);
const ORDERING_OPS = new Set(['lt', 'le', 'gt', 'ge']);
const STRING_OPS = new Map([
  ['$starts-with', 'starts'], ['$ends-with', 'ends'], ['$contains', 'contains'],
]);
const AGGREGATES = new Map([
  ['$count', 'count'], ['$sum', 'sum'], ['$avg', 'avg'],
  ['$min', 'min'], ['$max', 'max'],
]);

/**
 * The exhaustiveness backstop: every kind the AST can produce must be
 * DECIDED here — handled by the planner or listed as a deliberate
 * residual. A kind outside this union is a language change this
 * planner has not seen, and it throws rather than degrades.
 */
const DECIDED_KINDS = new Set([
  'flwor', 'op', 'path', 'var', 'literal',
  // deliberate residuals, one reason each
  'object', 'map', 'array', 'raw', 'call', 'let', 'quant',
]);

const KIND_REASONS = {
  object: 'an object constructor runs in the engine (projection territory)',
  map: 'a computed-member constructor runs in the engine',
  array: 'an array constructor runs in the engine (projection territory)',
  raw: 'a raw value passes through the engine untouched',
  call: 'a host function call cannot run in the database',
  let: 'no equivalence proof exists yet; residual by default',
  quant: 'a quantifier over a nested sequence runs in the engine',
};

/**
 * Assert a node kind is one this planner has decided. Called on every
 * dispatch; the throw names the kind and the AST version so a language
 * change breaks the build instead of becoming an accidental residual.
 * Exported so the throw itself is pinned by a test.
 * @param {any} node
 */
export function assertDecidedKind(node) {
  const kind = node?.kind;
  if (!DECIDED_KINDS.has(kind)) {
    throw new Error(
      `pushdown planner: unrecognised AST node kind '${String(kind)}' `
      + `(AST_VERSION ${AST_VERSION}) — the planner must be taught this construct`);
  }
}

// the exhaustiveness pact: if the engine adds a kind, this module
// fails to load until the planner decides it
for (const kind of NODE_KINDS) {
  if (!DECIDED_KINDS.has(kind)) {
    throw new Error(
      `pushdown planner: NODE_KINDS declares '${kind}' (AST_VERSION ${AST_VERSION}) `
      + 'but the planner has not decided it');
  }
}

/**
 * One named refusal.
 * @param {string} construct
 * @param {string} reason
 * @returns {{ construct: string, reason: string }}
 */
function refusal(construct, reason) {
  return { construct, reason };
}

/**
 * A translated predicate that DECIDES: no pre-filter, nothing left for
 * a residual to refine.
 * @param {import('./algebra.js').PlanPredicate} pred
 */
function exactly(pred) {
  return { pred, exact: true, prefilters: [], refinements: [] };
}

// ————— Registered operators (Ring 2) —————
//
// A store may open with a registry (createJsltRegistry()) whose
// operators become engine vocabulary. Ring 2 treats every registered
// operator as CORRECT but UN-pushable: the planner must KNOW its name
// (so the AST analysis does not fail `JQ0002`) yet still route it to the
// residual, where the compilation carries the same `{ functions,
// extensions }`. Ring 3 will promote the pushable subset to SQL; here
// everything registered runs in JavaScript over the fetched rows.

/**
 * The analyze options carrying the store's registered operators. A
 * registered operator is engine vocabulary, so the AST analysis must be
 * told its `{ functions, extensions }` or it rejects the document as an
 * unknown operator. `null`/absent operators → `undefined`, so a store
 * without a registry analyses byte-identically to before.
 * @param {{ functions?: any, extensions?: any } | null | undefined} operators
 * @returns {any}
 */
function analyzeOptionsFor(operators) {
  if (operators == null) return undefined;
  /** @type {any} */
  const options = {};
  if (operators.functions !== undefined) options.functions = operators.functions;
  if (operators.extensions !== undefined) options.extensions = operators.extensions;
  return options;
}

/**
 * The set of registered first-class operator names (the `op`/`agg`
 * entries that appear as document keys), or `null` when none.
 * @param {{ extensions?: any } | null | undefined} operators
 * @returns {Set<string> | null}
 */
function registeredNamesOf(operators) {
  if (operators == null) return null;
  const names = new Set(Object.keys(operators.extensions ?? {}));
  return names.size === 0 ? null : names;
}

/**
 * Which registered operator names a raw document mentions (a `$`-key is
 * an operator call). Robust across where/return/root placement, since it
 * walks the document rather than the AST.
 * @param {any} document
 * @param {Set<string>} registered
 * @returns {string[]}
 */
function registeredOpsUsed(document, registered) {
  const found = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        if (registered.has(key)) found.add(key);
        walk(node[key]);
      }
    }
  };
  walk(document);
  return [...found];
}

/**
 * Prepend an honest, named residual reason when a non-native plan used a
 * registered operator: `explain()` then says plainly that the operator
 * forced the residual, never silently. Native plans and no-registry
 * stores pass through untouched.
 * @param {any} planned - a planner result carrying `mode` and `reasons`
 * @param {any} document
 * @param {{ extensions?: any } | null | undefined} operators
 * @returns {any}
 */
function prependRegisteredReason(planned, document, operators) {
  if (planned.mode === 'native') return planned;
  const registered = registeredNamesOf(operators);
  if (registered === null) return planned;
  // only the part that actually runs in the residual can name an operator
  // as "residual": in `row` mode the where/order are pushed (a scalar
  // operator there may even be a Ring 3 UDF) and just the projection runs
  // per row; in `set` mode the whole document re-runs over the candidates
  const residualPart = planned.mode === 'row' ? planned.rowReturn : document;
  const used = registeredOpsUsed(residualPart, registered);
  if (used.length === 0) return planned;
  const many = used.length > 1;
  return {
    ...planned,
    reasons: [
      {
        construct: used.join(', '),
        reason: `registered operator${many ? 's' : ''} `
          + `${used.map((n) => `'${n}'`).join(', ')} run${many ? '' : 's'} in the residual `
          + '(Ring 2 — correct, not pushed to SQL)',
      },
      ...planned.reasons,
    ],
  };
}

/**
 * Is this node the bare binding variable (the whole item)?
 * @param {any} node
 * @param {number} itSlot
 */
function isItVar(node, itSlot) {
  return node.kind === 'var' && node.external !== true && node.slot === itSlot;
}

/**
 * The typed segments of a singular member path rooted on the binding,
 * with the canonical spelling the physical mapping keys columns by.
 * `null` when the node is not such a path.
 * @param {any} node
 * @param {number} itSlot
 * @returns {{ segments: ({ name: string } | { index: number })[],
 *   canonical: string } | null}
 */
function memberPath(node, itSlot) {
  if (node.kind !== 'path' || node.external === true) return null;
  if (node.rootSlot !== itSlot || node.singular !== true) return null;
  /** @type {({ name: string } | { index: number })[]} */
  const segments = [];
  for (const segment of node.segments) {
    if (segment.descendant === true || segment.selectors.length !== 1) return null;
    const selector = segment.selectors[0];
    if (selector.kind === 'name') segments.push({ name: selector.name });
    else if (selector.kind === 'index') segments.push({ index: selector.index });
    else return null;
  }
  if (segments.length === 0) return null;
  const canonical = segments
    .map((s) => ('name' in s ? `.${s.name}` : `[${s.index}]`)).join('');
  return { segments, canonical };
}

/**
 * A singular member path rooted on the binding → a PlanRef, or null.
 * @param {any} node
 * @param {number} itSlot
 * @param {any} shape - { schema, columnByCanonical }
 * @returns {import('./algebra.js').PlanRef | null}
 */
function pathRef(node, itSlot, shape) {
  const path = memberPath(node, itSlot);
  if (path === null) return null;
  return {
    segments: path.segments,
    type: typeOfPath(shape.schema, path.segments),
    column: shape.columnByCanonical.get(path.canonical) ?? null,
  };
}

/**
 * A literal or external operand, or null.
 * @param {any} node
 * @returns {import('./algebra.js').PlanOperand | null}
 */
function operandOf(node) {
  if (node.kind === 'literal') return { lit: node.value };
  if (node.kind === 'var' && node.external === true) return { ext: node.name };
  return null;
}

/** @param {any} value */
function isScalarLiteral(value) {
  return value === null || typeof value === 'string'
    || typeof value === 'number' || typeof value === 'boolean';
}


// ————— Spatial promotions: the implied conjunct —————
//
// Every other conjunct the planner pushes is a conjunct OF the document:
// it translates exactly or it does not. A spatial predicate cannot be
// translated exactly — there is no `ST_Within` in SQLite and this
// package does not build one — but it IMPLIES one that can be, over the
// derived columns a model declares (`indexes[].derive`): a bounding-box
// overlap, or a geohash-cell range.
//
// An IMPLIED conjunct narrows; it never decides. Three properties make
// that safe, and each is asserted by test:
//
//  1. No false negatives — every row the document's predicate keeps
//     passes the implied one. The proof per rule is in ARCHITECTURE.md's
//     truth table. A row with no derived value at all is not an
//     exception: the box is missing in exactly the cases §8.14's
//     representative position is, so the engine answers false for it
//     too. What a pre-filter DOES change is which rows can raise —
//     one it excludes never reaches the engine — and that is why the
//     precondition below is a schema one.
//  2. Idempotent refinement — the residual re-runs the ORIGINAL
//     predicate over the narrowed candidates, so the answer is the
//     engine's. That is why an implied conjunct forces the SET residual
//     rather than the row one.
//  3. `strict: true` refuses it — an implied conjunct leaves its own
//     reason behind, so the plan is not native and `JD0010` names it.
//
// A promotion reads a member the schema types as an array or an object.
// That precondition is the string operators' rule again: §8.14 answers
// `JQ2001` for a non-geographic operand, so on a member the schema does
// not type as geography a pushed filter could silently answer where the
// engine would throw.

/** The geographic schema types a spatial promotion is allowed over. */
const GEO_TYPES = new Set(['array', 'object']);

/**
 * Does the schema type this member as geography and ONLY as geography?
 * A union of `array` and `object` is the natural declaration for a
 * §8.14 operand (a bare position or a geometry); one that also admits
 * `null` is not, because §8.14 answers `JQ2001` for a `null` operand
 * while a pushed filter would simply not see the row.
 * @param {any} node - a subschema, or `undefined`
 * @returns {boolean}
 */
function isGeographicSchema(node) {
  const declared = node?.type;
  if (typeof declared === 'string') return GEO_TYPES.has(declared);
  return Array.isArray(declared) && declared.length > 0
    && declared.every((type) => GEO_TYPES.has(type));
}

/** `$geohash`'s default precision (QUERY-FORMAT §8.14). */
const GEOHASH_DEFAULT_PRECISION = 9;

const SPATIAL_REASONS = {
  within: 'a bounding-box pre-filter is pushed; exact containment refines in the engine',
  distance: 'a geodesic-circle box pre-filter is pushed; the exact distance refines in the engine',
  prefix: "a cell-range pre-filter over the derived column's precision is pushed; "
    + 'the longer prefix refines in the engine',
  noIndex: 'no derived spatial index on this member covers the predicate '
    + '(declare indexes[].derive on it)',
  notGeographic: 'spatial predicates translate only over a member the schema types as an '
    + 'array or an object (the engine ERRORS on a non-geographic operand)',
  operand: 'a spatial predicate translates only against a literal value or an external',
  unbounded: 'the probe has no bounding box, so no conservative pre-filter exists',
  pole: 'the circle reaches a pole, where a box has no longitude bound at all — '
    + 'pushing nothing is correct, pushing a wrong box is not',
  wrapped: 'the circle crosses the antimeridian, and a box that crosses it would need two '
    + 'disjuncts this suite\'s box convention does not carry — '
    + 'pushing nothing is correct, pushing a wrong box is not',
  precision: "the cell length must match the derived column's precision",
  rtreeBox: "the box is stored in an R*Tree, whose coordinates are 32-bit floats rounded "
    + 'OUTWARD, so the stored box is a superset of the row\'s; the exact box test refines '
    + 'in the engine',
};

/**
 * The constant value an AST subtree denotes, or `null` when it denotes
 * anything else. A literal GeoJSON region in a document is NOT a
 * `literal` node — it is the object/array constructor tree the engine
 * builds from the same members — so the planner folds it here to get
 * the value it must compute a probe box from.
 * @param {any} node
 * @returns {{ value: any } | null}
 */
function constantOf(node) {
  if (node.kind === 'literal') return { value: node.value };
  if (node.kind === 'array') {
    const value = [];
    for (const element of node.elements) {
      const item = constantOf(element);
      if (item === null) return null;
      value.push(item.value);
    }
    return { value };
  }
  if (node.kind === 'object') {
    /** @type {any} */
    const value = {};
    for (const entry of node.entries) {
      if (typeof entry.name !== 'string') return null;
      const member = constantOf(entry.expr);
      if (member === null) return null;
      value[entry.name] = member.value;
    }
    return { value };
  }
  return null;
}

/**
 * The derived columns one `(member, derivation)` pair maps to, or
 * `null` when the collection declares no such index. The identity is
 * the same one the physical mapping keys its column set by — path,
 * kind AND precision — so a query at a different precision finds no
 * column rather than the wrong one.
 * @param {any} shape
 * @param {string} canonical
 * @param {'geohash' | 'bbox'} derive
 * @param {number} [precision]
 * @returns {string | { w: string, s: string, e: string, n: string } | null}
 */
/**
 * The R\*Tree virtual table a `bbox` column set is realized as, or
 * `null` when it is realized as four columns under a B-tree — which is
 * also the answer on a driver whose build carries no R\*Tree module,
 * because the physical plan already fell back there (MODEL-FORMAT §4).
 * @param {any} shape
 * @param {string} canonical
 * @returns {{ name: string, columns: string[] } | null}
 */
function rtreeTableOf(shape, canonical) {
  const stem = shape.columnByCanonical?.get(`${canonical}|bbox|`);
  if (stem === undefined) return null;
  return shape.virtualByStem?.get(stem) ?? null;
}

/**
 * The pushed box conjunct for one column set, under whichever physical
 * mapping the collection declares — the same box either way, because
 * the implied-conjunct proof is a proof about BOXES and not about SQL.
 *
 * Under `'rtree'` it is a `rowid` subquery over the virtual table: a
 * conjunct on the collection table, so the `FROM` clause, the residual
 * machinery and `prefilters` are all untouched. A join would be 6 %
 * faster and would need join support the emitter does not have; a
 * correlated `EXISTS` defeats the virtual table's index entirely and is
 * 85x worse than the subquery.
 * @param {{ w: string, s: string, e: string, n: string }} columns
 * @param {{ name: string, columns: string[] } | null} virtual
 * @param {any} probe
 * @returns {{ pred: any, via: 'columns' | 'rtree', columns: string[],
 *   inexact: boolean }}
 */
function boxConjunct(columns, virtual, probe) {
  if (virtual === null) {
    return { pred: { p: 'bboxOverlap', columns, probe },
      via: 'columns', columns: boxColumnList(columns), inexact: false };
  }
  return { pred: { p: 'bboxRtree', table: virtual.name, columns: virtual.columns, probe },
    via: 'rtree', columns: [...virtual.columns], inexact: true };
}

function derivedColumnsOf(shape, canonical, derive, precision) {
  // `precision` is the identity's third component: a geohash column's
  // precision, a vector column's `dims`
  const stem = shape.columnByCanonical?.get(`${canonical}|${derive}|${precision ?? ''}`);
  if (stem === undefined) return null;
  if (derive === 'geohash' || derive === 'vector') return stem;
  /** @type {any} */
  const columns = {};
  for (const component of BBOX_COMPONENTS) columns[`${component}`] = `${stem}_${component}`;
  return columns;
}

/**
 * The vector columns declared over one canonical path, by width. The
 * identity key is `<canonical>|vector|<dims>`, so one path may carry
 * one column per declared width and a probe chooses by its own.
 * @param {any} shape
 * @param {string} canonical
 * @returns {{ column: string, dims: number }[]}
 */
function vectorColumnsOf(shape, canonical) {
  const prefix = `${canonical}|vector|`;
  const found = [];
  for (const [key, column] of shape.columnByCanonical ?? []) {
    if (key.startsWith(prefix))
      found.push({ column, dims: Number(key.slice(prefix.length)) });
  }
  return found;
}

/**
 * A spatial SUBJECT: a singular member path on the binding that the
 * schema types as geography. Answers the canonical path a derived
 * column set is looked up by, or a named refusal.
 * @param {any} node
 * @param {number} itSlot
 * @param {any} shape
 * @param {string} construct
 * @returns {{ canonical: string } | { refusal: { construct: string, reason: string } }}
 */
function spatialSubject(node, itSlot, shape, construct) {
  const path = memberPath(node, itSlot);
  if (path === null || !isGeographicSchema(schemaNodeAt(shape.schema, path.segments)))
    return { refusal: refusal(construct, SPATIAL_REASONS.notGeographic) };
  return { canonical: path.canonical };
}

/** A promotion outcome: a pushed predicate that may still need refining. */
function promotion(pred, prefilter, refinements = []) {
  return { pred, exact: refinements.length === 0, prefilters: [prefilter], refinements };
}

/** The four bbox columns in the order the declared index covers them. */
function boxColumnList(columns) {
  return BBOX_INDEX_ORDER.map((component) => columns[component]);
}

/**
 * P1/P2 — a box predicate over a `bbox`-derived index.
 *
 * `$bbox-intersects(path, probe)` is EXACT: the derived columns ARE the
 * row's box, so overlap is fully decidable in SQL. `<=`/`>=` and not
 * `<`/`>` because the kernel counts touching edges as intersecting.
 *
 * `$within(path, area)` is IMPLIED by the same overlap: the subject's
 * representative position lies inside its own box (a bare position IS
 * the box; a centroid is a mean of positions and a mean lies within
 * their min/max), and inside the area's surface implies inside the
 * area's box — so the two boxes share at least that position.
 * @param {any} node
 * @param {number} itSlot
 * @param {any} shape
 * @returns {any}
 */
function planBoxPredicate(node, itSlot, shape) {
  const construct = node.name;
  const symmetric = construct === '$bbox-intersects';
  // `$within` asks whether the FIRST value is inside the second, so only
  // the first may be the row; box overlap is symmetric, so either may be
  let subjectAt = 0;
  if (symmetric && memberPath(node.args[0], itSlot) === null
    && memberPath(node.args[1], itSlot) !== null) subjectAt = 1;
  const subject = spatialSubject(node.args[subjectAt], itSlot, shape, construct);
  if ('refusal' in subject) return subject;
  const columns = derivedColumnsOf(shape, subject.canonical, 'bbox');
  if (columns === null) return { refusal: refusal(construct, SPATIAL_REASONS.noIndex) };

  const probeNode = node.args[subjectAt === 0 ? 1 : 0];
  /** @type {any} */
  let probe = null;
  if (probeNode.kind === 'var' && probeNode.external === true) {
    // a GeoJSON object is not a value any database binds, so its four
    // box edges bind instead — computed at bind time from the same
    // kernel the stored columns were computed with
    probe = { ext: probeNode.name };
  }
  else {
    const constant = constantOf(probeNode);
    if (constant === null) return { refusal: refusal(construct, SPATIAL_REASONS.operand) };
    const box = probeBox(constant.value);
    if (box === null) return { refusal: refusal(construct, SPATIAL_REASONS.unbounded) };
    probe = { box };
  }
  const conjunct = boxConjunct(columns, rtreeTableOf(shape, subject.canonical), probe);
  // `$bbox-intersects` is EXACT over the four columns — they ARE
  // `B(row)` — and only IMPLIED over an R*Tree, whose 32-bit float
  // coordinates round outward: the stored box is a superset. No false
  // negatives either way, which is what D8 needs; but a superset does
  // not DECIDE, so the exact box test keeps its refinement and
  // `strict: true` is JD0010 where the column mapping ran native
  const exact = construct === '$bbox-intersects' && !conjunct.inexact;
  const refinements = construct === '$bbox-intersects'
    ? (conjunct.inexact ? [refusal(construct, SPATIAL_REASONS.rtreeBox)] : [])
    : [refusal('$within', SPATIAL_REASONS.within)];
  return promotion(conjunct.pred,
    { construct, via: conjunct.via, columns: conjunct.columns, exact }, refinements);
}

/**
 * P3 — a BOUNDED `$distance` is implied by the box of its circle.
 *
 * Recognized: `{$le|$lt: [{$distance: [path, probe]}, r]}` and the
 * mirrored `{$ge|$gt: [r, {$distance: …}]}`. A "farther than r"
 * predicate is deliberately NOT promoted: no box narrows it.
 *
 * The box comes from `circleBounds` on the same sphere and the same
 * `EARTH_RADIUS` the engine's `$distance` measures with, so the two
 * cannot disagree by model rather than by rounding — there is no
 * padding constant here, because no honest value could be chosen for
 * one. Two refusals instead: a circle reaching a pole has no longitude
 * bound at all, and one crossing the antimeridian would need two
 * disjoint boxes this suite's box convention cannot carry.
 * @param {any} node
 * @param {number} itSlot
 * @param {any} shape
 * @returns {any}
 */
function planDistanceBound(node, itSlot, shape) {
  const op = COMPARISONS.get(node.name);
  const upperOnLeft = op === 'le' || op === 'lt';
  const distanceNode = upperOnLeft ? node.args[0] : node.args[1];
  const radiusNode = upperOnLeft ? node.args[1] : node.args[0];
  const radius = constantOf(radiusNode);
  if (radius === null || typeof radius.value !== 'number')
    return { refusal: refusal('$distance', SPATIAL_REASONS.operand) };

  let subjectAt = 0;
  if (memberPath(distanceNode.args[0], itSlot) === null
    && memberPath(distanceNode.args[1], itSlot) !== null) subjectAt = 1;
  const subject = spatialSubject(distanceNode.args[subjectAt], itSlot, shape, '$distance');
  if ('refusal' in subject) return subject;
  const columns = derivedColumnsOf(shape, subject.canonical, 'bbox');
  if (columns === null) return { refusal: refusal('$distance', SPATIAL_REASONS.noIndex) };

  const probeNode = distanceNode.args[subjectAt === 0 ? 1 : 0];
  const constant = constantOf(probeNode);
  // an EXTERNAL centre would need a slot that composes the bound value
  // with the radius, and the derived slot kind is closed at one axis of
  // one bound value; such a query diverts to the full scan as before
  if (constant === null) return { refusal: refusal('$distance', SPATIAL_REASONS.operand) };
  const at = probePosition(constant.value);
  if (at === null) return { refusal: refusal('$distance', SPATIAL_REASONS.unbounded) };
  const box = probeCircleBox(at, radius.value);
  if (box === null) return { refusal: refusal('$distance', SPATIAL_REASONS.pole) };
  if (box[0] < -180 || box[2] > 180)
    return { refusal: refusal('$distance', SPATIAL_REASONS.wrapped) };

  const conjunct = boxConjunct(columns, rtreeTableOf(shape, subject.canonical), { box });
  return promotion(conjunct.pred,
    { construct: '$distance', via: conjunct.via, columns: conjunct.columns, exact: false },
    [refusal('$distance', SPATIAL_REASONS.distance)]);
}

/**
 * The `(canonical, precision)` a `$geohash` call over the binding
 * denotes, or a refusal. The precision must be a literal — it decides
 * WHICH column the derivation maps to.
 * @param {any} node
 * @param {number} itSlot
 * @param {any} shape
 * @param {string} construct
 * @returns {any}
 */
function geohashDerivation(node, itSlot, shape, construct) {
  if (node.kind !== 'op' || node.name !== '$geohash')
    return { refusal: refusal(construct, SPATIAL_REASONS.operand) };
  let precision = GEOHASH_DEFAULT_PRECISION;
  if (node.args.length > 1) {
    const declared = constantOf(node.args[1]);
    if (declared === null || !Number.isInteger(declared.value)
      || declared.value < PRECISION_MIN || declared.value > PRECISION_MAX)
      return { refusal: refusal(construct, SPATIAL_REASONS.operand) };
    precision = declared.value;
  }
  const subject = spatialSubject(node.args[0], itSlot, shape, construct);
  if ('refusal' in subject) return subject;
  const column = derivedColumnsOf(shape, subject.canonical, 'geohash', precision);
  if (column === null) return { refusal: refusal(construct, SPATIAL_REASONS.noIndex) };
  return { column: /** @type {string} */ (column), precision };
}

/**
 * P4, bucketing — `{$starts-with: [{$geohash: [path, k]}, "cell"]}` over
 * a `geohash` index declared at exactly `k`. The column HOLDS the k-
 * character cell, so a prefix test on the expression is a prefix test
 * on the column: exact while the literal is no longer than k, and
 * merely implied beyond it, where the column can only confirm its own
 * first k characters.
 *
 * A prefix range is what order 01 made sargable; `LIKE` and `substr`
 * both scan.
 * @param {any} node
 * @param {number} itSlot
 * @param {any} shape
 * @returns {any}
 */
function planCellPrefix(node, itSlot, shape) {
  const derivation = geohashDerivation(node.args[0], itSlot, shape, '$starts-with');
  if ('refusal' in derivation) return derivation;
  const pattern = constantOf(node.args[1]);
  if (pattern === null || typeof pattern.value !== 'string' || pattern.value === '')
    return { refusal: refusal('$starts-with', SPATIAL_REASONS.operand) };
  const exact = pattern.value.length <= derivation.precision;
  const cell = exact ? pattern.value : pattern.value.slice(0, derivation.precision);
  // a pattern as long as the column's own cell is an EQUALITY on it;
  // a shorter one is the half-open range order 01 made sargable
  const pred = cell.length === derivation.precision
    ? { p: 'cellIn', column: derivation.column, cells: [cell] }
    : { p: 'cellPrefix', column: derivation.column, prefix: cell };
  return promotion(pred,
    { construct: '$starts-with', via: 'columns', columns: [derivation.column], exact },
    exact ? [] : [refusal('$starts-with', SPATIAL_REASONS.prefix)]);
}

/**
 * P4, proximity — the nine-cell probe (D7), promoted to a membership
 * test over one column. The single-cell version misses a point ten metres
 * away across a cell edge, so a single prefix is BUCKETING and only the
 * neighbourhood is proximity; this is the shape §8.14 publishes with
 * the cells inline, where the planner can see them.
 *
 * Recognized: `{$exists: {$index-of: [{$geohash-neighbours: "cell"},
 * {$geohash: [path, k]}]}}`. Exact only when the cell's length IS k —
 * the membership test compares whole strings, so any other length makes
 * the document's own predicate constantly false and the promotion would
 * be answering a different question.
 * @param {any} node
 * @param {number} itSlot
 * @param {any} shape
 * @returns {any}
 */
function planCellNeighbourhood(node, itSlot, shape) {
  const membership = node.args[0];
  const neighbours = membership.args[0];
  const cell = constantOf(neighbours.args[0]);
  if (cell === null || typeof cell.value !== 'string' || cell.value === '')
    return { refusal: refusal('$geohash-neighbours', SPATIAL_REASONS.operand) };
  const derivation = geohashDerivation(membership.args[1], itSlot, shape, '$geohash-neighbours');
  if ('refusal' in derivation) return derivation;
  if (cell.value.length !== derivation.precision)
    return { refusal: refusal('$geohash-neighbours', SPATIAL_REASONS.precision) };
  const cells = cellNeighbourhood(cell.value);
  if (cells.length === 0)
    return { refusal: refusal('$geohash-neighbours', SPATIAL_REASONS.operand) };
  return promotion({ p: 'cellIn', column: derivation.column, cells },
    { construct: '$geohash-neighbours', via: 'columns', columns: [derivation.column],
      exact: true });
}

// ————— The k-nearest promotion: an ORDERING the column pre-filters —————
//
// `$orderby` on a `$similarity` key, descending, `$empty: 'least'`,
// under a `$subsequence` window with a finite limit, over a member a
// `derive: 'vector'` column stores: the one ordering the planner
// promotes. Not to SQL — no ORDER BY is emitted, no per-row similarity
// call, no LIMIT: every SQL spelling of the rank measured slower than
// fetching the packed column and ranking in the engine, and none of
// them runs where no function can be registered — but to a CUT. The
// statement projects (identity, column) under the pushed WHERE; the
// engine scores every row's column against the probe; the rows whose
// score is within `KNN_MARGIN` of the `offset + limit`-th best are the
// candidates. Then the ENGINE decides: the original document — its
// whole `$orderby` (the similarity key over the raw member, every
// secondary key, `$empty`), its window, its `$return` — runs as the set
// residual over exactly those documents.
//
// What makes that exact is the implied-conjunct argument, applied to an
// ordering. The column's score (a dot product over binary32-normalized
// forms) and the engine's key (the cosine of the raw doubles) differ by
// at most ~1e-8, measured; with a margin two orders of magnitude wider
// the engine's top `offset + limit` is a SUBSET of the candidates — a
// row the engine ranks inside the window that the column left out would
// need two true cosines to differ by more than the column can mis-order
// them. Ties at the boundary are included by construction, and the
// engine breaks them by the document's own secondary keys, which is why
// no row-identity tie rule exists here: row identity serves the fetch,
// never the order.
//
// Two shapes reach the window's tail that no cut can order: fewer than
// `offset + limit` rows scored — a small collection, or NULL columns
// (absent, wrong-width, non-finite members) — so the window reaches the
// unrankable rows, which `$empty: 'least'` places LAST in the engine's
// own secondary order. The candidate set is then every row, and the
// collection is no larger than the window.
//
// Preconditions, each a named refusal. The selection must be pushed
// WHOLE — every `$where` conjunct exact, nothing before it — because a
// conjunct left to the residual could drop a candidate the cut counted,
// and an implied one narrows to a superset the residual then shrinks;
// either could leave the window short. The probe must be a literal
// vector of the column's width, or an external: what an external
// carries is the binder's to check at call time, and a bound value that
// is not a vector of that width DIVERTS the call to the residual, where
// the engine answers what it answers everywhere (empty keys for another
// width, its own refusal of a non-array) — never a plan-side error the
// engine would not raise.

const KNN_REASONS = {
  rank: 'k-nearest rank is engine work: the vector column cuts the candidates and the engine orders them',
  direction: 'k-nearest is promoted only descending (higher similarity first)',
  empties: "k-nearest is promoted only under $empty: 'least' (unrankable rows last, where the cut can reach them)",
  collation: 'a collation on a similarity key is refused, not approximated',
  subject: 'the similarity key must compare a singular member path on the binding with a probe',
  probe: 'the probe must be a literal vector (an array of finite numbers) or an external',
  selection: 'k-nearest ranks over the column only when the selection is pushed whole (every $where conjunct exact, no $let or $as before it)',
  window: 'k-nearest needs a window with a finite limit; an unbounded ranking is a full sort in the engine',
  /** @param {string} path @param {number | null} dims */
  noColumn: (path, dims) =>
    `no vector column over ${path}${dims === null ? '' : ` at width ${dims}`}`,
  /** @param {string} path @param {number} want @param {number[]} have */
  dims: (path, want, have) =>
    `the literal probe has ${want} components but the vector column over ${path} is declared at ${have.join(', ')}`,
  /** @param {string} path */
  widths: (path) =>
    `several vector widths are declared over ${path}; an external probe cannot choose one at plan time`,
};

/**
 * Recognize the k-nearest ordering, or say why not. `null` when the
 * first key is not a `$similarity` at all — an ordinary ordering the
 * caller plans as before. Further key specs are the engine's business
 * (they order the candidates), so nothing here reads them.
 * @param {any} orderby - the flwor's orderby node
 * @param {number} itSlot
 * @param {any} shape
 * @param {boolean} selectionPushed - the WHERE pushed whole and exact,
 *   with nothing before it
 * @returns {{ rank: { column: string, dims: number,
 *   probe: { lit: number[] } | { ext: string } } }
 *   | { refusal: { construct: string, reason: string } } | null}
 */
function planKnnOrder(orderby, itSlot, shape, selectionPushed) {
  const first = orderby.specs[0];
  const key = first.key;
  if (key.kind !== 'op' || key.name !== '$similarity') return null;
  const refuse = (reason) => ({ refusal: refusal('$similarity', reason) });
  if (first.desc !== true) return refuse(KNN_REASONS.direction);
  if (first.emptyGreatest === true) return refuse(KNN_REASONS.empties);
  if (first.collation !== null || first.collationName !== null)
    return refuse(KNN_REASONS.collation);
  // the subject may be either operand; the other is the probe
  let subjectAt = 0;
  if (memberPath(key.args[0], itSlot) === null && memberPath(key.args[1], itSlot) !== null)
    subjectAt = 1;
  const subject = memberPath(key.args[subjectAt], itSlot);
  if (subject === null) return refuse(KNN_REASONS.subject);
  const path = `$${subject.canonical}`;
  const probeNode = key.args[subjectAt === 0 ? 1 : 0];
  const declared = vectorColumnsOf(shape, subject.canonical);

  if (probeNode.kind === 'var' && probeNode.external === true) {
    if (declared.length === 0) return refuse(KNN_REASONS.noColumn(path, null));
    if (declared.length > 1) return refuse(KNN_REASONS.widths(path));
    if (!selectionPushed) return refuse(KNN_REASONS.selection);
    return { rank: { column: declared[0].column, dims: declared[0].dims,
      probe: { ext: probeNode.name } } };
  }
  const constant = constantOf(probeNode);
  if (constant === null || !Array.isArray(constant.value)) return refuse(KNN_REASONS.probe);
  const dims = constant.value.length;
  if (probeVector(constant.value, dims) === null) return refuse(KNN_REASONS.probe);
  const column = derivedColumnsOf(shape, subject.canonical, 'vector', dims);
  if (column === null) {
    return refuse(declared.length === 0
      ? KNN_REASONS.noColumn(path, dims)
      : KNN_REASONS.dims(path, dims, declared.map((entry) => entry.dims)));
  }
  if (!selectionPushed) return refuse(KNN_REASONS.selection);
  return { rank: { column: /** @type {string} */ (column), dims, probe: { lit: constant.value } } };
}

/**
 * Dispatch the spatial shapes. Answers `null` when the node is not one
 * of them, so the caller falls through to the rest of the grammar.
 * @param {any} node
 * @param {number} itSlot
 * @param {any} shape
 * @returns {any}
 */
function planSpatial(node, itSlot, shape) {
  if (node.name === '$within' || node.name === '$bbox-intersects')
    return planBoxPredicate(node, itSlot, shape);
  const op = COMPARISONS.get(node.name);
  if (op !== undefined && ORDERING_OPS.has(op)) {
    const upperOnLeft = op === 'le' || op === 'lt';
    const distanceNode = upperOnLeft ? node.args[0] : node.args[1];
    if (distanceNode?.kind === 'op' && distanceNode.name === '$distance')
      return planDistanceBound(node, itSlot, shape);
    // `$distance >= r` — "farther than" — is narrowed by no box at all
    const other = upperOnLeft ? node.args[1] : node.args[0];
    if (other?.kind === 'op' && other.name === '$distance') {
      return { refusal: refusal('$distance',
        'only a BOUNDED distance is promoted; no box narrows "farther than r"') };
    }
    return null;
  }
  if (node.name === '$starts-with' && node.args[0]?.kind === 'op'
    && node.args[0].name === '$geohash')
    return planCellPrefix(node, itSlot, shape);
  if (node.name === '$exists' && node.args[0]?.kind === 'op'
    && node.args[0].name === '$index-of'
    && node.args[0].args[0]?.kind === 'op'
    && node.args[0].args[0].name === '$geohash-neighbours')
    return planCellNeighbourhood(node, itSlot, shape);
  return null;
}

/**
 * Translate one predicate node, or explain why not.
 *
 * A translated predicate is EXACT unless it carries `refinements`: an
 * implied spatial conjunct narrows the fetch and leaves the original
 * predicate to the residual, and `prefilters` records what it reads so
 * `explain()` can say whether a declared index is earning its keep.
 * @param {any} node
 * @param {number} itSlot
 * @param {any} shape
 * @returns {{ pred: import('./algebra.js').PlanPredicate, exact: boolean,
 *   prefilters: any[], refinements: { construct: string, reason: string }[] } |
 *   { refusal: { construct: string, reason: string } }}
 */
function planPredicate(node, itSlot, shape) {
  assertDecidedKind(node);
  if (node.kind !== 'op') {
    return { refusal: refusal(node.kind, KIND_REASONS[node.kind]
      ?? 'not a predicate the planner translates') };
  }

  if (node.name === '$and' || node.name === '$or') {
    const items = [];
    const prefilters = [];
    const refinements = [];
    for (const arg of node.args) {
      const inner = planPredicate(arg, itSlot, shape);
      if ('refusal' in inner) return inner; // partial $or/$and is not splittable here
      items.push(inner.pred);
      prefilters.push(...inner.prefilters);
      refinements.push(...inner.refinements);
    }
    // an implied child makes the composition a SUPERSET either way, so
    // it still narrows honestly — it just stops deciding
    return { pred: { p: node.name === '$and' ? 'and' : 'or', items },
      exact: refinements.length === 0, prefilters, refinements };
  }
  if (node.name === '$not') {
    const inner = planPredicate(node.args[0], itSlot, shape);
    if ('refusal' in inner) return inner;
    if (inner.refinements.length > 0) {
      // negating a superset is a SUBSET, which drops matching rows —
      // the one composition an implied conjunct may never enter
      return { refusal: refusal('$not',
        'a negated predicate cannot ride an implied pre-filter (negating a superset drops rows)') };
    }
    return { pred: { p: 'not', item: inner.pred },
      exact: true, prefilters: inner.prefilters, refinements: [] };
  }

  const spatial = planSpatial(node, itSlot, shape);
  if (spatial !== null) return spatial;

  if (node.name === '$exists' || node.name === '$empty') {
    const ref = pathRef(node.args[0], itSlot, shape);
    if (ref === null) {
      return { refusal: refusal(node.name,
        'existence tests translate only over a singular member path on the binding') };
    }
    return exactly({ p: 'typeIs', ref, types: [], positive: node.name === '$exists' });
  }

  const comparison = COMPARISONS.get(node.name);
  if (comparison !== undefined) {
    let [left, right] = node.args;
    let op = comparison;
    // literal/external on the left: flip the operator around the path
    if (pathRef(left, itSlot, shape) === null && operandOf(left) !== null) {
      [left, right] = [right, left];
      op = /** @type {any} */ ({ lt: 'gt', le: 'ge', gt: 'lt', ge: 'le' })[op] ?? op;
    }
    const ref = pathRef(left, itSlot, shape);
    const operand = operandOf(right);
    if (ref === null || operand === null) {
      if (pathRef(left, itSlot, shape) !== null && pathRef(right, itSlot, shape) !== null)
        return { refusal: refusal(node.name, 'comparisons where both sides are paths are join territory') };
      return { refusal: refusal(node.name,
        'comparisons translate only between a singular member path and a literal or external') };
    }
    if ('lit' in operand) {
      if (!isScalarLiteral(operand.lit)) {
        return { refusal: refusal(node.name,
          'array and object literals have no guarded native comparison form') };
      }
      const lit = operand.lit;
      if (typeof lit === 'boolean' || lit === null) {
        if (ORDERING_OPS.has(op)) return exactly({ p: 'const', value: false });
        const typeName = lit === null ? 'null' : lit ? 'true' : 'false';
        return exactly({ p: 'typeIs', ref, types: [typeName], positive: op === 'eq' });
      }
    }
    return exactly({ p: 'cmp', op: /** @type {any} */ (op), ref, operand });
  }

  const stringOp = STRING_OPS.get(node.name);
  if (stringOp !== undefined) {
    const ref = pathRef(node.args[0], itSlot, shape);
    const operand = operandOf(node.args[1]);
    if (ref === null || ref.type !== 'string') {
      return { refusal: refusal(node.name,
        'string operators translate only over schema-typed string paths (the engine ERRORS on non-string subjects)') };
    }
    if (operand === null || !('lit' in operand) || typeof operand.lit !== 'string') {
      return { refusal: refusal(node.name,
        "string operators translate only with literal string patterns (an external pattern's type is unknowable at plan time)") };
    }
    if (operand.lit === '') {
      return { refusal: refusal(node.name,
        "the empty pattern's vacuous-truth corner (true even on a missing member) is not translated") };
    }
    return exactly({ p: 'strop', kind: /** @type {any} */ (stringOp), ref, operand });
  }

  return { refusal: refusal(node.name,
    'no native spelling of this operator is proven equivalent') };
}

// ————— Time series: the three closed shapes over a declared index —————
//
// The physical feature is one a model already has: a composite index
// over `[$.series, $.at]`. There is no `derive: 'series'`, no column
// type and no host function — D9's whole point is that a declared
// numeric epoch column is already 52× reading the instant back out of
// the document, so the work here is recognizing which questions that
// index can answer rather than inventing a place to put time.
//
// Three shapes are recognized, and they are CLOSED:
//
//  1. **range** — every leading column of an instant index pinned by an
//     equality, a half-open range on the instant column, ordered by it.
//     Already a native selection; what this adds is the NAME of the
//     operation, the index it seeks, and the honest reason when the
//     prefix is missing.
//  2. **as-of** — the same prefix with ONE instant bound, ordered by
//     the instant, cut to a finite window. §2.2's 0.003 ms row.
//  3. **bucket** — a fixed-width ladder over the instant column with
//     the exact `sum|mean|min|max|count` aggregates, in both spellings
//     the language has for it: a `$groupby` whose key is
//     `$time-bucket`, and a `$resample` whose spec asks for nothing a
//     `GROUP BY` cannot do.
//
// Everything else is a NAMED core refinement: the fetch narrows through
// the index and the residual — which is the engine running the caller's
// own document — decides. That is what keeps a refinement idempotent,
// and it is why a calendar ladder, a fill policy, a rolling window and
// an as-of JOIN cost a bounded fetch rather than a wrong answer.

/** Is this node the whole collection — `$[*]` over the input document? */
function isCollectionSource(node) {
  return node?.kind === 'path' && node.name === '$' && node.external !== true
    && node.rootSlot === 0 && node.singular !== true
    && node.segments.length === 1 && node.segments[0].descendant !== true
    && node.segments[0].selectors.length === 1
    && node.segments[0].selectors[0].kind === 'wildcard';
}

/**
 * The collection-side operand of a root series operator: the bare
 * `$[*]`, or a FLWOR over it whose `$where` is the narrowing.
 * @param {any} node
 * @returns {{ flwor: any } | null}
 */
function collectionOperand(node) {
  if (isCollectionSource(node)) return { flwor: null };
  if (node?.kind === 'flwor' && node.forBindings.length === 1
    && isCollectionSource(node.forBindings[0]?.expr))
    return { flwor: node };
  return null;
}

/**
 * A typed reference to one top-level member of the collection's
 * documents — what a spec's row selector ultimately names.
 * @param {any} shape
 * @param {string} name
 * @returns {import('./algebra.js').PlanRef}
 */
function memberRef(shape, name) {
  const segments = [{ name }];
  return {
    segments,
    type: typeOfPath(shape.schema, segments),
    column: shape.columnByCanonical.get(`.${name}`) ?? null,
  };
}

/**
 * The instants a plan-time literal series carries, under one selector.
 * `null` when the operand is not a literal array of records, or when
 * one of them names no instant — either way the planner has no bound to
 * add and says so rather than guessing one.
 * @param {any} node
 * @param {any} selector - the spec's `leftAt`/`rightAt`, or undefined
 * @returns {{ min: number, max: number, keys: any[] | null } | null}
 */
function literalInstants(node, selector, keySelector) {
  const constant = constantOf(node);
  if (constant === null || !Array.isArray(constant.value) || constant.value.length === 0)
    return null;
  const at = selector === undefined ? 'at' : singularSelector(selector);
  const by = keySelector === undefined ? null : singularSelector(keySelector);
  if (at === null || (keySelector !== undefined && by === null)) return null;
  let min = Infinity;
  let max = -Infinity;
  const keys = by === null ? null : [];
  for (const row of constant.value) {
    if (row === null || typeof row !== 'object') return null;
    const instant = row[at];
    if (typeof instant !== 'number' || !Number.isFinite(instant)) return null;
    if (instant < min) min = instant;
    if (instant > max) max = instant;
    if (keys !== null) {
      const key = row[by];
      if (typeof key !== 'string' && typeof key !== 'number') return null;
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return { min, max, keys };
}

/**
 * The native bucket a `$resample` spec asks for, or the FIRST reason it
 * is a refinement instead. The rules are asked in one fixed order, so a
 * spec always names the same reason on every host.
 * @param {any} spec - the frozen literal
 * @param {any} shape
 * @returns {{ bucket: import('./algebra.js').PlanBucket } | { code: string }}
 */
function resampleBucket(spec, shape) {
  // the clock first, because a named zone is resolved by HOST code the
  // planner does not have: asking the kernel about it would report the
  // missing provider rather than the reason a ladder is not native
  if (spec.zone !== undefined && spec.zone !== 'UTC') return { code: 'named-zone' };
  // The kernel's own rules, asked once, by running it over NO rows —
  // order 04's trick, for order 04's reason. `analyzeQuery` does not
  // compile an operator, so a spec the kernel refuses reaches the
  // planner before the engine has had its say, and a plan that answered
  // where the engine raises is the one thing a pushdown may never do.
  try {
    resampleSeries([], spec);
  }
  catch {
    return { code: 'invalid-spec' };
  }
  if (spec.fill !== undefined && spec.fill !== 'omit') return { code: 'fill-policy' };
  const fn = NATIVE_AGGREGATES[spec.aggregate ?? 'mean'];
  if (fn === undefined) return { code: 'unsupported-aggregate' };
  const ladder = fixedLadder(spec, compileBuckets);
  if ('code' in ladder) return ladder;
  // a row selector is a singular path whose `$` is the ROW, so it names
  // a member — and a member is what a declared column stands for. One
  // that names a path INTO a member names no column, and says so
  const atName = spec.at === undefined ? 'at' : singularSelector(spec.at);
  const valueName = spec.value === undefined ? 'value' : singularSelector(spec.value);
  if (atName === null || valueName === null) return { code: 'row-selector' };
  const at = memberRef(shape, atName);
  const instantBad = instantRefusal(at);
  if (instantBad !== null) return { code: instantBad };
  const value = memberRef(shape, valueName);
  if (fn !== 'rows') {
    const valueBad = valueRefusal(value);
    if (valueBad !== null) return { code: valueBad };
  }
  // D5's shape, exactly: the bucket's start, its reading, and the count
  // of SOURCE rows — which is `COUNT(*)` whether or not it is also the
  // answer, because `aggregate: 'count'` returns that same number
  return { bucket: {
    ref: at,
    every: ladder.every,
    origin: ladder.origin,
    as: 'at',
    order: 'asc',
    aggregates: [
      { fn: /** @type {any} */ (fn), ref: fn === 'rows' ? null : value, as: 'value' },
      { fn: /** @type {any} */ ('rows'), ref: null, as: 'count' },
    ],
  } };
}

/**
 * The ladder a `$groupby` key spells, when the key is a `$time-bucket`
 * over a member path with literal width and origin.
 * @param {any} key - the grouping key expression node
 * @param {number} itSlot
 * @param {any} shape
 * @returns {{ ref: any, every: number, origin: number } | { code: string } | null}
 *   `null` when the key is not a `$time-bucket` at all
 */
function groupLadder(key, itSlot, shape) {
  if (key?.kind !== 'op' || key.name !== '$time-bucket') return null;
  const [atNode, everyNode, originNode, contextNode] = key.args;
  if (everyNode.kind !== 'literal') return { code: 'nonliteral-spec' };
  if (originNode !== undefined && originNode.kind !== 'literal')
    return { code: 'nonliteral-spec' };
  /** @type {any} */
  const spec = { every: everyNode.value };
  if (originNode !== undefined && originNode.value !== null) spec.origin = originNode.value;
  if (contextNode !== undefined) {
    if (contextNode.kind !== 'raw') return { code: 'nonliteral-spec' };
    const context = contextNode.value;
    if (context?.zone !== undefined) return { code: 'named-zone' };
    if (context?.offset !== undefined) spec.offset = context.offset;
  }
  const ladder = fixedLadder(spec, compileBuckets);
  if ('code' in ladder) return ladder;
  const ref = pathRef(atNode, itSlot, shape);
  const instantBad = instantRefusal(ref);
  if (instantBad !== null) return { code: instantBad };
  return { ref, every: ladder.every, origin: ladder.origin };
}

/**
 * The closed projection of a bucket grouping: one member per answered
 * value, each of them the group key, a `$count` of the whole binding,
 * or one of the four value aggregates over a schema-typed numeric path.
 * @param {any} ret - the `$return` node
 * @param {number} itSlot
 * @param {number} keySlot
 * @param {any} shape
 * @returns {{ as: string, aggregates: any[] } | { code: string }}
 */
function bucketProjection(ret, itSlot, keySlot, shape) {
  if (ret?.kind !== 'object') return { code: 'nonnative-grouping' };
  let as = null;
  const aggregates = [];
  for (const entry of ret.entries) {
    const expr = entry.expr;
    if (expr.kind === 'var' && expr.external !== true && expr.slot === keySlot) {
      if (as !== null) return { code: 'nonnative-grouping' };
      as = entry.name;
      continue;
    }
    if (expr.kind !== 'op') return { code: 'nonnative-grouping' };
    if (expr.name === '$count') {
      // `$count` over the BINDING is the group's row count; over a path
      // it counts the rows that HAVE the member, which SQL's
      // `COUNT(column)` does not reproduce for a JSON `null`
      if (!isItVar(expr.args[0], itSlot)) return { code: 'nonnative-grouping' };
      aggregates.push({ fn: 'rows', ref: null, as: entry.name, empty: 'null' });
      continue;
    }
    const fn = { $sum: 'sum', $avg: 'avg', $min: 'min', $max: 'max' }[expr.name];
    if (fn === undefined) return { code: 'nonnative-grouping' };
    const ref = pathRef(expr.args[0], itSlot, shape);
    const valueBad = valueRefusal(ref);
    if (valueBad !== null) return { code: valueBad };
    // what an aggregate over NO numbers says, in the ENGINE's words:
    // `$sum` of an empty sequence is 0 and the other three are the
    // empty sequence, which an object constructor leaves the member out
    // for. SQL answers `NULL` for all four, so the mapping is the plan's
    aggregates.push({ fn, ref, as: entry.name, empty: fn === 'sum' ? 'zero' : 'omit' });
  }
  if (as === null || aggregates.length === 0) return { code: 'nonnative-grouping' };
  return { as, aggregates };
}

/**
 * Which way the groups come out. The engine's own rule is order of
 * FIRST APPEARANCE (§6.5), which over a collection is the earliest row
 * identity in each group; an `$orderby` on the key alone replaces it.
 * @param {any} orderby
 * @param {number} keySlot
 * @returns {'asc' | 'desc' | 'first-seen' | null} `null` when the
 *   ordering is one this plan cannot reproduce
 */
function bucketOrder(orderby, keySlot) {
  if (orderby === null) return 'first-seen';
  if (orderby.specs.length !== 1) return null;
  const spec = orderby.specs[0];
  if (spec.collation !== null || spec.collationName !== null) return null;
  const key = spec.key;
  if (key.kind !== 'var' || key.external === true || key.slot !== keySlot) return null;
  return spec.desc === true ? 'desc' : 'asc';
}

/**
 * The record a refused grouping leaves behind: the same question, named
 * and reasoned, over whatever the fetch still narrows.
 * @param {import('./algebra.js').Plan} plan
 * @param {any} shape
 * @param {string} code
 * @param {string} construct
 * @returns {any}
 */
function refinedGrouping(plan, shape, code, construct) {
  const facts = filterFacts(plan.filter);
  let column = null;
  for (const [name] of facts.bounds) {
    if (instantIndexesOver(shape, name, 2).length > 0) column = name;
  }
  const index = seekingIndexFor(shape, column, facts, 2);
  const bound = column === null ? null : facts.bounds.get(column);
  return seriesRecord({
    mode: plan.filter === null ? 'engine' : 'hybrid',
    operation: 'bucket',
    index: index === null ? null : index.name,
    prefix: index === null ? [] : index.prefix,
    range: bound === undefined || bound === null ? null : { column, ...bound },
    refinement: 'resampleSeries',
    reasons: [seriesReason(code, construct)],
  });
}

/**
 * Classify a planned selection as a temporal range or as-of lookup, or
 * answer `null` when the document asked no such question. The plan is
 * NOT changed: this names what the selection already is, and which
 * declared index it seeks through.
 * @param {import('./algebra.js').Plan} plan
 * @param {any} shape
 * @param {boolean} ordered - the ordering was pushed whole
 * @returns {any} the series record, or null
 */
function classifySelection(plan, shape, ordered) {
  const facts = filterFacts(plan.filter);
  // the instant column is the one a DECLARED index ends with; without
  // such an index the collection has no instant and the question was
  // an ordinary one
  const candidates = [];
  for (const [column, bound] of facts.bounds) {
    if (instantIndexesOver(shape, column, 2).length === 0) continue;
    candidates.push([column, bound]);
  }
  if (candidates.length !== 1) return null;
  const [column, bound] = candidates[0];
  const index = seekingIndexFor(shape, column, facts, 2);
  const bounded = bound.from !== null || bound.to !== null;
  const twoSided = bound.from !== null && bound.to !== null;
  const orderedByInstant = ordered && plan.order !== null && plan.order.length === 1
    && plan.order[0].ref.column === column;
  const operation = twoSided ? 'range'
    : (orderedByInstant && plan.window !== null && plan.window.limit !== null) ? 'asof'
      : bounded ? 'range' : null;
  if (operation === null) return null;
  const reasons = index === null ? [seriesReason('missing-series-prefix', '$where')] : [];
  return seriesRecord({
    mode: index === null ? 'engine' : 'native',
    operation,
    index: index === null ? null : index.name,
    prefix: index === null ? [] : index.prefix,
    range: {
      from: bound.from, fromOp: bound.fromOp, to: bound.to, toOp: bound.toOp, column,
    },
    reasons,
  });
}


/**
 * The bucket a `$groupby` phrase spells, or the reason it is not one.
 * @param {any} node - the flwor node
 * @param {number} itSlot
 * @param {any} shape
 * @returns {{ bucket: any } | { code: string }}
 */
function planBucketGrouping(node, itSlot, shape) {
  if (node.groupby.keys.length !== 1) return { code: 'nonnative-grouping' };
  const key = node.groupby.keys[0];
  const ladder = groupLadder(key.expr, itSlot, shape);
  if (ladder === null) return { code: 'nonnative-grouping' };
  if ('code' in ladder) return ladder;
  const projection = bucketProjection(node.ret, itSlot, key.slot, shape);
  if ('code' in projection) return projection;
  const order = bucketOrder(node.orderby, key.slot);
  if (order === null) return { code: 'nonnative-grouping' };
  return { bucket: {
    ref: ladder.ref,
    every: ladder.every,
    origin: ladder.origin,
    as: projection.as,
    order,
    aggregates: projection.aggregates,
  } };
}

/**
 * The tolerance of an as-of spec in milliseconds, or `null` for one
 * that bounds nothing. A NEGATIVE tolerance is a broken document the
 * engine refuses, and narrowing by it would move the bounds INWARD —
 * so it bounds nothing here and the engine raises, which is the same
 * rule `safeEpoch` follows for an instant that names none.
 */
function toleranceMs(tolerance) {
  if (tolerance === undefined) return null;
  if (typeof tolerance === 'number')
    return Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : null;
  try {
    const span = compileBuckets({ every: tolerance }, {});
    return span.calendar || span.width < 0 ? null : span.width;
  }
  catch {
    return null;
  }
}

/**
 * The epoch a spec member names, or `null` when it names none.
 *
 * A planner may never raise on the ENGINE's behalf: `analyzeQuery` does
 * not compile an operator, so a spec whose `start` is not an instant
 * reaches here before the engine has had its say. Refusing to narrow is
 * the right answer — the residual compiles the caller's own document
 * and raises the `JQ0003` it would have raised anyway.
 * @param {any} value
 * @returns {number | null}
 */
function safeEpoch(value) {
  if (value === undefined) return null;
  try {
    const at = toEpoch(value);
    return Number.isFinite(at) ? at : null;
  }
  catch {
    return null;
  }
}

/** An instant bound as a pushable conjunct over the instant column. */
function instantBound(ref, op, value) {
  return { p: 'cmp', op, ref, operand: { lit: value } };
}

/**
 * The bounds a frozen spec implies for the collection side, as pushable
 * conjuncts. Every one of them is an IMPLIED conjunct: it narrows the
 * fetch and decides nothing, because the residual re-runs the caller's
 * own document — the whole operator — over what comes back.
 * @returns {{ preds: any[], range: any }}
 */
function impliedInstantBounds(ref, from, to) {
  const preds = [];
  if (from !== null) preds.push(instantBound(ref, 'ge', from));
  if (to !== null) preds.push(instantBound(ref, 'le', to));
  return { preds, range: { column: ref.column, from, fromOp: from === null ? null : 'ge',
    to, toOp: to === null ? null : 'le' } };
}

/**
 * Plan a document that IS a series operator over the collection.
 *
 * The collection is one of the operator's operands, so the narrowing is
 * that operand's own `$where` plus what the frozen spec implies, and
 * the kernel — the engine running the caller's document over the
 * fetched candidates — decides. A `$resample` whose spec asks for
 * nothing a `GROUP BY` cannot do is the one exception: it is native,
 * and answers the bucket records itself.
 * @param {any} root
 * @param {any} shape
 * @returns {any} `null` when the operator is not over this collection
 */
function planSeriesOperator(root, shape) {
  const name = root.name;
  /** @type {any} */
  let operandNode = null;
  /** @type {any} */
  let probesNode = null;
  /** @type {any} */
  let spec = null;
  if (name === '$resample' || name === '$rolling') {
    operandNode = root.args[0];
    spec = root.args[1]?.kind === 'raw' ? root.args[1].value : null;
  }
  else {
    spec = root.args.length === 3
      ? (root.args[2].kind === 'raw' ? root.args[2].value : null) : {};
    // narrowing is only sound on the RIGHT side: an as-of join answers
    // once per LEFT row, so every left row is needed whatever it matches
    if (collectionOperand(root.args[1]) !== null) {
      operandNode = root.args[1];
      probesNode = root.args[0];
    }
    else if (collectionOperand(root.args[0]) !== null) {
      operandNode = root.args[0];
    }
  }
  const operand = operandNode === null ? null : collectionOperand(operandNode);
  if (operand === null || spec === null || typeof spec !== 'object') return null;

  const inner = operand.flwor === null
    ? { plan: selectPlan(shape.collection), reasons: [], prefilters: [] }
    : planFlwor(operand.flwor, shape, undefined, undefined);
  const plan = inner.plan;
  // the operand's own clauses stay the engine's: the residual runs the
  // WHOLE document, so a projection or an ordering inside it is applied
  // there and only its pushed conjuncts narrow
  plan.order = null;
  plan.window = null;

  const reasons = [];
  const prefilters = [...(inner.prefilters ?? [])];
  const at = memberRef(shape,
    spec.at !== undefined ? (singularSelector(spec.at) ?? 'at')
      : (name === '$asof' && probesNode !== null && spec.rightAt !== undefined
        ? (singularSelector(spec.rightAt) ?? 'at') : 'at'));

  if (name === '$resample') {
    const outcome = resampleBucket(spec, shape);
    if ('bucket' in outcome) {
      // native: the ladder, the aggregate and the count are the plan's
      const bucket = outcome.bucket;
      bucket.aggregates[0].empty = 'null';
      bucket.aggregates[1].empty = 'null';
      plan.bucket = bucket;
      const windowFrom = safeEpoch(spec.start);
      const windowTo = safeEpoch(spec.end);
      if (windowFrom !== null) plan.filter = conjoin(plan.filter,
        instantBound(bucket.ref, 'ge', windowFrom));
      if (windowTo !== null) plan.filter = conjoin(plan.filter,
        instantBound(bucket.ref, 'lt', windowTo));
      const facts = filterFacts(plan.filter);
      const index = seekingIndexFor(shape, bucket.ref.column, facts);
      const bound = facts.bounds.get(bucket.ref.column) ?? null;
      return {
        plan,
        native: inner.reasons.length === 0,
        reasons: inner.reasons,
        prefilters,
        series: seriesRecord({
          mode: 'native',
          operation: 'resample',
          index: index === null ? null : index.name,
          prefix: index === null ? [] : index.prefix,
          range: bound === null ? null : { column: bucket.ref.column, ...bound },
          ladder: { every: bucket.every, origin: bucket.origin, calendar: false },
          aggregates: bucket.aggregates.map((a) => a.as),
          reasons: index === null ? [seriesReason('missing-series-prefix', name)] : [],
        }),
      };
    }
    reasons.push(seriesReason(outcome.code, name));
  }
  else if (name === '$rolling') {
    reasons.push(seriesReason('rolling-refinement', name));
  }
  else {
    reasons.push(seriesReason('asof-refinement', name));
  }

  // the refinement: narrow through the index by whatever the spec makes
  // provable, and let the engine's own kernel decide over what comes back
  let range = null;
  if (name === '$resample' && at.column !== null) {
    const from = safeEpoch(spec.start);
    const to = safeEpoch(spec.end);
    if (from !== null || to !== null) {
      if (from !== null) plan.filter = conjoin(plan.filter, instantBound(at, 'ge', from));
      if (to !== null) plan.filter = conjoin(plan.filter, instantBound(at, 'lt', to));
      range = { column: at.column, from, fromOp: from === null ? null : 'ge',
        to, toOp: to === null ? null : 'lt' };
      prefilters.push({ construct: name, via: 'columns', columns: [at.column], exact: false });
    }
  }
  else if (name === '$asof' && probesNode !== null) {
    const probes = literalInstants(probesNode, spec.leftAt, spec.by);
    if (probes !== null && at.column !== null) {
      const tolerance = toleranceMs(spec.tolerance);
      const direction = spec.direction ?? 'backward';
      let from = null;
      let to = null;
      if (direction === 'backward') {
        to = probes.max;
        if (tolerance !== null) from = probes.min - tolerance;
      }
      else if (direction === 'forward') {
        from = probes.min;
        if (tolerance !== null) to = probes.max + tolerance;
      }
      else if (tolerance !== null) {
        from = probes.min - tolerance;
        to = probes.max + tolerance;
      }
      const bounds = impliedInstantBounds(at, from, to);
      for (const pred of bounds.preds) plan.filter = conjoin(plan.filter, pred);
      if (bounds.preds.length > 0) {
        range = bounds.range;
        prefilters.push({ construct: name, via: 'columns', columns: [at.column], exact: false });
      }
    }
    // and the keys, whether or not the instant has a column of its own:
    // a right row whose group no left row names can match nothing, so a
    // membership test over the probes' own keys narrows and never drops
    if (probes !== null && probes.keys !== null && probes.keys.length > 0) {
      const byRef = memberRef(shape, /** @type {string} */ (singularSelector(spec.by)));
      if (byRef.column !== null) {
        plan.filter = conjoin(plan.filter, probes.keys.length === 1
          ? { p: 'cmp', op: 'eq', ref: byRef, operand: { lit: probes.keys[0] } }
          : { p: 'or', items: probes.keys.map((key) =>
            ({ p: 'cmp', op: 'eq', ref: byRef, operand: { lit: key } })) });
        prefilters.push({ construct: name, via: 'columns',
          columns: [byRef.column], exact: false });
      }
    }
  }

  const facts = filterFacts(plan.filter);
  const index = seekingIndexFor(shape, at.column, facts);
  // one code, once: an instant with no column of its own already said
  // this when the ladder refused, and saying it twice reads as two facts
  if (index === null && !reasons.some((r) => r.code === 'missing-series-prefix'))
    reasons.push(seriesReason('missing-series-prefix', name));
  const narrowed = plan.filter !== null;
  return {
    plan,
    native: false,
    reasons: [...reasons, ...inner.reasons],
    prefilters,
    series: seriesRecord({
      mode: narrowed ? 'hybrid' : 'engine',
      operation: { $resample: 'resample', $rolling: 'rolling', $asof: 'asof-join' }[name],
      index: narrowed && index !== null ? index.name : null,
      prefix: narrowed && index !== null ? index.prefix : [],
      range,
      refinement: { $resample: 'resampleSeries', $rolling: 'rollingSeries',
        $asof: 'asOfJoin' }[name],
      reasons,
    }),
  };
}

/**
 * Plan a FLWOR node into a select plan, recording refusals. When a
 * conjunct refuses native translation, the injected `udf` hook may
 * promote it to a deterministic-function predicate instead (the D9
 * hatch — the hook is supplied by the query layer, capability-gated,
 * and absent means no hatch).
 * @param {any} node
 * @param {any} shape - { collection, schema, columnByCanonical }
 * @param {any} rawFlwor - The raw FLWOR document (conjunct fragments
 *   for the hook — the AST has no unparser)
 * @param {((fragment: any, binding: string) => { name: string, key: string } | null) | undefined} udfHook
 * @returns {{ plan: import('./algebra.js').Plan,
 *   reasons: { construct: string, reason: string }[],
 *   whereFullyPushed: boolean, orderPushed: boolean,
 *   projectionNative: boolean, itSlot: number, itName: string | null,
 *   udfs: string[], prefilters: any[],
 *   knn: { column: string, dims: number, probe: any } | null }}
 *   `knn` is the recognized k-nearest ordering, pending the window
 *   the caller peels; its ordering is then never pushed
 */
function planFlwor(node, shape, rawFlwor, udfHook) {
  const reasons = [];
  const plan = selectPlan(shape.collection);

  // the one recognised source shape: a single plain binding over $[*]
  const binding = node.forBindings[0];
  const source = binding?.expr;
  const sourceIsCollection = node.forBindings.length === 1
    && source?.kind === 'path' && source.name === '$' && source.external !== true
    && source.segments.length === 1 && source.segments[0].descendant !== true
    && source.segments[0].selectors.length === 1
    && source.segments[0].selectors[0].kind === 'wildcard'
    && binding.window === null && binding.atSlot === -1
    && binding.allowingEmpty === false;
  if (!sourceIsCollection) {
    reasons.push(refusal('$for',
      'only a single plain binding over the whole collection is translated'));
    return { plan, reasons, whereFullyPushed: false, orderPushed: false,
      projectionNative: false, itSlot: -1, itName: null, udfs: [], prefilters: [],
      knn: null, bucket: null, bucketRefusal: null };
  }
  const itSlot = binding.slot;
  // the document's own name for the collection binding. The residual and
  // the UDF hatch both wrap raw fragments in a synthetic one-row query,
  // and that wrapper must bind what the fragments actually reference —
  // the name is the document's to choose, never this package's.
  const itName = binding.name;

  if (node.fold !== null) reasons.push(refusal('$fold', KIND_REASONS.let));
  if (node.letBindings.length > 0) reasons.push(refusal('$let', KIND_REASONS.let));
  if (node.asChecks !== null) reasons.push(refusal('$as', 'type assertions run in the engine'));
  // A grouping is an unconditional residual EXCEPT in one closed shape:
  // a fixed-width `$time-bucket` key with the exact aggregates, which
  // is a `GROUP BY` over integer arithmetic. The bucket then owns the
  // ordering and the projection too, so it is decided before either.
  let bucket = null;
  let bucketRefusal = null;
  if (node.groupby !== null && node.fold === null && node.letBindings.length === 0
    && node.asChecks === null && node.count === null) {
    const grouped = planBucketGrouping(node, itSlot, shape);
    if ('bucket' in grouped) bucket = grouped.bucket;
    else {
      bucketRefusal = grouped.code;
      reasons.push(seriesReason(grouped.code, '$groupby'));
    }
  }
  else if (node.groupby !== null) reasons.push(refusal('$groupby', KIND_REASONS.let));
  if (node.count !== null) reasons.push(refusal('$count clause', KIND_REASONS.let));
  const structureClean = reasons.length === 0;
  // $let and $as run BEFORE $where in clause order: a row our pushed
  // conjunct would exclude could still make the engine throw inside a
  // binding — narrowing is only sound when nothing precedes the where
  const narrowingSound = node.letBindings.length === 0 && node.asChecks === null;

  // WHERE: a top-level $and splits — translated conjuncts push, the
  // rest stay for the residual (pure narrowing). A refused conjunct
  // may still ride the deterministic-function hatch when the hook
  // accepts its raw fragment.
  let whereFullyPushed = true;
  const udfs = [];
  const prefilters = [];
  if (!narrowingSound) whereFullyPushed = false;
  else if (node.where !== null) {
    const split = node.where.kind === 'op' && node.where.name === '$and';
    const conjuncts = split ? node.where.args : [node.where];
    const rawWhere = rawFlwor?.$where;
    const rawConjuncts = split ? rawWhere?.$and ?? [] : [rawWhere];
    for (let i = 0; i < conjuncts.length; i++) {
      const outcome = planPredicate(conjuncts[i], itSlot, shape);
      if ('refusal' in outcome) {
        const promoted = udfHook !== undefined && rawConjuncts[i] !== undefined
          ? udfHook(rawConjuncts[i], itName)
          : null;
        if (promoted !== null) {
          plan.filter = conjoin(plan.filter,
            { p: 'udf', name: promoted.name, key: promoted.key });
          udfs.push(promoted.name);
        }
        else {
          reasons.push(outcome.refusal);
          whereFullyPushed = false;
        }
      }
      else {
        plan.filter = conjoin(plan.filter, outcome.pred);
        prefilters.push(...outcome.prefilters);
        // an IMPLIED conjunct narrows and leaves the original predicate
        // for the residual, which is why it is reported as forcing one
        for (const refinement of outcome.refinements) {
          reasons.push(refinement);
          whereFullyPushed = false;
        }
      }
    }
  }

  // ORDER BY: all terms or none — a partially pushed ordering is wrong.
  // A k-nearest ordering is the third outcome: not pushed, but
  // recognized for the column to pre-filter (the reason is the
  // caller's to name once the window is known)
  let orderPushed = false;
  let knn = null;
  const ranked = bucket !== null || node.orderby === null ? null
    : planKnnOrder(node.orderby, itSlot, shape, whereFullyPushed && structureClean);
  if (bucket !== null) orderPushed = true; // the groups' order is the bucket's
  else if (ranked !== null) {
    if ('rank' in ranked) knn = ranked.rank;
    else reasons.push(ranked.refusal);
  }
  else if (node.orderby !== null) {
    const terms = [];
    let refused = null;
    for (const spec of node.orderby.specs) {
      const ref = pathRef(spec.key, itSlot, shape);
      if (ref === null || ref.type === 'unknown') {
        refused = refusal('$orderby',
          'ordering translates only over singular schema-typed paths');
        break;
      }
      if (spec.collation !== null || spec.collationName !== null) {
        refused = refusal('$collation',
          'a collation the dialect cannot reproduce is refused, not approximated');
        break;
      }
      terms.push({ ref, desc: spec.desc === true, emptyGreatest: spec.emptyGreatest === true });
    }
    if (refused !== null) reasons.push(refused);
    else if (terms.length > 0) {
      plan.order = terms;
      orderPushed = true;
    }
  }
  else {
    orderPushed = true; // nothing to push
  }

  // RETURN: the bare binding is the native whole-document projection
  let projectionNative = false;
  assertDecidedKind(node.ret);
  if (bucket !== null) projectionNative = true; // the bucket IS the projection
  else if (isItVar(node.ret, itSlot)) projectionNative = true;
  else {
    reasons.push(refusal('$return',
    'projections other than the bare binding run per row (the row residual)'));
  }

  return {
    plan,
    reasons,
    whereFullyPushed: whereFullyPushed && structureClean,
    orderPushed: orderPushed && structureClean,
    projectionNative,
    itSlot,
    itName,
    udfs,
    prefilters,
    knn,
    bucket,
    bucketRefusal,
  };
}

/**
 * Compose peeled `$subsequence` windows into one: the innermost applies
 * first, so offsets add and each outer limit is cut to what the inner
 * one left. `null` when nothing was peeled.
 * @param {{ offset: number, limit: number | null }[]} windows -
 *   outermost first, as peeled
 * @returns {{ offset: number, limit: number | null } | null}
 */
function composeWindows(windows) {
  if (windows.length === 0) return null;
  let offset = 0;
  let limit = null;
  for (let i = windows.length - 1; i >= 0; i--) {
    const w = windows[i];
    offset += w.offset;
    if (w.limit !== null) {
      limit = limit === null ? w.limit : Math.min(Math.max(limit - w.offset, 0), w.limit);
    }
    else if (limit !== null) {
      limit = Math.max(limit - w.offset, 0);
    }
  }
  return { offset, limit };
}

/**
 * Plan a whole document against one collection.
 * @param {any} document - The raw query document (kept beside the AST
 *   for residual construction — the AST has no unparser)
 * @param {any} shape - { collection, schema, columnByCanonical }
 * @param {{ udf?: (fragment: any, binding: string) => { name: string, key: string } | null }} [options]
 * @returns {{
 *   analysis: any,
 *   plan: import('./algebra.js').Plan | null,
 *   mode: 'native' | 'row' | 'set' | 'knn',
 *   reasons: { construct: string, reason: string }[],
 *   rowReturn: any,
 *   udfs: string[],
 *   prefilters: { construct: string, via: 'columns' | 'rtree',
 *     columns: string[], exact: boolean }[],
 *   series: any,
 * }}
 *   `series` is the temporal record (`series.js`) when the document
 *   asked a §8.16 question, and `null` when it did not.
 */
function planCollectionCore(document, shape, options = undefined) {
  const analysis = analyzeQuery(document, analyzeOptionsFor(shape?.operators));
  let root = analysis.root;
  assertDecidedKind(root);

  // peel top-level $subsequence windows (0-based start[, length])
  let rawInner = document;
  const windows = [];
  while (root.kind === 'op' && root.name === '$subsequence') {
    const [inner, start, length] = root.args;
    if (start?.kind !== 'literal' || typeof start.value !== 'number'
      || (length !== undefined && (length.kind !== 'literal' || typeof length.value !== 'number'))) {
      // non-literal bounds: the whole document is a set residual
      return {
        analysis, plan: null, mode: 'set',
        reasons: [refusal('$subsequence', 'window bounds must be literal numbers to push')],
        rowReturn: null, udfs: [], prefilters: [], series: null,
      };
    }
    windows.push({ offset: start.value, limit: length === undefined ? null : length.value });
    root = inner;
    rawInner = Array.isArray(rawInner?.$subsequence) ? rawInner.$subsequence[0] : rawInner;
    assertDecidedKind(root);
  }

  // a top-level aggregate over a FLWOR
  let aggregate = null;
  if (root.kind === 'op' && AGGREGATES.has(root.name)) {
    if (windows.length > 0) {
      return {
        analysis, plan: null, mode: 'set',
        reasons: [refusal(root.name, 'a windowed aggregate is not translated')],
        rowReturn: null, udfs: [], prefilters: [], series: null,
      };
    }
    aggregate = { name: root.name, fn: AGGREGATES.get(root.name) };
    root = root.args[0];
    rawInner = rawInner?.[aggregate.name] ?? rawInner;
    assertDecidedKind(root);
  }

  // a document that IS a series operator over the collection: the
  // operand's own conjuncts (and what the frozen spec implies) narrow
  // through the index, and the kernel decides over what comes back
  if (aggregate === null && root.kind === 'op' && SERIES_ROOT_OPS.includes(root.name)) {
    const temporal = planSeriesOperator(root, shape);
    if (temporal !== null) {
      // a peeled `$subsequence` composes as it does everywhere — over a
      // NATIVE bucket it is a LIMIT on the ascending groups, which is
      // the same items the kernel's own window would have kept; over a
      // refinement the residual applies it, so the plan keeps none
      const window = windows.length === 0 ? null : composeWindows(windows);
      if (temporal.native && window !== null) temporal.plan.window = window;
      return {
        analysis,
        plan: temporal.plan,
        mode: temporal.native ? 'native' : 'set',
        reasons: temporal.native ? [] : temporal.reasons,
        rowReturn: null,
        udfs: [],
        prefilters: temporal.prefilters,
        series: temporal.series,
      };
    }
  }

  if (root.kind !== 'flwor') {
    return {
      analysis, plan: null, mode: 'set',
      reasons: [refusal(root.kind, KIND_REASONS[root.kind]
        ?? 'only a FLWOR over the collection is translated')],
      rowReturn: null, udfs: [], prefilters: [], series: null,
    };
  }

  const flwor = planFlwor(root, shape, rawInner, options?.udf);
  const { plan } = flwor;
  const fullyPushed = flwor.whereFullyPushed && flwor.orderPushed;

  if (flwor.knn !== null) {
    // the k-nearest mode: the recognized ordering under a window with
    // a finite limit, composed exactly as pushed windows are. The plan
    // keeps no order and no window — both are the engine's over the
    // cut — and the reason strict mode names is the rank itself
    const window = aggregate === null ? composeWindows(windows) : null;
    if (window !== null && window.limit !== null) {
      plan.rank = { ...flwor.knn, offset: window.offset, limit: window.limit,
        margin: KNN_MARGIN };
      return { analysis, plan, mode: 'knn',
        reasons: [refusal('$orderby', KNN_REASONS.rank), ...flwor.reasons],
        rowReturn: null, udfs: flwor.udfs, prefilters: flwor.prefilters, series: null };
    }
    flwor.reasons.unshift(refusal('$subsequence', KNN_REASONS.window));
  }

  if (aggregate !== null) {
    // aggregates need the WHOLE selection native (their input is the
    // full sequence, not a narrowed candidate set)
    if (!fullyPushed) {
      return { analysis, plan: null, mode: 'set', reasons: flwor.reasons,
        rowReturn: null, udfs: [], prefilters: flwor.prefilters, series: null };
    }
    if (aggregate.fn === 'count') {
      if (!flwor.projectionNative) {
        return {
          analysis, plan: null, mode: 'set',
          reasons: [refusal('$count',
            'count translates only over the bare binding (a projected return can change the item count)')],
          rowReturn: null, udfs: [], prefilters: [], series: null,
        };
      }
      plan.aggregate = { fn: 'count', ref: null };
      return { analysis, plan, mode: 'native', reasons: [], rowReturn: null,
        udfs: flwor.udfs, prefilters: flwor.prefilters,
        series: classifySelection(plan, shape, true) };
    }
    const ref = pathRef(root.ret, flwor.itSlot, shape);
    const numeric = aggregate.fn === 'sum' || aggregate.fn === 'avg';
    const acceptable = ref !== null
      && (numeric ? isNumericType(ref.type) : ref.type !== 'unknown');
    if (!acceptable) {
      return {
        analysis, plan: null, mode: 'set',
        reasons: [refusal(aggregate.name,
          'aggregates translate only over a singular schema-typed path (the engine ERRORS on non-conforming operands)')],
        rowReturn: null, udfs: [], prefilters: [], series: null,
      };
    }
    plan.aggregate = { fn: /** @type {any} */ (aggregate.fn), ref };
    return { analysis, plan, mode: 'native', reasons: [], rowReturn: null,
      udfs: flwor.udfs, prefilters: flwor.prefilters,
      series: classifySelection(plan, shape, true) };
  }

  // windows push only onto a fully pushed selection
  if (windows.length > 0 && fullyPushed) plan.window = composeWindows(windows);

  // the temporal bucket: only over a WHOLE pushed selection, because a
  // conjunct the residual would still apply would arrive after the rows
  // were already summed
  if (flwor.bucket !== null && fullyPushed && (windows.length === 0 || plan.window !== null)) {
    plan.bucket = flwor.bucket;
    const facts = filterFacts(plan.filter);
    const index = seekingIndexFor(shape, plan.bucket.ref.column, facts);
    const bound = facts.bounds.get(plan.bucket.ref.column) ?? null;
    return {
      analysis, plan, mode: 'native', reasons: [], rowReturn: null,
      udfs: flwor.udfs, prefilters: flwor.prefilters,
      series: seriesRecord({
        mode: 'native',
        operation: 'bucket',
        index: index === null ? null : index.name,
        prefix: index === null ? [] : index.prefix,
        range: bound === null ? null : { column: plan.bucket.ref.column, ...bound },
        ladder: { every: plan.bucket.every, origin: plan.bucket.origin, calendar: false },
        aggregates: plan.bucket.aggregates.map((a) => a.as),
        reasons: index === null ? [seriesReason('missing-series-prefix', '$groupby')] : [],
      }),
    };
  }

  if (fullyPushed && flwor.projectionNative && (windows.length === 0 || plan.window !== null)) {
    return { analysis, plan, mode: 'native', reasons: [], rowReturn: null,
      udfs: flwor.udfs, prefilters: flwor.prefilters,
      series: classifySelection(plan, shape, flwor.orderPushed) };
  }

  // the row residual: everything but the projection pushed
  if (fullyPushed && !flwor.projectionNative
    && (windows.length === 0 || plan.window !== null)) {
    const rawFlwor = rawInner;
    const name = flwor.itName ?? 'it';
    return {
      analysis,
      plan,
      mode: 'row',
      reasons: flwor.reasons,
      // a COMPLETE one-row document, not a bare expression the caller
      // must re-wrap: the binding and the projection that references it
      // travel together, so the two cannot be paired up wrongly
      rowReturn: {
        $for: { [name]: '$[*]' },
        $return: [rawFlwor?.$return ?? `$${name}`],
      },
      udfs: flwor.udfs,
      prefilters: flwor.prefilters,
      series: flwor.bucketRefusal == null
        ? classifySelection(plan, shape, flwor.orderPushed)
        : refinedGrouping(plan, shape, flwor.bucketRefusal, '$groupby'),
    };
  }

  // the set residual: pushed conjuncts narrow, the engine answers
  const narrowing = flwor.bucketRefusal == null
    ? classifySelection(plan, shape, false)
    : refinedGrouping(plan, shape, flwor.bucketRefusal, '$groupby');
  plan.order = null;
  plan.window = null;
  return { analysis, plan, mode: 'set', reasons: flwor.reasons, rowReturn: null,
    udfs: flwor.udfs, prefilters: flwor.prefilters, series: narrowing };
}

/**
 * Plan a whole document against one collection. The store's registered
 * operators (Ring 2) ride in `shape.operators` — the planner recognises
 * them as vocabulary but keeps them in the residual, and names them in
 * the reasons when it does.
 * @param {any} document - The raw query document (kept beside the AST
 *   for residual construction — the AST has no unparser)
 * @param {any} shape - { collection, schema, columnByCanonical, operators? }
 * @param {{ udf?: (fragment: any) => { name: string, key: string } | null }} [options]
 * @returns {{
 *   analysis: any,
 *   plan: import('./algebra.js').Plan | null,
 *   mode: 'native' | 'row' | 'set' | 'knn',
 *   reasons: { construct: string, reason: string }[],
 *   rowReturn: any,
 *   udfs: string[],
 *   prefilters: { construct: string, via: 'columns' | 'rtree',
 *     columns: string[], exact: boolean }[],
 *   series: any,
 * }}
 */
export function planQuery(document, shape, options = undefined) {
  const planned = planCollectionCore(document, shape, options);
  return prependRegisteredReason(planned, document, shape?.operators);
}

// ————— The entity document kind (one planner, two document kinds) —————

/**
 * Build the planner shape for one entity: canonical top-level paths
 * map to REAL columns (flavor `entity-column`), epoch date columns to
 * their derived integer twins (flavor `entity-epoch`), and everything
 * else stays a document path over the entity's JSONB column (the
 * phase-A guarded forms).
 * @param {any} entity - normalized entity (model.js)
 * @param {any} entityMapping - explainMapping(...).entities[name]
 * @returns {any}
 */
export function entityShape(entity, entityMapping) {
  /** @type {Map<string, any>} */
  const flavors = new Map();
  for (const column of entityMapping.columns) {
    const epoch = column.source === 'epoch(document)';
    flavors.set(`.${column.name}`, {
      column: column.name,
      flavor: epoch ? 'entity-epoch' : 'entity-column',
      storage: column.storage,
      format: epoch ? entity.properties.get(column.name)?.format : undefined,
    });
  }
  for (const fk of entityMapping.foreignKeys) {
    if (!flavors.has(`.${fk.column}`))
      flavors.set(`.${fk.column}`, { column: fk.column, flavor: 'entity-column', storage: 'string' });
  }
  return {
    collection: entity.name,
    schema: entity.schema,
    columnByCanonical: new Map(),
    entityFlavors: flavors,
  };
}

/**
 * Resolve a singular member path on an entity binding to a flavored
 * PlanRef.
 * @param {any} node - a path AST node
 * @param {number} slot
 * @param {any} shape - from {@link entityShape}
 * @returns {any | null}
 */
export function entityPathRef(node, slot, shape) {
  const ref = pathRef(node, slot, shape);
  if (ref === null) return null;
  const canonical = ref.segments
    .map((s) => ('name' in s ? `.${s.name}` : `[${s.index}]`)).join('');
  const flavored = shape.entityFlavors.get(canonical);
  if (flavored !== undefined) {
    return {
      ...ref,
      column: flavored.column,
      flavor: flavored.flavor,
      storage: flavored.storage,
      format: flavored.format,
    };
  }
  // a nested path rides the JSONB document with the phase-A guards;
  // strip nothing — jsonb_extract addresses the doc column directly
  return { ...ref, flavor: 'entity-doc' };
}

/**
 * Plan one predicate over an entity binding: the same operator
 * grammar as phase A, with entity-flavored refs. Reuses
 * {@link planPredicate} for the recognition, then re-resolves refs
 * through the flavor table.
 * @param {any} node
 * @param {number} slot
 * @param {any} shape
 * @returns {{ pred: any } | { refusal: { construct: string, reason: string } }}
 */
export function planEntityPredicate(node, slot, shape) {
  const outcome = planPredicate(node, slot, shape);
  if ('refusal' in outcome) return outcome;
  /** @type {{ construct: string, reason: string } | null} */
  let blocked = null;
  const reflavor = (pred) => {
    if (pred.p === 'and' || pred.p === 'or')
      return { ...pred, items: pred.items.map(reflavor) };
    if (pred.p === 'not') return { ...pred, item: reflavor(pred.item) };
    if (!('ref' in pred) || pred.ref === null) return pred;
    const canonical = pred.ref.segments
      .map((s) => ('name' in s ? `.${s.name}` : `[${s.index}]`)).join('');
    const flavored = shape.entityFlavors.get(canonical);
    if (flavored === undefined) {
      // externals against DOC paths are not translated here (the
      // phase-A external forms assume the collection layout)
      if (pred.p === 'cmp' && 'ext' in pred.operand) {
        blocked = { construct: '$eq',
          reason: 'externals compare only against entity columns in this version' };
      }
      return { ...pred, ref: { ...pred.ref, flavor: 'entity-doc' } };
    }
    const ref = { ...pred.ref, column: flavored.column,
      flavor: flavored.flavor, storage: flavored.storage, format: flavored.format };
    if (flavored.flavor === 'entity-epoch' && pred.p === 'cmp') {
      if ('ext' in pred.operand) {
        blocked = { construct: pred.op,
          reason: 'externals compare only against entity columns in this version' };
        return { ...pred, ref };
      }
      // the plan-time instant translation: an ordering comparison
      // against a literal of the column's own family (Z-normalized
      // date-time, or a plain date on a date column) gains the ±1s
      // epoch range the emitter narrows the index with; anything else
      // simply keeps the guarded document forms — sound, unassisted
      if (pred.op !== 'ne' && typeof pred.operand.lit === 'string') {
        const lit = pred.operand.lit;
        const epoch = flavored.format === 'date'
          ? (/^\d{4}-\d{2}-\d{2}$/.test(lit) ? getEpochOfDateOnlyRFC3339(lit) : NaN)
          : (lit.includes('T') && lit.endsWith('Z') ? getEpochOfDateTimeRFC3339(lit) : NaN);
        if (typeof epoch === 'number' && Number.isFinite(epoch))
          return { ...pred, ref, epoch };
      }
    }
    return { ...pred, ref };
  };
  const pred = reflavor(outcome.pred);
  if (blocked !== null) return { refusal: blocked };
  return { pred };
}

/**
 * Plan an ENTITY query document: a FLWOR whose bindings range over
 * `$.<Entity>[*]` arrays of the multi-entity root. One binding is a
 * guarded selection; two bindings joined by a key equality become an
 * INNER equijoin (exactly the engine's cross-product-plus-filter
 * semantics, which is what keeps the oracle honest). Everything else
 * is the set residual over the fetched root.
 * @param {any} document
 * @param {Map<string, any>} entities - normalized entities
 * @param {any} mapping - explainMapping result
 * @param {{ functions?: any, extensions?: any } | null} [operators] -
 *   the store's registered operators (Ring 2); recognised as vocabulary,
 *   kept in the set residual over the fetched root
 * @returns {any}
 */
function planEntityQueryCore(document, entities, mapping, operators) {
  const analysis = analyzeQuery(document, analyzeOptionsFor(operators));
  let root = analysis.root;
  assertDecidedKind(root);

  const referenced = [...collectEntityRoots(document, entities)];
  const residual = (construct, reason) => ({
    analysis, mode: 'set', plan: null, referenced,
    reasons: [{ construct, reason }],
  });

  // peel literal windows exactly as the collection planner does
  const windows = [];
  while (root.kind === 'op' && root.name === '$subsequence') {
    const [inner, start, length] = root.args;
    if (start?.kind !== 'literal' || typeof start.value !== 'number'
      || (length !== undefined && (length.kind !== 'literal' || typeof length.value !== 'number')))
      return residual('$subsequence', 'window bounds must be literal numbers to push');
    windows.push({ offset: start.value, limit: length === undefined ? null : length.value });
    root = inner;
    assertDecidedKind(root);
  }
  let aggregate = null;
  if (root.kind === 'op' && root.name === '$count' && windows.length === 0) {
    aggregate = 'count';
    root = root.args[0];
    assertDecidedKind(root);
  }
  if (root.kind !== 'flwor')
    return residual(root.kind, 'only a FLWOR over entity arrays is translated');
  if (root.fold !== null || root.letBindings.length > 0 || root.asChecks !== null
    || root.groupby !== null || root.count !== null)
    return residual('$let', 'no equivalence proof exists yet; residual by default');

  // bindings must each range over one entity's array
  const bindings = [];
  for (const binding of root.forBindings) {
    const source = binding.expr;
    const sourceEntity = source?.kind === 'path' && source.name === '$'
      && source.external !== true && source.segments.length === 2
      && source.segments[0].descendant !== true
      && source.segments[0].selectors.length === 1
      && source.segments[0].selectors[0].kind === 'name'
      && source.segments[1].selectors?.length === 1
      && source.segments[1].selectors[0].kind === 'wildcard'
      ? source.segments[0].selectors[0].name
      : null;
    if (sourceEntity === null || !entities.has(sourceEntity)
      || binding.window !== null || binding.atSlot !== -1 || binding.allowingEmpty !== false)
      return residual('$for', 'bindings must each range over one declared entity array ($.Entity[*])');
    bindings.push({
      name: binding.name,
      slot: binding.slot,
      entity: sourceEntity,
      shape: entityShape(entities.get(sourceEntity), mapping.entities[sourceEntity]),
    });
  }
  if (bindings.length > 2)
    return residual('$for', 'at most two bindings are translated (one join per statement)');

  const byName = new Map(bindings.map((binding) => [binding.slot, binding]));
  const conjuncts = root.where === null
    ? []
    : root.where.kind === 'op' && root.where.name === '$and'
      ? root.where.args
      : [root.where];

  let joinOn = null;
  const filters = new Map(bindings.map((binding) => [binding.slot, null]));
  const reasons = [];
  let whereFullyPushed = true;
  for (const conjunct of conjuncts) {
    // a key equality between the two bindings is the join condition
    if (bindings.length === 2 && joinOn === null
      && conjunct.kind === 'op' && conjunct.name === '$eq') {
      const [left, right] = conjunct.args;
      const leftBinding = left.kind === 'path' ? byName.get(left.rootSlot) : undefined;
      const rightBinding = right.kind === 'path' ? byName.get(right.rootSlot) : undefined;
      if (leftBinding !== undefined && rightBinding !== undefined
        && leftBinding !== rightBinding) {
        const leftRef = entityPathRef(left, left.rootSlot, leftBinding.shape);
        const rightRef = entityPathRef(right, right.rootSlot, rightBinding.shape);
        if (leftRef?.flavor === 'entity-column' && rightRef?.flavor === 'entity-column') {
          joinOn = {
            left: { binding: leftBinding, ref: leftRef },
            right: { binding: rightBinding, ref: rightRef },
          };
          continue;
        }
      }
    }
    // otherwise the conjunct must belong wholly to ONE binding
    const slots = new Set();
    collectBindingSlots(conjunct, byName, slots);
    if (slots.size !== 1) {
      reasons.push({ construct: '$where',
        reason: 'a conjunct must belong to one binding (or be the single join equality)' });
      whereFullyPushed = false;
      continue;
    }
    const slot = [...slots][0];
    const binding = byName.get(slot);
    const outcome = planEntityPredicate(conjunct, slot, binding.shape);
    if ('refusal' in outcome) {
      reasons.push(outcome.refusal);
      whereFullyPushed = false;
      continue;
    }
    filters.set(slot, conjoin(filters.get(slot), outcome.pred));
  }
  if (bindings.length === 2 && joinOn === null)
    return residual('$for', 'two bindings need a key equality between them (the join condition)');

  // the return must be one bare binding
  const retBinding = root.ret.kind === 'var' && root.ret.external !== true
    ? byName.get(root.ret.slot) : undefined;
  if (retBinding === undefined) {
    reasons.push({ construct: '$return',
      reason: 'entity queries return one bare binding natively; projections run in the engine' });
  }

  // ordering over flavored refs of either binding
  let order = null;
  let orderPushed = true;
  if (root.orderby !== null) {
    const terms = [];
    for (const spec of root.orderby.specs) {
      const slot = spec.key.kind === 'path' ? spec.key.rootSlot : -1;
      const binding = byName.get(slot);
      const ref = binding === undefined
        ? null : entityPathRef(spec.key, slot, binding.shape);
      if (ref === null || (ref.flavor === 'entity-doc' && ref.type === 'unknown')
        || spec.collation !== null || spec.collationName !== null) {
        orderPushed = false;
        reasons.push({ construct: '$orderby',
          reason: 'ordering translates only over typed entity paths' });
        break;
      }
      terms.push({ binding, ref, desc: spec.desc === true, emptyGreatest: spec.emptyGreatest === true });
    }
    if (orderPushed) order = terms;
  }

  const fullyPushed = whereFullyPushed && orderPushed && retBinding !== undefined
    && (aggregate === null || retBinding !== undefined);
  if (!fullyPushed) {
    return { analysis, mode: 'set', plan: null, referenced, reasons };
  }

  let window = null;
  if (windows.length > 0) {
    let offset = 0;
    let limit = null;
    for (let i = windows.length - 1; i >= 0; i--) {
      const w = windows[i];
      offset += w.offset;
      if (w.limit !== null) limit = limit === null ? w.limit : Math.min(Math.max(limit - w.offset, 0), w.limit);
      else if (limit !== null) limit = Math.max(limit - w.offset, 0);
    }
    window = { offset, limit };
  }

  return {
    analysis,
    mode: 'native',
    referenced,
    reasons: [],
    plan: {
      planVersion: PLAN_VERSION,
      alg: bindings.length === 2 ? 'entity-join' : 'entity-select',
      bindings: bindings.map((binding) => ({ name: binding.name, entity: binding.entity })),
      joinOn: joinOn === null ? null : {
        left: { binding: joinOn.left.binding.name, column: joinOn.left.ref.column },
        right: { binding: joinOn.right.binding.name, column: joinOn.right.ref.column },
      },
      filters: bindings.map((binding) => ({
        binding: binding.name,
        filter: filters.get(binding.slot),
      })),
      order: order === null ? null : order.map((term) => ({
        binding: term.binding.name, ref: term.ref,
        desc: term.desc, emptyGreatest: term.emptyGreatest,
      })),
      window,
      aggregate,
      ret: retBinding.name,
    },
  };
}

/**
 * Plan an ENTITY query document (one planner, two document kinds). The
 * store's registered operators (Ring 2) are recognised as vocabulary and
 * kept in the set residual over the fetched root, named in the reasons.
 * @param {any} document
 * @param {Map<string, any>} entities - normalized entities
 * @param {any} mapping - explainMapping result
 * @param {{ functions?: any, extensions?: any } | null} [operators]
 * @returns {any}
 */
export function planEntityQuery(document, entities, mapping, operators = null) {
  const planned = planEntityQueryCore(document, entities, mapping, operators);
  return prependRegisteredReason(planned, document, operators);
}

/** Which binding slots a subtree references (via path roots). */
function collectBindingSlots(node, byName, slots) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectBindingSlots(item, byName, slots);
    return;
  }
  if (node.kind === 'path' && byName.has(node.rootSlot)) slots.add(node.rootSlot);
  for (const key of Object.keys(node)) {
    if (key === 'docPath') continue;
    collectBindingSlots(node[key], byName, slots);
  }
}

/** The entity names a document's root paths reference (`$.Name[*]`). */
export function collectEntityRoots(document, entities) {
  const found = new Set();
  const walk = (node) => {
    if (typeof node === 'string') {
      const match = /^\$\.([A-Za-z_][A-Za-z0-9_]*)\[\*\]/.exec(node);
      if (match !== null && entities.has(match[1])) found.add(match[1]);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node)) walk(node[key]);
    }
  };
  walk(document);
  return found;
}
