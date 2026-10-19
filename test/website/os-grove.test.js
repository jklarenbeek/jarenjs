//@ts-check
/**
 * Monkey Grove — Radiant edition: the adaptive arithmetic engine (the
 * ladder, Elo rating with rust, selection, difficulty targeting, kinds
 * and what a board can host, every generator and its misconception
 * stones), the strings in both languages, the boards, the monkey's
 * walking body against the collision mesh, the four verbs, whole
 * chambers and a Banana Duel played headlessly through `play()`, saving
 * and restoring, the coach's tools, the HUD, and every board drawn in
 * every theme.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { lerpColor } from '@jarenjs/core/color';
import { grove, restoreProgress, describe as coachView, DUEL_ROUNDS } from '../../packages/website/src/os/games/grove/index.js';
import {
  WORLDS, LADDER, SKILLS, SKILL_IDS, RATING, HOST_LIMITS, createMath, expected, decayed, scaffoldFor, isMastered,
  lastPracticed, daysSince, effectiveRating, recordResult, focusSkill, targetDifficulty, nextProblem, ensureHostable,
  masteryReport, gateStage, explainKey, answerLabel, lineVars, solvedEquation,
} from '../../packages/website/src/os/games/grove/math.js';
import {
  GENERATORS, LINE_TOLERANCE, gcd, coprimes, reverseDigits, mixedNumberLabel, divisionAnswerLabel, pickTier,
  buildChoices, buildFracChoices, buildMixedDivisionChoices,
} from '../../packages/website/src/os/games/grove/generators.js';
import {
  HUB, makeBoard, varyLayout, reachable, findPath, canHost, boardKindFor, tileAt, centerOf, charAt, isWalkable,
} from '../../packages/website/src/os/games/grove/boards.js';
import {
  SPEED, RADIUS, JUMP_MS, DUNK_MS, SOLIDS, meshOf, cachedMeshes, createMonkey, followMonkey, walkTo, moveMonkey, distanceTo, nearest,
} from '../../packages/website/src/os/games/grove/walk.js';
import {
  REACH, verbFor, verbAct, answerFetch, bedRect, bedAnswers, vineValue, vineTicks, checkShare, takeBack,
} from '../../packages/website/src/os/games/grove/verbs.js';
import { PROBLEMS_PER_CHAMBER, CELEBRATE_MS, TOAST_MS, adviceLines } from '../../packages/website/src/os/games/grove/flow.js';
import { drawGrove, hubBloom } from '../../packages/website/src/os/games/grove/draw.js';
import { STAND, walkPose, monkey, monkeyShape, monkeyPose, mimiPose, flowerSpot } from '../../packages/website/src/os/games/grove/shapes.js';
import { LANGS, TABLES, t, langOf, hasLine } from '../../packages/website/src/os/games/grove/strings.js';
import { createRng, hashString, seedOf } from '../../packages/website/src/os/games/grove/rng.js';
import { COLORS, WORLD_COLORS } from '../../packages/website/src/os/games/grove/palette.js';
import { play, idle, TICK_MS } from '../../packages/website/src/os/games/game.js';
import { viewOf } from '../../packages/website/src/os/stage/camera.js';
import { STAGE_THEMES } from '../../packages/website/src/os/stage/scene.js';
import { POSES, skeleton } from '../../packages/website/src/os/stage/figures.js';
import { createLighting } from '../../packages/website/src/os/engine/light.js';
import { BANNED_HUES } from '../../scripts/check-site-design.js';

const DAY = 86400000;
const BASE = 1_700_000_000_000;
const PLAYER = Object.freeze({ id: 'ada', name: 'Ada', color: '#2563eb' });
const GUEST = Object.freeze({ id: 'bo', name: 'Bo', color: '#f97316' });
const FRAC_RE = /^\d+\/\d+$/;
const MIXED_RE = /^\d+ \d+\/\d+$/;
const KINDS = ['fetch', 'array', 'numberline', 'share'];
const NO_KEYS = Object.freeze(/** @type {{ up: boolean, down: boolean, left: boolean, right: boolean }} */ ({ up: false, down: false, left: false, right: false }));

/**
 * A math state with one skill set.
 * @param {string} id @param {number} r @param {number} [n] @param {number[]} [hist]
 */
function rated(id, r, n = 20, hist = []) {
  const m = createMath();
  m.skills[id] = { r, n, hist };
  return m;
}

/** A skill mastered: high rating, warmed up, ten right in a row. @param {any} m @param {string} id */
function master(m, id) {
  m.skills[id] = { r: 900, n: 20, hist: Array(10).fill(1) };
  return m;
}

/** A skill mastered at a moment, its last practice logged then. @param {any} m @param {string} id @param {number} at @param {number} [r] */
function masterAt(m, id, at, r = 900) {
  m.skills[id] = { r, n: 24, hist: Array(10).fill(1) };
  m.log.push({ t: at, skill: id, tag: 'correct', item: null, value: null, ok: true, ms: 1, hint: false, retry: false });
}

/** Every problem is well formed for its kind. @param {any} p */
function validateProblem(p) {
  const ctx = `${p.skillId}/${p.kind}`;
  assert.equal(typeof p.id, 'string', ctx);
  assert.ok(p.id.startsWith(`${p.skillId}-`), ctx);
  assert.equal(p.world, SKILLS[p.skillId].world, ctx);
  assert.ok(KINDS.includes(p.kind), ctx);
  assert.ok(p.equation.length > 0, ctx);
  assert.ok(p.prompt.key.startsWith('q.') && hasLine(p.prompt.key), ctx);
  assert.ok([0, 1, 2].includes(p.scaffold), ctx);
  assert.ok(p.difficulty >= 300 && p.difficulty <= 1500, `${ctx} difficulty ${p.difficulty}`);
  assert.ok(p.explain.key.startsWith('ex.') && hasLine(p.explain.key), ctx);
  assert.equal(typeof p.model.kind, 'string', ctx);
  if (p.kind === 'fetch') {
    assert.match(p.equation, /[?⬚]/, ctx);
    assert.equal(p.accept, null, ctx);
    assert.ok(p.choices.length >= 4 && p.choices.length <= 6, `${ctx} ${p.choices.length} choices`);
    const labels = p.choices.map((/** @type {any} */ c) => String(c.value));
    assert.equal(new Set(labels).size, labels.length, `${ctx} duplicate choices ${labels}`);
    const correct = p.choices.filter((/** @type {any} */ c) => c.tag === 'correct');
    assert.equal(correct.length, 1, ctx);
    assert.equal(String(correct[0].value), String(p.answer), ctx);
    assert.equal(labels.filter((l) => l === String(p.answer)).length, 1, `${ctx} the answer is a stone exactly once`);
    for (const c of p.choices) {
      if (typeof c.value === 'number') assert.ok(Number.isInteger(c.value) && c.value >= 0, `${ctx} value ${c.value}`);
      else assert.match(c.value, new RegExp(`${FRAC_RE.source}|${MIXED_RE.source}`), ctx);
    }
  }
  else assert.equal(p.choices, null, ctx);
  if (p.kind === 'array') {
    const { rows, cols, total, given } = p.model.params;
    assert.equal(rows * cols, total, ctx);
    assert.ok(['both', 'rows', 'total'].includes(given), ctx);
    assert.equal(p.answer, total, ctx);
    assert.match(p.equation, /[?⬚]/, ctx);
  }
  if (p.kind === 'numberline') {
    const { n, d, lo, hi } = p.model.params;
    assert.ok(lo < n / d && n / d < hi && !Number.isInteger(n / d), `${ctx} ${n}/${d}`);
    assert.ok(p.accept.tol > 0, ctx);
    assert.ok(Math.abs(p.answer - n / d) < 1e-12, ctx);
  }
  if (p.kind === 'share') {
    const { total, baskets, quotient, remainder } = p.model.params;
    assert.equal(total, baskets * quotient + remainder, ctx);
    assert.ok(remainder >= 0 && remainder < baskets, ctx);
    assert.equal(p.answer, quotient, ctx);
  }
}

/** The documented difficulty tiers of every skill. */
const TIERS = Object.freeze(/** @type {Record<string, number[]>} */ ({
  counting: [400, 520, 640], number_bonds: [460, 580, 700], add_20: [420, 540, 650], sub_20: [460, 580, 690],
  missing_addend: [500, 620, 780], add_100: [560, 760, 900], sub_100: [620, 840, 980], big_numbers: [820, 960, 1100],
  tables_a: [420, 520, 640], tables_b: [560, 660], tables_c: [680, 780, 860], tables_mix: [600, 700, 800], mult_2digit: [780, 940, 1100],
  div_facts: [480, 600, 720], share: [560, 700, 860], div_remainder: [680, 820, 960], missing_factor: [640, 780, 900],
  frac_magnitude: [520, 700, 880, 1040], frac_compare: [620, 760, 920], frac_equiv: [660, 800, 940], frac_of_n: [720, 880, 1040],
}));

/** A problem of a skill at a rating, warmed up. @param {string} id @param {number} r @param {string | number} seed @param {any} [kind] */
function problemOf(id, r, seed, kind) {
  return nextProblem(rated(id, r), { skill: id, kind, rng: createRng(seed) });
}

/** A fresh solo game. @param {number} [seed] @param {any} [save] @param {any} [options] */
function fresh(seed = 11, save = null, options = {}) {
  return grove.create({ seed, save, players: [PLAYER], options });
}

/** Play ticks with the same input. @param {any} state @param {number} n @param {any} [input] */
function run(state, n, input = {}) {
  return play(grove, state, Array.from({ length: n }, () => input));
}

/** Tap a point, then let the monkey walk there (and act on what it tapped). @param {any} state @param {[number, number]} point @param {number} [ticks] */
function tapWalk(state, point, ticks = 360) {
  return play(grove, state, [{ tap: { x: point[0], z: point[1] } }, ...idle(ticks)]);
}

/** The events of a kind. @param {any[]} events @param {string} kind */
const of = (events, kind) => events.filter((e) => e.kind === kind);
/** The sound names. @param {any[]} events */
const sounds = (events) => of(events, 'sfx').map((e) => e.name);
/** The effect names. @param {any[]} events */
const effects = (events) => of(events, 'fx').map((e) => e.fx);

/** A chamber of a kind in a world, found by trying seeds. @param {string} kind @param {string} world @param {any} save */
function chamberOfKind(kind, world, save) {
  for (let seed = 1; seed < 400; seed++) {
    const state = grove.act(fresh(seed, save), { type: 'world', world }).state;
    if (state.chamber.problem.kind === kind) return state;
  }
  throw new Error(`no ${kind} chamber in ${world}`);
}

/** A walkable point near nothing usable on a board. @param {any} board @param {any[]} [stones] */
function openPoint(board, stones = []) {
  for (let j = 1; j < board.d - 1; j++) {
    for (let i = 1; i < board.w - 1; i++) {
      if (!'.,'.includes(board.rows[j][i])) continue;
      const p = centerOf(board, i, j);
      const things = [board.mimi, board.altar, board.stump, ...board.baskets].filter(Boolean).map((c) => centerOf(board, c[0], c[1]));
      if (things.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) > 1.6) && stones.every((s) => Math.hypot(s.x - p[0], s.z - p[1]) > 1)) return p;
    }
  }
  throw new Error('no open point');
}

/** The free floor beside a solid tile, away from any stone. @param {any} board @param {[number, number]} cell @param {any[]} [stones] */
function beside(board, cell, stones = []) {
  for (const [di, dj] of [[0, 1], [1, 0], [-1, 0], [0, -1]]) {
    const ch = board.rows[cell[1] + dj][cell[0] + di];
    const p = centerOf(board, cell[0] + di, cell[1] + dj);
    if (isWalkable(ch) && ch !== 'V' && stones.every((s) => Math.hypot(s.x - p[0], s.z - p[1]) > REACH.stone)) return p;
  }
  throw new Error('nothing free beside');
}

/** Freeze a value all the way down. @param {any} value */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** A draw context. @param {'light' | 'dark' | 'neon'} theme @param {any} [extra] */
function ctxOf(theme, extra = {}) {
  return {
    view: viewOf(grove.camera, 960, 640), time: 1234, theme: STAGE_THEMES[theme], light: createLighting({ hour: 10 }),
    bodies: {}, reduce: false, palette: [], px: 1, ...extra,
  };
}

// ---------- randomness ----------

describe('seeded randomness', () => {
  it('replays the original game\'s streams and draws', () => {
    const rng = createRng(42);
    assert.deepEqual([rng.float(), rng.float(), rng.float()], [0.6011037519201636, 0.44829055899754167, 0.8524657934904099]);
    assert.equal(createRng('duel-42').float(), 0.8461664451751858);
    assert.equal(seedOf('duel', 42), hashString('duel:42'));
    const draws = createRng(7);
    for (let i = 0; i < 200; i++) {
      const n = draws.int(3, 5);
      assert.ok(n >= 3 && n <= 5 && Number.isInteger(n));
    }
    const list = [1, 2, 3, 4, 5];
    const shuffled = draws.shuffle(list);
    assert.deepEqual([...shuffled].sort(), list, 'a shuffle is a copy with the same members');
    assert.deepEqual(list, [1, 2, 3, 4, 5]);
    assert.ok(list.includes(draws.pick(list)));
    assert.equal(typeof draws.chance(0.5), 'boolean');
  });
});

// ---------- the math engine ----------

describe('the skill ladder', () => {
  it('has 21 story-world skills over four worlds with linear prereqs', () => {
    assert.deepEqual(WORLDS, ['tide', 'garden', 'stump', 'vines']);
    assert.equal(SKILL_IDS.length, 21);
    assert.deepEqual(WORLDS.map((w) => LADDER[w].length), [8, 5, 4, 4]);
    for (const [id, skill] of Object.entries(SKILLS)) {
      assert.equal(skill.id, id);
      if (skill.order === 0) assert.deepEqual(skill.prereqs, []);
      else assert.deepEqual(skill.prereqs, [LADDER[skill.world][skill.order - 1]]);
    }
    assert.deepEqual(SKILLS.share.kinds, ['share', 'fetch'], 'sharing is dealt by hand first');
    assert.deepEqual(SKILLS.frac_magnitude.kinds, ['numberline']);
    assert.deepEqual(SKILLS.mult_2digit.kinds, ['fetch'], 'big products never fit the soil');
    assert.equal(Object.keys(GENERATORS).length, 21);
  });

  it('starts every skill fresh at 600', () => {
    const m = createMath();
    assert.equal(Object.keys(m.skills).length, 21);
    assert.deepEqual(m.skills.add_20, { r: 600, n: 0, hist: [] });
    assert.deepEqual(m.log, []);
  });
});

