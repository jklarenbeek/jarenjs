//@ts-check
/**
 * Ragdoll liveliness for the cut-out figures. A figure's skeleton is a
 * handful of Verlet particles in its own drawing plane, held at bone
 * length by distance constraints and pulled toward the pose the
 * animation asks for by "muscles" — so a dancer follows its choreography
 * exactly while nothing disturbs it, and when something does (a hop, a
 * landing, a bump, a veto) it flails, tumbles, and finds its feet again.
 *
 * It is liveliness, never a hindrance: the simulation only ever bends how
 * a figure is DRAWN. Where a figure stands, what it holds, what it can
 * reach — all of that stays the game's and the machine's, so a ragdoll
 * that is still settling can never block, delay or change a move.
 */

import { JOINTS, skeleton } from '../stage/figures.js';

/**
 * @typedef {import('../stage/figures.js').Pose} Pose
 * @typedef {import('../stage/figures.js').Skeleton} Skeleton
 * @typedef {{ gravity: number, tone: number, rootTone: number, damping: number, iterations: number, friction: number, recovery: number }} RagdollParams
 * @typedef {{ pos: Float64Array, prev: Float64Array, rest: Float64Array, limp: number, head: 'round' | 'tv', params: RagdollParams }} Ragdoll
 */

/** The bones held at length, as joint index pairs, plus two braces that
 * keep the skull over the hips and the knees apart, so a limp figure
 * folds like a person and not like a chain. */
export const LINKS = Object.freeze([
  [0, 1], [1, 2], [1, 3], [3, 4], [1, 5], [5, 6], [0, 7], [7, 8], [0, 9], [9, 10],
  [0, 2], [7, 9],
]);

/** Per-joint mass: the hip and torso are heavy, hands and feet light. */
const MASS = Object.freeze([4, 3, 1.5, 1, 0.6, 1, 0.6, 1.2, 0.8, 1.2, 0.8]);

/** Lively defaults, in figure units and seconds. */
export const RAGDOLL_DEFAULTS = Object.freeze(/** @type {RagdollParams} */ ({
  gravity: 14,
  tone: 16,
  rootTone: 40,
  damping: 0.9,
  iterations: 5,
  friction: 0.6,
  recovery: 1.4,
}));

/** The nominal step the impulse units are measured against, s. */
const NOMINAL_DT = 1 / 60;

/**
 * A ragdoll standing in a pose.
 * @param {Pose} pose
 * @param {{ head?: 'round' | 'tv', params?: Partial<RagdollParams> }} [options]
 * @returns {Ragdoll}
 */
export function createRagdoll(pose, options = {}) {
  const head = options.head ?? 'round';
  const pos = flatten(skeleton(pose, { head }));
  const rest = new Float64Array(LINKS.length);
  LINKS.forEach(([a, b], i) => { rest[i] = Math.hypot(pos[a * 2] - pos[b * 2], pos[a * 2 + 1] - pos[b * 2 + 1]); });
  return { pos, prev: pos.slice(), rest, limp: 0, head, params: { ...RAGDOLL_DEFAULTS, ...options.params } };
}

/** @param {Skeleton} s @returns {Float64Array} */
function flatten(s) {
  const out = new Float64Array(JOINTS.length * 2);
  JOINTS.forEach((name, i) => {
    const p = s[/** @type {keyof Skeleton} */ (name)];
    out[i * 2] = p[0];
    out[i * 2 + 1] = p[1];
  });
  return out;
}

/**
 * Advance a ragdoll by `dt` seconds toward a pose: integrate, pull by the
 * muscles (weak while limp), hold the bones, keep everything above the
 * floor. Steps longer than 1/30 s are split, so a dropped frame never
 * explodes the figure.
 * @param {Ragdoll} rag @param {Pose} pose @param {number} dt
 * @param {{ bounce?: number }} [options]
 * @returns {Ragdoll} the same ragdoll, advanced
 */
export function stepRagdoll(rag, pose, dt, options = {}) {
  const target = flatten(skeleton(pose, { head: rag.head, bounce: options.bounce ?? 0 }));
  let left = Math.max(0, Math.min(0.25, dt));
  while (left > 1e-6) {
    const h = Math.min(left, 1 / 30);
    substep(rag, target, h);
    left -= h;
  }
  return rag;
}

