//#region JSONPath segment engine (package-internal)
// Runtime segment machinery shared by the JSONPath compiler (path.js) and
// the query engine (query/). Extracted verbatim from path.js, in two
// installments: values mode first, then the nodes-mode (normalized paths,
// RFC 9535 section 2.7) compilers - so consumers beyond path.js (the JSLT
// dispatcher's positional matching) can run selectors producing
// (value, normalized-path) pairs. This module is package-internal and is
// deliberately not listed in the package exports.

import { equalsJson, compareJsonScalarLt } from '@jarenjs/core/object';
import { countCodePoints } from '@jarenjs/core/string';
import { compileIRegexp } from '@jarenjs/core/text/iregexp';
import {
  CC_TAB,
  CC_LF,
  CC_CR,
  CC_SPACE,
  CC_SQUOTE,
  CC_BACKSLASH,
  CC_0,
  isDigitCode,
} from '@jarenjs/core/scan';

/**
 * Sentinel for the absence of a value ("Nothing" in RFC 9535 terms), as
 * distinct from the JSON value `null`. Re-exported from path.js as
 * `JSONPATH_NOTHING`.
 */
export const NOTHING = Symbol('JSONPath.Nothing');

const hasOwn = Object.hasOwn;

// Array indexes are bounded by the maximum array length (2^32 - 1), so a
// valid index has at most 10 digits and is strictly below 2^32 - 1.
const MAX_ARRAY_INDEX = 4294967294;

/**
 * Scan `source[start..end)` as an RFC 6901 array index: `0`, or a digit
 * sequence without leading zeros. Returns -1 when the range is not a
 * valid index (`-` is never a valid read index). Shared by the JSON
 * Pointer compiler (pointer.js) and the JSON Patch engine (patch.js).
 */
export function scanArrayIndex(source, start, end) {
  const digits = end - start;
  if (digits === 0 || digits > 10)
    return -1;
  const first = source.charCodeAt(start);
  if (!isDigitCode(first))
    return -1;
  if (first === CC_0)
    return digits === 1 ? 0 : -1;
  let index = first - CC_0;
  for (let i = start + 1; i < end; i++) {
    const c = source.charCodeAt(i);
    if (!isDigitCode(c))
      return -1;
    index = index * 10 + (c - CC_0);
  }
  return index <= MAX_ARRAY_INDEX ? index : -1;
}

/**
 * Returns true when every segment is a child segment with exactly one
 * name or index selector (a "singular query", RFC 9535 section 2.3.5.1).
 * @param {object[]} segments - Parsed query segments
 * @returns {boolean}
 */
export function isSingularSegments(segments) {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.descendant || seg.selectors.length !== 1)
      return false;
    const kind = seg.selectors[0].kind;
    if (kind !== 'name' && kind !== 'index')
      return false;
  }
  return true;
}

//#region filter compilation

// structural equality per RFC 9535 section 2.3.5.2.2 (equalsJson),
// lifted over the JSONPath-specific NOTHING sentinel
function cmpEquals(a, b) {
  if (a === NOTHING || b === NOTHING)
    return a === b;
  return equalsJson(a, b);
}

function countOwnKeys(obj) {
  let count = 0;
  for (const key in obj) {
    if (hasOwn(obj, key))
      count++;
  }
  return count;
}

/**
 * Compile a singular query into a direct property walk.
 * @returns {(current: any, root: any) => any} getter returning the value or NOTHING
 */
export function compileSingularGetter(segments, relative) {
  // steps: strings are member names, numbers are array indexes
  const steps = new Array(segments.length);
  for (let i = 0; i < segments.length; i++) {
    const sel = segments[i].selectors[0];
    steps[i] = sel.kind === 'name' ? sel.name : sel.index;
  }
  const slen = steps.length;
  return function singularGetter(current, root) {
    let v = relative ? current : root;
    for (let i = 0; i < slen; i++) {
      const step = steps[i];
      if (typeof step === 'string') {
        if (typeof v !== 'object' || v === null || Array.isArray(v) || !hasOwn(v, step))
          return NOTHING;
        v = v[step];
      }
      else {
        if (!Array.isArray(v))
          return NOTHING;
        const idx = step < 0 ? v.length + step : step;
        if (idx < 0 || idx >= v.length)
          return NOTHING;
        v = v[idx];
      }
    }
    return v;
  };
}