describe('the rating', () => {
  it('scores by the formula: K 32, a hint worth 0.7, K 16 after twenty', () => {
    const m = createMath();
    const p = nextProblem(m, { skill: 'add_20', rng: createRng(5) });
    const e = expected(600, p.difficulty);
    assert.ok(e > 0 && e < 1);
    assert.ok(Math.abs(expected(700, 592) - 1 / (1 + 10 ** (-108 / 400))) < 1e-12);
    const right = recordResult(m, p, { correct: true });
    assert.ok(Math.abs(right.delta - 32 * (1 - e)) < 1e-9);
    assert.ok(Math.abs(right.rating - (600 + right.delta)) < 1e-9);
    assert.deepEqual(right.math.skills.add_20.hist, [1]);
    assert.equal(right.math.skills.add_20.n, 1);
    assert.deepEqual(m.skills.add_20, { r: 600, n: 0, hist: [] }, 'the state handed in is never changed');
    const hinted = recordResult(createMath(), p, { correct: true, usedHint: true });
    assert.ok(Math.abs(hinted.delta - 32 * (0.7 - e)) < 1e-9);
    assert.deepEqual(hinted.math.skills.add_20.hist, [1], 'a hinted right answer still counts right in the history');
    assert.ok(recordResult(createMath(), p, { correct: false }).delta < 0);
    const late = rated('add_20', 600, 25);
    const lateOut = recordResult(late, p, { correct: true });
    assert.ok(Math.abs(lateOut.delta - 16 * (1 - e)) < 1e-9);
  });

  it('rates a problem once: a retry after a miss is logged, never charged again', () => {
    const p = nextProblem(createMath(), { skill: 'sub_20', rng: createRng(8) });
    const first = recordResult(createMath(), p, { correct: false, tag: 'addsub_confuse', ms: 4000 }, { now: 10 });
    const again = recordResult(first.math, p, { correct: false, tag: 'reversed', ms: 1500, retry: true }, { now: 20 });
    assert.equal(again.delta, 0);
    assert.equal(again.math.skills, first.math.skills, 'the ratings are untouched');
    assert.deepEqual(again.math.log.map((e) => [e.tag, e.ms, e.retry]), [['addsub_confuse', 4000, false], ['reversed', 1500, true]],
      'each attempt keeps its own misconception and its own time');
    const right = recordResult(again.math, p, { correct: true, retry: true }, { now: 30 });
    assert.equal(right.math.skills.sub_20.n, 1);
    assert.equal(right.math.log[2].tag, 'correct');
  });

  it('keeps a ring of 200 log entries but never a skill\'s last practice', () => {
    let m = createMath();
    const p = nextProblem(m, { skill: 'sub_20', rng: createRng(8) });
    for (let i = 0; i < 250; i++) m = recordResult(m, p, { correct: i % 3 !== 0, ms: i }).math;
    assert.equal(m.log.length, 200);
    assert.equal(m.log[0].ms, 50);
    assert.equal(m.log[199].ms, 249);
    let k = createMath();
    k = recordResult(k, nextProblem(k, { skill: 'counting', rng: createRng(1) }), { correct: true }, { now: 7 }).math;
    for (let i = 0; i < 250; i++) k = recordResult(k, p, { correct: true, ms: i }, { now: 100 + i }).math;
    assert.equal(k.log.length, 200);
    assert.equal(lastPracticed(k, 'counting'), 7, 'its only practice survives two hundred later ones');
    assert.equal(k.log[1].ms, 51);
    assert.equal(lastPracticed(k, 'add_20'), 0);
  });

  it('converges for a simulated 80%-accurate learner and masters only after sustained success', () => {
    let m = createMath();
    const gen = createRng('learner-gen');
    const ans = createRng('learner-ans');
    let r200 = 0;
    for (let i = 0; i < 400; i++) {
      m = recordResult(m, nextProblem(m, { skill: 'tables_mix', rng: gen }), { correct: ans.chance(0.8) }).math;
      if (i === 199) r200 = m.skills.tables_mix.r;
    }
    assert.ok(m.skills.tables_mix.r > 850 && m.skills.tables_mix.r < 1250, `r=${m.skills.tables_mix.r}`);
    assert.ok(Math.abs(m.skills.tables_mix.r - r200) < 150);
    let s = createMath();
    /** @type {string | null} */
    let mastered = null;
    let steps = 0;
    const rng = createRng('mastery');
    while (!mastered && steps < 300) {
      const out = recordResult(s, nextProblem(s, { skill: 'add_20', rng }), { correct: true });
      s = out.math;
      mastered = out.mastered;
      steps++;
    }
    assert.equal(mastered, 'add_20');
    assert.ok(steps >= RATING.minN && s.skills.add_20.r >= RATING.mastery);
    assert.equal(isMastered({ r: 900, n: 9, hist: Array(9).fill(1) }), false, 'ten problems at least');
    assert.equal(isMastered({ r: 900, n: 12, hist: [1, 1, 1, 1, 1, 1, 1, 0, 0, 0] }), false, '80% of the last ten');
    assert.equal(isMastered({ r: 840, n: 12, hist: Array(10).fill(1) }), false, 'a rating of 850');
    assert.equal(isMastered({ r: 900, n: 12, hist: Array(10).fill(1) }, 800), false, 'the rating asked about');
  });

  it('rusts gently after a grace window, toward a fresh start and never past it', () => {
    assert.equal(decayed(900, 2), 900);
    assert.equal(decayed(540, 400), 540, 'decay only pulls down');
    assert.ok(Math.abs(decayed(900, 62) - 750) < 1e-9, 'a half-life of sixty days after the grace');
    const m = createMath();
    masterAt(m, 'add_20', BASE);
    const at = (/** @type {number} */ now) => masteryReport(m, { now }).worlds.tide.skills.find((s) => s.id === 'add_20');
    assert.equal(at(0)?.rating, 900, 'no clock: untouched');
    assert.equal(at(BASE)?.rating, 900);
    const week = at(BASE + 7 * DAY);
    assert.ok(week && week.rating < 900 && week.rating > 875 && week.mastered, 'a week only nudges');
    const sixWeeks = at(BASE + 42 * DAY);
    assert.ok(sixWeeks && sixWeeks.rating < 850 && !sixWeeks.mastered, 'six weeks de-masters');
    assert.ok(/** @type {any} */ (at(BASE + 365 * DAY)).rating >= 600);
    assert.equal(daysSince(m, 'add_20', 0), 0);
    assert.equal(daysSince(m, 'add_20', BASE - DAY), 0, 'a clock running backwards adds nothing');
    assert.equal(daysSince(m, 'counting', BASE), 0, 'never practiced');
    assert.ok(Math.abs(effectiveRating(m, 'add_20', BASE + 62 * DAY) - 750) < 1e-9);
    const p = nextProblem(m, { skill: 'add_20', rng: createRng(1), now: BASE + 62 * DAY });
    const out = recordResult(m, p, { correct: true }, { now: BASE + 62 * DAY });
    assert.ok(Math.abs(out.rating - out.delta - 750) < 1e-9, 'the rust is baked in before scoring');
  });

  it('reports each world\'s share of mastery and the weakest practiced skills', () => {
    const m = createMath();
    const empty = masteryReport(m);
    assert.deepEqual(Object.keys(empty.worlds), WORLDS);
    assert.deepEqual(empty.weakest, []);
    for (const w of WORLDS) assert.equal(empty.worlds[w].pct, 0);
    m.skills.counting = { r: 725, n: 5, hist: [1, 1] };
    master(m, 'number_bonds');
    m.skills.tables_b = { r: 480, n: 5, hist: [0, 1, 0] };
    m.skills.share = { r: 650, n: 4, hist: [1] };
    m.skills.frac_equiv = { r: 620, n: 2, hist: [0] };
    const rep = masteryReport(m);
    assert.ok(Math.abs(rep.worlds.tide.pct - (0.5 * 0.5 + 1) / 8) < 1e-12);
    assert.equal(rep.worlds.tide.skills[1].mastered, true);
    assert.deepEqual(rep.weakest, ['tables_b', 'frac_equiv', 'share']);
    assert.deepEqual([0, 0.11, 0.12, 0.35, 0.59, 0.6, 0.88, 1].map(gateStage), [0, 0, 1, 2, 2, 3, 4, 4]);
  });
});

describe('selection and targeting', () => {
  it('focuses a fresh world on its first skill', () => {
    for (const [world, first] of [['tide', 'counting'], ['garden', 'tables_a'], ['stump', 'div_facts'], ['vines', 'frac_magnitude']]) {
      const rng = createRng(`fresh-${world}`);
      for (let i = 0; i < 50; i++) assert.equal(nextProblem(createMath(), { world, rng }).skillId, first);
    }
    assert.equal(focusSkill(createMath(), 'stump'), 'div_facts');
    const all = createMath();
    for (const id of LADDER.vines) master(all, id);
    assert.equal(focusSkill(all, 'vines'), 'frac_of_n', 'all mastered: the top of the ladder');
  });

  it('mixes the focus 70%, the skill below 20% and a mastered refresher 10%', () => {
    const m = createMath();
    for (const id of ['counting', 'number_bonds', 'add_20']) master(m, id);
    const rng = createRng('mix');
    /** @type {Record<string, number>} */
    const counts = {};
    for (let i = 0; i < 300; i++) {
      const id = nextProblem(m, { world: 'tide', rng }).skillId;
      counts[id] = (counts[id] ?? 0) + 1;
    }
    for (const id of Object.keys(counts)) assert.ok(['counting', 'number_bonds', 'add_20', 'sub_20'].includes(id), id);
    assert.ok(counts.sub_20 > 160, `focus ${counts.sub_20}`);
    assert.ok(counts.add_20 > 40, `review ${counts.add_20}`);
    const cross = createMath();
    master(cross, 'add_20');
    master(cross, 'tables_a');
    const seen = new Set();
    const r2 = createRng('refresh');
    for (let i = 0; i < 400; i++) seen.add(nextProblem(cross, { world: 'stump', rng: r2 }).skillId);
    assert.ok(seen.has('div_facts') && (seen.has('add_20') || seen.has('tables_a')), 'a refresher can come from another world');
    const anywhere = new Set();
    const r3 = createRng('anywhere');
    for (let i = 0; i < 40; i++) anywhere.add(nextProblem(createMath(), { rng: r3 }).world);
    assert.equal(anywhere.size, 4, 'no world named: any of them');
  });

  it('aims 108 under the rating, opens gently while cold and ramps on a streak, with ±40 jitter', () => {
    const still = /** @type {any} */ ({ float: () => 0.5 });
    assert.equal(targetDifficulty({ r: 700, n: 20, hist: [] }, still, 700), 592);
    assert.equal(targetDifficulty({ r: 700, n: 0, hist: [] }, still, 700), 592 - 200);
    assert.equal(targetDifficulty({ r: 700, n: 3, hist: [0, 1, 1] }, still, 700), 592 - 125 + 90);
    assert.equal(targetDifficulty({ r: 700, n: 20, hist: [] }, /** @type {any} */ ({ float: () => 0 }), 700), 552);
    assert.ok(targetDifficulty({ r: 700, n: 20, hist: [] }, /** @type {any} */ ({ float: () => 0.999999 }), 700) < 632);
    assert.deepEqual(pickTier([{ d: 400 }, { d: 500 }], 450), { d: 400 }, 'the first wins a tie');
    assert.deepEqual(pickTier([{ d: 400 }, { d: 500 }], 470), { d: 500 });
    const avg = (/** @type {number} */ n) => {
      let sum = 0;
      for (let i = 0; i < 60; i++) sum += nextProblem(rated('add_20', 600, n), { skill: 'add_20', rng: createRng(900 + i) }).difficulty;
      return sum / 60;
    };
    assert.ok(avg(0) < avg(20), 'cold start serves easier tiers');
  });

  it('reaches every tier of every skill, each the closest to its target', () => {
    for (const id of SKILL_IDS) {
      const seen = new Set();
      for (let r = 300; r <= 1500; r += 10) {
        const kind = id === 'frac_magnitude' ? 'numberline' : 'fetch';
        const rng = createRng(`tier:${id}:${r}`);
        const p = nextProblem(rated(id, r), { skill: id, kind, rng });
        seen.add(p.difficulty);
        const replay = createRng(`tier:${id}:${r}`);
        const target = targetDifficulty({ r, n: 20, hist: [] }, replay, r);
        const closest = TIERS[id].reduce((best, d) => (Math.abs(d - target) < Math.abs(best - target) ? d : best), TIERS[id][0]);
        assert.equal(p.difficulty, closest, `${id} @${r}`);
      }
      assert.deepEqual([...seen].sort((a, b) => a - b), TIERS[id], id);
    }
  });

  it('keeps the expected success near 65% at every tier, and a learner in the band', () => {
    for (const id of SKILL_IDS) {
      for (const tier of TIERS[id]) {
        const m = rated(id, tier + RATING.offset);
        const rng = createRng(`expect:${id}:${tier}`);
        let sum = 0;
        for (let i = 0; i < 600; i++) sum += expected(m.skills[id].r, nextProblem(m, { skill: id, rng }).difficulty);
        assert.ok(Math.abs(sum / 600 - 0.65) < 0.035, `${id} @${tier}: ${(sum / 600).toFixed(3)}`);
      }
    }
    for (const [id, ability] of [['tables_mix', 808], ['add_20', 650], ['frac_compare', 900], ['div_remainder', 1000]]) {
      let m = createMath();
      const gen = createRng(`gen:${id}`);
      const ans = createRng(`ans:${id}`);
      let hits = 0;
      for (let i = 0; i < 1200; i++) {
        const p = nextProblem(m, { skill: /** @type {string} */ (id), rng: gen });
        const correct = ans.chance(expected(/** @type {number} */ (ability), p.difficulty));
        m = recordResult(m, p, { correct }, { now: i }).math;
        if (i >= 600) hits += correct ? 1 : 0;
      }
      assert.ok(hits / 600 > 0.55 && hits / 600 < 0.75, `${id}: realized ${(hits / 600).toFixed(3)}`);
    }
  });

  it('fades the scaffold with the rating', () => {
    assert.deepEqual([400, 519, 520, 759, 760, 1200].map(scaffoldFor), [0, 0, 1, 1, 2, 2]);
    for (const r of [400, 600, 900]) assert.equal(problemOf('add_20', r, 1).scaffold, scaffoldFor(r));
    assert.deepEqual(LINE_TOLERANCE, [0.05, 0.03, 0.02]);
    assert.deepEqual([400, 600, 900].map((r) => problemOf('frac_magnitude', r, 2).accept?.tol), [0.05, 0.03, 0.02]);
    assert.equal(problemOf('tables_a', 400, 3, 'array').model.params.given, 'both', 'full support names both sides');
  });

  it('is deterministic from the seed, needs a stream, and names problems apart', () => {
    const make = (/** @type {string} */ seed) => {
      const rng = createRng(seed);
      const m = createMath();
      return [nextProblem(m, { world: 'garden', rng }), nextProblem(m, { world: 'vines', rng }), nextProblem(m, { skill: 'sub_100', rng })];
    };
    assert.deepEqual(make('duel-42'), make('duel-42'));
    assert.notDeepEqual(make('duel-42'), make('duel-43'));
    const [a, b] = make('duel-42');
    assert.notEqual(a.id, b.id);
    assert.throws(() => nextProblem(createMath(), /** @type {any} */ ({ world: 'garden' })), /random stream/);
  });

  it('spreads the first number-line targets', () => {
    let m = createMath();
    const rng = createRng('vine-openers');
    const labels = [];
    const values = [];
    for (let i = 0; i < 3; i++) {
      const p = nextProblem(m, { skill: 'frac_magnitude', rng });
      validateProblem(p);
      labels.push(`${p.meta.n}/${p.meta.d}`);
      values.push(p.answer);
      m = recordResult(m, p, { correct: true }).math;
    }
    assert.equal(new Set(labels).size, 3, labels.join(', '));
    assert.equal(new Set(values).size, 3, labels.join(', '));
  });
});

