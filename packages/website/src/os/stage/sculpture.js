//@ts-check
/**
 * Code as art: any JSON document as a crowd of figures, laid out in 3D
 * and animated by what is executing.
 *
 * The sculptor is a JSLT stylesheet (`sculpt.jslt.json`) that matches
 * JSON by SHAPE — its rules are schema matches, so the same six rules
 * sculpt a contract, a workflow, a stylesheet or the sculptor itself:
 * an object becomes a figure holding its members up, an array a chain of
 * figures holding hands, a string a figure with something to say, a
 * number a burst of rays, a boolean a heart, `null` a ghost. Each node
 * keeps the normalized path (`$path`) of the value it stands for, which
 * is how a running machine finds the figure to make dance: the OS hands
 * the widget the paths that just executed — the transitions the heads
 * fired, the workflow state the council is in — and those figures jump.
 *
 * The layout is radial: the document's root stands in the middle, each
 * generation in a wider ring, every subtree in an angular wedge sized by
 * what it holds; the camera turns slowly around it, like a sculpture in
 * a square.
 */

import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import sculptDoc from '../documents/sculpt.jslt.json' with { type: 'json' };
import { viewOf, project, depthOf } from './camera.js';
import { POSES, mixPose, person, heartOutline, motionMarks } from './figures.js';
import { STAGE_THEMES, cutout } from './scene.js';
import { createSurface, bindCamera } from './surface.js';

/** At most this many figures stand in one sculpture, at most this many
 * generations deep; the rest are counted, not drawn. */
export const SCULPTURE_MAX = 72;
export const SCULPTURE_DEPTH = 3;

/** Ring spacing on the floor, world units. */
const RING = 3.1;

/** The sculptor, compiled once with the validator as its type-test hook. */
const sculptor = compileJsltStylesheet(sculptDoc, { compileTypeTest: createTypeTestCompiler() });

/**
 * @typedef {{ kind: string, at: string, size?: number, text?: string, value?: any, children?: SculptNode[] }} SculptNode
 * @typedef {{ id: number, kind: string, at: string, depth: number, x: number, z: number, parent: number,
 *   text: string, value: any, hidden: number, label: string }} Placed
 */

/** Sculpt a document into its figure tree.
 * @param {any} doc @returns {SculptNode} */
export function sculpt(doc) {
  return /** @type {SculptNode} */ (sculptor(doc));
}

/**
 * Place a figure tree on the floor: breadth-first up to `max` figures,
 * each subtree in a wedge proportional to the figures it shows.
 * @param {SculptNode} root
 * @param {number} [max]
 * @returns {{ nodes: Placed[], hidden: number, radius: number }}
 */
export function layoutSculpture(root, max = SCULPTURE_MAX) {
  /** @type {Array<{ node: SculptNode, depth: number, parent: number, id: number, kids: number[] }>} */
  const order = [];
  const queue = [{ node: root, depth: 0, parent: -1 }];
  let hidden = 0;
  while (queue.length > 0) {
    const next = /** @type {{ node: SculptNode, depth: number, parent: number }} */ (queue.shift());
    if (order.length >= max || next.depth > SCULPTURE_DEPTH) { hidden++; continue; }
    const id = order.length;
    order.push({ ...next, id, kids: [] });
    if (next.parent >= 0) order[next.parent].kids.push(id);
    for (const child of next.node.children ?? []) queue.push({ node: child, depth: next.depth + 1, parent: id });
  }
  // the figures each subtree shows, for wedge widths
  const weight = new Array(order.length).fill(1);
  for (let i = order.length - 1; i >= 0; i--) for (const k of order[i].kids) weight[i] += weight[k];
  /** @type {Placed[]} */
  const nodes = order.map((o) => ({
    id: o.id, kind: o.node.kind, at: o.node.at ?? '$', depth: o.depth, parent: o.parent, x: 0, z: 0,
    text: typeof o.node.text === 'string' ? o.node.text : '',
    value: o.node.value ?? null,
    hidden: Math.max(0, (o.node.children?.length ?? 0) - o.kids.length),
    label: labelOf(o.node.at ?? '$'),
  }));
  /** @param {number} id @param {number} a0 @param {number} a1 */
  const place = (id, a0, a1) => {
    const o = order[id];
    const mid = (a0 + a1) / 2;
    nodes[id].x = Math.cos(mid) * o.depth * RING;
    nodes[id].z = Math.sin(mid) * o.depth * RING;
    let at = a0;
    const total = o.kids.reduce((s, k) => s + weight[k], 0);
    for (const k of o.kids) {
      const span = ((a1 - a0) * weight[k]) / Math.max(1, total);
      place(k, at, at + span);
      at += span;
    }
  };
  if (nodes.length > 0) place(0, 0, Math.PI * 2);
  const depth = Math.max(0, ...nodes.map((n) => n.depth));
  return { nodes, hidden, radius: Math.max(RING, depth * RING) };
}

