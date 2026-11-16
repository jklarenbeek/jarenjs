//@ts-check

import { AssignError } from './errors.js';
import { compareIds, isRecord, pointer } from './model.js';

/** @typedef {import('./model.js').ProblemIndex} ProblemIndex */
/** @typedef {import('./model.js').Assignment} Assignment */
/** @typedef {import('./model.js').AssignTask} AssignTask */
/** @typedef {import('./model.js').AssignResource} AssignResource */
/** @typedef {import('./model.js').AssignDemand} AssignDemand */
/** @typedef {import('./model.js').AssignFact} AssignFact */
/** @typedef {import('./rules.js').RegisteredRule} RegisteredRule */

/** What a view throws when a rule's reads pass `maxWork`. */
const WORK_LIMIT = /* @__PURE__ */ Object.freeze({ limit: 'maxWork' });

const EMPTY = /* @__PURE__ */ Object.freeze([]);

/**
 * The indexes of one scoring: an admitted problem with one candidate
 * assignment list, and the work counter every view charges.
 */
export class EvaluationContext {
  /**
   * @param {ProblemIndex} index
   * @param {readonly Assignment[]} assignments - admitted, sorted by task, slot and resource
   * @param {number} maxWork
   */
  constructor(index, assignments, maxWork) {
    this.index = index;
    this.assignments = assignments;
    this.maxWork = maxWork;
    this.work = 0;
    this.stopped = false;
    /** @type {Map<string, Assignment[]>} */
    const byTask = new Map();
    /** @type {Map<string, Assignment[]>} */
    const byResource = new Map();
    for (const assignment of assignments) {
      const forTask = byTask.get(assignment.task);
      if (forTask === undefined) byTask.set(assignment.task, [assignment]);
      else forTask.push(assignment);
      const ofResource = byResource.get(assignment.resource);
      if (ofResource === undefined) byResource.set(assignment.resource, [assignment]);
      else ofResource.push(assignment);
    }
    const taskById = index.taskById;
    const byTime = (/** @type {Assignment} */ a, /** @type {Assignment} */ b) => {
      const x = /** @type {AssignTask} */ (taskById.get(a.task)).interval;
      const y = /** @type {AssignTask} */ (taskById.get(b.task)).interval;
      return x.start - y.start || x.end - y.end || compareIds(a.task, b.task) || compareIds(a.slot, b.slot);
    };
    /** @type {Map<string, readonly Assignment[]>} */
    this.byTask = new Map([...byTask].map(([id, list]) => [id, Object.freeze(list)]));
    /** @type {Map<string, readonly Assignment[]>} */
    this.byResource = new Map([...byResource].map(([id, list]) => [id, Object.freeze(list.sort(byTime))]));
    this.byStart = Object.freeze([...index.tasks].sort((a, b) =>
      a.interval.start - b.interval.start || a.interval.end - b.interval.end || compareIds(a.id, b.id)));
    // The longest task bounds the window scan; a length past the safe
    // integers (start and end of opposite sign far out) is not exact as a
    // number, so the scan then starts at the first task.
    let longest = 0;
    for (const task of index.tasks) {
      const length = task.interval.end - task.interval.start;
      longest = Number.isSafeInteger(length) ? Math.max(longest, length) : Number.POSITIVE_INFINITY;
    }
    this.longest = longest;
    /** @type {Map<string, Map<string, Map<unknown, readonly unknown[]>>>} */
    this.factIndexes = new Map();
  }

  /**
   * Count `rows` rows answered, plus the call; past `maxWork` stop.
   * @param {number} rows
   */
  charge(rows) {
    this.work += 1 + rows;
    if (this.work > this.maxWork) {
      this.stopped = true;
      throw WORK_LIMIT;
    }
  }
}

/**
 * The read-only, indexed view a rule evaluates against. It answers only
 * frozen data, in code-unit id order (or time order where it says so),
 * and every answer counts toward `maxWork`. A rule reads only the fact
 * tables it declares.
 */
export class AssignView {
  /** @type {EvaluationContext} */
  #context;
  /** @type {RegisteredRule} */
  #rule;

  /**
   * @param {EvaluationContext} context
   * @param {RegisteredRule} rule
   */
  constructor(context, rule) {
    this.#context = context;
    this.#rule = rule;
    Object.freeze(this);
  }

  /**
   * Every resource, sorted by id.
   * @returns {readonly AssignResource[]}
   */
  resources() {
    const list = this.#context.index.resources;
    this.#context.charge(list.length);
    return list;
  }

  /**
   * Every task, sorted by id.
   * @returns {readonly AssignTask[]}
   */
  tasks() {
    const list = this.#context.index.tasks;
    this.#context.charge(list.length);
    return list;
  }

  /**
   * @param {string} id
   * @returns {AssignResource | undefined}
   */
  resource(id) {
    this.#context.charge(1);
    return this.#context.index.resourceById.get(id);
  }