describe('kinds and hosting', () => {
  it('honours a forced kind the skill supports, else plays its natural one', () => {
    for (const id of ['tables_a', 'tables_c', 'tables_mix']) assert.equal(problemOf(id, 700, 7, 'array').kind, 'array');
    assert.equal(problemOf('mult_2digit', 700, 7, 'array').kind, 'fetch');
    for (const id of ['div_facts', 'share', 'div_remainder', 'missing_factor']) assert.equal(problemOf(id, 700, 7, 'share').kind, 'share');
    for (const id of ['share', 'div_remainder']) assert.equal(problemOf(id, 700, 7, 'fetch').kind, 'fetch');
    assert.equal(problemOf('frac_magnitude', 700, 7, 'array').kind, 'numberline');
    assert.equal(problemOf('add_20', 700, 7, 'share').kind, 'fetch');
    const exact = problemOf('share', 700, 7, 'share');
    const left = problemOf('div_remainder', 700, 79, 'share');
    assert.equal(exact.prompt.key, 'q.share');
    assert.equal(left.prompt.key, 'q.share_remainder');
    assert.ok(left.prompt.vars.remainder > 0);
  });

  it('mixes beds and sharing in about a third of the time once a skill is warm', () => {
    let arrays = 0;
    const r1 = createRng('kindmix');
    for (let i = 0; i < 200; i++) if (nextProblem(rated('tables_a', 700, 12), { skill: 'tables_a', rng: r1 }).kind === 'array') arrays++;
    assert.ok(arrays > 30 && arrays < 120, `arrays=${arrays}`);
    let shares = 0;
    const r2 = createRng('kindmix2');
    for (let i = 0; i < 200; i++) if (nextProblem(rated('div_facts', 700, 12), { skill: 'div_facts', rng: r2 }).kind === 'share') shares++;
    assert.ok(shares > 30 && shares < 120, `shares=${shares}`);
    const r3 = createRng('kindmix3');
    for (let i = 0; i < 50; i++) assert.equal(nextProblem(rated('tables_a', 700, 0), { skill: 'tables_a', rng: r3 }).kind, 'fetch');
  });

  it('turns a bed too big for the soil, regenerates what no board can host, and strips tide sums', () => {
    const math = createMath();
    const options = { rng: createRng(3) };
    const bed = problemOf('tables_c', 860, 1, 'array');
    const tall = { ...bed, model: { kind: 'array', params: { rows: 9, cols: 6, total: 54, given: 'both' } }, prompt: { key: 'q.array_both', vars: { rows: 9, cols: 6, total: 54 } } };
    const turned = ensureHostable(tall, math, options);
    assert.deepEqual(turned.model.params, { rows: 6, cols: 9, total: 54, given: 'both' });
    assert.deepEqual(turned.prompt.vars, { rows: 6, cols: 9, total: 54 });
    assert.ok(turned.model.params.rows <= HOST_LIMITS.arrayRows && turned.model.params.cols <= HOST_LIMITS.arrayCols);
    const rows = ensureHostable({ ...tall, model: { kind: 'array', params: { rows: 9, cols: 6, total: 54, given: 'rows' } } }, math, options);
    assert.equal(rows.kind, 'fetch', 'the named rows cannot turn sideways');
    assert.equal(rows.skillId, 'tables_c');
    const huge = ensureHostable({ ...tall, model: { kind: 'array', params: { rows: 9, cols: 9, total: 81, given: 'total' } } }, math, options);
    assert.equal(huge.kind, 'fetch');
    const crowd = problemOf('share', 600, 2, 'share');
    const many = ensureHostable({ ...crowd, model: { kind: 'baskets', params: { ...crowd.model.params, baskets: 7 } } }, math, options);
    assert.equal(many.kind, 'fetch');
    assert.equal(many.skillId, 'share');
    assert.equal(ensureHostable(crowd, math, options), crowd, 'a hostable problem passes as it is');
    assert.equal(problemOf('div_facts', 900, 2, 'share').model.params.baskets > HOST_LIMITS.baskets, true);
    assert.equal(ensureHostable(problemOf('div_facts', 900, 2, 'share'), math, options).kind, 'fetch', 'sevens and up share into too many baskets');
    assert.deepEqual(ensureHostable(problemOf('add_20', 600, 1), math, options).model, { kind: 'strip', params: { ...problemOf('add_20', 600, 1).meta, op: '+' } });
    const sub = ensureHostable(problemOf('sub_20', 600, 1), math, options);
    assert.equal(sub.model.params.op, '−');
    const gap = ensureHostable(problemOf('missing_addend', 600, 1), math, options);
    assert.equal(gap.model.params.b, gap.meta.c - gap.meta.a, 'a missing addend is the gap');
    assert.equal(ensureHostable(problemOf('counting', 600, 1), math, options).model.kind, 'none', 'counting has no strip');
  });
});

describe('the generators', () => {
  it('make valid problems for every skill at every rating, with the right arithmetic', () => {
    for (const id of SKILL_IDS) {
      for (const r of [400, 600, 900, 1200]) {
        for (let i = 0; i < 12; i++) {
          const p = problemOf(id, r, `${id}:${r}:${i}`);
          validateProblem(p);
          const { meta } = p;
          if (id === 'counting') assert.equal(p.answer, meta.a + 2);
          if (id === 'number_bonds' || id === 'missing_addend') assert.equal(meta.a + p.answer, meta.c);
          if (['add_20', 'add_100', 'big_numbers'].includes(id)) assert.equal(p.answer, meta.a + meta.b);
          if (id === 'sub_20' || id === 'sub_100') assert.equal(p.answer, meta.a - meta.b);
          if (id.startsWith('tables') || id === 'mult_2digit') assert.equal(p.answer, meta.a * meta.b);
          if (id === 'div_facts' && p.kind === 'fetch') assert.equal(p.answer, meta.c / meta.a);
          if (id === 'share') assert.equal(p.answer, meta.total / meta.baskets);
          if (id === 'div_remainder' && p.kind === 'fetch') assert.equal(p.answer, divisionAnswerLabel(meta.total, meta.baskets));
          if (id === 'missing_factor' && p.kind === 'fetch') assert.equal(Number(p.answer) * meta.b, meta.c);
          if (id === 'frac_compare') {
            const value = (/** @type {string} */ s) => Number(s.split('/')[0]) / Number(s.split('/')[1]);
            assert.equal(value(String(p.answer)), Math.max(...meta.fractions.map(value)));
            for (const c of p.choices ?? []) if (c.tag !== 'correct') assert.ok(value(String(c.value)) < value(String(p.answer)));
          }
          if (id === 'frac_equiv') {
            const [n, d] = String(p.answer).split('/').map(Number);
            assert.ok(Math.abs(n / d - meta.n / meta.d) < 1e-12);
            const twins = (p.choices ?? []).filter((c) => {
              const [cn, cd] = String(c.value).split('/').map(Number);
              return Math.abs(cn / cd - meta.n / meta.d) < 1e-9;
            });
            assert.equal(twins.length, 1, 'exactly one stone is worth the same');
          }
          if (id === 'frac_of_n') assert.equal(p.answer, (meta.whole / meta.d) * meta.n);
        }
      }
    }
  });

  it('tag their stones with the misconception each one shows', () => {
    /** @type {Record<string, Set<string>>} */
    const tags = {};
    for (const id of SKILL_IDS) {
      tags[id] = new Set();
      for (const r of [500, 650, 800, 1100]) {
        for (let i = 0; i < 60; i++) {
          const p = problemOf(id, r, `tags:${id}:${r}:${i}`, id === 'frac_magnitude' ? undefined : 'fetch');
          for (const c of p.choices ?? []) {
            tags[id].add(c.tag);
            const { a, b, c: whole } = p.meta;
            if (c.tag === 'addsub_confuse' && id === 'add_20') assert.equal(c.value, Math.abs(a - b));
            if (c.tag === 'addsub_confuse' && id === 'sub_20') assert.equal(c.value, a + b);
            if (c.tag === 'addsub_confuse' && (id === 'missing_addend' || id === 'number_bonds')) assert.equal(c.value, a + whole);
            if (c.tag === 'reversed' && typeof p.answer === 'number') assert.equal(c.value, reverseDigits(p.answer) ?? reverseDigits(p.meta.a));
            if (c.tag === 'no_carry' && id === 'add_100') assert.equal(c.value, (((a % 10) + (b % 10)) % 10) + 10 * (Math.floor(a / 10) + Math.floor(b / 10)));
            if (c.tag === 'borrow') assert.equal(c.value, (Math.floor(a / 10) - Math.floor(b / 10)) * 10 + Math.abs((a % 10) - (b % 10)));
            if (c.tag === 'remainder_ignored') assert.equal(c.value, p.meta.quotient);
            if (c.tag === 'whole_number_bias' && id === 'frac_of_n') assert.equal(c.value, p.meta.n === 1 ? p.meta.whole : p.meta.whole / p.meta.d);
          }
        }
      }
    }
    const want = /** @type {Record<string, string[]>} */ ({
      counting: ['correct', 'near_miss', 'reversed'],
      number_bonds: ['addsub_confuse', 'reversed', 'near_miss'],
      add_20: ['addsub_confuse', 'reversed', 'near_miss'],
      sub_20: ['addsub_confuse', 'reversed', 'near_miss'],
      missing_addend: ['addsub_confuse', 'reversed', 'near_miss'],
      add_100: ['no_carry', 'reversed', 'near_miss'],
      sub_100: ['borrow', 'reversed', 'near_miss'],
      big_numbers: ['reversed', 'near_miss'],
      tables_mix: ['off_by_table', 'addsub_confuse', 'reversed', 'near_miss'],
      mult_2digit: ['no_carry', 'off_by_table', 'reversed', 'near_miss'],
      div_facts: ['off_by_table', 'addsub_confuse', 'near_miss'],
      div_remainder: ['remainder_ignored', 'near_miss', 'random'],
      missing_factor: ['off_by_table', 'addsub_confuse', 'reversed'],
      frac_compare: ['whole_number_bias', 'near_miss', 'random'],
      frac_equiv: ['add_tops_bottoms', 'near_miss', 'whole_number_bias'],
      frac_of_n: ['whole_number_bias', 'near_miss', 'random'],
    });
    for (const [id, list] of Object.entries(want)) for (const tag of list) assert.ok(tags[id].has(tag), `${id} never shows ${tag}`);
    assert.ok(tags.tables_a.has('random'), 'padding fills what the candidates cannot');
  });

  it('build six whole stones, four fraction stones and reduced mixed labels', () => {
    const rng = createRng(5);
    const six = buildChoices(rng, 12, [{ value: 12, tag: 'reversed' }, { value: null, tag: 'reversed' }, { value: 0, tag: 'near_miss' }, { value: 21, tag: 'reversed' }]);
    assert.equal(six.length, 6);
    assert.deepEqual(six.filter((c) => c.tag === 'correct').map((c) => c.value), [12]);
    assert.ok(six.every((c) => Number(c.value) >= 1), 'nothing under the minimum');
    assert.ok(six.some((c) => c.value === 21 && c.tag === 'reversed'));
    const zero = buildChoices(rng, 0, [{ value: 0, tag: 'near_miss' }]);
    assert.ok(zero.some((c) => c.value === 0 && c.tag === 'correct') && zero.every((c) => Number(c.value) >= 0));
    assert.equal(buildChoices(rng, 5, [], { count: 4 }).length, 4);
    const fracs = buildFracChoices(rng, '2/4', [{ value: '1/2', tag: 'near_miss' }, { value: '2/4', tag: 'near_miss' }], ['3/4', '4/8', '1/4', '5/4']);
    assert.equal(fracs.length, 4);
    assert.deepEqual(fracs.map((c) => c.value).sort(), ['1/4', '2/4', '3/4', '5/4'], 'equal values are one stone; the fills complete four');
    const mixed = buildMixedDivisionChoices(rng, { total: 14, baskets: 4, quotient: 3, remainder: 2 });
    assert.ok(mixed.some((c) => c.value === '3 1/2' && c.tag === 'correct'));
    assert.ok(mixed.some((c) => c.value === 3 && c.tag === 'remainder_ignored'));
    assert.ok(mixed.length <= 6 && new Set(mixed.map((c) => String(c.value))).size === mixed.length);
    assert.deepEqual([reverseDigits(26), reverseDigits(7), reverseDigits(33), reverseDigits(10)], [62, null, null, 1]);
    assert.deepEqual([mixedNumberLabel(3, 2, 4), mixedNumberLabel(2, 4, 4), mixedNumberLabel(3, 0, 5), divisionAnswerLabel(19, 5)], ['3 1/2', 3, 3, '3 4/5']);
    assert.deepEqual([gcd(12, 18), coprimes(6), coprimes(5)], [6, [1, 5], [1, 2, 3, 4]]);
    let reduced = false;
    for (let seed = 0; seed < 200; seed++) {
      const p = problemOf('div_remainder', 700, seed, 'fetch');
      const g = gcd(p.meta.remainder, p.meta.baskets);
      assert.equal(p.answer, `${p.meta.quotient} ${p.meta.remainder / g}/${p.meta.baskets / g}`);
      if (g > 1) reduced = true;
    }
    assert.ok(reduced, 'some leftovers reduce');
  });

  it('give a unit fraction of a number its own whole-number trap', () => {
    let seen = 0;
    for (let seed = 0; seed < 300 && seen < 5; seed++) {
      const p = problemOf('frac_of_n', 700, seed);
      if (p.meta.n !== 1) continue;
      seen++;
      assert.ok(p.choices?.some((c) => c.tag === 'whole_number_bias' && c.value === p.meta.whole), 'the fraction ignored outright');
    }
    assert.equal(seen, 5);
  });

  it('grow every kind of bed: both sides named, the rows named, or just the total', () => {
    const givens = new Set();
    for (let seed = 0; seed < 80; seed++) {
      const p = problemOf('tables_b', 700, seed, 'array');
      validateProblem(p);
      givens.add(p.model.params.given);
      assert.ok([560, 660].includes(p.difficulty - (p.model.params.given === 'both' ? 0 : 30)), 'a hidden side is a little harder');
      if (p.model.params.given === 'rows') assert.equal(p.equation, `${p.meta.a} × ? = ${p.answer}`);
      if (p.model.params.given === 'total') assert.equal(p.equation, `? × ? = ${p.answer}`);
    }
    assert.deepEqual([...givens].sort(), ['both', 'rows', 'total']);
  });
});

describe('what a miss says', () => {
  it('explains each misconception in the words of the problem\'s own operation', () => {
    const p = (/** @type {string} */ id, /** @type {any} */ kind = 'fetch') => problemOf(id, 700, `ex:${id}`, kind);
    assert.equal(explainKey(p('add_20'), { tag: 'addsub_confuse' }), 'ex.took_away');
    assert.equal(explainKey(p('sub_20'), { tag: 'addsub_confuse' }), 'ex.added');
    assert.equal(explainKey(p('missing_addend'), { tag: 'addsub_confuse' }), 'ex.gap');
    assert.equal(explainKey(p('number_bonds'), { tag: 'addsub_confuse' }), 'ex.gap');
    assert.equal(explainKey(p('tables_a'), { tag: 'addsub_confuse' }), 'ex.addsub_confuse', 'times copy for a times table');
    assert.equal(explainKey(p('tables_a'), { tag: 'off_by_table' }), 'ex.off_by_table');
    assert.equal(explainKey(p('div_facts'), { tag: 'off_by_table' }), 'ex.div_fact', 'a division states its own fact');
    assert.equal(explainKey(p('div_facts'), { tag: 'addsub_confuse' }), 'ex.div_fact');
    assert.equal(explainKey(p('missing_factor'), { tag: 'off_by_table' }), 'ex.missing_factor');
    assert.equal(explainKey(p('frac_equiv'), { tag: 'whole_number_bias' }), 'ex.equiv');
    assert.equal(explainKey(p('frac_of_n'), { tag: 'whole_number_bias' }), 'ex.pieces_of');
    assert.equal(explainKey(p('frac_compare'), { tag: 'whole_number_bias' }), 'ex.whole_number_bias');
    assert.equal(explainKey(p('add_20'), { tag: 'random' }), 'ex.near_miss');
    assert.equal(explainKey(p('add_100'), { tag: 'mystery' }), p('add_100').explain.key, 'an unknown misconception falls back');
    const both = p('tables_a', 'array');
    const named = { ...both, model: { kind: 'array', params: { ...both.model.params, given: 'both' } } };
    assert.equal(explainKey(named, { tag: 'near_miss', array: { tag: 'shape' } }), 'ex.array_shape');
    assert.equal(explainKey({ ...named, model: { kind: 'array', params: { ...named.model.params, given: 'rows' } } }, { tag: 'near_miss', array: { tag: 'shape' } }), 'ex.array_rows');
    assert.equal(explainKey({ ...named, model: { kind: 'array', params: { ...named.model.params, given: 'total' } } }, { tag: 'near_miss', array: { tag: 'shape' } }), 'ex.array_flat');
    assert.equal(explainKey(named, { tag: 'near_miss', array: { tag: 'too_few' } }), 'ex.array_count');
  });

  it('renders every line it can say with all its numbers, naming the answer, in both languages', () => {
    for (const lang of LANGS) {
      for (const id of SKILL_IDS) {
        for (let i = 0; i < 25; i++) {
          const p = problemOf(id, 500 + (i % 5) * 150, `lines:${lang}:${id}:${i}`, i % 2 ? undefined : 'fetch');
          const vars = lineVars(p);
          const prompt = t(lang, p.prompt.key, vars);
          assert.ok(!prompt.includes('{'), `${lang} ${id}: ${prompt}`);
          /** @type {any[]} */
          const infos = (p.choices ?? []).filter((c) => c.tag !== 'correct').map((c) => ({ tag: c.tag, value: c.value }));
          if (p.kind === 'numberline') infos.push({ tag: 'magnitude_low' }, { tag: 'magnitude_high' });
          if (p.kind === 'share') infos.push({ tag: 'unfair_share' }, { tag: 'share_more' });
          if (p.kind === 'array') for (const tag of ['shape', 'too_few', 'too_many']) infos.push({ tag: 'near_miss', value: 7, array: { tag } });
          for (const info of infos) {
            const key = explainKey(p, info);
            const line = t(lang, key, { ...vars, value: info.value });
            assert.ok(!line.includes('{') && line !== key, `${lang} ${id} ${info.tag}: ${line}`);
            if (TABLES.en[key].includes('{answer}')) assert.ok(line.includes(String(vars.answer)), `${id} ${key} names the answer`);
          }
        }
      }
    }
  });

  it('solves the equation truthfully, a bed by the rows and columns grown', () => {
    const bed = problemOf('tables_a', 700, 3, 'array');
    const rows = { ...bed, equation: '2 × ? = 18', model: { kind: 'array', params: { rows: 2, cols: 9, total: 18, given: 'rows' } } };
    assert.equal(solvedEquation(rows, { r: 2, c: 9 }), '2 × 9 = 18');
    assert.equal(solvedEquation({ ...rows, model: { kind: 'array', params: { rows: 3, cols: 6, total: 18, given: 'total' } } }, { r: 2, c: 9 }), '2 × 9 = 18');
    assert.equal(solvedEquation(rows), '2 × 9 = 18');
    const sum = problemOf('add_20', 600, 1);
    assert.equal(solvedEquation(sum), sum.equation.replace('?', String(sum.answer)));
    const share = problemOf('div_remainder', 700, 79, 'share');
    const { total, baskets, quotient, remainder } = share.model.params;
    assert.equal(solvedEquation(share), `${total} ÷ ${baskets} = ${quotient} (+${remainder})`);
    assert.equal(solvedEquation(problemOf('share', 700, 7, 'share')).includes('(+'), false);
    const line = problemOf('frac_magnitude', 600, 2);
    assert.equal(answerLabel(line), `${line.meta.n}/${line.meta.d}`);
    assert.equal(solvedEquation(line), `${line.meta.n}/${line.meta.d} ✓`);
  });
});

