//@ts-check

import { AssignError } from './errors.js';
import { admitAssignmentList, compareIds, idOf, indexOfProblem, intervalOf, isRecord, jsonCopy, pointer } from './model.js';
import { ruleSetOf, RULE_LEVELS } from './rules.js';
import { AssignView, EvaluationContext } from './view.js';
import { buildDays, dayPath } from './day-table.js';
import { DAY_SEAMS } from './seam.js';
import { contentKey, stableStringify } from '../object.js';

/** @typedef {import('./rules.js').RegisteredRule} RegisteredRule */
/** @typedef {import('./rules.js').RuleUnit} RuleUnit */
/** @typedef {import('./rules.js').RuleLevel} RuleLevel */
/** @typedef {import('./model.js').ProblemIndex} ProblemIndex */

/**
 * The limits a scoring stops at when the caller names none. Past any of
 * them the result is incomplete: `complete: false`, verdict `unknown`,
 * the limit in `stoppedAt`, and no score, matches or unknowns.
 * - `maxUnits`: rule evaluations (one per rule and unit);
 * - `maxMatches`: matches collected;
 * - `maxWork`: rows the views answer plus one per view call, match and unknown.
 * @type {Readonly<{ maxUnits: number, maxMatches: number, maxWork: number }>}
 */
export const ASSIGN_LIMITS = /* @__PURE__ */ Object.freeze({
  maxUnits: 1000000,
  maxMatches: 1000000,
  maxWork: 100000000,
});

/** @typedef {{ maxUnits?: number, maxMatches?: number, maxWork?: number }} AssignLimits */

/**
 * `number` while a value is a safe integer, `decimal` (a base-10 string,
 * exact) past it.
 * @typedef {'number' | 'decimal'} ScoreEncoding
 */

/**
 * A lexicographic score: hard, then service, then soft; 0 is best and
 * every match lowers its level. A level past `Number.MAX_SAFE_INTEGER`
 * in size is a decimal string, and `encoding` says so.
 * @typedef {Object} AssignScore
 * @property {{ hard: ScoreEncoding, service: ScoreEncoding, soft: ScoreEncoding }} encoding
 * @property {number | string} hard
 * @property {number | string} service
 * @property {number | string} soft
 */

/**
 * One explained match. `score` is minus `magnitude` times the rule's
 * weight; both are numbers, or decimal strings when either is past
 * `Number.MAX_SAFE_INTEGER` (`encoding: 'decimal'`).
 * @typedef {Object} AssignMatch
 * @property {ScoreEncoding} encoding
 * @property {readonly { start: number, end: number }[]} intervals
 * @property {RuleLevel} level
 * @property {number | string} magnitude
 * @property {string} measure
 * @property {string} messageId
 * @property {Readonly<Record<string, unknown>>} params
 * @property {string} rule
 * @property {number | string} score
 * @property {{ resources: readonly string[], tasks: readonly string[] }} subjects
 * @property {RuleUnit} unit
 * @property {string | number} version
 */

/**
 * Something a rule could not decide. `unit` is null for a rule that was
 * not evaluated because a fact it reads is missing (`reason: 'missing-fact'`).
 * @typedef {Object} AssignUnknown
 * @property {string | null} fact
 * @property {RuleLevel} level
 * @property {string} reason
 * @property {string} rule
 * @property {{ resources: readonly string[], tasks: readonly string[] }} subjects
 * @property {RuleUnit | null} unit
 * @property {string | number} version
 */

/**
 * @typedef {Object} AssignCounts
 * @property {number} rules
 * @property {number} units
 * @property {number} matches
 * @property {number} unknowns
 * @property {number} work
 */

