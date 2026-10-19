//@ts-check
/**
 * The stage composer: one scene document in, one frame's display list
 * out. The scene is plain JSON the OS view stylesheet produces from the
 * app state (the tape, the heads and who wears them, the council's
 * session); the display list is screen-space primitives in painter's
 * order, which two backends draw — a canvas for the running OS and SVG
 * vnodes for everything that must exist without a frame loop (`paint.js`).
 *
 * The world: the tape lies on the floor plane, one unit per cell,
 * centred on the origin; a written cell rises as an outlined block whose
 * height says which ink it holds, so the tape reads as a little city. The
 * heads dance on it. Figures are cut-outs standing toward the viewer: a
 * flat silhouette with a thin extruded edge, swaying so the edge shows —
 * drawn in screen space from one projected anchor, since a figure that
 * always faces the camera needs nothing more than its anchor's scale.
 *
 * Pure: time, interpolated positions and animation ages arrive in
 * `motion`, computed by the widget. A `motion` with `moving: false` is
 * the still frame — the reduced-motion frame, the SVG snapshot, the
 * server render — and draws every final state at once.
 */

import { lerpColor } from '@jarenjs/core/color';
import { project, depthOf } from './camera.js';
import { POSES, mixPose, person, baby, hand, heartOutline, motionMarks, signGlyph } from './figures.js';

/**
 * @typedef {import('./camera.js').View} View
 * @typedef {import('./figures.js').Shape} Shape
 * @typedef {{ t: 'poly', p: number[], fill: string | null, stroke: string | null, w: number, a?: number }
 *   | { t: 'line', p: number[], stroke: string, w: number, a?: number }
 *   | { t: 'disc', x: number, y: number, r: number, fill: string | null, stroke: string | null, w: number, a?: number }
 *   | { t: 'rect', x: number, y: number, wd: number, ht: number, r: number, fill: string | null, stroke: string | null, w: number, a?: number }
 *   | { t: 'arc', x: number, y: number, r: number, a0: number, a1: number, stroke: string, w: number, a?: number }} Item
 * @typedef {{ kind: 'head' | 'seat' | 'sign', id: string, x: number, y: number, r: number }} Pick
 * @typedef {{ id: string, x: number, y: number, dir: number, ink: number, merit: number, lead: boolean, pose: string, figure: string }} SceneHead
 * @typedef {{ id: string, ink: number, merit: number, lead: boolean, pose: string, figure: string }} SceneSeat
 * @typedef {{ phase: string, winner: any, deadline: number | null, window: number, proposals: any[] }} SceneSession
 * @typedef {{ seq: number, kind: string, by?: string, change?: any }} SceneEvent
 * @typedef {{ width: number, height: number, tape: number[], palette: string[], heads: SceneHead[], seats: SceneSeat[],
 *   session: SceneSession, events: SceneEvent[], tick: number, tempo: number, running: boolean,
 *   theme: 'light' | 'dark', focus: string | null }} Scene
 * @typedef {{ time: number, now: number, moving: boolean,
 *   heads: Record<string, { x: number, z: number, hop: number }>,
 *   heights: ArrayLike<number> | null,
 *   stamps: Array<{ cell: number, age: number }>,
 *   effects: Array<{ kind: string, age: number, by?: string, change?: any }> }} Motion
 */

/** Theme colours of the stage itself; the inks come from the scene's palette. */
export const STAGE_THEMES = Object.freeze({
  light: Object.freeze({ paper: '#fff7e6', floor: '#fffdf6', grid: '#eadfc6', ray: '#ffeec4', ink: '#11131c', shade: '#11131c', glow: '#fde68a' }),
  dark: Object.freeze({ paper: '#0c0f17', floor: '#171c2a', grid: '#283048', ray: '#131a29', ink: '#f4efe1', shade: '#000000', glow: '#3b2f0b' }),
});

