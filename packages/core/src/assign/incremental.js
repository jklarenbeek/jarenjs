//@ts-check
/**
 * @file Incremental and what-if evaluation: an evaluator holds one
 * scoring's answer per rule and unit, and after an edit re-evaluates
 * only the units whose rows the edit touched, so every answer is the
 * bytes a fresh full scoring of the same state answers.
 */

import { AssignError } from './errors.js';
import { admitAssignmentList, compareAssignments, idOf, indexOfProblem, isRecord, pointer } from './model.js';
import { ruleSetOf } from './rules.js';
import { AssignView, EvaluationContext, groupRows, timeOrder } from './view.js';
import { daysOfList, zonelessOf } from './day-table.js';
import { evaluateUnit, limitsOf, noZoneOf, provenanceOf, scoreAssignment, scoreOf, seamOf, unitsOf, unknownOf } from './score.js';
import { stableStringify } from '../object.js';
import { fnv1a } from '../string.js';

/** @typedef {import('./model.js').ProblemIndex} ProblemIndex */
/** @typedef {import('./model.js').Assignment} Assignment */
/** @typedef {import('./model.js').AssignTask} AssignTask */
/** @typedef {import('./rules.js').RegisteredRule} RegisteredRule */
/** @typedef {import('./rules.js').RuleSet} RuleSet */
/** @typedef {import('./rules.js').RuleUnit} RuleUnit */
/** @typedef {import('./score.js').AssignResult} AssignResult */
/** @typedef {import('./score.js').AssignMatch} AssignMatch */
/** @typedef {import('./score.js').AssignUnknown} AssignUnknown */
/** @typedef {import('./score.js').AssignLimits} AssignLimits */
/** @typedef {import('./day-table.js').AssignDay} AssignDay */
/** @typedef {import('./days.js').CivilDays} CivilDays */

/**
 * One edit of an evaluator's state:
 * - `assign` adds an assignment;
 * - `unassign` removes one;
 * - `move` hands one assignment (its lock with it) from resource `from` to `to`;
 * - `swap` exchanges the resources of two assignments, each keeping its lock;
 * - `revise` replaces the problem, the rule set, the civil-day seam or the
 *   whole assignment list, and every rule is evaluated again.
 * @typedef {{ op: 'assign', task: string, slot: string, resource: string, lock?: 'hard' | 'soft' }
 *   | { op: 'unassign', task: string, slot: string, resource: string }
 *   | { op: 'move', task: string, slot: string, from: string, to: string }
 *   | { op: 'swap', a: { task: string, slot: string, resource: string }, b: { task: string, slot: string, resource: string } }
 *   | { op: 'revise', problem?: unknown, ruleSet?: RuleSet, days?: CivilDays, assignments?: unknown }} AssignEdit
 */

/**
 * What an evaluator did, counted since it was created. `fullFallbacks`
 * counts each answer for which a rule was evaluated over every unit of
 * its scope because one of its units read assignments outside its own
 * row; `fullScorings` counts the answers every rule was evaluated over
 * every unit for: the first, each `revise`, and each answer past a limit
 * or after a rule threw or answered out of contract.
 * @typedef {Object} EvaluatorCounts
 * @property {number} edits - answers of `apply`
 * @property {number} previews - answers of `whatIf`
 * @property {number} evaluated - rule evaluations over one unit
 * @property {number} reused - unit answers kept from an earlier answer
 * @property {number} fullFallbacks
 * @property {number} fullScorings
 */

/**
 * One rule's answer for one unit, as kept.
 * @typedef {Object} Entry
 * @property {RuleUnit} unit
 * @property {boolean} failed - the evaluation passed maxWork, threw or answered out of contract
 * @property {readonly AssignMatch[]} matches
 * @property {readonly AssignUnknown[]} unknowns
 * @property {bigint} sum
 * @property {number} work - the work the scoring charges for it, fact indexes apart
 * @property {readonly string[]} asked - the fact indexes it read
 * @property {boolean} counted - an evaluated unit (an unknown `no-zone` is not one)
 */

/**
 * One rule's kept answers: a row per task (`task`), per resource
 * (`resource`, `resource-day`) or one (`global`), each a list of entries.
 * @typedef {Object} RuleState
 * @property {RegisteredRule} rule
 * @property {AssignView} view
 * @property {readonly AssignUnknown[] | null} missing - the unknowns `missing-fact` of a rule not evaluated
 * @property {boolean} wide - a unit read assignments outside its row: every row is evaluated again
 * @property {Entry[][]} rows
 */

