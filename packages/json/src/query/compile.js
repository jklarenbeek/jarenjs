//#region Jaren JSON Query compiler
// Compiles the normalized AST (normalize.js) into a tree of specialized
// closures. Every node compiles to `get(frame) -> item | EMPTY | Seq`
// where `frame` is a plain array: slot 0 holds the input document,
// externals and $let bindings live in their allocated slots.
//
// All decisions are taken at compile time: operator dispatch, operand
// cardinality, singular-path detection. Nodes whose static cardinality is
// CARD_ONE compile to singleton-mode closures that skip every sequence
// check - the main reason compiled queries are fast.

import { compareCodePoints } from '@jarenjs/core/string';
import { setObjectMember } from '@jarenjs/core/object';
import {
  NOTHING,
  compileSingularGetter,
  compileSegmentV,
  withDescentDocPath,
  runSegmentsV,
} from '../segments.js';
import { queryRuntimeError } from './messages.js';
import { EMPTY, Seq, seqOf, appendItem, ebv, stableKeyString, stableKeyStringWithin, itemRef } from './runtime.js';
import { CARD_ONE, CARD_MANY, hostFailureText, collectReadSlots } from './normalize.js';
// The operator registry: every section-8 operator compiles through its
// table entry (compileOp). Only referenced inside functions, so the
// import cycle compile.js <-> operators.js is initialization-safe.
import { OPERATORS, checkRangeBound } from './operators.js';
import { intervalArg } from './series.js';
import { bboxOf, createBboxIndex } from '@jarenjs/core/geo';
import { CodedError } from '@jarenjs/core/errors';
import { createIntervalIndex, overlapsInterval } from '@jarenjs/core/series';

/**
 * Sentinel stored in the frame slot of an external parameter the caller
 * did not bind; evaluating a reference to it raises JQ2006.
 */
export const UNBOUND = Symbol('JsonQuery.Unbound');

//#region variables & paths

function compileVarGetter(slot, external, name, docPath) {
  if (!external)
    return (f) => f[slot];
  return (f) => {
    const v = f[slot];
    if (v === UNBOUND)
      throw queryRuntimeError('JQ2006', 'query/external-unbound', { name }, docPath);
    return v;
  };
}

function compileVar(node) {
  return compileVarGetter(node.slot, node.external, node.name, node.docPath);
}

// A path leaf: run the (pre-parsed) RFC 9535 segments against the root
// value. The root of an embedded `[?...]` filter's `$` is always frame
// slot 0, the input document (section 3.2). A variable-rooted path runs
// its segments against each item of the variable's bound sequence in
// order, concatenating results; an item that is an array flows as-is
// (one RFC 9535 node).
function compilePath(node) {
  const base = compileVarGetter(node.rootSlot, node.external, node.name, node.docPath);
  if (node.singular) {
    const getter = compileSingularGetter(node.segments, true);
    if (node.rootCard === CARD_ONE) {
      // singleton root (input document, external, or ONE-card binding):
      // a direct property walk, no sequence checks
      return (f) => {
        const v = getter(base(f), f[0]);
        return v === NOTHING ? EMPTY : v;
      };
    }
    return (f) => {
      const b = base(f);
      if (b === EMPTY)
        return EMPTY;
      if (b instanceof Seq) {
        const items = b.items;
        const acc = [];
        for (let i = 0; i < items.length; i++) {
          const v = getter(items[i], f[0]);
          if (v !== NOTHING)
            acc.push(v);
        }
        return seqOf(acc);
      }
      const v = getter(b, f[0]);
      return v === NOTHING ? EMPTY : v;
    };
  }
  const segs = withDescentDocPath(node.docPath, () => node.segments.map(compileSegmentV));
  if (node.rootCard === CARD_ONE)
    return (f) => seqOf(runSegmentsV(segs, base(f), f[0]));
  return (f) => {
    const b = base(f);
    if (b === EMPTY)
      return EMPTY;
    if (b instanceof Seq) {
      const items = b.items;
      const acc = [];
      for (let i = 0; i < items.length; i++) {
        const out = runSegmentsV(segs, items[i], f[0]);
        for (let j = 0; j < out.length; j++)
          acc.push(out[j]);
      }
      return seqOf(acc);
    }
    return seqOf(runSegmentsV(segs, b, f[0]));
  };
}

/**
 * Existence-only compilation for `$exists`/`$empty` (and any future
 * boolean context): paths never materialize a result sequence (the
 * analogue of path.js's compileExists). Takes the operand AST node -
 * this is why registry `compile` functions receive arg nodes, not just
 * getters.
 * @param {object} node - a frozen AST node from normalize.js
 * @returns {(frame: any[]) => boolean}
 */
export function compileExistsTest(node) {
  if (node.kind === 'path') {
    const base = compileVarGetter(node.rootSlot, node.external, node.name, node.docPath);
    if (node.singular) {
      const getter = compileSingularGetter(node.segments, true);
      if (node.rootCard === CARD_ONE)
        return (f) => getter(base(f), f[0]) !== NOTHING;
      return (f) => {
        const b = base(f);
        if (b === EMPTY)
          return false;
        if (b instanceof Seq) {
          const items = b.items;
          for (let i = 0; i < items.length; i++) {
            if (getter(items[i], f[0]) !== NOTHING)
              return true;
          }
          return false;
        }
        return getter(b, f[0]) !== NOTHING;
      };
    }
    const segs = withDescentDocPath(node.docPath, () => node.segments.map(compileSegmentV));
    if (node.rootCard === CARD_ONE)
      return (f) => runSegmentsV(segs, base(f), f[0]).length !== 0;
    return (f) => {
      const b = base(f);
      if (b === EMPTY)
        return false;
      if (b instanceof Seq) {
        const items = b.items;
        for (let i = 0; i < items.length; i++) {
          if (runSegmentsV(segs, items[i], f[0]).length !== 0)
            return true;
        }
        return false;
      }
      return runSegmentsV(segs, b, f[0]).length !== 0;
    };
  }
  if (node.kind === 'var') {
    const get = compileVar(node);
    return (f) => get(f) !== EMPTY;
  }
  const get = compileNode(node);
  return (f) => get(f) !== EMPTY;
}

//#endregion

//#region constructors

// member applier for map constructors and $map values: ONE-card values
// assign directly; otherwise an empty result omits the member and a
// multi-item result is JQ2001 (a JSON member holds exactly one value)
function memberValue(v, name, docPath) {
  if (v instanceof Seq)
    throw queryRuntimeError('JQ2001', 'query/member-cardinality', { name, count: v.items.length }, docPath);
  return v;
}

function compileObject(node) {
  const entries = node.entries;
  if (entries.length === 0)
    return () => ({});
  const appliers = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    const { name, expr } = entries[i];
    const get = compileNode(expr);
    // a constructed '__proto__' member is data, not the prototype; the
    // name is static here, so the slow defineProperty path is chosen once
    // at compile time and the ordinary member keeps a bare assignment
    const proto = name === '__proto__';
    if (expr.card === CARD_ONE) {
      appliers[i] = proto
        ? (f, out) => setObjectMember(out, name, get(f))
        : (f, out) => {
          out[name] = get(f);
        };
    }
    else {
      const docPath = expr.docPath;
      appliers[i] = proto
        ? (f, out) => {
          const v = get(f);
          if (v !== EMPTY)
            setObjectMember(out, name, memberValue(v, name, docPath));
        }
        : (f, out) => {
          const v = get(f);
          if (v !== EMPTY)
            out[name] = memberValue(v, name, docPath);
        };
    }
  }
  return buildObject(appliers);
}

