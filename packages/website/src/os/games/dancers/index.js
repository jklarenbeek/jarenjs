//@ts-check
/**
 * Tape Dancers: a Turing-machine puzzle game for the Radiant arcade. A
 * Haring dancer stands on a one-dimensional tape of paper and three
 * inks; the player programs it with a rule table — for each control
 * state and ink under its feet, the ink to stamp, the step to take and
 * the state to go to, or halt — and presses Run, and the dancer dances
 * the program on the beat until it halts. Each level gives test tapes
 * and what each must become; the program is graded on every one, with
 * stars for solving it, for doing so within the par states and within
 * the par steps, and every graded run feeds the player's skill ladder.
 *
 * The program is a jaren-fsm document (`program.js`) stepped by the
 * flow engine; the levels are data (`levels.json`, `levels.js`); every
 * move is a pure function over plain JSON (`state.js`) that the HUD's
 * buttons and grid, the keys and the language-model tools (`tools.js`)
 * all reach the same way. This module is the GameModule the arcade
 * hosts: it dispatches actions and keys to those moves.
 */

import {
  CAMERA, addState, advance, createState, cycleCell, hint, nextLevel, openLevel, outcomeOf, removeState, resetRun,
  saveOf, setRule, stepOnce, toggleRun,
} from './state.js';
import { draw } from './draw.js';
import { hud } from './hud.js';
import { TOOLS } from './tools.js';

export { programChars, rulesToProgram, programToRules, compileProgram, runProgram } from './program.js';
export { LEVELS, TIERS, SKILLS, judge, suggestLevel } from './levels.js';

/**
 * @typedef {import('../game.js').GameModule} GameModule
 * @typedef {import('../game.js').GameInput} GameInput
 * @typedef {import('./state.js').DancersState} DancersState
 * @typedef {import('./state.js').Move} Move
 * @typedef {(state: DancersState, action: any) => Move} Handler
 */

/** What `act` answers, by action type: the HUD's buttons, its grid's cells and the OS's moves. */
const ACTIONS = Object.freeze(/** @type {Record<string, Handler>} */ ({
  level: (state, action) => openLevel(state, action.id),
  cell: (state, action) => cycleCell(state, action.id),
  rule: (state, action) => setRule(state, action),
  addState: (state) => addState(state),
  removeState: (state, action) => removeState(state, action.state),
  run: (state) => toggleRun(state),
  step: (state) => stepOnce(state),
  reset: (state) => resetRun(state),
  hint: (state) => hint(state),
  next: (state) => nextLevel(state),
}));

/** The keys the arcade passes as pressed actions: act runs (or moves on after a solve), hint hints, restart resets. */
const KEYS = Object.freeze(/** @type {Record<string, (state: DancersState) => Move>} */ ({
  act: (state) => (state.verdict?.solved ? nextLevel(state) : toggleRun(state)),
  hint: (state) => hint(state),
  restart: (state) => resetRun(state),
}));

/**
 * Answer a discrete move; an action of a type the game does not know
 * changes nothing.
 * @param {DancersState} state @param {{ type: string, [k: string]: any }} action @returns {Move}
 */
function act(state, action) {
  const handler = Object.hasOwn(ACTIONS, action?.type) ? ACTIONS[action.type] : null;
  return handler ? handler(state, action) : { state, events: [] };
}

/**
 * One fixed tick: the keys pressed since the last one, then the dance
 * clock.
 * @param {DancersState} state @param {GameInput} input @returns {Move}
 */
function step(state, input) {
  let next = state;
  /** @type {import('../game.js').GameEvent[]} */
  const events = [];
  for (const key of input.pressed) {
    if (!Object.hasOwn(KEYS, key)) continue;
    const out = KEYS[key](next);
    next = out.state;
    events.push(...out.events);
  }
  const out = advance(next);
  return { state: out.state, events: events.length > 0 ? [...events, ...out.events] : out.events };
}

/**
 * The Tape Dancers game module.
 * @type {GameModule}
 */
export const dancers = Object.freeze({
  id: 'dancers',
  title: 'Tape Dancers',
  blurb: 'Program a Haring dancer as a Turing machine: a rule table of inks, steps and states, danced on the beat and graded on every tape.',
  track: 'dancers',
  camera: CAMERA,
  duel: false,
  create: createState,
  step,
  act,
  draw,
  hud,
  over: outcomeOf,
  save: saveOf,
  tools: TOOLS,
});
