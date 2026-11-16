//@ts-check

import { AssignError } from './errors.js';

/**
 * An interval in epoch milliseconds (or any integer time unit the host
 * declares), half-open: it holds `start` and stops just before `end`.
 * @typedef {Object} AssignInterval
 * @property {number} start
 * @property {number} end
 */

/** @typedef {string | number} Revision a non-empty string or a whole number from 0 */

/**
 * @typedef {Object} AssignResource
 * @property {string} id
 * @property {Revision} revision
 * @property {Record<string, unknown>} [attributes] - host data, never read by the engine
 */

/**
 * One demand slot of a task: `count` resources may fill it.
 * @typedef {Object} AssignDemand
 * @property {string} slot
 * @property {number} count
 * @property {Record<string, unknown>} [attributes] - host data, never read by the engine
 */

/**
 * @typedef {Object} AssignTask
 * @property {string} id
 * @property {Revision} revision
 * @property {AssignInterval} interval
 * @property {AssignDemand[]} demands
 * @property {Record<string, unknown>} [attributes] - host data, never read by the engine
 * @property {string} [zone] - the zone the task's civil days are told in, such as
 *   `Europe/Amsterdam`; read only by `resource-day` rules, and a task without
 *   one has days nobody can tell (an unknown `no-zone`, never UTC)
 */

/**
 * One resource filling one slot of one task. `lock` is kept as data:
 * scoring does not read it, and `solve`'s `local` strategy holds a
 * `hard` one and changes a `soft` one only as churn against the baseline.
 * @typedef {Object} Assignment
 * @property {string} task
 * @property {string} slot
 * @property {string} resource
 * @property {'hard' | 'soft'} [lock]
 */

/**
 * A named, revisioned table of host rows; only rules read it.
 * @typedef {Object} AssignFact
 * @property {Revision} revision
 * @property {unknown[]} rows
 */

/**
 * @typedef {Object} AssignBaseline
 * @property {Revision} revision
 * @property {Assignment[]} assignments
 */

/**
 * An assignment problem as plain JSON. The admitted form has every
 * object's keys written in code-unit order, resources and tasks sorted by id,
 * demands by slot and assignments by task, slot and resource; `facts`
 * and `assignments` default to empty.
 * @typedef {Object} AssignProblem
 * @property {Revision} revision
 * @property {AssignResource[]} resources
 * @property {AssignTask[]} tasks
 * @property {Record<string, AssignFact>} [facts]
 * @property {Assignment[]} [assignments]
 * @property {AssignBaseline} [baseline]
 * @property {Record<string, unknown>} [attributes] - host data, never read by the engine
 */

/**
 * The engine's own index of an admitted problem.
 * @typedef {Object} ProblemIndex
 * @property {AssignProblem} problem
 * @property {readonly AssignResource[]} resources
 * @property {readonly AssignTask[]} tasks
 * @property {Map<string, AssignResource>} resourceById
 * @property {Map<string, AssignTask>} taskById
 * @property {Map<string, Map<string, AssignDemand>>} demandsByTask
 */

/** How deep host data may nest. */
const MAX_DEPTH = 64;

/** @type {WeakMap<object, ProblemIndex>} */
const ADMITTED = new WeakMap();

/**
 * Code-unit order, the one order every id is sorted by.
 * @param {string} a @param {string} b
 * @returns {number}
 */
export function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A JSON Pointer token.
 * @param {string | number} token
 * @returns {string}
 */
export function pointer(token) {
  return String(token).replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Define an own enumerable member, so an id such as `__proto__` stays data.
 * @param {Record<string, unknown>} target @param {string} key @param {unknown} value
 */
function put(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * A frozen copy of host JSON with every object's keys written in
 * code-unit order (integer-like keys still enumerate first, as JavaScript
 * lists them); anything JSON cannot hold is refused.
 * @param {unknown} value @param {string} path @param {number} [depth]
 * @returns {unknown}
 */
export function jsonCopy(value, path, depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AssignError('JN0009', `${String(value)} is not a JSON number`, path);
    return value;
  }
  if (depth >= MAX_DEPTH) throw new AssignError('JN0009', `the value nests deeper than ${MAX_DEPTH} levels, or holds a cycle`, path);
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i++) out.push(jsonCopy(value[i], `${path}/${i}`, depth + 1));
    return Object.freeze(out);
  }
  if (isRecord(value)) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(value).sort(compareIds)) put(out, key, jsonCopy(value[key], `${path}/${pointer(key)}`, depth + 1));
    return Object.freeze(out);
  }
  throw new AssignError('JN0009', `a ${typeof value === 'object' ? 'non-plain object' : typeof value} is not JSON`, path);
}