// ---------- strings ----------

describe('the strings', () => {
  it('speak English and Dutch with the same keys and the same placeholders', () => {
    assert.deepEqual(Object.keys(TABLES.nl).sort(), Object.keys(TABLES.en).sort());
    const holes = (/** @type {string} */ s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(TABLES.en)) {
      assert.ok(TABLES.en[key].length > 0 && TABLES.nl[key].length > 0, key);
      assert.deepEqual(holes(TABLES.nl[key]), holes(TABLES.en[key]), key);
    }
    for (const id of SKILL_IDS) assert.ok(hasLine(`skill.${id}`), id);
    for (const w of WORLDS) assert.ok(hasLine(`world.${w}`), w);
    for (const kind of KINDS) assert.ok(hasLine(`teach.${kind}`) && hasLine(`help.${kind}`), kind);
    assert.equal(t('nl', 'world.tide'), 'Getijdenpoel');
    assert.equal(t('en', 'hud.bananas', { n: 12 }), '12 bananas');
    assert.equal(t('en', 'hud.bananas'), '{n} bananas', 'a missing number stays visible');
    assert.equal(t('en', 'no.such.line'), 'no.such.line');
    assert.deepEqual([langOf('nl'), langOf('en'), langOf('fr'), langOf(undefined)], ['nl', 'en', 'en', 'en']);
    assert.equal(hasLine('constructor'), false);
  });
});

// ---------- boards ----------

describe('the boards', () => {
  it('deal reachable chambers for every verb from a seed', () => {
    for (const kind of /** @type {const} */ (['fetch', 'array', 'line', 'share'])) {
      for (let seed = 0; seed < 40; seed++) {
        const board = makeBoard(kind, seed, 'garden');
        assert.equal(board.w, 16);
        assert.equal(board.d, 10);
        assert.ok(board.rows.every((row) => row.length === 16));
        assert.equal(board.rows.join('').split('P').length - 1, 1);
        assert.equal(board.rows.join('').split('M').length - 1, 1);
        assert.ok(board.altar && board.spots.length >= 6, 'every board hosts a stone hunt');
        assert.ok(board.pad, 'and has room for the picture');
        const grid = board.rows.map((row) => [...row]);
        const reach = reachable(grid);
        const key = (/** @type {number} */ i, /** @type {number} */ j) => j * board.w + i;
        for (const [i, j] of board.spots) assert.ok(reach.has(key(i, j)), `${kind}:${seed} spot ${i},${j}`);
        for (const [i, j] of [board.altar, board.mimi, ...(board.stump ? [board.stump] : []), ...board.baskets]) {
          assert.ok([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([di, dj]) => reach.has(key(i + di, j + dj))), `${kind}:${seed} ${i},${j} has a way in`);
        }
        assert.ok(canHost(board, 'fetch'));
        assert.equal(canHost(board, 'array'), kind === 'array');
        assert.equal(canHost(board, 'numberline'), kind === 'line');
        assert.equal(canHost(board, 'share'), kind === 'share');
        if (kind === 'array') assert.deepEqual([board.soil?.cols, board.soil?.rows], [HOST_LIMITS.arrayCols, HOST_LIMITS.arrayRows]);
        if (kind === 'line') assert.equal(/** @type {any} */ (board.vine).i1 - /** @type {any} */ (board.vine).i0 + 1, 12);
        if (kind === 'share') assert.equal(board.baskets.length, HOST_LIMITS.baskets);
      }
    }
    assert.deepEqual(makeBoard('fetch', 5, 'tide'), makeBoard('fetch', 5, 'tide'));
    const looks = new Set(Array.from({ length: 12 }, (_, seed) => makeBoard('fetch', seed, 'tide').rows.join('')));
    assert.ok(looks.size > 6, 'seeds deal different boards');
    assert.deepEqual(['fetch', 'array', 'numberline', 'share'].map((k) => boardKindFor(/** @type {any} */ (k))), ['fetch', 'array', 'line', 'share']);
  });

  it('vary a template without walling anything off', () => {
    const open = ['######', '#P...#', '#....#', '#....#', '#....#', '######'];
    const necked = ['#########', '#P..#...#', '#...#...#', '#.......#', '#########'];
    for (const template of [open, necked]) {
      for (let seed = 0; seed < 60; seed++) {
        const rows = varyLayout(template, createRng(seed));
        assert.equal(rows.join('').split('P').length - 1, 1);
        const reach = reachable(rows.map((r) => [...r]));
        const walkable = rows.join('').split('').filter((ch) => isWalkable(ch)).length;
        assert.equal(reach.size, walkable, 'every walkable tile stays reachable');
      }
    }
  });

  it('keep the hub: four portals, Mimi, the banana pile', () => {
    assert.equal(HUB.kind, 'hub');
    assert.deepEqual(Object.keys(/** @type {any} */ (HUB.portals)), WORLDS);
    assert.ok(HUB.pile && HUB.mimi && HUB.pad === null);
    assert.equal(charAt(HUB, -3, 2), '#', 'off the board is sea');
    assert.deepEqual(tileAt(HUB, ...centerOf(HUB, 3, 6)), [3, 6]);
  });

  it('find walks over the tiles, ending beside what cannot be stood on', () => {
    const from = centerOf(HUB, 7, 6);
    const to = centerOf(HUB, 13, 2);
    const path = findPath(HUB, from, to);
    assert.ok(path && path.length > 0);
    assert.deepEqual(path[path.length - 1], to);
    for (const [x, z] of path) assert.ok(isWalkable(charAt(HUB, ...tileAt(HUB, x, z))));
    const [mx, mz] = centerOf(HUB, HUB.mimi[0], HUB.mimi[1]);
    const toMimi = findPath(HUB, from, [mx, mz]);
    assert.ok(toMimi);
    const end = toMimi[toMimi.length - 1];
    assert.ok(Math.abs(Math.hypot(end[0] - mx, end[1] - mz) - 1) < 1e-9, 'beside her, not on her');
    assert.equal(findPath(HUB, from, centerOf(HUB, 0, 0)), null, 'the sea is no destination');
    const edge = findPath(HUB, from, [centerOf(HUB, 14, 1)[0] + 0.49, centerOf(HUB, 14, 1)[1] - 0.49]);
    assert.ok(edge);
    const last = edge[edge.length - 1];
    assert.ok(last[0] <= centerOf(HUB, 14, 1)[0] + 0.16 + 1e-9 && last[1] >= centerOf(HUB, 14, 1)[1] - 0.16 - 1e-9, 'a goal by the sea is kept clear of it');
    const island = { ...HUB, rows: ['#####', '#P#.#', '#####'], w: 5, d: 3 };
    assert.equal(findPath(island, centerOf(island, 1, 1), centerOf(island, 3, 1)), null, 'nothing leads there');
    assert.deepEqual(findPath(HUB, from, [from[0] + 0.1, from[1]]), [[from[0] + 0.1, from[1]]]);
  });
});

// ---------- the walking monkey ----------

describe('the monkey\'s body', () => {
  const held = (/** @type {Partial<typeof NO_KEYS>} */ keys) => ({ ...NO_KEYS, ...keys });

  it('walks at a fixed speed, diagonals no faster, and steps audibly', () => {
    const start = createMonkey(HUB);
    let m = start;
    /** @type {any[]} */
    const events = [];
    for (let i = 0; i < 30; i++) {
      const out = moveMonkey(HUB, m, held({ down: true }), TICK_MS);
      m = out.monkey;
      events.push(...out.events);
    }
    assert.ok(Math.abs(m.z - start.z - SPEED * 0.5) < 1e-6, 'half a second at SPEED');
    assert.ok(sounds(events).includes('step'));
    assert.ok(of(events, 'follow').length > 0, 'the camera follows');
    let d = start;
    for (let i = 0; i < 30; i++) d = moveMonkey(HUB, d, held({ down: true, right: true }), TICK_MS).monkey;
    assert.ok(Math.abs(Math.hypot(d.x - start.x, d.z - start.z) - SPEED * 0.5) < 1e-6);
    assert.equal(d.face, 1);
    const still = moveMonkey(HUB, start, NO_KEYS, TICK_MS);
    assert.equal(still.monkey.moving, false);
    assert.deepEqual(still.events, []);
  });

  it('slides round a rock instead of stopping dead, with one soft knock', () => {
    const [rx, rz] = centerOf(HUB, 3, 6);
    let m = { ...createMonkey(HUB), x: rx - 1.2, z: rz + 0.3, followAt: /** @type {[number, number]} */ ([rx - 1.2, rz + 0.3]) };
    /** @type {any[]} */
    const events = [];
    let closest = Infinity;
    for (let i = 0; i < 60; i++) {
      const out = moveMonkey(HUB, m, held({ right: true }), TICK_MS);
      m = out.monkey;
      events.push(...out.events);
      closest = Math.min(closest, Math.hypot(m.x - rx, m.z - rz));
    }
    assert.ok(m.x > rx + 0.5, 'past the rock');
    assert.ok(m.z > rz + 0.4, 'pushed round it');
    assert.ok(closest >= SOLIDS.r.radius * Math.cos(Math.PI / SOLIDS.r.sides) + RADIUS - 1e-3, 'never inside it');
    const kicks = of(events, 'kick');
    assert.equal(kicks.length, 1);
    assert.equal(kicks[0].body, 'monkey');
    assert.ok(Math.hypot(...kicks[0].impulse) < 6, 'a soft knock, never a tumble');
  });

  it('stops at the shore with a splash and a ripple', () => {
    let m = { ...createMonkey(HUB), z: centerOf(HUB, 7, 1)[1] };
    /** @type {any[]} */
    const events = [];
    for (let i = 0; i < 40; i++) {
      const out = moveMonkey(HUB, m, held({ up: true }), TICK_MS);
      m = out.monkey;
      events.push(...out.events);
    }
    assert.ok(m.z >= -HUB.d / 2 + 1 + RADIUS - 1e-6, 'held out of the sea');
    assert.ok(sounds(events).includes('splash'));
    assert.ok(effects(events).includes('ripple'));
    assert.equal(of(events, 'kick').length, 1);
  });

  it('walks a tapped path, gives up on one that cannot be walked, and lands from a hop', () => {
    const to = centerOf(HUB, 13, 8);
    let m = walkTo(HUB, createMonkey(HUB), to, true);
    assert.equal(m.intent, true);
    let arrived = false;
    for (let i = 0; i < 400 && !arrived; i++) {
      const out = moveMonkey(HUB, m, NO_KEYS, TICK_MS);
      m = out.monkey;
      arrived = out.arrived;
    }
    assert.ok(arrived);
    assert.ok(distanceTo(m, to) < 1e-9);
    assert.equal(walkTo(HUB, m, centerOf(HUB, 0, 5), true), m, 'no path: the monkey stays as it was');
    const here = walkTo(HUB, m, [m.x, m.z], true);
    assert.deepEqual(here.path, [[m.x, m.z]]);
    const [rx, rz] = centerOf(HUB, 3, 6);
    let stuck = { ...createMonkey(HUB), x: rx - 1, z: rz, path: /** @type {Array<[number, number]>} */ ([[rx, rz]]), intent: true };
    for (let i = 0; i < 60; i++) stuck = moveMonkey(HUB, stuck, NO_KEYS, TICK_MS).monkey;
    assert.equal(stuck.path, null, 'pressed against a rock, the walk is given up');
    assert.equal(stuck.intent, false);
    const empty = moveMonkey(HUB, { ...createMonkey(HUB), path: [] }, NO_KEYS, TICK_MS);
    assert.equal(empty.arrived, true);
    let hop = { ...createMonkey(HUB), jumpMs: JUMP_MS };
    /** @type {any[]} */
    const landing = [];
    for (let i = 0; i < 40; i++) {
      const out = moveMonkey(HUB, hop, NO_KEYS, TICK_MS);
      hop = out.monkey;
      landing.push(...out.events);
    }
    assert.deepEqual(sounds(landing), ['land']);
    const dunked = moveMonkey(HUB, { ...createMonkey(HUB), dunkMs: DUNK_MS }, held({ right: true }), TICK_MS);
    assert.equal(dunked.monkey.x, createMonkey(HUB).x, 'climbing out of the water, the monkey cannot walk');
    let out = { ...createMonkey(HUB), dunkMs: 10 };
    const done = moveMonkey(HUB, out, NO_KEYS, TICK_MS);
    out = done.monkey;
    assert.deepEqual(sounds(done.events), ['land']);
  });

  it('builds each board\'s mesh once and keeps only a few', () => {
    const board = makeBoard('fetch', 99, 'tide');
    assert.equal(meshOf(board), meshOf(board), 'the same mesh, by board');
    assert.ok(meshOf(HUB).tags.includes('water') && meshOf(HUB).tags.includes('rock') && meshOf(HUB).tags.includes('mimi'));
    for (let seed = 0; seed < 20; seed++) meshOf(makeBoard('share', 1000 + seed, 'stump'));
    assert.ok(cachedMeshes() <= 12);
    assert.deepEqual(followMonkey(createMonkey(HUB)), { kind: 'follow', target: [createMonkey(HUB).x, 0.6, createMonkey(HUB).z], lag: 0.08 });
    assert.equal(nearest({ x: 0, z: 0 }, [[3, 0], [0.5, 0], [0.2, 0]], 1), 2);
    assert.equal(nearest({ x: 0, z: 0 }, [[3, 0]], 1), -1);
  });
});

// ---------- the verbs ----------

