//@ts-check
/**
 * Tape Dancers, the Turing-machine puzzle game of the Radiant arcade,
 * headless: the program as a jaren-fsm document and the tape unit that
 * runs it, the levels and their reference solutions (each proven to
 * solve its level within par), grading on the stars and the skill
 * ladder, the level suggestion, editing through actions and the HUD
 * grid, the dance on the beat through `play()`, the language-model
 * tools, the stage in every theme, and the save.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileFsm } from '@jarenjs/flow';
import { JarenValidator } from '@jarenjs/validate';

import { dancers } from '../../packages/website/src/os/games/dancers/index.js';
import {
  BLANK, HALT, INKS, INK_NAMES, MAX_STATES, MOVES, checkRules, compileProgram, freshRules, isStateName, placeHead,
  programChars, programToRules, restRule, ruleProblem, rulesToProgram, runProgram,
} from '../../packages/website/src/os/games/dancers/program.js';
import {
  LEVELS, SKILLS, TARGET_SUCCESS, TIERS, chanceOf, checkTape, firingOrder, judge, levelById, levelProblem, loadLevels,
  missText, plural, rateRun, starText, starsFor, suggestLevel, tierOf,
} from '../../packages/website/src/os/games/dancers/levels.js';
import {
  CAMERA, CLOCK_REST, advance, beatTicks, blockTop, cellX, createState, dancerPoint, followingLevel, hint, rulesOf,
  runAll, saveOf, setProgram, stepOnce, toggleRun,
} from '../../packages/website/src/os/games/dancers/state.js';
import { draw, DANCER_COLOR } from '../../packages/website/src/os/games/dancers/draw.js';
import { hud, ruleGrid } from '../../packages/website/src/os/games/dancers/hud.js';
import { TOOLS } from '../../packages/website/src/os/games/dancers/tools.js';
import { play, idle, IDLE_INPUT } from '../../packages/website/src/os/games/game.js';
import { STAGE_THEMES } from '../../packages/website/src/os/stage/scene.js';
import { viewOf } from '../../packages/website/src/os/stage/camera.js';
import { POSES, skeleton } from '../../packages/website/src/os/stage/figures.js';
import { createLighting } from '../../packages/website/src/os/engine/light.js';
import { SFX } from '../../packages/website/src/os/engine/audio.js';
import { LADDER, expected } from '../../packages/website/src/os/kernel/ladder.js';

/**
 * @typedef {import('../../packages/website/src/os/games/dancers/program.js').RuleTable} RuleTable
 * @typedef {import('../../packages/website/src/os/games/dancers/state.js').DancersState} DancersState
 * @typedef {import('../../packages/website/src/os/games/game.js').GameEvent} GameEvent
 */

/** @param {string} id */
const level = (id) => /** @type {NonNullable<ReturnType<typeof levelById>>} */ (levelById(id));

/** The two-state busy beaver champion: four blue cells in six steps. @type {RuleTable} */
const BB2 = {
  q0: [{ write: 1, move: 'R', next: 'q1' }, { write: 1, move: 'L', next: 'q1' }],
  q1: [{ write: 1, move: 'L', next: 'q0' }, { write: 1, move: 'R', next: 'halt' }],
};

/** Flip with one rule wrong: blue stays blue. @type {RuleTable} */
const FLIP_WRONG = {
  q0: [{ write: 0, move: 'S', next: 'halt' }, { write: 1, move: 'R', next: 'q0' }, { write: 1, move: 'R', next: 'q0' }],
};

/** Every rule of a table as `rule` actions, in table order. @param {RuleTable} rules */
const ruleActs = (rules) => Object.entries(rules).flatMap(([state, row]) => row.map((r, symbol) => ({ act: { type: 'rule', state, symbol, ...r } })));

/** Ticks enough for any dance of a level to end. @param {string} id */
const enough = (id) => 15 * level(id).maxSteps * level(id).tests.length;

/** @param {GameEvent[]} events @param {string} kind */
const kinds = (events, kind) => events.filter((e) => e.kind === kind);

/** @param {GameEvent[]} events @param {string} name */
const sounds = (events, name) => events.filter((e) => e.kind === 'sfx' && e.name === name);

/** A state with a program set (through the module's own actions). @param {string} id @param {RuleTable} rules */
function withProgram(id, rules) {
  return play(dancers, dancers.create({ seed: 1, save: null, players: [], options: { level: id } }), ruleActs(rules)).state;
}

/** The draw context the arcade hands in. @param {string} theme @param {Partial<import('../../packages/website/src/os/games/game.js').DrawContext>} [extra] */
function ctxOf(theme, extra = {}) {
  return { view: viewOf(CAMERA, 960, 600), time: 1200, theme: /** @type {any} */ (STAGE_THEMES)[theme], light: null, bodies: {}, reduce: false, palette: INKS, px: 1, ...extra };
}

/** A hex colour's hue in degrees, or null for greys. @param {string} hex */
function hueOf(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.08) return null;
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe('the program document', () => {
  it('writes a rule table in the house layout and reads it back', () => {
    const doc = rulesToProgram(BB2);
    assert.equal(doc.$fsm, '0.1');
    assert.equal(doc.initial, 'q0');
    assert.deepEqual(doc.states, ['q0', 'q1', { id: 'halt', final: true }]);
    assert.equal(doc.transitions.length, 4, 'one read transition per (state, symbol)');
    assert.deepEqual(doc.transitions[2], {
      from: 'q1', event: 'read', guard: { $eq: ['$.payload.symbol', 0] }, to: 'q0',
      effects: [{ run: 'write', with: 1 }, { run: 'move', with: 'L' }],
    }, 'transition q × symbols + s is the rule for (q, s)');
    assert.deepEqual(programToRules(doc), BB2);
    assert.deepEqual(programToRules(rulesToProgram(level('mirror').solution)), level('mirror').solution);
    assert.deepEqual(programToRules({ ...doc, states: [{ id: 'q0' }, 'q1', { id: 'halt', final: true }] }), BB2, 'states may be declared as objects');
  });

  it('compiles every program with compileFsm, once per document', () => {
    for (const lv of LEVELS) {
      for (const rules of [lv.solution, freshRules(lv.symbols)]) {
        const doc = rulesToProgram(rules);
        const machine = compileFsm(doc);
        assert.equal(machine.final('halt'), true, `${lv.id}: halt is final`);
        assert.equal(machine.initial, 'q0');
        assert.equal(compileProgram(doc), compileProgram(doc), 'memoized by document identity');
      }
    }
    assert.notEqual(compileProgram(rulesToProgram(BB2)), compileProgram(rulesToProgram(BB2)), 'a new document compiles anew');
    assert.throws(() => compileProgram({ states: [] }), RangeError, 'only documents in the program layout reach the engine');
  });

  it('starts every state resting: keep the ink, stay, halt', () => {
    assert.deepEqual(restRule(2), { write: 2, move: 'S', next: HALT });
    assert.deepEqual(freshRules(2), { q0: [restRule(0), restRule(1)] });
    const run = runProgram(rulesToProgram(freshRules(3)), [2, 1]);
    assert.deepEqual([run.steps, run.halted, run.tape], [1, true, [2, 1]], 'a fresh program halts on its first step');
  });

  it('refuses tables that are not programs, saying why', () => {
    const ok = { q0: [restRule(0), restRule(1)] };
    assert.equal(checkRules(ok, 2), null);
    assert.match(String(checkRules(ok, 1)), /2 to 4 inks/);
    assert.match(String(checkRules(ok, 5)), /2 to 4 inks/);
    assert.match(String(checkRules(null, 2)), /object of states/);
    assert.match(String(checkRules([ok], 2)), /object of states/);
    assert.match(String(checkRules({}, 2)), /at least one state/);
    const crowd = Object.fromEntries(Array.from({ length: MAX_STATES + 1 }, (_, i) => [`q${i}`, ok.q0]));
    assert.match(String(checkRules(crowd, 2)), /at most 8 states/);
    assert.match(String(checkRules({ Q0: ok.q0 }, 2)), /not a state name/);
    assert.match(String(checkRules({ halt: ok.q0 }, 2)), /not a state name/);
    assert.match(String(checkRules({ q0: [restRule(0)] }, 2)), /each of the 2 inks/);
    assert.match(String(checkRules({ q0: [restRule(0), { write: 7, move: 'S', next: 'halt' }] }, 2)), /q0 reading blue: write must be an ink from 0 to 1/);
    assert.match(String(checkRules({ q0: [restRule(0), { write: 1, move: 'U', next: 'halt' }] }, 2)), /move must be L, R or S/);
    assert.match(String(checkRules({ q0: [restRule(0), { write: 1, move: 'S', next: 'Nowhere' }] }, 2)), /next must be a state name or halt/);
    assert.match(String(checkRules({ q0: [restRule(0), { write: 1, move: 'S', next: 'q7' }] }, 2)), /there is no state q7/);
    assert.match(String(ruleProblem(null, 2)), /a rule is/);
    assert.equal(ruleProblem({ write: 1, move: 'L', next: 'q9' }, 2), null, 'a single rule may name a state the table lacks yet');
    assert.throws(() => rulesToProgram(/** @type {any} */ ({ q0: 'dance' })), RangeError);
    assert.throws(() => rulesToProgram(/** @type {any} */ (null)), RangeError);
    assert.ok(isStateName('q0') && isStateName('loop_2') && !isStateName('halt') && !isStateName('2q') && !isStateName(7));
  });

  it('refuses documents the table cannot represent exactly', () => {
    const doc = rulesToProgram(BB2);
    /** @param {(d: any) => void} change */
    const broken = (change) => {
      const d = structuredClone(doc);
      change(d);
      return () => programToRules(d);
    };
    assert.throws(() => programToRules(null), /not a jaren-fsm program/);
    assert.throws(broken((d) => { d.states[2] = 'halt'; }), /halt state must be declared final/);
    assert.throws(broken((d) => { d.states[0] = { id: 'q0', entry: [{ run: 'chime' }] }; }), /no effects of their own/);
    assert.throws(broken((d) => { d.states[1] = { id: 'q1', final: true }; }), /only halt is final/);
    assert.throws(broken((d) => { d.initial = 'q1'; }), /start in its first state/);
    assert.throws(broken((d) => { [d.transitions[0], d.transitions[1]] = [d.transitions[1], d.transitions[0]]; }), /transition 0 is not the rule for \(q0, 0\)/);
    assert.throws(broken((d) => { d.transitions[3].effects.push({ run: 'chime' }); }), /transition 3/);
    assert.throws(broken((d) => { d.transitions[1].guard.$or = []; }), /transition 1/);
    assert.throws(broken((d) => { delete d.transitions[1].guard; }), /transition 1/);
    assert.throws(broken((d) => { delete d.transitions[2].effects; }), /transition 2/);
    assert.throws(broken((d) => { d.transitions[0].effects[0].with = 9; }), /write must be an ink/);
    assert.throws(broken((d) => { d.transitions.pop(); }), RangeError, 'a missing rule leaves a row short');
  });
});

