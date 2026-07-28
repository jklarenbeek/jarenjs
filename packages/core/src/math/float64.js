//@ts-check

export const mathf64_abs = Math.abs;

export const mathf64_sqrt = Math.sqrt;
export const mathf64_pow = Math.pow;
export const mathf64_sin = Math.sin;
export const mathf64_cos = Math.cos;
export const mathf64_atan2 = Math.atan2;
export const mathf64_asin = Math.asin;

// Transcendental completeness. Free `Math.*` aliases, in the
// module's existing naming style, so downstream packages bind them by
// import instead of reaching for the global `Math`.
export const mathf64_tan = Math.tan;
export const mathf64_acos = Math.acos;
export const mathf64_atan = Math.atan;
export const mathf64_sinh = Math.sinh;
export const mathf64_cosh = Math.cosh;
export const mathf64_tanh = Math.tanh;
export const mathf64_cbrt = Math.cbrt;
export const mathf64_log = Math.log;
export const mathf64_log2 = Math.log2;
export const mathf64_log10 = Math.log10;
export const mathf64_exp = Math.exp;
export const mathf64_expm1 = Math.expm1;
export const mathf64_hypot = Math.hypot;
export const mathf64_sign = Math.sign;

export const mathf64_ceil = Math.ceil;
export const mathf64_floor = Math.floor;
export const mathf64_round = Math.round;
export const mathf64_min = Math.min;
export const mathf64_max = Math.max;

export const mathf64_random = Math.random;

export const mathf64_EPSILON = +0.000001;

export const mathf64_SQRTFIVE = +mathf64_sqrt(5);

export const mathf64_E = +Math.E;
export const mathf64_LN2 = +Math.LN2;
export const mathf64_LN10 = +Math.LN10;
export const mathf64_PHI = +((1 + mathf64_sqrt(5)) / 2);

export const mathf64_PI = +Math.PI;
export const mathf64_PI2 = +(mathf64_PI * 2);
export const mathf64_PI1H = +(mathf64_PI / 2);
export const mathf64_PI41 = +(4 / mathf64_PI);
export const mathf64_PI42 = +(4 / (mathf64_PI * mathf64_PI));

const _isqrt = (function float64_isqrt_oncompile() {
  const f = new Float32Array(1);
  const i = new Int32Array(f.buffer);
  return function float64_isqrt_impl(n = 0.0) {
    n = +n;
    const n2 = +(n * 0.5);
    f[0] = +n;
    i[0] = (0x5f375a86 - ((i[0] | 0) >> 1)) | 0;
    n = +f[0];
    return +(+n * +(1.5 - (+n2 * +n * +n)));
  };
})();

export class Float64 {

  static gcd(a = 0.0, b = 0.0) {
    a = +a; b = +b;
    // For example, a 1024x768 monitor has a GCD of 256.
    // When you divide both values by that you get 4x3 or 4: 3.
    return +((b === 0.0) ? +a : +Float64.gcd(b, a % b));
  }

  static sqrt(n = 0.0) {
    return +mathf64_sqrt(+n);
  }

  /**
   *
   * The Cross Product Magnitude
   * a × b of two vectors is another vector that is at right angles to both:
   * The magnitude (length) of the cross product equals the area
   * of a parallelogram with vectors a and b for sides:
   *
   * We can calculate the Cross Product this way:
   *
   *    a × b = |a| |b| sin(θ) n
   *
   * or as
   *
   *    a × b = ax × by - bx × ay
   *
   * Another useful property of the cross product is,
   * that its magnitude is related to the sine of
   * the angle between the two vectors:
   *
   *    | a x b | = |a| . |b| . sine(theta)
   *
   * or
   *
   *    sine(theta) = | a x b | / (|a| . |b|)
   *
   * So, in implementation 1 above, if a and b are known in advance
   * to be unit vectors then the result of that function is exactly that sine() value.
   * @param {number} ax
   * @param {number} ay
   * @param {number} bx
   * @param {number} by
   */
  static cross(ax = 0.0, ay = 0.0, bx = 0.0, by = 0.0) {
    return +(+(+ax * +by) - +(+bx * +ay));
  }


  /**
   *
   * We can calculate the Dot Product of two vectors this way:
   *
   *    a · b = |a| × |b| × cos(θ)
   *
   * or in this implementation as:
   *
   *    a · b = ax × bx + ay × by
   *
   * When two vectors are at right angles to each other the dot product is zero.
   *
   * @param {number} ax vector A x velocity
   * @param {number} ay vector A y velocity
   * @param {number} bx vector B x velocity
   * @param {number} by vector B y velocity
   * @returns {number} scalar of the dot product
   */
  static dot(ax = 0.0, ay = 0.0, bx = 0.0, by = 0.0) {
    return +(+(+ax * +bx) + +(+ay * +by));
  }

