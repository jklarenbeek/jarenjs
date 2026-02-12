//@ts-check

import {
  mathf64_sqrt,
  mathf64_sin,
  mathf64_cos,
  mathf64_abs,
  mathf64_ceil,
  mathf64_floor,
  mathf64_round,
  mathf64_min,
  mathf64_max,
  mathf64_EPSILON, // TODO: take epsilon from float.js
  Float64,
} from './float64.js';

export class Vec2f64 {
  constructor(x = 0.0, y = 0.0) {
    this.x = +x;
    this.y = +y;
  }

  /**
   * Create a new 2 dimensional vector
   * @param {number | Vec2f64} x a floating point number or a Vec2f64 instance
   * @param {number | undefined} y a fl
   * @returns {Vec2f64} a new vector structure
   */
  static new(x = 0.0, y = 0.0) {
    return (x instanceof Vec2f64)
      ? new Vec2f64(+x.x, +x.y)
      : new Vec2f64(+x, +y);
  }

  //#region static vec2f pure operators

  static neg(v = def_Vec2f64) {
    return new Vec2f64(
      +(-(+v.x)),
      +(-(+v.y))
    );
  }

  static add(a = def_Vec2f64, b = def_Vec2f64) {
    return new Vec2f64(
      +(+a.x + +b.x),
      +(+a.y + +b.y)
    );
  }

  static adds(v = def_Vec2f64, scalar = 0.0) {
    return new Vec2f64(
      +(+v.x + +scalar),
      +(+v.y + +scalar)
    );
  }

  static addms(a = def_Vec2f64, b = def_Vec2f64, scalar = 1.0) {
    return new Vec2f64(
      +(+a.x + +(+b.x * +scalar)),
      +(+a.y + +(+b.y * +scalar)),
    );
  }

  static sub(a = def_Vec2f64, b = def_Vec2f64) {
    return new Vec2f64(
      +(+a.x - +b.x),
      +(+a.y - +b.y)
    );
  }

  static subs(v = def_Vec2f64, scalar = 0.0) {
    return new Vec2f64(
      +(+v.x - +scalar),
      +(+v.y - +scalar)
    );
  }

  static mul(a = def_Vec2f64, b = def_Vec2f64) {
    return new Vec2f64(
      +(+a.x * +b.x),
      +(+a.y * +b.y)
    );
  }

  static muls(v = def_Vec2f64, scalar = 0.0) {
    return new Vec2f64(
      +(+v.x * +scalar),
      +(+v.y * +scalar)
    );
  }

  static div(a = def_Vec2f64, b = def_Vec2f64) {
    return new Vec2f64(
      +(+a.x / +b.x),
      +(+a.y / +b.y)
    );
  }

  static divs(v = def_Vec2f64, scalar = 0.0) {
    return new Vec2f64(
      +(+v.x / +scalar),
      +(+v.y / +scalar)
    );
  }

  static inv(v = def_Vec2f64) {
    return new Vec2f64(
      1.0 / +v.x,
      1.0 / +v.y,
    );
  }

  static ceil(v = def_Vec2f64) {
    return new Vec2f64(
      +mathf64_ceil(+v.x),
      +mathf64_ceil(+v.y),
    );
  }

  static floor(v = def_Vec2f64) {
    return new Vec2f64(
      +mathf64_floor(+v.x),
      +mathf64_floor(+v.y),
    );
  }

  static round(v = def_Vec2f64) {
    return new Vec2f64(
      +mathf64_round(+v.x),
      +mathf64_round(+v.y),
    );
  }

  /**
   * Returns the minimum of two vectors
   * @param {Vec2f64} a the base vector
   * @param {Vec2f64} b the target vector
   * @returns {Vec2f64} the new minimum of two vectors
   */
  static min(a = def_Vec2f64, b = def_Vec2f64) {
    return new Vec2f64(
      +mathf64_min(+a.x, +b.x),
      +mathf64_min(+a.y, +b.y),
    );
  }

  /**
   * Returns the maximum of two vectors
   * @param {Vec2f64} a the base vector
   * @param {Vec2f64} b the target vector
   * @returns {Vec2f64} the new maximum of two vectors
   */
  static max(a = def_Vec2f64, b = def_Vec2f64) {
    return new Vec2f64(
      +mathf64_max(+a.x, +b.x),
      +mathf64_max(+a.y, +b.y),
    );
  }

