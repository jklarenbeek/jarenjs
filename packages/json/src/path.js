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
//     tests on singular queries never materialize nodelists. A `$`-rooted
//     comparable is memoized per filter application (its value is invariant
//     across the candidates), with the memo reset before each application so
//     a mutated document re-queried under the same root reads fresh.
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
  runSegmentsV,
  compileSegmentG,
  runSegmentsG,
  compileSegmentP,
  runSegmentsP,
  scanArrayIndex,
  appendName,
} from './segments.js';
import {
  parseJSONPointer,
  encodeJSONPointerSegment,
} from './pointer.js';
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
  isNameStartCode,
  isNameCharCode,
} from '@jarenjs/core/scan';
import { deepFreeze } from '@jarenjs/core/object';
import { createBoundedCache, createWeakCache } from '@jarenjs/core/cache';
import { LabeledSyntaxError } from './errors.js';

/**
 * Sentinel for the absence of a value ("Nothing" in RFC 9535 terms), as
 * distinct from the JSON value `null`.
 */
export const JSONPATH_NOTHING = NOTHING;

/**
 * Error thrown when a JSONPath query is not valid RFC 9535 syntax
 * (including queries that are not well-typed per section 2.4.3).
 */
export class JSONPathSyntaxError extends LabeledSyntaxError {
  constructor(message, source, position) {
    super('JSONPathSyntaxError', 'JSONPath', message, source, position);
  }
}

// Built-in function extensions (RFC 9535 section 2.4).
// Parameter/return types: 'value' = ValueType, 'nodes' = NodesType,
// 'logical' = LogicalType. Null-prototype, so an inherited member name
// (`constructor`, `tostring`) is an unknown function and not a
// half-formed descriptor.
const FUNCTIONS = {
  __proto__: null,
  length: { params: ['value'], returns: 'value' },
  count: { params: ['nodes'], returns: 'value' },
  match: { params: ['value', 'value'], returns: 'logical' },
  search: { params: ['value', 'value'], returns: 'logical' },
  value: { params: ['nodes'], returns: 'value' },
};

// function-name = LCALPHA *(LCALPHA / "_" / DIGIT)   (RFC 9535 2.4.1)
const RE_FUNCTION_NAME = /^[a-z][a-z0-9_]*$/;
const TYPE_NAMES = ['value', 'nodes', 'logical'];

// Registries are validated once and memoized on the registry object, so
// compiling a thousand queries against one registry validates it once.
const FUNCTION_TABLES = new WeakMap();

function registryError(message) {
  return new TypeError(`options.pathFunctions: ${message}`);
}

function validateType(type, what) {
  if (!TYPE_NAMES.includes(type))
    throw registryError(`${what} must be one of ${TYPE_NAMES.join(', ')}`);
}

/**
 * Validate a registry of custom function extensions and merge it over
 * the built-ins. A registry entry declares its parameter and result
 * types exactly like a built-in, which is what lets the parser apply
 * the same well-typedness rules (RFC 9535 section 2.4.3) to it.
 * @param {object} functions - name to `{ params, returns, evaluate }`
 * @returns {object} the merged, null-prototype function table
 */
function resolveFunctionTable(functions) {
  const cached = FUNCTION_TABLES.get(functions);
  if (cached !== undefined)
    return cached;
  const table = { __proto__: null, ...FUNCTIONS };
  for (const name of Object.keys(functions)) {
    const def = functions[name];
    if (!RE_FUNCTION_NAME.test(name))
      throw registryError(`'${name}' is not a valid function name`);
    // section 2.4.1: an extension must not redefine a built-in, and a
    // literal keyword would be unreadable as a call
    if (FUNCTIONS[name] !== undefined)
      throw registryError(`'${name}' is a built-in function`);
    if (name === 'true' || name === 'false' || name === 'null')
      throw registryError(`'${name}' is a literal, not a function name`);
    if (def === null || typeof def !== 'object')
      throw registryError(`'${name}' must be a { params, returns, evaluate } object`);
    if (!Array.isArray(def.params))
      throw registryError(`'${name}'.params must be an array of parameter types`);
    for (let i = 0; i < def.params.length; i++)
      validateType(def.params[i], `'${name}'.params[${i}]`);
    validateType(def.returns, `'${name}'.returns`);
    if (typeof def.evaluate !== 'function')
      throw registryError(`'${name}'.evaluate must be a function`);
    table[name] = {
      params: [...def.params],
      returns: def.returns,
      evaluate: def.evaluate,
    };
  }
  Object.freeze(table);
  FUNCTION_TABLES.set(functions, table);
  return table;
}