/**
 * What produced a result.
 * @typedef {Object} AssignProvenance
 * @property {'full'} algorithm
 * @property {string} assignments - fingerprint of the scored assignments, sorted
 * @property {string | number | null} baseline - the baseline's revision
 * @property {Readonly<{ policy: 'rfc5545' | 'later' | 'reject', provider: { readonly name: string, readonly revision: string } }>} [days] -
 *   present when the scoring was given `options.days`: the policy and the identity of the
 *   zone provider its civil days were told with
 * @property {Readonly<Record<string, string | number>>} facts - each fact table's revision
 * @property {string | number} problem - the problem's revision
 * @property {string} ruleSet - the rule set's hash
 * @property {readonly { id: string, version: string | number }[]} rules
 */

/**
 * A complete scoring: the score, every match (whose scores sum exactly
 * to it) and every unknown.
 * @typedef {Object} AssignCompleteResult
 * @property {true} complete
 * @property {'feasible' | 'infeasible-by-validation' | 'unknown'} verdict
 * @property {AssignScore} score
 * @property {readonly AssignMatch[]} matches
 * @property {readonly AssignUnknown[]} unknowns
 * @property {AssignCounts} counts
 * @property {AssignProvenance} provenance
 */

/**
 * A scoring stopped at a limit: where it stopped, and no total.
 * @typedef {Object} AssignIncompleteResult
 * @property {false} complete
 * @property {'unknown'} verdict
 * @property {{ limit: 'maxUnits' | 'maxMatches' | 'maxWork', rule: string, unit: RuleUnit | null }} stoppedAt -
 *   `unit` is null when the work of a rule's missing-fact unknowns passed `maxWork` (the rule never ran)
 * @property {AssignCounts} counts
 * @property {AssignProvenance} provenance
 */

/**
 * A scoring; narrow it on `complete`.
 * @typedef {AssignCompleteResult | AssignIncompleteResult} AssignResult
 */

const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const ANSWER_MEMBERS = /* @__PURE__ */ Object.freeze(['matches', 'unknowns']);
const MATCH_MEMBERS = /* @__PURE__ */ Object.freeze(['magnitude', 'messageId', 'subjects', 'intervals', 'params']);
const UNKNOWN_MEMBERS = /* @__PURE__ */ Object.freeze(['reason', 'fact', 'subjects']);
const NO_SUBJECTS = /* @__PURE__ */ Object.freeze({ resources: Object.freeze([]), tasks: Object.freeze([]) });
const NO_PARAMS = /* @__PURE__ */ Object.freeze({});
const NO_INTERVALS = /* @__PURE__ */ Object.freeze([]);

/**
 * Read `{ days? }`: a seam `civilDays()` built, or none.
 * @param {unknown} options
 * @returns {import('./seam.js').DayOperations | null}
 */
export function seamOf(options) {
  const days = isRecord(options) ? options.days : undefined;
  if (days === undefined) return null;
  const seam = days !== null && typeof days === 'object' ? DAY_SEAMS.get(days) : undefined;
  if (seam === undefined) throw new AssignError('JN0021', 'days is the value civilDays from @jarenjs/core/assign/days answered', '/options/days');
  return seam;
}

/**
 * Read `{ limits?, days? }`'s limits.
 * @param {unknown} options
 * @returns {Required<AssignLimits>}
 */
export function limitsOf(options) {
  const out = { ...ASSIGN_LIMITS };
  if (options === undefined) return out;
  if (!isRecord(options)) throw new AssignError('JN0015', 'scoring options are { limits?, days? }', '/options');
  for (const key of Object.keys(options))
    if (key !== 'limits' && key !== 'days') throw new AssignError('JN0015', `${key} is not a scoring option`, `/options/${pointer(key)}`);
  const limits = options.limits;
  if (limits === undefined) return out;
  if (!isRecord(limits)) throw new AssignError('JN0015', 'limits is { maxUnits?, maxMatches?, maxWork? }', '/options/limits');
  for (const [name, value] of Object.entries(limits)) {
    if (!Object.hasOwn(ASSIGN_LIMITS, name)) throw new AssignError('JN0015', `${name} is not a scoring limit`, `/options/limits/${pointer(name)}`);
    if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0)
      throw new AssignError('JN0015', `${name} is a whole number from 0, not ${String(value)}`, `/options/limits/${pointer(name)}`);
    out[/** @type {keyof AssignLimits} */ (name)] = /** @type {number} */ (value);
  }
  return out;
}

