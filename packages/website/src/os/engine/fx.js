//@ts-check
/**
 * The visual effects engine: particles in world space, drawn into the
 * stage's own display list so they sort with the floor and the figures —
 * confetti when a project ships, sparks off a stamped block, the radiant
 * lines that ring a moment worth noticing, ripples on water and floor,
 * chalk dust, floating notes, stars and hearts — plus the screen-level
 * juice: camera shake, a flash, and the easing curves and springs every
 * other engine animates with.
 *
 * Deterministic by construction: an effect system owns a seeded random
 * stream, so the same emits stepped by the same frames draw the same
 * picture — in a test, an SVG still, or the frame you are looking at.
 */

import { mulberry32 } from '@jarenjs/core/random';
import { project, depthOf } from '../stage/camera.js';
import { heartOutline } from '../stage/figures.js';

/**
 * @typedef {import('../stage/scene.js').Item} Item
 * @typedef {import('../stage/camera.js').View} View
 * @typedef {'confetti' | 'sparks' | 'radiance' | 'ripple' | 'dust' | 'notes' | 'stars' | 'hearts'} FxKind
 * @typedef {{ kind: FxKind, x: number, y: number, z: number, vx: number, vy: number, vz: number,
 *   age: number, life: number, size: number, spin: number, angle: number, color: string }} Particle
 * @typedef {{ particles: Particle[], random: () => number, shake: { amp: number, age: number, life: number },
 *   flash: { color: string, age: number, life: number } | null, time: number }} Fx
 */

/** Per-kind physics: gravity (units/s²), drag (per s), life (s), how many by default. */
const KINDS = Object.freeze(/** @type {Record<FxKind, { gravity: number, drag: number, life: number, count: number }>} */ ({
  confetti: { gravity: -6, drag: 1.6, life: 2.4, count: 36 },
  sparks: { gravity: -9, drag: 0.6, life: 0.6, count: 14 },
  radiance: { gravity: 0, drag: 0, life: 0.9, count: 1 },
  ripple: { gravity: 0, drag: 0, life: 1.2, count: 1 },
  dust: { gravity: 0.6, drag: 2.5, life: 0.9, count: 8 },
  notes: { gravity: 1.2, drag: 0.8, life: 1.8, count: 4 },
  stars: { gravity: -2, drag: 1.2, life: 1.4, count: 8 },
  hearts: { gravity: 1.6, drag: 1.0, life: 1.6, count: 6 },
}));

/** Particles alive at once, at most: an effect storm degrades, never stalls. */
export const FX_MAX = 600;

/**
 * Easing curves over t ∈ [0, 1].
 */
