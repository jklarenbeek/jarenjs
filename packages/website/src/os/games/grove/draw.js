//@ts-check
/**
 * Monkey Grove drawn into the stage's display list: the island and its
 * chambers as lit, outlined blocks standing in an animated sea, painted
 * in each world's colours; the things on them — rocks, palms, the altar,
 * number stones with their labels, the soil bed lighting up as the bed
 * grows, the vine with its marks, baskets with their coconuts — and the
 * two monkeys as cut-out figures.
 *
 * The hub shows how far each world has come home: tiles near a portal
 * warm from gray to the world's colour as its share of mastery grows
 * (a fresh island starts mostly gray), flowers open, and each gate
 * dresses up step by step. A hint or a miss puts the problem's picture —
 * a bed of dots, baskets, a strip, a little number line — on the free
 * floor nearest the middle of the board.
 *
 * Pure: the frame is a function of the state and the draw context. The
 * figures the arcade should keep lively are named in `figures`, and
 * when it hands back their simulated skeletons in `ctx.bodies` those
 * are drawn instead of the pose (gameplay never waits on them).
 */

import { lerpColor, relativeLuminance } from '@jarenjs/core/color';
import { project, depthOf } from '../../stage/camera.js';
import { skeleton } from '../../stage/figures.js';
import { blockGroup, slabItem, waterItems, shadowItem, figureGroup, labelGroup, flatten } from '../../engine/render.js';
import { centerOf } from './boards.js';
import { COLORS, WORLD_COLORS } from './palette.js';
import { monkey, monkeyShape, monkeyPose, mimiPose, flowerSpot } from './shapes.js';
import { bedRect, vineTicks } from './verbs.js';
import { WORLDS, GATE_STEPS, masteryReport, gateStage } from './math.js';
import { DUNK_MS, JUMP_MS } from './walk.js';
import { t } from './strings.js';

/**
 * @typedef {import('./flow.js').GroveState} GroveState
 * @typedef {import('./boards.js').Board} Board
 * @typedef {import('./walk.js').Stone} Stone
 * @typedef {import('./math.js').World} World
 * @typedef {import('../game.js').DrawContext} DrawContext
 * @typedef {import('../game.js').Drawn} Drawn
 * @typedef {import('../game.js').FigureRequest} FigureRequest
 * @typedef {import('../../engine/render.js').Group} Group
 * @typedef {import('../../engine/render.js').Box} Box
 * @typedef {import('../../engine/render.js').Theme} Theme
 * @typedef {import('../../stage/scene.js').Item} Item
 * @typedef {import('../../stage/camera.js').View} View
 * @typedef {{ view: View, theme: Theme, light: import('../../engine/light.js').Lighting | null, px: number, time: number,
 *   ground: Group[], decals: Item[], groups: Group[], picks: NonNullable<Drawn['picks']> }} Canvas
 */

/** Figure heights, world units. */
const MONKEY_STATURE = 1.7;
const MIMI_STATURE = 1.85;
const SWAY = 0.25;
/** The sea is drawn in square cells this wide, this far round the island. */
const SEA_CELL = 6;
const SEA_REACH = 42;
/** Flower colours on a blooming island. */
const FLOWERS = Object.freeze([COLORS.gold, COLORS.red, COLORS.orange, COLORS.paper]);

/** Whether a theme is a night one (its paper dark). @param {Theme} theme */
function night(theme) {
  return relativeLuminance(theme.paper) < 0.3;
}

/**
 * The sea round the island to the horizon: square cells of rolling
 * waves, leaving out any the eye is level with or past and any off
 * screen (a cell reaching behind the eye would project inside out).
 * @param {View} view @param {Theme} theme @param {number} time @param {number} px @returns {Item[]}
 */
function sea(view, theme, time, px) {
  const color = night(theme) ? COLORS.seaNight : COLORS.sea;
  /** @type {Item[]} */
  const items = [];
  for (let z = -SEA_REACH; z < SEA_REACH; z += SEA_CELL) {
    for (let x = -SEA_REACH; x < SEA_REACH; x += SEA_CELL) {
      const corners = [[x, z], [x + SEA_CELL, z], [x, z + SEA_CELL], [x + SEA_CELL, z + SEA_CELL]].map(([cx, cz]) => project(view, cx, 0, cz));
      if (corners.some((c) => c[2] < 1)) continue;
      const off = corners.every((c) => c[0] < 0) || corners.every((c) => c[0] > view.width)
        || corners.every((c) => c[1] < 0) || corners.every((c) => c[1] > view.height);
      if (!off) items.push(...waterItems(view, x, z, x + SEA_CELL, z + SEA_CELL, time, { theme, color, px, rows: 3 }));
    }
  }
  return items;
}

