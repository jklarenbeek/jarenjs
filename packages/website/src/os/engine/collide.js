//@ts-check
/**
 * Mesh collision: triangle meshes behind a bounding-volume hierarchy, and
 * the queries the stage and the games ask of them — the nearest hit of a
 * ray (a pointer picking a block, a dancer looking for the floor), every
 * contact of a sphere (a monkey against a rock), the push-out that lets a
 * body slide along what it touched, a swept sphere that cannot tunnel
 * through a thin wall at speed, and the separating-axis test for convex
 * polygons on screen (cards on a board, a tap on a figure's outline).
 *
 * Everything is plain numbers in plain arrays: a mesh is built once from
 * `{ positions, indices }` and never mutated, a query allocates only its
 * answer, and no query reads the clock or the DOM — the same mesh answers
 * the same question in a test, a worker and a frame.
 */

/**
 * @typedef {[number, number, number]} V3
 * @typedef {{ positions: number[], indices: number[] }} Geometry
 * @typedef {{ min: V3, max: V3 }} Box
 * @typedef {{ min: V3, max: V3, left: BvhNode | null, right: BvhNode | null, tris: number[] }} BvhNode
 * @typedef {{ positions: Float64Array, indices: Uint32Array, triangles: number, root: BvhNode, bounds: Box, tags: string[] }} Mesh
 * @typedef {{ t: number, point: V3, normal: V3, triangle: number }} RayHit
 * @typedef {{ point: V3, normal: V3, depth: number, triangle: number }} Contact
 */

/** Triangles per BVH leaf: small enough to prune, big enough to stay shallow. */
const LEAF = 4;
/** Distances under this are the same point. */
const EPS = 1e-9;

/**
 * The twelve triangles of an axis-aligned box, wound outward.
 * @param {V3} min @param {V3} max @returns {Geometry}
 */
export function boxGeometry(min, max) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return {
    positions: [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1],
    indices: [
      0, 2, 1, 0, 3, 2, // back (−z)
      4, 5, 6, 4, 6, 7, // front (+z)
      0, 1, 5, 0, 5, 4, // bottom (−y)
      3, 7, 6, 3, 6, 2, // top (+y)
      0, 4, 7, 0, 7, 3, // left (−x)
      1, 2, 6, 1, 6, 5, // right (+x)
    ],
  };
}

/**
 * A ground quad (two triangles, facing up) over [x0, x1] × [z0, z1] at height y.
 * @param {number} x0 @param {number} z0 @param {number} x1 @param {number} z1 @param {number} [y]
 * @returns {Geometry}
 */
export function planeGeometry(x0, z0, x1, z1, y = 0) {
  return { positions: [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1], indices: [0, 2, 1, 0, 3, 2] };
}

/**
 * An upright prism (a rock, a tree trunk, a pillar): a regular n-gon of
 * the given radius around (x, z), from y0 to y1, capped both ends.
 * @param {number} x @param {number} z @param {number} radius @param {number} y0 @param {number} y1 @param {number} [sides]
 * @returns {Geometry}
 */
export function prismGeometry(x, z, radius, y0, y1, sides = 6) {
  /** @type {number[]} */
  const positions = [];
  /** @type {number[]} */
  const indices = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const px = x + Math.cos(a) * radius;
    const pz = z + Math.sin(a) * radius;
    positions.push(px, y0, pz, px, y1, pz);
  }
  const bottom = positions.length / 3;
  positions.push(x, y0, z);
  const top = bottom + 1;
  positions.push(x, y1, z);
  for (let i = 0; i < sides; i++) {
    const a0 = i * 2;
    const a1 = i * 2 + 1;
    const b0 = ((i + 1) % sides) * 2;
    const b1 = b0 + 1;
    indices.push(a0, a1, b1, a0, b1, b0);
    indices.push(bottom, a0, b0);
    indices.push(top, b1, a1);
  }
  return { positions, indices };
}

/**
 * Join several geometries into one (each optionally translated).
 * @param {Array<Geometry & { offset?: V3 }>} parts @returns {Geometry}
 */