/** The human's colour: an orange no tape symbol uses. */
export const HUMAN_INK = '#f97316';

/** The stamp red of a veto. */
const VETO_RED = '#dc2626';

/** Outline width around every figure primitive, in figure units. */
const OUTLINE = 0.075;

/** Height of a written block per symbol. */
export const blockHeight = (/** @type {number} */ symbol) => (symbol === 0 ? 0 : 0.16 + symbol * 0.17);

/** How long the veto and enactment animations last, ms. */
export const EFFECT_MS = Object.freeze({ veto: 1500, enact: 1300, repeal: 1100, rest: 900, boot: 1600 });

/** A world-space figure height multiplier from merit: stature is merit.
 * @param {number} merit */
const statureOf = (merit) => 3.4 + 0.5 * Math.max(-1.5, Math.min(3, merit - 1));

/**
 * The colour a member wears.
 * @param {Scene} scene @param {{ ink: number }} who
 */
export function inkOf(scene, who) {
  return who.ink < 0 ? HUMAN_INK : (scene.palette[who.ink] ?? HUMAN_INK);
}

/**
 * Compose one frame.
 * @param {Scene} scene
 * @param {View} view
 * @param {Motion} motion
 * @returns {{ items: Item[], picks: Pick[] }}
 */
export function composeFrame(scene, view, motion) {
  const theme = STAGE_THEMES[scene.theme] ?? STAGE_THEMES.light;
  /** @type {Item[]} */
  const items = [];
  /** @type {Pick[]} */
  const picks = [];
  const px = Math.max(0.6, Math.min(view.width, view.height) / 720);

  sky(items, view, motion, theme);
  floor(items, scene, view, theme, px);

  /** @type {Array<{ d: number, items: Item[] }>} */
  const groups = [];
  blocks(groups, scene, view, motion, theme, px);
  stamps(groups, scene, view, motion, theme, px);

  const t = motion.moving ? motion.time : 0;
  const phase = scene.session?.phase ?? 'idle';
  const proposers = new Set((scene.session?.proposals ?? []).map((p) => p.by));
  const signFor = new Map((scene.session?.proposals ?? []).map((p) => [p.by, p]));
  const hw = scene.width / 2;
  const hh = scene.height / 2;

  for (const head of scene.heads) {
    const at = motion.heads[head.id] ?? { x: head.x - hw + 0.5, z: head.y - hh + 0.5, hop: 0 };
    const cell = Math.round(at.z + hh - 0.5) * scene.width + Math.round(at.x + hw - 0.5);
    const ground = (motion.heights?.[cell] ?? blockHeight(scene.tape[cell] ?? 0));
    const holding = (phase === 'convening' || phase === 'veto') && proposers.has(head.id);
    figureGroup(groups, scene, view, {
      id: head.id, kind: 'head', x: at.x, y: ground + at.hop * 0.9, z: at.z,
      color: inkOf(scene, head), merit: head.merit, lead: head.lead,
      pose: holding ? 'hold' : head.pose, figure: head.figure, focused: scene.focus === head.id,
      sign: holding ? signFor.get(head.id) : null,
    }, t, motion, theme, picks);
  }

  // the seats beside the floor: the oracle on its plinth at the back,
  // the human crawling at the front edge, nearest the viewer
  for (const seat of scene.seats) {
    const human = seat.figure === 'baby';
    const x = 0;
    const z = human ? hh + 1.3 : -hh - 2.2;
    const plinth = human ? 0 : 1.1;
    if (!human) plinthGroup(groups, view, x, z, plinth, theme, px);
    const holding = !human && (phase === 'convening' || phase === 'veto') && proposers.has(seat.id);
    figureGroup(groups, scene, view, {
      id: seat.id, kind: 'seat', x, y: plinth, z, color: inkOf(scene, seat), merit: seat.merit,
      lead: seat.lead, pose: holding ? 'hold' : seat.pose, figure: seat.figure, focused: scene.focus === seat.id,
      sign: holding ? signFor.get(seat.id) : null,
      radiant: human, eager: human && phase === 'veto',
    }, t, motion, theme, picks);
  }

  groups.sort((a, b) => b.d - a.d);
  for (const g of groups) for (const item of g.items) items.push(item);

  verdict(items, scene, view, motion, theme, picks);
  return { items, picks };
}

