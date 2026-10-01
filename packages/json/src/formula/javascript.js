//@ts-check
/**
 * @file A saved JavaScript formula body, parsed for translation: a
 * hand-written recursive-descent parser over `@jarenjs/core/scan`. It reads
 * the statements and expressions formula bodies are written in, and more:
 * a construct the translator does not accept (a loop, a `throw`, a getter,
 * `this`) still parses into a node, so every blocker can be named with its
 * position. Only text that is not JavaScript, or that this parser does not
 * read (a class, a generator, a label), stops it — as one positioned
 * reason. Nothing is ever evaluated.
 *
 * Nodes carry `start` and `end` source offsets; `positionOf` turns an
 * offset into a 1-based line and column.
 */

import {
  CC_TAB, CC_LF, CC_CR, CC_SPACE, CC_DQUOTE, CC_DOLLAR, CC_SQUOTE, CC_STAR, CC_DOT, CC_SLASH,
  CC_BACKSLASH, CC_LBRACE, CC_LBRACKET, CC_RBRACKET, CC_0,
  isDigitCode, isHexDigitCode, isNameStartCode, isNameCharCode,
} from '@jarenjs/core/scan';

const CC_BACKTICK = 0x60;

/** A JavaScript source that is not read: the message and the offset. */
export class FormulaSyntaxError extends Error {
  /** @param {string} message @param {number} offset */
  constructor(message, offset) {
    super(message);
    this.name = 'FormulaSyntaxError';
    this.offset = offset;
  }
}

/**
 * The 1-based line and column of a source offset (a line ends at LF, CR,
 * CRLF, U+2028 or U+2029).
 * @param {string} source @param {number} offset
 * @returns {{ offset: number, line: number, column: number }}
 */
export function positionOf(source, offset) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c === CC_CR && source.charCodeAt(i + 1) === CC_LF) continue;
    if (c === CC_LF || c === CC_CR || c === 0x2028 || c === 0x2029) {
      line++;
      lineStart = i + 1;
    }
  }
  return { offset, line, column: offset - lineStart + 1 };
}

/** ECMAScript white space and line terminators. @param {number} c */
const isLineTerminator = (c) => c === CC_LF || c === CC_CR || c === 0x2028 || c === 0x2029;
/** @param {number} c */
const isJsSpace = (c) => c === CC_SPACE || c === CC_TAB || c === 0x0B || c === 0x0C || c === 0xA0 || c === 0xFEFF
  || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) || c === 0x202F || c === 0x205F || c === 0x3000;
/**
 * Whether a code point may start an identifier: `$`, `_`, an ASCII letter,
 * or a Unicode ID_Start character (the scanner's own predicate admits every
 * non-ASCII code unit, which JavaScript does not).
 * @param {number} cp
 */
const isIdentifierStart = (cp) => cp === CC_DOLLAR || (cp < 0x80 ? isNameStartCode(cp) : /\p{ID_Start}/u.test(String.fromCodePoint(cp)));
/** @param {number} cp */
const isIdentifierPart = (cp) => cp === CC_DOLLAR || (cp < 0x80 ? isNameCharCode(cp)
  : cp === 0x200C || cp === 0x200D || /\p{ID_Continue}/u.test(String.fromCodePoint(cp)));
/** The UTF-16 length of a code point. @param {number} cp */
const width = (cp) => (cp > 0xFFFF ? 2 : 1);

/** The punctuators, longest first per starting character. */
const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=',
  '&=', '|=', '^=', '**', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~',
  '?', ':', '=', '.', '@', '#',
];

/** Words that are never an identifier reference in a body. */
const RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new',
  'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'let', 'static', 'enum', 'await', 'implements', 'package', 'protected', 'interface', 'private', 'public']);

/** Statement keywords the parser reads only to report: each becomes an `Unsupported` node. */
const UNSUPPORTED_STATEMENTS = new Set(['for', 'while', 'do', 'switch', 'try', 'function', 'break', 'continue',
  'debugger', 'with', 'class', 'import', 'export', 'async']);

