//@ts-check
/**
 * The council: who sits in it, what each member proposes, and how the
 * members judge one another's proposals.
 *
 * Radiant OS is governed as a meritocracy with a human veto. Every
 * member has one taste (`metrics.js`) and a merit — the weight of its
 * vote. A session asks every seat for one amendment, lets every member
 * judge every amendment by SIMULATING it (the same tape unit, the same
 * compiled program, a few hundred steps ahead) against the status quo,
 * and tallies the judgements by merit. The winner then waits for the
 * human, who may always refuse it; the workflow document
 * (`council.workflow.json`) owns that order, the merit document
 * (`merit.dag.json`) owns the arithmetic of reward. This module only
 * supplies the members' judgement — host code a task node calls.
 *
 * Everything is deterministic for a given session seed: proposals draw
 * from `mulberry32`, never from `Math.random`, so a replayed session
 * proposes and votes exactly as it did.
 */

import { mulberry32, randomInt } from '@jarenjs/core/random';
import { compileMachine, stepWorld, mirrorWorld, clearWorld } from './machine.js';
import { measure } from './metrics.js';
import { SYMBOLS, TURNS, programStates, rulePointer } from './program.js';
import { applyJSONPatch } from '@jarenjs/json/patch';

/**
 * @typedef {import('./machine.js').World} World
 * @typedef {'balance' | 'symmetry' | 'structure' | 'motion' | 'harmony'} Taste
 * @typedef {{ id: string, name: string, taste: Taste | null, ink: number, figure: 'person' | 'tv' | 'baby', pose: string, motto: string }} Member
 * @typedef {{ kind: 'rule', state: string, symbol: number, member: 'write' | 'turn' | 'next', value: string | number }
 *   | { kind: 'tape', op: 'mirror' | 'clear' }
 *   | { kind: 'tempo', tempo: number }} Change
 * @typedef {{ id: string, by: string, title: string, why: string, change: Change }} Proposal
 * @typedef {{ voter: string, proposal: string, vote: number }} Ballot
 */

/** The seats, in totem order. `ink` is the palette index the member
 * wears; the human wears the orange no tape symbol uses. */
export const MEMBERS = /** @type {readonly Member[]} */ (Object.freeze([
  { id: 'painter', name: 'Painter', taste: 'balance', ink: 1, figure: 'person', pose: 'jubilant',
    motto: 'every colour gets the floor' },
  { id: 'dancer', name: 'Dancer', taste: 'motion', ink: 2, figure: 'person', pose: 'dance',
    motto: 'leave footprints, not a flood' },
  { id: 'critic', name: 'Critic', taste: 'structure', ink: 3, figure: 'person', pose: 'kick',
    motto: 'draw lines, not noise' },
  { id: 'architect', name: 'Architect', taste: 'symmetry', ink: 4, figure: 'person', pose: 'lift',
    motto: 'what stands on one side stands on the other' },
  { id: 'oracle', name: 'Oracle', taste: 'harmony', ink: 5, figure: 'tv', pose: 'dance',
    motto: 'the language model in the room — it proposes, the documents decide' },
  { id: 'human', name: 'You', taste: null, ink: -1, figure: 'baby', pose: 'crawl',
    motto: 'the veto is yours, always' },
]));

/** The members that dance on the tape: every seat with a taste and a body
 * on the floor. The oracle watches from its plinth; the human holds the veto. */
export const DANCERS = /** @type {readonly string[]} */ (['painter', 'dancer', 'critic', 'architect']);

/** How many steps a member looks ahead when it judges an amendment. */
export const LOOKAHEAD = 240;

/** A vote is the voter's taste delta over the look-ahead, scaled so a
 * swing of this size is a full yes (or no). */
const VOTE_SCALE = 0.08;

/** Tempo bounds a tempo amendment may ask for, in steps per second. */
export const TEMPO_MIN = 2;
export const TEMPO_MAX = 30;

/** True when a value is a tempo an amendment could have set.
 * @param {unknown} tempo */
export const isTempo = (tempo) => Number.isInteger(tempo) && /** @type {number} */ (tempo) >= TEMPO_MIN && /** @type {number} */ (tempo) <= TEMPO_MAX;

/**
 * Apply one change to a program and a world — the semantics every
 * proposal, simulation and enactment share. Returns the new program,
 * the new world, the RFC 6902 patch applied to the program (empty for
 * tape and tempo changes) and its inverse, which is what a repeal runs.
 * @param {{ machine: any, tempo: number }} program
 * @param {World} world
 * @param {Change} change
 */
