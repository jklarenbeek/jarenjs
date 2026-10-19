//@ts-check
/**
 * The OS state document: everything the running OS is, as one JSON
 * value. The app runtime owns it; every boundary (the tape unit, the
 * council driver, the contract handlers) reads it and changes it only by
 * dispatching an action document.
 */

import { DEFAULT_RULES, rulesToFsm, isProgram } from '../kernel/program.js';
import { createWorld, isWorld } from '../kernel/machine.js';
import { measure } from '../kernel/metrics.js';
import { MEMBERS, DANCERS, isTempo } from '../kernel/council.js';
import { SESSION_EVERY, VERDICT_MS } from '../kernel/session.js';

/** The tape inks, symbol by symbol: paper, then the five brights the
 * council wears. Blue leads (the Jaren brand), amber follows, then red,
 * green and cyan — a bright, outlined palette with no pink and no purple
 * anywhere in it (docs/DESIGN.md §1). */
export const PALETTE = Object.freeze(['#fffdf6', '#2563eb', '#fbbf24', '#ef4444', '#16a34a', '#06b6d4']);

/** The folded tape's side, in cells. */
export const WORLD_SIZE = 20;

/** The default tempo, steps a second. */
export const TEMPO = 12;

/** Where the dancers start: one per quarter of the floor, facing round
 * the clock — and deliberately NOT in a symmetric ring. Four heads placed
 * as each other's half-turn images under one shared program draw a floor
 * that stays point-symmetric forever, which would leave the architect
 * nothing to want. */
export const START = /** @type {Record<string, { x: number, y: number, dir: number }>} */ ({
  painter: { x: 4, y: 5, dir: 0 },
  dancer: { x: 13, y: 4, dir: 1 },
  critic: { x: 15, y: 14, dir: 2 },
  architect: { x: 6, y: 15, dir: 3 },
});

/** The seats as the scene needs them: what each member wears and how it stands. */
export const SEATS = Object.freeze(Object.fromEntries(MEMBERS.map((m) => [m.id, {
  name: m.name, ink: m.ink, pose: m.pose, figure: m.figure, taste: m.taste, motto: m.motto,
}])));

/**
 * A fresh OS: the default program, a blank floor, every merit at one.
 * @param {{ edition: string, title: string, theme?: 'light' | 'dark', reduce?: boolean, app?: string }} options
 */
export function initialState(options) {
  const machine = rulesToFsm(DEFAULT_RULES);
  const world = createWorld({
    width: WORLD_SIZE,
    height: WORLD_SIZE,
    heads: DANCERS.map((id) => ({ id, ...START[id] })),
    initial: /** @type {string} */ (machine.initial),
  });
  return {
    os: {
      edition: options.edition,
      title: options.title,
      theme: options.theme ?? 'light',
      reduce: options.reduce ?? false,
      app: options.app ?? 'council',
      focus: null,
      notice: null,
      seq: 0,
      storage: { mode: 'starting', detail: '' },
      online: true,
    },
    program: { machine, tempo: TEMPO, palette: [...PALETTE] },
    world,
    machine: { running: true, burst: 1, measure: measure(world), trail: [], fired: [], draft: null, forecast: null },
    council: {
      phase: 'idle',
      session: 0,
      seats: SEATS,
      merits: Object.fromEntries(MEMBERS.map((m) => [m.id, 1])),
      leader: MEMBERS[0].id,
      proposals: [],
      scores: [],
      winner: null,
      deadline: null,
      window: VERDICT_MS,
      next: SESSION_EVERY,
      queue: [],
      chat: [],
      log: [],
      draft: '',
    },
    events: [{ seq: 0, kind: 'boot' }],
    exports: { format: 'css', text: '', name: '', mime: '', status: 'idle' },
    gallery: { items: [], status: 'idle', title: '' },
    source: { doc: 'machine' },
  };
}

/**
 * Lay a saved session over a fresh state — the parts worth keeping
 * across a reload (the floor, the program, the council's merits and its
 * constitution) — keeping this boot's own preferences and edition. A
 * saved program or floor this OS cannot run is left behind, not booted.
 * @param {any} fresh @param {any} saved
 */
export function restoreState(fresh, saved) {
  if (!saved || typeof saved !== 'object') return fresh;
  const world = isWorld(saved.world) ? saved.world : fresh.world;
  const tempo = isTempo(saved.program?.tempo) ? saved.program.tempo : fresh.program.tempo;
  return {
    ...fresh,
    program: isProgram(saved.program?.machine) ? { ...fresh.program, machine: saved.program.machine, tempo } : fresh.program,
    world,
    machine: { ...fresh.machine, measure: measure(world) },
    council: {
      ...fresh.council,
      session: Number.isInteger(saved.council?.session) ? saved.council.session : 0,
      merits: { ...fresh.council.merits, ...(saved.council?.merits ?? {}) },
      leader: saved.council?.leader ?? fresh.council.leader,
      log: Array.isArray(saved.council?.log) ? saved.council.log.slice(0, 24) : [],
      next: world.tick + SESSION_EVERY,
    },
  };
}

/** The part of the state a session save keeps.
 * @param {any} state */
export function sessionSlice(state) {
  return {
    program: { machine: state.program.machine, tempo: state.program.tempo },
    world: state.world,
    council: { session: state.council.session, merits: state.council.merits, leader: state.council.leader, log: state.council.log },
  };
}
