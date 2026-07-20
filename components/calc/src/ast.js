//@ts-check
/**
 * @file The expression AST (design decisions D2/D3). Monomorphic node
 * constructors — one plain-object shape per kind — so the compiler and
 * printer branch on a single `type` tag and the reconciler/`deepEqual`
 * round-trip stays cheap. The AST is **geometry-free**: it carries no
 * layout, no source formatting (not even a literal's original radix), so
 * that `parseExpression(toExpression(ast))` deep-equals `ast`. Meaning is
 * imposed later — by `compileExpr` (evaluation) or the plotter
 * (projection), never by the parser.
 */

export const CALC_AST_VERSION = '0.13.0';

/** Numeric literal (value only — the radix/format is not preserved). */
export function num(value) {
  return { type: 'num', value: +value };
}

/** A named constant (`pi`, `e`, `phi`, `tau`, `inf`, `nan`). */
export function constant(name) {
  return { type: 'const', name };
}

/** A variable / free identifier (`x`, `y`, `ans`, `mem`). */
export function variable(name) {
  return { type: 'var', name };
}

/** A prefix unary node (`-`, `+`, `~`). */
export function unary(op, arg) {
  return { type: 'unary', op, arg };
}

/** A postfix node (`!` factorial, `%` percent). */
export function postfix(op, arg) {
  return { type: 'postfix', op, arg };
}

/** A binary node (`+ - * / ^ & | << >>`). */
export function binary(op, left, right) {
  return { type: 'binary', op, left, right };
}

/** A function call (`sin(x)`, `log(2, 8)`, `xor(a, b)`). */
export function call(name, args) {
  return { type: 'call', name, args };
}

/**
 * Free identifiers that always denote a constant rather than a variable.
 * @type {Record<string, number>}
 */
export const CONSTANTS = {
  pi: Math.PI,
  π: Math.PI,
  tau: Math.PI * 2,
  τ: Math.PI * 2,
  e: Math.E,
  phi: (1 + Math.sqrt(5)) / 2,
  φ: (1 + Math.sqrt(5)) / 2,
  inf: Infinity,
  nan: NaN,
};

/** Is `name` a known constant identifier? */
export function isConstant(name) {
  return Object.prototype.hasOwnProperty.call(CONSTANTS, name);
}

/**
 * Structural equality for ASTs (used by the round-trip fixed-point
 * tests). NaN compares equal to NaN so `nan` literals round-trip.
 * @param {any} a @param {any} b
 * @returns {boolean}
 */
export function astEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b || (Number.isNaN(a) && Number.isNaN(b));
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!astEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!astEqual(a[k], b[k])) return false;
  }
  return true;
}
