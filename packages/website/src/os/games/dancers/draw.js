//@ts-check
/**
 * Drawing Tape Dancers into the stage's display list. The tape is a row
 * of lit, outlined blocks on a stage floor, each cell as tall and as
 * bright as its ink, numbered along the front edge; the goal tape stands
 * behind it as a ghost row, so the difference is there to see. The cell
 * under the dancer glows, and after a miss the first wrong cell is
 * ringed in red on both rows. A radiant sunburst stands behind it all,
 * turning while the dance goes on; the front of the stage says which
 * tape is up, the step count against par, and any goal a ghost row
 * cannot show (where to finish, the answer to give, the ink to leave).
 *
 * The dancer is a Haring cut-out above its cell: posed by the game, or
 * simulated by the arcade's ragdoll once it has asked for one (the
 * `figures` request; `ctx.bodies.dancer` holds the body), never both, and
 * never in a way the game depends on. It hops from cell to cell on the
 * beat, radiates motion marks while it dances, and carries a little sign
 * naming its control state, so the state machine is visible as it runs.
 */

import { lerpColor } from '@jarenjs/core/color';
import { project, depthOf } from '../../stage/camera.js';
import { POSES, mixPose, person, skeletonShape, motionMarks } from '../../stage/figures.js';
import { blockGroup, slabItem, shadowItem, figureGroup, labelGroup, flatten } from '../../engine/render.js';
import { EASE } from '../../engine/fx.js';
import { BLANK, INKS, INK_NAMES } from './program.js';
import { CELL, beatTicks, blockTop, cellX, inkAt, levelOf } from './state.js';

/**
 * @typedef {import('../game.js').DrawContext} DrawContext
 * @typedef {import('../game.js').Drawn} Drawn
 * @typedef {import('../game.js').Item} Item
 * @typedef {import('../game.js').Pose} Pose
 * @typedef {import('../game.js').View} View
 * @typedef {import('../game.js').V3} V3
 * @typedef {import('../../engine/render.js').Group} Group
 * @typedef {import('./state.js').DancersState} DancersState
 * @typedef {import('./state.js').Shown} Shown
 */

/** The dancer's colour: a green no ink on the tape uses. */
export const DANCER_COLOR = '#16a34a';

/** The red that rings a wrong cell. */
const WRONG = '#ef4444';

/** The dancer's height, world units. */
const STATURE = 1.9;

/** How high a hop to the next cell lifts the dancer. */
const HOP = 0.8;

/** Ticks a hop takes at most (a slow beat rests after it). */
const HOP_TICKS = 10;

/** Cells drawn either side of the input's middle. */
const VIEW_HALF = 12;

/** Gap between neighbouring blocks. */
const INSET = 0.08;

/** The tape row and the ghost row behind it, along z. */
const ROW = Object.freeze({ z0: -0.5, z1: 0.5 });
const GHOST = Object.freeze({ z0: -2.1, z1: -1.3, alpha: 0.38, height: 0.6 });

/** Where the front of the stage carries its lines of text, along z. */
const CAPTION_Z = 1.6;
const NOTE_Z = 2.2;
const FRONT_Z = 2.55;

/** @param {View} view @param {number[][]} pts @returns {number[]} */
const flat = (view, pts) => pts.flatMap(([x, y, z]) => project(view, x, y, z).slice(0, 2));

/**
 * The radiant backdrop: alternating rays from a sun behind the stage,
 * turning slowly while the dancer dances.
 * @param {View} view @param {{ ray: string }} theme @param {number} spin - radians
 * @returns {Item[]}
 */
function backdrop(view, theme, spin) {
  const cx = view.width / 2;
  const cy = view.height * 0.42;
  const reach = Math.hypot(view.width, view.height);
  /** @type {Item[]} */
  const rays = [];
  for (let i = 0; i < 24; i += 2) {
    const a0 = spin + (i / 24) * Math.PI * 2;
    const a1 = spin + ((i + 1) / 24) * Math.PI * 2;
    rays.push({ t: 'poly', p: [cx, cy, cx + Math.cos(a0) * reach, cy + Math.sin(a0) * reach, cx + Math.cos(a1) * reach, cy + Math.sin(a1) * reach], fill: theme.ray, stroke: null, w: 0 });
  }
  return rays;
}

/**
 * An outline around a cell's footprint at height `y`, a little larger
 * than the block that stands there.
 * @param {View} view @param {number} x @param {{ z0: number, z1: number }} row @param {number} y
 * @param {string} stroke @param {number} w @returns {Item}
 */