/**
 * The units a scope is evaluated over, in id order. `resource-day` units
 * are told by the day table, at the first rule of that scope.
 * @param {ProblemIndex} index
 * @returns {Record<'resource' | 'task' | 'global', readonly RuleUnit[]>}
 */
export function unitsOf(index) {
  return {
    resource: Object.freeze(index.resources.map((resource) => Object.freeze({ id: resource.id, scope: /** @type {const} */ ('resource') }))),
    task: Object.freeze(index.tasks.map((task) => Object.freeze({ id: task.id, scope: /** @type {const} */ ('task') }))),
    global: Object.freeze([Object.freeze({ id: null, scope: /** @type {const} */ ('global') })]),
  };
}

/**
 * The docPath of one unit's answer.
 * @param {RegisteredRule} rule @param {RuleUnit} unit
 * @returns {string}
 */
function unitPath(rule, unit) {
  const base = `/rules/${pointer(rule.id)}`;
  if (unit.scope === 'resource-day') return dayPath(base, unit);
  return unit.id === null ? `${base}/global` : `${base}/${unit.scope}s/${pointer(unit.id)}`;
}

/**
 * Read `{ resources?, tasks? }`: ids the problem holds, sorted, once each.
 * @param {ProblemIndex} index @param {unknown} value @param {string} path
 * @returns {{ resources: readonly string[], tasks: readonly string[] }}
 */
function subjectsOf(index, value, path) {
  if (value === undefined) return NO_SUBJECTS;
  if (!isRecord(value)) throw new AssignError('JN0017', 'subjects is { resources?, tasks? }', path);
  /** @type {Record<string, readonly string[]>} */
  const out = { resources: NO_SUBJECTS.resources, tasks: NO_SUBJECTS.tasks };
  for (const key of Object.keys(value)) {
    if (key !== 'resources' && key !== 'tasks') throw new AssignError('JN0017', `${key} is not a member of subjects`, `${path}/${pointer(key)}`);
    const list = value[key];
    if (!Array.isArray(list)) throw new AssignError('JN0017', `subjects.${key} is an array of ids`, `${path}/${key}`);
    const known = key === 'resources' ? index.resourceById : index.taskById;
    const ids = list.map((id, i) => {
      idOf(id, `${path}/${key}/${i}`);
      if (!known.has(id)) throw new AssignError('JN0007', `the problem holds no ${key === 'resources' ? 'resource' : 'task'} ${JSON.stringify(id)}`, `${path}/${key}/${i}`);
      return /** @type {string} */ (id);
    });
    out[key] = Object.freeze([...new Set(ids)].sort(compareIds));
  }
  return /** @type {{ resources: readonly string[], tasks: readonly string[] }} */ (Object.freeze(out));
}

/**
 * A whole number from 1, as a bigint.
 * @param {unknown} value @param {string} path
 * @returns {bigint}
 */
function magnitudeOf(value, path) {
  if (typeof value === 'bigint' && value >= 1n) return value;
  if (Number.isSafeInteger(value) && /** @type {number} */ (value) >= 1) return BigInt(/** @type {number} */ (value));
  throw new AssignError('JN0017', 'a magnitude is a whole number from 1: a safe integer or a bigint', path);
}

/**
 * A number while it is a safe integer, else its exact decimal text.
 * @param {bigint} value
 * @returns {number | string}
 */
function encode(value) {
  return value <= SAFE && value >= -SAFE ? Number(value) : value.toString();
}

/**
 * Read one unit's answer into frozen matches and unknowns, each list in
 * canonical order.
 * @param {ProblemIndex} index @param {RegisteredRule} rule @param {RuleUnit} unit
 * @param {unknown} answer @param {Record<RuleLevel, bigint>} sums
 * @returns {{ matches: AssignMatch[], unknowns: AssignUnknown[] }}
 */