/**
 * The hard shadow a thing standing on the ground casts, when the light casts one.
 * @param {Canvas} cv @param {Box} box - from the ground up
 */
function castShadow(cv, box) {
  const shadow = shadowItem(cv.view, box, cv.light, cv.theme);
  if (shadow) cv.decals.push(shadow);
}

/**
 * A solid block; one standing on the ground casts its shadow (a part
 * held up — a canopy, a lintel — is in the shadow of what holds it).
 * @param {Canvas} cv @param {Box} box @param {string} color @param {string} [top]
 */
function solid(cv, box, color, top) {
  cv.groups.push(blockGroup(cv.view, box, color, { theme: cv.theme, light: cv.light, px: cv.px, top }));
  if ((box.y0 ?? 0) <= 0) castShadow(cv, box);
}

/**
 * A box around a point on the ground.
 * @param {number} x @param {number} z @param {number} half @param {number} y1 @param {number} [y0] @returns {Box}
 */
function around(x, z, half, y1, y0 = 0) {
  return { x0: x - half, x1: x + half, z0: z - half, z1: z + half, y0, y1 };
}

/**
 * A label standing over a point.
 * @param {Canvas} cv @param {[number, number, number]} at @param {string} text @param {number} [size] @param {number} [alpha]
 */
function label(cv, at, text, size = 0.6, alpha) {
  const group = labelGroup(cv.view, at, text, { theme: cv.theme, size, alpha });
  if (group) cv.groups.push(group);
}

/**
 * The screen point and scale of a figure-frame point, mapped the way the
 * stage maps a cut-out standing at `at`.
 * @param {View} view @param {[number, number, number]} at @param {number} stature @param {[number, number]} uv
 * @returns {[number, number, number]} x, y and one figure unit in pixels
 */
function figurePoint(view, at, stature, [u, v]) {
  const anchor = project(view, at[0], at[1], at[2]);
  const up = project(view, at[0], at[1] + stature, at[2]);
  const unit = Math.abs(anchor[1] - up[1]) / 2.1;
  return [anchor[0] + u * unit * Math.max(0.35, Math.cos(SWAY)), anchor[1] - v * unit, unit];
}

/**
 * A dot lying on the ground, sized in world units.
 * @param {Canvas} cv @param {number} x @param {number} z @param {number} r @param {string} fill @returns {Item}
 */
function dot(cv, x, z, r, fill) {
  const c = project(cv.view, x, 0.03, z);
  const e = project(cv.view, x + r, 0.03, z);
  return { t: 'disc', x: c[0], y: c[1], r: Math.max(1.5, Math.hypot(e[0] - c[0], e[1] - c[1])), fill, stroke: cv.theme.ink, w: 1.1 * cv.px };
}

/**
 * The colour of a ground tile.
 * @param {GroveState} state @param {string} ch @param {number} i @param {number} j
 * @param {Record<World, { p: number, stage: number }> | null} bloom @param {Rect | null} bed
 */
function tileColor(state, ch, i, j, bloom, bed) {
  const board = state.board;
  if ('1234'.includes(ch)) return WORLD_COLORS[WORLDS[Number(ch) - 1]].accent;
  if (ch === 'o') {
    const lit = bed && i >= bed.i0 && i <= bed.i1 && j >= bed.j0 && j <= bed.j1;
    return lit ? ((i + j) % 2 ? COLORS.lime : COLORS.leaf) : ((i + j) % 2 ? COLORS.bark : COLORS.wood);
  }
  if (ch === 'V') return COLORS.bark;
  /** @type {string} */
  let base;
  if (bloom) {
    const world = nearestPortal(board, i, j);
    base = lerpColor(COLORS.gray, WORLD_COLORS[world].floor, 0.25 + 0.75 * bloom[world].p);
  }
  else base = WORLD_COLORS[/** @type {World} */ (board.world)].floor;
  if (ch === ',') base = lerpColor(base, COLORS.leaf, 0.18);
  return (i + j) % 2 ? lerpColor(base, '#000000', 0.06) : base;
}