function ringItem(view, x, row, y, stroke, w) {
  const h = CELL / 2;
  const z0 = row.z0 - 0.08;
  const z1 = row.z1 + 0.08;
  return { t: 'poly', p: flat(view, [[x - h, y, z0], [x + h, y, z0], [x + h, y, z1], [x - h, y, z1]]), fill: null, stroke, w };
}

/**
 * The cell a miss points at (null when it points at none): the wrong
 * cell, the cell the dancer should have finished on, or where it halted
 * on the wrong answer.
 * @param {Shown | null} verdict @returns {number | null}
 */
function wrongCell(verdict) {
  const miss = verdict?.miss;
  if (!miss || miss.kind === 'halt' || miss.kind === 'ones') return null;
  return Number(miss.kind === 'end' ? miss.want : miss.cell);
}

/**
 * How the dancer stands: stamping into each hop while it dances, arms up
 * after a solve, bowing after a miss, swaying gently while it waits.
 * @param {DancersState} state @param {number} k - how far through the hop @param {number} time @param {boolean} reduce
 * @returns {Pose}
 */
function poseOf(state, k, time, reduce) {
  const mode = state.run.mode;
  if (mode === 'done') return state.verdict?.solved ? POSES.jubilant : POSES.bow;
  if (mode === 'running') return mixPose(POSES.stamp, POSES.dance, k);
  return reduce ? POSES.dance : mixPose(POSES.dance, POSES.jubilant, 0.3 + 0.3 * Math.sin(time / 420));
}

/**
 * Draw the stage.
 * @param {DancersState} state @param {DrawContext} ctx @returns {Drawn}
 */
