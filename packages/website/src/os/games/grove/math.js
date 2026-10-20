//@ts-check
/**
 * The adaptive arithmetic engine under Monkey Grove's island: a ladder
 * of 21 skills over the four story worlds, an Elo-style rating per
 * skill, the rule that picks which skill to serve and how hard, and the
 * mastery report the island blooms from. Pure functions over a plain
 * JSON math state — `{ skills: { [id]: { r, n, hist } }, log }` — that
 * answer a NEW state and never read a clock or invent randomness: the
 * caller hands in `now` and the stream to draw from.
 *
 * The rating is one-sided Elo. A skill's rating `r` meets an item of a
 * fixed tier difficulty `d`; the expected success is
 * `1 / (1 + 10^((d − r)/400))`, and a result moves `r` by `K·(score −
 * expected)` with `K = 32` for the first twenty problems and 16 after,
 * a hinted correct scoring 0.7. Problems are aimed `108` points under
 * the rating, where the expected success is about 65%: hard enough to
 * think about, easy enough to win most of the time. A skill left alone
 * rusts back toward a fresh start (a two-day grace, then a sixty-day
 * half-life), and is MASTERED at 850 with at least ten problems and 80%
 * of the last ten right.
 *
 * A problem is rated once, by its first answer: a child who misses and
 * tries again is never charged a second time, and the retry is logged
 * with its own misconception and its own time.
 */

import { GENERATORS } from './generators.js';
import { hasLine } from './strings.js';

/**
 * @typedef {import('./rng.js').Rng} Rng
 * @typedef {import('./generators.js').Kind} Kind
 * @typedef {import('./generators.js').Choice} Choice
 * @typedef {import('./generators.js').Line} Line
 * @typedef {import('./generators.js').Model} Model
 * @typedef {'tide' | 'garden' | 'stump' | 'vines'} World
 * @typedef {{ r: number, n: number, hist: number[] }} SkillState
 * @typedef {{ t: number, skill: string, tag: string, item: string | null, value: number | null, ok: boolean,
 *   ms: number, hint: boolean, retry: boolean }} LogEntry
 * @typedef {{ skills: Record<string, SkillState>, log: LogEntry[] }} MathState
 * @typedef {{ id: string, world: World, order: number, prereqs: string[], kinds: Kind[] }} Skill
 * @typedef {{ id: string, skillId: string, world: World, kind: Kind, equation: string, prompt: Line,
 *   answer: number | string, accept: { tol: number } | null, choices: Choice[] | null, model: Model,
 *   scaffold: number, difficulty: number, explain: Line, meta: Record<string, any> }} Problem
 * @typedef {{ world?: string, kind?: Kind, skill?: string, rng: Rng, now?: number }} ProblemOptions
 * @typedef {{ id: string, rating: number, acc10: number, n: number, mastered: boolean }} SkillReport
 * @typedef {{ worlds: Record<World, { pct: number, skills: SkillReport[] }>, weakest: string[] }} Report
 */

/** The four story worlds, in the order their portals stand. */
export const WORLDS = Object.freeze(/** @type {World[]} */ (['tide', 'garden', 'stump', 'vines']));

/** Each world's climb, easiest first; a skill's prerequisite is the one before it. */
export const LADDER = Object.freeze(/** @type {Record<World, readonly string[]>} */ ({
  tide: Object.freeze(['counting', 'number_bonds', 'add_20', 'sub_20', 'missing_addend', 'add_100', 'sub_100', 'big_numbers']),
  garden: Object.freeze(['tables_a', 'tables_b', 'tables_c', 'tables_mix', 'mult_2digit']),
  stump: Object.freeze(['div_facts', 'share', 'div_remainder', 'missing_factor']),
  vines: Object.freeze(['frac_magnitude', 'frac_compare', 'frac_equiv', 'frac_of_n']),
}));

