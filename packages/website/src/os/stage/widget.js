//@ts-check
/**
 * The stage widget: the one imperative island of the OS chrome,
 * registered with `@jarenjs/app` under the name `stage` (VIEW-FORMAT §7).
 * The view stylesheet hands it the scene document as props; the widget
 * owns its host's subtree (`surface.js`), its frame loop and its camera.
 *
 * The app never dispatches per frame. A state change arrives as one
 * `update` with a new scene; the widget turns the difference into
 * animation state (a head hopping to its next cell, a block rising, the
 * veto hand coming down) and its own `requestAnimationFrame` loop draws
 * the in-between frames. The only thing it sends back is a pick — the
 * figure, sign or cell the viewer tapped — through the binding its props
 * carry (`onPick`), composed with what was picked.
 *
 * Reduced motion (`props.reduce`) draws the final state of every change
 * at once and runs no loop: the camera still answers the viewer's hand,
 * because a frame drawn on request is not an animation.
 */

import { HOME_CAMERA, viewOf, project } from './camera.js';
import { composeFrame, blockHeight, EFFECT_MS, STAGE_THEMES, performers, poseFor } from './scene.js';
import { toSvg } from './paint.js';
import { createSurface, bindCamera } from './surface.js';
import { createDirector } from '../engine/director.js';
import { createFx, emit as burst, stepFx, fxGroups, overlayItems, flash } from '../engine/fx.js';
import { createRagdoll, stepRagdoll, kickRagdoll, ragdollSkeleton } from '../engine/ragdoll.js';
import { createLighting } from '../engine/light.js';

/**
 * @typedef {import('./scene.js').Scene} Scene
 * @typedef {import('./scene.js').Motion} Motion
 * @typedef {import('./camera.js').Camera} Camera
 * @typedef {{ scene: Scene, reduce?: boolean, label?: string, onPick?: any, tempo?: number,
 *   light?: { hour: number, bands: number, shadows: boolean } | null, orbit?: boolean, ragdoll?: boolean,
 *   shot?: { name: string | null, seq: number }, burst?: { fx: string | null, seq: number },
 *   cheer?: { who: string | null, seq: number } }} StageProps
 *   - `light`: the lighting rig's settings; `orbit`: drift while idle; `ragdoll`: lively figures;
 *     `shot` and `burst`: a camera shot or a burst of effects to play, each new `seq` once;
 *     `cheer`: a crew member who just built a block hops for joy, once per new `seq`
 */

/** How long a head takes to hop one cell, at most (it is also bounded by the tick). */
const HOP_MS = 220;
/** How long a block takes to rise to a new height. */
const RISE_MS = 340;
/** After the viewer lets go, the camera waits this long before the director takes it again. */
const IDLE_MS = 9000;
/** How fast the idle camera drifts round the set, radians a second. */
const DRIFT = 0.24;

/** easeOutBack: arrives with a little overshoot, the way a stamp lands. */
const settle = (/** @type {number} */ k) => {
  const c = 1.70158;
  const x = k - 1;
  return 1 + (c + 1) * x * x * x + c * x * x;
};

/**
 * The still frame of a scene as an SVG vnode — the widget's `ssr`, the
 * artwork export and the frame a host without a canvas draws.
 * @param {Scene} scene
 * @param {{ width?: number, height?: number, camera?: Camera, title?: string }} [options]
 */
export function stillFrame(scene, options = {}) {
  const width = options.width ?? 960;
  const height = options.height ?? 640;
  const view = viewOf(options.camera ?? HOME_CAMERA, width, height);
  const { items } = composeFrame(scene, view, stillMotion());
  const theme = STAGE_THEMES[scene.theme] ?? STAGE_THEMES.light;
  return toSvg(items, { width, height, background: theme.paper, title: options.title ?? 'Radiant OS stage' });
}

/** The motion of a frame in which nothing moves. @returns {Motion} */
function stillMotion() {
  return { time: 0, now: Date.now(), moving: false, heads: {}, heights: null, stamps: [], effects: [] };
}

