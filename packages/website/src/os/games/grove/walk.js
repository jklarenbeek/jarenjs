//@ts-check
/**
 * How the monkey gets about: continuously, at one fixed speed, steered
 * by held arrows or walking a path a tap planned over the tiles — and
 * always as a body. The monkey is a sphere swept through a triangle mesh
 * of everything solid on the board (rocks and trees as prisms, the
 * altar and the sea's edge as boxes), so pressing into a rock at an
 * angle slides the monkey round it instead of stopping it dead, and
 * nothing at any speed can tunnel through a wall.
 *
 * The mesh is built once per board, from the board's rows alone, and
 * kept in a small module-level cache keyed by the board's id — never in
 * the JSON state. Movement also says what it felt like: a footstep
 * every few strides, a soft knock on the monkey's ragdoll when it bumps
 * something, a splash and a ripple at the shore, the camera asked to
 * follow along.
 */

import { boxGeometry, prismGeometry, mergeGeometry, buildMesh, sweepSphere } from '../../engine/collide.js';
import { centerOf, charAt, findPath } from './boards.js';

/**
 * @typedef {import('./boards.js').Board} Board
 * @typedef {import('../game.js').GameEvent} GameEvent
 * @typedef {import('../../engine/collide.js').Mesh} Mesh
 * @typedef {{ id: number, value: number | string, label: string, tag: string, x: number, z: number, tried: boolean }} Stone
 * @typedef {{ x: number, z: number, face: number, path: Array<[number, number]> | null, intent: boolean,
 *   carry: Stone | null, stride: number, moving: boolean, stepMs: number, touching: boolean, bumpMs: number,
 *   splashMs: number, jumpMs: number, dunkMs: number, stuckMs: number, followAt: [number, number] }} Monkey
 * @typedef {{ up: boolean, down: boolean, left: boolean, right: boolean }} Held
 */

/** Walking speed, world units a second. */
export const SPEED = 3.4;
/** The monkey's body, a sphere of this radius resting on the ground. */
export const RADIUS = 0.3;
/** How long a hop lasts, ms. */
export const JUMP_MS = 520;
/** How long a tumble into the water lasts before the monkey climbs out, ms. */
export const DUNK_MS = 640;

/** Footstep, knock and splash spacing, ms; the camera follows every this many units. */
const STEP_MS = 270;
const BUMP_MS = 450;
const SPLASH_MS = 700;
const FOLLOW_EVERY = 0.5;

/** What each solid tile is made of: a prism (a box for the altar), its height and its tag. */
export const SOLIDS = Object.freeze(/** @type {Record<string, { tag: string, radius: number, height: number, sides: number }>} */ ({
  r: { tag: 'rock', radius: 0.4, height: 0.8, sides: 7 },
  t: { tag: 'tree', radius: 0.28, height: 2.0, sides: 6 },
  A: { tag: 'altar', radius: 0.42, height: 0.9, sides: 4 },
  m: { tag: 'stump', radius: 0.46, height: 0.6, sides: 8 },
  B: { tag: 'basket', radius: 0.36, height: 0.5, sides: 8 },
  M: { tag: 'mimi', radius: 0.32, height: 1.5, sides: 6 },
  N: { tag: 'pile', radius: 0.42, height: 0.6, sides: 8 },
}));

/** Boards' meshes, by board id; the oldest is dropped past this many. */
const MESHES = new Map();
const MESH_CACHE = 12;

/**
 * Whether a sea tile touches land (only those can be bumped).
 * @param {Board} board @param {number} i @param {number} j
 */
function shore(board, i, j) {
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (charAt(board, i + di, j + dj) !== '#') return true;
  return false;
}

/**
 * The collision mesh of a board, built on first use and cached by id.
 * @param {Board} board @returns {Mesh}
 */