// the object both constructors build: a fresh one per evaluation, each
// member applier run in order (so in a map, later pairs win on duplicate
// keys)
function buildObject(appliers) {
  const alen = appliers.length;
  return (f) => {
    const out = {};
    for (let i = 0; i < alen; i++)
      appliers[i](f, out);
    return out;
  };
}

function compileMap(node) {
  const pairs = node.pairs;
  if (pairs.length === 0)
    return () => ({});
  const appliers = new Array(pairs.length);
  for (let i = 0; i < pairs.length; i++) {
    const { key, value } = pairs[i];
    const keyGet = compileNode(key);
    const valGet = compileNode(value);
    const keyPath = key.docPath;
    const valPath = value.docPath;
    const valOne = value.card === CARD_ONE;
    appliers[i] = (f, out) => {
      const k = keyGet(f);
      if (typeof k !== 'string')
        throw queryRuntimeError('JQ2004', 'query/map-key', { got: itemRef(k) }, keyPath);
      // the key is dynamic, so the '__proto__' test is a runtime one
      if (valOne) {
        setObjectMember(out, k, valGet(f));
        return;
      }
      const v = valGet(f);
      if (v !== EMPTY)
        setObjectMember(out, k, memberValue(v, k, valPath));
    };
  }
  return buildObject(appliers);
}

// shared flattening accumulator of array constructors and $seq
function compileElementAppliers(elements) {
  const appliers = new Array(elements.length);
  for (let i = 0; i < elements.length; i++) {
    const get = compileNode(elements[i]);
    appliers[i] = elements[i].card === CARD_ONE
      ? (f, acc) => acc.push(get(f))
      : (f, acc) => appendItem(acc, get(f));
  }
  return appliers;
}

function compileArray(node) {
  if (node.elements.length === 0)
    return () => [];
  const appliers = compileElementAppliers(node.elements);
  const alen = appliers.length;
  return (f) => {
    const acc = [];
    for (let i = 0; i < alen; i++)
      appliers[i](f, acc);
    return acc;
  };
}

//#endregion

//#region operators

// A registry operator call (normalize.js `op` node): compile the argument
// getters, hand them - with the argument nodes, which carry `card` and
// `docPath` - to the table entry's `compile`. Arguments declared 'raw' or
// 'name' are compile-time data (`args[i].value`), not getters. Extension
// op nodes (options.extensions) carry their resolved entry themselves.
function compileOp(node) {
  const entry = OPERATORS[node.name] ?? node.entry;
  const args = node.args;
  const gets = new Array(args.length);
  for (let i = 0; i < args.length; i++)
    gets[i] = args[i].kind === 'raw' ? null : compileNode(args[i]);
  // the node rides along for entries that read compilation context
  // (e.g. $range's configurable resource guard via node.limits)
  return entry.compile(gets, args, node.docPath + '/' + node.name, node);
}

// A '$call' node: a registered trusted pure host function
// (options.functions). Sequences cross the boundary as arrays, the
// empty sequence as undefined; a returned undefined is the empty
// sequence, anything else is one item. A throwing function is JQ2010.
function compileCall(node) {
  const fn = node.fn;
  const name = node.name;
  const docPath = node.docPath;
  const argGets = new Array(node.args.length);
  for (let i = 0; i < node.args.length; i++)
    argGets[i] = compileNode(node.args[i]);
  return (f) => {
    const argv = new Array(argGets.length);
    for (let i = 0; i < argGets.length; i++) {
      const v = argGets[i](f);
      argv[i] = v === EMPTY ? undefined : v instanceof Seq ? v.items.slice() : v;
    }
    let out;
    try {
      out = fn(...argv);
    }
    catch (err) {
      // TOTAL: the registered function is host code — no .message read
      // on the raw value, no coercion; the original thrown value is
      // retained as an own cause (present even for undefined)
      throw queryRuntimeError('JQ2010', 'query/function-threw', { name, detail: hostFailureText(err) }, docPath,
        { cause: err });
    }
    return out === undefined ? EMPTY : out;
  };
}

//#endregion

//#region $let

function compileLet(node) {
  const ret = compileNode(node.ret);
  if (node.bindings.length === 1) {
    const { slot, expr } = node.bindings[0];
    const get = compileNode(expr);
    return (f) => {
      f[slot] = get(f);
      return ret(f);
    };
  }
  const blen = node.bindings.length;
  const slots = new Array(blen);
  const gets = new Array(blen);
  for (let i = 0; i < blen; i++) {
    slots[i] = node.bindings[i].slot;
    gets[i] = compileNode(node.bindings[i].expr);
  }
  return (f) => {
    for (let i = 0; i < blen; i++)
      f[slots[i]] = gets[i](f);
    return ret(f);
  };
}

//#endregion

//#region FLWOR
// The tuple stream is a chain of nested closures, each of signature
// `(frame, out) -> void`: a $for clause iterates its source and calls the
// next stage per item, $let assigns and calls once, $as validates bound
// slots against compiled type tests, $where gates on EBV.
// A tuple IS the current state of the frame slots - no tuple objects, no
// intermediate arrays. `out` threads the current stage's collector
// through untouched: the result accumulator, or a barrier's state.
//
// $groupby and $orderby are barriers; they materialize the minimum via
// compile-time liveness (normalize.js): $groupby accumulates only the
// live binding slots per group, $orderby snapshots only the live slots
// per tuple next to its pre-evaluated key row (Schwartzian transform).
//
//#region hash joins
// The default pipeline is nested loops, so `$for a, $for b` with an
// equality `$where` costs O(|a| x |b|). When the inner binding is
// *uncorrelated* - its source does not read any outer binding - that
// equality can be answered by a hash table built once over the inner
// side, which makes the join O(|a| + |b|).
//
// The rewrite is only applied where it is provably invisible:
//
//   - the phrase has no `$as` and no `$let`. Both run per tuple BETWEEN
//     `$for` and `$where`, so they can observe - or fail on - a tuple the
//     equality would later have dropped. A hash join never forms that
//     tuple, which would silently retract a `$as` assertion;
//   - the probe side is the innermost $for, with no `$at` (a position
//     would have to survive bucketing), no `$allowing-empty` and no
//     window. A `$range` source is probed only by a hash join whose inner
//     key is the range variable itself (below): no table is built over
//     it, so the range guard that refuses a build never applies;
//   - its source reads no slot bound by an outer binding;
//   - the equality is the whole `$where`, or its FIRST `$and` conjunct,
//     so nothing that used to be evaluated before it is skipped;
//   - both key expressions are paths or variable references, which raise
//     nothing but JQ2006 (an unbound external), and each is read only
//     where the scan reads it (below);
//   - neither key is statically MANY, because `$eq` is an existential
//     comparison over sequences and a bucket holds one key per item.
//
// Equality itself stays exact: buckets key on `stableKeyString`, which
// agrees with the `$eq` relation (`equalsJson`) on every JSON value
// except NaN, which the key groups with NaN and `$eq` finds equal to
// nothing. A NaN key is dropped on both sides, which is what `$eq`
// already does. A value with no key - one nested past the key's bound,
// holding a cycle, or holding a NaN at any depth, which `$eq` can still
// answer (a value equals itself, NaN inside it included) - is answered by
// the scan instead, through the `$eq` itself over every inner item, for
// an outer tuple whose key is missing. An inner item whose key is missing is
// filed nowhere: `$eq` finds it equal to no value that has a key, and
// raises nothing there, since the walk never goes deeper than the
// keyed side.
//
// Every probe - this one and the screened ones below - also evaluates
// what the scan evaluates WHEN the scan evaluates it, so it cannot
// raise where the scan answers, or raise a different first error:
//
//   - the inner side is built at the first outer tuple that reaches the
//     probe, which is where the scan first evaluates the inner source:
//     an empty outer side evaluates nothing of the inner one, and an
//     outer source that raises raises first. The source is then
//     evaluated once per phrase evaluation rather than once per outer
//     tuple, which only a registered `$call` function could observe,
//     and those are pure;
//   - the outer operand is read only when the scan's predicate reads it
//     for some pair: never without an inner item, and - when the inner
//     operand comes first and the predicate stops at an empty one, as
//     `$eq` and `$overlaps` do - only beside an inner operand that is
//     not empty;
//   - the probe's own reads of the operands are not counted against
//     `limits.steps`: the scan counts the same reads inside the
//     predicate, so the probe's count never runs ahead of the scan's,
//     and the probe never exceeds a limit the scan stays inside.