/**
 * Run a chain of compiled value-mode segment functions over a start value.
 * @returns {any[]} the resulting nodelist as an array of values
 */
export function runSegmentsV(segs, start, root) {
  let vals = [start];
  const slen = segs.length;
  for (let i = 0; i < slen; i++) {
    if (vals.length === 0)
      return vals;
    const out = [];
    segs[i](vals, out, root);
    vals = out;
  }
  return vals;
}

/**
 * Compile an existence test for a filter query; singular queries never
 * materialize nodelists.
 *
 * The non-singular case builds its nodelist rather than pulling the
 * lazy chain (compileSegmentG), even though it only needs one node: a
 * filter runs this per candidate node, where nodelists are a handful of
 * items and generator setup costs more than the pushes it saves - it
 * benched ~9x slower on `$.items[?@.tags[*]]` over 2000 items. Laziness
 * pays at the top of a query, not inside a filter.
 * @returns {(current: any, root: any) => boolean}
 */
export function compileExists(query) {
  if (isSingularSegments(query.segments)) {
    const getter = compileSingularGetter(query.segments, query.relative);
    return (current, root) => getter(current, root) !== NOTHING;
  }
  const segs = query.segments.map(compileSegmentV);
  const relative = query.relative;
  return (current, root) => runSegmentsV(segs, relative ? current : root, root).length > 0;
}

// getter producing a ValueType result (a JSON value or NOTHING)
function compileComparable(node) {
  if (node.kind === 'literal') {
    const value = node.value;
    return () => value;
  }
  if (node.kind === 'query')
    return compileSingularGetter(node.query.segments, node.query.relative);
  return compileValueFunction(node);
}

// getter producing a NodesType result (an array of the selected values).
// The argument is a filter query or a nodes-returning extension.
function compileNodesGetter(arg) {
  if (arg.kind !== 'query')
    return compileUserFunction(arg);
  const query = arg.query;
  const segs = query.segments.map(compileSegmentV);
  const relative = query.relative;
  return (current, root) => runSegmentsV(segs, relative ? current : root, root);
}

function compileValueFunction(func) {
  switch (func.name) {
    case 'length': {
      const getter = compileComparable(func.args[0]);
      return (current, root) => {
        const v = getter(current, root);
        if (typeof v === 'string')
          return countCodePoints(v);
        if (Array.isArray(v))
          return v.length;
        if (typeof v === 'object' && v !== null)
          return countOwnKeys(v);
        return NOTHING;
      };
    }
    case 'count': {
      const arg = func.args[0];
      if (arg.kind === 'query' && isSingularSegments(arg.query.segments)) {
        const getter = compileSingularGetter(arg.query.segments, arg.query.relative);
        return (current, root) => (getter(current, root) === NOTHING ? 0 : 1);
      }
      const get = compileNodesGetter(arg);
      return (current, root) => get(current, root).length;
    }
    case 'value': {
      const arg = func.args[0];
      if (arg.kind === 'query' && isSingularSegments(arg.query.segments))
        return compileSingularGetter(arg.query.segments, arg.query.relative);
      // eager for the same reason as compileExists: this runs per
      // candidate node inside a filter
      const get = compileNodesGetter(arg);
      return (current, root) => {
        const result = get(current, root);
        return result.length === 1 ? result[0] : NOTHING;
      };
    }
    default:
      return compileUserFunction(func);
  }
}