/** The widget definition. */
export const stageWidget = {
  /**
   * @param {HTMLElement} host
   * @param {StageProps} props
   * @param {(binding: any, event?: any) => void} emit
   * @param {{ document?: Document }} [context]
   */
  mount(host, props, emit, context) {
    const surface = createSurface(host, context?.document ?? host.ownerDocument);
    /** @type {any} */
    const handle = {
      host, emit, surface, props,
      director: createDirector(HOME_CAMERA),
      fx: createFx(11),
      bodies: new Map(),
      light: props.light ? createLighting(props.light) : null,
      raf: 0, alive: true, lastInput: -Infinity, lastFrame: -1,
      picks: [], view: null,
      anim: createAnim(props.scene),
    };
    host.setAttribute('tabindex', '0');
    host.setAttribute('role', 'img');
    host.setAttribute('aria-label', props.label ?? 'Radiant OS stage');
    handle.cleanups = bindCamera(host, surface, {
      get: () => handle.director.camera,
      set: (/** @type {Camera} */ c) => { handle.director.cut(c); },
      home: () => ({ ...HOME_CAMERA }),
      changed: () => { handle.lastInput = surface.now(); if (handle.props.reduce) schedule(handle); },
      tap: (/** @type {PointerEvent} */ e) => pick(handle, e),
      resized: () => { if (handle.props.reduce) schedule(handle); },
    });
    schedule(handle);
    return handle;
  },

  /** @param {any} handle @param {StageProps} props @param {StageProps} prev */
  update(handle, props, prev) {
    handle.props = props;
    if (props.label !== prev?.label) handle.host.setAttribute('aria-label', props.label ?? 'Radiant OS stage');
    if (props.light !== prev?.light) handle.light = props.light ? createLighting(props.light) : null;
    if (props.shot && props.shot.seq !== prev?.shot?.seq && props.shot.name) handle.director.move(props.shot.name, { ms: 1200 });
    if (props.burst && props.burst.seq !== prev?.burst?.seq && props.burst.fx && !props.reduce) {
      burst(handle.fx, /** @type {any} */ (props.burst.fx), [0, 2, 0], { colors: props.scene.palette.slice(1), count: 60, power: 1.2 });
      burst(handle.fx, 'radiance', [0, 1, 0]);
    }
    const before = prev?.scene?.session?.phase;
    const now = handle.surface.now();
    absorb(handle.anim, props.scene, now, props.tempo ?? 12);
    if (props.cheer && props.cheer.seq !== prev?.cheer?.seq && props.cheer.who && !props.reduce) cheer(handle, props.cheer.who, now);
    // the director follows the council: close in for the verdict, back home after
    const phase = props.scene.session?.phase;
    if (phase !== before && now - handle.lastInput > IDLE_MS) {
      if (phase === 'veto') handle.director.move('verdict', { ms: 1400 });
      else if (before === 'veto' || before === 'enacting') handle.director.move('home', { ms: 1600 });
      else if (phase === 'convening') handle.director.move('crane', { ms: 1800 });
    }
    schedule(handle);
  },

  /** @param {any} handle */
  unmount(handle) {
    handle.alive = false;
    if (handle.raf) handle.surface.win.cancelAnimationFrame?.(handle.raf);
    for (const off of handle.cleanups) off();
    handle.surface.destroy();
  },

  /** @param {StageProps} props */
  ssr(props) {
    return stillFrame(props.scene, { title: props.label });
  },
};

/** Ask for a frame: the next one when animating, otherwise draw now.
 * @param {any} handle */
function schedule(handle) {
  if (!handle.alive) return;
  const win = handle.surface.win;
  if (handle.props.reduce || typeof win.requestAnimationFrame !== 'function') {
    draw(handle, handle.surface.now());
    return;
  }
  if (handle.raf) return;
  const loop = (/** @type {number} */ t) => {
    handle.raf = 0;
    if (!handle.alive) return;
    draw(handle, t);
    if (!handle.props.reduce) handle.raf = win.requestAnimationFrame(loop);
  };
  handle.raf = win.requestAnimationFrame(loop);
}

