//#region JSONPath segment engine (package-internal)
// Runtime segment machinery shared by the JSONPath compiler (path.js) and
// the query engine (query/). Extracted verbatim from path.js, in two
// installments: values mode first, then the nodes-mode (normalized paths,
// RFC 9535 section 2.7) compilers - so consumers beyond path.js (the JSLT
// dispatcher's positional matching) can run selectors producing
// (value, normalized-path) pairs. This module is package-internal and is
// deliberately not listed in the package exports.

import { equalsJson } from '@jarenjs/core/object';
import { countCodePoints, compareCodePoints } from '@jarenjs/core/string';
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

// numbers by value, strings by Unicode scalar values (RFC 9535
// section 2.3.5.2.2); other types do not order
function cmpLess(a, b) {
  if (typeof a === 'number')
    return typeof b === 'number' && a < b;
  if (typeof a === 'string')
    return typeof b === 'string' && compareCodePoints(a, b) < 0;
  return false;
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
      const query = func.args[0].query;
      if (isSingularSegments(query.segments)) {
        const getter = compileSingularGetter(query.segments, query.relative);
        return (current, root) => (getter(current, root) === NOTHING ? 0 : 1);
      }
      const segs = query.segments.map(compileSegmentV);
      const relative = query.relative;
      return (current, root) => runSegmentsV(segs, relative ? current : root, root).length;
    }
    case 'value': {
      const query = func.args[0].query;
      if (isSingularSegments(query.segments))
        return compileSingularGetter(query.segments, query.relative);
      const segs = query.segments.map(compileSegmentV);
      const relative = query.relative;
      return (current, root) => {
        const result = runSegmentsV(segs, relative ? current : root, root);
        return result.length === 1 ? result[0] : NOTHING;
      };
    }
    /* c8 ignore next 2 -- guarded by the parser's well-typedness checks */
    default:
      throw new Error(`JSONPath: function '${func.name}' does not return ValueType`);
  }
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
      return (c, r) => cmpLess(left(c, r), right(c, r));
    case '>':
      return (c, r) => cmpLess(right(c, r), left(c, r));
    case '<=':
      return (c, r) => {
        const a = left(c, r);
        const b = right(c, r);
        return cmpLess(a, b) || cmpEquals(a, b);
      };
    default: // '>='
      return (c, r) => {
        const a = left(c, r);
        const b = right(c, r);
        return cmpLess(b, a) || cmpEquals(a, b);
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
    case 'ftest':
      return compileRegexTest(expr.func, expr.func.name === 'match');
    default: // 'cmp'
      return compileComparison(expr);
  }
}

//#endregion

//#region segment compilation (values mode)

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
        // bounds per RFC 9535 section 2.3.4.2.2
        const s = start === null ? (step > 0 ? 0 : len - 1) : (start < 0 ? len + start : start);
        const e = end === null ? (step > 0 ? len : -1) : (end < 0 ? len + end : end);
        if (step > 0) {
          const lower = s < 0 ? 0 : (s > len ? len : s);
          const upper = e < 0 ? 0 : (e > len ? len : e);
          for (let i = lower; i < upper; i += step)
            out.push(v[i]);
        }
        else {
          const upper = s < -1 ? -1 : (s > len - 1 ? len - 1 : s);
          const lower = e < -1 ? -1 : (e > len - 1 ? len - 1 : e);
          for (let i = upper; i > lower; i += step)
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

// segment functions: (input, output, root) => void
export function compileSegmentV(seg) {
  const fns = seg.selectors.map(compileSelectorNodeV);
  const apply = fns.length === 1
    ? fns[0]
    : (v, out, root) => {
      for (let i = 0; i < fns.length; i++)
        fns[i](v, out, root);
    };
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
        const s = start === null ? (step > 0 ? 0 : len - 1) : (start < 0 ? len + start : start);
        const e = end === null ? (step > 0 ? len : -1) : (end < 0 ? len + end : end);
        if (step > 0) {
          const lower = s < 0 ? 0 : (s > len ? len : s);
          const upper = e < 0 ? 0 : (e > len ? len : e);
          for (let i = lower; i < upper; i += step) {
            outV.push(v[i]);
            outP.push(p + '[' + i + ']');
          }
        }
        else {
          const upper = s < -1 ? -1 : (s > len - 1 ? len - 1 : s);
          const lower = e < -1 ? -1 : (e > len - 1 ? len - 1 : e);
          for (let i = upper; i > lower; i += step) {
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
