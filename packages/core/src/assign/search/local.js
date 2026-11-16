//@ts-check
/**
 * @file The local strategy: from the evaluator's current list, improve
 * it one edit at a time, taking an edit only when it is strictly better
 * under the objective, until a sweep over every position finds none (a
 * local optimum); then, with a seed and `maxRestarts`, perturb the best
 * list with seeded edits and descend again. An assignment the search
 * holds (a lock, or one a fill keeps) is never an edit's subject: it is
 * not unassigned, moved or swapped, and the list keeps it as it is. The
 * search never makes a lock: an assignment it makes carries the lock the
 * problem's list gives that same assignment, and none when it gives none.
 */

import { mulberry32, randomInt } from '../../random.js';
import { RULE_LEVELS } from '../rules.js';
import { candidateOf, compareLevels, INCOMPLETE, slotKey, UNDECIDED } from './order.js';
import { itemKey } from './churn.js';

/** @typedef {import('../model.js').Assignment} Assignment */
/** @typedef {import('../model.js').ProblemIndex} ProblemIndex */
/** @typedef {import('../score.js').AssignResult} AssignResult */
/** @typedef {import('../incremental.js').AssignEdit} AssignEdit */
/** @typedef {import('./order.js').Candidate} Candidate */
/** @typedef {import('./churn.js').ChurnTotal} ChurnTotal */
/** @typedef {import('./solve.js').Run} Run */

/**
 * A scored state: a candidate and its churn total (null without a baseline).
 * @typedef {Candidate & { churn: number | null }} Scored
 */

/**
 * A place an edit can start from: an assignment the search may change,
 * or a slot with room. `rank` is the level of the most severe match or
 * unknown that names it (0 hard, 1 service, 2 soft, 3 none).
 * @typedef {{ item: Assignment, task: string, slot: string, rank: number }
 *   | { item: null, task: string, slot: string, rank: number }} Position
 */

/**
 * What the local search keeps fixed and carries: the keys
 * ({@link itemKey}) of the assignments it holds, the locks to give an
 * assignment it makes again, the churn total (null without a baseline),
 * the seed and the number of restarts.
 * @typedef {Object} LocalSettings
 * @property {ReadonlySet<string>} held
 * @property {ReadonlyMap<string, 'hard' | 'soft'>} locks
 * @property {ChurnTotal | null} churn
 * @property {number | null} seed
 * @property {number | null} maxRestarts
 */

/** The number of seeded edits a restart makes to the best list before it descends again. */
export const PERTURBATION = 3;

const NONE = RULE_LEVELS.length;

/**
 * Lexicographic order of two level lists over the levels `from` to `to`.
 * @param {Scored} a @param {Scored} b @param {number} from @param {number} to
 * @returns {number}
 */
function levelsFrom(a, b, from, to) {
  return compareLevels(a.upper.slice(from, to), b.upper.slice(from, to));
}

/**
 * The local objective: the class (feasible, then undecided, then
 * infeasible by validation; an incomplete scoring is never better), then
 * the hard and service levels, then the churn total (fewer first), then
 * the soft level, then the worst score. Without a baseline it is the
 * incumbent order of the other strategies.
 * @param {Scored} a @param {Scored} b
 * @returns {number} 1 when a is better, -1 when worse, 0 when equal
 */
export function compareScored(a, b) {
  if (a.cls !== b.cls) return a.cls > b.cls ? 1 : -1;
  if (a.cls === INCOMPLETE) return 0;
  const head = levelsFrom(a, b, 0, 2);
  if (head !== 0) return head;
  if (a.churn !== null && b.churn !== null && a.churn !== b.churn) return a.churn < b.churn ? 1 : -1;
  return levelsFrom(a, b, 2, 3) || compareLevels(a.lower, b.lower);
}

/**
 * The resources in each slot, and the assignments the search may change, in list order.
 * @param {readonly Assignment[]} list @param {ReadonlySet<string>} held
 * @returns {{ holders: Map<string, Set<string>>, free: Assignment[], present: Set<string> }}
 */