function readAnswer(index, rule, unit, answer, sums) {
  const path = unitPath(rule, unit);
  if (answer !== null && typeof answer === 'object' && typeof (/** @type {any} */ (answer)).then === 'function')
    throw new AssignError('JN0017', 'evaluate answered a promise; it is synchronous', path);
  if (!isRecord(answer)) throw new AssignError('JN0017', 'evaluate answers { matches?, unknowns? }', path);
  for (const key of Object.keys(answer))
    if (!ANSWER_MEMBERS.includes(key)) throw new AssignError('JN0017', `${key} is not a member of a rule's answer`, `${path}/${pointer(key)}`);
  const matchList = answer.matches ?? [];
  const unknownList = answer.unknowns ?? [];
  if (!Array.isArray(matchList)) throw new AssignError('JN0017', 'matches is an array', `${path}/matches`);
  if (!Array.isArray(unknownList)) throw new AssignError('JN0017', 'unknowns is an array', `${path}/unknowns`);
  const weight = BigInt(rule.weight);
  const keyed = matchList.map((match, i) => {
    const at = `${path}/matches/${i}`;
    if (!isRecord(match)) throw new AssignError('JN0017', 'a match is { magnitude, messageId, subjects?, intervals?, params? }', at);
    for (const key of Object.keys(match))
      if (!MATCH_MEMBERS.includes(key)) throw new AssignError('JN0017', `${key} is not a member of a match`, `${at}/${pointer(key)}`);
    const magnitude = magnitudeOf(match.magnitude, `${at}/magnitude`);
    if (typeof match.messageId !== 'string' || match.messageId.length === 0)
      throw new AssignError('JN0017', 'a messageId is a non-empty string', `${at}/messageId`);
    let intervals = NO_INTERVALS;
    if (match.intervals !== undefined) {
      if (!Array.isArray(match.intervals)) throw new AssignError('JN0017', 'intervals is an array of { start, end }', `${at}/intervals`);
      intervals = Object.freeze(match.intervals.map((interval, j) => intervalOf(interval, `${at}/intervals/${j}`))
        .sort((a, b) => a.start - b.start || a.end - b.end));
    }
    let params = NO_PARAMS;
    if (match.params !== undefined) {
      if (!isRecord(match.params)) throw new AssignError('JN0017', 'params is an object', `${at}/params`);
      params = /** @type {Readonly<Record<string, unknown>>} */ (jsonCopy(match.params, `${at}/params`));
    }
    const score = -(magnitude * weight);
    sums[rule.level] += score;
    const exact = magnitude <= SAFE && -score <= SAFE;
    const out = Object.freeze({
      encoding: exact ? /** @type {const} */ ('number') : /** @type {const} */ ('decimal'),
      intervals,
      level: rule.level,
      magnitude: exact ? Number(magnitude) : magnitude.toString(),
      measure: rule.measure,
      messageId: match.messageId,
      params,
      rule: rule.id,
      score: exact ? Number(score) : score.toString(),
      subjects: subjectsOf(index, match.subjects, `${at}/subjects`),
      unit,
      version: rule.version,
    });
    return /** @type {[string, AssignMatch]} */ ([/** @type {string} */ (stableStringify(out)), out]);
  });
  const unknowns = unknownList.map((unknown, i) => {
    const at = `${path}/unknowns/${i}`;
    if (!isRecord(unknown)) throw new AssignError('JN0017', 'an unknown is { reason, fact?, subjects? }', at);
    for (const key of Object.keys(unknown))
      if (!UNKNOWN_MEMBERS.includes(key)) throw new AssignError('JN0017', `${key} is not a member of an unknown`, `${at}/${pointer(key)}`);
    if (typeof unknown.reason !== 'string' || unknown.reason.length === 0)
      throw new AssignError('JN0017', 'a reason is a non-empty string', `${at}/reason`);
    if (unknown.fact !== undefined && (typeof unknown.fact !== 'string' || unknown.fact.length === 0))
      throw new AssignError('JN0017', 'a fact is a non-empty string', `${at}/fact`);
    return unknownOf(rule, unit, unknown.reason, /** @type {string | undefined} */ (unknown.fact) ?? null, subjectsOf(index, unknown.subjects, `${at}/subjects`));
  });
  return {
    matches: keyed.sort((a, b) => compareIds(a[0], b[0])).map(([, match]) => match),
    unknowns: unknowns.map((unknown) => /** @type {[string, AssignUnknown]} */ ([/** @type {string} */ (stableStringify(unknown)), unknown]))
      .sort((a, b) => compareIds(a[0], b[0])).map(([, unknown]) => unknown),
  };
}

