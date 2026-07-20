//@ts-check
/**
 * @file Generic, domain-free numeric root finders (Part A3). No finance
 * or geometry lives here; `@jarenjs/core/finance` builds NPV/IRR/rate on
 * top of these, the calculator's equation helpers on top of them too.
 *
 * Each solver returns a `{ root, iterations, converged }` record instead
 * of throwing on non-convergence — callers decide how to react (finance
 * falls back from Newton to bisection, for example).
 */

/**
 * @typedef {object} SolveResult
 * @property {number} root the best estimate found
 * @property {number} iterations iterations actually run
 * @property {boolean} converged whether `tol` was reached
 */

const DEFAULT_TOL = 1e-10;
const DEFAULT_MAX_ITER = 100;

/**
 * Newton–Raphson using an explicit derivative. Falls back to reporting
 * non-convergence (rather than diverging silently) when the derivative
 * vanishes or the step explodes.
 *
 * @param {(x: number) => number} f
 * @param {(x: number) => number} df
 * @param {number} x0
 * @param {{ tol?: number, maxIter?: number }} [opts]
 * @returns {SolveResult}
 */
export function newtonRaphson(f, df, x0, opts = {}) {
  const tol = opts.tol ?? DEFAULT_TOL;
  const maxIter = opts.maxIter ?? DEFAULT_MAX_ITER;
  let x = +x0;
  for (let i = 1; i <= maxIter; i++) {
    const fx = +f(x);
    if (Math.abs(fx) <= tol) return { root: x, iterations: i, converged: true };
    const dfx = +df(x);
    if (dfx === 0 || !isFinite(dfx)) return { root: x, iterations: i, converged: false };
    const next = x - fx / dfx;
    if (!isFinite(next)) return { root: x, iterations: i, converged: false };
    if (Math.abs(next - x) <= tol) return { root: next, iterations: i, converged: true };
    x = next;
  }
  return { root: x, iterations: maxIter, converged: false };
}

/**
 * Bisection on a sign-changing bracket `[a, b]`. Guaranteed to converge
 * when `f(a)` and `f(b)` straddle a root; returns `converged: false` if
 * the bracket does not (rather than throwing).
 *
 * @param {(x: number) => number} f
 * @param {number} a
 * @param {number} b
 * @param {{ tol?: number, maxIter?: number }} [opts]
 * @returns {SolveResult}
 */
export function bisect(f, a, b, opts = {}) {
  const tol = opts.tol ?? DEFAULT_TOL;
  const maxIter = opts.maxIter ?? DEFAULT_MAX_ITER;
  let lo = +a;
  let hi = +b;
  let flo = +f(lo);
  let fhi = +f(hi);
  if (flo === 0) return { root: lo, iterations: 0, converged: true };
  if (fhi === 0) return { root: hi, iterations: 0, converged: true };
  if (flo * fhi > 0) return { root: (lo + hi) / 2, iterations: 0, converged: false };
  let mid = (lo + hi) / 2;
  for (let i = 1; i <= maxIter; i++) {
    mid = (lo + hi) / 2;
    const fmid = +f(mid);
    if (Math.abs(fmid) <= tol || (hi - lo) / 2 <= tol) {
      return { root: mid, iterations: i, converged: true };
    }
    if (flo * fmid < 0) { hi = mid; fhi = fmid; }
    else { lo = mid; flo = fmid; }
  }
  return { root: mid, iterations: maxIter, converged: false };
}

/**
 * The secant method (Newton without an explicit derivative). Needs two
 * starting points.
 *
 * @param {(x: number) => number} f
 * @param {number} x0
 * @param {number} x1
 * @param {{ tol?: number, maxIter?: number }} [opts]
 * @returns {SolveResult}
 */
export function secant(f, x0, x1, opts = {}) {
  const tol = opts.tol ?? DEFAULT_TOL;
  const maxIter = opts.maxIter ?? DEFAULT_MAX_ITER;
  let a = +x0;
  let b = +x1;
  let fa = +f(a);
  let fb = +f(b);
  for (let i = 1; i <= maxIter; i++) {
    if (Math.abs(fb) <= tol) return { root: b, iterations: i, converged: true };
    const denom = fb - fa;
    if (denom === 0 || !isFinite(denom)) return { root: b, iterations: i, converged: false };
    const next = b - fb * (b - a) / denom;
    if (!isFinite(next)) return { root: b, iterations: i, converged: false };
    if (Math.abs(next - b) <= tol) return { root: next, iterations: i, converged: true };
    a = b; fa = fb;
    b = next; fb = +f(b);
  }
  return { root: b, iterations: maxIter, converged: false };
}