describe('the tape unit', () => {
  it('reads, stamps, steps and halts; the halting step counts too', () => {
    const run = runProgram(rulesToProgram(level('coat').solution), [2, 2]);
    assert.deepEqual(run.tape, [1, 1, 0]);
    assert.deepEqual([run.head, run.origin, run.steps, run.halted, run.stuck, run.state], [2, 0, 3, true, false, 'halt']);
    assert.deepEqual(run.trace[0], { state: 'q0', at: 0, read: 2, write: 1, move: 'R', next: 'q0' });
    assert.deepEqual(run.trace[2], { state: 'q0', at: 2, read: 0, write: 0, move: 'S', next: 'halt' });
  });

  it('steps left on L, right on R and stays on S', () => {
    const rules = /** @type {RuleTable} */ ({
      q0: [{ write: 3, move: 'L', next: 'q1' }, restRule(1), restRule(2), restRule(3)],
      q1: [{ write: 2, move: 'S', next: 'q2' }, restRule(1), restRule(2), restRule(3)],
      q2: [restRule(0), restRule(1), { write: 1, move: 'R', next: 'halt' }, restRule(3)],
    });
    const run = runProgram(rulesToProgram(rules), [0, 0], { head: 1 });
    assert.deepEqual(run.trace.map((s) => [s.at, s.move]), [[1, 'L'], [0, 'S'], [0, 'R']]);
    assert.deepEqual(run.tape, [1, 3]);
    assert.equal(run.head, 1);
  });

  it('grows paper at either end and keeps the input addressable by its origin', () => {
    const run = runProgram(rulesToProgram(BB2), [0]);
    assert.deepEqual(run.tape, [1, 1, 1, 1]);
    assert.equal(run.origin, 2, 'two cells grew in front of the input');
    assert.equal(run.head - run.origin, 0, 'the champion halts back on the cell it started from');
    assert.deepEqual([run.steps, run.halted], [6, true]);
    assert.deepEqual(run.trace.map((s) => s.at), [0, 1, 0, -1, -2, -1], 'cells count from the input, wherever the tape grew');
    const right = runProgram(rulesToProgram(level('end').solution), [1, 2]);
    assert.deepEqual([right.tape, right.head, right.origin], [[1, 2, 0], 2, 0], 'stepping past the end adds paper');
  });

  it('stops at the step limit without halting', () => {
    const runaway = rulesToProgram({ q0: [{ write: 1, move: 'R', next: 'q0' }, { write: 1, move: 'R', next: 'q0' }] });
    const run = runProgram(runaway, [0], { maxSteps: 5 });
    assert.deepEqual([run.steps, run.halted, run.tape.length], [5, false, 6]);
    assert.equal(runProgram(runaway, [0]).steps, 1000, 'the default limit');
  });

  it('freezes when no rule answers the ink, and continues from a named state', () => {
    const two = rulesToProgram(BB2);
    const frozen = runProgram(two, [3]);
    assert.deepEqual([frozen.stuck, frozen.halted, frozen.steps], [true, false, 0], 'a two-ink program cannot read red');
    assert.deepEqual([runProgram(two, [0], { state: 'halt' }).steps, runProgram(two, [0], { state: 'halt' }).halted], [0, true]);
    const resumed = runProgram(two, [1, 0], { head: 1, state: 'q1', maxSteps: 1 });
    assert.deepEqual(resumed.trace, [{ state: 'q1', at: 1, read: 0, write: 1, move: 'L', next: 'q0' }]);
    assert.equal(resumed.state, 'q0');
  });

  it('places a head off the tape by adding paper, never touching the input', () => {
    const input = [1];
    assert.deepEqual(placeHead(input, -2), { tape: [0, 0, 1], head: 0, origin: 2 });
    assert.deepEqual(placeHead([], 3), { tape: [0, 0, 0, 0], head: 3, origin: 0 });
    assert.deepEqual(input, [1]);
  });

  it('measures a whole-table call against a single rule', () => {
    assert.equal(programChars(BB2), JSON.stringify({ rules: BB2 }).length);
    const one = JSON.stringify({ state: 'q0', symbol: 0, write: 1, move: 'R', next: 'q1' }).length;
    assert.ok(programChars(level('mirror').solution) > 15 * one, 'six states over four inks is a big breath for a small model');
  });
});

