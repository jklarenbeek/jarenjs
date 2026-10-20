//@ts-check
/**
 * The camera as a first-class system: a director that owns the one
 * camera every frame is shot through, and moves it the way a film crew
 * would — named shots it travels between on an eased dolly, a follow rig
 * that keeps a moving figure in frame with a little lag (so motion reads
 * as motion), an idle orbit that drifts the set while nobody touches it,
 * and a shake for the moments that land. The viewer's hand always wins:
 * a drag takes the camera over at once, and the director waits a while
 * before drifting again.
 *
 * Shots are plain camera documents (`SHOTS`), so a game, a tutorial step
 * or a language model can ask for one by name; the director only ever
 * produces cameras the stage's `viewOf` already understands.
 */

import { clampCamera, HOME_CAMERA } from '../stage/camera.js';
import { EASE } from './fx.js';

/**
 * @typedef {import('../stage/camera.js').Camera} Camera
 * @typedef {[number, number, number]} V3
 * @typedef {{ from: Camera, to: Camera, age: number, ms: number, ease: (t: number) => number }} Move
 * @typedef {{ target: () => V3 | null, lag: number, at: V3 | null }} Follow
 */

/** Named shots: where the director can put the camera on request. */
export const SHOTS = Object.freeze(/** @type {Record<string, Camera>} */ ({
  home: HOME_CAMERA,
  wide: { azimuth: 0.62, elevation: 0.98, distance: 54, lift: 0, fov: 0.62 },
  crane: { azimuth: 0.18, elevation: 1.22, distance: 46, lift: 0, fov: 0.6 },
  close: { azimuth: 0.74, elevation: 0.46, distance: 20, lift: 1.4, fov: 0.7 },
  hero: { azimuth: 0.94, elevation: 0.24, distance: 24, lift: 1.8, fov: 0.76 },
  map: { azimuth: 0, elevation: 1.3, distance: 40, lift: 0, fov: 0.58 },
  verdict: { azimuth: 0.34, elevation: 0.56, distance: 26, lift: 2.2, fov: 0.66 },
}));

/** How long the director waits after the viewer's hand before drifting, ms. */
export const HAND_IDLE_MS = 9000;

/**
 * Interpolate two cameras: angles the short way round, the target linearly.
 * @param {Camera} a @param {Camera} b @param {number} t @returns {Camera}
 */
export function lerpCamera(a, b, t) {
  const l = (/** @type {number} */ x, /** @type {number} */ y) => x + (y - x) * t;
  let turn = (b.azimuth - a.azimuth) % (Math.PI * 2);
  if (turn > Math.PI) turn -= Math.PI * 2;
  if (turn < -Math.PI) turn += Math.PI * 2;
  /** @type {Camera} */
  const out = {
    azimuth: a.azimuth + turn * t,
    elevation: l(a.elevation, b.elevation),
    distance: l(a.distance, b.distance),
    lift: l(a.lift, b.lift),
    fov: l(a.fov, b.fov),
  };
  const ta = a.target ?? [0, 0, 0];
  const tb = b.target ?? [0, 0, 0];
  if (a.target || b.target) out.target = [l(ta[0], tb[0]), l(ta[1], tb[1]), l(ta[2], tb[2])];
  return out;
}

/**
 * A director over a starting camera.
 * @param {Camera} [initial]
 * @param {{ limits?: boolean }} [options] - `limits: false` lets a game fly the camera past the orbit bounds
 */
