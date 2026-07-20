//@ts-check
/**
 * @file `compileExpr(ast, opts) → (scope) => number`. The second stage of
 * the two-stage compiler (D2): every dispatch decision — which operator
 * closure, which function, whether an identifier is a constant — is made
 * once, here, and baked into a nested closure. Evaluation then does no
 * lookups on the hot path. No `eval`, no `new Function` (CSP-safe).
 *
 * `evaluate(source, scope?, opts?)` is the error-safe front door: it
 * parses, compiles and runs, returning a tagged `{ ok, value } | { ok:
 * false, error }` result so the app/render path never throws.
 */

import { parseExpression } from './parser/index.js';
import { defaultEnv } from './env.js';
import { CalcParseError } from './errors.js';

/**
 * Compile an AST against an environment.
 * @param {any} ast
 * @param {{ env?: any }} [opts]
 * @returns {(scope?: any) => number}
 */
export function compileExpr(ast, opts = {}) {
  const env = opts.env ?? defaultEnv();
  return build(ast, env);
}

/**
 * @param {any} node
 * @param {any} env
 * @returns {(scope?: any) => number}
 */
function build(node, env) {
  switch (node.type) {
    case 'num': {
      const v = node.value;
      return () => v;
    }
    case 'const': {
      const name = node.name;
      const v = env.constants[name];
      if (v === undefined) throw new CalcParseError(`unknown constant '${name}'`);
      return () => v;
    }
    case 'var': {
      const name = node.name;
      return (scope) => {
        const v = scope ? scope[name] : undefined;
        return v === undefined ? NaN : +v;
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
      const fn = env.funcs[node.name];
      if (fn === undefined) throw new CalcParseError(`unknown function '${node.name}'`);
      const args = node.args.map((a) => build(a, env));
      return (scope) => fn(args.map((a) => a(scope)), scope);
    }
    default:
      throw new CalcParseError(`cannot compile node '${node.type}'`);
  }
}

/**
 * @typedef {object} EvalOk
 * @property {true} ok
 * @property {number} value
 */
/**
 * @typedef {object} EvalErr
 * @property {false} ok
 * @property {{ message: string, line?: number, column?: number }} error
 */

/**
 * Parse + compile + evaluate a source expression, error-safe.
 * @param {string} source
 * @param {any} [scope]
 * @param {{ env?: any }} [opts]
 * @returns {EvalOk | EvalErr}
 */
export function evaluate(source, scope = {}, opts = {}) {
  try {
    const ast = parseExpression(source, opts);
    const fn = compileExpr(ast, opts);
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
