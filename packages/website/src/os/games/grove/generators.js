//@ts-check
/**
 * The problem generators of Monkey Grove's 21 story-world skills, and
 * the distractor builders they share.
 *
 * A generator takes a target difficulty (an Elo number), the stream to
 * draw from, the interaction kind it should build and the scaffold
 * level, picks the parameter TIER whose fixed difficulty is closest to
 * the target, and answers the inner fields of a problem: the equation,
 * the prompt and explanation keys with their numbers, the answer, the
 * stones to choose from, and the visual MODEL a hint or a miss puts on
 * the floor. Difficulty is a property of the tier, never re-rated, so
 * the rating engine stays one-sided.
 *
 * Every wrong stone is a real mistake a child makes, tagged with the
 * misconception it shows (`reversed`, `addsub_confuse`, `no_carry`,
 * `whole_number_bias` …): the explanation a miss earns is chosen by
 * that tag. Nothing here reads a clock or any randomness but the
 * stream it is handed, so a problem is fixed by its inputs.
 */

/**
 * @typedef {import('./rng.js').Rng} Rng
 * @typedef {'fetch' | 'array' | 'numberline' | 'share'} Kind
 * @typedef {{ value: number | string, tag: string }} Choice
 * @typedef {{ key: string, vars: Record<string, any> }} Line
 * @typedef {{ kind: string, params: Record<string, any> }} Model
 * @typedef {{ kind: Kind, equation: string, prompt: Line, answer: number | string,
 *   accept?: { tol: number } | null, choices: Choice[] | null, model: Model, explain: Line,
 *   difficulty: number, meta: Record<string, any> }} Inner
 * @typedef {(target: number, rng: Rng, kind: Kind, scaffold: number) => Inner} Generator
 * @typedef {{ d: number }} Tier
 */

/** The model of a problem whose picture is drawn later (tide sums get a strip). */
const NONE = Object.freeze({ kind: 'none', params: Object.freeze({}) });

/** The greatest common divisor. @param {number} a @param {number} b @returns {number} */
export function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

/**
 * The numerators that make a reduced fraction with `d`.
 * @param {number} d @returns {number[]}
 */
export function coprimes(d) {
  /** @type {number[]} */
  const out = [];
  for (let n = 1; n < d; n++) if (gcd(n, d) === 1) out.push(n);
  return out;
}

/**
 * The digit-swap a child makes reading a number (62 for 26), or null
 * when there is none (one digit, or a palindrome).
 * @param {number} n @returns {number | null}
 */
export function reverseDigits(n) {
  if (n < 10) return null;
  const turned = Number([...String(n)].reverse().join(''));
  return turned === n ? null : turned;
}

/**
 * A mixed number reduced to its simplest label: `3 2/5`, or the whole
 * number when the fraction part vanishes. The whole part is at least
 * one wherever the game builds one.
 * @param {number} whole @param {number} numerator @param {number} denominator
 * @returns {number | string}
 */
export function mixedNumberLabel(whole, numerator, denominator) {
  const w = whole + Math.floor(numerator / denominator);
  const rest = numerator % denominator;
  if (!rest) return w;
  const g = gcd(rest, denominator);
  return `${w} ${rest / g}/${denominator / g}`;
}

/**
 * `total ÷ divisor` as the label a stone carries: `19 ÷ 5` is `3 4/5`.
 * @param {number} total @param {number} divisor @returns {number | string}
 */
export function divisionAnswerLabel(total, divisor) {
  return mixedNumberLabel(Math.floor(total / divisor), total % divisor, divisor);
}

/**
 * The tier whose difficulty is closest to the target (the first wins a tie).
 * @template {Tier} T
 * @param {readonly T[]} tiers @param {number} target @returns {T}
 */
export function pickTier(tiers, target) {
  let best = tiers[0];
  for (const tier of tiers) if (Math.abs(tier.d - target) < Math.abs(best.d - target)) best = tier;
  return best;
}

/**
 * Six whole-number stones: the answer, then the misconception values in
 * priority order (rounded, kept plausible and distinct), then near misses
 * one to three away, then random padding further out, shuffled.
 * @param {Rng} rng @param {number} answer
 * @param {Array<{ value: number | null, tag: string }>} candidates
 * @param {{ min?: number, count?: number }} [options] - `min`: the smallest stone (0 is allowed when the answer is 0)
 * @returns {Choice[]}
 */
