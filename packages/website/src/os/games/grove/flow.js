//@ts-check
/**
 * The flow of play in Monkey Grove: the island hub, a chamber run, the
 * result, and the Banana Duel — every transition a pure function from
 * one state to the next plus the events it is felt by.
 *
 * A chamber asks three problems of one world. Each answer is an attempt:
 * a wrong one is gentle (a soft sound, Mimi explaining the mistake and
 * naming the right answer, the picture appearing) and the SAME problem
 * waits; a right one pays bananas, throws confetti, sets the monkey
 * hopping and, after a short celebration, brings the next problem of
 * the same kind (the board reshapes if it cannot host it). Three right
 * answers open the chest, and the result shows stars by how few tries it
 * took. Every attempt is reported to the arcade as a `rate` event.
 *
 * The duel is two players at one keyboard, taking turns problem by
 * problem over a round per world: both face problems of the same skill
 * and kind on the same board, drawn from a neutral ladder so neither is
 * favoured. A right answer scores `10 + 2·(streak − 1)` (at most 20);
 * a wrong one costs nothing but the streak. The island's own progress
 * belongs to the first player, whose answers it records; the guest
 * plays for the duel alone.
 */

import {
  WORLDS, SKILL_IDS, createMath, nextProblem, ensureHostable, recordResult, masteryReport, focusSkill,
  explainKey, lineVars, solvedEquation, gateStage,
} from './math.js';
import { HUB, makeBoard, boardKindFor, canHost, centerOf, tileAt } from './boards.js';
import { JUMP_MS, createMonkey, distanceTo, followMonkey } from './walk.js';
import { REACH, verbFor, verbAct, answerFetch, checkShare, takeBack } from './verbs.js';
import { WORLD_COLORS } from './palette.js';
import { createRng, seedOf } from './rng.js';
import { t } from './strings.js';

/**
 * @typedef {import('./math.js').World} World
 * @typedef {import('./math.js').Problem} Problem
 * @typedef {import('./math.js').MathState} MathState
 * @typedef {import('./boards.js').Board} Board
 * @typedef {import('./walk.js').Monkey} Monkey
 * @typedef {import('./verbs.js').Verb} Verb
 * @typedef {import('./verbs.js').Attempt} Attempt
 * @typedef {import('./verbs.js').Outcome} Outcome
 * @typedef {import('./strings.js').Lang} Lang
 * @typedef {import('../game.js').GameEvent} GameEvent
 * @typedef {import('../game.js').Player} Player
 * @typedef {{ math: MathState, bananas: number, best: Record<World, number>, gates: Record<World, number>,
 *   met: boolean, talks: number, taught: string[] }} Progress
 * @typedef {{ world: World, index: number, solved: number, wrongs: number, attempts: number, combo: number,
 *   stars: number, chest: number, problem: Problem, verb: Verb, tries: number, usedHint: boolean,
 *   modelShown: boolean, lastTag: string | null, attemptAt: number, pulseAt: number | null,
 *   celebrateUntil: number, solvedText: string | null }} Chamber
 * @typedef {{ rounds: number, round: number, turn: number, scores: number[], combos: number[], firsts: number[],
 *   neutral: MathState, problems: Problem[], winner: number | null }} Duel
 * @typedef {{ v: 1, seed: number, serial: number, clock: number, lang: Lang, players: Player[], progress: Progress,
 *   mode: 'hub' | 'chamber' | 'result' | 'over', board: Board, monkey: Monkey, chamber: Chamber | null,
 *   duel: Duel | null, toast: { text: string, until: number } | null, mimiAt: number | null }} GroveState
 * @typedef {{ state: GroveState, events: GameEvent[] }} Step
 */

/** Right answers a chamber asks for. */
export const PROBLEMS_PER_CHAMBER = 3;
/** How long a right answer is celebrated before the next problem, ms. */
export const CELEBRATE_MS = 1300;
/** How long a line stays on screen, ms. */
export const TOAST_MS = 3200;

/**
 * The chamber of a state, which a chamber-only transition is sure of.
 * @param {GroveState} state @returns {Chamber}
 */