// Resolve the function table a parse should use. The overwhelmingly
// common call has no options at all and reaches the built-ins directly.
function functionTableOf(options) {
  if (options == null)
    return FUNCTIONS;
  const functions = options.pathFunctions;
  if (functions == null)
    return FUNCTIONS;
  if (typeof functions !== 'object' || Array.isArray(functions))
    throw registryError('must be a plain object of function extensions');
  return resolveFunctionTable(functions);
}

//#endregion

//#region parser

/**
 * Selects a named object member (RFC 9535 name selector).
 * @typedef {Object} JSONPathNameSelector
 * @property {'name'} kind - Discriminator
 * @property {string} name - The member name to select
 */

/**
 * Selects all members of an object / all elements of an array
 * (RFC 9535 wildcard selector).
 * @typedef {Object} JSONPathWildcardSelector
 * @property {'wildcard'} kind - Discriminator
 */

/**
 * Selects an array element by index; negative indexes count from the end
 * (RFC 9535 index selector).
 * @typedef {Object} JSONPathIndexSelector
 * @property {'index'} kind - Discriminator
 * @property {number} index - The array index to select
 */

/**
 * Selects a range of array elements (RFC 9535 array slice selector).
 * `null` means the bound was omitted in the query.
 * @typedef {Object} JSONPathSliceSelector
 * @property {'slice'} kind - Discriminator
 * @property {number | null} start - Slice start, or null when omitted
 * @property {number | null} end - Slice end (exclusive), or null when omitted
 * @property {number | null} step - Slice step, or null when omitted
 */

/**
 * Selects children for which a filter expression yields a truthy result
 * (RFC 9535 filter selector).
 * @typedef {Object} JSONPathFilterSelector
 * @property {'filter'} kind - Discriminator
 * @property {object} expr - The parsed filter expression tree
 */

/**
 * Any RFC 9535 selector, discriminated by its `kind` property.
 * @typedef {JSONPathNameSelector | JSONPathWildcardSelector | JSONPathIndexSelector | JSONPathSliceSelector | JSONPathFilterSelector} JSONPathSelector
 */

/**
 * One segment of a JSONPath query: a child (`.` / `[...]`) or descendant
 * (`..`) step holding one or more selectors.
 * @typedef {Object} JSONPathSegment
 * @property {boolean} descendant - True for a descendant (`..`) segment
 * @property {JSONPathSelector[]} selectors - The segment's selectors
 */

/**
 * The parsed AST of a JSONPath query.
 * @typedef {Object} JSONPathAst
 * @property {boolean} relative - True for a relative query (`@`), false for a root query (`$`)
 * @property {JSONPathSegment[]} segments - The query's segments in order
 */

/**
 * One result of a JSONPath query in nodes mode: the matched value together
 * with its normalized path (RFC 9535 section 2.7).
 * @typedef {Object} JSONPathNode
 * @property {string} path - The normalized path (e.g. `$['store']['book'][0]`)
 * @property {any} value - The matched value
 */

/**
 * A compiled JSONPath query. Calling it returns the matched values; the
 * attached methods expose the other result modes, and `source`/`ast`
 * expose the original query string and its parsed (deeply frozen) AST.
 * @typedef {((data: any) => any[]) & {
 *   values: (data: any) => any[],
 *   first: (data: any) => any,
 *   exists: (data: any) => boolean,
 *   iterate: (data: any) => Generator<any>,
 *   nodes: (data: any) => JSONPathNode[],
 *   paths: (data: any) => string[],
 *   source: string,
 *   ast: JSONPathAst,
 * }} JSONPathQuery
 */