export function buildChoices(rng, answer, candidates, options = {}) {
  const count = options.count ?? 6;
  const lo = answer === 0 ? 0 : (options.min ?? 1);
  /** @type {Choice[]} */
  const out = [{ value: answer, tag: 'correct' }];
  const used = new Set([answer]);
  const push = (/** @type {number | null} */ value, /** @type {string} */ tag) => {
    if (out.length >= count || value === null) return;
    const v = Math.round(value);
    if (v < lo || used.has(v)) return;
    used.add(v);
    out.push({ value: v, tag });
  };
  for (const c of candidates) push(c.value, c.tag);
  for (const off of [1, -1, 2, -2, 3, -3]) push(answer + off, 'near_miss');
  for (let off = 4; out.length < count; off++) {
    push(answer + (rng.chance(0.5) ? off : -off), 'random');
    push(answer + off, 'random');
  }
  return rng.shuffle(out);
}

/** The value of a fraction label `n/d`. @param {string} label */
const fractionValue = (label) => {
  const [n, d] = label.split('/').map(Number);
  return n / d;
};

/**
 * Four fraction stones whose VALUES all differ: the answer, the
 * candidates in priority order, then the fills.
 * @param {Rng} rng @param {string} answer
 * @param {Array<{ value: string, tag: string }>} candidates @param {string[]} fills
 * @returns {Choice[]}
 */
export function buildFracChoices(rng, answer, candidates, fills) {
  /** @type {Choice[]} */
  const out = [{ value: answer, tag: 'correct' }];
  const seen = [fractionValue(answer)];
  const push = (/** @type {string} */ label, /** @type {string} */ tag) => {
    const v = fractionValue(label);
    if (out.length >= 4 || seen.some((u) => Math.abs(u - v) < 1e-9)) return;
    seen.push(v);
    out.push({ value: label, tag });
  };
  for (const c of candidates) push(c.value, c.tag);
  for (const label of fills) push(label, 'random');
  return rng.shuffle(out);
}

/**
 * Up to six stones for a division with a remainder: the quotient alone
 * (the leftovers forgotten), the neighbours of the right mixed number,
 * then the labels of nearby totals.
 * @param {Rng} rng @param {{ total: number, baskets: number, quotient: number, remainder: number }} share
 * @returns {Choice[]}
 */
export function buildMixedDivisionChoices(rng, { total, baskets, quotient, remainder }) {
  const answer = divisionAnswerLabel(total, baskets);
  /** @type {Choice[]} */
  const out = [{ value: answer, tag: 'correct' }];
  const used = new Set([String(answer)]);
  const push = (/** @type {number | string} */ value, /** @type {string} */ tag) => {
    if (out.length >= 6 || used.has(String(value))) return;
    used.add(String(value));
    out.push({ value, tag });
  };
  push(quotient, 'remainder_ignored');
  push(quotient + 1, 'near_miss');
  push(mixedNumberLabel(quotient, remainder + 1, baskets), 'near_miss');
  push(mixedNumberLabel(quotient, Math.max(1, remainder - 1), baskets), 'near_miss');
  push(mixedNumberLabel(quotient, remainder, baskets + 1), 'random');
  for (const off of [1, -1, 2, -2, 3, -3]) push(divisionAnswerLabel(total + off, baskets), 'random');
  return rng.shuffle(out);
}

// ---------- tide: number sense ----------

/** @typedef {Tier & { gen: (rng: Rng) => number[] }} PairTier */

/** @type {PairTier[]} */
const COUNTING = [
  { d: 400, gen: (rng) => [rng.int(1, 8)] },
  { d: 520, gen: (rng) => [rng.int(9, 18)] },
  { d: 640, gen: (rng) => [rng.int(20, 96)] },
];

/** @type {Generator} */
function counting(target, rng) {
  const tier = pickTier(COUNTING, target);
  const [a] = tier.gen(rng);
  const answer = a + 2;
  return {
    kind: 'fetch',
    equation: `${a}, ${a + 1}, ⬚`,
    prompt: { key: 'q.count', vars: { a } },
    answer,
    choices: buildChoices(rng, answer, [
      { value: a + 1, tag: 'near_miss' },
      { value: reverseDigits(answer), tag: 'reversed' },
    ], { min: 0 }),
    model: NONE,
    explain: { key: 'ex.near_miss', vars: { answer } },
    difficulty: tier.d,
    meta: { a },
  };
}

/** @type {PairTier[]} */
const BONDS = [
  { d: 460, gen: (rng) => [10, rng.int(1, 9)] },
  { d: 580, gen: (rng) => [20, rng.int(2, 18)] },
  { d: 700, gen: (rng) => [100, rng.int(1, 9) * 10] },
];

/** @type {Generator} */
function numberBonds(target, rng) {
  const tier = pickTier(BONDS, target);
  const [c, a] = tier.gen(rng);
  const answer = c - a;
  return {
    kind: 'fetch',
    equation: `${a} + ? = ${c}`,
    prompt: { key: 'q.missing', vars: { a, c } },
    answer,
    choices: buildChoices(rng, answer, [
      { value: c + a, tag: 'addsub_confuse' },
      { value: reverseDigits(answer), tag: 'reversed' },
    ], { min: 0 }),
    model: NONE,
    explain: { key: 'ex.gap', vars: { a, c, answer } },
    difficulty: tier.d,
    meta: { a, c },
  };
}