describe('the levels', () => {
  it('ships twelve levels in four tiers, each with a skill, a difficulty and a reference', () => {
    assert.equal(LEVELS.length, 12);
    assert.deepEqual(TIERS.map((t) => t.id), ['chalk', 'spray', 'mural', 'radiant']);
    for (const tier of TIERS) assert.ok(LEVELS.filter((l) => l.tier === tier.id).length >= 2, tier.id);
    assert.ok(LEVELS.filter((l) => l.tier === 'chalk').every((l) => l.par.states === 1), 'chalk is one state');
    assert.ok(LEVELS.filter((l) => l.tier === 'spray').every((l) => l.par.states === 2), 'spray is two states');
    assert.ok(LEVELS.filter((l) => l.tier === 'mural').every((l) => l.par.states >= 3), 'mural is three or more');
    assert.deepEqual(LEVELS.filter((l) => l.tier === 'radiant').map((l) => [l.id, l.par.states, l.symbols]), [['bb2', 2, 2], ['bb3', 3, 2]]);
    assert.deepEqual([...new Set(LEVELS.map((l) => l.skill))].sort(), [...SKILLS].sort(), 'every Turing skill is taught');
    LEVELS.forEach((l, i) => {
      assert.equal(levelProblem(l), null);
      if (i > 0) assert.ok(l.difficulty > LEVELS[i - 1].difficulty, 'the ladder climbs');
      assert.equal(tierOf(l).id, l.tier);
    });
    assert.equal(levelById('nope'), null);
  });

  it('proves every reference solution solves every tape of its level within par', () => {
    for (const lv of LEVELS) {
      const verdict = judge(lv, lv.solution);
      assert.equal(verdict.solved, true, lv.id);
      assert.equal(verdict.failed, -1);
      assert.equal(verdict.stars, 3, `${lv.id} earns three stars`);
      assert.ok(verdict.states <= lv.par.states && verdict.steps <= lv.par.steps, lv.id);
      assert.ok(verdict.tapes.every((t) => t.passed && t.halted && t.miss === null && t.steps <= lv.maxSteps));
    }
  });

  it('keeps the busy beavers honest', () => {
    const ones = (/** @type {string} */ id) => judge(level(id), level(id).solution).tapes[0].tape.filter((s) => s === 1).length;
    assert.deepEqual([ones('bb2'), judge(level('bb2'), level('bb2').solution).steps], [4, 6], 'BB-2: four ones in six steps');
    assert.deepEqual([ones('bb3'), judge(level('bb3'), level('bb3').solution).steps], [6, 11], 'BB-3: six ones in eleven steps, stays allowed');
    assert.deepEqual(level('bb2').par, { states: 2, steps: 6 });
  });

  it('refuses a broken level, saying where it breaks', () => {
    const good = level('flip');
    /** @param {Record<string, any>} change */
    const bad = (change) => levelProblem({ ...structuredClone(good), ...change });
    assert.match(String(levelProblem(null)), /a level is an object/);
    assert.match(String(bad({ id: 'Flip!' })), /needs an id/);
    assert.match(String(bad({ name: '' })), /needs a name/);
    assert.match(String(bad({ tier: 'gold' })), /names no tier/);
    assert.match(String(bad({ skill: 'juggle' })), /no Turing skill/);
    assert.match(String(bad({ difficulty: 'hard' })), /needs a difficulty/);
    assert.match(String(bad({ symbols: 6 })), /2 to 4 inks/);
    assert.match(String(bad({ maxSteps: 0 })), /step limit/);
    assert.match(String(bad({ prompt: '' })), /goal in words/);
    assert.match(String(bad({ tests: [] })), /at least one tape/);
    assert.match(String(bad({ tests: [{ input: [] , goal: [1] }] })), /tape 1: the input must be 1 to 32 cells/);
    assert.match(String(bad({ tests: [{ input: [5], goal: [1] }] })), /the input must be/);
    assert.match(String(bad({ tests: [{ input: [1], head: 0.5, goal: [1] }] })), /the head must start on a cell/);
    assert.match(String(bad({ tests: [{ input: [1], goal: [9] }] })), /the goal must be a tape/);
    assert.match(String(bad({ tests: [{ input: [1], end: 'far' }] })), /the end must be a cell/);
    assert.match(String(bad({ tests: [{ input: [1], mark: 3 }] })), /the mark must be one of its inks/);
    assert.match(String(bad({ tests: [{ input: [1], ones: 0 }] })), /at least one/);
    assert.match(String(bad({ tests: [{ input: [1] }] })), /a goal, an end, a mark or a count/);
    assert.match(String(bad({ par: { states: 0, steps: 3 } })), /par of states and steps/);
    assert.match(String(bad({ solution: { q0: [] } })), /solution: state q0 must answer/);
    assert.throws(() => loadLevels([good, good]), /listed twice/);
    assert.throws(() => loadLevels([{ ...good, name: '' }]), /needs a name/);
    assert.deepEqual(loadLevels([good]), [good]);
  });

  it('points a wrong program at the first thing wrong, in the words the dancer says', () => {
    const verdict = judge(level('flip'), FLIP_WRONG);
    assert.deepEqual([verdict.solved, verdict.stars, verdict.failed], [false, 0, 0]);
    assert.deepEqual(verdict.tapes[0].miss, { kind: 'cell', cell: 0, want: 2, got: 1 });
    assert.equal(missText(level('flip'), 0, /** @type {any} */ (verdict.tapes[0].miss)), 'On tape 1, cell 1 should be yellow.');
    /** @param {string} id @param {RuleTable} rules */
    const firstMiss = (id, rules) => {
      const v = judge(level(id), rules);
      return missText(level(id), v.failed, /** @type {any} */ (v.tapes[v.failed].miss));
    };
    assert.equal(firstMiss('plus', freshRules(3)), 'On tape 1, cell 3 should be blue.');
    assert.equal(firstMiss('end', freshRules(3)), 'On tape 1, the dancer should finish on cell 5, not cell 1.');
    assert.equal(firstMiss('mirror', freshRules(4)), 'On tape 3, the dancer should halt on red, not blue.');
    assert.equal(firstMiss('bb2', freshRules(2)), 'Only 0 blue on the tape: the goal is 4.', 'one tape: no tape number');
    const runaway = { q0: [{ write: 0, move: 'R', next: 'q0' }, { write: 1, move: 'R', next: 'q0' }, { write: 2, move: 'R', next: 'q0' }] };
    assert.equal(firstMiss('end', /** @type {RuleTable} */ (runaway)), 'On tape 1, the dancer never reached halt in 40 steps: send a rule to halt.');
    // the tape is endless: a cell written left of the input must still be paper
    const left = checkTape({ input: [1], goal: [1] }, { tape: [3, 1], origin: 1, head: 1, halted: true });
    assert.deepEqual(left, { kind: 'cell', cell: -1, want: 0, got: 3 });
    assert.equal(missText(level('coat'), 1, /** @type {any} */ (left)), 'On tape 2, cell 0 should be paper.');
    assert.equal(checkTape({ input: [0], ones: 1 }, { tape: [1], origin: 0, head: 0, halted: true }), null);
    assert.deepEqual(checkTape({ input: [1], goal: [1, 2] }, { tape: [1], origin: 0, head: 0, halted: true }),
      { kind: 'cell', cell: 1, want: 2, got: 0 }, 'a goal past the tape asks for paper the dancer never reached');
    assert.throws(() => judge(level('flip'), BB2), RangeError, 'a program must read the level\'s inks');
  });

  it('grades on a ladder of stars: solved, within par states, within par steps', () => {
    const lv = level('coat');
    assert.equal(starsFor(lv, { solved: false, states: 1, steps: 1 }), 0);
    assert.equal(starsFor(lv, { solved: true, states: 2, steps: 1 }), 1, 'too many states caps at one star');
    assert.equal(starsFor(lv, { solved: true, states: 1, steps: 13 }), 2);
    assert.equal(starsFor(lv, { solved: true, states: 1, steps: 12 }), 3);
    assert.deepEqual([starText(0), starText(2), starText(3)], ['☆☆☆', '★★☆', '★★★']);
    const slow = { q0: [restRule(0), { write: 1, move: 'R', next: 'q0' }, { write: 1, move: 'S', next: 'q0' }] };
    assert.deepEqual(((v) => [v.solved, v.stars, v.steps])(judge(lv, /** @type {RuleTable} */ (slow))), [true, 2, 19], 'stamping then stepping takes longer');
    const spare = { ...level('end').solution, q1: freshRules(3).q0 };
    assert.deepEqual(((v) => [v.solved, v.stars, v.states])(judge(level('end'), spare)), [true, 1, 2], 'an unused state still counts');
    assert.deepEqual([plural(1, 'step'), plural(2, 'tape')], ['1 step', '2 tapes']);
  });

  it('rates each graded run on the shared one-sided Elo ladder', () => {
    const lv = level('flip');
    const e = expected(LADDER.start, lv.difficulty);
    assert.equal(chanceOf({}, lv), e);
    assert.ok(Math.abs(chanceOf({}, lv) - 1 / (1 + 10 ** ((480 - 600) / 400))) < 1e-12);
    const won = rateRun({}, lv, true, false);
    assert.ok(Math.abs(won.delta - 32 * (1 - e)) < 1e-9, 'K is 32 while new');
    assert.deepEqual([won.ratings.branch.n, won.ratings.branch.hist], [1, [1]]);
    assert.ok(Math.abs(won.ratings.branch.r - (600 + 32 * (1 - e))) < 1e-9);
    assert.ok(Math.abs(rateRun({}, lv, true, true).delta - 32 * (0.7 - e)) < 1e-9, 'a hinted solve scores 0.7');
    assert.ok(Math.abs(rateRun({}, lv, false, false).delta - 32 * (0 - e)) < 1e-9);
    const settled = rateRun({ branch: { r: 600, n: 20, hist: [] } }, lv, true, false);
    assert.ok(Math.abs(settled.delta - 16 * (1 - e)) < 1e-9, 'K is 16 after twenty attempts');
    assert.ok(Math.abs(TARGET_SUCCESS - 0.65) < 0.002, 'aiming 108 under the rating is about 65 %');
    assert.equal(chanceOf({ branch: { r: 480, n: 3, hist: [] } }, lv), 0.5);
  });

  it('suggests the unsolved level closest to two-in-three odds', () => {
    assert.equal(suggestLevel({}), 'flip', 'a fresh ladder: 480 is the nearest to 600 − 108');
    assert.equal(suggestLevel(null), 'flip');
    assert.equal(suggestLevel({}, 'flip'), 'bounce', 'never the level being left');
    assert.equal(suggestLevel({ progress: { flip: { solved: true, stars: 1, steps: 9 } } }), 'bounce');
    assert.equal(suggestLevel({ ratings: { branch: { r: 300, n: 5, hist: [] } } }), 'bounce', 'a weak skill pushes its levels out of reach');
    const all = Object.fromEntries(LEVELS.map((l) => [l.id, { solved: true, stars: 3, steps: l.par.steps }]));
    assert.equal(suggestLevel({ progress: all }), null, 'nothing left to improve');
    assert.equal(suggestLevel({ progress: { ...all, sum: { solved: true, stars: 2, steps: 40 } } }), 'sum', 'then the levels short of three stars');
    assert.equal(suggestLevel(/** @type {any} */ ({ progress: { ...all, plus: { solved: true } } })), 'plus', 'a raw save without stars counts none');
  });

  it('hints the rules the reference needs, in the order its dance first fires them', () => {
    assert.deepEqual(firingOrder(level('end')), [{ index: 0, symbol: 1 }, { index: 0, symbol: 2 }, { index: 0, symbol: 0 }]);
    assert.equal(firingOrder(level('end')), firingOrder(level('end')), 'computed once per level');
    assert.deepEqual(firingOrder(level('bb2')).map((f) => [f.index, f.symbol]), [[0, 0], [1, 0], [0, 1], [1, 1]]);
  });
});