// Compile a registered function extension (RFC 9535 section 2.4).
// Arguments are marshalled to their declared types - ValueType is a
// JSON value or NOTHING, NodesType an array of values, LogicalType a
// boolean - and the result is checked against the declared return type,
// because a registry entry that lies about its type would otherwise
// corrupt the comparison rules further up.
function compileUserFunction(func) {
  /* c8 ignore next 2 -- guarded by the parser's well-typedness checks */
  if (typeof func.evaluate !== 'function')
    throw new Error(`JSONPath: function '${func.name}' has no implementation`);
  const evaluate = func.evaluate;
  const name = func.name;
  const params = func.params;
  const gets = new Array(func.args.length);
  for (let i = 0; i < gets.length; i++) {
    const arg = func.args[i];
    gets[i] = params[i] === 'value'
      ? compileComparable(arg)
      : params[i] === 'nodes'
        ? compileNodesGetter(arg)
        : compileLogicalExpr(arg.expr);
  }

  let call;
  switch (gets.length) {
    case 0:
      call = () => evaluate();
      break;
    case 1: {
      const a = gets[0];
      call = (c, r) => evaluate(a(c, r));
      break;
    }
    case 2: {
      const a = gets[0];
      const b = gets[1];
      call = (c, r) => evaluate(a(c, r), b(c, r));
      break;
    }
    default:
      call = (c, r) => {
        const argv = new Array(gets.length);
        for (let i = 0; i < gets.length; i++)
          argv[i] = gets[i](c, r);
        return evaluate(...argv);
      };
  }

  if (func.returns === 'logical')
    return (c, r) => call(c, r) === true;
  if (func.returns === 'value') {
    // a function may legitimately return Nothing; `undefined` is not a
    // JSON value, so it is the natural spelling of it
    return (c, r) => {
      const v = call(c, r);
      return v === undefined ? NOTHING : v;
    };
  }
  return (c, r) => {
    const v = call(c, r);
    if (!Array.isArray(v))
      throw new TypeError(`JSONPath: function '${name}' must return an array of nodes (NodesType)`);
    return v;
  };
}

function compileRegexTest(func, fullMatch) {
  const inputGet = compileComparable(func.args[0]);
  const patternArg = func.args[1];
  if (patternArg.kind === 'literal') {
    if (typeof patternArg.value !== 'string')
      return () => false;
    const re = compileIRegexp(patternArg.value, fullMatch);
    if (re === null)
      return () => false;
    return (current, root) => {
      const s = inputGet(current, root);
      return typeof s === 'string' && re.test(s);
    };
  }
  const patternGet = compileComparable(patternArg);
  // monomorphic per-callsite cache: filters usually see one pattern
  let lastPattern = null;
  let lastRegExp = null;
  return (current, root) => {
    const s = inputGet(current, root);
    if (typeof s !== 'string')
      return false;
    const p = patternGet(current, root);
    if (typeof p !== 'string')
      return false;
    if (p !== lastPattern) {
      lastPattern = p;
      lastRegExp = compileIRegexp(p, fullMatch);
    }
    return lastRegExp !== null && lastRegExp.test(s);
  };
}

function compileComparison(expr) {
  const left = compileComparable(expr.left);
  const right = compileComparable(expr.right);
  switch (expr.op) {
    case '==':
      return (c, r) => cmpEquals(left(c, r), right(c, r));
    case '!=':
      return (c, r) => !cmpEquals(left(c, r), right(c, r));
    case '<':
      return (c, r) => compareJsonScalarLt(left(c, r), right(c, r));
    case '>':
      return (c, r) => compareJsonScalarLt(right(c, r), left(c, r));
    case '<=':
      return (c, r) => {
        const a = left(c, r);
        const b = right(c, r);
        return compareJsonScalarLt(a, b) || cmpEquals(a, b);
      };
    default: // '>='
      return (c, r) => {
        const a = left(c, r);
        const b = right(c, r);
        return compareJsonScalarLt(b, a) || cmpEquals(a, b);
      };
  }
}