function isEqOp(node) {
  return node.kind === 'op' && node.name === '$eq' && node.args.length === 2;
}

// A source the scan counts through rather than builds: `$range` with its
// two bounds (`rangeSource`)
function isRangeOp(expr) {
  return expr.kind === 'op' && expr.name === '$range' && expr.args.length === 2;
}

// The predicates an index over the inner side can screen, one screen per
// predicate family. A screen builds the index over the inner operands -
// pushing onto `always` every position the index cannot speak for - and
// answers, for one outer operand that is not EMPTY, the candidate
// positions, or null when that operand cannot be screened at all.
// `readsBoth` says whether the predicate reads both operands of every
// pair, or stops at an EMPTY first one.

// The spatial predicates a bounding box can screen. Box overlap is a
// NECESSARY condition for both - a position inside a surface lies inside
// that surface's box, and box intersection is what the second one tests
// outright - so an index over boxes can only ever remove candidates that
// would have failed anyway.
const BOX_SCREEN = {
  readsBoth: true,
  index(values, always) {
    const boxes = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      boxes[i] = screenBox(values[i]);
      // no box means the index cannot speak for it - a malformed operand
      // must still reach the predicate and raise what a scan would raise
      if (boxes[i] === null)
        always.push(i);
    }
    return createBboxIndex(boxes);
  },
  candidates(index, v) {
    const box = screenBox(v);
    return box === null ? null : index.search(box[0], box[1], box[2], box[3]);
  },
};

// The box a screen files a value under, or null for one it cannot: no box,
// or a value the walk refuses (a cycle, or a nest past its bound). The
// refusal is left for the predicate, which raises it for exactly the pairs
// a scan reaches, after whatever the scan raises first.
function screenBox(v) {
  try {
    return bboxOf(v);
  }
  catch (error) {
    if (error instanceof CodedError && (error.code === 'JO2001' || error.code === 'JO2002'))
      return null;
    throw error;
  }
}

// Does `$overlaps` accept `v` as an interval? Asked of the operator's own
// rule - `intervalArg`'s record test, then the kernel's `overlapsInterval`
// of the span against itself - so the rule lives in one place, and
// whatever it refuses, however it refuses it, is left for the predicate
// to raise.
function isInterval(v) {
  try {
    const span = intervalArg(v, '');
    overlapsInterval(span, span);
    return true;
  }
  catch {
    return false;
  }
}

const SPAN_BOUNDS = { start: (w) => w.span.start, end: (w) => w.span.end };

// `$overlaps`: an interval index answers exactly the spans the kernel
// would pair with the probe's - the same half-open test over the same
// instants. An EMPTY inner span is never a candidate: `$overlaps`
// answers it with the empty sequence, which `$where` reads as false and
// which raises nothing. A span the kernel refuses goes to the always
// list rather than the index, because `createIntervalIndex` refuses the
// whole build at the first malformed row. An outer span the kernel
// refuses cannot be screened.
const SPAN_SCREEN = {
  readsBoth: false,
  index(values, always) {
    const spans = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === EMPTY)
        continue;
      if (isInterval(v))
        spans.push({ i, span: v });
      else
        always.push(i);
    }
    return createIntervalIndex(spans, SPAN_BOUNDS);
  },
  candidates(index, v) {
    if (!isInterval(v))
      return null;
    const hits = index.overlapping(v.start, v.end);
    for (let k = 0; k < hits.length; k++)
      hits[k] = hits[k].i;
    return hits;
  },
};

const SCREENS = new Map([
  ['$within', BOX_SCREEN],
  ['$bbox-intersects', BOX_SCREEN],
  ['$overlaps', SPAN_SCREEN],
]);

function isKeyExpr(node) {
  return (node.kind === 'path' || node.kind === 'var') && node.card !== CARD_MANY;
}

function readsOf(node) {
  const set = new Set();
  collectReadSlots(node, set);
  return set;
}

function intersects(set, slots) {
  for (let i = 0; i < slots.length; i++) {
    if (set.has(slots[i]))
      return true;
  }
  return false;
}

// The innermost $for of a phrase a probe could serve, and the slots its
// outer bindings fill - or null when serving it would be visible.
// Returns { inner, outerSlots } or null.
function probeBinding(node) {
  const fors = node.forBindings;
  if (fors.length < 2 || node.where === null)
    return null;
  if (node.asChecks !== null || node.letBindings.length !== 0)
    return null; // they run per tuple before $where and would see fewer
  const inner = fors[fors.length - 1];
  if (inner.atSlot >= 0 || inner.allowingEmpty === true
    || (inner.window !== null && inner.window !== undefined))
    return null;

  const outerSlots = [];
  for (let i = 0; i < fors.length - 1; i++) {
    outerSlots.push(fors[i].slot);
    if (fors[i].atSlot >= 0)
      outerSlots.push(fors[i].atSlot);
  }
  if (intersects(readsOf(inner.expr), outerSlots))
    return null; // correlated: the probe would differ per outer tuple
  return { inner, outerSlots };
}

// Decide whether `node`'s innermost $for can become a hash-join probe.
// Returns { inner, eq, outerKey, innerKey, residual, outerFirst,
// readsBoth } or null.
function planHashJoin(node) {
  const binding = probeBinding(node);
  if (binding === null)
    return null;
  const { inner, outerSlots } = binding;

  const where = node.where;
  let eq = null;
  let rest = null;
  if (isEqOp(where)) {
    eq = where;
  }
  else if (where.kind === 'op' && where.name === '$and' && isEqOp(where.args[0])) {
    eq = where.args[0];
    // a one-conjunct $and is just the equality; leave no empty filter behind
    rest = where.args.length > 1 ? where.args.slice(1) : null;
  }
  if (eq === null || !isKeyExpr(eq.args[0]) || !isKeyExpr(eq.args[1]))
    return null;

  // one side must be the probe's key, the other must not mention it
  const reads0 = readsOf(eq.args[0]);
  const reads1 = readsOf(eq.args[1]);
  const uses0 = reads0.has(inner.slot);
  const uses1 = reads1.has(inner.slot);
  if (uses0 === uses1)
    return null;
  const innerKey = uses0 ? eq.args[0] : eq.args[1];
  const outerKey = uses0 ? eq.args[1] : eq.args[0];
  if (readsOf(outerKey).has(inner.slot) || intersects(readsOf(innerKey), outerSlots))
    return null;
  // a range holds each integer once, so its item for an outer key is the key
  // itself, and only a key that is the item itself says so
  if (isRangeOp(inner.expr) && !(innerKey.kind === 'var' && innerKey.slot === inner.slot))
    return null;

  return {
    inner, eq, outerKey, innerKey, residual: rest, outerFirst: uses1,
    // `$eq` of two singletons reads both; otherwise it stops at an empty
    // first operand
    readsBoth: eq.args[0].card === CARD_ONE && eq.args[1].card === CARD_ONE,
  };
}