describe('playing: editing through act and the HUD grid', () => {
  it('opens on the first level with a resting program', () => {
    const state = dancers.create({ seed: 7, save: null, players: [], options: { lang: 'nl' } });
    assert.equal(state.level, 'end');
    assert.deepEqual(rulesOf(state), freshRules(3));
    assert.equal(state.run.mode, 'idle');
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state, 'the state is plain JSON');
    assert.equal(createState().level, 'end');
    assert.equal(dancers.create({ seed: 1, save: null, players: [], options: { level: 'bb2' } }).level, 'bb2');
    assert.equal(dancers.id, 'dancers');
    assert.equal(dancers.track, 'dancers');
    assert.equal(/** @type {any} */ (dancers).duel, false);
    assert.ok(dancers.camera.target && dancers.camera.target[0] === 0, 'the camera aims at the middle of the tape');
  });

  it('cycles one member of one rule per grid cell', () => {
    let state = dancers.create({ seed: 1, save: null, players: [], options: {} });
    /** @param {string} id */
    const press = (id) => {
      const out = dancers.act(state, { type: 'cell', id });
      state = out.state;
      return out.events;
    };
    assert.equal(sounds(press('q0:1:write'), 'click').length, 1);
    assert.equal(rulesOf(state).q0[1].write, 2, 'blue → yellow');
    press('q0:1:write');
    assert.equal(rulesOf(state).q0[1].write, 0, 'yellow → paper: only the level\'s three inks');
    press('q0:1:write');
    assert.equal(rulesOf(state).q0[1].write, 1);
    press('q0:1:move');
    assert.equal(rulesOf(state).q0[1].move, 'L', 'S → L');
    press('q0:1:move');
    press('q0:1:move');
    assert.equal(rulesOf(state).q0[1].move, 'S', 'through L, R and back to S');
    press('q0:1:next');
    assert.equal(rulesOf(state).q0[1].next, 'q0', 'halt → the first state');
    press('q0:1:next');
    assert.equal(rulesOf(state).q0[1].next, 'halt');
    for (const id of ['q9:1:write', 'q0:7:write', 'q0:1:colour', 'nonsense', 42]) {
      const out = dancers.act(state, { type: 'cell', id });
      assert.equal(out.state, state, `${String(id)} changes nothing`);
      assert.equal(sounds(out.events, 'wrong').length, 1);
      assert.match(/** @type {any} */ (kinds(out.events, 'say')[0]).text, /There is no rule cell/);
    }
  });

  it('sets whole rules, creating the states they name', () => {
    const state = dancers.create({ seed: 1, save: null, players: [], options: { level: 'bb2' } });
    const out = dancers.act(state, { type: 'rule', state: 'q0', symbol: 0, write: 1, move: 'R', next: 'q1' });
    assert.deepEqual(Object.keys(rulesOf(out.state)), ['q0', 'q1']);
    assert.deepEqual(rulesOf(out.state).q1, [restRule(0), restRule(1)], 'a new state rests');
    assert.equal(/** @type {any} */ (sounds(out.events, 'click')[0]).pitch, 1, 'pitched by the ink written');
    const fresh = dancers.act(out.state, { type: 'rule', state: 'q2', symbol: 1, write: 0, move: 'L', next: 'q0' });
    assert.deepEqual(Object.keys(rulesOf(fresh.state)), ['q0', 'q1', 'q2'], 'a rule may belong to a state that did not exist yet');
    /** @type {Array<[Record<string, any>, RegExp]>} */
    const refusals = [
      [{ state: 'halt', symbol: 0, write: 1, move: 'R', next: 'q1' }, /Name the state/],
      [{ state: 'q0', symbol: 2, write: 1, move: 'R', next: 'q1' }, /from 0 to 1/],
      [{ state: 'q0', symbol: 0, write: 2, move: 'R', next: 'q1' }, /write must be an ink/],
      [{ state: 'q0', symbol: 0, write: 1, move: 'jump', next: 'q1' }, /move must be/],
      [{ state: 'q0', symbol: 0, write: 1, move: 'R', next: 'Q!' }, /next must be/],
    ];
    for (const [input, why] of refusals) {
      const refused = dancers.act(out.state, { type: 'rule', ...input });
      assert.equal(refused.state, out.state);
      assert.match(/** @type {any} */ (refused).error, why);
    }
    let full = out.state;
    for (let i = 0; i < MAX_STATES - 2; i++) full = dancers.act(full, { type: 'addState' }).state;
    assert.equal(Object.keys(rulesOf(full)).length, MAX_STATES);
    assert.match(/** @type {any} */ (dancers.act(full, { type: 'rule', state: 'q0', symbol: 0, write: 1, move: 'R', next: 'extra' })).error, /at most 8 states/);
  });

  it('adds and removes states; rules into a removed state halt', () => {
    let state = dancers.create({ seed: 1, save: null, players: [], options: { level: 'bounce' } });
    const added = dancers.act(state, { type: 'addState' });
    assert.equal(sounds(added.events, 'open').length, 1);
    state = dancers.act(added.state, { type: 'rule', state: 'q0', symbol: 0, write: 3, move: 'L', next: 'q1' }).state;
    state = dancers.act(state, { type: 'addState' }).state;
    assert.deepEqual(Object.keys(rulesOf(state)), ['q0', 'q1', 'q2']);
    const removed = dancers.act(state, { type: 'removeState', state: 'q1' });
    assert.deepEqual(Object.keys(rulesOf(removed.state)), ['q0', 'q2']);
    assert.equal(rulesOf(removed.state).q0[0].next, 'halt', 'the rule into q1 halts now');
    assert.equal(sounds(removed.events, 'close').length, 1);
    const last = dancers.act(removed.state, { type: 'removeState' });
    assert.deepEqual(Object.keys(rulesOf(last.state)), ['q0'], 'the HUD button removes the last state');
    assert.equal(dancers.act(last.state, { type: 'addState' }).state.programs.bounce.q1 !== undefined, true, 'the first free name comes back');
    assert.match(/** @type {any} */ (dancers.act(last.state, { type: 'removeState' })).error, /at least one state/);
    assert.match(/** @type {any} */ (dancers.act(last.state, { type: 'removeState', state: 'ghost' })).error, /no state ghost/);
    let full = last.state;
    for (let i = 1; i < MAX_STATES; i++) full = dancers.act(full, { type: 'addState' }).state;
    assert.match(/** @type {any} */ (dancers.act(full, { type: 'addState' })).error, /at most 8 states/);
  });

  it('hints one reference rule at a time and marks the run hinted', () => {
    let state = dancers.create({ seed: 1, save: null, players: [], options: {} });
    const first = dancers.act(state, { type: 'hint' });
    assert.equal(first.state.hinted, true);
    assert.deepEqual(rulesOf(first.state).q0[1], { write: 1, move: 'R', next: 'q0' });
    assert.equal(sounds(first.events, 'chime').length, 1);
    assert.equal(/** @type {any} */ (kinds(first.events, 'say')[0]).text, 'Hint: in q0 reading blue, stamp blue, step right and go to q0.');
    state = dancers.act(first.state, { type: 'hint' }).state;
    assert.deepEqual(rulesOf(state).q0[2], { write: 2, move: 'R', next: 'q0' });
    const done = dancers.act(state, { type: 'hint' });
    assert.equal(done.state, state, 'nothing left to reveal: the rest rule on paper is already right');
    assert.equal(/** @type {any} */ (kinds(done.events, 'say')[0]).text, 'Every rule the dance needs is already right: press Run.');
    const solved = play(dancers, state, [{ act: { type: 'run' } }, ...idle(enough('end'))]);
    assert.equal(solved.state.verdict?.solved, true);
    assert.equal(solved.state.verdict?.hinted, true);
    assert.equal(/** @type {any} */ (solved.events.find((e) => e.kind === 'rate'))?.hinted, true, 'and tells the studio’s ladder so');
    const e = expected(600, 380);
    assert.ok(Math.abs(solved.state.ratings.move.r - (600 + 32 * (0.7 - e))) < 1e-9, 'the ladder scores a hinted solve 0.7');
    // a hint that needs a state the program lacks adds it, named by position
    const beaver = hint(dancers.create({ seed: 1, save: null, players: [], options: { level: 'bb2' } }));
    assert.deepEqual(rulesOf(beaver.state).q0[0], { write: 1, move: 'R', next: 'q1' });
    assert.deepEqual(Object.keys(rulesOf(beaver.state)), ['q0', 'q1']);
    // four hints build the champion, the halting rule last
    let champ = beaver.state;
    for (let i = 0; i < 3; i++) champ = hint(champ).state;
    assert.deepEqual(rulesOf(champ), BB2);
    const last = hint(dancers.act(beaver.state, { type: 'rule', state: 'q1', symbol: 0, write: 1, move: 'L', next: 'q0' }).state);
    assert.equal(/** @type {any} */ (kinds(last.events, 'say')[0]).text, 'Hint: in q0 reading blue, stamp blue, step left and go to q1.');
    const halting = hint(last.state);
    assert.equal(/** @type {any} */ (kinds(halting.events, 'say')[0]).text, 'Hint: in q1 reading blue, stamp blue, step right and halt.');
    // the reference's states map onto this program's by position, whatever their names
    const named = setProgram(dancers.create({ seed: 1, save: null, players: [], options: { level: 'bb2' } }), { a: freshRules(2).q0, b: freshRules(2).q0 }).state;
    assert.deepEqual(rulesOf(hint(named).state).a[0], { write: 1, move: 'R', next: 'b' });
  });

  it('opens levels and moves on to the one the ladder suggests', () => {
    const state = dancers.create({ seed: 1, save: null, players: [], options: {} });
    const opened = dancers.act(state, { type: 'level', id: 'plus' });
    assert.equal(opened.state.level, 'plus');
    assert.deepEqual(kinds(opened.events, 'shot'), [{ kind: 'shot', shot: CAMERA, ms: 700 }]);
    assert.match(/** @type {any} */ (kinds(opened.events, 'say')[0]).text, /^Plus One: /);
    assert.match(/** @type {any} */ (dancers.act(state, { type: 'level', id: 'moon' })).error, /no level called moon/);
    assert.equal(dancers.act(state, { type: 'next' }).state.level, 'flip');
    const all = Object.fromEntries(LEVELS.map((l) => [l.id, { solved: true, stars: 3, steps: l.par.steps }]));
    const finished = { ...dancers.create({ seed: 1, save: null, players: [], options: { level: 'bb3' } }), progress: all };
    assert.equal(followingLevel(finished), 'end', 'with nothing to improve, simply the next level, round again');
    assert.equal(dancers.act(state, { type: 'juggle' }).state, state, 'an unknown action changes nothing');
    assert.equal(dancers.act(state, /** @type {any} */ (null)).state, state);
  });
});