/** @type {PairTier[]} */
const ADD_20 = [
  { d: 420, gen: (rng) => { const a = rng.int(1, 9); return [a, rng.int(1, Math.max(1, 10 - a))]; } },
  { d: 540, gen: (rng) => { const a = rng.int(3, 9); return [a, rng.int(Math.max(2, 11 - a), Math.min(9, 18 - a))]; } },
  { d: 650, gen: (rng) => { const a = rng.int(11, 17); return [a, rng.int(2, Math.min(9, 20 - a))]; } },
];

/** @type {Generator} */
function add20(target, rng) {
  const tier = pickTier(ADD_20, target);
  const [a, b] = tier.gen(rng);
  const answer = a + b;
  return {
    kind: 'fetch',
    equation: `${a} + ${b} = ?`,
    prompt: { key: 'q.fetch', vars: { a, b } },
    answer,
    choices: buildChoices(rng, answer, [
      { value: Math.abs(a - b), tag: 'addsub_confuse' },
      { value: reverseDigits(answer), tag: 'reversed' },
    ], { min: 0 }),
    model: NONE,
    explain: { key: 'ex.near_miss', vars: { a, b, answer } },
    difficulty: tier.d,
    meta: { a, b },
  };
}

/** @type {PairTier[]} */
const SUB_20 = [
  { d: 460, gen: (rng) => { const a = rng.int(3, 10); return [a, rng.int(1, a - 1)]; } },
  { d: 580, gen: (rng) => { const a = rng.int(12, 19); return [a, rng.int(1, a % 10)]; } },
  { d: 690, gen: (rng) => { const a = rng.int(11, 18); return [a, rng.int((a % 10) + 1, 9)]; } },
];

/** @type {Generator} */
function sub20(target, rng) {
  const tier = pickTier(SUB_20, target);
  const [a, b] = tier.gen(rng);
  const answer = a - b;
  return {
    kind: 'fetch',
    equation: `${a} − ${b} = ?`,
    prompt: { key: 'q.fetch', vars: { a, b } },
    answer,
    choices: buildChoices(rng, answer, [
      { value: a + b, tag: 'addsub_confuse' },
      { value: reverseDigits(answer), tag: 'reversed' },
    ], { min: 0 }),
    model: NONE,
    explain: { key: 'ex.near_miss', vars: { a, b, answer } },
    difficulty: tier.d,
    meta: { a, b },
  };
}

/** @type {PairTier[]} */
const MISSING_ADDEND = [
  { d: 500, gen: (rng) => { const c = rng.int(5, 10); return [rng.int(1, c - 1), c]; } },
  { d: 620, gen: (rng) => { const c = rng.int(11, 20); return [rng.int(2, c - 2), c]; } },
  { d: 780, gen: (rng) => { const c = rng.int(6, 18) * 5; return [rng.int(1, c / 5 - 1) * 5, c]; } },
];

/** @type {Generator} */
function missingAddend(target, rng) {
  const tier = pickTier(MISSING_ADDEND, target);
  const [a, c] = tier.gen(rng);
  const answer = c - a;
  return {
    kind: 'fetch',
    equation: `${a} + ? = ${c}`,
    prompt: { key: 'q.missing', vars: { a, c } },
    answer,
    choices: buildChoices(rng, answer, [
      { value: a + c, tag: 'addsub_confuse' },
      { value: reverseDigits(answer), tag: 'reversed' },
    ]),
    model: NONE,
    explain: { key: 'ex.gap', vars: { a, c, answer } },
    difficulty: tier.d,
    meta: { a, c },
  };
}

/** @typedef {PairTier & { flag: boolean }} FlagTier - `flag`: the tier carries (adding) or borrows (taking away) */

/** @type {FlagTier[]} */
const ADD_100 = [
  { d: 560, flag: false, gen: (rng) => {
    const tA = rng.int(1, 7);
    const tB = rng.int(1, 8 - tA);
    const oA = rng.int(1, 8);
    const oB = rng.int(0, 9 - oA);
    return [tA * 10 + oA, tB * 10 + oB];
  } },
  { d: 760, flag: true, gen: (rng) => {
    const tA = rng.int(1, 6);
    const tB = rng.int(1, 7 - tA);
    const oA = rng.int(2, 9);
    const oB = rng.int(Math.max(2, 11 - oA), 9);
    return [tA * 10 + oA, tB * 10 + oB];
  } },
  { d: 900, flag: true, gen: (rng) => {
    const tA = rng.int(3, 5);
    const tB = rng.int(3, Math.min(5, 8 - tA));
    const oA = rng.int(5, 9);
    const oB = rng.int(Math.max(5, 11 - oA), 9);
    return [tA * 10 + oA, tB * 10 + oB];
  } },
];