/** The radiant sky behind the floor: alternating rays from a sun below
 * the horizon, turning slowly when anything moves.
 * @param {Item[]} items @param {View} view @param {Motion} motion @param {typeof STAGE_THEMES.light} theme */
function sky(items, view, motion, theme) {
  const cx = view.width / 2;
  const cy = view.height * 0.46;
  const reach = Math.hypot(view.width, view.height);
  const spin = motion.moving ? motion.time / 24000 : 0;
  const rays = 24;
  for (let i = 0; i < rays; i += 2) {
    const a0 = spin + (i / rays) * Math.PI * 2;
    const a1 = spin + ((i + 1) / rays) * Math.PI * 2;
    items.push({ t: 'poly', p: [cx, cy, cx + Math.cos(a0) * reach, cy + Math.sin(a0) * reach,
      cx + Math.cos(a1) * reach, cy + Math.sin(a1) * reach], fill: theme.ray, stroke: null, w: 0 });
  }
}

/** The floor slab and its grid.
 * @param {Item[]} items @param {Scene} scene @param {View} view @param {typeof STAGE_THEMES.light} theme @param {number} px */
function floor(items, scene, view, theme, px) {
  const hw = scene.width / 2;
  const hh = scene.height / 2;
  const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  const top = corners.flatMap(([x, z]) => project(view, x, 0, z).slice(0, 2));
  // the slab's visible front edges give the floor its thickness
  const edge = [];
  for (const [x, z] of corners) edge.push(project(view, x, -0.45, z));
  const sides = [[0, 1], [1, 2], [2, 3], [3, 0]];
  for (const [a, b] of sides) {
    const [ax, az] = corners[a];
    const [bx, bz] = corners[b];
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    // outward normal is the midpoint direction for this axis-aligned slab
    const facing = (mx !== 0 ? Math.sign(mx) * (view.eye[0] - mx) : 0) + (mz !== 0 ? Math.sign(mz) * (view.eye[2] - mz) : 0);
    if (facing <= 0) continue;
    const pa = project(view, ax, 0, az);
    const pb = project(view, bx, 0, bz);
    items.push({ t: 'poly', p: [pa[0], pa[1], pb[0], pb[1], edge[b][0], edge[b][1], edge[a][0], edge[a][1]],
      fill: lerpColor(theme.floor, theme.shade, 0.18), stroke: theme.ink, w: 4 * px });
  }
  items.push({ t: 'poly', p: top, fill: theme.floor, stroke: theme.ink, w: 5 * px });
  for (let i = 1; i < scene.width; i++) {
    const a = project(view, i - hw, 0, -hh);
    const b = project(view, i - hw, 0, hh);
    items.push({ t: 'line', p: [a[0], a[1], b[0], b[1]], stroke: theme.grid, w: 1.2 * px });
  }
  for (let j = 1; j < scene.height; j++) {
    const a = project(view, -hw, 0, j - hh);
    const b = project(view, hw, 0, j - hh);
    items.push({ t: 'line', p: [a[0], a[1], b[0], b[1]], stroke: theme.grid, w: 1.2 * px });
  }
}

/** The written cells as outlined blocks, each its own painter's group.
 * @param {Array<{ d: number, items: Item[] }>} groups @param {Scene} scene @param {View} view
 * @param {Motion} motion @param {typeof STAGE_THEMES.light} theme @param {number} px */