/** The kinds a skill can be played as, its natural kind first. Unlisted skills are stone hunts. */
const KINDS = Object.freeze(/** @type {Record<string, Kind[]>} */ ({
  tables_a: ['fetch', 'array'], tables_b: ['fetch', 'array'], tables_c: ['fetch', 'array'], tables_mix: ['fetch', 'array'],
  div_facts: ['fetch', 'share'], share: ['share', 'fetch'], div_remainder: ['share', 'fetch'], missing_factor: ['fetch', 'share'],
  frac_magnitude: ['numberline'],
}));

/** Every skill, by id. */
export const SKILLS = Object.freeze(/** @type {Record<string, Skill>} */ (Object.fromEntries(WORLDS.flatMap((world) =>
  LADDER[world].map((id, order) => [id, Object.freeze({
    id, world, order,
    prereqs: order === 0 ? [] : [LADDER[world][order - 1]],
    kinds: KINDS[id] ?? ['fetch'],
  })])))));

/** The skill ids, ladder by ladder. */
export const SKILL_IDS = Object.freeze(Object.keys(SKILLS));

/** The rating's constants. */
export const RATING = Object.freeze({
  start: 600, mastery: 850, accuracy: 0.8, minN: 10, histMax: 10, logMax: 200,
  offset: 108, coldN: 8, decayGrace: 2, decayHalfLife: 60,
});

/** What a board can physically host: the soil bed and the baskets. */
export const HOST_LIMITS = Object.freeze({ arrayRows: 8, arrayCols: 10, baskets: 6 });

/** The bloom a world's gate shows passes these fractions of mastery. */
export const GATE_STEPS = Object.freeze([0.12, 0.35, 0.6, 0.88]);

const DAY_MS = 86400000;

/** A fresh math state: every skill at the start rating, nothing practiced. @returns {MathState} */
export function createMath() {
  return { skills: Object.fromEntries(SKILL_IDS.map((id) => [id, { r: RATING.start, n: 0, hist: [] }])), log: [] };
}

/**
 * The chance a rating solves an item of a difficulty.
 * @param {number} rating @param {number} difficulty
 */
export function expected(rating, difficulty) {
  return 1 / (1 + 10 ** ((difficulty - rating) / 400));
}

/**
 * A rating after `days` unpracticed: pulled toward a fresh start, never
 * below it, never up.
 * @param {number} rating @param {number} days
 */
export function decayed(rating, days) {
  const elapsed = days - RATING.decayGrace;
  if (rating <= RATING.start || elapsed <= 0) return rating;
  return RATING.start + (rating - RATING.start) * 2 ** (-elapsed / RATING.decayHalfLife);
}

/**
 * How much picture a rating still needs: 0 shows the model at once, 2 fades it.
 * @param {number} rating @returns {0 | 1 | 2}
 */
export function scaffoldFor(rating) {
  return rating < 520 ? 0 : rating < 760 ? 1 : 2;
}

/** The share of ones in a history. @param {number[]} hist */
function accuracy(hist) {
  return hist.length ? hist.reduce((a, b) => a + b, 0) / hist.length : 0;
}

/**
 * Whether a skill is mastered at a rating (its stored one by default).
 * @param {SkillState} s @param {number} [rating]
 */
export function isMastered(s, rating = s.r) {
  return rating >= RATING.mastery && s.n >= RATING.minN && s.hist.length >= RATING.minN && accuracy(s.hist) >= RATING.accuracy;
}

/**
 * When a skill was last practiced (0: never), from the log.
 * @param {MathState} math @param {string} id
 */
export function lastPracticed(math, id) {
  for (let i = math.log.length - 1; i >= 0; i--) if (math.log[i].skill === id) return math.log[i].t;
  return 0;
}

/**
 * Days since a skill was practiced; 0 with no clock or no practice.
 * @param {MathState} math @param {string} id @param {number} now
 */