describe('the dance on the beat', () => {
  it('dances a reference solution through play() to a graded success', () => {
    const start = dancers.create({ seed: 1, save: null, players: [], options: { level: 'flip' } });
    const { state, events } = play(dancers, start, [...ruleActs(level('flip').solution), { act: { type: 'run' } }, ...idle(enough('flip'))]);
    assert.equal(state.run.mode, 'done');
    assert.deepEqual(((v) => v && [v.solved, v.stars, v.steps, v.states])(state.verdict), [true, 3, 13, 1]);
    const sparks = events.filter((e) => e.kind === 'fx' && e.fx === 'sparks');
    assert.equal(sparks.length, 10, 'every stamp that changes a cell throws sparks');
    assert.deepEqual(/** @type {any} */ (sparks[0]).colors, [INKS[2]], 'sparks in the new ink');
    assert.equal(sounds(events, 'pop').length, 10, 'and a pop for each');
    assert.deepEqual([...new Set(sounds(events, 'pop').map((e) => /** @type {any} */ (e).pitch))].sort(), [1, 1.26], 'pitched by the ink written');
    assert.equal(sounds(events, 'levelup').length, 1);
    assert.ok(events.some((e) => e.kind === 'fx' && e.fx === 'confetti'));
    assert.ok(events.some((e) => e.kind === 'fx' && e.fx === 'radiance'));
    assert.deepEqual(kinds(events, 'rate'), [{ kind: 'rate', skill: 'branch', correct: true, difficulty: 480, hinted: false }]);
    assert.deepEqual(kinds(events, 'xp'), [{ kind: 'xp', amount: 30, reason: 'Flip ★★★' }]);
    assert.equal(sounds(events, 'right').length, 2, 'a chime for each tape passed before the last');
    assert.equal(/** @type {any} */ (kinds(events, 'say').at(-1)).text, '★★★ Flip in 13 steps with 1 state; par is 13 steps with 1 state.');
    assert.deepEqual(dancers.over(state), { stars: 3, score: 300 - 13, summary: '★★★ Flip in 13 steps with 1 state; par is 13 steps with 1 state.' });
    assert.deepEqual(state.progress.flip, { solved: true, stars: 3, steps: 13 });
    assert.ok(state.ratings.branch.r > 600);
    for (const e of events) if (e.kind === 'sfx') assert.ok(Object.hasOwn(SFX, e.name), `${e.name} is a known sound`);
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
    const again = play(dancers, state, [...ruleActs(level('flip').solution).slice(0, 1), { act: { type: 'run' } }, ...idle(enough('flip'))]);
    assert.deepEqual(again.state.progress.flip, { solved: true, stars: 3, steps: 13 }, 'the best is kept');
  });

  it('knocks the dancer gently and points at the first wrong cell on a miss', () => {
    const { state, events } = play(dancers, withProgram('flip', FLIP_WRONG), [{ act: { type: 'run' } }, ...idle(enough('flip'))]);
    assert.equal(state.run.mode, 'done');
    assert.equal(state.verdict?.solved, false);
    assert.deepEqual(state.verdict?.miss, { kind: 'cell', cell: 0, want: 2, got: 1 });
    assert.deepEqual(kinds(events, 'kick'), [{ kind: 'kick', body: 'dancer', impulse: [-4.5, 5.5] }]);
    assert.equal(sounds(events, 'wrong').length, 1);
    assert.equal(/** @type {any} */ (kinds(events, 'say').at(-1)).text, 'On tape 1, cell 1 should be yellow.');
    assert.deepEqual(kinds(events, 'rate'), [{ kind: 'rate', skill: 'branch', correct: false, difficulty: 480, hinted: false }]);
    assert.equal(dancers.over(state), null);
    assert.ok(state.ratings.branch.r < 600);
    assert.equal(state.progress.flip, undefined);
    assert.equal(dancers.hud(state).toast, 'On tape 1, cell 1 should be yellow.');
    assert.equal(state.run.test, 0, 'the stage stays on the tape that failed');
  });

  it('passes tape after tape with a breath between', () => {
    let state = withProgram('end', level('end').solution);
    state = toggleRun(state).state;
    let events = /** @type {GameEvent[]} */ ([]);
    while (state.run.test === 0) {
      const out = advance(state);
      state = out.state;
      events = out.events;
    }
    assert.equal(sounds(events, 'right').length, 1);
    assert.ok(events.some((e) => e.kind === 'fx' && e.fx === 'stars'));
    assert.deepEqual([state.run.test, state.run.steps, state.run.total, state.run.mode], [1, 0, 5, 'running']);
    assert.ok(state.run.clock < 0, 'a breath before the next tape');
  });

  it('quickens the beat on long dances and goes quiet when it is fast', () => {
    assert.deepEqual([0, 15, 16, 47, 48, 119, 120, 500].map(beatTicks), [15, 15, 8, 8, 4, 4, 1, 1]);
    const state = toggleRun(withProgram('mirror', level('mirror').solution)).state;
    const fast = { ...state, run: { ...state.run, total: 200 } };
    const out = advance(fast);
    assert.equal(out.state.run.steps, 1, 'a beat of one tick steps every tick');
    assert.deepEqual(out.events, [], 'and without a spark or a sound');
    const slow = advance(state);
    assert.deepEqual(slow.events, [
      { kind: 'fx', fx: 'sparks', at: [cellX(level('mirror').tests[0], 0), blockTop(BLANK) + 0.1, 0], colors: ['#fde68a'], count: 10 },
      { kind: 'sfx', name: 'pop', pitch: 0.75 },
    ], 'the first beats stamp aloud: wiping a cell to paper throws sand');
    const restamp = advance(toggleRun(withProgram('end', level('end').solution)).state);
    assert.deepEqual(restamp.events, [{ kind: 'sfx', name: 'click', pitch: 1 }], 'restamping the same ink only clicks');
  });

  it('stops a dance that never halts at the step limit', () => {
    const runaway = { q0: [{ write: 0, move: 'R', next: 'q0' }, { write: 1, move: 'R', next: 'q0' }, { write: 2, move: 'R', next: 'q0' }] };
    const { state } = play(dancers, withProgram('end', /** @type {RuleTable} */ (runaway)), [{ act: { type: 'run' } }, ...idle(enough('end'))]);
    assert.equal(state.run.mode, 'done');
    assert.equal(state.run.steps, 40);
    assert.deepEqual(state.verdict?.miss, { kind: 'halt' });
  });

  it('pauses, steps one at a time, and starts over after a verdict', () => {
    let state = withProgram('coat', level('coat').solution);
    const running = dancers.act(state, { type: 'run' });
    assert.equal(running.state.run.mode, 'running');
    assert.equal(sounds(running.events, 'start').length, 1);
    const paused = dancers.act(running.state, { type: 'run' });
    assert.equal(paused.state.run.mode, 'paused');
    assert.equal(sounds(paused.events, 'stop').length, 1);
    const one = dancers.act(paused.state, { type: 'step' });
    assert.deepEqual([one.state.run.steps, one.state.run.head, one.state.run.fired], [1, 1, { state: 'q0', symbol: 2 }]);
    assert.deepEqual(one.state.run.tape, [1, 2, 2]);
    assert.ok(one.events.some((e) => e.kind === 'fx' && e.fx === 'sparks'));
    const stepped = dancers.act(dancers.act(one.state, { type: 'run' }).state, { type: 'step' });
    assert.deepEqual([stepped.state.run.mode, stepped.state.run.steps], ['paused', 2], 'a step pauses a running dance');
    state = play(dancers, stepped.state, [{ act: { type: 'run' } }, ...idle(enough('coat'))]).state;
    assert.equal(state.verdict?.solved, true);
    const rerun = dancers.act(state, { type: 'run' });
    assert.deepEqual([rerun.state.run.mode, rerun.state.run.test, rerun.state.verdict], ['running', 0, null], 'a finished dance starts over');
    const restep = stepOnce(state);
    assert.deepEqual([restep.state.run.mode, restep.state.run.steps, restep.state.verdict], ['paused', 1, null]);
    const reset = dancers.act(one.state, { type: 'reset' });
    assert.deepEqual([reset.state.run.steps, reset.state.run.mode, reset.state.run.tape], [0, 'idle', [2, 2, 2]]);
    assert.equal(sounds(reset.events, 'whoosh').length, 1);
    const edited = dancers.act(one.state, { type: 'cell', id: 'q0:0:move' });
    assert.deepEqual([edited.state.run.steps, edited.state.run.mode], [0, 'idle'], 'an edit stops the dance and puts the first tape back');
  });

  it('answers keys: act runs or moves on, hint hints, restart resets', () => {
    let state = withProgram('coat', level('coat').solution);
    const go = dancers.step(state, { ...IDLE_INPUT, pressed: ['act', 'left'] }, 1000 / 60);
    assert.equal(go.state.run.mode, 'running');
    assert.equal(go.state.run.steps, 1, 'the first beat comes at once');
    assert.ok(sounds(go.events, 'start').length === 1 && go.events.some((e) => e.kind === 'fx'));
    const hinted = dancers.step(dancers.create({ seed: 1, save: null, players: [], options: {} }), { ...IDLE_INPUT, pressed: ['hint'] }, 16);
    assert.equal(hinted.state.hinted, true);
    const reset = dancers.step(go.state, { ...IDLE_INPUT, pressed: ['restart'] }, 16);
    assert.equal(reset.state.run.mode, 'idle');
    state = play(dancers, go.state, idle(enough('coat'))).state;
    assert.equal(state.verdict?.solved, true);
    assert.equal(dancers.step(state, { ...IDLE_INPUT, pressed: ['act'] }, 16).state.level, 'flip', 'after a solve, act moves on');
  });

  it('leaves a state with nothing to animate untouched', () => {
    const state = dancers.create({ seed: 1, save: null, players: [], options: {} });
    assert.equal(state.run.clock, CLOCK_REST);
    assert.equal(advance(state).state, state);
    assert.equal(dancers.step(state, IDLE_INPUT, 16).state, state);
    const stepped = stepOnce(state).state;
    assert.equal(stepped.run.clock, 0);
    assert.equal(advance(stepped).state.run.clock, 1, 'the hop clock runs after a manual step');
  });
});