/**
 * Decide whether the innermost `$for` can be probed through an index
 * that screens the predicate. Returns `{ inner, innerArg, outerArg,
 * screen, outerFirst, readsBoth }` or null.
 *
 * Unlike the hash join this does NOT consume the predicate: the index
 * only narrows the candidate set, and `$where` still runs unchanged on
 * every candidate. That makes the rewrite correct by construction — the
 * surviving tuples are decided by the same closure either way — and
 * leaves two things to be careful about. A tuple the index rejects never
 * reaches the predicate at all, so `compileScreenedProbe` keeps any item
 * the index cannot speak for in an always-check list, and a malformed
 * operand still raises the error a scan would have raised. And the
 * candidates run in the order the scan would have reached them, so the
 * answer's order and the first error are the scan's too.
 */
function planScreenedJoin(node) {
  const binding = probeBinding(node);
  if (binding === null)
    return null;
  const where = node.where;
  const screen = where.kind === 'op' && where.args.length === 2
    ? SCREENS.get(where.name)
    : undefined;
  if (screen === undefined)
    return null; // only a bare screened predicate; an $and could throw first
  const { inner, outerSlots } = binding;
  if (isRangeOp(inner.expr))
    return null; // the scan raises at the first pair: a range holds numbers only

  // one operand must be the probe's own, the other must not mention it
  const [a, b] = where.args;
  if (!isKeyExpr(a) || !isKeyExpr(b))
    return null; // paths and variables only, read where the scan reads them
  const usesA = readsOf(a).has(inner.slot);
  const usesB = readsOf(b).has(inner.slot);
  if (usesA === usesB)
    return null;
  const innerArg = usesA ? a : b;
  const outerArg = usesA ? b : a;
  if (readsOf(outerArg).has(inner.slot) || intersects(readsOf(innerArg), outerSlots))
    return null;
  return { inner, innerArg, outerArg, screen, outerFirst: usesB, readsBoth: screen.readsBoth };
}

// The items a $for over `v` iterates, unpacked exactly as the $for
// unpacks them: an array item contributes its members, one level deep.
function innerItems(v) {
  const items = [];
  if (v === EMPTY)
    return items;
  const list = v instanceof Seq ? v.items : [v];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (Array.isArray(item)) {
      for (let j = 0; j < item.length; j++)
        items.push(item[j]);
    }
    else {
      items.push(item);
    }
  }
  return items;
}

// Does the scan's predicate read the outer operand for some pair of this
// inner side? Not without a pair; at every pair when it reads both
// operands or the outer one first; otherwise only beside an inner
// operand that is not EMPTY.
function readsOuter(plan, count, someValue) {
  return count > 0 && (plan.outerFirst || plan.readsBoth || someValue);
}

// The driver of a probe clause, around the whole tuple stream: the
// stream runs with the probe's state unbuilt - the probe builds it at
// the first outer tuple that arrives - and the caller's state is
// restored after, because a registered `$call` function can re-enter the
// same compiled query from inside the stream.
function probeDriver(cell) {
  return (f, out, chain) => {
    const saved = cell.state;
    cell.state = null;
    try {
      chain(f, out);
    }
    finally {
      cell.state = saved;
    }
  };
}

const ascending = (x, y) => x - y;

/**
 * The one candidate emitter of the screened probes. `hits` are inner
 * positions in whatever order the index answers them (a tree's leaf
 * order, an interval index's start order); `always` is ascending by
 * construction, and the two never share a position. Visited merged, in
 * ascending inner position, they are the tuples the scan would reach, in
 * the order it reaches them - so the answer's order and the first error
 * a candidate raises are the scan's own.
 */
function emitAscending(hits, always, visit, f, out) {
  hits.sort(ascending);
  let h = 0;
  let a = 0;
  while (h < hits.length || a < always.length) {
    if (a === always.length || (h < hits.length && hits[h] < always[a]))
      visit(f, out, hits[h++]);
    else
      visit(f, out, always[a++]);
  }
}

/**
 * The screened probe clause and its driver. The index is built at the
 * first outer tuple that reaches the probe, once per phrase evaluation.
 */
function compileScreenedProbe(plan, next, where, wherePath) {
  const screen = plan.screen;
  const slot = plan.inner.slot;
  const srcGet = compileNode(plan.inner.expr);
  const innerGet = compileUncounted(plan.innerArg);
  const outerGet = compileUncounted(plan.outerArg);
  const cond = compileNode(where);
  const cell = { state: null };

  const build = (f) => {
    const items = innerItems(srcGet(f));
    // every inner operand is evaluated, and classified, once per build
    const values = new Array(items.length);
    let someValue = false;
    for (let i = 0; i < items.length; i++) {
      f[slot] = items[i];
      values[i] = innerGet(f);
      if (values[i] !== EMPTY)
        someValue = true;
    }
    const always = [];
    const index = screen.index(values, always);
    return { items, always, index, readsOuter: readsOuter(plan, items.length, someValue) };
  };

  const visit = (f, out, i) => {
    f[slot] = cell.state.items[i];
    if (ebv(cond(f), wherePath))
      next(f, out);
  };

  const probe = (f, out) => {
    if (cell.state === null)
      cell.state = build(f);
    const state = cell.state;
    if (!state.readsOuter)
      return; // the scan reads no outer operand here: nothing matches or raises
    const v = outerGet(f);
    if (v === EMPTY)
      return; // every pair answers false or empty, and none raises
    const hits = screen.candidates(state.index, v);
    if (hits === null) {
      // nothing to screen with: fall back to the full scan, which is
      // what this phrase would have done without an index at all
      for (let i = 0; i < state.items.length; i++)
        visit(f, out, i);
      return;
    }
    emitAscending(hits, state.always, visit, f, out);
  };
  return { drive: probeDriver(cell), probe };
}

// The key a bucket is filed under; null when the value cannot take part
// in an equality at all (empty, a multi-item sequence, or NaN); undefined
// when it can but has no key (nested past the key's bound, holding a
// cycle, or a container holding a NaN), so only the scan's `$eq` can
// answer it. A NaN leaf writes `NaN` unquoted into its container's key,
// so a key without that text holds none; one with it (text that spells
// `NaN` too) is left to the scan, which answers either the same.
function joinKey(v) {
  if (v === EMPTY || v instanceof Seq)
    return null;
  if (typeof v !== 'object' || v === null)
    return v !== v ? null : stableKeyStringWithin(v);
  const key = stableKeyStringWithin(v);
  return key !== undefined && key.includes('NaN') ? undefined : key;
}