export function daysSince(math, id, now) {
  const last = now ? lastPracticed(math, id) : 0;
  return last ? Math.max(0, (now - last) / DAY_MS) : 0;
}

/**
 * The rating a skill is worth now, its rust included.
 * @param {MathState} math @param {string} id @param {number} now
 */
export function effectiveRating(math, id, now) {
  return decayed(math.skills[id].r, daysSince(math, id, now));
}

/**
 * The log with room for one more entry's worth: the oldest entries go
 * first, but never a skill's newest one, so a skill's last practice can
 * never scroll out of the log (and its rust and staleness stay honest).
 * @param {LogEntry[]} log @returns {LogEntry[]}
 */
function trimLog(log) {
  let drop = log.length - RATING.logMax;
  if (drop <= 0) return log;
  /** @type {Map<string, number>} */
  const newest = new Map();
  log.forEach((entry, i) => newest.set(entry.skill, i));
  const keep = new Set(newest.values());
  return log.filter((_entry, i) => {
    if (drop > 0 && !keep.has(i)) {
      drop -= 1;
      return false;
    }
    return true;
  });
}

/**
 * Record one answer. The first answer to a problem moves the rating
 * (rust baked in first, then the Elo step); a retry after a miss is
 * logged but rated no more.
 * @param {MathState} math @param {Problem} problem
 * @param {{ correct: boolean, usedHint?: boolean, ms?: number, tag?: string, retry?: boolean }} res
 * @param {{ now?: number }} [options]
 * @returns {{ math: MathState, delta: number, rating: number, mastered: string | null }}
 */
export function recordResult(math, problem, res, options = {}) {
  const now = options.now ?? 0;
  const id = problem.skillId;
  const old = math.skills[id];
  const fraction = problem.meta.n !== undefined && problem.meta.d !== undefined;
  /** @type {LogEntry} */
  const entry = {
    t: now,
    skill: id,
    tag: res.tag ?? (res.correct ? 'correct' : 'near_miss'),
    item: fraction ? `${problem.meta.n}/${problem.meta.d}` : null,
    value: typeof problem.answer === 'number' ? problem.answer : null,
    ok: res.correct,
    ms: res.ms ?? 0,
    hint: res.usedHint === true,
    retry: res.retry === true,
  };
  const log = trimLog([...math.log, entry]);
  if (res.retry) return { math: { skills: math.skills, log }, delta: 0, rating: old.r, mastered: null };
  const rusty = { ...old, r: decayed(old.r, daysSince(math, id, now)) };
  const was = isMastered(rusty);
  const K = old.n < 20 ? 32 : 16;
  const score = res.correct ? (res.usedHint ? 0.7 : 1) : 0;
  const delta = K * (score - expected(rusty.r, problem.difficulty));
  const skill = { r: rusty.r + delta, n: old.n + 1, hist: [...old.hist, res.correct ? 1 : 0].slice(-RATING.histMax) };
  return {
    math: { skills: { ...math.skills, [id]: skill }, log },
    delta,
    rating: skill.r,
    mastered: !was && isMastered(skill) ? id : null,
  };
}

/**
 * The first skill of a world's ladder not yet mastered (the last one when all are).
 * @param {MathState} math @param {World} world @param {number} [now]
 */
export function focusSkill(math, world, now = 0) {
  const ladder = LADDER[world];
  return ladder.find((id) => !isMastered(math.skills[id], effectiveRating(math, id, now))) ?? ladder[ladder.length - 1];
}

/**
 * The kind a skill is served as: a forced kind if it supports it (its
 * natural kind if not); a warmed-up times table is a bed to grow 35% of
 * the time, a warmed-up division fact coconuts to deal.
 * @param {string} id @param {SkillState} s @param {Kind | undefined} forced @param {Rng} rng @returns {Kind}
 */