/**
 * Draw one frame at time `t`.
 * @param {any} handle @param {number} t
 */
function draw(handle, t) {
  const moving = !handle.props.reduce;
  // the director counts idle time in real milliseconds; motion steps at most a tenth of a second
  const elapsed = handle.lastFrame < 0 ? 16 : Math.max(0, t - handle.lastFrame);
  const dt = Math.min(100, elapsed);
  handle.lastFrame = t;
  const { surface } = handle;
  // the set drifts only once the viewer's hand has been off the camera a while
  handle.director.orbit(moving && handle.props.orbit !== false && t - handle.lastInput > IDLE_MS ? DRIFT : 0);
  const camera = moving ? handle.director.step(elapsed) : handle.director.camera;
  const view = viewOf(camera, surface.width, surface.height);
  const theme = STAGE_THEMES[handle.props.scene.theme] ?? STAGE_THEMES.light;
  const motion = motionAt(handle.anim, t, moving);
  motion.light = handle.light;
  if (moving) {
    react(handle);
    if (handle.props.ragdoll !== false) motion.bodies = liven(handle, t, motion, dt);
    stepFx(handle.fx, dt / 1000);
    motion.fx = fxGroups(handle.fx, view, theme);
  }
  const { items, picks } = composeFrame(handle.props.scene, view, motion);
  handle.picks = picks;
  handle.view = view;
  if (moving) items.push(...overlayItems(handle.fx, surface.width, surface.height));
  surface.paint(items, theme.paper, handle.props.label ?? 'Radiant OS stage');
}

/**
 * Turn what just happened into effects and knocks: a hop throws its
 * dancer up a little, an enactment rains confetti and hearts, a veto
 * shakes the set and tumbles the proposer it refused.
 * @param {any} handle
 */
function react(handle) {
  const anim = handle.anim;
  for (const id of anim.hopped.splice(0)) {
    const rag = handle.bodies.get(id);
    if (rag) kickRagdoll(rag, [0, 2.4]);
  }
  for (const e of anim.fresh.splice(0)) {
    const palette = handle.props.scene.palette.slice(1);
    if (e.kind === 'enact') {
      burst(handle.fx, 'confetti', [0, 3, 0], { colors: palette, count: 48 });
      burst(handle.fx, 'hearts', [0, 2, 0], { colors: ['#ef4444', '#f97316'] });
      handle.director.shake(0.012, 300);
    }
    else if (e.kind === 'veto') {
      burst(handle.fx, 'dust', [0, 0.5, 0], { colors: [handle.props.scene.theme === 'light' ? '#11131c' : '#f4efe1'], count: 14, power: 2 });
      flash(handle.fx, '#ef4444', 0.2);
      handle.director.shake(0.035, 420);
      const rag = e.by ? handle.bodies.get(e.by) : null;
      if (rag) kickRagdoll(rag, [7, 5]);
    }
    else if (e.kind === 'boot' || e.kind === 'repeal') burst(handle.fx, 'radiance', [0, 1.5, 0]);
  }
}

/**
 * A crew member's hop of joy for a block it built: a kick up where it
 * stands, sparks and a few notes in its own ink.
 * @param {any} handle @param {string} who @param {number} t
 */
function cheer(handle, who, t) {
  const head = handle.props.scene.heads.find((/** @type {{ id: string }} */ h) => h.id === who);
  if (!head) return;
  const at = positionAt(handle.anim.heads.get(who), t);
  /** @type {[number, number, number]} */
  const point = at ? [at.x, 2, at.z] : [0, 2, 0];
  const ink = handle.props.scene.palette[head.ink] ?? handle.props.scene.palette[1];
  const rag = handle.bodies.get(who);
  if (rag) kickRagdoll(rag, [0, 3.2]);
  burst(handle.fx, 'sparks', point, { colors: [ink], count: 26, power: 1.1 });
  burst(handle.fx, 'notes', point, { colors: [ink], count: 5 });
}