  static mag2(dx = 0.0, dy = 0.0) {
    return +Float64.dot(dx, dy, dx, dy);
  }

  static mag(dx = 0.0, dy = 0.0) {
    return +mathf64_sqrt(+Float64.mag2(dx, dy));
  }

  static isqrt(n = 0.0) {
    return +_isqrt(n);
  }

  static fib(n = 0.0) {
    n = +mathf64_floor(+n);
    if (!(n >= 1.0)) return 0.0;
    let c = 0.0;
    let x = 1.0;
    let i = 1.0;
    for (; i !== n; i += 1.0) {
      const t = +(+c + +x);
      c = +x;
      x = +t;
    }
    return +x;
  }

  // https://gist.github.com/geraldyeo/988116export
  static fib2(value = 0.0) {
    value = +value;
    const fh = +(1.0 / +mathf64_SQRTFIVE * +mathf64_pow(+(+(1.0 + mathf64_SQRTFIVE) / 2.0), +value));
    const sh = +(1.0 / +mathf64_SQRTFIVE * +mathf64_pow(+(+(1.0 - mathf64_SQRTFIVE) / 2.0), +value));
    return +mathf64_round(+(fh - sh));
  }

  static norm(value = 0.0, min = 0.0, max = 0.0) {
    value = +value; min = +min; max = +max;
    return +((value - min) / (max - min));
  }

  /**
   * Clamps a value between a checked boundary.
   * and can therefor handle swapped min/max arguments
   *
   * @param {number} value input value
   * @param {number} min minimum bounds
   * @param {number} max maximum bounds
   * @returns {number} clamped value
   */
  static clamp(value = 0.0, min = 0.0, max = 0.0) {
    return +mathf64_min(+mathf64_max(+value, +mathf64_min(+min, +max)), +mathf64_max(+min, +max));
  }
  /**
   * Clamps a value between an unchecked boundary
   * this function needs min < max!!
   * (see Float64.clamp for a checked boundary)
   *
   * @param {number} value input value
   * @param {number} min minimum bounds
   * @param {number} max maximum bounds
   * @returns {number} clamped value
   */
  static clampu(value = 0.0, min = 0.0, max = 0.0) {
    return +mathf64_min(+mathf64_max(+value, +min), +max);
  }

  static inRange(value = 0.0, min = 0.0, max = 0.0) {
    return +(+value >= +mathf64_min(+min, +max) && +value <= +mathf64_max(+min, +max));
  }

  static intersectsRange(smin = 0.0, smax = 0.0, dmin = 0.0, dmax = 0.0) {
    return +(+mathf64_max(+smin, +smax) >= +mathf64_min(+dmin, +dmax)
      && +mathf64_min(+smin, +smax) <= +mathf64_max(+dmin, +dmax));
  }

  static intersectsRect(
    ax = 0.0, ay = 0.0, aw = 0.0, ah = 0.0,
    bx = 0.0, by = 0.0, bw = 0.0, bh = 0.0,
  ) {
    return +(+(+Float64.intersectsRange(+ax, +(+ax + +aw), +bx, +(+bx + +bw)) > 0.0
      && +Float64.intersectsRange(+ay, +(+ay + +ah), +by, +(+by + +bh)) > 0.0));
  }

  //#region trigonometry

  static toRadian(degrees = 0.0) {
    return +(+degrees * +Math.PI / 180.0);
  }

  static toDegrees(radians = 0.0) {
    return +(+radians * 180.0 / +Math.PI);
  }

  static wrapRadians(r = 0.0) {
    r = +r;
    if (+r > Math.PI) return +(+r - +mathf64_PI2);
    else if (+r < -Math.PI) return +(+r + +mathf64_PI2);
    return +r;
  }

  static sinLpEx(r = 0.0) {
    r = +r;
    return +((r < 0.0)
      ? +(+mathf64_PI41 * +r + +mathf64_PI42 * +r * +r)
      : +(+mathf64_PI41 * +r - +mathf64_PI42 * +r * +r));
  }

  static sinLp(r = 0.0) {
    //always wrap input angle between -PI and PI
    return +Float64.sinLpEx(+Float64.wrapRadians(+r));
  }

  static cosLp(r = 0.0) {
    //compute cosine: sin(x + PI/2) = cos(x)
    return +Float64.sinLp(+(+r + +mathf64_PI1H));
  }