  /**
   * Returns true if two vectors are strictly equal
   * @param {Vec2f64} a the base vector
   * @param {Vec2f64} b the target vector
   * @returns {boolean} true if two vectors are strictly equal
   */
  static eqstrict(a = def_Vec2f64, b = def_Vec2f64) {
    return a.x === b.x && a.y === b.y;
  }

  /**
   * Returns true if two vectors are equal within a small epsilon
   * @param {Vec2f64} a the base vector
   * @param {Vec2f64} b the target vector
   * @returns {boolean} true if two vectors are equal within a small epsilon
   */
  static equals(a = def_Vec2f64, b = def_Vec2f64) {
    const ax = +a.x;
    const ay = +a.y;
    const bx = +b.x;
    const by = +b.y;
    return (mathf64_abs(ax - bx)
      <= mathf64_EPSILON * mathf64_max(1.0, mathf64_abs(ax), mathf64_abs(bx))
      && mathf64_abs(ay - by)
      <= mathf64_EPSILON * mathf64_max(1.0, mathf64_abs(ay), mathf64_abs(by))
    );
  }

  /**
   * Returns the square of the magnitude of the vector
   * @param {Vec2f64} v the vector
   * @returns {number} the square of the magnitude of the vector
   */
  static mag2(v = def_Vec2f64) {
    return +Float64.mag2(v.x, v.y);
  }

  /**
   * Returns the magnitude of the vector
   * @param {Vec2f64} v the vector
   * @returns {number} the magnitude of the vector
   */
  static mag(v = def_Vec2f64) {
    return +Float64.mag(v.x, v.y);
  }

  /**
   * Returns the square of the distance between two vectors
   * @param {Vec2f64} a the base vector
   * @param {Vec2f64} b the target vector
   * @returns {number} the square of the distance between two vectors
   */
  static dist2(a = def_Vec2f64, b = def_Vec2f64) {
    const dx = +(+b.x - +a.x);
    const dy = +(+b.y - +a.y);
    return +Float64.mag2(dx, dy);
  }

  /**
   * Returns the distance between two vectors
   * @param {Vec2f64} a the base vector
   * @param {Vec2f64} b the target vector
   * @returns {number} the distance between two vectors
   */
  static dist(a = def_Vec2f64, b = def_Vec2f64) {
    return +mathf64_sqrt(+Vec2f64.dist2(a, b));
  }

  /**
   * Returns the dot product of two vectors
   * @param {Vec2f64} a the base vector
   * @param {Vec2f64} b the target vector
   * @returns {number} the dot product of two vectors
   */
  static dot(a = def_Vec2f64, b = def_Vec2f64) {
    return +Float64.dot(+a.x, +a.y, +b.x, +b.y);
  }

  /**
   * Returns the cross-product of two vectors
   * @param {Vec2f64} a the base vector
   * @param {Vec2f64} b the target vector
   * @returns {number} the cross-product of two vectors
   */
  static cross(a = def_Vec2f64, b = def_Vec2f64) {
    return +Float64.cross(+a.x, +a.y, +b.x, +b.y);
  }

  /**
   * Returns the cross-product of three vectors
   *
   * You can determine which side of a line a point is on
   * by converting the line to hyperplane form (implicitly
   * or explicitly) and then computing the perpendicular
   * (pseudo)distance from the point to the hyperplane.
   *
   * With the cross-product of two vectors A and B being the vector
   *
   * AxB = (AyBz − AzBy, AzBx − AxBz, AxBy − AyBx)
   * with Az and Bz being zero you are left with the third component of that vector
   *
   *    AxBy - AyBx
   *
   * With A being the vector from point a to b, and B being the vector from point a to c means
   *
   *    Ax = (b[x]-a[x])
   *    Ay = (b[y]-a[y])
   *    Bx = (c[x]-a[x])
   *    By = (c[y]-a[y])
   *
   * giving
   *
   *    AxBy - AyBx = (b[x]-a[x])*(c[y]-a[y])-(b[y]-a[y])*(c[x]-a[x])
   *
   * which is a scalar, the sign of that scalar will tell you wether point c
   * lies to the left or right of vector ab
   *
   * @param {Vec2f64} a the base vector
   * @param {Vec2f64} b the pivot vector
   * @param {Vec2f64} c the target vector
   * @returns {number} the cross-product of three vectors
   */
  static cross3(a = def_Vec2f64, b = def_Vec2f64, c = def_Vec2f64) {
    const ax = +a.x;
    const ay = +a.y;
    const bx = +b.x;
    const by = +b.y;
    const cx = +c.x;
    const cy = +c.y;
    return +(
      +(+(bx - ax) * +(cy - ay))
      - +(+(by - ay) * +(cx - ax))
    );
  }

