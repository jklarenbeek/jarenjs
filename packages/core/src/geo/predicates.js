//@ts-check

//#region Robust geometric predicates
// The orientation test every spatial operation rests on: is point c left
// of, right of, or exactly on the directed line a->b? Point-in-polygon,
// segment intersection, convex hull and ring winding are all sign tests
// on this one determinant.
//
// Computing it directly in floating point is WRONG, not merely imprecise.
// The subtractions and products each round, and on near-collinear input
// the accumulated error can exceed the determinant itself, so the sign
// flips. A predicate that returns the wrong sign is not a small error:
// it makes a containment test contradict itself and a clipper emit
// self-intersecting output.
//
// The insidious part is that it does not fail on ordinary data. It needs
// coordinates that are close to collinear relative to their magnitude —
// which is exactly what real survey and OpenStreetMap data contains, and
// exactly what a hand-written test does not. So the exact path is here
// from the start rather than added after something looked correct.
//
// The method is Shewchuk's adaptive precision arithmetic (Jonathan R.
// Shewchuk, "Adaptive Precision Floating-Point Arithmetic and Fast
// Robust Geometric Predicates", 1996): evaluate with a cheap error
// bound, and only when the sign is not certain fall back to exact
// arithmetic carried in non-overlapping floating-point expansions. The
// common case pays one comparison over the naive form; the exact path
// runs only where the naive form would have been wrong.

// The unit roundoff for IEEE doubles, and Shewchuk's derived bounds.
const EPSILON = 1.1102230246251565e-16; // 2^-53
const CCW_ERRBOUND_A = (3 + 16 * EPSILON) * EPSILON;
const CCW_ERRBOUND_B = (2 + 12 * EPSILON) * EPSILON;
const CCW_ERRBOUND_C = (9 + 64 * EPSILON) * EPSILON * EPSILON;
const RESULT_ERRBOUND = (3 + 8 * EPSILON) * EPSILON;

// Dekker's splitter, 2^ceil(53/2) + 1: splits a double into two halves
// whose product with another half is exact.
const SPLITTER = 134217729;

// Scratch expansions. Reused across calls to keep the exact path
// allocation-free; the predicate is synchronous and never re-entered.
const B = new Float64Array(4);
const C1 = new Float64Array(8);
const C2 = new Float64Array(12);
const D = new Float64Array(16);
const U = new Float64Array(4);

/**
 * Sum two expansions, eliminating zero components (Shewchuk's
 * `fast_expansion_sum_zeroelim`). Both inputs are non-overlapping and
 * increasing in magnitude; so is the result.
 * @param {number} elen
 * @param {Float64Array} e
 * @param {number} flen
 * @param {Float64Array} f
 * @param {Float64Array} h - output
 * @returns {number} the number of components written
 */
function expansionSum(elen, e, flen, f, h) {
  let enow = e[0];
  let fnow = f[0];
  let eindex = 0;
  let findex = 0;
  let Q, Qnew, hh, bvirt;
  if ((fnow > enow) === (fnow > -enow)) {
    Q = enow;
    enow = e[++eindex];
  }
  else {
    Q = fnow;
    fnow = f[++findex];
  }
  let hindex = 0;
  if (eindex < elen && findex < flen) {
    if ((fnow > enow) === (fnow > -enow)) {
      Qnew = enow + Q;
      hh = Q - (Qnew - enow);
      enow = e[++eindex];
    }
    else {
      Qnew = fnow + Q;
      hh = Q - (Qnew - fnow);
      fnow = f[++findex];
    }
    Q = Qnew;
    if (hh !== 0)
      h[hindex++] = hh;
    while (eindex < elen && findex < flen) {
      if ((fnow > enow) === (fnow > -enow)) {
        Qnew = Q + enow;
        bvirt = Qnew - Q;
        hh = Q - (Qnew - bvirt) + (enow - bvirt);
        enow = e[++eindex];
      }
      else {
        Qnew = Q + fnow;
        bvirt = Qnew - Q;
        hh = Q - (Qnew - bvirt) + (fnow - bvirt);
        fnow = f[++findex];
      }
      Q = Qnew;
      if (hh !== 0)
        h[hindex++] = hh;
    }
  }
  while (eindex < elen) {
    Qnew = Q + enow;
    bvirt = Qnew - Q;
    hh = Q - (Qnew - bvirt) + (enow - bvirt);
    enow = e[++eindex];
    Q = Qnew;
    if (hh !== 0)
      h[hindex++] = hh;
  }
  while (findex < flen) {
    Qnew = Q + fnow;
    bvirt = Qnew - Q;
    hh = Q - (Qnew - bvirt) + (fnow - bvirt);
    fnow = f[++findex];
    Q = Qnew;
    if (hh !== 0)
      h[hindex++] = hh;
  }
  if (Q !== 0 || hindex === 0)
    h[hindex++] = Q;
  return hindex;
}