function blocks(groups, scene, view, motion, theme, px) {
  const hw = scene.width / 2;
  const hh = scene.height / 2;
  const [ex, , ez] = view.eye;
  const inset = 0.07;
  for (let j = 0; j < scene.height; j++) {
    for (let i = 0; i < scene.width; i++) {
      const cell = j * scene.width + i;
      const symbol = scene.tape[cell];
      const h = motion.heights?.[cell] ?? blockHeight(symbol);
      if (symbol === 0 && h < 0.02) continue;
      const color = scene.palette[symbol] ?? theme.floor;
      const x0 = i - hw + inset;
      const x1 = i - hw + 1 - inset;
      const z0 = j - hh + inset;
      const z1 = j - hh + 1 - inset;
      const top = Math.max(0.02, h);
      /** @type {Item[]} */
      const out = [];
      const quad = (/** @type {number[][]} */ pts, /** @type {string} */ fill) => {
        out.push({ t: 'poly', p: pts.flatMap(([x, y, z]) => project(view, x, y, z).slice(0, 2)), fill, stroke: theme.ink, w: 2.6 * px });
      };
      if (ez > z1) quad([[x0, 0, z1], [x1, 0, z1], [x1, top, z1], [x0, top, z1]], lerpColor(color, theme.shade, 0.16));
      else if (ez < z0) quad([[x1, 0, z0], [x0, 0, z0], [x0, top, z0], [x1, top, z0]], lerpColor(color, theme.shade, 0.16));
      if (ex > x1) quad([[x1, 0, z1], [x1, 0, z0], [x1, top, z0], [x1, top, z1]], lerpColor(color, theme.shade, 0.32));
      else if (ex < x0) quad([[x0, 0, z0], [x0, 0, z1], [x0, top, z1], [x0, top, z0]], lerpColor(color, theme.shade, 0.32));
      quad([[x0, top, z0], [x1, top, z0], [x1, top, z1], [x0, top, z1]], symbol === 0 ? theme.floor : color);
      groups.push({ d: depthOf(view, (x0 + x1) / 2, top / 2, (z0 + z1) / 2), items: out });
    }
  }
}

/** Radiant marks around the newest stamps on the tape.
 * @param {Array<{ d: number, items: Item[] }>} groups @param {Scene} scene @param {View} view
 * @param {Motion} motion @param {typeof STAGE_THEMES.light} theme @param {number} px */
function stamps(groups, scene, view, motion, theme, px) {
  if (!motion.moving) return;
  const hw = scene.width / 2;
  const hh = scene.height / 2;
  for (const { cell, age } of motion.stamps) {
    const k = age / 420;
    if (k < 0 || k > 1) continue;
    const i = cell % scene.width;
    const j = Math.floor(cell / scene.width);
    const cx = i - hw + 0.5;
    const cz = j - hh + 0.5;
    const y = (motion.heights?.[cell] ?? blockHeight(scene.tape[cell])) + 0.05;
    /** @type {Item[]} */
    const out = [];
    for (let m = 0; m < 4; m++) {
      const a = m * Math.PI / 2 + Math.PI / 4;
      const r1 = 0.45 + k * 0.35;
      const r2 = r1 + 0.28;
      const p1 = project(view, cx + Math.cos(a) * r1, y, cz + Math.sin(a) * r1);
      const p2 = project(view, cx + Math.cos(a) * r2, y, cz + Math.sin(a) * r2);
      out.push({ t: 'line', p: [p1[0], p1[1], p2[0], p2[1]], stroke: theme.ink, w: 2.4 * px, a: 1 - k });
    }
    groups.push({ d: depthOf(view, cx, y, cz) - 0.2, items: out });
  }
}

/** The oracle's plinth: a pale outlined block.
 * @param {Array<{ d: number, items: Item[] }>} groups @param {View} view @param {number} x @param {number} z
 * @param {number} h @param {typeof STAGE_THEMES.light} theme @param {number} px */