/** @type {Generator} */
function add100(target, rng) {
  const tier = pickTier(ADD_100, target);
  const [a, b] = tier.gen(rng);
  const answer = a + b;
  // the ten carried out of the ones is forgotten: 47 + 38 → 75
  const noCarry = (((a % 10) + (b % 10)) % 10) + 10 * (Math.floor(a / 10) + Math.floor(b / 10));
  return {
    kind: 'fetch',
    equation: `${a} + ${b} = ?`,
    prompt: { key: 'q.fetch', vars: { a, b } },
    answer,
    choices: buildChoices(rng, answer, [
      { value: noCarry, tag: 'no_carry' },
      { value: reverseDigits(answer), tag: 'reversed' },
    ]),
    model: NONE,
    explain: { key: tier.flag ? 'ex.no_carry' : 'ex.near_miss', vars: { a, b, answer } },
    difficulty: tier.d,
    meta: { a, b, carry: tier.flag },
  };
}

/** @type {FlagTier[]} */
const SUB_100 = [
  { d: 620, flag: false, gen: (rng) => {
    const tA = rng.int(2, 9);
    const oA = rng.int(1, 9);
    return [tA * 10 + oA, rng.int(1, tA - 1) * 10 + rng.int(0, oA)];
  } },
  { d: 840, flag: true, gen: (rng) => {
    const tA = rng.int(2, 9);
    const oA = rng.int(0, 8);
    return [tA * 10 + oA, rng.int(1, tA - 1) * 10 + rng.int(oA + 1, 9)];
  } },
  { d: 980, flag: true, gen: (rng) => {
    const tA = rng.int(6, 9);
    const oA = rng.int(0, 7);
    return [tA * 10 + oA, rng.int(2, tA - 1) * 10 + rng.int(oA + 1, 9)];
  } },
];

/** @type {Generator} */
function sub100(target, rng) {
  const tier = pickTier(SUB_100, target);
  const [a, b] = tier.gen(rng);
  const answer = a - b;
  // each column subtracted the easy way round: 52 − 27 → 35
  const wrongWay = (Math.floor(a / 10) - Math.floor(b / 10)) * 10 + Math.abs((a % 10) - (b % 10));
  return {
    kind: 'fetch',
    equation: `${a} − ${b} = ?`,
    prompt: { key: 'q.fetch', vars: { a, b } },
    answer,
    choices: buildChoices(rng, answer, [
      { value: wrongWay, tag: 'borrow' },
      { value: reverseDigits(answer), tag: 'reversed' },
    ], { min: 0 }),
    model: NONE,
    explain: { key: tier.flag ? 'ex.borrow' : 'ex.near_miss', vars: { a, b, answer } },
    difficulty: tier.d,
    meta: { a, b, borrow: tier.flag },
  };
}

/** @type {PairTier[]} */
const BIG_NUMBERS = [
  { d: 820, gen: (rng) => [rng.int(2, 8) * 100 + rng.int(0, 9) * 10, rng.int(1, 8) * 100 + rng.int(0, 9) * 10] },
  { d: 960, gen: (rng) => [rng.int(11, 89) * 100, rng.int(11, 89) * 100] },
  { d: 1100, gen: (rng) => [rng.int(12, 90) * 1000, rng.int(1, 9) * 1100 + rng.int(0, 9) * 100] },
];

/** @type {Generator} */
function bigNumbers(target, rng) {
  const tier = pickTier(BIG_NUMBERS, target);
  const [a, b] = tier.gen(rng);
  const answer = a + b;
  return {
    kind: 'fetch',
    equation: `${a} + ${b} = ?`,
    prompt: { key: 'q.fetch', vars: { a, b } },
    answer,
    choices: buildChoices(rng, answer, [{ value: reverseDigits(answer), tag: 'reversed' }], { min: 0 }),
    model: NONE,
    explain: { key: 'ex.near_miss', vars: { a, b, answer } },
    difficulty: tier.d,
    meta: { a, b },
  };
}

// ---------- garden: multiplication ----------

/**
 * A times-table problem: the constructed bed (`array`), or a stone hunt
 * that carries the bed as its model.
 * @param {Rng} rng @param {Kind} kind @param {number} scaffold @param {number} a @param {number} b @param {number} d
 * @returns {Inner}
 */