describe('the tools', () => {
  const validator = new JarenValidator({ collectErrors: true });
  /** @param {string} name */
  const toolOf = (name) => /** @type {import('../../packages/website/src/os/games/game.js').GameTool} */ (TOOLS.find((t) => t.name === name));
  /** @param {string} name @param {any} input */
  const valid = (name, input) => {
    const verdict = /** @type {any} */ (validator.compile(toolOf(name).inputSchema))(input);
    return verdict === true || verdict?.valid === true;
  };
  /** @param {DancersState} state @param {string} name @param {any} input */
  const call = (state, name, input) => {
    assert.ok(valid(name, input), `${name} accepts ${JSON.stringify(input)}`);
    return toolOf(name).run(state, input);
  };

  it('describe themselves with schemas the arcade validates against', () => {
    assert.deepEqual(TOOLS.map((t) => t.name), ['dancers_level', 'dancers_rule', 'dancers_program', 'dancers_run']);
    assert.equal(dancers.tools, TOOLS);
    for (const tool of TOOLS) assert.ok(tool.description.length > 40 && tool.inputSchema.type === 'object', tool.name);
    assert.ok(valid('dancers_level', {}) && valid('dancers_level', { id: 'bb3' }));
    assert.ok(!valid('dancers_level', { id: 'moon' }) && !valid('dancers_level', { level: 'bb3' }));
    assert.ok(valid('dancers_rule', { state: 'q0', symbol: 0, write: 1, move: 'R', next: 'halt' }));
    assert.ok(!valid('dancers_rule', { state: 'q0', symbol: 0, write: 1, move: 'X', next: 'halt' }));
    assert.ok(!valid('dancers_rule', { state: 'halt', symbol: 0, write: 1, move: 'R', next: 'q1' }), 'halt is not a state to program');
    assert.ok(!valid('dancers_rule', { state: 'q0', symbol: 0, write: 1, move: 'R' }), 'every member is required');
    assert.ok(valid('dancers_program', { rules: BB2 }) && !valid('dancers_program', { rules: { q0: [{ write: 1 }] } }));
    assert.ok(valid('dancers_run', {}) && !valid('dancers_run', { fast: true }));
  });

  it('reads the level, its tapes and the program, and opens another', () => {
    const state = dancers.create({ seed: 1, save: null, players: [], options: {} });
    const read = call(state, 'dancers_level', {});
    assert.equal(read.state, state, 'reading changes nothing');
    assert.equal(read.result.ok, true);
    assert.equal(read.result.level.id, 'end');
    assert.deepEqual(read.result.level.inks, [{ symbol: 0, name: 'paper' }, { symbol: 1, name: 'blue' }, { symbol: 2, name: 'yellow' }]);
    assert.deepEqual(read.result.level.tapes[0], { tape: 1, input: [1, 2, 2, 1], goal: [1, 2, 2, 1], end: 4, head: 0 });
    assert.deepEqual(read.result.rules, freshRules(3));
    assert.equal(read.result.programChars, programChars(freshRules(3)));
    assert.equal(read.result.levels.length, 12);
    assert.match(read.result.how, /dancers_rule/);
    const opened = call(state, 'dancers_level', { id: 'bb2' });
    assert.equal(opened.state.level, 'bb2');
    assert.equal(opened.result.level.goal, level('bb2').prompt);
    assert.ok(opened.events && sounds(opened.events, 'whoosh').length === 1);
    const same = call(state, 'dancers_level', { id: 'end' });
    assert.equal(same.state, state, 'naming the open level only reads it');
    const lost = toolOf('dancers_level').run(state, { id: 'moon' });
    assert.deepEqual([lost.state, lost.result.ok], [state, false], 'a call that skipped validation is still refused');
  });

  it('builds the BB-2 champion rule by rule, then grades it', () => {
    let state = dancers.create({ seed: 1, save: null, players: [], options: { level: 'bb2' } });
    for (const [s, row] of Object.entries(BB2)) {
      for (const [symbol, rule] of row.entries()) {
        const out = call(state, 'dancers_rule', { state: s, symbol, ...rule });
        assert.equal(out.result.ok, true);
        assert.deepEqual(out.result.row.rules[symbol], rule);
        state = out.state;
      }
    }
    assert.deepEqual(rulesOf(state), BB2);
    const graded = call(state, 'dancers_run', {});
    assert.deepEqual([graded.result.solved, graded.result.stars, graded.result.steps, graded.result.states], [true, 3, 6, 2]);
    assert.equal(graded.result.tapes[0].cells.filter((/** @type {number} */ s) => s === 1).length, 4);
    assert.deepEqual([graded.result.tapes[0].offset, graded.result.tapes[0].head, graded.result.tapes[0].problem], [2, 0, null]);
    assert.ok(graded.events && kinds(graded.events, 'rate').length === 1 && sounds(graded.events, 'levelup').length === 1);
    assert.equal(graded.state.run.mode, 'done');
    const board = call(graded.state, 'dancers_level', {}).result;
    assert.deepEqual([board.best, board.levels.find((/** @type {any} */ l) => l.id === 'bb2').stars], [{ solved: true, stars: 3, steps: 6 }, 3]);
    assert.deepEqual(dancers.over(graded.state), { stars: 3, score: 294, summary: graded.result.summary });
    const refused = call(state, 'dancers_rule', { state: 'q0', symbol: 1, write: 3, move: 'R', next: 'q1' });
    assert.deepEqual([refused.state, refused.result.ok], [state, false], 'a two-ink level has no red');
    assert.match(refused.result.error, /write must be an ink from 0 to 1/);
  });

  it('sets the whole table in one call, and says how big that call was', () => {
    const state = dancers.create({ seed: 1, save: null, players: [], options: { level: 'bb3' } });
    const input = { rules: level('bb3').solution };
    const out = call(state, 'dancers_program', input);
    assert.deepEqual([out.result.ok, out.result.states], [true, ['q0', 'q1', 'q2']]);
    assert.equal(out.result.programChars, JSON.stringify(input).length);
    assert.notEqual(rulesOf(out.state), input.rules, 'the table is copied, never aliased');
    assert.equal(call(out.state, 'dancers_run', {}).result.stars, 3);
    const wrong = call(state, 'dancers_program', { rules: { q0: [restRule(0), restRule(1), restRule(2)] } });
    assert.equal(wrong.result.ok, false, 'three inks do not fit a two-ink level');
    assert.equal(wrong.state, state);
  });

  it('reports a failed run tape by tape, and shows the tape that failed', () => {
    const state = withProgram('flip', FLIP_WRONG);
    const out = call(state, 'dancers_run', {});
    assert.equal(out.result.solved, false);
    assert.deepEqual(out.result.tapes.map((/** @type {any} */ t) => t.passed), [false, true, false]);
    assert.equal(out.result.tapes[0].problem, 'On tape 1, cell 1 should be yellow.');
    assert.equal(out.result.tapes[1].problem, null);
    assert.equal(out.result.summary, 'On tape 1, cell 1 should be yellow.');
    assert.deepEqual([out.state.run.mode, out.state.run.test, out.state.run.total], ['done', 0, 0]);
    const late = runAll(withProgram('copy', { ...level('copy').solution, q1: level('copy').solution.q0 }));
    assert.deepEqual([late.verdict.failed, late.state.run.test, late.state.run.total], [1, 1, 5], 'the stage counts the steps of the tapes before');
  });
});