/**
 * @param {RegisteredRule} rule @param {RuleUnit | null} unit @param {string} reason
 * @param {string | null} fact @param {{ resources: readonly string[], tasks: readonly string[] }} subjects
 * @returns {AssignUnknown}
 */
export function unknownOf(rule, unit, reason, fact, subjects) {
  return Object.freeze({ fact, level: rule.level, reason, rule: rule.id, subjects, unit, version: rule.version });
}

/**
 * One unknown `no-zone` per assigned task of `resource` that has no
 * zone, in canonical order: the resource's days cannot be told.
 * @param {RegisteredRule} rule @param {RuleUnit} unit @param {string} resource
 * @param {readonly string[]} tasks
 * @returns {AssignUnknown[]}
 */
export function noZoneOf(rule, unit, resource, tasks) {
  const resources = Object.freeze([resource]);
  return tasks.map((task) => unknownOf(rule, unit, 'no-zone', null, Object.freeze({ resources, tasks: Object.freeze([task]) })))
    .map((unknown) => /** @type {[string, AssignUnknown]} */ ([/** @type {string} */ (stableStringify(unknown)), unknown]))
    .sort((a, b) => compareIds(a[0], b[0])).map(([, unknown]) => unknown);
}

/**
 * The `resource-day` units of a day table, in order of resource id, zone
 * and date. A resource whose days cannot be told has one unit, with
 * `zone` and `date` null, which is not evaluated: it carries the
 * unknowns `no-zone`.
 * @param {ProblemIndex} index @param {import('./day-table.js').DayTable} table
 * @returns {readonly { unit: RuleUnit, zoneless: readonly string[] | null }[]}
 */
function dayUnitsOf(index, table) {
  /** @type {{ unit: RuleUnit, zoneless: readonly string[] | null }[]} */
  const out = [];
  for (const resource of index.resources) {
    const zoneless = table.zoneless.get(resource.id);
    if (zoneless !== undefined) {
      out.push({ unit: Object.freeze({ date: null, id: resource.id, scope: /** @type {const} */ ('resource-day'), zone: null }), zoneless });
      continue;
    }
    for (const day of table.byResource.get(resource.id) ?? [])
      out.push({ unit: Object.freeze({ date: day.date, id: resource.id, scope: /** @type {const} */ ('resource-day'), zone: day.zone }), zoneless: null });
  }
  return Object.freeze(out);
}

/**
 * Evaluate one rule over one unit as a scoring does: run the rule, read
 * its answer into frozen canonical matches and unknowns, and charge the
 * matches and unknowns to the context's work. A unit that read the days
 * of a resource whose days cannot be told answers that resource's
 * unknowns `no-zone` instead. Answers null when the rule's reads passed
 * the context's `maxWork`.
 * @param {ProblemIndex} index @param {EvaluationContext} context
 * @param {AssignView} view @param {RegisteredRule} rule @param {RuleUnit} unit
 * @returns {{ matches: AssignMatch[], unknowns: AssignUnknown[], sum: bigint } | null}
 *   `sum` the exact sum of the matches' scores
 * @throws {AssignError} JN0016 for a rule that threw, JN0017 for an answer out of
 *   contract, JN0018 and JN0021 for a read the rule may not make
 */
