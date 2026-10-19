//@ts-check
/**
 * The Arena's stage: a running track drawn in the desk's own hand. Lit
 * lanes in alternating palette tints run from a start line to a
 * chequered finish; on each lane a cut-out runner — a ragdoll when the
 * arcade simulates one — strides with its lane's progress, the leader
 * radiating motion marks the way the merit leader does on the desk.
 * When a race is decided the first three climb a podium past the line,
 * gold, silver and bronze. The reflex race raises one big outlined sign
 * beside the track, and the countdown stands its numerals over the start.
 *
 * Pure like the rest of a game: the state and the draw context in, the
 * display list and the figures to simulate out. The layout constants are
 * exported because the rules aim their effects at the same places.
 */

import { lerpColor } from '@jarenjs/core/color';
import { project } from '../../stage/camera.js';
import { POSES, mixPose, person, skeletonShape, motionMarks } from '../../stage/figures.js';
import { blockGroup, slabItem, shadowItem, figureGroup, labelGroup, flatten } from '../../engine/render.js';

/**
 * @typedef {import('../game.js').DrawContext} DrawContext
 * @typedef {import('../game.js').Drawn} Drawn
 * @typedef {import('../game.js').FigureRequest} FigureRequest
 * @typedef {import('../game.js').Pose} Pose
 * @typedef {import('../game.js').Theme} Theme
 * @typedef {import('../game.js').View} View
 * @typedef {import('../game.js').Item} Item
 * @typedef {import('../../engine/render.js').Group} Group
 * @typedef {[number, number, number]} V3
 */

/** Where the track starts and finishes along x, and how wide a lane is. */
export const X0 = -8;
export const X1 = 8;
export const LANE_W = 1.5;

/** How tall a runner stands, world units. */
const STATURE = 2.6;

/** Strides a runner takes over the whole track: its legs move with its progress. */
const STRIDES = 13;

/** The podium past the line, by place: centre and height of each block. */
export const PODIUM = Object.freeze([
  Object.freeze({ x: X1 + 3, z: 0, h: 1.5 }),
  Object.freeze({ x: X1 + 3, z: -2.1, h: 1 }),
  Object.freeze({ x: X1 + 3, z: 2.1, h: 0.65 }),
]);

/** The lanes alternate these two palette inks, tinted toward the floor:
 * never the runners' red, which a tint would turn pink. */
const LANE_INKS = Object.freeze(['#2563eb', '#fbbf24']);

/** Medal colours: gold, silver, bronze. */
export const MEDALS = Object.freeze(['#fbbf24', '#cbd5e1', '#a16207']);

/** The reflex sign's footprint, beside the middle of the track. */
export const SIGN = Object.freeze({ x0: -1.6, x1: 1.6, z0: -3.9, z1: -2.3 });

/**
 * The centre line of lane `i` of `n`.
 * @param {number} i @param {number} n
 */
export const laneZ = (i, n) => (i - (n - 1) / 2) * LANE_W;

/**
 * True when lane `i`'s runner stands on the podium: a decided race
 * between contenders (the reflex race has one runner and no podium).
 * @param {any} state @param {number} i
 */
const onPodium = (state, i) => state.phase === 'finished' && state.kind !== 'reflex'
  && state.lanes[i].place !== null && state.lanes[i].place <= PODIUM.length;

/**
 * Where lane `i`'s runner stands: on its lane at its shown progress, or
 * on the podium once the race placed it there.
 * @param {any} state @param {number} i @returns {V3}
 */
export function runnerAt(state, i) {
  const lane = state.lanes[i];
  if (onPodium(state, i)) {
    const spot = PODIUM[lane.place - 1];
    return [spot.x, spot.h, spot.z];
  }
  return [X0 + Math.max(0, Math.min(1, lane.shown)) * (X1 - X0), 0.06, laneZ(i, state.lanes.length)];
}

/**
 * The pose lane `i`'s runner holds now: warming up, set, striding with
 * its progress, a tumble out of the race, a celebration on the podium.
 * @param {any} state @param {number} i @param {number} t - animation time, ms (0 when still)
 * @returns {Pose}
 */
export function poseOf(state, i, t) {
  const lane = state.lanes[i];
  const wave = (/** @type {number} */ rate, /** @type {number} */ phase) => 0.5 + 0.5 * Math.sin(t / rate + phase);
  if (lane.out) return POSES.tumble;
  switch (state.phase) {
    case 'ready': return mixPose(POSES.stamp, POSES.dance, wave(420, i));
    case 'countdown': return POSES.stamp;
    case 'racing':
      if (lane.place !== null) return POSES.jubilant;
      return mixPose(POSES.dance, POSES.kick, 0.5 + 0.5 * Math.sin(lane.shown * STRIDES * Math.PI * 2));
    default:
      if (lane.place === 1) return mixPose(POSES.jubilant, POSES.lift, wave(260, 0));
      if (lane.place === 2) return POSES.lift;
      if (lane.place === 3) return POSES.hold;
      return POSES.bow;
  }
}