function chamberOf(state) {
  return /** @type {Chamber} */ (state.chamber);
}

/**
 * A line shown for a while (not dialogue: nothing is said aloud).
 * @param {GroveState} state @param {string} text @returns {GroveState}
 */
function toast(state, text) {
  return { ...state, toast: { text, until: state.clock + TOAST_MS } };
}

/**
 * Mimi says a line: the `say` event the HUD and the Mail app keep, a ring
 * of radiance around her, and the line on screen.
 * @param {GroveState} state @param {GameEvent[]} events @param {string} text @returns {GroveState}
 */
function speak(state, events, text) {
  const [x, z] = centerOf(state.board, state.board.mimi[0], state.board.mimi[1]);
  events.push({ kind: 'say', who: 'mimi', text }, { kind: 'fx', fx: 'radiance', at: [x, 1.7, z] });
  return { ...toast(state, text), mimiAt: state.clock };
}

/**
 * A problem set before the monkey: its verb dealt onto the board, the
 * picture shown at once while the skill still needs it, and — the first
 * time a kind is met — Mimi explaining how to play it.
 * @param {GroveState} state @param {Problem} problem @param {GameEvent[]} events @returns {Step}
 */
function present(state, problem, events) {
  const base = chamberOf(state);
  const turn = state.duel ? state.duel.round * 2 + state.duel.turn : 0;
  const rng = createRng(seedOf(state.seed, 'deal', state.serial, base.solved, turn));
  /** @type {Chamber} */
  const chamber = {
    ...base, problem, verb: verbFor(state.board, problem, rng), tries: 0, usedHint: false,
    modelShown: problem.scaffold === 0, lastTag: null, attemptAt: state.clock, pulseAt: null, celebrateUntil: 0, solvedText: null,
  };
  /** @type {GroveState} */
  let next = { ...state, chamber, monkey: { ...state.monkey, carry: null } };
  if (!next.progress.taught.includes(problem.kind)) {
    next = speak({ ...next, progress: { ...next.progress, taught: [...next.progress.taught, problem.kind] } }, events, t(state.lang, `teach.${problem.kind}`));
  }
  return { state: next, events };
}

/**
 * A fresh chamber of a world: its first problem chosen for the child,
 * and a board dealt for that problem's verb.
 * @param {GroveState} state @param {World} world @param {number} index @param {GameEvent[]} events @returns {Step}
 */
function beginChamber(state, world, index, events) {
  const serial = state.serial + 1;
  const math = state.progress.math;
  const options = { world, rng: createRng(seedOf(state.seed, 'problem', serial, 0)), now: state.clock };
  const problem = ensureHostable(nextProblem(math, options), math, options);
  const board = makeBoard(boardKindFor(problem.kind), seedOf(state.seed, 'board', serial), world);
  const monkey = { ...createMonkey(board), jumpMs: JUMP_MS };
  const combo = index === 1 ? 0 : chamberOf(state).combo;
  const chamber = /** @type {Chamber} */ ({ world, index, solved: 0, wrongs: 0, attempts: 0, combo, stars: 0, chest: 0 });
  events.push({ kind: 'sfx', name: 'open' }, { kind: 'shot', shot: 'close', ms: 900 }, followMonkey(monkey));
  return present({ ...state, serial, mode: 'chamber', board, monkey, chamber, toast: null }, problem, events);
}

/**
 * Step through a portal: a world's chamber run begins at chamber one.
 * @param {GroveState} state @param {World} world @returns {Step}
 */
export function enterWorld(state, world) {
  if (state.duel || !WORLDS.includes(world)) return { state, events: [] };
  return beginChamber(state, world, 1, [{ kind: 'sfx', name: 'hop' }]);
}

/**
 * From the result, on into the world's next chamber.
 * @param {GroveState} state @returns {Step}
 */
export function nextChamber(state) {
  if (state.mode !== 'result') return { state, events: [] };
  const chamber = chamberOf(state);
  return beginChamber(state, chamber.world, chamber.index + 1, [{ kind: 'sfx', name: 'hop' }]);
}