export function applyChange(program, world, change) {
  if (change.kind === 'rule') {
    const states = programStates(program.machine);
    const path = rulePointer(states, change.state, change.symbol, change.member);
    const before = readPointer(program.machine, path);
    const patch = [{ op: 'replace', path, value: change.value }];
    const inverse = [{ op: 'replace', path, value: before }];
    const machine = applyJSONPatch(program.machine, patch);
    return { program: { ...program, machine }, world, patch, inverse };
  }
  if (change.kind === 'tempo') {
    const tempo = Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, Math.round(change.tempo)));
    return { program: { ...program, tempo }, world, patch: [], inverse: [] };
  }
  const next = change.op === 'mirror' ? mirrorWorld(world) : clearWorld(world);
  return { program, world: next, patch: [], inverse: [] };
}

/**
 * True when a change names only what the program has: a rule change's
 * state, and the state a `next` change points at. The contract's schema
 * cannot know the program's states, so every road a proposal takes in —
 * `council.propose`, the oracle seam, the queue a session picks up, the
 * enactment — asks this before the change touches a simulation.
 * @param {Change} change
 * @param {any} machine - the program document
 */
export function fitsProgram(change, machine) {
  if (change.kind !== 'rule') return true;
  const states = programStates(machine);
  return states.includes(change.state) && (change.member !== 'next' || states.includes(String(change.value)));
}

/** Resolve a JSON Pointer the program layout guarantees exists.
 * @param {any} doc @param {string} pointer */
function readPointer(doc, pointer) {
  let at = doc;
  for (const raw of pointer.split('/').slice(1)) at = at[raw.replace(/~1/g, '/').replace(/~0/g, '~')];
  return at;
}

/**
 * Run the status quo and a change side by side for the look-ahead and
 * measure both. Simulation steps the SAME compiled machine the screen
 * runs; a rule change recompiles once (memoized by document identity).
 * @param {{ machine: any, tempo: number }} program
 * @param {World} world
 * @param {Change} change
 * @param {number} [steps]
 */
export function simulate(program, world, change, steps = LOOKAHEAD) {
  const base = stepWorld(compileMachine(program.machine), world, steps).world;
  const changed = applyChange(program, world, change);
  // a tempo change does not alter what a step does, only how often one
  // happens: judge it over the steps the new tempo fits into the same time
  const ratio = change.kind === 'tempo' ? changed.program.tempo / program.tempo : 1;
  const after = stepWorld(compileMachine(changed.program.machine), changed.world,
    Math.max(1, Math.round(steps * ratio))).world;
  // liveliness is judged against where each future started from, so a
  // one-shot tape change is not mistaken for the machine's own motion
  return { before: measure(base, world.tape), after: measure(after, changed.world.tape) };
}

/** A member's vote on a simulated outcome, in [-1, 1].
 * @param {Member} member
 * @param {{ before: Record<string, number>, after: Record<string, number> }} outcome */
export function voteOf(member, outcome) {
  if (member.taste === null) return 0;
  const delta = outcome.after[member.taste] - outcome.before[member.taste];
  return Math.max(-1, Math.min(1, delta / VOTE_SCALE));
}

/** A readable name for a symbol, for titles and the rule table. */
export const SYMBOL_NAMES = Object.freeze(['paper', 'blue', 'amber', 'red', 'green', 'cyan']);

/** A readable name for a turn. */
export const TURN_NAMES = Object.freeze({ L: 'turn left', R: 'turn right', U: 'turn around', N: 'go straight' });

/**
 * The title a proposal carries on its sign.
 * @param {Change} change
 */
export function describeChange(change) {
  if (change.kind === 'tape') return change.op === 'mirror' ? 'Fold the floor in half' : 'Wash the floor clean';
  if (change.kind === 'tempo') return `Dance at ${change.tempo} steps a second`;
  const when = `when ${change.state} reads ${SYMBOL_NAMES[change.symbol]}`;
  if (change.member === 'write') return `${cap(when)}, paint ${SYMBOL_NAMES[/** @type {number} */ (change.value)]}`;
  if (change.member === 'turn') return `${cap(when)}, ${TURN_NAMES[/** @type {'L'} */ (change.value)]}`;
  return `${cap(when)}, become ${change.value}`;
}

/** @param {string} s */
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Draw candidate changes for one member: a handful of single-rule
 * edits, plus the one-shot the member's temperament reaches for.
 * @param {Member} member
 * @param {{ machine: any, tempo: number }} program
 * @param {() => number} random
 * @param {number} count
 * @returns {Change[]}
 */
