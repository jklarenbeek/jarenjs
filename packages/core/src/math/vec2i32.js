import {
  mathi32_MULTIPLIER,
  mathi32_sqrt,
  mathi32_asin,
  mathi32_atan2,
} from './int32.js';

export class Vec2i32 {
  /**
   * @param {number | undefined} x
   * @param {number | undefined} y
   */
  constructor(x = 0, y = 0) {
    this.x = x | 0;
    this.y = y | 0;
  }

  static new(x = 0, y = 0) {
    return new Vec2i32(x | 0, y | 0);
  }

  new() {
    return new Vec2i32(this.x | 0, this.y | 0);
  }

  //#region static primitive operators

  static neg(v = def_Vec2i32) {
    return new Vec2i32(-(v.x | 0) | 0, -(v.y | 0) | 0);
  }
  static add(a = def_Vec2i32, b = def_Vec2i32) {
    return new Vec2i32(
      ((a.x | 0) + (b.x | 0)) | 0,
      ((a.y | 0) + (b.y | 0)) | 0,
    );
  }
  static adds(v = def_Vec2i32, scalar = 0) {
    scalar = scalar | 0;
    return new Vec2i32(((v.x | 0) + scalar) | 0, ((v.y | 0) + scalar) | 0);
  }

  static sub(a = def_Vec2i32, b = def_Vec2i32) {
    return new Vec2i32(
      ((a.x | 0) - (b.x | 0)) | 0,
      ((a.y | 0) - (b.y | 0)) | 0,
    );
  }
  static subs(a = def_Vec2i32, scalar = 0) {
    scalar = scalar | 0;
    return new Vec2i32(((a.x | 0) - scalar) | 0, ((a.y | 0) - scalar) | 0);
  }

  static mul(a = def_Vec2i32, b = def_Vec2i32) {
    return new Vec2i32(
      ((a.x | 0) * (b.x | 0)) | 0,
      ((a.y | 0) * (b.y | 0)) | 0,
    );
  }
  static muls(v = def_Vec2i32, scalar = 0) {
    scalar = scalar | 0;
    return new Vec2i32(((v.x | 0) * scalar) | 0, ((v.y | 0) * scalar) | 0);
  }

  static div(a = def_Vec2i32, b = def_Vec2i32) {
    return new Vec2i32(
      ((a.x | 0) / (b.x | 0)) | 0,
      ((a.y | 0) / (b.y | 0)) | 0,
    );
  }
  static divs(v = def_Vec2i32, scalar = 0) {
    scalar = scalar | 0;
    return new Vec2i32(((v.x | 0) / scalar) | 0, ((v.y | 0) / scalar) | 0);
  }

  //#endregion

  //#region static scalar products

  static mag2(v = def_Vec2i32) {
    return ((v.x | 0) * (v.x | 0) + (v.y | 0) * (v.y | 0)) | 0;
  }

  static mag(v = def_Vec2i32) {
    return mathi32_sqrt(+Vec2i32.mag2(v)) | 0;
  }

  static dot(a = def_Vec2i32, b = def_Vec2i32) {
    return ((a.x | 0) * (b.x | 0) + (a.y | 0) * (b.y | 0)) | 0;
  }

  static cross(a = def_Vec2i32, b = def_Vec2i32) {
    return ((a.x | 0) * (b.y | 0) - (a.y | 0) * (b.x | 0)) | 0;
  }

  static cross3(a = def_Vec2i32, b = def_Vec2i32, c = def_Vec2i32) {
    return (
      ((b.x | 0) - (a.x | 0)) * ((c.y | 0) - (a.y | 0)) -
      ((b.y | 0) - (a.y | 0)) * ((c.x | 0) - (a.x | 0))
    );
  }

  static thetaEx(v = def_Vec2i32) {
    return (mathi32_MULTIPLIER * mathi32_atan2(v.y | 0, v.x | 0)) | 0;
  }

  static phiEx(v = def_Vec2i32) {
    return mathi32_MULTIPLIER * mathi32_asin((v.y | 0) / Vec2i32.mag(v));
  }

  //#endregion

  //#region static advanced functions

  static norm(v = def_Vec2i32) {
    return Vec2i32.divs(v, Vec2i32.mag(v) | 0);
  }

  static rotn90(v = def_Vec2i32) {
    return new Vec2i32(v.y | 0, -(v.x | 0) | 0);
  }

  static rot90(v = def_Vec2i32) {
    return new Vec2i32(-(v.y | 0) | 0, v.x | 0);
  }

  //#endregion

  //#region instance primitive operators

  ineg() {
    this.x = -(this.x | 0) | 0;
    this.y = -(this.y | 0) | 0;
    return this;
  }

  iadd(v = def_Vec2i32) {
    this.x += v.x | 0 | 0;
    this.y += v.y | 0 | 0;
    return this;
  }

  iadds(scalar = 0) {
    scalar = scalar | 0;
    this.x += scalar | 0;
    this.y += scalar | 0;
    return this;
  }

  isub(v = def_Vec2i32) {
    this.x -= v.x | 0 | 0;
    this.y -= v.y | 0 | 0;
    return this;
  }

  isubs(scalar = 0) {
    scalar = scalar | 0;
    this.x -= scalar | 0;
    this.y -= scalar | 0;
    return this;
  }

  imul(v = def_Vec2i32) {
    this.x *= v.x | 0 | 0;
    this.y *= v.y | 0 | 0;
    return this;
  }

  imuls(scalar = 0) {
    scalar = scalar | 0;
    this.x *= scalar;
    this.y *= scalar;
    return this;
  }

  idiv(v = def_Vec2i32) {
    this.x /= v.x | 0 | 0;
    this.y /= v.y | 0 | 0;
    return this;
  }

  idivs(scalar = 0) {
    scalar = scalar | 0;
    this.x /= scalar;
    this.y /= scalar;
    return this;
  }

  //#endregion

  //#region instance advanced functions
  inorm(v = def_Vec2i32) {
    return this.idivs(Vec2i32.mag(v) | 0);
  }

  irotn90() {
    const t = this.x | 0;
    this.x = this.y | 0;
    this.y = -t | 0;
    return this;
  }

  irot90() {
    const t = this.y | 0;
    this.x = -t | 0;
    this.y = this.x | 0;
    return this;
  }

  //#endregion

  /** Just Some Notes
const fastSin_B = 1.2732395; // 4/pi
const fastSin_C = -0.40528473; // -4 / (pi²)
export function fastSin(value) {
  // See  for graph and equations
  // https://www.desmos.com/calculator/8nkxlrmp7a
  // logic explained here : http://devmaster.net/posts/9648/fast-and-accurate-sine-cosine

  return (value > 0)
    ? fastSin_B * value - fastSin_C * value * value
    : fastSin_B * value + fastSin_C * value * value;
}

export function fastSin2(a) {
  let b, c;
  return a *= 5214
    , c = a << 17
    , a -= 8192
    , a <<= 18
    , a >>= 18
    , a = a * a >> 12
    , b = 19900 - (3516 * a >> 14)
    , b = 4096 - (a * b >> 16)
    , 0 > c && (b = -b)
    , 2.44E-4 * b;
};

export function fastSin3(a) {
  a *= 5214;
  let b = a << 17;
  a = a - 8192 << 18 >> 18;
  a = a * a >> 12;
  a = 4096 - (a * (19900 - (3516 * a >> 14)) >> 16);
  0 > b && (a = -a);
  return 2.44E-4 * a
};
*/
}

export const def_Vec2i32 = Object.freeze(Object.seal(Vec2i32.new()));