  static cosHp(r = 0.0) {
    // High-precision polynomial cosine (Nick's approximation).
    //   template<typename T>
    // inline T cos(T x) noexcept
    // {
    //     constexpr T tp = 1./(2.*M_PI);
    //     x *= tp;
    //     x -= T(.25) + std::floor(x + T(.25));
    //     x *= T(16.) * (std::abs(x) - T(.5));
    //     #if EXTRA_PRECISION
    //     x += T(.225) * x * (std::abs(x) - T(1.));
    //     #endif
    //     return x;
    // }
    r = +r;
    const tp = +(1.0 / +mathf64_PI2);
    let x = +(+r * tp);
    x = +(x - +(0.25 + +mathf64_floor(+(x + 0.25))));
    x = +(x * +(16.0 * +(+mathf64_abs(x) - 0.5)));
    x = +(x + +(0.225 * x * +(+mathf64_abs(x) - 1.0)));
    return +x;
  }

  static sinMpEx(r = 0.0) {
    r = +r;
    const sin = +((r < 0.0)
      ? +(mathf64_PI41 * r + mathf64_PI42 * r * r)
      : +(mathf64_PI41 * r - mathf64_PI42 * r * r));
    return +((sin < 0.0)
      ? +(0.225 * (sin * -sin - sin) + sin)
      : +(0.225 * (sin * sin - sin) + sin));
  }

  static sinMp(r = 0.0) {
    return +Float64.sinMpEx(+Float64.wrapRadians(+r));
  }

  static cosMp(r = 0.0) {
    //compute cosine: sin(x + PI/2) = cos(x)
    return +Float64.sinMp(+(+r + +mathf64_PI1H));
  }

  static theta(x = 0.0, y = 0.0) {
    return +mathf64_atan2(+y, +x);
    /*
      // alternative was faster, but not anymore.
      // error < 0.005
      y = +y;
      x = +x;
      if (x == 0.0) {
        if (y > 0.0) return +(Math.PI / 2.0);
        if (y == 0.0) return 0.0;
        return +(-Math.PI / 2.0);
      }
  
      const z = +(y / x);
      var atan = 0.0;
      if (+Math.abs(z) < 1.0) {
        atan = +(z / (1.0 + 0.28 * z * z));
        if (x < 0.0) {
          if (y < 0.0) return +(atan - Math.PI);
          return +(atan + Math.PI);
        }
      }
      else {
        atan = +(Math.PI / 2.0 - z / (z * z + 0.28));
        if (y < 0.0) return +(atan - Math.PI);
      }
      return +(atan);
    */
  }

  static angle(x = 0.0, y = 0.0) {
    return +Float64.theta(x, y);
  }

  static phi(y = 0.0, len = 0.0) {
    return +mathf64_asin(+y / +len);
  }

  //#endregion

  //#region transcendental completeness

  /**
   * The base-e logarithm of `x` in an arbitrary base.
   * @param {number} base
   * @param {number} x
   * @returns {number}
   */
  static logBase(base = 0.0, x = 0.0) {
    return +(+mathf64_log(+x) / +mathf64_log(+base));
  }

  /**
   * The sign of `x` (-1, 0 or +1); preserves ±0 and NaN like `Math.sign`.
   * @param {number} x
   * @returns {number}
   */
  static sign(x = 0.0) {
    return +mathf64_sign(+x);
  }

  /**
   * The Euclidean length of any number of components, overflow-safe.
   * @param {...number} args
   * @returns {number}
   */
  static hypot(...args) {
    return +mathf64_hypot(...args);
  }

  /**
   * The real `n`-th root of `x` (odd roots of negatives handled).
   * @param {number} x
   * @param {number} n
   * @returns {number}
   */
  static nthroot(x = 0.0, n = 0.0) {
    x = +x; n = +n;
    if (x < 0.0 && (n % 2.0) !== 0.0) {
      return +(-mathf64_pow(-x, +(1.0 / n)));
    }
    return +mathf64_pow(x, +(1.0 / n));
  }

  /**
   * Round `value` to `digits` decimal places (banker-free, half-up).
   * @param {number} value
   * @param {number} [digits]
   * @returns {number}
   */
  static roundTo(value = 0.0, digits = 0.0) {
    value = +value; digits = +digits | 0;
    if (!isFinite(value)) return +value;
    const f = +mathf64_pow(10.0, digits);
    return +(+mathf64_round(+(value * f)) / f);
  }

  /**
   * Round `value` to `digits` significant figures (1–100) — the numeric
   * value of `Number.prototype.toPrecision`, without its exponential
   * string formatting.
   * @param {number} value
   * @param {number} [digits]
   * @returns {number}
   */
  static roundToPrecision(value = 0.0, digits = 1.0) {
    value = +value; digits = +digits | 0;
    if (!isFinite(value)) return +value;
    return +Number(value.toPrecision(digits));
  }