describe('FETCH', () => {
  const board = makeBoard('fetch', 21, 'tide');
  const problem = problemOf('add_20', 600, 4);
  const verb = /** @type {any} */ (verbFor(board, problem, createRng(9)));
  const at = (/** @type {number} */ x, /** @type {number} */ z, /** @type {any} */ carry = null) => ({ ...createMonkey(board), x, z, carry });
  const altarSide = () => beside(board, /** @type {[number, number]} */ (board.altar), verb.stones);

  it('deals every stone onto its own spot', () => {
    assert.equal(verb.stones.length, problem.choices?.length);
    const spots = new Set(board.spots.map(([i, j]) => centerOf(board, i, j).join()));
    assert.ok(verb.stones.every((/** @type {any} */ s) => spots.has([s.x, s.z].join())));
    assert.equal(new Set(verb.stones.map((/** @type {any} */ s) => [s.x, s.z].join())).size, verb.stones.length);
  });

  it('picks up, swaps and sets down stones', () => {
    const right = verb.stones.find((/** @type {any} */ s) => s.label === String(problem.answer));
    const picked = /** @type {any} */ (verbAct(board, problem, verb, at(right.x + 0.3, right.z)));
    assert.equal(picked.monkey.carry.label, right.label);
    assert.equal(picked.verb.stones.length, verb.stones.length - 1);
    assert.deepEqual(sounds(picked.events), ['pop']);
    const other = picked.verb.stones[0];
    const swapped = /** @type {any} */ (verbAct(board, problem, picked.verb, { ...picked.monkey, x: other.x, z: other.z }));
    assert.equal(swapped.monkey.carry.label, other.label);
    assert.ok(swapped.verb.stones.some((/** @type {any} */ s) => s.label === right.label && s.x === other.x && s.z === other.z), 'the stone in hand takes its spot');
    const [ox, oz] = openPoint(board, swapped.verb.stones);
    const down = /** @type {any} */ (verbAct(board, problem, swapped.verb, { ...swapped.monkey, x: ox, z: oz }));
    assert.equal(down.monkey.carry, null);
    assert.ok(down.verb.stones.some((/** @type {any} */ s) => s.label === other.label && s.x === ox && s.z === oz));
    assert.equal(verbAct(board, problem, verb, at(ox, oz)), null, 'nothing here to do');
  });

  it('judges the offering: the answer stone, or a gentle return of a wrong one', () => {
    const [ax, az] = altarSide();
    const right = verb.stones.find((/** @type {any} */ s) => s.label === String(problem.answer));
    const yes = /** @type {any} */ (verbAct(board, problem, verb, at(ax, az, right)));
    assert.equal(yes.attempt.correct, true);
    assert.equal(yes.monkey.carry, null);
    const wrong = verb.stones.find((/** @type {any} */ s) => s.tag !== 'correct');
    const rest = verb.stones.filter((/** @type {any} */ s) => s !== wrong);
    const no = /** @type {any} */ (verbAct(board, problem, { ...verb, stones: rest }, at(ax, az, wrong)));
    assert.equal(no.attempt.correct, false);
    assert.equal(no.attempt.info.tag, wrong.tag);
    const back = no.verb.stones.find((/** @type {any} */ s) => s.label === wrong.label);
    assert.ok(back.tried && distanceTo(back, centerOf(board, .../** @type {[number, number]} */ (board.altar))) < 1.5, 'back beside the altar, dimmed');
    const empty = /** @type {any} */ (verbAct(board, problem, verb, at(ax, az)));
    assert.equal(empty.note, 'play.altar_wants');
    assert.deepEqual(effects(empty.events), ['sparks']);
    const [mx, mz] = centerOf(board, board.mimi[0], board.mimi[1]);
    assert.equal(verbAct(board, problem, { ...verb, stones: [] }, at(mx + 1, mz)), null, 'by Mimi, Mimi talks');
  });

  it('answers straight from a stone\'s value', () => {
    const right = String(problem.answer);
    assert.equal(answerFetch(board, problem, verb, createMonkey(board), right)?.attempt?.correct, true);
    const wrong = verb.stones.find((/** @type {any} */ s) => s.tag !== 'correct');
    const no = /** @type {any} */ (answerFetch(board, problem, verb, createMonkey(board), wrong.value));
    assert.equal(no.attempt.correct, false);
    assert.ok(no.verb.stones.find((/** @type {any} */ s) => s.label === wrong.label).tried);
    const held = verb.stones[0];
    const fromHand = /** @type {any} */ (answerFetch(board, problem, { ...verb, stones: verb.stones.slice(1) }, { ...createMonkey(board), carry: held }, held.label));
    assert.equal(fromHand.monkey.carry, null);
    assert.equal(answerFetch(board, problem, verb, createMonkey(board), 'nope'), null);
  });
});

describe('ARRAY', () => {
  const board = makeBoard('array', 5, 'garden');
  const soil = /** @type {NonNullable<typeof board.soil>} */ (board.soil);
  const base = problemOf('tables_a', 700, 3, 'array');
  const bed = (/** @type {number} */ rows, /** @type {number} */ cols, /** @type {string} */ given) => ({ ...base, model: { kind: 'array', params: { rows, cols, total: rows * cols, given } } });
  const on = (/** @type {number} */ di, /** @type {number} */ dj) => {
    const [x, z] = centerOf(board, soil.i0 + di, soil.j0 + dj);
    return { ...createMonkey(board), x, z };
  };
  const grow = (/** @type {any} */ problem, /** @type {number} */ r, /** @type {number} */ c) => {
    const planted = /** @type {any} */ (verbAct(board, problem, verbFor(board, problem, createRng(1)), on(0, 0)));
    return /** @type {any} */ (verbAct(board, problem, planted.verb, on(c - 1, r - 1)));
  };

  it('plants a flag on the soil, takes it back, and stretches the bed to the monkey', () => {
    const problem = bed(3, 4, 'both');
    const verb = /** @type {any} */ (verbFor(board, problem, createRng(1)));
    const [ox, oz] = openPoint(board);
    assert.equal(bedRect(board, null, { ...createMonkey(board), x: ox, z: oz }), null);
    assert.deepEqual(bedRect(board, null, on(2, 3)), { i0: soil.i0 + 2, j0: soil.j0 + 3, i1: soil.i0 + 2, j1: soil.j0 + 3 });
    const off = /** @type {any} */ (verbAct(board, problem, verb, { ...createMonkey(board), x: ox, z: oz }));
    assert.equal(off.note, 'play.need_soil');
    const [mx, mz] = centerOf(board, board.mimi[0], board.mimi[1]);
    assert.equal(verbAct(board, problem, verb, { ...createMonkey(board), x: mx, z: mz + 1 }), null, 'off the soil by Mimi, Mimi talks');
    const planted = /** @type {any} */ (verbAct(board, problem, verb, on(1, 1)));
    assert.deepEqual(planted.verb.anchor, [soil.i0 + 1, soil.j0 + 1]);
    assert.equal(planted.note, 'play.flag_planted');
    const back = /** @type {any} */ (verbAct(board, problem, planted.verb, on(1, 1)));
    assert.equal(back.verb.anchor, null);
    assert.equal(back.note, 'play.flag_back');
    const far = { ...createMonkey(board), x: ox, z: oz };
    const clamped = /** @type {any} */ (bedRect(board, planted.verb.anchor, far));
    assert.ok(clamped.i0 >= soil.i0 && clamped.i1 < soil.i0 + soil.cols && clamped.j1 < soil.j0 + soil.rows, 'held to the soil');
  });

  it('grows the bed the problem asks for, either way round when both sides are named', () => {
    assert.equal(grow(bed(3, 4, 'both'), 3, 4).attempt.correct, true);
    assert.equal(grow(bed(3, 4, 'both'), 4, 3).attempt.correct, true);
    assert.deepEqual(grow(bed(3, 4, 'both'), 3, 4).verb.grown, { i0: soil.i0, j0: soil.j0, i1: soil.i0 + 3, j1: soil.j0 + 2 });
    assert.equal(grow(bed(3, 4, 'rows'), 3, 4).attempt.correct, true);
    const turned = grow(bed(3, 4, 'rows'), 4, 3).attempt;
    assert.deepEqual([turned.correct, turned.info.array.tag], [false, 'shape']);
    assert.equal(grow(bed(2, 3, 'total'), 3, 2).attempt.correct, true, 'any real bed of the total');
    assert.equal(grow(bed(2, 3, 'total'), 1, 6).attempt.info.array.tag, 'shape', 'one row is not a bed');
    assert.equal(grow(bed(3, 4, 'both'), 2, 2).attempt.info.array.tag, 'too_few');
    assert.deepEqual(grow(bed(3, 4, 'both'), 5, 5).attempt.info.array, { tag: 'too_many', r: 5, c: 5, n: 25 });
    assert.deepEqual([[3, 4, 3, 4], [3, 4, 4, 3], [2, 6, 3, 4], [2, 6, 1, 12]].map(([rows, cols, r, c]) => bedAnswers({ rows, cols, total: rows * cols, given: 'total' }, r, c)), [true, true, true, false]);
  });
});

describe('LINE', () => {
  const board = makeBoard('line', 2, 'vines');
  const vine = /** @type {NonNullable<typeof board.vine>} */ (board.vine);
  const problem = problemOf('frac_magnitude', 600, 5);
  const verb = /** @type {any} */ (verbFor(board, problem, createRng(1)));
  const [ax, z] = centerOf(board, vine.i0, vine.j);
  const [bx] = centerOf(board, vine.i1, vine.j);
  const xOf = (/** @type {number} */ value) => ax + ((value - problem.model.params.lo) / (problem.model.params.hi - problem.model.params.lo)) * (bx - ax);
  const at = (/** @type {number} */ x) => ({ ...createMonkey(board), x, z });

  it('reads the vine as a number line', () => {
    assert.equal(vineValue(board, problem, ax), 0);
    assert.equal(vineValue(board, problem, bx), problem.model.params.hi);
    assert.ok(Math.abs(vineValue(board, problem, (ax + bx) / 2) - problem.model.params.hi / 2) < 1e-12);
    assert.equal(vineValue(board, problem, ax - 3), 0, 'held to its ends');
  });

  it('labels its marks less as the scaffold fades, keeping a half anchor', () => {
    const q = (/** @type {number} */ d, /** @type {number} */ hi) => ({ ...problem, model: { kind: 'numberline', params: { n: 1, d, lo: 0, hi } } });
    assert.deepEqual(vineTicks(q(4, 1), 0).map((k) => k.label), ['1/4', '2/4', '3/4']);
    assert.deepEqual(vineTicks(q(4, 1), 1).map((k) => k.label), [null, '½', null]);
    assert.deepEqual(vineTicks(q(4, 1), 2).map((k) => [k.value, k.label]), [[0.5, null]]);
    assert.deepEqual(vineTicks(q(3, 1), 0).map((k) => k.label), ['1/3', '2/3', '½'], 'an odd denominator gets a half anchor');
    assert.deepEqual(vineTicks(q(3, 1), 2), [{ value: 0.5, big: true, label: null }]);
    assert.deepEqual(vineTicks(q(2, 2), 0).map((k) => k.label), ['1/2', '1', '3/2']);
    assert.deepEqual(vineTicks(q(2, 2), 1).map((k) => k.label), ['½', '1', '1½']);
    assert.equal(verb.level, problem.scaffold, 'the vine starts labelled to the scaffold');
  });

  it('rings true where the fraction lives, and tumbles anywhere else', () => {
    const answer = /** @type {number} */ (problem.answer);
    const tol = /** @type {any} */ (problem.accept).tol * (bx - ax) * 0.9;
    assert.equal(verbAct(board, problem, verb, at(xOf(answer) + tol))?.attempt?.correct, true);
    const miss = /** @type {any} */ (verbAct(board, problem, { ...verb, level: 2 }, at(answer < 0.5 ? bx : ax)));
    assert.equal(miss.attempt.correct, false);
    assert.equal(miss.attempt.info.tag, answer < 0.5 ? 'magnitude_high' : 'magnitude_low');
    assert.equal(miss.verb.level, 0, 'full labels come back');
    assert.equal(miss.monkey.dunkMs, DUNK_MS);
    assert.deepEqual([miss.monkey.x, miss.monkey.z], centerOf(board, board.spawn[0], board.spawn[1]), 'climbs out at the start');
    assert.ok(sounds(miss.events).includes('splash') && effects(miss.events).includes('ripple') && of(miss.events, 'follow').length === 1);
    const low = /** @type {any} */ (verbAct(board, problem, verb, at(answer < 0.5 ? ax : bx)));
    assert.equal(low.attempt.info.tag, answer < 0.5 ? 'magnitude_low' : 'magnitude_high');
    const [ox, oz] = openPoint(board);
    assert.equal(/** @type {any} */ (verbAct(board, problem, verb, { ...createMonkey(board), x: ox, z: oz })).note, 'play.off_vine');
    const [mx, mz] = centerOf(board, board.mimi[0], board.mimi[1]);
    assert.equal(verbAct(board, problem, verb, { ...createMonkey(board), x: mx + 1, z: mz }), null);
  });
});

describe('SHARE', () => {
  const board = makeBoard('share', 8, 'stump');
  const problem = problemOf('div_remainder', 560, 2, 'share');
  const verb = /** @type {any} */ (verbFor(board, problem, createRng(1)));
  const stump = centerOf(board, .../** @type {[number, number]} */ (board.stump));
  const at = (/** @type {[number, number]} */ p) => ({ ...createMonkey(board), x: p[0], z: p[1] });
  const nextTo = (/** @type {number} */ k) => at(beside(board, [verb.baskets[k].i, verb.baskets[k].j]));

  it('sets out the baskets nearest the stump and the whole pile on it', () => {
    const { baskets, total, remainder } = problem.model.params;
    assert.ok(remainder > 0);
    assert.equal(verb.baskets.length, baskets);
    assert.equal(verb.pile, total);
    const far = (/** @type {[number, number]} */ [i, j]) => Math.abs(i - /** @type {any} */ (board.stump)[0]) + Math.abs(j - /** @type {any} */ (board.stump)[1]);
    const chosen = verb.baskets.map((/** @type {any} */ b) => far([b.i, b.j]));
    const all = board.baskets.map(far).sort((a, b) => a - b);
    assert.deepEqual([...chosen].sort((a, b) => a - b), all.slice(0, baskets));
  });

  it('deals, takes back the last one, and checks the share', () => {
    const one = /** @type {any} */ (verbAct(board, problem, verb, nextTo(0)));
    assert.equal(one.verb.pile, verb.pile - 1);
    assert.deepEqual(one.verb.drops, [0]);
    assert.equal(one.verb.baskets[0].count, 1);
    const back = /** @type {any} */ (verbAct(board, problem, one.verb, at(beside(board, /** @type {[number, number]} */ (board.stump)))));
    assert.equal(back.verb.pile, verb.pile);
    assert.equal(back.verb.baskets[0].count, 0);
    assert.equal(takeBack(verb, createMonkey(board)).note, 'play.nothing_back');
    const empty = /** @type {any} */ (verbAct(board, problem, { ...verb, pile: 0 }, nextTo(0)));
    assert.equal(empty.note, 'play.pile_empty');
    const resting = board.baskets.find(([i, j]) => !verb.baskets.some((/** @type {any} */ b) => b.i === i && b.j === j));
    assert.ok(resting, 'some baskets rest');
    assert.equal(/** @type {any} */ (verbAct(board, problem, verb, at(beside(board, resting)))).note, 'play.basket_rest');
    const { quotient, remainder } = problem.model.params;
    const fair = { ...verb, pile: remainder, baskets: verb.baskets.map((/** @type {any} */ b) => ({ ...b, count: quotient })) };
    const open = at(openPoint(board));
    assert.equal(/** @type {any} */ (verbAct(board, problem, fair, open)).attempt.correct, true, 'out in the open, Act checks');
    assert.equal(checkShare(board, problem, fair).at.join(), stump.join());
    const lopsided = { ...fair, baskets: fair.baskets.map((/** @type {any} */ b, /** @type {number} */ k) => ({ ...b, count: quotient + (k === 0 ? 1 : 0) })), pile: remainder - 1 };
    assert.equal(checkShare(board, problem, lopsided).info.tag, 'unfair_share');
    const early = { ...verb, pile: verb.pile - verb.baskets.length, baskets: verb.baskets.map((/** @type {any} */ b) => ({ ...b, count: 1 })) };
    assert.equal(checkShare(board, problem, early).info.tag, 'share_more');
    const [mx, mz] = centerOf(board, board.mimi[0], board.mimi[1]);
    assert.equal(verbAct(board, problem, verb, at([mx, mz + 1])), null);
  });
});

// ---------- playing ----------