function tableProblem(rng, kind, scaffold, a, b, d) {
  const total = a * b;
  if (kind === 'array') {
    // full support always names both sides; later, half the beds hide one or both
    const given = scaffold === 0 || rng.chance(0.5) ? 'both' : rng.chance(0.6) ? 'rows' : 'total';
    const equation = given === 'both' ? `${a} × ${b} = ?` : given === 'rows' ? `${a} × ? = ${total}` : `? × ? = ${total}`;
    return {
      kind: 'array',
      equation,
      prompt: { key: `q.array_${given}`, vars: { rows: a, cols: b, total } },
      answer: total,
      choices: null,
      model: { kind: 'array', params: { rows: a, cols: b, total, given } },
      explain: { key: 'ex.off_by_table', vars: { a, b, answer: total } },
      difficulty: d + (given === 'both' ? 0 : 30),
      meta: { a, b },
    };
  }
  return {
    kind: 'fetch',
    equation: `${a} × ${b} = ?`,
    prompt: { key: 'q.fetch', vars: { a, b } },
    answer: total,
    choices: buildChoices(rng, total, [
      { value: (a + (rng.chance(0.5) ? 1 : -1)) * b, tag: 'off_by_table' },
      { value: a * (b + (rng.chance(0.5) ? 1 : -1)), tag: 'off_by_table' },
      { value: a + b, tag: 'addsub_confuse' },
      { value: reverseDigits(total), tag: 'reversed' },
    ]),
    model: { kind: 'array', params: { rows: a, cols: b, total, given: 'both' } },
    explain: { key: 'ex.off_by_table', vars: { a, b, answer: total } },
    difficulty: d,
    meta: { a, b },
  };
}

/**
 * A times-table skill over its tiers.
 * @param {PairTier[]} tiers @returns {Generator}
 */
function tableSkill(tiers) {
  return (target, rng, kind, scaffold) => {
    const tier = pickTier(tiers, target);
    const [a, b] = tier.gen(rng);
    return tableProblem(rng, kind, scaffold, a, b, tier.d);
  };
}

const TABLES_A = tableSkill([
  { d: 420, gen: (rng) => [rng.pick([2, 5, 10]), rng.int(1, 5)] },
  { d: 520, gen: (rng) => [rng.pick([2, 5, 10]), rng.int(2, 10)] },
  { d: 640, gen: (rng) => [rng.pick([2, 5, 10]), rng.int(6, 10)] },
]);
const TABLES_B = tableSkill([
  { d: 560, gen: (rng) => [rng.pick([3, 4, 6]), rng.int(2, 5)] },
  { d: 660, gen: (rng) => [rng.pick([3, 4, 6]), rng.int(2, 10)] },
]);
const TABLES_C = tableSkill([
  { d: 680, gen: (rng) => [rng.pick([7, 8, 9]), rng.int(2, 5)] },
  { d: 780, gen: (rng) => [rng.pick([7, 8, 9]), rng.int(2, 10)] },
  { d: 860, gen: (rng) => [rng.pick([7, 8, 9]), rng.int(6, 9)] },
]);
const TABLES_MIX = tableSkill([
  { d: 600, gen: (rng) => [rng.int(2, 6), rng.int(2, 6)] },
  { d: 700, gen: (rng) => [rng.int(2, 10), rng.int(2, 10)] },
  { d: 800, gen: (rng) => [rng.int(6, 9), rng.int(6, 9)] },
]);

/** @type {PairTier[]} */
const MULT_2DIGIT = [
  { d: 780, gen: (rng) => [rng.int(2, 4), rng.int(12, 29)] },
  { d: 940, gen: (rng) => [rng.int(3, 7), rng.int(13, 49)] },
  { d: 1100, gen: (rng) => [rng.int(4, 9), rng.int(25, 99)] },
];

/** @type {Generator} */
function mult2digit(target, rng) {
  const tier = pickTier(MULT_2DIGIT, target);
  const [a, b] = tier.gen(rng);
  const answer = a * b;
  // the carry out of the ones product is dropped: 7 × 26 → 142
  const noCarry = a * Math.floor(b / 10) * 10 + ((a * (b % 10)) % 10);
  return {
    kind: 'fetch',
    equation: `${a} × ${b} = ?`,
    prompt: { key: 'q.fetch', vars: { a, b } },
    answer,
    choices: buildChoices(rng, answer, [
      { value: noCarry, tag: 'no_carry' },
      { value: (a + (rng.chance(0.5) ? 1 : -1)) * b, tag: 'off_by_table' },
      { value: reverseDigits(answer), tag: 'reversed' },
    ]),
    model: { kind: 'array', params: { rows: a, cols: b, total: answer, given: 'both' } },
    explain: { key: 'ex.no_carry', vars: { a, b, answer } },
    difficulty: tier.d,
    meta: { a, b },
  };
}

// ---------- stump: division ----------