function shapeOf(list, held) {
  /** @type {Map<string, Set<string>>} */
  const holders = new Map();
  /** @type {Assignment[]} */
  const free = [];
  /** @type {Set<string>} */
  const present = new Set();
  for (const item of list) {
    const key = slotKey(item.task, item.slot);
    let set = holders.get(key);
    if (set === undefined) holders.set(key, set = new Set());
    set.add(item.resource);
    const own = itemKey(item.task, item.slot, item.resource);
    present.add(own);
    if (!held.has(own)) free.push(item);
  }
  return { holders, free, present };
}

/**
 * The positions of a state, the ones a severe match or unknown names
 * first: by rank, then assignments before open slots, then task, slot
 * and resource. A match names an assignment when it names its resource
 * (or no resource) and its task (or no task); it names an open slot
 * when it names its task and no resource.
 * @param {ProblemIndex} index @param {ReturnType<typeof shapeOf>} shape @param {AssignResult | null} result
 * @returns {Position[]}
 */
function positionsOf(index, shape, result) {
  /** @type {Map<string, number>} */
  const named = new Map();
  const note = (/** @type {string} */ key, /** @type {number} */ rank) => {
    if (rank < (named.get(key) ?? NONE)) named.set(key, rank);
  };
  if (result !== null && result.complete)
    for (const found of [...result.matches, ...result.unknowns]) {
      const rank = RULE_LEVELS.indexOf(found.level);
      const resources = found.subjects.resources.length === 0 ? [null] : found.subjects.resources;
      const tasks = found.subjects.tasks.length === 0 ? [null] : found.subjects.tasks;
      for (const resource of resources) for (const task of tasks) note(JSON.stringify([resource, task]), rank);
    }
  const rankOf = (/** @type {string | null} */ resource, /** @type {string} */ task) => Math.min(
    named.get(JSON.stringify([resource, task])) ?? NONE, named.get(JSON.stringify([resource, null])) ?? NONE,
    named.get(JSON.stringify([null, task])) ?? NONE, named.get(JSON.stringify([null, null])) ?? NONE);
  /** @type {Position[]} */
  const positions = shape.free.map((item) => ({ item, task: item.task, slot: item.slot, rank: rankOf(item.resource, item.task) }));
  for (const task of index.tasks)
    for (const demand of task.demands)
      if ((shape.holders.get(slotKey(task.id, demand.slot))?.size ?? 0) < demand.count)
        positions.push({ item: null, task: task.id, slot: demand.slot, rank: Math.min(named.get(JSON.stringify([null, task.id])) ?? NONE, named.get(JSON.stringify([null, null])) ?? NONE) });
  const order = new Map(positions.map((position, at) => [position, at]));
  return positions.sort((a, b) => a.rank - b.rank || Number(a.item === null) - Number(b.item === null)
    || /** @type {number} */ (order.get(a)) - /** @type {number} */ (order.get(b)));
}

/**
 * Whether a position still stands in the current state.
 * @param {ProblemIndex} index @param {Position} position @param {ReturnType<typeof shapeOf>} shape
 * @returns {boolean}
 */
function stands(index, position, shape) {
  if (position.item !== null) return shape.present.has(itemKey(position.task, position.slot, position.item.resource));
  const count = /** @type {import('../model.js').AssignDemand} */ (/** @type {Map<string, import('../model.js').AssignDemand>} */ (index.demandsByTask.get(position.task)).get(position.slot)).count;
  return (shape.holders.get(slotKey(position.task, position.slot))?.size ?? 0) < count;
}

/**
 * The edits a position offers, in a fixed order. An open slot: assign
 * each resource not in it (with the lock it had in the list the search
 * started from, if any). An assignment: unassign it, move it to each
 * resource not in its slot, swap it with each other assignment the
 * search may change whose slot neither resource is in.
 * @param {ProblemIndex} index @param {Position} position @param {ReturnType<typeof shapeOf>} shape
 * @param {ReadonlyMap<string, 'hard' | 'soft'>} locks
 * @returns {AssignEdit[]}
 */