/** Binary operator precedence (higher binds tighter); `**` is right-associative. */
const BINARY = {
  '??': 1, '||': 2, '&&': 3, '|': 4, '^': 5, '&': 6,
  '==': 7, '!=': 7, '===': 7, '!==': 7,
  '<': 8, '>': 8, '<=': 8, '>=': 8, instanceof: 8, in: 8,
  '<<': 9, '>>': 9, '>>>': 9,
  '+': 10, '-': 10, '*': 11, '/': 11, '%': 11, '**': 12,
};
const LOGICAL = new Set(['&&', '||', '??']);
const ASSIGNMENT = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']);

/**
 * @typedef {{ type: string, value: string, start: number, end: number, newline: boolean }} Token
 */

/**
 * Parse a formula body: the statements of a function body, `return`
 * included.
 * @param {string} source
 * @returns {{ type: 'Body', body: any[], start: number, end: number }}
 * @throws {FormulaSyntaxError}
 */
export function parseFormulaBody(source) {
  let pos = 0;
  /** @type {Token} */
  let tok = { type: 'eof', value: '', start: 0, end: 0, newline: false };

  const fail = (/** @type {string} */ message, at = tok.start) => {
    throw new FormulaSyntaxError(message, at);
  };

  /** Skip white space and comments; report whether a line terminator was crossed. */
  function skipTrivia() {
    let newline = false;
    while (pos < source.length) {
      const c = source.charCodeAt(pos);
      if (isLineTerminator(c)) { newline = true; pos++; }
      else if (isJsSpace(c)) pos++;
      else if (c === CC_SLASH && source.charCodeAt(pos + 1) === CC_SLASH) {
        pos += 2;
        while (pos < source.length && !isLineTerminator(source.charCodeAt(pos))) pos++;
      }
      else if (c === CC_SLASH && source.charCodeAt(pos + 1) === CC_STAR) {
        const close = source.indexOf('*/', pos + 2);
        if (close < 0) fail('an unterminated comment', pos);
        for (let i = pos + 2; i < close; i++) if (isLineTerminator(source.charCodeAt(i))) newline = true;
        pos = close + 2;
      }
      else break;
    }
    return newline;
  }

  /** Read the next token from `pos`; a `/` is always a punctuator here (see `rescanRegExp`). */
  function next() {
    const newline = skipTrivia();
    const start = pos;
    if (pos >= source.length) { tok = { type: 'eof', value: '', start, end: start, newline }; return; }
    const c = source.charCodeAt(pos);
    const cp = /** @type {number} */ (source.codePointAt(pos));
    if (isIdentifierStart(cp) || c === CC_BACKSLASH) {
      if (c === CC_BACKSLASH) fail('an escaped identifier', pos);
      pos += width(cp);
      while (pos < source.length) {
        const next = /** @type {number} */ (source.codePointAt(pos));
        if (!isIdentifierPart(next)) break;
        pos += width(next);
      }
      tok = { type: 'name', value: source.slice(start, pos), start, end: pos, newline };
      return;
    }
    if (isDigitCode(c) || (c === CC_DOT && isDigitCode(source.charCodeAt(pos + 1)))) {
      readNumber(start, newline);
      return;
    }
    if (c === CC_SQUOTE || c === CC_DQUOTE) {
      tok = { type: 'string', value: readString(c), start, end: pos, newline };
      return;
    }
    if (c === CC_BACKTICK) {
      pos++;
      tok = { type: 'template', value: '`', start, end: pos, newline };
      return;
    }
    for (const p of PUNCTUATORS) {
      if (source.startsWith(p, pos)) {
        // `?.` followed by a digit is a conditional and a number (`a?.5:b`)
        if (p === '?.' && isDigitCode(source.charCodeAt(pos + 2))) continue;
        pos += p.length;
        tok = { type: 'punct', value: p, start, end: pos, newline };
        return;
      }
    }
    fail(`an unexpected character '${String.fromCodePoint(/** @type {number} */ (source.codePointAt(pos)))}'`, pos);
  }

  /** @param {number} start @param {boolean} newline */
  function readNumber(start, newline) {
    const c = source.charCodeAt(pos);
    const prefix = c === CC_0 ? source.charCodeAt(pos + 1) | 0x20 : 0;
    if (prefix === 0x78 || prefix === 0x6F || prefix === 0x62) { // 0x, 0o, 0b
      pos += 2;
      const digit = prefix === 0x78 ? isHexDigitCode : prefix === 0x6F
        ? (/** @type {number} */ d) => d >= 0x30 && d <= 0x37 : (/** @type {number} */ d) => d === 0x30 || d === 0x31;
      const from = pos;
      while (digit(source.charCodeAt(pos)) || source.charCodeAt(pos) === 0x5F) pos++;
      if (pos === from) fail('a number without digits', start);
    }
    else {
      while (isDigitCode(source.charCodeAt(pos)) || source.charCodeAt(pos) === 0x5F) pos++;
      if (source.charCodeAt(pos) === CC_DOT) {
        pos++;
        while (isDigitCode(source.charCodeAt(pos)) || source.charCodeAt(pos) === 0x5F) pos++;
      }
      if ((source.charCodeAt(pos) | 0x20) === 0x65) { // e, E
        pos++;
        if (source.charCodeAt(pos) === 0x2B || source.charCodeAt(pos) === 0x2D) pos++;
        if (!isDigitCode(source.charCodeAt(pos))) fail('an exponent without digits', start);
        while (isDigitCode(source.charCodeAt(pos))) pos++;
      }
    }
    if (source.charCodeAt(pos) === 0x6E) fail('a BigInt literal', start); // n
    if (pos < source.length && isIdentifierStart(/** @type {number} */ (source.codePointAt(pos)))) fail('an identifier right after a number', pos);
    tok = { type: 'number', value: source.slice(start, pos), start, end: pos, newline };
  }

  /** Read an escape after a backslash, inside a string or a template. @returns {string} */
  function readEscape() {
    const c = source.charCodeAt(pos++);
    switch (c) {
      case 0x6E: return '\n';
      case 0x74: return '\t';
      case 0x72: return '\r';
      case 0x62: return '\b';
      case 0x66: return '\f';
      case 0x76: return '\v';
      case 0x30:
        if (isDigitCode(source.charCodeAt(pos))) fail('a legacy octal escape', pos - 2);
        return '\0';
      case 0x78: { // \xHH
        const hex = source.slice(pos, pos + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) fail('a malformed \\x escape', pos - 2);
        pos += 2;
        return String.fromCharCode(parseInt(hex, 16));
      }
      case 0x75: { // \uHHHH or \u{H…}
        if (source.charCodeAt(pos) === CC_LBRACE) {
          const close = source.indexOf('}', pos);
          const hex = close < 0 ? '' : source.slice(pos + 1, close);
          if (!/^[0-9a-fA-F]{1,6}$/.test(hex) || parseInt(hex, 16) > 0x10FFFF) fail('a malformed \\u{} escape', pos - 2);
          pos = close + 1;
          return String.fromCodePoint(parseInt(hex, 16));
        }
        const hex = source.slice(pos, pos + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('a malformed \\u escape', pos - 2);
        pos += 4;
        return String.fromCharCode(parseInt(hex, 16));
      }
      case CC_CR:
        if (source.charCodeAt(pos) === CC_LF) pos++;
        return '';
      case CC_LF: case 0x2028: case 0x2029:
        return '';
      default:
        if (isDigitCode(c)) fail('a legacy octal escape', pos - 2);
        if (Number.isNaN(c)) fail('an unterminated escape', pos - 2);
        return String.fromCharCode(c);
    }
  }

  /** @param {number} quote @returns {string} */
  function readString(quote) {
    const start = pos;
    pos++;
    let out = '';
    for (;;) {
      if (pos >= source.length) fail('an unterminated string', start);
      const c = source.charCodeAt(pos);
      if (c === quote) { pos++; return out; }
      if (c === CC_LF || c === CC_CR) fail('a line break inside a string', start);
      if (c === CC_BACKSLASH) { pos++; out += readEscape(); }
      else { out += source[pos]; pos++; }
    }
  }

  /** Re-read the current `/` or `/=` token as a regular expression literal. */
  function rescanRegExp() {
    const start = tok.start;
    pos = start + 1;
    let inClass = false;
    for (;;) {
      if (pos >= source.length || isLineTerminator(source.charCodeAt(pos))) fail('an unterminated regular expression', start);
      const c = source.charCodeAt(pos);
      if (c === CC_BACKSLASH) { pos += 2; continue; }
      if (c === CC_LBRACKET) inClass = true;
      else if (c === CC_RBRACKET) inClass = false;
      else if (c === CC_SLASH && !inClass) break;
      pos++;
    }
    const pattern = source.slice(start + 1, pos);
    pos++;
    const flagsStart = pos;
    while (pos < source.length && isIdentifierPart(source.charCodeAt(pos))) pos++;
    const flags = source.slice(flagsStart, pos);
    if (!/^[dgimsuyv]*$/.test(flags) || new Set(flags).size !== flags.length) fail(`unknown regular expression flags '${flags}'`, flagsStart);
    tok = { type: 'regexp', value: source.slice(start, pos), start, end: pos, newline: tok.newline };
    return { pattern, flags };
  }

  const is = (/** @type {string} */ value) => tok.type === 'punct' && tok.value === value;
  const isName = (/** @type {string} */ value) => tok.type === 'name' && tok.value === value;
  const eat = (/** @type {string} */ value) => { if (is(value)) { next(); return true; } return false; };
  const expect = (/** @type {string} */ value) => { if (!eat(value)) fail(`'${value}' expected`); };

  /** A statement's end: `;`, or a line break, `}` or the end (automatic semicolon insertion). */
  function semicolon() {
    if (eat(';')) return;
    if (is('}') || tok.type === 'eof' || tok.newline) return;
    fail(`';' expected`);
  }

  //#region statements

  function parseStatement() {
    const start = tok.start;
    if (is('{')) return parseBlock();
    if (is(';')) { next(); return { type: 'Empty', start, end: start + 1 }; }
    if (tok.type === 'name') {
      switch (tok.value) {
        case 'const': case 'let': case 'var': return parseDeclaration();
        case 'if': return parseIf();
        case 'return': return parseReturn();
        case 'throw': {
          next();
          if (tok.newline) fail('a line break after throw');
          const argument = parseExpression();
          semicolon();
          return { type: 'Throw', argument, start, end: argument.end };
        }
        default:
          if (UNSUPPORTED_STATEMENTS.has(tok.value)) return parseUnsupported();
      }
    }
    const expression = parseExpression();
    semicolon();
    return { type: 'ExpressionStatement', expression, start, end: expression.end };
  }

  function parseBlock() {
    const start = tok.start;
    expect('{');
    const body = [];
    while (!is('}')) {
      if (tok.type === 'eof') fail(`'}' expected`);
      body.push(parseStatement());
    }
    const end = tok.end;
    next();
    return { type: 'Block', body, start, end };
  }

  function parseDeclaration() {
    const start = tok.start;
    const kind = tok.value;
    next();
    const declarations = [];
    do {
      const at = tok.start;
      if (is('{') || is('[')) {
        const pattern = parsePattern();
        expect('=');
        const init = parseAssignment();
        declarations.push({ type: 'Declarator', name: null, pattern, init, start: at, end: init.end });
        continue;
      }
      if (tok.type !== 'name' || RESERVED.has(tok.value)) fail('a variable name expected');
      const name = tok.value;
      next();
      let init = null;
      if (eat('=')) init = parseAssignment();
      else if (kind === 'const') fail('a const without a value', at);
      declarations.push({ type: 'Declarator', name, init, start: at, end: init ? init.end : at + name.length });
    } while (eat(','));
    semicolon();
    return { type: 'Declaration', kind, declarations, start, end: declarations[declarations.length - 1].end };
  }

  /**
   * A destructuring pattern: `{ a, b: c, d = 1, ...rest }` or `[a, , b]`,
   * nested. Its parts are kept for the translator to accept or name.
   */
  function parsePattern() {
    const start = tok.start;
    if (eat('[')) {
      const elements = [];
      while (!is(']')) {
        if (is(',')) { next(); elements.push(null); continue; }
        elements.push(parsePatternTarget());
        if (!eat(',')) break;
      }
      const end = tok.end;
      expect(']');
      return { type: 'ArrayPattern', elements, start, end };
    }
    expect('{');
    const properties = [];
    while (!is('}')) {
      const at = tok.start;
      if (eat('...')) {
        if (tok.type !== 'name') fail('a name after ... expected');
        properties.push({ type: 'Rest', name: tok.value, start: at, end: tok.end });
        next();
      }
      else {
        let key;
        let computed = false;
        const named = tok.type === 'name';
        if (eat('[')) { key = parseAssignment(); computed = true; expect(']'); }
        else if (tok.type === 'name' || tok.type === 'string') { key = tok.value; next(); }
        else fail('a property name expected');
        let target;
        if (eat(':')) target = parsePatternTarget();
        else {
          // a shorthand property names its own variable
          if (computed || !named || RESERVED.has(/** @type {string} */ (key))) fail(`':' expected`);
          target = { type: 'Identifier', name: /** @type {string} */ (key), start: at, end: at + String(key).length };
        }
        if (is('=')) { next(); const fallback = parseAssignment(); target = { type: 'Default', target, value: fallback, start: at, end: fallback.end }; }
        properties.push({ type: 'PatternProperty', key, computed, value: target, start: at, end: target.end });
      }
      if (!eat(',')) break;
    }
    const end = tok.end;
    expect('}');
    return { type: 'ObjectPattern', properties, start, end };
  }

  /** A name, or a nested pattern, with an optional default. */
  function parsePatternTarget() {
    const start = tok.start;
    let target;
    if (is('{') || is('[')) target = parsePattern();
    else if (eat('...')) {
      if (tok.type !== 'name') fail('a name after ... expected');
      target = { type: 'Rest', name: tok.value, start, end: tok.end };
      next();
      return target;
    }
    else {
      if (tok.type !== 'name' || RESERVED.has(tok.value)) fail('a variable name expected');
      target = { type: 'Identifier', name: tok.value, start, end: tok.end };
      next();
    }
    if (!is('=')) return target;
    next();
    const fallback = parseAssignment();
    return { type: 'Default', target, value: fallback, start, end: fallback.end };
  }

  function parseIf() {
    const start = tok.start;
    next();
    expect('(');
    const test = parseExpression();
    expect(')');
    const consequent = parseStatement();
    let alternate = null;
    if (isName('else')) { next(); alternate = parseStatement(); }
    return { type: 'If', test, consequent, alternate, start, end: (alternate ?? consequent).end };
  }

  function parseReturn() {
    const start = tok.start;
    const end = tok.end;
    next();
    // a line break after return ends the statement (it returns undefined)
    if (is(';') || is('}') || tok.type === 'eof' || tok.newline) {
      const lineBreak = tok.newline && !is(';') && !is('}') && tok.type !== 'eof';
      eat(';');
      return { type: 'Return', argument: null, lineBreak, start, end };
    }
    const argument = parseExpression();
    semicolon();
    return { type: 'Return', argument, lineBreak: false, start, end: argument.end };
  }

  /** A statement read only to report it: its keyword and its extent. */
  function parseUnsupported() {
    return parseUnsupportedFrom(tok.start, tok.value);
  }

  /** Skip a statement balanced to its end: braces, brackets and parentheses nest. @param {number} start @param {string} what */
  function parseUnsupportedFrom(start, what) {
    let depth = 0;
    let end = tok.end;
    for (;;) {
      if (tok.type === 'eof') {
        if (depth > 0) fail(`an unbalanced ${what} statement`, start);
        break;
      }
      if (tok.type === 'template') { readTemplateParts(); end = lastEnd; continue; }
      if (is('{') || is('(') || is('[')) depth++;
      else if (is('}') || is(')') || is(']')) {
        if (depth === 0) break;
        depth--;
        if (depth === 0 && is('}')) { end = tok.end; next(); if (!isName('else') && !isName('catch') && !isName('finally') && !isName('while')) break; continue; }
      }
      else if (is(';') && depth === 0) { end = tok.end; next(); break; }
      else if (is('/') || is('/=')) {
        // a regular expression where an operand may start; a division otherwise (rough, only to skip)
        const before = source.slice(0, tok.start).trimEnd();
        if (!/[\w$)\]]$/.test(before)) rescanRegExp();
      }
      end = tok.end;
      next();
    }
    return { type: 'Unsupported', what, start, end };
  }

  //#endregion

  //#region expressions

  function parseExpression() {
    const start = tok.start;
    const first = parseAssignment();
    if (!is(',')) return first;
    const expressions = [first];
    while (eat(',')) expressions.push(parseAssignment());
    return { type: 'Sequence', expressions, start, end: expressions[expressions.length - 1].end };
  }

  function parseAssignment() {
    const start = tok.start;
    const arrow = tryArrow();
    if (arrow) return arrow;
    const left = parseConditional();
    if (tok.type === 'punct' && ASSIGNMENT.has(tok.value)) {
      const operator = tok.value;
      if (left.type !== 'Identifier' && left.type !== 'Member') fail('an assignment to something that is not a variable or a member', start);
      next();
      const value = parseAssignment();
      return { type: 'Assignment', operator, target: left, value, start, end: value.end };
    }
    return left;
  }

  /** An arrow function, when the tokens ahead are one: `x =>`, `(x, y) =>`, `() =>`. */
  function tryArrow() {
    const start = tok.start;
    if (tok.type === 'name' && !RESERVED.has(tok.value) && tok.value !== 'async') {
      const save = { pos, tok };
      const name = tok.value;
      next();
      if (is('=>') && !tok.newline) { next(); return arrowBody([name], start); }
      ({ pos, tok } = save);
      return null;
    }
    if (!is('(')) return null;
    // scan ahead for `( name, … ) =>` without building anything
    const save = { pos, tok };
    next();
    const params = [];
    let ok = true;
    if (!is(')')) {
      for (;;) {
        if (tok.type !== 'name' || RESERVED.has(tok.value)) { ok = false; break; }
        params.push(tok.value);
        next();
        if (eat(',')) continue;
        break;
      }
    }
    if (ok && is(')')) {
      next();
      if (is('=>') && !tok.newline) { next(); return arrowBody(params, start); }
    }
    ({ pos, tok } = save);
    return null;
  }

  /** @param {string[]} params @param {number} start */
  function arrowBody(params, start) {
    if (is('{')) {
      const body = parseBlock();
      return { type: 'Arrow', params, body, expression: false, start, end: body.end };
    }
    const body = parseAssignment();
    return { type: 'Arrow', params, body, expression: true, start, end: body.end };
  }

  function parseConditional() {
    const start = tok.start;
    const test = parseBinary(1);
    if (!is('?')) return test;
    next();
    const consequent = parseAssignment();
    expect(':');
    const alternate = parseAssignment();
    return { type: 'Conditional', test, consequent, alternate, start, end: alternate.end };
  }

  /** Precedence climbing over BINARY. @param {number} minimum */
  function parseBinary(minimum) {
    const start = tok.start;
    let left = parseUnary();
    for (;;) {
      const operator = tok.type === 'punct' || (tok.type === 'name' && (tok.value === 'instanceof' || tok.value === 'in')) ? tok.value : '';
      const precedence = BINARY[/** @type {keyof typeof BINARY} */ (operator)];
      if (precedence === undefined || precedence < minimum) return left;
      next();
      const right = operator === '**' ? parseBinary(precedence) : parseBinary(precedence + 1);
      left = { type: LOGICAL.has(operator) ? 'Logical' : 'Binary', operator, left, right, start, end: right.end };
    }
  }

  function parseUnary() {
    const start = tok.start;
    if (tok.type === 'punct' && (tok.value === '!' || tok.value === '-' || tok.value === '+' || tok.value === '~')) {
      const operator = tok.value;
      next();
      const argument = parseUnary();
      if (is('**')) fail('a unary operand of ** needs parentheses');
      return { type: 'Unary', operator, argument, start, end: argument.end };
    }
    if (tok.type === 'name' && (tok.value === 'typeof' || tok.value === 'void' || tok.value === 'delete' || tok.value === 'await')) {
      const operator = tok.value;
      next();
      const argument = parseUnary();
      return { type: 'Unary', operator, argument, start, end: argument.end };
    }
    if (is('++') || is('--')) {
      const operator = tok.value;
      next();
      const argument = parseUnary();
      return { type: 'Update', operator, prefix: true, argument, start, end: argument.end };
    }
    const expression = parsePostfix();
    if ((is('++') || is('--')) && !tok.newline) {
      const operator = tok.value;
      const end = tok.end;
      next();
      return { type: 'Update', operator, prefix: false, argument: expression, start, end };
    }
    return expression;
  }

  /** Member access, calls and optional chains after a primary. */
  function parsePostfix() {
    const start = tok.start;
    let expression;
    if (isName('new')) {
      next();
      if (is('.')) fail('new.target');
      let callee = parsePrimary();
      while (is('.') || is('[')) callee = parseMember(callee, start, false);
      const args = is('(') ? parseArguments() : [];
      expression = { type: 'New', callee, args, start, end: lastEnd };
    }
    else expression = parsePrimary();
    for (;;) {
      if (is('.') || is('[')) expression = parseMember(expression, start, false);
      else if (is('?.')) {
        next();
        if (is('(')) { const args = parseArguments(); expression = { type: 'Call', callee: expression, args, optional: true, start, end: lastEnd }; }
        else if (is('[')) expression = parseMember(expression, start, true);
        else expression = parseMemberName(expression, start, true);
      }
      else if (is('(')) { const args = parseArguments(); expression = { type: 'Call', callee: expression, args, optional: false, start, end: lastEnd }; }
      else if (tok.type === 'template') fail('a tagged template');
      else return expression;
    }
  }

  let lastEnd = 0;

  /** @param {any} object @param {number} start @param {boolean} optional */
  function parseMember(object, start, optional) {
    if (eat('[')) {
      const property = parseExpression();
      lastEnd = tok.end;
      expect(']');
      return { type: 'Member', object, property, computed: true, optional, start, end: lastEnd };
    }
    next(); // '.'
    return parseMemberName(object, start, optional);
  }

  /** @param {any} object @param {number} start @param {boolean} optional */
  function parseMemberName(object, start, optional) {
    if (is('#')) fail('a private member');
    if (tok.type !== 'name') fail('a member name expected');
    const property = tok.value;
    const end = tok.end;
    next();
    return { type: 'Member', object, property, computed: false, optional, start, end };
  }

  function parseArguments() {
    expect('(');
    const args = [];
    while (!is(')')) {
      const start = tok.start;
      if (eat('...')) { const argument = parseAssignment(); args.push({ type: 'Spread', argument, start, end: argument.end }); }
      else args.push(parseAssignment());
      if (!eat(',')) break;
    }
    lastEnd = tok.end;
    expect(')');
    return args;
  }

  function parsePrimary() {
    const start = tok.start;
    if (tok.type === 'number') {
      const raw = tok.value;
      const end = tok.end;
      const text = raw.replace(/_/g, '');
      if (/^0[0-9]+$/.test(text)) fail('a legacy octal number');
      next();
      return { type: 'Literal', value: Number(text), raw, start, end };
    }
    if (tok.type === 'string') {
      const value = tok.value;
      const end = tok.end;
      next();
      return { type: 'Literal', value, start, end };
    }
    if (tok.type === 'template') return parseTemplate();
    if (is('/') || is('/=')) {
      const { pattern, flags } = rescanRegExp();
      const end = tok.end;
      next();
      return { type: 'RegExp', pattern, flags, start, end };
    }
    if (is('(')) {
      next();
      const expression = parseExpression();
      const end = tok.end;
      expect(')');
      return { ...expression, parenthesized: true, outerStart: start, outerEnd: end };
    }
    if (is('[')) return parseArrayLiteral();
    if (is('{')) return parseObjectLiteral();
    if (tok.type === 'name') {
      const name = tok.value;
      const end = tok.end;
      if (name === 'true' || name === 'false') { next(); return { type: 'Literal', value: name === 'true', start, end }; }
      if (name === 'null') { next(); return { type: 'Literal', value: null, start, end }; }
      if (name === 'this' || name === 'super' || name === 'import') { next(); return { type: 'Unsupported', what: name, start, end }; }
      if (name === 'function' || name === 'class' || name === 'async' || name === 'yield') fail(`'${name}' in an expression`);
      if (RESERVED.has(name) && name !== 'let') fail(`the reserved word '${name}'`);
      next();
      return { type: 'Identifier', name, start, end };
    }
    if (tok.type === 'eof') fail('an expression expected, the source ended');
    return fail(`an expression expected, '${tok.value}' found`);
  }

  function parseArrayLiteral() {
    const start = tok.start;
    expect('[');
    const elements = [];
    while (!is(']')) {
      if (is(',')) { next(); elements.push(null); continue; }
      const at = tok.start;
      if (eat('...')) { const argument = parseAssignment(); elements.push({ type: 'Spread', argument, start: at, end: argument.end }); }
      else elements.push(parseAssignment());
      if (!eat(',')) break;
    }
    const end = tok.end;
    expect(']');
    return { type: 'Array', elements, start, end };
  }

  function parseObjectLiteral() {
    const start = tok.start;
    expect('{');
    const properties = [];
    while (!is('}')) {
      const at = tok.start;
      if (eat('...')) {
        const argument = parseAssignment();
        properties.push({ type: 'Spread', argument, start: at, end: argument.end });
      }
      else {
        let key;
        let computed = false;
        if (eat('[')) { key = parseAssignment(); computed = true; expect(']'); }
        else if (tok.type === 'name' || tok.type === 'string') { key = tok.value; next(); }
        else if (tok.type === 'number') { key = String(Number(tok.value.replace(/_/g, ''))); next(); }
        else fail('a property name expected');
        if ((key === 'get' || key === 'set' || key === 'async') && !computed && tok.type === 'name')
          fail(`${key === 'async' ? 'an async method' : `a ${key}ter`} in an object literal`, at);
        if (is('(')) fail('a method in an object literal', at);
        if (eat(':')) {
          const value = parseAssignment();
          properties.push({ type: 'Property', key, computed, value, shorthand: false, start: at, end: value.end });
        }
        else {
          if (computed || typeof key !== 'string' || !isIdentifierStart(/** @type {number} */ (key.codePointAt(0)))) fail(`':' expected`);
          properties.push({ type: 'Property', key, computed: false, value: { type: 'Identifier', name: key, start: at, end: at + key.length }, shorthand: true, start: at, end: at + key.length });
        }
      }
      if (!eat(',')) break;
    }
    const end = tok.end;
    expect('}');
    return { type: 'Object', properties, start, end };
  }

  /** The current token is a template's opening backtick. */
  function parseTemplate() {
    const start = tok.start;
    const { quasis, expressions } = readTemplateParts();
    return { type: 'Template', quasis, expressions, start, end: lastEnd };
  }

  /**
   * Read a template's text and expressions from just after its opening
   * backtick, leaving the token after its closing one current.
   */
  function readTemplateParts() {
    const start = tok.start;
    pos = tok.end;
    const quasis = [];
    const expressions = [];
    let text = '';
    for (;;) {
      if (pos >= source.length) fail('an unterminated template', start);
      const c = source.charCodeAt(pos);
      if (c === CC_BACKTICK) {
        pos++;
        quasis.push(text);
        lastEnd = pos;
        next();
        return { quasis, expressions };
      }
      if (c === CC_DOLLAR && source.charCodeAt(pos + 1) === CC_LBRACE) {
        quasis.push(text);
        text = '';
        pos += 2;
        next();
        expressions.push(parseExpression());
        if (!is('}')) fail(`'}' expected to close a template expression`);
        pos = tok.end;
        continue;
      }
      if (c === CC_BACKSLASH) { pos++; text += readEscape(); continue; }
      if (c === CC_CR) { text += '\n'; pos += source.charCodeAt(pos + 1) === CC_LF ? 2 : 1; continue; }
      text += source[pos];
      pos++;
    }
  }

  //#endregion

  next();
  const body = [];
  while (tok.type !== 'eof') {
    if (is('}')) fail(`an unmatched '}'`);
    body.push(parseStatement());
  }
  return { type: 'Body', body, start: 0, end: source.length };
}