export function meshOf(board) {
  const cached = MESHES.get(board.id);
  if (cached) return cached;
  /** @type {import('../../engine/collide.js').Geometry[]} */
  const parts = [];
  /** @type {string[]} */
  const tags = [];
  board.rows.forEach((row, j) => [...row].forEach((ch, i) => {
    const [x, z] = centerOf(board, i, j);
    if (ch === '#') {
      if (!shore(board, i, j)) return;
      parts.push(boxGeometry([x - 0.5, 0, z - 0.5], [x + 0.5, 0.7, z + 0.5]));
      for (let k = 0; k < 12; k++) tags.push('water');
      return;
    }
    const solid = SOLIDS[ch];
    if (!solid) return;
    if (ch === 'A') {
      parts.push(boxGeometry([x - solid.radius, 0, z - solid.radius], [x + solid.radius, solid.height, z + solid.radius]));
      for (let k = 0; k < 12; k++) tags.push(solid.tag);
      return;
    }
    parts.push(prismGeometry(x, z, solid.radius, 0, solid.height, solid.sides));
    for (let k = 0; k < solid.sides * 4; k++) tags.push(solid.tag);
  }));
  const mesh = buildMesh(mergeGeometry(parts), tags);
  MESHES.set(board.id, mesh);
  if (MESHES.size > MESH_CACHE) MESHES.delete(MESHES.keys().next().value);
  return mesh;
}

/** How many boards' meshes are cached (the cache never outgrows its bound). */
export function cachedMeshes() {
  return MESHES.size;
}

/**
 * The monkey standing on a board's spawn.
 * @param {Board} board @returns {Monkey}
 */
export function createMonkey(board) {
  const [x, z] = centerOf(board, board.spawn[0], board.spawn[1]);
  return {
    x, z, face: 1, path: null, intent: false, carry: null, stride: 0, moving: false,
    stepMs: 0, touching: false, bumpMs: 0, splashMs: 0, jumpMs: 0, dunkMs: 0, stuckMs: 0, followAt: [x, z],
  };
}

/**
 * The camera asked to keep the monkey in frame.
 * @param {Monkey} monkey @returns {GameEvent}
 */
export function followMonkey(monkey) {
  return { kind: 'follow', target: [monkey.x, 0.6, monkey.z], lag: 0.08 };
}

/**
 * Send the monkey walking to a point along the tiles; `intent` acts on
 * arrival (a tap on a stone picks it up). A point nothing leads to
 * leaves the monkey where it is.
 * @param {Board} board @param {Monkey} monkey @param {[number, number]} point @param {boolean} intent
 * @returns {Monkey}
 */
export function walkTo(board, monkey, point, intent) {
  const path = findPath(board, [monkey.x, monkey.z], point);
  return path ? { ...monkey, path, intent, stuckMs: 0 } : monkey;
}

/**
 * One tick of the monkey: held arrows steer (and cancel a planned walk),
 * otherwise the planned walk goes on; the body is swept through the
 * board's mesh and slides along whatever it meets.
 * @param {Board} board @param {Monkey} monkey @param {Held} held @param {number} dtMs
 * @returns {{ monkey: Monkey, events: GameEvent[], arrived: boolean }}
 */
