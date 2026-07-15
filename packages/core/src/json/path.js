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

/**
 * Sentinel for the absence of a value ("Nothing" in RFC 9535 terms), as
 * distinct from the JSON value `null`.
 */
export const JSONPATH_NOTHING = Symbol('JSONPath.Nothing');

const NOTHING = JSONPATH_NOTHING;

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

const CC_TAB = 0x09;
const CC_LF = 0x0A;
const CC_CR = 0x0D;
const CC_SPACE = 0x20;
const CC_BANG = 0x21;
const CC_DQUOTE = 0x22;
const CC_DOLLAR = 0x24;
const CC_AMP = 0x26;
const CC_SQUOTE = 0x27;
const CC_LPAREN = 0x28;
const CC_RPAREN = 0x29;
const CC_STAR = 0x2A;
const CC_COMMA = 0x2C;
const CC_MINUS = 0x2D;
const CC_DOT = 0x2E;
const CC_SLASH = 0x2F;
const CC_0 = 0x30;
const CC_9 = 0x39;
const CC_COLON = 0x3A;
const CC_LT = 0x3C;
const CC_EQ = 0x3D;
const CC_GT = 0x3E;
const CC_QUESTION = 0x3F;
const CC_AT = 0x40;
const CC_LBRACKET = 0x5B;
const CC_BACKSLASH = 0x5C;
const CC_RBRACKET = 0x5D;
const CC_UNDERSCORE = 0x5F;
const CC_PIPE = 0x7C;

function isDigitCode(c) {
  return c >= CC_0 && c <= CC_9;
}

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
 * Returns true when every segment is a child segment with exactly one
 * name or index selector (a "singular query", RFC 9535 section 2.3.5.1).
 * @param {object[]} segments - Parsed query segments
 * @returns {boolean}
 */
function isSingularSegments(segments) {
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

//#region filter compilation

/**
 * Structural equality of two JSON values per RFC 9535 section 2.3.5.2.2.
 */
function deepEquals(a, b) {
  if (a === b)
    return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null)
    return false;
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b))
    return false;
  if (aIsArray) {
    const alen = a.length;
    if (alen !== b.length)
      return false;
    for (let i = 0; i < alen; i++) {
      if (!deepEquals(a[i], b[i]))
        return false;
    }
    return true;
  }
  let count = 0;
  for (const key in a) {
    if (!hasOwn(a, key))
      continue;
    if (!hasOwn(b, key) || !deepEquals(a[key], b[key]))
      return false;
    count++;
  }
  for (const key in b) {
    if (hasOwn(b, key))
      count--;
  }
  return count === 0;
}

function cmpEquals(a, b) {
  if (a === NOTHING || b === NOTHING)
    return a === b;
  return deepEquals(a, b);
}

/**
 * Compare two strings by Unicode scalar values (code points), per
 * RFC 9535 section 2.3.5.2.2. This differs from JavaScript's native
 * `<`, which compares UTF-16 code units and orders surrogate pairs
 * (U+10000 and up) below unpaired BMP characters in U+E000-U+FFFF.
 */
function stringLessCodePoints(a, b) {
  const alen = a.length;
  const blen = b.length;
  const m = alen < blen ? alen : blen;
  let i = 0;
  while (i < m && a.charCodeAt(i) === b.charCodeAt(i))
    i++;
  if (i === m)
    return alen < blen;
  return a.codePointAt(i) < b.codePointAt(i);
}

function cmpLess(a, b) {
  if (typeof a === 'number')
    return typeof b === 'number' && a < b;
  if (typeof a === 'string')
    return typeof b === 'string' && stringLessCodePoints(a, b);
  return false;
}

function countCodePoints(str) {
  const slen = str.length;
  let count = 0;
  for (let i = 0; i < slen; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < slen) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xDC00 && d <= 0xDFFF)
        i++;
    }
    count++;
  }
  return count;
}

function countOwnKeys(obj) {
  let count = 0;
  for (const key in obj) {
    if (hasOwn(obj, key))
      count++;
  }
  return count;
}

// single-character escapes allowed by RFC 9485: \( \) \* \+ \- \. \? \[ \\ \] \^ \n \r \t \{ \| \}
const IREGEXP_SINGLE_ESC = '()*+-.?[\\]^nrt{|}';

// Unicode general categories allowed in \p{...} / \P{...} (RFC 9485):
// the key is the major category, the value the allowed subcategory letters
const IREGEXP_CATEGORIES = {
  L: 'lmotu',
  M: 'cen',
  N: 'dlo',
  P: 'cdefios',
  Z: 'lps',
  S: 'ckmo',
  C: 'cfno',
};