/**
 * Back to the island (a duel plays on).
 * @param {GroveState} state @returns {Step}
 */
export function goHome(state) {
  if (state.duel || state.mode === 'hub') return { state, events: [] };
  const monkey = { ...createMonkey(HUB), jumpMs: JUMP_MS };
  return {
    state: { ...state, mode: 'hub', board: HUB, monkey, chamber: null, toast: null },
    events: [{ kind: 'sfx', name: 'close' }, { kind: 'shot', shot: 'home', ms: 900 }, followMonkey(monkey)],
  };
}

/**
 * The hub's portals: walking onto one enters its world.
 * @param {GroveState} state @returns {Step | null} null while the monkey is on no portal
 */
export function enterPortal(state) {
  const portals = /** @type {Record<World, [number, number]>} */ (HUB.portals);
  const [i, j] = tileAt(HUB, state.monkey.x, state.monkey.z);
  const world = WORLDS.find((w) => portals[w][0] === i && portals[w][1] === j);
  return world ? enterWorld(state, world) : null;
}

/**
 * Score an attempt. Every attempt is reported (`rate`) and recorded; a
 * wrong one keeps the problem and explains, a right one celebrates.
 * @param {GroveState} state @param {Attempt} attempt @param {GameEvent[]} events @returns {Step}
 */
function resolve(state, attempt, events) {
  const chamber = chamberOf(state);
  const { problem } = chamber;
  const { duel, lang } = state;
  const recording = !duel || duel.turn === 0;
  let progress = state.progress;
  /** @type {string | null} */
  let mastered = null;
  if (recording) {
    const out = recordResult(progress.math, problem, {
      correct: attempt.correct, usedHint: chamber.usedHint, ms: state.clock - chamber.attemptAt, tag: attempt.info.tag, retry: chamber.tries > 0,
    }, { now: state.clock });
    progress = { ...progress, math: out.math };
    mastered = out.mastered;
    events.push({ kind: 'rate', skill: problem.skillId, correct: attempt.correct, difficulty: problem.difficulty });
  }
  const tries = chamber.tries + 1;
  const attempts = chamber.attempts + 1;
  if (!attempt.correct) {
    events.push({ kind: 'sfx', name: 'wrong' }, { kind: 'shake', amp: 2, ms: 220 });
    const line = t(lang, explainKey(problem, attempt.info), { ...lineVars(problem), value: attempt.info.value });
    /** @type {GroveState} */
    const next = {
      ...state, progress,
      chamber: {
        ...chamber, tries, attempts, wrongs: chamber.wrongs + 1, combo: 0, modelShown: true,
        lastTag: attempt.info.tag, attemptAt: state.clock, pulseAt: state.clock,
      },
      duel: duel && { ...duel, combos: duel.combos.map((c, k) => (k === duel.turn ? 0 : c)) },
    };
    return { state: speak(next, events, line), events };
  }
  const combo = (duel ? duel.combos[duel.turn] : chamber.combo) + 1;
  const rng = createRng(seedOf(state.seed, 'reward', state.serial, attempts, duel ? duel.round * 2 + duel.turn : 0));
  const bananas = recording ? rng.int(3, 5) + Math.min(10, (combo - 1) * 2) : 0;
  const points = 10 + Math.min(10, (combo - 1) * 2);
  const at = /** @type {[number, number, number]} */ ([attempt.at[0], 0.9, attempt.at[1]]);
  events.push(
    { kind: 'sfx', name: 'right' },
    { kind: 'sfx', name: 'hop' },
    { kind: 'fx', fx: 'confetti', at },
    { kind: 'fx', fx: 'stars', at, colors: ['#fbbf24', '#fffdf6'] },
    { kind: 'shake', amp: 5, ms: 300 },
  );
  const coins = Math.min(8, recording ? bananas : Math.round(points / 4));
  for (let k = 0; k < coins; k++) events.push({ kind: 'sfx', name: 'coin', pitch: 1 + k * 0.06 });
  if (recording) events.push({ kind: 'xp', amount: bananas, reason: 'correct' });
  /** @type {GroveState} */
  let next = {
    ...state,
    progress: { ...progress, bananas: progress.bananas + bananas },
    monkey: { ...state.monkey, jumpMs: JUMP_MS },
    chamber: {
      ...chamber, tries, attempts, combo, solved: chamber.solved + 1, lastTag: 'correct',
      celebrateUntil: state.clock + CELEBRATE_MS, solvedText: solvedEquation(problem, attempt.info),
    },
    duel: duel && {
      ...duel,
      combos: duel.combos.map((c, k) => (k === duel.turn ? combo : c)),
      scores: duel.scores.map((s, k) => (k === duel.turn ? s + points : s)),
      firsts: duel.firsts.map((f, k) => (k === duel.turn && chamber.tries === 0 ? f + 1 : f)),
    },
  };
  next = speak(next, events, t(lang, `play.correct.${rng.int(1, 4)}`));
  if (mastered) {
    events.push({ kind: 'sfx', name: 'levelup' }, { kind: 'fx', fx: 'radiance', at: [state.monkey.x, 1, state.monkey.z] });
    next = speak(next, events, t(lang, 'result.mastered', { skill: t(lang, `skill.${mastered}`) }));
  }
  return { state: next, events };
}