  /**
   * The Lanczos approximation of the Gamma function, valid for the whole
   * real line (poles at non-positive integers return ±Infinity/NaN).
   * @param {number} x
   * @returns {number}
   */
  static gamma(x = 0.0) {
    x = +x;
    // Reflection for the left half-plane: Γ(x)Γ(1-x) = π / sin(πx).
    if (x < 0.5) {
      return +(mathf64_PI / +(mathf64_sin(+(mathf64_PI * x)) * +Float64.gamma(+(1.0 - x))));
    }
    x -= 1.0;
    // g=7, n=9 Lanczos coefficients.
    const g = 7.0;
    const c = _LANCZOS_G7;
    let a = +c[0];
    const t = +(x + g + 0.5);
    for (let i = 1; i < c.length; i++) {
      a += +(c[i] / +(x + i));
    }
    return +(+mathf64_sqrt(+(2.0 * mathf64_PI)) * +mathf64_pow(t, +(x + 0.5)) * +mathf64_exp(-t) * a);
  }

  /**
   * The factorial `n!`. Integer `n` uses an exact product; non-integers
   * are lifted to `gamma(n + 1)`. Negative integers return NaN.
   * @param {number} n
   * @returns {number}
   */
  static factorial(n = 0.0) {
    n = +n;
    if (n < 0.0 && mathf64_floor(n) === n) return NaN;
    if (mathf64_floor(n) === n) {
      let acc = 1.0;
      for (let i = 2.0; i <= n; i += 1.0) acc *= i;
      return +acc;
    }
    return +Float64.gamma(+(n + 1.0));
  }

  //#endregion

}

/**
 * Linear remap of `v` from the source range `[smin, smax]` to the destination
 * range `[dmin, dmax]`: `dmin + t·(dmax - dmin)` with
 * `t = (v - smin)/(smax - smin)`. A degenerate source range collapses to
 * `dmin` rather than dividing by zero, so a constant-valued axis still maps to
 * a drawable coordinate. Inverted destination ranges are supported, which is
 * what screen-space y-flips need.
 *
 * @param {number} v
 * @param {number} smin
 * @param {number} smax
 * @param {number} dmin
 * @param {number} dmax
 * @returns {number}
 */
export function remap(v, smin, smax, dmin, dmax) {
  if (smax === smin) return dmin;
  return dmin + ((v - smin) / (smax - smin)) * (dmax - dmin);
}

/**
 * The "nice" axis step — 1, 2 or 5 times a power of ten — that covers `span`
 * in roughly `count` steps, so a tick sequence reads as 0/2/4/6 rather than
 * 0/1.7/3.4. `count` is floored at 1; pass a pre-divided per-step span and
 * leave it at its default to get the ladder alone.
 *
 * The ladder is pure arithmetic with no domain guard: it is the caller who
 * knows what a non-positive or non-finite `span` means for its axis, and
 * different axes answer that differently.
 *
 * @param {number} span the domain span to cover
 * @param {number} [count] desired number of steps (floored at 1)
 * @returns {number}
 */
export function niceStep(span, count = 1) {
  const raw = span / Math.max(1, count);
  const base = Math.pow(10, Math.floor(Math.log10(raw)));
  const unit = raw / base;
  const factor = unit < 1.5 ? 1 : unit < 3 ? 2 : unit < 7 ? 5 : 10;
  return factor * base;
}

/**
 * Clamp a value into the unit interval `[0, 1]` — the fraction every
 * unit-space geometry stage emits. `NaN` passes through as `NaN` rather
 * than collapsing to a boundary, so a non-finite input stays visible to
 * the caller instead of silently rendering at an edge; callers that want a
 * drawable coordinate regardless guard with `Number.isFinite` first.
 *
 * @param {number} v
 * @returns {number}
 */
export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Geometric mean — the honest average of ratios (a 10× and a 0.1×
 * average to parity, where an arithmetic mean would claim 5×).
 * Non-finite and non-positive entries are skipped; `null` when nothing
 * usable remains.
 * @param {number[]} values
 * @returns {number|null}
 */
export function geoMean(values) {
  const usable = values.filter((v) => Number.isFinite(v) && v > 0);
  if (usable.length === 0) return null;
  return Math.exp(usable.reduce((sum, v) => sum + Math.log(v), 0) / usable.length);
}

/** Lanczos g=7 coefficients (shared, allocation-free). */
const _LANCZOS_G7 = [
  0.99999999999980993,
  676.5203681218851,
  -1259.1392167224028,
  771.32342877765313,
  -176.61502916214059,
  12.507343278686905,
  -0.13857109526572012,
  9.9843695780195716e-6,
  1.5056327351493116e-7,
];
