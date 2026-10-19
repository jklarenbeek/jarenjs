//@ts-check
/**
 * The four things a child DOES with a problem in Monkey Grove — the
 * verbs — as pure rules over the board, the monkey and a little state:
 *
 *   - FETCH: number stones lie about the board; Act near one picks it up
 *     (or swaps it for the one in hand), Act elsewhere sets it down, and
 *     Act at the altar offers it — the offering is the answer.
 *   - ARRAY: on the soil bed, Act plants a corner flag; walking stretches
 *     the bed from the flag to the monkey; Act again grows it, and the
 *     bed's rows and columns are the answer (Act on the flag takes it back).
 *   - LINE: the vine is a number line; Act rings the bell where the
 *     monkey stands, and where it stands is the answer.
 *   - SHARE: coconuts on the stump; Act at a basket deals one in, Act at
 *     the stump takes the last one back, Act in the open checks the share.
 *
 * A verb answers what changed, what it sounded like, a short line to show
 * and — when the child committed to an answer — the ATTEMPT, which the
 * chamber scores. A wrong attempt never ends anything: the stone comes
 * back, the bed stays, the monkey climbs out of the water, and the same
 * problem waits. Interaction is by proximity to the monkey's body.
 */

import { centerOf, tileAt } from './boards.js';
import { DUNK_MS, createMonkey, distanceTo, followMonkey, nearest } from './walk.js';

/**
 * @typedef {import('./boards.js').Board} Board
 * @typedef {import('./math.js').Problem} Problem
 * @typedef {import('./rng.js').Rng} Rng
 * @typedef {import('./walk.js').Monkey} Monkey
 * @typedef {import('./walk.js').Stone} Stone
 * @typedef {import('../game.js').GameEvent} GameEvent
 * @typedef {{ i0: number, j0: number, i1: number, j1: number }} Rect
 * @typedef {{ kind: 'fetch', stones: Stone[] }
 *   | { kind: 'array', anchor: [number, number] | null, grown: Rect | null }
 *   | { kind: 'numberline', level: number }
 *   | { kind: 'share', pile: number, baskets: Array<{ i: number, j: number, count: number }>, drops: number[] }} Verb
 * @typedef {{ tag: string, value?: number | string, r?: number, c?: number,
 *   array?: { tag: 'shape' | 'too_few' | 'too_many', r: number, c: number, n: number } }} AttemptInfo
 * @typedef {{ correct: boolean, info: AttemptInfo, at: [number, number] }} Attempt
 * @typedef {{ verb: Verb, monkey: Monkey, events: GameEvent[], note?: string, attempt?: Attempt }} Outcome
 *   - `note`: a line key to show briefly
 */

/** How close the monkey's body must be to use a thing, world units. */
export const REACH = Object.freeze({ stone: 0.8, altar: 1.2, basket: 1.1, stump: 1.15, mimi: 1.2 });

/**
 * A verb's state at the start of a problem: the stones dealt onto the
 * spots, an unplanted bed, the vine labelled to the scaffold, the
 * coconuts all on the stump and the baskets nearest it set out.
 * @param {Board} board @param {Problem} problem @param {Rng} rng @returns {Verb}
 */
export function verbFor(board, problem, rng) {
  if (problem.kind === 'array') return { kind: 'array', anchor: null, grown: null };
  if (problem.kind === 'numberline') return { kind: 'numberline', level: problem.scaffold };
  if (problem.kind === 'share') {
    const stump = /** @type {[number, number]} */ (board.stump);
    const near = board.baskets
      .map(([i, j], k) => ({ i, j, k, far: Math.abs(i - stump[0]) + Math.abs(j - stump[1]) }))
      .sort((a, b) => a.far - b.far || a.k - b.k)
      .slice(0, problem.model.params.baskets);
    return { kind: 'share', pile: problem.model.params.total, baskets: near.map(({ i, j }) => ({ i, j, count: 0 })), drops: [] };
  }
  const spots = rng.shuffle(board.spots);
  const choices = rng.shuffle(/** @type {import('./generators.js').Choice[]} */ (problem.choices));
  return {
    kind: 'fetch',
    stones: choices.map((choice, id) => {
      const [x, z] = centerOf(board, spots[id][0], spots[id][1]);
      return { id, value: choice.value, label: String(choice.value), tag: choice.tag, x, z, tried: false };
    }),
  };
}