/**
 * Step every standing figure's ragdoll toward the pose it is dancing.
 * @param {any} handle @param {number} t @param {Motion} motion @param {number} dt
 * @returns {Record<string, import('./figures.js').Skeleton>}
 */
function liven(handle, t, motion, dt) {
  /** @type {Record<string, import('./figures.js').Skeleton>} */
  const out = {};
  const live = new Set();
  for (const who of performers(handle.props.scene)) {
    const { pose, bounce, head } = poseFor(who, t, motion);
    let rag = handle.bodies.get(who.id);
    if (!rag) {
      rag = createRagdoll(pose, { head });
      handle.bodies.set(who.id, rag);
    }
    stepRagdoll(rag, pose, dt / 1000, { bounce });
    out[who.id] = ragdollSkeleton(rag);
    live.add(who.id);
  }
  for (const id of [...handle.bodies.keys()]) if (!live.has(id)) handle.bodies.delete(id);
  return out;
}

/**
 * Animation state for a scene: where each head is coming from, how high
 * each block stands, which stamps and effects are still playing.
 * @param {Scene} scene
 */
export function createAnim(scene) {
  const cells = scene.width * scene.height;
  const heights = new Float64Array(cells);
  for (let i = 0; i < cells; i++) heights[i] = blockHeight(scene.tape[i] ?? 0);
  return {
    scene,
    heads: /** @type {Map<string, { fx: number, fz: number, tx: number, tz: number, start: number, dur: number }>} */ (new Map()),
    from: Float64Array.from(heights),
    to: Float64Array.from(heights),
    rise: new Float64Array(cells).fill(-Infinity),
    stamps: /** @type {Array<{ cell: number, start: number }>} */ ([]),
    effects: /** @type {Array<{ kind: string, start: number, by?: string, change?: any, seq: number }>} */ ([]),
    seen: Math.max(0, ...(scene.events ?? []).map((e) => e.seq)),
    // what the widget has not reacted to yet: heads that just hopped, events that just arrived
    hopped: /** @type {string[]} */ ([]),
    fresh: /** @type {Array<{ kind: string, by?: string }>} */ ([]),
  };
}

/**
 * Fold a new scene into the animation state.
 * @param {ReturnType<typeof createAnim>} anim
 * @param {Scene} scene
 * @param {number} t
 * @param {number} tempo
 */
export function absorb(anim, scene, t, tempo) {
  const previous = anim.scene;
  anim.scene = scene;
  if (previous.width !== scene.width || previous.height !== scene.height) {
    Object.assign(anim, createAnim(scene));
    return;
  }
  const hw = scene.width / 2;
  const hh = scene.height / 2;
  const dur = Math.min(HOP_MS, 1000 / Math.max(1, tempo));
  for (const head of scene.heads) {
    const before = previous.heads.find((h) => h.id === head.id);
    const tx = head.x - hw + 0.5;
    const tz = head.y - hh + 0.5;
    if (!before) { anim.heads.set(head.id, { fx: tx, fz: tz, tx, tz, start: t, dur: 0 }); continue; }
    const steps = Math.abs(before.x - head.x) + Math.abs(before.y - head.y);
    const current = positionAt(anim.heads.get(head.id), t) ?? { x: before.x - hw + 0.5, z: before.y - hh + 0.5 };
    // one cell over hops; a wrap round the folded tape or a burst of
    // steps between two frames lands at once
    if (steps === 1) {
      anim.heads.set(head.id, { fx: current.x, fz: current.z, tx, tz, start: t, dur });
      if (anim.hopped.length < 16) anim.hopped.push(head.id);
    }
    else if (steps > 1) anim.heads.set(head.id, { fx: tx, fz: tz, tx, tz, start: t, dur: 0 });
  }
  if (scene.tape !== previous.tape) {
    for (let i = 0; i < anim.to.length; i++) {
      const next = blockHeight(scene.tape[i] ?? 0);
      if (next === anim.to[i]) continue;
      anim.from[i] = heightAt(anim, i, t);
      anim.to[i] = next;
      anim.rise[i] = t;
      anim.stamps.push({ cell: i, start: t });
    }
    if (anim.stamps.length > 64) anim.stamps.splice(0, anim.stamps.length - 64);
  }
  for (const event of scene.events ?? []) {
    if (event.seq <= anim.seen) continue;
    anim.seen = Math.max(anim.seen, event.seq);
    anim.effects.push({ kind: event.kind, by: event.by, change: event.change, start: t, seq: event.seq });
    anim.fresh.push({ kind: event.kind, ...(event.by === undefined ? {} : { by: event.by }) });
  }
}