export function evaluateUnit(index, context, view, rule, unit) {
  context.noZone = null;
  context.unit = unit;
  /** @type {unknown} */
  let answer;
  try {
    answer = rule.evaluate(view, unit);
  }
  catch (error) {
    if (context.stopped) return null;
    if (context.noZone === null) {
      if (error instanceof AssignError && (error.code === 'JN0018' || error.code === 'JN0021')) throw error;
      throw new AssignError('JN0016', `rule ${JSON.stringify(rule.id)} threw`, unitPath(rule, unit), error);
    }
  }
  if (context.stopped) return null;
  if (context.noZone !== null) {
    const resource = context.noZone;
    const told = noZoneOf(rule, unit, resource, /** @type {readonly string[]} */ (/** @type {import('./day-table.js').DayTable} */ (context.days).zoneless.get(resource)));
    context.work += told.length;
    return { matches: [], unknowns: told, sum: 0n };
  }
  const sums = { hard: 0n, service: 0n, soft: 0n };
  const read = readAnswer(index, rule, unit, answer, sums);
  context.work += read.matches.length + read.unknowns.length;
  return { matches: read.matches, unknowns: read.unknowns, sum: sums[rule.level] };
}

/**
 * Sum match scores per level, exactly.
 * @param {readonly { level: RuleLevel, score: number | string }[]} matches
 * @returns {Record<RuleLevel, bigint>}
 */
export function sumMatches(matches) {
  const sums = { hard: 0n, service: 0n, soft: 0n };
  for (const match of matches) sums[match.level] += BigInt(match.score);
  return sums;
}

/**
 * The encoded score of exact level sums.
 * @param {Record<RuleLevel, bigint>} sums
 * @returns {AssignScore}
 */
export function scoreOf(sums) {
  const kind = (/** @type {bigint} */ value) => (value <= SAFE && value >= -SAFE ? /** @type {const} */ ('number') : /** @type {const} */ ('decimal'));
  return Object.freeze({
    encoding: Object.freeze({ hard: kind(sums.hard), service: kind(sums.service), soft: kind(sums.soft) }),
    hard: encode(sums.hard),
    service: encode(sums.service),
    soft: encode(sums.soft),
  });
}

/**
 * Score one assignment list against a problem with the host's rules:
 * every rule over every unit of its scope, rules in id order and units
 * in id order, each match explained and the score the exact sum of the
 * matches. Arithmetic is integer only: a level whose sum passes
 * `Number.MAX_SAFE_INTEGER` in size is answered as an exact decimal
 * string with `encoding: 'decimal'`, decided from the final sum alone.
 *
 * The verdict is `infeasible-by-validation` when a hard match exists (a
 * validated violation, not a search proof); else `unknown` when a hard
 * rule reported an unknown or could not run because a fact it reads is
 * missing; else `feasible`. Service and soft unknowns are reported and
 * do not block.
 *
 * Past a limit (`ASSIGN_LIMITS`, overridden by `options.limits`) the
 * result is incomplete: `complete: false`, verdict `unknown`, `stoppedAt`
 * naming the limit, rule and unit, and no score, matches or unknowns -
 * never a partial total.
 *
 * A `resource-day` rule is evaluated once per resource and civil day of
 * a zone the resource works in: each assigned task's interval is cut at
 * the civil-day boundaries of the task's own `zone` through
 * `options.days` (`civilDays({ zoneProvider, policy })` from
 * `@jarenjs/core/assign/days`), so a day across a change of the clock is
 * 23 or 25 hours long. A resource with an assigned task that has no zone
 * has days nobody can tell: its day units are not evaluated, and each
 * day rule reports one unknown `no-zone` per such task (a hard one makes
 * the verdict unknown); the engine never supplies a zone, UTC included.
 * The seam's policy and provider identity are `provenance.days`.
 *
 * Answers are frozen JSON, identical in every host time zone, for every
 * key order of the inputs and every order of their resources, tasks,
 * demands and assignments (fact rows keep the host's order); with day
 * rules, for one provider identity and policy.
 * @param {unknown} problem - admitted with {@link admitProblem} when it is not yet
 * @param {import('./rules.js').RuleSet} ruleSet - from `registerRules`
 * @param {unknown} assignments - the assignments to score, checked as the problem's are
 * @param {{ limits?: AssignLimits, days?: import('./days.js').CivilDays }} [options]
 * @returns {AssignResult}
 * @throws {AssignError} the problem's and assignments' refusals (JN0001-JN0009),
 *   JN0014 for a rule set registerRules did not build, JN0015 for an option,
 *   JN0016-JN0018 for a rule that threw, answered out of contract or read an undeclared fact,
 *   JN0021 for a day rule without `options.days` or a day read outside one,
 *   JN0022 for a task the seam cannot split (`docPath` `/tasks/<i>/zone`, `i` its
 *   place in the admitted problem, whose tasks are sorted by id)
 */