function plinthGroup(groups, view, x, z, h, theme, px) {
  const s = 0.9;
  /** @type {Item[]} */
  const out = [];
  const quad = (/** @type {number[][]} */ pts, /** @type {string} */ fill) => {
    out.push({ t: 'poly', p: pts.flatMap(([a, b, c]) => project(view, a, b, c).slice(0, 2)), fill, stroke: theme.ink, w: 3 * px });
  };
  const [ex, , ez] = view.eye;
  if (ez > z + s) quad([[x - s, 0, z + s], [x + s, 0, z + s], [x + s, h, z + s], [x - s, h, z + s]], lerpColor(theme.floor, theme.shade, 0.12));
  else quad([[x + s, 0, z - s], [x - s, 0, z - s], [x - s, h, z - s], [x + s, h, z - s]], lerpColor(theme.floor, theme.shade, 0.12));
  if (ex > x + s) quad([[x + s, 0, z + s], [x + s, 0, z - s], [x + s, h, z - s], [x + s, h, z + s]], lerpColor(theme.floor, theme.shade, 0.24));
  else quad([[x - s, 0, z - s], [x - s, 0, z + s], [x - s, h, z + s], [x - s, h, z - s]], lerpColor(theme.floor, theme.shade, 0.24));
  quad([[x - s, h, z - s], [x + s, h, z - s], [x + s, h, z + s], [x - s, h, z + s]], theme.floor);
  groups.push({ d: depthOf(view, x, h / 2, z) + 0.4, items: out });
}

/**
 * A figure as one painter's group: extruded edge, outline, fill, the
 * television's screen, motion marks, and the sign it may hold.
 * @param {Array<{ d: number, items: Item[] }>} groups
 * @param {Scene} scene
 * @param {View} view
 * @param {{ id: string, kind: 'head' | 'seat', x: number, y: number, z: number, color: string, merit: number, lead: boolean,
 *   pose: string, figure: string, focused: boolean, sign: any, radiant?: boolean, eager?: boolean }} who
 * @param {number} t - animation time, 0 when still
 * @param {Motion} motion
 * @param {typeof STAGE_THEMES.light} theme
 * @param {Pick[]} picks
 */
