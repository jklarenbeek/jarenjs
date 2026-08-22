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
 *   `rowReturn` is the COMPLETE one-row document to run, binding
 *   included — the collection binding is named by the document, so a
 *   wrapper built anywhere else would have to guess it.
 * - `set`    — the pushed conjuncts narrow candidates; the WHOLE
 *   compiled document runs over the materialized candidates.
 *
 * `reasons` names every construct that forced work off the database,
 * with reason text drawn from the deliberate-residual table.
 */

import { analyzeQuery, AST_VERSION, NODE_KINDS } from '@jarenjs/json/query';

import {
  getEpochOfDateTimeRFC3339, getEpochOfDateOnlyRFC3339,
} from '@jarenjs/core/dates/rfc3339';

import { selectPlan, conjoin, PLAN_VERSION } from './algebra.js';
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
 * @param {((fragment: any, binding: string) => { name: string, key: string } | null) | undefined} udfHook
 * @returns {{ plan: import('./algebra.js').Plan,
 *   reasons: { construct: string, reason: string }[],
 *   whereFullyPushed: boolean, orderPushed: boolean,
 *   projectionNative: boolean, itSlot: number, itName: string | null,
 *   udfs: string[] }}
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
      projectionNative: false, itSlot: -1, itName: null, udfs: [] };
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
    itName,
    udfs,
  };
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
 *   mode: 'native' | 'row' | 'set',
 *   reasons: { construct: string, reason: string }[],
 *   rowReturn: any,
 *   udfs: string[],
 * }}
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
    };
  }

  // the set residual: pushed conjuncts narrow, the engine answers
  plan.order = null;
  plan.window = null;
  return { analysis, plan, mode: 'set', reasons: flwor.reasons, rowReturn: null,
    udfs: flwor.udfs };
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
 *   mode: 'native' | 'row' | 'set',
 *   reasons: { construct: string, reason: string }[],
 *   rowReturn: any,
 *   udfs: string[],
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