/**
 * The world point at the middle of the altar.
 * @param {Board} board @returns {[number, number]}
 */
function altarAt(board) {
  const [i, j] = /** @type {[number, number]} */ (board.altar);
  return centerOf(board, i, j);
}

/**
 * Where a refused stone is handed back: the first free floor beside the
 * altar (no stone on it, not under the monkey), or at the monkey's feet.
 * @param {Board} board @param {Stone[]} stones @param {Monkey} monkey @returns {[number, number]}
 */
function besideAltar(board, stones, monkey) {
  const [ai, aj] = /** @type {[number, number]} */ (board.altar);
  for (const [di, dj] of [[0, 1], [1, 0], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const [x, z] = centerOf(board, ai + di, aj + dj);
    const ch = board.rows[aj + dj][ai + di];
    const taken = stones.some((s) => Math.hypot(s.x - x, s.z - z) < 0.5) || distanceTo(monkey, [x, z]) < 0.6;
    if ('.,soP'.includes(ch) && !taken) return [x, z];
  }
  return [monkey.x, monkey.z];
}

/**
 * Judge an offered stone: the answer when it says what the problem asks.
 * A refused stone comes back, dimmed, beside the altar.
 * @param {Board} board @param {Problem} problem @param {Stone[]} stones @param {Monkey} monkey @param {Stone} stone
 * @returns {{ stones: Stone[], attempt: Attempt }}
 */
function offer(board, problem, stones, monkey, stone) {
  const at = altarAt(board);
  const correct = stone.label === String(problem.answer);
  if (correct) return { stones, attempt: { correct, info: { tag: 'correct', value: stone.value }, at } };
  const [x, z] = besideAltar(board, stones, monkey);
  return {
    stones: [...stones, { ...stone, x, z, tried: true }],
    attempt: { correct, info: { tag: stone.tag, value: stone.value }, at },
  };
}

/**
 * FETCH: offer at the altar, pick up or swap a stone, set the carried
 * one down — or, empty-handed at the altar, a sparkle that says what it
 * wants. Null when there is nothing here to do (and Mimi is near).
 * @param {Board} board @param {Problem} problem @param {Extract<Verb, { kind: 'fetch' }>} verb @param {Monkey} monkey @param {boolean} nearMimi
 * @returns {Outcome | null}
 */
function fetchAct(board, problem, verb, monkey, nearMimi) {
  const altar = altarAt(board);
  const atAltar = distanceTo(monkey, altar) <= REACH.altar;
  if (monkey.carry && atAltar) {
    const out = offer(board, problem, verb.stones, monkey, monkey.carry);
    return { verb: { ...verb, stones: out.stones }, monkey: { ...monkey, carry: null }, events: [{ kind: 'sfx', name: 'whoosh' }], attempt: out.attempt };
  }
  const k = nearest(monkey, verb.stones.map((s) => [s.x, s.z]), REACH.stone);
  if (k >= 0) {
    const stone = verb.stones[k];
    const rest = verb.stones.filter((_s, n) => n !== k);
    const swapped = monkey.carry ? [...rest, { ...monkey.carry, x: stone.x, z: stone.z }] : rest;
    return {
      verb: { ...verb, stones: swapped },
      monkey: { ...monkey, carry: stone },
      events: [{ kind: 'sfx', name: 'pop' }, { kind: 'fx', fx: 'sparks', at: [stone.x, 0.4, stone.z], colors: ['#fbbf24', '#fffdf6'], count: 8 }],
    };
  }
  if (monkey.carry) {
    return {
      verb: { ...verb, stones: [...verb.stones, { ...monkey.carry, x: monkey.x, z: monkey.z }] },
      monkey: { ...monkey, carry: null },
      events: [{ kind: 'sfx', name: 'click' }],
    };
  }
  if (nearMimi) return null;
  if (atAltar) {
    return { verb, monkey, events: [{ kind: 'sfx', name: 'chime' }, { kind: 'fx', fx: 'sparks', at: [altar[0], 1.1, altar[1]], colors: ['#fbbf24', '#fde68a'], count: 10 }], note: 'play.altar_wants' };
  }
  return null;
}

/**
 * The bed planted from the flag to the monkey, held to the soil (before
 * the flag goes in, the one tile under the monkey; off the soil, none).
 * @param {Board} board @param {[number, number] | null} anchor @param {Monkey} monkey @returns {Rect | null}
 */
export function bedRect(board, anchor, monkey) {
  const soil = /** @type {NonNullable<Board['soil']>} */ (board.soil);
  const [i, j] = tileAt(board, monkey.x, monkey.z);
  const on = i >= soil.i0 && i < soil.i0 + soil.cols && j >= soil.j0 && j < soil.j0 + soil.rows;
  if (!anchor) return on ? { i0: i, j0: j, i1: i, j1: j } : null;
  const ci = Math.max(soil.i0, Math.min(soil.i0 + soil.cols - 1, i));
  const cj = Math.max(soil.j0, Math.min(soil.j0 + soil.rows - 1, j));
  return { i0: Math.min(anchor[0], ci), i1: Math.max(anchor[0], ci), j0: Math.min(anchor[1], cj), j1: Math.max(anchor[1], cj) };
}

/**
 * Whether a bed of r rows and c columns answers an array problem: both
 * sides named (either way round), the rows named (and the total), or
 * just the total (any real bed, at least two by two).
 * @param {{ rows: number, cols: number, total: number, given: string }} params @param {number} r @param {number} c
 */
export function bedAnswers({ rows, cols, total, given }, r, c) {
  if (given === 'both') return (r === rows && c === cols) || (r === cols && c === rows);
  if (given === 'rows') return r === rows && r * c === total;
  return r * c === total && r > 1 && c > 1;
}

/**
 * ARRAY: plant the flag, take it back, or grow the bed (the answer).
 * @param {Board} board @param {Problem} problem @param {Extract<Verb, { kind: 'array' }>} verb @param {Monkey} monkey @param {boolean} nearMimi
 * @returns {Outcome | null}
 */
function arrayAct(board, problem, verb, monkey, nearMimi) {
  const here = bedRect(board, null, monkey);
  if (!verb.anchor) {
    if (!here) return nearMimi ? null : { verb, monkey, events: [{ kind: 'sfx', name: 'click' }], note: 'play.need_soil' };
    return { verb: { ...verb, anchor: [here.i0, here.j0] }, monkey, events: [{ kind: 'sfx', name: 'pop' }], note: 'play.flag_planted' };
  }
  if (here && here.i0 === verb.anchor[0] && here.j0 === verb.anchor[1]) {
    return { verb: { ...verb, anchor: null }, monkey, events: [{ kind: 'sfx', name: 'whoosh' }], note: 'play.flag_back' };
  }
  const bed = /** @type {Rect} */ (bedRect(board, verb.anchor, monkey));
  const r = bed.j1 - bed.j0 + 1;
  const c = bed.i1 - bed.i0 + 1;
  const n = r * c;
  const [x0, z0] = centerOf(board, bed.i0, bed.j0);
  const [x1, z1] = centerOf(board, bed.i1, bed.j1);
  /** @type {[number, number]} */
  const at = [(x0 + x1) / 2, (z0 + z1) / 2];
  const { params } = problem.model;
  if (bedAnswers(/** @type {any} */ (params), r, c)) {
    return { verb: { ...verb, grown: bed }, monkey, events: [], attempt: { correct: true, info: { tag: 'correct', value: n, r, c }, at } };
  }
  const tag = n === params.total ? 'shape' : n < params.total ? 'too_few' : 'too_many';
  return { verb, monkey, events: [], attempt: { correct: false, info: { tag: 'near_miss', value: n, array: { tag, r, c, n } }, at } };
}

/**
 * The value on the vine at a point across it: the first plank is `lo`,
 * the last `hi`, evenly between.
 * @param {Board} board @param {Problem} problem @param {number} x
 */
export function vineValue(board, problem, x) {
  const vine = /** @type {NonNullable<Board['vine']>} */ (board.vine);
  const [ax] = centerOf(board, vine.i0, vine.j);
  const [bx] = centerOf(board, vine.i1, vine.j);
  const { lo, hi } = problem.model.params;
  return lo + Math.max(0, Math.min(1, (x - ax) / (bx - ax))) * (hi - lo);
}

/**
 * The marks along the vine at a labelling level: every 1/d, labelled
 * (level 0); every 1/d with only the wholes and halves labelled (1);
 * only the whole and half marks, bare (2). An odd denominator, which has
 * no half mark of its own, gets a half anchor anyway.
 * @param {Problem} problem @param {number} level
 * @returns {Array<{ value: number, big: boolean, label: string | null }>}
 */
export function vineTicks(problem, level) {
  const { lo, hi, d } = problem.model.params;
  /** @type {Array<{ value: number, big: boolean, label: string | null }>} */
  const ticks = [];
  let half = false;
  for (let k = 1; k < d * (hi - lo); k++) {
    const value = lo + k / d;
    const whole = Number.isInteger(value);
    const isHalf = !whole && Number.isInteger(value * 2);
    half ||= isHalf;
    if (level >= 2 && !whole && !isHalf) continue;
    /** @type {string | null} */
    let label = null;
    if (level === 0) label = whole ? String(value) : `${Math.round(value * d)}/${d}`;
    else if (level === 1 && whole) label = String(value);
    else if (level === 1 && isHalf) label = value === 0.5 ? '½' : `${Math.floor(value)}½`;
    ticks.push({ value, big: whole || isHalf, label });
  }
  if (!half && lo < 0.5 && hi > 0.5) ticks.push({ value: 0.5, big: true, label: level <= 1 ? '½' : null });
  return ticks;
}

/**
 * LINE: ring the bell where the monkey stands on the vine. Close enough
 * (by the scaffold's tolerance) is the answer; anywhere else is a comic
 * tumble into the water, a climb back out at the start, and the full
 * labels back on the vine.
 * @param {Board} board @param {Problem} problem @param {Extract<Verb, { kind: 'numberline' }>} verb @param {Monkey} monkey @param {boolean} nearMimi
 * @returns {Outcome | null}
 */
function lineAct(board, problem, verb, monkey, nearMimi) {
  const vine = /** @type {NonNullable<Board['vine']>} */ (board.vine);
  const [i, j] = tileAt(board, monkey.x, monkey.z);
  if (j !== vine.j || i < vine.i0 || i > vine.i1) {
    return nearMimi ? null : { verb, monkey, events: [{ kind: 'sfx', name: 'click' }], note: 'play.off_vine' };
  }
  const value = vineValue(board, problem, monkey.x);
  const { lo, hi } = problem.model.params;
  const answer = /** @type {number} */ (problem.answer);
  /** @type {[number, number]} */
  const at = [monkey.x, monkey.z];
  const ring = /** @type {GameEvent} */ ({ kind: 'sfx', name: 'chime' });
  if (Math.abs(value - answer) <= /** @type {{ tol: number }} */ (problem.accept).tol * (hi - lo)) {
    return { verb, monkey, events: [ring], attempt: { correct: true, info: { tag: 'correct', value }, at } };
  }
  const back = { ...createMonkey(board), face: monkey.face, stride: monkey.stride, dunkMs: DUNK_MS };
  return {
    verb: { ...verb, level: 0 },
    monkey: back,
    events: [ring, { kind: 'sfx', name: 'splash' }, { kind: 'fx', fx: 'ripple', at: [at[0], 0.05, at[1]], colors: ['#fffdf6'] },
      { kind: 'fx', fx: 'dust', at: [at[0], 0.2, at[1]], colors: ['#0ea5e9', '#fffdf6'], count: 10 }, followMonkey(back)],
    attempt: { correct: false, info: { tag: value < answer ? 'magnitude_low' : 'magnitude_high', value }, at },
  };
}

/**
 * The world points of the baskets in play.
 * @param {Board} board @param {Extract<Verb, { kind: 'share' }>} verb @returns {Array<[number, number]>}
 */
function basketPoints(board, verb) {
  return verb.baskets.map((b) => centerOf(board, b.i, b.j));
}

/**
 * SHARE, checked: fair when every basket holds the same and only the
 * leftovers stay on the stump (then each holds the quotient).
 * @param {Board} board @param {Problem} problem @param {Extract<Verb, { kind: 'share' }>} verb @returns {Attempt}
 */
export function checkShare(board, problem, verb) {
  const counts = verb.baskets.map((b) => b.count);
  const fair = counts.every((c) => c === counts[0]);
  const [i, j] = /** @type {[number, number]} */ (board.stump);
  const at = centerOf(board, i, j);
  if (fair && verb.pile === problem.model.params.remainder) return { correct: true, info: { tag: 'correct', value: counts[0] }, at };
  return { correct: false, info: { tag: fair ? 'share_more' : 'unfair_share', value: counts.join(',') }, at };
}

/**
 * SHARE, taken back: the last coconut dealt returns to the stump.
 * @param {Extract<Verb, { kind: 'share' }>} verb @param {Monkey} monkey @returns {Outcome}
 */
export function takeBack(verb, monkey) {
  if (verb.drops.length === 0) return { verb, monkey, events: [{ kind: 'sfx', name: 'click' }], note: 'play.nothing_back' };
  const k = verb.drops[verb.drops.length - 1];
  return {
    verb: {
      ...verb,
      pile: verb.pile + 1,
      drops: verb.drops.slice(0, -1),
      baskets: verb.baskets.map((b, n) => (n === k ? { ...b, count: b.count - 1 } : b)),
    },
    monkey,
    events: [{ kind: 'sfx', name: 'whoosh' }],
  };
}

/**
 * SHARE: deal into the basket at hand, take back at the stump, a word
 * at a resting basket, or — out in the open — check the share.
 * @param {Board} board @param {Problem} problem @param {Extract<Verb, { kind: 'share' }>} verb @param {Monkey} monkey @param {boolean} nearMimi
 * @returns {Outcome | null}
 */
function shareAct(board, problem, verb, monkey, nearMimi) {
  const k = nearest(monkey, basketPoints(board, verb), REACH.basket);
  if (k >= 0) {
    if (verb.pile === 0) return { verb, monkey, events: [{ kind: 'sfx', name: 'click' }], note: 'play.pile_empty' };
    const [x, z] = basketPoints(board, verb)[k];
    const count = verb.baskets[k].count + 1;
    return {
      verb: { ...verb, pile: verb.pile - 1, drops: [...verb.drops, k], baskets: verb.baskets.map((b, n) => (n === k ? { ...b, count } : b)) },
      monkey,
      events: [{ kind: 'sfx', name: 'pop', pitch: 1 + count * 0.05 }, { kind: 'fx', fx: 'dust', at: [x, 0.5, z], colors: ['#78350f', '#fde68a'], count: 4 }],
    };
  }
  const [si, sj] = /** @type {[number, number]} */ (board.stump);
  if (distanceTo(monkey, centerOf(board, si, sj)) <= REACH.stump) return takeBack(verb, monkey);
  const resting = board.baskets.map(([i, j]) => centerOf(board, i, j));
  if (nearest(monkey, resting, REACH.basket) >= 0) return { verb, monkey, events: [{ kind: 'sfx', name: 'click' }], note: 'play.basket_rest' };
  if (nearMimi) return null;
  return { verb, monkey, events: [], attempt: checkShare(board, problem, verb) };
}

/**
 * Act, by the verb of the problem being played. Null when the verb has
 * nothing to do here — the caller lets Mimi talk or the monkey hop.
 * @param {Board} board @param {Problem} problem @param {Verb} verb @param {Monkey} monkey
 * @returns {Outcome | null}
 */
export function verbAct(board, problem, verb, monkey) {
  const nearMimi = distanceTo(monkey, centerOf(board, board.mimi[0], board.mimi[1])) <= REACH.mimi;
  if (verb.kind === 'fetch') return fetchAct(board, problem, verb, monkey, nearMimi);
  if (verb.kind === 'array') return arrayAct(board, problem, verb, monkey, nearMimi);
  if (verb.kind === 'numberline') return lineAct(board, problem, verb, monkey, nearMimi);
  return shareAct(board, problem, verb, monkey, nearMimi);
}

/**
 * FETCH answered without walking (the HUD's stone buttons): the stone
 * with that label — on the ground or in hand — is offered at once.
 * Null when no stone says that.
 * @param {Board} board @param {Problem} problem @param {Extract<Verb, { kind: 'fetch' }>} verb @param {Monkey} monkey @param {unknown} value
 * @returns {Outcome | null}
 */
export function answerFetch(board, problem, verb, monkey, value) {
  const label = String(value);
  if (monkey.carry?.label === label) {
    const out = offer(board, problem, verb.stones, monkey, monkey.carry);
    return { verb: { ...verb, stones: out.stones }, monkey: { ...monkey, carry: null }, events: [{ kind: 'sfx', name: 'whoosh' }], attempt: out.attempt };
  }
  const stone = verb.stones.find((s) => s.label === label);
  if (!stone) return null;
  const out = offer(board, problem, verb.stones.filter((s) => s !== stone), monkey, stone);
  return { verb: { ...verb, stones: out.stones }, monkey, events: [{ kind: 'sfx', name: 'whoosh' }], attempt: out.attempt };
}