/** The last member name or index of a normalized path, for a figure's label.
 * @param {string} at */
export function labelOf(at) {
  const m = /\[(?:'((?:[^'\\]|\\.)*)'|(\d+))\]$/.exec(at);
  if (!m) return '$';
  return m[1] !== undefined ? m[1] : `#${m[2]}`;
}

/** Colours by generation: the bright inks in the palette's order. */
const GENERATIONS = Object.freeze(['#2563eb', '#fbbf24', '#ef4444', '#16a34a', '#06b6d4', '#f97316']);

/**
 * Compose one sculpture frame.
 * @param {ReturnType<typeof layoutSculpture>} layout
 * @param {import('./camera.js').View} view
 * @param {{ time: number, moving: boolean, active: ReadonlySet<string> }} motion
 * @param {'light' | 'dark'} themeName
 */
export function composeSculpture(layout, view, motion, themeName) {
  const theme = STAGE_THEMES[themeName] ?? STAGE_THEMES.light;
  const t = motion.moving ? motion.time : 0;
  const px = Math.max(0.6, Math.min(view.width, view.height) / 720);
  /** @type {import('./scene.js').Item[]} */
  const items = [];
  // the square the sculpture stands in
  const r = layout.radius + RING * 0.8;
  items.push({ t: 'poly', p: [[-r, -r], [r, -r], [r, r], [-r, r]].flatMap(([x, z]) => project(view, x, 0, z).slice(0, 2)), fill: theme.floor, stroke: theme.ink, w: 4 * px });
  /** @type {Array<{ d: number, items: import('./scene.js').Item[] }>} */
  const groups = [];
  // who holds whom: a line on the floor from each figure to its parent
  for (const node of layout.nodes) {
    if (node.parent < 0) continue;
    const parent = layout.nodes[node.parent];
    const a = project(view, parent.x, 0.02, parent.z);
    const b = project(view, node.x, 0.02, node.z);
    const lit = motion.active.has(node.at);
    groups.push({ d: depthOf(view, (parent.x + node.x) / 2, 0, (parent.z + node.z) / 2) + 1.5, items: [
      { t: 'line', p: [a[0], a[1], b[0], b[1]], stroke: theme.ink, w: (lit ? 4.5 : 2.4) * px },
    ] });
  }
  for (const node of layout.nodes) {
    const lit = motion.active.has(node.at);
    const height = node.depth === 0 ? 2.6 : Math.max(1.3, 2.2 - node.depth * 0.25);
    const anchor = project(view, node.x, 0, node.z);
    if (anchor[2] <= 0) continue;
    const up = project(view, node.x, height, node.z);
    const unit = Math.abs(anchor[1] - up[1]);
    const color = GENERATIONS[node.depth % GENERATIONS.length];
    const phase = (node.id * 0.618) % 1;
    const beat = lit ? (Math.sin(t / 140 + phase * 6.28) + 1) / 2 : (Math.sin(t / 420 + phase * 6.28) + 1) / 2 * 0.35;
    const hop = lit && motion.moving ? Math.abs(Math.sin(t / 160 + phase * 6.28)) * 0.35 * unit : 0;
    const sway = motion.moving ? Math.sin(t / 1300 + phase * 6.28) * 0.35 : 0.3;
    /** @type {import('./scene.js').Item[]} */
    const out = [];
    const ax = anchor[0];
    const ay = anchor[1] - hop;
    if (lit) out.push({ t: 'disc', x: ax, y: ay - unit * 1.1, r: unit * 1.3, fill: theme.glow, stroke: null, w: 0, a: 0.9 });
    if (node.kind === 'rays') {
      const c = ay - unit * 0.9;
      out.push({ t: 'disc', x: ax, y: c, r: unit * 0.32, fill: color, stroke: theme.ink, w: unit * 0.09 });
      const n = Math.min(12, 4 + Math.round(Math.log2(Math.abs(Number(node.value)) + 1)));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + t / 900;
        out.push({ t: 'line', p: [ax + Math.cos(a) * unit * 0.48, c + Math.sin(a) * unit * 0.48, ax + Math.cos(a) * unit * (0.78 + beat * 0.15), c + Math.sin(a) * unit * (0.78 + beat * 0.15)], stroke: theme.ink, w: unit * 0.09 });
      }
    }
    else if (node.kind === 'heart') {
      const heart = heartOutline(unit * 0.5);
      out.push({ t: 'poly', p: heart.flatMap(([u, v]) => [ax + u, ay - unit * 0.8 - v]), fill: node.value ? '#ef4444' : theme.paper, stroke: theme.ink, w: unit * 0.1 });
    }
    else {
      const base = node.kind === 'chain' ? POSES.jubilant : node.kind === 'speech' ? POSES.dance : node.kind === 'ghost' ? POSES.bow : POSES.lift;
      const shape = person(mixPose(base, POSES.jubilant, beat * 0.6), { bounce: beat * 0.08 });
      cutout(out, shape, { x: ax, y: ay, unit, sway }, node.kind === 'ghost' ? theme.paper : color, theme, node.kind === 'ghost' ? 0.55 : 1);
      if (node.kind === 'speech') {
        const wave = [];
        for (let k = 0; k <= 8; k++) wave.push(ax + unit * (0.35 + k * 0.12), ay - unit * (2.35 + Math.sin(k * 1.4 + t / 200) * 0.12));
        out.push({ t: 'line', p: wave, stroke: theme.ink, w: unit * 0.08 });
      }
      if (lit) {
        for (const [p1, p2] of motionMarks(shape.center, 1.1, 9, 0.08 * Math.sin(t / 120))) {
          out.push({ t: 'line', p: [ax + p1[0] * unit, ay - p1[1] * unit, ax + p2[0] * unit, ay - p2[1] * unit], stroke: theme.ink, w: unit * 0.08 });
        }
      }
    }
    groups.push({ d: depthOf(view, node.x, 0.8, node.z), items: out });
  }
  groups.sort((a, b) => b.d - a.d);
  for (const g of groups) for (const item of g.items) items.push(item);
  return items;
}