/**
 * What a verb did, applied: its state, the monkey, its sounds, its line,
 * and its attempt scored.
 * @param {GroveState} state @param {Outcome} out @param {GameEvent[]} events @returns {Step}
 */
function applyOutcome(state, out, events) {
  events.push(...out.events);
  /** @type {GroveState} */
  let next = { ...state, monkey: out.monkey, chamber: { ...chamberOf(state), verb: out.verb } };
  if (out.note) next = toast(next, t(state.lang, out.note));
  return out.attempt ? resolve(next, out.attempt, events) : { state: next, events };
}

/**
 * The lines Mimi has for the island, read off the mastery report (rust
 * counted): a first hello, the sleepiest world and its next skill, the
 * bloomiest world, the skills known by heart, the festival, the
 * bananas, her own mood, and a little chat. Repeated talks go round them.
 * @param {GroveState} state @returns {string[]}
 */
export function adviceLines(state) {
  const { progress, lang } = state;
  const report = masteryReport(progress.math, { now: state.clock });
  const name = (/** @type {World} */ w) => t(lang, `world.${w}`);
  const pct = (/** @type {World} */ w) => report.worlds[w].pct;
  /** @type {string[]} */
  const lines = [];
  if (!progress.met) lines.push(t(lang, 'mimi.meet'));
  const order = [...WORLDS].sort((a, b) => pct(a) - pct(b));
  const weakest = order[0];
  const strongest = order[order.length - 1];
  if (pct(weakest) < 1) {
    lines.push(t(lang, 'mimi.world_hint', { world: name(weakest) }));
    lines.push(t(lang, 'mimi.focus', { world: name(weakest), skill: t(lang, `skill.${focusSkill(progress.math, weakest, state.clock)}`) }));
  }
  if (pct(strongest) > 0) lines.push(t(lang, 'mimi.bloom', { world: name(strongest), pct: Math.round(pct(strongest) * 100) }));
  const known = WORLDS.reduce((n, w) => n + report.worlds[w].skills.filter((s) => s.mastered).length, 0);
  if (known > 0) lines.push(t(lang, 'mimi.mastered', { n: known, total: SKILL_IDS.length }));
  if (WORLDS.every((w) => pct(w) >= 0.88)) lines.push(t(lang, 'mimi.festival'));
  if (progress.bananas > 0) lines.push(t(lang, 'mimi.bananas', { n: progress.bananas }));
  const blooming = WORLDS.filter((w) => progress.gates[w] >= 2).length;
  lines.push(t(lang, `mimi.phase${blooming === 0 ? 0 : blooming < WORLDS.length ? 1 : 2}`));
  lines.push(t(lang, 'mimi.chat.1'), t(lang, 'mimi.chat.2'), t(lang, 'mimi.chat.3'));
  return lines;
}