export function createDirector(initial = HOME_CAMERA, options = {}) {
  const bound = options.limits === false ? (/** @type {Camera} */ c) => c : clampCamera;
  /** @type {Camera} */
  let camera = bound({ ...initial });
  /** @type {Move | null} */
  let move = null;
  /** @type {Follow | null} */
  let follow = null;
  let drift = 0;
  let idle = HAND_IDLE_MS;
  let shakeAmp = 0;
  let shakeLeft = 0;
  let shakeTotal = 0;
  let time = 0;

  return {
    /** The camera as it stands (before shake). */
    get camera() { return camera; },
    /** True while a move is under way. */
    get moving() { return move !== null; },
    /** The shot names the director knows. */
    shots: Object.keys(SHOTS),
    /**
     * Put the camera somewhere at once.
     * @param {Camera | string} shot
     */
    cut(shot) {
      const to = typeof shot === 'string' ? SHOTS[shot] : shot;
      if (!to) return false;
      camera = bound({ ...camera, ...to });
      move = null;
      return true;
    },
    /**
     * Travel to a shot over `ms`, eased.
     * @param {Camera | string} shot @param {{ ms?: number, ease?: (t: number) => number }} [opts]
     */
    move(shot, opts = {}) {
      const to = typeof shot === 'string' ? SHOTS[shot] : shot;
      if (!to) return false;
      move = { from: camera, to: bound({ ...camera, ...to }), age: 0, ms: Math.max(1, opts.ms ?? 900), ease: opts.ease ?? EASE.inOutSine };
      return true;
    },
    /**
     * Keep a moving point in frame (null stops following). `lag` is the
     * fraction of the gap left after a second — 0.02 is a tight rig, 0.4 a lazy one.
     * @param {(() => V3 | null) | null} target @param {{ lag?: number }} [opts]
     */
    follow(target, opts = {}) {
      follow = target ? { target, lag: Math.max(0.001, Math.min(0.9, opts.lag ?? 0.08)), at: camera.target ?? null } : null;
    },
    /** Drift around the set at `rate` radians a second while idle (0 stops). @param {number} rate */
    orbit(rate) {
      drift = rate;
    },
    /** Shake by `amp` (camera units of azimuth/elevation wobble), decaying over `ms`. @param {number} amp @param {number} [ms] */
    shake(amp, ms = 380) {
      if (amp >= shakeAmp * (shakeTotal > 0 ? shakeLeft / shakeTotal : 0)) {
        shakeAmp = amp;
        shakeLeft = ms;
        shakeTotal = ms;
      }
    },
    /**
     * The viewer moved the camera: take it as is, stop any move, pause the drift.
     * @param {Camera} next
     */
    hand(next) {
      camera = bound({ ...next, target: next.target ?? camera.target });
      move = null;
      idle = 0;
    },
    /**
     * Advance by `ms` and answer the camera to shoot this frame through.
     * @param {number} ms @returns {Camera}
     */
    step(ms) {
      // a slow frame moves the camera at most a quarter second; the idle
      // clock counts every millisecond, however the frames arrive
      const dt = Math.max(0, Math.min(250, ms));
      time += dt;
      idle += Math.max(0, ms);
      if (move) {
        move.age += dt;
        const k = Math.min(1, move.age / move.ms);
        camera = lerpCamera(move.from, move.to, move.ease(k));
        if (k >= 1) { camera = move.to; move = null; }
      }
      else if (drift !== 0 && idle >= HAND_IDLE_MS) {
        camera = { ...camera, azimuth: camera.azimuth + drift * dt / 1000 };
      }
      if (follow) {
        const goal = follow.target();
        if (goal) {
          const from = follow.at ?? goal;
          const keep = Math.pow(follow.lag, dt / 1000);
          /** @type {V3} */
          const at = [goal[0] + (from[0] - goal[0]) * keep, goal[1] + (from[1] - goal[1]) * keep, goal[2] + (from[2] - goal[2]) * keep];
          follow.at = at;
          camera = { ...camera, target: at };
        }
      }
      if (shakeLeft > 0) {
        shakeLeft = Math.max(0, shakeLeft - dt);
        const k = shakeLeft / shakeTotal;
        const amp = shakeAmp * k * k;
        if (shakeLeft === 0) shakeAmp = 0;
        return { ...camera, azimuth: camera.azimuth + Math.sin(time * 0.09) * amp, elevation: camera.elevation + Math.cos(time * 0.071) * amp * 0.6 };
      }
      return camera;
    },
  };
}