/**
 * A division problem: the coconuts dealt into baskets (`share`), or a
 * stone hunt for the per-basket count (a mixed number when some are left).
 * @param {Rng} rng @param {Kind} kind
 * @param {{ total: number, baskets: number, quotient: number, remainder: number, d: number, meta: Record<string, any>, explain: Line }} spec
 * @returns {Inner}
 */
function shareProblem(rng, kind, { total, baskets, quotient, remainder, d, meta, explain }) {
  const model = { kind: 'baskets', params: { total, baskets, quotient, remainder } };
  if (kind === 'share') {
    return {
      kind: 'share',
      equation: `${total} ÷ ${baskets}`,
      prompt: { key: remainder > 0 ? 'q.share_remainder' : 'q.share', vars: { total, baskets, remainder } },
      answer: quotient,
      choices: null,
      model,
      explain,
      difficulty: d,
      meta,
    };
  }
  if (remainder > 0) {
    const label = divisionAnswerLabel(total, baskets);
    return {
      kind: 'fetch',
      equation: `${total} ÷ ${baskets} = ?`,
      prompt: { key: 'q.share_fetch', vars: { total, baskets } },
      answer: label,
      choices: buildMixedDivisionChoices(rng, { total, baskets, quotient, remainder }),
      model,
      explain: { key: explain.key, vars: { ...explain.vars, answer: label } },
      difficulty: d,
      meta: { ...meta, answerLabel: label },
    };
  }
  return {
    kind: 'fetch',
    equation: `${total} ÷ ${baskets} = ?`,
    prompt: { key: 'q.fetch', vars: { total, baskets } },
    answer: quotient,
    choices: buildChoices(rng, quotient, [
      { value: quotient + (rng.chance(0.5) ? 1 : -1), tag: 'off_by_table' },
      { value: total - baskets, tag: 'addsub_confuse' },
    ]),
    model,
    explain,
    difficulty: d,
    meta,
  };
}

/** @type {PairTier[]} */
const DIV_FACTS = [
  { d: 480, gen: (rng) => [rng.pick([2, 5, 10]), rng.int(2, 5)] },
  { d: 600, gen: (rng) => [rng.pick([2, 3, 4, 5, 6, 10]), rng.int(2, 10)] },
  { d: 720, gen: (rng) => [rng.pick([6, 7, 8, 9]), rng.int(3, 10)] },
];

/** @type {Generator} */
function divFacts(target, rng, kind) {
  const tier = pickTier(DIV_FACTS, target);
  const [a, b] = tier.gen(rng); // c ÷ a = b, from the fact a × b
  const c = a * b;
  return shareProblem(rng, kind, {
    total: c, baskets: a, quotient: b, remainder: 0, d: tier.d,
    meta: { a, b, c },
    explain: { key: 'ex.div_fact', vars: { a, b, c, answer: b } },
  });
}

/** @type {PairTier[]} */
const SHARE = [
  { d: 560, gen: (rng) => [rng.int(2, 4), rng.int(2, 5)] },
  { d: 700, gen: (rng) => [rng.int(3, 8), rng.int(3, 9)] },
  { d: 860, gen: (rng) => [rng.int(4, 9), rng.int(6, 12)] },
];

/** @type {Generator} */
function fairShare(target, rng, kind) {
  const tier = pickTier(SHARE, target);
  const [baskets, quotient] = tier.gen(rng);
  const total = baskets * quotient;
  return shareProblem(rng, kind, {
    total, baskets, quotient, remainder: 0, d: tier.d,
    meta: { baskets, quotient, total, remainder: 0 },
    explain: { key: 'ex.div_fact', vars: { a: baskets, b: quotient, c: total, answer: quotient } },
  });
}

/** @type {PairTier[]} */
const DIV_REMAINDER = [
  { d: 680, gen: (rng) => [rng.int(2, 5), rng.int(2, 5)] },
  { d: 820, gen: (rng) => [rng.int(3, 8), rng.int(3, 9)] },
  { d: 960, gen: (rng) => [rng.int(6, 9), rng.int(6, 12)] },
];

/** @type {Generator} */
function divRemainder(target, rng, kind) {
  const tier = pickTier(DIV_REMAINDER, target);
  const [baskets, quotient] = tier.gen(rng);
  const remainder = rng.int(1, baskets - 1);
  const total = baskets * quotient + remainder;
  return shareProblem(rng, kind, {
    total, baskets, quotient, remainder, d: tier.d,
    meta: { baskets, quotient, total, remainder },
    explain: { key: 'ex.remainder_ignored', vars: { total, baskets, quotient, remainder, answer: quotient } },
  });
}