export function draw(state, ctx) {
  const level = levelOf(state);
  const { run, verdict } = state;
  const test = level.tests[run.test];
  const { view, theme, px } = ctx;
  const light = ctx.light ?? null;
  const reduce = ctx.reduce === true;
  const head = run.head - run.origin;
  const middle = Math.round((test.input.length - 1) / 2);
  const lo = Math.max(run.origin > 0 ? -run.origin : 0, middle - VIEW_HALF);
  const hi = Math.min(run.tape.length - run.origin - 1, middle + VIEW_HALF);
  const goal = test.goal ?? null;
  const gHi = goal ? Math.min(Math.max(hi, goal.length - 1), middle + VIEW_HALF) : hi;
  const wrong = wrongCell(verdict);

  /** @type {Item[]} */
  const floor = backdrop(view, theme, reduce || run.mode !== 'running' ? 0 : ctx.time / 9000);
  /** @type {Array<Group | null>} */
  const groups = [];
  // the floor reaches every cell on show, and the cell to finish on
  const left = cellX(test, Math.min(lo, 0, test.end ?? 0)) - CELL * 0.9;
  const right = cellX(test, Math.max(gHi, test.end ?? gHi)) + CELL * 0.9;
  floor.push(slabItem(view, left, GHOST.z0 - 0.6, right, FRONT_Z, 0, theme.floor, theme, px));
  const hx = cellX(test, head);
  floor.push(slabItem(view, hx - CELL * 0.55, ROW.z0 - 0.16, hx + CELL * 0.55, ROW.z1 + 0.16, 0.005, theme.glow, theme, px));

  for (let cell = lo; cell <= hi; cell++) {
    const ink = inkAt(run, cell);
    const x = cellX(test, cell);
    const box = { x0: x - CELL / 2 + INSET, x1: x + CELL / 2 - INSET, z0: ROW.z0, z1: ROW.z1, y1: blockTop(ink) };
    const shadow = shadowItem(view, box, light, theme);
    if (shadow) floor.push(shadow);
    const top = cell === head ? lerpColor(INKS[ink], theme.glow, 0.5) : undefined;
    groups.push(blockGroup(view, box, INKS[ink], { theme, light, px, top }));
    groups.push(labelGroup(view, [x, 0.02, 0.9], String(cell + 1), { theme, size: 0.3, alpha: 0.8 }));
  }

  if (goal) {
    for (let cell = Math.min(lo, 0); cell <= gHi; cell++) {
      const ink = goal[cell] ?? BLANK;
      const x = cellX(test, cell);
      const box = { x0: x - CELL / 2 + INSET * 2, x1: x + CELL / 2 - INSET * 2, z0: GHOST.z0, z1: GHOST.z1, y1: blockTop(ink) * GHOST.height };
      const ghost = blockGroup(view, box, INKS[ink], { theme, light, px });
      groups.push({ d: ghost.d, items: ghost.items.map((item) => ({ ...item, a: GHOST.alpha })) });
    }
  }

  /** @type {string[]} */
  const notes = [];
  if (test.end !== undefined) {
    floor.push(ringItem(view, cellX(test, test.end), ROW, 0.01, theme.ink, 3 * px));
    notes.push(`finish on cell ${test.end + 1}`);
  }
  if (test.mark !== undefined) notes.push(`this tape answers ${INK_NAMES[test.mark]}`);
  if (test.ones !== undefined) notes.push(`${test.ones} blue or more`);
  if (notes.length > 0) groups.push(labelGroup(view, [0, 0.02, NOTE_Z], notes.join(' · '), { theme, size: 0.32 }));

  if (wrong !== null) {
    const x = cellX(test, wrong);
    const y = blockTop(inkAt(run, wrong)) + 0.03;
    /** @type {Item[]} */
    const rings = [ringItem(view, x, ROW, y, WRONG, 5 * px)];
    if (goal) rings.push(ringItem(view, x, GHOST, blockTop(goal[wrong] ?? BLANK) * GHOST.height + 0.03, WRONG, 4 * px));
    groups.push({ d: depthOf(view, x, y, 0) - 0.45, items: rings });
  }

  // the dancer, between the cell it hopped from and the one it stands on
  const k = reduce ? 1 : Math.max(0, Math.min(1, (run.clock + 1) / Math.min(HOP_TICKS, beatTicks(run.total + run.steps))));
  const ease = EASE.inOutSine(k);
  const fromX = cellX(test, run.from);
  const fromY = blockTop(inkAt(run, run.from));
  const x = fromX + (hx - fromX) * ease;
  const lift = reduce ? 0 : Math.sin(Math.PI * k) * (run.from === head ? 0.25 : HOP);
  const y = fromY + (blockTop(inkAt(run, head)) - fromY) * ease + lift;
  const pose = poseOf(state, k, ctx.time, reduce);
  const body = ctx.bodies?.dancer;
  const shape = body ? skeletonShape(body) : person(pose);
  const sway = run.mode === 'running' ? 0.3 + 0.25 * Math.sin(Math.PI * k) : 0.3;
  const figure = figureGroup(view, [x, y, 0], shape, { color: DANCER_COLOR, theme, stature: STATURE, sway });
  groups.push(figure);

  if (run.mode === 'running' && figure) {
    const anchor = project(view, x, y, 0);
    const up = project(view, x, y + STATURE, 0);
    const unit = Math.abs(anchor[1] - up[1]) / 2.1;
    const pulse = reduce ? 0 : 0.08 * Math.sin(Math.PI * k);
    const marks = motionMarks(shape.center, 1.15, 9, pulse).map(([p1, p2]) => /** @type {Item} */ ({
      t: 'line', p: [anchor[0] + p1[0] * unit, anchor[1] - p1[1] * unit, anchor[0] + p2[0] * unit, anchor[1] - p2[1] * unit],
      stroke: theme.ink, w: 0.075 * unit,
    }));
    groups.push({ d: figure.d - 0.05, items: marks });
  }

  // the sign over the dancer's head: its control state
  /** @type {V3} */
  const signAt = [x, y + STATURE + 0.8, 0];
  const sign = labelGroup(view, signAt, run.state, { theme, size: 0.44, stroke: null });
  if (sign) {
    const c = project(view, signAt[0], signAt[1], signAt[2]);
    const t = project(view, signAt[0], signAt[1] + 0.44, signAt[2]);
    const foot = project(view, x, y + STATURE + 0.2, 0);
    const h = Math.abs(c[1] - t[1]) * 1.6;
    const w = h * (0.42 * run.state.length + 0.8);
    sign.items.unshift(
      { t: 'line', p: [c[0], c[1] + h / 2, foot[0], foot[1]], stroke: theme.ink, w: 2.4 * px },
      { t: 'rect', x: c[0] - w / 2, y: c[1] - h / 2, wd: w, ht: h, r: h * 0.25, fill: theme.paper, stroke: theme.ink, w: 2.6 * px },
    );
    groups.push(sign);
  }

  const tapeNote = level.tests.length > 1 ? `tape ${run.test + 1} of ${level.tests.length} · ` : '';
  groups.push(labelGroup(view, [0, 0.02, CAPTION_Z], `${tapeNote}step ${run.total + run.steps} · par ${level.par.steps}`, { theme, size: 0.34 }));

  return { items: [...floor, ...flatten(groups)], figures: [{ id: 'dancer', pose }] };
}