function chooseKind(id, s, forced, rng) {
  const { kinds, world } = SKILLS[id];
  if (forced) return kinds.includes(forced) ? forced : kinds[0];
  if (s.n >= RATING.coldN && kinds[0] === 'fetch') {
    if (world === 'garden' && kinds.includes('array') && rng.chance(0.35)) return 'array';
    if (world === 'stump' && kinds.includes('share') && rng.chance(0.35)) return 'share';
  }
  return kinds[0];
}

/**
 * The difficulty to aim at: 108 under the rating, lower while a skill is
 * new (but climbing fast on a run of wins), with ±40 of jitter.
 * @param {SkillState} s @param {Rng} rng @param {number} base - the effective rating
 */
export function targetDifficulty(s, rng, base) {
  let t = base - RATING.offset;
  if (s.n < RATING.coldN) {
    t -= (RATING.coldN - s.n) * 25;
    let streak = 0;
    for (let i = s.hist.length - 1; i >= 0 && s.hist[i] === 1; i--) streak++;
    t += streak * 45;
  }
  return t + (rng.float() - 0.5) * 80;
}

/**
 * How much a number-line problem repeats the last ones (0: not at all).
 * @param {import('./generators.js').Inner} inner @param {LogEntry[]} recent @param {SkillState} s
 */
function repeatScore(inner, recent, s) {
  const key = `${inner.meta.n}/${inner.meta.d}`;
  let score = 0;
  if (recent[0]?.item === key) score += 12;
  else if (recent.some((e) => e.item === key)) score += 7;
  if (recent.some((e) => Math.abs(/** @type {number} */ (e.value) - /** @type {number} */ (inner.answer)) < 1e-9)) score += 6;
  // after the very first half, the quarter landmarks come next
  if (s.n > 0 && s.n < 4 && inner.meta.d === 2) score += 3;
  return score;
}

/**
 * A number-line problem that does not land where the last two did: up
 * to twelve redraws, the least repetitive kept.
 * @param {import('./generators.js').Inner} first @param {MathState} math @param {Rng} rng
 * @param {number} target @param {Kind} kind @param {number} scaffold @param {SkillState} s
 */
