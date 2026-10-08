//@ts-check
/**
 * @file Live queries (LIVE-FORMAT §§7–12): a registered query document
 * whose result is maintained as capture records arrive, emitting
 * RFC 6902 patches against its own `{ rows }` result document.
 *
 * The CLASSIFIER implements §7's normative table and nothing more —
 * it unwraps the one-element array pack and literal `$subsequence`
 * windows the same way the planner does, then reads the compiled
 * plan: translated filters, order terms and aggregates are exactly
 * the planner's, never a re-implementation. Everything outside the
 * table re-runs on invalidation with the reason named (`live.mode`).
 *
 * Incremental maintenance is synchronous inside capture delivery (§8): inserts
 * carry their document in the patch, updates point-read the touched
 * row, deletes are answered from maintained state. Per-row semantics
 * reuse the ENGINE via packed one-row compilation (the residual
 * discipline) — a live row evaluates exactly as the query would. Optional
 * asynchronous resnapshots share this registry's result and lifecycle owner.
 */

import { compileJsonQuery, analyzeQuery } from '@jarenjs/json/query';
import { decodeJSONPointerSegment } from '@jarenjs/json/pointer';
import { isJsonObject, stableStringify } from '@jarenjs/core/object';

import { DbCompileError, DbRuntimeError } from './errors.js';
import { chain, attempt } from './driver.js';
import { planQuery, BIND_REASONS } from './plan.js';
import { createSortedWindow } from './window.js';
import { classifyEventTime, bucketStrategy, rollingStrategy } from './live-time.js';
import { joinStrategy } from './live-join.js';
import { classifyNestedGroup, nestedGroupStrategy, readsRoot } from './live-nested.js';
import { LIVE_DEFAULTS } from './live-options.js';

/** The store-level live bounds and their defaults (§12: printed,
 * never silent). */
export { LIVE_DEFAULTS };

const AGGREGATE_MEMBERS = new Map([
  ['$count', 'count'], ['$sum', 'sum'], ['$avg', 'avg'],
  ['$min', 'min'], ['$max', 'max'],
]);

/** Why an integer sum or average re-runs once its terms leave the bound
 * in which every partial sum is exact: the query path's own reason. */
const ACCUMULATION_RERUN = `'accumulation' — ${BIND_REASONS.accumulation}`;

/** Split an emitted pointer into unescaped segments. */
const segmentsOf = (path) => path.split('/').slice(1).map(decodeJSONPointerSegment);

/** Whether a `$subsequence` bound is a number literal as the query
 * analysis reads it — written as a number or quoted with `$const` —
 * which is what the planner peels a window by (it validates the value).
 * @param {any} bound
 * @returns {boolean} */
const isLiteralBound = (bound) => typeof bound === 'number'
  || (isJsonObject(bound) && Object.keys(bound).length === 1 && typeof bound.$const === 'number');

/**
 * Peel the canonical wrappers off a document the way the planner
 * does: one-element array pack, then `$subsequence` windows with
 * number-literal bounds, then a top-level aggregate member. It says
 * only WHETHER windows were peeled: their bounds are validated and
 * composed by the planner alone (`plan.window`, read through
 * `windowProbe`).
 * @param {any} document
 */
function unwrapDocument(document) {
  const whole = Array.isArray(document) && document.length === 1 ? document[0] : document;
  let doc = whole;
  let windowed = false;
  while (isJsonObject(doc) && Array.isArray(doc.$subsequence)
    && Object.keys(doc).length === 1
    && isLiteralBound(doc.$subsequence[1])
    && (doc.$subsequence[2] === undefined || isLiteralBound(doc.$subsequence[2]))) {
    windowed = true;
    doc = doc.$subsequence[0];
  }
  let aggregate = null;
  if (isJsonObject(doc)) {
    const keys = Object.keys(doc);
    if (keys.length === 1 && AGGREGATE_MEMBERS.has(keys[0])) {
      aggregate = { name: keys[0], fn: AGGREGATE_MEMBERS.get(keys[0]) };
      doc = doc[keys[0]];
      // a window INSIDE the aggregate is still a windowed aggregate
      while (isJsonObject(doc) && Array.isArray(doc.$subsequence)
        && Object.keys(doc).length === 1) {
        windowed = true;
        doc = doc.$subsequence[0];
      }
    }
  }
  return { inner: doc, whole, windowed, aggregate };
}

/**
 * The document that asks the planner for a peeled window's bounds: the
 * same `$subsequence` nesting around the ordered phrase, whose return
 * is the bare binding. A window pushes only under a projection that
 * pushes too, and the maintained window evaluates the projection per
 * row itself — so the bounds are read from a plan whose projection
 * always pushes, and `composeWindows` (plan.js) stays the one place
 * nested windows compose.
 * @param {any} window - the outermost peeled `$subsequence`, or `inner`
 * @param {any} inner - the ordered phrase `unwrapDocument` reached
 * @param {string} binding - the phrase's single `$for` name
 * @returns {any}
 */
function windowProbe(window, inner, binding) {
  if (window === inner) return { ...inner, $return: `$${binding}` };
  const [phrase, ...bounds] = window.$subsequence;
  return { $subsequence: [windowProbe(phrase, inner, binding), ...bounds] };
}

/** Whether a `$for` source is the whole collection: the bare `$[*]`, or
 * its packed spelling `["$[*]"]` — one array item a `$for` unpacks back
 * into the rows, which is how `@jarenjs/linq` binds every source so an
 * array-valued row stays one item. Over a collection the two are the
 * same rows (the planner reads through the packing the same way). */
function isWholeCollection(source) {
  return source === '$[*]'
    || (Array.isArray(source) && source.length === 1 && source[0] === '$[*]');
}