describe('the island', () => {
  it('starts on the hub, where Mimi gives advice read off the mastery report', () => {
    const state = fresh();
    assert.equal(state.mode, 'hub');
    assert.equal(state.board, HUB);
    const [mx, mz] = centerOf(HUB, HUB.mimi[0], HUB.mimi[1]);
    const met = tapWalk(state, [mx, mz]);
    const said = of(met.events, 'say');
    assert.equal(said.length, 1);
    assert.equal(said[0].who, 'mimi');
    assert.equal(said[0].text, t('en', 'mimi.meet'));
    assert.ok(effects(met.events).includes('radiance'));
    assert.equal(met.state.progress.met, true);
    assert.equal(met.state.toast?.text, said[0].text);
    const again = grove.act(met.state, { type: 'hint' });
    const lines = adviceLines(met.state);
    assert.equal(of(again.events, 'say')[0].text, lines[1 % lines.length]);
    assert.ok(lines.includes(t('en', 'mimi.world_hint', { world: 'Tide Pools' })));
    assert.ok(lines.includes(t('en', 'mimi.focus', { world: 'Tide Pools', skill: 'Counting on' })));
    assert.ok(lines.includes(t('en', 'mimi.phase0')));
    const hop = run(fresh(), 1, { pressed: ['act'] });
    assert.deepEqual(sounds(hop.events), ['hop'], 'far from Mimi, Act is a hop');
    assert.ok(hop.state.monkey.jumpMs > 0);
    assert.deepEqual(run(hop.state, 1, { pressed: ['act'] }).events.filter((e) => e.kind === 'sfx'), [], 'no hop in mid-air');
  });

  it('praises a blooming island: the bloomiest world, the skills by heart, the festival', () => {
    const math = createMath();
    for (const id of SKILL_IDS) master(math, id);
    const state = fresh(3, { math, bananas: 40, gates: { tide: 4, garden: 4, stump: 4, vines: 4 }, met: true });
    const lines = adviceLines(state);
    assert.ok(lines.includes(t('en', 'mimi.festival')));
    assert.ok(lines.includes(t('en', 'mimi.mastered', { n: 21, total: 21 })));
    assert.ok(lines.includes(t('en', 'mimi.bananas', { n: 40 })));
    assert.ok(lines.includes(t('en', 'mimi.phase2')));
    assert.ok(lines.includes(t('en', 'mimi.bloom', { world: 'Vine Heights', pct: 100 })), 'the last of the bloomiest');
    assert.ok(!lines.some((l) => l.includes('sleepy')));
    const half = fresh(3, { math: rated('counting', 900), gates: { tide: 2 } });
    assert.ok(adviceLines(half).includes(t('en', 'mimi.phase1')));
  });

  it('walks through a portal into that world\'s first chamber', () => {
    const tidePortal = /** @type {any} */ (HUB.portals).tide;
    const [px, pz] = centerOf(HUB, tidePortal[0], tidePortal[1]);
    const out = tapWalk(fresh(), [px, pz], 400);
    assert.equal(out.state.mode, 'chamber');
    assert.equal(out.state.chamber.world, 'tide');
    assert.equal(out.state.chamber.index, 1);
    const shots = of(out.events, 'shot');
    assert.deepEqual(shots.map((e) => e.shot), ['close']);
    assert.ok(sounds(out.events).includes('hop') && sounds(out.events).includes('open') && sounds(out.events).includes('land'));
    assert.ok(of(out.events, 'follow').length > 0);
    assert.equal(grove.hud(out.state).title, 'Tide Pools');
    const nl = grove.act(fresh(1, null, { lang: 'nl' }), { type: 'cell', id: 'vines' }).state;
    assert.equal(grove.hud(nl).title, 'Lianenhoogte');
    assert.equal(nl.chamber.problem.kind, 'numberline');
    assert.equal(grove.act(fresh(), { type: 'world', world: 'moon' }).state.mode, 'hub');
  });
});

describe('a chamber run', () => {
  it('is played whole through play(): fetch the stone, carry it, offer it — three times', () => {
    let state = grove.act(fresh(5), { type: 'world', world: 'tide' }).state;
    assert.equal(state.chamber.problem.kind, 'fetch');
    /** @type {any[]} */
    const all = [];
    for (let k = 0; k < PROBLEMS_PER_CHAMBER; k++) {
      const { problem, verb } = state.chamber;
      const answerStone = verb.stones.find((/** @type {any} */ s) => s.label === String(problem.answer));
      const fetched = tapWalk(state, [answerStone.x, answerStone.z]);
      assert.equal(fetched.state.monkey.carry?.label, answerStone.label, 'tapped and picked up');
      const [ax, az] = centerOf(fetched.state.board, fetched.state.board.altar[0], fetched.state.board.altar[1]);
      const offered = play(grove, fetched.state, [{ tap: { x: ax, z: az } }, ...idle(360)]);
      all.push(...offered.events);
      const rate = of(offered.events, 'rate');
      assert.deepEqual(rate, [{ kind: 'rate', skill: problem.skillId, correct: true, difficulty: problem.difficulty }]);
      assert.ok(sounds(offered.events).includes('right') && sounds(offered.events).includes('coin'));
      assert.ok(effects(offered.events).includes('confetti') && effects(offered.events).includes('stars'));
      assert.deepEqual(of(offered.events, 'xp').map((e) => e.reason), k < PROBLEMS_PER_CHAMBER - 1 ? ['correct'] : ['correct', 'chamber']);
      state = offered.state;
    }
    assert.equal(state.mode, 'result');
    assert.equal(state.chamber.stars, 3, 'three right first time');
    assert.equal(state.progress.best.tide, 3);
    assert.ok(state.progress.bananas >= 3 * 3 + 10);
    assert.ok(sounds(all).includes('levelup'));
    assert.ok(of(all, 'flash').length === 1 && of(all, 'shot').some((e) => e.shot === 'hero'));
    const hud = grove.hud(state);
    assert.equal(hud.title, 'Chamber complete!');
    assert.equal(hud.prompt, '★★★');
    assert.deepEqual(hud.buttons?.map((b) => b.id), ['next', 'home']);
    const next = grove.act(state, { type: 'next' }).state;
    assert.deepEqual([next.mode, next.chamber.index, next.chamber.world], ['chamber', 2, 'tide']);
    assert.ok(next.chamber.combo >= 3, 'the streak carries into the next chamber');
    const again = run(state, 1, { pressed: ['act'] }).state;
    assert.equal(again.chamber.index, 2, 'Act on the result is Next');
    const home = grove.act(next, { type: 'home' });
    assert.equal(home.state.mode, 'hub');
    assert.deepEqual(of(home.events, 'shot').map((e) => e.shot), ['home']);
    assert.equal(grove.act(home.state, { type: 'home' }).events.length, 0);
  });

  it('meets a wrong stone gently: the same problem, Mimi naming the answer, the picture shown', () => {
    const state = grove.act(fresh(5), { type: 'world', world: 'tide' }).state;
    const { problem, verb } = state.chamber;
    const wrong = verb.stones.find((/** @type {any} */ s) => s.tag !== 'correct');
    const fetched = tapWalk(state, [wrong.x, wrong.z]);
    const [ax, az] = centerOf(fetched.state.board, fetched.state.board.altar[0], fetched.state.board.altar[1]);
    const out = play(grove, fetched.state, [{ tap: { x: ax, z: az } }, ...idle(200)]);
    const said = of(out.events, 'say');
    assert.equal(said.length, 1);
    assert.equal(said[0].text, t('en', explainKey(problem, { tag: wrong.tag }), { ...lineVars(problem), value: wrong.value }));
    assert.ok(said[0].text.includes(String(problem.answer)), 'the line names the answer');
    assert.ok(sounds(out.events).includes('wrong') && !sounds(out.events).includes('right'));
    assert.deepEqual(of(out.events, 'rate').map((e) => e.correct), [false]);
    assert.equal(out.state.chamber.problem.id, problem.id, 'the same problem waits');
    assert.equal(out.state.chamber.modelShown, true);
    assert.equal(out.state.chamber.combo, 0);
    assert.ok(out.state.chamber.verb.stones.some((/** @type {any} */ s) => s.label === wrong.label && s.tried));
    assert.equal(out.state.progress.math.skills[problem.skillId].n, 1);
    const right = grove.act(out.state, { type: 'answer', value: problem.answer });
    assert.deepEqual(of(right.events, 'rate').map((e) => e.correct), [true]);
    assert.equal(right.state.progress.math.skills[problem.skillId].n, 1, 'the retry is not rated again');
    assert.equal(right.state.progress.math.log.length, 2);
    assert.ok(right.state.progress.math.log[0].tag === wrong.tag && right.state.progress.math.log[1].retry);
    assert.equal(grove.hud(right.state).prompt, solvedEquation(problem));
    assert.equal(grove.act(right.state, { type: 'answer', value: problem.answer }).events.length, 0, 'no second answer while celebrating');
    assert.equal(grove.act(right.state, { type: 'hint' }).events.length, 0);
    assert.equal(run(right.state, 1, { pressed: ['act'] }).events.length, 0);
    const later = run(right.state, Math.ceil(CELEBRATE_MS / TICK_MS) + 1);
    assert.notEqual(later.state.chamber.problem.id, problem.id, 'after the celebration, the next problem');
    assert.equal(later.state.chamber.problem.kind, 'fetch');
    const stars = (/** @type {number} */ misses) => {
      let s = grove.act(fresh(8), { type: 'world', world: 'garden' }).state;
      for (let k = 0; k < PROBLEMS_PER_CHAMBER; k++) {
        const p = s.chamber.problem;
        for (let w = 0; w < (k === 0 ? misses : 0); w++) s = grove.act(s, { type: 'answer', value: p.choices.find((/** @type {any} */ c) => c.tag !== 'correct').value }).state;
        s = run(grove.act(s, { type: 'answer', value: p.answer }).state, 90).state;
      }
      return s.chamber.stars;
    };
    assert.deepEqual([stars(0), stars(1), stars(2), stars(3)], [3, 2, 2, 1]);
  });

  it('shows the picture on a hint, and a hinted right answer counts 0.7', () => {
    const state = grove.act(fresh(6), { type: 'world', world: 'garden' }).state;
    const hinted = grove.act(state, { type: 'hint' });
    assert.ok(sounds(hinted.events).includes('chime'));
    assert.equal(of(hinted.events, 'say')[0].text, t('en', 'hint.look'));
    assert.ok(hinted.state.chamber.usedHint && hinted.state.chamber.modelShown);
    const p = state.chamber.problem;
    const out = grove.act(hinted.state, { type: 'answer', value: p.answer });
    const e = expected(600, p.difficulty);
    assert.ok(Math.abs(out.state.progress.math.skills[p.skillId].r - (600 + 32 * (0.7 - e))) < 1e-9);
    assert.equal(grove.act(state, { type: 'answer', value: 'no such stone' }).state, state);
  });

  it('grows a bed on the soil through play()', () => {
    const math = createMath();
    math.skills.tables_a = { r: 600, n: 12, hist: [] };
    const state = chamberOfKind('array', 'garden', { math });
    const soil = state.board.soil;
    const { rows, cols } = state.chamber.problem.model.params;
    const corner = centerOf(state.board, soil.i0, soil.j0);
    const far = centerOf(state.board, soil.i0 + cols - 1, soil.j0 + rows - 1);
    const planted = play(grove, state, [{ tap: { x: corner[0], z: corner[1] } }, ...idle(300), { pressed: ['act'] }]);
    assert.deepEqual(planted.state.chamber.verb.anchor, [soil.i0, soil.j0]);
    const small = rows * cols > 1 ? play(grove, planted.state, [{ pressed: ['act'] }]) : null;
    assert.equal(small?.state.chamber.verb.anchor, null, 'Act on the flag picks it back up');
    const wrong = play(grove, planted.state, [{ tap: { x: corner[0] + 1, z: corner[1] } }, ...idle(120), { pressed: ['act'] }]);
    assert.equal(of(wrong.events, 'rate')[0].correct, rows === 1 && cols === 2);
    const grown = play(grove, planted.state, [{ tap: { x: far[0], z: far[1] } }, ...idle(400), { pressed: ['act'] }]);
    assert.deepEqual(of(grown.events, 'rate').map((e) => e.correct), [true]);
    assert.equal(grove.hud(grown.state).prompt, `${rows} × ${cols} = ${rows * cols}`);
    assert.deepEqual(grown.state.chamber.verb.grown, { i0: soil.i0, j0: soil.j0, i1: soil.i0 + cols - 1, j1: soil.j0 + rows - 1 });
  });

  it('rings the vine where the fraction lives through play(), and tumbles in elsewhere', () => {
    const state = grove.act(fresh(4), { type: 'world', world: 'vines' }).state;
    const { problem } = state.chamber;
    const vine = state.board.vine;
    const [ax, z] = centerOf(state.board, vine.i0, vine.j);
    const [bx] = centerOf(state.board, vine.i1, vine.j);
    const { lo, hi } = problem.model.params;
    const x = ax + ((problem.answer - lo) / (hi - lo)) * (bx - ax);
    const far = problem.answer < (lo + hi) / 2 ? bx : ax;
    const missed = play(grove, state, [{ tap: { x: far, z } }, ...idle(400), { pressed: ['act'] }, ...idle(60)]);
    assert.ok(sounds(missed.events).includes('splash') && sounds(missed.events).includes('land'));
    assert.match(of(missed.events, 'say').at(-1).text, /where you stood/);
    assert.equal(missed.state.chamber.verb.level, 0);
    const rung = play(grove, missed.state, [{ tap: { x, z } }, ...idle(400), { pressed: ['act'] }]);
    assert.deepEqual(of(rung.events, 'rate').map((e) => e.correct), [true]);
    assert.ok(sounds(rung.events).includes('chime'));
  });

  it('shares coconuts fairly through play(), with a take-back and a check', () => {
    const math = master(createMath(), 'div_facts');
    const state = chamberOfKind('share', 'stump', { math });
    const { quotient, remainder } = state.chamber.problem.model.params;
    const board = state.board;
    const near = (/** @type {any} */ b) => centerOf(board, b.i, b.j);
    let s = play(grove, state, [{ tap: { x: near(state.chamber.verb.baskets[0])[0], z: near(state.chamber.verb.baskets[0])[1] } }, ...idle(300)]).state;
    assert.equal(s.chamber.verb.baskets[0].count, 1, 'a tap on a basket deals one in');
    const unfair = grove.act(s, { type: 'check' });
    assert.equal(of(unfair.events, 'say')[0].text, t('en', 'ex.unfair_share'));
    s = grove.act(unfair.state, { type: 'undo' }).state;
    assert.equal(s.chamber.verb.baskets[0].count, 0);
    for (const basket of s.chamber.verb.baskets) {
      const [x, z] = near(basket);
      s = play(grove, s, [{ tap: { x, z } }, ...idle(300), ...Array.from({ length: quotient - 1 }, () => ({ pressed: ['act'] }))]).state;
    }
    assert.ok(s.chamber.verb.baskets.every((/** @type {any} */ b) => b.count === quotient));
    assert.equal(s.chamber.verb.pile, remainder);
    const hud = grove.hud(s);
    assert.deepEqual(hud.buttons?.map((b) => b.id), ['hint', 'check', 'undo', 'home']);
    const checked = grove.act(s, { type: 'check' });
    assert.deepEqual(of(checked.events, 'rate').map((e) => e.correct), [true]);
    assert.equal(grove.act(checked.state, { type: 'undo' }).events.length, 0, 'nothing to undo while celebrating');
  });

  it('reshapes the board when the next problem needs another verb', () => {
    const math = master(createMath(), 'frac_magnitude');
    for (let seed = 1; seed < 300; seed++) {
      const state = grove.act(fresh(seed, { math, taught: ['fetch', 'numberline'] }), { type: 'world', world: 'vines' }).state;
      if (state.board.kind !== 'fetch') continue;
      const out = run(grove.act(state, { type: 'answer', value: state.chamber.problem.answer }).state, 90);
      if (out.state.board.kind === 'fetch') continue;
      assert.equal(out.state.board.kind, 'line');
      assert.equal(out.state.chamber.problem.kind, 'numberline');
      assert.ok(sounds(out.events).includes('whoosh'));
      assert.equal(grove.hud(out.state).toast, t('en', 'play.reshape'));
      return;
    }
    assert.fail('no seed reshaped the board');
  });

  it('celebrates a skill mastered and a world blooming', () => {
    const math = createMath();
    math.skills.counting = { r: 849, n: 9, hist: Array(9).fill(1) };
    for (const id of ['number_bonds', 'add_20']) math.skills[id] = { r: 800, n: 10, hist: Array(10).fill(1) };
    let state = grove.act(fresh(2, { math }), { type: 'world', world: 'tide' }).state;
    assert.equal(state.chamber.problem.skillId, 'counting');
    const out = grove.act(state, { type: 'answer', value: state.chamber.problem.answer });
    assert.ok(sounds(out.events).includes('levelup'));
    assert.ok(of(out.events, 'say').some((e) => e.text === t('en', 'result.mastered', { skill: 'Counting on' })));
    state = run(out.state, 90).state;
    /** @type {any[]} */
    const events = [];
    for (let k = 1; k < PROBLEMS_PER_CHAMBER; k++) {
      const done = run(grove.act(state, { type: 'answer', value: state.chamber.problem.answer }).state, 90);
      events.push(...done.events);
      state = done.state;
    }
    assert.equal(state.mode, 'result');
    assert.ok(state.progress.gates.tide >= 1);
    assert.ok(of(events, 'say').some((e) => e.text === t('en', 'result.bloomed', { world: 'Tide Pools' })));
  });

  it('brings the vine\'s labels back on a hint, hops in the open, and reads pressed buttons', () => {
    const vines = grove.act(fresh(4), { type: 'world', world: 'vines' }).state;
    const labelled = run({ ...vines, chamber: { ...vines.chamber, verb: { ...vines.chamber.verb, level: 2 } } }, 1, { pressed: ['hint'] });
    assert.equal(labelled.state.chamber.verb.level, 0);
    assert.equal(labelled.state.chamber.usedHint, true);
    assert.equal(run(vines, 1, { pressed: ['pause'] }).events.length, 0, 'a button the game does not know does nothing');
    const tide = grove.act(fresh(5), { type: 'world', world: 'tide' }).state;
    const [ox, oz] = openPoint(tide.board, tide.chamber.verb.stones);
    const away = { ...tide, monkey: { ...tide.monkey, x: ox, z: oz, jumpMs: 0 } };
    assert.deepEqual(sounds(grove.act(away, { type: 'act' }).events), ['hop'], 'nothing to use here: a hop');
    let done = tide;
    for (let k = 0; k < PROBLEMS_PER_CHAMBER; k++) done = run(grove.act(done, { type: 'answer', value: done.chamber.problem.answer }).state, 90).state;
    assert.equal(done.mode, 'result');
    const stone = { x: done.monkey.x + 2, z: done.monkey.z };
    const tapped = play(grove, done, [{ tap: stone }, ...idle(5)]);
    assert.equal(tapped.state.monkey.intent, false, 'on the result, a tap only walks');
  });

  it('lets Mimi cheer in a chamber', () => {
    const state = grove.act(fresh(5), { type: 'world', world: 'tide' }).state;
    const [mx, mz] = centerOf(state.board, state.board.mimi[0], state.board.mimi[1]);
    const out = tapWalk({ ...state, chamber: { ...state.chamber, verb: { ...state.chamber.verb, stones: [] } } }, [mx, mz]);
    assert.ok(of(out.events, 'say').some((e) => e.text.startsWith(t('en', 'play.cheer.1').slice(0, 4))));
  });
});