export const EASE = Object.freeze({
  linear: (/** @type {number} */ t) => t,
  inOutSine: (/** @type {number} */ t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outCubic: (/** @type {number} */ t) => 1 - Math.pow(1 - t, 3),
  outBack: (/** @type {number} */ t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
  outElastic: (/** @type {number} */ t) => (t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
});

/**
 * Interpolate with an easing curve; t is clamped to [0, 1].
 * @param {number} a @param {number} b @param {number} t @param {(t: number) => number} [ease]
 */
export function tween(a, b, t, ease = EASE.inOutSine) {
  return a + (b - a) * ease(Math.max(0, Math.min(1, t)));
}

/**
 * One step of a damped spring toward `target` (semi-implicit Euler):
 * the motion of a camera settling, a card snapping, a squash recovering.
 * @param {number} x @param {number} v @param {number} target
 * @param {number} stiffness - per s² @param {number} damping - per s @param {number} dt - s
 * @returns {[number, number]} the new position and velocity
 */
export function spring(x, v, target, stiffness, damping, dt) {
  const nv = v + ((target - x) * stiffness - v * damping) * dt;
  return [x + nv * dt, nv];
}

/**
 * A fresh effect system.
 * @param {number} [seed] @returns {Fx}
 */
export function createFx(seed = 7) {
  return { particles: [], random: mulberry32(seed), shake: { amp: 0, age: 0, life: 0 }, flash: null, time: 0 };
}

/**
 * Emit a burst of one kind at a world point.
 * @param {Fx} fx @param {FxKind} kind @param {[number, number, number]} at
 * @param {{ count?: number, colors?: readonly string[], power?: number, size?: number }} [options]
 * @returns {number} how many particles were emitted
 */
export function emit(fx, kind, at, options = {}) {
  const spec = KINDS[kind];
  if (!spec) return 0;
  const count = Math.max(0, Math.min(FX_MAX - fx.particles.length, options.count ?? spec.count));
  const colors = options.colors && options.colors.length > 0 ? options.colors : ['#facc15', '#2563eb', '#dc2626', '#16a34a', '#f97316'];
  const power = options.power ?? 1;
  const r = fx.random;
  for (let i = 0; i < count; i++) {
    const a = r() * Math.PI * 2;
    const lift = kind === 'confetti' ? 5 + r() * 4 : kind === 'sparks' ? 3 + r() * 3 : kind === 'stars' ? 2 + r() * 2 : 0.6 + r();
    const out = kind === 'confetti' ? 1.5 + r() * 2.5 : kind === 'sparks' ? 2 + r() * 3 : kind === 'notes' || kind === 'hearts' ? 0.3 + r() * 0.4 : 0.8 + r();
    fx.particles.push({
      kind,
      x: at[0], y: at[1], z: at[2],
      vx: Math.cos(a) * out * power,
      vy: (kind === 'radiance' || kind === 'ripple' ? 0 : lift) * power,
      vz: Math.sin(a) * out * power,
      age: 0,
      life: spec.life * (0.8 + r() * 0.4),
      size: (options.size ?? 1) * (kind === 'confetti' ? 0.16 + r() * 0.08 : kind === 'dust' ? 0.25 + r() * 0.2 : 0.22 + r() * 0.08),
      spin: (r() - 0.5) * 12,
      angle: r() * Math.PI * 2,
      color: colors[Math.floor(r() * colors.length) % colors.length],
    });
  }
  return count;
}

/**
 * Shake the camera: `amp` pixels, decaying over `life` seconds. A bigger
 * shake replaces a smaller one; a smaller one never cuts a big one short.
 * @param {Fx} fx @param {number} amp @param {number} [life]
 */
export function shake(fx, amp, life = 0.4) {
  const left = fx.shake.life > 0 ? fx.shake.amp * (1 - fx.shake.age / fx.shake.life) : 0;
  if (amp >= left) fx.shake = { amp, age: 0, life };
}

/**
 * Flash the whole frame with a colour, fading over `life` seconds.
 * @param {Fx} fx @param {string} color @param {number} [life]
 */
export function flash(fx, color, life = 0.25) {
  fx.flash = { color, age: 0, life };
}

/**
 * Advance every particle by `dt` seconds and retire the spent ones.
 * @param {Fx} fx @param {number} dt @returns {Fx}
 */
export function stepFx(fx, dt) {
  const h = Math.max(0, Math.min(0.1, dt));
  fx.time += h;
  const live = [];
  for (const p of fx.particles) {
    const spec = KINDS[p.kind];
    p.age += h;
    if (p.age >= p.life) continue;
    const keep = Math.exp(-spec.drag * h);
    p.vx *= keep;
    p.vz *= keep;
    p.vy = p.vy * keep + spec.gravity * h;
    p.x += p.vx * h;
    p.y = Math.max(0, p.y + p.vy * h);
    p.z += p.vz * h;
    p.angle += p.spin * h;
    live.push(p);
  }
  fx.particles = live;
  if (fx.shake.life > 0) {
    fx.shake.age += h;
    if (fx.shake.age >= fx.shake.life) fx.shake = { amp: 0, age: 0, life: 0 };
  }
  if (fx.flash) {
    fx.flash.age += h;
    if (fx.flash.age >= fx.flash.life) fx.flash = null;
  }
  return fx;
}

/**
 * The camera-shake offset this frame, in pixels.
 * @param {Fx} fx @returns {[number, number]}
 */
export function shakeOffset(fx) {
  if (fx.shake.life <= 0) return [0, 0];
  const k = 1 - fx.shake.age / fx.shake.life;
  const amp = fx.shake.amp * k * k;
  return [Math.sin(fx.time * 91) * amp, Math.cos(fx.time * 73) * amp * 0.7];
}

/**
 * The particles as painter's groups for the stage to sort with its own.
 * @param {Fx} fx @param {View} view @param {{ ink: string }} theme
 * @returns {Array<{ d: number, items: Item[] }>}
 */
export function fxGroups(fx, view, theme) {
  /** @type {Array<{ d: number, items: Item[] }>} */
  const groups = [];
  for (const p of fx.particles) {
    const c = project(view, p.x, p.y, p.z);
    if (c[2] <= 0) continue;
    const up = project(view, p.x, p.y + 1, p.z);
    const unit = Math.abs(c[1] - up[1]);
    const k = p.age / p.life;
    const a = Math.max(0, 1 - k * k);
    const s = p.size * unit;
    /** @type {Item[]} */
    const out = [];
    switch (p.kind) {
      case 'confetti': {
        const cs = Math.cos(p.angle) * s;
        const sn = Math.sin(p.angle) * s * 0.6;
        out.push({ t: 'poly', p: [c[0] - cs, c[1] - sn, c[0] + sn, c[1] - cs, c[0] + cs, c[1] + sn, c[0] - sn, c[1] + cs], fill: p.color, stroke: theme.ink, w: Math.max(0.8, s * 0.18), a });
        break;
      }
      case 'sparks': {
        const tail = project(view, p.x - p.vx * 0.06, p.y - p.vy * 0.06, p.z - p.vz * 0.06);
        out.push({ t: 'line', p: [tail[0], tail[1], c[0], c[1]], stroke: p.color, w: Math.max(1.2, s * 0.5), a });
        break;
      }
      case 'radiance': {
        // the ring of paired dashes a figure radiates, thrown outward
        const r1 = unit * (0.6 + k * 1.6);
        const r2 = r1 + unit * 0.45;
        for (let m = 0; m < 12; m++) {
          const ang = (m / 12) * Math.PI * 2 + p.angle;
          out.push({ t: 'line', p: [c[0] + Math.cos(ang) * r1, c[1] + Math.sin(ang) * r1, c[0] + Math.cos(ang) * r2, c[1] + Math.sin(ang) * r2], stroke: theme.ink, w: Math.max(1.4, unit * 0.09), a });
        }
        break;
      }
      case 'ripple': {
        const r = 0.4 + k * 2.2;
        /** @type {number[]} */
        const ring = [];
        for (let m = 0; m <= 24; m++) {
          const ang = (m / 24) * Math.PI * 2;
          const q = project(view, p.x + Math.cos(ang) * r, p.y + 0.02, p.z + Math.sin(ang) * r);
          ring.push(q[0], q[1]);
        }
        out.push({ t: 'line', p: ring, stroke: p.color, w: Math.max(1.2, unit * 0.06), a });
        break;
      }
      case 'dust':
        out.push({ t: 'disc', x: c[0], y: c[1], r: s * (1 + k), fill: p.color, stroke: null, w: 0, a: a * 0.6 });
        break;
      case 'notes':
        out.push({ t: 'disc', x: c[0], y: c[1], r: s * 0.55, fill: p.color, stroke: theme.ink, w: Math.max(1, s * 0.16), a });
        out.push({ t: 'line', p: [c[0] + s * 0.5, c[1], c[0] + s * 0.5, c[1] - s * 1.8, c[0] + s * 1.1, c[1] - s * 1.4], stroke: theme.ink, w: Math.max(1, s * 0.18), a });
        break;
      case 'stars': {
        /** @type {number[]} */
        const star = [];
        for (let m = 0; m < 10; m++) {
          const ang = p.angle + (m / 10) * Math.PI * 2;
          const rr = m % 2 === 0 ? s : s * 0.45;
          star.push(c[0] + Math.cos(ang) * rr, c[1] + Math.sin(ang) * rr);
        }
        out.push({ t: 'poly', p: star, fill: p.color, stroke: theme.ink, w: Math.max(1, s * 0.14), a });
        break;
      }
      case 'hearts': {
        const heart = heartOutline(s);
        out.push({ t: 'poly', p: heart.flatMap(([u, v]) => [c[0] + u, c[1] - v]), fill: p.color, stroke: theme.ink, w: Math.max(1, s * 0.14), a });
        break;
      }
    }
    groups.push({ d: depthOf(view, p.x, p.y, p.z) - 0.5, items: out });
  }
  return groups;
}

/**
 * The full-frame layer over everything: the flash, if one is fading.
 * @param {Fx} fx @param {number} width @param {number} height @returns {Item[]}
 */
export function overlayItems(fx, width, height) {
  if (!fx.flash) return [];
  const a = 0.55 * (1 - fx.flash.age / fx.flash.life);
  return [{ t: 'rect', x: 0, y: 0, wd: width, ht: height, r: 0, fill: fx.flash.color, stroke: null, w: 0, a }];
}