/**
 * Validate an I-Regexp (RFC 9485) against its complete ABNF grammar and
 * translate it to an equivalent ECMAScript pattern (RFC 9485 section 5.3):
 *
 * - unescaped dots outside character classes become [^\n\r]
 * - '\-' outside a character class becomes '-' (not a valid ECMAScript
 *   escape under the 'u' flag)
 * - unescaped '^' and '$' (grammatically NormalChars) pass through
 *   unchanged: the RFC's own ECMAScript/PCRE/RE2/Ruby conversions
 *   (sections 5.3/5.4) leave them alone, which gives them anchor
 *   semantics, and the official JSONPath compliance test suite expects
 *   exactly that; write '\^' for a literal caret and '[$]' for a
 *   literal dollar ('\$' is not a valid I-Regexp escape)
 *
 * I-Regexp deliberately excludes lookaround, backreferences, lazy
 * quantifiers, multi-character escapes (\d \s \w), and inline flags; per
 * RFC 9535 sections 2.4.6/2.4.7 a nonconforming pattern makes
 * match()/search() yield LogicalFalse, so this returns null for them.
 *
 * @param {string} pattern - The I-Regexp pattern
 * @returns {string|null} The ECMAScript pattern source, or null when invalid
 */
function translateIRegexp(pattern) {
  const n = pattern.length;
  let i = 0;
  let out = '';

  // reads the code point at i; -1 marks a lone surrogate (not a
  // Unicode scalar value, so never valid in an I-Regexp)
  function codePoint() {
    const c = pattern.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDFFF) {
      if (c >= 0xDC00 || i + 1 >= n)
        return -1;
      const d = pattern.charCodeAt(i + 1);
      return (d >= 0xDC00 && d <= 0xDFFF) ? pattern.codePointAt(i) : -1;
    }
    return c;
  }

  function emitCodePoint(cp) {
    const width = cp > 0xFFFF ? 2 : 1;
    out += pattern.slice(i, i + width);
    i += width;
  }

  // NormalChar = %x00-27 / "," / "-" / %x2F-3E / %x40-5A / %x5E-7A / %x7E-D7FF / %xE000-10FFFF
  function isNormalChar(cp) {
    return cp <= 0x27
      || cp === 0x2C || cp === 0x2D
      || (cp >= 0x2F && cp <= 0x3E)
      || (cp >= 0x40 && cp <= 0x5A)
      || (cp >= 0x5E && cp <= 0x7A)
      || cp >= 0x7E; // codePoint() already excluded surrogates
  }

  // CCchar = %x00-2C / %x2E-5A / %x5E-D7FF / %xE000-10FFFF (or SingleCharEsc)
  function isCCchar(cp) {
    return cp !== 0x2D && cp !== 0x5B && cp !== 0x5C && cp !== 0x5D;
  }

  // "\" already consumed; SingleCharEsc / catEsc / complEsc
  function parseEscape(inClass) {
    if (i >= n)
      return false;
    const ch = pattern[i];
    if (ch === 'p' || ch === 'P') {
      i++;
      if (pattern[i] !== '{')
        return false;
      i++;
      const sub = IREGEXP_CATEGORIES[pattern[i]];
      if (sub === undefined)
        return false;
      let prop = pattern[i];
      i++;
      if (pattern[i] !== '}') {
        if (i >= n || !sub.includes(pattern[i]))
          return false;
        prop += pattern[i];
        i++;
        if (pattern[i] !== '}')
          return false;
      }
      i++;
      out += '\\' + ch + '{' + prop + '}';
      return true;
    }
    if (!IREGEXP_SINGLE_ESC.includes(ch))
      return false;
    // '\-' is a valid I-Regexp escape but not a valid ECMAScript 'u'
    // escape outside a character class
    out += (ch === '-' && !inClass) ? '-' : '\\' + ch;
    i++;
    return true;
  }

  // CCE1 = ( CCchar [ "-" CCchar ] ) / charClassEsc
  function parseCCE1() {
    let rangeStart = false; // \p{...} cannot start a range
    if (pattern.charCodeAt(i) === 0x5C) { // backslash
      i++;
      const isCat = pattern[i] === 'p' || pattern[i] === 'P';
      if (!parseEscape(true))
        return false;
      rangeStart = !isCat;
    }
    else {
      const cp = codePoint();
      if (cp < 0 || !isCCchar(cp))
        return false;
      emitCodePoint(cp);
      rangeStart = true;
    }
    // optional range: "-" CCchar (a trailing "-]" belongs to the class)
    if (rangeStart && pattern[i] === '-' && i + 1 < n && pattern[i + 1] !== ']') {
      out += '-';
      i++;
      if (pattern.charCodeAt(i) === 0x5C) {
        i++;
        return pattern[i] !== 'p' && pattern[i] !== 'P' && parseEscape(true);
      }
      const cp = codePoint();
      if (cp < 0 || !isCCchar(cp))
        return false;
      emitCodePoint(cp);
    }
    return true;
  }

  // charClassExpr = "[" [ "^" ] ( "-" / CCE1 ) *CCE1 [ "-" ] "]"
  // (with the extra RFC 9485 restriction that "[^]" is not allowed)
  function parseCharClassExpr() {
    out += '[';
    i++; // consume '['
    if (pattern[i] === '^') {
      out += '^';
      i++;
    }
    if (pattern[i] === '-') {
      out += '\\-';
      i++;
    }
    else if (i >= n || pattern[i] === ']' || !parseCCE1()) {
      return false;
    }
    for (;;) {
      if (i >= n)
        return false;
      const ch = pattern[i];
      if (ch === ']') {
        out += ']';
        i++;
        return true;
      }
      if (ch === '-') { // only valid as the trailing "-]"
        if (pattern[i + 1] !== ']')
          return false;
        out += '\\-]';
        i += 2;
        return true;
      }
      if (!parseCCE1())
        return false;
    }
  }

  // atom = NormalChar / charClass / ( "(" i-regexp ")" )
  function parseAtom() {
    const ch = pattern[i];
    if (ch === '(') {
      out += '(';
      i++;
      if (!parseAlternation())
        return false;
      if (pattern[i] !== ')')
        return false;
      out += ')';
      i++;
      return true;
    }
    if (ch === '.') { // matches any character except \n and \r
      out += '[^\\n\\r]';
      i++;
      return true;
    }
    if (ch === '\\') {
      i++;
      return parseEscape(false);
    }
    if (ch === '[')
      return parseCharClassExpr();
    const cp = codePoint();
    if (cp < 0 || !isNormalChar(cp))
      return false;
    emitCodePoint(cp);
    return true;
  }

  // piece = atom [ quantifier ]
  function parsePiece() {
    if (!parseAtom())
      return false;
    const ch = pattern[i];
    if (ch === '*' || ch === '+' || ch === '?') {
      out += ch;
      i++;
    }
    else if (ch === '{') { // range-quantifier = "{" QuantExact [ "," [ QuantExact ] ] "}"
      let j = i + 1;
      const first = j;
      while (j < n && pattern.charCodeAt(j) >= CC_0 && pattern.charCodeAt(j) <= CC_9)
        j++;
      if (j === first)
        return false;
      if (pattern[j] === ',') {
        j++;
        while (j < n && pattern.charCodeAt(j) >= CC_0 && pattern.charCodeAt(j) <= CC_9)
          j++;
      }
      if (pattern[j] !== '}')
        return false;
      out += pattern.slice(i, j + 1);
      i = j + 1;
    }
    return true;
  }

  // branch = *piece
  function parseBranch() {
    while (i < n) {
      const ch = pattern[i];
      if (ch === '|' || ch === ')')
        return true;
      if (!parsePiece())
        return false;
    }
    return true;
  }

  // i-regexp = branch *( "|" branch )
  function parseAlternation() {
    if (!parseBranch())
      return false;
    while (pattern[i] === '|') {
      out += '|';
      i++;
      if (!parseBranch())
        return false;
    }
    return true;
  }

  return (parseAlternation() && i === n) ? out : null;
}

/**
 * Compile an I-Regexp into an ECMAScript RegExp.
 * @param {string} pattern - The I-Regexp pattern
 * @param {boolean} fullMatch - Anchor for match() (true) or leave free for search() (false)
 * @returns {RegExp|null} null when the pattern is not a valid I-Regexp
 */
function iregexpToRegExp(pattern, fullMatch) {
  const translated = translateIRegexp(pattern);
  if (translated === null)
    return null;
  try {
    return new RegExp(fullMatch ? `^(?:${translated})$` : translated, 'u');
  }
  catch {
    return null;
  }
}

/**
 * Compile a singular query into a direct property walk.
 * @returns {(current: any, root: any) => any} getter returning the value or NOTHING
 */
function compileSingularGetter(segments, relative) {
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

function runSegmentsV(segs, start, root) {
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

function compileExists(query) {
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
    const re = iregexpToRegExp(patternArg.value, fullMatch);
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
      lastRegExp = iregexpToRegExp(p, fullMatch);
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
function compileLogicalExpr(expr) {
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

function compileSelectorNodeV(sel) {
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

function descendV(v, output, root, apply) {
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
function compileSegmentV(seg) {
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