export function scoreAssignment(problem, ruleSet, assignments, options = undefined) {
  const index = indexOfProblem(problem);
  const set = ruleSetOf(ruleSet);
  const limits = limitsOf(options);
  const seam = seamOf(options);
  if (seam === null && set.rules.some((rule) => rule.scope === 'resource-day'))
    throw new AssignError('JN0021', 'a resource-day rule needs options.days, from civilDays in @jarenjs/core/assign/days', '/options/days');
  const scored = admitAssignmentList(index, assignments, '/assignments');
  const context = new EvaluationContext(index, scored, limits.maxWork);
  const units = unitsOf(index);
  /** @type {readonly { unit: RuleUnit, zoneless: readonly string[] | null }[] | null} */
  let dayUnits = null;
  const counts = { rules: set.rules.length, units: 0, matches: 0, unknowns: 0, work: 0 };
  const provenance = provenanceOf(index, set, scored, /** @type {any} */ (options)?.days);
  /** @type {AssignMatch[]} */
  const matches = [];
  /** @type {AssignUnknown[]} */
  const unknowns = [];
  const sums = { hard: 0n, service: 0n, soft: 0n };
  /**
   * @param {'maxUnits' | 'maxMatches' | 'maxWork'} limit @param {RegisteredRule} rule
   * @param {RuleUnit | null} unit - null for a rule never evaluated because a fact it reads is missing
   * @returns {AssignResult}
   */
  const stop = (limit, rule, unit) => Object.freeze({
    complete: false,
    counts: Object.freeze({ ...counts, work: context.work }),
    provenance,
    stoppedAt: Object.freeze({ limit, rule: rule.id, unit }),
    verdict: /** @type {const} */ ('unknown'),
  });
  for (const rule of set.rules) {
    const facts = /** @type {Record<string, unknown>} */ (index.problem.facts);
    const missing = rule.reads.facts.filter((name) => !Object.hasOwn(facts, name));
    if (missing.length > 0) {
      for (const fact of missing) unknowns.push(unknownOf(rule, null, 'missing-fact', fact, NO_SUBJECTS));
      counts.unknowns += missing.length;
      context.work += missing.length;
      if (context.work > limits.maxWork) return stop('maxWork', rule, null);
      continue;
    }
    const view = new AssignView(context, rule);
    if (rule.scope === 'resource-day' && dayUnits === null) {
      const table = buildDays(context, /** @type {import('./seam.js').DayOperations} */ (seam), limits.maxWork);
      if ('stoppedAt' in table)
        return stop('maxWork', rule, Object.freeze({ date: null, id: table.stoppedAt, scope: /** @type {const} */ ('resource-day'), zone: null }));
      context.days = table;
      dayUnits = dayUnitsOf(index, table);
    }
    const list = rule.scope === 'resource-day'
      ? /** @type {readonly { unit: RuleUnit, zoneless: readonly string[] | null }[]} */ (dayUnits)
      : units[rule.scope].map((unit) => ({ unit, zoneless: null }));
    for (const { unit, zoneless } of list) {
      if (zoneless !== null) {
        const told = noZoneOf(rule, unit, /** @type {string} */ (unit.id), zoneless);
        for (const unknown of told) unknowns.push(unknown);
        counts.unknowns += told.length;
        context.work += told.length;
        if (context.work > limits.maxWork) return stop('maxWork', rule, unit);
        continue;
      }
      if (counts.units >= limits.maxUnits) return stop('maxUnits', rule, unit);
      counts.units++;
      const answer = evaluateUnit(index, context, view, rule, unit);
      if (answer === null || context.work > limits.maxWork) return stop('maxWork', rule, unit);
      if (counts.matches + answer.matches.length > limits.maxMatches) return stop('maxMatches', rule, unit);
      for (const match of answer.matches) matches.push(match);
      for (const unknown of answer.unknowns) unknowns.push(unknown);
      counts.matches += answer.matches.length;
      counts.unknowns += answer.unknowns.length;
      sums[rule.level] += answer.sum;
    }
  }
  const check = sumMatches(matches);
  if (check.hard !== sums.hard || check.service !== sums.service || check.soft !== sums.soft)
    throw new Error('assign: the matches do not re-sum to the score');
  const hardUnknown = unknowns.some((unknown) => unknown.level === 'hard');
  return Object.freeze({
    complete: true,
    counts: Object.freeze({ ...counts, work: context.work }),
    matches: Object.freeze(matches),
    provenance,
    score: scoreOf(sums),
    unknowns: Object.freeze(unknowns),
    verdict: sums.hard < 0n ? 'infeasible-by-validation' : hardUnknown ? 'unknown' : 'feasible',
  });
}