  /**
   * Returns the angle in radians of its vector
   * @param {Vec2f64} v the base vector
   * @returns {number} the angle in radians of its vector
   */
  static theta(v = def_Vec2f64) {
    return +Float64.theta(v.x, v.y);
  }

  /**
   * Returns the angle in radians of its vector
   * @param {Vec2f64} v the base vector
   * @returns {number} the angle in radians of its vector
   */
  static phi(v = def_Vec2f64) {
    return +Float64.phi(+v.y, +Vec2f64.mag(v));
  }

  /**
   * Returns the unit vector of its vector
   * @param {Vec2f64} v the base vector
   * @returns {Vec2f64} the new unit vector of its vector
   */
  static unit(v = def_Vec2f64) {
    // const mag2 = +Vec2f64.mag2(v);
    // return Vec2f64.divs(
    //   v,
    //   +(mag2 > 0 ? 1.0 / +mathf64_sqrt(mag2) : 1),
    // );
    return Vec2f64.divs(v, +Vec2f64.mag(v));
  }

  /**
   * Returns the vector rotated 90 degrees counter-clockwise
   * @param {Vec2f64} v the base vector
   * @returns {Vec2f64} the new vector rotated 90 degrees counter-clockwise
   */
  static rotn90(v = def_Vec2f64) {
    return new Vec2f64(
      +v.y,
      +(-(+v.x))
    );
  }

  /**
   * Returns the vector rotated 90 degrees clockwise
   * @param {Vec2f64} v the base vector
   * @returns {Vec2f64} the new vector rotated 90 degrees clockwise
   */
  static rot90(v = def_Vec2f64) {
    return new Vec2f64(
      +(-(+v.y)),
      +v.x
    );
  }

  /**
   * Rotates a vector by the specified angle in radians
   * @param {Vec2f64} v the base vector
   * @param {number} radians the angle in radians
   * @returns {Vec2f64} transformed output vector
   */
  static rotate(v = def_Vec2f64, radians = 0.0) {
    return new Vec2f64(
      +(+(+v.x * +mathf64_cos(+radians)) - +(+v.y * +mathf64_sin(+radians))),
      +(+(+v.x * +mathf64_sin(+radians)) + +(+v.y * +mathf64_cos(+radians))),
    );
  }

  /**
   * Rotates a vector by the specified angle in radians about a specified vector
   * @param {Vec2f64} a the base vector to rotate
   * @param {Vec2f64} b the pivot vector to rotate about
   * @param {number} radians the angle in radians
   * @returns {Vec2f64} the new transformed output vector
   */
  static about(a = def_Vec2f64, b = def_Vec2f64, radians = 0.0) {
    return new Vec2f64(
      +(+b.x
        + +(+(+(+a.x - +b.x) * +mathf64_cos(+radians))
          - +(+(+a.y - +b.y) * +mathf64_sin(+radians)))),
      +(+b.y
        + +(+(+(+a.x - +b.x) * +mathf64_sin(+radians))
          + +(+(+a.y - +b.y) * +mathf64_cos(+radians)))),
    );
  }

  /**
   * Linearly interpolates between two vectors
   * @param {number} norm the interpolation factor
   * @param {Vec2f64} a the base vector
   * @param {Vec2f64} b the target vector
   * @returns {Vec2f64} the new interpolated vector
   */
  static lerp(norm = 0.0, a = def_Vec2f64, b = def_Vec2f64) {
    norm = +norm;
    const ax = +a.x;
    const ay = +a.y;
    const bx = +b.x;
    const by = +b.y;
    return new Vec2f64(
      +((ax + norm) * (bx - ax)),
      +((ay + norm) * (by - ay)),
    );
  }

