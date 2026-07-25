//#region XQuery text front-end (XQUERY-FRONTEND.md)
// parseXQuery: a strict, single-pass recursive-descent parser (char-code
// level, the path.js discipline) for a defined subset of XQuery 3.1 text
// syntax, emitting Jaren JSON Query documents (QUERY-FORMAT.md). This is
// a front-end only: the JSON query document stays the canonical language
// and compileJsonQuery the only engine - the parser never evaluates
// anything and never emits an invalid document.
//
// Everything outside the subset fails with a named, positioned
// XQuerySyntaxError. The `unsupported ...` message prefixes are the
// classification signal for compliance tooling (the QT3 harness) - keep
// them stable:
//
//   - `unsupported construct '<name>'`  - a recognized XQuery construct
//     outside the subset (instance of, path expressions, typeswitch, ...)
//   - `unsupported function '<name>'` / `'<name>#<arity>'` - a function
//     (or an arity of one) outside the mapping table
//   - `unsupported clause order: ...` - a FLWOR clause sequence that
//     cannot be expressed by mechanically nesting phrases (section below)
//   - `unsupported variable name '<name>'` / `unsupported lookup index 0`
//
// 1-based/0-based rule (D6, documented in XQUERY-FRONTEND.md): positional
// *inputs* are adjusted at parse time so XQuery text means what it says
// (`?N` lookups, substring/subsequence starts, array:get indexes emit
// N-1); positional *outputs* keep the JSON format's 0-based convention
// (`at $i`, `count $c`, fn:index-of results).

//#region imports & shared tables

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
  CC_COLON,
  CC_LT,
  CC_EQ,
  CC_GT,
  CC_QUESTION,
  CC_AT,
  CC_LBRACKET,
  CC_RBRACKET,
  CC_PIPE,
  isDigitCode,
  isNameStartCode,
  isNameCharCode,
} from '@jarenjs/core/scan';

const CC_HASH = 0x23;
const CC_PERCENT = 0x25;
const CC_PLUS = 0x2B;
const CC_SEMICOLON = 0x3B;
const CC_BACKTICK = 0x60;
const CC_LBRACE = 0x7B;
const CC_RBRACE = 0x7D;

const hasOwn = Object.hasOwn;

/**
 * Error thrown when XQuery text is not valid for the supported subset -
 * either invalid XQuery 3.1 syntax or a recognized construct outside the
 * subset (mirrors JSONPathSyntaxError: `source` and `position` locate the
 * offending token).
 */
export class XQuerySyntaxError extends SyntaxError {
  constructor(message, source, position) {
    super(`Invalid XQuery: ${message} at position ${position} in '${source}'`);
    this.name = 'XQuerySyntaxError';
    this.source = source;
    this.position = position;
  }
}

// value comparisons map onto the same operators as general comparisons -
// a documented front-end approximation (singleton inputs behave
// identically; see XQUERY-FRONTEND.md)
const VALUE_COMPS = Object.freeze({
  eq: '$eq', ne: '$ne', lt: '$lt', le: '$le', gt: '$gt', ge: '$ge',
});

// keywords that can never start an expression in the subset; produces a
// clearer error than the generic path-expression one
const EXPR_KEYWORDS = new Set([
  'for', 'let', 'some', 'every', 'if', 'then', 'else', 'return', 'where',
  'order', 'group', 'stable', 'count', 'satisfies', 'in', 'at', 'to',
  'and', 'or', 'div', 'idiv', 'mod', 'union', 'intersect', 'except',
  'instance', 'treat', 'castable', 'cast', 'is', 'case', 'default',
  'ascending', 'descending', 'least', 'greatest', 'collation', 'empty',
  'allowing', 'by', 'declare', 'import', 'module', 'external', 'variable',
]);

// computed node constructor keywords (keyword followed by '{')
const NODE_CTOR_KEYWORDS = new Set([
  'element', 'attribute', 'text', 'comment', 'document', 'namespace',
  'processing-instruction',
]);

// FLWOR clause positions in the fixed semantic order of the JSON format
// (QUERY-FORMAT.md section 6.1, D7)
const CLAUSE_SLOT = Object.freeze({
  for: 0, let: 1, where: 2, groupby: 3, orderby: 4, count: 5,
});

const CLAUSE_LABEL = Object.freeze({
  for: 'for', let: 'let', where: 'where', groupby: 'group by',
  orderby: 'order by', count: 'count',
});

// sentinel for the '?*' wildcard lookup key
const STAR_KEY = Object.freeze({ star: true });

//#endregion

//#region function mapping table

// 1-based -> 0-based (D6) for positional *input* arguments: number
// literals fold at parse time, everything else subtracts at runtime.
// An integral shift commutes with the F&O round() the engine applies.
function toZeroBased(e) {
  return typeof e === 'number' ? e - 1 : { '$sub': [e, 1] };
}

function fnUnary(op) {
  return { min: 1, max: 1, emit: (args) => ({ [op]: args[0] }) };
}

function fnPair(op) {
  return { min: 2, max: 2, emit: (args) => ({ [op]: args }) };
}

// substring/subsequence: F&O's 1-based start becomes 0-based (D6);
// the optional length argument is a count and passes through unchanged
function fnAdjustedStart(op) {
  return {
    min: 2, max: 3,
    emit: (args) => {
      const out = [args[0], toZeroBased(args[1])];
      if (args.length === 3)
        out.push(args[2]);
      return { [op]: out };
    },
  };
}

// The supported built-in functions (bare or `fn:`-prefixed), one entry
// per name: `{ min, max, emit(args) }` over already-emitted argument
// expressions. Arities outside [min, max] - including F&O arities that
// exist but are not in the subset, like fn:sum#2 or the 0-argument
// context-item forms - fail as `unsupported function 'name#arity'`.
const FN_TABLE = Object.freeze({
  'count': fnUnary('$count'),
  'sum': fnUnary('$sum'),
  'avg': fnUnary('$avg'),
  'min': fnUnary('$min'),
  'max': fnUnary('$max'),
  'exists': fnUnary('$exists'),
  'empty': fnUnary('$empty'),
  'not': fnUnary('$not'),
  'boolean': fnUnary('$boolean'),
  'string': fnUnary('$string'),
  'number': fnUnary('$number'),
  'reverse': fnUnary('$reverse'),
  'head': fnUnary('$head'),
  'tail': fnUnary('$tail'),
  'distinct-values': fnUnary('$distinct'),
  'upper-case': fnUnary('$upper'),
  'lower-case': fnUnary('$lower'),
  'string-length': fnUnary('$string-length'),
  'normalize-space': fnUnary('$normalize-space'),
  'contains': fnPair('$contains'),
  'starts-with': fnPair('$starts-with'),
  'ends-with': fnPair('$ends-with'),
  // fn:matches tests a *substring* match (F&O), which is `$search`;
  // `$match` is the anchored RFC 9535 match() - see XQUERY-FRONTEND.md
  'matches': fnPair('$search'),
  // fn:index-of *results* stay 0-based (D6) - the positional-output rule
  'index-of': fnPair('$index-of'),
  'concat': { min: 2, max: Infinity, emit: (args) => ({ '$concat': args }) },
  'string-join': { min: 1, max: 2, emit: (args) => ({ '$string-join': args }) },
  'replace': { min: 3, max: 3, emit: (args) => ({ '$replace': args }) },
  'substring': fnAdjustedStart('$substring'),
  'subsequence': fnAdjustedStart('$subsequence'),
  // XQuery has no boolean literals; fn:true()/fn:false() are the spelling
  'true': { min: 0, max: 0, emit: () => true },
  'false': { min: 0, max: 0, emit: () => false },
});