function editsAt(index, position, shape, locks) {
  const { task, slot } = position;
  const here = /** @type {Set<string>} */ (shape.holders.get(slotKey(task, slot)) ?? new Set());
  /** @type {AssignEdit[]} */
  const edits = [];
  if (position.item === null) {
    for (const { id } of index.resources) if (!here.has(id)) edits.push(assignOf(task, slot, id, locks));
    return edits;
  }
  const resource = position.item.resource;
  edits.push({ op: 'unassign', task, slot, resource });
  for (const { id } of index.resources) if (!here.has(id)) edits.push({ op: 'move', task, slot, from: resource, to: id });
  for (const other of shape.free) {
    if (other.resource === resource || (other.task === task && other.slot === slot)) continue;
    if (here.has(other.resource) || /** @type {Set<string>} */ (shape.holders.get(slotKey(other.task, other.slot))).has(resource)) continue;
    edits.push({ op: 'swap', a: { task, slot, resource }, b: { task: other.task, slot: other.slot, resource: other.resource } });
  }
  return edits;
}

/**
 * An `assign` edit with the lock the problem's list gives that assignment.
 * @param {string} task @param {string} slot @param {string} resource @param {ReadonlyMap<string, 'hard' | 'soft'>} locks
 * @returns {AssignEdit}
 */
function assignOf(task, slot, resource, locks) {
  const lock = locks.get(itemKey(task, slot, resource));
  return lock === undefined ? { op: 'assign', task, slot, resource } : { op: 'assign', task, slot, resource, lock };
}

/**
 * The evaluator edits that make one search edit, so that each assignment
 * it makes carries exactly the lock the problem's list gives it: the
 * evaluator's own `move` or `swap` when the locks they carry along are
 * those, else the same change as unassigns and then assigns (the
 * evaluator's `move` and `swap` keep an assignment's lock). `undo` takes
 * back all the steps but the last, for a preview.
 * @param {AssignEdit} edit @param {ReadonlyMap<string, 'hard' | 'soft'>} locks
 * @returns {{ steps: AssignEdit[], undo: AssignEdit[] }}
 */
function stepsOf(edit, locks) {
  const lockOf = (/** @type {string} */ task, /** @type {string} */ slot, /** @type {string} */ resource) => locks.get(itemKey(task, slot, resource));
  if (edit.op === 'move') {
    const { task, slot, from, to } = edit;
    if (lockOf(task, slot, from) === lockOf(task, slot, to)) return { steps: [edit], undo: [] };
    return { steps: [{ op: 'unassign', task, slot, resource: from }, assignOf(task, slot, to, locks)], undo: [assignOf(task, slot, from, locks)] };
  }
  if (edit.op === 'swap') {
    const { a, b } = edit;
    if (lockOf(a.task, a.slot, a.resource) === lockOf(a.task, a.slot, b.resource) && lockOf(b.task, b.slot, b.resource) === lockOf(b.task, b.slot, a.resource))
      return { steps: [edit], undo: [] };
    return {
      steps: [{ op: 'unassign', ...a }, { op: 'unassign', ...b }, assignOf(a.task, a.slot, b.resource, locks), assignOf(b.task, b.slot, a.resource, locks)],
      undo: [{ op: 'unassign', task: a.task, slot: a.slot, resource: b.resource }, assignOf(b.task, b.slot, b.resource, locks), assignOf(a.task, a.slot, a.resource, locks)],
    };
  }
  return { steps: [edit], undo: [] };
}

/**
 * Improve the evaluator's list. Positions are taken in
 * {@link positionsOf} order; at each, every edit it offers is previewed
 * with `whatIf`, and the best one is applied when it is strictly better
 * than the current state ({@link compareScored}); a tie between the best
 * edits goes to the first in order, or with a seed to the one a draw of
 * `mulberry32(seed)` picks. A sweep that applies nothing ends a descent.
 * Then, while restarts are left (`maxRestarts`, which needs a seed), the
 * best list so far is restored and given {@link PERTURBATION} seeded
 * edits, each counted as a move, and the search descends again. The
 * answer is the best state the search held, which a stop by a budget or
 * the signal does not change. An edit made of several evaluator edits
 * ({@link stepsOf}) is made whole or not at all: each counts as a move,
 * and a budget that cannot cover all of them stops the search before it.
 * @param {Run} run @param {LocalSettings} settings
 * @returns {Scored} the best state the search held
 */