  //#endregion

  //#region vec2f in-place operators

  /**
   * Negates the vector in place
   * @returns {Vec2f64} the negated vector
   */
  ineg() {
    this.x = +(-(+this.x));
    this.y = +(-(+this.y));
    return this;
  }

  /**
   * Adds a vector to the vector in place
   * @param {Vec2f64} v the target vector
   * @returns {Vec2f64} the sum of the vectors
   */
  iadd(v = def_Vec2f64) {
    this.x += +v.x;
    this.y += +v.y;
    return this;
  }

  /**
   * Adds a scalar to the vector in place
   * @param {number} scalar 
   * @returns {Vec2f64} the vector with the scalar added
   */
  iadds(scalar = 0.0) {
    this.x += +scalar;
    this.y += +scalar;
    return this;
  }

  /**
   * Adds a vector scaled by a scalar to the vector in place
   * @param {Vec2f64} v the target vector
   * @param {number} scalar 
   * @returns {Vec2f64} the vector with the vector scaled by the scalar added
   */
  iaddms(v = def_Vec2f64, scalar = 1.0) {
    this.x += +(+v.x * +scalar);
    this.y += +(+v.y * +scalar);
    return this;
  }
  
  /**
   * Subtracts a vector from the vector in place
   * @param {Vec2f64} v the target vector
   * @returns {Vec2f64} the difference of the vectors
   */
  isub(v = def_Vec2f64) {
    this.x -= +v.x;
    this.y -= +v.y;
    return this;
  }

  /**
   * Subtracts a scalar from the vector in place
   * @param {number} scalar 
   * @returns {Vec2f64} the vector with the scalar subtracted
   */
  isubs(scalar = 0.0) {
    this.x -= +scalar;
    this.y -= +scalar;
    return this;
  }

  /**
   * Multiplies the vector by a vector in place
   * @param {Vec2f64} v the target vector
   * @returns {Vec2f64} the product of the vectors
   */
  imul(v = def_Vec2f64) {
    this.x *= +v.x;
    this.y *= +v.y;
    return this;
  }

  /**
   * Multiplies the vector by a scalar in place
   * @param {number} scalar
   * @returns {Vec2f64} the vector with the scalar multiplied
   */
  imuls(scalar = 0.0) {
    this.x *= +scalar;
    this.y *= +scalar;
    return this;
  }

  /**
   * Divides the vector by a vector in place
   * @param {Vec2f64} v the target vector
   * @returns {Vec2f64} the quotient of the vectors
   */
  idiv(v = def_Vec2f64) {
    this.x /= +v.x;
    this.y /= +v.y;
    return this;
  }

  /**
   * Divides a vector by a scalar in place
   * @param {number} scalar 
   * @returns {Vec2f64} the vector with the scalar divided
   */
  idivs(scalar = 0.0) {
    this.x /= +scalar;
    this.y /= +scalar;
    return this;
  }

  /**
   * Inverts the vector in place
   * @returns {Vec2f64} the inverted vector
   */
  iinv() {
    this.x = 1.0 / +this.x;
    this.y = 1.0 / +this.y;
    return this;
  }

  /**
   * Rounds the vector in place
   * @returns {Vec2f64} the rounded vector
   */
  iceil() {
    this.x = +mathf64_ceil(+this.x);
    this.y = +mathf64_ceil(+this.y);
    return this;
  }

  /**
   * Floors the vector in place
   * @returns {Vec2f64} the floored vector
   */
  ifloor() {
    this.x = +mathf64_floor(+this.x);
    this.y = +mathf64_floor(+this.y);
    return this;
  }

  /**
   * Rounds the vector in place
   * @returns {Vec2f64} the rounded vector
   */
  iround() {
    this.x = +mathf64_round(+this.x);
    this.y = +mathf64_round(+this.y);
    return this;
  }
  