/**
 * @param {ProblemIndex} index @param {import('./rules.js').RuleSet} set
 * @param {readonly import('./model.js').Assignment[]} scored
 * @param {AssignProvenance['days'] | undefined} days - the seam, already checked
 * @param {string} [key] - `contentKey(scored)`, when the caller holds it
 * @returns {AssignProvenance}
 */
export function provenanceOf(index, set, scored, days, key = contentKey(scored)) {
  const problem = index.problem;
  /** @type {Record<string, string | number>} */
  const facts = {};
  for (const [name, table] of Object.entries(/** @type {Record<string, import('./model.js').AssignFact>} */ (problem.facts)))
    Object.defineProperty(facts, name, { value: table.revision, enumerable: true });
  return Object.freeze({
    algorithm: /** @type {const} */ ('full'),
    assignments: key,
    baseline: problem.baseline?.revision ?? null,
    ...(days === undefined ? {} : { days }),
    facts: Object.freeze(facts),
    problem: problem.revision,
    ruleSet: set.hash,
    rules: Object.freeze(set.rules.map((rule) => Object.freeze({ id: rule.id, version: rule.version }))),
  });
}

/**
 * A level of a score as an exact bigint.
 * @param {unknown} score @param {RuleLevel} level @param {string} path
 * @returns {bigint}
 */
function levelOf(score, level, path) {
  const record = /** @type {Record<string, any>} */ (score);
  const value = record[level];
  const encoding = record.encoding[level];
  if (encoding === 'number' && Number.isSafeInteger(value) && value <= 0) return BigInt(value);
  if (encoding === 'decimal' && typeof value === 'string' && /^-[1-9][0-9]*$/.test(value)) return BigInt(value);
  throw new AssignError('JN0019', `${level} is not a level of a score`, `${path}/${level}`);
}

/**
 * Compare two scores lexicographically: hard first, then service, then
 * soft, each exactly (decimal levels included). Answers 1 when `a` is
 * better, -1 when `b` is, 0 when they are equal; `scores.sort(compareScores)`
 * puts the worst first.
 * @param {AssignScore} a @param {AssignScore} b
 * @returns {-1 | 0 | 1}
 * @throws {AssignError} JN0019 for a value that is not a score
 */
export function compareScores(a, b) {
  for (const [score, path] of /** @type {[unknown, string][]} */ ([[a, '/a'], [b, '/b']]))
    if (!isRecord(score) || !isRecord(score.encoding)) throw new AssignError('JN0019', 'a score is { hard, service, soft, encoding }', path);
  for (const level of RULE_LEVELS) {
    const x = levelOf(a, level, '/a');
    const y = levelOf(b, level, '/b');
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
