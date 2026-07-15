//#region JSONPath (RFC 9535)
// JSONPath: Query Expressions for JSON
// https://www.rfc-editor.org/rfc/rfc9535.html
//
// This module implements RFC 9535 as a two-stage compiler:
//
//   1. `parseJSONPath` - a strict, single-pass recursive-descent parser that
//      turns a query string into an AST, enforcing the complete RFC grammar
//      including the well-typedness rules of function expressions (2.4.3).
//   2. `compileJSONPath` - compiles the AST into a chain of specialized
//      closures. All decisions (selector kind, sign of an index, literal
//      regexps, singular-query detection) are taken at compile time so the
//      returned query function does no interpretation at runtime.
//
// Runtime fast paths:
//   - Singular queries (`$.a.b[3]`) compile to a direct property walk with
//     no intermediate arrays.
//   - Filter comparables compile to sentinel-returning getters; existence
//     tests on singular queries never materialize nodelists.
//   - `match()`/`search()` with a literal pattern precompile their RegExp;
//     dynamic patterns use a per-callsite monomorphic cache.
//   - Normalized-path production (RFC 9535 section 2.7) is compiled lazily,
//     so value-only queries never pay for path-string building.

//#region constants & shared helpers

import {
  NOTHING,
  isSingularSegments,
  compileSingularGetter,
  compileSegmentV,
  compileLogicalExpr,
  runSegmentsV,
} from './segments.js';
import {
  CC_TAB,
  CC_LF,
  CC_CR,
  CC_SPACE,
  CC_BANG,
  CC_DQUOTE,
  CC_DOLLAR,
  CC_AMP,
  CC_SQUOTE,
  CC_LPAREN,
  CC_RPAREN,
  CC_STAR,
  CC_COMMA,
  CC_MINUS,
  CC_DOT,
  CC_SLASH,
  CC_0,
  CC_9,
  CC_COLON,
  CC_LT,
  CC_EQ,
  CC_GT,
  CC_QUESTION,
  CC_AT,
  CC_LBRACKET,
  CC_BACKSLASH,
  CC_RBRACKET,
  CC_UNDERSCORE,
  CC_PIPE,
  isDigitCode,
} from '@jarenjs/core/scan';

/**
 * Sentinel for the absence of a value ("Nothing" in RFC 9535 terms), as
 * distinct from the JSON value `null`.
 */
export const JSONPATH_NOTHING = NOTHING;

const hasOwn = Object.hasOwn;

function deepFreeze(value) {
  if (typeof value !== 'object' || value === null)
    return value;
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++)
    deepFreeze(value[keys[i]]);
  return Object.freeze(value);
}

/**
 * Error thrown when a JSONPath query is not valid RFC 9535 syntax
 * (including queries that are not well-typed per section 2.4.3).
 */
export class JSONPathSyntaxError extends SyntaxError {
  constructor(message, source, position) {
    super(`Invalid JSONPath: ${message} at position ${position} in '${source}'`);
    this.name = 'JSONPathSyntaxError';
    this.source = source;
    this.position = position;
  }
}

// Built-in function extensions (RFC 9535 section 2.4).
// Parameter/return types: 'value' = ValueType, 'nodes' = NodesType,
// 'logical' = LogicalType.
const FUNCTIONS = {
  length: { params: ['value'], returns: 'value' },
  count: { params: ['nodes'], returns: 'value' },
  match: { params: ['value', 'value'], returns: 'logical' },
  search: { params: ['value', 'value'], returns: 'logical' },
  value: { params: ['nodes'], returns: 'value' },
};

//#endregion

//#region parser

function isNameFirstCode(c) {
  return (c >= 0x41 && c <= 0x5A) // A-Z
    || (c >= 0x61 && c <= 0x7A) // a-z
    || c === CC_UNDERSCORE
    || c >= 0x80; // any non-ASCII code unit
}

function isNameCharCode(c) {
  return isNameFirstCode(c) || isDigitCode(c);
}