/**
 * The approximate value of an expansion: its components summed.
 * @param {number} elen
 * @param {Float64Array} e
 * @returns {number}
 */
function estimate(elen, e) {
  let Q = e[0];
  for (let i = 1; i < elen; i++)
    Q += e[i];
  return Q;
}

/**
 * The exact stage: the determinant as an expansion, returning its
 * (exactly correct) leading component.
 * @returns {number}
 */
function orient2dExact(ax, ay, bx, by, cx, cy, detsum) {
  let acx, acy, bcx, bcy, acxtail, acytail, bcxtail, bcytail;
  let s1, s0, t1, t0, u3, bvirt, c, ahi, alo, bhi, blo, _i, _j, _0;

  acx = ax - cx;
  bcx = bx - cx;
  acy = ay - cy;
  bcy = by - cy;

  // two_product(acx, bcy) and two_product(acy, bcx), exactly
  s1 = acx * bcy;
  c = SPLITTER * acx;
  ahi = c - (c - acx);
  alo = acx - ahi;
  c = SPLITTER * bcy;
  bhi = c - (c - bcy);
  blo = bcy - bhi;
  s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
  t1 = acy * bcx;
  c = SPLITTER * acy;
  ahi = c - (c - acy);
  alo = acy - ahi;
  c = SPLITTER * bcx;
  bhi = c - (c - bcx);
  blo = bcx - bhi;
  t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);

  // two_two_diff(s1, s0, t1, t0) -> B
  _i = s0 - t0;
  bvirt = s0 - _i;
  B[0] = s0 - (_i + bvirt) + (bvirt - t0);
  _j = s1 + _i;
  bvirt = _j - s1;
  _0 = s1 - (_j - bvirt) + (_i - bvirt);
  _i = _0 - t1;
  bvirt = _0 - _i;
  B[1] = _0 - (_i + bvirt) + (bvirt - t1);
  u3 = _j + _i;
  bvirt = u3 - _j;
  B[2] = _j - (u3 - bvirt) + (_i - bvirt);
  B[3] = u3;

  let det = estimate(4, B);
  let errbound = CCW_ERRBOUND_B * detsum;
  if (det >= errbound || -det >= errbound)
    return det;

  // recover the exact tails of the four differences
  bvirt = ax - acx;
  acxtail = ax - (acx + bvirt) + (bvirt - cx);
  bvirt = bx - bcx;
  bcxtail = bx - (bcx + bvirt) + (bvirt - cx);
  bvirt = ay - acy;
  acytail = ay - (acy + bvirt) + (bvirt - cy);
  bvirt = by - bcy;
  bcytail = by - (bcy + bvirt) + (bvirt - cy);

  if (acxtail === 0 && acytail === 0 && bcxtail === 0 && bcytail === 0)
    return det; // the differences were exact, so B is the exact answer

  errbound = CCW_ERRBOUND_C * detsum + RESULT_ERRBOUND * Math.abs(det);
  det += (acx * bcytail + bcy * acxtail) - (acy * bcxtail + bcx * acytail);
  if (det >= errbound || -det >= errbound)
    return det;

  // the full exact determinant, accumulated through the expansions
  let len = expansionSum(4, B, twoProduct(acxtail, bcy, U), U, C1);
  len = expansionSum(len, C1, twoProduct(acx, bcytail, U), U, C2);
  const c1len = len;
  len = expansionSum(c1len, C2, twoProduct(acytail, bcx, U, true), U, C1);
  len = expansionSum(len, C1, twoProduct(acy, bcxtail, U, true), U, D);
  return D[len - 1];
}