/**
 * Mimi talks: on the island, her advice (in turn); in a chamber, a cheer.
 * @param {GroveState} state @param {GameEvent[]} events @returns {Step}
 */
function talk(state, events) {
  const { progress } = state;
  const lines = state.mode === 'hub' ? adviceLines(state) : [1, 2, 3, 4].map((k) => t(state.lang, `play.cheer.${k}`));
  events.push({ kind: 'sfx', name: 'chime' });
  const next = { ...state, progress: { ...progress, met: progress.met || state.mode === 'hub', talks: progress.talks + 1 } };
  return { state: speak(next, events, lines[progress.talks % lines.length]), events };
}

/**
 * Nothing here to use: the monkey hops for joy instead.
 * @param {GroveState} state @param {GameEvent[]} events @returns {Step}
 */
function hop(state, events) {
  if (state.monkey.jumpMs > 0) return { state, events };
  events.push({ kind: 'sfx', name: 'hop' }, { kind: 'fx', fx: 'dust', at: [state.monkey.x, 0.05, state.monkey.z], colors: ['#fde68a'], count: 5 });
  return { state: { ...state, monkey: { ...state.monkey, jumpMs: JUMP_MS } }, events };
}

/**
 * Whether Mimi is within reach of the monkey.
 * @param {GroveState} state
 */
function nearMimi(state) {
  return distanceTo(state.monkey, centerOf(state.board, state.board.mimi[0], state.board.mimi[1])) <= REACH.mimi;
}

/**
 * Act — the one button: on the island, talk to Mimi (or hop); in a
 * chamber, whatever the verb does here; on the result, the next chamber.
 * Ignored while a right answer is being celebrated and once a duel is over.
 * @param {GroveState} state @returns {Step}
 */
export function interact(state) {
  /** @type {GameEvent[]} */
  const events = [];
  if (state.mode === 'result') return nextChamber(state);
  if (state.mode === 'hub') return nearMimi(state) ? talk(state, events) : hop(state, events);
  const chamber = state.chamber;
  if (state.mode !== 'chamber' || !chamber || chamber.celebrateUntil > 0) return { state, events };
  const out = verbAct(state.board, chamber.problem, chamber.verb, state.monkey);
  if (out) return applyOutcome(state, out, events);
  return nearMimi(state) ? talk(state, events) : hop(state, events);
}

/**
 * Whether a chamber problem is waiting for an answer of a kind.
 * @param {GroveState} state @param {string} kind
 */
function waiting(state, kind) {
  return state.mode === 'chamber' && state.chamber !== null && state.chamber.celebrateUntil === 0 && state.chamber.problem.kind === kind;
}

/**
 * Answer the stone hunt directly with a stone's value (the HUD's stone
 * buttons, a test). A value no stone carries changes nothing.
 * @param {GroveState} state @param {unknown} value @returns {Step}
 */
export function answer(state, value) {
  if (!waiting(state, 'fetch')) return { state, events: [] };
  const chamber = chamberOf(state);
  const out = answerFetch(state.board, chamber.problem, /** @type {Extract<Verb, { kind: 'fetch' }>} */ (chamber.verb), state.monkey, value);
  return out ? applyOutcome(state, out, []) : { state, events: [] };
}

/**
 * The share checked (the HUD's Check button).
 * @param {GroveState} state @returns {Step}
 */
export function check(state) {
  if (!waiting(state, 'share')) return { state, events: [] };
  const chamber = chamberOf(state);
  const verb = /** @type {Extract<Verb, { kind: 'share' }>} */ (chamber.verb);
  return applyOutcome(state, { verb, monkey: state.monkey, events: [], attempt: checkShare(state.board, chamber.problem, verb) }, []);
}

/**
 * The last coconut taken back (the HUD's Take-back button).
 * @param {GroveState} state @returns {Step}
 */
export function undo(state) {
  if (!waiting(state, 'share')) return { state, events: [] };
  return applyOutcome(state, takeBack(/** @type {Extract<Verb, { kind: 'share' }>} */ (chamberOf(state).verb), state.monkey), []);
}