function figureGroup(groups, scene, view, who, t, motion, theme, picks) {
  const stature = statureOf(who.merit) * (who.figure === 'baby' ? 0.75 : 1) / 2.1;
  const anchor = project(view, who.x, who.y, who.z);
  if (anchor[2] <= 0) return;
  const up = project(view, who.x, who.y + stature, who.z);
  const unit = Math.abs(anchor[1] - up[1]);
  const seed = hashUnit(who.id);
  const beat = (Math.sin(t / 260 + seed * 6.28) + 1) / 2;
  const sway = t === 0 ? 0.32 : Math.sin(t / 1100 + seed * 6.28) * 0.42;
  const squash = Math.max(0.35, Math.cos(sway));
  const vetoing = motion.effects.some((e) => e.kind === 'veto' && e.age < EFFECT_MS.veto);

  /** @type {Shape} */
  let shape;
  if (who.figure === 'baby') {
    shape = baby(t === 0 ? 0 : t / 160);
  }
  else {
    const base = POSES[who.pose] ?? POSES.dance;
    // a dancer moves between its own pose and the jubilant one; a veto
    // makes every proposer of the refused amendment bow
    const refused = vetoing && motion.effects.some((e) => e.kind === 'veto' && e.by === who.id);
    const pose = refused ? POSES.bow : mixPose(base, POSES.jubilant, t === 0 ? 0 : beat * 0.55);
    shape = person(pose, { bounce: t === 0 ? 0 : beat * 0.1, head: who.figure === 'tv' ? 'tv' : 'round' });
  }

  /** @type {Item[]} */
  const out = [];
  const sx = (/** @type {number} */ u) => anchor[0] + u * unit * squash;
  const sy = (/** @type {number} */ v) => anchor[1] - v * unit;

  // a glow disc under the focused member, and under the human while its veto is awaited
  if (who.focused || who.eager) {
    const pulse = t === 0 ? 0 : (Math.sin(t / 180) + 1) * 0.08;
    out.push({ t: 'disc', x: anchor[0], y: sy(shape.center[1]), r: unit * (1.25 + pulse), fill: theme.glow, stroke: null, w: 0, a: 0.85 });
  }

  cutout(out, shape, { x: anchor[0], y: anchor[1], unit, sway }, who.color, theme);
  if (shape.screen) {
    const s = shape.screen;
    // the oracle talks while the council convenes: a squiggle on its screen
    if (scene.session?.phase === 'convening' || who.sign) {
      const wave = [];
      for (let k = 0; k <= 6; k++) {
        const u = s.c[0] - s.w * 0.36 + (k / 6) * s.w * 0.72;
        const v = s.c[1] + Math.sin(k * 1.7 + t / 90) * s.h * 0.22;
        wave.push(sx(u), sy(v));
      }
      out.push({ t: 'line', p: wave, stroke: theme.ink, w: 0.05 * unit });
    }
  }

  // motion marks: everyone radiates while the machine runs; the merit
  // leader and the radiant baby radiate more
  if (scene.running || who.radiant || who.eager) {
    const count = who.radiant ? 13 : who.lead ? 11 : 7;
    const pulse = t === 0 ? 0 : 0.08 * Math.sin(t / 160 + seed * 6.28) + (who.eager ? 0.12 * Math.sin(t / 90) : 0);
    const radius = who.figure === 'baby' ? 0.95 : 1.12;
    for (const [p1, p2] of motionMarks(shape.center, radius, count, pulse)) {
      out.push({ t: 'line', p: [sx(p1[0]), sy(p1[1]), sx(p2[0]), sy(p2[1])], stroke: theme.ink, w: 0.075 * unit });
    }
  }

  if (who.sign) signItems(out, scene, sx(0), sy(shape.top + 0.62), unit * 0.95, who.sign.change, theme, 1);

  groups.push({ d: depthOf(view, who.x, who.y + 0.9, who.z) - 0.35, items: out });
  picks.push({ kind: who.kind, id: who.id, x: anchor[0], y: sy(shape.center[1]), r: Math.max(18, unit * 1.2) });
}

/**
 * Draw a shape as a cut-out standing toward the viewer: a thin extruded
 * edge in ink (offset by the sway, so a turning figure shows its
 * thickness), the outline pass, the fill pass, and a television's
 * screen. `frame` places the figure frame on screen: its anchor in
 * pixels, pixels per figure unit and the sway angle.
 * @param {Item[]} out
 * @param {Shape} shape
 * @param {{ x: number, y: number, unit: number, sway: number }} frame
 * @param {string} color
 * @param {{ ink: string, paper: string }} theme
 * @param {number} [alpha]
 */
export function cutout(out, shape, frame, color, theme, alpha = 1) {
  const { unit, sway } = frame;
  const squash = Math.max(0.35, Math.cos(sway));
  const sx = (/** @type {number} */ u) => frame.x + u * unit * squash;
  const sy = (/** @type {number} */ v) => frame.y - v * unit;
  const a = alpha < 1 ? alpha : undefined;
  const pass = (/** @type {number} */ dx, /** @type {string} */ ink, /** @type {number} */ grow) => {
    for (const st of shape.strokes) {
      out.push({ t: 'line', p: st.pts.flatMap(([u, v]) => [sx(u) + dx, sy(v)]), stroke: ink, w: (st.w + grow * 2) * unit, a });
    }
    for (const d of shape.dots) {
      out.push({ t: 'disc', x: sx(d.c[0]) + dx, y: sy(d.c[1]), r: (d.r + grow) * unit, fill: ink, stroke: null, w: 0, a });
    }
    for (const b of shape.boxes) {
      out.push({ t: 'rect', x: sx(b.c[0]) + dx - ((b.w / 2 + grow) * unit * squash), y: sy(b.c[1]) - (b.h / 2 + grow) * unit,
        wd: (b.w + grow * 2) * unit * squash, ht: (b.h + grow * 2) * unit, r: b.r * unit, fill: ink, stroke: null, w: 0, a });
    }
  };
  const depth = 0.034 * unit * Math.abs(Math.sin(sway)) * (Math.sin(sway) >= 0 ? 1 : -1);
  for (let k = 3; k >= 1; k--) pass(-depth * k, theme.ink, OUTLINE);
  pass(0, theme.ink, OUTLINE);
  pass(0, color, 0);
  if (shape.screen) {
    const s = shape.screen;
    out.push({ t: 'rect', x: sx(s.c[0]) - s.w / 2 * unit * squash, y: sy(s.c[1]) - s.h / 2 * unit,
      wd: s.w * unit * squash, ht: s.h * unit, r: s.r * unit, fill: theme.paper, stroke: theme.ink, w: 0.045 * unit, a });
  }
}