/**
 * A flat quad on the ground (a finish-line square, the start line's foot).
 * @param {View} view @param {number} x0 @param {number} z0 @param {number} x1 @param {number} z1
 * @param {number} y @param {string} fill @returns {Item}
 */
function groundQuad(view, x0, z0, x1, z1, y, fill) {
  const p = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].flatMap(([x, z]) => project(view, x, y, z).slice(0, 2));
  return { t: 'poly', p, fill, stroke: null, w: 0 };
}

/**
 * Motion marks around a runner: the paired strokes the desk's leader
 * radiates, breathing with time.
 * @param {View} view @param {V3} at @param {Theme} theme @param {number} t
 * @returns {Item[]}
 */
function marksItems(view, at, theme, t) {
  const anchor = project(view, at[0], at[1], at[2]);
  const up = project(view, at[0], at[1] + STATURE, at[2]);
  const unit = Math.abs(anchor[1] - up[1]) / 2.1;
  const pulse = 0.08 * Math.sin(t / 160);
  return motionMarks([0, 1.22], 1.12, 11, pulse).map(([a, b]) => (/** @type {Item} */ ({
    t: 'line', p: [anchor[0] + a[0] * unit, anchor[1] - a[1] * unit, anchor[0] + b[0] * unit, anchor[1] - b[1] * unit],
    stroke: theme.ink, w: Math.max(1, 0.075 * unit),
  })));
}

/**
 * A medal over a podium runner: a disc in the medal's colour with the place on it.
 * @param {View} view @param {V3} at @param {number} place @param {Theme} theme @param {number} px
 * @returns {Group | null}
 */
function medalGroup(view, at, place, theme, px) {
  const c = project(view, at[0], at[1], at[2]);
  const up = project(view, at[0], at[1] + 0.5, at[2]);
  const r = Math.max(7, Math.abs(c[1] - up[1]) * 0.85);
  const label = labelGroup(view, at, String(place), { theme, size: 0.62, fill: '#11131c', stroke: null });
  if (!label) return null;
  return {
    d: label.d - 0.1,
    items: [{ t: 'disc', x: c[0], y: c[1], r, fill: MEDALS[place - 1], stroke: theme.ink, w: 2.6 * px }, ...label.items],
  };
}

/**
 * The text and colour the reflex sign shows for its stage.
 * @param {any} state @param {Theme} theme
 * @returns {{ text: string, color: string }}
 */
export function signFace(state, theme) {
  const r = state.reflex;
  if (state.phase === 'finished' && state.last?.kind === 'reflex') return { text: `${state.last.median} ms`, color: '#16a34a' };
  if (!r) return { text: 'ready', color: lerpColor(theme.floor, theme.shade, 0.12) };
  if (r.stage === 'sign') return { text: 'GO!', color: '#fbbf24' };
  if (r.stage === 'result') return { text: `${r.last} ms`, color: r.last < 350 ? '#16a34a' : '#0ea5e9' };
  return { text: 'wait…', color: lerpColor(theme.floor, theme.shade, 0.12) };
}

/**
 * The words standing over the start: the countdown's numerals, then GO.
 * @param {any} state @returns {string | null}
 */
export function countdownText(state) {
  if (state.phase === 'countdown' && state.count >= 0 && state.count < 3) return String(3 - state.count);
  if (state.phase === 'racing' && state.phaseAt !== null && state.now - state.phaseAt < 700) return 'GO!';
  return null;
}

/**
 * Paint the Arena.
 * @param {any} state @param {DrawContext} ctx @returns {Drawn}
 */