/** The single for-binding name of a canonical flwor, or null. */
function bindingNameOf(inner) {
  if (!isJsonObject(inner) || !isJsonObject(inner.$for)) return null;
  const names = Object.keys(inner.$for);
  if (names.length !== 1) return null;
  return isWholeCollection(inner.$for[names[0]]) ? names[0] : null;
}

/** The whole-documents read behind a flwor: same binding, same
 * filter, the bare document returned — the SQL-narrowed source every
 * strategy initializes from. */
function documentsSource(binding, where) {
  return {
    $for: { [binding]: '$[*]' },
    ...(where !== undefined ? { $where: where } : {}),
    $return: `$${binding}`,
  };
}

/** Whether a document fragment never reads the collection root (`$`,
 * `$.…`, `$[…]`, or the root inside a path filter — {@link readsRoot}): a
 * part the maintenance evaluates over a subset of the rows — one group,
 * one row — would see that subset as the collection. A `$const` is
 * quoted, never read.
 * @param {any} node
 * @returns {boolean} */
function readsNoRoot(node) {
  if (typeof node === 'string') return !readsRoot(node);
  if (Array.isArray(node)) return node.every(readsNoRoot);
  if (!isJsonObject(node) || Object.hasOwn(node, '$const')) return true;
  return Object.values(node).every(readsNoRoot);
}

/** Whether the live evaluators can compile `document` the way they
 * do — with no options: the registered operators, the zone provider
 * and the profile limits ride only on `execute`'s residual. A document
 * they cannot compile stays on the re-run path, which executes it.
 * @param {any} document
 * @returns {boolean} */
function compilesBare(document) {
  try {
    compileJsonQuery([document]);
    return true;
  }
  catch {
    return false;
  }
}

/**
 * Recognise the single-level group form (§7): one binding over `$[*]`,
 * optional `$where`, one or more group keys, and a `$return` that reads
 * only the group — its keys, its rows, externals — never the collection
 * root. Every output then depends on one group's rows alone, which is
 * what per-group recomputation needs; what the return reads decides its
 * member dependencies ({@link groupDeps}), not its shape.
 * @param {any} inner
 * @returns {null | { binding: string, key: any, where: any }}
 */
function recogniseGroupForm(inner) {
  const binding = bindingNameOf(inner);
  if (binding === null || !isJsonObject(inner.$groupby)) return null;
  const allowed = new Set(['$for', '$where', '$groupby', '$return']);
  if (!Object.keys(inner).every((key) => allowed.has(key))) return null;
  const groupNames = Object.keys(inner.$groupby);
  if (groupNames.length === 0) return null;
  if (![inner.$where, inner.$groupby, inner.$return].every(readsNoRoot)) return null;
  return { binding, key: groupNames.map((name) => [inner.$groupby[name]]), where: inner.$where };
}

/**
 * Recognise a group emission (§7) — how `@jarenjs/linq` spells one
 * `groupBy` followed by `select`/`where` steps: at every outer level
 * `{ $for: { <name>: [<inner>] }, $where?, $return }`, one binding over a
 * one-item packed source and a filter and return that never read the
 * collection root, around a group form ({@link recogniseGroupForm}). Each
 * outer level maps or filters one group object at a time, so the whole
 * emission evaluated over one group's rows yields exactly that group's
 * outputs. A `$groupby`, `$orderby`, window or `$distinct` at an outer
 * level is not an emission.
 * @param {any} document
 * @returns {null | { binding: string, key: any, where: any }} the group form inside
 */
function recogniseGroupEmission(document) {
  if (!isJsonObject(document) || !isJsonObject(document.$for)) return null;
  const allowed = new Set(['$for', '$where', '$return']);
  if (!Object.keys(document).every((key) => allowed.has(key))) return null;
  const sources = Object.values(document.$for);
  if (sources.length !== 1 || !Array.isArray(sources[0]) || sources[0].length !== 1) return null;
  if (![document.$where, document.$return].every(readsNoRoot)) return null;
  const [source] = sources[0];
  return recogniseGroupForm(source) ?? recogniseGroupEmission(source);
}

/**
 * Collect the top-level document members a compiled expression reads
 * through an item binding — the §8 member-level dependency set. Any
 * non-simple first step (wildcard, descendant, index) widens to the
 * whole collection. Only PATH nodes are visited: a binding read bare
 * (`$r`, `['$r']`, a nested `$for` over `$r`) is an analysis `var` node
 * this walk never sees, so a strategy that admits a bare row read
 * declares the whole document itself ({@link groupDeps}).
 * @param {any} node - an analysis AST node
 * @param {{ whole: boolean, members: Set<string> }} into
 */
function collectTopMembers(node, into) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectTopMembers(item, into);
    return;
  }
  if (node.kind === 'path' && node.rootSlot > 0 && node.external !== true) {
    const first = node.segments[0];
    if (first === undefined) {
      into.whole = true; // a path with no step reads its whole root
    }
    else if (first.descendant !== true && first.selectors.length === 1
      && first.selectors[0].kind === 'name') {
      into.members.add(first.selectors[0].name);
    }
    else {
      into.whole = true;
    }
  }
  for (const key of Object.keys(node)) {
    if (key === 'docPath') continue;
    collectTopMembers(node[key], into);
  }
}

/** Derive the member dependency set from an analysis root. */
function memberDeps(root) {
  const deps = { whole: false, members: new Set() };
  collectTopMembers(root, deps);
  return deps;
}

/**
 * The member dependency set of an admitted group (§8): the members its
 * paths read ({@link memberDeps}), unless its key, filter or return reads
 * a row BARE — a row copied whole, a nested `$for` over the group's rows,
 * `$get` over a row, a row-valued key — which reads every member of it,
 * so the group depends on the whole document. A group key variable or an
 * external read bare is not a row read, and neither is counting a group's
 * rows.
 * @param {any} root - the group document's analysis root
 * @returns {{ whole: boolean, members: Set<string> }}
 */