export function mergeGeometry(parts) {
  /** @type {number[]} */
  const positions = [];
  /** @type {number[]} */
  const indices = [];
  for (const part of parts) {
    const base = positions.length / 3;
    const [ox, oy, oz] = part.offset ?? [0, 0, 0];
    for (let i = 0; i < part.positions.length; i += 3) positions.push(part.positions[i] + ox, part.positions[i + 1] + oy, part.positions[i + 2] + oz);
    for (const index of part.indices) indices.push(index + base);
  }
  return { positions, indices };
}

/**
 * Build a mesh: copy the geometry into typed arrays and build its BVH by
 * median splits along the longest axis of each node's centroids.
 * @param {Geometry} geometry
 * @param {string[]} [tags] - an optional tag per triangle (what was hit: `rock`, `gate`…)
 * @returns {Mesh}
 */
export function buildMesh(geometry, tags = []) {
  const positions = Float64Array.from(geometry.positions);
  const indices = Uint32Array.from(geometry.indices);
  if (indices.length % 3 !== 0) throw new RangeError('buildMesh: indices must come in threes');
  for (const index of indices) {
    if (index * 3 + 2 >= positions.length) throw new RangeError(`buildMesh: index ${index} is past the positions`);
  }
  const triangles = indices.length / 3;
  const centroids = new Float64Array(triangles * 3);
  for (let t = 0; t < triangles; t++) {
    for (let k = 0; k < 3; k++) {
      const i = indices[t * 3 + k] * 3;
      centroids[t * 3] += positions[i] / 3;
      centroids[t * 3 + 1] += positions[i + 1] / 3;
      centroids[t * 3 + 2] += positions[i + 2] / 3;
    }
  }
  const all = Array.from({ length: triangles }, (_, t) => t);
  const root = buildNode(all, positions, indices, centroids);
  return { positions, indices, triangles, root, bounds: { min: root.min, max: root.max }, tags };
}

/**
 * @param {number[]} tris @param {Float64Array} positions @param {Uint32Array} indices @param {Float64Array} centroids
 * @returns {BvhNode}
 */
function buildNode(tris, positions, indices, centroids) {
  /** @type {V3} */
  const min = [Infinity, Infinity, Infinity];
  /** @type {V3} */
  const max = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const i = indices[t * 3 + k] * 3;
      for (let a = 0; a < 3; a++) {
        if (positions[i + a] < min[a]) min[a] = positions[i + a];
        if (positions[i + a] > max[a]) max[a] = positions[i + a];
      }
    }
  }
  if (tris.length <= LEAF) return { min, max, left: null, right: null, tris };
  let axis = 0;
  let spread = -1;
  for (let a = 0; a < 3; a++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const t of tris) {
      lo = Math.min(lo, centroids[t * 3 + a]);
      hi = Math.max(hi, centroids[t * 3 + a]);
    }
    if (hi - lo > spread) { spread = hi - lo; axis = a; }
  }
  const sorted = tris.slice().sort((p, q) => centroids[p * 3 + axis] - centroids[q * 3 + axis]);
  const half = sorted.length >> 1;
  return {
    min, max,
    left: buildNode(sorted.slice(0, half), positions, indices, centroids),
    right: buildNode(sorted.slice(half), positions, indices, centroids),
    tris: [],
  };
}

/**
 * The corners of triangle `t`.
 * @param {Mesh} mesh @param {number} t @returns {[V3, V3, V3]}
 */
export function triangleOf(mesh, t) {
  const { positions: p, indices: ix } = mesh;
  const a = ix[t * 3] * 3;
  const b = ix[t * 3 + 1] * 3;
  const c = ix[t * 3 + 2] * 3;
  return [[p[a], p[a + 1], p[a + 2]], [p[b], p[b + 1], p[b + 2]], [p[c], p[c + 1], p[c + 2]]];
}

