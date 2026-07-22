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
import {
  NOTHING,
  compileSingularGetter,
  compileSegmentV,
  runSegmentsV,
} from '../segments.js';
import { JsonQueryRuntimeError } from './errors.js';
import { EMPTY, Seq, seqOf, appendItem, ebv, stableKeyString, describeItem } from './runtime.js';
import { CARD_ONE } from './normalize.js';
// The operator registry: every section-8 operator compiles through its
// table entry (compileOp). Only referenced inside functions, so the
// import cycle compile.js <-> operators.js is initialization-safe.
import { OPERATORS } from './operators.js';

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
      throw new JsonQueryRuntimeError('JQ2006', `external parameter '${name}' was not bound`, docPath);
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
  const segs = node.segments.map(compileSegmentV);
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
    const segs = node.segments.map(compileSegmentV);
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
    throw new JsonQueryRuntimeError('JQ2001',
      `member '${name}' evaluated to ${v.items.length} items; an object member takes exactly one`, docPath);
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
    if (expr.card === CARD_ONE) {
      appliers[i] = (f, out) => {
        out[name] = get(f);
      };
    }
    else {
      const docPath = expr.docPath;
      appliers[i] = (f, out) => {
        const v = get(f);
        if (v !== EMPTY)
          out[name] = memberValue(v, name, docPath);
      };
    }
  }
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
        throw new JsonQueryRuntimeError('JQ2004',
          `a $map key must evaluate to a single string, got ${describeItem(k)}`, keyPath);
      if (valOne) {
        out[k] = valGet(f);
        return;
      }
      const v = valGet(f);
      if (v !== EMPTY)
        out[k] = memberValue(v, k, valPath);
    };
  }
  const alen = appliers.length;
  return (f) => {
    const out = {};
    for (let i = 0; i < alen; i++)
      appliers[i](f, out); // later pairs win on duplicate keys
    return out;
  };
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
      throw new JsonQueryRuntimeError('JQ2010',
        `registered function '${name}' threw: ${/** @type {Error} */ (err).message}`, docPath);
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
//#region roadmap: FLWOR optimizer
// The compiled form is the straightforward nested-loop pipeline: a join
// ($for x $for + $where equality) runs O(n*m). Hash joins (build a table
// on one side of an equijoin), filter hoisting into the deepest binding
// that covers the predicate's variables, and orderby/groupby fusion are
// future optimizer work orders.
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

function compileForClause(binding, next) {
  const get = compileNode(binding.expr);
  const slot = binding.slot;
  const atSlot = binding.atSlot;
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
        throw new JsonQueryRuntimeError('JQ2008',
          `variable '${name}' failed its '$as' schema: ${describeItem(v)} does not satisfy it`, docPath);
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
            throw new JsonQueryRuntimeError('JQ2008',
              `variable '${name}' failed its '$as' schema: item ${i} (${describeItem(items[i])}) does not satisfy it`, docPath);
        }
      }
      else if (!test(v)) {
        throw new JsonQueryRuntimeError('JQ2008',
          `variable '${name}' failed its '$as' schema: ${describeItem(v)} does not satisfy it`, docPath);
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
        throw new JsonQueryRuntimeError('JQ2005',
          `an $orderby key must be the empty sequence, a number, or a string, got ${describeItem(v)}`, keyPaths[i]);
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
          throw new JsonQueryRuntimeError('JQ2005',
            'cannot order a number against a string in $orderby', keyPaths[i]);
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
          throw new JsonQueryRuntimeError('JQ2005',
            'cannot order a string against a number in $orderby', keyPaths[i]);
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
  // final sink: $return collects into the accumulator; the $count clause
  // numbers surviving tuples through its own frame slot (0-based, D6),
  // reset once per phrase evaluation by the drivers below
  const retGet = compileNode(node.ret);
  let sink;
  if (node.ret.card === CARD_ONE)
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
  const seqLimit = node.limits !== null && node.limits !== undefined
    && node.limits.sequenceItems !== null
    ? node.limits.sequenceItems
    : 0;
  if (seqLimit > 0) {
    const inner = sink;
    const limitPath = node.docPath;
    sink = (f, out) => {
      inner(f, out);
      if (out.length > seqLimit)
        throw new JsonQueryRuntimeError('JQ2009',
          `a phrase materialized more than ${seqLimit} items (limits.sequenceItems)`, limitPath);
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
          throw new JsonQueryRuntimeError('JQ2001',
            `a $groupby key must be the empty sequence or a single item, got ${describeItem(v)}`, keyPaths[i]);
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
  if (node.where !== null) {
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
  for (let i = fors.length - 1; i >= 0; i--)
    emit = compileForClause(fors[i], emit);
  const head = emit;

  // drivers, one per barrier combination
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
  const get = compileNode(binding.expr);
  const slot = binding.slot;
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

/**
 * Compile a normalized AST node into its getter closure.
 * @param {object} node - a frozen AST node from normalize.js
 * @returns {(frame: any[]) => any} getter returning an item, EMPTY, or a Seq
 */
export function compileNode(node) {
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