/**
 * A proposal sign: a paper board with the amendment's glyph.
 * @param {Item[]} out @param {Scene} scene @param {number} x @param {number} y @param {number} size
 * @param {any} change @param {typeof STAGE_THEMES.light} theme @param {number} alpha
 */
function signItems(out, scene, x, y, size, change, theme, alpha) {
  const half = size / 2;
  out.push({ t: 'rect', x: x - half, y: y - half, wd: size, ht: size, r: size * 0.12, fill: theme.paper, stroke: theme.ink, w: size * 0.08, a: alpha });
  const glyph = signGlyph(change);
  if (glyph.swatch !== null) {
    const s = size * 0.5;
    out.push({ t: 'rect', x: x - s / 2, y: y - s / 2, wd: s, ht: s, r: s * 0.12,
      fill: scene.palette[glyph.swatch] ?? theme.floor, stroke: theme.ink, w: size * 0.06, a: alpha });
    return;
  }
  for (const st of glyph.strokes) {
    out.push({ t: 'line', p: st.pts.flatMap(([u, v]) => [x + u * half * 0.8, y - v * half * 0.8]), stroke: theme.ink, w: st.w * half, a: alpha });
  }
}

/**
 * The verdict layer, drawn over the stage: the winning amendment's big
 * sign while the veto is awaited (with the countdown ring the human is
 * racing), the hand that comes down when the veto is used, the hearts
 * that fly when an amendment is enacted.
 * @param {Item[]} items @param {Scene} scene @param {View} view @param {Motion} motion
 * @param {typeof STAGE_THEMES.light} theme @param {Pick[]} picks
 */