export function candidates(member, program, random, count = 6) {
  const states = programStates(program.machine);
  /** @type {Change[]} */
  const out = [];
  for (let i = 0; i < count; i++) {
    const state = states[randomInt(random, 0, states.length)];
    const symbol = randomInt(random, 0, SYMBOLS);
    const roll = random();
    if (member.id === 'painter' || (roll < 0.45 && member.id !== 'dancer')) {
      out.push({ kind: 'rule', state, symbol, member: 'write', value: randomInt(random, 0, SYMBOLS) });
    }
    else if (member.id === 'dancer' || roll < 0.85) {
      out.push({ kind: 'rule', state, symbol, member: 'turn', value: TURNS[randomInt(random, 0, TURNS.length)] });
    }
    else {
      out.push({ kind: 'rule', state, symbol, member: 'next', value: states[randomInt(random, 0, states.length)] });
    }
  }
  if (member.id === 'architect') out.push({ kind: 'tape', op: 'mirror' });
  if (member.id === 'critic') out.push({ kind: 'tape', op: 'clear' });
  if (member.id === 'dancer') {
    out.push({ kind: 'tempo', tempo: Math.min(TEMPO_MAX, program.tempo + 4) });
    out.push({ kind: 'tempo', tempo: Math.max(TEMPO_MIN, program.tempo - 4) });
  }
  return out;
}

/** True when a change would leave the program exactly as it is. */
function isNoop(program, change) {
  if (change.kind !== 'rule') return change.kind === 'tempo' && change.tempo === program.tempo;
  const path = rulePointer(programStates(program.machine), change.state, change.symbol, change.member);
  return readPointer(program.machine, path) === change.value;
}

/**
 * One member's proposal for this session: the candidate that best
 * serves its own taste WITHOUT costing the shared harmony — a member
 * that only ever helped itself would be outvoted, and its merit would
 * wither, so the score it maximizes weighs both. `null` when nothing
 * it can think of helps.
 * @param {Member} member
 * @param {{ machine: any, tempo: number }} program
 * @param {World} world
 * @param {number} seed - the session seed; each member draws its own stream
 * @returns {Proposal | null}
 */
export function propose(member, program, world, seed) {
  if (member.taste === null) return null;
  const random = mulberry32((seed ^ hashString(member.id)) >>> 0);
  let best = null;
  let bestScore = 0;
  for (const change of candidates(member, program, random)) {
    if (isNoop(program, change)) continue;
    const outcome = simulate(program, world, change);
    const own = outcome.after[member.taste] - outcome.before[member.taste];
    const shared = outcome.after.harmony - outcome.before.harmony;
    const score = 0.6 * own + 0.4 * shared;
    if (score > bestScore) { bestScore = score; best = { change, outcome }; }
  }
  if (best === null) return null;
  const own = best.outcome.after[member.taste] - best.outcome.before[member.taste];
  return {
    id: `${member.id}-${seed.toString(36)}`,
    by: member.id,
    title: describeChange(best.change),
    why: `${member.name} foresees ${member.taste} ${signed(own)} and harmony `
      + `${signed(best.outcome.after.harmony - best.outcome.before.harmony)} over ${LOOKAHEAD} steps.`,
    change: best.change,
  };
}

/** @param {number} v */
const signed = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}`;

/**
 * Every voting member's judgement of every proposal. The proposer
 * judges its own proposal like anyone else — by simulation, not by
 * pride — and the human casts no automatic vote (a cheer, when given,
 * arrives as its own ballot).
 * @param {readonly Proposal[]} proposals
 * @param {{ machine: any, tempo: number }} program
 * @param {World} world
 * @returns {{ ballots: Ballot[], outcomes: Record<string, { before: any, after: any }> }}
 */
export function deliberate(proposals, program, world) {
  /** @type {Ballot[]} */
  const ballots = [];
  /** @type {Record<string, { before: any, after: any }>} */
  const outcomes = {};
  for (const proposal of proposals) {
    const outcome = simulate(program, world, proposal.change);
    outcomes[proposal.id] = outcome;
    for (const member of MEMBERS) {
      if (member.taste === null) continue;
      ballots.push({ voter: member.id, proposal: proposal.id, vote: round3(voteOf(member, outcome)) });
    }
  }
  return { ballots, outcomes };
}

/** @param {number} v */
const round3 = (v) => Math.round(v * 1000) / 1000;

/** A stable 32-bit hash of a string (FNV-1a), for per-member seeds.
 * @param {string} text */
export function hashString(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