/**
 * Parse a JSONPath query string into an AST.
 * @param {string} source - The JSONPath expression (e.g. `$.store.book[?@.price < 10].title`)
 * @returns {{ relative: boolean, segments: object[] }} The parsed query AST
 * @throws {JSONPathSyntaxError} When the query violates the RFC 9535 grammar
 */
export function parseJSONPath(source) {
  if (typeof source !== 'string')
    throw new JSONPathSyntaxError('query must be a string', String(source), 0);

  const len = source.length;
  let pos = 0;

  function fail(message, at = pos) {
    throw new JSONPathSyntaxError(message, source, at);
  }

  function cc(at) {
    return at < len ? source.charCodeAt(at) : -1;
  }

  function skipWS() {
    while (pos < len) {
      const c = source.charCodeAt(pos);
      if (c !== CC_SPACE && c !== CC_TAB && c !== CC_LF && c !== CC_CR)
        break;
      pos++;
    }
  }

  //#region scalar tokens

  function parseIdentifier() {
    const start = pos;
    let c = cc(pos);
    while ((c >= 0x61 && c <= 0x7A) || c === CC_UNDERSCORE || isDigitCode(c)) {
      pos++;
      c = cc(pos);
    }
    return source.slice(start, pos);
  }

  function parseMemberNameShorthand() {
    const start = pos;
    if (!isNameFirstCode(cc(pos)))
      fail('expected member name');
    while (pos < len) {
      const c = source.charCodeAt(pos);
      if (c >= 0xD800 && c <= 0xDFFF) {
        // queries are sequences of Unicode scalar values (RFC 9535 2.1);
        // raw surrogates must form a well-formed pair
        const d = cc(pos + 1);
        if (c >= 0xDC00 || d < 0xDC00 || d > 0xDFFF)
          fail('lone surrogate in member name');
        pos += 2;
        continue;
      }
      if (!isNameCharCode(c))
        break;
      pos++;
    }
    return source.slice(start, pos);
  }

  function hex4() {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const c = cc(pos);
      let d;
      if (c >= CC_0 && c <= CC_9) d = c - CC_0;
      else if (c >= 0x41 && c <= 0x46) d = c - 0x37; // A-F
      else if (c >= 0x61 && c <= 0x66) d = c - 0x57; // a-f
      else return fail('invalid unicode escape');
      value = (value << 4) | d;
      pos++;
    }
    return value;
  }

  function parseUnicodeEscape() {
    const hi = hex4();
    if (hi >= 0xD800 && hi <= 0xDBFF) {
      // high surrogate must be directly followed by a low surrogate escape
      if (cc(pos) !== CC_BACKSLASH || cc(pos + 1) !== 0x75 /* u */)
        fail('lone surrogate in unicode escape');
      pos += 2;
      const lo = hex4();
      if (lo < 0xDC00 || lo > 0xDFFF)
        fail('invalid low surrogate in unicode escape');
      return String.fromCharCode(hi, lo);
    }
    if (hi >= 0xDC00 && hi <= 0xDFFF)
      fail('lone surrogate in unicode escape');
    return String.fromCharCode(hi);
  }

  function parseEscape(quote) {
    const c = cc(pos);
    pos++;
    switch (c) {
      case 0x62: return '\b'; // \b
      case 0x66: return '\f'; // \f
      case 0x6E: return '\n'; // \n
      case 0x72: return '\r'; // \r
      case 0x74: return '\t'; // \t
      case CC_SLASH: return '/';
      case CC_BACKSLASH: return '\\';
      case 0x75: return parseUnicodeEscape(); // \uXXXX
      default:
        if (c === quote)
          return String.fromCharCode(quote);
        return fail('invalid escape sequence', pos - 1);
    }
  }

  function parseStringLiteral() {
    const quote = source.charCodeAt(pos);
    pos++;
    let out = '';
    let chunk = pos;
    while (pos < len) {
      const c = source.charCodeAt(pos);
      if (c === quote) {
        out += source.slice(chunk, pos);
        pos++;
        return out;
      }
      if (c === CC_BACKSLASH) {
        out += source.slice(chunk, pos);
        pos++;
        out += parseEscape(quote);
        chunk = pos;
        continue;
      }
      if (c < CC_SPACE)
        fail('unescaped control character in string literal');
      if (c >= 0xD800 && c <= 0xDFFF) {
        // raw surrogates must form a well-formed pair (RFC 9535 2.1)
        const d = cc(pos + 1);
        if (c >= 0xDC00 || d < 0xDC00 || d > 0xDFFF)
          fail('lone surrogate in string literal');
        pos += 2;
        continue;
      }
      pos++;
    }
    return fail('unterminated string literal');
  }

  // int per RFC: "0" or ["-"] 1-9 *DIGIT; no leading zeros, no -0
  function parseIntToken() {
    const start = pos;
    let neg = false;
    if (cc(pos) === CC_MINUS) {
      neg = true;
      pos++;
    }
    const first = cc(pos);
    if (!isDigitCode(first))
      fail('expected integer');
    pos++;
    if (first === CC_0) {
      if (isDigitCode(cc(pos)))
        fail('leading zeros are not allowed', start);
      if (neg)
        fail("'-0' is not allowed as an index", start);
      return 0;
    }
    while (isDigitCode(cc(pos)))
      pos++;
    const value = Number(source.slice(start, pos));
    if (!Number.isSafeInteger(value))
      fail('integer out of interoperable range', start);
    return value;
  }

  // number per RFC: (int / "-0") [frac] [exp]
  function parseNumberLiteral() {
    const start = pos;
    if (cc(pos) === CC_MINUS)
      pos++;
    if (!isDigitCode(cc(pos)))
      fail('expected digit in number literal');
    if (cc(pos) === CC_0) {
      pos++;
      if (isDigitCode(cc(pos)))
        fail('leading zeros are not allowed', start);
    }
    else {
      while (isDigitCode(cc(pos)))
        pos++;
    }
    if (cc(pos) === CC_DOT) {
      pos++;
      if (!isDigitCode(cc(pos)))
        fail('expected digit after decimal point');
      while (isDigitCode(cc(pos)))
        pos++;
    }
    const e = cc(pos);
    if (e === 0x65 || e === 0x45) { // e | E
      pos++;
      const s = cc(pos);
      if (s === 0x2B || s === CC_MINUS)
        pos++;
      if (!isDigitCode(cc(pos)))
        fail('expected digit in exponent');
      while (isDigitCode(cc(pos)))
        pos++;
    }
    return Number(source.slice(start, pos));
  }

  //#endregion

  //#region segments & selectors

  function parseSegments() {
    const segments = [];
    for (;;) {
      const save = pos;
      skipWS();
      const c = cc(pos);
      if (c === CC_LBRACKET) {
        segments.push(parseBracketed(false));
      }
      else if (c === CC_DOT) {
        if (cc(pos + 1) === CC_DOT) {
          pos += 2;
          segments.push(parseDescendant());
        }
        else {
          pos += 1;
          segments.push(parseChildShorthand());
        }
      }
      else {
        pos = save;
        return segments;
      }
    }
  }

  function parseChildShorthand() {
    // no whitespace allowed after '.'
    if (cc(pos) === CC_STAR) {
      pos++;
      return { descendant: false, selectors: [{ kind: 'wildcard' }] };
    }
    return { descendant: false, selectors: [{ kind: 'name', name: parseMemberNameShorthand() }] };
  }

  function parseDescendant() {
    // no whitespace allowed after '..'
    const c = cc(pos);
    if (c === CC_LBRACKET)
      return parseBracketed(true);
    if (c === CC_STAR) {
      pos++;
      return { descendant: true, selectors: [{ kind: 'wildcard' }] };
    }
    return { descendant: true, selectors: [{ kind: 'name', name: parseMemberNameShorthand() }] };
  }

  function parseBracketed(descendant) {
    pos++; // consume '['
    skipWS();
    const selectors = [];
    for (;;) {
      selectors.push(parseSelector());
      skipWS();
      const c = cc(pos);
      if (c === CC_COMMA) {
        pos++;
        skipWS();
        continue;
      }
      if (c === CC_RBRACKET) {
        pos++;
        return { descendant, selectors };
      }
      fail("expected ',' or ']'");
    }
  }

  function parseSelector() {
    const c = cc(pos);
    if (c === CC_SQUOTE || c === CC_DQUOTE)
      return { kind: 'name', name: parseStringLiteral() };
    if (c === CC_STAR) {
      pos++;
      return { kind: 'wildcard' };
    }
    if (c === CC_QUESTION) {
      pos++;
      skipWS();
      return { kind: 'filter', expr: parseLogicalOr() };
    }
    if (c === CC_COLON || c === CC_MINUS || isDigitCode(c))
      return parseIndexOrSlice();
    return fail('expected a selector');
  }

  function parseIndexOrSlice() {
    let start = null;
    if (cc(pos) !== CC_COLON)
      start = parseIntToken();
    let save = pos;
    skipWS();
    if (cc(pos) !== CC_COLON) {
      pos = save;
      return { kind: 'index', index: start };
    }
    pos++; // consume ':'
    skipWS();
    let end = null;
    let c = cc(pos);
    if (c === CC_MINUS || isDigitCode(c))
      end = parseIntToken();
    save = pos;
    skipWS();
    let step = null;
    if (cc(pos) === CC_COLON) {
      pos++;
      skipWS();
      c = cc(pos);
      if (c === CC_MINUS || isDigitCode(c))
        step = parseIntToken();
      // no step after ':' is fine; trailing WS belongs to the bracket
    }
    else {
      pos = save;
    }
    return { kind: 'slice', start, end, step };
  }

  //#endregion

  //#region filter expressions

  function parseLogicalOr() {
    let expr = parseLogicalAnd();
    for (;;) {
      const save = pos;
      skipWS();
      if (cc(pos) === CC_PIPE && cc(pos + 1) === CC_PIPE) {
        pos += 2;
        skipWS();
        const right = parseLogicalAnd();
        expr = expr.kind === 'or'
          ? { kind: 'or', operands: [...expr.operands, right] }
          : { kind: 'or', operands: [expr, right] };
      }
      else {
        pos = save;
        return expr;
      }
    }
  }

  function parseLogicalAnd() {
    let expr = parseBasicExpr();
    for (;;) {
      const save = pos;
      skipWS();
      if (cc(pos) === CC_AMP && cc(pos + 1) === CC_AMP) {
        pos += 2;
        skipWS();
        const right = parseBasicExpr();
        expr = expr.kind === 'and'
          ? { kind: 'and', operands: [...expr.operands, right] }
          : { kind: 'and', operands: [expr, right] };
      }
      else {
        pos = save;
        return expr;
      }
    }
  }

  function parseBasicExpr() {
    const c = cc(pos);
    if (c === CC_BANG) {
      pos++;
      skipWS();
      return { kind: 'not', operand: parseNegatable() };
    }
    if (c === CC_LPAREN)
      return parseParen();
    return parseComparisonOrTest();
  }

  function parseNegatable() {
    const c = cc(pos);
    if (c === CC_LPAREN)
      return parseParen();
    if (c === CC_AT || c === CC_DOLLAR)
      return { kind: 'exists', query: parseFilterQuery() };
    if (c >= 0x61 && c <= 0x7A) {
      const at = pos;
      const ident = parseIdentifier();
      if (cc(pos) !== CC_LPAREN)
        fail('expected a test expression after !', at);
      const func = parseFunctionExpr(ident, at);
      if (func.returns === 'value')
        fail('a function of type ValueType cannot be used as a test expression', at);
      return { kind: 'ftest', func };
    }
    return fail('expected a test expression after !');
  }

  function parseParen() {
    pos++; // consume '('
    skipWS();
    const expr = parseLogicalOr();
    skipWS();
    if (cc(pos) !== CC_RPAREN)
      fail("expected ')'");
    pos++;
    return expr;
  }

  function tryParseCompOp() {
    const c = cc(pos);
    if (c === CC_EQ) {
      if (cc(pos + 1) !== CC_EQ)
        fail("expected '=='");
      pos += 2;
      return '==';
    }
    if (c === CC_BANG) {
      if (cc(pos + 1) !== CC_EQ)
        return null;
      pos += 2;
      return '!=';
    }
    if (c === CC_LT) {
      if (cc(pos + 1) === CC_EQ) {
        pos += 2;
        return '<=';
      }
      pos += 1;
      return '<';
    }
    if (c === CC_GT) {
      if (cc(pos + 1) === CC_EQ) {
        pos += 2;
        return '>=';
      }
      pos += 1;
      return '>';
    }
    return null;
  }

  function parseFilterQuery() {
    const relative = cc(pos) === CC_AT;
    pos++; // consume '@' or '$'
    return { relative, segments: parseSegments() };
  }

  function requireSingular(query, at, what) {
    if (!isSingularSegments(query.segments))
      fail(`${what} requires a singular query`, at);
    return query;
  }

  function parseComparisonOrTest() {
    const at = pos;
    const c = cc(pos);
    if (c === CC_AT || c === CC_DOLLAR) {
      const query = parseFilterQuery();
      const save = pos;
      skipWS();
      const op = tryParseCompOp();
      if (op === null) {
        pos = save;
        return { kind: 'exists', query };
      }
      requireSingular(query, at, 'a comparison');
      skipWS();
      return { kind: 'cmp', op, left: { kind: 'query', query }, right: parseComparable() };
    }
    if (c === CC_SQUOTE || c === CC_DQUOTE || c === CC_MINUS || isDigitCode(c)) {
      const left = parseLiteralComparable();
      skipWS();
      const op = tryParseCompOp();
      if (op === null)
        fail('a literal must be part of a comparison', at);
      skipWS();
      return { kind: 'cmp', op, left, right: parseComparable() };
    }
    if (c >= 0x61 && c <= 0x7A) {
      const ident = parseIdentifier();
      if (cc(pos) === CC_LPAREN) {
        const func = parseFunctionExpr(ident, at);
        const save = pos;
        skipWS();
        const op = tryParseCompOp();
        if (op === null) {
          pos = save;
          if (func.returns === 'value')
            fail('a function of type ValueType cannot be used as a test expression', at);
          return { kind: 'ftest', func };
        }
        if (func.returns !== 'value')
          fail('only functions of type ValueType can be compared', at);
        skipWS();
        return { kind: 'cmp', op, left: func, right: parseComparable() };
      }
      if (ident === 'true' || ident === 'false' || ident === 'null') {
        skipWS();
        const op = tryParseCompOp();
        if (op === null)
          fail('a literal must be part of a comparison', at);
        skipWS();
        const value = ident === 'true' ? true : ident === 'false' ? false : null;
        return { kind: 'cmp', op, left: { kind: 'literal', value }, right: parseComparable() };
      }
      return fail(`unexpected identifier '${ident}'`, at);
    }
    return fail('expected a filter expression');
  }

  function parseLiteralComparable() {
    const c = cc(pos);
    if (c === CC_SQUOTE || c === CC_DQUOTE)
      return { kind: 'literal', value: parseStringLiteral() };
    return { kind: 'literal', value: parseNumberLiteral() };
  }

  function parseComparable() {
    const at = pos;
    const c = cc(pos);
    if (c === CC_AT || c === CC_DOLLAR) {
      const query = requireSingular(parseFilterQuery(), at, 'a comparison');
      return { kind: 'query', query };
    }
    if (c === CC_SQUOTE || c === CC_DQUOTE || c === CC_MINUS || isDigitCode(c))
      return parseLiteralComparable();
    if (c >= 0x61 && c <= 0x7A) {
      const ident = parseIdentifier();
      if (cc(pos) === CC_LPAREN) {
        const func = parseFunctionExpr(ident, at);
        if (func.returns !== 'value')
          fail('only functions of type ValueType can be compared', at);
        return func;
      }
      if (ident === 'true') return { kind: 'literal', value: true };
      if (ident === 'false') return { kind: 'literal', value: false };
      if (ident === 'null') return { kind: 'literal', value: null };
      return fail(`unexpected identifier '${ident}'`, at);
    }
    return fail('expected a comparable expression');
  }

  function parseFunctionArg() {
    const at = pos;
    const c = cc(pos);
    if (c === CC_AT || c === CC_DOLLAR)
      return { kind: 'query', query: parseFilterQuery() };
    if (c === CC_SQUOTE || c === CC_DQUOTE || c === CC_MINUS || isDigitCode(c))
      return parseLiteralComparable();
    if (c >= 0x61 && c <= 0x7A) {
      const ident = parseIdentifier();
      if (cc(pos) === CC_LPAREN)
        return parseFunctionExpr(ident, at);
      if (ident === 'true') return { kind: 'literal', value: true };
      if (ident === 'false') return { kind: 'literal', value: false };
      if (ident === 'null') return { kind: 'literal', value: null };
      return fail(`unexpected identifier '${ident}'`, at);
    }
    return fail('expected a function argument');
  }

  function parseFunctionExpr(name, at) {
    const def = FUNCTIONS[name];
    if (def === undefined)
      fail(`unknown function '${name}'`, at);
    pos++; // consume '('
    skipWS();
    const args = [];
    if (cc(pos) !== CC_RPAREN) {
      for (;;) {
        args.push(parseFunctionArg());
        skipWS();
        if (cc(pos) === CC_COMMA) {
          pos++;
          skipWS();
          continue;
        }
        break;
      }
    }
    if (cc(pos) !== CC_RPAREN)
      fail("expected ')'");
    pos++;
    if (args.length !== def.params.length)
      fail(`function '${name}' expects ${def.params.length} argument(s), got ${args.length}`, at);
    for (let i = 0; i < args.length; i++) {
      const param = def.params[i];
      const arg = args[i];
      if (param === 'value') {
        if (arg.kind === 'literal')
          continue;
        if (arg.kind === 'query') {
          requireSingular(arg.query, at, `argument ${i + 1} of '${name}'`);
          continue;
        }
        if (arg.kind === 'func' && arg.returns === 'value')
          continue;
        fail(`argument ${i + 1} of '${name}' must be of type ValueType`, at);
      }
      else { // 'nodes'
        if (arg.kind === 'query')
          continue;
        if (arg.kind === 'func' && arg.returns === 'nodes')
          continue;
        fail(`argument ${i + 1} of '${name}' must be a query (NodesType)`, at);
      }
    }
    return { kind: 'func', name, args, returns: def.returns };
  }

  //#endregion

  // jsonpath-query = root-identifier segments
  if (len === 0)
    fail('empty query', 0);
  if (source.charCodeAt(0) !== CC_DOLLAR)
    fail("query must start with '$'", 0);
  pos = 1;
  const segments = parseSegments();
  if (pos !== len)
    fail('unexpected token');
  return { relative: false, segments };
}