/**
 * A resource's civil days as kept: no assignments, an assigned task
 * without a zone, its days, or a seam refusal.
 * @typedef {{ kind: 'none' } | { kind: 'zoneless', tasks: readonly string[] }
 *   | { kind: 'days', list: readonly Assignment[], days: readonly AssignDay[] } | { kind: 'broken' }} DayState
 */

const EDIT_MEMBERS = /* @__PURE__ */ Object.freeze({
  assign: Object.freeze({ required: ['task', 'slot', 'resource'], optional: ['lock'] }),
  unassign: Object.freeze({ required: ['task', 'slot', 'resource'], optional: [] }),
  move: Object.freeze({ required: ['task', 'slot', 'from', 'to'], optional: [] }),
  swap: Object.freeze({ required: ['a', 'b'], optional: [] }),
  revise: Object.freeze({ required: [], optional: ['problem', 'ruleSet', 'days', 'assignments'] }),
});
const NONE = /* @__PURE__ */ Object.freeze({ kind: /** @type {const} */ ('none') });
const BROKEN = /* @__PURE__ */ Object.freeze({ kind: /** @type {const} */ ('broken') });
const EMPTY = /* @__PURE__ */ Object.freeze([]);
/** @type {WeakMap<Assignment, string>} - each admitted assignment's canonical text */
const TEXTS = new WeakMap();

/**
 * The fingerprint `provenance.assignments` holds, `contentKey` of the
 * list (`hashContent` of its canonical text), hashed piece by piece from
 * the kept text of each assignment: a list's canonical text is its
 * items' texts, comma-joined, in brackets.
 * @param {readonly Assignment[]} list
 * @returns {string}
 */
function listKey(list) {
  let hash = fnv1a('[');
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    let text = TEXTS.get(item);
    if (text === undefined) TEXTS.set(item, text = /** @type {string} */ (stableStringify(item)));
    if (i > 0) hash = fnv1a(',', hash);
    hash = fnv1a(text, hash);
  }
  return fnv1a(']', hash).toString(36);
}

/**
 * The evaluation context of an evaluator: fact indexes are kept for its
 * life and charged by the assembly, once each, as a scoring charges
 * them; and every read of assignments is checked against the unit's own
 * row (its task, or its resource with that resource's days).
 */
class KeptContext extends EvaluationContext {
  /**
   * @param {ProblemIndex} index @param {readonly Assignment[]} assignments @param {number} maxWork
   */
  constructor(index, assignments, maxWork) {
    super(index, assignments, maxWork);
    /** @type {Map<string, Map<unknown, readonly unknown[]>>} */
    this.kept = new Map();
    /** @type {Map<string, number>} - what a scoring charges to build each kept index */
    this.costs = new Map();
    /** @type {string[]} */
    this.asked = [];
    this.wide = false;
  }

  /** @param {'task' | 'resource' | null} kind @param {string | null} id */
  row(kind, id) {
    const unit = /** @type {RuleUnit} */ (this.unit);
    if (unit.scope === 'global') return;
    if (kind !== (unit.scope === 'task' ? 'task' : 'resource') || id !== unit.id) this.wide = true;
  }

  /** @param {string} name @param {string} member @param {import('./model.js').AssignFact} table */
  factIndex(name, member, table) {
    const key = JSON.stringify([name, member]);
    let byValue = this.kept.get(key);
    if (byValue === undefined) {
      this.kept.set(key, byValue = groupRows(table, member));
      this.costs.set(key, 1 + table.rows.length);
    }
    if (!this.asked.includes(key)) this.asked.push(key);
    return byValue;
  }
}

/**
 * Insert into, or remove from, a frozen sorted list, answering a new one.
 * @param {readonly Assignment[]} list @param {Assignment} item
 * @param {(a: Assignment, b: Assignment) => number} order @param {boolean} add
 * @returns {readonly Assignment[]}
 */
function edited(list, item, order, add) {
  const out = list.slice();
  const at = place(out, item, order);
  if (add) out.splice(at, 0, item);
  else out.splice(at, 1);
  return Object.freeze(out);
}

/**
 * The first place in a sorted list not before `item`.
 * @param {readonly Assignment[]} list @param {Assignment} item
 * @param {(a: Assignment, b: Assignment) => number} order
 * @returns {number}
 */
