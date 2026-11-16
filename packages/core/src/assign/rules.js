//@ts-check

import { AssignError } from './errors.js';
import { compareIds, idOf, isRecord, pointer, revisionOf } from './model.js';
import { contentKey } from '../object.js';

/** @typedef {'hard' | 'service' | 'soft'} RuleLevel */
/** @typedef {'resource' | 'resource-day' | 'task' | 'global'} RuleScope */

/**
 * The scope instance a rule is evaluated for: one resource, one task, the
 * whole problem (`id` null), or one resource on one civil day of one zone
 * (`resource-day`: `id` the resource, with `zone` and `date`). A
 * `resource-day` unit whose `zone` and `date` are null names a resource
 * whose days could not be told, in an unknown `no-zone`.
 * @typedef {Object} RuleUnit
 * @property {RuleScope} scope
 * @property {string | null} id
 * @property {string | null} [zone] - `resource-day` only: the zone the day is civil in
 * @property {string | null} [date] - `resource-day` only: the civil date, `YYYY-MM-DD`
 */

/**
 * What a rule reports for one unit: the matches it found and what it
 * could not decide. Either member may be left out.
 * @typedef {Object} RuleAnswer
 * @property {RuleMatchInput[]} [matches]
 * @property {RuleUnknownInput[]} [unknowns]
 */

/**
 * One match as a rule reports it. The engine adds the rule, its version,
 * level and measure, and the score: minus `magnitude` times the rule's
 * `weight`.
 * @typedef {Object} RuleMatchInput
 * @property {number | bigint} magnitude - a whole number from 1, in the rule's measure
 * @property {string} messageId - a key the host localizes; the engine writes no prose
 * @property {{ resources?: string[], tasks?: string[] }} [subjects]
 * @property {{ start: number, end: number }[]} [intervals]
 * @property {Record<string, unknown>} [params] - JSON the message is filled from
 */

/**
 * Something a rule could not decide: never a pass.
 * @typedef {Object} RuleUnknownInput
 * @property {string} reason
 * @property {string} [fact]
 * @property {{ resources?: string[], tasks?: string[] }} [subjects]
 */

/**
 * A rule as the host writes it: plain data and one pure function.
 * @typedef {Object} AssignRule
 * @property {string} id
 * @property {string | number} version
 * @property {RuleLevel} level
 * @property {RuleScope} scope
 * @property {(view: import('./view.js').AssignView, unit: RuleUnit) => RuleAnswer} evaluate
 * @property {number} [weight] - a whole number from 1; a match scores minus magnitude times weight (default 1)
 * @property {string} [measure] - the unit a magnitude counts in, such as `count` or `ms` (default `count`)
 * @property {{ facts?: string[] }} [reads] - the fact tables the rule reads; a missing one makes it unknown
 */

/**
 * A rule as registered: its declaration frozen, `reads.facts` sorted.
 * @typedef {Object} RegisteredRule
 * @property {string} id
 * @property {string | number} version
 * @property {RuleLevel} level
 * @property {RuleScope} scope
 * @property {number} weight
 * @property {string} measure
 * @property {{ facts: readonly string[] }} reads
 * @property {AssignRule['evaluate']} evaluate
 */

/**
 * A frozen rule set: the rules sorted by id and a fingerprint of their
 * declarations.
 * @typedef {Object} RuleSet
 * @property {string} hash - fingerprint of every rule's declaration (id, version, level, scope, weight, measure, reads)
 * @property {readonly RegisteredRule[]} rules
 */

/** The levels, best kept first. */
export const RULE_LEVELS = /* @__PURE__ */ Object.freeze(/** @type {const} */ (['hard', 'service', 'soft']));
const SCOPES = /* @__PURE__ */ Object.freeze(['resource', 'resource-day', 'task', 'global']);
const MEMBERS = /* @__PURE__ */ Object.freeze(['id', 'version', 'level', 'scope', 'evaluate', 'weight', 'measure', 'reads']);

/** @type {WeakSet<object>} */
const REGISTERED = new WeakSet();

/**
 * @param {unknown} rule @param {string} path
 * @returns {RegisteredRule}
 */
