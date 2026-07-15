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

import { equalsJson } from '@jarenjs/core/object';
import { compareCodePoints } from '@jarenjs/core/string';
import {
  NOTHING,
  compileSingularGetter,
  compileSegmentV,
  runSegmentsV,
} from '../segments.js';
import { JsonQueryRuntimeError } from './errors.js';
import { EMPTY, Seq, seqOf, appendItem, ebv } from './runtime.js';
import { CARD_ONE } from './normalize.js';

/**
 * Sentinel stored in the frame slot of an external parameter the caller
 * did not bind; evaluating a reference to it raises JQ2006.
 */
export const UNBOUND = Symbol('JsonQuery.Unbound');

function describeItem(v) {
  if (v instanceof Seq)
    return `a sequence of ${v.items.length} items`;
  if (v === EMPTY)
    return 'the empty sequence';
  if (v === null)
    return 'null';
  if (Array.isArray(v))
    return 'an array';
  const t = typeof v;
  return t === 'object' ? 'an object' : `a ${t}`;
}

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

// existence-only variant for $exists/$empty: paths never materialize a
// result sequence (the analogue of path.js's compileExists)
function compileExistsTest(node) {
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

function compileSeq(node) {
  if (node.elements.length === 0)
    return () => EMPTY;
  if (node.elements.length === 1) // {"$seq": [e]} is e
    return compileNode(node.elements[0]);
  const appliers = compileElementAppliers(node.elements);
  const alen = appliers.length;
  return (f) => {
    const acc = [];
    for (let i = 0; i < alen; i++)
      appliers[i](f, acc);
    return seqOf(acc);
  };
}

//#endregion

//#region comparisons

// item comparison rules (section 8.4): $eq/$ne deep structural JSON
// equality (D2); ordering only between two numbers or two strings, any
// other pair is simply false (no witness, no error)
function itemEq(a, b) {
  return equalsJson(a, b);
}
function itemNe(a, b) {
  return !equalsJson(a, b);
}
function itemLt(a, b) {
  if (typeof a === 'number')
    return typeof b === 'number' && a < b;
  if (typeof a === 'string')
    return typeof b === 'string' && compareCodePoints(a, b) < 0;
  return false;
}
function itemLe(a, b) {
  if (typeof a === 'number')
    return typeof b === 'number' && a <= b;
  if (typeof a === 'string')
    return typeof b === 'string' && compareCodePoints(a, b) <= 0;
  return false;
}
function itemGt(a, b) {
  return itemLt(b, a);
}
function itemGe(a, b) {
  return itemLe(b, a);
}

const ITEM_COMPARATORS = {
  eq: itemEq, ne: itemNe, lt: itemLt, le: itemLe, gt: itemGt, ge: itemGe,
};

function compileCmp(node) {
  const itemCmp = ITEM_COMPARATORS[node.op];
  const left = compileNode(node.left);
  const right = compileNode(node.right);
  if (node.left.card === CARD_ONE && node.right.card === CARD_ONE)
    // the common case: two singletons, one direct item comparison
    return (f) => itemCmp(left(f), right(f));
  // existential general comparison: true iff some pair of items compares
  // true; either side empty means no witnessing pair (contrast the path
  // filter dialect where Nothing == Nothing holds - section 5.2)
  return (f) => {
    const lv = left(f);
    if (lv === EMPTY)
      return false;
    const rv = right(f);
    if (rv === EMPTY)
      return false;
    if (lv instanceof Seq) {
      const li = lv.items;
      if (rv instanceof Seq) {
        const ri = rv.items;
        for (let i = 0; i < li.length; i++) {
          for (let j = 0; j < ri.length; j++) {
            if (itemCmp(li[i], ri[j]))
              return true;
          }
        }
        return false;
      }
      for (let i = 0; i < li.length; i++) {
        if (itemCmp(li[i], rv))
          return true;
      }
      return false;
    }
    if (rv instanceof Seq) {
      const ri = rv.items;
      for (let j = 0; j < ri.length; j++) {
        if (itemCmp(lv, ri[j]))
          return true;
      }
      return false;
    }
    return itemCmp(lv, rv);
  };
}

//#endregion

//#region arithmetic

function arithOperandError(v, docPath) {
  return new JsonQueryRuntimeError('JQ2001',
    `arithmetic requires a number operand, got ${describeItem(v)}`, docPath);
}

function compileArith(node) {
  const left = compileNode(node.left);
  const right = compileNode(node.right);
  const docPath = node.docPath + '/$' + node.op;
  let apply;
  switch (node.op) {
    case 'add':
      apply = (a, b) => a + b;
      break;
    case 'sub':
      apply = (a, b) => a - b;
      break;
    case 'mul':
      apply = (a, b) => a * b;
      break;
    case 'div': // IEEE 754 double division: /0 is ±Infinity or NaN (D1)
      apply = (a, b) => a / b;
      break;
    case 'idiv': // truncating division; zero divisor errors (section 8.5)
      apply = (a, b) => {
        if (b === 0)
          throw new JsonQueryRuntimeError('JQ2002', "'$idiv' by zero", docPath);
        return Math.trunc(a / b);
      };
      break;
    default: // 'mod': XQuery double mod takes the sign of the dividend = JS %
      apply = (a, b) => {
        if (b === 0)
          throw new JsonQueryRuntimeError('JQ2002', "'$mod' by zero", docPath);
        return a % b;
      };
      break;
  }
  const leftPath = node.left.docPath;
  const rightPath = node.right.docPath;
  if (node.left.card === CARD_ONE && node.right.card === CARD_ONE) {
    // singleton operands: type guard only, no sequence checks
    return (f) => {
      const a = left(f);
      if (typeof a !== 'number')
        throw arithOperandError(a, leftPath);
      const b = right(f);
      if (typeof b !== 'number')
        throw arithOperandError(b, rightPath);
      return apply(a, b);
    };
  }
  return (f) => {
    const a = left(f);
    if (a === EMPTY) // empty propagation (XQuery)
      return EMPTY;
    if (typeof a !== 'number')
      throw arithOperandError(a, leftPath);
    const b = right(f);
    if (b === EMPTY)
      return EMPTY;
    if (typeof b !== 'number')
      throw arithOperandError(b, rightPath);
    return apply(a, b);
  };
}

function compileNeg(node) {
  const get = compileNode(node.operand);
  const docPath = node.operand.docPath;
  if (node.operand.card === CARD_ONE) {
    return (f) => {
      const a = get(f);
      if (typeof a !== 'number')
        throw arithOperandError(a, docPath);
      return -a;
    };
  }
  return (f) => {
    const a = get(f);
    if (a === EMPTY)
      return EMPTY;
    if (typeof a !== 'number')
      throw arithOperandError(a, docPath);
    return -a;
  };
}

//#endregion

//#region logic & control

function compileAnd(node) {
  const operands = node.operands;
  const fns = operands.map(compileNode);
  const paths = operands.map((o) => o.docPath);
  const flen = fns.length;
  return (f) => {
    for (let i = 0; i < flen; i++) {
      if (!ebv(fns[i](f), paths[i]))
        return false; // short-circuit: later operands are not evaluated
    }
    return true;
  };
}

function compileOr(node) {
  const operands = node.operands;
  const fns = operands.map(compileNode);
  const paths = operands.map((o) => o.docPath);
  const flen = fns.length;
  return (f) => {
    for (let i = 0; i < flen; i++) {
      if (ebv(fns[i](f), paths[i]))
        return true; // short-circuit
    }
    return false;
  };
}

function compileNot(node) {
  const get = compileNode(node.operand);
  const docPath = node.operand.docPath;
  return (f) => !ebv(get(f), docPath);
}

function compileIf(node) {
  const cond = compileNode(node.cond);
  const condPath = node.cond.docPath;
  const then = compileNode(node.then);
  if (node.alt === null) // missing else means the empty sequence
    return (f) => (ebv(cond(f), condPath) ? then(f) : EMPTY);
  const alt = compileNode(node.alt);
  return (f) => (ebv(cond(f), condPath) ? then(f) : alt(f));
}

function compileExistsOp(node) {
  const test = compileExistsTest(node.operand);
  if (node.negated) // $empty
    return (f) => !test(f);
  return test;
}

//#endregion

//#region strings

// cast one $concat operand item per the (provisional) $string rules:
// an empty operand contributes '', a singleton casts, anything that
// cannot cast (array, object, multi-item sequence) is JQ2001
function concatItem(v, docPath) {
  switch (typeof v) {
    case 'string':
      return v;
    case 'number':
      return String(v);
    case 'boolean':
      return v ? 'true' : 'false';
    default:
      if (v === EMPTY)
        return '';
      if (v === null)
        return 'null';
      throw new JsonQueryRuntimeError('JQ2001',
        `cannot cast ${describeItem(v)} to a string`, docPath);
  }
}

function compileConcat(node) {
  const operands = node.operands;
  if (operands.length === 0)
    return () => '';
  const fns = operands.map(compileNode);
  const paths = operands.map((o) => o.docPath);
  const flen = fns.length;
  return (f) => {
    let s = '';
    for (let i = 0; i < flen; i++)
      s += concatItem(fns[i](f), paths[i]);
    return s;
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
    case 'seq':
      return compileSeq(node);
    case 'cmp':
      return compileCmp(node);
    case 'arith':
      return compileArith(node);
    case 'neg':
      return compileNeg(node);
    case 'and':
      return compileAnd(node);
    case 'or':
      return compileOr(node);
    case 'not':
      return compileNot(node);
    case 'if':
      return compileIf(node);
    case 'exists':
      return compileExistsOp(node);
    case 'concat':
      return compileConcat(node);
    default: // 'let'
      return compileLet(node);
  }
}

//#endregion
