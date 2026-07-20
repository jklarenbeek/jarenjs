//@ts-check
/**
 * @file `@jarenjs/calc` — the ENGINE (part one of the two-layer package,
 * design decision D1). Pure functions over data — expression text ⇄ AST ⇄
 * value, and AST/scene → pure-vnode SVG — that know only `@jarenjs/core`
 * and `@jarenjs/view`. It imports nothing from the component,
 * `@jarenjs/app`, `@jarenjs/forms` or the DOM. The boundary is one-way
 * (the component imports the engine, never the reverse).
 *
 * The signature duality mirrors the rest of the suite:
 * `parseExpression` ⇄ `toExpression` is a round-trip fixed point (D3).
 */

import { renderToString } from '@jarenjs/view';
import { evaluate } from './compile.js';
import { plot2d } from './plot/plot2d.js';
import { plot3d } from './plot/plot3d.js';
import { errorToVnode } from './render/error.js';

export { parseExpression } from './parser/index.js';
export { toExpression } from './to-expr.js';
export { compileExpr, evaluate } from './compile.js';
export { defaultEnv, programmerEnv } from './env.js';
export { CalcParseError } from './errors.js';
export {
  num, constant, variable, unary, postfix, binary, call,
  CONSTANTS, isConstant, astEqual, CALC_AST_VERSION,
} from './ast.js';
export { plot2d, buildScene2d, scene2dToVnode } from './plot/plot2d.js';
export { plot3d, buildScene3d, scene3dToVnode } from './plot/plot3d.js';
export { errorToVnode } from './render/error.js';
export { createTheme, THEMES } from './theme.js';
export { hashContent } from './utils.js';
export {
  MODES, MODE_BY_ID,
  standardMode, scientificMode, programmerMode, financialMode, converterMode,
  wordViews, solveTvm, buildAmortization, npvOf, irrOf,
  convertValue, unitOptions, converterDimensions, CURRENCY,
} from './modes/index.js';

/**
 * Render an expression to a plot vnode, choosing 2D or 3D by whether the
 * expression's free variables include a second axis. Error-safe: a parse
 * failure yields the error vnode (D2), never a throw.
 *
 * @param {string} source
 * @param {{ kind?: '2d'|'3d', [k: string]: any }} [options]
 * @returns {any} an SVG vnode
 */
export function calcToVnode(source, options = {}) {
  const ev = evaluate(source, {}, { env: options.env });
  if (!ev.ok && ev.error && ev.error.line !== undefined) {
    // a genuine parse error (not just an unbound variable like x/y)
    if (/unexpected|expected|invalid|empty/.test(ev.error.message)) {
      return errorToVnode(ev.error, options);
    }
  }
  const kind = options.kind ?? (usesVar(source, 'y') ? '3d' : '2d');
  try {
    return kind === '3d' ? plot3d(source, options) : plot2d(source, options);
  }
  catch (err) {
    return errorToVnode({ message: String(/** @type {any} */ (err)?.message ?? err) }, options);
  }
}

/** Cheap check for whether a source references a bare identifier `name`. */
function usesVar(source, name) {
  try {
    const re = new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_(]|$)`);
    return re.test(source);
  }
  catch {
    return false;
  }
}

/**
 * Render any calc SVG vnode to a standalone SVG string (SSR / headless).
 * @param {any} vnode
 * @returns {string}
 */
export function toSvgString(vnode) {
  return renderToString(vnode);
}