/** @param {V3} a @param {V3} b @returns {V3} */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** @param {V3} a @param {V3} b @returns {number} */
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** @param {V3} a @param {V3} b @returns {V3} */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @param {V3} a @param {number} s @returns {V3} */
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
/** @param {V3} a @param {V3} b @returns {V3} */
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** @param {V3} a @returns {V3} */
export function normalize(a) {
  const length = Math.hypot(a[0], a[1], a[2]);
  // `+ 0` folds a negative zero, so an axis-aligned normal reads as one
  return length < EPS ? [0, 1, 0] : [a[0] / length + 0, a[1] / length + 0, a[2] / length + 0];
}

/**
 * The unit normal of triangle `t` (by its winding).
 * @param {Mesh} mesh @param {number} t @returns {V3}
 */
export function triangleNormal(mesh, t) {
  const [a, b, c] = triangleOf(mesh, t);
  return normalize(cross(sub(b, a), sub(c, a)));
}

/**
 * Slab test of a ray against a box: the entry distance, or Infinity on a miss.
 * @param {Box} box @param {V3} origin @param {V3} inv - 1 / direction, per axis
 * @param {number} maxT
 */
function rayBox(box, origin, inv, maxT) {
  let t0 = 0;
  let t1 = maxT;
  for (let a = 0; a < 3; a++) {
    let near = (box.min[a] - origin[a]) * inv[a];
    let far = (box.max[a] - origin[a]) * inv[a];
    if (Number.isNaN(near) || Number.isNaN(far)) {
      // a ray parallel to this slab: inside it or never
      if (origin[a] < box.min[a] || origin[a] > box.max[a]) return Infinity;
      continue;
    }
    if (near > far) [near, far] = [far, near];
    t0 = Math.max(t0, near);
    t1 = Math.min(t1, far);
    if (t0 > t1) return Infinity;
  }
  return t0;
}

/**
 * Möller–Trumbore: the distance along the ray to triangle (a, b, c), or
 * null on a miss. Both faces count — a pick from below a floor still hits it.
 * @param {V3} origin @param {V3} dir @param {V3} a @param {V3} b @param {V3} c
 * @returns {number | null}
 */
export function rayTriangle(origin, dir, a, b, c) {
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const p = cross(dir, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < EPS) return null;
  const inv = 1 / det;
  const s = sub(origin, a);
  const u = dot(s, p) * inv;
  if (u < 0 || u > 1) return null;
  const q = cross(s, e1);
  const v = dot(dir, q) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = dot(e2, q) * inv;
  return t > EPS ? t : null;
}

/**
 * The nearest hit of a ray on a mesh within `maxT`, or null.
 * @param {Mesh} mesh @param {V3} origin @param {V3} direction - need not be unit; `t` is in its units
 * @param {number} [maxT]
 * @returns {RayHit | null}
 */
export function raycast(mesh, origin, direction, maxT = Infinity) {
  /** @type {V3} */
  const inv = [1 / direction[0], 1 / direction[1], 1 / direction[2]];
  let best = maxT;
  let hit = -1;
  /** @type {BvhNode[]} */
  const stack = [mesh.root];
  while (stack.length > 0) {
    const node = /** @type {BvhNode} */ (stack.pop());
    if (rayBox(node, origin, inv, best) === Infinity) continue;
    if (node.left && node.right) {
      stack.push(node.left, node.right);
      continue;
    }
    for (const t of node.tris) {
      const [a, b, c] = triangleOf(mesh, t);
      const d = rayTriangle(origin, direction, a, b, c);
      if (d !== null && d < best) { best = d; hit = t; }
    }
  }
  if (hit < 0) return null;
  let normal = triangleNormal(mesh, hit);
  // the face the ray came through, whichever way the triangle is wound
  if (dot(normal, direction) > 0) normal = normalize(scale(normal, -1));
  return { t: best, point: add(origin, scale(direction, best)), normal, triangle: hit };
}

/**
 * The point of triangle (a, b, c) closest to p (Ericson, Real-Time
 * Collision Detection, 5.1.5): by Voronoi region, no square roots.
 * @param {V3} p @param {V3} a @param {V3} b @param {V3} c @returns {V3}
 */
export function closestOnTriangle(p, a, b, c) {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, scale(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
  const denom = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * denom), scale(ac, vc * denom)));
}