const MAP_FN_TABLE = Object.freeze({
  'get': { min: 2, max: 2, emit: (args) => ({ '$get': args }) },
});

const ARRAY_FN_TABLE = Object.freeze({
  // array:get's 1-based position becomes a 0-based (D6) $get index
  'get': { min: 2, max: 2, emit: (args) => ({ '$get': [args[0], toZeroBased(args[1])] }) },
});

//#endregion

//#region emission helpers

// Rule-2 escaping (QUERY-FORMAT.md section 3.2): a literal string that
// starts with '$' must be emitted with one extra leading '$'
function emitString(s) {
  return s.charCodeAt(0) === CC_DOLLAR ? '$' + s : s;
}

// own-property assignment for emitted objects keyed by user-controlled
// names: a plain `obj[name] =` would follow the prototype chain for
// '__proto__' and silently drop the member
function setMember(obj, name, value) {
  if (name === '__proto__')
    Object.defineProperty(obj, name, { value, enumerable: true, writable: true, configurable: true });
  else
    obj[name] = value;
}

// member names foldable into RFC 9535 dot shorthand; everything else
// (NCNames with '-', '.', or non-ASCII) uses the bracketed name selector.
// NCNames can never contain a quote or backslash, so no escaping needed.
const SHORTHAND_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// `{"$seq": []}` - the emitted form of '()' (used to fold `else ()`)
function isEmptySeqExpr(e) {
  if (typeof e !== 'object' || e === null || Array.isArray(e))
    return false;
  const keys = Object.keys(e);
  return keys.length === 1 && keys[0] === '$seq'
    && Array.isArray(e.$seq) && e.$seq.length === 0;
}

//#endregion

//#region parser

// XML NameChar, pragmatically: name start, digits, '-' and '.'
function isXmlNameCharCode(c) {
  return isNameCharCode(c) || c === CC_MINUS || c === CC_DOT;
}

/**
 * Parse XQuery 3.1 text (the supported subset, see XQUERY-FRONTEND.md)
 * into a Jaren JSON Query document.
 * @param {string} source - the XQuery text (e.g. `for $b in $doc?store?book?* return $b?title`)
 * @returns {any} a valid query document for `compileJsonQuery` (envelope omitted)
 * @throws {XQuerySyntaxError} when the text is invalid or uses a construct
 *   outside the subset (named `unsupported ...` messages)
 */