/**
 * A custom JSONPath function extension (RFC 9535 section 2.4). The
 * declared types are what the parser type-checks call sites against
 * (section 2.4.3), exactly as it does for the five built-ins.
 *
 * `evaluate` receives one argument per declared parameter: a `value`
 * parameter arrives as a JSON value or `JSONPATH_NOTHING`, a `nodes`
 * parameter as an array of the selected values, a `logical` parameter
 * as a boolean. Its result must match `returns` - a `value` function
 * may return `undefined` to mean Nothing.
 * @typedef {Object} JSONPathFunction
 * @property {('value'|'nodes'|'logical')[]} params - Declared parameter types
 * @property {'value'|'nodes'|'logical'} returns - Declared result type
 * @property {(...args: any[]) => any} evaluate - The implementation
 */

/**
 * Options accepted by the JSONPath entry points.
 * @typedef {Object} JSONPathOptions
 * @property {Record<string, JSONPathFunction>} [pathFunctions] - Custom
 *   function extensions, by name. A name must match the RFC's
 *   `function-name` production and must not redefine a built-in.
 */

/**
 * Parse a JSONPath query string into an AST.
 * @param {string} source - The JSONPath expression (e.g. `$.store.book[?@.price < 10].title`)
 * @param {JSONPathOptions} [options] - Parse options
 * @returns {JSONPathAst} The parsed query AST
 * @throws {JSONPathSyntaxError} When the query violates the RFC 9535 grammar
 * @throws {TypeError} When `options.pathFunctions` is not a valid registry
 */