describe('the stage', () => {
  const themes = Object.keys(STAGE_THEMES);

  it('draws the tape, the ghost goal, the dancer and its sign in every theme', () => {
    assert.ok(themes.includes('light') && themes.includes('dark'));
    const state = dancers.create({ seed: 1, save: null, players: [], options: { level: 'flip' } });
    for (const theme of themes) {
      for (const light of [null, createLighting({ hour: 10 }), createLighting({ hour: 23 })]) {
        const drawn = dancers.draw(state, ctxOf(theme, { light }));
        assert.ok(drawn.items.length > 60, `${theme}: a stage full of blocks`);
        assert.deepEqual(drawn.figures?.map((f) => f.id), ['dancer']);
        assert.equal(typeof drawn.figures?.[0].pose.lean, 'number', 'the ragdoll is asked for a pose');
        const texts = drawn.items.filter((i) => i.t === 'text').map((i) => /** @type {any} */ (i).text);
        assert.ok(texts.includes('q0'), 'the sign names the control state');
        assert.ok(['1', '2', '3', '4'].every((n) => texts.includes(n)), 'the cells are numbered');
        assert.ok(texts.includes('tape 1 of 3 · step 0 · par 13'));
        assert.ok(drawn.items.some((i) => i.a !== undefined && Math.abs(i.a - 0.38) < 1e-9), 'the goal stands behind as a ghost row');
      }
    }
  });

  it('keeps to the palette: no pink and no purple anywhere', () => {
    const state = play(dancers, withProgram('mirror', level('mirror').solution), [{ act: { type: 'run' } }, ...idle(30)]).state;
    for (const theme of themes) {
      for (const light of [null, createLighting({ hour: 10 }), createLighting({ hour: 19 }), createLighting({ hour: 23 })]) {
        for (const item of dancers.draw(state, ctxOf(theme, { light })).items) {
          for (const colour of [/** @type {any} */ (item).fill, /** @type {any} */ (item).stroke]) {
            if (typeof colour !== 'string' || !colour.startsWith('#')) continue;
            const hue = hueOf(colour);
            assert.ok(hue === null || hue < 260 || hue > 345, `${theme} at ${light?.hour ?? 'no light'}: ${colour}`);
          }
        }
      }
    }
    for (const colour of [...INKS, DANCER_COLOR]) assert.ok(hueOf(colour) === null || /** @type {number} */ (hueOf(colour)) < 260);
  });

  it('draws the ragdoll body when the arcade simulates one', () => {
    const state = dancers.create({ seed: 1, save: null, players: [], options: {} });
    const posed = dancers.draw(state, ctxOf('light'));
    const limp = dancers.draw(state, ctxOf('light', { bodies: { dancer: skeleton(POSES.tumble) } }));
    assert.notDeepEqual(limp.items, posed.items, 'a tumbling body draws differently');
    assert.equal(limp.items.length, posed.items.length);
  });

  it('hops between cells on the beat and radiates while it dances', () => {
    const state = toggleRun(withProgram('coat', level('coat').solution)).state;
    const mid = advance(state).state;
    assert.equal(mid.run.steps, 1);
    const soon = dancers.draw(mid, ctxOf('light'));
    const later = dancers.draw({ ...mid, run: { ...mid.run, clock: 5 } }, ctxOf('light'));
    assert.notDeepEqual(soon.items, later.items, 'the dancer moves through the hop');
    const still = dancers.draw({ ...mid, run: { ...mid.run, mode: 'paused' } }, ctxOf('light'));
    const lines = (/** @type {any[]} */ items) => items.filter((i) => i.t === 'line').length;
    assert.ok(lines(soon.items) > lines(still.items), 'motion marks while it dances');
    const reducedA = dancers.draw(mid, ctxOf('light', { reduce: true, time: 0 }));
    const reducedB = dancers.draw(mid, ctxOf('light', { reduce: true, time: 5000 }));
    assert.deepEqual(reducedA.items, reducedB.items, 'under reduced motion the frame is a still: the clock moves nothing');
    assert.notDeepEqual(dancers.draw(mid, ctxOf('light', { time: 0 })).items, dancers.draw(mid, ctxOf('light', { time: 5000 })).items, 'otherwise the sunburst turns');
    const idleA = dancers.draw(createState(), ctxOf('light', { time: 0 }));
    const idleB = dancers.draw(createState(), ctxOf('light', { time: 700 }));
    assert.notDeepEqual(idleA.figures?.[0].pose, idleB.figures?.[0].pose, 'a waiting dancer sways');
    const calm = dancers.draw(createState(), ctxOf('light', { reduce: true }));
    assert.deepEqual(calm.figures?.[0].pose, POSES.dance, 'and stands still under reduced motion');
  });

  it('cheers a solve, bows after a miss and rings the first wrong cell', () => {
    const won = play(dancers, withProgram('flip', level('flip').solution), [{ act: { type: 'run' } }, ...idle(enough('flip'))]).state;
    assert.deepEqual(dancers.draw(won, ctxOf('light')).figures?.[0].pose, POSES.jubilant);
    const lost = play(dancers, withProgram('flip', FLIP_WRONG), [{ act: { type: 'run' } }, ...idle(enough('flip'))]).state;
    const drawn = dancers.draw(lost, ctxOf('dark'));
    assert.deepEqual(drawn.figures?.[0].pose, POSES.bow);
    const rings = drawn.items.filter((i) => i.t === 'poly' && /** @type {any} */ (i).stroke === '#ef4444' && /** @type {any} */ (i).fill === null);
    assert.equal(rings.length, 2, 'the wrong cell is ringed on the tape and on the ghost row');
    const late = play(dancers, withProgram('end', freshRules(3)), [{ act: { type: 'run' } }, ...idle(40)]).state;
    assert.equal(late.verdict?.miss?.kind, 'end');
    const lateRings = dancers.draw(late, ctxOf('light')).items.filter((i) => /** @type {any} */ (i).stroke === '#ef4444');
    assert.equal(lateRings.length, 2, 'a wrong finish rings the cell to finish on');
    const beaver = play(dancers, withProgram('bb2', freshRules(2)), [{ act: { type: 'run' } }, ...idle(40)]).state;
    assert.equal(dancers.draw(beaver, ctxOf('light')).items.filter((i) => /** @type {any} */ (i).stroke === '#ef4444').length, 0, 'a count has no cell to ring');
  });

  it('says on the stage what a ghost row cannot show', () => {
    /** @param {string} id */
    const texts = (id) => dancers.draw(createState({ options: { level: id } }), ctxOf('light')).items
      .filter((i) => i.t === 'text').map((i) => /** @type {any} */ (i).text);
    assert.ok(texts('end').includes('finish on cell 5'));
    assert.ok(texts('mirror').includes('this tape answers blue'));
    assert.ok(texts('bb2').includes('4 blue or more'));
    assert.ok(texts('bb2').includes('step 0 · par 6'), 'one tape: no tape count');
    assert.ok(!texts('flip').some((t) => t.includes('finish')));
  });

  it('shows the cells the tape grew, numbered from the input', () => {
    const champ = play(dancers, withProgram('bb2', BB2), [{ act: { type: 'run' } }, ...idle(enough('bb2'))]).state;
    assert.deepEqual([champ.run.origin, champ.run.tape], [2, [1, 1, 1, 1]]);
    const texts = dancers.draw(champ, ctxOf('neon')).items.filter((i) => i.t === 'text').map((i) => /** @type {any} */ (i).text);
    assert.ok(['-1', '0', '1', '2'].every((n) => texts.includes(n)), 'cells left of the input count down past 1');
    assert.equal(dancers.draw, draw);
    assert.equal(dancers.hud, hud);
  });

  it('stands the dancer on the block under the head', () => {
    const state = createState({ options: { level: 'plus' } });
    assert.deepEqual(dancerPoint(level('plus'), state.run), [cellX(level('plus').tests[0], 1), blockTop(1), 0]);
    assert.deepEqual([blockTop(BLANK) < blockTop(1), blockTop(1) < blockTop(2), blockTop(2) < blockTop(3)], [true, true, true], 'every ink stands taller');
    assert.equal(cellX({ input: [1, 2, 3] }, 1), 0, 'the input is centred on the stage');
  });
});