/** @typedef {import('./verbs.js').Rect} Rect */

/**
 * The world whose portal is nearest a hub tile.
 * @param {Board} board @param {number} i @param {number} j @returns {World}
 */
function nearestPortal(board, i, j) {
  const portals = /** @type {Record<World, [number, number]>} */ (board.portals);
  let best = WORLDS[0];
  for (const w of WORLDS) {
    if (Math.hypot(portals[w][0] - i, portals[w][1] - j) < Math.hypot(portals[best][0] - i, portals[best][1] - j)) best = w;
  }
  return best;
}

/**
 * How far each world has bloomed on the island: its share of mastery
 * (stored ratings, so the reward never wilts), never below the step its
 * gate has already reached.
 * @param {GroveState} state @returns {Record<World, { p: number, stage: number }>}
 */
export function hubBloom(state) {
  const report = masteryReport(state.progress.math);
  return /** @type {Record<World, { p: number, stage: number }>} */ (Object.fromEntries(WORLDS.map((w) => {
    const pct = report.worlds[w].pct;
    const stage = Math.max(state.progress.gates[w], gateStage(pct));
    return [w, { p: Math.max(Math.min(1, pct * 1.15), stage > 0 ? GATE_STEPS[stage - 1] : 0), stage }];
  })));
}

/**
 * A flower lying on a tile.
 * @param {Canvas} cv @param {number} x @param {number} z @param {string} color
 */
function flower(cv, x, z, color) {
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    cv.decals.push(dot(cv, x + Math.cos(a) * 0.09, z + Math.sin(a) * 0.09, 0.07, color));
  }
  cv.decals.push(dot(cv, x, z, 0.05, COLORS.gold));
}

/**
 * A hub portal: two posts and a lintel in the world's colour, dressed by
 * its bloom step (flowers along the lintel, a star once it is whole), and
 * the world's name over it.
 * @param {Canvas} cv @param {GroveState} state @param {World} world @param {{ p: number, stage: number }} bloom
 */
function portal(cv, state, world, bloom) {
  const board = state.board;
  const [i, j] = /** @type {Record<World, [number, number]>} */ (board.portals)[world];
  const [x, z] = centerOf(board, i, j);
  const color = lerpColor(COLORS.gray, WORLD_COLORS[world].accent, 0.35 + 0.65 * bloom.p);
  solid(cv, { x0: x - 0.48, x1: x - 0.3, z0: z - 0.09, z1: z + 0.09, y1: 1.2 }, color);
  solid(cv, { x0: x + 0.3, x1: x + 0.48, z0: z - 0.09, z1: z + 0.09, y1: 1.2 }, color);
  solid(cv, { x0: x - 0.52, x1: x + 0.52, z0: z - 0.11, z1: z + 0.11, y0: 1.2, y1: 1.38 }, color, COLORS.gold);
  /** @type {Item[]} */
  const dress = [];
  for (let k = 0; k < bloom.stage * 2; k++) {
    const c = project(cv.view, x - 0.42 + (k / 7) * 0.84, 1.42, z);
    dress.push({ t: 'disc', x: c[0], y: c[1], r: 4.5 * cv.px, fill: FLOWERS[k % FLOWERS.length], stroke: cv.theme.ink, w: 1.3 * cv.px });
  }
  if (bloom.stage >= 4) {
    const c = project(cv.view, x, 1.75, z);
    /** @type {number[]} */
    const star = [];
    for (let k = 0; k < 10; k++) {
      const a = -Math.PI / 2 + (k / 10) * Math.PI * 2;
      const r = (k % 2 ? 5 : 12) * cv.px;
      star.push(c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r);
    }
    dress.push({ t: 'poly', p: star, fill: COLORS.gold, stroke: cv.theme.ink, w: 1.4 * cv.px });
  }
  cv.groups.push({ d: depthOf(cv.view, x, 1.4, z) - 0.2, items: dress });
  label(cv, [x, 2.05, z], t(state.lang, `world.${world}`), 0.55);
  const c = project(cv.view, x, 0.6, z);
  cv.picks.push({ id: `portal:${world}`, x: c[0], y: c[1], r: 26 * cv.px });
}

/**
 * The banana pile by Mimi: more bunches the more bananas there are.
 * @param {Canvas} cv @param {GroveState} state
 */