/** @param {{ fx: number, fz: number, tx: number, tz: number, start: number, dur: number } | undefined} hop @param {number} t */
function positionAt(hop, t) {
  if (!hop) return null;
  const k = hop.dur <= 0 ? 1 : Math.min(1, Math.max(0, (t - hop.start) / hop.dur));
  return { x: hop.fx + (hop.tx - hop.fx) * k, z: hop.fz + (hop.tz - hop.fz) * k, hop: Math.sin(k * Math.PI) };
}

/** @param {ReturnType<typeof createAnim>} anim @param {number} i @param {number} t */
function heightAt(anim, i, t) {
  const k = Math.min(1, Math.max(0, (t - anim.rise[i]) / RISE_MS));
  return anim.from[i] + (anim.to[i] - anim.from[i]) * settle(k);
}

/**
 * The motion of the frame at time `t`.
 * @param {ReturnType<typeof createAnim>} anim @param {number} t @param {boolean} moving
 * @returns {Motion}
 */
export function motionAt(anim, t, moving) {
  if (!moving) return stillMotion();
  /** @type {Motion['heads']} */
  const heads = {};
  for (const [id, hop] of anim.heads) heads[id] = /** @type {any} */ (positionAt(hop, t));
  const heights = new Float64Array(anim.to.length);
  for (let i = 0; i < heights.length; i++) heights[i] = heightAt(anim, i, t);
  anim.stamps = anim.stamps.filter((s) => t - s.start < 600);
  const longest = Math.max(...Object.values(EFFECT_MS));
  anim.effects = anim.effects.filter((e) => t - e.start < longest);
  return {
    time: t,
    now: Date.now(),
    moving: true,
    heads,
    heights,
    stamps: anim.stamps.map((s) => ({ cell: s.cell, age: t - s.start })),
    effects: anim.effects.map((e) => ({ kind: e.kind, by: e.by, change: e.change, age: t - e.start })),
  };
}

/**
 * Resolve a tap to the figure, sign or cell under it and emit the pick
 * binding the view gave the stage.
 * @param {any} handle @param {{ clientX: number, clientY: number }} e
 */
export function pick(handle, e) {
  const binding = handle.props.onPick;
  if (!binding || !handle.view) return;
  const rect = handle.host.getBoundingClientRect?.() ?? { left: 0, top: 0 };
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  /** @type {any} */
  let hit = null;
  let best = Infinity;
  for (const p of handle.picks) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < p.r && d < best) { best = d; hit = { kind: p.kind, id: p.id }; }
  }
  if (!hit) {
    const scene = handle.props.scene;
    const hw = scene.width / 2;
    const hh = scene.height / 2;
    for (let j = 0; j < scene.height; j++) {
      for (let i = 0; i < scene.width; i++) {
        const cell = j * scene.width + i;
        const [cx, cy] = project(handle.view, i - hw + 0.5, blockHeight(scene.tape[cell]), j - hh + 0.5);
        const d = Math.hypot(cx - x, cy - y);
        if (d < best) { best = d; hit = { kind: 'cell', id: String(cell), x: i, y: j, symbol: scene.tape[cell] }; }
      }
    }
    if (best > 48) hit = null;
  }
  if (!hit) return;
  const base = typeof binding === 'string' ? { action: binding } : binding;
  handle.emit({ ...base, with: { ...(base.with ?? {}), ...hit } }, e);
}