function spreadFractions(first, math, rng, target, kind, scaffold, s) {
  /** @type {LogEntry[]} */
  const recent = [];
  for (let i = math.log.length - 1; i >= 0 && recent.length < 2; i--) {
    const e = math.log[i];
    if (e.skill === 'frac_magnitude' && e.item && e.value !== null) recent.push(e);
  }
  let best = first;
  let bestScore = recent.length ? repeatScore(first, recent, s) : 0;
  for (let i = 0; i < 12 && bestScore > 0; i++) {
    const candidate = GENERATORS.frac_magnitude(target, rng, kind, scaffold);
    const score = repeatScore(candidate, recent, s);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The next problem. A forced skill is served as asked; otherwise the
 * world (the one named, or a random one) serves its focus skill 70% of
 * the time, the skill below it 20%, and a mastered skill from anywhere
 * 10% — a refresher.
 * @param {MathState} math @param {ProblemOptions} options @returns {Problem}
 */
export function nextProblem(math, options) {
  const { rng } = options;
  if (!rng) throw new TypeError('nextProblem needs a random stream (options.rng): the engine has no randomness of its own');
  const now = options.now ?? 0;
  /** @type {string} */
  let id;
  if (options.skill && SKILLS[options.skill]) id = options.skill;
  else {
    const world = /** @type {World} */ (WORLDS.includes(/** @type {World} */ (options.world)) ? options.world : rng.pick(WORLDS));
    const focus = focusSkill(math, world, now);
    const roll = rng.float();
    if (roll < 0.7) id = focus;
    else if (roll < 0.9) id = LADDER[world][SKILLS[focus].order - 1] ?? focus;
    else {
      const mastered = SKILL_IDS.filter((s) => s !== focus && isMastered(math.skills[s], effectiveRating(math, s, now)));
      id = mastered.length ? rng.pick(mastered) : focus;
    }
  }
  const s = math.skills[id];
  const effR = effectiveRating(math, id, now);
  const scaffold = scaffoldFor(effR);
  const kind = chooseKind(id, s, options.kind, rng);
  const target = targetDifficulty(s, rng, effR);
  let inner = GENERATORS[id](target, rng, kind, scaffold);
  if (id === 'frac_magnitude') inner = spreadFractions(inner, math, rng, target, kind, scaffold, s);
  const tag = `${Math.floor(rng.float() * 0xffffffff).toString(36)}${Math.floor(rng.float() * 0xffffffff).toString(36)}`;
  return {
    id: `${id}-${tag}`,
    skillId: id,
    world: SKILLS[id].world,
    kind: inner.kind,
    equation: inner.equation,
    prompt: inner.prompt,
    answer: inner.answer,
    accept: inner.accept ?? null,
    choices: inner.choices,
    model: inner.model,
    scaffold,
    difficulty: inner.difficulty,
    explain: inner.explain,
    meta: inner.meta,
  };
}

/**
 * A problem a board can host: a bed too big for the soil turns sideways
 * when it may (or becomes a stone hunt), more baskets than the stump has
 * becomes a stone hunt, and a tide sum gets its strip picture.
 * @param {Problem} problem @param {MathState} math @param {ProblemOptions} options @returns {Problem}
 */
export function ensureHostable(problem, math, options) {
  let p = problem;
  const fits = (/** @type {number} */ r, /** @type {number} */ c) => r <= HOST_LIMITS.arrayRows && c <= HOST_LIMITS.arrayCols;
  if (p.kind === 'array') {
    const { rows, cols, given } = p.model.params;
    if (!fits(rows, cols)) {
      p = given !== 'rows' && fits(cols, rows)
        ? { ...p, model: { kind: 'array', params: { ...p.model.params, rows: cols, cols: rows } },
          prompt: { key: p.prompt.key, vars: { ...p.prompt.vars, rows: cols, cols: rows } } }
        : nextProblem(math, { ...options, skill: p.skillId, kind: 'fetch' });
    }
  }
  else if (p.kind === 'share' && p.model.params.baskets > HOST_LIMITS.baskets) {
    p = nextProblem(math, { ...options, skill: p.skillId, kind: 'fetch' });
  }
  if (p.world === 'tide' && p.model.kind === 'none') {
    const { a, b, c } = p.meta;
    const other = b ?? (c === undefined ? undefined : c - a);
    if (other !== undefined) p = { ...p, model: { kind: 'strip', params: { a, b: Math.abs(other), op: p.equation.includes('−') ? '−' : '+' } } };
  }
  return p;
}

/**
 * A world's share of mastery: a mastered skill counts whole, the rest by
 * how far their rating climbed toward mastery, scaled by practice.
 * @param {SkillReport[]} skills
 */
function worldPct(skills) {
  return skills.reduce((sum, sk) => sum + (sk.mastered ? 1
    : Math.min(1, Math.max(0, (sk.rating - RATING.start) / (RATING.mastery - RATING.start))) * Math.min(1, sk.n / RATING.minN)), 0) / skills.length;
}

/**
 * The mastery report: each world's skills and share of mastery, and the
 * three weakest practiced skills. With `now` the rust counts; without it
 * the stored ratings stand (the bloom the island shows never wilts).
 * @param {MathState} math @param {{ now?: number }} [options] @returns {Report}
 */
export function masteryReport(math, options = {}) {
  const now = options.now ?? 0;
  const worlds = /** @type {Report['worlds']} */ (Object.fromEntries(WORLDS.map((world) => {
    const skills = LADDER[world].map((id) => {
      const s = math.skills[id];
      const rating = effectiveRating(math, id, now);
      return { id, rating: Math.round(rating), acc10: accuracy(s.hist), n: s.n, mastered: isMastered(s, rating) };
    });
    return [world, { pct: worldPct(skills), skills }];
  })));
  const weakest = SKILL_IDS.filter((id) => math.skills[id].n > 0)
    .sort((p, q) => effectiveRating(math, p, now) - effectiveRating(math, q, now))
    .slice(0, 3);
  return { worlds, weakest };
}

/**
 * How many of a gate's bloom steps a share of mastery has passed (0–4).
 * @param {number} pct
 */
export function gateStage(pct) {
  return GATE_STEPS.filter((step) => pct >= step).length;
}

/** The explanation lines a skill states in its own words, by misconception. */
const OWN_LINES = Object.freeze(/** @type {Record<string, Record<string, string>>} */ ({
  add_20: { addsub_confuse: 'ex.took_away' },
  sub_20: { addsub_confuse: 'ex.added' },
  number_bonds: { addsub_confuse: 'ex.gap' },
  missing_addend: { addsub_confuse: 'ex.gap' },
  div_facts: { addsub_confuse: 'ex.div_fact' },
  share: { addsub_confuse: 'ex.div_fact' },
  missing_factor: { addsub_confuse: 'ex.missing_factor' },
  frac_equiv: { whole_number_bias: 'ex.equiv' },
  frac_of_n: { whole_number_bias: 'ex.pieces_of' },
}));

/**
 * The explanation a wrong answer earns: the misconception's own line, in
 * the words of the problem's own operation (a random stone reads as a
 * near miss; a division that missed "by a row" states its own fact).
 * @param {Problem} problem
 * @param {{ tag: string, array?: { tag: 'shape' | 'too_few' | 'too_many' } }} info
 * @returns {string} a line key
 */
export function explainKey(problem, info) {
  if (info.array) {
    if (info.array.tag !== 'shape') return 'ex.array_count';
    const given = problem.model.params.given;
    return given === 'both' ? 'ex.array_shape' : given === 'rows' ? 'ex.array_rows' : 'ex.array_flat';
  }
  const tag = info.tag === 'random' ? 'near_miss' : info.tag;
  const own = OWN_LINES[problem.skillId]?.[tag];
  if (own) return own;
  if (tag === 'off_by_table' && problem.explain.key !== 'ex.off_by_table') return problem.explain.key;
  const key = `ex.${tag}`;
  return hasLine(key) ? key : problem.explain.key;
}

/**
 * The answer as a child reads it: the stone's label, the fraction, the count.
 * @param {Problem} problem @returns {string}
 */
export function answerLabel(problem) {
  return problem.kind === 'numberline' ? `${problem.meta.n}/${problem.meta.d}` : String(problem.answer);
}

/**
 * The numbers a problem's lines are filled with.
 * @param {Problem} problem @returns {Record<string, any>}
 */
export function lineVars(problem) {
  /** @type {Record<string, any>} */
  const vars = { ...problem.meta, ...problem.model.params, ...problem.prompt.vars, ...problem.explain.vars };
  if (vars.n !== undefined && vars.d !== undefined) vars.frac = `${vars.n}/${vars.d}`;
  vars.answer = problem.explain.vars.answer ?? answerLabel(problem);
  return vars;
}

/**
 * The equation solved, true as written: the slot filled with the answer,
 * a bed by the rows and columns the child grew, a share with its leftovers.
 * @param {Problem} problem @param {{ r?: number, c?: number }} [built]
 * @returns {string}
 */
export function solvedEquation(problem, built = {}) {
  const { params } = problem.model;
  if (problem.kind === 'array') return `${built.r ?? params.rows} × ${built.c ?? params.cols} = ${params.total}`;
  if (problem.kind === 'share') return `${params.total} ÷ ${params.baskets} = ${params.quotient}${params.remainder ? ` (+${params.remainder})` : ''}`;
  if (problem.kind === 'numberline') return `${answerLabel(problem)} ✓`;
  return problem.equation.replace(/[?⬚]/, answerLabel(problem));
}