  /**
   * @param {string} id
   * @returns {AssignTask | undefined}
   */
  task(id) {
    this.#context.charge(1);
    return this.#context.index.taskById.get(id);
  }

  /**
   * @param {string} task @param {string} slot
   * @returns {AssignDemand | undefined}
   */
  demand(task, slot) {
    this.#context.charge(1);
    return this.#context.index.demandsByTask.get(task)?.get(slot);
  }

  /**
   * Every scored assignment, sorted by task, slot and resource.
   * @returns {readonly Assignment[]}
   */
  assignments() {
    const list = this.#context.assignments;
    this.#context.charge(list.length);
    return list;
  }

  /**
   * The scored assignments of one resource, in task time order (start,
   * end, task id, slot).
   * @param {string} resource
   * @returns {readonly Assignment[]}
   */
  assignmentsOf(resource) {
    const list = this.#context.byResource.get(resource) ?? EMPTY;
    this.#context.charge(list.length);
    return list;
  }

  /**
   * The scored assignments of one task, sorted by slot and resource.
   * @param {string} task
   * @returns {readonly Assignment[]}
   */
  assignmentsFor(task) {
    const list = this.#context.byTask.get(task) ?? EMPTY;
    this.#context.charge(list.length);
    return list;
  }

  /**
   * The tasks whose interval overlaps `[start, end)`, in time order.
   * @param {number} start @param {number} end
   * @returns {readonly AssignTask[]}
   */
  tasksOverlapping(start, end) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end)
      throw new AssignError('JN0005', 'tasksOverlapping takes safe integers with start before end');
    const context = this.#context;
    const list = context.byStart;
    const low = start - context.longest;
    const from = Number.isSafeInteger(low) ? firstAtOrAfter(list, low + 1) : 0;
    const to = firstAtOrAfter(list, end);
    const out = [];
    for (let i = from; i < to; i++) if (list[i].interval.end > start) out.push(list[i]);
    context.charge(to - from);
    return Object.freeze(out);
  }

  /**
   * A fact table this rule declares in `reads.facts`.
   * @param {string} name
   * @returns {AssignFact}
   */
  fact(name) {
    const table = this.#table(name);
    this.#context.charge(table.rows.length);
    return table;
  }

  /**
   * The rows of a declared fact table whose `member` is `value`
   * (SameValueZero), in the table's order; indexed on first use.
   * @param {string} name @param {string} member @param {unknown} value
   * @returns {readonly unknown[]}
   */
  factRows(name, member, value) {
    const table = this.#table(name);
    const context = this.#context;
    let byMember = context.factIndexes.get(name);
    if (byMember === undefined) context.factIndexes.set(name, byMember = new Map());
    let byValue = byMember.get(member);
    if (byValue === undefined) {
      /** @type {Map<unknown, unknown[]>} */
      const groups = new Map();
      for (const row of table.rows) {
        if (!isRecord(row) || !Object.hasOwn(row, member)) continue;
        const group = groups.get(row[member]);
        if (group === undefined) groups.set(row[member], [row]);
        else group.push(row);
      }
      byValue = new Map([...groups].map(([key, rows]) => [key, Object.freeze(rows)]));
      byMember.set(member, byValue);
      context.charge(table.rows.length);
    }
    const rows = byValue.get(value) ?? EMPTY;
    context.charge(rows.length);
    return rows;
  }

  /**
   * The problem's stored assignments (with their locks), sorted by task,
   * slot and resource; the scored list is {@link AssignView#assignments}.
   * @returns {readonly Assignment[]}
   */
  stored() {
    const list = /** @type {readonly Assignment[]} */ (this.#context.index.problem.assignments);
    this.#context.charge(list.length);
    return list;
  }

  /**
   * The problem's baseline, or null when it has none.
   * @returns {import('./model.js').AssignBaseline | null}
   */
  baseline() {
    const baseline = this.#context.index.problem.baseline ?? null;
    this.#context.charge(baseline === null ? 0 : baseline.assignments.length);
    return baseline;
  }

  /**
   * The problem's own attributes (host data), or null.
   * @returns {Readonly<Record<string, unknown>> | null}
   */
  attributes() {
    this.#context.charge(0);
    return this.#context.index.problem.attributes ?? null;
  }

  /**
   * @param {string} name
   * @returns {AssignFact}
   */
  #table(name) {
    if (!this.#rule.reads.facts.includes(name))
      throw new AssignError('JN0018', `rule ${JSON.stringify(this.#rule.id)} reads fact ${JSON.stringify(name)} it does not declare`, `/rules/${pointer(this.#rule.id)}/reads/facts`);
    return /** @type {Record<string, AssignFact>} */ (this.#context.index.problem.facts)[name];
  }
}

/**
 * The first index whose task starts at or after `at`.
 * @param {readonly AssignTask[]} list @param {number} at
 * @returns {number}
 */
function firstAtOrAfter(list, at) {
  let low = 0, high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (list[mid].interval.start < at) low = mid + 1;
    else high = mid;
  }
  return low;
}
