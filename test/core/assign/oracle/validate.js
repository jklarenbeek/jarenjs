//@ts-check
/**
 * @file The corpus validator: what a `solve` answer must be, read over
 * raw problem JSON by the oracle's own files and nothing else (no engine
 * module, no view, no rule plugin; a test holds that to the source text).
 *
 * - `oracleOf(kind, zones)` scores a list the oracle's way for a rule set
 *   kind: `reference` (the eight reference rules), `rolling` (those plus
 *   rolling-cap) or `days` (the four day rules, over the raw transition
 *   table `zones`).
 * - `prove(problem, answerOf)` is the complete search over every list the
 *   problem allows (the problem's own assignments kept), with the proof
 *   semantics `oracleSolve` states, for any of those kinds.
 * - `validateAnswer(problem, strategy, answer, answerOf, options)` lists
 *   every way an answer disagrees with the problem: a list the problem
 *   does not allow, a lock or held assignment broken, `added`, `removed`
 *   or `churn` that are not the raw differences, a score or verdict that
 *   is not the oracle's for `best`, or a status the answer cannot claim.
 *   An empty list means the validator agrees.
 */

import { oracleScore, LEVEL as REFERENCE_LEVEL } from './score.js';
import { oracleDays, LEVEL as DAY_LEVEL } from './days.js';
import { oracleRolling } from './rolling.js';
import { enumerate } from './instances.js';

const LEVELS = ['hard', 'service', 'soft'];
const STATUSES = ['optimal', 'infeasible', 'feasible', 'limit', 'unknown'];

/** @param {string} a @param {string} b */
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** @typedef {{ task: string, slot: string, resource: string, lock?: 'hard' | 'soft' }} Item */
/** @typedef {{ score: { hard: string, service: string, soft: string }, verdict: string, first: number }} Answer */

/** @param {Item} item */
const keyOf = (item) => JSON.stringify([item.task, item.slot, item.resource]);

/**
 * @param {'reference' | 'rolling' | 'days'} kind
 * @param {any} [zones] - transitions.json's `zones`, for `days`
 * @returns {(problem: any, list: Item[]) => Answer}
 */
export function oracleOf(kind, zones) {
  return (problem, list) => {
    const plain = list.map((item) => ({ task: item.task, slot: item.slot, resource: item.resource }));
    const answer = kind === 'days' ? oracleDays(zones, problem, plain) : oracleScore(problem, plain);
    const level = kind === 'days' ? DAY_LEVEL : REFERENCE_LEVEL;
    let first = 3;
    for (const line of answer.unknowns) first = Math.min(first, LEVELS.indexOf(level[line.split('|')[0]]));
    const score = { ...answer.score };
    let verdict = answer.verdict;
    if (kind === 'rolling') score.service = String(BigInt(score.service) + oracleRolling(problem, plain).service);
    if (BigInt(score.hard) < 0n) verdict = 'infeasible-by-validation';
    return { score, verdict, first };
  };
}

/**
 * @param {(bigint | null)[]} a @param {(bigint | null)[]} b
 * @returns {number} 1 when a is better
 */
function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === null) return -1;
    if (b[i] === null) return 1;
    return /** @type {bigint} */ (a[i]) > /** @type {bigint} */ (b[i]) ? 1 : -1;
  }
  return 0;
}

/**
 * @typedef {Object} Proof
 * @property {'optimal' | 'infeasible' | 'feasible' | 'unknown'} status
 * @property {{ hard: string, service: string, soft: string }} score - the best list's score
 * @property {{ hard: string, service: string, soft: string }} bound - the best score any list answered
 * @property {number} lists
 * @property {number} undecided
 */

/**
 * @param {any} problem @param {(problem: any, list: Item[]) => Answer} answerOf
 * @returns {Proof}
 */
export function prove(problem, answerOf) {
  const scored = [];
  for (const list of enumerate(problem)) {
    const answer = answerOf(problem, list);
    const upper = LEVELS.map((level) => BigInt(/** @type {any} */ (answer.score)[level]));
    scored.push({ answer, upper, lower: upper.map((value, i) => (i >= answer.first ? null : value)) });
  }
  const text = (/** @type {(bigint | null)[]} */ levels) => ({ hard: String(levels[0]), service: String(levels[1]), soft: String(levels[2]) });
  const best = (/** @type {typeof scored} */ list) => list.reduce((a, b) => (compare(b.upper, a.upper) > 0 ? b : a));
  const feasible = scored.filter((item) => item.answer.verdict === 'feasible');
  const unknown = scored.filter((item) => item.answer.verdict === 'unknown');
  let status = /** @type {Proof['status']} */ ('unknown');
  if (feasible.length === 0 && unknown.length === 0) status = 'infeasible';
  else if (feasible.length > 0) {
    status = 'feasible';
    for (const candidate of feasible)
      if (!scored.some((other) => other !== candidate && other.answer.verdict !== 'infeasible-by-validation' && compare(other.upper, candidate.lower) > 0))
        status = 'optimal';
  }
  const pick = feasible.length > 0 ? feasible : unknown.length > 0 ? unknown : scored;
  return { status, score: text(best(pick).upper), bound: text(best(scored).upper), lists: scored.length, undecided: unknown.length };
}