describe('the Banana Duel', () => {
  it('takes turns problem by problem, round by round, and ends with a winner', () => {
    let state = grove.create({ seed: 31, save: null, players: [PLAYER, GUEST], options: { rounds: 2 } });
    assert.equal(grove.duel, true);
    assert.equal(state.mode, 'chamber');
    assert.deepEqual([state.duel.round, state.duel.turn, state.duel.rounds], [0, 0, 2]);
    assert.equal(grove.hud(state).toast, t('en', 'duel.turn', { name: 'Ada' }));
    assert.deepEqual(grove.hud(state).players?.map((p) => [p.name, p.active]), [['Ada', true], ['Bo', false]]);
    assert.equal(grove.over(state), null);
    const [p0, p1] = state.duel.problems;
    assert.equal(p0.skillId, p1.skillId, 'the same skill for both');
    assert.equal(p0.kind, p1.kind);
    /** @type {any[]} */
    const events = [];
    const turns = [];
    for (let k = 0; k < 4; k++) {
      turns.push([state.duel.round, state.duel.turn]);
      const p = state.chamber.problem;
      if (state.duel.turn === 1 && state.duel.round === 0) {
        const wrong = p.choices ? p.choices.find((/** @type {any} */ c) => c.tag !== 'correct').value : null;
        if (wrong !== null) events.push(...grove.act(state, { type: 'answer', value: wrong }).events);
      }
      const out = solveTurn(state);
      events.push(...out.events);
      state = out.state;
    }
    assert.deepEqual(turns, [[0, 0], [0, 1], [1, 0], [1, 1]]);
    assert.equal(state.mode, 'over');
    assert.ok(sounds(events).includes('pass') && sounds(events).includes('start') === false);
    const outcome = grove.over(state);
    assert.ok(outcome && outcome.score === Math.max(...state.duel.scores));
    assert.ok(outcome.stars >= 1 && outcome.stars <= 3);
    assert.equal(outcome.summary, of(events, 'say').at(-1).text);
    assert.equal(grove.hud(state).prompt, outcome.summary);
    assert.equal(grove.hud(state).players?.some((p) => p.active), false);
    assert.equal(grove.step(state, { held: NO_KEYS, pressed: ['act'], tap: null, time: 0 }, TICK_MS).events.length, 0, 'nothing moves once it is over');
    assert.equal(grove.act(state, { type: 'home' }).state, state, 'a duel has no way home');
  });

  it('records only the first player\'s answers on the island and scores streaks', () => {
    let state = grove.create({ seed: 12, save: null, players: [PLAYER, GUEST], options: { rounds: 1 } });
    const first = solveTurn(state);
    assert.equal(of(first.events, 'rate').length, 1);
    state = first.state;
    assert.equal(state.duel.turn, 1);
    assert.equal(state.duel.scores[0], 10);
    const second = solveTurn(state);
    assert.equal(of(second.events, 'rate').length, 0, 'the guest plays for the duel alone');
    assert.deepEqual(second.state.duel.scores, [10, 10]);
    assert.equal(second.state.duel.winner, -1);
    assert.equal(grove.over(second.state)?.summary, t('en', 'duel.tie'));
    assert.equal(grove.over(second.state)?.stars, 3);
    let upset = grove.create({ seed: 12, save: null, players: [PLAYER, GUEST], options: { rounds: 2 } });
    upset = solveTurn(solveTurn(upset).state).state;
    const p = upset.chamber.problem;
    assert.ok(p.choices, 'round two is a stone hunt');
    upset = grove.act(upset, { type: 'answer', value: p.choices.find((/** @type {any} */ c) => c.tag !== 'correct').value }).state;
    upset = solveTurn(solveTurn(upset).state).state;
    assert.deepEqual(upset.duel.scores, [20, 22], 'a miss costs the streak, nothing more');
    assert.equal(upset.duel.winner, 1, 'the guest can win');
    assert.equal(grove.over(upset)?.summary, t('en', 'duel.winner', { name: 'Bo', score: upset.duel.scores[1] }));
    const four = grove.create({ seed: 1, save: null, players: [PLAYER, GUEST] });
    assert.equal(four.duel.rounds, DUEL_ROUNDS);
    assert.equal(grove.act(four, { type: 'world', world: 'tide' }).state, four, 'no wandering off mid-duel');
  });
});

/** Solve the current duel turn and let its celebration run out. @param {any} state */
function solveTurn(state) {
  const p = state.chamber.problem;
  /** @type {any[]} */
  const events = [];
  let s = state;
  if (p.kind === 'fetch') {
    const out = grove.act(s, { type: 'answer', value: p.answer });
    events.push(...out.events);
    s = out.state;
  }
  else {
    s = { ...s, chamber: { ...s.chamber } };
    const out = forceRight(s);
    events.push(...out.events);
    s = out.state;
  }
  const rest = run(s, Math.ceil(CELEBRATE_MS / TICK_MS) + 2);
  return { state: rest.state, events: [...events, ...rest.events] };
}

/** Answer a constructed problem rightly by standing where it is solved and acting. @param {any} state */
function forceRight(state) {
  const { problem, verb } = state.chamber;
  const board = state.board;
  if (problem.kind === 'numberline') {
    const [ax, z] = centerOf(board, board.vine.i0, board.vine.j);
    const [bx] = centerOf(board, board.vine.i1, board.vine.j);
    const { lo, hi } = problem.model.params;
    return grove.act({ ...state, monkey: { ...state.monkey, x: ax + ((problem.answer - lo) / (hi - lo)) * (bx - ax), z } }, { type: 'act' });
  }
  if (problem.kind === 'share') {
    const { quotient, remainder } = problem.model.params;
    return grove.act({ ...state, chamber: { ...state.chamber, verb: { ...verb, pile: remainder, baskets: verb.baskets.map((/** @type {any} */ b) => ({ ...b, count: quotient })) } } }, { type: 'check' });
  }
  const { rows, cols } = problem.model.params;
  const soil = board.soil;
  const [x, z] = centerOf(board, soil.i0 + cols - 1, soil.j0 + rows - 1);
  return grove.act({ ...state, chamber: { ...state.chamber, verb: { ...verb, anchor: [soil.i0, soil.j0] } }, monkey: { ...state.monkey, x, z } }, { type: 'act' });
}

// ---------- the module's surface ----------

describe('the game module', () => {
  it('is a GameModule the arcade can shelve', () => {
    assert.equal(grove.id, 'grove');
    assert.equal(grove.title, 'Monkey Grove');
    assert.equal(grove.track, 'grove');
    assert.equal(grove.duel, true);
    assert.ok(grove.blurb.length > 20);
    assert.ok(grove.camera.distance >= 18 && grove.camera.distance <= 80);
    assert.deepEqual(grove.tools?.map((tool) => tool.name), ['grove_problem', 'grove_hint']);
    assert.equal(grove.act(fresh(), { type: 'dance' }).events.length, 0);
    const nl = grove.act(fresh(), { type: 'lang', lang: 'nl' });
    assert.equal(nl.state.lang, 'nl');
    assert.equal(grove.hud(nl.state).subtitle, 'Breng de getallen thuis!');
    assert.equal(grove.act(fresh(), { type: 'next' }).events.length, 0, 'no next chamber from the island');
    assert.equal(grove.act(fresh(), { type: 'check' }).events.length, 0);
    assert.equal(grove.act(fresh(), { type: 'act' }).events.length, 2, 'an on-screen Act button is Act');
  });

  it('stays pure: a frozen state is never written to', () => {
    const state = deepFreeze(grove.act(fresh(9), { type: 'world', world: 'tide' }).state);
    const { problem, verb } = state.chamber;
    const stone = verb.stones[0];
    assert.doesNotThrow(() => {
      tapWalk(state, [stone.x, stone.z], 200);
      grove.act(state, { type: 'answer', value: problem.answer });
      grove.act(state, { type: 'hint' });
      run(state, 30, { held: { left: true } });
      grove.draw(state, ctxOf('light'));
      grove.hud(state);
      grove.save(state);
      grove.tools?.forEach((tool) => tool.run(state, {}));
    });
  });

  it('saves the island and restores it, refusing a broken save field by field', () => {
    let state = grove.act(fresh(5, null, { now: BASE }), { type: 'world', world: 'tide' }).state;
    state = run(grove.act(state, { type: 'answer', value: state.chamber.problem.answer }).state, 10).state;
    const saved = grove.save(state);
    assert.deepEqual(JSON.parse(JSON.stringify(saved)), saved, 'plain JSON');
    assert.ok(saved.clock >= BASE);
    const back = grove.create({ seed: 1, save: JSON.parse(JSON.stringify(saved)), players: [PLAYER] });
    assert.deepEqual(back.progress, state.progress);
    assert.equal(back.clock, saved.clock);
    assert.equal(back.mode, 'hub');
    const broken = restoreProgress({ math: { skills: { add_20: { r: 'x' }, sub_20: { r: 700, n: 3, hist: [1, 0, 5, 1, 1, 1, 1, 1, 1, 1, 1, 0] } }, log: [{ skill: 'nope', t: 1 }, null, { skill: 'add_20', t: 5 }] },
      bananas: -4, best: { tide: 9, garden: 'x' }, gates: null, met: 'yes', talks: 2.5, taught: ['fetch', 7] });
    assert.deepEqual(broken.math.skills.add_20, { r: 600, n: 0, hist: [] });
    assert.deepEqual(broken.math.skills.sub_20, { r: 700, n: 3, hist: [1, 1, 1, 1, 1, 1, 1, 1, 1, 0] }, 'the last ten, as ones and zeros');
    assert.deepEqual(broken.math.log.map((e) => e.skill), ['add_20']);
    assert.deepEqual([broken.bananas, broken.best.tide, broken.best.garden, broken.gates.vines, broken.met, broken.talks, broken.taught], [0, 3, 0, 0, false, 0, ['fetch']]);
    assert.deepEqual(restoreProgress(undefined), restoreProgress({}));
    assert.equal(grove.create({ seed: 1, save: null, players: [] }).players[0].name, 'Explorer');
  });

  it('offers a coach the problem without its answer, and a hint button', () => {
    const [problemTool, hintTool] = /** @type {any[]} */ (grove.tools);
    const hub = problemTool.run(fresh(), {});
    assert.equal(hub.result.problem, null);
    assert.equal(hub.result.worlds.length, 4);
    for (const [world, save] of /** @type {Array<[string, any]>} */ ([['tide', null], ['vines', null]])) {
      const state = grove.act(fresh(5, save), { type: 'world', world }).state;
      const read = problemTool.run(state, {});
      assert.equal(read.state, state);
      assert.equal('answer' in read.result.problem, false);
      assert.equal(JSON.stringify(read.result).includes('"answer"'), false);
      assert.equal(read.result.problem.equation, state.chamber.problem.equation);
      if (world === 'tide') assert.equal(read.result.board.stones.length, state.chamber.problem.choices.length);
      else assert.equal(typeof read.result.board.standingAt, 'number');
    }
    const array = grove.act(chamberOfKind('array', 'garden', { math: rated('tables_a', 600, 12) }), { type: 'act' }).state;
    assert.ok('bed' in problemTool.run(array, {}).result.board);
    const share = chamberOfKind('share', 'stump', { math: master(createMath(), 'div_facts') });
    const shared = problemTool.run(share, {}).result;
    assert.equal(shared.board.share.baskets.length, share.chamber.problem.model.params.baskets);
    assert.deepEqual(shared.problem.picture, { kind: 'baskets', shown: share.chamber.modelShown }, 'the picture, never its numbers');
    assert.equal(JSON.stringify(shared).includes('quotient'), false);
    const state = grove.act(fresh(5), { type: 'world', world: 'tide' }).state;
    const hinted = hintTool.run(state, {});
    assert.equal(hinted.result.shown, true);
    assert.equal(hinted.state.chamber.usedHint, true);
    assert.ok(hinted.events.length > 0);
    assert.equal(problemTool.run(hinted.state, {}).result.problem.hintShown, true);
    const idleHint = hintTool.run(run(grove.act(state, { type: 'answer', value: state.chamber.problem.answer }).state, 2).state, {});
    assert.equal(idleHint.result.shown, false, 'nothing to show mid-celebration');
    const wrong = grove.act(state, { type: 'answer', value: state.chamber.problem.choices.find((/** @type {any} */ c) => c.tag !== 'correct').value }).state;
    assert.equal(coachView(wrong).problem?.lastMistake, wrong.chamber.lastTag);
    assert.equal(coachView({ ...wrong, monkey: { ...wrong.monkey, carry: wrong.chamber.verb.stones[0] } }).holding, wrong.chamber.verb.stones[0].label);
  });
});

