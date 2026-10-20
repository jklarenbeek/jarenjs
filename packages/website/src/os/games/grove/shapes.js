//@ts-check
/**
 * The two monkeys of Monkey Grove as cut-out figures in the house style:
 * the stage's stick-and-disc silhouette with two round ears either side
 * of the skull and a tail that curls up from the hip — one flat fill,
 * one bold outline, the way every figure on the stage is drawn. The
 * player's monkey wears the player's colour; Mimi, the island's guide,
 * wears warm amber and a flower (painted on by the board drawing).
 *
 * A shape is built over a SKELETON, so the same builder draws a posed
 * monkey and one the arcade's ragdoll is throwing about. Poses are
 * plain data: a relaxed stand, a walk cycle driven by the distance
 * walked, the stone lifted overhead, a jubilant dance, a tumble.
 */

import { POSES, mixPose, skeleton, skeletonShape } from '../../stage/figures.js';

/**
 * @typedef {import('../../stage/figures.js').Pose} Pose
 * @typedef {import('../../stage/figures.js').Shape} Shape
 * @typedef {import('../../stage/figures.js').Skeleton} Skeleton
 */

/** A relaxed stand: arms loose, feet apart. */
export const STAND = Object.freeze(/** @type {Pose} */ ({ lean: 0, head: 0, aL: [-0.5, 0.35], aR: [0.5, -0.35], lL: [-0.14, 0.05], lR: [0.14, -0.05] }));

/**
 * A step of the walk cycle: legs swinging, arms against them.
 * @param {number} phase - radians; a stride is 2π
 * @returns {Pose}
 */
export function walkPose(phase) {
  const s = Math.sin(phase);
  return { lean: 0.08, head: 0.04 * s, aL: [-0.45 - 0.45 * s, 0.4], aR: [0.45 - 0.45 * s, -0.4], lL: [-0.1 + 0.5 * s, 0.25], lR: [0.1 - 0.5 * s, -0.25] };
}

/**
 * A monkey over a skeleton, facing right (`face` 1) or left (-1): the
 * figure, its ears, and its tail curling up behind it.
 * @param {Skeleton} skel @param {{ face?: number }} [options] @returns {Shape}
 */
export function monkeyShape(skel, options = {}) {
  const face = options.face === -1 ? -1 : 1;
  const shape = skeletonShape(skel);
  const [sx, sy] = skel.skull;
  shape.dots.push({ c: [sx - 0.25, sy + 0.08], r: 0.1 }, { c: [sx + 0.25, sy + 0.08], r: 0.1 });
  // a spiral about a point behind the hip, winding in as it climbs
  const [hx, hy] = skel.hip;
  const cu = hx - 0.3;
  const cv = hy + 0.12;
  const start = Math.atan2(hy - cv, hx - cu);
  const reach = Math.hypot(hx - cu, hy - cv);
  /** @type {Array<[number, number]>} */
  const tail = [];
  for (let k = 0; k <= 12; k++) {
    const s = k / 12;
    const a = start - s * Math.PI * 1.75;
    const r = reach * (1 - 0.55 * s);
    tail.push([cu + r * Math.cos(a), cv + r * Math.sin(a)]);
  }
  shape.strokes.push({ pts: tail, w: 0.07 });
  if (face === 1) return shape;
  const flip = (/** @type {[number, number]} */ [u, v]) => /** @type {[number, number]} */ ([-u, v]);
  return {
    strokes: shape.strokes.map((st) => ({ pts: st.pts.map(flip), w: st.w })),
    dots: shape.dots.map((d) => ({ c: flip(d.c), r: d.r })),
    boxes: shape.boxes.map((b) => ({ ...b, c: flip(b.c) })),
    center: flip(shape.center),
    top: shape.top,
  };
}

/**
 * A posed monkey.
 * @param {Pose} pose @param {{ face?: number }} [options] @returns {Shape}
 */
export function monkey(pose, options = {}) {
  return monkeyShape(skeleton(pose), options);
}

/**
 * Where the player's monkey is in its body: tumbling into the water,
 * dancing a right answer, lifting a stone overhead, walking, or at rest.
 * @param {{ dunkMs: number, carry: unknown, moving: boolean, stride: number }} m
 * @param {boolean} celebrating @param {number} time - ms
 * @returns {Pose}
 */
export function monkeyPose(m, celebrating, time) {
  if (m.dunkMs > 0) return POSES.tumble;
  if (celebrating) return mixPose(POSES.jubilant, POSES.dance, (Math.sin(time / 170) + 1) / 2);
  if (m.carry) return m.moving ? mixPose(POSES.lift, walkPose(m.stride * 4.2), 0.3) : POSES.lift;
  return m.moving ? walkPose(m.stride * 4.2) : STAND;
}

/**
 * Mimi: waving while she talks, otherwise a slow sway of welcome.
 * @param {boolean} talking @param {number} time - ms @returns {Pose}
 */
export function mimiPose(talking, time) {
  const wave = Math.sin(time / (talking ? 140 : 420));
  return { ...STAND, lean: 0.06 * wave, aR: [2.45 + 0.35 * wave, -0.7], aL: talking ? [-1.2, 0.6] : STAND.aL };
}

/**
 * Where Mimi's flower sits on her head, in figure units.
 * @param {Skeleton} skel @returns {[number, number]}
 */
export function flowerSpot(skel) {
  return [skel.skull[0] + 0.12, skel.skull[1] + 0.27];
}