// The hash-join probe clause and its driver. The table is built at the
// first outer tuple that reaches the probe, once per phrase evaluation.
function compileJoinProbe(plan, next) {
  if (isRangeOp(plan.inner.expr))
    return compileRangeProbe(plan, next);
  const slot = plan.inner.slot;
  const srcGet = compileNode(plan.inner.expr);
  const innerKeyGet = compileUncounted(plan.innerKey);
  const outerKeyGet = compileUncounted(plan.outerKey);
  const eqGet = compileNode(plan.eq);
  const eqPath = plan.eq.docPath;
  const cell = { state: null };

  const build = (f) => {
    const items = innerItems(srcGet(f));
    const table = new Map();
    let someValue = false;
    for (let i = 0; i < items.length; i++) {
      f[slot] = items[i];
      const v = innerKeyGet(f);
      if (v !== EMPTY)
        someValue = true;
      // an item without a key equals no outer key that has one: only an
      // outer key without one, which the scan answers, can meet it
      const key = joinKey(v);
      if (key === null || key === undefined)
        continue;
      const bucket = table.get(key);
      if (bucket === undefined)
        table.set(key, [items[i]]);
      else
        bucket.push(items[i]);
    }
    return { items, table, readsOuter: readsOuter(plan, items.length, someValue) };
  };

  // the scan this probe stands for, for an outer tuple
  const scan = (f, out, items) => {
    for (let i = 0; i < items.length; i++) {
      f[slot] = items[i];
      if (ebv(eqGet(f), eqPath))
        next(f, out);
    }
  };

  const probe = (f, out) => {
    if (cell.state === null)
      cell.state = build(f);
    const state = cell.state;
    if (!state.readsOuter)
      return; // the scan reads no outer key here: nothing matches or raises
    const key = joinKey(outerKeyGet(f));
    if (key === null)
      return;
    if (key === undefined)
      return scan(f, out, state.items);
    const bucket = state.table.get(key);
    if (bucket === undefined)
      return;
    for (let i = 0; i < bucket.length; i++) {
      f[slot] = bucket[i];
      next(f, out);
    }
  };
  return { drive: probeDriver(cell), probe };
}

// The probe over a `$range` source, which builds nothing: the range holds
// each integer from its first bound to its last once, so the only item an
// outer key can equal is that key, when it is an integer inside the bounds.
// The bounds are read, and checked, as the counting loop reads them, at the
// first outer tuple that reaches the probe.
function compileRangeProbe(plan, next) {
  const slot = plan.inner.slot;
  const [fromNode, toNode] = plan.inner.expr.args;
  const fromGet = compileNode(fromNode);
  const toGet = compileNode(toNode);
  const outerKeyGet = compileUncounted(plan.outerKey);
  const cell = { state: null };

  const build = (f) => {
    const a = fromGet(f);
    const b = toGet(f);
    if (a === EMPTY || b === EMPTY)
      return { from: 0, to: -1 };
    checkRangeBound(a, fromNode.docPath);
    checkRangeBound(b, toNode.docPath);
    return { from: a, to: b };
  };

  const probe = (f, out) => {
    if (cell.state === null)
      cell.state = build(f);
    const { from, to } = cell.state;
    if (from > to)
      return; // no item: the scan reads no outer key here
    const key = outerKeyGet(f);
    if (!Number.isInteger(key) || key < from || key > to)
      return;
    // the item the counting loop reaches: its first one is the lower bound as
    // handed over (a negative zero stays one), the others come from adding 1
    f[slot] = key === from ? from : key + 0;
    next(f, out);
  };
  return { drive: probeDriver(cell), probe };
}

//#endregion

// D4 iteration step: an item that is an array contributes its members
// (one level - nested arrays inside stay items); everything else is one
// tuple. Shared by $for and the quantifier loops.
function emitForItem(item, f, slot, next, out) {
  if (Array.isArray(item)) {
    for (let j = 0; j < item.length; j++) {
      f[slot] = item[j];
      next(f, out);
    }
    return;
  }
  f[slot] = item;
  next(f, out);
}

// ... and the positional variant: `pos` is the 0-based (D6) position
// within the iterated (post-unpacking) sequence; returns the next one.
function emitForItemAt(item, f, slot, atSlot, pos, next, out) {
  if (Array.isArray(item)) {
    for (let j = 0; j < item.length; j++) {
      f[slot] = item[j];
      f[atSlot] = pos++;
      next(f, out);
    }
    return pos;
  }
  f[slot] = item;
  f[atSlot] = pos;
  next(f, out);
  return pos + 1;
}

// Iterating a `$range` never needs the range to exist. A `$for` (or a
// quantifier) whose source is *statically* a `$range` compiles to a
// counting loop instead of materializing 2^32 numbers to walk them once:
// the memory goes from O(n) to O(1) and the JQ2007 resource guard stops
// being the thing standing between a query and the heap. What bounds
// such a loop is time, which is what `limits.steps` is for.
//
// This is a compile-time specialization of the one shape that matters,
// not general lazy-sequence evaluation: a `$range` bound by `$let`, or
// handed to an aggregate, still materializes.
// The bound getters of a statically-recognized `$range` source, or null
// when the source is anything else. The loop itself is written out at
// each use site rather than shared through a callback: an indirect call
// per iterated number would cost more than the duplication saves.
function rangeSource(expr) {
  if (!isRangeOp(expr))
    return null;
  return {
    fromGet: compileNode(expr.args[0]),
    fromPath: expr.args[0].docPath,
    toGet: compileNode(expr.args[1]),
    toPath: expr.args[1].docPath,
  };
}

// Whether a source sequence yields at least one tuple, accounting for
// the D4 unpacking step (an empty array item contributes nothing). This
// is what `$allowing-empty` asks about: "did this binding produce a
// tuple", not "was the sequence empty".
function yieldsTuple(v) {
  if (v === EMPTY)
    return false;
  if (v instanceof Seq) {
    const items = v.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!Array.isArray(item) || item.length !== 0)
        return true;
    }
    return false;
  }
  return !Array.isArray(v) || v.length !== 0;
}

// The item stream a $for would iterate, flattened once (D4), which is
// what a window partitions.
function unpackedItems(v) {
  const out = [];
  if (v === EMPTY)
    return out;
  if (v instanceof Seq) {
    const items = v.items;
    for (let i = 0; i < items.length; i++)
      appendItem(out, Array.isArray(items[i]) ? seqOf(items[i].slice()) : items[i]);
    return out;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++)
      out.push(v[i]);
    return out;
  }
  out.push(v);
  return out;
}

// A window binding (section 6.10): the source materializes once, then a
// window starts every `step` items. A tumbling window keeps its short
// final window (it partitions the stream); a sliding one emits only
// full-width windows.
function compileWindowClause(binding, next) {
  const get = compileNode(binding.expr);
  const slot = binding.slot;
  const atSlot = binding.atSlot;
  const { sliding, size, step } = binding.window;
  const allowingEmpty = binding.allowingEmpty;
  return (f, out) => {
    const items = unpackedItems(get(f));
    const n = items.length;
    let w = 0;
    for (let start = 0; start < n; start += step) {
      let end = start + size;
      if (end > n) {
        if (sliding)
          break;
        end = n;
      }
      f[slot] = seqOf(items.slice(start, end));
      if (atSlot >= 0)
        f[atSlot] = w;
      w++;
      next(f, out);
    }
    if (w === 0 && allowingEmpty) {
      f[slot] = EMPTY;
      if (atSlot >= 0)
        f[atSlot] = -1;
      next(f, out);
    }
  };
}