function bananaPile(cv, state) {
  const board = state.board;
  const [i, j] = /** @type {[number, number]} */ (board.pile);
  const [x, z] = centerOf(board, i, j);
  solid(cv, around(x, z, 0.4, 0.3), COLORS.wood, COLORS.bark);
  const bunches = Math.min(9, Math.ceil(Math.log2(state.progress.bananas + 1)));
  for (let k = 0; k < bunches; k++) {
    const layer = Math.floor(k / 4);
    const a = (k % 4) * (Math.PI / 2) + layer * 0.6;
    const bx = x + Math.cos(a) * 0.18 * (1 - layer * 0.4);
    const bz = z + Math.sin(a) * 0.18 * (1 - layer * 0.4);
    solid(cv, around(bx, bz, 0.11, 0.3 + (layer + 1) * 0.16, 0.3 + layer * 0.16), COLORS.gold, COLORS.sand);
  }
  label(cv, [x, 1.15, z], String(state.progress.bananas), 0.6);
}

/**
 * A number stone: a rounded block (its edge, then its face) and its label.
 * @param {Canvas} cv @param {Stone} stone @param {number} y @param {number} [depthBias]
 */
function stoneGroup(cv, stone, y, depthBias = 0) {
  const c = project(cv.view, stone.x, y + 0.3, stone.z);
  if (c[2] <= 0) return;
  const top = project(cv.view, stone.x, y + 0.8, stone.z);
  const h = Math.max(12, Math.abs(c[1] - top[1]) * 1.4);
  const wd = h * (stone.label.length > 3 ? 2 : 1.3);
  const a = stone.tried ? 0.55 : 1;
  const fill = stone.tried ? COLORS.stone : COLORS.paper;
  cv.groups.push({
    d: depthOf(cv.view, stone.x, y + 0.3, stone.z) + depthBias,
    items: [
      { t: 'rect', x: c[0] - wd / 2, y: c[1] - h / 2 + h * 0.2, wd, ht: h, r: h * 0.38, fill: lerpColor(fill, cv.theme.shade, 0.35), stroke: cv.theme.ink, w: 2.4 * cv.px, a },
      { t: 'rect', x: c[0] - wd / 2, y: c[1] - h / 2, wd, ht: h, r: h * 0.38, fill, stroke: cv.theme.ink, w: 2.6 * cv.px, a },
    ],
  });
  const text = labelGroup(cv.view, [stone.x, y + 0.2, stone.z], stone.label, { theme: cv.theme, size: stone.label.length > 3 ? 0.36 : 0.5, alpha: a });
  if (text) cv.groups.push({ ...text, d: text.d + depthBias });
  cv.picks.push({ id: `stone:${stone.id}`, x: c[0], y: c[1], r: Math.max(14, wd * 0.6) });
}

/**
 * The tiles and what stands on them.
 * @param {Canvas} cv @param {GroveState} state
 */
function terrain(cv, state) {
  const board = state.board;
  const bloom = board.kind === 'hub' ? hubBloom(state) : null;
  const chamber = state.chamber;
  const verb = chamber?.verb;
  const bed = verb?.kind === 'array' ? (verb.grown ?? bedRect(board, verb.anchor, state.monkey)) : null;
  board.rows.forEach((row, j) => [...row].forEach((ch, i) => {
    if (ch === '#') return;
    const [x, z] = centerOf(board, i, j);
    const color = tileColor(state, ch, i, j, bloom, bed);
    cv.ground.push(blockGroup(cv.view, { x0: x - 0.5, x1: x + 0.5, z0: z - 0.5, z1: z + 0.5, y0: -0.4, y1: 0 }, color, { theme: cv.theme, light: cv.light, px: cv.px }));
    if (bloom && '.,'.includes(ch)) {
      const world = nearestPortal(board, i, j);
      if (((i * 37 + j * 11) % 100) < bloom[world].p * 45) flower(cv, x + 0.18, z - 0.12, FLOWERS[(i + j) % FLOWERS.length]);
    }
    if (ch === 'r') solid(cv, around(x, z, 0.4, 0.75), COLORS.stone, lerpColor(COLORS.stone, COLORS.paper, 0.3));
    else if (ch === 't') {
      solid(cv, around(x, z, 0.14, 1.1), COLORS.bark);
      solid(cv, around(x, z, 0.55, 1.85, 0.95), COLORS.leaf, COLORS.lime);
      castShadow(cv, around(x, z, 0.55, 1.85));
    }
    else if (ch === 'A') {
      solid(cv, around(x, z, 0.4, 0.55), COLORS.stone);
      solid(cv, around(x, z, 0.48, 0.85, 0.55), COLORS.gold, COLORS.sand);
      castShadow(cv, around(x, z, 0.48, 0.85));
    }
    else if (ch === 'm') solid(cv, around(x, z, 0.45, 0.55), COLORS.bark, COLORS.sand);
  }));
  if (bloom) {
    for (const w of WORLDS) portal(cv, state, w, bloom[w]);
    bananaPile(cv, state);
  }
}