//#endregion

//#region segment compilation (nodes mode, normalized paths)

// eslint-disable-next-line no-control-regex
const RE_NAME_NEEDS_ESCAPE = /['\\\u0000-\u001f]/;

/**
 * Escape a member name for use inside a normalized path name selector
 * (RFC 9535 section 2.7).
 */
function escapeNormalizedName(name) {
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

function appendName(path, name) {
  return path + "['" + escapeNormalizedName(name) + "']";
}

// selector-node functions: (value, path, outValues, outPaths, root) => void

function compileSelectorNodeP(sel) {
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

function descendP(v, p, outV, outP, root, apply) {
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
function compileSegmentP(seg) {
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

//#endregion

//#region public API

/**
 * Compile a JSONPath query (RFC 9535) into a reusable query function.
 *
 * The returned function applies the query to a JSON value and returns
 * the resulting nodelist as an array of values. It also carries helper
 * methods:
 *
 * - `query(data)` / `query.values(data)` - array of matched values
 * - `query.first(data)` - first matched value, or `undefined`
 * - `query.exists(data)` - true when the query selects at least one node
 * - `query.nodes(data)` - array of `{ path, value }` with normalized paths
 * - `query.paths(data)` - array of normalized paths (RFC 9535 section 2.7)
 * - `query.source` - the original query string
 * - `query.ast` - the parsed query AST (deeply frozen; the lazily
 *   compiled path mode must agree with the eagerly compiled value mode)
 *
 * @param {string} source - The JSONPath expression
 * @returns {function} The compiled query function
 * @throws {JSONPathSyntaxError} When the query is not valid RFC 9535
 * @example
 * const q = compileJSONPath('$.store.book[?@.price < 10].title');
 * q(data); // ['Sayings of the Century', 'Moby Dick']
 * q.paths(data); // ["$['store']['book'][0]['title']", ...]
 */
export function compileJSONPath(source) {
  const ast = deepFreeze(parseJSONPath(source));
  const segments = ast.segments;

  let values, first, exists;
  if (isSingularSegments(segments)) {
    const getter = compileSingularGetter(segments, false);
    values = (data) => {
      const v = getter(data, data);
      return v === NOTHING ? [] : [v];
    };
    first = (data) => {
      const v = getter(data, data);
      return v === NOTHING ? undefined : v;
    };
    exists = (data) => getter(data, data) !== NOTHING;
  }
  else {
    const segs = segments.map(compileSegmentV);
    values = (data) => runSegmentsV(segs, data, data);
    first = (data) => {
      const result = runSegmentsV(segs, data, data);
      return result.length !== 0 ? result[0] : undefined;
    };
    exists = (data) => runSegmentsV(segs, data, data).length !== 0;
  }

  // nodes mode is compiled lazily; value-only queries never pay for it
  let segsP = null;
  function runNodes(data) {
    if (segsP === null)
      segsP = segments.map(compileSegmentP);
    let vals = [data];
    let paths = ['$'];
    for (let i = 0; i < segsP.length; i++) {
      if (vals.length === 0)
        break;
      const outV = [];
      const outP = [];
      segsP[i](vals, paths, outV, outP, data);
      vals = outV;
      paths = outP;
    }
    return { vals, paths };
  }

  const query = (data) => values(data);
  query.values = values;
  query.first = first;
  query.exists = exists;
  query.nodes = (data) => {
    const { vals, paths } = runNodes(data);
    const nodes = new Array(vals.length);
    for (let i = 0; i < vals.length; i++)
      nodes[i] = { path: paths[i], value: vals[i] };
    return nodes;
  };
  query.paths = (data) => runNodes(data).paths;
  query.source = source;
  query.ast = ast;
  return query;
}

const QUERY_CACHE = new Map();
const QUERY_CACHE_LIMIT = 512;

/**
 * Apply a JSONPath query to a JSON value in one call. Compiled queries
 * are cached (FIFO, 512 entries), so repeated calls with the same query
 * string reuse the compiled function.
 * @param {string} source - The JSONPath expression
 * @param {any} data - The JSON value to query
 * @returns {any[]} Array of matched values
 * @throws {JSONPathSyntaxError} When the query is not valid RFC 9535
 */
export function queryJSONPath(source, data) {
  let query = QUERY_CACHE.get(source);
  if (query === undefined) {
    query = compileJSONPath(source);
    if (QUERY_CACHE.size >= QUERY_CACHE_LIMIT)
      QUERY_CACHE.delete(QUERY_CACHE.keys().next().value);
    QUERY_CACHE.set(source, query);
  }
  return query(data);
}

/**
 * Validates a JSONPath expression strictly against the RFC 9535 grammar,
 * including well-typedness of function expressions. Unlike the heuristic
 * `isValidJSONPath` in basic.js, this uses the full parser.
 * @param {string} str - The JSONPath expression to validate
 * @returns {boolean} True when the string is a valid RFC 9535 query
 * @example
 * isValidJSONPathStrict('$.store.book[?@.price < 10]'); // true
 * isValidJSONPathStrict('$.store.book[0 5]'); // false
 * isValidJSONPathStrict('@.name'); // false (queries start at $)
 */
export function isValidJSONPathStrict(str) {
  if (typeof str !== 'string')
    return false;
  try {
    parseJSONPath(str);
    return true;
  }
  catch {
    return false;
  }
}

//#endregion

//#endregion