/**
 * Exact product of two doubles as a two-component expansion, written
 * into `out`. With `negate` the product's sign is flipped, which is how
 * the subtracted half of the determinant is folded into a sum.
 * @returns {number} always 2
 */
function twoProduct(a, b, out, negate = false) {
  const x = a * b;
  let c = SPLITTER * a;
  const ahi = c - (c - a);
  const alo = a - ahi;
  c = SPLITTER * b;
  const bhi = c - (c - b);
  const blo = b - bhi;
  const y = alo * blo - (x - ahi * bhi - alo * bhi - ahi * blo);
  out[0] = negate ? -y : y;
  out[1] = negate ? -x : x;
  return 2;
}

/**
 * The orientation of the triple (a, b, c): **positive** when c lies to
 * the left of the directed line a->b (counter-clockwise), **negative**
 * when it lies to the right, and **exactly zero** when the three points
 * are collinear.
 *
 * The sign is always correct. The magnitude is twice the signed area of
 * the triangle, but only approximately — callers must use this for its
 * sign, and `ringArea` for a measurement.
 *
 * Coordinates are raw numbers rather than vector objects so a GeoJSON
 * position (`[lon, lat]`) can be passed straight through.
 *
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {number} cx
 * @param {number} cy
 * @returns {number} positive, negative, or zero
 * @example
 * orient2d(0, 0, 1, 0, 0, 1);  // > 0 — (0,1) is left of the x axis
 * orient2d(0, 0, 1, 0, 0, -1); // < 0
 * orient2d(0, 0, 2, 2, 1, 1);  // 0 — exactly collinear
 */
export function orient2d(ax, ay, bx, by, cx, cy) {
  // the same two halves the exact stage forms, in the same order: a
  // mismatch here would make the filter and the fallback disagree about
  // which direction is counter-clockwise
  const detleft = (ax - cx) * (by - cy);
  const detright = (ay - cy) * (bx - cx);
  const det = detleft - detright;

  // the cheap filter: when the two halves have opposite signs, or one is
  // zero, the subtraction cannot have destroyed the sign
  const detsum = detleft > 0
    ? (detright <= 0 ? det : detleft + detright)
    : detleft < 0
      ? (detright >= 0 ? det : -detleft - detright)
      : det;
  if (detleft === 0 || detright === 0 || (detleft > 0) !== (detright > 0))
    return det;

  const errbound = CCW_ERRBOUND_A * detsum;
  if (det >= errbound || -det >= errbound)
    return det;

  return orient2dExact(ax, ay, bx, by, cx, cy, detsum);
}

/**
 * The same determinant without the exact fallback: fast, and **wrong on
 * near-collinear input**.
 *
 * This exists for the one case where that is acceptable — a bounding
 * pre-filter whose answer is checked by `orient2d` afterwards. Anything
 * that decides containment, winding or intersection must use `orient2d`;
 * a wrong sign there is a wrong answer, not a rounding error.
 *
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {number} cx
 * @param {number} cy
 * @returns {number}
 */
export function orient2dFast(ax, ay, bx, by, cx, cy) {
  return (ax - cx) * (by - cy) - (ay - cy) * (bx - cx);
}

//#endregion
