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
 *   { plan, mode: 'native' | 'row' | 'set', reasons, rowReturn }
 *
 * - `native` — everything translated; the plan alone answers.
 * - `row`    — predicates, ordering and window pushed; only the
 *   projection runs in the engine, per fetched row (streams).
 * - `set`    — the pushed conjuncts narrow candidates; the WHOLE
 *   compiled document runs over the materialized candidates.
 *
 * `reasons` names every construct that forced work off the database,
 * with reason text drawn from the deliberate-residual table.
 */

import { analyzeQuery, AST_VERSION, NODE_KINDS } from '@jarenjs/json/query';

import { selectPlan, conjoin } from './algebra.js';
import { typeOfPath, isNumericType } from './types.js';

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

// the exhaustiveness pact with TODO_02's gate: if the engine adds a
// kind, this module fails to load until the planner decides it
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
 * Is this node the bare binding variable (the whole item)?
 * @param {any} node
 * @param {number} itSlot
 */
function isItVar(node, itSlot) {
  return node.kind === 'var' && node.external !== true && node.slot === itSlot;
}

/**
 * A singular member path rooted on the binding → a PlanRef, or null.
 * @param {any} node
 * @param {number} itSlot
 * @param {any} shape - { schema, columnByCanonical }
 * @returns {import('./algebra.js').PlanRef | null}
 */
function pathRef(node, itSlot, shape) {
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
  return {
    segments,
    type: typeOfPath(shape.schema, segments),
    column: shape.columnByCanonical.get(canonical) ?? null,
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

/**
 * Translate one predicate node, or explain why not.
 * @param {any} node
 * @param {number} itSlot
 * @param {any} shape
 * @returns {{ pred: import('./algebra.js').PlanPredicate } |
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
    for (const arg of node.args) {
      const inner = planPredicate(arg, itSlot, shape);
      if ('refusal' in inner) return inner; // partial $or/$and is not splittable here
      items.push(inner.pred);
    }
    return { pred: { p: node.name === '$and' ? 'and' : 'or', items } };
  }
  if (node.name === '$not') {
    const inner = planPredicate(node.args[0], itSlot, shape);
    if ('refusal' in inner) return inner;
    return { pred: { p: 'not', item: inner.pred } };
  }

  if (node.name === '$exists' || node.name === '$empty') {
    const ref = pathRef(node.args[0], itSlot, shape);
    if (ref === null) {
      return { refusal: refusal(node.name,
        'existence tests translate only over a singular member path on the binding') };
    }
    return { pred: { p: 'typeIs', ref, types: [], positive: node.name === '$exists' } };
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
        if (ORDERING_OPS.has(op)) return { pred: { p: 'const', value: false } };
        const typeName = lit === null ? 'null' : lit ? 'true' : 'false';
        return { pred: { p: 'typeIs', ref, types: [typeName], positive: op === 'eq' } };
      }
    }
    return { pred: { p: 'cmp', op: /** @type {any} */ (op), ref, operand } };
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
    return { pred: { p: 'strop', kind: /** @type {any} */ (stringOp), ref, operand } };
  }

  return { refusal: refusal(node.name,
    'no native spelling of this operator is proven equivalent') };
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
 * @param {((fragment: any) => { name: string, key: string } | null) | undefined} udfHook
 * @returns {{ plan: import('./algebra.js').Plan,
 *   reasons: { construct: string, reason: string }[],
 *   whereFullyPushed: boolean, orderPushed: boolean,
 *   projectionNative: boolean, itSlot: number, udfs: string[] }}
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
      projectionNative: false, itSlot: -1, udfs: [] };
  }
  const itSlot = binding.slot;

  if (node.fold !== null) reasons.push(refusal('$fold', KIND_REASONS.let));
  if (node.letBindings.length > 0) reasons.push(refusal('$let', KIND_REASONS.let));
  if (node.asChecks !== null) reasons.push(refusal('$as', 'type assertions run in the engine'));
  if (node.groupby !== null) reasons.push(refusal('$groupby', KIND_REASONS.let));
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
          ? udfHook(rawConjuncts[i])
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
      }
    }
  }

  // ORDER BY: all terms or none — a partially pushed ordering is wrong
  let orderPushed = false;
  if (node.orderby !== null) {
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
  if (isItVar(node.ret, itSlot)) projectionNative = true;
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
    udfs,
  };
}