function groupDeps(root) {
  const keys = new Set(root.groupby.keys.map((key) => key.slot));
  const readsRowBare = (node) => {
    if (node === null || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(readsRowBare);
    if (node.kind === 'op' && node.name === '$count' && node.args.length === 1
      && node.args[0].kind === 'var') return false;
    if (node.kind === 'var' && node.external !== true && !keys.has(node.slot)) return true;
    return Object.keys(node).some((key) => key !== 'docPath' && readsRowBare(node[key]));
  };
  return readsRowBare(root) ? { whole: true, members: new Set() } : memberDeps(root);
}

/**
 * The residual reasons a plan carries once every spatial REFINEMENT is
 * taken out. A refinement is a pushed, non-exact pre-filter (`$within`,
 * a bounded `$distance`, an over-long cell prefix): the fetch is still
 * SQL-narrowed and the exact predicate stays in the residual, which is
 * the per-row evaluation maintenance runs anyway. One reason is removed
 * per non-exact pre-filter, matched by construct, so a spatial
 * predicate the planner REFUSED (no derived index on the member) still
 * counts as a reason and still re-runs.
 * @param {any} planned
 * @returns {{ construct: string, reason: string }[]}
 */
function unrefinedReasons(planned) {
  const remaining = [...planned.reasons];
  for (const prefilter of planned.prefilters) {
    if (prefilter.exact) continue;
    const index = remaining.findIndex((reason) => reason.construct === prefilter.construct);
    if (index !== -1) remaining.splice(index, 1);
  }
  return remaining;
}

/**
 * Whether a plan fell to the set residual ONLY because a spatial
 * pre-filter refines in the engine (§7's spatial rows). `allowReturn`
 * admits the per-row projection reason beside the refinement — the
 * rows strategy re-evaluates the whole document per row, so a
 * projected return is exact there and nowhere else.
 * @param {any} planned
 * @param {boolean} allowReturn
 */
function refinedOnly(planned, allowReturn) {
  if (planned.mode !== 'set' || !planned.prefilters.some((prefilter) => !prefilter.exact)) {
    return false;
  }
  const remaining = unrefinedReasons(planned)
    .filter((reason) => !(allowReturn && reason.construct === '$return'));
  return remaining.length === 0;
}

const SPATIAL_RERUN = {
  aggregate: 'a spatial aggregate re-runs: the accumulator needs a fully translated '
    + 'selection, and a refined spatial predicate leaves the exact test to the engine',
  group: 'a spatial group re-runs: the group filter needs a fully translated selection, '
    + 'and a refined spatial predicate leaves the exact test to the engine',
  order: "'$orderby' — an ordering over a refined spatial selection re-runs "
    + '(no window is maintained beside a pre-filter that only narrows)',
};

/**
 * Classify a collection query document against §7's table. Pure —
 * given the document and the collection's planner shape, returns the
 * strategy description, or a re-run description with the reason.
 * @param {any} document
 * @param {any} queryShape - the planner shape (collection, schema,
 *   columnByCanonical)
 * @param {boolean} keyed - whether documents carry their key (a
 *   declared key pointer); unkeyed rows cannot be tracked by key
 * @param {any} [eventTime] - the normalized `eventTime` option
 *   (`live-time.js`), or null when the caller declared none
 * @returns {any}
 */
export function classifyLiveQuery(document, queryShape, keyed, eventTime = null) {
  const rerun = (reason) => ({ strategy: 'rerun', reason });
  // the reason named is the first one that is NOT a spatial refinement:
  // a refinement narrows and never forces a re-run by itself
  const plannerReason = (planned) => {
    const forcing = unrefinedReasons(planned)[0] ?? planned.reasons[0]
      ?? { construct: 'residual', reason: 'the document did not translate' };
    return `'${forcing.construct}' — ${forcing.reason}`;
  };
  const { inner, whole, windowed, aggregate } = unwrapDocument(document);
  const nested = classifyNestedGroup(inner);
  if (nested !== null && !windowed && keyed && aggregate === null) return nested;

  // §13: a document that IS a temporal operator over the collection
  // answers to event time or re-runs, and never to the §7 table — the
  // planner's own residual for it is a fetch, not a maintainable shape
  const temporal = classifyEventTime(inner, windowed, keyed, eventTime);
  if (temporal !== null) return temporal;

  if (aggregate !== null) {
    if (windowed) return rerun('a windowed aggregate maintains no accumulator');
    if ((recogniseGroupForm(inner) ?? recogniseGroupEmission(inner)) !== null) {
      const grouped = classifyLiveQuery(inner, queryShape, keyed, eventTime);
      if (grouped.strategy === 'group') return { ...grouped, aggregate: aggregate.name };
    }
    const planned = planQuery({ [aggregate.name]: inner }, queryShape, {});
    if (planned.mode !== 'native' || planned.plan.aggregate === null) {
      return rerun(refinedOnly(planned, false) ? SPATIAL_RERUN.aggregate : plannerReason(planned));
    }
    if (planned.plan.group !== null || planned.plan.bucket !== null)
      return rerun('an aggregate over groups needs group-level maintenance');
    if (!keyed) return rerun('rows without a document key cannot be tracked');
    return {
      strategy: 'accumulator',
      fn: planned.plan.aggregate.fn,
      operand: inner,
      deps: memberDeps(planned.analysis.root),
    };
  }

  const emission = recogniseGroupEmission(inner);
  const group = emission ?? recogniseGroupForm(inner);
  if (group !== null) {
    if (windowed) return rerun('a windowed group re-runs');
    // the strategy evaluates the whole document once per group; an
    // emission is compiled before its row filter is planned apart from
    // it, so a refusal names the filter's place in the document
    const compiles = compilesBare(inner);
    const uncompiled = () => rerun(plannerReason(planQuery(inner, queryShape, {})));
    if (emission !== null && !compiles) return uncompiled();
    const carrier = documentsSource(group.binding, group.where);
    const planned = planQuery(carrier, queryShape, {});
    if (planned.mode !== 'native') {
      return rerun(refinedOnly(planned, false)
        ? SPATIAL_RERUN.group
        : `the group filter did not translate: ${plannerReason(planned)}`);
    }
    if (!keyed) return rerun('rows without a document key cannot be tracked');
    if (!compiles) return uncompiled();
    return {
      strategy: 'group', inner, binding: group.binding, key: group.key, carrier,
      // an emission's own `$where` filters group objects, so the row filter
      // rides on the description; its outer levels read the rows only
      // through group objects, whose members (`key`, `items`) are not
      // document members, so it depends on every member of a row
      ...(emission === null ? { deps: groupDeps(analyzeQuery(inner).root) }
        : { where: group.where ?? null, deps: { whole: true, members: new Set() } }),
    };
  }

  // a k-nearest window is planned WITH its window (the cut needs the
  // limit), so the whole document is asked before the inner one: the
  // column cuts the candidates and the engine orders them, and no
  // maintained window has that shape — a ranking re-runs, named
  if (windowed && planQuery(whole, queryShape, {}).mode === 'knn')
    return rerun('a k-nearest ranking re-runs (the vector column cuts the candidates and the engine orders them)');

  const planned = planQuery(inner, queryShape, {});
  const distinct = isJsonObject(inner) ? inner.$distinct : null;
  if (!windowed && keyed && planned.mode === 'native' && isJsonObject(distinct)
    && distinct.$orderby === undefined && bindingNameOf(distinct) !== null) {
    const binding = bindingNameOf(distinct);
    const name = binding === '_distinct' ? '_distinctKey' : '_distinct';
    const grouped = { ...distinct, $groupby: { [name]: distinct.$return }, $return: `$${name}` };
    return { strategy: 'distinct', inner: grouped, binding, key: [distinct.$return],
      carrier: documentsSource(binding, distinct.$where),
      deps: memberDeps(analyzeQuery(grouped).root) };
  }
  if (planned.mode === 'set') {
    // §7's spatial rows: the fetch is SQL-narrowed by the pushed box or
    // cell range and the exact predicate is what per-row re-evaluation
    // runs — so a `$where` that fell to the set residual ONLY for a
    // refinement is maintained as rows. An ordering beside it is not
    // (the set residual drops the planner's order terms), and neither
    // is a window; both re-run, named.
    if (!refinedOnly(planned, true)) return rerun(plannerReason(planned));
    if (!keyed) return rerun('rows without a document key cannot be tracked');
    // a translated ordering leaves no reason behind, but the set residual
    // dropped its terms — the window is not maintainable here
    if (isJsonObject(inner) && inner.$orderby !== undefined) return rerun(SPATIAL_RERUN.order);
    if (windowed) return rerun('a limit without an order is not deterministic to maintain');
    if (!compilesBare(inner)) return rerun(plannerReason(planned));
    return {
      strategy: 'rows',
      inner,
      projected: planned.reasons.some((reason) => reason.construct === '$return'),
      deps: { whole: true, members: new Set() },
    };
  }
  if (!keyed) return rerun('rows without a document key cannot be tracked');

  // SQL can group a complete selection without proving that evaluating
  // the document once per changed row maintains its result. Groups whose
  // return reads only the group were maintained above; the remaining
  // groups and distinct projections need set-level invalidation.
  if (planned.plan.group !== null || planned.plan.bucket !== null)
    return rerun('this grouping or distinct projection needs set-level maintenance');

  if (planned.plan.order !== null) {
    // the planner read through a one-item array constructor the
    // unwrapping above keeps: the result is ONE row, the whole array
    if (planned.wrapped) {
      return rerun('an ordered query inside a one-item array constructor re-runs (its one row is the whole array)');
    }
    // the bounds are the planner's: literal non-negative integers, and
    // nested windows composed innermost first — anything else re-runs
    // with the planner's own reason (a native windowed plan carries its
    // composed window). An ordered plan's phrase is one plain binding
    // over the collection, so `bindingNameOf` names it.
    /** @type {{ offset: number, limit: number | null }} */
    let window = { offset: 0, limit: null };
    if (windowed) {
      const bounded = planQuery(
        windowProbe(whole, inner, /** @type {string} */ (bindingNameOf(inner))), queryShape, {});
      if (bounded.mode !== 'native') return rerun(plannerReason(bounded));
      window = /** @type {any} */ (bounded.plan).window;
    }
    // the window keeps one item per row and evaluates every row alone
    // through an evaluator compiled with no options
    if ((planned.analysis.root.ret?.card ?? 1) > 2) return rerun('a one-to-many projection under an order re-runs');
    if (![inner.$where, inner.$return].every(readsNoRoot)) {
      return rerun('a projection that reads the collection root re-runs (a row is evaluated alone)');
    }
    if (!compilesBare(inner)) return rerun(plannerReason(planned));
    return {
      strategy: 'window',
      inner,
      order: planned.plan.order,
      offset: window.offset,
      limit: window.limit,
      deps: { whole: true, members: new Set() },
    };
  }
  if (planned.plan.window !== null || windowed) {
    return rerun('a limit without an order is not deterministic to maintain');
  }
  if (!compilesBare(inner)) return rerun(plannerReason(planned));
  return {
    strategy: 'rows',
    inner,
    projected: planned.mode === 'row',
    deps: { whole: true, members: new Set() },
  };
}

// ————— shared machinery —————

/**
 * Diff two row arrays into sequential add/remove/replace ops under
 * `/rows`, relying on REFERENCE identity for unchanged rows (the §9
 * sharing contract makes identity the equality that matters). A
 * working copy is replayed op by op, so the emitted patch transforms
 * the old array into the new one BY CONSTRUCTION; a remove re-filled
 * at the same index merges into a replace.
 * @param {any[]} oldRows
 * @param {any[]} newRows
 * @returns {any[]} ops
 */
export function diffRows(oldRows, newRows) {
  const ops = [];
  const work = oldRows.slice();
  const wanted = new Set(newRows);
  for (let i = work.length - 1; i >= 0; i--) {
    if (!wanted.has(work[i])) {
      ops.push({ op: 'remove', path: `/rows/${i}` });
      work.splice(i, 1);
    }
  }
  for (let i = 0; i < newRows.length; i++) {
    if (work[i] === newRows[i]) continue;
    const found = work.indexOf(newRows[i], i + 1);
    if (found !== -1) {
      ops.push({ op: 'remove', path: `/rows/${found}` });
      work.splice(found, 1);
    }
    ops.push({ op: 'add', path: `/rows/${i}`, value: newRows[i] });
    work.splice(i, 0, newRows[i]);
  }
  // duplicate primitive values can leave a surplus tail (the Set
  // collapsed them): trim it
  for (let i = work.length - 1; i >= newRows.length; i--) {
    ops.push({ op: 'remove', path: `/rows/${i}` });
    work.splice(i, 1);
  }
  const merged = [];
  for (let i = 0; i < ops.length; i++) {
    const here = ops[i];
    const next = ops[i + 1];
    if (next !== undefined && here.op === 'remove' && next.op === 'add'
      && here.path === next.path) {
      merged.push({ op: 'replace', path: here.path, value: next.value });
      i++;
      continue;
    }
    merged.push(here);
  }
  return merged;
}

/** The shared emission tail: ops plus the next rows, or null when
 * nothing visibly changed. */
function diffAgainst(previousRows, nextRows) {
  const ops = diffRows(previousRows, nextRows);
  return ops.length === 0 ? null : { ops, rows: nextRows };
}

/** Reuse the previous row object when a fresh one is value-equal —
 * the structural-sharing half of §9 for re-evaluated rows. */
function sharedRow(previous, fresh) {
  return stableStringify(previous) === stableStringify(fresh) ? previous : fresh;
}

/**
 * Map fresh rows onto previous references where value-equal — the
 * sharing pass for strategies that rebuild their row list (window
 * re-placements, re-runs).
 * @param {any[]} previousRows
 * @param {any[]} nextRows
 */
function shareByValue(previousRows, nextRows) {
  const kept = new Set(nextRows.filter((row) => previousRows.includes(row)));
  /** @type {Map<string, any[]>} */
  const pool = new Map();
  for (const row of previousRows) {
    if (kept.has(row)) continue;
    const key = stableStringify(row) ?? '';
    const bucket = pool.get(key);
    if (bucket === undefined) pool.set(key, [row]);
    else bucket.push(row);
  }
  return nextRows.map((row) => {
    if (kept.has(row)) return row;
    const bucket = pool.get(stableStringify(row) ?? '');
    return bucket !== undefined && bucket.length > 0 ? bucket.shift() : row;
  });
}

/**
 * Extract this collection's touched keys from one capture record,
 * respecting the member-level dependency set (§8).
 * @param {any} record
 * @param {string} name - collection name
 * @param {{ whole: boolean, members: Set<string> }} deps
 * @returns {Map<string, { kind: 'insert' | 'delete' | 'update', doc?: any }> | null}
 */
function touchedKeys(record, name, deps) {
  /** @type {Map<string, any>} */
  const touched = new Map();
  for (const op of record.patch) {
    const segments = segmentsOf(op.path);
    if (segments[0] !== name) continue;
    const token = segments[1];
    if (segments.length === 2) {
      if (op.op === 'add') touched.set(token, { kind: 'insert', doc: op.value });
      else if (op.op === 'remove') touched.set(token, { kind: 'delete' });
      else touched.set(token, { kind: 'update' });
      continue;
    }
    if (!deps.whole && !deps.members.has(segments[2])) continue;
    if (!touched.has(token)) touched.set(token, { kind: 'update' });
  }
  return touched.size === 0 ? null : touched;
}

// ————— strategies —————

/**
 * `where` (+ per-row `select`): §7's incremental rows. Bookkeeping is
 * per source key — a projected row may yield 0..n items — and the
 * result keeps arrival order (§9).
 * @param {any} description
 * @param {any} context
 */
function rowsStrategy(description, context) {
  const { inner } = description;
  const binding = /** @type {string} */ (bindingNameOf(inner));
  const evaluate = compileJsonQuery([inner]);
  const source = documentsSource(binding, inner.$where);

  /** @type {Map<string, any[]>} arrival-ordered per-key items */
  const itemsByKey = new Map();
  const flatten = () => {
    const rows = [];
    for (const items of itemsByKey.values()) rows.push(...items);
    return rows;
  };

  return {
    init: () => chain(context.execute([source], { externals: context.externals }),
      (docs) => {
        for (const doc of /** @type {any[]} */ (docs)) {
          const items = /** @type {any[]} */ (evaluate([doc], context.externals));
          if (items.length > 0) itemsByKey.set(context.keyOf(doc), items);
        }
        return flatten();
      }),
    entries: () => flatten().length,
    close: () => itemsByKey.clear(),
    apply(record, previousRows) {
      const touched = touchedKeys(record, context.name, description.deps);
      if (touched === null) return null;
      let changed = false;
      for (const [token, change] of touched) {
        const previous = itemsByKey.get(token);
        const doc = change.kind === 'delete'
          ? undefined
          : change.kind === 'insert' ? change.doc : context.readRow(token);
        const fresh = doc === undefined
          ? []
          : /** @type {any[]} */ (evaluate([doc], context.externals));
        if (fresh.length === 0) {
          if (previous !== undefined) {
            itemsByKey.delete(token);
            changed = true;
          }
          continue;
        }
        if (previous === undefined) {
          itemsByKey.set(token, fresh);
          changed = true;
          continue;
        }
        const next = fresh.map((item, index) => sharedRow(previous[index], item));
        if (next.length !== previous.length
          || next.some((item, index) => item !== previous[index])) {
          itemsByKey.set(token, next);
          changed = true;
        }
      }
      return changed ? diffAgainst(previousRows, flatten()) : null;
    },
  };
}

/**
 * `orderBy` (+ `offset`, `limit`): §7's maintained window over ALL
 * matching rows — which is what answers a delete inside the visible
 * window, and a row entering or leaving above the offset, without a
 * re-query — with the `limit` entries after the first `offset` visible
 * and ties broken by the key token.
 * @param {any} description
 * @param {any} context
 */
function windowStrategy(description, context) {
  const { inner, order, offset, limit } = description;
  const binding = /** @type {string} */ (bindingNameOf(inner));
  const rowDocument = { ...inner };
  delete rowDocument.$orderby;
  const evaluate = compileJsonQuery([rowDocument]);
  const source = documentsSource(binding, inner.$where);
  const getters = order.map((term) => {
    const steps = term.ref.segments.map((segment) =>
      ('name' in segment ? segment.name : segment.index));
    return (doc) => {
      let value = doc;
      for (const step of steps) {
        if (value === null || typeof value !== 'object') return undefined;
        value = value[step];
      }
      return value;
    };
  });
  // every matching row is kept; `visible()` is the first `offset +
  // limit` of them and the rows shown are those past the offset (a
  // `null` limit shows every row past it — never `offset + null`)
  const sortedWindow = createSortedWindow(order, limit === null ? null : offset + limit);

  const place = (token, doc) => {
    const items = /** @type {any[]} */ (evaluate([doc], context.externals));
    if (items.length === 0) return;
    sortedWindow.insert(token, getters.map((get) => get(doc)), items[0]);
  };
  const visibleRows = () => sortedWindow.visible().slice(offset).map((entry) => entry.item);

  return {
    init: () => chain(context.execute([source], { externals: context.externals }),
      (docs) => {
        for (const doc of /** @type {any[]} */ (docs)) place(context.keyOf(doc), doc);
        return visibleRows();
      }),
    entries: () => sortedWindow.size(),
    close: () => sortedWindow.clear(),
    apply(record, previousRows) {
      const touched = touchedKeys(record, context.name, description.deps);
      if (touched === null) return null;
      for (const [token, change] of touched) {
        sortedWindow.remove(token);
        if (change.kind === 'delete') continue;
        const doc = change.kind === 'insert' ? change.doc : context.readRow(token);
        if (doc !== undefined) place(token, doc);
      }
      return diffAgainst(previousRows, shareByValue(previousRows, visibleRows()));
    },
  };
}

/**
 * Whole-query aggregates: §7's running accumulator with per-row
 * contributions. `min`/`max` FALL BACK to a recompute over the
 * retained contributions when the current extremum's last holder
 * leaves — the documented fallback, counted in `stats().fallbacks`.
 * A stored `null` term is skipped, as the native aggregate skips it.
 * A sum or an average answers from its terms only while every partial
 * sum is exact — the guard the native statement carries beside it: the
 * largest magnitude times the number of terms within ±(2^53 - 1), a term
 * that is not an integer counting as past it. Past it the answer is the
 * engine's left-to-right addition in the order a fresh run reads the rows
 * (or SQL's compensated sum of non-integer terms), which only a fresh run
 * reproduces, so the registration re-runs from then on, the reason named.
 * @param {any} description
 * @param {any} context
 */
function accumulatorStrategy(description, context) {
  const { fn, operand } = description;
  const isCount = fn === 'count';
  const evaluate = compileJsonQuery([operand]);
  const binding = bindingNameOf(operand);
  const source = binding === null
    ? { $for: { it: '$[*]' }, $return: '$it' }
    : documentsSource(binding, operand.$where);

  /** @type {Map<string, number | (number | null)[]>} */
  const contributions = new Map();
  const stats = { fallbacks: 0 };
  const INEXACT = Symbol('past the exactness bound');
  /** @type {any} the re-run this registration answers by past the bound */
  let rerun = null;

  const contributionOf = (doc) => {
    const items = /** @type {any[]} */ (evaluate([doc], context.externals));
    if (items.length === 0) return undefined;
    return isCount ? items.length : items;
  };
  const fold = () => {
    let sum = 0;
    let count = 0;
    let largest = 0;
    let extreme;
    for (const contribution of contributions.values()) {
      if (isCount) {
        count += /** @type {number} */ (contribution);
        continue;
      }
      for (const value of /** @type {(number | null)[]} */ (contribution)) {
        if (value === null) continue;
        sum += value;
        count += 1;
        // a term that is not an integer (an `integer` member stores what it
        // is given) has no exact running sum: SQL compensates its rounding
        largest = Math.max(largest, Number.isInteger(value) ? Math.abs(value) : Infinity);
        if (extreme === undefined
          || (fn === 'min' ? value < extreme : value > extreme)) extreme = value;
      }
    }
    if (fn === 'count') return count;
    if (fn === 'min' || fn === 'max') return extreme;
    // the native guard: largest <= floor((2^53 - 1) / count), exactly
    if (count > 0 && largest > (Number.MAX_SAFE_INTEGER - Number.MAX_SAFE_INTEGER % count) / count) {
      return INEXACT;
    }
    if (fn === 'sum') return sum;
    return count === 0 ? undefined : sum / count;
  };
  /** Answer by re-running for the rest of the registration's life. */
  const switchToRerun = () => {
    context.handOver(ACCUMULATION_RERUN);
    contributions.clear();
    rerun = rerunStrategy(description, context);
    return rerun;
  };

  /** @type {any} */
  let current;
  const rowsOf = () => (current === undefined ? [] : [current]);

  return {
    init: () => chain(context.execute([source], { externals: context.externals }),
      (docs) => {
        for (const doc of /** @type {any[]} */ (docs)) {
          const contribution = contributionOf(doc);
          if (contribution !== undefined) {
            contributions.set(context.keyOf(doc), contribution);
          }
        }
        current = fold();
        return current === INEXACT ? switchToRerun().init() : rowsOf();
      }),
    entries: (rows) => (rerun === null ? contributions.size : rerun.entries(rows)),
    close: () => contributions.clear(),
    stats: () => ({ ...stats, ...rerun?.stats() }),
    apply(record, previousRows) {
      if (rerun !== null) return rerun.apply(record, previousRows);
      const touched = touchedKeys(record, context.name, description.deps);
      if (touched === null) return null;
      let changed = false;
      let extremumLeft = false;
      for (const [token, change] of touched) {
        const previous = contributions.get(token);
        const doc = change.kind === 'delete'
          ? undefined
          : change.kind === 'insert' ? change.doc : context.readRow(token);
        const next = doc === undefined ? undefined : contributionOf(doc);
        if (stableStringify(previous ?? null) === stableStringify(next ?? null)) continue;
        changed = true;
        if ((fn === 'min' || fn === 'max') && previous !== undefined
          && current !== undefined
          && /** @type {number[]} */ (previous).includes(current)) {
          extremumLeft = true;
        }
        if (next === undefined) contributions.delete(token);
        else contributions.set(token, next);
      }
      if (!changed) return null;
      if (extremumLeft) stats.fallbacks += 1;
      // count/sum/avg fold in O(state); the same recompute IS the
      // min/max fallback when the extremum's holder left
      current = fold();
      if (current === INEXACT) return switchToRerun().apply(record, previousRows);
      return diffAgainst(previousRows, shareByValue(previousRows, rowsOf()));
    },
  };
}

/**
 * Everything outside the table: re-run the WHOLE query on
 * invalidation and diff against the previous result with value-equal
 * reference reuse — declared, honest, reported through `live.mode`.
 * The rows are the document's result sequence (§9), as every maintained
 * strategy evaluates it: a document registered unpacked runs packed, so
 * a result that is one array is one row, never the array's items — and
 * a refusal is the one the document as registered raises, naming its
 * place there.
 * @param {any} description
 * @param {any} context
 */
function rerunStrategy(description, context) {
  const stats = { reruns: 0 };
  const { document, externals } = context;
  const packed = Array.isArray(document) ? document : [document];
  const run = () => {
    try {
      return context.execute(packed, { externals });
    }
    catch (error) {
      if (packed !== document) context.execute(document, { externals });
      throw error;
    }
  };
  return {
    init: run,
    entries: (rows) => rows.length,
    stats: () => ({ ...stats }),
    apply(record, previousRows) {
      stats.reruns += 1;
      return diffAgainst(previousRows, shareByValue(previousRows, run()));
    },
  };
}

// ————— the registry —————

/**
 * The store-level live-query registry: registration against the §12
 * bounds, capture-record delivery in commit order, lifecycle.
 * @param {{ maxQueries: number, maxMaintained: number, maxBytes?: number, resnapshot?: Function }} bounds
 */
export function createLiveRegistry(bounds) {
  if (bounds.maxBytes !== undefined && (!Number.isSafeInteger(bounds.maxBytes) || bounds.maxBytes < 1))
    throw new TypeError('live.maxBytes must be a positive safe integer');
  /** @type {Set<any>} */
  const queries = new Set();

  /**
   * @param {any} definition - `{ name, tables, document, externals,
   *   demanded, classification, execute, readRow, keyOf }`; entity
   *   re-runs pass `readRow`/`keyOf` as null and their bound tables.
   */
  const register = (definition) => {
    if (queries.size >= bounds.maxQueries) {
      throw new DbCompileError('JD0052',
        `the store's live.maxQueries bound of ${bounds.maxQueries} was reached`);
    }
    const classification = definition.classification;
    /** `live.mode` for a strategy label and its reason. */
    const modeOf = (strategy, reason) => Object.freeze({
      strategy,
      mode: ['rerun', 'resnapshot'].includes(strategy) ? strategy : 'incremental',
      ...(reason ? { reason } : {}),
    });
    const unavailable = (reason) => new DbCompileError('JD0051',
      `the demanded incremental mode is unavailable: ${reason}`);
    if (definition.demanded === 'incremental' && ['rerun', 'resnapshot'].includes(classification.strategy)) {
      throw unavailable(classification.reason);
    }
    let mode = modeOf(classification.strategy, classification.reason);

    const context = {
      name: definition.name,
      document: definition.document,
      externals: definition.externals ?? {},
      execute: definition.execute,
      readRow: definition.readRow,
      keyOf: definition.keyOf,
      readDependency: definition.readDependency,
      dependencyPosition: definition.dependencyPosition,
      rowPosition: definition.rowPosition,
      maxMaintained: bounds.maxMaintained,
      maxBytes: bounds.maxBytes ?? LIVE_DEFAULTS.maxBytes,
      diff: diffAgainst,
      share: shareByValue,
      ...definition.snapshot,
      tables: definition.tables,
      // §8's touched-key reader, handed to the strategies rather than
      // imported by them: `live-time.js` maintains its own state and
      // must not become a second implementation of the pointer walk
      touchedKeys: (record, deps) => touchedKeys(record, definition.name, deps),
      // a maintained strategy that can no longer answer what a fresh run
      // answers hands its registration over to re-running for the rest of
      // its life, the reason named in `live.mode`; a registration that
      // demanded incremental maintenance refuses instead
      handOver: (reason) => {
        if (definition.demanded === 'incremental') throw unavailable(reason);
        mode = modeOf('rerun', reason);
      },
    };
    const STRATEGIES = {
      rows: rowsStrategy, window: windowStrategy, accumulator: accumulatorStrategy,
      group: nestedGroupStrategy, distinct: nestedGroupStrategy,
      bucket: bucketStrategy, rolling: rollingStrategy, join: joinStrategy, graph: joinStrategy,
      'nested-group': nestedGroupStrategy,
    };
    const strategy = classification.strategy === 'resnapshot'
      ? bounds.resnapshot(context)
      : (STRATEGIES[classification.strategy] ?? rerunStrategy)(classification, context);

    /** @type {Set<Function>} */
    const observers = new Set();
    const state = {
      status: 'live',
      result: { rows: /** @type {any[]} */ ([]) },
      /** @type {any} */
      error: null,
      stats: { records: 0, matched: 0, emissions: 0 },
    };
    const checkBound = (entries) => {
      if (entries > bounds.maxMaintained) {
        throw new DbRuntimeError('JD2060',
          `the maintained live state (${entries} entries) exceeded the `
          + `live.maxMaintained bound of ${bounds.maxMaintained}`,
          { collection: definition.name });
      }
    };
    const emit = (event) => {
      if (strategy.emit) { strategy.emit(event); return; }
      for (const observer of observers) {
        try { observer(event); }
        catch { /* Observer isolation: committed writes remain committed. */ }
      }
    };
    const failed = (error) => {
      if (state.status !== 'live') return;
      state.status = 'errored'; state.error = error;
      emit({ error });
      queries.delete(query); strategy.close?.(); observers.clear();
    };
    const publish = (outcome, event) => {
      if (state.status !== 'live' || outcome === null) return;
      checkBound(strategy.entries(outcome.rows));
      state.stats.matched++; state.stats.emissions++;
      state.result = { rows: outcome.rows };
      emit({ patch: outcome.ops, ...event });
    };

    const query = {
      deliver(record) {
        if (state.status !== 'live') return;
        let relevant = false;
        for (const table of record.collections) {
          if (definition.tables.has(table)) {
            relevant = true;
            break;
          }
        }
        if (!relevant) return;
        state.stats.records += 1;
        if (strategy.invalidate) { strategy.invalidate(record); return; }
        let outcome;
        try {
          outcome = strategy.apply(record, state.result.rows);
          if (outcome !== null && outcome.ops === undefined) {
            // §13: a reading behind the lateness boundary is never
            // folded in silently — the view re-reads from the store,
            // and the emission carries the reason EVEN when the rows
            // did not move, because "nothing changed" is exactly what
            // a reader must not conclude on its own here
            const late = outcome.rebuild === true;
            const fresh = late ? strategy.rebuild() : outcome.rows;
            const rows = shareByValue(state.result.rows, fresh);
            const ops = diffRows(state.result.rows, rows);
            outcome = ops.length === 0 && !late ? null
              : { ops, rows, ...(late ? { late: outcome.late } : {}) };
          }
          checkBound(strategy.entries(outcome?.rows ?? state.result.rows));
        }
        catch (error) {
          failed(error);
          return;
        }
        publish(outcome, { seq: record.seq,
          ...(outcome?.late === undefined ? {} : { lateData: outcome.late }) });
      },
      close() {
        if (state.status === 'live') state.status = 'closed';
        queries.delete(query);
        observers.clear();
        return strategy.close?.();
      },
    };

    queries.add(query);
    return attempt(() => chain(strategy.init(), (rows) => {
      if (state.status !== 'live') throw new DbRuntimeError('JD2072', 'live registration closed before its snapshot settled');
      checkBound(strategy.entries(rows));
      state.result = { rows };
      let lag = false;
      strategy.start?.((event) => {
        const outcome = diffAgainst(state.result.rows, event.rows);
        const changed = event.lag !== lag;
        lag = event.lag;
        if (outcome || event.resetRequired || event.lag || changed)
          publish(outcome ?? { rows: event.rows, ops: [] }, {
            seq: event.seq, resetRequired: event.resetRequired, lag: event.lag });
      }, failed);
      return Object.freeze({
        get result() { return state.result; },
        get state() { return state.status; },
        get error() { return state.error; },
        get mode() { return mode; },
        stats: () => ({ ...state.stats, ...(strategy.stats?.() ?? {}) }),
        ...(strategy.refresh ? { refresh: strategy.refresh } : {}),
        ...(strategy.advance === undefined ? {} : {
          advance(watermark) {
            if (state.status !== 'live') throw new TypeError('the live query is closed');
            strategy.advance(watermark);
          },
        }),
        subscribe(observer) {
          if (state.status !== 'live') throw new TypeError('the live query is closed');
          if (strategy.subscribe) return strategy.subscribe(observer);
          observers.add(observer);
          return () => observers.delete(observer);
        },
        close: () => query.close(),
      });
    }), (error) => { query.close(); return error; });
  };

  return {
    register,
    count: () => queries.size,
    deliver(record) {
      for (const query of [...queries]) query.deliver(record);
    },
    closeAll() {
      const pending = [...queries].map((query) => query.close()).filter(Boolean);
      return pending.length ? Promise.all(pending) : undefined;
    },
  };
}
