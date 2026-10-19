//@ts-check
/**
 * Monkey Grove — Radiant edition: a cozy island adventure that secretly
 * teaches arithmetic, as a game for the Radiant OS arcade.
 *
 * A monkey walks an island whose numbers the Crab King pinched. Four
 * portals lead to four worlds — the Tide Pools (number sense), the
 * Banana Garden (times tables), the Sharing Stump (division) and the
 * Vine Heights (fractions) — and each world's chambers ask three
 * problems, chosen and pitched for the child by an adaptive rating
 * engine. A problem is answered with the body, never a keyboard: carry
 * the right number stone to the altar, walk out a bed of sprouts, stand
 * where a fraction lives on the vine, deal coconuts fairly into baskets.
 * Mistakes are gentle — Mimi, the island's guide, explains the very
 * mistake that was made, the picture appears, and the same problem
 * waits — and the island blooms back to colour world by world as its
 * numbers come home. Two players can face off in a hot-seat Banana Duel.
 *
 * This module is the arcade's GameModule over the pieces: the math
 * engine (`math.js`, `generators.js`), the boards (`boards.js`), the
 * walking monkey and its collision mesh (`walk.js`), the verbs
 * (`verbs.js`), the flow of play (`flow.js`) and the drawing
 * (`draw.js`, `shapes.js`); the lines it shows live in `strings.json`,
 * in English and Dutch. Everything is pure over plain JSON state.
 */

import { WORLDS, SKILLS, SKILL_IDS, RATING, createMath, masteryReport, lineVars } from './math.js';
import { HUB, centerOf } from './boards.js';
import { createMonkey, moveMonkey, walkTo } from './walk.js';
import { vineValue, bedRect } from './verbs.js';
import { interact, hint, answer, check, undo, enterWorld, nextChamber, goHome, enterPortal, advance, startDuel, PROBLEMS_PER_CHAMBER } from './flow.js';
import { drawGrove } from './draw.js';
import { COLORS, WORLD_COLORS } from './palette.js';
import { t, langOf } from './strings.js';

/**
 * @typedef {import('./flow.js').GroveState} GroveState
 * @typedef {import('./flow.js').Progress} Progress
 * @typedef {import('./math.js').World} World
 * @typedef {import('../game.js').GameEvent} GameEvent
 * @typedef {import('../game.js').GameInput} GameInput
 * @typedef {import('../game.js').GameTool} GameTool
 * @typedef {import('../game.js').Hud} Hud
 * @typedef {import('../game.js').Outcome} Outcome
 * @typedef {import('../game.js').Player} Player
 * @typedef {import('../game.js').GameModule} GameModule
 */

/** Rounds of a duel unless the arcade asks for another number. */
export const DUEL_ROUNDS = 4;

/** How near a tap must land to a thing to mean "go and use it". */
const TAP_REACH = 0.7;

/**
 * A count read from a save: a whole number of at least zero, else 0.
 * @param {unknown} value
 */
function count(value) {
  return Number.isInteger(value) && /** @type {number} */ (value) >= 0 ? /** @type {number} */ (value) : 0;
}

/**
 * A moment read from a save or the arcade: a finite time of at least zero, else 0.
 * @param {unknown} value
 */