/**
 * Compile a filter logical expression to a predicate.
 * @returns {(current: any, root: any) => boolean}
 */
export function compileLogicalExpr(expr) {
  switch (expr.kind) {
    case 'or': {
      const fns = expr.operands.map(compileLogicalExpr);
      const flen = fns.length;
      return (c, r) => {
        for (let i = 0; i < flen; i++) {
          if (fns[i](c, r))
            return true;
        }
        return false;
      };
    }
    case 'and': {
      const fns = expr.operands.map(compileLogicalExpr);
      const flen = fns.length;
      return (c, r) => {
        for (let i = 0; i < flen; i++) {
          if (!fns[i](c, r))
            return false;
        }
        return true;
      };
    }
    case 'not': {
      const fn = compileLogicalExpr(expr.operand);
      return (c, r) => !fn(c, r);
    }
    case 'exists':
      return compileExists(expr.query);
    case 'ftest': {
      const func = expr.func;
      if (func.name === 'match' || func.name === 'search')
        return compileRegexTest(func, func.name === 'match');
      // a registered extension as a test expression: LogicalType is the
      // answer itself, NodesType is true for a non-empty nodelist
      const fn = compileUserFunction(func);
      if (func.returns === 'logical')
        return fn;
      return (c, r) => fn(c, r).length > 0;
    }
    default: // 'cmp'
      return compileComparison(expr);
  }
}

//#endregion

//#region segment compilation (values mode)

// Resolve a slice selector's bounds against an array length (RFC 9535
// section 2.3.4.2.2) for a `for (i = sliceFrom; i != sliceTo; i += step)`
// walk - exclusive at `sliceTo` in both directions. The two results are
// handed back through module scope rather than an object or a pair,
// because this runs once per input node on every slice selector in all
// three segment modes and must not allocate. Read them immediately; no
// slice applier calls anything in between.
let sliceFrom = 0;
let sliceTo = 0;

function sliceBounds(start, end, step, len) {
  const s = start === null ? (step > 0 ? 0 : len - 1) : (start < 0 ? len + start : start);
  const e = end === null ? (step > 0 ? len : -1) : (end < 0 ? len + end : end);
  if (step > 0) {
    sliceFrom = s < 0 ? 0 : (s > len ? len : s);
    sliceTo = e < 0 ? 0 : (e > len ? len : e);
  }
  else {
    sliceFrom = s < -1 ? -1 : (s > len - 1 ? len - 1 : s);
    sliceTo = e < -1 ? -1 : (e > len - 1 ? len - 1 : e);
  }
}

// selector-node functions: (value, output, root) => void

export function compileSelectorNodeV(sel) {
  switch (sel.kind) {
    case 'name': {
      const name = sel.name;
      return (v, out) => {
        if (typeof v === 'object' && v !== null && !Array.isArray(v) && hasOwn(v, name))
          out.push(v[name]);
      };
    }
    case 'index': {
      const index = sel.index;
      if (index >= 0) {
        return (v, out) => {
          if (Array.isArray(v) && index < v.length)
            out.push(v[index]);
        };
      }
      return (v, out) => {
        if (Array.isArray(v)) {
          const idx = v.length + index;
          if (idx >= 0)
            out.push(v[idx]);
        }
      };
    }
    case 'wildcard':
      return (v, out) => {
        if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i++)
            out.push(v[i]);
        }
        else if (typeof v === 'object' && v !== null) {
          for (const key in v) {
            if (hasOwn(v, key))
              out.push(v[key]);
          }
        }
      };
    case 'slice': {
      const start = sel.start;
      const end = sel.end;
      const step = sel.step === null ? 1 : sel.step;
      if (step === 0)
        return () => { };
      return (v, out) => {
        if (!Array.isArray(v))
          return;
        const len = v.length;
        if (len === 0)
          return;
        sliceBounds(start, end, step, len);
        if (step > 0) {
          for (let i = sliceFrom; i < sliceTo; i += step)
            out.push(v[i]);
        }
        else {
          for (let i = sliceFrom; i > sliceTo; i += step)
            out.push(v[i]);
        }
      };
    }
    default: { // 'filter'
      const pred = compileLogicalExpr(sel.expr);
      return (v, out, root) => {
        if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) {
            if (pred(v[i], root))
              out.push(v[i]);
          }
        }
        else if (typeof v === 'object' && v !== null) {
          for (const key in v) {
            if (hasOwn(v, key) && pred(v[key], root))
              out.push(v[key]);
          }
        }
      };
    }
  }
}

