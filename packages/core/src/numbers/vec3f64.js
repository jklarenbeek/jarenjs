//@ts-check

import { mathf64_sqrt } from './float64.js';

import { Vec2f64 } from './vec2f64.js';

/**
 * @class Vec3f64
 * @classdesc A 3-dimensional vector of float64 values
 * @property {double} x - The x component of the vector
 * @property {double} y - The y component of the vector
 * @property {double} z - The z component of the vector
 */
export class Vec3f64 {
  constructor(x = 0.0, y = 0.0, z = 0.0) {
    this.x = +x;
    this.y = +y;
    this.z = +z;
  }

  /**
   * Create a new 3 dimensional vector
   * @param {number | Vec3f64 | Vec2f64} x a floating point number or a Vec3f64 instance or a vec2f64 instance
   * @param {number | undefined} y a floating point number
   * @param {number | undefined} z a floating point number
   * @returns {Vec3f64} a new vector structure
   */
  static new(x = 0.0, y = 0.0, z = 0.0) {
    return (x instanceof Vec3f64)
      ? new Vec3f64(+x.x, +x.y, +x.z)
      : (x instanceof Vec2f64)
        ? new Vec3f64(+x.x, +x.y, +z) // TODO: check this
        : new Vec3f64(+x, +y, +z);
  }

  //#region static vec3f pure operators

  static add(a = def_Vec3f64, b = def_Vec3f64) {
    return new Vec3f64(
      +(+a.x + +b.x),
      +(+a.y + +b.y),
      +(+a.z + +b.z),
    );
  }

  static adds(a = def_Vec3f64, scalar = 0.0) {
    return new Vec3f64(
      +(+a.x + +scalar),
      +(+a.y + +scalar),
      +(+a.z + +scalar),
    );
  }

  static sub(a = def_Vec3f64, b = def_Vec3f64) {
    return new Vec3f64(
      +(+a.x - +b.x),
      +(+a.y - +b.y),
      +(+a.z - +b.z),
    );
  }

  static subs(a = def_Vec3f64, scalar = 0.0) {
    return new Vec3f64(
      +(+a.x - +scalar),
      +(+a.y - +scalar),
      +(+a.z - +scalar),
    );
  }

  static div(a = def_Vec3f64, b = def_Vec3f64) {
    return new Vec3f64(
      +(+a.x / +b.x),
      +(+a.y / +b.y),
      +(+a.z / +b.z),
    );
  }
  static divs(v = def_Vec3f64, scalar = 0.0) {
    return new Vec3f64(
      +(+v.x / +scalar),
      +(+v.y / +scalar),
      +(+v.z / +scalar),
    );
  }

  static mul(a = def_Vec3f64, b = def_Vec3f64) {
    return new Vec3f64(
      +(+a.x * +b.x),
      +(+a.y * +b.y),
      +(+a.z * +b.z),
    );
  }
  static muls(v = def_Vec3f64, scalar = 0.0) {
    return new Vec3f64(
      +(+v.x * +scalar),
      +(+v.y * +scalar),
      +(+v.z * +scalar),
    );
  }

  /**
   * Returns the dot product of two 3d vectors
   * @param {Vec3f64} a the base vector
   * @param {Vec3f64} b the target vector
   * @returns {number} the dot product of two vectors
   */
  static dot(a = def_Vec3f64, b = def_Vec3f64) {
    return +(+(+a.x * +b.x) + +(+a.y * +b.y) + +(+a.z * +b.z));
  }

  /**
   * Returns the cross product of two 3d vectors
   * @param {Vec3f64} a the base vector
   * @param {Vec3f64} b the target vector
   * @returns {Vec3f64} the cross product of two vectors
   */
  static cross(a = def_Vec3f64, b = def_Vec3f64) {
    return new Vec3f64(
      +(+(+a.y * +b.z) - +(+a.z * +b.y)),
      +(+(+a.z * +b.x) - +(+a.x * +b.z)),
      +(+(+a.x * +b.y) - +(+a.y * +b.x)),
    );
  }

  static mag2(v = def_Vec3f64) {
    return +Vec3f64.dot(v, v);
  }

  static mag(v = def_Vec3f64) {
    return +mathf64_sqrt(+Vec3f64.mag2(v));
  }

  static unit(v = def_Vec3f64) {
    return Vec3f64.divs(v, +Vec3f64.mag(v));
  }

  //#endregion

  //#region vec3f in-place operators

  iadd(v = def_Vec3f64) {
    this.x += +(+v.x);
    this.y += +(+v.y);
    this.z += +(+v.z);
    return this;
  }

  iadds(scalar = 0.0) {
    this.x += +scalar;
    this.y += +scalar;
    this.z += +scalar;
    return this;
  }

  isub(v = def_Vec3f64) {
    this.x -= +(+v.x);
    this.y -= +(+v.y);
    this.z -= +(+v.z);
    return this;
  }

  isubs(scalar = 0.0) {
    this.x -= +scalar;
    this.y -= +scalar;
    this.z -= +scalar;
    return this;
  }

  idiv(v = def_Vec3f64) {
    this.x /= +(+v.x);
    this.y /= +(+v.y);
    this.z /= +(+v.z);
    return this;
  }

  idivs(scalar = 0.0) {
    this.x /= +scalar;
    this.y /= +scalar;
    this.z /= +scalar;
    return this;
  }

  imul(v = def_Vec3f64) {
    this.x *= +(+v.x);
    this.y *= +(+v.y);
    this.z *= +(+v.z);
    return this;
  }

  imuls(scalar = 0.0) {
    this.x *= +scalar;
    this.y *= +scalar;
    this.z *= +scalar;
    return this;
  }

  dot(v = def_Vec3f64) {
    return Vec3f64.dot(this, v);
  }

  icross(v = def_Vec3f64) {
    this.x = +(+(+this.y * +v.z) - +(+this.z * +v.y));
    this.y = +(+(+this.z * +v.x) - +(+this.x * +v.z));
    this.z = +(+(+this.x * +v.y) - +(+this.y * +v.x));
    return this;
  }

  mag2() {
    return Vec3f64.mag2(this);
  }

  mag() {
    return Vec3f64.mag(this);
  }

  iunit() {
    return this.idivs(+this.mag());
  }

  //#endregion
}

export const def_Vec3f64 = Object.freeze(Object.seal(Vec3f64.new()));

