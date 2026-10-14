//@ts-check
/**
 * @file `compileExpr(ast, opts) → (scope) => number`. The second stage of
 * the two-stage compiler: every dispatch decision — which operator
 * closure, which function, whether an identifier is a constant — is made
 * once, here, and baked into a nested closure. Evaluation then does no
 * lookups on the hot path. No `eval`, no `new Function` (CSP-safe).
 *
 * `evaluate(source, scope?, opts?)` is the error-safe front door: it
 * parses, compiles and runs, returning a tagged `{ ok, value } | { ok:
 * false, error }` result so the app/render path never throws.
 *
 * An exact environment (`env.exact`, the programmer one) computes with a
 * `bigint` wherever a `Number` could not hold the integer. The public
 * `compileExpr` and `evaluate` answer a `Number` regardless, rounding such a
 * value once at the end; `compileExact` and `evaluateExact` answer the value
 * itself, for the calculator's word display.
 */

import { parseExpression } from './parser/index.js';
import { defaultEnv } from './env.js';
import { CalcParseError, errorAt } from './errors.js';
import { siteOf, exactOf } from './ast.js';
import { DECIMAL_INTEGER, fit, toNumber } from './exact.js';

/**
 * Compile an AST against an environment.
 * @param {any} ast
 * @param {{ env?: any }} [opts]
 * @returns {(scope?: any) => number}
 */
export function compileExpr(ast, opts = {}) {
  const env = opts.env ?? defaultEnv();
  const run = build(ast, env);
  return env.exact === true ? (scope) => toNumber(run(scope)) : run;
}

/**
 * Compile an AST and answer the value itself: a `bigint` where the
 * environment is exact and the integer is past what a `Number` holds.
 * @param {any} ast
 * @param {{ env?: any }} [opts]
 * @returns {(scope?: any) => number | bigint}
 */
export function compileExact(ast, opts = {}) {
  return build(ast, opts.env ?? defaultEnv());
}

/**
 * @param {any} node
 * @param {any} env
 * @returns {(scope?: any) => number | bigint}
 */
function build(node, env) {
  switch (node.type) {
    case 'num': {
      const v = env.exact === true ? (exactOf(node) ?? node.value) : node.value;
      return () => v;
    }
    case 'const': {
      const name = node.name;
      const v = env.constants[name];
      if (v === undefined) throw refuse(node, `unknown constant '${name}'`);
      return () => v;
    }
    case 'var': {
      const name = node.name;
      // an exact environment reads a decimal-integer string as the integer it
      // spells, where `+v` would round it to a double past 2^53
      const exact = env.exact === true;
      return (scope) => {
        const v = scope ? scope[name] : undefined;
        if (v === undefined) return NaN;
        if (exact && typeof v === 'string' && DECIMAL_INTEGER.test(v)) {
          // only a word a Number cannot hold takes the integer: a safe one reads as `+v` does
          const word = fit(BigInt(v));
          if (typeof word === 'bigint') return word;
        }
        return +v;
      };
    }
    case 'unary': {
      const op = env.unops[node.op];
      if (op === undefined) throw new CalcParseError(`unknown unary operator '${node.op}'`);
      const arg = build(node.arg, env);
      return (scope) => op(arg(scope), scope);
    }
    case 'postfix': {
      const op = env.postops[node.op];
      if (op === undefined) throw new CalcParseError(`unknown postfix operator '${node.op}'`);
      const arg = build(node.arg, env);
      return (scope) => op(arg(scope), scope);
    }
    case 'binary': {
      const op = env.binops[node.op];
      if (op === undefined) throw new CalcParseError(`unknown operator '${node.op}'`);
      const l = build(node.left, env);
      const r = build(node.right, env);
      return (scope) => op(l(scope), r(scope), scope);
    }
    case 'call': {
      // own members only: a name inherited from Object.prototype is no function of ours
      const fn = Object.hasOwn(env.funcs, node.name) ? env.funcs[node.name] : undefined;
      if (fn === undefined) throw refuse(node, `unknown function '${node.name}'`);
      checkArity(node, env.arity);
      const args = node.args.map((a) => build(a, env));
      return (scope) => fn(args.map((a) => a(scope)), scope);
    }
    default:
      throw new CalcParseError(`cannot compile node '${node.type}'`);
  }
}

/**
 * The error for a node the environment cannot compile: positioned where
 * the node was written when the parser recorded it, unpositioned otherwise.
 * @param {any} node
 * @param {string} message
 * @returns {CalcParseError}
 */
function refuse(node, message) {
  const site = siteOf(node);
  return site === undefined ? new CalcParseError(message) : errorAt(message, site.source, site.position);
}

/**
 * Refuse a call with an argument count outside the function's declared
 * `[min, max]`. An environment without an `arity` table, or a function
 * without an entry in it, is not checked.
 * @param {any} node the call node
 * @param {Record<string, readonly [number, number]> | undefined} arity
 */
function checkArity(node, arity) {
  const name = node.name;
  const count = node.args.length;
  if (arity === undefined || !Object.hasOwn(arity, name)) return;
  const [min, max] = arity[name];
  if (count >= min && count <= max) return;
  const noun = (/** @type {number} */ n) => (n === 1 ? 'argument' : 'arguments');
  const expected = max === Infinity ? `at least ${min} ${noun(min)}`
    : min === max ? `${min} ${noun(min)}`
      : `${min} or ${max} arguments`;
  throw refuse(node, `${name}() expected ${expected}, got ${count}`);
}

/**
 * @typedef {object} EvalOk
 * @property {true} ok
 * @property {number} value
 */
/**
 * @typedef {object} ExactOk
 * @property {true} ok
 * @property {number | bigint} value
 */
/**
 * @typedef {object} EvalErr
 * @property {false} ok
 * @property {{ message: string, line?: number, column?: number }} error
 */

/**
 * Parse + compile + evaluate a source expression, error-safe. A value an
 * exact environment holds as a `bigint` is answered as the nearest `Number`.
 * @param {string} source
 * @param {any} [scope]
 * @param {{ env?: any }} [opts]
 * @returns {EvalOk | EvalErr}
 */
export function evaluate(source, scope = {}, opts = {}) {
  const result = evaluateExact(source, scope, opts);
  return result.ok ? { ok: true, value: toNumber(result.value) } : result;
}

/**
 * Parse + compile + evaluate a source expression, error-safe, answering the
 * value itself: a `bigint` where the environment is exact and the integer is
 * past what a `Number` holds.
 * @param {string} source
 * @param {any} [scope]
 * @param {{ env?: any }} [opts]
 * @returns {ExactOk | EvalErr}
 */
export function evaluateExact(source, scope = {}, opts = {}) {
  try {
    const ast = parseExpression(source, opts);
    const fn = compileExact(ast, opts);
    const value = fn(scope);
    return { ok: true, value };
  }
  catch (err) {
    const e = /** @type {any} */ (err);
    return {
      ok: false,
      error: {
        message: e && e.message ? e.message : String(err),
        line: e instanceof CalcParseError ? e.line : undefined,
        column: e instanceof CalcParseError ? e.column : undefined,
      },
    };
  }
}