/**
 * The model pad: the problem's picture on the free floor (a bed of dots,
 * baskets, a strip, a short number line, a counting run).
 * @param {Canvas} cv @param {GroveState} state
 */
function modelPad(cv, state) {
  const board = state.board;
  const chamber = /** @type {NonNullable<GroveState['chamber']>} */ (state.chamber);
  const pad = board.pad;
  const { model, meta } = chamber.problem;
  if (!pad || chamber.problem.kind !== 'fetch' || !chamber.modelShown) return;
  const [x0, z0] = centerOf(board, pad.i, pad.j);
  const left = x0 - 0.5;
  const back = z0 - 0.5;
  cv.decals.push(slabItem(cv.view, left, back, left + pad.w, back + pad.d, 0.02, COLORS.paper, cv.theme, cv.px));
  const at = (/** @type {number} */ u, /** @type {number} */ v) => /** @type {[number, number]} */ ([left + u * pad.w, back + v * pad.d]);
  if (model.kind === 'array') {
    const { rows, cols } = model.params;
    // wide beds are drawn as rods of ten and loose ones, row by row
    const tens = cols > 12 ? Math.floor(cols / 10) : 0;
    const ones = cols > 12 ? cols % 10 : cols;
    const slots = tens + ones;
    for (let r = 0; r < rows; r++) {
      const v = (r + 0.5) / rows;
      for (let k = 0; k < slots; k++) {
        const [x, z] = at((k + 0.5) / slots, v);
        if (k < tens) {
          const a = project(cv.view, x - 0.4 / slots * pad.w, 0.03, z);
          const b = project(cv.view, x + 0.4 / slots * pad.w, 0.03, z);
          cv.decals.push({ t: 'line', p: [a[0], a[1], b[0], b[1]], stroke: COLORS.blue, w: 4 * cv.px });
        }
        else cv.decals.push(dot(cv, x, z, Math.min(0.08, 0.35 * pad.d / rows), COLORS.lime));
      }
    }
  }
  else if (model.kind === 'baskets') {
    const { baskets, quotient, remainder } = model.params;
    const spread = baskets + (remainder > 0 ? 1 : 0);
    for (let k = 0; k < spread; k++) {
      const [x, z] = at((k + 0.5) / spread, 0.5);
      const extra = k === baskets;
      cv.decals.push(slabItem(cv.view, x - 0.17, z - 0.17, x + 0.17, z + 0.17, 0.04, extra ? COLORS.red : COLORS.bark, cv.theme, cv.px));
      label(cv, [x, 0.25, z], extra ? `+${remainder}` : String(quotient), 0.42);
    }
  }
  else if (model.kind === 'numberline') {
    const { n, d, lo, hi } = model.params;
    const [ax, az] = at(0.08, 0.5);
    const [bx] = at(0.92, 0.5);
    const a = project(cv.view, ax, 0.03, az);
    const b = project(cv.view, bx, 0.03, az);
    cv.decals.push({ t: 'line', p: [a[0], a[1], b[0], b[1]], stroke: cv.theme.ink, w: 2.4 * cv.px });
    for (let k = 0; k <= d * (hi - lo); k++) cv.decals.push(dot(cv, ax + (k / (d * (hi - lo))) * (bx - ax), az, 0.04, cv.theme.ink));
    cv.decals.push(dot(cv, ax + ((n / d - lo) / (hi - lo)) * (bx - ax), az, 0.09, COLORS.gold));
    label(cv, [ax, 0.25, az], String(lo), 0.4);
    label(cv, [bx, 0.25, az], String(hi), 0.4);
  }
  else if (model.kind === 'strip') {
    const { a, b, op } = model.params;
    for (const row of [{ n: a, v: 0.3, color: COLORS.blue }, { n: b, v: 0.72, color: op === '+' ? COLORS.lime : COLORS.red }]) {
      // up to twenty loose dots; past that, the number itself
      if (row.n > 20) {
        const [x, z] = at(0.5, row.v);
        label(cv, [x, 0.25, z], String(row.n), 0.45);
        continue;
      }
      for (let k = 0; k < row.n; k++) {
        const [x, z] = at((k + 0.5) / Math.max(row.n, 10), row.v);
        cv.decals.push(dot(cv, x, z, 0.06, row.color));
      }
    }
  }
  else {
    // a counting run: the two numbers given, a hop of one, and the gap
    [String(meta.a), String(meta.a + 1), '?'].forEach((text, k) => {
      const [x, z] = at((k + 0.5) / 3, 0.5);
      label(cv, [x, 0.25, z], text, 0.5);
    });
  }
}