describe('the HUD', () => {
  it('shows the island, the problem, the result and the duel in both languages', () => {
    for (const lang of LANGS) {
      const hub = grove.hud(fresh(1, { bananas: 1 }, { lang }));
      assert.equal(hub.title, 'Monkey Grove');
      assert.equal(hub.score, t(lang, 'hud.banana'));
      assert.equal(hub.help, t(lang, 'help.hub'));
      assert.deepEqual(hub.grid?.rows[0].cells.map((c) => c.id), WORLDS);
      assert.equal(hub.grid?.rows[0].cells[0].text, '☆☆☆ 0%');
      assert.deepEqual(hub.grid?.columns, WORLDS.map((w) => t(lang, `world.${w}`)));
      const chamber = grove.act(fresh(5, null, { lang }), { type: 'world', world: 'tide' }).state;
      const hud = grove.hud(chamber);
      assert.equal(hud.title, t(lang, 'world.tide'));
      assert.equal(hud.prompt, chamber.chamber.problem.equation);
      assert.equal(hud.subtitle, t(lang, chamber.chamber.problem.prompt.key, lineVars(chamber.chamber.problem)));
      assert.equal(hud.level, t(lang, 'hud.level', { n: 1, k: 1, total: 3 }));
      assert.equal(hud.score, t(lang, 'hud.bananas', { n: 0 }));
      assert.deepEqual(hud.buttons?.map((b) => b.id), ['hint', 'home']);
      assert.equal(hud.help, t(lang, 'help.fetch'));
      assert.equal(hud.meter?.label, t(lang, 'hud.bloom'));
      assert.deepEqual(hud.grid?.rows[0].cells.map((c) => c.id).sort(), chamber.chamber.problem.choices.map((/** @type {any} */ c) => String(c.value)).sort());
      const stone = chamber.chamber.verb.stones[0];
      const carrying = grove.hud({ ...chamber, monkey: { ...chamber.monkey, carry: stone }, chamber: { ...chamber.chamber, verb: { ...chamber.chamber.verb, stones: chamber.chamber.verb.stones.slice(1) } } });
      assert.equal(carrying.grid?.rows[0].cells.find((c) => c.active)?.id, stone.label, 'the stone in hand is lit');
      const solved = grove.act(chamber, { type: 'cell', id: String(chamber.chamber.problem.answer) }).state;
      assert.equal(grove.hud(solved).subtitle, t(lang, 'hud.solved'));
      assert.equal(grove.hud(solved).grid, undefined);
      const line = grove.hud(grove.act(fresh(5, null, { lang }), { type: 'world', world: 'vines' }).state);
      assert.equal(line.help, t(lang, 'help.numberline'));
      assert.equal(line.grid, undefined);
      const duel = grove.hud(grove.create({ seed: 4, save: null, players: [PLAYER, GUEST], options: { lang } }));
      assert.equal(duel.title, t(lang, 'hud.duel'));
      assert.equal(duel.level, t(lang, 'hud.round', { n: 1, total: DUEL_ROUNDS }));
      assert.equal(duel.score, undefined);
      assert.deepEqual(duel.players?.map((p) => p.score), [t(lang, 'hud.bananas', { n: 0 }), t(lang, 'hud.bananas', { n: 0 })]);
      assert.ok(!duel.buttons?.some((b) => b.id === 'home'));
      const later = run(chamber, Math.ceil(TOAST_MS / TICK_MS) + 2).state;
      assert.equal(grove.hud(later).toast, null, 'a line fades');
    }
  });
});

// ---------- drawing ----------

describe('the drawing', () => {
  /** @type {Array<[string, any]>} */
  const scenes = [];
  scenes.push(['hub', fresh(2, { bananas: 30 })]);
  const tide = grove.act(fresh(5), { type: 'world', world: 'tide' }).state;
  scenes.push(['fetch', tide]);
  scenes.push(['array', chamberOfKind('array', 'garden', { math: rated('tables_a', 600, 12) })]);
  scenes.push(['line', grove.act(fresh(4), { type: 'world', world: 'vines' }).state]);
  scenes.push(['share', chamberOfKind('share', 'stump', { math: master(createMath(), 'div_facts') })]);

  it('draws the hub and every board in every theme, lit and unlit, with the figures named', () => {
    for (const [name, state] of scenes) {
      for (const theme of /** @type {const} */ (['light', 'dark', 'neon'])) {
        for (const light of [createLighting({ hour: 10 }), null]) {
          const drawn = grove.draw(state, ctxOf(theme, { light }));
          assert.ok(drawn.items.length > 150, `${name}/${theme}`);
          assert.deepEqual(drawn.figures?.map((f) => f.id), ['monkey', 'mimi']);
          assert.ok(drawn.items.every((item) => ['poly', 'line', 'disc', 'rect', 'text', 'arc'].includes(item.t)));
          if (name !== 'array') assert.ok(drawn.items.some((item) => item.t === 'text'), 'labels');
          const shadows = drawn.items.filter((item) => item.t === 'poly' && item.a === 0.16).length;
          if (light) assert.ok(shadows > 0, `${name}/${theme} casts shadows`);
          else assert.equal(shadows, 0);
          const ids = drawn.picks?.map((p) => p.id) ?? [];
          assert.ok(ids.includes('monkey') && ids.includes('mimi'));
          if (name === 'fetch') assert.equal(ids.filter((id) => id.startsWith('stone:')).length, state.chamber.verb.stones.length);
          if (name === 'hub') assert.equal(ids.filter((id) => id.startsWith('portal:')).length, 4);
          if (name === 'share') assert.equal(ids.filter((id) => id.startsWith('basket:')).length, state.chamber.verb.baskets.length);
        }
      }
    }
  });

  it('draws the ragdoll\'s bodies when the arcade hands them back, and holds still under reduced motion', () => {
    const bodies = { monkey: skeleton(POSES.tumble), mimi: skeleton(POSES.dance) };
    const posed = drawGrove(tide, ctxOf('light'));
    const thrown = drawGrove(tide, ctxOf('light', { bodies }));
    assert.notDeepEqual(thrown.items, posed.items);
    const still = drawGrove(tide, ctxOf('light', { reduce: true, time: 0 }));
    assert.deepEqual(drawGrove(tide, ctxOf('light', { reduce: true, time: 99999 })).items, still.items);
    const left = drawGrove({ ...tide, monkey: { ...tide.monkey, face: -1, moving: true, stride: 2 } }, ctxOf('dark'));
    assert.ok(left.items.length > 0);
    const carrying = drawGrove({ ...tide, monkey: { ...tide.monkey, carry: tide.chamber.verb.stones[0] } }, ctxOf('light'));
    assert.ok(carrying.picks?.some((p) => p.id === `stone:${tide.chamber.verb.stones[0].id}`), 'the stone overhead');
    const hopping = drawGrove({ ...tide, monkey: { ...tide.monkey, jumpMs: JUMP_MS / 2 } }, ctxOf('light'));
    const dunking = drawGrove({ ...tide, monkey: { ...tide.monkey, jumpMs: 0, dunkMs: DUNK_MS / 2 } }, ctxOf('light'));
    const long = { ...tide.chamber.verb.stones[0], label: '3 4/5', tried: true };
    const marked = drawGrove({ ...tide, chamber: { ...tide.chamber, verb: { ...tide.chamber.verb, stones: [long, ...tide.chamber.verb.stones.slice(1)] } } }, ctxOf('light'));
    assert.ok(marked.items.some((item) => item.t === 'text' && item.text === '3 4/5' && item.a === 0.55), 'a tried stone is dimmed');
    const duel = grove.create({ seed: 4, save: null, players: [PLAYER, GUEST] });
    const second = { ...duel, duel: { ...duel.duel, turn: 1 } };
    assert.ok(drawGrove(second, ctxOf('light')).items.some((item) => item.t === 'line' && item.stroke === GUEST.color), 'the monkey wears the player\'s colour');
    assert.notDeepEqual(hopping.items, dunking.items);
    const talking = drawGrove({ ...tide, mimiAt: tide.clock }, ctxOf('light'));
    assert.ok(talking.items.length > 0);
    const behind = { ...ctxOf('light'), view: viewOf({ azimuth: 0, elevation: 0.2, distance: 18, lift: 0, fov: 0.6, target: [0, 0, 30] }, 640, 480) };
    assert.ok(Array.isArray(drawGrove(tide, behind).items), 'a view from far off still draws');
  });

  it('puts the problem\'s picture on the floor, whatever its model', () => {
    const plain = drawGrove({ ...tide, chamber: { ...tide.chamber, modelShown: false } }, ctxOf('light')).items.length;
    const models = [
      [{ kind: 'array', params: { rows: 3, cols: 4 } }, {}],
      [{ kind: 'array', params: { rows: 4, cols: 26 } }, {}],
      [{ kind: 'baskets', params: { total: 13, baskets: 4, quotient: 3, remainder: 1 } }, {}],
      [{ kind: 'baskets', params: { total: 12, baskets: 4, quotient: 3, remainder: 0 } }, {}],
      [{ kind: 'numberline', params: { n: 3, d: 4, lo: 0, hi: 1 } }, {}],
      [{ kind: 'strip', params: { a: 8, b: 5, op: '+' } }, {}],
      [{ kind: 'strip', params: { a: 45, b: 7, op: '−' } }, {}],
      [{ kind: 'none', params: {} }, { a: 4 }],
    ];
    for (const [model, meta] of models) {
      const state = { ...tide, chamber: { ...tide.chamber, modelShown: true, problem: { ...tide.chamber.problem, model, meta: { ...tide.chamber.problem.meta, ...meta } } } };
      assert.ok(drawGrove(state, ctxOf('light')).items.length > plain, JSON.stringify(model));
    }
    const solved = grove.act(tide, { type: 'answer', value: tide.chamber.problem.answer }).state;
    assert.ok(drawGrove(solved, ctxOf('light')).picks?.some((p) => p.id === 'stone:-1'), 'the answer stone sits on the altar');
    const result = run(solved, 90).state;
    assert.ok(drawGrove({ ...result, mode: 'result' }, ctxOf('light')).items.length > 0);
  });

  it('draws the bed, the vine and the baskets as they change', () => {
    const [, array] = scenes[2];
    const soil = array.board.soil;
    const flagged = { ...array, chamber: { ...array.chamber, modelShown: true, verb: { ...array.chamber.verb, anchor: [soil.i0, soil.j0] } } };
    const grown = { ...array, chamber: { ...array.chamber, verb: { ...array.chamber.verb, grown: { i0: soil.i0, j0: soil.j0, i1: soil.i0 + 2, j1: soil.j0 + 1 } } } };
    const base = drawGrove(array, ctxOf('light')).items.length;
    assert.ok(drawGrove(flagged, ctxOf('light')).items.length > base);
    assert.ok(drawGrove(grown, ctxOf('light')).items.length > base);
    const [, line] = scenes[3];
    const rung = { ...line, chamber: { ...line.chamber, lastTag: 'correct', verb: { ...line.chamber.verb, level: 0 } } };
    assert.ok(drawGrove(rung, ctxOf('light')).items.length > drawGrove({ ...line, chamber: { ...line.chamber, verb: { ...line.chamber.verb, level: 2 } } }, ctxOf('light')).items.length);
    const [, share] = scenes[4];
    const dealt = { ...share, chamber: { ...share.chamber, pulseAt: share.clock - 100, verb: { ...share.chamber.verb, baskets: share.chamber.verb.baskets.map((/** @type {any} */ b) => ({ ...b, count: 4 })) } } };
    assert.notDeepEqual(drawGrove(dealt, ctxOf('light')).items, drawGrove(share, ctxOf('light')).items);
  });

  it('blooms the island from gray as its numbers come home', () => {
    const grayTide = lerpColor(COLORS.gray, WORLD_COLORS.tide.floor, 0.25);
    const freshFills = new Set(drawGrove(fresh(), ctxOf('light', { light: null })).items.map((item) => /** @type {any} */ (item).fill));
    assert.ok(freshFills.has(grayTide), 'a fresh island is mostly gray');
    assert.ok(!freshFills.has(WORLD_COLORS.tide.floor));
    const math = createMath();
    for (const id of SKILL_IDS) master(math, id);
    const bloomed = fresh(1, { math, bananas: 900 });
    assert.deepEqual(Object.values(hubBloom(bloomed)).map((b) => [b.p, b.stage]), [[1, 4], [1, 4], [1, 4], [1, 4]]);
    const bloomFills = new Set(drawGrove(bloomed, ctxOf('light', { light: null })).items.map((item) => /** @type {any} */ (item).fill));
    assert.ok(bloomFills.has(WORLD_COLORS.tide.floor) && bloomFills.has(WORLD_COLORS.vines.floor));
    assert.ok(bloomFills.has(COLORS.gold), 'flowers and stars');
    const kept = hubBloom(fresh(1, { gates: { stump: 3 } }));
    assert.ok(kept.stump.p >= 0.6 && kept.stump.stage === 3, 'a gate never wilts below the step it reached');
  });

  it('keeps every colour out of the pink and purple family', () => {
    const dir = fileURLToPath(new URL('../../packages/website/src/os/games/grove/', import.meta.url));
    const hue = (/** @type {string} */ hex) => {
      const [r, g, b] = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      if (max === min) return { h: 0, sat };
      const h = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
      return { h: (h * 60 + 360) % 360, sat };
    };
    let count = 0;
    for (const file of readdirSync(dir)) {
      const text = readFileSync(dir + file, 'utf8');
      for (const banned of BANNED_HUES) assert.ok(!text.toLowerCase().includes(banned.toLowerCase()), `${file}: ${banned}`);
      for (const [hex] of text.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
        const { h, sat } = hue(hex);
        assert.ok(!(h >= 260 && h <= 345 && sat > 0.15), `${file}: ${hex} is in the banned family`);
        count++;
      }
      assert.ok(text.startsWith('//@ts-check') || file.endsWith('.json'), `${file} is checked`);
    }
    assert.ok(count > 20);
    for (const hex of [...Object.values(COLORS), ...Object.values(WORLD_COLORS).flatMap((w) => [w.floor, w.accent])]) assert.ok(!(hue(hex).h >= 260 && hue(hex).h <= 345));
  });
});

describe('the figures', () => {
  it('builds a monkey over a skeleton: ears, a curled tail, mirrored when it faces left', () => {
    const shape = monkey(STAND);
    const plain = skeleton(STAND);
    assert.equal(shape.dots.length, 3, 'a head and two ears');
    assert.equal(shape.strokes.length, 6, 'five limbs and a tail');
    const tail = shape.strokes[5].pts;
    assert.ok(tail[tail.length - 1][1] > plain.hip[1], 'the tail curls up');
    assert.ok(tail.every(([u]) => u < plain.hip[0] + 0.05), 'behind a monkey facing right');
    const left = monkey(STAND, { face: -1 });
    assert.deepEqual(left.strokes[5].pts.map(([u, v]) => [-u, v]), tail);
    assert.deepEqual(left.center, [-shape.center[0], shape.center[1]]);
    assert.deepEqual(monkeyShape(plain), shape);
    assert.deepEqual(flowerSpot(plain), [plain.skull[0] + 0.12, plain.skull[1] + 0.27]);
    assert.notDeepEqual(walkPose(0), walkPose(1));
    assert.equal(monkeyPose({ dunkMs: 5, carry: null, moving: false, stride: 0 }, false, 0), POSES.tumble);
    assert.equal(monkeyPose({ dunkMs: 0, carry: {}, moving: false, stride: 0 }, false, 0), POSES.lift);
    assert.notEqual(monkeyPose({ dunkMs: 0, carry: {}, moving: true, stride: 1 }, false, 0), POSES.lift);
    assert.equal(monkeyPose({ dunkMs: 0, carry: null, moving: false, stride: 0 }, false, 0), STAND);
    assert.deepEqual(monkeyPose({ dunkMs: 0, carry: null, moving: true, stride: 1 }, false, 0), walkPose(4.2));
    assert.notDeepEqual(monkeyPose({ dunkMs: 0, carry: null, moving: false, stride: 0 }, true, 0), STAND);
    assert.notDeepEqual(mimiPose(true, 100), mimiPose(false, 100));
  });
});