export function local(run, settings) {
  const { evaluator, counts, index } = run;
  const { held, locks, churn } = settings;
  const random = settings.seed === null ? null : mulberry32(settings.seed);
  const scoredNow = () => ({ ...candidateOf(evaluator.result, evaluator.assignments), churn: churn === null ? null : churn.total });
  let current = scoredNow();
  let best = current;
  /** @param {{ steps: AssignEdit[], undo: AssignEdit[] }} plan @returns {AssignResult} the result the edit would have */
  const preview = ({ steps, undo }) => {
    counts.moves += steps.length + undo.length;
    for (let i = 0; i < steps.length - 1; i++) evaluator.apply(steps[i]);
    const result = evaluator.whatIf(steps[steps.length - 1]);
    for (const step of undo) evaluator.apply(step);
    return result;
  };
  /** @param {AssignEdit} edit @returns {boolean} false when a budget or the signal stopped it */
  const commit = (edit) => {
    const { steps } = stepsOf(edit, locks);
    if (run.halted(false, steps.length)) return false;
    counts.moves += steps.length;
    for (const step of steps) evaluator.apply(step);
    churn?.commit(edit);
    current = scoredNow();
    if (compareScored(current, best) > 0) best = current;
    return true;
  };
  /** @returns {boolean} false once the run stopped */
  const descend = () => {
    for (;;) {
      let shape = shapeOf(evaluator.assignments, held);
      let improved = false;
      for (const position of positionsOf(index, shape, evaluator.result)) {
        if (!stands(index, position, shape)) continue;
        if (run.halted(true)) return false;
        counts.nodes++;
        /** @type {AssignEdit[]} */
        let tied = [];
        let top = current;
        for (const edit of editsAt(index, position, shape, locks)) {
          const plan = stepsOf(edit, locks);
          if (run.halted(false, plan.steps.length + plan.undo.length)) return false;
          const scored = { ...candidateOf(preview(plan), evaluator.assignments), churn: churn === null ? null : churn.after(edit) };
          if (scored.cls === INCOMPLETE || scored.cls === UNDECIDED) counts.undecided++;
          const order = compareScored(scored, top);
          if (order > 0) {
            top = scored;
            tied = [edit];
          }
          else if (order === 0 && tied.length > 0) tied.push(edit);
        }
        if (tied.length === 0) continue;
        if (!commit(random === null || tied.length === 1 ? tied[0] : tied[randomInt(random, 0, tied.length)])) return false;
        shape = shapeOf(evaluator.assignments, held);
        improved = true;
      }
      if (!improved) return true;
    }
  };
  if (!descend()) return best;
  while (random !== null && settings.maxRestarts !== null && counts.restarts < settings.maxRestarts) {
    if (positionsOf(index, shapeOf(best.list, held), null).length === 0) break;
    if (evaluator.assignments !== best.list) {
      if (run.halted(false)) return best;
      counts.moves++;
      evaluator.apply({ op: 'revise', assignments: best.list });
      churn?.reset(evaluator.assignments);
      current = scoredNow();
    }
    counts.restarts++;
    for (let step = 0; step < PERTURBATION; step++) {
      const shape = shapeOf(evaluator.assignments, held);
      const positions = positionsOf(index, shape, null);
      const edits = positions.length === 0 ? [] : editsAt(index, positions[randomInt(random, 0, positions.length)], shape, locks);
      if (edits.length === 0) continue;
      if (!commit(edits[randomInt(random, 0, edits.length)])) return best;
    }
    if (!descend()) return best;
  }
  return best;
}