/**
 * The churn of a list against a baseline, as the engine documents it:
 * per slot, the baseline's resources the list lacks and the list's that
 * the baseline lacks, each in code-unit order, paired one to one into
 * moves; what is left over is removed or added. A move counts once in the
 * total and for its task, and once for each of its two resources.
 * @param {Item[]} baseline @param {Item[]} list
 */
export function churnOf(baseline, list) {
  /** @type {Map<string, { task: string, slot: string, was: Set<string>, now: Set<string> }>} */
  const slots = new Map();
  const slotOf = (/** @type {Item} */ item) => {
    const key = JSON.stringify([item.task, item.slot]);
    let slot = slots.get(key);
    if (slot === undefined) slots.set(key, (slot = { task: item.task, slot: item.slot, was: new Set(), now: new Set() }));
    return slot;
  };
  for (const item of baseline) slotOf(item).was.add(item.resource);
  for (const item of list) slotOf(item).now.add(item.resource);
  const added = [];
  const removed = [];
  const moved = [];
  /** @type {Map<string, number>} */
  const byResource = new Map();
  /** @type {Map<string, number>} */
  const byTask = new Map();
  let total = 0;
  const ordered = [...slots.values()].sort((a, b) => byCode(a.task, b.task) || byCode(a.slot, b.slot));
  for (const { task, slot, was, now } of ordered) {
    const lost = [...was].filter((resource) => !now.has(resource)).sort(byCode);
    const gained = [...now].filter((resource) => !was.has(resource)).sort(byCode);
    const changes = Math.max(lost.length, gained.length);
    if (changes === 0) continue;
    total += changes;
    byTask.set(task, (byTask.get(task) ?? 0) + changes);
    for (const resource of [...lost, ...gained]) byResource.set(resource, (byResource.get(resource) ?? 0) + 1);
    const pairs = Math.min(lost.length, gained.length);
    for (let i = 0; i < pairs; i++) moved.push({ from: lost[i], slot, task, to: gained[i] });
    for (const resource of lost.slice(pairs)) removed.push({ resource, slot, task });
    for (const resource of gained.slice(pairs)) added.push({ resource, slot, task });
  }
  const listed = (/** @type {Map<string, number>} */ map, /** @type {string} */ name) => [...map.keys()].sort(byCode).map((id) => ({ count: map.get(id), [name]: id }));
  return { added, byResource: listed(byResource, 'resource'), byTask: listed(byTask, 'task'), moved, removed, total };
}