/**
 * True when two boxes overlap.
 * @param {Box} a @param {Box} b
 */
export function boxesOverlap(a, b) {
  return a.min[0] <= b.max[0] && a.max[0] >= b.min[0]
    && a.min[1] <= b.max[1] && a.max[1] >= b.min[1]
    && a.min[2] <= b.max[2] && a.max[2] >= b.min[2];
}

/**
 * The triangles whose BVH leaves overlap a box (the broad phase).
 * @param {Mesh} mesh @param {Box} box @returns {number[]}
 */
export function queryBox(mesh, box) {
  /** @type {number[]} */
  const out = [];
  /** @type {BvhNode[]} */
  const stack = [mesh.root];
  while (stack.length > 0) {
    const node = /** @type {BvhNode} */ (stack.pop());
    if (!boxesOverlap(node, box)) continue;
    if (node.left && node.right) stack.push(node.left, node.right);
    else out.push(...node.tris);
  }
  return out;
}

/**
 * Every triangle a sphere touches, deepest first: the closest point, the
 * push-out normal (from the surface toward the centre) and the depth.
 * @param {Mesh} mesh @param {V3} center @param {number} radius @returns {Contact[]}
 */
export function sphereContacts(mesh, center, radius) {
  const box = { min: /** @type {V3} */ ([center[0] - radius, center[1] - radius, center[2] - radius]), max: /** @type {V3} */ ([center[0] + radius, center[1] + radius, center[2] + radius]) };
  /** @type {Contact[]} */
  const contacts = [];
  for (const t of queryBox(mesh, box)) {
    const [a, b, c] = triangleOf(mesh, t);
    const point = closestOnTriangle(center, a, b, c);
    const away = sub(center, point);
    const distance = Math.hypot(away[0], away[1], away[2]);
    if (distance >= radius) continue;
    // a centre exactly on the surface pushes out along the face normal
    const normal = distance < EPS ? triangleNormal(mesh, t) : scale(away, 1 / distance);
    contacts.push({ point, normal, depth: radius - distance, triangle: t });
  }
  return contacts.sort((p, q) => q.depth - p.depth);
}

/**
 * Push a sphere out of a mesh: a few rounds of moving it along its
 * deepest contact's normal, so a body pressed into a corner settles in
 * the corner and a body walking into a wall slides along it.
 * @param {Mesh} mesh @param {V3} center @param {number} radius @param {number} [rounds]
 * @returns {{ center: V3, hit: boolean, normal: V3 | null, tags: string[] }}
 */
export function resolveSphere(mesh, center, radius, rounds = 4) {
  let at = center;
  /** @type {V3 | null} */
  let normal = null;
  /** @type {Set<string>} */
  const tags = new Set();
  for (let round = 0; round < rounds; round++) {
    const contacts = sphereContacts(mesh, at, radius);
    if (contacts.length === 0) break;
    const deepest = contacts[0];
    at = add(at, scale(deepest.normal, deepest.depth + 1e-6));
    normal = deepest.normal;
    for (const contact of contacts) {
      const tag = mesh.tags[contact.triangle];
      if (tag) tags.add(tag);
    }
  }
  return { center: at, hit: normal !== null, normal, tags: [...tags] };
}

/**
 * Move a sphere from `from` toward `to` without tunnelling: the path is
 * walked in steps no longer than half the radius, resolving at each, so a
 * fast body stops at (and slides along) a wall thinner than its stride.
 * @param {Mesh} mesh @param {V3} from @param {V3} to @param {number} radius
 * @returns {{ center: V3, hit: boolean, normal: V3 | null, tags: string[] }}
 */
export function sweepSphere(mesh, from, to, radius) {
  const path = sub(to, from);
  const length = Math.hypot(path[0], path[1], path[2]);
  const steps = Math.max(1, Math.ceil(length / Math.max(EPS, radius * 0.5)));
  let at = from;
  let hit = false;
  /** @type {V3 | null} */
  let normal = null;
  /** @type {Set<string>} */
  const tags = new Set();
  for (let i = 0; i < steps; i++) {
    const resolved = resolveSphere(mesh, add(at, scale(path, 1 / steps)), radius);
    at = resolved.center;
    if (resolved.hit) {
      hit = true;
      normal = resolved.normal;
      for (const tag of resolved.tags) tags.add(tag);
    }
  }
  return { center: at, hit, normal, tags: [...tags] };
}