export function parseJSONPath(source, options = undefined) {
  if (typeof source !== 'string')
    throw new JSONPathSyntaxError('query must be a string', String(source), 0);

  const FUNCS = functionTableOf(options);
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
    if (!isNameStartCode(cc(pos)))
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
    const def = FUNCS[name];
    if (def === undefined)
      fail(`unknown function '${name}'`, at);
    pos++; // consume '('
    skipWS();
    const args = [];
    if (cc(pos) !== CC_RPAREN) {
      for (;;) {
        // argument parsing is type-directed: a LogicalType parameter
        // takes the whole logical-expr production (RFC 9535 2.4.3), so
        // `!`, `(`, comparisons and `&&`/`||` are only legal there
        args.push(def.params[args.length] === 'logical'
          ? { kind: 'logical', expr: parseLogicalOr() }
          : parseFunctionArg());
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
      else if (param === 'nodes') {
        if (arg.kind === 'query')
          continue;
        if (arg.kind === 'func' && arg.returns === 'nodes')
          continue;
        fail(`argument ${i + 1} of '${name}' must be a query (NodesType)`, at);
      }
      // 'logical': parseLogicalOr only produces well-typed logical
      // expressions, and it already rejects a ValueType function there
    }
    const node = { kind: 'func', name, args, returns: def.returns };
    if (def.evaluate !== undefined) {
      node.params = def.params;
      node.evaluate = def.evaluate;
    }
    return node;
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

// The nodes-mode segment compilers (normalized paths, RFC 9535 section
// 2.7) live in segments.js next to the values-mode ones; nodes mode is
// still compiled lazily here (see compileJSONPath), so value-only
// queries never pay for path-string building.

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
 * - `query.iterate(data)` - a generator yielding matched values on
 *   demand, in document order; `first`/`exists` are one pull of it, so
 *   none of the three builds a nodelist it does not need
 * - `query.nodes(data)` - array of `{ path, value }` with normalized paths
 * - `query.paths(data)` - array of normalized paths (RFC 9535 section 2.7)
 * - `query.source` - the original query string
 * - `query.ast` - the parsed query AST (deeply frozen; the lazily
 *   compiled path mode must agree with the eagerly compiled value mode)
 *
 * @param {string} source - The JSONPath expression
 * @param {JSONPathOptions} [options] - Compile options
 * @returns {JSONPathQuery} The compiled query function
 * @throws {JSONPathSyntaxError} When the query is not valid RFC 9535
 * @throws {TypeError} When `options.pathFunctions` is not a valid registry
 * @example
 * const q = compileJSONPath('$.store.book[?@.price < 10].title');
 * q(data); // ['Sayings of the Century', 'Moby Dick']
 * q.paths(data); // ["$['store']['book'][0]['title']", ...]
 */
export function compileJSONPath(source, options = undefined) {
  const ast = deepFreeze(parseJSONPath(source, options));
  const segments = ast.segments;

  let values, first, exists, iterate;
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
    iterate = function* iterateSingular(data) {
      const v = getter(data, data);
      if (v !== NOTHING)
        yield v;
    };
  }
  else {
    const segs = segments.map(compileSegmentV);
    values = (data) => runSegmentsV(segs, data, data);
    // the lazy chain is a second compilation of the same selectors, so
    // it is built on first use - a query that only ever calls values()
    // never pays for it
    let gens = null;
    iterate = (data) => {
      if (gens === null)
        gens = segments.map(compileSegmentG);
      return runSegmentsG(gens, 0, data, data);
    };
    first = (data) => {
      const r = iterate(data).next();
      return r.done ? undefined : r.value;
    };
    exists = (data) => !iterate(data).next().done;
  }

  // nodes mode is compiled lazily; value-only queries never pay for it
  let segsP = null;
  function runNodes(data) {
    if (segsP === null)
      segsP = segments.map(compileSegmentP);
    return runSegmentsP(segsP, data, '$', data);
  }

  const query = (data) => values(data);
  query.values = values;
  query.first = first;
  query.exists = exists;
  query.iterate = iterate;
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

const QUERY_CACHE = createBoundedCache(512);
// One cache per registry, because the same source compiles differently
// under different extensions; keyed weakly so a registry that goes out
// of scope takes its compiled queries with it. A WeakMap of bounded
// caches — the two axes of `@jarenjs/core/cache`, composed.
const REGISTRY_CACHES = createWeakCache();
const boundedCacheFor = () => createBoundedCache(512);

/**
 * Apply a JSONPath query to a JSON value in one call. Compiled queries
 * are cached (bounded LRU, 512 entries), so repeated calls with the
 * same query string reuse the compiled function. A query compiled
 * against a function-extension registry is cached under that registry.
 * @param {string} source - The JSONPath expression
 * @param {any} data - The JSON value to query
 * @param {JSONPathOptions} [options] - Compile options
 * @returns {any[]} Array of matched values
 * @throws {JSONPathSyntaxError} When the query is not valid RFC 9535
 */
export function queryJSONPath(source, data, options = undefined) {
  const functions = options == null ? null : options.pathFunctions;
  const cache = functions == null
    ? QUERY_CACHE
    : REGISTRY_CACHES.getOrCreate(functions, boundedCacheFor);
  const query = cache.getOrCreate(source, (src) => compileJSONPath(src, options));
  return query(data);
}

/**
 * Validates a JSONPath expression strictly against the RFC 9535 grammar,
 * including well-typedness of function expressions. Unlike the heuristic
 * `isValidJSONPath` in basic.js, this uses the full parser.
 *
 * Without options this recognizes the five built-in functions and
 * nothing else, which is what the registered `json-path` string format
 * asserts: a format is a property of the string itself, so it must mean
 * the same thing in every schema, independent of which extensions some
 * host happens to have installed. Pass `options.pathFunctions` to
 * validate against a registry instead - a host that wants its
 * extensions asserted registers a tester bound to them.
 *
 * @param {string} str - The JSONPath expression to validate
 * @param {JSONPathOptions} [options] - Compile options
 * @returns {boolean} True when the string is a valid RFC 9535 query
 * @example
 * isValidJSONPathStrict('$.store.book[?@.price < 10]'); // true
 * isValidJSONPathStrict('$.store.book[0 5]'); // false
 * isValidJSONPathStrict('@.name'); // false (queries start at $)
 */
export function isValidJSONPathStrict(str, options = undefined) {
  if (typeof str !== 'string')
    return false;
  try {
    parseJSONPath(str, options);
    return true;
  }
  catch (error) {
    // a malformed registry is the host's bug, not the string's
    if (!(error instanceof JSONPathSyntaxError))
      throw error;
    return false;
  }
}

/**
 * The head of a variable-rooted path string: `$` followed by a variable
 * name. The Jaren query format writes a path relative to a bound
 * variable as `$name` plus ordinary RFC 9535 segments, and the query
 * normalizer splits on exactly this production - so schema-time
 * validation and compile-time parsing agree on where the segments start.
 */
export const RE_JSONPATH_VARIABLE_HEAD = /^\$([A-Za-z_][A-Za-z0-9_]*)/;

/**
 * Validates a variable-rooted path string: `$name`, optionally followed
 * by RFC 9535 segments (`$book.price`, `$b[?@.isbn]`, `$item`).
 *
 * This is the counterpart of `isValidJSONPathStrict` for paths whose
 * root is a bound variable rather than the document. Such a string is
 * not a valid RFC 9535 query - the RFC's root identifier is `$` alone -
 * so it can only be checked by recognizing the head and validating the
 * tail as segments, which is what the query normalizer does before it
 * raises `JQ0004`. Without this, a schema could only pattern-check the
 * head and had to leave the segment grammar to the compiler.
 *
 * @param {string} str - The variable-rooted path string to validate
 * @param {JSONPathOptions} [options] - Parse options
 * @returns {boolean} True when the string is a well-formed variable-rooted path
 * @example
 * isValidJSONPathSegments('$book.price'); // true
 * isValidJSONPathSegments('$book'); // true (no segments)
 * isValidJSONPathSegments('$book.price['); // false (unterminated segment)
 * isValidJSONPathSegments('$.price'); // false (no variable name; that is json-path)
 */
export function isValidJSONPathSegments(str, options = undefined) {
  if (typeof str !== 'string')
    return false;
  const head = RE_JSONPATH_VARIABLE_HEAD.exec(str);
  if (head === null)
    return false;
  const rest = str.slice(head[0].length);
  if (rest === '')
    return true;
  try {
    // the tail is validated by parsing it under a substituted root,
    // exactly as the normalizer compiles it
    parseJSONPath('$' + rest, options);
    return true;
  }
  catch (error) {
    if (!(error instanceof JSONPathSyntaxError))
      throw error;
    return false;
  }
}

//#endregion

//#region normalized path <-> JSON Pointer bridge

/**
 * Convert a singular JSONPath query - which includes every RFC 9535
 * normalized path - to an RFC 6901 JSON Pointer, so the two addressing
 * standards compose.
 *
 * Any singular form is accepted (`$['store']['book'][0]`, `$.store.book[0]`);
 * non-singular queries and negative (from-the-end) indexes are rejected,
 * because a pointer cannot express them.
 *
 * @param {string} source - A singular JSONPath query
 * @returns {string} The equivalent JSON Pointer
 * @throws {JSONPathSyntaxError} When the query is invalid, not singular,
 *   or uses a negative index
 * @example
 * jsonPointerFromJSONPath("$['store']['book'][0]['a/b']"); // '/store/book/0/a~1b'
 */
export function jsonPointerFromJSONPath(source) {
  const { segments } = parseJSONPath(source);
  if (!isSingularSegments(segments))
    throw new JSONPathSyntaxError('only a singular query converts to a JSON Pointer', source, 0);
  let pointer = '';
  for (let i = 0; i < segments.length; i++) {
    const sel = segments[i].selectors[0];
    if (sel.kind === 'name') {
      pointer += '/' + encodeJSONPointerSegment(sel.name);
    }
    else {
      if (sel.index < 0)
        throw new JSONPathSyntaxError('a negative index has no JSON Pointer form', source, 0);
      pointer += '/' + sel.index;
    }
  }
  return pointer;
}

/**
 * Convert an RFC 6901 JSON Pointer to an RFC 9535 normalized path.
 *
 * A pointer token is one text with two readings (RFC 6901 lets `"2"`
 * address both a `"2"` member and array element 2); a normalized path
 * must pick one. Convention: a token that is a valid array index (digits,
 * no leading zeros) becomes an index selector `[2]`, everything else a
 * name selector `['name']`. A pointer addressing an object member that
 * merely looks like an index is therefore converted to the index form -
 * convert with the document in hand (e.g. via `query.paths`) when that
 * distinction matters.
 *
 * @param {string} pointer - The JSON Pointer (e.g. `/store/book/0`)
 * @returns {string} The normalized path (e.g. `$['store']['book'][0]`)
 * @throws {JSONPointerSyntaxError} When the pointer is not valid RFC 6901
 * @example
 * jsonPathFromJSONPointer('/store/book/0'); // "$['store']['book'][0]"
 */
export function jsonPathFromJSONPointer(pointer) {
  const segments = parseJSONPointer(pointer);
  let path = '$';
  for (let i = 0; i < segments.length; i++) {
    const name = segments[i];
    const index = scanArrayIndex(name, 0, name.length);
    path = index >= 0 ? path + '[' + index + ']' : appendName(path, name);
  }
  return path;
}

//#endregion

//#endregion