/**
 * Show the picture: the model on the floor, the vine's labels back, a
 * marked hint (a hinted right answer counts 0.7). On the island, Mimi's
 * advice from afar.
 * @param {GroveState} state @returns {Step}
 */
export function hint(state) {
  /** @type {GameEvent[]} */
  const events = [];
  if (state.mode === 'hub') return talk(state, events);
  const chamber = state.chamber;
  if (state.mode !== 'chamber' || !chamber || chamber.celebrateUntil > 0) return { state, events };
  const verb = chamber.verb.kind === 'numberline' ? { ...chamber.verb, level: 0 } : chamber.verb;
  events.push({ kind: 'sfx', name: 'chime' });
  const next = { ...state, chamber: { ...chamber, verb, usedHint: true, modelShown: true, pulseAt: state.clock } };
  return { state: speak(next, events, t(state.lang, 'hint.look')), events };
}

/**
 * The chamber's last problem solved: the chest, the stars (three for no
 * misses, two for at most two, one otherwise), the world's best, and its
 * gate blooming when it passed a step.
 * @param {GroveState} state @param {GameEvent[]} events @returns {Step}
 */
function completeChamber(state, events) {
  const chamber = chamberOf(state);
  const { world } = chamber;
  const { progress, lang } = state;
  const chest = 10 + createRng(seedOf(state.seed, 'chest', state.serial)).int(0, 6) + Math.min(12, chamber.index * 2);
  const stars = chamber.wrongs === 0 ? 3 : chamber.wrongs <= 2 ? 2 : 1;
  const stage = gateStage(masteryReport(progress.math).worlds[world].pct);
  /** @type {[number, number, number]} */
  const at = [state.monkey.x, 1, state.monkey.z];
  events.push(
    { kind: 'sfx', name: 'levelup' },
    { kind: 'fx', fx: 'confetti', at, count: 60 },
    { kind: 'fx', fx: 'stars', at, colors: ['#fbbf24'], count: 3 * stars },
    { kind: 'flash', color: WORLD_COLORS[world].accent },
    { kind: 'shot', shot: 'hero', ms: 900 },
  );
  for (let k = 0; k < Math.min(8, chest); k++) events.push({ kind: 'sfx', name: 'coin', pitch: 1 + k * 0.05 });
  events.push({ kind: 'xp', amount: chest, reason: 'chamber' });
  let next = toast({
    ...state,
    mode: 'result',
    chamber: { ...chamber, stars, chest, celebrateUntil: 0 },
    progress: {
      ...progress,
      bananas: progress.bananas + chest,
      best: { ...progress.best, [world]: Math.max(progress.best[world], stars) },
      gates: { ...progress.gates, [world]: Math.max(progress.gates[world], stage) },
    },
  }, t(lang, 'result.chest', { n: chest }));
  if (stage > progress.gates[world]) next = speak(next, events, t(lang, 'result.bloomed', { world: t(lang, `world.${world}`) }));
  return { state: next, events };
}

/**
 * After a right answer's celebration: the next problem (the same kind,
 * on a reshaped board if this one cannot host it), or the result.
 * @param {GroveState} state @returns {Step}
 */
export function advance(state) {
  /** @type {GameEvent[]} */
  const events = [];
  const chamber = chamberOf(state);
  if (state.duel) return endTurn(state, events);
  if (chamber.solved >= PROBLEMS_PER_CHAMBER) return completeChamber(state, events);
  const math = state.progress.math;
  const options = { world: chamber.world, kind: chamber.problem.kind, rng: createRng(seedOf(state.seed, 'problem', state.serial, chamber.solved)), now: state.clock };
  const problem = ensureHostable(nextProblem(math, options), math, options);
  let next = state;
  if (!canHost(state.board, problem.kind)) {
    const board = makeBoard(boardKindFor(problem.kind), seedOf(state.seed, 'board', state.serial, chamber.solved), chamber.world);
    const monkey = createMonkey(board);
    events.push({ kind: 'sfx', name: 'whoosh' }, followMonkey(monkey));
    next = toast({ ...state, board, monkey }, t(state.lang, 'play.reshape'));
  }
  return present(next, problem, events);
}