describe('the HUD', () => {
  it('shows the level, the goal, the score, the buttons and a meter of steps against par', () => {
    const state = dancers.create({ seed: 1, save: null, players: [], options: {} });
    const view = dancers.hud(state);
    assert.equal(view.title, 'Find the End · Chalk');
    assert.equal(view.level, 'Level 1 · Chalk');
    assert.equal(view.prompt, `${level('end').prompt} (3 tapes)`);
    assert.equal(view.score, '☆☆☆ · par 15 steps');
    assert.deepEqual(view.buttons?.map((b) => b.id), ['run', 'step', 'reset', 'hint', 'addState', 'next']);
    assert.deepEqual(view.meter, { label: 'Steps 0 / par 15', value: 0 });
    assert.equal(view.toast, null);
    assert.match(String(view.help), /★★ with 1 state or fewer · ★★★ also in 15 steps or fewer/);
    assert.equal(dancers.hud(createState({ options: { level: 'bounce' } })).level, 'Level 4 · Spray');
    const more = dancers.act(state, { type: 'addState' }).state;
    assert.deepEqual(dancers.hud(more).buttons?.at(-2), { id: 'removeState', label: 'Remove q1' });
    const running = toggleRun(state).state;
    assert.equal(dancers.hud(running).buttons?.[0].label, 'Pause');
  });

  it('lays the rule table out as the grid, lighting the rule that just fired', () => {
    const state = withProgram('end', level('end').solution);
    const grid = /** @type {NonNullable<ReturnType<typeof hud>['grid']>} */ (dancers.hud(state).grid);
    assert.deepEqual(grid.columns, ['paper ink', 'paper step', 'paper next', 'blue ink', 'blue step', 'blue next', 'yellow ink', 'yellow step', 'yellow next']);
    assert.equal(grid.rows.length, 1);
    assert.equal(grid.rows[0].label, 'q0 · start');
    assert.deepEqual(grid.rows[0].cells.slice(3, 6), [
      { id: 'q0:1:write', text: 'blue', swatch: INKS[1], active: false },
      { id: 'q0:1:move', text: 'R', active: false },
      { id: 'q0:1:next', text: 'q0', active: false },
    ]);
    const stepped = stepOnce(state).state;
    const lit = dancers.hud(stepped).grid?.rows[0].cells.filter((c) => c.active).map((c) => c.id);
    assert.deepEqual(lit, ['q0:1:write', 'q0:1:move', 'q0:1:next']);
    const two = ruleGrid(level('bb2'), BB2, { state: 'q1', symbol: 0 });
    assert.deepEqual(two.rows.map((r) => r.label), ['q0 · start', 'q1']);
    assert.equal(two.rows[1].cells.filter((c) => c.active).length, 3);
    const beaver = withProgram('bb2', BB2);
    for (const cell of two.rows.flatMap((r) => r.cells)) {
      const moved = dancers.act(beaver, { type: 'cell', id: cell.id });
      assert.equal(/** @type {any} */ (moved).error, undefined, `${cell.id} is a cell the game answers`);
      assert.notDeepEqual(rulesOf(moved.state), BB2, `${cell.id} changes its rule`);
    }
  });

  it('puts the stars up after a solve and keeps the best after a miss', () => {
    const won = play(dancers, withProgram('coat', level('coat').solution), [{ act: { type: 'run' } }, ...idle(enough('coat'))]).state;
    const view = dancers.hud(won);
    assert.equal(view.score, '★★★ · 12 steps');
    assert.deepEqual(view.buttons?.filter((b) => b.primary).map((b) => b.id), ['next']);
    assert.equal(view.buttons?.[0].label, 'Run again');
    assert.deepEqual(view.meter, { label: 'Steps 12 / par 12', value: 1 });
    const missed = play(dancers, won, [{ act: { type: 'cell', id: 'q0:2:write' } }, { act: { type: 'run' } }, ...idle(enough('coat'))]).state;
    assert.equal(missed.verdict?.solved, false);
    assert.equal(dancers.hud(missed).score, 'Best ★★★ · 12 steps');
  });
});

describe('saving', () => {
  it('keeps the level, every program, the best results and the ladder, and moves on from a solve', () => {
    const won = play(dancers, withProgram('end', level('end').solution), [{ act: { type: 'run' } }, ...idle(enough('end'))]).state;
    const save = dancers.save(won);
    assert.deepEqual([save.v, save.level, save.next], [1, 'end', 'flip']);
    assert.deepEqual(save.progress, { end: { solved: true, stars: 3, steps: 15 } });
    assert.ok(save.ratings.move.r > LADDER.start);
    const restored = dancers.create({ seed: 2, save: JSON.parse(JSON.stringify(save)), players: [], options: {} });
    assert.equal(restored.level, 'flip', 'a game started again after a solve opens the next level');
    assert.deepEqual(restored.programs.end, level('end').solution);
    assert.deepEqual(restored.progress, save.progress);
    assert.deepEqual(restored.ratings, save.ratings);
    assert.equal(createState({ save: { ...save, next: null } }).level, 'end');
    assert.equal(saveOf(restored).next, null, 'no solve on stage, nowhere to move on to');
  });

  it('drops whatever in a save does not check out', () => {
    const save = {
      level: 'moon',
      programs: { end: { q0: 'junk' }, moon: level('end').solution, flip: level('flip').solution },
      progress: { end: { solved: true, stars: 9, steps: -3 }, flip: { solved: false, stars: 1, steps: 3 }, moon: { solved: true, stars: 1, steps: 1 }, coat: 'x' },
      ratings: { move: 'fast' },
    };
    const state = createState({ save });
    assert.equal(state.level, 'end');
    assert.deepEqual(rulesOf(state), freshRules(3));
    assert.deepEqual(Object.keys(state.programs).sort(), ['end', 'flip']);
    assert.deepEqual(state.progress, { end: { solved: true, stars: 3, steps: 0 } });
    assert.deepEqual(state.ratings, {});
    for (const junk of [null, 'save', 42, { programs: 'x', progress: null }]) assert.equal(createState({ save: junk }).level, 'end');
  });
});

describe('the alphabet', () => {
  it('names its inks and steps as the HUD and the hints say them', () => {
    assert.deepEqual(INK_NAMES, ['paper', 'blue', 'yellow', 'red']);
    assert.deepEqual([...MOVES], ['L', 'R', 'S']);
    assert.equal(INKS[0], '#fffdf6', 'paper is the OS paper');
  });
});