/** @param {Ragdoll} rag @param {Float64Array} target @param {number} h */
function substep(rag, target, h) {
  const { pos, prev, params } = rag;
  const keep = Math.pow(params.damping, h / NOMINAL_DT);
  const strength = 1 - rag.limp * 0.92;
  const pull = 1 - Math.exp(-params.tone * strength * h);
  const rootPull = 1 - Math.exp(-params.rootTone * Math.max(0.15, strength) * h);
  for (let i = 0; i < JOINTS.length; i++) {
    const x = i * 2;
    const vx = (pos[x] - prev[x]) * keep;
    const vy = (pos[x + 1] - prev[x + 1]) * keep;
    prev[x] = pos[x];
    prev[x + 1] = pos[x + 1];
    pos[x] += vx;
    pos[x + 1] += vy - params.gravity * h * h;
    const k = i === 0 ? rootPull : pull;
    pos[x] += (target[x] - pos[x]) * k;
    pos[x + 1] += (target[x + 1] - pos[x + 1]) * k;
  }
  for (let n = 0; n < params.iterations; n++) {
    LINKS.forEach(([a, b], i) => {
      const dx = pos[b * 2] - pos[a * 2];
      const dy = pos[b * 2 + 1] - pos[a * 2 + 1];
      const length = Math.hypot(dx, dy) || 1e-9;
      const diff = (length - rag.rest[i]) / length;
      const wa = 1 / MASS[a];
      const wb = 1 / MASS[b];
      const share = diff / (wa + wb);
      pos[a * 2] += dx * share * wa;
      pos[a * 2 + 1] += dy * share * wa;
      pos[b * 2] -= dx * share * wb;
      pos[b * 2 + 1] -= dy * share * wb;
    });
    for (let i = 0; i < JOINTS.length; i++) {
      if (pos[i * 2 + 1] < 0) {
        pos[i * 2 + 1] = 0;
        // ground friction: what touches the floor stops sliding
        prev[i * 2] = pos[i * 2] - (pos[i * 2] - prev[i * 2]) * (1 - params.friction);
      }
    }
  }
  rag.limp = Math.max(0, rag.limp - h / params.recovery);
}

/**
 * Knock a ragdoll: an impulse (figure units per second) on every joint,
 * strongest at `joint` and falling off along the body. A hard knock goes
 * limp for a moment — the tumble — and recovers on its own.
 * @param {Ragdoll} rag @param {[number, number]} impulse
 * @param {{ joint?: number, spread?: number, limp?: number }} [options]
 * @returns {Ragdoll}
 */
export function kickRagdoll(rag, impulse, options = {}) {
  const joint = options.joint ?? -1;
  const spread = options.spread ?? 0.8;
  const jx = joint >= 0 ? rag.pos[joint * 2] : 0;
  const jy = joint >= 0 ? rag.pos[joint * 2 + 1] : 0;
  for (let i = 0; i < JOINTS.length; i++) {
    const falloff = joint < 0 ? 1 : Math.exp(-Math.hypot(rag.pos[i * 2] - jx, rag.pos[i * 2 + 1] - jy) / spread);
    rag.prev[i * 2] -= impulse[0] * NOMINAL_DT * falloff;
    rag.prev[i * 2 + 1] -= impulse[1] * NOMINAL_DT * falloff;
  }
  const hard = Math.hypot(impulse[0], impulse[1]) > 6;
  rag.limp = Math.min(1, Math.max(rag.limp, options.limp ?? (hard ? 0.85 : 0)));
  return rag;
}

/**
 * The simulated joints as a skeleton the figure builder draws.
 * @param {Ragdoll} rag @returns {Skeleton}
 */
export function ragdollSkeleton(rag) {
  /** @type {any} */
  const out = {};
  JOINTS.forEach((name, i) => { out[name] = [rag.pos[i * 2], rag.pos[i * 2 + 1]]; });
  return out;
}

/**
 * How much a ragdoll is still moving: the mean joint speed, figure units
 * per nominal step. A figure under ~0.002 has settled.
 * @param {Ragdoll} rag @returns {number}
 */
export function ragdollEnergy(rag) {
  let sum = 0;
  for (let i = 0; i < JOINTS.length; i++) sum += Math.hypot(rag.pos[i * 2] - rag.prev[i * 2], rag.pos[i * 2 + 1] - rag.prev[i * 2 + 1]);
  return sum / JOINTS.length;
}

/**
 * The greatest stretch of any bone off its rest length, as a fraction —
 * the constraint solver's error, which a test holds small.
 * @param {Ragdoll} rag @returns {number}
 */
export function ragdollStretch(rag) {
  let worst = 0;
  LINKS.forEach(([a, b], i) => {
    const length = Math.hypot(rag.pos[a * 2] - rag.pos[b * 2], rag.pos[a * 2 + 1] - rag.pos[b * 2 + 1]);
    worst = Math.max(worst, Math.abs(length - rag.rest[i]) / rag.rest[i]);
  });
  return worst;
}