export function descendV(v, output, root, apply) {
  apply(v, output, root);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++)
      descendV(v[i], output, root, apply);
  }
  else if (typeof v === 'object' && v !== null) {
    for (const key in v) {
      if (hasOwn(v, key))
        descendV(v[key], output, root, apply);
    }
  }
}

// Combine a segment's selectors into one (value, output, root) => void
// applier; a single selector is its own applier.
function compileSelectorsV(seg) {
  const fns = seg.selectors.map(compileSelectorNodeV);
  if (fns.length === 1)
    return fns[0];
  return (v, out, root) => {
    for (let i = 0; i < fns.length; i++)
      fns[i](v, out, root);
  };
}

// segment functions: (input, output, root) => void
export function compileSegmentV(seg) {
  const apply = compileSelectorsV(seg);
  if (seg.descendant) {
    return (input, output, root) => {
      for (let i = 0; i < input.length; i++)
        descendV(input[i], output, root, apply);
    };
  }
  return (input, output, root) => {
    for (let i = 0; i < input.length; i++)
      apply(input[i], output, root);
  };
}

//#endregion

//#region segment compilation (lazy values mode)
// The same selectors as values mode, pulled one node at a time instead
// of pushed into a nodelist. A consumer that stops early (`first`,
// `exists`, `value()`'s two-node test) never visits the rest of the
// document: a filter evaluates its predicate only until a node passes,
// a wildcard reads only the children actually pulled, and a descendant
// segment abandons the walk mid-subtree.
//
// Nothing here is buffered - every applier yields directly - so the
// laziness is per node, not per segment. Enumeration order is identical
// to runSegmentsV: a segment maps each input node to its outputs in
// order and concatenates them, so pulling the chain depth-first visits
// exactly the sequence values mode builds breadth-first.

// selector-node functions: (value, root) => Generator<any>

function compileSelectorNodeG(sel) {
  switch (sel.kind) {
    case 'name': {
      const name = sel.name;
      return function* nameG(v) {
        if (typeof v === 'object' && v !== null && !Array.isArray(v) && hasOwn(v, name))
          yield v[name];
      };
    }
    case 'index': {
      const index = sel.index;
      return function* indexG(v) {
        if (!Array.isArray(v))
          return;
        const idx = index < 0 ? v.length + index : index;
        if (idx >= 0 && idx < v.length)
          yield v[idx];
      };
    }
    case 'wildcard':
      return function* wildcardG(v) {
        if (Array.isArray(v)) {
          yield* v;
        }
        else if (typeof v === 'object' && v !== null) {
          for (const key in v) {
            if (hasOwn(v, key))
              yield v[key];
          }
        }
      };
    case 'slice': {
      const start = sel.start;
      const end = sel.end;
      const step = sel.step === null ? 1 : sel.step;
      if (step === 0)
        return function* emptySliceG() { };
      return function* sliceG(v) {
        if (!Array.isArray(v))
          return;
        const len = v.length;
        if (len === 0)
          return;
        sliceBounds(start, end, step, len);
        // read the bounds out before the first yield: a suspended
        // generator must not depend on the shared scratch surviving
        const from = sliceFrom;
        const to = sliceTo;
        if (step > 0) {
          for (let i = from; i < to; i += step)
            yield v[i];
        }
        else {
          for (let i = from; i > to; i += step)
            yield v[i];
        }
      };
    }
    default: { // 'filter'
      const pred = compileLogicalExpr(sel.expr);
      return function* filterG(v, root) {
        if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) {
            if (pred(v[i], root))
              yield v[i];
          }
        }
        else if (typeof v === 'object' && v !== null) {
          for (const key in v) {
            if (hasOwn(v, key) && pred(v[key], root))
              yield v[key];
          }
        }
      };
    }
  }
}

