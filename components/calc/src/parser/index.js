//@ts-check
/**
 * @file `parseExpression(text, opts) → ExprAST`. A char-offset
 * recursive-descent, precedence-climbing parser in the repository idiom
 * (module-const sticky regexes for the number/identifier leaves, a
 * `fail(id, params, pos)` that raises `CalcParseError` with 1-based line/column
 * and the diagnostic's message id).
 * No `eval`, no per-parse `RegExp` allocation.
 *
 * Grammar (low → high precedence), all left-associative except power
 * (right) and the prefix unaries:
 *
 *   or      := xor    ('|' xor)*
 *   xor     := and    ('xor' and)*
 *   and     := shift  ('&' shift)*
 *   shift   := add    (('<<'|'>>') add)*
 *   add     := mul    (('+'|'-') mul)*
 *   mul     := unary  (('*'|'/'|'mod') unary)*
 *   unary   := ('-'|'+'|'~') unary | power
 *   power   := postfix ('^' unary)?           // right-assoc via unary
 *   postfix := primary ('!' | '%')*
 *   primary := number | const | ident | ident '(' args ')' | '(' or ')'
 *
 * Number bases (`0x`/`0o`/`0b`) and scientific notation are recognized at
 * the leaf; the AST keeps only the numeric value.
 *
 * `a mod b` and `a xor b` are the word operators a programmer keypad
 * writes between two operands: the parser reads them as the calls
 * `mod(a, b)` and `xor(a, b)`, so the AST and every environment see the
 * function they always bound. In an operand's place `mod(`…`)` is still
 * the call, and a name after an operand is an operator only when it is
 * one of these two.
 */

import { num, constant, variable, unary, postfix, binary, call, isConstant, setSite, setExact } from '../ast.js';
import { CalcParseError, errorAt } from '../errors.js';
import { calcText } from '../messages.js';

/** The English of every diagnostic, the `message` of the error it raises. */
const english = calcText();

/** Sticky number matcher: hex / octal / binary / decimal-with-exponent. */
const RE_NUMBER = /0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
/** An integer literal: a prefixed base, or decimal digits with no fraction or exponent. */
const RE_INTEGER = /^(?:0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|\d+)$/;
/** Sticky identifier matcher (ascii idents plus the greek constant glyphs). */
const RE_IDENT = /[A-Za-z_][A-Za-z0-9_]*|[πφτ]/y;

/** Binary operator precedences (higher binds tighter); power is separate. */
const BINOPS = {
  '|': 1, 'xor': 2, '&': 3, '<<': 4, '>>': 4, '+': 5, '-': 5, '*': 6, '/': 6, 'mod': 6,
};

/** The word operators, read as the call of the function they name. */
const WORD_OPS = new Set(['mod', 'xor']);

class Parser {
  /** @param {string} text */
  constructor(text) {
    this.s = text;
    this.n = text.length;
    this.p = 0;
  }

  /**
   * Raise the diagnostic `id` (a `calcMessagesEn` id) at `pos`.
   * @param {string} id @param {Record<string, unknown>} [params] @param {number} [pos]
   * @returns {never}
   */
  fail(id, params = {}, pos = this.p) {
    throw errorAt(english(id, params), this.s, pos, id, params);
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
    if (c === 0x6d || c === 0x78) { // m x: a word operator, whole
      RE_IDENT.lastIndex = this.p;
      const word = RE_IDENT.exec(this.s);
      if (word !== null && word.index === this.p && WORD_OPS.has(word[0])) return word[0];
    }
    return null;
  }

  parse() {
    this.skipWs();
    if (this.p >= this.n) this.fail('calc/parse/empty');
    const node = this.parseBinary(1);
    this.skipWs();
    if (this.p < this.n) this.fail('calc/parse/unexpected', { token: this.s[this.p] });
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
      const start = this.p;
      this.p += op.length;
      const right = this.parseBinary(prec + 1); // all these are left-assoc
      left = WORD_OPS.has(op) ? setSite(call(op, [left, right]), this.s, start) : binary(op, left, right);
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
    if (this.p >= this.n) this.fail('calc/parse/end');
    const c = this.s.charCodeAt(this.p);

    if (c === 0x28) { // (
      this.p++;
      const inner = this.parseBinary(1);
      this.skipWs();
      if (this.s.charCodeAt(this.p) !== 0x29) this.fail('calc/parse/close');
      this.p++;
      return inner;
    }

    // number
    if ((c >= 0x30 && c <= 0x39) || c === 0x2e) { // digit or '.'
      RE_NUMBER.lastIndex = this.p;
      const m = RE_NUMBER.exec(this.s);
      if (m === null || m.index !== this.p) this.fail('calc/parse/number');
      this.p += m[0].length;
      return numericNode(m[0]);
    }

    // identifier: constant, variable, or function call
    RE_IDENT.lastIndex = this.p;
    const mi = RE_IDENT.exec(this.s);
    if (mi !== null && mi.index === this.p) {
      const name = mi[0];
      const start = this.p;
      this.p += name.length;
      this.skipWs();
      if (this.s.charCodeAt(this.p) === 0x28) { // '(' → call
        this.p++;
        const args = this.parseArgs();
        return setSite(call(name, args), this.s, start);
      }
      return isConstant(name) ? setSite(constant(name), this.s, start) : variable(name);
    }

    this.fail('calc/parse/unexpected', { token: this.s[this.p] });
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
      this.fail('calc/parse/separator');
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
 * The node for a matched numeric literal. An integer literal past the safe
 * range is rounded in the node's `Number` value, so the integer as written
 * is recorded beside it for an environment that computes exactly.
 * @param {string} lit
 * @returns {any}
 */
function numericNode(lit) {
  const node = num(parseNumericLiteral(lit));
  if (!Number.isSafeInteger(node.value) && Number.isFinite(node.value) && RE_INTEGER.test(lit)) {
    setExact(node, BigInt(lit));
  }
  return node;
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