/**
 * The duel begins: round one, the first player's turn.
 * @param {GroveState} state @param {number} rounds @returns {Step}
 */
export function startDuel(state, rounds) {
  /** @type {Duel} */
  const duel = { rounds, round: 0, turn: 0, scores: [0, 0], combos: [0, 0], firsts: [0, 0], neutral: createMath(), problems: [], winner: null };
  return beginRound({ ...state, duel }, 0, [{ kind: 'sfx', name: 'start' }]);
}

/**
 * A duel round: one world, one board, one problem of the same skill and
 * kind for each player, from the neutral ladder (which then climbs).
 * @param {GroveState} state @param {number} round @param {GameEvent[]} events @returns {Step}
 */
function beginRound(state, round, events) {
  const duel = /** @type {Duel} */ (state.duel);
  const world = WORLDS[round % WORLDS.length];
  const first = { world, rng: createRng(seedOf(state.seed, 'duel', round, 0)) };
  const p0 = ensureHostable(nextProblem(duel.neutral, first), duel.neutral, first);
  const second = { skill: p0.skillId, kind: p0.kind, rng: createRng(seedOf(state.seed, 'duel', round, 1)) };
  const p1 = ensureHostable(nextProblem(duel.neutral, second), duel.neutral, second);
  const board = makeBoard(boardKindFor(p0.kind), seedOf(state.seed, 'duel-board', round), world);
  const neutral = recordResult(duel.neutral, p0, { correct: true }).math;
  const chamber = /** @type {Chamber} */ ({ world, index: round + 1, solved: 0, wrongs: 0, attempts: 0, combo: 0, stars: 0, chest: 0 });
  return beginTurn({
    ...state, mode: 'chamber', serial: state.serial + 1, board, chamber,
    duel: { ...duel, round, turn: 0, neutral, problems: [p0, p1] },
  }, 0, events);
}

/**
 * A player's turn: the monkey back on the spawn in the player's colours,
 * the problem set, and Mimi calling the player up.
 * @param {GroveState} state @param {number} turn @param {GameEvent[]} events @returns {Step}
 */
function beginTurn(state, turn, events) {
  const duel = /** @type {Duel} */ (state.duel);
  const monkey = { ...createMonkey(state.board), jumpMs: JUMP_MS };
  events.push({ kind: 'sfx', name: 'pass' }, { kind: 'shot', shot: 'close', ms: 900 }, followMonkey(monkey));
  const set = present({ ...state, monkey, duel: { ...duel, turn } }, duel.problems[turn], events);
  return { state: speak(set.state, events, t(state.lang, 'duel.turn', { name: state.players[turn].name })), events };
}

/**
 * A turn solved: the other player's turn, the next round, or the end.
 * @param {GroveState} state @param {GameEvent[]} events @returns {Step}
 */
function endTurn(state, events) {
  const duel = /** @type {Duel} */ (state.duel);
  if (duel.turn === 0) return beginTurn(state, 1, events);
  if (duel.round + 1 < duel.rounds) return beginRound(state, duel.round + 1, events);
  const [a, b] = duel.scores;
  const winner = a === b ? -1 : a > b ? 0 : 1;
  const line = winner < 0
    ? t(state.lang, 'duel.tie')
    : t(state.lang, 'duel.winner', { name: state.players[winner].name, score: duel.scores[winner] });
  /** @type {[number, number, number]} */
  const at = [state.monkey.x, 1, state.monkey.z];
  events.push({ kind: 'sfx', name: 'levelup' }, { kind: 'fx', fx: 'confetti', at, count: 80 }, { kind: 'shot', shot: 'verdict', ms: 1100 });
  const over = { ...state, mode: /** @type {'over'} */ ('over'), duel: { ...duel, winner }, chamber: { ...chamberOf(state), celebrateUntil: 0 } };
  return { state: speak(over, events, line), events };
}