/** The sculpture's resting camera: farther out the bigger the crowd.
 * @param {number} radius */
const homeFor = (radius) => ({ azimuth: 0.5, elevation: 0.62, distance: Math.max(16, radius * 2.9), lift: 0.6, fov: 0.62 });

/**
 * @typedef {{ layout: ReturnType<typeof layoutSculpture>, active: string[], theme: 'light' | 'dark', reduce: boolean, label: string }} SculptureProps
 */

/** The sculpture widget. */
export const sculptureWidget = {
  /**
   * @param {HTMLElement} host @param {SculptureProps} props
   * @param {(binding: any, event?: any) => void} _emit @param {{ document?: Document }} [context]
   */
  mount(host, props, _emit, context) {
    const surface = createSurface(host, context?.document ?? host.ownerDocument);
    /** @type {any} */
    const handle = { host, surface, props, raf: 0, alive: true, camera: homeFor(props.layout.radius), active: new Set(props.active) };
    host.setAttribute('tabindex', '0');
    host.setAttribute('role', 'img');
    host.setAttribute('aria-label', props.label);
    handle.cleanups = bindCamera(host, surface, {
      get: () => handle.camera,
      set: (/** @type {any} */ c) => { handle.camera = c; },
      home: () => homeFor(handle.props.layout.radius),
      changed: () => { if (handle.props.reduce) paintSculpture(handle, surface.now()); },
      resized: () => paintSculpture(handle, surface.now()),
    });
    loopSculpture(handle);
    return handle;
  },
  /** @param {any} handle @param {SculptureProps} props @param {SculptureProps} prev */
  update(handle, props, prev) {
    handle.props = props;
    handle.active = new Set(props.active);
    if (props.layout !== prev?.layout) handle.camera = homeFor(props.layout.radius);
    if (props.label !== prev?.label) handle.host.setAttribute('aria-label', props.label);
    loopSculpture(handle);
  },
  /** @param {any} handle */
  unmount(handle) {
    handle.alive = false;
    if (handle.raf) handle.surface.win.cancelAnimationFrame?.(handle.raf);
    for (const off of handle.cleanups) off();
    handle.surface.destroy();
  },
};

/** @param {any} handle */
function loopSculpture(handle) {
  if (!handle.alive) return;
  const win = handle.surface.win;
  if (handle.props.reduce || typeof win.requestAnimationFrame !== 'function') {
    paintSculpture(handle, handle.surface.now());
    return;
  }
  if (handle.raf) return;
  const frame = (/** @type {number} */ t) => {
    handle.raf = 0;
    if (!handle.alive) return;
    handle.camera = { ...handle.camera, azimuth: handle.camera.azimuth + 0.0025 };
    paintSculpture(handle, t);
    if (!handle.props.reduce) handle.raf = win.requestAnimationFrame(frame);
  };
  handle.raf = win.requestAnimationFrame(frame);
}

/** @param {any} handle @param {number} t */
function paintSculpture(handle, t) {
  const { surface, props } = handle;
  const view = viewOf(handle.camera, surface.width, surface.height);
  const items = composeSculpture(props.layout, view, { time: t, moving: !props.reduce, active: handle.active }, props.theme);
  surface.paint(items, (STAGE_THEMES[props.theme] ?? STAGE_THEMES.light).paper, props.label);
}
