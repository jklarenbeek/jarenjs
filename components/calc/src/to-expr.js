//@ts-check
/**
 * @file `toExpression(ast)` — the canonical printer. It is a **round-trip
 * fixed point**: `parseExpression(toExpression(ast))` deep-equals
 * `ast` for every AST the parser can produce. Parentheses are emitted
 * from operator precedence/associativity only where removing them would
 * change the parse; numbers print in canonical decimal (the AST never
 * carried their original radix).
 */

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
 * Print a number canonically (finite → `String`, non-finite → the named
 * constants the parser recognizes).
 * @param {number} v
 * @returns {string}
 */
function printNum(v) {
  if (Number.isNaN(v)) return 'nan';
  if (v === Infinity) return 'inf';
  if (v === -Infinity) return '-inf';
  return String(v);
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
    case 'num': return printNum(node.value);
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