/**
 * Plan a whole document against one collection.
 * @param {any} document - The raw query document (kept beside the AST
 *   for residual construction — the AST has no unparser)
 * @param {any} shape - { collection, schema, columnByCanonical }
 * @param {{ udf?: (fragment: any) => { name: string, key: string } | null }} [options]
 * @returns {{
 *   analysis: any,
 *   plan: import('./algebra.js').Plan | null,
 *   mode: 'native' | 'row' | 'set',
 *   reasons: { construct: string, reason: string }[],
 *   rowReturn: any,
 *   udfs: string[],
 * }}
 */
export function planQuery(document, shape, options = undefined) {
  const analysis = analyzeQuery(document);
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
        rowReturn: null, udfs: [],
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
        rowReturn: null, udfs: [],
      };
    }
    aggregate = { name: root.name, fn: AGGREGATES.get(root.name) };
    root = root.args[0];
    rawInner = rawInner?.[aggregate.name] ?? rawInner;
    assertDecidedKind(root);
  }

  if (root.kind !== 'flwor') {
    return {
      analysis, plan: null, mode: 'set',
      reasons: [refusal(root.kind, KIND_REASONS[root.kind]
        ?? 'only a FLWOR over the collection is translated')],
      rowReturn: null, udfs: [],
    };
  }

  const flwor = planFlwor(root, shape, rawInner, options?.udf);
  const { plan } = flwor;
  const fullyPushed = flwor.whereFullyPushed && flwor.orderPushed;

  if (aggregate !== null) {
    // aggregates need the WHOLE selection native (their input is the
    // full sequence, not a narrowed candidate set)
    if (!fullyPushed) {
      return { analysis, plan: null, mode: 'set', reasons: flwor.reasons,
        rowReturn: null, udfs: [] };
    }
    if (aggregate.fn === 'count') {
      if (!flwor.projectionNative) {
        return {
          analysis, plan: null, mode: 'set',
          reasons: [refusal('$count',
            'count translates only over the bare binding (a projected return can change the item count)')],
          rowReturn: null, udfs: [],
        };
      }
      plan.aggregate = { fn: 'count', ref: null };
      return { analysis, plan, mode: 'native', reasons: [], rowReturn: null,
        udfs: flwor.udfs };
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
        rowReturn: null, udfs: [],
      };
    }
    plan.aggregate = { fn: /** @type {any} */ (aggregate.fn), ref };
    return { analysis, plan, mode: 'native', reasons: [], rowReturn: null,
      udfs: flwor.udfs };
  }

  // windows push only onto a fully pushed selection
  if (windows.length > 0 && fullyPushed) {
    // innermost window applies first; compose offsets/limits
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
    plan.window = { offset, limit };
  }

  if (fullyPushed && flwor.projectionNative && (windows.length === 0 || plan.window !== null)) {
    return { analysis, plan, mode: 'native', reasons: [], rowReturn: null,
      udfs: flwor.udfs };
  }

  // the row residual: everything but the projection pushed
  if (fullyPushed && !flwor.projectionNative
    && (windows.length === 0 || plan.window !== null)) {
    const rawFlwor = rawInner;
    return {
      analysis,
      plan,
      mode: 'row',
      reasons: flwor.reasons,
      rowReturn: rawFlwor?.$return ?? '$it',
      udfs: flwor.udfs,
    };
  }

  // the set residual: pushed conjuncts narrow, the engine answers
  plan.order = null;
  plan.window = null;
  return { analysis, plan, mode: 'set', reasons: flwor.reasons, rowReturn: null,
    udfs: flwor.udfs };
}