function place(list, item, order) {
  let low = 0, high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (order(list[mid], item) < 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Read `{ task, slot, <resource> }` as an assignment the problem can hold.
 * @param {ProblemIndex} index @param {Record<string, unknown>} record
 * @param {string} member - the member naming the resource
 * @param {string} path
 * @returns {{ task: string, slot: string, resource: string }}
 */
function targetOf(index, record, member, path) {
  const task = idOf(record.task, `${path}/task`);
  const slot = idOf(record.slot, `${path}/slot`);
  const resource = idOf(record[member], `${path}/${member}`);
  const demands = index.demandsByTask.get(task);
  if (demands === undefined) throw new AssignError('JN0007', `the problem holds no task ${JSON.stringify(task)}`, `${path}/task`);
  if (!demands.has(slot)) throw new AssignError('JN0007', `task ${JSON.stringify(task)} has no slot ${JSON.stringify(slot)}`, `${path}/slot`);
  if (!index.resourceById.has(resource)) throw new AssignError('JN0007', `the problem holds no resource ${JSON.stringify(resource)}`, `${path}/${member}`);
  return { task, slot, resource };
}

/**
 * Check an edit's members against its op.
 * @param {unknown} edit
 * @returns {Record<string, unknown> & { op: keyof typeof EDIT_MEMBERS }}
 */
function editOf(edit) {
  if (!isRecord(edit)) throw new AssignError('JN0023', 'an edit is { op, ... }', '/edit');
  const op = edit.op;
  if (typeof op !== 'string' || !Object.hasOwn(EDIT_MEMBERS, op))
    throw new AssignError('JN0023', `${JSON.stringify(op)} is not assign, unassign, move, swap or revise`, '/edit/op');
  const shape = EDIT_MEMBERS[/** @type {keyof typeof EDIT_MEMBERS} */ (op)];
  for (const key of shape.required)
    if (edit[key] === undefined) throw new AssignError('JN0023', `a ${op} edit has no ${key}`, `/edit/${key}`);
  for (const key of Object.keys(edit))
    if (key !== 'op' && !shape.required.includes(key) && !shape.optional.includes(key))
      throw new AssignError('JN0023', `${key} is not a member of a ${op} edit`, `/edit/${pointer(key)}`);
  return /** @type {any} */ (edit);
}

/**
 * The scoring state an evaluator keeps: the admitted problem and rule
 * set, the assignment list with its indexes, the civil days, and every
 * rule's answers.
 */
class State {
  /**
   * @param {ProblemIndex} index @param {RuleSet} set @param {Required<AssignLimits>} limits
   * @param {import('./seam.js').DayOperations | null} seam @param {CivilDays | undefined} days
   * @param {readonly Assignment[]} list - admitted
   * @param {EvaluatorCounts} counts
   */
  constructor(index, set, limits, seam, days, list, counts) {
    this.index = index;
    this.set = set;
    this.limits = limits;
    this.seam = seam;
    this.days = days;
    this.counts = counts;
    /** @type {readonly Assignment[]} */
    this.list = list;
    this.context = new KeptContext(index, list, limits.maxWork);
    this.units = unitsOf(index);
    this.byTime = timeOrder(index);
    this.taskAt = new Map(index.tasks.map((task, i) => [task.id, i]));
    this.resourceAt = new Map(index.resources.map((resource, i) => [resource.id, i]));
    const facts = /** @type {Record<string, unknown>} */ (index.problem.facts);
    /** @type {RuleState[]} */
    this.rules = set.rules.map((rule) => {
      const missing = rule.reads.facts.filter((name) => !Object.hasOwn(facts, name));
      return {
        rule,
        view: new AssignView(this.context, rule),
        missing: missing.length === 0 ? null : Object.freeze(missing.map((fact) => unknownOf(rule, null, 'missing-fact', fact, Object.freeze({ resources: EMPTY, tasks: EMPTY })))),
        wide: false,
        rows: [],
      };
    });
    this.needDays = this.rules.some((state) => state.rule.scope === 'resource-day' && state.missing === null);
    /** @type {DayState[]} */
    this.dayStates = index.resources.map(() => NONE);
    /** @type {Map<string, ReadonlyArray<{ date: string, start: number, end: number }>>} */
    this.splits = new Map();
    /** @type {Map<string, { start: number, end: number }>} */
    this.spans = new Map();
    /** @type {Map<string, number>} */
    this.taskRefs = new Map();
    /** @type {Map<string, number>} */
    this.spanRefs = new Map();
    /** the work a scoring charges to build the day table */
    this.dayWork = 0;
    this.evaluatedNow = 0;
    if (this.needDays) {
      this.context.days = { byResource: new Map(), byKey: new Map(), zoneless: new Map() };
      for (const resource of index.resources) this.setDays(/** @type {number} */ (this.resourceAt.get(resource.id)), this.dayStateOf(resource.id));
    }
    for (const state of this.rules)
      if (state.missing === null) state.rows = this.rowsOf(state).map((at) => this.evaluateRow(state, at));
  }

  /**
   * The rows of a rule's scope, by place.
   * @param {RuleState} state
   * @returns {number[]}
   */
  rowsOf(state) {
    const count = state.rule.scope === 'task' ? this.index.tasks.length : state.rule.scope === 'global' ? 1 : this.index.resources.length;
    return Array.from({ length: count }, (_, i) => i);
  }

  /**
   * A resource's days, told from its assignments as a scoring tells them.
   * @param {string} resource
   * @returns {DayState}
   */
  dayStateOf(resource) {
    const list = this.context.byResource.get(resource);
    if (list === undefined) return NONE;
    const zoneless = zonelessOf(this.index, list);
    if (zoneless !== null) return Object.freeze({ kind: /** @type {const} */ ('zoneless'), tasks: zoneless });
    const seam = /** @type {import('./seam.js').DayOperations} */ (this.seam);
    try {
      const days = /** @type {readonly AssignDay[]} */ (daysOfList(this.index, list, (task) => {
        let pieces = this.splits.get(task.id);
        if (pieces === undefined) this.splits.set(task.id, pieces = seam.split(task.interval, /** @type {string} */ (task.zone)));
        return pieces;
      }, (task, date) => {
        const key = `${task.zone}\n${date}`;
        let span = this.spans.get(key);
        if (span === undefined) this.spans.set(key, span = seam.span(/** @type {string} */ (task.zone), date));
        return span;
      }, () => false));
      return Object.freeze({ kind: /** @type {const} */ ('days'), list, days });
    }
    catch {
      return BROKEN;
    }
  }

  /**
   * Keep a resource's days, and what a scoring charges for them: one per
   * split task and piece, one per distinct day span, over every resource
   * whose days can be told.
   * @param {number} at @param {DayState} next
   * @returns {DayState} the days it held
   */
  setDays(at, next) {
    const before = this.dayStates[at];
    const id = this.index.resources[at].id;
    this.charge(before, -1);
    this.charge(next, 1);
    const table = /** @type {import('./day-table.js').DayTable} */ (this.context.days);
    table.byResource.delete(id);
    table.byKey.delete(id);
    table.zoneless.delete(id);
    if (next.kind === 'zoneless') table.zoneless.set(id, next.tasks);
    else if (next.kind === 'days') {
      table.byResource.set(id, next.days);
      table.byKey.set(id, new Map(next.days.map((day) => [`${day.zone}\n${day.date}`, day])));
    }
    this.dayStates[at] = next;
    return before;
  }

  /** @param {DayState} state @param {1 | -1} by */
  charge(state, by) {
    if (state.kind !== 'days') return;
    for (const assignment of state.list) {
      const refs = (this.taskRefs.get(assignment.task) ?? 0) + by;
      this.taskRefs.set(assignment.task, refs);
      if (refs === (by > 0 ? 1 : 0)) this.dayWork += by * (1 + /** @type {readonly unknown[]} */ (this.splits.get(assignment.task)).length);
    }
    for (const day of state.days) {
      const key = `${day.zone}\n${day.date}`;
      const refs = (this.spanRefs.get(key) ?? 0) + by;
      this.spanRefs.set(key, refs);
      if (refs === (by > 0 ? 1 : 0)) this.dayWork += by;
    }
  }

  /**
   * Evaluate one row of a rule: its units as a scoring would.
   * @param {RuleState} state @param {number} at
   * @returns {Entry[]}
   */
  evaluateRow(state, at) {
    const scope = state.rule.scope;
    if (scope !== 'resource-day') {
      const unit = scope === 'global' ? this.units.global[0] : this.units[scope][at];
      return [this.evaluate(state, unit)];
    }
    const id = this.index.resources[at].id;
    const days = this.dayStates[at];
    if (days.kind === 'none') return [];
    if (days.kind === 'broken') return [failed(Object.freeze({ date: null, id, scope, zone: null }))];
    if (days.kind === 'zoneless') {
      const unit = Object.freeze({ date: null, id, scope, zone: null });
      const unknowns = noZoneOf(state.rule, unit, id, days.tasks);
      return [{ unit, failed: false, matches: EMPTY, unknowns, sum: 0n, work: unknowns.length, asked: EMPTY, counted: false }];
    }
    return days.days.map((day) => this.evaluate(state, Object.freeze({ date: day.date, id, scope, zone: day.zone })));
  }

  /**
   * @param {RuleState} state @param {RuleUnit} unit
   * @returns {Entry}
   */
  evaluate(state, unit) {
    const context = this.context;
    context.work = 0;
    context.stopped = false;
    context.asked = [];
    context.wide = false;
    this.counts.evaluated++;
    this.evaluatedNow++;
    /** @type {ReturnType<typeof evaluateUnit>} */
    let answer;
    try {
      answer = evaluateUnit(this.index, context, state.view, state.rule, unit);
    }
    catch {
      answer = null;
    }
    if (context.wide) state.wide = true;
    if (answer === null) return failed(unit);
    return { unit, failed: false, matches: answer.matches, unknowns: answer.unknowns, sum: answer.sum, work: context.work, asked: context.asked, counted: true };
  }

  /**
   * The result of the kept answers, or null when a scoring would stop at
   * a limit or a kept answer failed: a scoring then answers.
   * @returns {AssignResult | null}
   */
  assemble() {
    const counts = { rules: this.rules.length, units: 0, matches: 0, unknowns: 0, work: 0 };
    /** @type {AssignMatch[]} */
    const matches = [];
    /** @type {AssignUnknown[]} */
    const unknowns = [];
    const sums = { hard: 0n, service: 0n, soft: 0n };
    const asked = new Set();
    let hardUnknown = false;
    let days = false;
    let entries = 0;
    for (const state of this.rules) {
      const hard = state.rule.level === 'hard';
      if (state.missing !== null) {
        for (const unknown of state.missing) unknowns.push(unknown);
        counts.unknowns += state.missing.length;
        counts.work += state.missing.length;
        hardUnknown ||= hard;
        continue;
      }
      if (state.rule.scope === 'resource-day' && !days) {
        days = true;
        counts.work += this.dayWork;
      }
      let sum = 0n;
      for (const row of state.rows)
        for (const entry of row) {
          if (entry.failed) return null;
          entries++;
          if (entry.counted) counts.units++;
          counts.work += entry.work;
          for (const key of entry.asked)
            if (!asked.has(key)) {
              asked.add(key);
              counts.work += /** @type {number} */ (this.context.costs.get(key));
            }
          for (const match of entry.matches) matches.push(match);
          for (const unknown of entry.unknowns) unknowns.push(unknown);
          counts.matches += entry.matches.length;
          counts.unknowns += entry.unknowns.length;
          hardUnknown ||= hard && entry.unknowns.length > 0;
          sum += entry.sum;
        }
      sums[state.rule.level] += sum;
    }
    const limits = this.limits;
    if (counts.units > limits.maxUnits || counts.matches > limits.maxMatches || counts.work > limits.maxWork) return null;
    this.counts.reused += entries - this.evaluatedNow;
    return Object.freeze({
      complete: /** @type {const} */ (true),
      counts: Object.freeze(counts),
      matches: Object.freeze(matches),
      provenance: provenanceOf(this.index, this.set, this.list, this.days, listKey(this.list)),
      score: scoreOf(sums),
      unknowns: Object.freeze(unknowns),
      verdict: sums.hard < 0n ? 'infeasible-by-validation' : hardUnknown ? 'unknown' : 'feasible',
    });
  }

  /**
   * The answer of the current state: the kept answers, else a scoring.
   * @returns {AssignResult}
   * @throws {AssignError} what the scoring throws
   */
  answer() {
    const result = this.assemble();
    this.evaluatedNow = 0;
    if (result !== null) return result;
    this.counts.fullScorings++;
    return scoreAssignment(this.index.problem, this.set, this.list,
      this.days === undefined ? { limits: this.limits } : { limits: this.limits, days: this.days });
  }

  /**
   * Make an edit to the assignment list, re-evaluate the rows it touched
   * and answer; `undo` collects how to take it all back.
   * @param {readonly Assignment[]} removed @param {readonly Assignment[]} added
   * @param {(() => void)[]} undo
   * @returns {AssignResult}
   */
  edit(removed, added, undo) {
    const context = this.context;
    const tasks = new Set();
    const resources = new Set();
    const before = { list: this.list, assignments: context.assignments };
    undo.push(() => {
      this.list = before.list;
      context.assignments = before.assignments;
    });
    for (const [item, add] of [...removed.map((a) => /** @type {const} */ ([a, false])), ...added.map((a) => /** @type {const} */ ([a, true]))]) {
      this.list = edited(this.list, item, compareAssignments, add);
      for (const [map, key, order] of /** @type {const} */ ([[context.byTask, item.task, compareAssignments], [context.byResource, item.resource, this.byTime]])) {
        const old = map.get(key);
        const next = edited(old ?? EMPTY, item, order, add);
        if (next.length === 0) map.delete(key);
        else map.set(key, next);
        undo.push(() => {
          if (old === undefined) map.delete(key);
          else map.set(key, old);
        });
      }
      tasks.add(/** @type {number} */ (this.taskAt.get(item.task)));
      resources.add(/** @type {number} */ (this.resourceAt.get(item.resource)));
    }
    context.assignments = this.list;
    if (this.needDays)
      for (const at of resources) {
        const old = this.setDays(at, this.dayStateOf(this.index.resources[at].id));
        undo.push(() => this.setDays(at, old));
      }
    for (const state of this.rules) {
      if (state.missing !== null) continue;
      const scope = state.rule.scope;
      const wide = state.wide;
      undo.push(() => {
        state.wide = wide;
      });
      /** @type {Iterable<number>} */
      let rows;
      if (scope === 'global') rows = [0];
      else if (wide) {
        rows = this.rowsOf(state);
        this.counts.fullFallbacks++;
      }
      else rows = scope === 'task' ? tasks : resources;
      for (const at of rows) {
        const old = state.rows[at];
        state.rows[at] = this.evaluateRow(state, at);
        undo.push(() => {
          state.rows[at] = old;
        });
      }
    }
    return this.answer();
  }
}

/**
 * The answer of a state whose every rule was just evaluated over every
 * unit: one full scoring, whether the kept answers or a scoring answer.
 * @param {State} state
 * @returns {AssignResult}
 */
function fresh(state) {
  const before = state.counts.fullScorings;
  const result = state.answer();
  if (state.counts.fullScorings === before) state.counts.fullScorings++;
  return result;
}

/**
 * @param {RuleUnit} unit
 * @returns {Entry}
 */
function failed(unit) {
  return { unit, failed: true, matches: EMPTY, unknowns: EMPTY, sum: 0n, work: 0, asked: EMPTY, counted: false };
}

/**
 * Score one assignment list and keep the answer per rule and unit, so
 * edits re-evaluate only what they touch. Made by {@link createEvaluator}.
 */
export class AssignEvaluator {
  /** @type {State | null} */
  #state;
  /** @type {AssignResult} */
  #result;
  /** @type {readonly Assignment[]} */
  #assignments;
  /** @type {EvaluatorCounts} */
  #counts;

  /**
   * @param {State} state - every rule just evaluated over every unit
   */
  constructor(state) {
    this.#state = state;
    this.#counts = state.counts;
    this.#assignments = state.list;
    this.#result = fresh(state);
    Object.freeze(this);
  }

  /**
   * The answer for the current state: the bytes `scoreAssignment` answers
   * for the same problem, rule set, assignments and options.
   * @returns {AssignResult}
   */
  get result() {
    return this.#result;
  }

  /**
   * The current assignment list, admitted: frozen, sorted by task, slot
   * and resource.
   * @returns {readonly Assignment[]}
   */
  get assignments() {
    return this.#assignments;
  }

  /**
   * What the evaluator did since it was created, as a frozen copy.
   * @returns {Readonly<EvaluatorCounts>}
   */
  get counts() {
    return Object.freeze({ ...this.#counts });
  }

  /**
   * Make an edit and answer the new state's result.
   * @param {AssignEdit} edit
   * @returns {AssignResult}
   * @throws {AssignError} JN0023 for an edit out of form or to a closed evaluator,
   *   JN0002/JN0007/JN0008 for an assignment the edit cannot make, and what
   *   `scoreAssignment` throws for the new state; the state is then unchanged
   */
  apply(edit) {
    return this.#step(edit, true);
  }

  /**
   * Answer the result an edit would have, changing nothing: the state,
   * `result` and `assignments` stay as they were.
   * @param {AssignEdit} edit
   * @returns {AssignResult}
   * @throws {AssignError} as {@link AssignEvaluator#apply}
   */
  whatIf(edit) {
    return this.#step(edit, false);
  }

  /**
   * Drop the kept answers. `result` and `assignments` still answer the
   * last state; an edit after this is refused. Closing twice is closing once.
   */
  close() {
    this.#state = null;
  }

  /**
   * @param {unknown} raw @param {boolean} commit
   * @returns {AssignResult}
   */
  #step(raw, commit) {
    const state = this.#state;
    if (state === null) throw new AssignError('JN0023', 'the evaluator is closed', '/edit');
    const edit = editOf(raw);
    if (edit.op === 'revise') return this.#revise(state, edit, commit);
    const { removed, added } = changeOf(state, edit);
    /** @type {AssignResult} */
    let result;
    if (removed.length === 0 && added.length === 0) result = this.#result;
    else {
      /** @type {(() => void)[]} */
      const undo = [];
      try {
        result = state.edit(removed, added, undo);
      }
      catch (error) {
        for (let i = undo.length - 1; i >= 0; i--) undo[i]();
        throw error;
      }
      if (commit) {
        this.#result = result;
        this.#assignments = state.list;
      }
      else for (let i = undo.length - 1; i >= 0; i--) undo[i]();
    }
    if (commit) this.#counts.edits++;
    else this.#counts.previews++;
    return result;
  }

  /**
   * @param {State} state @param {Record<string, unknown>} edit @param {boolean} commit
   * @returns {AssignResult}
   */
  #revise(state, edit, commit) {
    const names = Object.keys(edit).filter((key) => key !== 'op');
    if (names.length === 0) throw new AssignError('JN0023', 'a revise edit names a problem, a rule set, days or assignments', '/edit');
    const index = edit.problem === undefined ? state.index : indexOfProblem(edit.problem);
    const set = edit.ruleSet === undefined ? state.set : ruleSetOf(edit.ruleSet);
    const days = edit.days === undefined ? state.days : /** @type {CivilDays} */ (edit.days);
    const seam = edit.days === undefined ? state.seam : seamOf({ days });
    /** @type {AssignResult} */
    let result;
    if (index === state.index && set === state.set && days === state.days && edit.assignments === undefined) result = this.#result;
    else {
      const list = admitAssignmentList(index, edit.assignments ?? state.list, '/assignments');
      if (seam === null && set.rules.some((rule) => rule.scope === 'resource-day'))
        throw new AssignError('JN0021', 'a resource-day rule needs options.days, from civilDays in @jarenjs/core/assign/days', '/options/days');
      if (commit) {
        const next = new State(index, set, state.limits, seam, days, list, this.#counts);
        result = fresh(next);
        this.#state = next;
        this.#result = result;
        this.#assignments = next.list;
      }
      else {
        this.#counts.fullScorings++;
        result = scoreAssignment(index.problem, set, list, days === undefined ? { limits: state.limits } : { limits: state.limits, days });
      }
    }
    if (commit) this.#counts.edits++;
    else this.#counts.previews++;
    return result;
  }
}

/**
 * The assignments an edit removes and adds, checked against the state:
 * what it removes exists, and what it adds is neither held twice nor
 * past its slot's count.
 * @param {State} state @param {Record<string, unknown> & { op: string }} edit
 * @returns {{ removed: Assignment[], added: Assignment[] }}
 */
function changeOf(state, edit) {
  const index = state.index;
  const held = (/** @type {{ task: string, slot: string, resource: string }} */ target, /** @type {string} */ path) => {
    const found = state.context.byTask.get(target.task)?.find((item) => item.slot === target.slot && item.resource === target.resource);
    if (found === undefined)
      throw new AssignError('JN0023', `the assignments hold no ${JSON.stringify(target.resource)} in slot ${JSON.stringify(target.slot)} of task ${JSON.stringify(target.task)}`, path);
    return found;
  };
  /** @type {Assignment[]} */
  let removed = [];
  /** @type {Assignment[]} */
  let added = [];
  if (edit.op === 'assign') {
    const target = targetOf(index, edit, 'resource', '/edit');
    if (edit.lock !== undefined && edit.lock !== 'hard' && edit.lock !== 'soft') throw new AssignError('JN0001', 'a lock is hard or soft', '/edit/lock');
    added = [assignmentOf(target, /** @type {'hard' | 'soft' | undefined} */ (edit.lock))];
  }
  else if (edit.op === 'unassign') removed = [held(targetOf(index, edit, 'resource', '/edit'), '/edit')];
  else if (edit.op === 'move') {
    const source = targetOf(index, edit, 'from', '/edit');
    const to = targetOf(index, edit, 'to', '/edit');
    const from = held(source, '/edit/from');
    removed = [from];
    added = [assignmentOf(to, from.lock)];
  }
  else {
    /** @type {{ task: string, slot: string, resource: string }[]} */
    const targets = [];
    for (const name of ['a', 'b']) {
      const value = edit[name];
      if (!isRecord(value)) throw new AssignError('JN0023', `${name} is { task, slot, resource }`, `/edit/${name}`);
      for (const key of Object.keys(value))
        if (key !== 'task' && key !== 'slot' && key !== 'resource') throw new AssignError('JN0023', `${key} is not a member of a swapped assignment`, `/edit/${name}/${pointer(key)}`);
      targets.push(targetOf(index, value, 'resource', `/edit/${name}`));
    }
    const a = held(targets[0], '/edit/a');
    const b = held(targets[1], '/edit/b');
    if (a !== b) {
      removed = [a, b];
      added = [assignmentOf({ task: a.task, slot: a.slot, resource: b.resource }, a.lock), assignmentOf({ task: b.task, slot: b.slot, resource: a.resource }, b.lock)];
    }
  }
  const key = (/** @type {Assignment} */ item) => JSON.stringify([item.task, item.slot, item.resource, item.lock ?? null]);
  const gone = new Set(removed.map(key));
  if (removed.length === added.length && added.every((item) => gone.has(key(item)))) return { removed: [], added: [] };
  /** @type {Map<string, number>} */
  const filled = new Map();
  for (const item of added) {
    const slotKey = JSON.stringify([item.task, item.slot]);
    const holders = (state.context.byTask.get(item.task) ?? EMPTY).filter((other) => other.slot === item.slot && !removed.includes(other));
    if (holders.some((other) => other.resource === item.resource) || added.some((other) => other !== item && compareAssignments(other, item) === 0))
      throw new AssignError('JN0008', `resource ${JSON.stringify(item.resource)} fills slot ${JSON.stringify(item.slot)} of task ${JSON.stringify(item.task)} twice`, '/edit');
    const count = /** @type {import('./model.js').AssignDemand} */ (/** @type {Map<string, import('./model.js').AssignDemand>} */ (index.demandsByTask.get(item.task)).get(item.slot)).count;
    const total = (filled.get(slotKey) ?? holders.length) + 1;
    filled.set(slotKey, total);
    if (total > count)
      throw new AssignError('JN0008', `slot ${JSON.stringify(item.slot)} of task ${JSON.stringify(item.task)} takes ${count}, not ${total}`, '/edit');
  }
  return { removed, added };
}

/**
 * An admitted assignment: frozen, keys as admission writes them.
 * @param {{ task: string, slot: string, resource: string }} target @param {'hard' | 'soft' | undefined} lock
 * @returns {Assignment}
 */
function assignmentOf(target, lock) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (lock !== undefined) out.lock = lock;
  out.resource = target.resource;
  out.slot = target.slot;
  out.task = target.task;
  return /** @type {Assignment} */ (Object.freeze(out));
}

/**
 * Score an assignment list and keep the answer per rule and unit, so an
 * edit re-evaluates only the units it touches: `apply(edit)` makes the
 * edit and answers the new result, `whatIf(edit)` answers the result the
 * edit would have and changes nothing, and each answer is the bytes a
 * fresh {@link scoreAssignment} of the same problem, rule set,
 * assignments and options answers - counts, provenance and refusals
 * included.
 *
 * A unit's row is its task (`task`) or its resource with that
 * resource's days (`resource`, `resource-day`); an edit touches the rows
 * of the tasks and resources it names, and `global` rules are evaluated
 * on every edit. The scope is the declaration: a rule one of whose units
 * reads assignments outside its row (`assignments()`, another task's or
 * another resource's) is from then on evaluated over every unit of its
 * scope on every edit, counted in `counts.fullFallbacks`, so its answers
 * stay exact. A rule must be pure: what it reads past the view (host
 * state in a closure) the evaluator cannot see.
 *
 * Past a limit, or when a kept answer failed (a rule threw or answered
 * out of contract, or the seam refused a task), the answer is a full
 * scoring, counted in `counts.fullScorings`: typed incomplete with no
 * total, or the scoring's refusal, and a refused edit changes nothing.
 * A `revise` edit (a new problem, rule set, days seam or assignment
 * list) evaluates every rule again; an object it names that is the one
 * already held changes nothing.
 * @param {unknown} problem - admitted with `admitProblem` when it is not yet
 * @param {RuleSet} ruleSet - from `registerRules`
 * @param {unknown} assignments - checked as `scoreAssignment` checks them
 * @param {{ limits?: AssignLimits, days?: CivilDays }} [options] - as `scoreAssignment` takes them
 * @returns {AssignEvaluator}
 * @throws {AssignError} what `scoreAssignment` throws for the same arguments
 */
export function createEvaluator(problem, ruleSet, assignments, options = undefined) {
  const index = indexOfProblem(problem);
  const set = ruleSetOf(ruleSet);
  const limits = limitsOf(options);
  const seam = seamOf(options);
  if (seam === null && set.rules.some((rule) => rule.scope === 'resource-day'))
    throw new AssignError('JN0021', 'a resource-day rule needs options.days, from civilDays in @jarenjs/core/assign/days', '/options/days');
  const list = admitAssignmentList(index, assignments, '/assignments');
  const days = /** @type {CivilDays | undefined} */ (/** @type {any} */ (options)?.days);
  return new AssignEvaluator(new State(index, set, limits, seam, days, list,
    { edits: 0, previews: 0, evaluated: 0, reused: 0, fullFallbacks: 0, fullScorings: 0 }));
}