/** @type {PairTier[]} */
const MISSING_FACTOR = [
  { d: 640, gen: (rng) => [rng.int(2, 5), rng.int(2, 5)] },
  { d: 780, gen: (rng) => [rng.int(3, 9), rng.int(3, 9)] },
  { d: 900, gen: (rng) => [rng.int(6, 12), rng.int(6, 9)] },
];

/** @type {Generator} */
function missingFactor(target, rng, kind) {
  const tier = pickTier(MISSING_FACTOR, target);
  const [a, b] = tier.gen(rng); // ? × b = c, the answer a
  const c = a * b;
  const explain = { key: 'ex.missing_factor', vars: { a, b, c, answer: a } };
  if (kind === 'share') {
    return shareProblem(rng, 'share', { total: c, baskets: b, quotient: a, remainder: 0, d: tier.d, meta: { a, b, c }, explain });
  }
  return {
    kind: 'fetch',
    equation: `? × ${b} = ${c}`,
    prompt: { key: 'q.missing', vars: { b, c } },
    answer: a,
    choices: buildChoices(rng, a, [
      { value: a + (rng.chance(0.5) ? 1 : -1), tag: 'off_by_table' },
      { value: c - b, tag: 'addsub_confuse' },
      { value: reverseDigits(a), tag: 'reversed' },
    ]),
    model: { kind: 'array', params: { rows: a, cols: b, total: c, given: 'total' } },
    explain,
    difficulty: tier.d,
    meta: { a, b, c },
  };
}

// ---------- vines: fractions ----------

/** @typedef {Tier & { denoms: number[] }} FracTier */

/** @type {Array<FracTier & { hi: number }>} */
const MAGNITUDE = [
  { d: 520, denoms: [2, 4], hi: 1 },
  { d: 700, denoms: [3, 6, 8], hi: 1 },
  { d: 880, denoms: [5, 10, 12], hi: 1 },
  { d: 1040, denoms: [3, 4, 5, 6, 8], hi: 2 },
];

/** Number-line tolerance by scaffold: generous while the vine is labelled. */
export const LINE_TOLERANCE = Object.freeze([0.05, 0.03, 0.02]);

/** @type {Generator} */
function fracMagnitude(target, rng, _kind, scaffold) {
  const tier = pickTier(MAGNITUDE, target);
  const d = rng.pick(tier.denoms);
  const hi = tier.hi;
  let n = hi === 1 ? rng.int(1, d - 1) : rng.int(1, 2 * d - 1);
  if (n % d === 0) n += 1; // never a whole number
  return {
    kind: 'numberline',
    equation: `${n}/${d}`,
    prompt: { key: 'q.numberline', vars: { n, d } },
    answer: n / d,
    accept: { tol: LINE_TOLERANCE[scaffold] },
    choices: null,
    model: { kind: 'numberline', params: { n, d, lo: 0, hi, ticks: d * hi } },
    explain: { key: 'ex.magnitude', vars: { n, d } },
    difficulty: tier.d,
    meta: { n, d, lo: 0, hi },
  };
}

/** @type {FracTier[]} */
const COMPARE = [
  { d: 620, denoms: [2, 3, 4] },
  { d: 760, denoms: [2, 3, 4, 6, 8] },
  { d: 920, denoms: [3, 5, 8, 10, 12] },
];

/** Fractions to complete a pool the random draws could not fill. */
const COMPARE_FALLBACK = Object.freeze([[1, 2], [1, 3], [2, 3], [1, 4], [3, 4], [1, 5], [4, 5], [5, 6]]);

/** @type {Generator} */
function fracCompare(target, rng) {
  const tier = pickTier(COMPARE, target);
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Array<{ n: number, d: number, v: number }>} */
  const pool = [];
  const tryAdd = (/** @type {number} */ n, /** @type {number} */ d) => {
    const g = gcd(n, d);
    const key = `${n / g}/${d / g}`;
    if (seen.has(key)) return;
    seen.add(key);
    pool.push({ n, d, v: n / d });
  };
  for (let guard = 0; pool.length < 4 && guard < 200; guard++) {
    const d = rng.pick(tier.denoms);
    tryAdd(rng.int(1, d - 1), d);
  }
  for (const [n, d] of COMPARE_FALLBACK) if (pool.length < 4) tryAdd(n, d);
  pool.sort((x, y) => y.v - x.v);
  const [correct, ...rest] = pool;
  // big numerals, small value: the classic whole-number trap
  const bias = rest.reduce((m, f) => (f.n + f.d > m.n + m.d ? f : m), rest[0]);
  const others = rest.filter((f) => f !== bias);
  const near = others.reduce((m, f) => (correct.v - f.v < correct.v - m.v ? f : m), others[0]);
  const label = (/** @type {{ n: number, d: number }} */ f) => `${f.n}/${f.d}`;
  const choices = rng.shuffle([
    { value: label(correct), tag: 'correct' },
    ...rest.map((f) => ({ value: label(f), tag: f === bias ? 'whole_number_bias' : f === near ? 'near_miss' : 'random' })),
  ]);
  return {
    kind: 'fetch',
    equation: `${choices.map((c) => c.value).join(' · ')} → ?`,
    prompt: { key: 'q.compare', vars: { count: 4 } },
    answer: label(correct),
    choices,
    model: { kind: 'numberline', params: { n: correct.n, d: correct.d, lo: 0, hi: 1, ticks: correct.d + 1 } },
    explain: { key: 'ex.whole_number_bias', vars: { n: bias.n, d: bias.d, answer: label(correct) } },
    difficulty: tier.d,
    meta: { fractions: pool.map(label) },
  };
}

