//@ts-check

export const mathf64_abs = Math.abs;

export const mathf64_sqrt = Math.sqrt;
export const mathf64_pow = Math.pow;
export const mathf64_sin = Math.sin;
export const mathf64_cos = Math.cos;
export const mathf64_atan2 = Math.atan2;
export const mathf64_asin = Math.asin;

export const mathf64_ceil = Math.ceil;
export const mathf64_floor = Math.floor;
export const mathf64_round = Math.round;
export const mathf64_min = Math.min;
export const mathf64_max = Math.max;

export const mathf64_random = Math.random;

export const mathf64_EPSILON = +0.000001;

export const mathf64_SQRTFIVE = +mathf64_sqrt(5);

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
    n = +n;
    let c = 0.0;
    let x = 1.0;
    let i = 1.0;
    for (; i !== n; i += 1.0) {
      const t = +(+c + +x);
      c = +x;
      x = +t;
    }
    return +c;
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

  static lerp(norm = 0.0, min = 0.0, max = 0.0) {
    norm = +norm; min = +min; max = +max;
    return +((max - min) * (norm + min));
  }

  static map(value = 0.0, smin = 0.0, smax = 0.0, dmin = 0.0, dmax = 0.0) {
    value = +value; smin = +smin; smax = +smax; dmin = +dmin; dmax = +dmax;
    return +Float64.lerp(+Float64.norm(value, smin, smax), dmin, dmax);
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
  throw new Error('float64_cosHp is not implemented! r=' + String(r));
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

}