/**
 * The stones of a stone hunt, the one on the altar while a right answer
 * is celebrated.
 * @param {Canvas} cv @param {GroveState} state
 */
function stones(cv, state) {
  const chamber = /** @type {NonNullable<GroveState['chamber']>} */ (state.chamber);
  const verb = chamber.verb;
  if (verb.kind !== 'fetch') return;
  for (const stone of verb.stones) stoneGroup(cv, stone, 0);
  if (chamber.lastTag === 'correct' && state.board.altar) {
    const [x, z] = centerOf(state.board, state.board.altar[0], state.board.altar[1]);
    stoneGroup(cv, { id: -1, value: chamber.problem.answer, label: String(chamber.problem.answer), tag: 'correct', x, z, tried: false }, 0.86, -0.4);
  }
}

/**
 * The soil bed: the flag, the grown bed's sprouts and its skip counts,
 * and — with the picture shown — the rows and columns numbered.
 * @param {Canvas} cv @param {GroveState} state
 */
function soilBed(cv, state) {
  const board = state.board;
  const soil = board.soil;
  const chamber = /** @type {NonNullable<GroveState['chamber']>} */ (state.chamber);
  const verb = chamber.verb;
  if (!soil || verb.kind !== 'array') return;
  if (verb.anchor) {
    const [x, z] = centerOf(board, verb.anchor[0], verb.anchor[1]);
    const foot = project(cv.view, x - 0.3, 0, z - 0.3);
    const tip = project(cv.view, x - 0.3, 0.9, z - 0.3);
    const flap = project(cv.view, x + 0.05, 0.75, z - 0.3);
    const low = project(cv.view, x - 0.3, 0.6, z - 0.3);
    cv.groups.push({
      d: depthOf(cv.view, x - 0.3, 0.4, z - 0.3),
      items: [
        { t: 'line', p: [foot[0], foot[1], tip[0], tip[1]], stroke: cv.theme.ink, w: 2.6 * cv.px },
        { t: 'poly', p: [tip[0], tip[1], flap[0], flap[1], low[0], low[1]], fill: COLORS.red, stroke: cv.theme.ink, w: 2 * cv.px },
      ],
    });
  }
  if (verb.grown) {
    const { i0, j0, i1, j1 } = verb.grown;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const [x, z] = centerOf(board, i, j);
        const a = project(cv.view, x, 0, z);
        const b = project(cv.view, x, 0.35, z);
        const l = project(cv.view, x - 0.15, 0.3, z);
        const r = project(cv.view, x + 0.15, 0.3, z);
        cv.groups.push({ d: depthOf(cv.view, x, 0.2, z), items: [
          { t: 'line', p: [a[0], a[1], b[0], b[1]], stroke: COLORS.leaf, w: 3 * cv.px },
          { t: 'line', p: [l[0], l[1], b[0], b[1], r[0], r[1]], stroke: COLORS.lime, w: 2.4 * cv.px },
        ] });
      }
      const [x, z] = centerOf(board, i1 + 1, j);
      label(cv, [x - 0.2, 0.3, z], String((j - j0 + 1) * (i1 - i0 + 1)), 0.45);
    }
  }
  if (chamber.modelShown) {
    for (let r = 0; r < soil.rows; r++) {
      const [x, z] = centerOf(board, soil.i0, soil.j0 + r);
      label(cv, [x - 0.3, 0.15, z], String(r + 1), 0.34, 0.85);
    }
    for (let c = 0; c < soil.cols; c++) {
      const [x, z] = centerOf(board, soil.i0 + c, soil.j0);
      label(cv, [x, 0.15, z - 0.3], String(c + 1), 0.34, 0.85);
    }
  }
}

