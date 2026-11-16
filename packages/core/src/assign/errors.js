//@ts-check

import { CodedError } from '../errors.js';

/**
 * The codes an {@link AssignError} carries. Each names one refusal, so a
 * host can tell a problem that is malformed from a rule that answered
 * out of contract, and both from an option this call does not take.
 * @type {Readonly<Record<'JN0001'|'JN0002'|'JN0003'|'JN0004'|'JN0005'|'JN0006'|'JN0007'
 *   |'JN0008'|'JN0009'|'JN0010'|'JN0011'|'JN0012'|'JN0013'|'JN0014'|'JN0015'|'JN0016'
 *   |'JN0017'|'JN0018'|'JN0019'|'JN0020', string>>}
 */
export const ASSIGN_CODES = /* @__PURE__ */ Object.freeze({
  JN0001: 'the problem or one of its members is not of the form the schema takes: a wrong type, a missing member or one it does not define',
  JN0002: 'an id or a fact name is not a non-empty string',
  JN0003: 'an id is given twice where it must be unique: two resources, two tasks, two slots of one task or two rules',
  JN0004: 'a revision or a rule version is not a non-empty string or a whole number from 0',
  JN0005: 'an interval is not a pair of safe integers with start before end',
  JN0006: 'a demand count is not a whole number from 1',
  JN0007: 'an assignment, a baseline entry or a match names a task, slot or resource the problem does not hold',
  JN0008: 'an assignment repeats a task, slot and resource, or fills a slot past its count',
  JN0009: 'a value inside attributes, facts or params is not JSON: a non-finite number, undefined, a function, a symbol, a cycle or deeper than 64 levels',
  JN0010: 'a rule is not of the contract\'s form: a missing member, one it does not define, a wrong type, or an evaluate that is not a function',
  JN0011: 'a rule\'s level is not hard, service or soft',
  JN0012: 'a rule\'s scope is not resource, task or global',
  JN0013: 'a rule\'s weight is not a whole number from 1',
  JN0014: 'a rule set was not built by registerRules',
  JN0015: 'an option is not of the form this call takes: an unknown option, a limit that is not a whole number from 0, or an unknown group',
  JN0016: 'a rule\'s evaluate threw; what it threw is the cause',
  JN0017: 'a rule\'s evaluate answered something other than the contract\'s matches and unknowns: a promise, a wrong member, or a magnitude that is not a whole number from 1',
  JN0018: 'a rule read a fact it does not declare in reads.facts',
  JN0019: 'a score is not of the form scoreAssignment answers',
  JN0020: 'a result is incomplete or not one scoreAssignment answers, so it has no total to explain',
});

/**
 * The refusal every `@jarenjs/core/assign` operation throws: a
 * {@link CodedError} whose `code` is one of {@link ASSIGN_CODES} and
 * whose `docPath` names the place at fault, as a JSON Pointer into the
 * argument (`/tasks/2/demands/0/count`, `/rules/1/level`,
 * `/options/limits/maxWork`) or, for a rule's answer, into that answer
 * under the rule and unit (`/rules/no-overlap/resources/r1/matches/0/magnitude`,
 * `/rules/<id>/global` for a global rule).
 */
export class AssignError extends CodedError {
  /**
   * @param {string} code - one of {@link ASSIGN_CODES}
   * @param {string} reason - the bare reason; `message` is composed per
   *   the coded contract
   * @param {string} [docPath] - the place at fault
   * @param {unknown} [cause] - what a rule threw, when it threw
   */
  constructor(code, reason, docPath = undefined, cause = undefined) {
    super('AssignError', code, reason, docPath,
      cause !== undefined ? { cause } : undefined);
  }
}