function* descendG(v, root, apply) {
  yield* apply(v, root);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++)
      yield* descendG(v[i], root, apply);
  }
  else if (typeof v === 'object' && v !== null) {
    for (const key in v) {
      if (hasOwn(v, key))
        yield* descendG(v[key], root, apply);
    }
  }
}

/**
 * Compile a segment into its lazy form: a generator function yielding
 * the nodes one input value contributes, in document order.
 * @param {object} seg - a parsed query segment
 * @returns {(value: any, root: any) => Generator<any>}
 */
export function compileSegmentG(seg) {
  const fns = seg.selectors.map(compileSelectorNodeG);
  const apply = fns.length === 1
    ? fns[0]
    : function* applyG(v, root) {
      for (let i = 0; i < fns.length; i++)
        yield* fns[i](v, root);
    };
  if (seg.descendant)
    return function* segmentDescendantG(v, root) { yield* descendG(v, root, apply); };
  return apply;
}

/**
 * Lazily enumerate the nodelist a compiled segment chain selects,
 * yielding values in document order.
 * @param {Function[]} gens - segment generators from compileSegmentG
 * @param {number} i - the segment to apply (0 to start the chain)
 * @param {any} value - the value this segment applies to
 * @param {any} root - the query root (`$` inside embedded filters)
 * @returns {Generator<any>}
 */
export function* runSegmentsG(gens, i, value, root) {
  if (i === gens.length) {
    yield value;
    return;
  }
  for (const v of gens[i](value, root))
    yield* runSegmentsG(gens, i + 1, v, root);
}

//#endregion

//#region segment compilation (nodes mode, normalized paths)
// Moved verbatim from path.js: the selector/segment compilers producing
// (value, normalized-path) pairs per RFC 9535 section 2.7. path.js
// imports them back for `query.nodes()`/`query.paths()`; nodes mode
// stays lazily compiled there, so value-only queries never pay for it.

// eslint-disable-next-line no-control-regex
export const RE_NAME_NEEDS_ESCAPE = /['\\\u0000-\u001f]/;

/**
 * Escape a member name for use inside a normalized path name selector
 * (RFC 9535 section 2.7).
 */
export function escapeNormalizedName(name) {
  if (!RE_NAME_NEEDS_ESCAPE.test(name))
    return name;
  let out = '';
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c === CC_SQUOTE) out += "\\'";
    else if (c === CC_BACKSLASH) out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === CC_TAB) out += '\\t';
    else if (c === CC_LF) out += '\\n';
    else if (c === 0x0C) out += '\\f';
    else if (c === CC_CR) out += '\\r';
    else if (c < CC_SPACE) out += '\\u00' + (c < 0x10 ? '0' : '') + c.toString(16);
    else out += name[i];
  }
  return out;
}

export function appendName(path, name) {
  return path + "['" + escapeNormalizedName(name) + "']";
}

// selector-node functions: (value, path, outValues, outPaths, root) => void