/**
 * The world-space ray under a viewport pixel, for a view built by the
 * stage camera: the inverse of its model-view-projection matrix carries
 * the pixel's near and far clip points back into the world.
 * @param {{ matrix: ArrayLike<number>, width: number, height: number }} view
 * @param {number} sx @param {number} sy
 * @returns {{ origin: V3, direction: V3 } | null} null when the matrix is singular
 */
export function screenRay(view, sx, sy) {
  const inv = invert4(view.matrix);
  if (inv === null) return null;
  const nx = (sx / view.width) * 2 - 1;
  const ny = 1 - (sy / view.height) * 2;
  const near = unproject(inv, nx, ny, -1);
  const far = unproject(inv, nx, ny, 1);
  return { origin: near, direction: normalize(sub(far, near)) };
}

/** @param {Float64Array} m @param {number} x @param {number} y @param {number} z @returns {V3} */
function unproject(m, x, y, z) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}

/**
 * The inverse of a column-major 4×4 matrix (cofactor expansion), or null
 * when it has none.
 * @param {ArrayLike<number>} m @returns {Float64Array | null}
 */
export function invert4(m) {
  const out = new Float64Array(16);
  out[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  out[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  out[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  out[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  out[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  out[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  out[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  out[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  out[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  out[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  out[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  out[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  out[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  out[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  out[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  out[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  const det = m[0] * out[0] + m[1] * out[4] + m[2] * out[8] + m[3] * out[12];
  if (Math.abs(det) < 1e-15) return null;
  for (let i = 0; i < 16; i++) out[i] /= det;
  return out;
}

/**
 * Separating-axis test of two convex polygons (flat `[x0, y0, x1, y1, …]`,
 * either winding): whether they overlap, and if so the smallest push that
 * separates `a` from `b` (`axis` points from b toward a).
 * @param {readonly number[]} a @param {readonly number[]} b
 * @returns {{ overlap: boolean, depth: number, axis: [number, number] }}
 */
export function satPolygons(a, b) {
  let depth = Infinity;
  /** @type {[number, number]} */
  let axis = [0, 0];
  for (const poly of [a, b]) {
    const n = poly.length / 2;
    for (let i = 0; i < n; i++) {
      const x0 = poly[i * 2];
      const y0 = poly[i * 2 + 1];
      const x1 = poly[((i + 1) % n) * 2];
      const y1 = poly[((i + 1) % n) * 2 + 1];
      const length = Math.hypot(y1 - y0, x0 - x1);
      if (length < EPS) continue;
      const ax = (y1 - y0) / length;
      const ay = (x0 - x1) / length;
      const [amin, amax] = projectPolygon(a, ax, ay);
      const [bmin, bmax] = projectPolygon(b, ax, ay);
      const overlap = Math.min(amax, bmax) - Math.max(amin, bmin);
      if (overlap <= 0) return { overlap: false, depth: 0, axis: [0, 0] };
      if (overlap < depth) {
        depth = overlap;
        const flip = (amin + amax) / 2 < (bmin + bmax) / 2 ? -1 : 1;
        axis = [ax * flip, ay * flip];
      }
    }
  }
  return { overlap: true, depth, axis };
}

/** @param {readonly number[]} poly @param {number} ax @param {number} ay @returns {[number, number]} */
function projectPolygon(poly, ax, ay) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    const d = poly[i] * ax + poly[i + 1] * ay;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return [lo, hi];
}

/**
 * Even–odd point-in-polygon on screen (any simple polygon).
 * @param {number} x @param {number} y @param {readonly number[]} poly
 */
export function pointInPolygon(x, y, poly) {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2];
    const yi = poly[i * 2 + 1];
    const xj = poly[j * 2];
    const yj = poly[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