/** @param {unknown} value @returns {string} JSON with every object's keys in code-unit order */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value).sort(byCode).map((key) => `${JSON.stringify(key)}:${canonical(/** @type {any} */ (value)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * @typedef {Object} ValidateOptions
 * @property {boolean} [stoppable] - a budget or a signal was given, so `limit` may be answered
 * @property {Proof | null} [proof] - the complete search's answer, when the space was enumerated
 */

/**
 * Every disagreement between a `solve` answer and the problem it answers.
 * @param {any} problem - raw problem JSON
 * @param {'exhaustive' | 'construct' | 'local' | 'auto'} strategy
 * @param {any} answer - what solve answered
 * @param {(problem: any, list: Item[]) => Answer} answerOf - from {@link oracleOf}
 * @param {ValidateOptions} [options]
 * @returns {string[]} empty when the validator agrees
 */
export function validateAnswer(problem, strategy, answer, answerOf, options = {}) {
  /** @type {string[]} */
  const wrong = [];
  if (!STATUSES.includes(answer.status)) return [`status ${String(answer.status)} is not a status`];
  if (!Array.isArray(answer.best)) return ['best is not a list'];
  /** @type {Item[]} */
  const best = answer.best;
  /** @type {Item[]} */
  const own = problem.assignments ?? [];
  const ownByKey = new Map(own.map((item) => [keyOf(item), item]));
  const bestKeys = new Set();
  /** @type {Map<string, number>} */
  const filled = new Map();
  for (const item of best) {
    const task = problem.tasks.find((/** @type {any} */ t) => t.id === item.task);
    const demand = task?.demands.find((/** @type {any} */ d) => d.slot === item.slot);
    if (demand === undefined) wrong.push(`best holds ${keyOf(item)}, a place the problem does not have`);
    if (!problem.resources.some((/** @type {any} */ r) => r.id === item.resource)) wrong.push(`best names a resource the problem does not have: ${item.resource}`);
    if (bestKeys.has(keyOf(item))) wrong.push(`best holds ${keyOf(item)} twice`);
    bestKeys.add(keyOf(item));
    const slot = JSON.stringify([item.task, item.slot]);
    filled.set(slot, (filled.get(slot) ?? 0) + 1);
    if (demand !== undefined && /** @type {number} */ (filled.get(slot)) > demand.count) wrong.push(`best fills ${slot} past its count`);
    const lock = ownByKey.get(keyOf(item))?.lock;
    if (item.lock !== lock) wrong.push(`${keyOf(item)} carries lock ${String(item.lock)}, the problem's is ${String(lock)}`);
  }
  // a list the problem does not allow has no oracle score
  if (wrong.length > 0) return wrong;
  const baseline = problem.baseline?.assignments ?? null;
  const baselineKeys = new Set((baseline ?? []).map(keyOf));
  const fills = strategy !== 'local';
  for (const item of own) {
    if (bestKeys.has(keyOf(item))) continue;
    if (fills) wrong.push(`${strategy} dropped the problem's ${keyOf(item)}`);
    else if (item.lock === 'hard') wrong.push(`local dropped the hard-locked ${keyOf(item)}`);
    else if (item.lock === 'soft' && !baselineKeys.has(keyOf(item))) wrong.push(`local changed the soft-locked ${keyOf(item)} the baseline does not hold`);
  }
  const addedKeys = best.filter((item) => !ownByKey.has(keyOf(item))).map(keyOf).sort(byCode);
  if (canonical((answer.added ?? []).map(keyOf).sort(byCode)) !== canonical(addedKeys)) wrong.push('added is not best minus the problem\'s list');
  const removedKeys = own.filter((item) => !bestKeys.has(keyOf(item))).map(keyOf).sort(byCode);
  const searches = strategy === 'local' || strategy === 'auto';
  if (searches && canonical((answer.removed ?? null)?.map(keyOf).sort(byCode) ?? null) !== canonical(removedKeys)) wrong.push('removed is not the problem\'s list minus best');
  if (!searches && 'removed' in answer) wrong.push(`${strategy} answers removed`);
  if (searches && baseline !== null) {
    if (canonical(answer.churn) !== canonical(churnOf(baseline, best))) wrong.push('churn is not the raw difference against the baseline');
  }
  else if ('churn' in answer) wrong.push('churn answered without a baseline or by a fill strategy');

  const score = answer.score;
  /** @type {Answer | null} */
  let expected = null;
  if (score?.complete === true) {
    expected = answerOf(problem, best);
    const got = { hard: String(score.score.hard), service: String(score.score.service), soft: String(score.score.soft) };
    if (canonical(got) !== canonical(expected.score)) wrong.push(`score ${canonical(got)} is not the oracle's ${canonical(expected.score)}`);
    if (score.verdict !== expected.verdict) wrong.push(`verdict ${score.verdict} is not the oracle's ${expected.verdict}`);
  }
  else if (answer.status !== 'unknown' && answer.status !== 'limit') wrong.push(`status ${answer.status} over an incomplete scoring`);

  const proved = strategy === 'exhaustive' || (strategy === 'auto' && answer.provenance?.algorithm === 'exhaustive');
  const status = answer.status;
  if ((status === 'optimal' || status === 'infeasible') && !proved) wrong.push(`${strategy} claims ${status} without a complete exhaustive search`);
  if (status === 'limit' && !options.stoppable) wrong.push('limit without a budget or a signal');
  if ('cancelled' in answer && status !== 'limit') wrong.push('cancelled outside limit');
  if (expected !== null) {
    if ((status === 'feasible' || status === 'optimal') && expected.verdict !== 'feasible') wrong.push(`${status} over a best of verdict ${expected.verdict}`);
    if (status === 'unknown' && expected.verdict === 'feasible') wrong.push('unknown over a validated feasible best');
    if (status === 'infeasible' && expected.verdict !== 'infeasible-by-validation') wrong.push(`infeasible over a best of verdict ${expected.verdict}`);
  }
  if (status === 'limit' && 'bound' in answer) wrong.push('a bound beside limit');
  const proof = options.proof ?? null;
  if (proof !== null && proved && status !== 'limit') {
    if (status !== proof.status) wrong.push(`status ${status} is not the proof's ${proof.status}`);
    if (expected !== null && canonical(expected.score) !== canonical(proof.score)) wrong.push(`the best scores ${canonical(expected.score)}, the proof's best ${canonical(proof.score)}`);
    const bound = answer.bound === undefined ? null : { hard: String(answer.bound.hard), service: String(answer.bound.service), soft: String(answer.bound.soft) };
    if (canonical(bound) !== canonical(proof.bound)) wrong.push(`bound ${canonical(bound)} is not the proof's ${canonical(proof.bound)}`);
  }
  return wrong;
}