function ruleOf(rule, path) {
  if (!isRecord(rule)) throw new AssignError('JN0010', 'a rule is a plain object', path);
  const record = rule;
  for (const key of ['id', 'version', 'level', 'scope', 'evaluate'])
    if (record[key] === undefined) throw new AssignError('JN0010', `a rule has no ${key}`, `${path}/${key}`);
  for (const key of Object.keys(record))
    if (!MEMBERS.includes(key)) throw new AssignError('JN0010', `${key} is not a member of a rule`, `${path}/${pointer(key)}`);
  const id = idOf(record.id, `${path}/id`);
  const version = revisionOf(record.version, `${path}/version`);
  if (!RULE_LEVELS.includes(/** @type {any} */ (record.level)))
    throw new AssignError('JN0011', `${JSON.stringify(record.level)} is not hard, service or soft`, `${path}/level`);
  if (!SCOPES.includes(/** @type {any} */ (record.scope)))
    throw new AssignError('JN0012', `${JSON.stringify(record.scope)} is not resource, resource-day, task or global`, `${path}/scope`);
  if (typeof record.evaluate !== 'function') throw new AssignError('JN0010', 'evaluate is a function', `${path}/evaluate`);
  const weight = record.weight ?? 1;
  if (!Number.isSafeInteger(weight) || /** @type {number} */ (weight) < 1)
    throw new AssignError('JN0013', 'a weight is a whole number from 1', `${path}/weight`);
  const measure = record.measure ?? 'count';
  if (typeof measure !== 'string' || measure.length === 0) throw new AssignError('JN0010', 'a measure is a non-empty string', `${path}/measure`);
  /** @type {string[]} */
  let facts = [];
  if (record.reads !== undefined) {
    if (!isRecord(record.reads)) throw new AssignError('JN0010', 'reads is { facts? }', `${path}/reads`);
    for (const key of Object.keys(record.reads))
      if (key !== 'facts') throw new AssignError('JN0010', `${key} is not a member of reads`, `${path}/reads/${pointer(key)}`);
    if (record.reads.facts !== undefined) {
      if (!Array.isArray(record.reads.facts)) throw new AssignError('JN0010', 'reads.facts is an array of fact names', `${path}/reads/facts`);
      facts = record.reads.facts.map((name, i) => {
        if (typeof name !== 'string' || name.length === 0) throw new AssignError('JN0002', 'a fact name is a non-empty string', `${path}/reads/facts/${i}`);
        return name;
      }).sort(compareIds);
      for (let i = 1; i < facts.length; i++)
        if (facts[i] === facts[i - 1]) throw new AssignError('JN0010', `fact ${JSON.stringify(facts[i])} is read twice`, `${path}/reads/facts`);
    }
  }
  return Object.freeze({
    evaluate: /** @type {AssignRule['evaluate']} */ (record.evaluate),
    id,
    level: /** @type {RuleLevel} */ (record.level),
    measure,
    reads: Object.freeze({ facts: Object.freeze(facts) }),
    scope: /** @type {RuleScope} */ (record.scope),
    version,
    weight: /** @type {number} */ (weight),
  });
}

/**
 * Register a host's rules: check every declaration against the rule
 * contract and answer a frozen rule set, sorted by id, with a fingerprint
 * of the declarations. The engine ships no rules; every constraint is the
 * host's.
 *
 * A rule is `{ id, version, level, scope, evaluate, weight?, measure?, reads? }`:
 * `level` is `hard`, `service` or `soft`; `scope` is `resource` (evaluated
 * once per resource), `resource-day` (once per resource and civil day of a
 * zone it works in; scoring then needs `options.days` from
 * `@jarenjs/core/assign/days`), `task` (once per task) or `global` (once);
 * `evaluate(view, unit)` is synchronous and pure and answers
 * `{ matches?, unknowns? }`. `reads.facts` names the fact tables it reads:
 * a rule may read no other, and a problem missing one makes the rule
 * unknown rather than satisfied.
 *
 * The hash covers the declarations, not the functions: a rule whose
 * behaviour changes must change its `version`.
 * @param {readonly AssignRule[]} rules
 * @returns {RuleSet}
 * @throws {AssignError} JN0002-JN0004, JN0010-JN0013, `docPath` `/rules/<index>/<member>`
 */
export function registerRules(rules) {
  if (!Array.isArray(rules)) throw new AssignError('JN0010', 'rules is an array of rules', '/rules');
  const registered = rules.map((rule, i) => /** @type {[RegisteredRule, number]} */ ([ruleOf(rule, `/rules/${i}`), i]))
    .sort((a, b) => compareIds(a[0].id, b[0].id));
  for (let i = 1; i < registered.length; i++)
    if (registered[i][0].id === registered[i - 1][0].id)
      throw new AssignError('JN0003', `rule ${JSON.stringify(registered[i][0].id)} is given twice`, `/rules/${registered[i][1]}/id`);
  const list = Object.freeze(registered.map(([rule]) => rule));
  const declarations = list.map((rule) => ({
    id: rule.id, level: rule.level, measure: rule.measure, reads: rule.reads, scope: rule.scope, version: rule.version, weight: rule.weight,
  }));
  const set = Object.freeze({ hash: contentKey(declarations), rules: list });
  REGISTERED.add(set);
  return set;
}

/**
 * Refuse a rule set `registerRules` did not build.
 * @param {unknown} ruleSet
 * @returns {RuleSet}
 */
export function ruleSetOf(ruleSet) {
  if (ruleSet === null || typeof ruleSet !== 'object' || !REGISTERED.has(ruleSet))
    throw new AssignError('JN0014', 'the rule set is the one registerRules answered', '/ruleSet');
  return /** @type {RuleSet} */ (ruleSet);
}
