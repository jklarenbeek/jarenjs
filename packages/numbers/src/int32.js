import { mathf64_random } from './float64.js';

export const mathi32_MULTIPLIER = 10000;

export const mathi32_abs = Math.abs;
export const mathi32_round = Math.round;
export const mathi32_ceil = Math.ceil;
export const mathi32_floor = Math.floor;
export const mathi32_min = Math.min;
export const mathi32_max = Math.max;

export const mathi32_sqrt = Math.sqrt;
export const mathi32_asin = Math.asin;
export const mathi32_atan2 = Math.atan2;

export const mathi32_PI = (Math.PI * mathi32_MULTIPLIER) | 0;
export const mathi32_PI2 = (mathi32_PI * 2) | 0;
export const mathi32_PI1H = (mathi32_PI / 2) | 0;
export const mathi32_PI41 = ((4 / Math.PI) * mathi32_MULTIPLIER) | 0;
export const mathi32_PI42 =
  ((4 / (Math.PI * Math.PI)) * mathi32_MULTIPLIER) | 0;

let random_seed = mathi32_abs(
  Date.now() ^ (+mathf64_random() * Number.MAX_SAFE_INTEGER),
);

export class Int32 {
  static random() {
    const x = Math.sin(random_seed++) * mathi32_MULTIPLIER;
    return x - Math.floor(x);
  }

  //#region mutliplier functions

  static sqrt(n = 0) {
    n = n | 0;
    return mathi32_sqrt(n) | 0;
  }

  static sqrtEx(n = 0) {
    n = n | 0;
    return (mathi32_MULTIPLIER * mathi32_sqrt(n)) | 0;
  }

  static fib(n = 0) {
    n = n | 0;
    let c = 0;
    let x = 1;
    let i = 1;
    for (; i !== n; i += 1) {
      const t = (c + x) | 0;
      c = x | 0;
      x = t | 0;
    }
    return c | 0;
  }

  static mag2(dx = 0, dy = 0) {
    dx = dx | 0;
    dy = dy | 0;
    return (dx * dx + dy * dy) | 0;
  }

  static hypot(dx = 0, dy = 0) {
    dx = dx | 0;
    dy = dy | 0;
    return Int32.sqrt(dx * dx + dy * dy) | 0;
  }

  static hypotEx(dx = 0, dy = 0) {
    dx = dx | 0;
    dy = dy | 0;
    return Int32.sqrtEx(dx * dx + dy * dy) | 0;
  }

  static dot(ax = 0, ay = 0, bx = 0, by = 0) {
    ax = ax | 0;
    ay = ay | 0;
    bx = bx | 0;
    by = by | 0;
    return (ax * bx + ay * by) | 0;
  }

  static cross(ax = 0, ay = 0, bx = 0, by = 0) {
    ax = ax | 0;
    ay = ay | 0;
    bx = bx | 0;
    by = by | 0;
    return (ax * by - bx * ay) | 0;
  }

  static norm(value = 0, min = 0, max = 0) {
    value = value | 0;
    min = min | 0;
    max = max | 0;
    return ((value - min) / (max - min)) | 0;
  }

  static lerp(norm = 0, min = 0, max = 0) {
    norm = norm | 0;
    min = min | 0;
    max = max | 0;
    return ((max - min) * (norm + min)) | 0;
  }

  static map(value = 0, smin = 0, smax = 0, dmin = 0, dmax = 0) {
    value = value | 0;
    smin = smin | 0;
    smax = smax | 0;
    dmin = dmin | 0;
    dmax = dmax | 0;
    // return int32_lerp(int32_norm(value, smin, smax), dmin, dmax) | 0;
    return (
      mathi32_round(((value - smin) * (dmax - dmin)) / (smax - smin) + dmin) | 0
    );
  }

  static clamp(value = 0, min = 0, max = 0) {
    value = value | 0;
    min = min | 0;
    max = max | 0;
    return (
      mathi32_min(
        mathi32_max(value, mathi32_min(min, max)),
        mathi32_max(min, max),
      ) | 0
    );
  }
  static clampu(value = 0, min = 0, max = 0) {
    value = value | 0;
    min = min | 0;
    max = max | 0;
    // return mathi32_min(mathi32_max(value, min), max)|0;
    return mathi32_max(min, mathi32_min(value, max)) | 0;
  }
  static clampu_u8a(value = 0) {
    value = value | 0;
    return -(
      (((255 - value) & ((value - 255) >> 31)) - 255) &
      ((((255 - value) & ((value - 255) >> 31)) - 255) >> 31)
    );
  }
  static clampu_u8b(value = 0) {
    value = value | 0;
    value &= -(value >= 0);
    return value | ~-!(value & -256);
  }

  static inRange(value = 0, min = 0, max = 0) {
    value = value | 0;
    min = min | 0;
    max = max | 0;
    min = mathi32_min(min, max) | 0;
    max = mathi32_max(min, max) | 0;
    return value >= min && value <= max;
  }

  //#endregion

  //#region collision
  static intersectsRange(smin = 0, smax = 0, dmin = 0, dmax = 0) {
    smin = smin | 0;
    smax = smax | 0;
    dmin = dmin | 0;
    dmax = dmax | 0;
    const _smin = mathi32_min(smin, smax) | 0;
    const _smax = mathi32_max(smin, smax) | 0;
    const _dmin = mathi32_min(dmin, dmax) | 0;
    const _dmax = mathi32_max(dmin, dmax) | 0;
    return _smax >= _dmin && _smin <= _dmax
  }

  static intersectsRect(
    ax = 0,
    ay = 0,
    aw = 0,
    ah = 0,
    bx = 0,
    by = 0,
    bw = 0,
    bh = 0,
  ) {
    ax = ax | 0;
    ay = ay | 0;
    aw = aw | 0;
    ah = ah | 0;
    bx = bx | 0;
    by = by | 0;
    bw = bw | 0;
    bh = bh | 0;
    const ix = Int32.intersectsRange(ax | 0, (ax + aw) | 0, bx | 0, (bx + bw) | 0);
    const iy = Int32.intersectsRange(ay | 0, (ay + ah) | 0, by | 0, (by + bh) | 0);

    return ix && iy;
  }

  //#endregion

  //#region trigonometry

  static toRadianEx(degrees = 0) {
    degrees = degrees | 0;
    return ((degrees * mathi32_PI) / 180) | 0;
  }

  static toDegreesEx(radians = 0) {
    radians = radians | 0;
    return ((mathi32_MULTIPLIER * radians * 180) / mathi32_PI) | 0;
  }

  static wrapRadians(r = 0) {
    r = r | 0;
    if (r > mathi32_PI) return (r - mathi32_PI2) | 0;
    else if (r < -mathi32_PI) return (r + mathi32_PI2) | 0;
    return r | 0;
  }

  static sinLpEx(r = 0) {
    r = r | 0;
    return (
      (r < 0
        ? mathi32_PI41 * r + mathi32_PI42 * r * r
        : mathi32_PI41 * r - mathi32_PI42 * r * r) | 0
    );
  }

  static sinLp(r = 0) {
    r = r | 0;
    //always wrap input angle between -PI and PI
    return Int32.sinLpEx(Int32.wrapRadians(r)) | 0;
  }

  //#endregion
}
