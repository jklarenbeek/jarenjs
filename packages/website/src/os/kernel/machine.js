//@ts-check
/**
 * The tape unit: the half of the Turing machine the jaren-fsm document
 * deliberately does not own. `compileFsm` turns the program into a pure
 * step function from (control state, symbol read) to a transition
 * result whose effects come back as data; this module is the host that
 * reads the tape, hands the symbol in, performs the `write`/`turn`
 * descriptors and moves the head.
 *
 * The world is plain JSON — `{ width, height, tape, heads, tick }`, the
 * tape a flat row-major array of symbols on a torus — and every call
 * returns a NEW world, so the app's reference-identity change detection
 * and the renderer's sharing fast path see a step as one change. The
 * same function runs the live machine and every what-if simulation the
 * council votes on: there is one semantics, not a fast one for votes
 * and a faithful one for the screen.
 */

import { compileFsm } from '@jarenjs/flow';
import { SYMBOLS } from './program.js';

/** Heading deltas: 0 north, 1 east, 2 south, 3 west (screen rows grow south). */
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

/** Turn letter → heading delta. Anything else (a malformed amendment the
 * contract let through, never the default program) keeps the heading. */
const TURN_DELTA = /** @type {Record<string, number>} */ ({ L: 3, R: 1, U: 2, N: 0 });

/**
 * @typedef {{ id: string, x: number, y: number, dir: number, state: string }} Head
 * @typedef {{ width: number, height: number, tape: number[], heads: Head[], tick: number }} World
 * @typedef {{ cell: number, symbol: number, head: string }} Write
 * @typedef {ReturnType<typeof compileFsm>} Machine
 */

/** Compiled programs, by document identity: a program is recompiled only
 * when an amendment produced a new document. */
const compiled = new WeakMap();

/**
 * The compiled machine for a program document, memoized by identity.
 * @param {object} doc @returns {Machine}
 */
export function compileMachine(doc) {
  let machine = compiled.get(doc);
  if (machine === undefined) {
    machine = compileFsm(doc);
    compiled.set(doc, machine);
  }
  return machine;
}

/**
 * A blank world with the given heads, each starting in `initial`.
 * @param {{ width: number, height: number, heads: Array<Omit<Head, 'state'> & { state?: string }>, initial: string }} spec
 * @returns {World}
 */
export function createWorld({ width, height, heads, initial }) {
  return {
    width,
    height,
    tape: new Array(width * height).fill(0),
    heads: heads.map((h) => ({ id: h.id, x: h.x, y: h.y, dir: h.dir, state: h.state ?? initial })),
    tick: 0,
  };
}

/**
 * Run `steps` machine steps over every head, in head order per step.
 * Pure: the world passed in is never mutated.
 *
 * `writes` lists the cells written during the LAST step only (capped at
 * one per head) — enough for the stage to animate the newest stamps
 * without a run of a thousand simulated steps building a list nobody
 * reads — and `fired` the program transitions the heads took in that
 * step, by index (`state × symbols + symbol`, the program layout), which
 * is what the Source app lights up. `errors` collects the step results'
 * fail-closed evaluation records (JF2003/JF2004), deduplicated by code
 * and docPath.
 *
 * @param {Machine} machine
 * @param {World} world
 * @param {number} [steps]
 * @returns {{ world: World, writes: Write[], fired: number[], errors: Array<{ code: string, docPath: string, message: string }> }}
 */
export function stepWorld(machine, world, steps = 1) {
  const { width, height } = world;
  const tape = world.tape.slice();
  const heads = world.heads.map((h) => ({ ...h }));
  const initial = machine.initial ?? machine.states[0];
  /** @type {Write[]} */
  let writes = [];
  /** @type {number[]} */
  let fired = [];
  /** @type {Map<string, { code: string, docPath: string, message: string }>} */
  const errors = new Map();
  for (let n = 0; n < steps; n++) {
    writes = [];
    fired = [];
    for (const head of heads) {
      if (!machine.states.includes(head.state)) head.state = initial;
      const cell = head.y * width + head.x;
      fired.push(machine.states.indexOf(head.state) * SYMBOLS + tape[cell]);
      const result = machine.step(head.state, 'read', { payload: { symbol: tape[cell] } });
      for (const error of result.errors) errors.set(`${error.code} ${error.docPath}`, error);
      head.state = result.state;
      for (const effect of result.effects) {
        if (effect.run === 'write' && Number.isInteger(effect.with)) {
          tape[cell] = effect.with;
          writes.push({ cell, symbol: effect.with, head: head.id });
        }
        else if (effect.run === 'turn') {
          head.dir = (head.dir + (TURN_DELTA[effect.with] ?? 0)) % 4;
        }
      }
      head.x = (head.x + DX[head.dir] + width) % width;
      head.y = (head.y + DY[head.dir] + height) % height;
    }
  }
  return {
    world: { width, height, tape, heads, tick: world.tick + steps },
    writes,
    fired,
    errors: [...errors.values()],
  };
}

/**
 * The tape folded about its vertical axis (left half mirrored onto the
 * right), the architect's favourite one-shot amendment.
 * @param {World} world @returns {World}
 */
export function mirrorWorld(world) {
  const { width, height } = world;
  const tape = world.tape.slice();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < Math.floor(width / 2); x++) {
      tape[y * width + (width - 1 - x)] = tape[y * width + x];
    }
  }
  return { ...world, tape };
}

/**
 * True when a value is a world this tape unit can step and the stage can
 * draw: a tape of symbols filling its floor, heads on it facing one of
 * the four ways. The check a world from storage must pass.
 * @param {any} world
 * @param {number} [symbols]
 */
export function isWorld(world, symbols = SYMBOLS) {
  if (!world || typeof world !== 'object') return false;
  const { width, height, tape, heads, tick } = world;
  const side = (/** @type {unknown} */ n) => Number.isInteger(n) && /** @type {number} */ (n) > 0 && /** @type {number} */ (n) <= 256;
  return side(width) && side(height) && Number.isInteger(tick) && tick >= 0
    && Array.isArray(tape) && tape.length === width * height
    && tape.every((s) => Number.isInteger(s) && s >= 0 && s < symbols)
    && Array.isArray(heads) && heads.every((h) => h && typeof h.id === 'string' && typeof h.state === 'string'
      && Number.isInteger(h.x) && h.x >= 0 && h.x < width && Number.isInteger(h.y) && h.y >= 0 && h.y < height
      && Number.isInteger(h.dir) && h.dir >= 0 && h.dir < 4);
}

/** The tape wiped back to paper; heads keep their places.
 * @param {World} world @returns {World} */
export function clearWorld(world) {
  return { ...world, tape: new Array(world.tape.length).fill(0) };
}