function verdict(items, scene, view, motion, theme, picks) {
  const session = scene.session;
  const anchor = project(view, 0, 6.2, 0);
  const above = project(view, 0, 7.2, 0);
  const unit = Math.abs(anchor[1] - above[1]);
  const size = unit * 2.6;
  const veto = motion.effects.find((e) => e.kind === 'veto');
  const enact = motion.effects.find((e) => e.kind === 'enact' || e.kind === 'repeal');
  const winner = session?.winner;

  if (session?.phase === 'veto' && winner && !veto) {
    const bob = motion.moving ? Math.sin(motion.time / 300) * unit * 0.12 : 0;
    signItems(items, scene, anchor[0], anchor[1] + bob, size, winner.change, theme, 1);
    if (session.deadline !== null && session.window > 0) {
      const left = Math.max(0, Math.min(1, (session.deadline - motion.now) / session.window));
      items.push({ t: 'arc', x: anchor[0], y: anchor[1] + bob, r: size * 0.78, a0: -Math.PI / 2,
        a1: -Math.PI / 2 + left * Math.PI * 2, stroke: theme.ink, w: unit * 0.18 });
    }
    picks.push({ kind: 'sign', id: winner.id, x: anchor[0], y: anchor[1], r: size * 0.8 });
  }

  // the refused amendment: the event carries it, because by the time the
  // hand comes down the session that proposed it has already closed
  const refused = veto?.change ?? winner?.change;
  if (veto && refused) {
    const k = veto.age / EFFECT_MS.veto;
    if (k <= 1) {
      const impact = 0.3;
      const fall = Math.max(0, (k - impact) / (1 - impact));
      if (motion.moving) {
        signItems(items, scene, anchor[0] + fall * unit * 1.2, anchor[1] + fall * fall * unit * 6, size * (1 - fall * 0.4),
          refused, theme, 1 - fall);
      }
      // the X, stamped red
      const s = size * 0.5 * (motion.moving ? Math.min(1, k / impact) : 1);
      const xa = 1 - (motion.moving ? fall : 0);
      for (const [a, b] of [[[-1, -1], [1, 1]], [[1, -1], [-1, 1]]]) {
        items.push({ t: 'line', p: [anchor[0] + a[0] * s, anchor[1] + a[1] * s, anchor[0] + b[0] * s, anchor[1] + b[1] * s],
          stroke: theme.ink, w: unit * 0.62, a: xa });
        items.push({ t: 'line', p: [anchor[0] + a[0] * s, anchor[1] + a[1] * s, anchor[0] + b[0] * s, anchor[1] + b[1] * s],
          stroke: VETO_RED, w: unit * 0.42, a: xa });
      }
      // the hand descends, presses, lifts
      const reach = motion.moving ? (k < impact ? 1 - k / impact : (k - impact) * 0.8) : 0;
      const handShape = hand();
      const hu = unit * 1.9;
      const hx = anchor[0];
      const hy = anchor[1] + size * 0.15 - reach * unit * 7;
      const ha = motion.moving ? 1 - Math.max(0, (k - 0.75) / 0.25) : 1;
      for (const [color, grow] of [[theme.ink, OUTLINE], [HUMAN_INK, 0]]) {
        for (const st of handShape.strokes) {
          items.push({ t: 'line', p: st.pts.flatMap(([u, v]) => [hx + u * hu, hy - v * hu]),
            stroke: /** @type {string} */ (color), w: (st.w + /** @type {number} */ (grow) * 2) * hu, a: ha });
        }
      }
      // the shock of the stamp
      if (motion.moving && k > impact) {
        const r1 = size * (0.7 + fall * 0.9);
        for (let m = 0; m < 12; m++) {
          const a = (m / 12) * Math.PI * 2;
          items.push({ t: 'line', p: [anchor[0] + Math.cos(a) * r1, anchor[1] + Math.sin(a) * r1,
            anchor[0] + Math.cos(a) * (r1 + unit * 0.7), anchor[1] + Math.sin(a) * (r1 + unit * 0.7)],
          stroke: theme.ink, w: unit * 0.14, a: 1 - fall });
        }
      }
    }
  }

  if (enact && motion.moving) {
    const k = enact.age / EFFECT_MS.enact;
    if (k <= 1) {
      const color = enact.kind === 'repeal' ? HUMAN_INK : (scene.palette[2] ?? HUMAN_INK);
      const heart = heartOutline(unit * 0.55);
      for (let m = 0; m < 8; m++) {
        const a = (m / 8) * Math.PI * 2 + 0.3;
        const r = size * (0.2 + k * 1.6);
        const cx = anchor[0] + Math.cos(a) * r;
        const cy = anchor[1] + Math.sin(a) * r * 0.7 - k * unit * 1.5;
        const p = heart.flatMap(([u, v]) => [cx + u, cy - v]);
        items.push({ t: 'poly', p, fill: color, stroke: theme.ink, w: unit * 0.1, a: 1 - k });
      }
    }
  }
}

/** A stable [0, 1) number per id, so each figure keeps its own rhythm.
 * @param {string} id */
function hashUnit(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}