/**
 * Refuse a member this shape does not define, or a missing required one.
 * @param {unknown} value @param {string} path @param {string} what
 * @param {readonly string[]} required @param {readonly string[]} optional
 * @returns {Record<string, unknown>}
 */
function shape(value, path, what, required, optional) {
  if (!isRecord(value)) throw new AssignError('JN0001', `${what} is an object`, path);
  for (const key of required)
    if (!Object.hasOwn(value, key)) throw new AssignError('JN0001', `${what} has no ${key}`, `${path}/${key}`);
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.includes(key))
      throw new AssignError('JN0001', `${key} is not a member of ${what}`, `${path}/${pointer(key)}`);
  return value;
}

/**
 * @param {unknown} value @param {string} path
 * @returns {string}
 */
export function idOf(value, path) {
  if (typeof value !== 'string' || value.length === 0) throw new AssignError('JN0002', 'an id is a non-empty string', path);
  return value;
}

/**
 * @param {unknown} value @param {string} path
 * @returns {Revision}
 */
export function revisionOf(value, path) {
  if ((typeof value === 'string' && value.length > 0) || (Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0))
    return /** @type {Revision} */ (value);
  throw new AssignError('JN0004', 'a revision is a non-empty string or a whole number from 0', path);
}

/**
 * @param {unknown} value @param {string} path
 * @returns {AssignInterval}
 */
export function intervalOf(value, path) {
  const record = shape(value, path, 'an interval', ['start', 'end'], []);
  const { start, end } = record;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || /** @type {number} */ (start) >= /** @type {number} */ (end))
    throw new AssignError('JN0005', 'an interval is { start, end } of safe integers with start before end', path);
  return Object.freeze({ end: /** @type {number} */ (end), start: /** @type {number} */ (start) });
}

/**
 * @param {unknown} value @param {string} path
 * @returns {Record<string, unknown>}
 */
function attributesOf(value, path) {
  if (!isRecord(value)) throw new AssignError('JN0001', 'attributes is an object', path);
  return /** @type {Record<string, unknown>} */ (jsonCopy(value, path));
}

/**
 * @template T
 * @param {unknown} value @param {string} path @param {string} what
 * @param {(item: unknown, path: string) => T} read
 * @returns {T[]}
 */
function listOf(value, path, what, read) {
  if (!Array.isArray(value)) throw new AssignError('JN0001', `${what} is an array`, path);
  return value.map((item, i) => read(item, `${path}/${i}`));
}

/**
 * Sort by id and refuse a repeat.
 * @template {{ id: string }} T
 * @param {T[]} items @param {string} path @param {string} what
 * @returns {readonly T[]}
 */
function uniqueById(items, path, what) {
  const order = items.map((item, i) => /** @type {[T, number]} */ ([item, i])).sort((a, b) => compareIds(a[0].id, b[0].id));
  for (let i = 1; i < order.length; i++)
    if (order[i][0].id === order[i - 1][0].id)
      throw new AssignError('JN0003', `${what} ${JSON.stringify(order[i][0].id)} is given twice`, `${path}/${order[i][1]}/id`);
  return Object.freeze(order.map(([item]) => item));
}

/**
 * @param {unknown} value @param {string} path
 * @returns {AssignResource}
 */
function resourceOf(value, path) {
  const record = shape(value, path, 'a resource', ['id', 'revision'], ['attributes']);
  /** @type {Record<string, unknown>} */
  const out = {};
  if (record.attributes !== undefined) out.attributes = attributesOf(record.attributes, `${path}/attributes`);
  out.id = idOf(record.id, `${path}/id`);
  out.revision = revisionOf(record.revision, `${path}/revision`);
  return /** @type {AssignResource} */ (Object.freeze(out));
}

/**
 * @param {unknown} value @param {string} path
 * @returns {AssignDemand}
 */
function demandOf(value, path) {
  const record = shape(value, path, 'a demand', ['slot', 'count'], ['attributes']);
  /** @type {Record<string, unknown>} */
  const out = {};
  if (record.attributes !== undefined) out.attributes = attributesOf(record.attributes, `${path}/attributes`);
  if (!Number.isSafeInteger(record.count) || /** @type {number} */ (record.count) < 1)
    throw new AssignError('JN0006', 'a demand count is a whole number from 1', `${path}/count`);
  out.count = record.count;
  out.slot = idOf(record.slot, `${path}/slot`);
  return /** @type {AssignDemand} */ (Object.freeze(out));
}