function compileForClause(binding, next) {
  if (binding.window !== null && binding.window !== undefined)
    return compileWindowClause(binding, next);
  const slot = binding.slot;
  const atSlot = binding.atSlot;
  // a range source counts instead of materializing; a range is never
  // empty-yielding in a way $allowing-empty could not also see, so the
  // two compose
  const range = binding.allowingEmpty ? null : rangeSource(binding.expr);
  if (range !== null) {
    const { fromGet, fromPath, toGet, toPath } = range;
    if (atSlot < 0) {
      return (f, out) => {
        const a = fromGet(f);
        const b = toGet(f);
        if (a === EMPTY || b === EMPTY)
          return;
        checkRangeBound(a, fromPath);
        checkRangeBound(b, toPath);
        for (let i = a; i <= b; i++) {
          f[slot] = i;
          next(f, out);
        }
      };
    }
    return (f, out) => {
      const a = fromGet(f);
      const b = toGet(f);
      if (a === EMPTY || b === EMPTY)
        return;
      checkRangeBound(a, fromPath);
      checkRangeBound(b, toPath);
      let pos = 0;
      for (let i = a; i <= b; i++) {
        f[slot] = i;
        f[atSlot] = pos++;
        next(f, out);
      }
    };
  }
  const get = compileNode(binding.expr);
  if (binding.allowingEmpty) {
    // outer-join iteration: when the binding would produce no tuple at
    // all, produce exactly one with the variable bound to the empty
    // sequence. The position of that tuple is -1: every real position is
    // a 0-based one (D6), so there is no non-negative "no position".
    if (atSlot < 0) {
      return (f, out) => {
        const v = get(f);
        if (!yieldsTuple(v)) {
          f[slot] = EMPTY;
          next(f, out);
          return;
        }
        if (v instanceof Seq) {
          const items = v.items;
          for (let i = 0; i < items.length; i++)
            emitForItem(items[i], f, slot, next, out);
          return;
        }
        emitForItem(v, f, slot, next, out);
      };
    }
    return (f, out) => {
      const v = get(f);
      if (!yieldsTuple(v)) {
        f[slot] = EMPTY;
        f[atSlot] = -1;
        next(f, out);
        return;
      }
      if (v instanceof Seq) {
        const items = v.items;
        let pos = 0;
        for (let i = 0; i < items.length; i++)
          pos = emitForItemAt(items[i], f, slot, atSlot, pos, next, out);
        return;
      }
      emitForItemAt(v, f, slot, atSlot, 0, next, out);
    };
  }
  if (atSlot < 0) {
    return (f, out) => {
      const v = get(f);
      if (v === EMPTY)
        return;
      if (v instanceof Seq) {
        const items = v.items;
        for (let i = 0; i < items.length; i++)
          emitForItem(items[i], f, slot, next, out);
        return;
      }
      emitForItem(v, f, slot, next, out);
    };
  }
  // positional counter per binding activation
  return (f, out) => {
    const v = get(f);
    if (v === EMPTY)
      return;
    if (v instanceof Seq) {
      const items = v.items;
      let pos = 0;
      for (let i = 0; i < items.length; i++)
        pos = emitForItemAt(items[i], f, slot, atSlot, pos, next, out);
      return;
    }
    emitForItemAt(v, f, slot, atSlot, 0, next, out);
  };
}

// One $as check (section 6.4): validate a phrase binding's frame slot per
// tuple against its compiled type-test predicate. A $for/$at variable is
// always exactly one item; a $let variable is validated per item of its
// bound sequence (the empty sequence passes vacuously). Failure is JQ2008,
// naming the variable.
function compileAsCheck(check, next) {
  const { name, slot, test, docPath } = check;
  if (!check.isLet) { // a $for/$at binding: one item per tuple
    return (f, out) => {
      const v = f[slot];
      if (!test(v))
        throw queryRuntimeError('JQ2008', 'query/as-failed', { name, got: itemRef(v) }, docPath);
      next(f, out);
    };
  }
  return (f, out) => {
    const v = f[slot];
    if (v !== EMPTY) {
      if (v instanceof Seq) {
        const items = v.items;
        for (let i = 0; i < items.length; i++) {
          if (!test(items[i]))
            throw queryRuntimeError('JQ2008', 'query/as-failed-item', { name, index: i, got: itemRef(items[i]) }, docPath);
        }
      }
      else if (!test(v)) {
        throw queryRuntimeError('JQ2008', 'query/as-failed', { name, got: itemRef(v) }, docPath);
      }
    }
    next(f, out);
  };
}

// $orderby tuple collector: evaluate the N key expressions once into a
// keys row, snapshot the live slots, push [keys..., snapshot]. A key
// value must be the empty sequence, one number, or one string (JQ2005).
function compileRowSink(specs, keyGets, keyPaths, liveSlots) {
  const keyCount = specs.length;
  const liveCount = liveSlots.length;
  return (f, rows) => {
    const row = new Array(keyCount + 1);
    for (let i = 0; i < keyCount; i++) {
      const v = keyGets[i](f);
      if (v !== EMPTY && typeof v !== 'number' && typeof v !== 'string')
        throw queryRuntimeError('JQ2005', 'query/orderby-key', { got: itemRef(v) }, keyPaths[i]);
      row[i] = v;
    }
    const snap = new Array(liveCount);
    for (let j = 0; j < liveCount; j++)
      snap[j] = f[liveSlots[j]];
    row[keyCount] = snap;
    rows.push(row);
  };
}

// Row comparator over the key specs (direction, $empty least/greatest,
// number/string type check per pair - JQ2005 on mismatch). Empty keys
// order as -Infinity under 'least' and +Infinity under 'greatest',
// before the direction applies (section 6.6). NaN keys order equal to
// themselves and less than every other number (the XQuery order-by
// rule). Ties fall through to the next key; JS sort is stable, so equal
// rows keep tuple order.
function compileRowComparator(specs, keyPaths) {
  const keyCount = specs.length;
  const descs = new Array(keyCount);
  const emptyGreatests = new Array(keyCount);
  const collations = new Array(keyCount);
  for (let i = 0; i < keyCount; i++) {
    descs[i] = specs[i].desc;
    emptyGreatests[i] = specs[i].emptyGreatest;
    collations[i] = specs[i].collation ?? null;
  }
  return (a, b) => {
    for (let i = 0; i < keyCount; i++) {
      const x = a[i];
      const y = b[i];
      if (x === y) // also EMPTY vs EMPTY, and -0 vs 0 (mathematically equal)
        continue;
      let c;
      if (x === EMPTY)
        c = emptyGreatests[i] ? 1 : -1;
      else if (y === EMPTY)
        c = emptyGreatests[i] ? -1 : 1;
      else if (typeof x === 'number') {
        if (typeof y !== 'number')
          throw queryRuntimeError('JQ2005', 'query/orderby-number-string', {}, keyPaths[i]);
        if (x < y)
          c = -1;
        else if (x > y)
          c = 1;
        else if (x !== x) // x is NaN: equal to NaN, less than all others
          c = y !== y ? 0 : -1;
        else // y is NaN (x === y was false, so they are not both non-NaN equal)
          c = 1;
      }
      else {
        if (typeof y !== 'string')
          throw queryRuntimeError('JQ2005', 'query/orderby-string-number', {}, keyPaths[i]);
        // a registered $collation orders the STRING keys; the default
        // stays the format's code-point order
        c = collations[i] !== null ? collations[i](x, y) : compareCodePoints(x, y);
      }
      if (c !== 0)
        return descs[i] ? -c : c;
    }
    return 0;
  };
}

