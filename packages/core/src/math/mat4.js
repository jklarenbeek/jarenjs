//@ts-check
/**
 * @file A minimal 4×4 matrix kernel (Part A4) for the x·y·z plotter and
 * any future 3D consumer (Mermaid 3D is a candidate — see ROADMAP).
 *
 * Matrices are `Float64Array(16)` in **column-major** order (the WebGL /
 * glMatrix convention): element `m[col * 4 + row]`. Every factory returns
 * a fresh array; `multiply` composes right-to-left like linear algebra
 * (`multiply(a, b)` applies `b` then `a` to a column vector).
 */

/** @typedef {Float64Array} Mat4Array */

export class Mat4 {
  /** @returns {Mat4Array} the 4×4 identity. */
  static identity() {
    const m = new Float64Array(16);
    m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
    return m;
  }

  /**
   * `a · b` (column-major). Neither operand is mutated.
   * @param {Mat4Array} a @param {Mat4Array} b
   * @returns {Mat4Array}
   */
  static multiply(a, b) {
    const out = new Float64Array(16);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        let s = 0;
        for (let k = 0; k < 4; k++) {
          s += a[k * 4 + row] * b[col * 4 + k];
        }
        out[col * 4 + row] = s;
      }
    }
    return out;
  }

  /** @param {number} rad @returns {Mat4Array} */
  static rotationX(rad) {
    const c = Math.cos(rad); const s = Math.sin(rad);
    const m = Mat4.identity();
    m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
    return m;
  }

  /** @param {number} rad @returns {Mat4Array} */
  static rotationY(rad) {
    const c = Math.cos(rad); const s = Math.sin(rad);
    const m = Mat4.identity();
    m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
    return m;
  }

  /** @param {number} rad @returns {Mat4Array} */
  static rotationZ(rad) {
    const c = Math.cos(rad); const s = Math.sin(rad);
    const m = Mat4.identity();
    m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
    return m;
  }

  /** @param {number} tx @param {number} ty @param {number} tz @returns {Mat4Array} */
  static translation(tx, ty, tz) {
    const m = Mat4.identity();
    m[12] = tx; m[13] = ty; m[14] = tz;
    return m;
  }

  /** @param {number} sx @param {number} sy @param {number} sz @returns {Mat4Array} */
  static scaling(sx, sy, sz) {
    const m = new Float64Array(16);
    m[0] = sx; m[5] = sy; m[10] = sz; m[15] = 1;
    return m;
  }

  /**
   * Orthographic projection.
   * @param {number} l @param {number} r @param {number} b @param {number} t
   * @param {number} n @param {number} f
   * @returns {Mat4Array}
   */
  static ortho(l, r, b, t, n, f) {
    const m = new Float64Array(16);
    m[0] = 2 / (r - l);
    m[5] = 2 / (t - b);
    m[10] = -2 / (f - n);
    m[12] = -(r + l) / (r - l);
    m[13] = -(t + b) / (t - b);
    m[14] = -(f + n) / (f - n);
    m[15] = 1;
    return m;
  }

  /**
   * Perspective projection (right-handed, clip space z in [-1, 1]).
   * @param {number} fovy vertical field of view, radians
   * @param {number} aspect width / height
   * @param {number} n near plane (> 0)
   * @param {number} f far plane
   * @returns {Mat4Array}
   */
  static perspective(fovy, aspect, n, f) {
    const t = 1 / Math.tan(fovy / 2);
    const m = new Float64Array(16);
    m[0] = t / aspect;
    m[5] = t;
    m[10] = (f + n) / (n - f);
    m[11] = -1;
    m[14] = (2 * f * n) / (n - f);
    return m;
  }

  /**
   * Transform a 3D point (implicit w = 1) by `m`, returning the
   * perspective-divided `{ x, y, z, w }` (w is the pre-divide clip w, so
   * callers can reject points behind the camera).
   * @param {Mat4Array} m @param {number} x @param {number} y @param {number} z
   * @returns {{ x: number, y: number, z: number, w: number }}
   */
  static transformPoint(m, x, y, z) {
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    const w = cw === 0 ? 1 : cw;
    return { x: cx / w, y: cy / w, z: cz / w, w: cw };
  }
}