/**
 * @param {unknown} value @param {string} path
 * @returns {AssignTask}
 */
function taskOf(value, path) {
  const record = shape(value, path, 'a task', ['id', 'revision', 'interval', 'demands'], ['attributes', 'zone']);
  /** @type {Record<string, unknown>} */
  const out = {};
  if (record.attributes !== undefined) out.attributes = attributesOf(record.attributes, `${path}/attributes`);
  const demands = listOf(record.demands, `${path}/demands`, 'demands', demandOf);
  const order = demands.map((demand, i) => /** @type {[AssignDemand, number]} */ ([demand, i])).sort((a, b) => compareIds(a[0].slot, b[0].slot));
  for (let i = 1; i < order.length; i++)
    if (order[i][0].slot === order[i - 1][0].slot)
      throw new AssignError('JN0003', `slot ${JSON.stringify(order[i][0].slot)} is given twice`, `${path}/demands/${order[i][1]}/slot`);
  out.demands = Object.freeze(order.map(([demand]) => demand));
  out.id = idOf(record.id, `${path}/id`);
  out.interval = intervalOf(record.interval, `${path}/interval`);
  out.revision = revisionOf(record.revision, `${path}/revision`);
  if (record.zone !== undefined) {
    if (typeof record.zone !== 'string' || record.zone.length === 0)
      throw new AssignError('JN0001', 'a zone is a non-empty string', `${path}/zone`);
    out.zone = record.zone;
  }
  return /** @type {AssignTask} */ (Object.freeze(out));
}

/**
 * @param {unknown} value @param {string} path
 * @returns {AssignFact}
 */
function factOf(value, path) {
  const record = shape(value, path, 'a fact table', ['revision', 'rows'], []);
  if (!Array.isArray(record.rows)) throw new AssignError('JN0001', 'rows is an array', `${path}/rows`);
  return Object.freeze({
    revision: revisionOf(record.revision, `${path}/revision`),
    rows: /** @type {unknown[]} */ (jsonCopy(record.rows, `${path}/rows`)),
  });
}

/**
 * Check a list of assignments against an admitted problem: every task,
 * slot and resource it names exists, no (task, slot, resource) repeats
 * and no slot is filled past its count. Answers the list frozen, sorted
 * by task, slot and resource.
 * @param {ProblemIndex} index @param {unknown} value @param {string} path
 * @returns {readonly Assignment[]}
 */
export function admitAssignmentList(index, value, path) {
  const list = listOf(value, path, 'assignments', (item, at) => {
    const record = shape(item, at, 'an assignment', ['task', 'slot', 'resource'], ['lock']);
    const task = idOf(record.task, `${at}/task`);
    const slot = idOf(record.slot, `${at}/slot`);
    const resource = idOf(record.resource, `${at}/resource`);
    const demands = index.demandsByTask.get(task);
    if (demands === undefined) throw new AssignError('JN0007', `the problem holds no task ${JSON.stringify(task)}`, `${at}/task`);
    if (!demands.has(slot)) throw new AssignError('JN0007', `task ${JSON.stringify(task)} has no slot ${JSON.stringify(slot)}`, `${at}/slot`);
    if (!index.resourceById.has(resource)) throw new AssignError('JN0007', `the problem holds no resource ${JSON.stringify(resource)}`, `${at}/resource`);
    /** @type {Record<string, unknown>} */
    const out = {};
    if (record.lock !== undefined) {
      if (record.lock !== 'hard' && record.lock !== 'soft') throw new AssignError('JN0001', 'a lock is hard or soft', `${at}/lock`);
      out.lock = record.lock;
    }
    out.resource = resource;
    out.slot = slot;
    out.task = task;
    return /** @type {Assignment} */ (Object.freeze(out));
  });
  const order = list.map((item, i) => /** @type {[Assignment, number]} */ ([item, i])).sort((a, b) => compareAssignments(a[0], b[0]));
  let filled = 0;
  for (let i = 0; i < order.length; i++) {
    const [item, at] = order[i];
    const previous = i > 0 ? order[i - 1][0] : undefined;
    const sameSlot = previous !== undefined && previous.task === item.task && previous.slot === item.slot;
    if (sameSlot && previous.resource === item.resource)
      throw new AssignError('JN0008', `resource ${JSON.stringify(item.resource)} fills slot ${JSON.stringify(item.slot)} of task ${JSON.stringify(item.task)} twice`, `${path}/${at}`);
    filled = sameSlot ? filled + 1 : 1;
    const demand = /** @type {AssignDemand} */ (/** @type {Map<string, AssignDemand>} */ (index.demandsByTask.get(item.task)).get(item.slot));
    const count = demand.count;
    if (filled > count)
      throw new AssignError('JN0008', `slot ${JSON.stringify(item.slot)} of task ${JSON.stringify(item.task)} takes ${count}, not ${filled}`, `${path}/${at}`);
  }
  return Object.freeze(order.map(([item]) => item));
}