function moment(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * A per-world record of small counts read from a save, held to `max`.
 * @param {any} value @param {number} max @returns {Record<World, number>}
 */
function perWorld(value, max) {
  return /** @type {Record<World, number>} */ (Object.fromEntries(WORLDS.map((w) => [w, Math.min(max, count(value?.[w]))])));
}

/**
 * The island's progress read back from a save, every field checked: a
 * missing or broken one starts fresh instead of breaking the game.
 * @param {any} save @returns {Progress}
 */
export function restoreProgress(save) {
  const fresh = createMath();
  const saved = save?.math;
  for (const id of SKILL_IDS) {
    const s = saved?.skills?.[id];
    if (s && Number.isFinite(s.r) && Number.isInteger(s.n) && s.n >= 0 && Array.isArray(s.hist)) {
      fresh.skills[id] = { r: s.r, n: s.n, hist: s.hist.slice(-RATING.histMax).map((/** @type {unknown} */ h) => (h ? 1 : 0)) };
    }
  }
  const log = Array.isArray(saved?.log)
    ? saved.log.filter((/** @type {any} */ e) => e && Object.hasOwn(SKILLS, e.skill) && Number.isFinite(e.t)).slice(-RATING.logMax)
    : [];
  return {
    math: { skills: fresh.skills, log },
    bananas: count(save?.bananas),
    best: perWorld(save?.best, 3),
    gates: perWorld(save?.gates, 4),
    met: save?.met === true,
    talks: count(save?.talks),
    taught: Array.isArray(save?.taught) ? save.taught.filter((/** @type {unknown} */ k) => typeof k === 'string') : [],
  };
}

/**
 * A new game: the island restored from the save, the monkey on the hub —
 * or, with two players, straight into the Banana Duel.
 * @param {{ seed: number, save: any, players: Player[], options?: any }} init @returns {GroveState}
 */
function create(init) {
  const options = init.options ?? {};
  const players = (init.players?.length ? init.players : [{ id: 'p1', name: 'Explorer', color: COLORS.monkey }]).slice(0, 2);
  /** @type {GroveState} */
  const state = {
    v: 1,
    seed: init.seed >>> 0,
    serial: 0,
    clock: Math.max(moment(options.now), moment(init.save?.clock)),
    lang: langOf(options.lang),
    players,
    progress: restoreProgress(init.save),
    mode: 'hub',
    board: HUB,
    monkey: createMonkey(HUB),
    chamber: null,
    duel: null,
    toast: null,
    mimiAt: null,
  };
  return players.length === 2 ? startDuel(state, count(options.rounds) || DUEL_ROUNDS).state : state;
}

/**
 * What the arcade keeps between sessions: the math state, the bananas,
 * the best stars and gate blooms per world, and what Mimi has said.
 * @param {GroveState} state
 */
function save(state) {
  const p = state.progress;
  return { v: 1, clock: state.clock, math: p.math, bananas: p.bananas, best: p.best, gates: p.gates, met: p.met, talks: p.talks, taught: p.taught };
}

/**
 * Whether a tap lands on something to use (Mimi, a stone, the altar, a
 * basket, the stump): then the walk there ends by using it.
 * @param {GroveState} state @param {{ x: number, z: number }} tap
 */
function tapsThing(state, tap) {
  if (state.mode !== 'hub' && state.mode !== 'chamber') return false;
  const board = state.board;
  /** @type {Array<[number, number]>} */
  const points = [board.mimi, board.altar, board.stump, ...board.baskets].flatMap((cell) => (cell ? [centerOf(board, cell[0], cell[1])] : []));
  const verb = state.chamber?.verb;
  if (verb?.kind === 'fetch') for (const stone of verb.stones) points.push([stone.x, stone.z]);
  return points.some(([x, z]) => Math.hypot(x - tap.x, z - tap.z) <= TAP_REACH);
}

/**
 * One tick: the celebration timing out into the next problem, a tap
 * planning a walk, the monkey moving, the buttons pressed, a portal
 * stepped into.
 * @param {GroveState} state @param {GameInput} input @param {number} dtMs
 * @returns {{ state: GroveState, events: GameEvent[] }}
 */
function step(state, input, dtMs) {
  /** @type {GameEvent[]} */
  const events = [];
  /** @type {GroveState} */
  let s = { ...state, clock: state.clock + dtMs };
  if (s.mode === 'over') return { state: s, events };
  const chamber = s.chamber;
  if (s.mode === 'chamber' && chamber && chamber.celebrateUntil > 0 && s.clock >= chamber.celebrateUntil) {
    const out = advance(s);
    s = out.state;
    events.push(...out.events);
    if (s.mode === 'over') return { state: s, events };
  }
  if (input.tap) s = { ...s, monkey: walkTo(s.board, s.monkey, [input.tap.x, input.tap.z], tapsThing(s, input.tap)) };
  const moved = moveMonkey(s.board, s.monkey, input.held, dtMs);
  s = { ...s, monkey: moved.monkey };
  events.push(...moved.events);
  const pressed = [...input.pressed];
  if (moved.arrived && s.monkey.intent) {
    pressed.push('act');
    s = { ...s, monkey: { ...s.monkey, intent: false } };
  }
  for (const action of pressed) {
    const out = action === 'act' ? interact(s) : action === 'hint' ? hint(s) : null;
    if (out) {
      s = out.state;
      events.push(...out.events);
    }
  }
  const through = s.mode === 'hub' ? enterPortal(s) : null;
  if (through) {
    s = through.state;
    events.push(...through.events);
  }
  return { state: s, events };
}

/**
 * A discrete move: a HUD button (`hint`, `home`, `next`, `check`,
 * `undo`, `act`), a grid cell (a world on the island, a stone in a
 * chamber), a direct answer, a world to enter, a language.
 * @param {GroveState} state @param {{ type: string, [k: string]: any }} action
 * @returns {{ state: GroveState, events: GameEvent[] }}
 */
function act(state, action) {
  switch (action.type) {
    case 'act': return interact(state);
    case 'hint': return hint(state);
    case 'home': return goHome(state);
    case 'next': return nextChamber(state);
    case 'world': return enterWorld(state, action.world);
    case 'answer': return answer(state, action.value);
    case 'check': return check(state);
    case 'undo': return undo(state);
    case 'cell': return state.mode === 'hub' ? enterWorld(state, action.id) : answer(state, action.id);
    case 'lang': return { state: { ...state, lang: langOf(action.lang) }, events: [{ kind: 'sfx', name: 'click' }] };
    default: return { state, events: [] };
  }
}

/**
 * Stars as text: filled for earned, hollow for the rest of three.
 * @param {number} n
 */
function starText(n) {
  return '★'.repeat(n) + '☆'.repeat(3 - n);
}

/**
 * What the chrome shows: the world, the problem and its instruction (the
 * equation solved, once it is), the bananas, the chamber and step, the
 * buttons, both players in a duel, the line of the moment and the
 * controls. On the island a grid of the worlds (press one to go); in a
 * stone hunt a grid of the stones (press one to offer it).
 * @param {GroveState} state @returns {Hud}
 */
function hud(state) {
  const { lang, progress, duel } = state;
  const say = (/** @type {string} */ key, /** @type {Record<string, unknown>} */ vars = {}) => t(lang, key, vars);
  const score = progress.bananas === 1 ? say('hud.banana') : say('hud.bananas', { n: progress.bananas });
  const toast = state.toast && state.clock < state.toast.until ? state.toast.text : null;
  const players = duel
    ? state.players.map((p, k) => ({ name: p.name, score: say('hud.bananas', { n: duel.scores[k] }), active: state.mode !== 'over' && k === duel.turn, color: p.color }))
    : undefined;
  const chamber = state.chamber;
  if (state.mode === 'hub' || !chamber) {
    const report = masteryReport(progress.math);
    return {
      title: say('hud.title'), subtitle: say('hud.tagline'), prompt: say('hud.pick_world'), score,
      buttons: [{ id: 'hint', label: `💡 ${say('hud.hint')}` }], toast, help: say('help.hub'),
      grid: {
        columns: WORLDS.map((w) => say(`world.${w}`)),
        rows: [{ label: say('hud.bloom'), cells: WORLDS.map((w) => ({ id: w, text: `${starText(progress.best[w])} ${Math.round(report.worlds[w].pct * 100)}%`, swatch: WORLD_COLORS[w].accent })) }],
      },
    };
  }
  const world = say(`world.${chamber.world}`);
  if (state.mode === 'over') return { title: say('hud.duel'), subtitle: world, prompt: /** @type {Outcome} */ (over(state)).summary, players, toast, help: say('help.over') };
  if (state.mode === 'result') {
    return {
      title: say('result.title'), subtitle: world, prompt: starText(chamber.stars), score,
      level: say('hud.level', { n: chamber.index, k: PROBLEMS_PER_CHAMBER, total: PROBLEMS_PER_CHAMBER }),
      buttons: [{ id: 'next', label: say('result.next'), primary: true }, { id: 'home', label: say('result.home') }],
      toast, help: say('help.result'),
    };
  }
  const { problem } = chamber;
  const solved = chamber.celebrateUntil > 0;
  /** @type {NonNullable<Hud['buttons']>} */
  const buttons = [{ id: 'hint', label: `💡 ${say('hud.hint')}` }];
  if (problem.kind === 'share') buttons.push({ id: 'check', label: `✅ ${say('hud.check')}`, primary: true }, { id: 'undo', label: say('hud.undo') });
  if (!duel) buttons.push({ id: 'home', label: say('result.home') });
  const verb = chamber.verb;
  /** @type {Hud} */
  const out = {
    title: duel ? say('hud.duel') : world,
    subtitle: solved ? say('hud.solved') : say(problem.prompt.key, lineVars(problem)),
    prompt: solved ? /** @type {string} */ (chamber.solvedText) : problem.equation,
    level: duel
      ? say('hud.round', { n: duel.round + 1, total: duel.rounds })
      : say('hud.level', { n: chamber.index, k: Math.min(chamber.solved + 1, PROBLEMS_PER_CHAMBER), total: PROBLEMS_PER_CHAMBER }),
    buttons, toast, help: say(`help.${problem.kind}`),
    meter: { label: say('hud.bloom'), value: masteryReport(progress.math).worlds[chamber.world].pct },
  };
  if (duel) out.players = players;
  else out.score = score;
  if (verb.kind === 'fetch' && !solved) {
    const carried = state.monkey.carry;
    const stones = carried ? [...verb.stones, carried] : verb.stones;
    out.grid = {
      columns: [],
      rows: [{ label: say('hud.stones'), cells: [...stones].sort((a, b) => a.id - b.id).map((s) => ({ id: s.label, text: s.label, active: s === carried })) }],
    };
  }
  return out;
}

/**
 * The duel's outcome once it is over (solo play never ends): the top
 * score, and stars by how often the winner was right first time.
 * @param {GroveState} state @returns {Outcome | null}
 */
function over(state) {
  const duel = state.duel;
  if (state.mode !== 'over' || !duel) return null;
  const winner = /** @type {number} */ (duel.winner);
  const firsts = winner < 0 ? Math.max(...duel.firsts) : duel.firsts[winner];
  const share = firsts / duel.rounds;
  return {
    stars: share >= 0.75 ? 3 : share >= 0.5 ? 2 : 1,
    score: Math.max(...duel.scores),
    summary: winner < 0 ? t(state.lang, 'duel.tie') : t(state.lang, 'duel.winner', { name: state.players[winner].name, score: duel.scores[winner] }),
  };
}

/**
 * What a coach needs to know, and nothing that answers for the child:
 * the problem as shown (its equation, instruction and stones, which
 * picture it has and whether the child has seen it — never the answer,
 * nor the picture's numbers, which carry it), how it has gone so far,
 * the board and what the monkey holds.
 * @param {GroveState} state
 */
export function describe(state) {
  const { lang, progress, chamber, board, monkey } = state;
  const base = { mode: state.mode, lang, bananas: progress.bananas, world: chamber?.world ?? null, chamber: chamber?.index ?? null, holding: monkey.carry?.label ?? null };
  if (state.mode !== 'chamber' || !chamber) {
    const report = masteryReport(progress.math);
    return { ...base, problem: null, board: { kind: board.kind }, worlds: WORLDS.map((w) => ({ world: w, name: t(lang, `world.${w}`), bloom: report.worlds[w].pct })) };
  }
  const { problem, verb } = chamber;
  /** @type {Record<string, any>} */
  const where = { kind: board.kind, monkey: [monkey.x, monkey.z] };
  if (verb.kind === 'fetch') {
    where.altar = board.altar && centerOf(board, board.altar[0], board.altar[1]);
    where.stones = verb.stones.map((s) => ({ label: s.label, at: [s.x, s.z], tried: s.tried }));
  }
  else if (verb.kind === 'array') {
    const bed = bedRect(board, verb.anchor, monkey);
    where.flag = verb.anchor;
    where.bed = bed && { rows: bed.j1 - bed.j0 + 1, cols: bed.i1 - bed.i0 + 1 };
  }
  else if (verb.kind === 'numberline') where.standingAt = vineValue(board, problem, monkey.x);
  else where.share = { pile: verb.pile, baskets: verb.baskets.map((b) => b.count) };
  return {
    ...base,
    problem: {
      skill: problem.skillId,
      skillName: t(lang, `skill.${problem.skillId}`),
      kind: problem.kind,
      equation: problem.equation,
      instruction: t(lang, problem.prompt.key, lineVars(problem)),
      choices: problem.choices ? problem.choices.map((c) => String(c.value)) : null,
      picture: { kind: problem.model.kind, shown: chamber.modelShown },
      scaffold: problem.scaffold,
      attempts: chamber.tries,
      lastMistake: chamber.lastTag === 'correct' ? null : chamber.lastTag,
      hintShown: chamber.usedHint,
      solved: chamber.celebrateUntil > 0,
    },
    board: where,
  };
}

const NO_INPUT = Object.freeze({ type: 'object', properties: {}, additionalProperties: false });

/** The moves a language model helper may make: read, and show the picture. */
const TOOLS = Object.freeze(/** @type {GameTool[]} */ ([
  {
    name: 'grove_problem',
    description: 'Read the current Monkey Grove problem as the child sees it — instruction, stones, picture, attempts so far — with the board and what the monkey holds. It never includes the answer: coach the child toward it.',
    inputSchema: NO_INPUT,
    run: (state) => ({ state, result: describe(state) }),
  },
  {
    name: 'grove_hint',
    description: 'Show the child the picture for the current problem (the same as the Hint button: the model appears and Mimi says to look at it).',
    inputSchema: NO_INPUT,
    run: (state) => {
      const out = hint(state);
      return { state: out.state, result: { shown: out.events.length > 0 }, events: out.events };
    },
  },
]));

/** Monkey Grove, the arcade game. */
export const grove = /** @type {GameModule} */ (Object.freeze({
  id: 'grove',
  title: 'Monkey Grove',
  blurb: 'A cozy island adventure that secretly teaches arithmetic: fetch number stones, grow beds of sprouts, find where fractions live and share coconuts fairly.',
  track: 'grove',
  duel: true,
  camera: Object.freeze({ azimuth: 0.62, elevation: 0.86, distance: 26, lift: 0.4, fov: 0.62 }),
  create,
  step,
  act,
  draw: drawGrove,
  hud,
  over,
  save,
  tools: TOOLS,
}));