function compileFlwor(node) {
  const seqLimit = node.limits?.sequenceItems ?? 0;
  const checkFold = seqLimit > 0 ? (value) => {
    const size = value instanceof Seq ? value.items.length : value === EMPTY ? 0 : 1;
    if (size > seqLimit)
      throw queryRuntimeError('JQ2009', 'query/fold-limit', { limit: seqLimit }, node.docPath);
    return value;
  } : null;
  // final sink: $return collects into the accumulator; the $count clause
  // numbers surviving tuples through its own frame slot (0-based, D6),
  // reset once per phrase evaluation by the drivers below
  const retGet = compileNode(node.ret);
  // $fold (section 6.9) replaces the collecting sink with an assigning
  // one: $return names the accumulator's next value instead of an item
  // of the result. It avoids collecting intermediate return values.
  const foldSlot = node.fold === null ? -1 : node.fold.slot;
  let sink;
  if (foldSlot >= 0) {
    sink = checkFold === null
      ? (f) => { f[foldSlot] = retGet(f); }
      : (f) => { f[foldSlot] = checkFold(retGet(f)); };
  }
  else if (node.ret.card === CARD_ONE)
    sink = (f, out) => out.push(retGet(f));
  else
    sink = (f, out) => appendItem(out, retGet(f));
  const countSlot = node.count === null ? -1 : node.count.slot;
  if (countSlot >= 0) {
    const inner = sink;
    sink = (f, out) => {
      inner(f, out);
      f[countSlot] += 1;
    };
  }

  // limits.sequenceItems bounds every phrase materialization: the guard
  // fires while the accumulator grows, deterministically, inside the
  // synchronous engine (never a wall-clock claim)
  // A fold does not collect returns; its accumulator can nevertheless
  // be a sequence. That value is checked by the fold driver below.
  if (seqLimit > 0 && foldSlot < 0) {
    const inner = sink;
    const limitPath = node.docPath;
    sink = (f, out) => {
      inner(f, out);
      if (out.length > seqLimit)
        throw queryRuntimeError('JQ2009', 'query/phrase-limit', { limit: seqLimit }, limitPath);
    };
  }

  const groupby = node.groupby;
  const orderby = node.orderby;

  // $orderby machinery (Schwartzian rows + compiled comparator)
  let rowSink = null;
  let comparator = null;
  let liveSlots = null;
  let keyCount = 0;
  if (orderby !== null) {
    const specs = orderby.specs;
    const keyGets = specs.map((s) => compileNode(s.key));
    const keyPaths = specs.map((s) => s.docPath);
    keyCount = specs.length;
    liveSlots = orderby.liveSlots;
    rowSink = compileRowSink(specs, keyGets, keyPaths, liveSlots);
    comparator = compileRowComparator(specs, keyPaths);
  }

  // $groupby machinery: Map<stableKeyString composite, group>; the Map
  // preserves first-appearance order. Key variables rebind as singletons,
  // every other live binding as the concatenation of its values across
  // the group's tuples (spec section 6.5).
  let groupSink = null;
  let writeGroup = null;
  if (groupby !== null) {
    const keys = groupby.keys;
    const groupCount = keys.length;
    const keyGets = keys.map((k) => compileNode(k.expr));
    const keyPaths = keys.map((k) => k.docPath);
    const keySlots = keys.map((k) => k.slot);
    const accSlots = groupby.accSlots;
    const accCount = accSlots.length;
    groupSink = (f, map) => {
      const keyValues = new Array(groupCount);
      let composite = '';
      for (let i = 0; i < groupCount; i++) {
        const v = keyGets[i](f);
        if (v instanceof Seq)
          throw queryRuntimeError('JQ2001', 'query/groupby-key', { got: itemRef(v) }, keyPaths[i]);
        keyValues[i] = v;
        // '\u0000' never occurs in stableKeyString output, '~' never
        // starts one: the composite cannot collide across keys
        composite += v === EMPTY ? '\u0000~' : '\u0000' + stableKeyString(v);
      }
      let group = map.get(composite);
      if (group === undefined) {
        const accs = new Array(accCount);
        for (let j = 0; j < accCount; j++)
          accs[j] = [];
        group = { keyValues, accs };
        map.set(composite, group);
      }
      const accs = group.accs;
      for (let j = 0; j < accCount; j++)
        appendItem(accs[j], f[accSlots[j]]);
    };
    writeGroup = (f, group) => {
      const keyValues = group.keyValues;
      for (let i = 0; i < groupCount; i++)
        f[keySlots[i]] = keyValues[i];
      const accs = group.accs;
      for (let j = 0; j < accCount; j++)
        f[accSlots[j]] = seqOf(accs[j]);
    };
  }

  // the streaming prefix $for -> $let -> $as -> $where, feeding the first
  // barrier's collector (or the final sink when there is none)
  let emit = groupby !== null ? groupSink : (orderby !== null ? rowSink : sink);
  // an equijoin the planner can serve from a hash table is answered by
  // the probe clause below, so its conjunct never reaches $where
  const join = planHashJoin(node);
  // a spatial or an interval predicate is screened by an index instead:
  // the probe keeps $where intact and runs it on every candidate, so no
  // where-stage is installed at all - the probe evaluates the predicate
  // itself, on the candidates
  const screened = join === null ? planScreenedJoin(node) : null;
  if (screened === null && join !== null && join.residual !== null) {
    const conds = join.residual.map(compileNode);
    const paths = join.residual.map((a) => a.docPath);
    const clen = conds.length;
    const next = emit;
    emit = (f, out) => {
      for (let i = 0; i < clen; i++) {
        if (!ebv(conds[i](f), paths[i]))
          return;
      }
      next(f, out);
    };
  }
  else if (screened === null && join === null && node.where !== null) {
    const cond = compileNode(node.where);
    const condPath = node.where.docPath;
    const next = emit;
    emit = (f, out) => {
      if (ebv(cond(f), condPath))
        next(f, out);
    };
  }
  if (node.asChecks !== null) {
    for (let i = node.asChecks.length - 1; i >= 0; i--)
      emit = compileAsCheck(node.asChecks[i], emit);
  }
  const lets = node.letBindings;
  for (let i = lets.length - 1; i >= 0; i--) {
    const slot = lets[i].slot;
    const get = compileNode(lets[i].expr);
    const next = emit;
    emit = (f, out) => {
      f[slot] = get(f);
      next(f, out);
    };
  }
  const fors = node.forBindings;
  let driveJoin = null;
  for (let i = fors.length - 1; i >= 0; i--) {
    if (i === fors.length - 1 && (join !== null || screened !== null)) {
      const probe = join !== null
        ? compileJoinProbe(join, emit)
        : compileScreenedProbe(screened, emit, node.where, node.where.docPath);
      driveJoin = probe.drive;
      emit = probe.probe;
      continue;
    }
    emit = compileForClause(fors[i], emit);
  }
  // a probe's driver wraps the outer loops, and the probe builds its
  // table or index at the first outer tuple that reaches it
  const head = driveJoin === null
    ? emit
    : ((chain) => (f, out) => driveJoin(f, out, chain))(emit);

  // drivers, one per barrier combination. A $fold wraps whichever driver
  // this builds rather than adding a fifth pair: the tuple stream, both
  // barriers and $count all behave identically, only the phrase's value
  // is read from the accumulator instead of the collector.
  const drive = buildDriver();
  if (foldSlot < 0)
    return drive;
  const initGet = compileNode(node.fold.expr);
  return (f) => {
    f[foldSlot] = checkFold === null ? initGet(f) : checkFold(initGet(f));
    drive(f);
    return f[foldSlot];
  };

  function buildDriver() {
    if (groupby === null && orderby === null) {
      if (countSlot < 0) {
        return (f) => {
          const out = [];
          head(f, out);
          return seqOf(out);
        };
      }
      return (f) => {
        const out = [];
        f[countSlot] = 0;
        head(f, out);
        return seqOf(out);
      };
    }
    if (groupby === null) { // $orderby only
      return (f) => {
        const rows = [];
        head(f, rows);
        rows.sort(comparator); // stable
        const out = [];
        if (countSlot >= 0)
          f[countSlot] = 0;
        const liveCount = liveSlots.length;
        for (let i = 0; i < rows.length; i++) {
          const snap = rows[i][keyCount];
          for (let j = 0; j < liveCount; j++)
            f[liveSlots[j]] = snap[j];
          sink(f, out);
        }
        return seqOf(out);
      };
    }
    if (orderby === null) { // $groupby only
      return (f) => {
        const map = new Map();
        head(f, map);
        const out = [];
        if (countSlot >= 0)
          f[countSlot] = 0;
        for (const group of map.values()) { // first-appearance order
          writeGroup(f, group);
          sink(f, out);
        }
        return seqOf(out);
      };
    }
    // $groupby then $orderby: sort the per-group tuples
    return (f) => {
      const map = new Map();
      head(f, map);
      const rows = [];
      for (const group of map.values()) {
        writeGroup(f, group);
        rowSink(f, rows);
      }
      rows.sort(comparator);
      const out = [];
      if (countSlot >= 0)
        f[countSlot] = 0;
      const liveCount = liveSlots.length;
      for (let i = 0; i < rows.length; i++) {
        const snap = rows[i][keyCount];
        for (let j = 0; j < liveCount; j++)
          f[liveSlots[j]] = snap[j];
        sink(f, out);
      }
      return seqOf(out);
    };
  }
}

