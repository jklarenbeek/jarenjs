//@ts-check
/**
 * @file `parseExpression(text, opts) → ExprAST`. A char-offset
 * recursive-descent, precedence-climbing parser in the repository idiom
 * (module-const sticky regexes for the number/identifier leaves, a
 * `fail(msg, pos)` that raises `CalcParseError` with 1-based line/column).
 * No `eval`, no per-parse `RegExp` allocation.
 *
 * Grammar (low → high precedence), all left-associative except power
 * (right) and the prefix unaries:
 *
 *   or      := and    ('|' and)*
 *   and     := shift  ('&' shift)*
 *   shift   := add    (('<<'|'>>') add)*
 *   add     := mul    (('+'|'-') mul)*
 *   mul     := unary  (('*'|'/') unary)*
 *   unary   := ('-'|'+'|'~') unary | power
 *   power   := postfix ('^' unary)?           // right-assoc via unary
 *   postfix := primary ('!' | '%')*
 *   primary := number | const | ident | ident '(' args ')' | '(' or ')'
 *
 * Number bases (`0x`/`0o`/`0b`) and scientific notation are recognized at
 * the leaf; the AST keeps only the numeric value.
 */

import { num, constant, variable, unary, postfix, binary, call, isConstant } from '../ast.js';
import { CalcParseError } from '../errors.js';

/** Sticky number matcher: hex / octal / binary / decimal-with-exponent. */
const RE_NUMBER = /0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
/** Sticky identifier matcher (ascii idents plus the greek constant glyphs). */
const RE_IDENT = /[A-Za-z_][A-Za-z0-9_]*|[πφτ]/y;

/** Binary operator precedences (higher binds tighter); power is separate. */
const BINOPS = {
  '|': 1, '&': 2, '<<': 3, '>>': 3, '+': 4, '-': 4, '*': 5, '/': 5,
};

class Parser {
  /** @param {string} text */
  constructor(text) {
    this.s = text;
    this.n = text.length;
    this.p = 0;
  }

  /** @returns {never} */
  fail(message, pos = this.p) {
    let line = 1;
    let col = 1;
    for (let i = 0; i < pos && i < this.n; i++) {
      if (this.s.charCodeAt(i) === 10) { line++; col = 1; } else col++;
    }
    throw new CalcParseError(message, line, col, pos);
  }

  skipWs() {
    while (this.p < this.n) {
      const c = this.s.charCodeAt(this.p);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.p++;
      else break;
    }
  }

  /** Peek the operator at the cursor (no consume): returns its string or null. */
  peekOp() {
    const c = this.s.charCodeAt(this.p);
    const c2 = this.p + 1 < this.n ? this.s.charCodeAt(this.p + 1) : 0;
    if (c === 0x3c && c2 === 0x3c) return '<<';
    if (c === 0x3e && c2 === 0x3e) return '>>';
    if (c === 0x7c) return '|';
    if (c === 0x26) return '&';
    if (c === 0x2b) return '+';
    if (c === 0x2d) return '-';
    if (c === 0x2a) return '*';
    if (c === 0x2f) return '/';
    return null;
  }

  parse() {
    this.skipWs();
    if (this.p >= this.n) this.fail('empty expression');
    const node = this.parseBinary(1);
    this.skipWs();
    if (this.p < this.n) this.fail(`unexpected '${this.s[this.p]}'`);
    return node;
  }

  /** Precedence climbing over BINOPS (power/unary handled below). */
  parseBinary(minPrec) {
    let left = this.parseUnary();
    for (;;) {
      this.skipWs();
      const op = this.peekOp();
      if (op === null) break;
      const prec = BINOPS[op];
      if (prec === undefined || prec < minPrec) break;
      this.p += op.length;
      const right = this.parseBinary(prec + 1); // all these are left-assoc
      left = binary(op, left, right);
    }
    return left;
  }

  parseUnary() {
    this.skipWs();
    const c = this.s.charCodeAt(this.p);
    if (c === 0x2d || c === 0x2b || c === 0x7e) { // - + ~
      const op = this.s[this.p];
      this.p++;
      return unary(op, this.parseUnary());
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePostfix();
    this.skipWs();
    if (this.s.charCodeAt(this.p) === 0x5e) { // ^
      this.p++;
      return binary('^', base, this.parseUnary()); // right-assoc
    }
    return base;
  }

  parsePostfix() {
    let node = this.parsePrimary();
    for (;;) {
      this.skipWs();
      const c = this.s.charCodeAt(this.p);
      if (c === 0x21) { this.p++; node = postfix('!', node); } // !
      else if (c === 0x25) { this.p++; node = postfix('%', node); } // %
      else break;
    }
    return node;
  }

  parsePrimary() {
    this.skipWs();
    if (this.p >= this.n) this.fail('unexpected end of input');
    const c = this.s.charCodeAt(this.p);

    if (c === 0x28) { // (
      this.p++;
      const inner = this.parseBinary(1);
      this.skipWs();
      if (this.s.charCodeAt(this.p) !== 0x29) this.fail("expected ')'");
      this.p++;
      return inner;
    }

    // number
    if ((c >= 0x30 && c <= 0x39) || c === 0x2e) { // digit or '.'
      RE_NUMBER.lastIndex = this.p;
      const m = RE_NUMBER.exec(this.s);
      if (m === null || m.index !== this.p) this.fail('invalid number');
      this.p += m[0].length;
      return num(parseNumericLiteral(m[0]));
    }

    // identifier: constant, variable, or function call
    RE_IDENT.lastIndex = this.p;
    const mi = RE_IDENT.exec(this.s);
    if (mi !== null && mi.index === this.p) {
      const name = mi[0];
      this.p += name.length;
      this.skipWs();
      if (this.s.charCodeAt(this.p) === 0x28) { // '(' → call
        this.p++;
        const args = this.parseArgs();
        return call(name, args);
      }
      return isConstant(name) ? constant(name) : variable(name);
    }

    this.fail(`unexpected '${this.s[this.p]}'`);
  }

  parseArgs() {
    const args = [];
    this.skipWs();
    if (this.s.charCodeAt(this.p) === 0x29) { this.p++; return args; } // empty
    for (;;) {
      args.push(this.parseBinary(1));
      this.skipWs();
      const c = this.s.charCodeAt(this.p);
      if (c === 0x2c) { this.p++; continue; } // ,
      if (c === 0x29) { this.p++; break; } // )
      this.fail("expected ',' or ')'");
    }
    return args;
  }
}

/**
 * Interpret a matched numeric literal (respecting 0x/0o/0b prefixes).
 * @param {string} lit
 * @returns {number}
 */
function parseNumericLiteral(lit) {
  if (lit.length > 1 && lit[0] === '0') {
    const k = lit[1];
    if (k === 'x' || k === 'X') return parseInt(lit.slice(2), 16);
    if (k === 'o' || k === 'O') return parseInt(lit.slice(2), 8);
    if (k === 'b' || k === 'B') return parseInt(lit.slice(2), 2);
  }
  return Number(lit);
}

/**
 * Parse an expression string into an `ExprAST`.
 * @param {string} text
 * @param {{ [k: string]: any }} [opts]
 * @returns {any}
 */
export function parseExpression(text, opts = {}) {
  void opts; // reserved for future mode gating (see CALC-FORMAT.md)
  if (typeof text !== 'string') throw new CalcParseError('expression must be a string');
  return new Parser(text).parse();
}