export function parseXQuery(source) {
  if (typeof source !== 'string')
    throw new XQuerySyntaxError('query must be a string', String(source), 0);

  const len = source.length;
  let pos = 0;

  function fail(message, at = pos) {
    throw new XQuerySyntaxError(message, source, at);
  }

  function cc(at) {
    return at < len ? source.charCodeAt(at) : -1;
  }

  // whitespace and nestable (: ... :) comments (XQuery A.2.1 ws:explicit
  // does not occur in the subset, so comments are legal between any two
  // tokens and are handled uniformly here)
  function skipWS() {
    while (pos < len) {
      const c = source.charCodeAt(pos);
      if (c === CC_SPACE || c === CC_TAB || c === CC_LF || c === CC_CR) {
        pos++;
        continue;
      }
      if (c === CC_LPAREN && cc(pos + 1) === CC_COLON) {
        const start = pos;
        pos += 2;
        let depth = 1;
        while (depth > 0) {
          if (pos >= len)
            fail('unterminated comment', start);
          const d = source.charCodeAt(pos);
          if (d === CC_LPAREN && cc(pos + 1) === CC_COLON) {
            depth++;
            pos += 2;
          }
          else if (d === CC_COLON && cc(pos + 1) === CC_RPAREN) {
            depth--;
            pos += 2;
          }
          else {
            pos++;
          }
        }
        continue;
      }
      break;
    }
  }

  //#region scalar tokens

  function parseNCName() {
    const start = pos;
    if (!isNameStartCode(cc(pos)))
      fail('expected a name');
    while (pos < len) {
      const c = source.charCodeAt(pos);
      if (c >= 0xD800 && c <= 0xDFFF) {
        // raw surrogates must form a well-formed pair
        const d = cc(pos + 1);
        if (c >= 0xDC00 || d < 0xDC00 || d > 0xDFFF)
          fail('lone surrogate in name');
        pos += 2;
        continue;
      }
      if (!isXmlNameCharCode(c))
        break;
      pos++;
    }
    return source.slice(start, pos);
  }

  // reads the NCName at pos when it equals `word` (consuming it),
  // returning its start position; -1 otherwise (nothing consumed)
  function tryKeyword(word) {
    const save = pos;
    skipWS();
    if (isNameStartCode(cc(pos))) {
      const at = pos;
      if (parseNCName() === word)
        return at;
    }
    pos = save;
    return -1;
  }

  function expectKeyword(word) {
    skipWS();
    const at = pos;
    if (!isNameStartCode(cc(pos)) || parseNCName() !== word)
      fail(`expected '${word}'`, at);
  }

  // variable name after a consumed '$' ('$' is a delimiting terminal, so
  // whitespace and comments may separate it from the name): an NCName
  // restricted to the JSON format's variable lexeme [A-Za-z_][A-Za-z0-9_]*
  // (JQ0003 rule) - an NCName like `foo-bar` or `a.b` is valid XQuery but
  // cannot map
  function parseVarName() {
    skipWS();
    const at = pos;
    const name = parseNCName();
    if (name === 'Q' && cc(pos) === CC_LBRACE)
      fail("unsupported construct 'URI-qualified name'", at);
    if (cc(pos) === CC_COLON && isNameStartCode(cc(pos + 1)))
      fail("unsupported construct 'namespaced variable'", at);
    if (!VAR_NAME_RE.test(name))
      fail(`unsupported variable name '${name}'`, at);
    return name;
  }

  // string literal, both quote kinds, doubled-quote escape; `&` character
  // and entity references are outside the subset
  function parseStringLiteral() {
    const quote = source.charCodeAt(pos);
    const start = pos;
    pos++;
    let out = '';
    let chunk = pos;
    while (pos < len) {
      const c = source.charCodeAt(pos);
      if (c === quote) {
        if (cc(pos + 1) === quote) { // '' / "" escape
          out += source.slice(chunk, pos + 1);
          pos += 2;
          chunk = pos;
          continue;
        }
        out += source.slice(chunk, pos);
        pos++;
        return out;
      }
      if (c === CC_AMP)
        fail("unsupported construct 'character reference'", pos);
      if (c >= 0xD800 && c <= 0xDFFF) {
        const d = cc(pos + 1);
        if (c >= 0xDC00 || d < 0xDC00 || d > 0xDFFF)
          fail('lone surrogate in string literal');
        pos += 2;
        continue;
      }
      pos++;
    }
    return fail('unterminated string literal', start);
  }

  // IntegerLiteral | DecimalLiteral | DoubleLiteral (XQuery A.2 - unlike
  // JSON: leading zeros, '1.' and '.5' are all legal; no sign). The value
  // is emitted as a JSON number, so only the double's value survives.
  function parseNumberLiteral() {
    const start = pos;
    if (cc(pos) === CC_DOT) {
      pos++; // callers guarantee a digit follows
      while (isDigitCode(cc(pos)))
        pos++;
    }
    else {
      while (isDigitCode(cc(pos)))
        pos++;
      if (cc(pos) === CC_DOT) {
        pos++;
        while (isDigitCode(cc(pos)))
          pos++;
      }
    }
    const e = cc(pos);
    if (e === 0x65 || e === 0x45) { // e | E
      pos++;
      const s = cc(pos);
      if (s === CC_PLUS || s === CC_MINUS)
        pos++;
      if (!isDigitCode(cc(pos)))
        fail('expected a digit in the exponent');
      while (isDigitCode(cc(pos)))
        pos++;
    }
    // XQuery A.2.2: a numeric literal must not be followed directly by
    // '.' or a name start character (e.g. `10div 3` is not `10 div 3`)
    const n = cc(pos);
    if (n === CC_DOT || isNameStartCode(n))
      fail('a numeric literal must be followed by a delimiter');
    const value = Number(source.slice(start, pos));
    // an overflowing DoubleLiteral is a valid XQuery double (INF) but has
    // no JSON literal form - the parser must never emit an invalid document
    if (!Number.isFinite(value))
      fail("unsupported construct 'non-finite number literal'", start);
    return value;
  }

  //#endregion

  //#region expressions by precedence

  // Expr ::= ExprSingle ("," ExprSingle)* - the XQuery comma is $seq
  function parseExpr() {
    const first = parseExprSingle();
    skipWS();
    if (cc(pos) !== CC_COMMA)
      return first;
    const items = [first];
    while (cc(pos) === CC_COMMA) {
      pos++;
      items.push(parseExprSingle());
      skipWS();
    }
    return { '$seq': items };
  }

  // ExprSingle ::= FLWORExpr | QuantifiedExpr | IfExpr | OrExpr
  // (SwitchExpr, TypeswitchExpr and TryCatchExpr are recognized and
  // rejected by name)
  function parseExprSingle() {
    skipWS();
    const at = pos;
    if (isNameStartCode(cc(pos))) {
      const save = pos;
      const ident = parseNCName();
      skipWS();
      const next = cc(pos);
      if (ident === 'for' || ident === 'let') {
        if (next === CC_DOLLAR)
          return parseFlwor(ident);
        if (ident === 'for' && isNameStartCode(next)) {
          const save2 = pos;
          const w = parseNCName();
          pos = save2;
          if (w === 'sliding' || w === 'tumbling')
            fail("unsupported construct 'window clause'", at);
        }
      }
      else if ((ident === 'some' || ident === 'every') && next === CC_DOLLAR) {
        return parseQuantified(ident);
      }
      else if (ident === 'if' && next === CC_LPAREN) {
        return parseIf();
      }
      else if ((ident === 'switch' || ident === 'typeswitch') && next === CC_LPAREN) {
        fail(`unsupported construct '${ident} expression'`, at);
      }
      else if (ident === 'try' && next === CC_LBRACE) {
        fail("unsupported construct 'try/catch expression'", at);
      }
      pos = save;
    }
    return parseOr();
  }

  function parseOr() {
    const first = parseAnd();
    let items = null;
    for (;;) {
      const save = pos;
      skipWS();
      if (isNameStartCode(cc(pos)) && parseNCName() === 'or') {
        if (items === null)
          items = [first];
        items.push(parseAnd());
        continue;
      }
      pos = save;
      return items === null ? first : { '$or': items };
    }
  }

  function parseAnd() {
    const first = parseComparison();
    let items = null;
    for (;;) {
      const save = pos;
      skipWS();
      if (isNameStartCode(cc(pos)) && parseNCName() === 'and') {
        if (items === null)
          items = [first];
        items.push(parseComparison());
        continue;
      }
      pos = save;
      return items === null ? first : { '$and': items };
    }
  }

  // ComparisonExpr ::= StringConcatExpr ((ValueComp | GeneralComp) StringConcatExpr)?
  // Value comparisons map onto the general-comparison operators (front-end
  // approximation); node comparisons (`is`, `<<`, `>>`) are unsupported.
  function parseComparison() {
    const left = parseStringConcat();
    const save = pos;
    skipWS();
    const at = pos;
    let op = null;
    const c = cc(pos);
    if (c === CC_EQ) {
      if (cc(pos + 1) === CC_GT)
        fail("unsupported construct 'arrow expression'", at);
      pos++;
      op = '$eq';
    }
    else if (c === CC_BANG) {
      if (cc(pos + 1) !== CC_EQ)
        fail("unsupported construct 'simple map operator'", at);
      pos += 2;
      op = '$ne';
    }
    else if (c === CC_LT) {
      if (cc(pos + 1) === CC_LT)
        fail("unsupported construct 'node comparison'", at);
      if (cc(pos + 1) === CC_EQ) {
        pos += 2;
        op = '$le';
      }
      else {
        pos++;
        op = '$lt';
      }
    }
    else if (c === CC_GT) {
      if (cc(pos + 1) === CC_GT)
        fail("unsupported construct 'node comparison'", at);
      if (cc(pos + 1) === CC_EQ) {
        pos += 2;
        op = '$ge';
      }
      else {
        pos++;
        op = '$gt';
      }
    }
    else if (isNameStartCode(c)) {
      const ident = parseNCName();
      if (hasOwn(VALUE_COMPS, ident))
        op = VALUE_COMPS[ident];
      else if (ident === 'is')
        fail("unsupported construct 'node comparison'", at);
      else {
        pos = save;
        return left;
      }
    }
    else {
      pos = save;
      return left;
    }
    skipWS();
    return { [op]: [left, parseStringConcat()] };
  }

  // StringConcatExpr ::= RangeExpr ("||" RangeExpr)* - variadic $concat.
  // A single '|' is the (unsupported) union operator.
  function parseStringConcat() {
    const first = parseRange();
    let items = null;
    for (;;) {
      const save = pos;
      skipWS();
      if (cc(pos) === CC_PIPE) {
        if (cc(pos + 1) === CC_PIPE) {
          pos += 2;
          if (items === null)
            items = [first];
          items.push(parseRange());
          continue;
        }
        fail("unsupported construct 'union expression'");
      }
      pos = save;
      return items === null ? first : { '$concat': items };
    }
  }

  // RangeExpr ::= AdditiveExpr ("to" AdditiveExpr)?
  function parseRange() {
    const first = parseAdditive();
    const save = pos;
    skipWS();
    if (isNameStartCode(cc(pos)) && parseNCName() === 'to')
      return { '$range': [first, parseAdditive()] };
    pos = save;
    return first;
  }

  function parseAdditive() {
    let expr = parseMultiplicative();
    for (;;) {
      const save = pos;
      skipWS();
      const c = cc(pos);
      if (c === CC_PLUS) {
        pos++;
        expr = { '$add': [expr, parseMultiplicative()] };
        continue;
      }
      if (c === CC_MINUS) {
        pos++;
        expr = { '$sub': [expr, parseMultiplicative()] };
        continue;
      }
      pos = save;
      return expr;
    }
  }

  // MultiplicativeExpr ::= UnaryExpr (("*" | "div" | "idiv" | "mod") UnaryExpr)*
  // The grammar levels between multiplicative and unary (union, intersect,
  // except, instance of, treat as, castable as, cast as, arrow) are all
  // outside the subset and rejected here by name.
  function parseMultiplicative() {
    let expr = parseUnary();
    for (;;) {
      const save = pos;
      skipWS();
      const at = pos;
      const c = cc(pos);
      if (c === CC_STAR) {
        pos++;
        expr = { '$mul': [expr, parseUnary()] };
        continue;
      }
      if (isNameStartCode(c)) {
        const ident = parseNCName();
        if (ident === 'div') {
          expr = { '$div': [expr, parseUnary()] };
          continue;
        }
        if (ident === 'idiv') {
          expr = { '$idiv': [expr, parseUnary()] };
          continue;
        }
        if (ident === 'mod') {
          expr = { '$mod': [expr, parseUnary()] };
          continue;
        }
        if (ident === 'instance')
          fail("unsupported construct 'instance of'", at);
        if (ident === 'treat')
          fail("unsupported construct 'treat as'", at);
        if (ident === 'castable')
          fail("unsupported construct 'castable as'", at);
        if (ident === 'cast')
          fail("unsupported construct 'cast as'", at);
        if (ident === 'union' || ident === 'intersect' || ident === 'except')
          fail(`unsupported construct '${ident} expression'`, at);
      }
      pos = save;
      return expr;
    }
  }

  // UnaryExpr ::= ("-" | "+")* ValueExpr. Unary '+' is a no-op in this
  // mapping; each '-' emits $neg, folding into number literals directly.
  function parseUnary() {
    skipWS();
    let c = cc(pos);
    if (c === CC_MINUS || c === CC_PLUS) {
      let negs = 0;
      while (c === CC_MINUS || c === CC_PLUS) {
        if (c === CC_MINUS)
          negs++;
        pos++;
        skipWS();
        c = cc(pos);
      }
      let expr = parsePostfix();
      for (let i = 0; i < negs; i++)
        expr = typeof expr === 'number' ? -expr : { '$neg': expr };
      return expr;
    }
    return parsePostfix();
  }

  //#endregion

  //#region postfix lookups & path folding

  // postfix operators outside the subset, each with a named error
  function checkUnsupportedPostfix(c) {
    if (c === CC_LPAREN)
      fail("unsupported construct 'dynamic function call'");
    if (c === CC_LBRACKET)
      fail("unsupported construct 'predicate'");
    if (c === CC_HASH)
      fail("unsupported construct 'named function reference'");
    if (c === CC_SLASH)
      fail("unsupported construct 'path expression'");
  }

  // '?' consumed: KeySpecifier ::= NCName | IntegerLiteral | "*"
  // (a ParenthesizedExpr key is outside the subset)
  function parseLookupKey() {
    skipWS();
    const c = cc(pos);
    if (c === CC_STAR) {
      pos++;
      return STAR_KEY;
    }
    if (isDigitCode(c))
      return { index: parseLookupIndex() };
    if (isNameStartCode(c))
      return { name: parseNCName() };
    if (c === CC_LPAREN)
      fail("unsupported construct 'parenthesized lookup key'");
    return fail('expected a lookup key');
  }

  function parseLookupIndex() {
    const at = pos;
    while (isDigitCode(cc(pos)))
      pos++;
    if (cc(pos) === CC_DOT || isNameStartCode(cc(pos)))
      fail('expected an integer lookup key', at);
    const n = Number(source.slice(at, pos));
    if (!Number.isSafeInteger(n))
      fail('integer out of interoperable range', at);
    if (n === 0)
      fail('unsupported lookup index 0 (XQuery arrays are 1-based)', at);
    return n - 1; // 1-based XQuery -> 0-based RFC 9535 (D6)
  }

  // PostfixExpr with the variable-rooted fold: `$b?price?1` becomes the
  // path string "$b.price[0]" (per-item lookup over the variable's
  // sequence, exactly the XQuery postfix-lookup rule); lookups on any
  // other base map to $get, which addresses a *single* item (documented
  // approximation). Unary lookup (`?name` on the context item) is
  // outside the subset via parsePrimary.
  function parsePostfix() {
    skipWS();
    if (cc(pos) === CC_DOLLAR) {
      pos++;
      const name = parseVarName();
      let segs = '';
      for (;;) {
        const save = pos;
        skipWS();
        const c = cc(pos);
        if (c === CC_QUESTION) {
          pos++;
          const key = parseLookupKey();
          if (key === STAR_KEY)
            segs += '[*]';
          else if (hasOwn(key, 'index'))
            segs += '[' + key.index + ']';
          else
            segs += SHORTHAND_RE.test(key.name) ? '.' + key.name : "['" + key.name + "']";
          continue;
        }
        checkUnsupportedPostfix(c);
        pos = save;
        return '$' + name + segs;
      }
    }
    let expr = parsePrimary();
    for (;;) {
      const save = pos;
      skipWS();
      const c = cc(pos);
      if (c === CC_QUESTION) {
        const at = pos;
        pos++;
        const key = parseLookupKey();
        if (key === STAR_KEY)
          fail("unsupported construct 'wildcard lookup on a non-variable expression'", at);
        expr = { '$get': [expr, hasOwn(key, 'index') ? key.index : key.name] };
        continue;
      }
      checkUnsupportedPostfix(c);
      pos = save;
      return expr;
    }
  }

  //#endregion

  //#region primary expressions

  function parsePrimary() {
    skipWS();
    const at = pos;
    const c = cc(pos);
    if (c === CC_SQUOTE || c === CC_DQUOTE)
      return emitString(parseStringLiteral());
    if (isDigitCode(c))
      return parseNumberLiteral();
    if (c === CC_DOT) {
      if (isDigitCode(cc(pos + 1)))
        return parseNumberLiteral();
      if (cc(pos + 1) === CC_DOT)
        fail("unsupported construct 'path expression'", at);
      fail("unsupported construct 'context item expression'", at);
    }
    if (c === CC_LPAREN)
      return parseParenthesized();
    if (c === CC_LBRACKET)
      return parseSquareArray();
    if (c === CC_QUESTION)
      fail("unsupported construct 'unary lookup'", at);
    if (c === CC_SLASH || c === CC_AT || c === CC_STAR)
      fail("unsupported construct 'path expression'", at);
    if (c === CC_LT)
      fail("unsupported construct 'node constructor'", at);
    if (c === CC_BACKTICK)
      fail("unsupported construct 'string constructor'", at);
    if (isNameStartCode(c))
      return parseNamedPrimary(at);
    return fail('expected an expression');
  }

  function parseParenthesized() {
    pos++; // consume '('
    skipWS();
    if (cc(pos) === CC_HASH)
      fail("unsupported construct 'pragma'", pos - 1);
    if (cc(pos) === CC_RPAREN) {
      pos++;
      return { '$seq': [] }; // '()' - the empty sequence
    }
    const expr = parseExpr();
    skipWS();
    if (cc(pos) !== CC_RPAREN)
      fail("expected ')'");
    pos++;
    return expr;
  }

  // SquareArrayConstructor `[a, b]`: each member expression becomes one
  // array-constructor element. The JSON array constructor flattens each
  // element's sequence, so a non-singleton member deviates from XQuery's
  // sequence-valued members (which JSON cannot hold) - documented.
  function parseSquareArray() {
    pos++; // consume '['
    skipWS();
    if (cc(pos) === CC_RBRACKET) {
      pos++;
      return [];
    }
    const items = [];
    for (;;) {
      items.push(parseExprSingle());
      skipWS();
      const c = cc(pos);
      if (c === CC_COMMA) {
        pos++;
        continue;
      }
      if (c === CC_RBRACKET) {
        pos++;
        return items;
      }
      fail("expected ',' or ']'");
    }
  }

  // CurlyArrayConstructor `array { E }`: the enclosed expression's
  // sequence flattens into the members - exactly the JSON array
  // constructor's behavior.
  function parseCurlyArray() {
    pos++; // consume '{'
    skipWS();
    if (cc(pos) === CC_RBRACE) {
      pos++;
      return [];
    }
    const items = [parseExprSingle()];
    for (;;) {
      skipWS();
      const c = cc(pos);
      if (c === CC_COMMA) {
        pos++;
        items.push(parseExprSingle());
        continue;
      }
      if (c === CC_RBRACE) {
        pos++;
        return items;
      }
      fail("expected ',' or '}'");
    }
  }

  // MapConstructor `map { K : V, ... }`: a plain-object map constructor
  // when every key is a string literal without a leading '$', else the
  // general `$map` form (computed keys evaluate at runtime, JQ2004).
  // Static keys that can never be strings, and duplicate literal keys
  // (XQDY0137), are rejected at parse time.
  function parseMapConstructor() {
    pos++; // consume '{'
    skipWS();
    if (cc(pos) === CC_RBRACE) {
      pos++;
      return {};
    }
    const keys = [];
    const values = [];
    const literals = []; // the literal string value per key, or null
    const seen = new Set();
    for (;;) {
      skipWS();
      const keyAt = pos;
      const literal = (cc(pos) === CC_SQUOTE || cc(pos) === CC_DQUOTE);
      const key = parseExprSingle();
      const scalarKey = typeof key === 'number' || typeof key === 'boolean' || key === null;
      if (scalarKey || Array.isArray(key))
        fail("unsupported construct 'non-string map key'", keyAt);
      if (literal && typeof key === 'string') {
        // a quoted key that parsed to a bare string is a literal (a
        // leading '$' would have been '$$'-escaped by emitString)
        const raw = key.charCodeAt(0) === CC_DOLLAR ? key.slice(1) : key;
        if (seen.has(raw))
          fail(`duplicate map key '${raw}'`, keyAt);
        seen.add(raw);
        literals.push(raw);
      }
      else {
        literals.push(null);
      }
      skipWS();
      if (cc(pos) !== CC_COLON)
        fail("expected ':'");
      pos++;
      keys.push(key);
      values.push(parseExprSingle());
      skipWS();
      const c = cc(pos);
      if (c === CC_COMMA) {
        pos++;
        continue;
      }
      if (c === CC_RBRACE) {
        pos++;
        break;
      }
      fail("expected ',' or '}'");
    }
    let plain = true;
    for (let i = 0; i < keys.length; i++) {
      if (literals[i] === null || literals[i].charCodeAt(0) === CC_DOLLAR) {
        plain = false;
        break;
      }
    }
    if (plain) {
      const out = {};
      for (let i = 0; i < keys.length; i++)
        setMember(out, keys[i], values[i]);
      return out;
    }
    const pairs = new Array(keys.length);
    for (let i = 0; i < keys.length; i++)
      pairs[i] = [keys[i], values[i]];
    return { '$map': pairs };
  }

  function parseNamedPrimary(at) {
    let name = parseNCName();
    let written = name;
    let prefix = null;
    if (cc(pos) === CC_COLON && isNameStartCode(cc(pos + 1))) {
      pos++;
      prefix = name;
      name = parseNCName();
      written = prefix + ':' + name;
    }
    skipWS();
    const next = cc(pos);
    if (next === CC_LPAREN) {
      if (prefix === null && name === 'function')
        fail("unsupported construct 'inline function expression'", at);
      pos++; // consume '('
      const args = parseArguments();
      return emitFunctionCall(prefix, name, written, args, at);
    }
    if (next === CC_HASH)
      fail("unsupported construct 'named function reference'", at);
    if (next === CC_LBRACE && prefix === null) {
      if (name === 'map')
        return parseMapConstructor();
      if (name === 'array')
        return parseCurlyArray();
      if (NODE_CTOR_KEYWORDS.has(name))
        fail("unsupported construct 'computed node constructor'", at);
      if (name === 'ordered' || name === 'unordered')
        fail(`unsupported construct '${name} expression'`, at);
      if (name === 'validate')
        fail("unsupported construct 'validate expression'", at);
    }
    if (prefix === null && name === 'function')
      fail("unsupported construct 'inline function expression'", at);
    if (prefix === null && EXPR_KEYWORDS.has(name))
      fail(`unexpected keyword '${name}'`, at);
    // a bare (or prefixed) name in expression position is an axis step
    return fail("unsupported construct 'path expression'", at);
  }

  function parseArguments() {
    skipWS();
    if (cc(pos) === CC_RPAREN) {
      pos++;
      return [];
    }
    const args = [];
    for (;;) {
      skipWS();
      if (cc(pos) === CC_QUESTION) {
        // a bare '?' argument is a partial-application placeholder
        const at = pos;
        const save = pos;
        pos++;
        skipWS();
        const c = cc(pos);
        pos = save;
        if (c === CC_COMMA || c === CC_RPAREN)
          fail("unsupported construct 'argument placeholder'", at);
        fail("unsupported construct 'unary lookup'", at);
      }
      args.push(parseExprSingle());
      skipWS();
      const c = cc(pos);
      if (c === CC_COMMA) {
        pos++;
        continue;
      }
      if (c === CC_RPAREN) {
        pos++;
        return args;
      }
      fail("expected ',' or ')'");
    }
  }

  function emitFunctionCall(prefix, local, written, args, at) {
    let table;
    if (prefix === null || prefix === 'fn')
      table = FN_TABLE;
    else if (prefix === 'map')
      table = MAP_FN_TABLE;
    else if (prefix === 'array')
      table = ARRAY_FN_TABLE;
    else
      return fail(`unsupported function '${written}'`, at);
    if (!hasOwn(table, local))
      return fail(`unsupported function '${written}'`, at);
    const def = table[local];
    if (args.length < def.min || args.length > def.max)
      return fail(`unsupported function '${written}#${args.length}'`, at);
    return def.emit(args);
  }

  //#endregion

  //#region if, quantifiers

  // IfExpr ::= "if" "(" Expr ")" "then" ExprSingle "else" ExprSingle
  // (`else ()` folds to the two-argument $if form)
  function parseIf() {
    pos++; // consume '('
    const cond = parseExpr();
    skipWS();
    if (cc(pos) !== CC_RPAREN)
      fail("expected ')'");
    pos++;
    expectKeyword('then');
    const thenExpr = parseExprSingle();
    expectKeyword('else');
    const elseExpr = parseExprSingle();
    if (isEmptySeqExpr(elseExpr))
      return { '$if': [cond, thenExpr] };
    return { '$if': [cond, thenExpr, elseExpr] };
  }

  // QuantifiedExpr ::= ("some" | "every") "$" VarName "in" ExprSingle
  //                    ("," "$" VarName "in" ExprSingle)* "satisfies" ExprSingle
  // Distinct names merge into one binding object; a repeated name starts
  // a nested quantifier phrase (XQuery shadowing; one binding object
  // cannot bind a name twice - JQ0007). Nesting quantifiers of the same
  // polarity is equivalent to one quantifier over the combined tuples.
  function parseQuantified(kw) {
    const key = kw === 'some' ? '$some' : '$every';
    const bindings = [];
    for (;;) {
      skipWS();
      if (cc(pos) !== CC_DOLLAR)
        fail(`expected '$' after '${kw}'`);
      pos++;
      const name = parseVarName();
      checkTypeDeclaration();
      expectKeyword('in');
      bindings.push([name, parseExprSingle()]);
      skipWS();
      if (cc(pos) === CC_COMMA) {
        pos++;
        continue;
      }
      break;
    }
    expectKeyword('satisfies');
    const cond = parseExprSingle();
    const groups = [];
    let group = {};
    for (let i = 0; i < bindings.length; i++) {
      const name = bindings[i][0];
      if (hasOwn(group, name)) {
        groups.push(group);
        group = {};
      }
      setMember(group, name, bindings[i][1]);
    }
    groups.push(group);
    let out = cond;
    for (let i = groups.length - 1; i >= 0; i--)
      out = { [key]: groups[i], '$satisfies': out };
    return out;
  }

  // 'as SequenceType' declarations are outside the subset everywhere
  function checkTypeDeclaration() {
    const at = tryKeyword('as');
    if (at >= 0)
      fail("unsupported construct 'type declaration'", at);
  }

  //#endregion

  //#region FLWOR

  // FLWORExpr ::= (ForClause | LetClause) IntermediateClause* ReturnClause.
  // Clauses parse into a flat list in source order; assembleFlwor packs
  // them into (possibly nested) JSON FLWOR phrases.
  function parseFlwor(firstKw) {
    const clauses = [];
    parseBindingClause(firstKw, clauses);
    for (;;) {
      skipWS();
      const at = pos;
      if (!isNameStartCode(cc(pos)))
        fail('expected a FLWOR clause');
      const kw = parseNCName();
      if (kw === 'for' || kw === 'let') {
        requireDollar(kw, at);
        parseBindingClause(kw, clauses);
        continue;
      }
      if (kw === 'where') {
        clauses.push({ kind: 'where', expr: parseExprSingle(), at });
        continue;
      }
      if (kw === 'group') {
        expectKeyword('by');
        parseGroupByClause(clauses, at);
        continue;
      }
      if (kw === 'stable') {
        expectKeyword('order');
        expectKeyword('by');
        parseOrderByClause(clauses, at);
        continue;
      }
      if (kw === 'order') {
        expectKeyword('by');
        parseOrderByClause(clauses, at);
        continue;
      }
      if (kw === 'count') {
        skipWS();
        if (cc(pos) !== CC_DOLLAR)
          fail("expected '$' after 'count'");
        pos++;
        clauses.push({ kind: 'count', name: parseVarName(), at });
        continue;
      }
      if (kw === 'return')
        return assembleFlwor(clauses, parseExprSingle());
      return fail(`expected a FLWOR clause, got '${kw}'`, at);
    }
  }

  function requireDollar(kw, clauseAt) {
    skipWS();
    if (cc(pos) === CC_DOLLAR)
      return;
    if (kw === 'for' && isNameStartCode(cc(pos))) {
      const save = pos;
      const w = parseNCName();
      pos = save;
      if (w === 'sliding' || w === 'tumbling')
        fail("unsupported construct 'window clause'", clauseAt);
    }
    fail(`expected '$' after '${kw}'`);
  }

  // ForClause / LetClause with comma-separated bindings; each binding
  // becomes one clause entry (a multi-binding clause and consecutive
  // clauses of the same kind are equivalent - both merge when packed)
  function parseBindingClause(kind, clauses) {
    for (;;) {
      skipWS();
      const at = pos;
      if (cc(pos) !== CC_DOLLAR)
        fail(`expected '$' after '${kind}'`);
      pos++;
      const name = parseVarName();
      checkTypeDeclaration();
      if (kind === 'for') {
        const allowingAt = tryKeyword('allowing');
        if (allowingAt >= 0)
          fail("unsupported construct 'allowing empty'", allowingAt);
        let atName = null;
        if (tryKeyword('at') >= 0) {
          skipWS();
          if (cc(pos) !== CC_DOLLAR)
            fail("expected '$' after 'at'");
          pos++;
          skipWS();
          const atNameAt = pos;
          atName = parseVarName();
          if (atName === name)
            fail(`duplicate variable '$${name}'`, atNameAt);
        }
        expectKeyword('in');
        clauses.push({ kind: 'for', name, atName, expr: parseExprSingle(), at });
      }
      else {
        skipWS();
        if (cc(pos) !== CC_COLON || cc(pos + 1) !== CC_EQ)
          fail("expected ':='");
        pos += 2;
        clauses.push({ kind: 'let', name, expr: parseExprSingle(), at });
      }
      skipWS();
      if (cc(pos) === CC_COMMA) {
        pos++;
        continue;
      }
      return;
    }
  }

  // GroupByClause: only the `group by $new := expr` form maps - the JSON
  // $groupby key is always a fresh grouping variable (JQ0007 forbids
  // rebinding); the bare `group by $x` form is outside the subset
  function parseGroupByClause(clauses, at) {
    const keys = [];
    for (;;) {
      skipWS();
      const bindAt = pos;
      if (cc(pos) !== CC_DOLLAR)
        fail("expected '$' after 'group by'");
      pos++;
      const name = parseVarName();
      checkTypeDeclaration();
      skipWS();
      if (cc(pos) !== CC_COLON || cc(pos + 1) !== CC_EQ)
        fail("unsupported construct 'group by' binding without ':='", bindAt);
      pos += 2;
      const expr = parseExprSingle();
      const collationAt = tryKeyword('collation');
      if (collationAt >= 0)
        fail("unsupported construct 'collation'", collationAt);
      keys.push({ name, expr, at: bindAt });
      skipWS();
      if (cc(pos) === CC_COMMA) {
        pos++;
        continue;
      }
      break;
    }
    clauses.push({ kind: 'groupby', keys, at });
  }

  // OrderByClause: OrderSpec ::= ExprSingle ("ascending" | "descending")?
  // ("empty" ("least" | "greatest"))? - collation is outside the subset
  function parseOrderByClause(clauses, at) {
    const specs = [];
    for (;;) {
      const key = parseExprSingle();
      let desc = false;
      let greatest = false;
      if (tryKeyword('ascending') < 0 && tryKeyword('descending') >= 0)
        desc = true;
      if (tryKeyword('empty') >= 0) {
        if (tryKeyword('greatest') >= 0)
          greatest = true;
        else if (tryKeyword('least') < 0)
          fail("expected 'least' or 'greatest'");
      }
      const collationAt = tryKeyword('collation');
      if (collationAt >= 0)
        fail("unsupported construct 'collation'", collationAt);
      specs.push({ key, desc, greatest });
      skipWS();
      if (cc(pos) === CC_COMMA) {
        pos++;
        continue;
      }
      break;
    }
    clauses.push({ kind: 'orderby', specs, at });
  }

  // A key spec in default form is the bare key expression; explicit
  // modifiers use the {$key, $dir, $empty} object with only non-default
  // members. An array-constructor key always takes the explicit form: a
  // bare array in $orderby position reads as a list of key specs.
  function emitOrderBySpec(spec) {
    if (!spec.desc && !spec.greatest && !Array.isArray(spec.key))
      return spec.key;
    const out = { '$key': spec.key };
    if (spec.desc)
      out.$dir = 'desc';
    if (spec.greatest)
      out.$empty = 'greatest';
    return out;
  }

  function emitOrderBy(specs) {
    if (specs.length === 1)
      return emitOrderBySpec(specs[0]);
    const out = new Array(specs.length);
    for (let i = 0; i < specs.length; i++)
      out[i] = emitOrderBySpec(specs[i]);
    return out;
  }

  //#region clause packing
  // The JSON FLWOR phrase holds at most one clause per kind, applied in
  // the fixed semantic order $for -> $let -> $where -> $groupby ->
  // $orderby -> $count -> $return (D7). The parser packs the source
  // clause list greedily into that order and expresses everything else
  // by nesting - which is only sound for the per-tuple clauses:
  //
  //   - for/let/where nest into $return freely (a nested phrase runs
  //     once per surviving tuple, exactly XQuery's tuple-stream
  //     semantics); a bare leading `where` nests as `$if`.
  //   - group by / order by / count operate on the *whole* tuple stream.
  //     Nesting them under a phrase that iterates ($for or $groupby)
  //     would wrongly scope them to one tuple, so that clause order is
  //     rejected: `unsupported clause order: '<kw>' after '<kw>'`.
  //
  // A name collision (XQuery shadowing, JQ0007 in one phrase) also forces
  // a split - the nested phrase then shadows, exactly XQuery semantics.

  function assembleFlwor(clauses, ret) {
    return buildChain(clauses, 0, ret, false);
  }

  function buildChain(clauses, i, ret, enclosingMulti) {
    if (i >= clauses.length)
      return ret;
    const c = clauses[i];
    if (c.kind === 'where') // a leading tuple filter is $if
      return { '$if': [c.expr, buildChain(clauses, i + 1, ret, enclosingMulti)] };
    if (c.kind === 'groupby' || c.kind === 'orderby' || c.kind === 'count')
      fail(`unsupported clause order: '${CLAUSE_LABEL[c.kind]}' after '${CLAUSE_LABEL[clauses[i - 1].kind]}'`, c.at);
    return buildPhrase(clauses, i, ret, enclosingMulti);
  }

  function buildPhrase(clauses, i, ret, enclosingMulti) {
    const names = new Set();
    let forObj = null;
    let letObj = null;
    let whereExpr = null;
    let groupObj = null;
    let orderSpecs = null;
    let countName = null;
    let lastSlot = -1;
    let multi = false; // this phrase iterates: $for or $groupby present

    for (; i < clauses.length; i++) {
      const c = clauses[i];
      const slot = CLAUSE_SLOT[c.kind];
      if (c.kind === 'for' || c.kind === 'let') {
        // equal slots merge (consecutive bindings of one kind); a slot
        // regression or a name collision closes the phrase
        if (slot < lastSlot)
          break;
        if (names.has(c.name) || (c.kind === 'for' && c.atName !== null && names.has(c.atName)))
          break;
        if (c.kind === 'for') {
          if (forObj === null)
            forObj = {};
          setMember(forObj, c.name, c.atName === null ? c.expr : { '$in': c.expr, '$at': c.atName });
          names.add(c.name);
          if (c.atName !== null)
            names.add(c.atName);
          multi = true;
        }
        else {
          if (letObj === null)
            letObj = {};
          setMember(letObj, c.name, c.expr);
          names.add(c.name);
        }
        lastSlot = slot;
        continue;
      }
      if (slot <= lastSlot)
        break;
      if (c.kind === 'where') {
        whereExpr = c.expr;
        lastSlot = slot;
        continue;
      }
      // whole-stream clauses cannot nest under an iterating phrase
      if (enclosingMulti)
        fail(`unsupported clause order: '${CLAUSE_LABEL[c.kind]}' after '${CLAUSE_LABEL[clauses[i - 1].kind]}'`, c.at);
      if (c.kind === 'groupby') {
        groupObj = {};
        for (let k = 0; k < c.keys.length; k++) {
          const g = c.keys[k];
          if (hasOwn(groupObj, g.name))
            fail(`duplicate variable '$${g.name}'`, g.at);
          if (names.has(g.name))
            fail(`unsupported construct 'group by' rebinding variable '$${g.name}'`, g.at);
          setMember(groupObj, g.name, g.expr);
        }
        for (let k = 0; k < c.keys.length; k++)
          names.add(c.keys[k].name);
        multi = true;
        lastSlot = slot;
        continue;
      }
      if (c.kind === 'orderby') {
        orderSpecs = c.specs;
        lastSlot = slot;
        continue;
      }
      // count
      if (names.has(c.name))
        fail(`unsupported construct 'count' rebinding variable '$${c.name}'`, c.at);
      countName = c.name;
      names.add(c.name);
      lastSlot = slot;
    }

    const retExpr = i < clauses.length
      ? buildChain(clauses, i, ret, enclosingMulti || multi)
      : ret;

    const phrase = {};
    if (forObj !== null)
      phrase.$for = forObj;
    if (letObj !== null)
      phrase.$let = letObj;
    if (whereExpr !== null)
      phrase.$where = whereExpr;
    if (groupObj !== null)
      phrase.$groupby = groupObj;
    if (orderSpecs !== null)
      phrase.$orderby = emitOrderBy(orderSpecs);
    if (countName !== null)
      phrase.$count = countName;
    phrase.$return = retExpr;
    return phrase;
  }

  //#endregion

  //#endregion

  //#region prolog

  const declared = new Set();

  // `xquery version "..." (encoding "...")? ;` - parsed, ignored
  function parseVersionDecl() {
    const save = pos;
    if (tryKeyword('xquery') < 0)
      return;
    skipWS();
    if (!isNameStartCode(cc(pos))) {
      pos = save;
      return;
    }
    const w = parseNCName();
    if (w !== 'version' && w !== 'encoding') {
      pos = save;
      return;
    }
    skipWS();
    if (cc(pos) !== CC_SQUOTE && cc(pos) !== CC_DQUOTE)
      fail(`expected a string literal after '${w}'`);
    parseStringLiteral();
    if (w === 'version') {
      const save2 = pos;
      if (tryKeyword('encoding') >= 0) {
        skipWS();
        if (cc(pos) !== CC_SQUOTE && cc(pos) !== CC_DQUOTE)
          fail("expected a string literal after 'encoding'");
        parseStringLiteral();
      }
      else {
        pos = save2;
      }
    }
    skipWS();
    if (cc(pos) !== CC_SEMICOLON)
      fail("expected ';'");
    pos++;
  }

  // `declare variable $name external;` - validated and ignored: in the
  // JSON format use is the declaration (spec section 9); the engine
  // collects free variables as externals. Everything else in a prolog is
  // outside the subset, each with a named error.
  function parseVariableDecl(declAt) {
    skipWS();
    if (cc(pos) !== CC_DOLLAR)
      fail("expected '$' after 'declare variable'");
    pos++;
    skipWS();
    const nameAt = pos;
    const name = parseVarName();
    if (declared.has(name))
      fail(`duplicate variable declaration '$${name}'`, nameAt);
    checkTypeDeclaration();
    skipWS();
    if (cc(pos) === CC_COLON && cc(pos + 1) === CC_EQ)
      fail("unsupported construct 'variable declaration with default value'", declAt);
    expectKeyword('external');
    skipWS();
    if (cc(pos) === CC_COLON && cc(pos + 1) === CC_EQ)
      fail("unsupported construct 'variable declaration with default value'", declAt);
    if (cc(pos) !== CC_SEMICOLON)
      fail("expected ';'");
    pos++;
    declared.add(name);
  }

  function parseProlog() {
    parseVersionDecl();
    for (;;) {
      const save = pos;
      skipWS();
      const at = pos;
      if (!isNameStartCode(cc(pos))) {
        pos = save;
        return;
      }
      const w = parseNCName();
      if (w === 'declare') {
        skipWS();
        if (cc(pos) === CC_PERCENT)
          fail("unsupported construct 'annotation'");
        if (!isNameStartCode(cc(pos)))
          fail('expected a declaration keyword');
        const kind = parseNCName();
        if (kind === 'variable') {
          parseVariableDecl(at);
          continue;
        }
        fail(`unsupported construct 'declare ${kind}'`, at);
      }
      if (w === 'import') {
        skipWS();
        const kind = isNameStartCode(cc(pos)) ? parseNCName() : 'declaration';
        fail(`unsupported construct 'import ${kind}'`, at);
      }
      if (w === 'module')
        fail("unsupported construct 'library module'", at);
      pos = save;
      return;
    }
  }

  //#endregion

  // Module ::= VersionDecl? Prolog QueryBody
  parseProlog();
  skipWS();
  if (pos >= len)
    fail('empty query', 0);
  const body = parseExpr();
  skipWS();
  if (pos !== len)
    fail('unexpected token');
  return body;
}

//#endregion

//#endregion