/**
 * The vine: its rope, its marks and their labels by the labelling level,
 * its two ends, and flowers along it once it has been rung right.
 * @param {Canvas} cv @param {GroveState} state
 */
function vine(cv, state) {
  const board = state.board;
  const chamber = /** @type {NonNullable<GroveState['chamber']>} */ (state.chamber);
  const verb = chamber.verb;
  if (!board.vine || verb.kind !== 'numberline') return;
  const { i0, i1, j } = board.vine;
  const [ax, z] = centerOf(board, i0, j);
  const [bx] = centerOf(board, i1, j);
  const a = project(cv.view, ax, 0.05, z);
  const b = project(cv.view, bx, 0.05, z);
  cv.decals.push({ t: 'line', p: [a[0], a[1], b[0], b[1]], stroke: COLORS.leaf, w: 5 * cv.px });
  const { lo, hi } = chamber.problem.model.params;
  const xAt = (/** @type {number} */ value) => ax + ((value - lo) / (hi - lo)) * (bx - ax);
  for (const tick of vineTicks(chamber.problem, verb.level)) {
    const x = xAt(tick.value);
    solid(cv, { x0: x - 0.08, x1: x + 0.08, z0: z - 0.5, z1: z - 0.34, y1: tick.big ? 0.55 : 0.34 }, tick.big ? COLORS.gold : COLORS.paper);
    if (tick.label) label(cv, [x, 0.85, z - 0.42], tick.label, 0.48);
  }
  label(cv, [ax, 0.85, z - 0.42], String(lo), 0.55);
  label(cv, [bx, 0.85, z - 0.42], String(hi), 0.55);
  if (chamber.lastTag === 'correct') {
    for (let i = i0; i <= i1; i += 2) {
      const [x] = centerOf(board, i, j);
      flower(cv, x, z + 0.3, FLOWERS[i % FLOWERS.length]);
    }
  }
}

/**
 * A heap of coconuts on a basket or the stump: up to nine, in rows of three.
 * @param {Canvas} cv @param {number} x @param {number} y @param {number} z @param {number} count
 */
function coconuts(cv, x, y, z, count) {
  /** @type {Item[]} */
  const nuts = [];
  for (let n = 0; n < Math.min(count, 9); n++) {
    const c = project(cv.view, x - 0.2 + (n % 3) * 0.2, y + Math.floor(n / 3) * 0.12, z);
    nuts.push({ t: 'disc', x: c[0], y: c[1], r: 5 * cv.px, fill: COLORS.wood, stroke: cv.theme.ink, w: 1.4 * cv.px });
  }
  cv.groups.push({ d: depthOf(cv.view, x, y, z) - 0.1, items: nuts });
}

/**
 * The stump with its pile, the baskets with their coconuts (the ones in
 * play numbered, the resting ones dim), bouncing while a hint is shown.
 * @param {Canvas} cv @param {GroveState} state
 */
function baskets(cv, state) {
  const board = state.board;
  const chamber = state.chamber;
  const verb = chamber?.verb;
  const share = verb?.kind === 'share' ? verb : null;
  const bounce = chamber && chamber.pulseAt !== null && state.clock - chamber.pulseAt < 700
    ? Math.sin(((state.clock - chamber.pulseAt) / 700) * Math.PI) * 0.25 : 0;
  board.baskets.forEach(([i, j], k) => {
    const [x, z] = centerOf(board, i, j);
    const live = share?.baskets.findIndex((b) => b.i === i && b.j === j) ?? -1;
    const y0 = live >= 0 ? bounce : 0;
    solid(cv, around(x, z, 0.36, y0 + 0.45, y0), live >= 0 ? COLORS.wood : lerpColor(COLORS.wood, COLORS.gray, 0.6), COLORS.bark);
    if (live < 0 || !share) return;
    const count = share.baskets[live].count;
    coconuts(cv, x, y0 + 0.5, z, count);
    label(cv, [x, y0 + 1.1, z], String(count), 0.55);
    const c = project(cv.view, x, y0 + 0.3, z);
    cv.picks.push({ id: `basket:${k}`, x: c[0], y: c[1], r: 22 * cv.px });
  });
  if (share && board.stump) {
    const [x, z] = centerOf(board, board.stump[0], board.stump[1]);
    coconuts(cv, x, 0.6, z, share.pile);
    label(cv, [x, 1.2, z], String(share.pile), 0.6);
  }
}

