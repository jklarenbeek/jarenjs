//@ts-check
/**
 * @file `toExpression(ast)` — the canonical printer. It is a **round-trip
 * fixed point**: `parseExpression(toExpression(ast))` deep-equals
 * `ast` for every AST the parser can produce. Parentheses are emitted
 * from operator precedence/associativity only where removing them would
 * change the parse; numbers print in canonical decimal (the AST never
 * carried their original radix). An integer beyond 2^53 prints as the
 * exact integer it stands for, so an exact environment reads back the
 * integer it compiled rather than the nearest double's digits.
 */

import { exactOf } from './ast.js';

/** Printing precedence per node, matching the grammar in parser/index.js. */
const PREC = {
  '|': 10, '&': 20, '<<': 30, '>>': 30,
  '+': 40, '-': 40, '*': 50, '/': 50,
  unary: 70, '^': 80, postfix: 90, atom: 100,
};

/**
 * @param {any} node
 * @returns {number}
 */
function precOf(node) {
  switch (node.type) {
    case 'binary': return PREC[node.op];
    case 'unary': return PREC.unary;
    case 'postfix': return PREC.postfix;
    default: return PREC.atom;
  }
}

/**
 * Print a numeric node canonically: non-finite as the named constants the
 * parser recognizes, otherwise the shortest `String` of its value, unless
 * the node stands for an exact integer that text would not read back as
 * (`9007199254740993` is not `9007199254740992`, and the `Number` 2^64
 * prints as `18446744073709552000`), when it prints that integer's digits.
 * Exponent text (`1e+300`) reads back as the integer its double is.
 * @param {{ value: number }} node
 * @returns {string}
 */
function printNum(node) {
  const v = node.value;
  if (Number.isNaN(v)) return 'nan';
  if (v === Infinity) return 'inf';
  if (v === -Infinity) return '-inf';
  const text = String(v);
  const exact = exactOf(node);
  if (exact === undefined) return text;
  const reads = text.includes('e') ? BigInt(v) : BigInt(text);
  return reads === exact ? text : String(exact);
}

/**
 * @param {any} node
 * @returns {string}
 */
export function toExpression(node) {
  if (node === null || typeof node !== 'object') {
    throw new TypeError('toExpression: not an AST node');
  }
  switch (node.type) {
    case 'num': return printNum(node);
    case 'const': return node.name;
    case 'var': return node.name;
    case 'call':
      return `${node.name}(${node.args.map(toExpression).join(', ')})`;
    case 'unary': {
      const argP = precOf(node.arg);
      const inner = toExpression(node.arg);
      return `${node.op}${argP < PREC.unary ? `(${inner})` : inner}`;
    }
    case 'postfix': {
      const argP = precOf(node.arg);
      const inner = toExpression(node.arg);
      return `${argP < PREC.postfix ? `(${inner})` : inner}${node.op}`;
    }
    case 'binary': {
      const p = PREC[node.op];
      const rightAssoc = node.op === '^';
      const lp = precOf(node.left);
      const rp = precOf(node.right);
      // left needs parens when strictly lower, or equal-and-right-assoc
      const leftParen = lp < p || (lp === p && rightAssoc);
      // right needs parens when strictly lower, or equal-and-left-assoc
      const rightParen = rp < p || (rp === p && !rightAssoc);
      const l = toExpression(node.left);
      const r = toExpression(node.right);
      return `${leftParen ? `(${l})` : l} ${node.op} ${rightParen ? `(${r})` : r}`;
    }
    default:
      throw new TypeError(`toExpression: unknown node type '${node.type}'`);
  }
}