  /**
   * Returns the minimum of two vectors in place
   * @param {Vec2f64} v the target vector
   * @returns {Vec2f64} the minimum of two vectors
   */
  imin(v = def_Vec2f64) {
    this.x = +mathf64_min(+this.x, +v.x);
    this.y = +mathf64_min(+this.y, +v.y);
    return this;
  }
  
  /**
   * Returns the maximum of two vectors in place
   * @param {Vec2f64} v the target vector
   * @returns {Vec2f64} the maximum of two vectors
   */
  imax(v = def_Vec2f64) {
    this.x = +mathf64_max(+this.x, +v.x);
    this.y = +mathf64_max(+this.y, +v.y);
    return this;
  }

  /**
   * Returns the square of the magnitude of the vector
   * @returns {number} the square of the magnitude of the vector
   */
  mag2() {
    return +Float64.mag2(+this.x, +this.y);
  }

  /**
   * Returns the magnitude of the vector
   * @returns {number} the magnitude of the vector
   */
  mag() {
    return +Float64.mag(+this.x, +this.y);
  }

  /**
   * Returns the angle in radians of its vector
   * @returns {number} the angle in radians of its vector
   */
  phi() {
    return Vec2f64.phi(this);
  }

  /**
   * Returns the dot product of this vector and the target vector
   * @param {Vec2f64} v the target vector
   * @returns {number} the dot product of two vectors
   */
  dot(v = def_Vec2f64) {
    return Vec2f64.dot(this, v);
  }

  /**
   * Returns the cross-product of this vector and the target vector
   * @param {Vec2f64} v the target vector
   * @returns {number} The cross product of two vectors
   */
  cross(v = def_Vec2f64) {
    return Vec2f64.cross(this, v);
  }

  /**
   * Returns the cross-product of three vectors
   * @param {Vec2f64} a B
   * @param {Vec2f64} b C
   * @returns {number} The cross product of three vectors
   *
   */
  cross3(a = def_Vec2f64, b = def_Vec2f64) {
    return Vec2f64.cross3(this, a, b);
  }

  /**
   * Returns the angle in radians of its vector
   *
   * Math.atan2(dy, dx) === Math.asin(dy/Math.sqrt(dx*dx + dy*dy))
   *
   * @returns {number} the angle in radians of its vector
   */
  theta() {
    return Float64.theta(+this.x, +this.y);
  }


  /**
   * Returns the unit vector of its vector in place
   * @returns {Vec2f64} the unit vector of its vector
   */
  iunit() {
    return this.idivs(+this.mag());
  }

  /**
   * Rotates a vector 90 degrees counter-clockwise in place
   * @returns {Vec2f64} the vector rotated 90 degrees counter-clockwise
   */
  irotn90() {
    this.x = +this.y;
    this.y = +(-(+this.x));
    return this;
  }

  /**
   * Rotates a vector 90 degrees clockwise in place
   * @returns {Vec2f64} the vector rotated 90 degrees clockwise
   */
  irot90() {
    this.x = +(-(+this.y));
    this.y = +this.x;
    return this;
  }

  /**
   * Rotates a vector by the specified angle in radians in place
   * @param {number} radians  angle in radians
   * @returns {Vec2f64} transformed output vector
   */
  irotate(radians = 0.0) {
    this.x = +(+(+this.x * +mathf64_cos(+radians)) - +(+this.y * +mathf64_sin(+radians)));
    this.y = +(+(+this.x * +mathf64_sin(+radians)) + +(+this.y * +mathf64_cos(+radians)));
    return this;
  }

  /**
   * Rotates a vector by the specified angle in radians about a specified vector in place
   * @param {Vec2f64} v the pivot vector
   * @param {number} radians the angle in radians to rotate by
   * @returns {Vec2f64} transformed output vector
   */
  iabout(v = def_Vec2f64, radians = 0.0) {
    this.x = +(+v.x + +(+(+(+this.x - +v.x) * +mathf64_cos(+radians))
      - +(+(+this.y - +v.y) * +mathf64_sin(+radians))));
    this.y = +(+v.y + +(+(+(+this.x - +v.x) * +mathf64_sin(+radians))
      + +(+(+this.y - +v.y) * +mathf64_cos(+radians))));
    return this;
  }

  //#endregion

}

export const def_Vec2f64 = Object.freeze(Object.seal(Vec2f64.new()));