/**
 * The player's monkey (posed, or as the ragdoll has it), hopping and
 * carrying, and Mimi with her flower; both named for the ragdoll.
 * @param {Canvas} cv @param {GroveState} state @param {DrawContext} ctx @returns {FigureRequest[]}
 */
function figures(cv, state, ctx) {
  const board = state.board;
  const m = state.monkey;
  const celebrating = (state.chamber?.celebrateUntil ?? 0) > 0 || state.mode === 'result' || state.mode === 'over';
  const pose = monkeyPose(m, celebrating, cv.time);
  const lift = m.jumpMs > 0 ? Math.sin(Math.PI * (1 - m.jumpMs / JUMP_MS)) * 0.55 : m.dunkMs > 0 ? (m.dunkMs / DUNK_MS) * 1.4 : 0;
  const player = state.players[state.duel ? state.duel.turn : 0];
  const body = ctx.bodies?.monkey;
  /** @type {[number, number, number]} */
  const at = [m.x, lift, m.z];
  const shape = body ? monkeyShape(body, { face: m.face }) : monkey(pose, { face: m.face });
  const mg = figureGroup(cv.view, at, shape, { color: player.color, theme: cv.theme, stature: MONKEY_STATURE, sway: SWAY });
  if (mg) {
    cv.groups.push(mg);
    cv.picks.push({ id: 'monkey', ...mg.pick });
    if (m.carry) stoneGroup(cv, { ...m.carry, x: m.x, z: m.z }, lift + MONKEY_STATURE + 0.05, -0.6);
  }
  const [mx, mz] = centerOf(board, board.mimi[0], board.mimi[1]);
  const talking = state.mimiAt !== null && state.clock - state.mimiAt < 1800;
  const mimiStance = mimiPose(talking, cv.time);
  const mimiBody = ctx.bodies?.mimi;
  const mimiSkeleton = mimiBody ?? skeleton(mimiStance);
  /** @type {[number, number, number]} */
  const mimiAt = [mx, 0, mz];
  const mimiShape = mimiBody ? monkeyShape(mimiBody, { face: -1 }) : monkey(mimiStance, { face: -1 });
  const fg = figureGroup(cv.view, mimiAt, mimiShape, { color: COLORS.mimi, theme: cv.theme, stature: MIMI_STATURE, sway: SWAY });
  if (fg) {
    const [u, v] = flowerSpot(mimiSkeleton);
    const [fx, fy, unit] = figurePoint(cv.view, mimiAt, MIMI_STATURE, [-u, v]);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      fg.items.push({ t: 'disc', x: fx + Math.cos(a) * unit * 0.1, y: fy + Math.sin(a) * unit * 0.1, r: unit * 0.075, fill: COLORS.gold, stroke: cv.theme.ink, w: unit * 0.025 });
    }
    fg.items.push({ t: 'disc', x: fx, y: fy, r: unit * 0.055, fill: COLORS.red, stroke: cv.theme.ink, w: unit * 0.02 });
    cv.groups.push(fg);
    cv.picks.push({ id: 'mimi', ...fg.pick });
  }
  return [{ id: 'monkey', pose }, { id: 'mimi', pose: mimiStance }];
}

/**
 * Draw a frame of the game.
 * @param {GroveState} state @param {DrawContext} ctx @returns {Drawn}
 */
export function drawGrove(state, ctx) {
  const { view, theme } = ctx;
  /** @type {Canvas} */
  const cv = { view, theme, light: ctx.light, px: ctx.px, time: ctx.reduce ? 0 : ctx.time, ground: [], decals: [], groups: [], picks: [] };
  const items = sea(view, theme, cv.time, cv.px);
  terrain(cv, state);
  if (state.chamber && state.mode !== 'hub') {
    modelPad(cv, state);
    stones(cv, state);
    soilBed(cv, state);
    vine(cv, state);
  }
  baskets(cv, state);
  const requested = figures(cv, state, ctx);
  items.push(...flatten(cv.ground), ...cv.decals, ...flatten(cv.groups));
  return { items, figures: requested, picks: cv.picks };
}