/**
 * Task, then slot, then resource, each in code-unit order.
 * @param {Assignment} a @param {Assignment} b
 * @returns {number}
 */
export function compareAssignments(a, b) {
  return compareIds(a.task, b.task) || compareIds(a.slot, b.slot) || compareIds(a.resource, b.resource);
}

/**
 * Admit an assignment problem: check it against the problem schema
 * (`@jarenjs/core/schemas/assign/problem.schema.json`) and the checks a
 * schema cannot state - unique ids, references that resolve, no slot
 * filled past its count, start before end - and answer it as frozen
 * canonical JSON. Admitting the answer again answers it unchanged.
 *
 * Resources and tasks are sorted by id, demands by slot, assignments by
 * task, slot and resource, and every object's keys are written in
 * code-unit order (JavaScript still lists integer-like keys such as `9`
 * and `10` first, in numeric order), so two problems that differ only in
 * key order or in the order of those four lists admit to the same bytes.
 * `attributes` and fact rows are host data: the engine copies them,
 * keeps their array order and never reads them.
 * @param {unknown} problem
 * @returns {AssignProblem}
 * @throws {AssignError} JN0001-JN0009, `docPath` the JSON Pointer at fault
 */
export function admitProblem(problem) {
  if (problem !== null && typeof problem === 'object' && ADMITTED.has(problem)) return /** @type {AssignProblem} */ (problem);
  const record = shape(problem, '', 'a problem', ['revision', 'resources', 'tasks'], ['facts', 'assignments', 'baseline', 'attributes']);
  /** @type {Record<string, unknown>} */
  const out = {};
  if (record.attributes !== undefined) out.attributes = attributesOf(record.attributes, '/attributes');
  const resources = uniqueById(listOf(record.resources, '/resources', 'resources', resourceOf), '/resources', 'resource');
  const tasks = uniqueById(listOf(record.tasks, '/tasks', 'tasks', taskOf), '/tasks', 'task');
  /** @type {Record<string, AssignFact>} */
  const facts = {};
  if (record.facts !== undefined) {
    if (!isRecord(record.facts)) throw new AssignError('JN0001', 'facts is an object of named tables', '/facts');
    for (const name of Object.keys(record.facts).sort(compareIds)) {
      if (name.length === 0) throw new AssignError('JN0002', 'a fact name is a non-empty string', '/facts/');
      put(facts, name, factOf(record.facts[name], `/facts/${pointer(name)}`));
    }
  }
  /** @type {ProblemIndex} */
  const index = {
    problem: /** @type {AssignProblem} */ (/** @type {unknown} */ (out)),
    resources,
    tasks,
    resourceById: new Map(resources.map((resource) => [resource.id, resource])),
    taskById: new Map(tasks.map((task) => [task.id, task])),
    demandsByTask: new Map(tasks.map((task) => [task.id, new Map(task.demands.map((demand) => [demand.slot, demand]))])),
  };
  out.assignments = admitAssignmentList(index, record.assignments ?? [], '/assignments');
  if (record.baseline !== undefined) {
    const baseline = shape(record.baseline, '/baseline', 'a baseline', ['revision', 'assignments'], []);
    out.baseline = Object.freeze({
      assignments: admitAssignmentList(index, baseline.assignments, '/baseline/assignments'),
      revision: revisionOf(baseline.revision, '/baseline/revision'),
    });
  }
  out.facts = Object.freeze(facts);
  out.resources = resources;
  out.revision = revisionOf(record.revision, '/revision');
  out.tasks = tasks;
  const admitted = /** @type {AssignProblem} */ (Object.freeze(sortedKeys(out)));
  index.problem = admitted;
  ADMITTED.set(admitted, index);
  return admitted;
}

/**
 * The same members with keys in code-unit order.
 * @param {Record<string, unknown>} record
 * @returns {Record<string, unknown>}
 */
function sortedKeys(record) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(record).sort(compareIds)) put(out, key, record[key]);
  return out;
}

/**
 * The index of a problem, admitting it first when it is not yet admitted.
 * @param {unknown} problem
 * @returns {ProblemIndex}
 */
export function indexOfProblem(problem) {
  return /** @type {ProblemIndex} */ (ADMITTED.get(admitProblem(problem)));
}