//#endregion

//#region quantifiers

// $some/$every + $satisfies (section 7): a $for-style loop nest with
// early exit - $some stops at the first EBV-true tuple, $every at the
// first EBV-false one. D4 unpacking applies; nothing materializes.
function quantVisitSome(item, f, slot, next) {
  if (Array.isArray(item)) { // D4
    for (let j = 0; j < item.length; j++) {
      f[slot] = item[j];
      if (next(f))
        return true;
    }
    return false;
  }
  f[slot] = item;
  return next(f);
}

function quantVisitEvery(item, f, slot, next) {
  if (Array.isArray(item)) { // D4
    for (let j = 0; j < item.length; j++) {
      f[slot] = item[j];
      if (!next(f))
        return false;
    }
    return true;
  }
  f[slot] = item;
  return next(f);
}

function compileQuantLevel(binding, next, some) {
  const slot = binding.slot;
  // a quantified range counts too, and stops at its witness: `$some` over
  // a billion numbers should cost the numbers it actually examines
  const range = rangeSource(binding.expr);
  if (range !== null) {
    const { fromGet, fromPath, toGet, toPath } = range;
    return (f) => {
      const a = fromGet(f);
      const b = toGet(f);
      if (a === EMPTY || b === EMPTY)
        return !some; // empty source: no witness / vacuously true
      checkRangeBound(a, fromPath);
      checkRangeBound(b, toPath);
      for (let i = a; i <= b; i++) {
        f[slot] = i;
        if (next(f) === some)
          return some;
      }
      return !some;
    };
  }
  const get = compileNode(binding.expr);
  if (some) {
    return (f) => {
      const v = get(f);
      if (v === EMPTY) // empty source: no witnessing tuple
        return false;
      if (v instanceof Seq) {
        const items = v.items;
        for (let i = 0; i < items.length; i++) {
          if (quantVisitSome(items[i], f, slot, next))
            return true;
        }
        return false;
      }
      return quantVisitSome(v, f, slot, next);
    };
  }
  return (f) => {
    const v = get(f);
    if (v === EMPTY) // empty source: vacuously true
      return true;
    if (v instanceof Seq) {
      const items = v.items;
      for (let i = 0; i < items.length; i++) {
        if (!quantVisitEvery(items[i], f, slot, next))
          return false;
      }
      return true;
    }
    return quantVisitEvery(v, f, slot, next);
  };
}

function compileQuant(node) {
  const sat = compileNode(node.satisfies);
  const satPath = node.satisfies.docPath;
  const some = node.some;
  let test = (f) => ebv(sat(f), satPath);
  for (let i = node.bindings.length - 1; i >= 0; i--)
    test = compileQuantLevel(node.bindings[i], test, some);
  return test;
}

//#endregion

// Step instrumentation (`limits.steps`). Null unless the compilation in
// flight set a step limit, so an ordinary compile emits exactly the
// closures it always did and pays nothing. Compilation is synchronous,
// and compileQueryRoot saves/restores around the whole tree, so a nested
// compile - a `compileTypeTest` hook that compiles another query - keeps
// its own setting.
let STEPS = null;

/**
 * A getter for a join probe's own read of an operand, compiled without
 * the step check: the scan counts the same read inside the predicate,
 * pair by pair, so leaving the probe's read uncounted keeps its count
 * from ever running ahead of the scan's.
 * @param {object} node - a path or variable reference
 * @returns {(frame: any[]) => any}
 */
function compileUncounted(node) {
  const steps = STEPS;
  STEPS = null;
  try {
    return compileNode(node);
  }
  finally {
    STEPS = steps;
  }
}

/**
 * Compile a query's AST root, optionally instrumenting every node
 * evaluation against a step limit.
 * @param {object} root - the AST root from normalizeQuery
 * @param {{ slot: number, limit: number } | null} steps - the step
 *   counter's frame slot and its limit, or null for no instrumentation
 * @returns {(frame: any[]) => any} the root getter
 */
export function compileQueryRoot(root, steps) {
  const prev = STEPS;
  STEPS = steps;
  try {
    return compileNode(root);
  }
  finally {
    STEPS = prev;
  }
}

/**
 * Compile a normalized AST node into its getter closure.
 * @param {object} node - a frozen AST node from normalize.js
 * @returns {(frame: any[]) => any} getter returning an item, EMPTY, or a Seq
 */
export function compileNode(node) {
  const get = compileNodeKind(node);
  if (STEPS === null)
    return get;
  // one step = one expression-node evaluation (section 8.12)
  const slot = STEPS.slot;
  const limit = STEPS.limit;
  const docPath = node.docPath;
  return (f) => {
    if (++f[slot] > limit)
      throw queryRuntimeError('JQ2009', 'query/steps-limit', { limit }, docPath);
    return get(f);
  };
}

function compileNodeKind(node) {
  switch (node.kind) {
    case 'literal': {
      const value = node.value;
      return () => value;
    }
    case 'var':
      return compileVar(node);
    case 'path':
      return compilePath(node);
    case 'object':
      return compileObject(node);
    case 'map':
      return compileMap(node);
    case 'array':
      return compileArray(node);
    case 'op':
      return compileOp(node);
    case 'call':
      return compileCall(node);
    case 'let':
      return compileLet(node);
    case 'quant':
      return compileQuant(node);
    default: // 'flwor'
      return compileFlwor(node);
  }
}

//#endregion