export function moveMonkey(board, monkey, held, dtMs) {
  /** @type {GameEvent[]} */
  const events = [];
  const m = {
    ...monkey,
    moving: false,
    bumpMs: Math.max(0, monkey.bumpMs - dtMs),
    splashMs: Math.max(0, monkey.splashMs - dtMs),
    jumpMs: Math.max(0, monkey.jumpMs - dtMs),
    dunkMs: Math.max(0, monkey.dunkMs - dtMs),
  };
  if ((monkey.jumpMs > 0 && m.jumpMs === 0) || (monkey.dunkMs > 0 && m.dunkMs === 0)) events.push({ kind: 'sfx', name: 'land' });
  let arrived = false;
  if (m.path && m.path.length === 0) {
    m.path = null;
    arrived = true;
  }
  if (m.dunkMs > 0) return { monkey: m, events, arrived };
  const reach = SPEED * dtMs / 1000;
  const hx = (held.right ? 1 : 0) - (held.left ? 1 : 0);
  const hz = (held.down ? 1 : 0) - (held.up ? 1 : 0);
  let dx = 0;
  let dz = 0;
  if (hx !== 0 || hz !== 0) {
    const length = Math.hypot(hx, hz);
    dx = (hx / length) * reach;
    dz = (hz / length) * reach;
    m.path = null;
    m.intent = false;
  }
  else if (m.path) {
    const [tx, tz] = m.path[0];
    const gap = Math.hypot(tx - m.x, tz - m.z);
    const k = gap <= reach ? 1 : reach / gap;
    dx = (tx - m.x) * k;
    dz = (tz - m.z) * k;
  }
  if (dx === 0 && dz === 0) return { monkey: m, events, arrived };
  const swept = sweepSphere(meshOf(board), [m.x, RADIUS, m.z], [m.x + dx, RADIUS, m.z + dz], RADIUS);
  const [nx, , nz] = swept.center;
  const moved = Math.hypot(nx - m.x, nz - m.z);
  if (Math.abs(nx - m.x) > 1e-4) m.face = nx > m.x ? 1 : -1;
  m.x = nx;
  m.z = nz;
  m.stride += moved;
  m.moving = moved > 1e-4;
  if (swept.hit && swept.normal) {
    const [ux, , uz] = swept.normal;
    if (!m.touching && m.bumpMs === 0) {
      events.push({ kind: 'kick', body: 'monkey', impulse: [ux * 2.6 + uz * 0.8, 1.4] });
      m.bumpMs = BUMP_MS;
    }
    if (swept.tags.includes('water') && m.splashMs === 0) {
      /** @type {[number, number, number]} */
      const at = [nx - ux * RADIUS, 0.05, nz - uz * RADIUS];
      events.push({ kind: 'sfx', name: 'splash' }, { kind: 'fx', fx: 'ripple', at, colors: ['#fffdf6'] },
        { kind: 'fx', fx: 'dust', at, colors: ['#0ea5e9', '#fffdf6'], count: 6 });
      m.splashMs = SPLASH_MS;
    }
  }
  m.touching = swept.hit;
  if (m.moving) {
    m.stepMs += dtMs;
    if (m.stepMs >= STEP_MS) {
      m.stepMs = 0;
      events.push({ kind: 'sfx', name: 'step' });
    }
  }
  if (m.path) {
    const [tx, tz] = m.path[0];
    if (Math.hypot(tx - nx, tz - nz) < 1e-3) {
      m.path = m.path.length > 1 ? m.path.slice(1) : null;
      arrived = m.path === null;
      m.stuckMs = 0;
    }
    else if (moved < reach * 0.25) {
      // pressed against something the plan did not foresee: give the walk up
      m.stuckMs += dtMs;
      if (m.stuckMs > 500) {
        m.path = null;
        m.intent = false;
        m.stuckMs = 0;
      }
    }
    else m.stuckMs = 0;
  }
  if (Math.hypot(m.x - m.followAt[0], m.z - m.followAt[1]) >= FOLLOW_EVERY) {
    m.followAt = [m.x, m.z];
    events.push(followMonkey(m));
  }
  return { monkey: m, events, arrived };
}

/**
 * The distance from the monkey to a point on the ground.
 * @param {{ x: number, z: number }} monkey @param {[number, number]} point
 */
export function distanceTo(monkey, point) {
  return Math.hypot(point[0] - monkey.x, point[1] - monkey.z);
}

/**
 * The index of the nearest point within `reach` of the monkey, or -1.
 * @param {{ x: number, z: number }} monkey @param {Array<[number, number]>} points @param {number} reach
 */
export function nearest(monkey, points, reach) {
  let best = -1;
  let bestDistance = reach;
  points.forEach((point, k) => {
    const d = distanceTo(monkey, point);
    if (d <= bestDistance) {
      best = k;
      bestDistance = d;
    }
  });
  return best;
}
