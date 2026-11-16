//@ts-check

import { AssignError } from './errors.js';
import { compareIds, isRecord, pointer } from './model.js';
import { scoreOf, sumMatches } from './score.js';

/** @typedef {import('./score.js').AssignResult} AssignResult */
/** @typedef {import('./score.js').AssignMatch} AssignMatch */
/** @typedef {import('./score.js').AssignUnknown} AssignUnknown */
/** @typedef {import('./score.js').AssignScore} AssignScore */

/**
 * One group of an explanation: its key, the exact score of its matches,
 * and its matches and unknowns in the result's order.
 * @typedef {Object} ExplainGroup
 * @property {string} key
 * @property {AssignScore} score
 * @property {readonly AssignMatch[]} matches
 * @property {readonly AssignUnknown[]} unknowns
 */

/**
 * @typedef {Object} Explanation
 * @property {'rule' | 'level' | 'resource' | 'task'} group
 * @property {readonly ExplainGroup[]} groups - sorted by key in code-unit order
 * @property {{ score: AssignScore, matches: readonly AssignMatch[], unknowns: readonly AssignUnknown[] }} ungrouped
 *   - what names no subject of the grouping (always empty for `rule` and `level`)
 */

const GROUPS = /* @__PURE__ */ Object.freeze(['rule', 'level', 'resource', 'task']);

/**
 * The keys an entry is grouped under.
 * @param {AssignMatch | AssignUnknown} entry @param {string} group
 * @returns {readonly string[]}
 */
function keysOf(entry, group) {
  if (group === 'rule') return [entry.rule];
  if (group === 'level') return [entry.level];
  return group === 'resource' ? entry.subjects.resources : entry.subjects.tasks;
}

/**
 * Group a complete result's matches and unknowns for a report: by `rule`
 * or `level` (each entry in one group, so the groups' scores sum to the
 * total), or by `resource` or `task` subject (an entry is in every group
 * its subjects name, so groups can overlap; one naming none is
 * `ungrouped`). Each group's score is the exact sum of its matches.
 * Groups are sorted by key in code-unit order; within a group entries
 * keep the result's order. `messageId` and `params` are for the host to
 * localize: the engine writes no prose.
 * @param {AssignResult} result - a complete result of `scoreAssignment`
 * @param {{ group?: 'rule' | 'level' | 'resource' | 'task' }} [options] - `group` defaults to `rule`
 * @returns {Explanation}
 * @throws {AssignError} JN0020 for an incomplete result or one that is not a result, JN0015 for an option
 */
export function explain(result, options = undefined) {
  if (!isRecord(result) || result.complete !== true || !Array.isArray(result.matches) || !Array.isArray(result.unknowns))
    throw new AssignError('JN0020', 'only a complete result of scoreAssignment has a total to explain', '/result');
  let group = 'rule';
  if (options !== undefined) {
    if (!isRecord(options)) throw new AssignError('JN0015', 'explain options are { group? }', '/options');
    for (const key of Object.keys(options))
      if (key !== 'group') throw new AssignError('JN0015', `${key} is not an explain option`, `/options/${pointer(key)}`);
    if (options.group !== undefined) {
      if (!GROUPS.includes(/** @type {any} */ (options.group)))
        throw new AssignError('JN0015', `${JSON.stringify(options.group)} is not rule, level, resource or task`, '/options/group');
      group = /** @type {string} */ (options.group);
    }
  }
  /** @type {Map<string, { matches: AssignMatch[], unknowns: AssignUnknown[] }>} */
  const groups = new Map();
  const ungrouped = { matches: /** @type {AssignMatch[]} */ ([]), unknowns: /** @type {AssignUnknown[]} */ ([]) };
  /**
   * @param {AssignMatch | AssignUnknown} entry @param {'matches' | 'unknowns'} into
   */
  const place = (entry, into) => {
    const keys = keysOf(entry, group);
    if (keys.length === 0) /** @type {any[]} */ (ungrouped[into]).push(entry);
    for (const key of keys) {
      let bucket = groups.get(key);
      if (bucket === undefined) groups.set(key, bucket = { matches: [], unknowns: [] });
      /** @type {any[]} */ (bucket[into]).push(entry);
    }
  };
  for (const match of result.matches) place(match, 'matches');
  for (const unknown of result.unknowns) place(unknown, 'unknowns');
  return Object.freeze({
    group: /** @type {Explanation['group']} */ (group),
    groups: Object.freeze([...groups.keys()].sort(compareIds).map((key) => {
      const bucket = /** @type {{ matches: AssignMatch[], unknowns: AssignUnknown[] }} */ (groups.get(key));
      return Object.freeze({
        key,
        matches: Object.freeze(bucket.matches),
        score: scoreOf(sumMatches(bucket.matches)),
        unknowns: Object.freeze(bucket.unknowns),
      });
    })),
    ungrouped: Object.freeze({
      matches: Object.freeze(ungrouped.matches),
      score: scoreOf(sumMatches(ungrouped.matches)),
      unknowns: Object.freeze(ungrouped.unknowns),
    }),
  });
}