/** @type {Array<FracTier & { kMax: number }>} */
const EQUIV = [
  { d: 660, denoms: [2, 3, 4], kMax: 3 },
  { d: 800, denoms: [2, 3, 4, 5, 6], kMax: 4 },
  { d: 940, denoms: [3, 4, 5, 6, 8], kMax: 6 },
];

/** @type {Generator} */
function fracEquiv(target, rng) {
  const tier = pickTier(EQUIV, target);
  const d = rng.pick(tier.denoms);
  const n = rng.pick(coprimes(d));
  const k = rng.int(2, tier.kMax);
  const answer = `${n * k}/${d * k}`;
  const choices = buildFracChoices(rng, answer, [
    { value: `${n + k}/${d + k}`, tag: 'add_tops_bottoms' },
    { value: `${n * k + 1}/${d * k}`, tag: 'near_miss' },
    { value: `${(n + 1) * k}/${(d + 1) * k}`, tag: 'whole_number_bias' },
    { value: `${n * k}/${d * (k + 1)}`, tag: 'near_miss' },
  ], [0, 1, 2, 3, 4, 5].map((j) => `${n * k + 2 + j}/${d * k}`));
  return {
    kind: 'fetch',
    equation: `${n}/${d} = ?`,
    prompt: { key: 'q.equiv', vars: { n, d } },
    answer,
    choices,
    model: { kind: 'numberline', params: { n, d, lo: 0, hi: 1, ticks: d * k + 1 } },
    explain: { key: 'ex.equiv', vars: { n, d, answer } },
    difficulty: tier.d,
    meta: { n, d, k },
  };
}

/** @type {Array<FracTier & { mMin: number, mMax: number }>} */
const FRAC_OF = [
  { d: 720, denoms: [2, 4], mMin: 2, mMax: 6 },
  { d: 880, denoms: [3, 4, 6, 8], mMin: 3, mMax: 8 },
  { d: 1040, denoms: [5, 8, 10, 12], mMin: 4, mMax: 10 },
];

/** @type {Generator} */
function fracOfN(target, rng) {
  const tier = pickTier(FRAC_OF, target);
  const d = rng.pick(tier.denoms);
  const n = rng.pick(coprimes(d));
  const whole = d * rng.int(tier.mMin, tier.mMax);
  const unit = whole / d;
  const answer = unit * n;
  return {
    kind: 'fetch',
    equation: `${n}/${d} × ${whole} = ?`,
    prompt: { key: 'q.frac_of', vars: { n, d, whole } },
    answer,
    choices: buildChoices(rng, answer, [
      // one piece, the numerator forgotten — or, for a unit fraction, the fraction ignored outright
      { value: n === 1 ? whole : unit, tag: 'whole_number_bias' },
      { value: answer + unit, tag: 'near_miss' },
      { value: answer - unit, tag: 'near_miss' },
      { value: whole - n, tag: 'random' },
    ]),
    model: { kind: 'baskets', params: { total: whole, baskets: d, quotient: unit, remainder: 0 } },
    explain: { key: 'ex.pieces_of', vars: { n, d, whole, unit, answer } },
    difficulty: tier.d,
    meta: { n, d, whole },
  };
}

/** Every skill's generator, by skill id. */
export const GENERATORS = Object.freeze(/** @type {Record<string, Generator>} */ ({
  counting,
  number_bonds: numberBonds,
  add_20: add20,
  sub_20: sub20,
  missing_addend: missingAddend,
  add_100: add100,
  sub_100: sub100,
  big_numbers: bigNumbers,
  tables_a: TABLES_A,
  tables_b: TABLES_B,
  tables_c: TABLES_C,
  tables_mix: TABLES_MIX,
  mult_2digit: mult2digit,
  div_facts: divFacts,
  share: fairShare,
  div_remainder: divRemainder,
  missing_factor: missingFactor,
  frac_magnitude: fracMagnitude,
  frac_compare: fracCompare,
  frac_equiv: fracEquiv,
  frac_of_n: fracOfN,
}));