export function drawTrack(state, ctx) {
  const { view, theme, px } = ctx;
  const light = ctx.light ?? null;
  const t = ctx.reduce ? 0 : ctx.time;
  const n = state.lanes.length;
  const half = (n * LANE_W) / 2;
  // the ground under the labels, the lanes, and the podium or the sign
  const near = Math.max(half, 3.1) + 0.7;
  const far = state.kind === 'reflex' ? SIGN.z0 - 0.7 : -near;
  /** @type {Item[]} */
  const items = [slabItem(view, X0 - 2.6, far, PODIUM[0].x + 1.7, near, 0, theme.floor, theme, px)];
  const lit = state.phase === 'finished' ? state.places[0] ?? null : state.leader;

  // the lanes lie flat on the ground, so they are painted before anything
  // that stands on them, far ones first
  /** @type {Group[]} */
  const lanes = state.lanes.map((/** @type {any} */ _lane, /** @type {number} */ i) => {
    const z = laneZ(i, n);
    const tint = lerpColor(LANE_INKS[i % LANE_INKS.length], theme.floor, i === lit ? 0.35 : 0.68);
    return blockGroup(view, { x0: X0, x1: X1, z0: z - LANE_W / 2 + 0.05, z1: z + LANE_W / 2 - 0.05, y1: 0.05 }, tint, { theme, light, px });
  });
  items.push(...flatten(lanes));
  items.push(groundQuad(view, X0 - 0.08, -half, X0 + 0.08, half, 0.06, theme.ink));

  // the chequered finish: two columns of squares across every lane
  const sq = LANE_W / 4;
  for (let r = 0; r < n * 4; r++) {
    for (let c = 0; c < 2; c++) {
      items.push(groundQuad(view, X1 + c * sq, -half + r * sq, X1 + (c + 1) * sq, -half + (r + 1) * sq, 0.07, (r + c) % 2 === 0 ? theme.ink : theme.paper));
    }
  }

  /** @type {Array<Group | null>} */
  const groups = [];
  /** @type {FigureRequest[]} */
  const figures = [];
  state.lanes.forEach((/** @type {any} */ lane, /** @type {number} */ i) => {
    groups.push(labelGroup(view, [X0 - 1.5, 0.3, laneZ(i, n)], lane.label, { theme, size: 0.42 }));
    const at = runnerAt(state, i);
    const pose = poseOf(state, i, t);
    const id = `lane-${i}`;
    figures.push({ id, pose });
    const body = ctx.bodies?.[id];
    const shape = body ? skeletonShape(body) : person(pose);
    const sway = t === 0 ? 0.3 : 0.3 + 0.12 * Math.sin(t / 300 + i);
    const runner = figureGroup(view, at, shape, { color: lane.color, theme, stature: STATURE, sway, alpha: lane.out ? 0.7 : 1 });
    if (runner && i === lit) runner.items.push(...marksItems(view, at, theme, t));
    groups.push(runner);
    if (onPodium(state, i)) {
      groups.push(medalGroup(view, [at[0], at[1] + STATURE + 0.95, at[2]], lane.place, theme, px));
    }
  });

  if (state.phase === 'finished' && state.kind !== 'reflex') {
    PODIUM.forEach((spot, k) => {
      const box = { x0: spot.x - 1, x1: spot.x + 1, z0: spot.z - 1, z1: spot.z + 1, y1: spot.h };
      const shadow = shadowItem(view, box, light, theme);
      if (shadow) items.push(shadow);
      groups.push(blockGroup(view, box, lerpColor(theme.paper, theme.shade, 0.08), { theme, light, px, top: MEDALS[k] }));
    });
  }

  if (state.kind === 'reflex') {
    const lift = state.reflex?.lift ?? 0.35;
    const face = signFace(state, theme);
    const box = { x0: SIGN.x0, x1: SIGN.x1, z0: SIGN.z0, z1: SIGN.z1, y1: Math.max(0.2, lift) };
    const shadow = shadowItem(view, box, light, theme);
    if (shadow) items.push(shadow);
    groups.push(blockGroup(view, box, face.color, { theme, light, px }));
    groups.push(labelGroup(view, [0, Math.max(0.2, lift) + 0.75, (SIGN.z0 + SIGN.z1) / 2], face.text,
      { theme, size: face.text === 'GO!' ? 1.3 : 0.8, fill: theme.ink, stroke: theme.paper }));
  }

  const words = countdownText(state);
  if (words) groups.push(labelGroup(view, [X0 + 2.5, 3.4, 0], words, { theme, size: 1.7, fill: '#fbbf24', stroke: theme.ink }));

  items.push(...flatten(groups));
  return { items, figures };
}

/** The camera the race is watched through, and the shots it cuts to. */
export const TRACK_CAMERA = Object.freeze({ azimuth: 1.05, elevation: 0.85, distance: 40, lift: 0.8, fov: 0.62, target: /** @type {V3} */ ([0, 0, 0]) });
export const START_SHOT = Object.freeze({ azimuth: 1.3, elevation: 0.5, distance: 22, lift: 1.4, fov: 0.66, target: /** @type {V3} */ ([X0 + 2, 0, 0]) });
export const PODIUM_SHOT = Object.freeze({ azimuth: 1.15, elevation: 0.42, distance: 22, lift: 2.2, fov: 0.64, target: /** @type {V3} */ ([X1 + 2, 0.8, 0]) });