export function compileSelectorNodeP(sel) {
  switch (sel.kind) {
    case 'name': {
      const name = sel.name;
      const suffix = "['" + escapeNormalizedName(name) + "']";
      return (v, p, outV, outP) => {
        if (typeof v === 'object' && v !== null && !Array.isArray(v) && hasOwn(v, name)) {
          outV.push(v[name]);
          outP.push(p + suffix);
        }
      };
    }
    case 'index': {
      const index = sel.index;
      return (v, p, outV, outP) => {
        if (!Array.isArray(v))
          return;
        const idx = index < 0 ? v.length + index : index;
        if (idx >= 0 && idx < v.length) {
          outV.push(v[idx]);
          outP.push(p + '[' + idx + ']');
        }
      };
    }
    case 'wildcard':
      return (v, p, outV, outP) => {
        if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) {
            outV.push(v[i]);
            outP.push(p + '[' + i + ']');
          }
        }
        else if (typeof v === 'object' && v !== null) {
          for (const key in v) {
            if (hasOwn(v, key)) {
              outV.push(v[key]);
              outP.push(appendName(p, key));
            }
          }
        }
      };
    case 'slice': {
      const start = sel.start;
      const end = sel.end;
      const step = sel.step === null ? 1 : sel.step;
      if (step === 0)
        return () => { };
      return (v, p, outV, outP) => {
        if (!Array.isArray(v))
          return;
        const len = v.length;
        if (len === 0)
          return;
        sliceBounds(start, end, step, len);
        if (step > 0) {
          for (let i = sliceFrom; i < sliceTo; i += step) {
            outV.push(v[i]);
            outP.push(p + '[' + i + ']');
          }
        }
        else {
          for (let i = sliceFrom; i > sliceTo; i += step) {
            outV.push(v[i]);
            outP.push(p + '[' + i + ']');
          }
        }
      };
    }
    default: { // 'filter'
      const pred = compileLogicalExpr(sel.expr);
      return (v, p, outV, outP, root) => {
        if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) {
            if (pred(v[i], root)) {
              outV.push(v[i]);
              outP.push(p + '[' + i + ']');
            }
          }
        }
        else if (typeof v === 'object' && v !== null) {
          for (const key in v) {
            if (hasOwn(v, key) && pred(v[key], root)) {
              outV.push(v[key]);
              outP.push(appendName(p, key));
            }
          }
        }
      };
    }
  }
}

export function descendP(v, p, outV, outP, root, apply) {
  apply(v, p, outV, outP, root);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++)
      descendP(v[i], p + '[' + i + ']', outV, outP, root, apply);
  }
  else if (typeof v === 'object' && v !== null) {
    for (const key in v) {
      if (hasOwn(v, key))
        descendP(v[key], appendName(p, key), outV, outP, root, apply);
    }
  }
}

// segment functions: (inValues, inPaths, outValues, outPaths, root) => void
export function compileSegmentP(seg) {
  const fns = seg.selectors.map(compileSelectorNodeP);
  const apply = fns.length === 1
    ? fns[0]
    : (v, p, outV, outP, root) => {
      for (let i = 0; i < fns.length; i++)
        fns[i](v, p, outV, outP, root);
    };
  if (seg.descendant) {
    return (inV, inP, outV, outP, root) => {
      for (let i = 0; i < inV.length; i++)
        descendP(inV[i], inP[i], outV, outP, root, apply);
    };
  }
  return (inV, inP, outV, outP, root) => {
    for (let i = 0; i < inV.length; i++)
      apply(inV[i], inP[i], outV, outP, root);
  };
}

/**
 * Run a chain of compiled nodes-mode segment functions over a start
 * value, threading normalized paths alongside values.
 * @param {Function[]} segs - segment functions from compileSegmentP
 * @param {any} startValue - the value the first segment applies to
 * @param {string} startPath - the base normalized path of startValue
 *   (`'$'` for the document root)
 * @param {any} root - the query root (`$` inside embedded filters)
 * @returns {{ vals: any[], paths: string[] }} parallel arrays of the
 *   resulting nodelist's values and normalized paths
 */
export function runSegmentsP(segs, startValue, startPath, root) {
  let vals = [startValue];
  let paths = [startPath];
  const slen = segs.length;
  for (let i = 0; i < slen; i++) {
    if (vals.length === 0)
      break;
    const outV = [];
    const outP = [];
    segs[i](vals, paths, outV, outP, root);
    vals = outV;
    paths = outP;
  }
  return { vals, paths };
}

//#endregion

//#endregion
